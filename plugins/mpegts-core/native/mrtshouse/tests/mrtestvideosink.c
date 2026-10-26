/* Test-only display sinks (plan ch. 15.4 B-162; WI-P4-3), never installed: mrvideopace's measured
 * display period without Weston or a DRM device. Each refreshes on its own grid on
 * CLOCK_MONOTONIC (`period-ns`, `drift-ppm`: negative is a slow display, its period longer).
 *
 * mrtestvideosink models waylandsink with Yocto 0008's present-every-frame: a frame waits until
 * the previous one is presented, at the first refresh after its commit, then is committed, and
 * `display-stats` has 0008's fields and types. `stall-ms` switches the output off for that long:
 * nothing is presented, a wait gives up after 1 s (`present-timeouts`) and until a refresh shows
 * the last commit again frames are committed at once, counted `not-presented` (0008's rule).
 *
 * mrtestkmssink models kmssink: unless `skip-vsync`, each frame returns at the first refresh after
 * it, every `late-every`th `late-us` after it (a late wake), and the sink has no stats. */
#include <gst/base/gstbasesink.h>
#include <gst/gst.h>

#define PACKAGE "media-router"

#define PRESENT_TIMEOUT_NS ((gint64)GST_SECOND)
#define DEFAULT_PERIOD_NS 20000000

/* --- the refresh grid ------------------------------------------------------------------- */

typedef struct {
    gint64 period_ns;
    gint ppm;
    gboolean started;
    gint64 origin;   /* refresh 0, the first frame's arrival */
} Grid;

static gint64 mono_ns(void) { return g_get_monotonic_time() * 1000; }

/* Refresh n: origin + n x period x (1e6 - ppm) / 1e6, floored. */
static gint64 grid_at(const Grid* g, gint64 n) {
    return g->origin + (gint64)((__int128)n * g->period_ns * (1000000 - g->ppm) / 1000000);
}

/* The first refresh strictly after t. */
static gint64 grid_next(const Grid* g, gint64 t) {
    if (t < g->origin) return 0;
    const __int128 span = (__int128)g->period_ns * (1000000 - g->ppm);
    gint64 n = (gint64)((__int128)(t - g->origin) * 1000000 / span) + 1;
    while (n > 0 && grid_at(g, n - 1) > t) n--;
    while (grid_at(g, n) <= t) n++;
    return n;
}

static gint64 grid_period(const Grid* g) {
    return (gint64)(((__int128)g->period_ns * (1000000 - g->ppm) * 2 + 1000000) / 2000000);
}

/* Until `at` (CLOCK_MONOTONIC ns) or a signal, `lock` held. */
static void wait_until(GCond* cond, GMutex* lock, gint64 at) {
    g_cond_wait_until(cond, lock, (at + 999) / 1000);
}

/* As a display proposes its own buffers: two of 4096 bytes, no pool object (what mrvideopace's
 * allocation case looks for upstream of it). */
static gboolean propose_allocation(GstBaseSink* bsink, GstQuery* query) {
    (void)bsink;
    gst_query_add_allocation_pool(query, NULL, 4096, 2, 0);
    return TRUE;
}

static guint64 running_time(GstBaseSink* bsink, GstBuffer* buf) {
    const GstClockTime pts = GST_BUFFER_PTS(buf);
    if (!GST_CLOCK_TIME_IS_VALID(pts) || bsink->segment.format != GST_FORMAT_TIME)
        return GST_CLOCK_TIME_NONE;
    return gst_segment_to_running_time(&bsink->segment, GST_FORMAT_TIME, pts);
}

/* --- mrtestvideosink ---------------------------------------------------------------------- */

#define MR_TYPE_TEST_VIDEO_SINK (mr_test_video_sink_get_type())
G_DECLARE_FINAL_TYPE(MrTestVideoSink, mr_test_video_sink, MR, TEST_VIDEO_SINK, GstBaseSink)

