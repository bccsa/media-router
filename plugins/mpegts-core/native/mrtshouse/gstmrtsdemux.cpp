/* mrtsdemux (plan ch. 6 WI-P2-7): mrts::SelectDemux as an element, the formula demux in select
 * mode. One ALWAYS src pad carries the selected stream on the formula timeline (PTS = DTS =
 * unwrap(PES PTS) - 1 h, one buffer per PES, its own TIME segment from 0), with GAP events for
 * a hole in its PTS and for the bus gap markers on its PID. The bus stamps are never read.
 * Phase 3 adds the demux mode to this element (WI-P3-2). */
#include <atomic>
#include <cstring>
#include <new>
#include <utility>
#include <vector>

#include "mrts/ts_select.h"
#include "mrtshouse.h"

#define GST_CAT_DEFAULT mrtshouse_debug

using mrts::SelectDemux;

enum {
    PROP_0,
    PROP_SELECT,
    PROP_PROGRAM_NUMBER,
    PROP_PID,
    PROP_PES,
    PROP_GAPS,
    PROP_MARKERS,
    PROP_MARKERS_DROPPED,
};

/* The `mrtsdemux` message's cadence, in running time. */
static const gint64 REPORT_NS = GST_SECOND;

#define GST_TYPE_MRTSDEMUX (gst_mrtsdemux_get_type())
G_DECLARE_FINAL_TYPE(GstMrtsDemux, gst_mrtsdemux, GST, MRTSDEMUX, GstElement)

struct _GstMrtsDemux {
    GstElement parent;
    GstPad* sinkpad;
    GstPad* srcpad;

    /* Properties, under the object lock; they apply at the next start. `caps` is the select
     * mode's output, made at the start (the src pad's CAPS query reads it). */
    gchar* select;
    gint program_number;
    GstCaps* caps;

    /* Streaming state, under the sink pad's stream lock; a start resets it. */
    SelectDemux* core;                     // null outside PAUSED and PLAYING
    std::vector<SelectDemux::Out>* outs;
    GstSegment in_segment;                 // upstream's: places a marker's PTS
    gchar* stream_id;                      // ours, from upstream's STREAM_START
    guint group_id;
    gboolean have_group_id;
    gboolean started, caps_sent, segment_sent;
    gboolean have_report;
    gint64 report_at;

    /* Read-only properties: written by the streaming thread, read from any. */
    std::atomic<gint> pid;
    std::atomic<guint64> pes, gaps, markers, markers_dropped;
    MrtsHouseCommon common;
};

G_DEFINE_TYPE(GstMrtsDemux, gst_mrtsdemux, GST_TYPE_ELEMENT)

static GstStaticPadTemplate demux_sink_tmpl =
    GST_STATIC_PAD_TEMPLATE("sink", GST_PAD_SINK, GST_PAD_ALWAYS,
                            GST_STATIC_CAPS("video/mpegts, systemstream=(boolean)true"));
/* What select names; Phase 3's SOMETIMES templates come beside it. */
static GstStaticPadTemplate demux_src_tmpl =
    GST_STATIC_PAD_TEMPLATE("src", GST_PAD_SRC, GST_PAD_ALWAYS, GST_STATIC_CAPS_ANY);

/* Pipeline clock - base time; false without a clock (not PLAYING yet). */
static gboolean demux_clock_now(GstMrtsDemux* self, gint64* now) {
    GstClock* clock = gst_element_get_clock(GST_ELEMENT_CAST(self));
    if (!clock) return FALSE;
    const GstClockTime t = gst_clock_get_time(clock);
    gst_object_unref(clock);
    if (!GST_CLOCK_TIME_IS_VALID(t)) return FALSE;
    *now = (gint64)t - (gint64)gst_element_get_base_time(GST_ELEMENT_CAST(self));
    return TRUE;
}

