/* mrtsdemux (plan ch. 6 WI-P2-7, ch. 7 WI-P3-2; B-122, B-123): the formula demux, the element of
 * mrts::DemuxCore. Demux mode (the default): tsdemux 1.28.2's SOMETIMES pads, names, caps, stream
 * collection and event order for every stream `media` names, one PES per buffer on the formula
 * timeline (PTS = DTS = ceil(unwrap(PES PTS) - 1 h), its own TIME segment from 0), GAP events for
 * holes, bus gap markers and sparse pads, the PAT and PMT as section messages (the PMT before the
 * program's pads, for the muxer hooks). Select mode (`select`, Phase 2): one ALWAYS src pad with
 * the selected stream. The bus stamps are never read. */
#define GST_USE_UNSTABLE_API   // gst/mpegts is "unstable API" (it has not changed since 1.x)
#include <gst/audio/audio.h>
#include <gst/base/gstflowcombiner.h>
#include <gst/mpegts/mpegts.h>
#include <gst/pbutils/pbutils.h>
#include <gst/tag/tag.h>

#include <atomic>
#include <cstring>
#include <new>
#include <string>
#include <utility>
#include <vector>

#include "mrts/demux_core.h"
#include "mrtshouse.h"

#define GST_CAT_DEFAULT mrtshouse_debug

using mrts::AuPost;
using mrts::DemuxCore;
using mrts::DemuxEvent;
using mrts::EsClass;

enum {
    PROP_0,
    PROP_SELECT,
    PROP_PROGRAM_NUMBER,
    PROP_MEDIA,
    PROP_SPARSE_GAP_LAG,
    PROP_MAX_PES_BYTES,
    PROP_PID,
    PROP_PES,
    PROP_GAPS,
    PROP_MARKERS,
    PROP_MARKERS_DROPPED,
    PROP_UNKNOWN_STREAMS,
    PROP_GENERATION,
};

/* The `mrtsdemux` message's cadence, in running time. */
static const gint64 REPORT_NS = GST_SECOND;
static const gchar MEDIA_ALL[] = "video,audio,private,subpicture";
static const guint64 SPARSE_GAP_LAG_DEFAULT = 500 * GST_MSECOND;
static const guint MAX_PES_BYTES_DEFAULT = 32u << 20;

/* A demux-mode pad: the GstPad and GstStream of one stream of the plan, and what it has sent. */
struct DemuxOut {
    GstPad* pad = nullptr;              // a ref of ours; in the element while its program runs
    GstStream* stream = nullptr;        // a ref of ours; the program's collection holds another
    std::string name;
    int pid = -1, stream_type = 0;
    mrts::EsPlan es;
    GstTagList* tags = nullptr;         // its TAG, sent once with its first segment
    int adts_version = 4;               // the mpegversion its caps carry (AuPost::Adts)
    bool head = false;                  // its segment sent, since the start or the last flush
    bool discont = false;               // a unit it could not parse: the next buffer is DISCONT
};

#define GST_TYPE_MRTSDEMUX (gst_mrtsdemux_get_type())
G_DECLARE_FINAL_TYPE(GstMrtsDemux, gst_mrtsdemux, GST, MRTSDEMUX, GstElement)

struct _GstMrtsDemux {
    GstElement parent;
    GstPad* sinkpad;
    GstPad* srcpad;                     // select mode's, a ref of ours; in the element while
                                        // `select` is set, so gst_parse links demux-mode pads late

    /* Properties, under the object lock; they apply at the next start. `caps` is the select
     * mode's output, made at the start (the src pad's CAPS query reads it). */
    gchar* select;
    gint program_number;
    gchar* media;
    guint64 sparse_gap_lag;
    guint max_pes_bytes;
    GstCaps* caps;

    /* Streaming state, under the sink pad's stream lock; a start resets it. */
    DemuxCore* core;                       // null outside PAUSED and PLAYING
    std::vector<DemuxEvent>* outs;
    gint found_pid;                        // the PID the head was pushed for, -1 none
    GstSegment in_segment;                 // upstream's: places a marker's PTS
    gchar* stream_id;                      // ours, from upstream's STREAM_START
    guint group_id;
    gboolean have_group_id;
    gboolean started, caps_sent, segment_sent;
    gboolean have_report;
    gint64 report_at;
    /* Demux mode: the program's pads in plan order; the previous program's until its `gone`. */
    std::vector<DemuxOut*>* pads_now;
    std::vector<DemuxOut*>* pads_old;
    GstStreamCollection* collection;
    GstFlowCombiner* combiner;
    gboolean finish_pending;               // the plan's tail waits for the old pads' removal
    gint plan_gen, plan_pcr_pid;

    /* Read-only properties: written by the streaming thread, read from any. */
    std::atomic<gint> pid, generation;
    std::atomic<guint64> pes, gaps, markers, markers_dropped, unknown_streams;
    MrtsHouseCommon common;
};

G_DEFINE_TYPE(GstMrtsDemux, gst_mrtsdemux, GST_TYPE_ELEMENT)

static GstStaticPadTemplate demux_sink_tmpl =
    GST_STATIC_PAD_TEMPLATE("sink", GST_PAD_SINK, GST_PAD_ALWAYS,
                            GST_STATIC_CAPS("video/mpegts, systemstream=(boolean)true"));
/* What select names; in the element only while `select` is set. */
static GstStaticPadTemplate demux_src_tmpl =
    GST_STATIC_PAD_TEMPLATE("src", GST_PAD_SRC, GST_PAD_ALWAYS, GST_STATIC_CAPS_ANY);
/* The demux mode's: tsdemux 1.28.2's names and caps (tsdemux.c VIDEO_CAPS, AUDIO_CAPS,
 * SUBPICTURE_CAPS), copied as they are. */
static GstStaticPadTemplate video_tmpl = GST_STATIC_PAD_TEMPLATE(
    "video_%01x_%05x", GST_PAD_SRC, GST_PAD_SOMETIMES,
    GST_STATIC_CAPS("video/mpeg, mpegversion = (int) { 1, 2, 4 }, systemstream = (boolean) FALSE; "
                    "video/x-h264,stream-format=(string)byte-stream;"
                    "video/x-h265,stream-format=(string)byte-stream;"
                    "video/x-h266,stream-format=(string)byte-stream;"
                    "video/x-vp9;"
                    "video/x-av1,stream-format=(string)obu-stream,alignment=(string)frame;"
                    "video/x-dirac;"
                    "video/x-cavs;"
                    "video/x-wmv, wmvversion = (int) 3, format = (string) WVC1;"
                    "image/x-jpc;"
                    "image/x-jxsc;"));
