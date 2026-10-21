/* mrtsstamp (plan ch. 6 WI-P2-3): the bus egress stamp, by identity only. Every bus producer's
 * PES carry house time + 1 h, so a buffer is stamped with `mrts::IdentityStamp` (PES - 1 h,
 * unwrapped near the clock) and its running time is `max(stamp - base_time, 0)`.
 *
 * Both runners splice one element at the head of each `busout_*` egress, ahead of the
 * `capssetter ! capsfilter` pair, where the buffer is still singly owned (no copy) and the mux's
 * per-access-unit buffer lists are still whole, so `chain_list` can merge each into one bus
 * buffer (ADR-0011). `active` is the lazy arm: inactive it only counts bytes (`bytes-total`). */
#include <gst/gst.h>
#include <gst/base/gstbasetransform.h>

#include <atomic>

#include "mrts/ts_house.h"

/* GST_PLUGIN_DEFINE reads PACKAGE for GstPluginDesc.source. */
#define PACKAGE "media-router"
/* 3.0.0: the anchored stamper, its properties and messages removed (WI-P2-3). */
#define MRTSSTAMP_VERSION "3.0.0"

GST_DEBUG_CATEGORY_STATIC(mrtsstamp_debug);
#define GST_CAT_DEFAULT mrtsstamp_debug

/* Bus caps without packetsize: the element sits on the producer's own src, ahead of the caps
 * pair that pins them, so it takes whatever TS caps that producer emits. */
#define MRTSSTAMP_CAPS "video/mpegts, systemstream=(boolean)true"

enum {
    PROP_0,
    PROP_ACTIVE,
    PROP_COPY_COUNT,
    PROP_BYTES_TOTAL,
    PROP_COALESCE,
    PROP_COALESCED_LISTS,
};

#define GST_TYPE_MRTSSTAMP (gst_mrtsstamp_get_type())
G_DECLARE_FINAL_TYPE(GstMrTsStamp, gst_mrtsstamp, GST, MRTSSTAMP, GstBaseTransform)

struct _GstMrTsStamp {
    GstBaseTransform parent;

    GMutex lock;                 /* guards everything up to `copies` */
    gboolean active;
    gboolean checked;            /* one-shot clock/segment diagnostics per arm */
    gboolean seg_warned;         /* one-shot unmappable-segment report per arm */
    gboolean identity_posted;    /* `mrtsstamp-identity` posted for this arm */
    mrts::IdentityStamp *idst;   /* one stream: the egress's A/V share one floor */
    guint64 copies;              /* buffers handed to us non-writable */
    gint map_warned;             /* one-shot map-failure report (atomic, taken before the lock) */
    /* The producer's egress byte counter, armed or not: read by the runner's throughput
     * tracker from the main loop while the streaming thread adds. */
    std::atomic<guint64> bytes_total;
    std::atomic<int> coalesce;
    std::atomic<guint64> coalesced_lists;
};

G_DEFINE_TYPE(GstMrTsStamp, gst_mrtsstamp, GST_TYPE_BASE_TRANSFORM)

static GstStaticPadTemplate mrtsstamp_sink_tmpl = GST_STATIC_PAD_TEMPLATE(
    "sink", GST_PAD_SINK, GST_PAD_ALWAYS, GST_STATIC_CAPS(MRTSSTAMP_CAPS));
static GstStaticPadTemplate mrtsstamp_src_tmpl = GST_STATIC_PAD_TEMPLATE(
    "src", GST_PAD_SRC, GST_PAD_ALWAYS, GST_STATIC_CAPS(MRTSSTAMP_CAPS));

/* --- environment ---------------------------------------------------------- */

/* The pipeline clock's time, 0 without one. Identity unwraps against clock time; the base comes
 * off the position, so a natural base (liveCaptureClock) still lands on house time. */
static gint64 gst_mrtsstamp_clock_now(GstMrTsStamp *self) {
    GstClock *clock = gst_element_get_clock(GST_ELEMENT_CAST(self));
    if (clock == NULL) return 0;
    GstClockTime now = gst_clock_get_time(clock);
    gst_object_unref(clock);
    return GST_CLOCK_TIME_IS_VALID(now) ? (gint64)now : 0;
}