static const gchar* stream_state_name(SelectDemux::State s) {
    switch (s) {
        case SelectDemux::State::found: return "found";
        case SelectDemux::State::missing: return "missing";
        default: return "waiting";
    }
}

/* --- messages and counters ------------------------------------------------------------ */

static void demux_post(GstMrtsDemux* self, GstStructure* s) {
    gst_element_post_message(GST_ELEMENT_CAST(self),
                             gst_message_new_element(GST_OBJECT_CAST(self), s));
}

/* The forwarded `mrtsdemux` structure, so the runners pass it on unsubscribed as
 * `mrtsdemux:<name>` (a live-added input has no busReports). */
static GstStructure* demux_message(GstMrtsDemux* self, const gchar* reason) {
    GST_OBJECT_LOCK(self);
    const gchar* select = self->select ? self->select : "";
    GstStructure* s = gst_structure_new("mrtsdemux", "reason", G_TYPE_STRING, reason, "select",
                                        G_TYPE_STRING, select, NULL);
    GST_OBJECT_UNLOCK(self);
    gst_structure_set(s, "program", G_TYPE_INT, self->core->program(), "pid", G_TYPE_INT,
                      self->core->pid(), "stream", G_TYPE_STRING,
                      stream_state_name(self->core->state()), NULL);
    return s;
}

/* The counter properties now; the `mrtsdemux` interval message every 1 s of running time from
 * the first buffer, or now (`force`, EOS). */
static void demux_report(GstMrtsDemux* self, gboolean have_now, gint64 now, gboolean force) {
    const SelectDemux::Counters c = self->core->counters();
    self->pid.store(self->core->pid(), std::memory_order_relaxed);
    self->pes.store(c.pes, std::memory_order_relaxed);
    self->gaps.store(c.gaps, std::memory_order_relaxed);
    self->markers.store(c.markers, std::memory_order_relaxed);
    self->markers_dropped.store(c.markers_dropped, std::memory_order_relaxed);
    MrtsHouseCounters k;   // no header rewrite here: header-spans stays 0
    k.desync_bytes = c.desync_bytes;
    k.cc_lost = c.cc_lost;
    k.pes_oversize = c.pes_oversize;
    k.pes_dropped_cc = c.pes_dropped_cc;
    k.psi_unsupported_sections = c.psi_unsupported_sections;
    k.pes_no_pts = c.pes_no_pts;
    k.dts_discarded = c.dts_discarded;
    self->common.publish(k);
    if (!force) {
        if (!have_now) return;
        if (!self->have_report) {
            self->have_report = TRUE;
            self->report_at = now;
            return;
        }
        if (now - self->report_at < REPORT_NS) return;
    }
    if (have_now) self->report_at = now;
    GstStructure* s = demux_message(self, "interval");
    gst_structure_set(s, "pes", G_TYPE_UINT64, (guint64)c.pes, "gaps", G_TYPE_UINT64,
                      (guint64)c.gaps, "cc-lost", G_TYPE_UINT64, (guint64)c.cc_lost, "markers",
                      G_TYPE_UINT64, (guint64)c.markers, "markers-dropped", G_TYPE_UINT64,
                      (guint64)c.markers_dropped, "pes-dropped-cc", G_TYPE_UINT64,
                      (guint64)c.pes_dropped_cc, "pes-no-pts", G_TYPE_UINT64,
                      (guint64)c.pes_no_pts, "desync-bytes", G_TYPE_UINT64,
                      (guint64)c.desync_bytes, "frame-ns", G_TYPE_INT64,
                      (gint64)self->core->frame_ns(), NULL);
    demux_post(self, s);
}

/* --- the src pad's stream ------------------------------------------------------------- */

/* Our STREAM_START: upstream's id with "/select", else one made from the pad. */
static void demux_push_stream_start(GstMrtsDemux* self) {
    if (self->started) return;
    gchar* id = self->stream_id ? g_strdup(self->stream_id)
                                : gst_pad_create_stream_id(self->srcpad, GST_ELEMENT_CAST(self),
                                                           "select");
    GstEvent* ev = gst_event_new_stream_start(id);
    g_free(id);
    if (self->have_group_id) gst_event_set_group_id(ev, self->group_id);
    self->started = TRUE;
    gst_pad_push_event(self->srcpad, ev);
}

