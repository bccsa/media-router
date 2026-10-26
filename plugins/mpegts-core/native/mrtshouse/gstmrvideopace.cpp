/* mrvideopace (plan ch. 8 part 4.2, WI-P4-3; ch. 15.4 B-162): mrts::VideoPace as an element. Each
 * decoded frame leaves at its release on the element clock (the runners' monotonic clock, base
 * time 0), a rate drop at once; caps, allocation and scheduling are the neighbours' (dmabuf and
 * DMA_DRM pass untouched). The display period comes from the first GstBaseSink downstream:
 * 0008's `display-stats` (presented time over MSC), else a vsync sink's returns (kmssink), else
 * `refresh-mhz` (nominal), else none. While that sink reports frames it could not present (an
 * output switched off) frames pass unpaced, and the cadence restarts once it presents again. */
#include <algorithm>
#include <atomic>
#include <new>

#include <gst/base/gstbasesink.h>

#include "mrts/video_pace.h"
#include "mrtshouse.h"

#define GST_CAT_DEFAULT mrtshouse_debug

using mrts::DisplayPeriod;
using mrts::DisplaySource;
using mrts::PaceDecision;
using mrts::PaceSummary;
using mrts::PresentedSample;
using mrts::VideoPace;

enum {
    PROP_0,
    PROP_REFRESH_MHZ,
    PROP_GAP_THRESHOLD_MS,
    PROP_STATS,
};

#define DEFAULT_GAP_THRESHOLD_MS 250
static const gint64 UPDATE_NS = GST_SECOND;       // the display period, once a second
static const gint64 REPORT_NS = 2 * GST_SECOND;   // the `mrvideopace` message
/* A push this long blocked on the display (0008's 1 s timeout): read the sink before the next. */
static const gint64 LONG_PUSH_NS = GST_SECOND / 2;
/* Feedback read once a second: 64 samples span the 60 s S12 asks for. */
static const size_t SAMPLES = 64;
/* A blocking sink's returns: 60 s of frames at up to 68 fps. */
static const size_t RETURNS = 4096;

namespace {

/* The first GstBaseSink downstream and what it can tell. Streaming thread only. */
struct Display {
    enum class Kind { unknown, stats, vsync, other };
    GstElement* sink = nullptr;
    Kind kind = Kind::unknown;
    bool updated = false, force = false;
    gint64 last_update = 0;
    /* stats: the last presented sample per read, oldest first from `head`. */
    PresentedSample samples[SAMPLES];
    size_t n_samples = 0, head = 0;
    PresentedSample ordered[SAMPLES];
    bool have_counts = false, outage = false;
    guint64 not_presented = 0, timeouts = 0;
    bool have_presented = false;
    gint64 last_presented = 0, last_running = 0;
    /* vsync: the clock as each push returned. */
    gint64* returns = nullptr;
    gint64* scratch = nullptr;
    gint64* intervals = nullptr;
    size_t n_returns = 0, rhead = 0;

    void reset() {
        if (sink) gst_object_unref(sink);
        sink = nullptr;
        kind = Kind::unknown;
        updated = force = false;
        last_update = 0;
        n_samples = head = 0;
        have_counts = outage = false;
        not_presented = timeouts = 0;
        have_presented = false;
        last_presented = last_running = 0;
        n_returns = rhead = 0;
    }
};

/* What `stats` reads and the message carries. */
struct Snapshot {
    guint64 released = 0, late = 0, rate_drops = 0, gaps_collapsed = 0, unpaced = 0;
    gint64 content_period = 0, display_period = 0;
    DisplaySource source = DisplaySource::none;
    gint64 mean_hold = 0, present_lateness = 0;
    bool presenting = true;
};

}  // namespace

#define GST_TYPE_MRVIDEOPACE (gst_mrvideopace_get_type())
G_DECLARE_FINAL_TYPE(GstMrVideoPace, gst_mrvideopace, GST, MRVIDEOPACE, GstElement)

struct _GstMrVideoPace {
    GstElement parent;
    GstPad* sinkpad;
    GstPad* srcpad;

    std::atomic<guint> refresh_mhz;   // live: the next display update takes it
    guint gap_threshold_ms;           // object lock; applies at the next start

    /* The wait, under `lock`: the clock of this run, one clock id re-armed per frame, and
     * whether the streaming thread waits on it (FLUSH_START and PAUSED->READY unschedule it). */
    GMutex lock;
    GstClock* clock;
    GstClockID clock_id;
    GstClock* id_clock;
    gboolean waiting, flushing;
    std::atomic<bool> playing;

