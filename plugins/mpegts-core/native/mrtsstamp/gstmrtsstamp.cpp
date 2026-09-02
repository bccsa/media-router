/* mrtsstamp — the time-sync contract's producer-side egress stamper, as a
 * GStreamer element.
 *
 * ADR-0005 decision 2: a producer maps its source's PES timeline onto the house
 * clock ONCE and rewrites its bus buffers' PTS/DTS with the result, so every
 * consumer inherits identical timing by construction instead of re-deriving it
 * from its own arrival. This element is the C++ half of that; the python probe
 * in the runner's `gst_bus_stamper.py` (`arm`) is the reference and the
 * fallback, and the arithmetic below is not a second implementation — it is
 * `mrts::TimelineStamper` verbatim, the same object `mr-tssplit` and
 * `mr-bus-fanout` run, conformance-pinned buffer-for-buffer against the python
 * one.
 *
 * WHY an element at all: the python probe's cost is not TS parsing (one fused
 * parse pass already took that term down 2x), it is FIXED per-buffer overhead —
 * PyGObject callback dispatch plus the whole-buffer `bytes` copy pygobject makes
 * on every `MapInfo.data` read. Measured on the Pi 400 at 10.9.1.42
 * (2026-08-12) that left a routed producer +323 cgroup ticks/min while the same
 * arithmetic inside `mr-tssplit` cost ~18. The only way down is off the python
 * probe, so: same maths, native call path, no copy.
 *
 * PLACEMENT: between the bus egress capsfilter and the `busout_*` tee (the
 * runner inserts it there via the element API — the pipeline STRINGS are
 * untouched, so with the contract off the graph is byte-identical). Upstream of
 * the tee the buffer is normally singly-owned, so basetransform hands it to us
 * in place with no copy at all; downstream of the tee every branch would see a
 * shared buffer and pay a (shallow) copy each. `copy-count` counts exactly that
 * case so the claim stays measured rather than assumed.
 *
 * LAZY ARM: the `active` property is the contract's arm/disarm. Inactive is
 * basetransform passthrough; the buffer is still handed to `transform_ip`
 * (`transform_ip_on_passthrough` on) but only for the `bytes-total` counter —
 * one size read and one atomic add — and the stamping path stays behind the
 * `active` check, so a tee with no consumer edge pays nothing for stamping.
 * The counter is the producer's egress byte counter, read by the runner's
 * throughput tracker instead of a per-buffer python probe (which cost 0.5-0.7
 * of a core per producer on a Pi 4, 2026-09-02). Activating starts a FRESH
 * latch (an anchor only ever means anything to the consumers that held it);
 * deactivating drops all state; the byte counter runs across both.
 *
 * FILE SIZE, deliberately over the repo's ~250-line guideline (CLAUDE.md): a
 * GStreamer element is one cohesive unit — GObject boilerplate, property
 * plumbing and `transform_ip` are a single registration contract that reads as
 * one file and cannot be understood in halves. The timeline arithmetic, which
 * is the part that would be worth extracting, IS already extracted: it lives in
 * `mrts::TimelineStamper` and is maintained in line-for-line parity with
 * `py/ts_timeline.py`. What is left here is the element, and splitting THAT
 * would only add a second place to look for one registration.
 */
#include <gst/gst.h>
#include <gst/base/gstbasetransform.h>

#include <atomic>
#include <vector>

#include "mrts/ts_timeline.h"

/* GST_PLUGIN_DEFINE reads PACKAGE for GstPluginDesc.source. */
#define PACKAGE "media-router"
#define MRTSSTAMP_VERSION "2.1.0"

GST_DEBUG_CATEGORY_STATIC(mrtsstamp_debug);
#define GST_CAT_DEFAULT mrtsstamp_debug

/* Bus caps, identical to busHelpers.BUS_TS_CAPS minus packetsize: the element
 * only ever sits behind that capsfilter, and leaving packetsize open keeps it
 * from inventing a negotiation failure the python probe never had. */
