/* mrasrc (plan ch. 5 WI-P1-8, part 4.5; ch. 7 WI-P3-5, part 4.4): mrts::AsrcServo locks the input frame
 * count to the buffer PTS and commands GstAudioResampler's ratio: a house-rate counter, PTS_out(m) = T0 +
 * m / out_rate. Modes (S17): capture; decode (`bypass-below-ppm`: passed unchanged until the source is
 * measured off house time); device (`device-sink`: the sink's clock in the ratio; with decode, the product). */
#include <gst/audio/gstaudiobasesink.h>
#include <gst/base/gstbasetransform.h>

#include <atomic>
#include <cmath>
#include <cstring>
#include <mutex>
#include <new>
#include <set>
#include <vector>

#include "mrasrc_resampler.h"
#include "mrts/asrc_servo.h"
#include "mrtshouse.h"

#define GST_CAT_DEFAULT mrtshouse_debug

using mrts::AsrcDeviceLock;
using mrts::AsrcEvent;
using mrts::AsrcServo;

enum {
    PROP_0,
    PROP_OUT_RATE,
    PROP_QUALITY,
    PROP_STATS,
    PROP_BYPASS_BELOW_PPM,
    PROP_DEVICE_SINK,
};

/* AsrcServo clamps its rates to this range, so the caps keep to it. */
#define RATE_MIN 1000
#define RATE_MAX 768000
#define DEFAULT_QUALITY GST_AUDIO_RESAMPLER_QUALITY_DEFAULT
/* Part 4.3's stats interval, on the output labels (house time, never backwards). */
static const gint64 STATS_INTERVAL_NS = 2 * GST_SECOND;
/* What passed, kept to prime the resampler at an engage: more than the filter's half length. */
static const gsize HISTORY_FRAMES = 64;
#define BYPASS_MAX_PPM 1000.0

/* What the capture branches produce (WI-P1-8), and a decoder through audioconvert (S15); the
 * format passes through unchanged. */
#define MRASRC_CAPS                                                                   \
    "audio/x-raw, format = (string) { S16LE, S32LE, F32LE }, rate = (int) [ 1000, 768000 ], " \
    "channels = (int) [ 1, MAX ], layout = (string) interleaved"

/* The device term (WI-P3-5): the sink's custom-slaving callback feeds the lock on its streaming
 * thread (or any thread, for a device failure); the transform reads the atomics. The element owns
 * it; the sink holds the pointer from READY->PAUSED to PAUSED->READY, when no callback runs. */
struct AsrcDeviceTerm {
    std::mutex mu;               // the lock: callbacks may come from more than one thread
    AsrcDeviceLock lock;
    std::atomic<int64_t> eps_ppb{0}, rate_ppb{0};
    std::atomic<bool> locked{false};
    std::atomic<uint64_t> pairs{0}, relocks{0};
    std::atomic<int> last_reason{0};
};

static const gchar* asrc_discont_name(int reason) {
    switch (reason) {
        case GST_AUDIO_BASE_SINK_DISCONT_REASON_NEW_CAPS: return "new-caps";
        case GST_AUDIO_BASE_SINK_DISCONT_REASON_FLUSH: return "flush";
        case GST_AUDIO_BASE_SINK_DISCONT_REASON_SYNC_LATENCY: return "sync-latency";
        case GST_AUDIO_BASE_SINK_DISCONT_REASON_ALIGNMENT: return "alignment";
        case GST_AUDIO_BASE_SINK_DISCONT_REASON_DEVICE_FAILURE: return "device-failure";
        default: return "";
    }
}

/* Each callback: (etime, itime), house and device time since the sink's calibration, and how
 * long after etime's read the house clock reads now, after itime's read (AsrcDeviceLock::feed).
 * The resampler follows the device, so the sink is never asked to skew (C-6). */
static void asrc_slaving_cb(GstAudioBaseSink* sink, GstClockTime etime, GstClockTime itime,
                            GstClockTimeDiff* requested_skew,
                            GstAudioBaseSinkDiscontReason reason, gpointer data) {
    AsrcDeviceTerm* t = static_cast<AsrcDeviceTerm*>(data);
    if (reason != GST_AUDIO_BASE_SINK_DISCONT_REASON_NO_DISCONT) {
        std::lock_guard<std::mutex> g(t->mu);
        t->lock.discont();
        t->locked.store(false);
        t->last_reason.store((int)reason);
        t->relocks.fetch_add(1);
        return;
    }
    if (requested_skew) *requested_skew = 0;
    GstClock* clock = GST_ELEMENT_CLOCK(sink);
    if (!GST_CLOCK_TIME_IS_VALID(etime) || !GST_CLOCK_TIME_IS_VALID(itime) || !clock) return;
    GstClockTime cint, cext, rnum, rden;
    gst_clock_get_calibration(sink->provided_clock, &cint, &cext, &rnum, &rden);
    const gint64 read_ns = (gint64)gst_clock_get_time(clock) - (gint64)cext - (gint64)etime;
    std::lock_guard<std::mutex> g(t->mu);
    t->lock.feed((int64_t)itime, (int64_t)etime, read_ns);
    t->eps_ppb.store(t->lock.ppb());
    t->rate_ppb.store(t->lock.rate_ppb());
    t->locked.store(t->lock.locked());
    t->pairs.fetch_add(1);
}

#define GST_TYPE_MRASRC (gst_mrasrc_get_type())
G_DECLARE_FINAL_TYPE(GstMrAsrc, gst_mrasrc, GST, MRASRC, GstBaseTransform)

struct _GstMrAsrc {
    GstBaseTransform parent;

    /* Properties, under the object lock; they apply when a run is next built (a start, a caps
     * change or a flush), device-sink at READY->PAUSED. */
    gint out_rate;
    gint quality;
    gdouble bypass_below_ppm;
    gchar* device_sink;

    /* The device term, from READY->PAUSED to PAUSED->READY. */
    AsrcDeviceTerm* term;
    GstAudioBaseSink* sink;   // a ref, to take the callback back
    uint64_t term_relocks;    // the term's relocks the events have told
    gboolean device_only;     // the device term alone (bypass-below-ppm 0): no source lock