    /* Streaming state: chain and serialized events; a state change resets it while nothing
     * flows. A flush or an output's return starts a new pace, its counters folded in. */
    VideoPace* pace;
    Snapshot* folded;
    GstSegment segment;
    gint64 frame_dur;                 // the caps' frame period, 0 unknown
    Display* display;
    gboolean have_kept;
    gint64 last_lateness;             // the last kept frame's release - its running time
    gboolean have_post;
    gint64 next_post;
    guint64 unpaced;

    GMutex snap_lock;
    Snapshot* snap;

    MrtsHouseCommon common;
};

G_DEFINE_TYPE(GstMrVideoPace, gst_mrvideopace, GST_TYPE_ELEMENT)

static GstStaticPadTemplate vp_sink_tmpl =
    GST_STATIC_PAD_TEMPLATE("sink", GST_PAD_SINK, GST_PAD_ALWAYS, GST_STATIC_CAPS_ANY);
static GstStaticPadTemplate vp_src_tmpl =
    GST_STATIC_PAD_TEMPLATE("src", GST_PAD_SRC, GST_PAD_ALWAYS, GST_STATIC_CAPS_ANY);

/* --- time ----------------------------------------------------------------------------- */

/* Clock - base time, and the base time; false unless PLAYING with a clock. */
static gboolean vp_now(GstMrVideoPace* self, gint64* now, gint64* base) {
    if (!self->playing.load(std::memory_order_acquire)) return FALSE;
    g_mutex_lock(&self->lock);
    GstClock* clock = self->clock ? (GstClock*)gst_object_ref(self->clock) : NULL;
    g_mutex_unlock(&self->lock);
    if (!clock) return FALSE;
    const GstClockTime t = gst_clock_get_time(clock);
    gst_object_unref(clock);
    if (!GST_CLOCK_TIME_IS_VALID(t)) return FALSE;
    *base = (gint64)gst_element_get_base_time(GST_ELEMENT_CAST(self));
    *now = (gint64)t - *base;
    return TRUE;
}

/* Waits until release + base on the run's clock; false: flushing (the frame goes). */
static gboolean vp_wait(GstMrVideoPace* self, gint64 release, gint64 base) {
    if (release + base <= 0) return TRUE;
    const GstClockTime at = (GstClockTime)(release + base);
    g_mutex_lock(&self->lock);
    for (;;) {
        if (self->flushing) break;
        if (!self->clock) {
            g_mutex_unlock(&self->lock);
            return TRUE;
        }
        if (!self->clock_id || self->id_clock != self->clock ||
            !gst_clock_single_shot_id_reinit(self->clock, self->clock_id, at)) {
            if (self->clock_id) gst_clock_id_unref(self->clock_id);
            self->clock_id = gst_clock_new_single_shot_id(self->clock, at);
            self->id_clock = self->clock;
        }
        GstClockID id = gst_clock_id_ref(self->clock_id);
        self->waiting = TRUE;
        g_mutex_unlock(&self->lock);
        const GstClockReturn r = gst_clock_id_wait(id, NULL);
        gst_clock_id_unref(id);
        g_mutex_lock(&self->lock);
        self->waiting = FALSE;
        /* Unscheduled without a flush: the clock changed, wait again on the new one. */
        if (r != GST_CLOCK_UNSCHEDULED || self->flushing) break;
    }
    const gboolean go = !self->flushing;
    g_mutex_unlock(&self->lock);
    return go;
}

static void vp_unschedule(GstMrVideoPace* self) {
    g_mutex_lock(&self->lock);
    self->flushing = TRUE;
    if (self->waiting && self->clock_id) gst_clock_id_unschedule(self->clock_id);
    g_mutex_unlock(&self->lock);
}

/* --- the pace ------------------------------------------------------------------------- */

static void vp_fold(Snapshot* into, const PaceSummary& s) {
    into->released += s.released;
    into->late += s.late;
    into->rate_drops += s.rate_drops;
    into->gaps_collapsed += s.gaps_collapsed;
}