static GstStaticPadTemplate audio_tmpl = GST_STATIC_PAD_TEMPLATE(
    "audio_%01x_%05x", GST_PAD_SRC, GST_PAD_SOMETIMES,
    GST_STATIC_CAPS("audio/mpeg, mpegversion = (int) 1;"
                    "audio/mpeg, mpegversion = (int) { 2, 4 }, stream-format = (string) adts; "
                    "audio/mpeg, mpegversion = (int) 4, stream-format = (string) loas; "
                    "audio/x-lpcm, width = (int) { 16, 20, 24 }, rate = (int) { 48000, 96000 }, "
                    "channels = (int) [ 1, 8 ], dynamic_range = (int) [ 0, 255 ], "
                    "emphasis = (boolean) { FALSE, TRUE }, mute = (boolean) { FALSE, TRUE }; "
                    "audio/x-ac3; audio/x-eac3;"
                    "audio/x-ac4;"
                    "audio/x-dts;"
                    "audio/x-opus;"
                    "audio/x-private-ts-lpcm"));
static GstStaticPadTemplate subpicture_tmpl = GST_STATIC_PAD_TEMPLATE(
    "subpicture_%01x_%05x", GST_PAD_SRC, GST_PAD_SOMETIMES,
    GST_STATIC_CAPS("subpicture/x-pgs; subpicture/x-dvd; subpicture/x-dvb"));
static GstStaticPadTemplate private_tmpl = GST_STATIC_PAD_TEMPLATE(
    "private_%01x_%05x", GST_PAD_SRC, GST_PAD_SOMETIMES, GST_STATIC_CAPS_ANY);

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

static gboolean select_mode(GstMrtsDemux* self) { return self->core && self->core->select_mode(); }

static gboolean demux_src_query(GstPad* pad, GstObject* parent, GstQuery* query);