    /* Streaming state: set_caps, the transform and the serialized events, all on the streaming
     * thread. Built at negotiation, rebuilt by a flush. */
    GstAudioInfo in_info, out_info;
    gint bpf;
    AsrcServo* servo;               // null until negotiated
    GstAudioResampler* resampler;   // capture mode never resets it inside a run: a relock keeps its history
    gint32 cur_in_rate;             // the in_rate last given to the resampler
    AsrcServo::Command cmd;         // the command of the buffer being transformed
    gsize total;                    // ... the resampler's output for it, the first `discard` dropped
    gsize discard;                  // outputs still to drop after an engage's priming
    gboolean started;               // a buffer came since the build: there is a tail to drain
    gboolean need_discont;          // the next output opens an epoch (start, relock, flush)
    gboolean have_pts;              // a PTS-less buffer continues the previous one's ...
    gint64 last_pts;
    guint64 last_frames;
    gboolean pts_warned;
    gboolean have_stats_at;
    gint64 stats_at;
    guint64 buffers, updates;
    std::atomic<guint64> delay_ns;   // the filter's lookahead, for the latency query
    std::vector<guint8>* history;    // the last frames passed, at most HISTORY_FRAMES

    /* The `stats` snapshot, written at each stats post. */
    GMutex snap_lock;
    GstStructure* snapshot;

    MrtsHouseCommon common;   // no TS here: the counters stay 0
};

G_DEFINE_TYPE(GstMrAsrc, gst_mrasrc, GST_TYPE_BASE_TRANSFORM)

static GstStaticPadTemplate asrc_sink_tmpl =
    GST_STATIC_PAD_TEMPLATE("sink", GST_PAD_SINK, GST_PAD_ALWAYS, GST_STATIC_CAPS(MRASRC_CAPS));
static GstStaticPadTemplate asrc_src_tmpl =
    GST_STATIC_PAD_TEMPLATE("src", GST_PAD_SRC, GST_PAD_ALWAYS, GST_STATIC_CAPS(MRASRC_CAPS));

/* --- messages ------------------------------------------------------------------------- */

static void asrc_post(GstMrAsrc* self, GstStructure* s) {
    gst_element_post_message(GST_ELEMENT_CAST(self),
                             gst_message_new_element(GST_OBJECT_CAST(self), s));
}

/* Part 10's mrasrc-stats fields, from the servo (a fresh one before any buffer), then WI-P3-5's
 * mode and the two clocks against house time (ppb, positive fast; 0 where none is measured). The
 * device term alone has no source lock: its state is the device lock's. */
static GstStructure* asrc_stats_structure(const AsrcServo::Stats& s, const AsrcDeviceTerm* t,
                                          bool device_only) {
    const gchar* state = t && device_only ? (t->locked.load() ? "locked" : "acquiring")
                                          : mrts::asrc_state_name(s.state);
    return gst_structure_new(
        "mrasrc-stats", "state", G_TYPE_STRING, state, "ratio-ppb", G_TYPE_INT64,
        (gint64)s.ratio_ppb, "phase-err-ns", G_TYPE_INT64, (gint64)s.phase_err_ns, "relocks",
        G_TYPE_UINT64, (guint64)s.relocks, "in-frames", G_TYPE_UINT64, (guint64)s.in_frames,
        "out-frames", G_TYPE_UINT64, (guint64)s.out_frames, "discont-in", G_TYPE_UINT64,
        (guint64)s.discont_in, "dropped-frames", G_TYPE_UINT64, (guint64)s.dropped_frames, "mode",
        G_TYPE_STRING, mrts::asrc_mode_name(s.mode), "source-ppb", G_TYPE_INT64,
        (gint64)s.source_ppb, "device-ppb", G_TYPE_INT64, (gint64)(t ? t->rate_ppb.load() : 0),
        NULL);
}

/* The message, then the snapshot: the message's fields plus the run's configuration. */
static void asrc_post_stats(GstMrAsrc* self) {
    const AsrcServo::Stats s = self->servo->stats();
    GstStructure* snap = asrc_stats_structure(s, self->term, self->device_only);
    asrc_post(self, gst_structure_copy(snap));
    gst_structure_set(snap, "format", G_TYPE_STRING,
                      gst_audio_format_to_string(GST_AUDIO_INFO_FORMAT(&self->in_info)),
                      "channels", G_TYPE_INT, GST_AUDIO_INFO_CHANNELS(&self->in_info), "in-rate",
                      G_TYPE_INT, GST_AUDIO_INFO_RATE(&self->in_info), "out-rate", G_TYPE_INT,
                      GST_AUDIO_INFO_RATE(&self->out_info), "delay-frames", G_TYPE_UINT,
                      (guint)gst_audio_resampler_get_max_latency(self->resampler), "buffers",
                      G_TYPE_UINT64, self->buffers, "resampler-updates", G_TYPE_UINT64,
                      self->updates, "device-pairs", G_TYPE_UINT64,
                      (guint64)(self->term ? self->term->pairs.load() : 0), NULL);
    g_mutex_lock(&self->snap_lock);
    if (self->snapshot) gst_structure_free(self->snapshot);
    self->snapshot = snap;
    g_mutex_unlock(&self->snap_lock);
}

/* Stats every 2 s of output labels from the first output (of the input's, while passing), or
 * now (`force`). */
static void asrc_report(GstMrAsrc* self, gboolean force) {
    const gint64 now = self->servo->next_pts();
    if (!self->have_stats_at) {
        self->have_stats_at = TRUE;
        self->stats_at = now;
    }
    if (force || now - self->stats_at >= STATS_INTERVAL_NS || now < self->stats_at) {
        asrc_post_stats(self);
        self->stats_at = now;
    }
}

/* mrasrc-event at once: a relock with its new T0, the output PTS jump and the input dropped as
 * overlap; a device rate fit past the ratio clamp; an engage with the source's rate and the
 * phase it reached; a device relock (a sink discontinuity) with its reason. */