/* A new cadence (a flush, an output presenting again): the next frame leaves at its arrival. */
static void vp_restart_pace(GstMrVideoPace* self) {
    if (!self->pace) return;
    const PaceSummary was = self->pace->peek();
    vp_fold(self->folded, was);
    GST_OBJECT_LOCK(self);
    const gint64 gap_ns = (gint64)self->gap_threshold_ms * GST_MSECOND;
    GST_OBJECT_UNLOCK(self);
    *self->pace = VideoPace(gap_ns);
    self->pace->set_display(was.display_period, was.display_source);
    self->have_kept = FALSE;
}

static gint64 vp_prior_ns(GstMrVideoPace* self) {
    const guint mhz = self->refresh_mhz.load(std::memory_order_relaxed);
    return mhz ? (gint64)((2000000000000LL / mhz + 1) / 2) : 0;   // 1e12 / mhz, rounded
}

/* --- the display ---------------------------------------------------------------------- */

/* The first GstBaseSink the src pad feeds, through bins and the elements between. */
static GstElement* vp_downstream_sink(GstMrVideoPace* self) {
    GstPad* pad = gst_pad_get_peer(self->srcpad);
    for (int hop = 0; pad && hop < 32; hop++) {
        GstPad* next = NULL;
        if (GST_IS_GHOST_PAD(pad)) {   // a bin's sink: what it targets inside
            next = gst_ghost_pad_get_target(GST_GHOST_PAD(pad));
        } else if (GST_IS_PROXY_PAD(pad)) {   // the inside of a bin's src: what that feeds
            if (GstProxyPad* ghost = gst_proxy_pad_get_internal(GST_PROXY_PAD(pad))) {
                next = gst_pad_get_peer(GST_PAD(ghost));
                gst_object_unref(ghost);
            }
        } else if (GstElement* el = gst_pad_get_parent_element(pad)) {
            if (GST_IS_BASE_SINK(el)) {
                gst_object_unref(pad);
                return el;
            }
            GstIterator* it = gst_element_iterate_src_pads(el);
            GValue v = G_VALUE_INIT;
            if (gst_iterator_next(it, &v) == GST_ITERATOR_OK)
                next = gst_pad_get_peer(GST_PAD(g_value_get_object(&v)));
            g_value_unset(&v);
            gst_iterator_free(it);
            gst_object_unref(el);
        }
        gst_object_unref(pad);
        pad = next;
    }
    if (pad) gst_object_unref(pad);
    return NULL;
}

static void vp_find_sink(GstMrVideoPace* self) {
    Display& d = *self->display;
    GstElement* sink = vp_downstream_sink(self);
    if (!sink) return;
    d.sink = sink;
    GObjectClass* klass = G_OBJECT_GET_CLASS(sink);
    GParamSpec* ps = g_object_class_find_property(klass, "display-stats");
    GParamSpec* vs = g_object_class_find_property(klass, "skip-vsync");
    if (ps && G_PARAM_SPEC_VALUE_TYPE(ps) == GST_TYPE_STRUCTURE &&
        (ps->flags & G_PARAM_READABLE)) {
        d.kind = Display::Kind::stats;
    } else if (vs && G_PARAM_SPEC_VALUE_TYPE(vs) == G_TYPE_BOOLEAN &&
               (vs->flags & G_PARAM_READABLE)) {
        /* kmssink's: unless skipped, show_frame returns at the vblank after its flip. */
        gboolean skip = TRUE;
        g_object_get(sink, "skip-vsync", &skip, NULL);
        d.kind = skip ? Display::Kind::other : Display::Kind::vsync;
    } else {
        d.kind = Display::Kind::other;
    }
    GST_INFO_OBJECT(self, "display: %s, %s", GST_ELEMENT_NAME(sink),
                    d.kind == Display::Kind::stats   ? "presentation feedback"
                    : d.kind == Display::Kind::vsync ? "its returns"
                                                     : "no measurement");
}

static gboolean vp_get_u64(const GstStructure* s, const gchar* f, guint64* v) {
    return gst_structure_get_uint64(s, f, v);
}

/* 0008's display-stats: a presented sample when it is new; frames not presented since the
 * last read put the element in the outage mode, none take it out with a new cadence. */