/* Before the pad's first buffer or GAP, and after a flush: CAPS once, then the formula's
 * segment {start 0, base 0, time 0}, so running time is the formula. */
static void demux_push_head(GstMrtsDemux* self) {
    demux_push_stream_start(self);
    if (!self->caps_sent) {
        GST_OBJECT_LOCK(self);
        GstCaps* caps = self->caps ? gst_caps_ref(self->caps) : NULL;
        GST_OBJECT_UNLOCK(self);
        if (caps) {
            gst_pad_push_event(self->srcpad, gst_event_new_caps(caps));
            gst_caps_unref(caps);
        }
        self->caps_sent = TRUE;
    }
    if (!self->segment_sent) {
        GstSegment seg;
        gst_segment_init(&seg, GST_FORMAT_TIME);
        gst_pad_push_event(self->srcpad, gst_event_new_segment(&seg));
        self->segment_sent = TRUE;
    }
}

static void free_payload(gpointer p) { delete static_cast<std::vector<uint8_t>*>(p); }

static GstBuffer* demux_unit_buffer(SelectDemux::Out& o) {
    GstBuffer* b;
    if (o.payload.empty()) {
        b = gst_buffer_new();
    } else {
        auto* v = new std::vector<uint8_t>(std::move(o.payload));
        b = gst_buffer_new_wrapped_full((GstMemoryFlags)0, v->data(), v->size(), 0, v->size(), v,
                                        free_payload);
    }
    GST_BUFFER_PTS(b) = o.pts_ns >= 0 ? (GstClockTime)o.pts_ns : GST_CLOCK_TIME_NONE;
    GST_BUFFER_DTS(b) = o.dts_ns >= 0 ? (GstClockTime)o.dts_ns : GST_CLOCK_TIME_NONE;
    GST_BUFFER_DURATION(b) = o.dur_ns >= 0 ? (GstClockTime)o.dur_ns : GST_CLOCK_TIME_NONE;
    if (o.discont) GST_BUFFER_FLAG_SET(b, GST_BUFFER_FLAG_DISCONT);
    return b;
}

/* The core's outputs in order, emptied. After a failed push the rest are dropped and the flow
 * goes upstream. */
static GstFlowReturn demux_push_outs(GstMrtsDemux* self) {
    GstFlowReturn ret = GST_FLOW_OK;
    for (SelectDemux::Out& o : *self->outs) {
        switch (o.kind) {
            case SelectDemux::Out::Kind::found:
                GST_INFO_OBJECT(self, "selected stream on PID 0x%04x", o.pid);
                demux_push_head(self);
                break;
            case SelectDemux::Out::Kind::unit:
                if (ret != GST_FLOW_OK) break;
                demux_push_head(self);
                ret = gst_pad_push(self->srcpad, demux_unit_buffer(o));
                break;
            case SelectDemux::Out::Kind::gap:
                if (ret != GST_FLOW_OK) break;
                GST_DEBUG_OBJECT(self, "gap (%s) %" G_GINT64_FORMAT " ns from %" G_GINT64_FORMAT,
                                 o.reason, (gint64)o.dur_ns, (gint64)o.pts_ns);
                demux_push_head(self);
                gst_pad_push_event(self->srcpad, gst_event_new_gap((GstClockTime)o.pts_ns,
                                                                   (GstClockTime)o.dur_ns));
                break;
            case SelectDemux::Out::Kind::no_stream: {
                GST_WARNING_OBJECT(self, "no stream matches select within 2 s of the PMT");
                demux_post(self, demux_message(self, "no-stream"));
                break;
            }
        }
    }
    self->outs->clear();
    return ret;
}

