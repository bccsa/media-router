/* libgstmrtest.so (plan ch. 7 WI-P3-5, S18; reused by ch. 8 WI-P4-4), test-only, never installed.
 * mrtestaudiosink: a device `ppm` off the pipeline clock holding `device-ns`; the ring's fill, resyncs, the
 * provided clock's calibration changes. MrTestClock: `speed` times real time, its waits in its own time. */
#include <gst/audio/audio.h>
#include <gst/gst.h>

#include <stdlib.h>
#include <string.h>

/* --- MrTestClock -------------------------------------------------------------------------- */

#define MR_TYPE_TEST_CLOCK (mr_test_clock_get_type())
G_DECLARE_FINAL_TYPE(MrTestClock, mr_test_clock, MR, TEST_CLOCK, GstClock)

struct _MrTestClock {
    GstClock parent;
    guint speed;
    gint64 mono0;   /* us: real time at creation; the clock reads mono0 there too */
    GMutex lock;
    GCond cond;
};

enum { CLOCK_PROP_0, CLOCK_PROP_SPEED };

G_DEFINE_TYPE(MrTestClock, mr_test_clock, GST_TYPE_CLOCK)

static GstClockTime mr_test_clock_internal(GstClock* clock) {
    MrTestClock* self = MR_TEST_CLOCK(clock);
    const gint64 now = g_get_monotonic_time();
    return (GstClockTime)(self->mono0 * 1000 + (now - self->mono0) * 1000 * (gint64)self->speed);
}

static GstClockTime mr_test_clock_resolution(GstClock* clock G_GNUC_UNUSED) { return 1; }

/* Sleeps toward the entry's time in steps of at most 2 ms real time, re-reading the clock, so a
 * calibration or an unschedule takes effect at once. */
static GstClockReturn mr_test_clock_wait(GstClock* clock, GstClockEntry* entry,
                                         GstClockTimeDiff* jitter) {
    MrTestClock* self = MR_TEST_CLOCK(clock);
    const GstClockTime target = GST_CLOCK_ENTRY_TIME(entry);
    GstClockTimeDiff diff = GST_CLOCK_DIFF(gst_clock_get_time(clock), target);
    if (jitter) *jitter = -diff;
    g_mutex_lock(&self->lock);
    if (GST_CLOCK_ENTRY_STATUS(entry) == GST_CLOCK_UNSCHEDULED) {
        g_mutex_unlock(&self->lock);
        return GST_CLOCK_UNSCHEDULED;
    }
    if (diff <= 0) {
        GST_CLOCK_ENTRY_STATUS(entry) = GST_CLOCK_EARLY;
        g_mutex_unlock(&self->lock);
        return GST_CLOCK_EARLY;
    }
    GST_CLOCK_ENTRY_STATUS(entry) = GST_CLOCK_BUSY;
    while (GST_CLOCK_ENTRY_STATUS(entry) != GST_CLOCK_UNSCHEDULED) {
        diff = GST_CLOCK_DIFF(gst_clock_get_time(clock), target);
        if (diff <= 0) break;
        const gint64 us = MIN(diff / 1000 / (gint64)self->speed + 1, 2000);
        g_cond_wait_until(&self->cond, &self->lock, g_get_monotonic_time() + us);
    }
    const GstClockReturn ret =
        GST_CLOCK_ENTRY_STATUS(entry) == GST_CLOCK_UNSCHEDULED ? GST_CLOCK_UNSCHEDULED : GST_CLOCK_OK;
    if (ret == GST_CLOCK_OK) GST_CLOCK_ENTRY_STATUS(entry) = GST_CLOCK_DONE;
    g_mutex_unlock(&self->lock);
    return ret;
}

static void mr_test_clock_unschedule(GstClock* clock, GstClockEntry* entry) {
    MrTestClock* self = MR_TEST_CLOCK(clock);
    g_mutex_lock(&self->lock);
    GST_CLOCK_ENTRY_STATUS(entry) = GST_CLOCK_UNSCHEDULED;
    g_cond_broadcast(&self->cond);
    g_mutex_unlock(&self->lock);
}

static void mr_test_clock_set_property(GObject* object, guint id, const GValue* v, GParamSpec* ps) {
    MrTestClock* self = MR_TEST_CLOCK(object);
    if (id == CLOCK_PROP_SPEED)
        self->speed = g_value_get_uint(v);
    else
        G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, ps);
}