static DisplayPeriod vp_read_feedback(GstMrVideoPace* self) {
    Display& d = *self->display;
    GstStructure* st = NULL;
    g_object_get(d.sink, "display-stats", &st, NULL);
    if (st) {
        guint64 presented = 0, seq = 0, at = GST_CLOCK_TIME_NONE, running = GST_CLOCK_TIME_NONE;
        guint64 not_presented = 0, timeouts = 0;
        gboolean monotonic = TRUE;
        vp_get_u64(st, "presented", &presented);
        vp_get_u64(st, "presented-seq", &seq);
        vp_get_u64(st, "last-presented-ns", &at);
        vp_get_u64(st, "last-running-time", &running);
        vp_get_u64(st, "not-presented", &not_presented);
        vp_get_u64(st, "present-timeouts", &timeouts);
        gst_structure_get_boolean(st, "clock-monotonic", &monotonic);
        gst_structure_free(st);
        if (d.have_counts) {
            const bool off = not_presented > d.not_presented || timeouts > d.timeouts;
            if (off && !d.outage) {
                d.outage = true;
                GST_INFO_OBJECT(self, "the display is not presenting: frames pass unpaced");
            } else if (!off && d.outage) {
                d.outage = false;
                vp_restart_pace(self);
                GST_INFO_OBJECT(self, "the display presents again: a new cadence");
            }
        }
        d.have_counts = true;
        d.not_presented = not_presented;
        d.timeouts = timeouts;
        if (monotonic && presented > 0 && seq > 0 && GST_CLOCK_TIME_IS_VALID(at) &&
            at <= (guint64)G_MAXINT64 && seq <= (guint64)G_MAXINT64) {
            const PresentedSample s{(gint64)at, (gint64)seq};
            const PresentedSample* last =
                d.n_samples ? &d.samples[(d.head + d.n_samples - 1) % SAMPLES] : NULL;
            if (!last || last->presented_ns != s.presented_ns || last->seq != s.seq) {
                if (d.n_samples == SAMPLES) {
                    d.samples[d.head] = s;
                    d.head = (d.head + 1) % SAMPLES;
                } else {
                    d.samples[(d.head + d.n_samples++) % SAMPLES] = s;
                }
            }
            if (GST_CLOCK_TIME_IS_VALID(running) && running <= (guint64)G_MAXINT64) {
                d.have_presented = true;
                d.last_presented = (gint64)at;
                d.last_running = (gint64)running;
            }
        }
    }
    for (size_t i = 0; i < d.n_samples; i++) d.ordered[i] = d.samples[(d.head + i) % SAMPLES];
    return mrts::display_period_from_feedback(d.ordered, d.n_samples);
}

/* The returns counted in the mode's refresh; without one, in their 25th-percentile interval:
 * the reference's own base, the smallest, is a late wake's short interval as often as not. */
static DisplayPeriod vp_read_returns(GstMrVideoPace* self) {
    Display& d = *self->display;
    size_t n_iv = 0;
    for (size_t i = 0; i < d.n_returns; i++) {
        d.scratch[i] = d.returns[(d.rhead + i) % RETURNS];
        if (i && d.scratch[i] > d.scratch[i - 1])
            d.intervals[n_iv++] = d.scratch[i] - d.scratch[i - 1];
    }
    gint64 base = vp_prior_ns(self);
    if (base <= 0 && n_iv) {
        std::nth_element(d.intervals, d.intervals + n_iv / 4, d.intervals + n_iv);
        base = d.intervals[n_iv / 4];
    }
    return mrts::display_period_from_returns(d.scratch, d.n_returns, base);
}

static void vp_note_return(GstMrVideoPace* self, gint64 t) {
    Display& d = *self->display;
    if (d.n_returns == RETURNS) {
        d.returns[d.rhead] = t;
        d.rhead = (d.rhead + 1) % RETURNS;
    } else {
        d.returns[(d.rhead + d.n_returns++) % RETURNS] = t;
    }
}

/* Once a second of arrivals (at once after a long push): the display period the pace uses,
 * measured when the sink gives one, else the mode's refresh, else none. */
static void vp_update_display(GstMrVideoPace* self, gint64 now) {
    Display& d = *self->display;
    if (d.updated && !d.force && now - d.last_update < UPDATE_NS) return;
    d.updated = true;
    d.force = false;
    d.last_update = now;
    if (d.kind == Display::Kind::unknown) vp_find_sink(self);
    DisplayPeriod p;
    if (d.kind == Display::Kind::stats) p = vp_read_feedback(self);
    else if (d.kind == Display::Kind::vsync) p = vp_read_returns(self);
    const gint64 prior = vp_prior_ns(self);
    if (p.period_ns > 0) self->pace->set_display(p.period_ns, DisplaySource::measured);
    else if (prior > 0) self->pace->set_display(prior, DisplaySource::nominal);
    else self->pace->set_display(0, DisplaySource::none);
}