static gboolean gst_mrtsstamp_identity_segment(const GstSegment *seg) {
    return seg->format == GST_FORMAT_TIME && seg->rate == 1.0
           && seg->applied_rate == 1.0 && seg->start == 0 && seg->offset == 0
           && seg->base == 0 && seg->time == 0;
}

/* Once per arm, report (never fail on) the clock and segment the stamp rides on: a pipeline
 * that hits either needs a human, not a dropped stream. */
static void gst_mrtsstamp_check_env(GstMrTsStamp *self) {
    const gchar *name = GST_OBJECT_NAME(self);
    GstClock *clock = gst_element_get_clock(GST_ELEMENT_CAST(self));
    if (clock == NULL) {
        g_printerr("[mrtsstamp] %s: no pipeline clock at arm — PES are unwrapped against 0\n", name);
    } else {
        gint type = -1;
        if (GST_IS_SYSTEM_CLOCK(clock)) g_object_get(clock, "clock-type", &type, NULL);
        if (type != (gint)GST_CLOCK_TYPE_MONOTONIC) {
            g_printerr("[mrtsstamp] %s: pipeline clock is %s (clock-type=%d), not a "
                       "MONOTONIC GstSystemClock — the house-clock contract assumes "
                       "CLOCK_MONOTONIC\n",
                       name, G_OBJECT_TYPE_NAME(clock), type);
        }
        gst_object_unref(clock);
    }
    const GstSegment *seg = &GST_BASE_TRANSFORM_CAST(self)->segment;
    if (!GST_BASE_TRANSFORM_CAST(self)->have_segment) {
        g_printerr("[mrtsstamp] %s: no SEGMENT event yet — stamp may not survive the "
                   "wire (running-time mapping unknown)\n", name);
    } else if (!gst_mrtsstamp_identity_segment(seg)) {
        g_printerr("[mrtsstamp] %s: non-identity segment (format=%d rate=%f "
                   "appliedRate=%f start=%" G_GUINT64_FORMAT " offset=%" G_GUINT64_FORMAT
                   " base=%" G_GUINT64_FORMAT " time=%" G_GUINT64_FORMAT ") — stamps "
                   "are mapped back through it so running time still carries house "
                   "time\n",
                   name, (int)seg->format, seg->rate, seg->applied_rate, seg->start,
                   seg->offset, seg->base, seg->time);
    }
}

/* Buffer PTS whose RUNNING time is `running`: the wire carries running time + base time, so
 * a non-identity segment is undone through its own inverse. `why` is set when no mapping exists. */
static GstClockTime gst_mrtsstamp_position(GstMrTsStamp *self, gint64 running,
                                           const gchar **why) {
    GstBaseTransform *base = GST_BASE_TRANSFORM_CAST(self);
    const GstSegment *seg = &base->segment;
    if (!base->have_segment) {
        *why = "no SEGMENT event on the tee sink";
        return (GstClockTime)running;
    }
    if (gst_mrtsstamp_identity_segment(seg)) return (GstClockTime)running;
    if (seg->format != GST_FORMAT_TIME) {
        *why = "the segment format is not TIME";
        return (GstClockTime)running;
    }
    guint64 pos = gst_segment_position_from_running_time(seg, GST_FORMAT_TIME,
                                                         (guint64)running);
    if (!GST_CLOCK_TIME_IS_VALID(pos)) {
        *why = "the house stamp falls outside the current segment";
        return (GstClockTime)running;
    }
    return (GstClockTime)pos;
}

/* --- messages (posted outside the lock: a bus handler may re-enter us) ---- */

/* The segment cannot carry the stamp: once per arm, engine-visible through the runner. */
static void gst_mrtsstamp_post_segment_warning(GstMrTsStamp *self, const gchar *why) {
    GstStructure *s = gst_structure_new("mrtsstamp-segment-warning",
                                        "why", G_TYPE_STRING, why, NULL);
    gst_element_post_message(GST_ELEMENT_CAST(self),
                             gst_message_new_element(GST_OBJECT_CAST(self), s));
    g_printerr("[mrtsstamp] %s: %s — stamp written unmapped\n",
               GST_OBJECT_NAME(self), why);
}