static void mr_test_clock_get_property(GObject* object, guint id, GValue* v, GParamSpec* ps) {
    MrTestClock* self = MR_TEST_CLOCK(object);
    if (id == CLOCK_PROP_SPEED)
        g_value_set_uint(v, self->speed);
    else
        G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, ps);
}

static void mr_test_clock_finalize(GObject* object) {
    MrTestClock* self = MR_TEST_CLOCK(object);
    g_mutex_clear(&self->lock);
    g_cond_clear(&self->cond);
    G_OBJECT_CLASS(mr_test_clock_parent_class)->finalize(object);
}

static void mr_test_clock_init(MrTestClock* self) {
    self->speed = 1;
    self->mono0 = g_get_monotonic_time();
    g_mutex_init(&self->lock);
    g_cond_init(&self->cond);
    GST_OBJECT_FLAG_SET(self, GST_CLOCK_FLAG_CAN_DO_SINGLE_SYNC);
}

static void mr_test_clock_class_init(MrTestClockClass* klass) {
    GObjectClass* o = G_OBJECT_CLASS(klass);
    GstClockClass* c = GST_CLOCK_CLASS(klass);
    o->set_property = mr_test_clock_set_property;
    o->get_property = mr_test_clock_get_property;
    o->finalize = mr_test_clock_finalize;
    c->get_internal_time = mr_test_clock_internal;
    c->get_resolution = mr_test_clock_resolution;
    c->wait = mr_test_clock_wait;
    c->unschedule = mr_test_clock_unschedule;
    g_object_class_install_property(
        o, CLOCK_PROP_SPEED,
        g_param_spec_uint("speed", "Speed", "Clock time per real time; set before use.", 1, 1000, 1,
                          (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS)));
}

/* --- mrtestaudiosink ------------------------------------------------------------------------ */

#define MR_TYPE_TEST_AUDIO_SINK (mr_test_audio_sink_get_type())
#define WIN_NS (5 * GST_SECOND)
#define TOPS_MAX 1024   /* settled windows kept: 85 min of 5 s windows */
G_DECLARE_FINAL_TYPE(MrTestAudioSink, mr_test_audio_sink, MR, TEST_AUDIO_SINK, GstAudioSink)

struct _MrTestAudioSink {
    GstAudioSink parent;
    gdouble ppm;
    guint64 settle_ns;          /* fill-min/max skip the renders before this much pipeline time */
    guint64 device_ns;          /* the device's own buffer; 0: one segment */

    /* The device, under the lock: it plays at rate x (1 + ppm 1e-6) frames per clock second from
     * its first write; written counts the frames handed to it, which hold one segment. */
    GMutex lock;
    gint rate, bpf;
    guint64 seg_frames;
    gboolean playing;
    GstClockTime t_start;
    guint64 written;
    gint64 ring_at;             /* the ring sample device frame 0 played, set by each write */
    gboolean have_ring;
    GstClockID wait_id;
    guint64 underruns;

    /* Measured on render, the streaming thread; read by get_property. A render held late (a starved
     * producer) reads the fill low, never high: each window of WIN_NS of clock time keeps its top. */
    gint64 fill_ns, fill_min_ns, fill_max_ns, fill_first_ns;
    gint64 win_top;
    gboolean win_any;
    gint64 tops[TOPS_MAX];   /* each settled window's top */
    guint ntops;
    GstClockTime win_end;
    gboolean have_fill;
    GstClockTime first_render;
    guint64 renders, resyncs, calibrations;
    gboolean have_cal;
    GstClockTime cal[4];
};

enum {
    SINK_PROP_0,
    SINK_PROP_PPM,
    SINK_PROP_SETTLE,
    SINK_PROP_DEVICE,
    SINK_PROP_FILL,
    SINK_PROP_FILL_FIRST,
    SINK_PROP_FILL_MIN,
    SINK_PROP_FILL_MAX,
    SINK_PROP_FILL_P05,
    SINK_PROP_FILL_P95,
    SINK_PROP_FILL_LAST,
    SINK_PROP_RENDERS,
    SINK_PROP_RESYNCS,
    SINK_PROP_CALIBRATIONS,
    SINK_PROP_UNDERRUNS,
};

G_DEFINE_TYPE(MrTestAudioSink, mr_test_audio_sink, GST_TYPE_AUDIO_SINK)

static GstFlowReturn (*parent_render)(GstBaseSink*, GstBuffer*);

