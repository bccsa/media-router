// C++ port of ts_timeline.py — source-timeline latch — plus the producer-side
// egress stamper the native bus sidecars share (mr-bus-fanout, mr-tssplit).
// Behavior mirrors the Python module, which is what the gst runner's egress
// probe runs too (packages/engine/src/child-process/gst_bus_stamper.py); see
// ts_timeline.py for the full latch commentary and ADR-0005 decision 2 for the
// contract.
#pragma once
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <utility>
#include <vector>

namespace mrts {

constexpr int64_t PTS_WRAP = 1LL << 33;

// 90 kHz ticks -> nanoseconds, exact in integers: ns = pts * 1e9 / 90e3.
// Floor division, like Python's `//`, so a negative delta rounds the same way.
int64_t pts90k_to_ns(int64_t pts);

// `pts` shifted by the 2^33 period that lands it nearest `ref` (`ref` may
// itself already be unwrapped, i.e. outside 33 bits).
int64_t unwrap_near(int64_t pts, int64_t ref);

// Per-PID first-PES-PTS recorder over a TS byte stream. EPOCH-CONSISTENT: the
// first PID to latch defines the epoch and every later PID's first PTS is
// unwrapped to the 2^33 period nearest that reference, so a stream starting
// astride the boundary stays ONE timeline instead of two 26.5 h apart.
class TimelineLatch {
  public:
    void feed(const uint8_t* data, size_t len);
    bool latched(int pid) const { return first_pts_.count(pid) != 0; }
    // First PES PTS latched for `pid`, epoch-unwrapped; `fallback` if none.
    int64_t first_pts(int pid, int64_t fallback) const;
    // The epoch reference — the first PES PTS this latch ever recorded. Equals
    // Python's `next(iter(first_pts.values()))` (first insertion), which is
    // what the runner's stamper uses as the timeline's zero.
    int64_t epoch_ref(int64_t fallback) const { return has_epoch_ ? epoch_ref_ : fallback; }
    bool has_epoch() const { return has_epoch_; }
    void clear();

  private:
    std::map<int, int64_t> first_pts_;
    int64_t epoch_ref_ = 0;
    bool has_epoch_ = false;
};

// Producer-side egress stamper — the C++ half of the runner's bus stamper.
//
// Maps a producer's PES timeline onto the house clock ONCE and stamps every
// outgoing bus buffer with `anchor + (payload PES - firstPES)`, so consumers
// inherit identical timing by construction instead of re-deriving it from
// their own arrival. `house_now` is supplied by the caller: on the sidecars
// the wire domain is absolute CLOCK_MONOTONIC (busproto.h), i.e. mono_ns().
//
// ONE stamper serves a whole egress. mr-tssplit passes each output PID as its
// own `stream`, so the branches share a single anchor + epoch reference (the
// splitter's whole point — A/V branches must stay mutually aligned) while each
// keeps its own monotone floor: a shared floor would clamp the lagging branch
// to the leading one's stamp and silently re-roll lipsync.
//
// TWO independent ways back from a source discontinuity, because the freeze
// mode one of them misses is unbounded (the 2026-08-13 field failure): the
// per-PID discontinuity WATCH (`scan_watch`) recognises the jump, and the
// bounded-staleness NET (`scan_stale`) catches whatever the watch did not.
//
// THIRD, continuous rather than event-driven: the drift SLEW (`observe` /
// `slew`). Neither of the above can answer a source whose crystal simply runs
// at a different RATE from ours — 10-50 ppm apart is ordinary — which walks the
// arrival-vs-stamp margin for as long as the route runs. Estimator and loop
// constants are documented in full in ts_timeline.py; this is its port, integer
// for integer.
class TimelineStamper {
  public:
    struct Reanchor {
        int pid;
        int64_t last_pts, pts;     // 90 kHz, the jump that triggered this
        int64_t delta_ticks;       // signed, wrap-folded
        int64_t anchor_ns;
        long long count;           // re-anchors so far, this incarnation
    };
    using OnReanchor = std::function<void(const Reanchor&)>;
    struct Anchored {
        int pid;                   // PID carrying the first PES seen
        int64_t anchor_ns, ref_pts;
    };
    using OnAnchor = std::function<void(const Anchored&)>;
    // The latch-repair window closed (python's `on_settled`): `repair_ns` (<= 0)
    // is what the window pulled the anchor back by — the backlog a late first
    // PES was the head of. Reported once per anchor, on the first PES buffer
    // past the window.
    struct Settled {
        int64_t anchor_ns, repair_ns, window_ns;
    };
    using OnSettled = std::function<void(const Settled&)>;
    // The timeline conditioner absorbed one clock step (python's
    // `on_conditioned`): `pcr` names which clock, `step_ticks` the step it took
    // out of the wire (90 kHz, signed: negative = the source stepped back),
    // `offset_ticks` the cumulative correction now applied to that PID.
    struct Conditioned {
        int pid;
        bool pcr;
        int64_t step_ticks, offset_ticks;
        int64_t house_ns;
    };
    using OnConditioned = std::function<void(const Conditioned&)>;