/* --- reporting ------------------------------------------------------------------------ */

static guint content_fps_x100(gint64 period) {
    return period > 0 ? (guint)((200000000000LL / period + 1) / 2) : 0;   // 1e11 / period
}

/* The snapshot after a frame: the counters of this pace and those before it. */
static void vp_publish(GstMrVideoPace* self, gint64 base) {
    Snapshot s = *self->folded;
    if (self->pace) {
        const PaceSummary p = self->pace->peek();
        vp_fold(&s, p);
        s.content_period = p.content_period;
        s.display_period = p.display_period;
        s.source = p.display_source;
    }
    s.unpaced = self->unpaced;
    const Display& d = *self->display;
    s.presenting = !d.outage;
    if (d.have_presented) {
        s.present_lateness = d.last_presented - (d.last_running + base);
    } else if (self->have_kept) {
        s.present_lateness =
            self->last_lateness + (s.display_period ? s.display_period : s.content_period);
    }
    g_mutex_lock(&self->snap_lock);
    s.mean_hold = self->snap->mean_hold;
    *self->snap = s;
    g_mutex_unlock(&self->snap_lock);
}

static GstStructure* vp_structure(const Snapshot& s) {
    return gst_structure_new(
        "mrvideopace", "released", G_TYPE_UINT64, s.released, "late", G_TYPE_UINT64, s.late,
        "rate-drops", G_TYPE_UINT64, s.rate_drops, "gaps-collapsed", G_TYPE_UINT64,
        s.gaps_collapsed, "unpaced", G_TYPE_UINT64, s.unpaced, "content-fps-x100", G_TYPE_UINT,
        content_fps_x100(s.content_period), "refresh-ns", G_TYPE_UINT64,
        (guint64)std::max<gint64>(s.display_period, 0), "refresh-source", G_TYPE_STRING,
        mrts::display_source_name(s.source), "mean-hold-ns", G_TYPE_INT64, s.mean_hold,
        "present-lateness-ns", G_TYPE_INT64, s.present_lateness, "display-presenting",
        G_TYPE_BOOLEAN, (gboolean)s.presenting, NULL);
}

/* The `mrvideopace` message: at the first frame, then every 2 s of arrivals; the mean hold
 * over the frames since the one before. */
static void vp_report(GstMrVideoPace* self, gint64 now) {
    if (self->have_post && now < self->next_post) return;
    self->have_post = TRUE;
    self->next_post = now + REPORT_NS;
    const gint64 hold = self->pace ? self->pace->take().mean_hold : 0;
    g_mutex_lock(&self->snap_lock);
    self->snap->mean_hold = hold;
    GstStructure* st = vp_structure(*self->snap);
    g_mutex_unlock(&self->snap_lock);
    gst_element_post_message(GST_ELEMENT_CAST(self),
                             gst_message_new_element(GST_OBJECT_CAST(self), st));
}

/* --- pads ----------------------------------------------------------------------------- */

static GstFlowReturn vp_push_unpaced(GstMrVideoPace* self, GstBuffer* buf, gint64 base) {
    self->unpaced++;
    vp_publish(self, base);
    return gst_pad_push(self->srcpad, buf);
}