/* The buffer would not map, so it leaves with its source timing: once per arm. */
static void gst_mrtsstamp_post_map_warning(GstMrTsStamp *self) {
    if (!g_atomic_int_compare_and_exchange(&self->map_warned, 0, 1))
        return;
    const gchar *why = "buffer would not map READ — stamp skipped";
    GstStructure *s = gst_structure_new("mrtsstamp-map-failed",
                                        "why", G_TYPE_STRING, why, NULL);
    gst_element_post_message(GST_ELEMENT_CAST(self),
                             gst_message_new_element(GST_OBJECT_CAST(self), s));
    g_printerr("[mrtsstamp] %s: %s — buffer passed through with source timing\n",
               GST_OBJECT_NAME(self), why);
}

/* The egress's first timing PES since the arm, for the runners' one log line. */
static void gst_mrtsstamp_post_identity(GstMrTsStamp *self, gint pid, gint64 stamp, gint64 pts) {
    GstStructure *s = gst_structure_new("mrtsstamp-identity",
                                        "pid", G_TYPE_INT, pid,
                                        "stamp", G_TYPE_INT64, stamp,
                                        "pts", G_TYPE_INT64, pts, NULL);
    gst_element_post_message(GST_ELEMENT_CAST(self),
                             gst_message_new_element(GST_OBJECT_CAST(self), s));
}

/* --- transform ------------------------------------------------------------ */

static GstFlowReturn gst_mrtsstamp_transform_ip(GstBaseTransform *base, GstBuffer *buf) {
    GstMrTsStamp *self = GST_MRTSSTAMP(base);
    self->bytes_total.fetch_add(gst_buffer_get_size(buf), std::memory_order_relaxed);
    if (!self->active) return GST_FLOW_OK;
    /* A gap marker (OQ-12) keeps its PTS, the gap's end, but loses its DTS: the restamp's is on
     * its input's timeline, which a bus queue reading DTS first takes for its level (B-19). */
    if (GST_BUFFER_FLAG_IS_SET(buf, GST_BUFFER_FLAG_GAP)) {
        GST_BUFFER_DTS(buf) = GST_CLOCK_TIME_NONE;
        return GST_FLOW_OK;
    }
    GstMapInfo mi;
    if (!gst_buffer_map(buf, &mi, GST_MAP_READ)) {
        gst_mrtsstamp_post_map_warning(self);
        return GST_FLOW_OK;
    }
    const gint64 clock_now = gst_mrtsstamp_clock_now(self);
    const gint64 base_time = (gint64)gst_element_get_base_time(GST_ELEMENT_CAST(self));
    int first_pid = 0;
    int64_t first_stamp = 0, first_pts = 0;
    gboolean post_identity = FALSE;

    g_mutex_lock(&self->lock);
    if (!self->active) {
        /* Raced with a disarm: the buffer leaves as it arrived. */
        g_mutex_unlock(&self->lock);
        gst_buffer_unmap(buf, &mi);
        return GST_FLOW_OK;
    }
    if (!self->checked) {
        self->checked = TRUE;
        gst_mrtsstamp_check_env(self);
    }
    const gint64 stamp = self->idst->stamp(mi.data, mi.size, clock_now, 0);
    if (!self->identity_posted && self->idst->first(0, &first_pid, &first_stamp, &first_pts)) {
        self->identity_posted = TRUE;
        post_identity = TRUE;
    }
    const gchar *seg_why = NULL;
    GstClockTime pos = gst_mrtsstamp_position(self, MAX(stamp - base_time, 0), &seg_why);
    if (seg_why != NULL && self->seg_warned) seg_why = NULL;
    else if (seg_why != NULL) self->seg_warned = TRUE;
    g_mutex_unlock(&self->lock);
    gst_buffer_unmap(buf, &mi);

    GST_BUFFER_PTS(buf) = pos;
    /* DTS too: tsdemux takes its PCR skew basis from DTS before PTS, so a mux DTS left in
     * place would silently override the stamp (ADR-0005's named regression). */
    GST_BUFFER_DTS(buf) = pos;

    if (post_identity) gst_mrtsstamp_post_identity(self, first_pid, first_stamp, first_pts);
    if (seg_why != NULL) gst_mrtsstamp_post_segment_warning(self, seg_why);
    return GST_FLOW_OK;
}