    // `repair_latch` is the OPT-IN for the latch-repair window (ts_timeline.py,
    // "latch repair"): only for a producer whose delivery cadence IS its media
    // cadence — a network ingest, a splitter or muxer riding one, a capture.
    // The HLS fan-out runs AHEAD by design and must leave it off.
    TimelineStamper(OnAnchor on_anchor = nullptr, OnReanchor on_reanchor = nullptr,
                    OnSettled on_settled = nullptr, bool repair_latch = false)
        : on_anchor_(std::move(on_anchor)), on_reanchor_(std::move(on_reanchor)),
          on_settled_(std::move(on_settled)), repair_on_(repair_latch) {}

    // Map one outgoing buffer of `stream` onto the house timeline. EVERY
    // buffer gets a valid stamp: one with no PES header at all (PSI/PCR-only
    // or continuation packets) repeats the stream's last stamp, because a
    // timestampless buffer leaves the time-bounded leaky queues on the bus
    // unable to measure their own level.
    int64_t stamp(const uint8_t* data, size_t len, int64_t house_now, int stream = 0);

    // TIMELINE CONDITIONER (python's `condition`) — rewrites the PES PTS/DTS and
    // PCR fields IN `data` so that a clock step at the source (a muxer that
    // resets its pacing timeline: vMix CBR, −1.1 s then +1.1 s every ~90 s)
    // never reaches a consumer as a discontinuity. Per PID, a PES whose PTS
    // moved by more than COND_STEP_NS while its arrival moved normally is a
    // clock step, not content: the PID's offset absorbs the difference so the
    // written cadence follows arrival. A delivery STALL (PTS normal, arrival
    // late) and a genuine GAP (PTS and arrival moved together) are left alone;
    // so is anything past COND_MAX_NS, which the watch re-anchors as before.
    // Call BEFORE stamp() on the same bytes; live-cadence producers only (the
    // same set that turns repair_latch on — an HLS fan-out's bursts are not a
    // cadence). Returns the number of steps absorbed.
    int condition(uint8_t* data, size_t len, int64_t house_now);
    void set_on_conditioned(OnConditioned cb) { on_conditioned_ = std::move(cb); }

    // Close an open latch-repair window NOW and report it (python's
    // `close_latch`): for a disarm inside the window, so a short-lived
    // incarnation's anchor cost is not silently skipped. No-op otherwise.
    void close_latch();

    bool anchored() const { return anchored_; }
    int64_t anchor_ns() const { return anchor_; }
    int64_t ref_pts() const { return ref_; }
    long long reanchors() const { return reanchors_; }

    // Drift-servo state for the producers' periodic stats line — python's
    // `drift_stats()`, field for field. `ppm` is the rate the servo has locked
    // onto (the source's clock offset from ours) and `slew_ns` what applying it
    // has cost or given the anchor this epoch; `margin_ns` is the current
    // envelope level (`house - stamp`, so NEGATIVE is a healthy delivery lead)
    // and `engage_ns` the level the servo engaged at and undertakes not to give
    // away. `samples` below `window` means the trend window is still filling
    // and nothing is being corrected — which a reader must be able to tell from
    // a measured zero.
    struct Drift {
        int ppm;
        int64_t slew_ns;
        int64_t margin_ns;
        int64_t engage_ns;
        int samples;
        int window;
    };
    Drift drift() const;