static const gchar* stream_state_name(DemuxCore::State s) {
    switch (s) {
        case DemuxCore::State::found: return "found";
        case DemuxCore::State::missing: return "missing";
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

static std::string joined(const std::vector<std::string>& names) {
    std::string s;
    for (const std::string& n : names) s += (s.empty() ? "" : ",") + n;
    return s;
}

/* The counter properties now; the `mrtsdemux` interval message every 1 s of running time from
 * the first buffer, or now (`force`, EOS). */
static void demux_report(GstMrtsDemux* self, gboolean have_now, gint64 now, gboolean force) {
    const DemuxCore::Counters c = self->core->counters();
    self->pid.store(self->core->pid(), std::memory_order_relaxed);
    self->generation.store(c.generation, std::memory_order_relaxed);
    self->pes.store(c.pes, std::memory_order_relaxed);
    self->gaps.store(c.gaps, std::memory_order_relaxed);
    self->markers.store(c.markers, std::memory_order_relaxed);
    self->markers_dropped.store(c.markers_dropped, std::memory_order_relaxed);
    self->unknown_streams.store(c.unknown_streams, std::memory_order_relaxed);
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
                      (guint64)c.desync_bytes, "unknown-streams", G_TYPE_UINT64,
                      (guint64)c.unknown_streams, "frame-ns", G_TYPE_INT64,
                      (gint64)self->core->frame_ns(), "generation", G_TYPE_INT, c.generation,
                      "pads", G_TYPE_STRING, joined(self->core->pads()).c_str(), NULL);
    demux_post(self, s);
}

/* --- payloads ------------------------------------------------------------------------- */

static void free_payload(gpointer p) { delete static_cast<std::vector<uint8_t>*>(p); }

/* The PES payload as one buffer, the core's bytes in place. */
static GstBuffer* payload_buffer(std::vector<uint8_t>& bytes) {
    if (bytes.empty()) return gst_buffer_new();
    auto* v = new std::vector<uint8_t>(std::move(bytes));
    return gst_buffer_new_wrapped_full((GstMemoryFlags)0, v->data(), v->size(), 0, v->size(), v,
                                       free_payload);
}

static void stamp(GstBuffer* b, const DemuxEvent& o, bool discont) {
    GST_BUFFER_PTS(b) = o.pts_ns >= 0 ? (GstClockTime)o.pts_ns : GST_CLOCK_TIME_NONE;
    GST_BUFFER_DTS(b) = o.dts_ns >= 0 ? (GstClockTime)o.dts_ns : GST_CLOCK_TIME_NONE;
    GST_BUFFER_DURATION(b) = o.dur_ns >= 0 ? (GstClockTime)o.dur_ns : GST_CLOCK_TIME_NONE;
    if (discont) GST_BUFFER_FLAG_SET(b, GST_BUFFER_FLAG_DISCONT);
}

/* --- select mode: the src pad's stream ------------------------------------------------ */

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

/* The core's outputs in order, emptied; the head first once the core has found a stream on a
 * new PID (its PMT seen, no data yet). After a failed push the rest are dropped and the flow
 * goes upstream. */
static GstFlowReturn select_push_outs(GstMrtsDemux* self) {
    GstFlowReturn ret = GST_FLOW_OK;
    const gint pid = self->core->pid();
    if (pid >= 0 && pid != self->found_pid) {
        GST_INFO_OBJECT(self, "selected stream on PID 0x%04x", pid);
        demux_push_head(self);
    }
    self->found_pid = pid;
    for (DemuxEvent& o : *self->outs) {
        switch (o.kind) {
            case DemuxEvent::Kind::unit: {
                if (ret != GST_FLOW_OK) break;
                demux_push_head(self);
                GstBuffer* b = payload_buffer(o.bytes);
                stamp(b, o, o.discont);
                ret = gst_pad_push(self->srcpad, b);
                break;
            }
            case DemuxEvent::Kind::gap:
                if (ret != GST_FLOW_OK) break;
                GST_DEBUG_OBJECT(self, "gap (%s) %" G_GINT64_FORMAT " ns from %" G_GINT64_FORMAT,
                                 o.reason, (gint64)o.dur_ns, (gint64)o.pts_ns);
                demux_push_head(self);
                gst_pad_push_event(self->srcpad, gst_event_new_gap((GstClockTime)o.pts_ns,
                                                                   (GstClockTime)o.dur_ns));
                break;
            case DemuxEvent::Kind::no_stream:
                GST_WARNING_OBJECT(self, "no stream matches select within 2 s of the PMT");
                demux_post(self, demux_message(self, "no-stream"));
                break;
            default:                           // the demux mode's events: none in select mode
                break;
        }
    }
    self->outs->clear();
    return ret;
}

/* --- demux mode: pads, sections, the stream collection -------------------------------- */

static GstStaticPadTemplate* template_of(EsClass c) {
    switch (c) {
        case EsClass::Video: return &video_tmpl;
        case EsClass::Audio: return &audio_tmpl;
        case EsClass::Subpicture: return &subpicture_tmpl;
        default: return &private_tmpl;
    }
}

/* tsdemux's GstStream types: KLV and ID3 metadata, teletext unknown, subpictures text. */
static GstStreamType stream_type_of(const mrts::EsPlan& es) {
    switch (es.cls) {
        case EsClass::Video: return GST_STREAM_TYPE_VIDEO;
        case EsClass::Audio: return GST_STREAM_TYPE_AUDIO;
        case EsClass::Subpicture: return GST_STREAM_TYPE_TEXT;
        default:
            return g_str_has_prefix(es.caps.c_str(), "meta/") ? GST_STREAM_TYPE_METADATA
                                                               : GST_STREAM_TYPE_UNKNOWN;
    }
}

/* A plan row's caps: the core's tsdemux string; AV1's fields from its av1C descriptor, as
 * tsdemux makes them (pbutils). Null when the string will not parse (no pad). */
static GstCaps* plan_caps(const mrts::EsPlan& es) {
    GstCaps* caps = gst_caps_from_string(es.caps.c_str());
    if (!caps || es.av1_desc.empty() || !g_str_has_prefix(es.caps.c_str(), "video/x-av1"))
        return caps;
    GstBuffer* av1c = gst_buffer_new_memdup(es.av1_desc.data(), es.av1_desc.size());
    GstCaps* fields = gst_codec_utils_av1_create_caps_from_av1c(av1c);
    if (fields) {
        gst_caps_set_simple(fields, "codec_data", GST_TYPE_BUFFER, av1c, NULL);
        GstCaps* both = gst_caps_intersect(caps, fields);
        gst_caps_unref(fields);
        if (gst_caps_is_empty(both)) {
            gst_caps_unref(both);
        } else {
            gst_caps_unref(caps);
            caps = both;
        }
    }
    gst_buffer_unref(av1c);
    return caps;
}

/* tsdemux's tags: the ISO 639-1 code where one maps, else the PMT's, and the codec. */
static GstTagList* plan_tags(const mrts::EsPlan& es, const GstCaps* caps) {
    GstTagList* tags = gst_tag_list_new_empty();
    if (!es.lang.empty()) {
        const gchar* lc = gst_tag_get_language_code(es.lang.c_str());
        gst_tag_list_add(tags, GST_TAG_MERGE_REPLACE, GST_TAG_LANGUAGE_CODE,
                         lc ? lc : es.lang.c_str(), NULL);
    }
    gst_pb_utils_add_codec_description_to_tag_list(tags, NULL, caps);
    return tags;
}

/* One pad of a plan, before it is added: its stream and its STREAM_START and CAPS (sticky),
 * as tsdemux's create_pad_for_stream. Null for caps that will not parse. */
static DemuxOut* out_new(GstMrtsDemux* self, const mrts::DemuxPad& p, const gchar* collection_id) {
    GstCaps* caps = plan_caps(p.es);
    if (!caps) {
        GST_WARNING_OBJECT(self, "PID 0x%04x: caps \"%s\" will not parse; no pad", p.pid,
                           p.es.caps.c_str());
        return nullptr;
    }
    DemuxOut* o = new DemuxOut();
    o->name = p.name;
    o->pid = p.pid;
    o->stream_type = p.stream_type;
    o->es = p.es;
    GstPadTemplate* tmpl = gst_static_pad_template_get(template_of(p.es.cls));
    o->pad = GST_PAD(gst_object_ref_sink(gst_pad_new_from_template(tmpl, p.name.c_str())));
    gst_object_unref(tmpl);
    gst_pad_set_active(o->pad, TRUE);
    gst_pad_use_fixed_caps(o->pad);
    gst_pad_set_query_function(o->pad, GST_DEBUG_FUNCPTR(demux_src_query));
    gchar* sid = g_strdup_printf("%s/%08x", collection_id, p.pid);
    const GstStreamFlags flags = p.es.sparse ? GST_STREAM_FLAG_SPARSE : GST_STREAM_FLAG_NONE;
    o->stream = gst_stream_new(sid, caps, stream_type_of(p.es), flags);
    o->tags = plan_tags(p.es, caps);
    gst_stream_set_tags(o->stream, o->tags);
    gst_stream_collection_add_stream(self->collection, GST_STREAM(gst_object_ref(o->stream)));
    GstEvent* ev = gst_event_new_stream_start(sid);
    g_free(sid);
    gst_event_set_stream(ev, o->stream);
    if (self->have_group_id) gst_event_set_group_id(ev, self->group_id);
    gst_event_set_stream_flags(ev, flags);
    gst_pad_push_event(o->pad, ev);
    gst_pad_set_caps(o->pad, caps);
    gst_caps_unref(caps);
    return o;
}

static void out_free(DemuxOut* o) {
    if (o->pad) gst_object_unref(o->pad);
    if (o->stream) gst_object_unref(o->stream);
    if (o->tags) gst_tag_list_unref(o->tags);
    delete o;
}

static DemuxOut* out_named(GstMrtsDemux* self, const std::string& name) {
    for (DemuxOut* o : *self->pads_now)
        if (o->name == name) return o;
    for (DemuxOut* o : *self->pads_old)
        if (o->name == name) return o;
    return nullptr;
}

/* A pad's head, once: SEGMENT {TIME, start 0, base 0, time 0}, so running time is the
 * formula, then its TAG. */
static void out_head(DemuxOut* o) {
    if (o->head) return;
    GstSegment seg;
    gst_segment_init(&seg, GST_FORMAT_TIME);
    gst_pad_push_event(o->pad, gst_event_new_segment(&seg));
    if (o->tags) {
        gst_pad_push_event(o->pad, gst_event_new_tag(o->tags));
        o->tags = nullptr;
    }
    o->head = true;
}

/* Every pad of the program at once, as tsdemux's calculate_and_push_newsegment: at the
 * program's first buffer or GAP, or its first sparse pad's GAP(0, 0). */
static void program_head(GstMrtsDemux* self) {
    for (DemuxOut* o : *self->pads_now) out_head(o);
}

/* The upstream id tsdemux's stream ids start with (mpegtsbase.c _get_upstream_id). */
static gchar* upstream_id(GstMrtsDemux* self) {
    gchar* id = gst_pad_get_stream_id(self->sinkpad);
    if (!id)
        id = g_strdup_printf("%08x%08x%08x%08x", g_random_int(), g_random_int(), g_random_int(),
                             g_random_int());
    return id;
}

/* Upstream's group id, as tsdemux takes it at pad creation; one of our own without a stream. */
static void plan_group_id(GstMrtsDemux* self) {
    GstEvent* ev = gst_pad_get_sticky_event(self->sinkpad, GST_EVENT_STREAM_START, 0);
    if (ev) {
        self->have_group_id = gst_event_parse_group_id(ev, &self->group_id);
        gst_event_unref(ev);
    } else if (!self->have_group_id) {
        self->have_group_id = TRUE;
        self->group_id = gst_util_group_id_next();
    }
}

/* The plan's tail, after the old program's pads are gone (tsdemux's program_started): a sparse
 * pad's GAP(0, 0), each pad's STREAM_COLLECTION, then no-more-pads. */
static void program_finish(GstMrtsDemux* self) {
    self->finish_pending = FALSE;
    std::vector<std::string> names;
    for (DemuxOut* o : *self->pads_now) {
        if (o->es.sparse) {
            program_head(self);
            gst_pad_push_event(o->pad, gst_event_new_gap(0, 0));
        }
        gst_pad_push_event(o->pad, gst_event_new_stream_collection(self->collection));
        names.push_back(o->name);
    }
    gst_element_no_more_pads(GST_ELEMENT_CAST(self));
    GstStructure* s = demux_message(self, "program");
    gst_structure_set(s, "generation", G_TYPE_INT, self->plan_gen, "pcr-pid", G_TYPE_INT,
                      self->plan_pcr_pid, "pads", G_TYPE_STRING, joined(names).c_str(), NULL);
    demux_post(self, s);
}

/* A new program (the core's plan): the collection message, then each pad added. The old
 * program's pads stay until the core's `gone`, after the new ones (tsdemux's drain, add,
 * remove). */
static void program_plan(GstMrtsDemux* self, const DemuxEvent& e) {
    GST_INFO_OBJECT(self, "program %d, generation %d: %zu pads", e.program, e.generation,
                    e.pads.size());
    for (DemuxOut* o : *self->pads_now) self->pads_old->push_back(o);
    self->pads_now->clear();
    plan_group_id(self);
    gchar* up = upstream_id(self);
    gchar* collection_id = g_strdup_printf("%s:%d", up, e.program);
    g_free(up);
    if (self->collection) gst_object_unref(self->collection);
    self->collection = gst_stream_collection_new(collection_id);
    for (const mrts::DemuxPad& p : e.pads) {
        DemuxOut* o = out_new(self, p, collection_id);
        if (o) self->pads_now->push_back(o);
    }
    g_free(collection_id);
    gst_element_post_message(GST_ELEMENT_CAST(self),
                             gst_message_new_stream_collection(GST_OBJECT_CAST(self),
                                                               self->collection));
    for (DemuxOut* o : *self->pads_now) {
        gst_flow_combiner_add_pad(self->combiner, o->pad);
        gst_element_add_pad(GST_ELEMENT_CAST(self), o->pad);
    }
    self->plan_gen = e.generation;
    self->plan_pcr_pid = e.pcr_pid;
    self->finish_pending = TRUE;
    if (self->pads_old->empty()) program_finish(self);
}

/* The old program's pads (the core's `gone`): EOS, then each removed; then the plan's tail. */
static void program_gone(GstMrtsDemux* self) {
    for (DemuxOut* o : *self->pads_old) {
        gst_flow_combiner_remove_pad(self->combiner, o->pad);
        gst_pad_push_event(o->pad, gst_event_new_eos());
        gst_pad_set_active(o->pad, FALSE);
        gst_element_remove_pad(GST_ELEMENT_CAST(self), o->pad);
        out_free(o);
    }
    self->pads_old->clear();
    if (self->finish_pending) program_finish(self);
}

/* Every demux-mode pad out of the element, at a stop: no EOS (the pads are inactive). */
static void pads_clear(GstMrtsDemux* self) {
    for (std::vector<DemuxOut*>* list : {self->pads_old, self->pads_now}) {
        for (DemuxOut* o : *list) {
            gst_flow_combiner_remove_pad(self->combiner, o->pad);
            gst_pad_set_active(o->pad, FALSE);
            gst_element_remove_pad(GST_ELEMENT_CAST(self), o->pad);
            out_free(o);
        }
        list->clear();
    }
    if (self->collection) gst_object_unref(self->collection);
    self->collection = NULL;
    self->finish_pending = FALSE;
}

/* A PAT or PMT section as tsdemux posts it, on the streaming thread, so a sync handler reads
 * it before the program's pads appear. */
static void post_section(GstMrtsDemux* self, const DemuxEvent& e) {
    guint8* data = (guint8*)g_memdup2(e.bytes.data(), e.bytes.size());
    GstMpegtsSection* sec = gst_mpegts_section_new((guint16)e.pid, data, e.bytes.size());
    if (!sec) return;                      // it frees the bytes
    gst_element_post_message(GST_ELEMENT_CAST(self),
                             gst_message_new_mpegts_section(GST_OBJECT_CAST(self), sec));
    gst_mpegts_section_unref(sec);
}

/* tsdemux's mpegversion refine (parse_aac_adts_frame): every PES, before its segment. */
static void adts_refine(DemuxOut* o, const std::vector<uint8_t>& payload) {
    const int v = mrts::adts_mpegversion(payload.data(), payload.size());
    if (v == o->adts_version) return;
    GST_DEBUG_OBJECT(o->pad, "mpegversion %d -> %d", o->adts_version, v);
    o->adts_version = v;
    GstCaps* caps = gst_caps_make_writable(gst_stream_get_caps(o->stream));
    gst_caps_set_simple(caps, "mpegversion", G_TYPE_INT, v, NULL);
    gst_stream_set_caps(o->stream, caps);
    gst_pad_set_caps(o->pad, caps);
    gst_caps_unref(caps);
}

/* One unit: a buffer, or a buffer list of the Opus packets or KLV cells it carries (tsdemux's
 * parse_access_unit), the first stamped; a unit that will not parse is dropped, as there. */
static GstFlowReturn program_unit(GstMrtsDemux* self, DemuxEvent& e) {
    DemuxOut* o = out_named(self, e.pad);
    if (!o) return GST_FLOW_OK;
    const bool discont = e.discont || o->discont;
    std::vector<std::pair<size_t, size_t>> pieces;   // offset, length
    std::vector<std::pair<int, int>> trims;          // Opus: start, end
    std::vector<std::pair<int, int>> cells;          // KLV: service id, flags
    if (o->es.post == AuPost::Adts) {
        adts_refine(o, e.bytes);
    } else if (o->es.post == AuPost::Opus) {
        std::vector<mrts::OpusAu> aus;
        if (!mrts::opus_access_units(e.bytes.data(), e.bytes.size(), &aus)) {
            GST_WARNING_OBJECT(o->pad, "an Opus access unit of %zu bytes will not parse; dropped",
                               e.bytes.size());
            o->discont = discont;
            return GST_FLOW_OK;
        }
        for (const mrts::OpusAu& a : aus) {
            pieces.emplace_back(a.off, a.len);
            trims.emplace_back(a.trim_start, a.trim_end);
        }
    } else if (o->es.post == AuPost::Klv) {
        std::vector<mrts::KlvCell> kc;
        if (!mrts::klv_metadata_cells(e.bytes.data(), e.bytes.size(), &kc)) {
            GST_WARNING_OBJECT(o->pad, "KLV metadata cells of %zu bytes will not parse; dropped",
                               e.bytes.size());
            o->discont = discont;
            return GST_FLOW_OK;
        }
        for (const mrts::KlvCell& c : kc) {
            pieces.emplace_back(c.off, c.len);
            cells.emplace_back(c.service_id, c.flags);
        }
    }
    program_head(self);
    out_head(o);
    o->discont = false;
    GstBuffer* whole = payload_buffer(e.bytes);
    GstFlowReturn ret;
    if (pieces.empty()) {
        // An ID3 metadata PES (0x15) without data alignment is a partial tag (tsdemux).
        if (o->stream_type == 0x15 && !e.hdr.data_alignment &&
            g_str_has_prefix(o->es.caps.c_str(), "meta/x-id3"))
            GST_BUFFER_FLAG_SET(whole, GST_BUFFER_FLAG_DELTA_UNIT);
        stamp(whole, e, discont);
        ret = gst_pad_push(o->pad, whole);
    } else {
        GstBufferList* list = gst_buffer_list_new_sized(pieces.size());
        for (size_t i = 0; i < pieces.size(); i++) {
            GstBuffer* b = gst_buffer_copy_region(whole, GST_BUFFER_COPY_MEMORY, pieces[i].first,
                                                  pieces[i].second);
            if (!trims.empty() && (trims[i].first || trims[i].second))
                gst_buffer_add_audio_clipping_meta(b, GST_FORMAT_DEFAULT, trims[i].first,
                                                   trims[i].second);
            if (!cells.empty()) {
                GstMpegtsPESMetadataMeta* m = gst_buffer_add_mpegts_pes_metadata_meta(b);
                m->metadata_service_id = (guint8)cells[i].first;
                m->flags = (guint8)cells[i].second;
            }
            if (i == 0) stamp(b, e, discont);
            gst_buffer_list_add(list, b);
        }
        gst_buffer_unref(whole);
        if (gst_buffer_list_length(list) == 1) {
            GstBuffer* one = gst_buffer_ref(gst_buffer_list_get(list, 0));
            gst_buffer_list_unref(list);
            ret = gst_pad_push(o->pad, one);
        } else {
            ret = gst_pad_push_list(o->pad, list);
        }
    }
    return gst_flow_combiner_update_pad_flow(self->combiner, o->pad, ret);
}

static void program_gap(GstMrtsDemux* self, const DemuxEvent& e) {
    DemuxOut* o = out_named(self, e.pad);
    if (!o) return;
    GST_DEBUG_OBJECT(o->pad, "gap (%s) %" G_GINT64_FORMAT " ns from %" G_GINT64_FORMAT, e.reason,
                     (gint64)e.dur_ns, (gint64)e.pts_ns);
    program_head(self);
    out_head(o);
    gst_pad_push_event(o->pad,
                       gst_event_new_gap((GstClockTime)e.pts_ns, (GstClockTime)e.dur_ns));
}

/* The core's outputs in order, emptied. The program's events always; after a failed combined
 * flow the units and gaps that remain are dropped and the flow goes upstream. */
static GstFlowReturn pads_push_outs(GstMrtsDemux* self) {
    GstFlowReturn ret = GST_FLOW_OK;
    for (DemuxEvent& e : *self->outs) {
        switch (e.kind) {
            case DemuxEvent::Kind::section:
                post_section(self, e);
                break;
            case DemuxEvent::Kind::plan:
                program_plan(self, e);
                break;
            case DemuxEvent::Kind::gone:
                program_gone(self);
                break;
            case DemuxEvent::Kind::unit:
                if (ret == GST_FLOW_OK) ret = program_unit(self, e);
                break;
            case DemuxEvent::Kind::gap:
                if (ret == GST_FLOW_OK) program_gap(self, e);
                break;
            case DemuxEvent::Kind::unknown: {
                const std::string reg = mrts::reg_text(e.reg);
                GST_WARNING_OBJECT(self, "PID 0x%04x: stream type 0x%02x%s%s has no pad (OQ-27)",
                                   e.pid, e.stream_type, reg.empty() ? "" : ", registration ",
                                   reg.c_str());
                GstStructure* s = demux_message(self, "unknown-stream");
                gst_structure_set(s, "pid", G_TYPE_INT, e.pid, "stream-type", G_TYPE_INT,
                                  e.stream_type, "registration", G_TYPE_STRING, reg.c_str(),
                                  "generation", G_TYPE_INT, e.generation, NULL);
                demux_post(self, s);
                break;
            }
            case DemuxEvent::Kind::not_house_time: {
                GST_WARNING_OBJECT(self, "PID 0x%04x: its first PTS is %" G_GINT64_FORMAT
                                   " ms from house time; its producer writes no house time",
                                   e.pid, (gint64)e.offset_ms);
                GstStructure* s = demux_message(self, "not-house-time");
                gst_structure_set(s, "pid", G_TYPE_INT, e.pid, "offset-ms", G_TYPE_INT64,
                                  (gint64)e.offset_ms, NULL);
                demux_post(self, s);
                break;
            }
            case DemuxEvent::Kind::no_stream:
                GST_WARNING_OBJECT(self, "no stream of `media` within 2 s of the PMT");
                demux_post(self, demux_message(self, "no-stream"));
                break;
        }
    }
    if (self->finish_pending && self->pads_old->empty()) program_finish(self);
    self->outs->clear();
    return ret;
}

static GstFlowReturn demux_push_outs(GstMrtsDemux* self) {
    return select_mode(self) ? select_push_outs(self) : pads_push_outs(self);
}

/* --- the sink pad --------------------------------------------------------------------- */

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
            /* Select mode: each upstream stream starts one here; its caps and segment follow
             * again. Demux mode: its id and group id name the next program's streams. */
            const gchar* id = NULL;
            gst_event_parse_stream_start(event, &id);
            g_free(self->stream_id);
            self->stream_id = g_strdup_printf("%s/select", id ? id : "mrtsdemux");
            self->have_group_id = gst_event_parse_group_id(event, &self->group_id);
            gst_event_unref(event);
            if (select_mode(self)) {
                self->started = self->caps_sent = self->segment_sent = FALSE;
                demux_push_stream_start(self);
            }
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
            gst_flow_combiner_reset(self->combiner);
            for (DemuxOut* o : *self->pads_now) o->head = false;   // the flush took the segments
            return gst_pad_event_default(pad, parent, event);   // to every src pad
        case GST_EVENT_EOS:
            if (self->core) {
                gint64 now = 0;
                const gboolean have_now = demux_clock_now(self, &now);
                self->core->drain(*self->outs);
                demux_push_outs(self);
                demux_report(self, have_now, now, TRUE);
            }
            if (select_mode(self)) {
                demux_push_stream_start(self);
                return gst_pad_push_event(self->srcpad, event);
            }
            /* Demux mode: EOS on every pad; with none it ends here, as in tsdemux. */
            for (DemuxOut* o : *self->pads_now) gst_pad_push_event(o->pad, gst_event_ref(event));
            gst_event_unref(event);
            return TRUE;
        default:
            return gst_pad_event_default(pad, parent, event);
    }
}

