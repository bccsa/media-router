/* mralignwatch (plan ch. 6 part 4.3, WI-P2-6): a non-live aggregator's input. A FIFO released
 * at running time + the shared pace; silent past W, gapped, and so is an input that joins or
 * rejoins a running aggregator until it catches up (B-80); LATENCY non-live. A plain GstElement:
 * lists stay lists, every push leaves from the src task, in order. */
#include <gst/audio/audio.h>

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <deque>
#include <new>
#include <string>
#include <utility>
#include <vector>

#include "mrts/align_watch.h"
#include "mrtshouse.h"

#define GST_CAT_DEFAULT mrtshouse_debug

using mrts::PaceRegistry;

enum {
    PROP_0,
    PROP_ALIGNER,
    PROP_INPUT,
    PROP_SPARSE,
    PROP_HOLD_ON_EOS,
    PROP_SEED_LATENESS,
    PROP_SILENCE_FACTOR,
    PROP_SILENCE_FLOOR,
    PROP_SILENCE_CEILING,
    PROP_MAX_SIZE_TIME,
    PROP_MAX_SIZE_BYTES,
    PROP_TICK,
    PROP_FALL_AFTER,
    PROP_STATE,
    PROP_LATENESS,
    PROP_PACE,
    PROP_PACE_TARGET,
    PROP_SILENCE_LIMIT,
    PROP_ABSENCES,
    PROP_STALE_BUFFERS,
    PROP_STALE_TIME,
    PROP_GAPS,
    PROP_LEVEL_TIME,
    PROP_LEVEL_BYTES,
    PROP_FULL_COUNT,
    PROP_PASSES,
};

#define DEFAULT_SILENCE_FACTOR 3.0
#define DEFAULT_SILENCE_FLOOR (100 * GST_MSECOND)
#define DEFAULT_SILENCE_CEILING (2 * GST_SECOND)
#define DEFAULT_MAX_SIZE_TIME (5 * GST_SECOND)
#define DEFAULT_TICK (20 * GST_MSECOND)
#define DEFAULT_FALL_AFTER ((guint64)mrts::PaceGroup::FALL_AFTER_NS)
/* GstAudioAggregator's own default output block, for one that reports none. */
#define DEFAULT_AUDIO_BLOCK (10 * GST_MSECOND)
/* The longest gap an audio aggregator gets in pieces of its block (aw_push_gap). */
static const gint64 PIECED_MAX_NS = GST_SECOND;
/* The `mralignwatch` message's cadence (part 4.3), besides every state change. */
static const gint64 REPORT_NS = GST_SECOND;
/* What is due this close to now leaves at once, without a timed wait (B-79). */
static const gint64 RELEASE_SLACK_NS = GST_MSECOND;
/* A joiner this close behind the gaps' end, no rise under way, is waited for: a stop of at most
 * this (a tick more toward mpegtsmux), half the 100 ms floor of any downstream W, where a slew
 * would cost it half a second (B-80). */
static const gint64 CATCH_UP_NS = 50 * GST_MSECOND;
/* Untimed buffers add no time level: past this many items the FIFO is full anyway (R9). */
static const size_t ITEMS_MAX = 32768;

enum class AwState { waiting, present, absent };

static const gchar* state_name(AwState s) {
    switch (s) {
        case AwState::present: return "present";
        case AwState::absent: return "absent";
        default: return "waiting";
    }
}

enum class Kind { buffer, list, event, query };

/* The sink thread of a serialized query waits on this for the src task's answer. */
struct QueryWait {
    bool done = false;
    bool res = false;
};

struct Item {
    Kind kind;
    GstMiniObject* obj;
    bool timed = false;     // start/end valid: data with a timestamp, or a GAP
    gint64 start = 0;       // running time of the decode time (DTS, else PTS)
    gint64 end = 0;         // start + duration
    gint64 lateness = 0;    // at arrival
    guint64 bytes = 0;
    bool late = false;      // sparse: ended before the horizon at arrival, forwarded anyway
    QueryWait* wait = nullptr;
};

/* A sparse cue forwarded behind its gaps, for its message (C-3). */
struct LateCue {
    bool set = false;
    gint64 start = 0, lateness = 0, behind = 0;
};

/* Messages a critical section leaves for after the unlock (posting can re-enter us). */
enum : guint { MSG_STATE = 1, MSG_INTERVAL = 2, MSG_FULL = 4, MSG_FELL = 8 };

/* Everything a message or a property read reports, copied under the lock. */
struct Snap {
    std::string aligner, input;
    AwState state = AwState::waiting;
    gint64 lateness = 0, pace = 0, pace_target = 0, silence_limit = 0, fell = 0;
    guint64 absences = 0, stale_buffers = 0, stale_time = 0, gaps = 0, level_time = 0,
            level_bytes = 0, full_count = 0, passes = 0, fall_after = 0;
};

/* The run's state, under `lock`; reset at each start (READY -> PAUSED). */
struct Run {
    std::deque<Item> fifo;
    guint64 level_bytes = 0;
    gint64 tail_end = 0;            // the latest end of a timed item taken in
    mrts::ArrivalRhythm rhythm;
    mrts::GapPlanner planner;
    PaceRegistry::Membership member;
    std::string aligner, input;     // the properties as this run started
    bool sparse = false, hold_on_eos = false;
    AwState state = AwState::waiting;
    bool sink_eos = false;          // EOS taken in: data refused until FLUSH_STOP or STREAM_START
    bool eos_out = false;           // EOS forwarded
    bool eos_held = false;          // hold-on-eos: the EOS became absence
    bool discont = false;           // the next data out carries DISCONT (WI-P2-1 F3)
    /* Gapped from a late join, an absence or a held EOS until its first timed data that is
     * kept goes out: the others never wait for content behind the gaps (B-80). */
    bool catching_up = false;
    bool full_episode = false;
    bool ran = false;               // this member told its group the aggregator runs
    bool pace_run = false;          // an arrival of this run went into the pace
    bool primed = false;            // the task pushed what a first gap needs (task thread only)
    bool caps_primed = false;       // ...caps among it, no upstream CAPS out since (task only)
    bool quiet_started = false;
    gint64 quiet_from = 0;          // silence counts from here (the last arrival)...
    gint64 held_ns = 0;             // ...less the time we held the input since
    gint64 silence_limit = 0;       // W, as last taken...
    bool limit_stale = true;        // ...and an arrival or a setting since
    bool upstream_blocked = false;  // the sink thread waits in us (full, or a query)
    gint64 blocked_since = 0;
    bool report_started = false;
    gint64 report_at = 0;
    /* The pipeline's clock and base time, read once a run (PLAYING, set_clock), and the task's
     * one wait on it, re-armed each pass (task thread only) and unscheduled while it sleeps. */
    GstClock* clock = nullptr;
    gint64 base = 0;
    GstClockID clock_id = nullptr;
    GstClock* id_clock = nullptr;   // what clock_id was made on; cleared when the clock changes
    bool sleeping = false;          // the task waits on clock_id...
    gint64 wake_at = 0;             // ...to this running time
    bool cond_waiting = false;      // the task waits on item_added (no clock)
    bool ahead = false;             // the last data out waited for its release
    GstSegment in_segment;
    gint64 pace = 0, pace_target = 0, lateness = 0;
    mrts::PaceGroup::Snapshot snap;   // the group as the pace was last read
    gint64 fell = 0;                  // the last skip down this member's call applied (B-82)
    guint64 fall_after = 0;           // the group's
    guint64 absences = 0, stale_buffers = 0, stale_time = 0, gaps = 0, full_count = 0, passes = 0;
    gint64 unit_ns = 0;             // the last data buffer's duration, a gap piece's toward audio
    /* What the src pad feeds (task thread only): an audio aggregator takes a GAP whole at the
     * start of its output block, mpegtsmux takes only a GAP's start (WI-P2-1 F2). */
    enum class Down { unknown, audio, other } down = Down::unknown;
    gint64 block_ns = 0;            // the audio aggregator's output block
};

#define GST_TYPE_MRALIGNWATCH (gst_mralignwatch_get_type())
G_DECLARE_FINAL_TYPE(GstMrAlignWatch, gst_mralignwatch, GST, MRALIGNWATCH, GstElement)

struct _GstMrAlignWatch {
    GstElement parent;
    GstPad* sinkpad;
    GstPad* srcpad;

    /* Properties under the object lock; the live ones are also read by the task. */
    gchar* aligner;
    gchar* input;
    gboolean sparse;
    gboolean hold_on_eos;
    gint64 seed_lateness;
    guint64 fall_after;
    std::atomic<double> silence_factor;
    std::atomic<guint64> silence_floor, silence_ceiling, max_size_time, tick;
    std::atomic<guint> max_size_bytes;
    std::atomic<bool> playing;

    GMutex lock;
    GCond item_added;     // the task waits on it without a clock
    GCond item_removed;   // a full chain and a serialized query wait on it
    GstFlowReturn srcresult;
    Run* run;

    MrtsHouseCommon common;
};

G_DEFINE_TYPE(GstMrAlignWatch, gst_mralignwatch, GST_TYPE_ELEMENT)

static GstStaticPadTemplate aw_sink_tmpl =
    GST_STATIC_PAD_TEMPLATE("sink", GST_PAD_SINK, GST_PAD_ALWAYS, GST_STATIC_CAPS_ANY);
static GstStaticPadTemplate aw_src_tmpl =
    GST_STATIC_PAD_TEMPLATE("src", GST_PAD_SRC, GST_PAD_ALWAYS, GST_STATIC_CAPS_ANY);

static void aw_loop(gpointer data);
static bool aw_gapped(const Run& r);

/* --- time ------------------------------------------------------------------------------- */

/* Under the lock: pipeline clock - base time, only while PLAYING with a clock: nothing is paced
 * before. */
static bool aw_now(GstMrAlignWatch* self, gint64* now) {
    const Run& r = *self->run;
    if (!self->playing.load(std::memory_order_acquire) || !r.clock) return false;
    const GstClockTime t = gst_clock_get_time(r.clock);
    if (!GST_CLOCK_TIME_IS_VALID(t)) return false;
    *now = (gint64)t - r.base;
    return true;
}

/* Under the lock: the run's clock is `clock` from now; the task makes its wait on it anew. */
static void aw_use_clock(Run& r, GstClock* clock) {
    if (r.clock == clock) return;
    gst_object_replace((GstObject**)&r.clock, (GstObject*)clock);
    r.id_clock = nullptr;
}

/* Under the lock, the task stopped: the run lets go of the clock and its wait. */
static void aw_drop_clock(Run& r) {
    if (r.clock_id) gst_clock_id_unref(r.clock_id);
    r.clock_id = nullptr;
    r.id_clock = nullptr;
    gst_clear_object(&r.clock);
}

/* A buffer's [start, end) in running time, on its decode time (DTS, else PTS): a B-frame's
 * PTS runs back, and mpegtsmux, like GstQueue, orders by DTS. False: untimed. */