struct _MrTestVideoSink {
    GstBaseSink parent;
    GMutex lock;
    GCond cond;
    gint64 period_ns;   /* the properties; the grid takes them at a start */
    gint drift_ppm;
    Grid grid;
    gboolean unlocked;
    gboolean pending;          /* the last commit is not presented yet */
    gint64 commit_ns;
    guint64 commit_running;
    gboolean presenting;
    gint64 stall_from, stall_to;   /* the output off over [from, to) */
    guint64 presented, presented_seq, discarded, present_timeouts, not_presented;
    guint64 last_presented_ns, last_running_time;
    gint64 commit_to_present_ns;
};

G_DEFINE_TYPE(MrTestVideoSink, mr_test_video_sink, GST_TYPE_BASE_SINK)

enum { VPROP_0, VPROP_PERIOD_NS, VPROP_DRIFT_PPM, VPROP_STALL_MS, VPROP_DISPLAY_STATS };

/* When the pending commit is presented: the first refresh after it, past an output off. */
static gint64 tv_presentation(const MrTestVideoSink* s, gint64* seq) {
    gint64 n = grid_next(&s->grid, s->commit_ns);
    if (s->stall_to > s->stall_from && grid_at(&s->grid, n) >= s->stall_from &&
        grid_at(&s->grid, n) < s->stall_to)
        n = grid_next(&s->grid, s->stall_to - 1);
    *seq = n;
    return grid_at(&s->grid, n);
}

/* Under the lock: the pending commit is presented once its refresh has passed. */
static void tv_settle(MrTestVideoSink* s, gint64 now) {
    if (!s->pending) return;
    gint64 seq;
    const gint64 at = tv_presentation(s, &seq);
    if (at > now) return;
    s->pending = FALSE;
    s->presenting = TRUE;
    s->presented++;
    s->presented_seq = (guint64)seq;
    s->last_presented_ns = (guint64)at;
    s->last_running_time = s->commit_running;
    s->commit_to_present_ns += (at - s->commit_ns - s->commit_to_present_ns) / 16;
}

static GstFlowReturn tv_render(GstBaseSink* bsink, GstBuffer* buf) {
    MrTestVideoSink* s = MR_TEST_VIDEO_SINK(bsink);
    const guint64 running = running_time(bsink, buf);
    g_mutex_lock(&s->lock);
    gint64 now = mono_ns();
    if (!s->grid.started) {
        s->grid.started = TRUE;
        s->grid.origin = now;
    }
    tv_settle(s, now);
    gboolean timed_out = FALSE;
    gint64 deadline = now + PRESENT_TIMEOUT_NS;
    while (s->pending && s->presenting) {
        if (s->unlocked) {   /* a flush or a pause: as basesink orders, then go on */
            g_mutex_unlock(&s->lock);
            const GstFlowReturn ret = gst_base_sink_wait_preroll(bsink);
            if (ret != GST_FLOW_OK) return ret;
            g_mutex_lock(&s->lock);
            now = mono_ns();
            deadline = now + PRESENT_TIMEOUT_NS;
            tv_settle(s, now);
            continue;
        }
        gint64 seq;
        const gint64 at = tv_presentation(s, &seq);
        wait_until(&s->cond, &s->lock, MIN(at, deadline));
        now = mono_ns();
        tv_settle(s, now);
        if (s->pending && now >= deadline && !s->unlocked) {
            s->presenting = FALSE;
            s->present_timeouts++;
            timed_out = TRUE;
        }
    }
    if (s->pending) s->discarded++;   /* replaced before a refresh took it */
    if (!s->presenting && !timed_out) s->not_presented++;
    s->pending = TRUE;
    s->commit_ns = now;
    s->commit_running = running;
    g_mutex_unlock(&s->lock);
    return GST_FLOW_OK;
}

static gboolean tv_start(GstBaseSink* bsink) {
    MrTestVideoSink* s = MR_TEST_VIDEO_SINK(bsink);
    g_mutex_lock(&s->lock);
    s->grid.period_ns = s->period_ns;
    s->grid.ppm = s->drift_ppm;
    s->grid.started = FALSE;
    s->unlocked = s->pending = FALSE;
    s->presenting = TRUE;
    s->stall_from = s->stall_to = 0;
    s->presented = s->presented_seq = s->discarded = s->present_timeouts = s->not_presented = 0;
    s->last_presented_ns = s->last_running_time = GST_CLOCK_TIME_NONE;
    s->commit_to_present_ns = 0;
    g_mutex_unlock(&s->lock);
    return TRUE;
}