/* Counting only: a non-writable input costs basetransform a shallow GstBuffer copy before we
 * see it. Upstream of the tee this stays 0, which is why the element goes there. */
static GstFlowReturn gst_mrtsstamp_prepare_output_buffer(GstBaseTransform *base,
                                                         GstBuffer *inbuf,
                                                         GstBuffer **outbuf) {
    GstMrTsStamp *self = GST_MRTSSTAMP(base);
    if (!gst_buffer_is_writable(inbuf)) {
        g_mutex_lock(&self->lock);
        if (self->active) self->copies++;
        g_mutex_unlock(&self->lock);
    }
    return GST_BASE_TRANSFORM_CLASS(gst_mrtsstamp_parent_class)
        ->prepare_output_buffer(base, inbuf, outbuf);
}

/* --- coalesce (ADR-0011) -------------------------------------------------- */

/* Merging would hand a gap marker's flags and PTS to the whole access unit, or bury the
 * marker in a data buffer, so such a list goes member by member (B-10). */
static gboolean gst_mrtsstamp_list_has_gap(GstBufferList *list) {
    for (guint i = 0; i < gst_buffer_list_length(list); i++)
        if (GST_BUFFER_FLAG_IS_SET(gst_buffer_list_get(list, i), GST_BUFFER_FLAG_GAP)) return TRUE;
    return FALSE;
}

/* GstBaseTransform has no chain_list, so the core would split every mux list into 1316-byte
 * bus messages. A list of two or more members becomes one buffer with the first member's
 * timestamps, flags and metas and the summed duration; it goes through gst_pad_chain on our own
 * sink pad, so a BUFFER probe there still fires (the stream lock is recursive). */
static GstFlowReturn gst_mrtsstamp_sink_chain_list(GstPad *pad, GstObject *parent,
                                                   GstBufferList *list) {
    GstMrTsStamp *self = GST_MRTSSTAMP(parent);
    guint n = gst_buffer_list_length(list);
    GstBuffer *out = NULL;

    if (self->coalesce.load(std::memory_order_relaxed) && n >= 2
        && !gst_mrtsstamp_list_has_gap(list)) {
        gsize total = 0;
        GstClockTime duration = 0;
        gboolean all_durations = TRUE;
        for (guint i = 0; i < n; i++) {
            GstBuffer *b = gst_buffer_list_get(list, i);
            total += gst_buffer_get_size(b);
            if (GST_BUFFER_DURATION_IS_VALID(b)) duration += GST_BUFFER_DURATION(b);
            else all_durations = FALSE;
        }
        out = gst_buffer_new_allocate(NULL, total, NULL);
        GstMapInfo mo;
        if (out != NULL && gst_buffer_map(out, &mo, GST_MAP_WRITE)) {
            gsize off = 0;
            for (guint i = 0; i < n; i++) {
                GstBuffer *b = gst_buffer_list_get(list, i);
                off += gst_buffer_extract(b, 0, mo.data + off, gst_buffer_get_size(b));
            }
            gst_buffer_unmap(out, &mo);
            gst_buffer_copy_into(out, gst_buffer_list_get(list, 0),
                                 (GstBufferCopyFlags)(GST_BUFFER_COPY_FLAGS
                                                      | GST_BUFFER_COPY_TIMESTAMPS
                                                      | GST_BUFFER_COPY_META),
                                 0, (gsize)-1);
            if (all_durations) GST_BUFFER_DURATION(out) = duration;
            self->coalesced_lists.fetch_add(1, std::memory_order_relaxed);
        } else if (out != NULL) {
            gst_buffer_unref(out);       /* map failed: member by member */
            out = NULL;
        }
    }
    if (out != NULL) {
        gst_buffer_list_unref(list);
        return gst_pad_chain(pad, out);
    }
    GstFlowReturn ret = GST_FLOW_OK;
    for (guint i = 0; i < n && ret == GST_FLOW_OK; i++) {
        ret = gst_pad_chain(pad, gst_buffer_ref(gst_buffer_list_get(list, i)));
    }
    gst_buffer_list_unref(list);
    return ret;
}