static int cmp64(const void* a, const void* b) {
    const gint64 x = *(const gint64*)a, y = *(const gint64*)b;
    return x < y ? -1 : x > y;
}

/* The p-th percentile (0..100) of the settled windows' tops; 0 before the first. */
static gint64 top_percentile(MrTestAudioSink* self, guint p) {
    if (!self->ntops) return 0;
    gint64 v[TOPS_MAX];
    memcpy(v, self->tops, self->ntops * sizeof v[0]);
    qsort(v, self->ntops, sizeof v[0], cmp64);
    return v[(self->ntops - 1) * p / 100];
}

/* Frames the device has played by clock time `now` (lock held). */
static guint64 device_played(MrTestAudioSink* self, GstClockTime now) {
    if (!self->playing || now <= self->t_start) return 0;
    const gdouble f = (gdouble)(now - self->t_start) * self->rate * (1.0 + self->ppm * 1e-6) / 1e9;
    return (guint64)f;
}

static GstClock* sink_clock(MrTestAudioSink* self) { return gst_element_get_clock(GST_ELEMENT(self)); }

static gboolean mr_test_open(GstAudioSink* sink G_GNUC_UNUSED) { return TRUE; }
static gboolean mr_test_close(GstAudioSink* sink G_GNUC_UNUSED) { return TRUE; }
static gboolean mr_test_unprepare(GstAudioSink* sink G_GNUC_UNUSED) { return TRUE; }

static gboolean mr_test_prepare(GstAudioSink* sink, GstAudioRingBufferSpec* spec) {
    MrTestAudioSink* self = MR_TEST_AUDIO_SINK(sink);
    g_mutex_lock(&self->lock);
    self->rate = GST_AUDIO_INFO_RATE(&spec->info);
    self->bpf = GST_AUDIO_INFO_BPF(&spec->info);
    self->seg_frames = (guint64)(spec->segsize / self->bpf);
    if (self->device_ns)
        self->seg_frames = MAX(self->seg_frames, self->device_ns * (guint64)self->rate / GST_SECOND);
    self->playing = FALSE;
    self->written = 0;
    self->have_ring = FALSE;
    g_mutex_unlock(&self->lock);
    return TRUE;
}

/* One segment to the device: wait until it has room, as a device's write blocks. A device that
 * found nothing to play skipped ahead (an underrun). */
static gint mr_test_write(GstAudioSink* sink, gpointer data G_GNUC_UNUSED, guint length) {
    MrTestAudioSink* self = MR_TEST_AUDIO_SINK(sink);
    GstClock* clock = sink_clock(self);
    if (!clock) return (gint)length;
    g_mutex_lock(&self->lock);
    const guint64 frames = length / self->bpf;
    GstClockTime now = gst_clock_get_time(clock);
    if (!self->playing) {
        self->playing = TRUE;
        self->t_start = now;
        self->written = 0;
    }
    const guint64 played = device_played(self, now);
    if (self->written < played) {
        self->underruns++;
        self->written = played;
    }
    /* This segment is the ring's next, not yet advanced: where the device's frames sit in the ring. */
    self->ring_at = (gint64)gst_audio_ring_buffer_samples_done(GST_AUDIO_BASE_SINK(sink)->ringbuffer) -
                    (gint64)self->written;
    self->have_ring = TRUE;
    const guint64 need = self->written + frames > self->seg_frames ? self->written + frames - self->seg_frames : 0;
    if (need > played) {
        const GstClockTime at = self->t_start + (GstClockTime)((gdouble)need * 1e9 /
                                                                ((gdouble)self->rate * (1.0 + self->ppm * 1e-6))) + 1;
        GstClockID id = gst_clock_new_single_shot_id(clock, at);
        self->wait_id = id;
        g_mutex_unlock(&self->lock);
        gst_clock_id_wait(id, NULL);
        g_mutex_lock(&self->lock);
        self->wait_id = NULL;
        gst_clock_id_unref(id);
    }
    self->written += frames;
    g_mutex_unlock(&self->lock);
    gst_object_unref(clock);
    return (gint)length;
}

static guint mr_test_delay(GstAudioSink* sink) {
    MrTestAudioSink* self = MR_TEST_AUDIO_SINK(sink);
    GstClock* clock = sink_clock(self);
    g_mutex_lock(&self->lock);
    const guint64 played = clock ? device_played(self, gst_clock_get_time(clock)) : self->written;
    const guint d = self->written > played ? (guint)(self->written - played) : 0;
    g_mutex_unlock(&self->lock);
    if (clock) gst_object_unref(clock);
    return d;
}