static void asrc_post_events(GstMrAsrc* self, gint64 house_ns) {
    for (const AsrcEvent& e : self->servo->take_events()) {
        const gchar* kind = mrts::asrc_event_name(e.kind);
        GstStructure* s = gst_structure_new("mrasrc-event", "kind", G_TYPE_STRING, kind, "reason",
                                            G_TYPE_STRING, e.reason ? e.reason : "", "house-ns",
                                            G_TYPE_INT64, (gint64)e.house_ns, NULL);
        if (e.kind == AsrcEvent::Kind::relock) {
            gst_structure_set(s, "jump-ns", G_TYPE_INT64, (gint64)e.value, "dropped-ns",
                              G_TYPE_INT64, (gint64)e.dropped_ns, NULL);
            GST_INFO_OBJECT(self, "relock (%s): T0 %" G_GINT64_FORMAT ", jump %" G_GINT64_FORMAT
                            " ns, dropped %" G_GINT64_FORMAT " ns", e.reason,
                            (gint64)e.house_ns, (gint64)e.value, (gint64)e.dropped_ns);
        } else if (e.kind == AsrcEvent::Kind::engaged) {
            gst_structure_set(s, "source-ppb", G_TYPE_INT64, (gint64)e.value, "phase-ns",
                              G_TYPE_INT64, (gint64)e.phase_ns, NULL);
            GST_INFO_OBJECT(self, "engaged (%s): source %+" G_GINT64_FORMAT " ppb, phase %+"
                            G_GINT64_FORMAT " ns", e.reason, (gint64)e.value, (gint64)e.phase_ns);
        } else {
            gst_structure_set(s, "fit-ppb", G_TYPE_INT64, (gint64)e.value, NULL);
            GST_WARNING_OBJECT(self, "device rate %" G_GINT64_FORMAT " ppb past the ratio clamp",
                               (gint64)e.value);
        }
        asrc_post(self, s);
    }
    AsrcDeviceTerm* t = self->term;
    const uint64_t r = t ? t->relocks.load() : 0;
    if (t && r != self->term_relocks) {
        self->term_relocks = r;
        const gchar* why = asrc_discont_name(t->last_reason.load());
        GST_INFO_OBJECT(self, "device relock (%s)", why);
        asrc_post(self, gst_structure_new("mrasrc-event", "kind", G_TYPE_STRING, "device-relock",
                                          "reason", G_TYPE_STRING, why, "house-ns", G_TYPE_INT64,
                                          house_ns, NULL));
    }
}

/* --- the servo and the resampler ------------------------------------------------------ */

static void asrc_free_run(GstMrAsrc* self) {
    delete self->servo;
    self->servo = NULL;
    if (self->resampler) gst_audio_resampler_free(self->resampler);
    self->resampler = NULL;
}

/* A run from the negotiated caps: a fresh lock and resampler, the next output an epoch's first.
 * The resampler is made at the scaled nominal rates; the first command moves it before any
 * sample, which leaves it as if made at the command's rates. */
static gboolean asrc_build_run(GstMrAsrc* self) {
    GST_OBJECT_LOCK(self);
    const guint quality = (guint)self->quality;
    const int64_t bypass_ppb = std::llround(self->bypass_below_ppm * 1000.0);
    GST_OBJECT_UNLOCK(self);
    const gint in_hz = GST_AUDIO_INFO_RATE(&self->in_info);
    const gint out_hz = GST_AUDIO_INFO_RATE(&self->out_info);
    const gint64 old_delay = self->resampler ? (gint64)self->delay_ns.load() : -1;
    asrc_free_run(self);
    self->resampler = mrasrc_resampler_new(GST_AUDIO_INFO_FORMAT(&self->in_info),
                                           GST_AUDIO_INFO_CHANNELS(&self->in_info), quality,
                                           in_hz, out_hz);
    if (!self->resampler) return FALSE;
    const bool device = self->term != NULL;
    mrts::AsrcServoConfig cfg = bypass_ppb > 0 ? mrts::asrc_decode_config(bypass_ppb, device)
                                               : mrts::AsrcServoConfig();
    cfg.device = device;
    self->device_only = device && bypass_ppb <= 0;
    self->servo = new AsrcServo(in_hz, out_hz, cfg);
    const gsize delay = gst_audio_resampler_get_max_latency(self->resampler);
    self->servo->set_delay((uint32_t)delay);
    self->cur_in_rate = in_hz * MRASRC_RATE_SCALE;
    self->cmd = AsrcServo::Command{self->cur_in_rate, out_hz * MRASRC_RATE_SCALE, false, 0};
    self->total = self->discard = 0;
    self->history->clear();
    self->started = FALSE;
    self->need_discont = TRUE;
    self->have_pts = FALSE;
    self->have_stats_at = FALSE;
    const guint64 delay_ns = gst_util_uint64_scale_int(delay, GST_SECOND, in_hz);
    self->delay_ns.store(delay_ns);
    if (old_delay >= 0 && (guint64)old_delay != delay_ns)
        gst_element_post_message(GST_ELEMENT_CAST(self),
                                 gst_message_new_latency(GST_OBJECT_CAST(self)));
    GST_INFO_OBJECT(self, "%s %d ch, %d -> %d Hz, quality %u, filter delay %u frames, mode %s",
                    gst_audio_format_to_string(GST_AUDIO_INFO_FORMAT(&self->in_info)),
                    GST_AUDIO_INFO_CHANNELS(&self->in_info), in_hz, out_hz, quality,
                    (guint)delay, mrts::asrc_mode_name(self->servo->mode()));
    return TRUE;
}

/* The capture time of the buffer's first frame. A buffer without one continues the previous
 * one at the nominal rate, which is where the lock would put it. */
static gint64 asrc_input_pts(GstMrAsrc* self, GstBuffer* buf, guint64 frames) {
    gint64 pts;
    if (GST_BUFFER_PTS_IS_VALID(buf)) {
        pts = (gint64)GST_BUFFER_PTS(buf);
    } else {
        if (!self->pts_warned) {
            self->pts_warned = TRUE;
            GST_WARNING_OBJECT(self, "buffer without a PTS: continuing the previous one");
        }
        pts = self->have_pts ? self->last_pts + (gint64)gst_util_uint64_scale_int(
                                                    self->last_frames, GST_SECOND,
                                                    GST_AUDIO_INFO_RATE(&self->in_info))
                             : 0;
    }
    self->have_pts = TRUE;
    self->last_pts = pts;
    self->last_frames = frames;
    return pts;
}

/* An epoch's end in decode and device modes (a GAP, a DISCONT): the filter's lookahead of zeros
 * brings the held tail out on the counter that ended, then the resampler starts afresh. */
static void asrc_drain_tail(GstMrAsrc* self) {
    const gsize delay = gst_audio_resampler_get_max_latency(self->resampler);
    const gsize k = gst_audio_resampler_get_out_frames(self->resampler, delay);
    GstBuffer* out = k ? gst_buffer_new_allocate(NULL, k * self->bpf, NULL) : NULL;
    GstMapInfo om;
    if (out && gst_buffer_map(out, &om, GST_MAP_WRITE)) {
        gpointer op = om.data;
        gst_audio_resampler_resample(self->resampler, NULL, delay, &op, k);
        gst_buffer_unmap(out, &om);
        const gint64 pts = self->servo->tail_pts_at(0), end = self->servo->tail_pts_at(k);
        const guint64 offset = self->servo->stats().out_frames;
        GST_BUFFER_PTS(out) = (GstClockTime)MAX(pts, 0);
        GST_BUFFER_DURATION(out) = (GstClockTime)(end - pts);
        GST_BUFFER_OFFSET(out) = offset;
        GST_BUFFER_OFFSET_END(out) = offset + k;
        if (self->need_discont) {   // an epoch shorter than the lookahead: its first output
            GST_BUFFER_FLAG_SET(out, GST_BUFFER_FLAG_DISCONT);
            self->need_discont = FALSE;
        }
        self->servo->tail_produced((uint32_t)k);
        const GstFlowReturn ret = gst_pad_push(GST_BASE_TRANSFORM_SRC_PAD(self), out);
        if (ret != GST_FLOW_OK)
            GST_DEBUG_OBJECT(self, "the drained tail was refused: %s", gst_flow_get_name(ret));
    } else if (out) {
        gst_buffer_unref(out);
    }
    gst_audio_resampler_reset(self->resampler);
    self->discard = 0;
}