static bool aw_buffer_times(const GstSegment* seg, GstBuffer* b, gint64* start, gint64* end) {
    const GstClockTime ts = GST_BUFFER_DTS_OR_PTS(b);
    if (!GST_CLOCK_TIME_IS_VALID(ts) || seg->format != GST_FORMAT_TIME) return false;
    const GstClockTime rt = gst_segment_to_running_time(seg, GST_FORMAT_TIME, ts);
    if (!GST_CLOCK_TIME_IS_VALID(rt)) return false;
    *start = (gint64)rt;
    *end = *start + (GST_BUFFER_DURATION_IS_VALID(b) ? (gint64)GST_BUFFER_DURATION(b) : 0);
    return true;
}

/* A list's span: its first timed member's start to the latest end. */
static bool aw_list_times(const GstSegment* seg, GstBufferList* l, gint64* start, gint64* end) {
    bool any = false;
    const guint n = gst_buffer_list_length(l);
    for (guint i = 0; i < n; i++) {
        gint64 s, e;
        if (!aw_buffer_times(seg, gst_buffer_list_get(l, i), &s, &e)) continue;
        if (!any) *start = s;
        *end = any ? std::max(*end, e) : e;
        any = true;
    }
    return any;
}

/* --- levels ----------------------------------------------------------------------------- */

static guint64 aw_level_time(const Run& r) {
    for (const Item& it : r.fifo)
        if (it.timed) return (guint64)std::max<gint64>(r.tail_end - it.start, 0);
    return 0;
}

/* Full at the limits; `div` 2: at half of them, where a full episode ends. */
static bool aw_full(GstMrAlignWatch* self, guint div = 1) {
    const Run& r = *self->run;
    if (r.fifo.empty()) return false;
    const guint64 max_time = self->max_size_time.load(std::memory_order_relaxed) / div;
    const guint max_bytes = self->max_size_bytes.load(std::memory_order_relaxed) / div;
    return r.fifo.size() >= ITEMS_MAX / div || (max_bytes && r.level_bytes >= max_bytes) ||
           (max_time && aw_level_time(r) >= max_time);
}

/* --- messages --------------------------------------------------------------------------- */

static mrts::ArrivalRhythm::Config aw_rhythm_config(GstMrAlignWatch* self) {
    mrts::ArrivalRhythm::Config c;
    c.factor = self->silence_factor.load(std::memory_order_relaxed);
    c.floor_ns = (int64_t)self->silence_floor.load(std::memory_order_relaxed);
    c.ceiling_ns = (int64_t)self->silence_ceiling.load(std::memory_order_relaxed);
    return c;
}

/* Under the lock: W, taken from the arrivals and the settings only when it can matter: a p95
 * over 200 gaps at every arrival cost the matrix of n1 at 16 pairs a tenth of a core (B-79). */
static gint64 aw_limit(GstMrAlignWatch* self) {
    Run& r = *self->run;
    if (r.limit_stale) {
        r.silence_limit = r.rhythm.limit_ns(aw_rhythm_config(self));
        r.limit_stale = false;
    }
    return r.silence_limit;
}

/* The least W can be: a shorter silence needs no W. */
static gint64 aw_limit_floor(GstMrAlignWatch* self) {
    return (gint64)std::min(self->silence_floor.load(std::memory_order_relaxed),
                            self->silence_ceiling.load(std::memory_order_relaxed));
}

/* Under the lock. The group's pace, its target and this member's lateness as of now (the task
 * reads only the pace, lock-free); the last known once it left. */
static Snap aw_snap(GstMrAlignWatch* self) {
    Run& r = *self->run;
    gint64 now = 0;
    const PaceRegistry::View v =
        PaceRegistry::global().view(r.member, aw_now(self, &now) ? now : -1);
    if (v.members) {
        r.pace = v.pace_ns;
        r.pace_target = v.target_ns;
    }
    if (v.has_lateness) r.lateness = v.lateness_ns;
    Snap s;
    s.aligner = r.aligner;
    s.input = r.input;
    s.state = r.state;
    s.lateness = r.lateness;
    s.pace = r.pace;
    s.pace_target = r.pace_target;
    s.fell = r.fell;
    s.fall_after = r.fall_after;
    s.silence_limit = aw_limit(self);
    s.absences = r.absences;
    s.stale_buffers = r.stale_buffers;
    s.stale_time = r.stale_time;
    s.gaps = r.gaps;
    s.level_time = aw_level_time(r);
    s.level_bytes = r.level_bytes;
    s.full_count = r.full_count;
    s.passes = r.passes;
    return s;
}

static GstStructure* aw_message_structure(const Snap& s, const gchar* reason) {
    return gst_structure_new(
        "mralignwatch", "reason", G_TYPE_STRING, reason, "aligner", G_TYPE_STRING,
        s.aligner.c_str(), "input", G_TYPE_STRING, s.input.c_str(), "state", G_TYPE_STRING,
        state_name(s.state), "lateness", G_TYPE_INT64, s.lateness, "pace", G_TYPE_INT64, s.pace,
        "pace-target", G_TYPE_INT64, s.pace_target, "silence-limit", G_TYPE_INT64,
        s.silence_limit, "absences", G_TYPE_UINT64, s.absences,
        "stale-buffers", G_TYPE_UINT64, s.stale_buffers, "stale-time", G_TYPE_UINT64,
        s.stale_time, "gaps", G_TYPE_UINT64, s.gaps, "level-time", G_TYPE_UINT64, s.level_time,
        "level-bytes", G_TYPE_UINT64, s.level_bytes, "full-count", G_TYPE_UINT64, s.full_count,
        "passes", G_TYPE_UINT64, s.passes, NULL);
}

static void aw_post(GstMrAlignWatch* self, GstStructure* st) {
    gst_element_post_message(GST_ELEMENT_CAST(self),
                             gst_message_new_element(GST_OBJECT_CAST(self), st));
}

/* Not under the lock. One message per reason, from one snapshot. */
static void aw_post_pending(GstMrAlignWatch* self, guint pending, const Snap& s) {
    if (pending & MSG_STATE) aw_post(self, aw_message_structure(s, "state"));
    if (pending & MSG_FULL) aw_post(self, aw_message_structure(s, "full"));
    if (pending & MSG_FELL) {
        GstStructure* st = aw_message_structure(s, "pace-fell");
        gst_structure_set(st, "fell", G_TYPE_INT64, s.fell, "fall-after", G_TYPE_UINT64,
                          s.fall_after, NULL);
        aw_post(self, st);
    }
    if (pending & MSG_INTERVAL) aw_post(self, aw_message_structure(s, "interval"));
}

/* Under the lock: a skip down that this member's call applied, which it reports (B-82). */
static void aw_fell(GstMrAlignWatch* self, const mrts::PaceGroup::Event& ev, guint* pending) {
    if (!ev.fell_ns) return;
    self->run->fell = ev.fell_ns;
    *pending |= MSG_FELL;
    GST_INFO_OBJECT(self, "pace fell by %" G_GINT64_FORMAT " ms", ev.fell_ns / GST_MSECOND);
}

/* Under the lock: the group's pace at `now` (unclocked: as it stands), lock-free from its
 * snapshot; once now reaches the snapshot's next_at, the group ticks first (B-82). */
static gint64 aw_pace(GstMrAlignWatch* self, bool clocked, gint64 now, guint* pending) {
    Run& r = *self->run;
    r.snap = r.member.snapshot();
    if (clocked && r.member.member && now >= r.snap.next_at) {
        mrts::PaceGroup::Event ev;
        PaceRegistry::global().tick(r.member, now, &ev);
        aw_fell(self, ev, pending);
        r.snap = r.member.snapshot();
    }
    return r.snap.pace_at(clocked ? now : -1);
}

/* --- the FIFO --------------------------------------------------------------------------- */

static void aw_item_free(Item& it) {
    if (it.kind == Kind::query) {
        it.wait->done = true;   // flushed: the query fails, the sink thread goes on
        return;
    }
    gst_mini_object_unref(it.obj);
}

/* Under the lock: everything queued goes; a blocked chain or query is woken. */
static void aw_flush_fifo(GstMrAlignWatch* self) {
    Run& r = *self->run;
    for (Item& it : r.fifo) aw_item_free(it);
    r.fifo.clear();
    r.level_bytes = 0;
    r.full_episode = false;
    g_cond_broadcast(&self->item_removed);
}

/* Under the lock: wake the task's wait, whichever it is in (GLib signals cost a syscall). */
static void aw_wake(GstMrAlignWatch* self) {
    const Run& r = *self->run;
    if (r.sleeping) gst_clock_id_unschedule(r.clock_id);
    if (r.cond_waiting) g_cond_signal(&self->item_added);
}

/* An item in wakes the task when the queue was empty, unless its wait already ends no later
 * than the item's release at `pace`, the pace as it arrived (an input held behind the pace:
 * aw_deadline arms for it, B-79); the task's last pass may have read a higher one. */
static void aw_enqueue(GstMrAlignWatch* self, Item&& it, gint64 pace) {
    Run& r = *self->run;
    const bool was_empty = r.fifo.empty();
    const bool armed = r.sleeping && it.timed && it.start + pace - RELEASE_SLACK_NS >= r.wake_at;
    if (it.timed) r.tail_end = std::max(r.fifo.empty() ? it.end : r.tail_end, it.end);
    r.level_bytes += it.bytes;
    r.fifo.push_back(std::move(it));
    if (was_empty && !armed) aw_wake(self);
}

/* Under the lock: an item left. A full episode ends once the queue drained to half, so a
 * queue held at its limit (one out, one in) is one episode. */
static void aw_dequeued(GstMrAlignWatch* self, const Item& it) {
    Run& r = *self->run;
    r.level_bytes -= std::min(r.level_bytes, it.bytes);
    if (r.full_episode && !aw_full(self, 2)) r.full_episode = false;
    if (r.upstream_blocked) g_cond_broadcast(&self->item_removed);
}

/* --- arrival ---------------------------------------------------------------------------- */

/* Under the lock: an arrival (data or a GAP) at `now`. */
static void aw_arrival(GstMrAlignWatch* self, gint64 now, guint* pending) {
    Run& r = *self->run;
    r.rhythm.arrive(now);
    r.limit_stale = true;
    r.quiet_started = true;
    r.quiet_from = now;
    r.held_ns = 0;
    if (r.upstream_blocked) r.blocked_since = now;
    r.eos_held = false;   // data after a held EOS: the stream started again, a rejoin
    if (r.state == AwState::present) return;
    if (r.state == AwState::absent) r.discont = true;   // a rejoin is placed by PTS
    r.state = AwState::present;
    *pending |= MSG_STATE;
    GST_INFO_OBJECT(self, "input %s present", r.input.c_str());
}

/* Under the lock: a timed arrival into the pace, kept or stale (B-81): what a joiner or a rejoin
 * sends behind the gaps says how late it now is; a backlog's drain the estimator leaves out. */