/* Every src pad: not seekable (a live bus). The select pad's CAPS query answers its caps; a
 * demux pad's are fixed (gst_pad_use_fixed_caps). */
static gboolean demux_src_query(GstPad* pad, GstObject* parent, GstQuery* query) {
    GstMrtsDemux* self = parent ? GST_MRTSDEMUX(parent) : NULL;
    if (!self) return gst_pad_query_default(pad, parent, query);
    if (GST_QUERY_TYPE(query) == GST_QUERY_SEEKING) {
        GstFormat fmt;
        gst_query_parse_seeking(query, &fmt, NULL, NULL, NULL);
        gst_query_set_seeking(query, fmt, FALSE, -1, -1);
        return TRUE;
    }
    if (GST_QUERY_TYPE(query) != GST_QUERY_CAPS || pad != self->srcpad)
        return gst_pad_query_default(pad, parent, query);
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

/* `media`: a comma list of the pad classes; false for a name that is none, or for none. */
static gboolean parse_media(const gchar* media, uint32_t* mask) {
    *mask = 0;
    gchar** parts = g_strsplit(media, ",", -1);
    gboolean ok = TRUE;
    for (gchar** p = parts; *p && ok; p++) {
        const gchar* name = g_strstrip(*p);
        EsClass c;
        if (!*name) continue;
        ok = mrts::es_class_from_name(name, &c);
        if (ok) *mask |= mrts::media_bit(c);
    }
    g_strfreev(parts);
    return ok && *mask != 0;
}

/* A start: the core from the properties as they are now; false when `select` names no stream
 * or `media` no class. */
static gboolean demux_start(GstMrtsDemux* self) {
    DemuxCore::Config cfg;
    GST_OBJECT_LOCK(self);
    gchar* select = g_strdup(self->select ? self->select : "");
    gchar* media = g_strdup(self->media ? self->media : MEDIA_ALL);
    cfg.program = self->program_number;
    cfg.sparse_gap_lag_ns = (int64_t)self->sparse_gap_lag;
    cfg.max_pes_bytes = self->max_pes_bytes;
    GST_OBJECT_UNLOCK(self);
    gboolean ok = TRUE;
    if (*select) {
        GstCaps* parsed = gst_caps_from_string(select);
        const GstStructure* st =
            parsed && gst_caps_get_size(parsed) == 1 ? gst_caps_get_structure(parsed, 0) : NULL;
        if (st && g_strcmp0(gst_structure_get_name(st), mrts::CAPS_302M) == 0)
            cfg.select = mrts::CAPS_302M;
        if (parsed) gst_caps_unref(parsed);
        if (cfg.select.empty()) {
            GST_ELEMENT_ERROR(self, LIBRARY, SETTINGS,
                              ("select \"%s\" names no stream mrtsdemux can select", select),
                              ("select names audio/x-smpte-302m; without it every stream of "
                               "`media` has its pad"));
            ok = FALSE;
        }
    } else if (!parse_media(media, &cfg.media_mask)) {
        GST_ELEMENT_ERROR(self, LIBRARY, SETTINGS, ("media \"%s\" names no pad class", media),
                          ("media lists video, audio, private, subpicture, comma-separated"));
        ok = FALSE;
    }
    g_free(select);
    g_free(media);
    if (!ok) return FALSE;
    GstCaps* caps = cfg.select.empty() ? NULL : gst_caps_new_empty_simple(mrts::CAPS_302M);
    GST_OBJECT_LOCK(self);
    if (self->caps) gst_caps_unref(self->caps);
    self->caps = caps;
    GST_OBJECT_UNLOCK(self);
    delete self->core;
    self->core = new DemuxCore(cfg);
    self->outs->clear();
    self->found_pid = -1;
    gst_segment_init(&self->in_segment, GST_FORMAT_UNDEFINED);
    self->started = self->caps_sent = self->segment_sent = FALSE;
    self->have_report = FALSE;
    self->report_at = 0;
    gst_flow_combiner_reset(self->combiner);
    self->finish_pending = FALSE;
    self->plan_gen = self->plan_pcr_pid = -1;
    self->pid.store(-1, std::memory_order_relaxed);
    self->generation.store(-1, std::memory_order_relaxed);
    self->pes.store(0, std::memory_order_relaxed);
    self->gaps.store(0, std::memory_order_relaxed);
    self->markers.store(0, std::memory_order_relaxed);
    self->markers_dropped.store(0, std::memory_order_relaxed);
    self->unknown_streams.store(0, std::memory_order_relaxed);
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
        pads_clear(self);
        delete self->core;
        self->core = NULL;
        g_free(self->stream_id);
        self->stream_id = NULL;
        self->have_group_id = FALSE;
    }
    return ret;
}