/* An engage from passing: the resampler, reset, takes the passed history at the commanded rate
 * and drops as many outputs as frames it took, so its next output is the engaging buffer's first
 * frame (seamless: nothing dropped or repeated). */
static void asrc_prime(GstMrAsrc* self) {
    gst_audio_resampler_reset(self->resampler);
    gst_audio_resampler_update(self->resampler, self->cmd.in_rate, self->cmd.out_rate, NULL);
    self->cur_in_rate = self->cmd.in_rate;
    self->updates++;
    const gsize h = self->history->size() / self->bpf;
    const gsize k0 = gst_audio_resampler_get_out_frames(self->resampler, h);
    std::vector<guint8> scratch(MAX(k0, (gsize)1) * self->bpf);
    gpointer ip = self->history->data(), op = scratch.data();
    if (h > 0) gst_audio_resampler_resample(self->resampler, &ip, h, &op, k0);
    self->discard = h - k0;
    self->history->clear();
}

/* The last frames passed: at most HISTORY_FRAMES, the newest last. */
static void asrc_keep_history(GstMrAsrc* self, GstBuffer* buf, gboolean fresh) {
    std::vector<guint8>& h = *self->history;
    if (fresh) h.clear();
    GstMapInfo im;
    if (!gst_buffer_map(buf, &im, GST_MAP_READ)) return;
    const gsize keep = HISTORY_FRAMES * self->bpf, n = MIN(im.size, keep);
    h.insert(h.end(), im.data + im.size - n, im.data + im.size);
    if (h.size() > keep) h.erase(h.begin(), h.begin() + (h.size() - keep));
    gst_buffer_unmap(buf, &im);
}

/* --- the device term ------------------------------------------------------------------- */

/* The element downstream of this one named `name`, through each element's src pads; into a bin
 * by its ghost pad's target, out of one by the ghost pad. A new ref, or NULL. */
static GstElement* asrc_find_downstream(GstMrAsrc* self, const gchar* name) {
    std::vector<GstPad*> todo{GST_PAD(gst_object_ref(GST_BASE_TRANSFORM_SRC_PAD(self)))};
    std::set<GstElement*> seen;   // compared only: the pipeline keeps them alive
    GstElement* found = NULL;
    while (!todo.empty() && !found) {
        GstPad* pad = todo.back();
        todo.pop_back();
        GstPad* peer = gst_pad_get_peer(pad);
        gst_object_unref(pad);
        while (peer && GST_IS_GHOST_PAD(peer)) {
            GstPad* target = gst_ghost_pad_get_target(GST_GHOST_PAD(peer));
            gst_object_unref(peer);
            peer = target;
        }
        if (!peer) continue;
        GstObject* parent = gst_object_get_parent(GST_OBJECT(peer));
        if (parent && GST_IS_GHOST_PAD(parent)) {   // a ghost src pad's inside: on from the ghost pad
            todo.push_back(GST_PAD(parent));
            gst_object_unref(peer);
            continue;
        }
        gst_object_unref(peer);
        if (!parent || !GST_IS_ELEMENT(parent)) {
            if (parent) gst_object_unref(parent);
            continue;
        }
        GstElement* el = GST_ELEMENT(parent);
        if (!seen.insert(el).second) {
            gst_object_unref(el);
            continue;
        }
        if (!g_strcmp0(GST_OBJECT_NAME(el), name)) {
            found = el;
            break;
        }
        GstIterator* it = gst_element_iterate_src_pads(el);
        GValue v = G_VALUE_INIT;
        while (gst_iterator_next(it, &v) == GST_ITERATOR_OK) {
            todo.push_back(GST_PAD(gst_object_ref(g_value_get_object(&v))));
            g_value_reset(&v);
        }
        g_value_unset(&v);
        gst_iterator_free(it);
        gst_object_unref(el);
    }
    for (GstPad* p : todo) gst_object_unref(p);
    return found;
}

/* READY->PAUSED: the named sink must be a GstAudioBaseSink downstream with slave-method=custom
 * (a builder bug otherwise, posted as an error naming it); its callback feeds the device lock. */
static gboolean asrc_install_device(GstMrAsrc* self) {
    GST_OBJECT_LOCK(self);
    gchar* name = g_strdup(self->device_sink);
    GST_OBJECT_UNLOCK(self);
    if (!name || !*name) {
        g_free(name);
        return TRUE;
    }
    GstElement* el = asrc_find_downstream(self, name);
    gint method = -1;
    if (el && GST_IS_AUDIO_BASE_SINK(el)) g_object_get(el, "slave-method", &method, NULL);
    if (!el || !GST_IS_AUDIO_BASE_SINK(el) || method != GST_AUDIO_BASE_SINK_SLAVE_CUSTOM) {
        const gchar* what = !el ? "no element of that name downstream"
                            : !GST_IS_AUDIO_BASE_SINK(el) ? "not a GstAudioBaseSink"
                                                          : "its slave-method is not custom (3)";
        GST_ELEMENT_ERROR(self, CORE, FAILED, ("device-sink \"%s\": %s", name, what),
                          ("mrasrc follows that sink's clock through its custom slaving callback "
                           "(found: %s)", el ? G_OBJECT_TYPE_NAME(el) : "none"));
        if (el) gst_object_unref(el);
        g_free(name);
        return FALSE;
    }
    AsrcDeviceTerm* t = new AsrcDeviceTerm();
    gst_audio_base_sink_set_custom_slaving_callback(GST_AUDIO_BASE_SINK(el), asrc_slaving_cb, t, NULL);
    self->term = t;
    self->term_relocks = 0;
    self->sink = GST_AUDIO_BASE_SINK(el);
    GST_INFO_OBJECT(self, "device-sink %s: following its clock (custom slaving)", name);
    g_free(name);
    return TRUE;
}

/* PAUSED->READY: the sink's streaming has stopped; the callback is taken back under its lock. */
static void asrc_remove_device(GstMrAsrc* self) {
    if (self->sink) {
        gst_audio_base_sink_set_custom_slaving_callback(self->sink, NULL, NULL, NULL);
        gst_object_unref(self->sink);
        self->sink = NULL;
    }
    delete self->term;
    self->term = NULL;
}