#define MRTSSTAMP_CAPS "video/mpegts, systemstream=(boolean)true"

/* One anchor / re-anchor notification, collected under the lock by the
 * TimelineStamper callbacks and posted on the bus after it is released —
 * posting a message runs arbitrary bus handlers, and doing that under our own
 * lock invites a deadlock with the thread setting `active`. */
struct MrTsStampPending {
    gboolean reanchor;
    gint pid;
    gint64 anchor_ns;
    gint64 ref_pts;
    gint64 last_pts;
    gint64 delta_ticks;
    gint64 count;
};

enum {
    PROP_0,
    PROP_ACTIVE,
    PROP_COPY_COUNT,
    PROP_DRIFT,
    PROP_BYTES_TOTAL,
};

#define GST_TYPE_MRTSSTAMP (gst_mrtsstamp_get_type())
G_DECLARE_FINAL_TYPE(GstMrTsStamp, gst_mrtsstamp, GST, MRTSSTAMP, GstBaseTransform)

struct _GstMrTsStamp {
    GstBaseTransform parent;

    GMutex lock;                 /* guards everything below */
    gboolean active;
    gboolean checked;            /* one-shot clock/segment diagnostics per arm */
    gboolean seg_warned;         /* one-shot unmappable-segment report per arm */
    guint64 copies;              /* buffers we were handed as a COPY (see above) */
    /* Bytes seen on the sink pad since construction, active OR passthrough —
     * the producer's egress byte counter (`bytes-total`). Counted here, in C,
     * because this element already sits in front of every `busout_*` tee and
     * a python pad probe at this rate (~1170 single buffers/s at 12 Mbps —
     * capssetter/capsfilter dismantle the mux's buffer lists) cost the runner
     * 0.5-0.7 of a core PER PRODUCER (Pi 4, 2026-09-02: a box at 60 % fell
     * to 26 % with the probe removed). Atomic: read by the runner's
     * get_throughput from the main loop while the streaming thread adds. */
    std::atomic<guint64> bytes_total;
    mrts::TimelineStamper *st;
    std::vector<MrTsStampPending> *pending;
};

G_DEFINE_TYPE(GstMrTsStamp, gst_mrtsstamp, GST_TYPE_BASE_TRANSFORM)

static GstStaticPadTemplate mrtsstamp_sink_tmpl = GST_STATIC_PAD_TEMPLATE(
    "sink", GST_PAD_SINK, GST_PAD_ALWAYS, GST_STATIC_CAPS(MRTSSTAMP_CAPS));
static GstStaticPadTemplate mrtsstamp_src_tmpl = GST_STATIC_PAD_TEMPLATE(
    "src", GST_PAD_SRC, GST_PAD_ALWAYS, GST_STATIC_CAPS(MRTSSTAMP_CAPS));

/* --- stamper state ------------------------------------------------------- */

/* Fresh latch + fresh callbacks. Called with the lock held on every `active`
 * transition, so an arm never inherits the previous incarnation's anchor. */
static void gst_mrtsstamp_reset(GstMrTsStamp *self) {
    delete self->st;
    self->pending->clear();
    std::vector<MrTsStampPending> *pending = self->pending;
    self->st = new mrts::TimelineStamper(
        [pending](const mrts::TimelineStamper::Anchored &a) {
            pending->push_back({FALSE, a.pid, a.anchor_ns, a.ref_pts, 0, 0, 0});
        },
        [pending](const mrts::TimelineStamper::Reanchor &r) {
            pending->push_back({TRUE, r.pid, r.anchor_ns, r.pts, r.last_pts,
                                r.delta_ticks, (gint64)r.count});
        });
}

/* Running-time, which under the contract IS house-clock time. Written as
 * clock − base_time rather than clock.get_time() (the python probe's exact
 * expression) so a pipeline that somehow missed the contract clock still gets a
 * self-consistent timeline instead of one offset by its base-time. */