/* Pause, stop: unblock the write; the device starts again at the next. */
static void mr_test_reset(GstAudioSink* sink) {
    MrTestAudioSink* self = MR_TEST_AUDIO_SINK(sink);
    g_mutex_lock(&self->lock);
    if (self->wait_id) gst_clock_id_unschedule(self->wait_id);
    self->playing = FALSE;
    self->have_ring = FALSE;
    g_mutex_unlock(&self->lock);
}

/* The base class's render, measured around: the write position runs on by the buffer's frames
 * unless the sink resynced; the fill is that position less the device's play position. */
static GstFlowReturn mr_test_render(GstBaseSink* bsink, GstBuffer* buf) {
    MrTestAudioSink* self = MR_TEST_AUDIO_SINK(bsink);
    GstAudioBaseSink* abs = GST_AUDIO_BASE_SINK(bsink);
    const guint64 before = abs->next_sample;
    const GstFlowReturn ret = parent_render(bsink, buf);
    if (ret != GST_FLOW_OK || self->bpf <= 0) return ret;
    const guint64 frames = gst_buffer_get_size(buf) / self->bpf;
    self->renders++;
    if (before != (guint64)-1 && abs->next_sample != before + frames) self->resyncs++;
    GstClockTime ci, ce, rn, rd;
    gst_clock_get_calibration(abs->provided_clock, &ci, &ce, &rn, &rd);
    const GstClockTime cal[4] = {ci, ce, rn, rd};
    if (self->have_cal && memcmp(cal, self->cal, sizeof cal) != 0) self->calibrations++;
    memcpy(self->cal, cal, sizeof cal);
    self->have_cal = self->renders > 1;   /* the first render calibrates (sync_latency) */
    GstClock* clock = sink_clock(self);
    if (!clock || abs->next_sample == (guint64)-1) {
        if (clock) gst_object_unref(clock);
        return ret;
    }
    const GstClockTime now = gst_clock_get_time(clock);
    gst_object_unref(clock);
    /* Both in ring samples (the writer's offsets sit segbase segments in) and the device's position
     * its model's, so no read races the ring's advance. */
    g_mutex_lock(&self->lock);
    const gboolean have = self->have_ring;
    const gint64 at = self->ring_at + (gint64)device_played(self, now);
    g_mutex_unlock(&self->lock);
    if (!have) return ret;
    GstAudioRingBuffer* rb = abs->ringbuffer;
    const gint64 fill_frames = (gint64)abs->next_sample + (gint64)rb->segbase * rb->samples_per_seg - at;
    self->fill_ns = fill_frames * GST_SECOND / self->rate;
    if (self->first_render == GST_CLOCK_TIME_NONE) {
        self->first_render = now;
        self->win_end = now + WIN_NS;
        self->win_any = FALSE;
    }
    if (now >= self->win_end) {   /* a window closed: its top fill */
        if (self->win_any && self->win_end - self->first_render > self->settle_ns) {
            const gint64 top = self->win_top;
            if (!self->have_fill) {
                self->fill_min_ns = self->fill_max_ns = self->fill_first_ns = top;
                self->have_fill = TRUE;
            }
            self->fill_min_ns = MIN(self->fill_min_ns, top);
            self->fill_max_ns = MAX(self->fill_max_ns, top);
            if (self->ntops < TOPS_MAX) self->tops[self->ntops++] = top;
        }
        self->win_any = FALSE;
        while (self->win_end <= now) self->win_end += WIN_NS;
    }
    if (!self->win_any || self->fill_ns > self->win_top) self->win_top = self->fill_ns;
    self->win_any = TRUE;
    return ret;
}

static gboolean mr_test_start(GstBaseSink* bsink) {
    MrTestAudioSink* self = MR_TEST_AUDIO_SINK(bsink);
    self->renders = self->resyncs = self->calibrations = self->underruns = 0;
    self->have_cal = self->have_fill = FALSE;
    self->first_render = GST_CLOCK_TIME_NONE;
    self->fill_ns = self->fill_min_ns = self->fill_max_ns = self->fill_first_ns = 0;
    self->ntops = 0;
    self->win_any = FALSE;
    return GST_BASE_SINK_CLASS(mr_test_audio_sink_parent_class)->start
               ? GST_BASE_SINK_CLASS(mr_test_audio_sink_parent_class)->start(bsink)
               : TRUE;
}