/* --- GstBaseTransform ----------------------------------------------------------------- */

/* Can `s` carry `rate`? (No rate field: any.) gst_value_can_intersect would only compare the
 * types; the intersection itself compares the values. */
static gboolean asrc_accepts_rate(const GstStructure* s, gint rate) {
    const GValue* r = gst_structure_get_value(s, "rate");
    if (!r) return TRUE;
    GValue v = G_VALUE_INIT;
    g_value_init(&v, G_TYPE_INT);
    g_value_set_int(&v, rate);
    const gboolean ok = gst_value_intersect(NULL, r, &v);
    g_value_unset(&v);
    return ok;
}

/* The rate is free on the input. On the output it is out-rate, or with 0 the input's first
 * (same as input) and any other rate downstream asks for second, as audioresample offers it. */
static GstCaps* asrc_transform_caps(GstBaseTransform* trans, GstPadDirection direction,
                                    GstCaps* caps, GstCaps* filter) {
    GstMrAsrc* self = GST_MRASRC(trans);
    GST_OBJECT_LOCK(self);
    const gint out_rate = self->out_rate;
    GST_OBJECT_UNLOCK(self);
    GstCaps* res = gst_caps_new_empty();
    const guint n = gst_caps_get_size(caps);
    for (guint i = 0; i < n; i++) {
        const GstStructure* s = gst_caps_get_structure(caps, i);
        if (direction == GST_PAD_SINK && out_rate > 0) {
            GstStructure* t = gst_structure_copy(s);
            gst_structure_set(t, "rate", G_TYPE_INT, out_rate, NULL);
            res = gst_caps_merge_structure(res, t);
            continue;
        }
        if (direction == GST_PAD_SRC && out_rate > 0 && !asrc_accepts_rate(s, out_rate)) continue;
        if (direction == GST_PAD_SINK) res = gst_caps_merge_structure(res, gst_structure_copy(s));
        GstStructure* t = gst_structure_copy(s);
        gst_structure_set(t, "rate", GST_TYPE_INT_RANGE, RATE_MIN, RATE_MAX, NULL);
        res = gst_caps_merge_structure(res, t);
    }
    if (filter) {
        GstCaps* both = gst_caps_intersect_full(filter, res, GST_CAPS_INTERSECT_FIRST);
        gst_caps_unref(res);
        res = both;
    }
    return res;
}

/* The output at out-rate, else at the rate nearest the other side's. */
static GstCaps* asrc_fixate_caps(GstBaseTransform* trans, GstPadDirection direction,
                                 GstCaps* caps, GstCaps* othercaps) {
    GstMrAsrc* self = GST_MRASRC(trans);
    GST_OBJECT_LOCK(self);
    const gint out_rate = self->out_rate;
    GST_OBJECT_UNLOCK(self);
    gint want = 0;
    if (direction == GST_PAD_SINK && out_rate > 0)
        want = out_rate;
    else if (!gst_structure_get_int(gst_caps_get_structure(caps, 0), "rate", &want))
        want = 0;
    othercaps = gst_caps_make_writable(gst_caps_truncate(othercaps));
    if (want > 0)
        gst_structure_fixate_field_nearest_int(gst_caps_get_structure(othercaps, 0), "rate",
                                               want);
    return gst_caps_fixate(othercaps);
}

static gboolean asrc_get_unit_size(GstBaseTransform*, GstCaps* caps, gsize* size) {
    GstAudioInfo info;
    if (!gst_audio_info_from_caps(&info, caps)) return FALSE;
    *size = GST_AUDIO_INFO_BPF(&info);
    return TRUE;
}

/* The format and the channels pass through; only the rate may differ. New caps that leave the
 * audio format as it was (a field GstAudioInfo ignores) keep the run: a rebuild restarts T0. */
static gboolean asrc_set_caps(GstBaseTransform* trans, GstCaps* incaps, GstCaps* outcaps) {
    GstMrAsrc* self = GST_MRASRC(trans);
    GstAudioInfo in, out;
    if (!gst_audio_info_from_caps(&in, incaps) || !gst_audio_info_from_caps(&out, outcaps)) {
        GST_ERROR_OBJECT(self, "caps not audio: %" GST_PTR_FORMAT " -> %" GST_PTR_FORMAT, incaps,
                         outcaps);
        return FALSE;
    }
    const GstAudioFormat f = GST_AUDIO_INFO_FORMAT(&in);
    if (f != GST_AUDIO_INFO_FORMAT(&out) || GST_AUDIO_INFO_CHANNELS(&in) !=
                                                GST_AUDIO_INFO_CHANNELS(&out) ||
        GST_AUDIO_INFO_LAYOUT(&in) != GST_AUDIO_LAYOUT_INTERLEAVED ||
        GST_AUDIO_INFO_LAYOUT(&out) != GST_AUDIO_LAYOUT_INTERLEAVED ||
        (f != GST_AUDIO_FORMAT_S16 && f != GST_AUDIO_FORMAT_S32 && f != GST_AUDIO_FORMAT_F32)) {
        GST_ERROR_OBJECT(self, "only the rate may change: %" GST_PTR_FORMAT " -> %" GST_PTR_FORMAT,
                         incaps, outcaps);
        return FALSE;
    }
    if (self->servo && gst_audio_info_is_equal(&in, &self->in_info) &&
        gst_audio_info_is_equal(&out, &self->out_info))
        return TRUE;
    self->in_info = in;
    self->out_info = out;
    self->bpf = GST_AUDIO_INFO_BPF(&in);
    if (!asrc_build_run(self)) {
        GST_ELEMENT_ERROR(self, CORE, NEGOTIATION, ("Cannot make the resampler"),
                          ("%" GST_PTR_FORMAT " -> %" GST_PTR_FORMAT, incaps, outcaps));
        return FALSE;
    }
    return TRUE;
}

/* SINK: what the buffer being prepared makes, its relock overlap skipped first and an engage's
 * remaining discard taken off; a passed buffer, its own size. */
static gboolean asrc_transform_size(GstBaseTransform* trans, GstPadDirection direction,
                                    GstCaps*, gsize size, GstCaps*, gsize* othersize) {
    GstMrAsrc* self = GST_MRASRC(trans);
    if (!self->resampler || self->bpf <= 0) return FALSE;
    const gsize frames = size / self->bpf;
    if (direction == GST_PAD_SINK) {
        if (self->cmd.pass) {
            *othersize = size;
            return TRUE;
        }
        const gsize skip = MIN((gsize)self->cmd.skip, frames);
        const gsize k = gst_audio_resampler_get_out_frames(self->resampler, frames - skip);
        *othersize = (k - MIN(self->discard, k)) * self->bpf;
    } else {
        *othersize = gst_audio_resampler_get_in_frames(self->resampler, frames) * self->bpf;
    }
    return TRUE;
}