/* One input buffer into the core, its outputs appended to `outs`. Takes `buf`. A GAP buffer
 * is an OQ-12 marker: its PTS, through upstream's segment, is the gap's end. */
static void demux_buffer(GstMrtsDemux* self, GstBuffer* buf, gboolean have_now, gint64 now) {
    GstMapInfo map;
    if (!gst_buffer_map(buf, &map, GST_MAP_READ)) {
        GST_WARNING_OBJECT(self, "buffer will not map; dropped");
        gst_buffer_unref(buf);
        return;
    }
    if (GST_BUFFER_FLAG_IS_SET(buf, GST_BUFFER_FLAG_GAP)) {
        gint64 end = -1;
        if (GST_BUFFER_PTS_IS_VALID(buf) && self->in_segment.format == GST_FORMAT_TIME) {
            const GstClockTime rt = gst_segment_to_running_time(&self->in_segment, GST_FORMAT_TIME,
                                                                GST_BUFFER_PTS(buf));
            if (GST_CLOCK_TIME_IS_VALID(rt)) end = (gint64)rt;
        }
        self->core->marker(map.data, map.size, end, *self->outs);
    } else {
        self->core->feed(map.data, map.size, GST_BUFFER_FLAG_IS_SET(buf, GST_BUFFER_FLAG_DISCONT),
                         have_now ? now : -1, *self->outs);
    }
    gst_buffer_unmap(buf, &map);
    gst_buffer_unref(buf);
}

static GstFlowReturn demux_chain(GstPad*, GstObject* parent, GstBuffer* buf) {
    GstMrtsDemux* self = GST_MRTSDEMUX(parent);
    if (!self->core) {
        gst_buffer_unref(buf);
        return GST_FLOW_FLUSHING;
    }
    gint64 now = 0;
    const gboolean have_now = demux_clock_now(self, &now);
    demux_buffer(self, buf, have_now, now);
    const GstFlowReturn ret = demux_push_outs(self);
    demux_report(self, have_now, now, FALSE);
    return ret;
}

static GstFlowReturn demux_chain_list(GstPad*, GstObject* parent, GstBufferList* list) {
    GstMrtsDemux* self = GST_MRTSDEMUX(parent);
    if (!self->core) {
        gst_buffer_list_unref(list);
        return GST_FLOW_FLUSHING;
    }
    gint64 now = 0;
    const gboolean have_now = demux_clock_now(self, &now);
    const guint n = gst_buffer_list_length(list);
    for (guint i = 0; i < n; i++)
        demux_buffer(self, gst_buffer_ref(gst_buffer_list_get(list, i)), have_now, now);
    gst_buffer_list_unref(list);
    const GstFlowReturn ret = demux_push_outs(self);
    demux_report(self, have_now, now, FALSE);
    return ret;
}

static gboolean demux_sink_event(GstPad* pad, GstObject* parent, GstEvent* event) {
    GstMrtsDemux* self = GST_MRTSDEMUX(parent);
    switch (GST_EVENT_TYPE(event)) {
        case GST_EVENT_STREAM_START: {
            /* Each upstream stream starts one here; its caps and segment follow again. */
            const gchar* id = NULL;
            gst_event_parse_stream_start(event, &id);
            g_free(self->stream_id);
            self->stream_id = g_strdup_printf("%s/select", id ? id : "mrtsdemux");
            self->have_group_id = gst_event_parse_group_id(event, &self->group_id);
            gst_event_unref(event);
            self->started = self->caps_sent = self->segment_sent = FALSE;
            demux_push_stream_start(self);
            return TRUE;
        }
        case GST_EVENT_SEGMENT:
            /* Upstream's segment places the markers; the output has its own. */
            gst_event_copy_segment(event, &self->in_segment);
            gst_event_unref(event);
            return TRUE;
        case GST_EVENT_CAPS:
        case GST_EVENT_TAG:
        case GST_EVENT_GAP:
            /* The TS's own caps and tags describe no output; its time comes from the PES. */
            gst_event_unref(event);
            return TRUE;
        case GST_EVENT_FLUSH_STOP:
            if (self->core) self->core->flush();
            gst_segment_init(&self->in_segment, GST_FORMAT_UNDEFINED);
            self->segment_sent = FALSE;
            return gst_pad_push_event(self->srcpad, event);
        case GST_EVENT_EOS:
            if (self->core) {
                gint64 now = 0;
                const gboolean have_now = demux_clock_now(self, &now);
                self->core->drain(*self->outs);
                demux_push_outs(self);
                demux_report(self, have_now, now, TRUE);
            }
            demux_push_stream_start(self);
            return gst_pad_push_event(self->srcpad, event);
        default:
            return gst_pad_event_default(pad, parent, event);
    }
}