static void aw_observe(GstMrAlignWatch* self, gint64 now, gint64 lateness, guint* pending) {
    Run& r = *self->run;
    mrts::PaceGroup::Event ev;
    PaceRegistry::global().observe(r.member, now, lateness, !r.pace_run, aw_gapped(r), &ev);
    r.pace_run = true;
    aw_fell(self, ev, pending);
}

/* Under the lock: a stale arrival of an input catching up that ends near the gaps' end. Its next
 * buffer is kept once they stop: it caught up (B-80). Near is its own length during a rise (the
 * gaps go out as data would, so an input at the pace races its own piece by the slack), else
 * CATCH_UP_NS: a joiner that close is waited for rather than slewed to. */
static void aw_caught_up(GstMrAlignWatch* self, bool clocked, gint64 now, gint64 start,
                         gint64 end) {
    Run& r = *self->run;
    if (!r.catching_up || r.state != AwState::present) return;
    const mrts::PaceGroup::Snapshot sn = r.member.snapshot();
    const bool rising = sn.target > sn.pace_at(clocked ? now : -1);
    const gint64 near = rising ? end - start : std::max(end - start, CATCH_UP_NS);
    if (end + near > r.planner.horizon_ns()) r.catching_up = false;
}

/* Under the lock: the first timed item out marks the group running; who joins it later is
 * gapped while it waits (aw_watch). */
static void aw_mark_running(GstMrAlignWatch* self) {
    Run& r = *self->run;
    if (r.ran || !r.planner.has_horizon()) return;
    PaceRegistry::global().start(r.member);
    r.ran = true;
}

/* Under the lock: the sink thread waits in us from `now` (clocked) or not at all. */
static void aw_block_begin(GstMrAlignWatch* self, bool clocked, gint64 now) {
    Run& r = *self->run;
    r.upstream_blocked = true;
    r.blocked_since = clocked ? now : 0;
}

/* Silence counts again: a task with nothing queued slept with no W deadline meanwhile. */
static void aw_block_end(GstMrAlignWatch* self) {
    Run& r = *self->run;
    gint64 now;
    if (r.upstream_blocked && aw_now(self, &now) && r.quiet_started)
        r.held_ns += std::max<gint64>(now - std::max(r.blocked_since, r.quiet_from), 0);
    r.upstream_blocked = false;
    if (r.fifo.empty()) aw_wake(self);
}

/* Data in. Takes `obj` (a buffer, or a list with `is_list`). */
static GstFlowReturn aw_take_data(GstMrAlignWatch* self, GstMiniObject* obj, bool is_list) {
    guint pending = 0;
    GstFlowReturn ret = GST_FLOW_OK;
    Snap snap;
    g_mutex_lock(&self->lock);
    Run& r = *self->run;
    if (self->srcresult != GST_FLOW_OK || r.sink_eos) {
        ret = self->srcresult != GST_FLOW_OK ? self->srcresult : GST_FLOW_EOS;
        g_mutex_unlock(&self->lock);
        gst_mini_object_unref(obj);
        return ret;
    }
    Item it;
    it.kind = is_list ? Kind::list : Kind::buffer;
    it.obj = obj;
    it.timed = is_list ? aw_list_times(&r.in_segment, GST_BUFFER_LIST_CAST(obj), &it.start, &it.end)
                       : aw_buffer_times(&r.in_segment, GST_BUFFER_CAST(obj), &it.start, &it.end);
    gint64 now = 0;
    const bool clocked = aw_now(self, &now);
    if (clocked) {
        if (it.timed) it.lateness = now - it.start;
        aw_arrival(self, now, &pending);
    } else if (r.state != AwState::present) {
        r.state = AwState::present;
        pending |= MSG_STATE;
    }

    if (r.sparse) {
        /* A cue its gaps already passed: forwarded at its own PTS, the pace raised (C-3). */
        if (it.timed && r.planner.stale(it.start, it.end)) {
            it.late = true;
            mrts::PaceGroup::Event ev;
            PaceRegistry::global().raise(r.member, it.lateness, clocked ? now : -1, &ev);
            aw_fell(self, ev, &pending);
        }
        if (clocked && it.timed) aw_observe(self, now, it.lateness, &pending);
    } else if (is_list) {
        /* The only discard (R21): what ends before the horizon, member by member. */
        GstBufferList* l = GST_BUFFER_LIST_CAST(obj);
        const guint n = gst_buffer_list_length(l);
        guint dropped = 0;
        std::vector<std::pair<gint64, gint64>> stale_spans;   // newest first
        for (guint i = n; i-- > 0;) {
            gint64 s, e;
            if (!aw_buffer_times(&r.in_segment, gst_buffer_list_get(l, i), &s, &e) ||
                !r.planner.stale(s, e))
                continue;
            if (!dropped) l = gst_buffer_list_make_writable(l);
            gst_buffer_list_remove(l, i, 1);
            dropped++;
            r.stale_buffers++;
            r.stale_time += (guint64)(e - s);
            stale_spans.emplace_back(s, e);
        }
        /* Observed all the same, oldest first, each at its own lateness (B-81). */
        if (clocked)
            for (auto s = stale_spans.rbegin(); s != stale_spans.rend(); ++s)
                aw_observe(self, now, now - s->first, &pending);
        it.obj = GST_MINI_OBJECT_CAST(l);
        if (dropped) {
            r.discont = true;
            it.timed = aw_list_times(&r.in_segment, l, &it.start, &it.end);
            if (it.timed && clocked) it.lateness = now - it.start;
        }
        if (gst_buffer_list_length(l) == 0) {
            if (!stale_spans.empty())
                aw_caught_up(self, clocked, now, stale_spans.front().first,
                             stale_spans.front().second);
            if (pending) snap = aw_snap(self);
            g_mutex_unlock(&self->lock);
            gst_buffer_list_unref(l);
            aw_post_pending(self, pending, snap);
            return GST_FLOW_OK;
        }
        if (clocked && it.timed) aw_observe(self, now, it.lateness, &pending);
    } else if (it.timed && r.planner.stale(it.start, it.end)) {
        r.stale_buffers++;
        r.stale_time += (guint64)(it.end - it.start);
        r.discont = true;
        GST_LOG_OBJECT(self, "stale buffer [%" G_GINT64_FORMAT ", %" G_GINT64_FORMAT
                       ") before horizon %" G_GINT64_FORMAT ": discarded", it.start, it.end,
                       r.planner.horizon_ns());
        if (clocked) aw_observe(self, now, it.lateness, &pending);   // B-81
        aw_caught_up(self, clocked, now, it.start, it.end);
        if (pending) snap = aw_snap(self);
        g_mutex_unlock(&self->lock);
        gst_mini_object_unref(obj);
        aw_post_pending(self, pending, snap);
        return GST_FLOW_OK;
    } else if (clocked && it.timed) {
        aw_observe(self, now, it.lateness, &pending);
    }
    if (!is_list && it.timed && it.end > it.start) r.unit_ns = it.end - it.start;
    it.bytes = is_list ? gst_buffer_list_calculate_size(GST_BUFFER_LIST_CAST(it.obj))
                       : gst_buffer_get_size(GST_BUFFER_CAST(it.obj));

    /* Full: the upstream thread waits, nothing is dropped; one count per episode (R9). */
    while (aw_full(self) && self->srcresult == GST_FLOW_OK) {
        if (!r.full_episode) {
            r.full_episode = true;
            r.full_count++;
            GST_WARNING_OBJECT(self, "input %s: queue full, upstream held", r.input.c_str());
            snap = aw_snap(self);
            g_mutex_unlock(&self->lock);
            aw_post_pending(self, pending | MSG_FULL, snap);
            pending = 0;
            g_mutex_lock(&self->lock);
            continue;
        }
        gint64 t = 0;
        const bool c = aw_now(self, &t);
        aw_block_begin(self, c, t);
        g_cond_wait(&self->item_removed, &self->lock);
        aw_block_end(self);
    }
    if (self->srcresult != GST_FLOW_OK) {
        ret = self->srcresult;
        g_mutex_unlock(&self->lock);
        gst_mini_object_unref(it.obj);
        return ret;
    }
    /* The armed check's pace as of now: a full queue may have held us since the arrival. */
    gint64 t = now;
    const bool c = clocked && aw_now(self, &t);
    aw_enqueue(self, std::move(it), aw_pace(self, c, t, &pending));
    if (pending) snap = aw_snap(self);
    g_mutex_unlock(&self->lock);
    if (pending) aw_post_pending(self, pending, snap);
    return GST_FLOW_OK;
}

static GstFlowReturn aw_chain(GstPad*, GstObject* parent, GstBuffer* buf) {
    return aw_take_data(GST_MRALIGNWATCH(parent), GST_MINI_OBJECT_CAST(buf), false);
}

static GstFlowReturn aw_chain_list(GstPad*, GstObject* parent, GstBufferList* list) {
    return aw_take_data(GST_MRALIGNWATCH(parent), GST_MINI_OBJECT_CAST(list), true);
}

/* --- sink events and queries ------------------------------------------------------------ */

/* A serialized event, in order through the FIFO. Takes `event`. */
static gboolean aw_take_event(GstMrAlignWatch* self, GstEvent* event) {
    guint pending = 0;
    Snap snap;
    g_mutex_lock(&self->lock);
    Run& r = *self->run;
    const GstEventType type = GST_EVENT_TYPE(event);
    if (self->srcresult == GST_FLOW_FLUSHING) {
        g_mutex_unlock(&self->lock);
        if (GST_EVENT_IS_STICKY(event)) gst_pad_store_sticky_event(self->srcpad, event);
        gst_event_unref(event);
        return FALSE;
    }
    /* As GstQueue: a new stream or segment after downstream's EOS restarts the task; else a
     * failed downstream refuses what is not sticky, and any EOS. */
    if ((type == GST_EVENT_STREAM_START || type == GST_EVENT_SEGMENT) &&
        self->srcresult == GST_FLOW_EOS) {
        self->srcresult = GST_FLOW_OK;
        if (gst_pad_is_active(self->srcpad))
            gst_pad_start_task(self->srcpad, aw_loop, self, NULL);
    }
    if (self->srcresult != GST_FLOW_OK && (!GST_EVENT_IS_STICKY(event) || type == GST_EVENT_EOS)) {
        g_mutex_unlock(&self->lock);
        gst_event_unref(event);
        return FALSE;
    }
    if (r.sink_eos && type != GST_EVENT_STREAM_START && type != GST_EVENT_SEGMENT) {
        g_mutex_unlock(&self->lock);
        gst_event_unref(event);
        return FALSE;
    }
    Item it;
    it.kind = Kind::event;
    it.obj = GST_MINI_OBJECT_CAST(event);
    gint64 pace = 0;   // a GAP's, for the armed check
    switch (type) {
        case GST_EVENT_STREAM_START:
        case GST_EVENT_SEGMENT:
            r.sink_eos = false;
            if (type == GST_EVENT_SEGMENT) gst_event_copy_segment(event, &r.in_segment);
            else r.pace_run = false;   // a new stream: no stretch reaches back past it
            break;
        case GST_EVENT_EOS:
            r.sink_eos = true;
            break;
        case GST_EVENT_GAP: {
            /* An arrival. Sparse: tsdemux's own GAPs are not on content time, dropped. */
            GstClockTime ts, dur;
            gst_event_parse_gap(event, &ts, &dur);
            gint64 now = 0;
            const bool clocked = aw_now(self, &now);
            GstClockTime rt = GST_CLOCK_TIME_NONE;
            if (r.in_segment.format == GST_FORMAT_TIME && GST_CLOCK_TIME_IS_VALID(ts))
                rt = gst_segment_to_running_time(&r.in_segment, GST_FORMAT_TIME, ts);
            it.timed = GST_CLOCK_TIME_IS_VALID(rt);
            if (it.timed) {
                it.start = (gint64)rt;
                it.end = it.start + (GST_CLOCK_TIME_IS_VALID(dur) ? (gint64)dur : 0);
                it.lateness = now - it.end;   // the gap's end: when what follows is due
            }
            if (clocked) aw_arrival(self, now, &pending);
            if (r.sparse) {
                if (pending) snap = aw_snap(self);
                g_mutex_unlock(&self->lock);
                gst_event_unref(event);
                if (pending) aw_post_pending(self, pending, snap);
                return TRUE;
            }
            /* Observed even if all of it went by already, though its release clips it away. */
            if (clocked && it.timed) aw_observe(self, now, it.lateness, &pending);
            pace = aw_pace(self, clocked, now, &pending);
            break;
        }
        default:
            break;
    }
    aw_enqueue(self, std::move(it), pace);
    if (pending) snap = aw_snap(self);
    g_mutex_unlock(&self->lock);
    if (pending) aw_post_pending(self, pending, snap);
    return TRUE;
}