  private:
    void reanchor(int pid, int64_t last_pts, int64_t pts, int64_t d, int64_t house_now);
    // Fresh epoch for the drift servo — construction and every re-anchor (the
    // rate belonged to a mapping that no longer exists, and a fresh anchor means
    // a fresh producer transient to settle through).
    void reset_drift(int64_t house_now, bool have_now);
    // One buffer's arrival-vs-stamp margin into the estimator. PES-less buffers
    // are never observed: they repeat the staircase, so their "margin" is the
    // previous stamp's age, not a measurement.
    void observe(int64_t house_now, int64_t stamp);
    // Trend of the margin across the window in ppm; false while it is not full.
    bool slope_ppm(int64_t* out) const;
    // One servo step, per closed sub-window.
    void update_rate();
    // Apply the locked rate to the anchor for the elapsed house time.
    void slew(int64_t house_now);
    void scan_watch(const uint8_t* data, size_t len, int64_t house_now);
    // The bounded-staleness net: forces a re-anchor when `stream`'s stamps have
    // fallen and STAYED further behind house time than the sanity bound. See
    // ts_timeline.py for the constants' rationale.
    void scan_stale(int pid, int64_t pts, int64_t house_now, int stream);
    // The level tier of that net (python's `_scan_late`): re-anchors when even
    // the best-delivered buffer of the egress has arrived more than LATE_NS
    // after its own mapped time for LATE_HOLD_NS straight, or (repair_on_
    // producers only) when even the least-early buffer has arrived more than
    // EARLY_NS before it for EARLY_HOLD_NS. True when it did, so the caller
    // restamps the buffer on the fresh epoch.
    bool scan_late(int pid, int64_t pts, int64_t house_now, int64_t stamp);
    // False when the buffer carries no PES header at all (`*out` untouched).
    // `*out_pid` is the PID whose PES the stamp came from (the timing PID's
    // when the buffer carries one).
    bool scan_stamp(const uint8_t* data, size_t len, int64_t house_now, int64_t* out,
                    int* out_pid = nullptr, int64_t* out_pts = nullptr);
    // Latch repair (python's `_open_latch` / `_repair`): a fresh anchor opens
    // the window; inside it a stamp later than its own arrival pulls the anchor
    // back and leaves as the arrival; the first PES past it closes and reports.
    void open_latch(int64_t house_now);
    int64_t repair(int64_t house_now, int64_t stamp);