static gboolean demux_src_query(GstPad* pad, GstObject* parent, GstQuery* query) {
    GstMrtsDemux* self = GST_MRTSDEMUX(parent);
    if (GST_QUERY_TYPE(query) != GST_QUERY_CAPS) return gst_pad_query_default(pad, parent, query);
    GstCaps* filter = NULL;
    gst_query_parse_caps(query, &filter);
    GST_OBJECT_LOCK(self);
    GstCaps* caps = self->caps ? gst_caps_ref(self->caps) : NULL;
    GST_OBJECT_UNLOCK(self);
    if (!caps) caps = gst_pad_get_pad_template_caps(pad);
    if (filter) {
        GstCaps* both = gst_caps_intersect_full(filter, caps, GST_CAPS_INTERSECT_FIRST);
        gst_caps_unref(caps);
        caps = both;
    }
    gst_query_set_caps_result(query, caps);
    gst_caps_unref(caps);
    return TRUE;
}

/* --- GObject -------------------------------------------------------------------------- */

/* A start: the core from the properties as they are now; false when `select` names no stream. */
static gboolean demux_start(GstMrtsDemux* self) {
    SelectDemux::Config cfg;
    GST_OBJECT_LOCK(self);
    gchar* select = g_strdup(self->select ? self->select : "");
    cfg.program = self->program_number;
    GST_OBJECT_UNLOCK(self);
    GstCaps* parsed = *select ? gst_caps_from_string(select) : NULL;
    const GstStructure* st =
        parsed && gst_caps_get_size(parsed) == 1 ? gst_caps_get_structure(parsed, 0) : NULL;
    cfg.stream = st ? mrts::select_stream(gst_structure_get_name(st)) : mrts::SelectStream::none;
    if (parsed) gst_caps_unref(parsed);
    if (cfg.stream == mrts::SelectStream::none) {
        GST_ELEMENT_ERROR(self, LIBRARY, SETTINGS,
                          ("select \"%s\" names no stream mrtsdemux can select", select),
                          ("select mode knows audio/x-smpte-302m; the demux mode is Phase 3's"));
        g_free(select);
        return FALSE;
    }
    g_free(select);
    GstCaps* caps = gst_caps_new_empty_simple(mrts::select_caps_name(cfg.stream));
    GST_OBJECT_LOCK(self);
    if (self->caps) gst_caps_unref(self->caps);
    self->caps = caps;
    GST_OBJECT_UNLOCK(self);
    delete self->core;
    self->core = new SelectDemux(cfg);
    self->outs->clear();
    gst_segment_init(&self->in_segment, GST_FORMAT_UNDEFINED);
    self->started = self->caps_sent = self->segment_sent = FALSE;
    self->have_report = FALSE;
    self->report_at = 0;
    self->pid.store(-1, std::memory_order_relaxed);
    self->pes.store(0, std::memory_order_relaxed);
    self->gaps.store(0, std::memory_order_relaxed);
    self->markers.store(0, std::memory_order_relaxed);
    self->markers_dropped.store(0, std::memory_order_relaxed);
    self->common.reset();
    return TRUE;
}