static gboolean tv_unlock(GstBaseSink* bsink) {
    MrTestVideoSink* s = MR_TEST_VIDEO_SINK(bsink);
    g_mutex_lock(&s->lock);
    s->unlocked = TRUE;
    g_cond_broadcast(&s->cond);
    g_mutex_unlock(&s->lock);
    return TRUE;
}

static gboolean tv_unlock_stop(GstBaseSink* bsink) {
    MrTestVideoSink* s = MR_TEST_VIDEO_SINK(bsink);
    g_mutex_lock(&s->lock);
    s->unlocked = FALSE;
    g_mutex_unlock(&s->lock);
    return TRUE;
}

/* An output off from now for `ms` (0: back on now); a stall in progress is only extended. */
static void tv_stall(MrTestVideoSink* s, guint ms) {
    g_mutex_lock(&s->lock);
    const gint64 now = mono_ns(), to = now + (gint64)ms * GST_MSECOND;
    tv_settle(s, now);   /* what an earlier stall let through is presented before this one */
    const gboolean active = s->stall_to > now && s->stall_from <= now;
    if (ms == 0) {
        if (active) s->stall_to = now;
    } else if (active) {
        s->stall_to = MAX(s->stall_to, to);
    } else {
        s->stall_from = now;
        s->stall_to = to;
    }
    g_cond_broadcast(&s->cond);
    g_mutex_unlock(&s->lock);
}

static GstStructure* tv_stats(MrTestVideoSink* s) {
    g_mutex_lock(&s->lock);
    tv_settle(s, mono_ns());
    GstStructure* st = gst_structure_new(
        "wayland-display-stats", "presented", G_TYPE_UINT64, s->presented, "presented-seq",
        G_TYPE_UINT64, s->presented_seq, "discarded", G_TYPE_UINT64, s->discarded, "replaced",
        G_TYPE_UINT64, (guint64)0, "present-timeouts", G_TYPE_UINT64, s->present_timeouts,
        "not-presented", G_TYPE_UINT64, s->not_presented, "refresh-ns", G_TYPE_UINT64,
        (guint64)grid_period(&s->grid), "last-presented-ns", G_TYPE_UINT64, s->last_presented_ns,
        "last-running-time", G_TYPE_UINT64, s->last_running_time, "commit-to-present-ns",
        G_TYPE_UINT64, (guint64)MAX(s->commit_to_present_ns, 0), "clock-monotonic", G_TYPE_BOOLEAN,
        TRUE, NULL);
    g_mutex_unlock(&s->lock);
    return st;
}

static void tv_set_property(GObject* object, guint id, const GValue* value, GParamSpec* pspec) {
    MrTestVideoSink* s = MR_TEST_VIDEO_SINK(object);
    switch (id) {
        case VPROP_PERIOD_NS:
            g_mutex_lock(&s->lock);
            s->period_ns = (gint64)g_value_get_uint64(value);
            g_mutex_unlock(&s->lock);
            break;
        case VPROP_DRIFT_PPM:
            g_mutex_lock(&s->lock);
            s->drift_ppm = g_value_get_int(value);
            g_mutex_unlock(&s->lock);
            break;
        case VPROP_STALL_MS:
            tv_stall(s, g_value_get_uint(value));
            break;
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, pspec);
            break;
    }
}

static void tv_get_property(GObject* object, guint id, GValue* value, GParamSpec* pspec) {
    MrTestVideoSink* s = MR_TEST_VIDEO_SINK(object);
    switch (id) {
        case VPROP_PERIOD_NS:
            g_mutex_lock(&s->lock);
            g_value_set_uint64(value, (guint64)s->period_ns);
            g_mutex_unlock(&s->lock);
            break;
        case VPROP_DRIFT_PPM:
            g_mutex_lock(&s->lock);
            g_value_set_int(value, s->drift_ppm);
            g_mutex_unlock(&s->lock);
            break;
        case VPROP_STALL_MS: {
            g_mutex_lock(&s->lock);
            const gint64 left = s->stall_to - mono_ns();
            g_mutex_unlock(&s->lock);
            g_value_set_uint(value, left > 0 ? (guint)(left / GST_MSECOND) : 0);
            break;
        }
        case VPROP_DISPLAY_STATS:
            g_value_take_boxed(value, tv_stats(s));
            break;
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, pspec);
            break;
    }
}