/* The servo runs here, once per buffer the base class transforms, so every frame it counts
 * reaches the resampler; its command moves the ratio before the output size is known. A passed
 * buffer is its own output (zero copy). */
static GstFlowReturn asrc_prepare_output_buffer(GstBaseTransform* trans, GstBuffer* in,
                                                GstBuffer** out) {
    GstMrAsrc* self = GST_MRASRC(trans);
    if (!self->servo) return GST_FLOW_NOT_NEGOTIATED;
    const gsize size = gst_buffer_get_size(in);
    const guint64 frames = size / self->bpf;
    const gint64 pts = asrc_input_pts(self, in, frames);
    const gboolean discont = GST_BUFFER_IS_DISCONT(in);
    self->buffers++;
    // Decode and device modes: the epoch ends before a DISCONT buffer, the tail out first.
    if (discont && self->started && self->servo->end_epoch()) asrc_drain_tail(self);
    self->started = TRUE;
    const int64_t dev = self->term ? self->term->eps_ppb.load() : 0;
    self->cmd = self->servo->push(pts, (uint32_t)frames, discont, dev);
    if (self->cmd.drain) asrc_drain_tail(self);
    if (self->cmd.engage) asrc_prime(self);
    if (!self->cmd.pass && self->cmd.in_rate != self->cur_in_rate) {
        gst_audio_resampler_update(self->resampler, self->cmd.in_rate, self->cmd.out_rate, NULL);
        self->cur_in_rate = self->cmd.in_rate;
        self->updates++;
    }
    if (self->cmd.relock) self->need_discont = TRUE;
    asrc_post_events(self, pts);
    if (self->cmd.pass) {
        *out = in;   // the base class pushes it as it came: no copy, no new metadata
        return GST_FLOW_OK;
    }
    const gsize skip = MIN((gsize)self->cmd.skip, (gsize)frames);
    self->total = gst_audio_resampler_get_out_frames(self->resampler, frames - skip);
    gsize outsize = 0;
    asrc_transform_size(trans, GST_PAD_SINK, NULL, size, NULL, &outsize);
    GstAllocator* allocator = NULL;
    GstAllocationParams params;
    gst_base_transform_get_allocator(trans, &allocator, &params);
    *out = gst_buffer_new_allocate(allocator, outsize, &params);
    if (allocator) gst_object_unref(allocator);
    return *out ? GST_FLOW_OK : GST_FLOW_ERROR;
}

/* Labels from the servo's counter; DISCONT on an epoch's first output. */
static void asrc_label(GstMrAsrc* self, GstBuffer* out, gsize k) {
    const uint64_t m = self->servo->epoch_frames();
    const gint64 pts = self->servo->pts_at(m), end = self->servo->pts_at(m + k);
    const guint64 offset = self->servo->stats().out_frames;
    GST_BUFFER_PTS(out) = (GstClockTime)MAX(pts, 0);
    GST_BUFFER_DTS(out) = GST_CLOCK_TIME_NONE;
    GST_BUFFER_DURATION(out) = (GstClockTime)(end - pts);
    GST_BUFFER_OFFSET(out) = offset;
    GST_BUFFER_OFFSET_END(out) = offset + k;
    if (k > 0 && self->need_discont) {
        GST_BUFFER_FLAG_SET(out, GST_BUFFER_FLAG_DISCONT);
        self->need_discont = FALSE;
    }
    self->servo->produced((uint32_t)k);
}

static GstFlowReturn asrc_transform(GstBaseTransform* trans, GstBuffer* in, GstBuffer* out) {
    GstMrAsrc* self = GST_MRASRC(trans);
    const gsize bpf = (gsize)self->bpf;
    const gsize frames = gst_buffer_get_size(in) / bpf;
    if (out == in) {   // passed: what it held is the history an engage primes with
        asrc_keep_history(self, in, self->cmd.relock);
        self->need_discont = FALSE;   // an output: its epoch's DISCONT is the input's own
        self->servo->produced((uint32_t)frames);
        asrc_report(self, FALSE);
        return GST_FLOW_OK;
    }
    const gsize skip = MIN((gsize)self->cmd.skip, frames), fed = frames - skip;
    const gsize k = gst_buffer_get_size(out) / bpf;   // asrc_prepare_output_buffer's count
    if (fed > 0) {
        GstMapInfo im, om = GST_MAP_INFO_INIT;
        if (!gst_buffer_map(in, &im, GST_MAP_READ)) return GST_FLOW_ERROR;
        if (k > 0 && !gst_buffer_map(out, &om, GST_MAP_WRITE)) {
            gst_buffer_unmap(in, &im);
            return GST_FLOW_ERROR;
        }
        /* The overlap leaves unresampled, from the head (part 4.5). */
        gpointer ip = im.data + skip * bpf;
        if (self->total == k) {
            gpointer op = om.data;
            gst_audio_resampler_resample(self->resampler, &ip, fed, &op, k);
        } else {   // an engage's first outputs repeat what passed: dropped
            std::vector<guint8> all(MAX(self->total, (gsize)1) * bpf);
            gpointer op = all.data();
            gst_audio_resampler_resample(self->resampler, &ip, fed, &op, self->total);
            const gsize d = self->total - k;
            if (k > 0) std::memcpy(om.data, all.data() + d * bpf, k * bpf);
            self->discard -= MIN(self->discard, d);
        }
        if (k > 0) gst_buffer_unmap(out, &om);
        gst_buffer_unmap(in, &im);
    }
    asrc_label(self, out, k);
    asrc_report(self, FALSE);
    return GST_FLOW_OK;
}

/* A buffer that made no output (the filter filling, an overlap dropped whole) is not pushed,
 * and is no discontinuity: GST_BASE_TRANSFORM_FLOW_DROPPED would flag the next buffer DISCONT. */
static GstFlowReturn asrc_generate_output(GstBaseTransform* trans, GstBuffer** out) {
    const GstFlowReturn ret =
        GST_BASE_TRANSFORM_CLASS(gst_mrasrc_parent_class)->generate_output(trans, out);
    if (ret == GST_FLOW_OK && *out && gst_buffer_get_size(*out) == 0) {
        gst_buffer_unref(*out);
        *out = NULL;
    }
    return ret;
}