/* select's pad in the element while `select` names a stream: an ALWAYS pad there would be
 * linked at once by gst_parse, which then never links the demux mode's pads. */
static void demux_select_pad(GstMrtsDemux* self, gboolean want) {
    GstPad* in = gst_element_get_static_pad(GST_ELEMENT_CAST(self), "src");
    if (in) gst_object_unref(in);
    if (want && !in)
        gst_element_add_pad(GST_ELEMENT_CAST(self), self->srcpad);
    else if (!want && in)
        gst_element_remove_pad(GST_ELEMENT_CAST(self), self->srcpad);
}

/* Under the object lock: a mode change only in NULL or READY, where no pad streams. */
static gboolean demux_settable(GstMrtsDemux* self, const gchar* name) {
    if (GST_STATE(self) <= GST_STATE_READY && GST_STATE_PENDING(self) <= GST_STATE_READY)
        return TRUE;
    GST_WARNING_OBJECT(self, "%s changes only in NULL or READY; kept", name);
    return FALSE;
}

static void demux_set_property(GObject* object, guint prop_id, const GValue* value,
                               GParamSpec* pspec) {
    GstMrtsDemux* self = GST_MRTSDEMUX(object);
    switch (prop_id) {
        case PROP_SELECT: {
            GST_OBJECT_LOCK(self);
            if (!demux_settable(self, "select")) {
                GST_OBJECT_UNLOCK(self);
                break;
            }
            g_free(self->select);
            self->select = g_value_dup_string(value);
            const gboolean want = self->select && *self->select;
            GST_OBJECT_UNLOCK(self);
            demux_select_pad(self, want);
            break;
        }
        case PROP_MEDIA:
            GST_OBJECT_LOCK(self);
            if (demux_settable(self, "media")) {
                g_free(self->media);
                self->media = g_value_dup_string(value);
            }
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_PROGRAM_NUMBER:
            GST_OBJECT_LOCK(self);
            self->program_number = g_value_get_int(value);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_SPARSE_GAP_LAG:
            GST_OBJECT_LOCK(self);
            self->sparse_gap_lag = g_value_get_uint64(value);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_MAX_PES_BYTES:
            GST_OBJECT_LOCK(self);
            self->max_pes_bytes = g_value_get_uint(value);
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
        case PROP_MEDIA:
            GST_OBJECT_LOCK(self);
            g_value_set_string(value, self->media ? self->media : MEDIA_ALL);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_PROGRAM_NUMBER:
            GST_OBJECT_LOCK(self);
            g_value_set_int(value, self->program_number);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_SPARSE_GAP_LAG:
            GST_OBJECT_LOCK(self);
            g_value_set_uint64(value, self->sparse_gap_lag);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_MAX_PES_BYTES:
            GST_OBJECT_LOCK(self);
            g_value_set_uint(value, self->max_pes_bytes);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_PID:
            g_value_set_int(value, self->pid.load(std::memory_order_relaxed));
            break;
        case PROP_GENERATION:
            g_value_set_int(value, self->generation.load(std::memory_order_relaxed));
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
        case PROP_UNKNOWN_STREAMS:
            g_value_set_uint64(value, self->unknown_streams.load(std::memory_order_relaxed));
            break;
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
            break;
    }
}