/* --- GObject -------------------------------------------------------------- */

static void gst_mrtsstamp_set_property(GObject *object, guint prop_id,
                                       const GValue *value, GParamSpec *pspec) {
    GstMrTsStamp *self = GST_MRTSSTAMP(object);
    switch (prop_id) {
        case PROP_ACTIVE: {
            gboolean want = g_value_get_boolean(value);
            g_mutex_lock(&self->lock);
            if (want != self->active) {
                /* Every transition forgets the stream, so an arm starts a fresh floor and a
                 * fresh first-PES record. */
                self->active = want;
                self->checked = FALSE;
                self->seg_warned = FALSE;
                self->identity_posted = FALSE;
                g_atomic_int_set(&self->map_warned, 0);
                self->idst->reset();
            }
            g_mutex_unlock(&self->lock);
            /* Outside the lock: basetransform takes its own object lock here. */
            gst_base_transform_set_passthrough(GST_BASE_TRANSFORM(self), !want);
            break;
        }
        case PROP_COALESCE:
            self->coalesce.store(g_value_get_boolean(value) ? 1 : 0, std::memory_order_relaxed);
            break;
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
            break;
    }
}

static void gst_mrtsstamp_get_property(GObject *object, guint prop_id, GValue *value,
                                       GParamSpec *pspec) {
    GstMrTsStamp *self = GST_MRTSSTAMP(object);
    switch (prop_id) {
        case PROP_ACTIVE:
            g_mutex_lock(&self->lock);
            g_value_set_boolean(value, self->active);
            g_mutex_unlock(&self->lock);
            break;
        case PROP_COALESCE:
            g_value_set_boolean(value, self->coalesce.load(std::memory_order_relaxed) != 0);
            break;
        case PROP_COALESCED_LISTS:
            g_value_set_uint64(value, self->coalesced_lists.load(std::memory_order_relaxed));
            break;
        case PROP_BYTES_TOTAL:
            g_value_set_uint64(value, self->bytes_total.load(std::memory_order_relaxed));
            break;
        case PROP_COPY_COUNT:
            g_mutex_lock(&self->lock);
            g_value_set_uint64(value, self->copies);
            g_mutex_unlock(&self->lock);
            break;
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
            break;
    }
}

static void gst_mrtsstamp_finalize(GObject *object) {
    GstMrTsStamp *self = GST_MRTSSTAMP(object);
    delete self->idst;
    g_mutex_clear(&self->lock);
    G_OBJECT_CLASS(gst_mrtsstamp_parent_class)->finalize(object);
}

static void gst_mrtsstamp_init(GstMrTsStamp *self) {
    g_mutex_init(&self->lock);
    self->active = FALSE;
    self->checked = FALSE;
    self->seg_warned = FALSE;
    self->identity_posted = FALSE;
    self->idst = new mrts::IdentityStamp();
    self->copies = 0;
    self->map_warned = 0;
    self->bytes_total.store(0, std::memory_order_relaxed);
    self->coalesce.store(1, std::memory_order_relaxed);
    self->coalesced_lists.store(0, std::memory_order_relaxed);
    gst_base_transform_set_in_place(GST_BASE_TRANSFORM(self), TRUE);
    /* The base class installed its chain function already; chain_list is ours. */
    gst_pad_set_chain_list_function(GST_BASE_TRANSFORM(self)->sinkpad,
                                    gst_mrtsstamp_sink_chain_list);
    /* Inactive until the runner arms it on the tee's first consumer edge. */
    gst_base_transform_set_passthrough(GST_BASE_TRANSFORM(self), TRUE);
}