static void tv_finalize(GObject* object) {
    MrTestVideoSink* s = MR_TEST_VIDEO_SINK(object);
    g_mutex_clear(&s->lock);
    g_cond_clear(&s->cond);
    G_OBJECT_CLASS(mr_test_video_sink_parent_class)->finalize(object);
}

static void mr_test_video_sink_init(MrTestVideoSink* s) {
    g_mutex_init(&s->lock);
    g_cond_init(&s->cond);
    s->period_ns = DEFAULT_PERIOD_NS;
    s->drift_ppm = 0;
    s->presenting = TRUE;
    s->last_presented_ns = s->last_running_time = GST_CLOCK_TIME_NONE;
    s->grid.period_ns = DEFAULT_PERIOD_NS;
    /* As the outputs run a display: no sync, no QoS. */
    gst_base_sink_set_sync(GST_BASE_SINK(s), FALSE);
    gst_base_sink_set_qos_enabled(GST_BASE_SINK(s), FALSE);
}

static void install_grid_properties(GObjectClass* klass, guint period_id, guint drift_id) {
    const GParamFlags at_start =
        (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS | GST_PARAM_MUTABLE_READY);
    g_object_class_install_property(
        klass, period_id,
        g_param_spec_uint64("period-ns", "Period (ns)", "The refresh period before the drift.",
                            1000000, G_GUINT64_CONSTANT(1000000000), DEFAULT_PERIOD_NS, at_start));
    g_object_class_install_property(
        klass, drift_id,
        g_param_spec_int("drift-ppm", "Drift (ppm)",
                         "The display clock's rate error against CLOCK_MONOTONIC: negative is "
                         "slow, its period that much longer.",
                         -100000, 100000, 0, at_start));
}

static void mr_test_video_sink_class_init(MrTestVideoSinkClass* klass) {
    GObjectClass* gobject_class = G_OBJECT_CLASS(klass);
    GstElementClass* element_class = GST_ELEMENT_CLASS(klass);
    GstBaseSinkClass* sink_class = GST_BASE_SINK_CLASS(klass);
    static GstStaticPadTemplate sink_tmpl =
        GST_STATIC_PAD_TEMPLATE("sink", GST_PAD_SINK, GST_PAD_ALWAYS, GST_STATIC_CAPS_ANY);

    gobject_class->set_property = tv_set_property;
    gobject_class->get_property = tv_get_property;
    gobject_class->finalize = tv_finalize;
    sink_class->render = tv_render;
    sink_class->propose_allocation = propose_allocation;
    sink_class->start = tv_start;
    sink_class->unlock = tv_unlock;
    sink_class->unlock_stop = tv_unlock_stop;

    install_grid_properties(gobject_class, VPROP_PERIOD_NS, VPROP_DRIFT_PPM);
    g_object_class_install_property(
        gobject_class, VPROP_STALL_MS,
        g_param_spec_uint("stall-ms", "Stall (ms)",
                          "Write: the output off from now for this long (0: back on). Read: the "
                          "time left.",
                          0, 3600000, 0,
                          (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS |
                                        GST_PARAM_MUTABLE_PLAYING)));
    g_object_class_install_property(
        gobject_class, VPROP_DISPLAY_STATS,
        g_param_spec_boxed("display-stats", "Display stats",
                           "0008's wayland-display-stats: every field guint64 but clock-monotonic, "
                           "a time not known yet GST_CLOCK_TIME_NONE.",
                           GST_TYPE_STRUCTURE,
                           (GParamFlags)(G_PARAM_READABLE | G_PARAM_STATIC_STRINGS)));

    gst_element_class_add_static_pad_template(element_class, &sink_tmpl);
    gst_element_class_set_static_metadata(
        element_class, "Media Router test display (0008 model)", "Sink/Video",
        "A display that presents every frame at its next refresh",
        "Media Router <https://github.com/bccsa/media-router>");
}

/* --- mrtestkmssink ------------------------------------------------------------------------ */