static void mr_test_sink_set_property(GObject* object, guint id, const GValue* v, GParamSpec* ps) {
    MrTestAudioSink* self = MR_TEST_AUDIO_SINK(object);
    switch (id) {
        case SINK_PROP_PPM:
            g_mutex_lock(&self->lock);
            self->ppm = g_value_get_double(v);
            g_mutex_unlock(&self->lock);
            break;
        case SINK_PROP_SETTLE: self->settle_ns = g_value_get_uint64(v); break;
        case SINK_PROP_DEVICE: self->device_ns = g_value_get_uint64(v); break;
        default: G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, ps); break;
    }
}

static void mr_test_sink_get_property(GObject* object, guint id, GValue* v, GParamSpec* ps) {
    MrTestAudioSink* self = MR_TEST_AUDIO_SINK(object);
    switch (id) {
        case SINK_PROP_PPM: g_value_set_double(v, self->ppm); break;
        case SINK_PROP_SETTLE: g_value_set_uint64(v, self->settle_ns); break;
        case SINK_PROP_DEVICE: g_value_set_uint64(v, self->device_ns); break;
        case SINK_PROP_FILL: g_value_set_int64(v, self->fill_ns); break;
        case SINK_PROP_FILL_FIRST: g_value_set_int64(v, self->fill_first_ns); break;
        case SINK_PROP_FILL_MIN: g_value_set_int64(v, self->fill_min_ns); break;
        case SINK_PROP_FILL_P05: g_value_set_int64(v, top_percentile(self, 5)); break;
        case SINK_PROP_FILL_P95: g_value_set_int64(v, top_percentile(self, 95)); break;
        case SINK_PROP_FILL_LAST: g_value_set_int64(v, self->ntops ? self->tops[self->ntops - 1] : 0); break;
        case SINK_PROP_FILL_MAX: g_value_set_int64(v, self->fill_max_ns); break;
        case SINK_PROP_RENDERS: g_value_set_uint64(v, self->renders); break;
        case SINK_PROP_RESYNCS: g_value_set_uint64(v, self->resyncs); break;
        case SINK_PROP_CALIBRATIONS: g_value_set_uint64(v, self->calibrations); break;
        case SINK_PROP_UNDERRUNS: g_value_set_uint64(v, self->underruns); break;
        default: G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, ps); break;
    }
}

static void mr_test_sink_finalize(GObject* object) {
    g_mutex_clear(&MR_TEST_AUDIO_SINK(object)->lock);
    G_OBJECT_CLASS(mr_test_audio_sink_parent_class)->finalize(object);
}

static void mr_test_audio_sink_init(MrTestAudioSink* self) {
    g_mutex_init(&self->lock);
    self->ppm = 0.0;
    self->settle_ns = 10 * GST_SECOND;
    self->first_render = GST_CLOCK_TIME_NONE;
}