/* At EOS the filter's lookahead of zeros brings the last input out, on the same counter. */
static void asrc_drain(GstMrAsrc* self) {
    if (!self->servo || !self->started || self->servo->passing()) return;
    const gsize delay = gst_audio_resampler_get_max_latency(self->resampler);
    const gsize k = gst_audio_resampler_get_out_frames(self->resampler, delay);
    if (k == 0) return;
    GstBuffer* out = gst_buffer_new_allocate(NULL, k * self->bpf, NULL);
    GstMapInfo om;
    if (!out || !gst_buffer_map(out, &om, GST_MAP_WRITE)) {
        if (out) gst_buffer_unref(out);
        return;
    }
    gpointer op = om.data;
    gst_audio_resampler_resample(self->resampler, NULL, delay, &op, k);
    gst_buffer_unmap(out, &om);
    asrc_label(self, out, k);
    const GstFlowReturn ret = gst_pad_push(GST_BASE_TRANSFORM_SRC_PAD(self), out);
    if (ret != GST_FLOW_OK)
        GST_DEBUG_OBJECT(self, "the drained tail was refused: %s", gst_flow_get_name(ret));
}

static gboolean asrc_sink_event(GstBaseTransform* trans, GstEvent* event) {
    GstMrAsrc* self = GST_MRASRC(trans);
    switch (GST_EVENT_TYPE(event)) {
        case GST_EVENT_FLUSH_STOP:
            /* Nothing before the flush joins what follows: a fresh lock and filter. */
            if (self->servo && !asrc_build_run(self))
                GST_ELEMENT_ERROR(self, CORE, FAILED, ("Cannot make the resampler"), (NULL));
            break;
        case GST_EVENT_GAP:
            /* Decode and device modes: the content breaks; the tail leaves before the GAP. */
            if (self->servo && self->started && self->servo->end_epoch()) asrc_drain_tail(self);
            break;
        case GST_EVENT_EOS:
            /* The last stats first: the drained tail moves the counter without input, which
             * would read as a phase error. */
            if (self->servo && self->started) asrc_report(self, TRUE);
            asrc_drain(self);
            break;
        default:
            break;
    }
    return GST_BASE_TRANSFORM_CLASS(gst_mrasrc_parent_class)->sink_event(trans, event);
}

/* Upstream's latency plus the filter's lookahead, as audioresample reports it; in decode mode
 * too while passing, since it may engage. */
static gboolean asrc_query(GstBaseTransform* trans, GstPadDirection direction, GstQuery* query) {
    GstMrAsrc* self = GST_MRASRC(trans);
    const gboolean res =
        GST_BASE_TRANSFORM_CLASS(gst_mrasrc_parent_class)->query(trans, direction, query);
    if (res && direction == GST_PAD_SRC && GST_QUERY_TYPE(query) == GST_QUERY_LATENCY) {
        gboolean live;
        GstClockTime min, max;
        gst_query_parse_latency(query, &live, &min, &max);
        const GstClockTime d = self->delay_ns.load();
        gst_query_set_latency(query, live, min + d, GST_CLOCK_TIME_IS_VALID(max) ? max + d : max);
    }
    return res;
}

/* Every start counts from 0. */
static gboolean asrc_start(GstBaseTransform* trans) {
    GstMrAsrc* self = GST_MRASRC(trans);
    self->buffers = self->updates = 0;
    self->pts_warned = FALSE;
    g_mutex_lock(&self->snap_lock);
    if (self->snapshot) gst_structure_free(self->snapshot);
    self->snapshot = NULL;
    g_mutex_unlock(&self->snap_lock);
    self->common.reset();
    return TRUE;
}

static gboolean asrc_stop(GstBaseTransform* trans) {
    GstMrAsrc* self = GST_MRASRC(trans);
    asrc_free_run(self);
    gst_audio_info_init(&self->in_info);
    gst_audio_info_init(&self->out_info);
    self->bpf = 0;
    self->delay_ns.store(0);
    return TRUE;
}

static GstStateChangeReturn asrc_change_state(GstElement* element, GstStateChange transition) {
    GstMrAsrc* self = GST_MRASRC(element);
    if (transition == GST_STATE_CHANGE_READY_TO_PAUSED && !asrc_install_device(self))
        return GST_STATE_CHANGE_FAILURE;
    const GstStateChangeReturn ret =
        GST_ELEMENT_CLASS(gst_mrasrc_parent_class)->change_state(element, transition);
    if (transition == GST_STATE_CHANGE_PAUSED_TO_READY ||
        (transition == GST_STATE_CHANGE_READY_TO_PAUSED && ret == GST_STATE_CHANGE_FAILURE))
        asrc_remove_device(self);
    return ret;
}

/* --- GObject -------------------------------------------------------------------------- */

static void asrc_set_property(GObject* object, guint prop_id, const GValue* value,
                              GParamSpec* pspec) {
    GstMrAsrc* self = GST_MRASRC(object);
    switch (prop_id) {
        case PROP_OUT_RATE:
            GST_OBJECT_LOCK(self);
            self->out_rate = g_value_get_int(value);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_QUALITY:
            GST_OBJECT_LOCK(self);
            self->quality = g_value_get_int(value);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_BYPASS_BELOW_PPM:
            GST_OBJECT_LOCK(self);
            self->bypass_below_ppm = g_value_get_double(value);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_DEVICE_SINK:
            GST_OBJECT_LOCK(self);
            g_free(self->device_sink);
            self->device_sink = g_value_dup_string(value);
            GST_OBJECT_UNLOCK(self);
            break;
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
            break;
    }
}

static void asrc_get_property(GObject* object, guint prop_id, GValue* value, GParamSpec* pspec) {
    GstMrAsrc* self = GST_MRASRC(object);
    if (self->common.get(prop_id, value)) return;
    switch (prop_id) {
        case PROP_OUT_RATE:
            GST_OBJECT_LOCK(self);
            g_value_set_int(value, self->out_rate);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_QUALITY:
            GST_OBJECT_LOCK(self);
            g_value_set_int(value, self->quality);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_BYPASS_BELOW_PPM:
            GST_OBJECT_LOCK(self);
            g_value_set_double(value, self->bypass_below_ppm);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_DEVICE_SINK:
            GST_OBJECT_LOCK(self);
            g_value_set_string(value, self->device_sink ? self->device_sink : "");
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_STATS: {
            g_mutex_lock(&self->snap_lock);
            GstStructure* s = self->snapshot ? gst_structure_copy(self->snapshot) : NULL;
            g_mutex_unlock(&self->snap_lock);
            g_value_take_boxed(value, s ? s : asrc_stats_structure(AsrcServo::Stats(), NULL, false));
            break;
        }
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
            break;
    }
}