#define MR_TYPE_TEST_KMS_SINK (mr_test_kms_sink_get_type())
G_DECLARE_FINAL_TYPE(MrTestKmsSink, mr_test_kms_sink, MR, TEST_KMS_SINK, GstBaseSink)

struct _MrTestKmsSink {
    GstBaseSink parent;
    GMutex lock;
    GCond cond;
    gint64 period_ns;
    gint drift_ppm;
    gboolean skip_vsync;
    guint late_every, late_us;
    guint64 frames;
    Grid grid;
    gboolean unlocked;
};

G_DEFINE_TYPE(MrTestKmsSink, mr_test_kms_sink, GST_TYPE_BASE_SINK)

enum {
    KPROP_0,
    KPROP_PERIOD_NS,
    KPROP_DRIFT_PPM,
    KPROP_SKIP_VSYNC,
    KPROP_LATE_EVERY,
    KPROP_LATE_US,
};

static GstFlowReturn tk_render(GstBaseSink* bsink, GstBuffer* buf) {
    MrTestKmsSink* s = MR_TEST_KMS_SINK(bsink);
    (void)buf;
    g_mutex_lock(&s->lock);
    if (s->skip_vsync) {
        g_mutex_unlock(&s->lock);
        return GST_FLOW_OK;
    }
    gint64 now = mono_ns();
    if (!s->grid.started) {
        s->grid.started = TRUE;
        s->grid.origin = now;
    }
    gint64 at = grid_at(&s->grid, grid_next(&s->grid, now));
    if (s->late_every && ++s->frames % s->late_every == 0) at += (gint64)s->late_us * 1000;
    while (now < at) {
        if (s->unlocked) {
            g_mutex_unlock(&s->lock);
            const GstFlowReturn ret = gst_base_sink_wait_preroll(bsink);
            if (ret != GST_FLOW_OK) return ret;
            g_mutex_lock(&s->lock);
        } else {
            wait_until(&s->cond, &s->lock, at);
        }
        now = mono_ns();
    }
    g_mutex_unlock(&s->lock);
    return GST_FLOW_OK;
}

static gboolean tk_start(GstBaseSink* bsink) {
    MrTestKmsSink* s = MR_TEST_KMS_SINK(bsink);
    g_mutex_lock(&s->lock);
    s->grid.period_ns = s->period_ns;
    s->grid.ppm = s->drift_ppm;
    s->grid.started = FALSE;
    s->unlocked = FALSE;
    s->frames = 0;
    g_mutex_unlock(&s->lock);
    return TRUE;
}

static gboolean tk_unlock(GstBaseSink* bsink) {
    MrTestKmsSink* s = MR_TEST_KMS_SINK(bsink);
    g_mutex_lock(&s->lock);
    s->unlocked = TRUE;
    g_cond_broadcast(&s->cond);
    g_mutex_unlock(&s->lock);
    return TRUE;
}

static gboolean tk_unlock_stop(GstBaseSink* bsink) {
    MrTestKmsSink* s = MR_TEST_KMS_SINK(bsink);
    g_mutex_lock(&s->lock);
    s->unlocked = FALSE;
    g_mutex_unlock(&s->lock);
    return TRUE;
}

static void tk_set_property(GObject* object, guint id, const GValue* value, GParamSpec* pspec) {
    MrTestKmsSink* s = MR_TEST_KMS_SINK(object);
    g_mutex_lock(&s->lock);
    switch (id) {
        case KPROP_PERIOD_NS: s->period_ns = (gint64)g_value_get_uint64(value); break;
        case KPROP_DRIFT_PPM: s->drift_ppm = g_value_get_int(value); break;
        case KPROP_SKIP_VSYNC: s->skip_vsync = g_value_get_boolean(value); break;
        case KPROP_LATE_EVERY: s->late_every = g_value_get_uint(value); break;
        case KPROP_LATE_US: s->late_us = g_value_get_uint(value); break;
        default: G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, pspec); break;
    }
    g_mutex_unlock(&s->lock);
}