static GstFlowReturn vp_chain(GstPad*, GstObject* parent, GstBuffer* buf) {
    GstMrVideoPace* self = GST_MRVIDEOPACE(parent);
    gint64 now = 0, base = 0;
    const gboolean clocked = vp_now(self, &now, &base);
    const GstClockTime pts = GST_BUFFER_PTS(buf);
    GstClockTime running = GST_CLOCK_TIME_NONE;
    if (GST_CLOCK_TIME_IS_VALID(pts) && self->segment.format == GST_FORMAT_TIME)
        running = gst_segment_to_running_time(&self->segment, GST_FORMAT_TIME, pts);
    /* Untimed, before PLAYING (a preroll) or while the display presents nothing: as it comes. */
    if (!clocked || !self->pace || !GST_CLOCK_TIME_IS_VALID(running) ||
        running > (guint64)G_MAXINT64)
        return vp_push_unpaced(self, buf, base);
    vp_update_display(self, now);
    if (self->display->outage) return vp_push_unpaced(self, buf, base);

    const GstClockTime bdur = GST_BUFFER_DURATION(buf);
    const bool timed = GST_CLOCK_TIME_IS_VALID(bdur) && bdur <= (guint64)G_MAXINT64;
    const gint64 dur = timed ? (gint64)bdur : self->frame_dur;
    const PaceDecision d =
        self->pace->on_frame((gint64)running, dur, now, GST_BUFFER_IS_DISCONT(buf));
    GST_LOG_OBJECT(self, "pts %" GST_TIME_FORMAT " arrival %" G_GINT64_FORMAT " release %"
                   G_GINT64_FORMAT "%s", GST_TIME_ARGS(pts), now, d.release_ns,
                   d.rate_drop ? " (rate drop)" : "");
    if (d.rate_drop) {
        gst_buffer_unref(buf);
        vp_publish(self, base);
        vp_report(self, now);
        return GST_FLOW_OK;
    }
    if (!vp_wait(self, d.release_ns, base)) {
        gst_buffer_unref(buf);
        return GST_FLOW_FLUSHING;
    }
    self->have_kept = TRUE;
    self->last_lateness = d.release_ns - (gint64)running;
    vp_publish(self, base);
    vp_report(self, now);
    const GstFlowReturn ret = gst_pad_push(self->srcpad, buf);
    gint64 back = 0, base2 = 0;
    if (ret == GST_FLOW_OK && vp_now(self, &back, &base2)) {
        if (self->display->kind == Display::Kind::vsync) vp_note_return(self, back);
        if (back - std::max(now, d.release_ns) >= LONG_PUSH_NS) self->display->force = true;
    }
    return ret;
}

static gboolean vp_sink_event(GstPad* pad, GstObject* parent, GstEvent* event) {
    GstMrVideoPace* self = GST_MRVIDEOPACE(parent);
    switch (GST_EVENT_TYPE(event)) {
        case GST_EVENT_FLUSH_START:
            vp_unschedule(self);
            break;
        case GST_EVENT_FLUSH_STOP:
            g_mutex_lock(&self->lock);
            self->flushing = FALSE;
            g_mutex_unlock(&self->lock);
            gst_segment_init(&self->segment, GST_FORMAT_UNDEFINED);
            vp_restart_pace(self);
            break;
        case GST_EVENT_SEGMENT:
            gst_event_copy_segment(event, &self->segment);
            break;
        case GST_EVENT_CAPS: {
            GstCaps* caps = NULL;
            gst_event_parse_caps(event, &caps);
            const GstStructure* s =
                caps && gst_caps_get_size(caps) ? gst_caps_get_structure(caps, 0) : NULL;
            gint num = 0, den = 0;
            const gboolean rate = s && gst_structure_get_fraction(s, "framerate", &num, &den);
            self->frame_dur = rate && num > 0 && den > 0
                                  ? (gint64)gst_util_uint64_scale_int_round(GST_SECOND, den, num)
                                  : 0;
            break;
        }
        case GST_EVENT_GAP:
            if (self->pace) self->pace->on_gap();
            break;
        default:
            break;
    }
    return gst_pad_event_default(pad, parent, event);
}

/* --- GObject -------------------------------------------------------------------------- */

/* A start counts from 0 with a new pace; nothing flows. */
static void vp_start(GstMrVideoPace* self) {
    GST_OBJECT_LOCK(self);
    const gint64 gap_ns = (gint64)self->gap_threshold_ms * GST_MSECOND;
    GST_OBJECT_UNLOCK(self);
    delete self->pace;
    self->pace = new VideoPace(gap_ns);
    *self->folded = Snapshot();
    gst_segment_init(&self->segment, GST_FORMAT_UNDEFINED);
    self->frame_dur = 0;
    self->display->reset();
    self->have_kept = FALSE;
    self->last_lateness = 0;
    self->have_post = FALSE;
    self->next_post = 0;
    self->unpaced = 0;
    g_mutex_lock(&self->snap_lock);
    *self->snap = Snapshot();
    g_mutex_unlock(&self->snap_lock);
    g_mutex_lock(&self->lock);
    self->flushing = FALSE;
    g_mutex_unlock(&self->lock);
    self->common.reset();
}

static void vp_use_clock(GstMrVideoPace* self, GstClock* clock) {
    g_mutex_lock(&self->lock);
    if (self->clock != clock) {
        gst_object_replace((GstObject**)&self->clock, (GstObject*)clock);
        if (self->waiting && self->clock_id) gst_clock_id_unschedule(self->clock_id);
    }
    g_mutex_unlock(&self->lock);
}