static void gst_mrtsstamp_class_init(GstMrTsStampClass *klass) {
    GObjectClass *gobject_class = G_OBJECT_CLASS(klass);
    GstElementClass *element_class = GST_ELEMENT_CLASS(klass);
    GstBaseTransformClass *base_class = GST_BASE_TRANSFORM_CLASS(klass);

    gobject_class->set_property = gst_mrtsstamp_set_property;
    gobject_class->get_property = gst_mrtsstamp_get_property;
    gobject_class->finalize = gst_mrtsstamp_finalize;

    g_object_class_install_property(
        gobject_class, PROP_ACTIVE,
        g_param_spec_boolean("active", "Active",
                             "Stamp buffers by identity (PES - 1 h). FALSE is passthrough that "
                             "only counts bytes; each transition forgets the stream.",
                             FALSE,
                             (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS
                                           | GST_PARAM_MUTABLE_PLAYING)));
    g_object_class_install_property(
        gobject_class, PROP_COPY_COUNT,
        g_param_spec_uint64("copy-count", "Copy count",
                            "Buffers that arrived non-writable and so had to be copied "
                            "before stamping (expected 0 upstream of the tee).",
                            0, G_MAXUINT64, 0,
                            (GParamFlags)(G_PARAM_READABLE | G_PARAM_STATIC_STRINGS)));
    g_object_class_install_property(
        gobject_class, PROP_BYTES_TOTAL,
        g_param_spec_uint64("bytes-total", "Bytes total",
                            "Bytes that passed this element since construction, stamping "
                            "or in passthrough: the producer's egress byte counter.",
                            0, G_MAXUINT64, 0,
                            (GParamFlags)(G_PARAM_READABLE | G_PARAM_STATIC_STRINGS)));
    g_object_class_install_property(
        gobject_class, PROP_COALESCE,
        g_param_spec_boolean("coalesce", "Coalesce buffer lists",
                             "Merge each incoming GstBufferList (mpegtsmux emits one per "
                             "access unit) into a single buffer, so the bus carries one "
                             "message per access unit instead of one per 1316-byte chunk "
                             "(ADR-0011). FALSE hands the members on one by one.",
                             TRUE,
                             (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS)));
    g_object_class_install_property(
        gobject_class, PROP_COALESCED_LISTS,
        g_param_spec_uint64("coalesced-lists", "Coalesced lists",
                            "Buffer lists merged into one buffer since construction.",
                            0, G_MAXUINT64, 0,
                            (GParamFlags)(G_PARAM_READABLE | G_PARAM_STATIC_STRINGS)));

    gst_element_class_add_static_pad_template(element_class, &mrtsstamp_sink_tmpl);
    gst_element_class_add_static_pad_template(element_class, &mrtsstamp_src_tmpl);
    gst_element_class_set_static_metadata(
        element_class, "Media Router MPEG-TS identity stamper", "Filter/Network",
        "Stamps bus MPEG-TS buffers by identity: PES - 1 h (ADR-0029)",
        "Media Router <https://github.com/bccsa/media-router>");

    base_class->transform_ip = gst_mrtsstamp_transform_ip;
    base_class->prepare_output_buffer = gst_mrtsstamp_prepare_output_buffer;
    /* Passthrough still reaches transform_ip, for the byte counter alone. */
    base_class->transform_ip_on_passthrough = TRUE;
    /* In and out caps are always identical: on, this would pin passthrough for good. */
    base_class->passthrough_on_same_caps = FALSE;
}

static gboolean plugin_init(GstPlugin *plugin) {
    GST_DEBUG_CATEGORY_INIT(mrtsstamp_debug, "mrtsstamp", 0,
                            "Media Router MPEG-TS identity stamper");
    /* Rank NONE: the runner loads the plugin by path and splices the element by name. */
    return gst_element_register(plugin, "mrtsstamp", GST_RANK_NONE, GST_TYPE_MRTSSTAMP);
}

GST_PLUGIN_DEFINE(GST_VERSION_MAJOR, GST_VERSION_MINOR, mrtsstamp,
                  "Media Router producer-side MPEG-TS identity stamper",
                  plugin_init, MRTSSTAMP_VERSION, "MIT/X11", "media-router",
                  "https://github.com/bccsa/media-router")