    TimelineLatch latch_;
    bool anchored_ = false;
    int64_t anchor_ = 0;              // house time (ns) latched at the first PES
    int64_t ref_ = 0;                 // that first PES (90 kHz), the timeline's zero
    std::map<int, int64_t> unwrapped_;    // pid -> last PES PTS, unwrapped past 2^33
    std::map<int, int64_t> watch_last_;   // pid -> last PES PTS (raw), watch
    std::map<int, int64_t> pending_;      // pid -> the epoch its last anomaly proposed
    std::map<int, int64_t> floors_;       // stream -> last stamp emitted
    std::map<int, int64_t> stale_since_;  // stream -> house time its lag went out of bound
    bool late_open_ = false;              // the egress-wide margin is past LATE_NS
    int64_t late_since_ = 0;              // ... since this house time
    int64_t late_min_ = 0;                // ... and the smallest margin since (the level)
    bool early_open_ = false;             // the margin is below -EARLY_NS (repair_on_ only)
    int64_t early_since_ = 0;             // ... since this house time
    int64_t early_max_ = 0;               // ... and the largest margin since (the level)
    int anom_ = 0;
    long long reanchors_ = 0;
    // Drift servo (see ts_timeline.py for the design and every constant's
    // rationale, including the field failure that produced them).
    int64_t env_min_ = 0;         // running minimum of the open 2 s bucket
    int64_t env_end_ = 0;         // house time that bucket closes at
    bool env_open_ = false;
    std::vector<int64_t> sub_;    // closed bucket minima of the open sub-window
    int64_t sub_end_ = 0;         // house time the sub-window closes at
    std::vector<std::pair<int64_t, int64_t>> trend_;   // (house time, level)
    int64_t level_ = 0;           // newest sub-window level, i.e. the margin now
    bool has_level_ = false;
    int rate_ppm_ = 0;            // the correction rate currently applied
    int slope_sign_ = 0;          // sign of the last qualifying slope
    int64_t engage_level_ = 0;    // margin level when the servo engaged
    bool has_engage_ = false;
    int64_t epoch_start_ = 0;     // anchor time — the settling period runs from it
    bool has_epoch_start_ = false;
    int64_t slew_last_ = 0;       // house time the last correction was applied
    bool has_slew_last_ = false;
    int64_t slew_total_ = 0;      // cumulative anchor correction, this epoch
    // Latch repair (see ts_timeline.py for the design and the field failure).
    bool latch_open_ = false;     // a repair window is open
    int64_t latch_until_ = 0;     // house time it closes at
    int64_t repair_ns_ = 0;       // what it has pulled the anchor back by (<= 0)
    OnAnchor on_anchor_;
    OnReanchor on_reanchor_;
    OnSettled on_settled_;
    OnConditioned on_conditioned_;
    bool repair_on_ = false;
    // Timeline conditioner state (python's `_cond_pes` / `_cond_pcr`).
    struct CondClock {
        int64_t last_raw;      // last raw value seen (90 kHz for PES, 27 MHz for PCR)
        int64_t last_house;    // house time it arrived at
        int64_t offset;        // correction applied (same unit as last_raw)
        std::vector<int64_t> recent;   // recent in-cadence deltas (ns), the nominal's source
    };
    // The step to absorb: the raw delta less this clock's nominal interval (the
    // median of its recent in-cadence deltas), so a step that lands on a large
    // frame is not over-corrected by that frame's wire time.
    static int64_t cond_step_ns(const CondClock& c, int64_t d_ns);
    static void cond_remember(CondClock& c, int64_t d_ns);
    // The PTS the regenerated PCR must trail: the LOWEST recent written PTS of
    // any stream (an audio PID can lag the video's by hundreds of ms and must
    // not be placed before it is delivered), bounded to at most COND_PCR_FLOOR_NS
    // below the reference PID's so a sparse metadata PID cannot drag it.
    int64_t cond_pcr_floor_pts(int64_t house_now) const;
    std::map<int, CondClock> cond_pes_;
    // PCR regeneration (python's `_cond_ref_*`): the reference PES PID (the
    // first with a PTS), its last WRITTEN PTS and the house time it arrived at,
    // the last written PCR (monotone guard), and the last reported raw→written
    // PCR offset (an event marks each new deviation of the source's PCR).
    int cond_ref_pid_ = -1;
    int cond_pcr_pid_ = -1;              // the PID carrying the PCR: the reference, when it has PES
    // TIMING PID (python's `_timing_pid`): under conditioning, the PID carrying
    // the PCR is the egress's timing reference — the anchor is taken on ITS
    // first PES, and the latch repair, the drift servo and the late/early
    // tiers judge ITS buffers only. Every other PID rides the same anchor. A
    // source whose audio PES run 1.7 s ahead of its video (vMix, .103
    // 2026-09-08 12:03) otherwise has each mechanism "correcting" the anchor
    // for one stream and breaking it for the other. −1 = any PID (legacy).
    int timing_pid_ = -1;
    int anchor_pid_ = -1;                // the PID the anchor was taken on
    bool timing_rebase_pending_ = false; // the timing PID was learned after the anchor: re-base on its next PES
    int64_t cond_ref_wpts_ = 0;
    int64_t cond_ref_house_ = 0;
    std::map<int, std::pair<int64_t, int64_t>> cond_seen_;   // pid -> (last wpts, house): the floor's candidates
    bool cond_have_wpcr_ = false;
    int64_t cond_last_wpcr_ = 0;
    int64_t cond_last_wpcr_house_ = 0;   // arrival of the last written PCR
    bool cond_pcr_regen_ = false;
    bool cond_pcr_reported_ = false;
    int64_t cond_pcr_reported_offset_ = 0;
};

std::string conditioned_event_json(const TimelineStamper::Conditioned& c);

// The stamper's two engine events as JSON lines — ONE definition for every
// native producer (mr-bus-fanout, mr-tssplit), field for field what
// `unixfd-fanout.py` emits from the python `TimelineStamper`. The sidecars
// used to carry a copy of these lambdas each, and the copies had already
// drifted: both dropped `lastPts90k` and `deltaTicks` from the re-anchor, so
// the cross-implementation event contract the comments promised was true only
// of python. Pinned by ts_timeline_test.cpp and, across the language boundary,
// by the fan-out conformance suite (unixfdFanout.test.ts).
std::string anchor_event_json(const TimelineStamper::Anchored& a);
std::string reanchor_event_json(const TimelineStamper::Reanchor& r);
std::string settled_event_json(const TimelineStamper::Settled& s);

// The drift loop's state as the `timeline` object of a producer's periodic
// stats line — key for key what python's `drift_stats()` produces, so a
// burn-in chart does not have to know which implementation stamped.
std::string drift_stats_json(const TimelineStamper::Drift& d);

}  // namespace mrts