static gboolean aw_sink_event(GstPad* pad, GstObject* parent, GstEvent* event) {
    GstMrAlignWatch* self = GST_MRALIGNWATCH(parent);
    switch (GST_EVENT_TYPE(event)) {
        case GST_EVENT_FLUSH_START: {
            /* Downstream first, so a push blocked in the aggregator returns. */
            const gboolean ret = gst_pad_push_event(self->srcpad, event);
            g_mutex_lock(&self->lock);
            self->srcresult = GST_FLOW_FLUSHING;
            aw_wake(self);
            g_cond_broadcast(&self->item_removed);
            g_mutex_unlock(&self->lock);
            gst_pad_pause_task(self->srcpad);
            return ret;
        }
        case GST_EVENT_FLUSH_STOP: {
            const gboolean ret = gst_pad_push_event(self->srcpad, event);
            g_mutex_lock(&self->lock);
            Run& r = *self->run;
            aw_flush_fifo(self);
            /* Nothing before the flush joins what follows; a held EOS ends (FLUSH or NULL). */
            r.planner.reset();
            r.sink_eos = r.eos_out = r.eos_held = false;
            r.discont = r.primed = r.caps_primed = false;
            r.catching_up = false;   // nothing is stale after a flush
            r.pace_run = false;
            r.quiet_started = false;
            if (r.state == AwState::absent) r.state = AwState::waiting;
            gst_segment_init(&r.in_segment, GST_FORMAT_UNDEFINED);
            self->srcresult = GST_FLOW_OK;
            if (gst_pad_is_active(self->srcpad))
                gst_pad_start_task(self->srcpad, aw_loop, self, NULL);
            g_mutex_unlock(&self->lock);
            return ret;
        }
        default:
            if (GST_EVENT_IS_SERIALIZED(event)) return aw_take_event(self, event);
            return gst_pad_event_default(pad, parent, event);
    }
}

static gboolean aw_sink_query(GstPad* pad, GstObject* parent, GstQuery* query) {
    GstMrAlignWatch* self = GST_MRALIGNWATCH(parent);
    if (!GST_QUERY_IS_SERIALIZED(query)) return gst_pad_query_default(pad, parent, query);
    /* In order, like GstQueue: the src task answers it from downstream after what precedes. */
    QueryWait wait;
    g_mutex_lock(&self->lock);
    if (self->srcresult != GST_FLOW_OK) {
        g_mutex_unlock(&self->lock);
        return FALSE;
    }
    Item it;
    it.kind = Kind::query;
    it.obj = GST_MINI_OBJECT_CAST(query);
    it.wait = &wait;
    aw_enqueue(self, std::move(it), 0);
    gint64 t = 0;
    const bool c = aw_now(self, &t);
    aw_block_begin(self, c, t);
    while (!wait.done) g_cond_wait(&self->item_removed, &self->lock);
    aw_block_end(self);
    g_mutex_unlock(&self->lock);
    return wait.res;
}

/* --- src -------------------------------------------------------------------------------- */

/* The aggregator must never see a live input (WI-P2-1 F4): answered, not forwarded. */
static gboolean aw_src_query(GstPad* pad, GstObject* parent, GstQuery* query) {
    if (GST_QUERY_TYPE(query) == GST_QUERY_LATENCY) {
        gst_query_set_latency(query, FALSE, 0, GST_CLOCK_TIME_NONE);
        return TRUE;
    }
    return gst_pad_query_default(pad, parent, query);
}

/* The gaps' caps for an input that sent none: upstream's when fixed, whatever the media; raw
 * audio fixated, above 2 channels unpositioned (as wide 302M decodes) unless upstream fixes the
 * mask: an audio aggregator refuses a wide pad without one. NULL: none, mpegtsmux takes that. */
static GstCaps* aw_gap_caps(GstCaps* up) {
    if (gst_caps_is_empty(up) || gst_caps_is_any(up)) return NULL;
    const GstStructure* s0 = gst_caps_get_structure(up, 0);
    if (!gst_structure_has_name(s0, "audio/x-raw"))
        return gst_caps_is_fixed(up) ? gst_caps_copy(up) : NULL;
    const GValue* mask = gst_structure_get_value(s0, "channel-mask");
    const bool mask_fixed = mask && gst_value_is_fixed(mask);
    GstCaps* caps = gst_caps_fixate(gst_caps_copy_nth(up, 0));
    GstStructure* s = gst_caps_get_structure(caps, 0);
    gint channels = 0;
    if (!mask_fixed && gst_structure_get_int(s, "channels", &channels) && channels > 2)
        gst_structure_set(s, "channel-mask", GST_TYPE_BITMASK, (guint64)0, NULL);
    return caps;
}

/* Before the first gap of an input that never sent them: a stream, caps when they can be known
 * (an audio aggregator refuses a pad without caps) and a TIME segment, so the aggregator takes
 * the gap. */
static void aw_prime_src(GstMrAlignWatch* self) {
    GstEvent* ev = gst_pad_get_sticky_event(self->srcpad, GST_EVENT_STREAM_START, 0);
    if (ev) {
        gst_event_unref(ev);
    } else {
        gchar* id = gst_pad_create_stream_id(self->srcpad, GST_ELEMENT_CAST(self), "gap");
        ev = gst_event_new_stream_start(id);
        gst_event_set_group_id(ev, gst_util_group_id_next());
        g_free(id);
        gst_pad_push_event(self->srcpad, ev);
    }
    if (!gst_pad_has_current_caps(self->srcpad)) {
        GstCaps* down = gst_pad_peer_query_caps(self->srcpad, NULL);
        GstCaps* up = gst_pad_peer_query_caps(self->sinkpad, down);
        if (GstCaps* caps = aw_gap_caps(up)) {
            GST_INFO_OBJECT(self, "no caps from upstream: gaps under %" GST_PTR_FORMAT, caps);
            gst_pad_push_event(self->srcpad, gst_event_new_caps(caps));
            gst_caps_unref(caps);
            self->run->caps_primed = true;
        }
        gst_caps_unref(up);
        gst_caps_unref(down);
    }
    ev = gst_pad_get_sticky_event(self->srcpad, GST_EVENT_SEGMENT, 0);
    if (ev) {
        gst_event_unref(ev);
    } else {
        GstSegment seg;
        gst_segment_init(&seg, GST_FORMAT_TIME);
        gst_pad_push_event(self->srcpad, gst_event_new_segment(&seg));
    }
}

/* The element our src pad feeds, through ghost pads (a live branch's bin); NULL: unlinked. */
static GstElement* aw_downstream(GstMrAlignWatch* self) {
    GstPad* pad = gst_pad_get_peer(self->srcpad);
    for (int hop = 0; pad && hop < 16; hop++) {
        GstPad* next = NULL;
        if (GST_IS_GHOST_PAD(pad)) {   // a bin's sink: what it targets inside
            next = gst_ghost_pad_get_target(GST_GHOST_PAD(pad));
        } else if (GST_IS_PROXY_PAD(pad)) {   // the inside of a bin's src: what that feeds
            if (GstProxyPad* ghost = gst_proxy_pad_get_internal(GST_PROXY_PAD(pad))) {
                next = gst_pad_get_peer(GST_PAD(ghost));
                gst_object_unref(ghost);
            }
        } else {
            GstElement* el = gst_pad_get_parent_element(pad);
            gst_object_unref(pad);
            return el;
        }
        gst_object_unref(pad);
        pad = next;
    }
    if (pad) gst_object_unref(pad);
    return NULL;
}

/* Task thread, not under the lock: what the src pad feeds, learnt once it feeds something. */
static void aw_learn_downstream(GstMrAlignWatch* self) {
    Run& r = *self->run;
    if (r.down != Run::Down::unknown) return;
    GstElement* el = aw_downstream(self);
    if (!el) return;
    if (GST_IS_AUDIO_AGGREGATOR(el)) {
        guint64 block = 0;
        g_object_get(el, "output-buffer-duration", &block, NULL);
        r.block_ns = std::max<gint64>(block ? (gint64)block : DEFAULT_AUDIO_BLOCK, GST_MSECOND);
        r.down = Run::Down::audio;
    } else {
        r.down = Run::Down::other;
    }
    GST_DEBUG_OBJECT(self, "feeds %s%s", GST_ELEMENT_NAME(el),
                     r.down == Run::Down::audio ? ", an audio aggregator" : "");
    gst_object_unref(el);
}

/* The segment downstream holds, to place running times; false when none is TIME. */
static bool aw_out_segment(GstMrAlignWatch* self, GstSegment* seg) {
    GstEvent* ev = gst_pad_get_sticky_event(self->srcpad, GST_EVENT_SEGMENT, 0);
    if (!ev) return false;
    gst_event_copy_segment(ev, seg);
    gst_event_unref(ev);
    return seg->format == GST_FORMAT_TIME;
}

/* [start, end) of running time as GAPs; a refused one is no fault (a flush stops the task by
 * itself). An aggregator takes a GAP at its start (WI-P2-1 F2): toward an audio one, pieces of at
 * most its block; elsewhere one GAP and a zero-length one at its end, which carries it there. */