static void mr_test_audio_sink_class_init(MrTestAudioSinkClass* klass) {
    GObjectClass* o = G_OBJECT_CLASS(klass);
    GstElementClass* e = GST_ELEMENT_CLASS(klass);
    GstBaseSinkClass* b = GST_BASE_SINK_CLASS(klass);
    GstAudioSinkClass* a = GST_AUDIO_SINK_CLASS(klass);
    o->set_property = mr_test_sink_set_property;
    o->get_property = mr_test_sink_get_property;
    o->finalize = mr_test_sink_finalize;
    a->open = mr_test_open;
    a->prepare = mr_test_prepare;
    a->unprepare = mr_test_unprepare;
    a->close = mr_test_close;
    a->write = mr_test_write;
    a->delay = mr_test_delay;
    a->reset = mr_test_reset;
    parent_render = b->render;
    b->render = mr_test_render;
    b->start = mr_test_start;
    const GParamFlags ro = (GParamFlags)(G_PARAM_READABLE | G_PARAM_STATIC_STRINGS);
    const GParamFlags rw = (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS);
    g_object_class_install_property(
        o, SINK_PROP_PPM,
        g_param_spec_double("ppm", "ppm", "The device plays this much fast against the pipeline clock.",
                            -100000.0, 100000.0, 0.0, rw));
    g_object_class_install_property(
        o, SINK_PROP_SETTLE,
        g_param_spec_uint64("settle-ns", "Settle", "fill-min-ns and fill-max-ns from this long after the "
                            "first render.", 0, G_MAXUINT64, 10 * GST_SECOND, rw));
    g_object_class_install_property(
        o, SINK_PROP_DEVICE,
        g_param_spec_uint64("device-ns", "Device buffer", "The device's own buffer (0: one segment).", 0,
                            G_MAXUINT64, 0, rw));
    g_object_class_install_property(
        o, SINK_PROP_FILL, g_param_spec_int64("fill-ns", "Fill", "What is written ahead of the device's play "
                                              "position, at the last render.", G_MININT64, G_MAXINT64, 0, ro));
    g_object_class_install_property(
        o, SINK_PROP_FILL_FIRST, g_param_spec_int64("fill-first-ns", "Fill first", "The first settled window's "
                                                    "top fill (windows of 5 s: their most punctual render's).",
                                                    G_MININT64, G_MAXINT64, 0, ro));
    g_object_class_install_property(
        o, SINK_PROP_FILL_MIN, g_param_spec_int64("fill-min-ns", "Fill min", "The least of the settled "
                                                  "windows' top fills.", G_MININT64, G_MAXINT64, 0, ro));
    g_object_class_install_property(
        o, SINK_PROP_FILL_MAX, g_param_spec_int64("fill-max-ns", "Fill max", "The most of the settled "
                                                  "windows' top fills.", G_MININT64, G_MAXINT64, 0, ro));
    g_object_class_install_property(
        o, SINK_PROP_FILL_P05, g_param_spec_int64("fill-p05-ns", "Fill p05", "The 5th percentile of the settled "
                                                  "windows' top fills.", G_MININT64, G_MAXINT64, 0, ro));
    g_object_class_install_property(
        o, SINK_PROP_FILL_P95, g_param_spec_int64("fill-p95-ns", "Fill p95", "Their 95th percentile.",
                                                  G_MININT64, G_MAXINT64, 0, ro));
    g_object_class_install_property(
        o, SINK_PROP_FILL_LAST, g_param_spec_int64("fill-last-ns", "Fill last", "The last settled window's "
                                                   "top fill.", G_MININT64, G_MAXINT64, 0, ro));
    g_object_class_install_property(o, SINK_PROP_RENDERS,
                                    g_param_spec_uint64("renders", "Renders", "Buffers rendered.", 0,
                                                        G_MAXUINT64, 0, ro));
    g_object_class_install_property(
        o, SINK_PROP_RESYNCS, g_param_spec_uint64("resyncs", "Resyncs", "Renders whose write position jumped "
                                                  "off the previous end.", 0, G_MAXUINT64, 0, ro));
    g_object_class_install_property(
        o, SINK_PROP_CALIBRATIONS, g_param_spec_uint64("calibrations", "Calibrations", "Changes of the provided "
                                                       "clock's calibration after the first render (skews).",
                                                       0, G_MAXUINT64, 0, ro));
    g_object_class_install_property(
        o, SINK_PROP_UNDERRUNS, g_param_spec_uint64("underruns", "Underruns", "Writes that found the device "
                                                    "ahead of what it had.", 0, G_MAXUINT64, 0, ro));
    gst_element_class_add_static_pad_template(
        e, &(GstStaticPadTemplate)GST_STATIC_PAD_TEMPLATE(
               "sink", GST_PAD_SINK, GST_PAD_ALWAYS,
               GST_STATIC_CAPS("audio/x-raw, format = (string) { S16LE, S32LE, F32LE }, "
                               "rate = (int) [ 8000, 192000 ], channels = (int) [ 1, 8 ], "
                               "layout = (string) interleaved")));
    gst_element_class_set_static_metadata(e, "Media Router test audio sink", "Sink/Audio",
                                          "A device playing off the pipeline clock by a set ppm (tests only)",
                                          "media-router");
}

static gboolean plugin_init(GstPlugin* plugin) {
    g_type_ensure(MR_TYPE_TEST_CLOCK);
    return gst_element_register(plugin, "mrtestaudiosink", GST_RANK_NONE, MR_TYPE_TEST_AUDIO_SINK);
}

#define PACKAGE "media-router"
GST_PLUGIN_DEFINE(GST_VERSION_MAJOR, GST_VERSION_MINOR, mrtest,
                  "Test-only elements of mpegts-core's native tests (never installed)", plugin_init,
                  "1.0", "LGPL", PACKAGE, "https://github.com/bccsa")