static GstStateChangeReturn demux_change_state(GstElement* element, GstStateChange transition) {
    GstMrtsDemux* self = GST_MRTSDEMUX(element);
    if (transition == GST_STATE_CHANGE_READY_TO_PAUSED && !demux_start(self))
        return GST_STATE_CHANGE_FAILURE;
    const GstStateChangeReturn ret =
        GST_ELEMENT_CLASS(gst_mrtsdemux_parent_class)->change_state(element, transition);
    if (transition == GST_STATE_CHANGE_PAUSED_TO_READY) {
        /* The pads are inactive: no chain or serialized event runs. */
        delete self->core;
        self->core = NULL;
        g_free(self->stream_id);
        self->stream_id = NULL;
        self->have_group_id = FALSE;
    }
    return ret;
}

static void demux_set_property(GObject* object, guint prop_id, const GValue* value,
                               GParamSpec* pspec) {
    GstMrtsDemux* self = GST_MRTSDEMUX(object);
    switch (prop_id) {
        case PROP_SELECT:
            GST_OBJECT_LOCK(self);
            g_free(self->select);
            self->select = g_value_dup_string(value);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_PROGRAM_NUMBER:
            GST_OBJECT_LOCK(self);
            self->program_number = g_value_get_int(value);
            GST_OBJECT_UNLOCK(self);
            break;
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
            break;
    }
}

static void demux_get_property(GObject* object, guint prop_id, GValue* value, GParamSpec* pspec) {
    GstMrtsDemux* self = GST_MRTSDEMUX(object);
    if (self->common.get(prop_id, value)) return;
    switch (prop_id) {
        case PROP_SELECT:
            GST_OBJECT_LOCK(self);
            g_value_set_string(value, self->select);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_PROGRAM_NUMBER:
            GST_OBJECT_LOCK(self);
            g_value_set_int(value, self->program_number);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_PID:
            g_value_set_int(value, self->pid.load(std::memory_order_relaxed));
            break;
        case PROP_PES:
            g_value_set_uint64(value, self->pes.load(std::memory_order_relaxed));
            break;
        case PROP_GAPS:
            g_value_set_uint64(value, self->gaps.load(std::memory_order_relaxed));
            break;
        case PROP_MARKERS:
            g_value_set_uint64(value, self->markers.load(std::memory_order_relaxed));
            break;
        case PROP_MARKERS_DROPPED:
            g_value_set_uint64(value, self->markers_dropped.load(std::memory_order_relaxed));
            break;
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
            break;
    }
}

static void demux_finalize(GObject* object) {
    GstMrtsDemux* self = GST_MRTSDEMUX(object);
    delete self->core;
    delete self->outs;
    g_free(self->select);
    g_free(self->stream_id);
    if (self->caps) gst_caps_unref(self->caps);
    G_OBJECT_CLASS(gst_mrtsdemux_parent_class)->finalize(object);
}

static void gst_mrtsdemux_init(GstMrtsDemux* self) {
    new (&self->common) MrtsHouseCommon();
    new (&self->pid) std::atomic<gint>(-1);
    new (&self->pes) std::atomic<guint64>(0);
    new (&self->gaps) std::atomic<guint64>(0);
    new (&self->markers) std::atomic<guint64>(0);
    new (&self->markers_dropped) std::atomic<guint64>(0);
    self->select = NULL;
    self->program_number = -1;
    self->caps = NULL;
    self->core = NULL;
    self->outs = new std::vector<SelectDemux::Out>();
    gst_segment_init(&self->in_segment, GST_FORMAT_UNDEFINED);
    self->stream_id = NULL;
    self->group_id = 0;
    self->have_group_id = FALSE;
    self->started = self->caps_sent = self->segment_sent = FALSE;
    self->have_report = FALSE;
    self->report_at = 0;

    self->sinkpad = gst_pad_new_from_static_template(&demux_sink_tmpl, "sink");
    gst_pad_set_chain_function(self->sinkpad, GST_DEBUG_FUNCPTR(demux_chain));
    gst_pad_set_chain_list_function(self->sinkpad, GST_DEBUG_FUNCPTR(demux_chain_list));
    gst_pad_set_event_function(self->sinkpad, GST_DEBUG_FUNCPTR(demux_sink_event));
    gst_element_add_pad(GST_ELEMENT_CAST(self), self->sinkpad);
    self->srcpad = gst_pad_new_from_static_template(&demux_src_tmpl, "src");
    gst_pad_set_query_function(self->srcpad, GST_DEBUG_FUNCPTR(demux_src_query));
    gst_element_add_pad(GST_ELEMENT_CAST(self), self->srcpad);
}