static void aw_push_gap(GstMrAlignWatch* self, gint64 start, gint64 end) {
    if (!self->run->primed) {   // once per stream: the caps queries are not free
        aw_prime_src(self);
        self->run->primed = true;
    }
    GstSegment seg;
    if (!aw_out_segment(self, &seg)) return;
    const Run& r = *self->run;
    /* A fence would cost an audio aggregator one more block (WI-P2-14 F1); past a second (a
     * content jump), that block costs less than a GAP per block. */
    const bool pieces = r.down == Run::Down::audio && end - start <= PIECED_MAX_NS;
    for (gint64 a = start;;) {
        const gint64 b = pieces ? std::min(end, a + r.block_ns) : end;
        const guint64 s = gst_segment_position_from_running_time(&seg, GST_FORMAT_TIME, a);
        const guint64 e = gst_segment_position_from_running_time(&seg, GST_FORMAT_TIME, b);
        if (!GST_CLOCK_TIME_IS_VALID(s) || !GST_CLOCK_TIME_IS_VALID(e) || e < s) return;
        if (e > s) gst_pad_push_event(self->srcpad, gst_event_new_gap(s, e - s));
        if (!pieces) gst_pad_push_event(self->srcpad, gst_event_new_gap(e, 0));
        if (b >= end) return;
        a = b;
    }
}

/* A flow return of a push, under the lock: anything but OK stops the task. */
static void aw_flow(GstMrAlignWatch* self, GstFlowReturn ret) {
    if (ret == GST_FLOW_OK) return;
    if (self->srcresult == GST_FLOW_OK) self->srcresult = ret;
    g_cond_broadcast(&self->item_removed);
}

/* Not under the lock: a data item out, DISCONT on its first buffer when asked. */
static GstFlowReturn aw_push_data(GstMrAlignWatch* self, Item& it, bool discont) {
    if (it.kind == Kind::buffer) {
        GstBuffer* b = GST_BUFFER_CAST(it.obj);
        if (discont) {
            b = gst_buffer_make_writable(b);
            GST_BUFFER_FLAG_SET(b, GST_BUFFER_FLAG_DISCONT);
        }
        return gst_pad_push(self->srcpad, b);
    }
    GstBufferList* l = GST_BUFFER_LIST_CAST(it.obj);
    if (discont && gst_buffer_list_length(l) > 0) {
        l = gst_buffer_list_make_writable(l);
        GstBuffer* b = gst_buffer_list_get_writable(l, 0);
        GST_BUFFER_FLAG_SET(b, GST_BUFFER_FLAG_DISCONT);
    }
    return gst_pad_push_list(self->srcpad, l);
}

/* Not under the lock: the CAPS event's caps are those already on the src pad. */
static bool aw_caps_current(GstMrAlignWatch* self, GstEvent* ev) {
    GstCaps* caps = NULL;
    gst_event_parse_caps(ev, &caps);
    GstCaps* cur = gst_pad_get_current_caps(self->srcpad);
    const bool same = cur && caps && gst_caps_is_equal(cur, caps);
    if (cur) gst_caps_unref(cur);
    return same;
}

/* Under the lock, back under it: the head item out. Data that ends before the horizon is
 * discarded (or, sparse, forwarded with a message); a GAP is clipped to the horizon. */
static void aw_release(GstMrAlignWatch* self, gint64 now, bool clocked, guint* pending,
                       Snap* late_snap, LateCue* late_cue) {
    Run& r = *self->run;
    Item it = std::move(r.fifo.front());
    r.fifo.pop_front();
    aw_dequeued(self, it);

    if (it.kind == Kind::query) {
        QueryWait* w = it.wait;
        g_mutex_unlock(&self->lock);
        const bool res = gst_pad_peer_query(self->srcpad, GST_QUERY_CAST(it.obj));
        g_mutex_lock(&self->lock);
        w->res = res;
        w->done = true;
        g_cond_broadcast(&self->item_removed);
        return;
    }

    if (it.kind == Kind::event) {
        GstEvent* ev = GST_EVENT_CAST(it.obj);
        switch (GST_EVENT_TYPE(ev)) {
            case GST_EVENT_GAP: {
                if (!it.timed) {   // no place on the timeline: as it came
                    g_mutex_unlock(&self->lock);
                    gst_pad_push_event(self->srcpad, ev);
                    g_mutex_lock(&self->lock);
                    return;
                }
                const bool h = r.planner.has_horizon();
                if (h && it.end <= r.planner.horizon_ns()) {   // all of it already passed
                    gst_event_unref(ev);
                    return;
                }
                const gint64 start = h ? std::max(it.start, r.planner.horizon_ns()) : it.start;
                r.planner.emitted(it.end);
                r.gaps++;
                r.discont = true;
                g_mutex_unlock(&self->lock);
                gst_event_unref(ev);
                aw_push_gap(self, start, it.end);
                g_mutex_lock(&self->lock);
                return;
            }
            case GST_EVENT_EOS:
                if (r.hold_on_eos) {
                    /* Absence until FLUSH or NULL: the aggregator keeps waiting on gaps. */
                    gst_event_unref(ev);
                    r.eos_held = true;
                    r.catching_up = true;
                    r.pace_run = false;
                    if (r.state != AwState::absent) {
                        r.state = AwState::absent;
                        r.absences++;
                        *pending |= MSG_STATE;
                    }
                    GST_INFO_OBJECT(self, "input %s: EOS held as absence", r.input.c_str());
                    return;
                }
                r.eos_out = true;
                break;
            case GST_EVENT_STREAM_START:
                r.eos_out = r.eos_held = false;
                break;
            case GST_EVENT_CAPS:
                if (r.caps_primed) {
                    /* The first caps after primed ones go only if they differ: on a pad with a
                     * stream, mpegtsmux answers a CAPS by resending PAT and PMT. */
                    r.caps_primed = false;
                    g_mutex_unlock(&self->lock);
                    if (aw_caps_current(self, ev))
                        gst_event_unref(ev);
                    else
                        gst_pad_push_event(self->srcpad, ev);
                    g_mutex_lock(&self->lock);
                    return;
                }
                break;
            default:
                break;
        }
        g_mutex_unlock(&self->lock);
        gst_pad_push_event(self->srcpad, ev);
        g_mutex_lock(&self->lock);
        return;
    }

    if (it.timed && r.planner.stale(it.start, it.end) && !r.sparse) {
        r.stale_buffers +=
            it.kind == Kind::list ? gst_buffer_list_length(GST_BUFFER_LIST_CAST(it.obj)) : 1;
        r.stale_time += (guint64)(it.end - it.start);
        r.discont = true;
        gst_mini_object_unref(it.obj);
        return;
    }
    const bool late = r.sparse && it.timed && (it.late || r.planner.stale(it.start, it.end));
    if (late) {
        if (!it.late) {
            mrts::PaceGroup::Event ev;
            PaceRegistry::global().raise(r.member, it.lateness, clocked ? now : -1, &ev);
            aw_fell(self, ev, pending);
        }
        *late_snap = aw_snap(self);
        late_cue->set = true;
        late_cue->start = it.start;
        late_cue->lateness = it.lateness;
        late_cue->behind = r.planner.horizon_ns() - it.end;
        GST_WARNING_OBJECT(self, "input %s: cue %" G_GINT64_FORMAT " ns behind the gaps, "
                           "forwarded at its own PTS", r.input.c_str(),
                           r.planner.horizon_ns() - it.end);
    }
    if (it.timed) {
        r.planner.emitted(it.end);
        /* Kept timed data from a present input: caught up, its gaps end (B-80). What an absent
         * one still had queued is no catch-up. */
        if (r.state != AwState::absent) r.catching_up = false;
    }
    /* It came ahead of its release by more than the slack: the next is armed for (B-79). */
    r.ahead = it.timed && it.end > it.start && it.lateness < r.pace - RELEASE_SLACK_NS;
    const bool discont = r.discont;
    r.discont = false;
    gint64 t0 = now;
    g_mutex_unlock(&self->lock);
    const GstFlowReturn ret = aw_push_data(self, it, discont);
    g_mutex_lock(&self->lock);
    /* Blocked in the push is not silence: the time counts as held. */
    gint64 t1;
    if (clocked && aw_now(self, &t1) && r.quiet_started)
        r.held_ns += std::max<gint64>(t1 - std::max(t0, r.quiet_from), 0);
    if (ret != GST_FLOW_OK) {
        GST_DEBUG_OBJECT(self, "push: %s", gst_flow_get_name(ret));
        if (ret < GST_FLOW_EOS && ret != GST_FLOW_FLUSHING && ret != GST_FLOW_NOT_LINKED) {
            g_mutex_unlock(&self->lock);
            GST_ELEMENT_FLOW_ERROR(self, ret);
            gst_pad_push_event(self->srcpad, gst_event_new_eos());
            g_mutex_lock(&self->lock);
        }
        aw_flow(self, ret);
    }
}

/* Under the lock, clocked: the 1 s report, checked on every pass of the task and after every
 * release (an input held by a paced output releases on within one pass). */
static void aw_report(GstMrAlignWatch* self, gint64 now, guint* pending) {
    Run& r = *self->run;
    if (!r.report_started) {
        r.report_started = true;
        r.report_at = now;
    } else if (now - r.report_at >= REPORT_NS) {
        *pending |= MSG_INTERVAL;
        r.report_at = now;
    }
}

/* Under the lock: the input is gapped, being sparse, absent, held at EOS or catching up after a
 * late join or a rejoin (B-80), so the others never stall on it. */
static bool aw_gapped(const Run& r) {
    if (r.eos_out) return false;
    return r.sparse || r.eos_held || r.catching_up || r.state == AwState::absent;
}

/* Gaps toward an audio aggregator go as the data would (WI-P2-14 F1). */
static bool aw_paced_gaps(const Run& r) {
    return r.down == Run::Down::audio && !r.sparse;
}

/* Such a gap's piece: the input's last buffer length, the aggregator's block at least (B-79). */
static gint64 aw_piece(const Run& r) {
    return std::max(r.unit_ns, r.block_ns);
}

/* Under the lock: the first timed item queued, which no gap may pass. */
static const Item* aw_next_timed(const Run& r) {
    for (const Item& it : r.fifo)
        if (it.timed) return &it;
    return nullptr;
}

/* Under the lock: silence can make the input absent. An input whose EOS is queued ended, it is
 * not silent; a held EOS turns absent on its pop. */
static bool aw_silence_counts(const Run& r) {
    return !r.eos_out && !r.sparse && !r.eos_held && !r.sink_eos && r.state != AwState::absent;
}

/* Under the lock, clocked: silence -> absent; the gap due now, to push out of the lock: toward
 * an audio aggregator a piece of the input's buffer length (the aggregator's block at least) at
 * its start + pace, else to now - pace. */