static void demux_finalize(GObject* object) {
    GstMrtsDemux* self = GST_MRTSDEMUX(object);
    for (std::vector<DemuxOut*>* list : {self->pads_old, self->pads_now}) {
        for (DemuxOut* o : *list) out_free(o);
        delete list;
    }
    if (self->collection) gst_object_unref(self->collection);
    gst_flow_combiner_free(self->combiner);
    gst_object_unref(self->srcpad);
    delete self->core;
    delete self->outs;
    g_free(self->select);
    g_free(self->media);
    g_free(self->stream_id);
    if (self->caps) gst_caps_unref(self->caps);
    G_OBJECT_CLASS(gst_mrtsdemux_parent_class)->finalize(object);
}

static void gst_mrtsdemux_init(GstMrtsDemux* self) {
    new (&self->common) MrtsHouseCommon();
    new (&self->pid) std::atomic<gint>(-1);
    new (&self->generation) std::atomic<gint>(-1);
    new (&self->pes) std::atomic<guint64>(0);
    new (&self->gaps) std::atomic<guint64>(0);
    new (&self->markers) std::atomic<guint64>(0);
    new (&self->markers_dropped) std::atomic<guint64>(0);
    new (&self->unknown_streams) std::atomic<guint64>(0);
    self->select = NULL;
    self->program_number = -1;
    self->media = g_strdup(MEDIA_ALL);
    self->sparse_gap_lag = SPARSE_GAP_LAG_DEFAULT;
    self->max_pes_bytes = MAX_PES_BYTES_DEFAULT;
    self->caps = NULL;
    self->core = NULL;
    self->outs = new std::vector<DemuxEvent>();
    self->found_pid = -1;
    gst_segment_init(&self->in_segment, GST_FORMAT_UNDEFINED);
    self->stream_id = NULL;
    self->group_id = 0;
    self->have_group_id = FALSE;
    self->started = self->caps_sent = self->segment_sent = FALSE;
    self->have_report = FALSE;
    self->report_at = 0;
    self->pads_now = new std::vector<DemuxOut*>();
    self->pads_old = new std::vector<DemuxOut*>();
    self->collection = NULL;
    self->combiner = gst_flow_combiner_new();
    self->finish_pending = FALSE;
    self->plan_gen = self->plan_pcr_pid = -1;

    self->sinkpad = gst_pad_new_from_static_template(&demux_sink_tmpl, "sink");
    gst_pad_set_chain_function(self->sinkpad, GST_DEBUG_FUNCPTR(demux_chain));
    gst_pad_set_chain_list_function(self->sinkpad, GST_DEBUG_FUNCPTR(demux_chain_list));
    gst_pad_set_event_function(self->sinkpad, GST_DEBUG_FUNCPTR(demux_sink_event));
    gst_element_add_pad(GST_ELEMENT_CAST(self), self->sinkpad);
    /* Ours, added while `select` is set (demux_select_pad). */
    self->srcpad =
        GST_PAD(gst_object_ref_sink(gst_pad_new_from_static_template(&demux_src_tmpl, "src")));
    gst_pad_set_query_function(self->srcpad, GST_DEBUG_FUNCPTR(demux_src_query));
}