static void tk_get_property(GObject* object, guint id, GValue* value, GParamSpec* pspec) {
    MrTestKmsSink* s = MR_TEST_KMS_SINK(object);
    g_mutex_lock(&s->lock);
    switch (id) {
        case KPROP_PERIOD_NS: g_value_set_uint64(value, (guint64)s->period_ns); break;
        case KPROP_DRIFT_PPM: g_value_set_int(value, s->drift_ppm); break;
        case KPROP_SKIP_VSYNC: g_value_set_boolean(value, s->skip_vsync); break;
        case KPROP_LATE_EVERY: g_value_set_uint(value, s->late_every); break;
        case KPROP_LATE_US: g_value_set_uint(value, s->late_us); break;
        default: G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, pspec); break;
    }
    g_mutex_unlock(&s->lock);
}

static void tk_finalize(GObject* object) {
    MrTestKmsSink* s = MR_TEST_KMS_SINK(object);
    g_mutex_clear(&s->lock);
    g_cond_clear(&s->cond);
    G_OBJECT_CLASS(mr_test_kms_sink_parent_class)->finalize(object);
}

static void mr_test_kms_sink_init(MrTestKmsSink* s) {
    g_mutex_init(&s->lock);
    g_cond_init(&s->cond);
    s->period_ns = DEFAULT_PERIOD_NS;
    s->late_us = 5000;
    s->grid.period_ns = DEFAULT_PERIOD_NS;
    gst_base_sink_set_sync(GST_BASE_SINK(s), FALSE);
    gst_base_sink_set_qos_enabled(GST_BASE_SINK(s), FALSE);
}

static void mr_test_kms_sink_class_init(MrTestKmsSinkClass* klass) {
    GObjectClass* gobject_class = G_OBJECT_CLASS(klass);
    GstElementClass* element_class = GST_ELEMENT_CLASS(klass);
    GstBaseSinkClass* sink_class = GST_BASE_SINK_CLASS(klass);
    static GstStaticPadTemplate sink_tmpl =
        GST_STATIC_PAD_TEMPLATE("sink", GST_PAD_SINK, GST_PAD_ALWAYS, GST_STATIC_CAPS_ANY);

    gobject_class->set_property = tk_set_property;
    gobject_class->get_property = tk_get_property;
    gobject_class->finalize = tk_finalize;
    sink_class->render = tk_render;
    sink_class->propose_allocation = propose_allocation;
    sink_class->start = tk_start;
    sink_class->unlock = tk_unlock;
    sink_class->unlock_stop = tk_unlock_stop;

    install_grid_properties(gobject_class, KPROP_PERIOD_NS, KPROP_DRIFT_PPM);
    /* kmssink's own, with its meaning: mrvideopace times the returns of a sink that waits. */
    g_object_class_install_property(
        gobject_class, KPROP_SKIP_VSYNC,
        g_param_spec_boolean("skip-vsync", "Skip vsync",
                             "Return at once instead of at the next refresh.", FALSE,
                             (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS)));
    g_object_class_install_property(
        gobject_class, KPROP_LATE_EVERY,
        g_param_spec_uint("late-every", "Late every",
                          "Every this many frames one returns late-us after its refresh (a late "
                          "wake); 0: none.",
                          0, G_MAXUINT, 0,
                          (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS)));
    g_object_class_install_property(
        gobject_class, KPROP_LATE_US,
        g_param_spec_uint("late-us", "Late (us)", "How late such a frame returns.", 0, 1000000,
                          5000, (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS)));

    gst_element_class_add_static_pad_template(element_class, &sink_tmpl);
    gst_element_class_set_static_metadata(
        element_class, "Media Router test display (kmssink model)", "Sink/Video",
        "A display whose render returns at the next refresh",
        "Media Router <https://github.com/bccsa/media-router>");
}

/* --- the plugin --------------------------------------------------------------------------- */

static gboolean plugin_init(GstPlugin* plugin) {
    return gst_element_register(plugin, "mrtestvideosink", GST_RANK_NONE,
                                MR_TYPE_TEST_VIDEO_SINK) &&
           gst_element_register(plugin, "mrtestkmssink", GST_RANK_NONE, MR_TYPE_TEST_KMS_SINK);
}

GST_PLUGIN_DEFINE(GST_VERSION_MAJOR, GST_VERSION_MINOR, mrtestvideo,
                  "Media Router test display sinks", plugin_init, "1.0.0", "MIT/X11",
                  "media-router", "https://github.com/bccsa/media-router")