static gboolean vp_set_clock(GstElement* element, GstClock* clock) {
    vp_use_clock(GST_MRVIDEOPACE(element), clock);
    return GST_ELEMENT_CLASS(gst_mrvideopace_parent_class)->set_clock(element, clock);
}

static GstStateChangeReturn vp_change_state(GstElement* element, GstStateChange transition) {
    GstMrVideoPace* self = GST_MRVIDEOPACE(element);
    switch (transition) {
        case GST_STATE_CHANGE_READY_TO_PAUSED:
            vp_start(self);
            break;
        case GST_STATE_CHANGE_PAUSED_TO_PLAYING: {
            /* The clock and base time are set before this. */
            GstClock* clock = gst_element_get_clock(element);
            vp_use_clock(self, clock);
            if (clock) gst_object_unref(clock);
            self->playing.store(true, std::memory_order_release);
            break;
        }
        case GST_STATE_CHANGE_PLAYING_TO_PAUSED:
            self->playing.store(false, std::memory_order_release);
            break;
        case GST_STATE_CHANGE_PAUSED_TO_READY:
            /* Before the pads deactivate: a chain waiting for a release returns at once. */
            vp_unschedule(self);
            break;
        default:
            break;
    }
    const GstStateChangeReturn ret =
        GST_ELEMENT_CLASS(gst_mrvideopace_parent_class)->change_state(element, transition);
    if (transition == GST_STATE_CHANGE_PAUSED_TO_READY) {
        g_mutex_lock(&self->lock);
        if (self->clock_id) gst_clock_id_unref(self->clock_id);
        self->clock_id = NULL;
        self->id_clock = NULL;
        gst_clear_object(&self->clock);
        g_mutex_unlock(&self->lock);
        self->display->reset();
        delete self->pace;
        self->pace = NULL;
    }
    return ret;
}

static void vp_set_property(GObject* object, guint prop_id, const GValue* value,
                            GParamSpec* pspec) {
    GstMrVideoPace* self = GST_MRVIDEOPACE(object);
    switch (prop_id) {
        case PROP_REFRESH_MHZ:
            self->refresh_mhz.store(g_value_get_uint(value), std::memory_order_relaxed);
            break;
        case PROP_GAP_THRESHOLD_MS:
            GST_OBJECT_LOCK(self);
            self->gap_threshold_ms = g_value_get_uint(value);
            GST_OBJECT_UNLOCK(self);
            break;
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
            break;
    }
}

static void vp_get_property(GObject* object, guint prop_id, GValue* value, GParamSpec* pspec) {
    GstMrVideoPace* self = GST_MRVIDEOPACE(object);
    if (self->common.get(prop_id, value)) return;
    switch (prop_id) {
        case PROP_REFRESH_MHZ:
            g_value_set_uint(value, self->refresh_mhz.load(std::memory_order_relaxed));
            break;
        case PROP_GAP_THRESHOLD_MS:
            GST_OBJECT_LOCK(self);
            g_value_set_uint(value, self->gap_threshold_ms);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_STATS: {
            g_mutex_lock(&self->snap_lock);
            GstStructure* s = vp_structure(*self->snap);
            g_mutex_unlock(&self->snap_lock);
            g_value_take_boxed(value, s);
            break;
        }
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
            break;
    }
}

static void vp_finalize(GObject* object) {
    GstMrVideoPace* self = GST_MRVIDEOPACE(object);
    if (self->clock_id) gst_clock_id_unref(self->clock_id);
    gst_clear_object(&self->clock);
    self->display->reset();
    delete[] self->display->returns;
    delete[] self->display->scratch;
    delete[] self->display->intervals;
    delete self->display;
    delete self->pace;
    delete self->folded;
    delete self->snap;
    g_mutex_clear(&self->lock);
    g_mutex_clear(&self->snap_lock);
    G_OBJECT_CLASS(gst_mrvideopace_parent_class)->finalize(object);
}

static GstPad* vp_new_pad(GstMrVideoPace* self, GstStaticPadTemplate* tmpl, const gchar* name) {
    GstPad* pad = gst_pad_new_from_static_template(tmpl, name);
    /* Caps, allocation and scheduling are the decoder's and the sink's: dmabuf passes untouched. */
    GST_PAD_SET_PROXY_CAPS(pad);
    GST_PAD_SET_PROXY_ALLOCATION(pad);
    GST_PAD_SET_PROXY_SCHEDULING(pad);
    gst_element_add_pad(GST_ELEMENT_CAST(self), pad);
    return pad;
}