static void gst_mrtsdemux_class_init(GstMrtsDemuxClass* klass) {
    GObjectClass* gobject_class = G_OBJECT_CLASS(klass);
    GstElementClass* element_class = GST_ELEMENT_CLASS(klass);

    gobject_class->set_property = demux_set_property;
    gobject_class->get_property = demux_get_property;
    gobject_class->finalize = demux_finalize;
    element_class->change_state = demux_change_state;

    const GParamFlags at_start =
        (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS | GST_PARAM_MUTABLE_READY);
    const GParamFlags ro = (GParamFlags)(G_PARAM_READABLE | G_PARAM_STATIC_STRINGS);
    g_object_class_install_property(
        gobject_class, PROP_SELECT,
        g_param_spec_string("select", "Select",
                            "The stream to output, as caps: audio/x-smpte-302m (PMT stream type "
                            "0x06 with registration BSSD). Required: the demux mode is Phase 3's. "
                            "Applies at the next start.",
                            NULL, at_start));
    g_object_class_install_property(
        gobject_class, PROP_PROGRAM_NUMBER,
        g_param_spec_int("program-number", "Program number",
                         "The program to follow; -1: the first in the PAT. Applies at the next "
                         "start.",
                         -1, 65535, -1, at_start));
    g_object_class_install_property(
        gobject_class, PROP_PID,
        g_param_spec_int("pid", "PID", "The selected stream's PID; -1 while there is none.", -1,
                         0x1FFF, -1, ro));
    g_object_class_install_property(
        gobject_class, PROP_PES,
        g_param_spec_uint64("pes", "PES", "Buffers out, one per PES, since the start.", 0,
                            G_MAXUINT64, 0, ro));
    g_object_class_install_property(
        gobject_class, PROP_GAPS,
        g_param_spec_uint64("gaps", "Gaps",
                            "GAP events out since the start: holes past two frames and placed "
                            "markers.",
                            0, G_MAXUINT64, 0, ro));
    g_object_class_install_property(
        gobject_class, PROP_MARKERS,
        g_param_spec_uint64("markers", "Markers",
                            "Bus gap markers (OQ-12) on the selected PID since the start.", 0,
                            G_MAXUINT64, 0, ro));
    g_object_class_install_property(
        gobject_class, PROP_MARKERS_DROPPED,
        g_param_spec_uint64("markers-dropped", "Markers dropped",
                            "Markers that left no GAP: nothing past what the pad already "
                            "emitted, or no placeable PTS.",
                            0, G_MAXUINT64, 0, ro));
    /* After our own: the common ids are clear of these (MrtsHouseCommon::PROP_BASE). */
    MrtsHouseCommon::install(gobject_class);

    gst_element_class_add_static_pad_template(element_class, &demux_sink_tmpl);
    gst_element_class_add_static_pad_template(element_class, &demux_src_tmpl);
    gst_element_class_set_static_metadata(
        element_class, "Media Router formula demux", "Codec/Demuxer",
        "Demuxes one MPEG-TS stream on the formula timeline (PTS = PES - 1 h), with GAP events "
        "for its holes and the bus gap markers on its PID",
        "Media Router <https://github.com/bccsa/media-router>");
}