static bool aw_watch(GstMrAlignWatch* self, gint64 now, guint* pending,
                     mrts::GapPlanner::Gap* gap) {
    Run& r = *self->run;
    if (!r.quiet_started) {   // the first pass of a run: silence counts from here
        r.quiet_started = true;
        r.quiet_from = now;
        r.held_ns = 0;
    }
    if (r.eos_out) return false;
    if (aw_silence_counts(r)) {
        gint64 held = r.held_ns;
        if (r.upstream_blocked)
            held += std::max<gint64>(now - std::max(r.blocked_since, r.quiet_from), 0);
        const gint64 silent = now - r.quiet_from - held;
        const gint64 w = silent >= aw_limit_floor(self) ? aw_limit(self) : G_MAXINT64;
        if (silent >= w) {
            r.state = AwState::absent;
            r.catching_up = true;
            r.pace_run = false;
            r.absences++;
            *pending |= MSG_STATE;
            GST_INFO_OBJECT(self, "input %s absent: silent %" G_GINT64_FORMAT " ms, W %"
                            G_GINT64_FORMAT " ms", r.input.c_str(), silent / GST_MSECOND,
                            w / GST_MSECOND);
        }
    }
    if (!aw_gapped(r)) return false;
    const Item* next = aw_next_timed(r);
    const gint64 next_start = next ? next->start : 0;
    const gint64* nx = next ? &next_start : nullptr;
    /* A piece due within the slack goes now, as data does. */
    if (!(aw_paced_gaps(r)
              ? r.planner.take_piece(now + RELEASE_SLACK_NS, r.pace, aw_piece(r), nx, gap)
              : r.planner.take(now, r.pace, nx, gap)))
        return false;
    if (gap->end_ns > gap->start_ns) r.gaps++;
    r.discont = true;
    return true;
}

/* Under the lock, clocked: when the task must next run, the earliest of what can come due:
 * the head's release, the next paced gap piece, the W deadline while silence counts, the tick
 * while gapped otherwise, the next report; and, for an input held behind the pace, the release
 * of the data that continues it. An arrival due before that wakes it earlier (aw_enqueue). */
static gint64 aw_deadline(GstMrAlignWatch* self, gint64 now) {
    const Run& r = *self->run;
    gint64 at = r.report_at + REPORT_NS;
    if (!r.fifo.empty()) {
        const Item& h = r.fifo.front();
        if (!h.timed) return now;   // it came in while we posted: due at once
        at = std::min(at, h.start + r.pace - RELEASE_SLACK_NS);
    }
    /* Silence stops while the sink thread is held in us; its unblock wakes us (aw_block_end).
     * W not taken since the last arrival: its least, where aw_watch takes it. */
    if (aw_silence_counts(r) && r.quiet_started && !r.upstream_blocked)
        at = std::min(at, r.quiet_from + r.held_ns +
                              (r.limit_stale ? aw_limit_floor(self) : r.silence_limit));
    /* Held behind the pace, the next buffer's release is armed: its arrival need not wake us,
     * so a held input's task runs once a buffer, as a queue's does. */
    if (r.fifo.empty() && r.ahead && aw_silence_counts(r) && !aw_gapped(r) &&
        r.planner.has_horizon()) {
        const gint64 next = r.planner.horizon_ns() + r.pace - RELEASE_SLACK_NS;
        if (next > now) at = std::min(at, next);
    }
    if (aw_gapped(r)) {
        if (!aw_paced_gaps(r)) {
            at = std::min(at, now + (gint64)self->tick.load(std::memory_order_relaxed));
        } else {
            const gint64 h = r.planner.has_horizon() ? r.planner.horizon_ns() : 0;
            const Item* next = aw_next_timed(r);
            if (!next || next->start > h) at = std::min(at, h + r.pace - RELEASE_SLACK_NS);
        }
    }
    /* From then on time alone may lower the pace (a rotation, a skip): the group ticks (B-82). */
    if (r.member.member) at = std::min(at, r.snap.next_at);
    return at;
}

/* Under the lock, back under it: a state change is news now, not after the sleep. */
static void aw_post_now(GstMrAlignWatch* self, guint* pending) {
    if (!*pending) return;
    const Snap snap = aw_snap(self);
    const guint p = *pending;
    *pending = 0;
    g_mutex_unlock(&self->lock);
    aw_post_pending(self, p, snap);
    g_mutex_lock(&self->lock);
}

/* Under the lock: the task's sleep to `deadline` on its one clock id, re-armed. */
static void aw_sleep(GstMrAlignWatch* self, gint64 deadline) {
    Run& r = *self->run;
    const GstClockTime at = (GstClockTime)(r.base + std::max<gint64>(deadline, 0));
    if (!r.clock_id || r.id_clock != r.clock ||
        !gst_clock_single_shot_id_reinit(r.clock, r.clock_id, at)) {
        if (r.clock_id) gst_clock_id_unref(r.clock_id);
        r.clock_id = gst_clock_new_single_shot_id(r.clock, at);
        r.id_clock = r.clock;
    }
    GstClockID id = r.clock_id;
    r.sleeping = true;
    r.wake_at = deadline;
    g_mutex_unlock(&self->lock);
    gst_clock_id_wait(id, NULL);
    g_mutex_lock(&self->lock);
    r.sleeping = false;
}

/* One pass a wake: what is due goes, then the task sleeps to the next thing that can come due
 * (aw_deadline). */
static void aw_loop(gpointer data) {
    GstMrAlignWatch* self = GST_MRALIGNWATCH(data);
    guint pending = 0;
    aw_learn_downstream(self);
    g_mutex_lock(&self->lock);
    Run& r = *self->run;
    r.passes++;
    if (self->srcresult != GST_FLOW_OK) {
        g_mutex_unlock(&self->lock);
        gst_pad_pause_task(self->srcpad);
        return;
    }
    gint64 now = 0;
    bool clocked = aw_now(self, &now);
    r.pace = aw_pace(self, clocked, now, &pending);
    if (clocked) aw_report(self, now, &pending);

    /* Every head due: untimed at once, timed within the slack of start + pace. Not PLAYING (no
     * clock): at once, as from a queue, so a non-live upstream can preroll. */
    while (self->srcresult == GST_FLOW_OK && !r.fifo.empty()) {
        const Item& h = r.fifo.front();
        if (h.timed && clocked && now < h.start + r.pace - RELEASE_SLACK_NS) break;
        Snap late_snap;
        LateCue late;
        aw_release(self, now, clocked, &pending, &late_snap, &late);
        aw_mark_running(self);
        clocked = aw_now(self, &now);   // time passed in the push, and PLAYING may have come
        r.pace = aw_pace(self, clocked, now, &pending);
        if (late.set) {
            g_mutex_unlock(&self->lock);
            GstStructure* st = aw_message_structure(late_snap, "late-cue");
            gst_structure_set(st, "cue-start", G_TYPE_INT64, late.start, "cue-lateness",
                              G_TYPE_INT64, late.lateness, "cue-behind", G_TYPE_INT64,
                              late.behind, NULL);
            aw_post(self, st);
            g_mutex_lock(&self->lock);
        }
        /* An output that paces us keeps data due: one pass releases on, and reports. */
        if (clocked) aw_report(self, now, &pending);
        aw_post_now(self, &pending);
    }

    if (self->srcresult == GST_FLOW_OK && clocked) {
        mrts::GapPlanner::Gap gap{};
        /* Paced gaps: every piece due by now (a late pass catches up); else one gap a tick. */
        while (self->srcresult == GST_FLOW_OK && aw_watch(self, now, &pending, &gap)) {
            g_mutex_unlock(&self->lock);
            aw_push_gap(self, gap.start_ns, gap.end_ns);
            g_mutex_lock(&self->lock);
            aw_mark_running(self);
            if (!aw_paced_gaps(r)) break;
        }
    }
    aw_post_now(self, &pending);

    /* The clock again, under the lock the wait releases: PLAYING may have come while a push
     * held it off, and its wake found no wait (then the next pass runs at once, clocked). */
    gint64 t = 0;
    const bool clocked_now = aw_now(self, &t);
    if (self->srcresult == GST_FLOW_OK) {
        if (clocked && clocked_now) {
            aw_sleep(self, aw_deadline(self, now));
        } else if (!clocked_now && r.fifo.empty()) {
            /* Nothing to watch before PLAYING: an item, PLAYING or a flush wakes it. */
            r.cond_waiting = true;
            g_cond_wait(&self->item_added, &self->lock);
            r.cond_waiting = false;
        }
    }
    g_mutex_unlock(&self->lock);
}

static gboolean aw_src_activate_mode(GstPad* pad, GstObject* parent, GstPadMode mode,
                                     gboolean active) {
    GstMrAlignWatch* self = GST_MRALIGNWATCH(parent);
    if (mode != GST_PAD_MODE_PUSH) return FALSE;
    if (active) {
        g_mutex_lock(&self->lock);
        self->srcresult = GST_FLOW_OK;
        g_mutex_unlock(&self->lock);
        return gst_pad_start_task(pad, aw_loop, self, NULL);
    }
    g_mutex_lock(&self->lock);
    self->srcresult = GST_FLOW_FLUSHING;
    aw_wake(self);
    g_cond_broadcast(&self->item_removed);
    g_mutex_unlock(&self->lock);
    return gst_pad_stop_task(pad);
}

static gboolean aw_sink_activate_mode(GstPad*, GstObject* parent, GstPadMode mode,
                                      gboolean active) {
    GstMrAlignWatch* self = GST_MRALIGNWATCH(parent);
    if (mode != GST_PAD_MODE_PUSH) return FALSE;
    g_mutex_lock(&self->lock);
    if (active) {
        self->srcresult = GST_FLOW_OK;
    } else {
        /* The src task has stopped (src pads go first): a blocked chain or query wakes. */
        self->srcresult = GST_FLOW_FLUSHING;
        aw_flush_fifo(self);
    }
    g_mutex_unlock(&self->lock);
    return TRUE;
}

/* --- GObject ---------------------------------------------------------------------------- */

/* The pace group's key: the pipeline (the topmost bin) and `aligner`; none: a group of one. */
static std::string aw_group_key(GstMrAlignWatch* self, const gchar* aligner) {
    GstObject* top = GST_OBJECT_CAST(gst_object_ref(self));
    while (GstObject* p = gst_object_get_parent(top)) {
        gst_object_unref(top);
        top = p;
    }
    char buf[64];
    std::snprintf(buf, sizeof buf, "%p/", (void*)top);
    gst_object_unref(top);
    std::string key = buf;
    if (aligner && *aligner) return key + aligner;
    std::snprintf(buf, sizeof buf, "#%p", (void*)self);
    return key + buf;
}

/* Running time from the clock and base time a running bin gave a live add; -1 without them (a
 * pipeline's own start, where nothing is paced yet). */
static gint64 aw_join_time(GstMrAlignWatch* self) {
    GstClock* clock = gst_element_get_clock(GST_ELEMENT_CAST(self));
    if (!clock) return -1;
    const GstClockTime t = gst_clock_get_time(clock);
    const GstClockTime base = gst_element_get_base_time(GST_ELEMENT_CAST(self));
    gst_object_unref(clock);
    if (!GST_CLOCK_TIME_IS_VALID(t) || !GST_CLOCK_TIME_IS_VALID(base) || t < base) return -1;
    return (gint64)(t - base);
}