static void asrc_finalize(GObject* object) {
    GstMrAsrc* self = GST_MRASRC(object);
    asrc_free_run(self);
    asrc_remove_device(self);
    if (self->snapshot) gst_structure_free(self->snapshot);
    g_mutex_clear(&self->snap_lock);
    g_free(self->device_sink);
    delete self->history;
    G_OBJECT_CLASS(gst_mrasrc_parent_class)->finalize(object);
}

static void gst_mrasrc_init(GstMrAsrc* self) {
    new (&self->common) MrtsHouseCommon();
    new (&self->delay_ns) std::atomic<guint64>(0);
    self->out_rate = 0;
    self->quality = DEFAULT_QUALITY;
    self->bypass_below_ppm = 0.0;
    self->device_sink = NULL;
    self->term = NULL;
    self->sink = NULL;
    self->term_relocks = 0;
    self->device_only = FALSE;
    gst_audio_info_init(&self->in_info);
    gst_audio_info_init(&self->out_info);
    self->bpf = 0;
    self->servo = NULL;
    self->resampler = NULL;
    self->cur_in_rate = 0;
    self->cmd = AsrcServo::Command{0, 0, false, 0};
    self->total = self->discard = 0;
    self->started = FALSE;
    self->need_discont = TRUE;
    self->have_pts = FALSE;
    self->last_pts = 0;
    self->last_frames = 0;
    self->pts_warned = FALSE;
    self->have_stats_at = FALSE;
    self->stats_at = 0;
    self->buffers = self->updates = 0;
    self->history = new std::vector<guint8>();
    g_mutex_init(&self->snap_lock);
    self->snapshot = NULL;
}

static void gst_mrasrc_class_init(GstMrAsrcClass* klass) {
    GObjectClass* gobject_class = G_OBJECT_CLASS(klass);
    GstElementClass* element_class = GST_ELEMENT_CLASS(klass);
    GstBaseTransformClass* trans_class = GST_BASE_TRANSFORM_CLASS(klass);

    gobject_class->set_property = asrc_set_property;
    gobject_class->get_property = asrc_get_property;
    gobject_class->finalize = asrc_finalize;

    const GParamFlags at_start =
        (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS | GST_PARAM_MUTABLE_READY);
    g_object_class_install_property(
        gobject_class, PROP_OUT_RATE,
        g_param_spec_int("out-rate", "Output rate",
                         "The house rate the output counts at, in Hz. 0: the input's rate, or "
                         "the rate downstream asks for. Applies at the next start or caps change.",
                         0, RATE_MAX, 0, at_start));
    g_object_class_install_property(
        gobject_class, PROP_QUALITY,
        g_param_spec_int("quality", "Quality",
                         "GstAudioResampler Kaiser quality, 0 (8 taps) to 10 (256 taps). "
                         "Applies at the next start or caps change.",
                         GST_AUDIO_RESAMPLER_QUALITY_MIN, GST_AUDIO_RESAMPLER_QUALITY_MAX,
                         DEFAULT_QUALITY, at_start));
    g_object_class_install_property(
        gobject_class, PROP_STATS,
        g_param_spec_boxed("stats", "Stats",
                           "The last mrasrc-stats post (state, ratio-ppb, phase-err-ns, relocks, "
                           "in-frames, out-frames, discont-in, dropped-frames, mode, source-ppb, "
                           "device-ppb) with the run's format, channels, in-rate, out-rate, "
                           "delay-frames, buffers, resampler-updates and device-pairs.",
                           GST_TYPE_STRUCTURE,
                           (GParamFlags)(G_PARAM_READABLE | G_PARAM_STATIC_STRINGS)));
    g_object_class_install_property(
        gobject_class, PROP_BYPASS_BELOW_PPM,
        g_param_spec_double("bypass-below-ppm", "Bypass below (ppm)",
                            "Decode mode when above 0: buffers pass unchanged while the source's "
                            "clock measures within this many ppm of house time and its phase "
                            "within 1 ms, resampled to house rate from the buffer that crosses "
                            "either until a DISCONT or GAP. 0: capture mode, or with device-sink "
                            "the device term alone. Applies at the next start or caps change.",
                            0.0, BYPASS_MAX_PPM, 0.0, at_start));
    g_object_class_install_property(
        gobject_class, PROP_DEVICE_SINK,
        g_param_spec_string("device-sink", "Device sink",
                            "The name of the GstAudioBaseSink downstream whose clock the output "
                            "follows, through its custom slaving callback (it must have "
                            "slave-method=custom); the ratio carries that device term. \"\": "
                            "none. Found at READY to PAUSED.",
                            "", at_start));
    /* After our own: the common ids are clear of these (MrtsHouseCommon::PROP_BASE). */
    MrtsHouseCommon::install(gobject_class);

    gst_element_class_add_static_pad_template(element_class, &asrc_sink_tmpl);
    gst_element_class_add_static_pad_template(element_class, &asrc_src_tmpl);
    gst_element_class_set_static_metadata(
        element_class, "Media Router ASRC", "Filter/Converter/Audio",
        "Resamples audio to the house rate as a sample counter: a capture to its capture time, "
        "a decode to its content time once its source's clock is measured off house time, an "
        "output to its device's clock (mrts::AsrcServo driving GstAudioResampler)",
        "media-router");
    element_class->change_state = GST_DEBUG_FUNCPTR(asrc_change_state);

    trans_class->transform_caps = GST_DEBUG_FUNCPTR(asrc_transform_caps);
    trans_class->fixate_caps = GST_DEBUG_FUNCPTR(asrc_fixate_caps);
    trans_class->get_unit_size = GST_DEBUG_FUNCPTR(asrc_get_unit_size);
    trans_class->set_caps = GST_DEBUG_FUNCPTR(asrc_set_caps);
    trans_class->transform_size = GST_DEBUG_FUNCPTR(asrc_transform_size);
    trans_class->prepare_output_buffer = GST_DEBUG_FUNCPTR(asrc_prepare_output_buffer);
    trans_class->transform = GST_DEBUG_FUNCPTR(asrc_transform);
    trans_class->generate_output = GST_DEBUG_FUNCPTR(asrc_generate_output);
    trans_class->sink_event = GST_DEBUG_FUNCPTR(asrc_sink_event);
    trans_class->query = GST_DEBUG_FUNCPTR(asrc_query);
    trans_class->start = GST_DEBUG_FUNCPTR(asrc_start);
    trans_class->stop = GST_DEBUG_FUNCPTR(asrc_stop);
    /* Never the base class's pass-through, even at equal rates: decode mode passes buffers
     * itself, the other modes correct a clock there too. */
    trans_class->passthrough_on_same_caps = FALSE;
}