static void gst_mrtsdemux_class_init(GstMrtsDemuxClass* klass) {
    GObjectClass* gobject_class = G_OBJECT_CLASS(klass);
    GstElementClass* element_class = GST_ELEMENT_CLASS(klass);

    /* Section messages (GstMpegts) and codec tags (pbutils), as tsdemux registers them. */
    gst_mpegts_initialize();
    gst_pb_utils_init();

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
                            "Select mode: the one stream to output on the src pad, as caps: "
                            "audio/x-smpte-302m (PMT stream type 0x06 with registration BSSD). "
                            "Unset: the demux mode, a pad per stream of `media`. Changes only in "
                            "NULL or READY.",
                            NULL, at_start));
    g_object_class_install_property(
        gobject_class, PROP_PROGRAM_NUMBER,
        g_param_spec_int("program-number", "Program number",
                         "The program to follow; -1: the first in the PAT. Applies at the next "
                         "start.",
                         -1, 65535, -1, at_start));
    g_object_class_install_property(
        gobject_class, PROP_MEDIA,
        g_param_spec_string("media", "Media",
                            "Demux mode: the pad classes exposed, comma-separated (video, audio, "
                            "private, subpicture); the streams of other classes are never "
                            "reassembled. Changes only in NULL or READY.",
                            MEDIA_ALL, at_start));
    g_object_class_install_property(
        gobject_class, PROP_SPARSE_GAP_LAG,
        g_param_spec_uint64("sparse-gap-lag", "Sparse gap lag",
                            "Demux mode: a sparse pad gets a GAP up to program time less this, "
                            "once that span passes it (ns); 0: none. Applies at the next start.",
                            0, G_MAXUINT64, SPARSE_GAP_LAG_DEFAULT, at_start));
    g_object_class_install_property(
        gobject_class, PROP_MAX_PES_BYTES,
        g_param_spec_uint("max-pes-bytes", "Max PES bytes",
                          "A PES growing past this is dropped (R9). Applies at the next start.",
                          1024, G_MAXUINT, MAX_PES_BYTES_DEFAULT, at_start));
    g_object_class_install_property(
        gobject_class, PROP_PID,
        g_param_spec_int("pid", "PID",
                         "Select mode: the selected stream's PID; -1 while there is none, and "
                         "in the demux mode.",
                         -1, 0x1FFF, -1, ro));
    g_object_class_install_property(
        gobject_class, PROP_GENERATION,
        g_param_spec_int("generation", "Generation",
                         "Demux mode: the planned program's generation, its pad names' low 4 "
                         "bits; -1 before a plan.",
                         -1, G_MAXINT, -1, ro));
    g_object_class_install_property(
        gobject_class, PROP_PES,
        g_param_spec_uint64("pes", "PES", "Buffers out, one per PES, since the start.", 0,
                            G_MAXUINT64, 0, ro));
    g_object_class_install_property(
        gobject_class, PROP_GAPS,
        g_param_spec_uint64("gaps", "Gaps",
                            "GAP events out for lost content since the start: holes in a "
                            "pad's PTS and placed markers.",
                            0, G_MAXUINT64, 0, ro));
    g_object_class_install_property(
        gobject_class, PROP_MARKERS,
        g_param_spec_uint64("markers", "Markers",
                            "Bus gap markers (OQ-12) on a PID with a pad since the start.", 0,
                            G_MAXUINT64, 0, ro));
    g_object_class_install_property(
        gobject_class, PROP_MARKERS_DROPPED,
        g_param_spec_uint64("markers-dropped", "Markers dropped",
                            "Markers that left no GAP: nothing past what the pad already "
                            "emitted, or no placeable PTS.",
                            0, G_MAXUINT64, 0, ro));
    g_object_class_install_property(
        gobject_class, PROP_UNKNOWN_STREAMS,
        g_param_spec_uint64("unknown-streams", "Unknown streams",
                            "Demux mode: streams of `media` without a pad (no caps for their "
                            "type), once per PID per program, since the start (OQ-27).",
                            0, G_MAXUINT64, 0, ro));
    /* After our own: the common ids are clear of these (MrtsHouseCommon::PROP_BASE). */
    MrtsHouseCommon::install(gobject_class);

    /* tsdemux's templates before select's: a linker looking for a template to match finds one
     * of theirs first (private's caps are ANY), never src's, whose pad may be absent. */
    gst_element_class_add_static_pad_template(element_class, &demux_sink_tmpl);
    gst_element_class_add_static_pad_template(element_class, &video_tmpl);
    gst_element_class_add_static_pad_template(element_class, &audio_tmpl);
    gst_element_class_add_static_pad_template(element_class, &private_tmpl);
    gst_element_class_add_static_pad_template(element_class, &subpicture_tmpl);
    gst_element_class_add_static_pad_template(element_class, &demux_src_tmpl);
    gst_element_class_set_static_metadata(
        element_class, "Media Router formula demux", "Codec/Demuxer",
        "Demuxes MPEG-TS on the formula timeline (PTS = PES - 1 h): tsdemux's pads and events for "
        "every stream, or one selected stream, with GAP events for holes, bus gap markers and "
        "sparse pads",
        "Media Router <https://github.com/bccsa/media-router>");
}