static void aw_start(GstMrAlignWatch* self) {
    GST_OBJECT_LOCK(self);
    const std::string aligner = self->aligner ? self->aligner : "";
    const std::string input = self->input ? self->input : "";
    const bool sparse = self->sparse, hold = self->hold_on_eos;
    const gint64 seed = self->seed_lateness;
    const guint64 fall_after = self->fall_after;
    GST_OBJECT_UNLOCK(self);
    const std::string key = aw_group_key(self, aligner.c_str());
    const gint64 now = aw_join_time(self);
    g_mutex_lock(&self->lock);
    Run* r = self->run;
    aw_flush_fifo(self);
    PaceRegistry::global().leave(&r->member);
    aw_drop_clock(*r);
    r->~Run();
    new (r) Run();
    r->aligner = aligner;
    r->input = input;
    r->sparse = sparse;
    r->hold_on_eos = hold;
    gst_segment_init(&r->in_segment, GST_FORMAT_UNDEFINED);
    /* A seed into a running group slews from now; a late joiner catches up (B-80). */
    r->member = PaceRegistry::global().join(key, seed, (int64_t)fall_after, now);
    r->catching_up = r->member.late;
    r->fall_after = r->member.group ? (guint64)r->member.group->fall_after() : fall_after;
    r->state = AwState::waiting;
    const guint64 group_fall_after = r->fall_after;
    g_mutex_unlock(&self->lock);
    self->common.reset();
    GST_DEBUG_OBJECT(self, "joined pace group %s (seed %" G_GINT64_FORMAT ")", key.c_str(), seed);
    if (group_fall_after != fall_after)
        GST_DEBUG_OBJECT(self, "fall-after %" G_GUINT64_FORMAT " ns ignored: the group's is %"
                         G_GUINT64_FORMAT, fall_after, group_fall_after);
}

/* Leaving the group recomputes its target from the members that remain (part 4.3, B-82). */
static void aw_stop(GstMrAlignWatch* self) {
    g_mutex_lock(&self->lock);
    Run& r = *self->run;
    aw_flush_fifo(self);
    gint64 now = -1;
    if (r.clock) {
        const GstClockTime t = gst_clock_get_time(r.clock);
        if (GST_CLOCK_TIME_IS_VALID(t) && (gint64)t >= r.base) now = (gint64)t - r.base;
    }
    PaceRegistry::global().leave(&r.member, now);
    aw_drop_clock(r);
    g_mutex_unlock(&self->lock);
}

/* The clock as the pipeline sets it, a new one while playing too: the task re-arms on it. */
static gboolean aw_set_clock(GstElement* element, GstClock* clock) {
    GstMrAlignWatch* self = GST_MRALIGNWATCH(element);
    const gboolean ret =
        GST_ELEMENT_CLASS(gst_mralignwatch_parent_class)->set_clock(element, clock);
    g_mutex_lock(&self->lock);
    if (self->run->clock != clock) {
        aw_use_clock(*self->run, clock);
        aw_wake(self);
    }
    g_mutex_unlock(&self->lock);
    return ret;
}

static GstStateChangeReturn aw_change_state(GstElement* element, GstStateChange transition) {
    GstMrAlignWatch* self = GST_MRALIGNWATCH(element);
    switch (transition) {
        case GST_STATE_CHANGE_READY_TO_PAUSED:
            aw_start(self);
            break;
        case GST_STATE_CHANGE_PAUSED_TO_PLAYING: {
            /* The clock and base time are set before this: read once for the run. */
            GstClock* clock = gst_element_get_clock(element);
            g_mutex_lock(&self->lock);
            aw_use_clock(*self->run, clock);
            self->run->base = (gint64)gst_element_get_base_time(element);
            self->playing.store(true, std::memory_order_release);
            aw_wake(self);
            g_mutex_unlock(&self->lock);
            if (clock) gst_object_unref(clock);
            break;
        }
        case GST_STATE_CHANGE_PLAYING_TO_PAUSED:
            self->playing.store(false, std::memory_order_release);
            g_mutex_lock(&self->lock);
            self->run->quiet_started = false;
            self->run->pace_run = false;   // the clock stops: no stretch spans the pause
            aw_wake(self);
            g_mutex_unlock(&self->lock);
            break;
        default:
            break;
    }
    const GstStateChangeReturn ret =
        GST_ELEMENT_CLASS(gst_mralignwatch_parent_class)->change_state(element, transition);
    if (transition == GST_STATE_CHANGE_PAUSED_TO_READY) aw_stop(self);
    return ret;
}

static void aw_set_property(GObject* object, guint prop_id, const GValue* value,
                            GParamSpec* pspec) {
    GstMrAlignWatch* self = GST_MRALIGNWATCH(object);
    switch (prop_id) {
        case PROP_ALIGNER:
            GST_OBJECT_LOCK(self);
            g_free(self->aligner);
            self->aligner = g_value_dup_string(value);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_INPUT:
            GST_OBJECT_LOCK(self);
            g_free(self->input);
            self->input = g_value_dup_string(value);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_SPARSE:
            GST_OBJECT_LOCK(self);
            self->sparse = g_value_get_boolean(value);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_HOLD_ON_EOS:
            GST_OBJECT_LOCK(self);
            self->hold_on_eos = g_value_get_boolean(value);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_SEED_LATENESS:
            GST_OBJECT_LOCK(self);
            self->seed_lateness = g_value_get_int64(value);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_SILENCE_FACTOR:
        case PROP_SILENCE_FLOOR:
        case PROP_SILENCE_CEILING:
            if (prop_id == PROP_SILENCE_FACTOR)
                self->silence_factor.store(g_value_get_double(value), std::memory_order_relaxed);
            else if (prop_id == PROP_SILENCE_FLOOR)
                self->silence_floor.store(g_value_get_uint64(value), std::memory_order_relaxed);
            else
                self->silence_ceiling.store(g_value_get_uint64(value), std::memory_order_relaxed);
            /* W again, and the task's deadline with it. */
            g_mutex_lock(&self->lock);
            self->run->limit_stale = true;
            aw_wake(self);
            g_mutex_unlock(&self->lock);
            break;
        case PROP_MAX_SIZE_TIME:
        case PROP_MAX_SIZE_BYTES:
            if (prop_id == PROP_MAX_SIZE_TIME)
                self->max_size_time.store(g_value_get_uint64(value), std::memory_order_relaxed);
            else
                self->max_size_bytes.store(g_value_get_uint(value), std::memory_order_relaxed);
            /* A raised limit makes room for a waiting chain. */
            g_mutex_lock(&self->lock);
            g_cond_broadcast(&self->item_removed);
            g_mutex_unlock(&self->lock);
            break;
        case PROP_TICK:
            self->tick.store(g_value_get_uint64(value), std::memory_order_relaxed);
            break;
        case PROP_FALL_AFTER:
            GST_OBJECT_LOCK(self);
            self->fall_after = g_value_get_uint64(value);
            GST_OBJECT_UNLOCK(self);
            break;
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
            break;
    }
}

static void aw_get_property(GObject* object, guint prop_id, GValue* value, GParamSpec* pspec) {
    GstMrAlignWatch* self = GST_MRALIGNWATCH(object);
    if (self->common.get(prop_id, value)) return;
    if (prop_id >= PROP_STATE) {
        g_mutex_lock(&self->lock);
        const Snap s = aw_snap(self);
        g_mutex_unlock(&self->lock);
        switch (prop_id) {
            case PROP_STATE: g_value_set_string(value, state_name(s.state)); break;
            case PROP_LATENESS: g_value_set_int64(value, s.lateness); break;
            case PROP_PACE: g_value_set_int64(value, s.pace); break;
            case PROP_PACE_TARGET: g_value_set_int64(value, s.pace_target); break;
            case PROP_SILENCE_LIMIT: g_value_set_int64(value, s.silence_limit); break;
            case PROP_ABSENCES: g_value_set_uint64(value, s.absences); break;
            case PROP_STALE_BUFFERS: g_value_set_uint64(value, s.stale_buffers); break;
            case PROP_STALE_TIME: g_value_set_uint64(value, s.stale_time); break;
            case PROP_GAPS: g_value_set_uint64(value, s.gaps); break;
            case PROP_LEVEL_TIME: g_value_set_uint64(value, s.level_time); break;
            case PROP_LEVEL_BYTES: g_value_set_uint64(value, s.level_bytes); break;
            case PROP_FULL_COUNT: g_value_set_uint64(value, s.full_count); break;
            case PROP_PASSES: g_value_set_uint64(value, s.passes); break;
            default: G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec); break;
        }
        return;
    }
    switch (prop_id) {
        case PROP_ALIGNER:
            GST_OBJECT_LOCK(self);
            g_value_set_string(value, self->aligner);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_INPUT:
            GST_OBJECT_LOCK(self);
            g_value_set_string(value, self->input);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_SPARSE:
            GST_OBJECT_LOCK(self);
            g_value_set_boolean(value, self->sparse);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_HOLD_ON_EOS:
            GST_OBJECT_LOCK(self);
            g_value_set_boolean(value, self->hold_on_eos);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_SEED_LATENESS:
            GST_OBJECT_LOCK(self);
            g_value_set_int64(value, self->seed_lateness);
            GST_OBJECT_UNLOCK(self);
            break;
        case PROP_SILENCE_FACTOR:
            g_value_set_double(value, self->silence_factor.load(std::memory_order_relaxed));
            break;
        case PROP_SILENCE_FLOOR:
            g_value_set_uint64(value, self->silence_floor.load(std::memory_order_relaxed));
            break;
        case PROP_SILENCE_CEILING:
            g_value_set_uint64(value, self->silence_ceiling.load(std::memory_order_relaxed));
            break;
        case PROP_MAX_SIZE_TIME:
            g_value_set_uint64(value, self->max_size_time.load(std::memory_order_relaxed));
            break;
        case PROP_MAX_SIZE_BYTES:
            g_value_set_uint(value, self->max_size_bytes.load(std::memory_order_relaxed));
            break;
        case PROP_TICK:
            g_value_set_uint64(value, self->tick.load(std::memory_order_relaxed));
            break;
        case PROP_FALL_AFTER:
            GST_OBJECT_LOCK(self);
            g_value_set_uint64(value, self->fall_after);
            GST_OBJECT_UNLOCK(self);
            break;
        default:
            G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
            break;
    }
}

static void aw_finalize(GObject* object) {
    GstMrAlignWatch* self = GST_MRALIGNWATCH(object);
    aw_flush_fifo(self);
    PaceRegistry::global().leave(&self->run->member);
    aw_drop_clock(*self->run);
    delete self->run;
    g_free(self->aligner);
    g_free(self->input);
    g_mutex_clear(&self->lock);
    g_cond_clear(&self->item_added);
    g_cond_clear(&self->item_removed);
    G_OBJECT_CLASS(gst_mralignwatch_parent_class)->finalize(object);
}