static gint64 gst_mrtsstamp_house_now(GstMrTsStamp *self) {
    GstClock *clock = gst_element_get_clock(GST_ELEMENT_CAST(self));
    if (clock == NULL) return 0;
    GstClockTime now = gst_clock_get_time(clock);
    gst_object_unref(clock);
    if (!GST_CLOCK_TIME_IS_VALID(now)) return 0;
    gint64 v = (gint64)now - (gint64)gst_element_get_base_time(GST_ELEMENT_CAST(self));
    return v > 0 ? v : 0;
}

static gboolean gst_mrtsstamp_identity_segment(const GstSegment *seg) {
    return seg->format == GST_FORMAT_TIME && seg->rate == 1.0
           && seg->applied_rate == 1.0 && seg->start == 0 && seg->offset == 0
           && seg->base == 0 && seg->time == 0;
}

/* One-shot, per arm: report (never fail on) the two environment assumptions the
 * stamp rides on. Report-only for the same reason the python probe's checks
 * are — a real pipeline that hits either needs a human, not a dropped stream. */
static void gst_mrtsstamp_check_env(GstMrTsStamp *self) {
    const gchar *name = GST_OBJECT_NAME(self);

    /* House clock. The contract pins a monotonic GstSystemClock with
     * base_time=0; anything else and `house_now` is not house time. */
    GstClock *clock = gst_element_get_clock(GST_ELEMENT_CAST(self));
    if (clock == NULL) {
        g_printerr("[mrtsstamp] %s: no pipeline clock at arm — the anchor will be 0\n", name);
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

    /* Segment. What reaches the wire is not the PTS we write: unixfdsink
     * transmits gst_segment_to_running_time(segment, pts) + base_time. On the
     * identity segment a bus producer normally carries those are the same
     * number; anything else is mapped back through the segment in
     * `gst_mrtsstamp_position` below, so this is a note, not a fault. */
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

/* Buffer PTS that makes this buffer's RUNNING time equal `stamp`.
 *
 * The stamp is house-clock time, and house-clock time is what a consumer has to
 * end up seeing — but the wire carries running time, not PTS. On the identity
 * segment a bus producer normally has, the two are equal and this returns the
 * stamp unchanged; on anything else (an upstream `GstPad.set_offset`, a trimmed
 * or rate-scaled segment, a non-zero base after a seek) the segment's own
 * inverse mapping is what keeps the contract true instead of shipping silently
 * shifted timing. `why` is set when no mapping exists at all — the caller
 * reports that once, ENGINE-visibly. */
static GstClockTime gst_mrtsstamp_position(GstMrTsStamp *self, gint64 stamp,
                                           const gchar **why) {
    GstBaseTransform *base = GST_BASE_TRANSFORM_CAST(self);
    const GstSegment *seg = &base->segment;
    if (!base->have_segment) {
        *why = "no SEGMENT event on the tee sink";
        return (GstClockTime)stamp;
    }
    if (gst_mrtsstamp_identity_segment(seg)) return (GstClockTime)stamp;
    if (seg->format != GST_FORMAT_TIME) {
        *why = "the segment format is not TIME";
        return (GstClockTime)stamp;
    }
    guint64 pos = gst_segment_position_from_running_time(seg, GST_FORMAT_TIME,
                                                         (guint64)stamp);
    if (!GST_CLOCK_TIME_IS_VALID(pos)) {
        *why = "the house stamp falls outside the current segment";
        return (GstClockTime)stamp;
    }
    return (GstClockTime)pos;
}

/* A segment the stamp cannot be mapped through. ENGINE-VISIBLE and once per
 * arm: this is the case that silently ships shifted timing, so it must reach
 * the engine's log rather than our stderr. The runner turns it into the same
 * `warning` event the python probe emits for the same condition. */
static void gst_mrtsstamp_post_segment_warning(GstMrTsStamp *self, const gchar *why) {
    GstStructure *s = gst_structure_new("mrtsstamp-segment-warning",
                                        "why", G_TYPE_STRING, why, NULL);
    gst_element_post_message(GST_ELEMENT_CAST(self),
                             gst_message_new_element(GST_OBJECT_CAST(self), s));
    g_printerr("[mrtsstamp] %s: %s — stamp written unmapped\n",
               GST_OBJECT_NAME(self), why);
}

/* --- transform ----------------------------------------------------------- */

static void gst_mrtsstamp_post(GstMrTsStamp *self, const MrTsStampPending &p) {
    /* Field names are the python probe's event field names verbatim: the runner
     * translates these straight into the existing `timeline_restamped` /
     * `timeline_reanchor` engine events, so nothing downstream can tell which
     * stamper produced them. */
    GstStructure *s;
    if (p.reanchor) {
        s = gst_structure_new("mrtsstamp-reanchor",
                              "pid", G_TYPE_INT, p.pid,
                              "anchorNs", G_TYPE_INT64, p.anchor_ns,
                              "refPts90k", G_TYPE_INT64, p.ref_pts,
                              "lastPts90k", G_TYPE_INT64, p.last_pts,
                              "deltaTicks", G_TYPE_INT64, p.delta_ticks,
                              "count", G_TYPE_INT64, p.count, NULL);
    } else {
        s = gst_structure_new("mrtsstamp-anchor",
                              "pid", G_TYPE_INT, p.pid,
                              "anchorNs", G_TYPE_INT64, p.anchor_ns,
                              "refPts90k", G_TYPE_INT64, p.ref_pts, NULL);
    }
    gst_element_post_message(GST_ELEMENT_CAST(self),
                             gst_message_new_element(GST_OBJECT_CAST(self), s));
}

static GstFlowReturn gst_mrtsstamp_transform_ip(GstBaseTransform *base, GstBuffer *buf) {
    GstMrTsStamp *self = GST_MRTSSTAMP(base);
    GstMapInfo mi;

    /* Byte accounting first, every buffer, armed or not: in passthrough
     * (`transform_ip_on_passthrough` on) this is the whole per-buffer cost —
     * one size read and one atomic add, no map, no lock. */
    self->bytes_total.fetch_add(gst_buffer_get_size(buf), std::memory_order_relaxed);
    if (!self->active) return GST_FLOW_OK;

    /* READ, not READWRITE: only the buffer's PTS/DTS change, never its bytes. */
    if (!gst_buffer_map(buf, &mi, GST_MAP_READ)) return GST_FLOW_OK;

    gint64 now = gst_mrtsstamp_house_now(self);
    std::vector<MrTsStampPending> posts;
    gint64 stamp;

    g_mutex_lock(&self->lock);
    if (!self->active) {
        /* Raced with a disarm — leave the buffer exactly as it arrived, which
         * is what removing the python probe does. */
        g_mutex_unlock(&self->lock);
        gst_buffer_unmap(buf, &mi);
        return GST_FLOW_OK;
    }
    if (!self->checked) {
        self->checked = TRUE;
        gst_mrtsstamp_check_env(self);
    }
    /* ONE egress, so ONE stream: every branch of this producer shares the
     * anchor and the monotone floor, which is what keeps A/V paired. */
    stamp = self->st->stamp(mi.data, mi.size, now, 0);
    posts.swap(*self->pending);
    /* Segment mapping under the lock only for the one-shot warn latch; the
     * segment itself is owned by this (the streaming) thread. */
    const gchar *seg_why = NULL;
    GstClockTime pos = gst_mrtsstamp_position(self, stamp, &seg_why);
    if (seg_why != NULL && self->seg_warned) seg_why = NULL;
    else if (seg_why != NULL) self->seg_warned = TRUE;
    g_mutex_unlock(&self->lock);

    gst_buffer_unmap(buf, &mi);

    GST_BUFFER_PTS(buf) = pos;
    /* DTS is LOAD-BEARING, not tidiness: the consumer's tsdemux takes its PCR
     * skew basis from GST_BUFFER_DTS_OR_PTS — DTS FIRST — so a mux-generated DTS
     * riding along unchanged silently overrides the PTS we just wrote and the
     * whole contract becomes a no-op that nothing reports (ADR-0005's named
     * regression). */
    GST_BUFFER_DTS(buf) = pos;

    for (const MrTsStampPending &p : posts) gst_mrtsstamp_post(self, p);
    if (seg_why != NULL) gst_mrtsstamp_post_segment_warning(self, seg_why);
    return GST_FLOW_OK;
}

/* Counting only — the base implementation does all the work. A non-writable
 * input is what makes basetransform `gst_buffer_make_writable` before handing
 * us the buffer: a SHALLOW copy (the GstBuffer struct; its GstMemory is taken
 * by reference, the TS bytes are never copied), but still an allocation per
 * buffer. Upstream of the tee the buffer is singly-owned and this stays 0,
 * which is exactly why the element goes there and not on a tee branch. The
 * `copy_metadata` vfunc is NOT this signal: the make-writable path derives the
 * output from the input, so basetransform never calls it. */
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

/* --- GObject ------------------------------------------------------------- */

static void gst_mrtsstamp_set_property(GObject *object, guint prop_id,
                                       const GValue *value, GParamSpec *pspec) {
    GstMrTsStamp *self = GST_MRTSSTAMP(object);
    switch (prop_id) {
        case PROP_ACTIVE: {
            gboolean want = g_value_get_boolean(value);
            g_mutex_lock(&self->lock);
            if (want != self->active) {
                self->active = want;
                self->checked = FALSE;
                self->seg_warned = FALSE;
                gst_mrtsstamp_reset(self);
            }
            g_mutex_unlock(&self->lock);
            /* Outside the lock: basetransform takes its own object lock here.
             * Order matters — arming resets state BEFORE buffers can reach
             * transform_ip; disarming stops stamping before the state is gone
             * (the `!active` guard in transform_ip covers the in-flight buffer
             * either way). */
            gst_base_transform_set_passthrough(GST_BASE_TRANSFORM(self), !want);
            break;
        }
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
        case PROP_BYTES_TOTAL:
            g_value_set_uint64(value, self->bytes_total.load(std::memory_order_relaxed));
            break;
        case PROP_COPY_COUNT:
            g_mutex_lock(&self->lock);
            g_value_set_uint64(value, self->copies);
            g_mutex_unlock(&self->lock);
            break;
        case PROP_DRIFT: {
            /* A GstStructure, read by the runner's periodic drift report and
             * turned into the same `timeline_drift` engine event the python
             * probe builds from `TimelineStamper.drift_stats()` — field names
             * are that dict's, so which backend stamped stays invisible. */
            g_mutex_lock(&self->lock);
            mrts::TimelineStamper::Drift d = self->st->drift();
            g_mutex_unlock(&self->lock);
            g_value_take_boxed(value,
                               gst_structure_new("mrtsstamp-drift",
                                                 "ppm", G_TYPE_INT, d.ppm,
                                                 "slewNs", G_TYPE_INT64, d.slew_ns,
                                                 "marginNs", G_TYPE_INT64, d.margin_ns,
                                                 "engageNs", G_TYPE_INT64, d.engage_ns,
                                                 "samples", G_TYPE_INT, d.samples,
                                                 "window", G_TYPE_INT, d.window, NULL));
            break;
        }
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
            break;
    }
}

static void gst_mrtsstamp_finalize(GObject *object) {
    GstMrTsStamp *self = GST_MRTSSTAMP(object);
    delete self->st;
    delete self->pending;
    g_mutex_clear(&self->lock);
    G_OBJECT_CLASS(gst_mrtsstamp_parent_class)->finalize(object);
}

static void gst_mrtsstamp_init(GstMrTsStamp *self) {
    /* GObject memory is zeroed, but be explicit for the atomic. */
    self->bytes_total.store(0, std::memory_order_relaxed);
    g_mutex_init(&self->lock);
    self->active = FALSE;
    self->checked = FALSE;
    self->seg_warned = FALSE;
    self->copies = 0;
    self->st = NULL;
    self->pending = new std::vector<MrTsStampPending>();
    gst_mrtsstamp_reset(self);
    gst_base_transform_set_in_place(GST_BASE_TRANSFORM(self), TRUE);
    /* Inactive by default: the runner arms per tee on that tee's first consumer
     * edge, exactly where it armed the python probe. */
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
                             "Stamp buffers onto the house timeline. FALSE is pure "
                             "passthrough with no state and no per-buffer cost; each "
                             "transition starts a fresh anchor.",
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
                            "Bytes that passed this element since construction, whether "
                            "stamping or in passthrough — the producer's egress byte "
                            "counter, read by the runner's throughput tracker instead of "
                            "a per-buffer python probe.",
                            0, G_MAXUINT64, 0,
                            (GParamFlags)(G_PARAM_READABLE | G_PARAM_STATIC_STRINGS)));
    g_object_class_install_property(
        gobject_class, PROP_DRIFT,
        g_param_spec_boxed("drift", "Drift",
                           "Drift-servo state (ppm, slewNs, marginNs, engageNs, "
                           "samples, window) — the source's clock offset against ours and "
                           "what holding it has cost the anchor. Read periodically "
                           "by the runner; the native equivalent of the python "
                           "stamper's drift_stats().",
                           GST_TYPE_STRUCTURE,
                           (GParamFlags)(G_PARAM_READABLE | G_PARAM_STATIC_STRINGS)));

    gst_element_class_add_static_pad_template(element_class, &mrtsstamp_sink_tmpl);
    gst_element_class_add_static_pad_template(element_class, &mrtsstamp_src_tmpl);
    gst_element_class_set_static_metadata(
        element_class, "Media Router MPEG-TS timeline stamper", "Filter/Network",
        "Stamps bus MPEG-TS buffers with house-clock media time (ADR-0005)",
        "Media Router <https://github.com/bccsa/media-router>");

    base_class->transform_ip = gst_mrtsstamp_transform_ip;
    base_class->prepare_output_buffer = gst_mrtsstamp_prepare_output_buffer;
    /* Passthrough still hands every buffer to transform_ip — for the byte
     * counter only (one atomic add, then return; the stamping path is behind
     * the `active` check). This used to be FALSE so a disarmed egress paid
     * nothing per buffer; the counter's cost is a rounding error next to the
     * python probe it replaces, and a producer with no consumer attached must
     * still report its output bitrate. */
    base_class->transform_ip_on_passthrough = TRUE;
    /* In and out caps are always identical, so leaving this on would pin
     * passthrough permanently and the element could never arm. */
    base_class->passthrough_on_same_caps = FALSE;
}

static gboolean plugin_init(GstPlugin *plugin) {
    GST_DEBUG_CATEGORY_INIT(mrtsstamp_debug, "mrtsstamp", 0,
                            "Media Router MPEG-TS timeline stamper");
    /* Rank NONE: the runner loads this plugin explicitly and inserts the element
     * by name — it must never be auto-plugged into anything. */
    return gst_element_register(plugin, "mrtsstamp", GST_RANK_NONE, GST_TYPE_MRTSSTAMP);
}

GST_PLUGIN_DEFINE(GST_VERSION_MAJOR, GST_VERSION_MINOR, mrtsstamp,
                  "Media Router producer-side MPEG-TS timeline stamper",
                  plugin_init, MRTSSTAMP_VERSION, "MIT/X11", "media-router",
                  "https://github.com/bccsa/media-router")