static void gst_mrvideopace_init(GstMrVideoPace* self) {
    new (&self->common) MrtsHouseCommon();
    new (&self->refresh_mhz) std::atomic<guint>(0);
    new (&self->playing) std::atomic<bool>(false);
    self->gap_threshold_ms = DEFAULT_GAP_THRESHOLD_MS;
    g_mutex_init(&self->lock);
    self->clock = NULL;
    self->clock_id = NULL;
    self->id_clock = NULL;
    self->waiting = self->flushing = FALSE;
    self->pace = NULL;
    self->folded = new Snapshot();
    self->display = new Display();
    self->display->returns = new gint64[RETURNS];
    self->display->scratch = new gint64[RETURNS];
    self->display->intervals = new gint64[RETURNS];
    g_mutex_init(&self->snap_lock);
    self->snap = new Snapshot();
    gst_segment_init(&self->segment, GST_FORMAT_UNDEFINED);
    self->frame_dur = 0;
    self->have_kept = self->have_post = FALSE;
    self->last_lateness = self->next_post = 0;
    self->unpaced = 0;

    self->sinkpad = vp_new_pad(self, &vp_sink_tmpl, "sink");
    gst_pad_set_chain_function(self->sinkpad, GST_DEBUG_FUNCPTR(vp_chain));
    gst_pad_set_event_function(self->sinkpad, GST_DEBUG_FUNCPTR(vp_sink_event));
    self->srcpad = vp_new_pad(self, &vp_src_tmpl, "src");
}

static void gst_mrvideopace_class_init(GstMrVideoPaceClass* klass) {
    GObjectClass* gobject_class = G_OBJECT_CLASS(klass);
    GstElementClass* element_class = GST_ELEMENT_CLASS(klass);

    gobject_class->set_property = vp_set_property;
    gobject_class->get_property = vp_get_property;
    gobject_class->finalize = vp_finalize;
    element_class->change_state = vp_change_state;
    element_class->set_clock = vp_set_clock;

    const GParamFlags live =
        (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS | GST_PARAM_MUTABLE_PLAYING);
    const GParamFlags at_start =
        (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS | GST_PARAM_MUTABLE_READY);
    g_object_class_install_property(
        gobject_class, PROP_REFRESH_MHZ,
        g_param_spec_uint("refresh-mhz", "Refresh (mHz)",
                          "The output mode's refresh in mHz, 0 unknown: the period used until the "
                          "sink measures one (no decimation inside 0.05 % of it), and the base a "
                          "blocking sink's returns are counted in. Live, from the next second.",
                          0, 1000000, 0, live));
    g_object_class_install_property(
        gobject_class, PROP_GAP_THRESHOLD_MS,
        g_param_spec_uint("gap-threshold-ms", "Gap threshold (ms)",
                          "A PTS step past min(this, 4 frames) is a content gap: the backlog "
                          "drains into it. Applies at the next start.",
                          0, 10000, DEFAULT_GAP_THRESHOLD_MS, at_start));
    g_object_class_install_property(
        gobject_class, PROP_STATS,
        g_param_spec_boxed("stats", "Stats",
                           "The `mrvideopace` message's fields now: released, late, rate-drops, "
                           "gaps-collapsed and unpaced since the start, content-fps-x100, "
                           "refresh-ns and refresh-source (measured, nominal, none), mean-hold-ns "
                           "(the last message's), present-lateness-ns and display-presenting.",
                           GST_TYPE_STRUCTURE,
                           (GParamFlags)(G_PARAM_READABLE | G_PARAM_STATIC_STRINGS)));
    /* After our own: the common ids are clear of these (MrtsHouseCommon::PROP_BASE). */
    MrtsHouseCommon::install(gobject_class);

    gst_element_class_add_static_pad_template(element_class, &vp_sink_tmpl);
    gst_element_class_add_static_pad_template(element_class, &vp_src_tmpl);
    gst_element_class_set_static_metadata(
        element_class, "Media Router video pace", "Filter/Video",
        "Releases each decoded frame on the content's cadence, never before it arrives, and drops "
        "frames deterministically to match a display slower than the content",
        "Media Router <https://github.com/bccsa/media-router>");
}