static void gst_mralignwatch_init(GstMrAlignWatch* self) {
    new (&self->common) MrtsHouseCommon();
    new (&self->silence_factor) std::atomic<double>(DEFAULT_SILENCE_FACTOR);
    new (&self->silence_floor) std::atomic<guint64>(DEFAULT_SILENCE_FLOOR);
    new (&self->silence_ceiling) std::atomic<guint64>(DEFAULT_SILENCE_CEILING);
    new (&self->max_size_time) std::atomic<guint64>(DEFAULT_MAX_SIZE_TIME);
    new (&self->max_size_bytes) std::atomic<guint>(0);
    new (&self->tick) std::atomic<guint64>(DEFAULT_TICK);
    new (&self->playing) std::atomic<bool>(false);
    self->aligner = NULL;
    self->input = NULL;
    self->sparse = FALSE;
    self->hold_on_eos = FALSE;
    self->seed_lateness = -1;
    self->fall_after = DEFAULT_FALL_AFTER;
    g_mutex_init(&self->lock);
    g_cond_init(&self->item_added);
    g_cond_init(&self->item_removed);
    self->srcresult = GST_FLOW_FLUSHING;
    self->run = new Run();
    gst_segment_init(&self->run->in_segment, GST_FORMAT_UNDEFINED);

    self->sinkpad = gst_pad_new_from_static_template(&aw_sink_tmpl, "sink");
    GST_PAD_SET_PROXY_CAPS(self->sinkpad);
    gst_pad_set_chain_function(self->sinkpad, GST_DEBUG_FUNCPTR(aw_chain));
    gst_pad_set_chain_list_function(self->sinkpad, GST_DEBUG_FUNCPTR(aw_chain_list));
    gst_pad_set_event_function(self->sinkpad, GST_DEBUG_FUNCPTR(aw_sink_event));
    gst_pad_set_query_function(self->sinkpad, GST_DEBUG_FUNCPTR(aw_sink_query));
    gst_pad_set_activatemode_function(self->sinkpad, GST_DEBUG_FUNCPTR(aw_sink_activate_mode));
    gst_element_add_pad(GST_ELEMENT_CAST(self), self->sinkpad);

    self->srcpad = gst_pad_new_from_static_template(&aw_src_tmpl, "src");
    GST_PAD_SET_PROXY_CAPS(self->srcpad);
    gst_pad_set_query_function(self->srcpad, GST_DEBUG_FUNCPTR(aw_src_query));
    gst_pad_set_activatemode_function(self->srcpad, GST_DEBUG_FUNCPTR(aw_src_activate_mode));
    gst_element_add_pad(GST_ELEMENT_CAST(self), self->srcpad);
}

static void gst_mralignwatch_class_init(GstMrAlignWatchClass* klass) {
    GObjectClass* gobject_class = G_OBJECT_CLASS(klass);
    GstElementClass* element_class = GST_ELEMENT_CLASS(klass);

    gobject_class->set_property = aw_set_property;
    gobject_class->get_property = aw_get_property;
    gobject_class->finalize = aw_finalize;
    element_class->change_state = aw_change_state;
    element_class->set_clock = aw_set_clock;

    const GParamFlags at_start =
        (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS | GST_PARAM_MUTABLE_READY);
    const GParamFlags live =
        (GParamFlags)(G_PARAM_READWRITE | G_PARAM_STATIC_STRINGS | GST_PARAM_MUTABLE_PLAYING);
    const GParamFlags ro = (GParamFlags)(G_PARAM_READABLE | G_PARAM_STATIC_STRINGS);

    g_object_class_install_property(
        gobject_class, PROP_ALIGNER,
        g_param_spec_string("aligner", "Aligner",
                            "The aggregator this input feeds: the inputs of one pipeline with "
                            "the same name share a pace. Empty: a group of one.",
                            NULL, at_start));
    g_object_class_install_property(
        gobject_class, PROP_INPUT,
        g_param_spec_string("input", "Input", "The input's label in messages.", NULL, at_start));
    g_object_class_install_property(
        gobject_class, PROP_SPARSE,
        g_param_spec_boolean("sparse", "Sparse",
                             "A sparse stream (KLV, subtitles): never absent, upstream GAPs "
                             "dropped, gaps between cues at the pace; a late cue is forwarded "
                             "at its own PTS and raises the pace.",
                             FALSE, at_start));
    g_object_class_install_property(
        gobject_class, PROP_HOLD_ON_EOS,
        g_param_spec_boolean("hold-on-eos", "Hold on EOS",
                             "Turn EOS into absence until a flush or NULL, so the aggregator "
                             "keeps running on gaps; else EOS is forwarded.",
                             FALSE, at_start));
    g_object_class_install_property(
        gobject_class, PROP_SEED_LATENESS,
        g_param_spec_int64("seed-lateness", "Seed lateness (ns)",
                           "The input's known upstream lateness at start, in the pace for "
                           "fall-after unless the input shows more; -1: none.",
                           -1, 3600 * GST_SECOND, -1, at_start));
    g_object_class_install_property(
        gobject_class, PROP_SILENCE_FACTOR,
        g_param_spec_double("silence-factor", "Silence factor",
                            "W = factor x p95 of the gaps between the last 200 arrivals.", 1.0,
                            100.0, DEFAULT_SILENCE_FACTOR, live));
    g_object_class_install_property(
        gobject_class, PROP_SILENCE_FLOOR,
        g_param_spec_uint64("silence-floor", "Silence floor (ns)", "The least W.", GST_MSECOND,
                            60 * GST_SECOND, DEFAULT_SILENCE_FLOOR, live));
    g_object_class_install_property(
        gobject_class, PROP_SILENCE_CEILING,
        g_param_spec_uint64("silence-ceiling", "Silence ceiling (ns)",
                            "The most W, and W before 10 arrivals.", GST_MSECOND,
                            60 * GST_SECOND, DEFAULT_SILENCE_CEILING, live));
    g_object_class_install_property(
        gobject_class, PROP_MAX_SIZE_TIME,
        g_param_spec_uint64("max-size-time", "Max size time (ns)",
                            "Queue time level that blocks upstream (never drops); 0: none.", 0,
                            G_MAXUINT64, DEFAULT_MAX_SIZE_TIME, live));
    g_object_class_install_property(
        gobject_class, PROP_MAX_SIZE_BYTES,
        g_param_spec_uint("max-size-bytes", "Max size bytes",
                          "Queue bytes that block upstream (never drops); 0: none.", 0,
                          G_MAXUINT, 0, live));
    g_object_class_install_property(
        gobject_class, PROP_TICK,
        g_param_spec_uint64("tick", "Tick (ns)",
                            "How often a sparse input, or a gapped one toward mpegtsmux, gets "
                            "its gap (toward an audio aggregator gaps go as the data would).",
                            GST_MSECOND, GST_SECOND, DEFAULT_TICK, live));
    g_object_class_install_property(
        gobject_class, PROP_FALL_AFTER,
        g_param_spec_uint64("fall-after", "Fall after (ns)",
                            "How long every input must stay 10 ms or more under the pace before "
                            "it falls to them, at most 1 s a step (window: 1 to 1.5 times this); "
                            "the group's first input sets it.",
                            GST_SECOND, 3600 * GST_SECOND, DEFAULT_FALL_AFTER, at_start));

    g_object_class_install_property(
        gobject_class, PROP_STATE,
        g_param_spec_string("state", "State", "waiting, present or absent.", "waiting", ro));
    g_object_class_install_property(
        gobject_class, PROP_LATENESS,
        g_param_spec_int64("lateness", "Lateness (ns)",
                           "This input's lateness: the median over the last second of wall "
                           "time it delivered; a catch-up (a burst) and stale data left out.",
                           G_MININT64, G_MAXINT64, 0, ro));
    g_object_class_install_property(
        gobject_class, PROP_PACE,
        g_param_spec_int64("pace", "Pace (ns)",
                           "The pace group's: data leaves at its running time + this.", 0,
                           G_MAXINT64, 0, ro));
    g_object_class_install_property(
        gobject_class, PROP_PACE_TARGET,
        g_param_spec_int64("pace-target", "Pace target (ns)",
                           "The most any input showed over fall-after: the pace eases up to it "
                           "and falls to it.",
                           0, G_MAXINT64, 0, ro));
    g_object_class_install_property(
        gobject_class, PROP_SILENCE_LIMIT,
        g_param_spec_int64("silence-limit", "Silence limit (ns)",
                           "W: silent this long, the input is absent.", 0, G_MAXINT64, 0, ro));
    g_object_class_install_property(
        gobject_class, PROP_ABSENCES,
        g_param_spec_uint64("absences", "Absences", "Times the input went absent.", 0,
                            G_MAXUINT64, 0, ro));
    g_object_class_install_property(
        gobject_class, PROP_STALE_BUFFERS,
        g_param_spec_uint64("stale-buffers", "Stale buffers",
                            "Buffers discarded for ending before what went out (a rejoin).", 0,
                            G_MAXUINT64, 0, ro));
    g_object_class_install_property(
        gobject_class, PROP_STALE_TIME,
        g_param_spec_uint64("stale-time", "Stale time (ns)", "Their total duration.", 0,
                            G_MAXUINT64, 0, ro));
    g_object_class_install_property(
        gobject_class, PROP_GAPS,
        g_param_spec_uint64("gaps", "Gaps", "GAP spans sent downstream, forwarded ones included.",
                            0, G_MAXUINT64, 0, ro));
    g_object_class_install_property(
        gobject_class, PROP_LEVEL_TIME,
        g_param_spec_uint64("level-time", "Level time (ns)", "Time queued.", 0, G_MAXUINT64, 0,
                            ro));
    g_object_class_install_property(
        gobject_class, PROP_LEVEL_BYTES,
        g_param_spec_uint64("level-bytes", "Level bytes", "Bytes queued.", 0, G_MAXUINT64, 0,
                            ro));
    g_object_class_install_property(
        gobject_class, PROP_FULL_COUNT,
        g_param_spec_uint64("full-count", "Full count",
                            "Times the queue filled and held upstream.", 0, G_MAXUINT64, 0, ro));
    g_object_class_install_property(
        gobject_class, PROP_PASSES,
        g_param_spec_uint64("passes", "Passes",
                            "Times the src task ran, once a wake: about one per arrival while "
                            "data flows.", 0, G_MAXUINT64, 0, ro));
    /* After our own: the common ids are clear of these (MrtsHouseCommon::PROP_BASE). */
    MrtsHouseCommon::install(gobject_class);

    gst_element_class_add_static_pad_template(element_class, &aw_sink_tmpl);
    gst_element_class_add_static_pad_template(element_class, &aw_src_tmpl);
    gst_element_class_set_static_metadata(
        element_class, "Media Router aligner input", "Generic",
        "The input of a non-live aggregator: holds data to the pace its inputs share, fills a "
        "silent input with gaps and answers LATENCY as non-live",
        "Media Router <https://github.com/bccsa/media-router>");
}
