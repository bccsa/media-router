// The virtual STC (design §5.1-§5.3; plan ch. 5 parts 4.3-4.4): the source clock
// locked to PCR arrivals, its validation and the per-program epochs. Integer-only,
// so a replay is bit-exact on every machine.
#pragma once
#include <cstdint>
#include <deque>
#include <map>
#include <utility>
#include <vector>

#include "ts_house.h"

namespace mrts {

// Every constant of part 4.3, at the values WI-P1-6's replay sweep chose (ADR-0029).
struct ClockLockConfig {
    int64_t bucket_ns = 1000000000;            // bucket minima: 1 s of house time
    int rate_buckets_min = 30;                 // first rate fit
    int rate_buckets_max = 300;                // fit window grows to 5 min (clamped to 1000)
    int64_t rate_tau_ns = 120000000000LL;      // ε_applied's first-order loop
    int64_t rate_warn_ppm = 100;
    int64_t rate_max_ppm = 1000;               // ε_applied is clamped here
    int rate_refit_mads = 2;                   // refit without points this many MADs above the line
    int offset_buckets = 10;                   // M: β* = min over the last M buckets
    int64_t slew_acquire_ppm = 2000;
    int64_t acquire_ns = 5000000000LL;
    int64_t slew_track_ppm = 20;
    int64_t step_ns = 20000000;                // envelope step: the minimum delay rose this much
    int64_t step_hold_ns = 10000000000LL;      // ... for this long
    bool step_falls = false;                   // ... or fell this much (mrasrc: two-sided)
    // Two buckets agreeing on a floor this far below the line: a drained backlog, moved onto
    // in any epoch and phase (B-39). leap_ns's 500 ms less the acquire slew's 10 ms, so a backlog
    // that relocks still lies past it when its floor shows (B-48, the owner's). 0: off (mrasrc).
    int64_t backlog_ns = 490000000;
    int64_t lost_ns = 5000000000LL;            // no sample this long: phase lost
    int64_t residual_window_ns = 2000000000;   // residual stats window (stats-interval-ms)
};

// One mapping segment: house(σ) = house_ref + Δ + Δ·rate + the β slew, Δ = σ - sigma_ref.
// The slew runs at slew_ppb only until it has moved slew_ns, so a late next
// bucket cannot overshoot β*; behind sigma_ref the plain rate line applies.
struct StcLine {
    int64_t sigma_ref = 0;
    int64_t house_ref = 0;
    int64_t rate_ppb = 0;      // ε applied
    int64_t slew_ppb = 0;      // |β velocity|
    int64_t slew_ns = 0;       // β travel left (signed)
    int64_t house_of(int64_t sigma) const;
    int64_t travel(int64_t sigma) const;   // slew moved by the time σ is reached
};

// Lower-envelope lock of remote (source) time to arrival time. No TS knowledge:
// the PCR here, a PES PTS in degraded mode, a frame counter in mrasrc.
// Scaling: times and β in ns, ε in ppb (loop state ppb * 2^16). The rate fit is least
// squares on x in ms by y in ns, <= 1000 buckets within 1100 s, y clamped to ±2^30 ns.
class ClockLock {
  public:
    enum class Phase { acquiring, locked, lost };
    // r = arrival - house(σ) before the sample moves the mapping; 0s when count is 0.
    struct Residual {
        int64_t min_ns = 0, p50_ns = 0, p99_ns = 0, max_ns = 0;
        uint32_t count = 0;
    };

    explicit ClockLock(const ClockLockConfig& cfg = ClockLockConfig());

    void feed(int64_t remote_ns, int64_t arrival_ns);
    // House time passed with no sample: lets an outage turn the phase to lost.
    void tick(int64_t now_ns);
    // locked once the rate is known (first fit, or kept by relock) and acquire_ns has
    // passed since; lost while no sample came for lost_ns (feed or tick). The mapping
    // survives lost: the next sample resumes the previous phase.
    Phase phase() const;
    bool started() const { return started_; }
    int64_t house_of(int64_t remote_ns) const { return line_.house_of(remote_ns); }
    const StcLine& line() const { return line_; }
    int64_t ppb() const;                        // ε applied
    bool has_fit() const { return fit_valid_; }
    int64_t fit_ppb() const { return fit_ppb_; }  // last raw fit, unclamped (validator)
    Residual residual() const;
    // β travel since the phase became locked: how far the minimum delay wandered.
    int64_t offset_drift_ns() const { return locked_ ? travel_ns_ - travel_at_lock_ : 0; }
    // A rise of the minimum delay makes content late, so it re-locks; a fall only adds
    // latency and is slewed (no overlap, nothing dropped), unless step_falls: a capture
    // labelled on its floor is late by any fall.
    bool envelope_step() const { return step_fired_; }
    int64_t step_size_ns() const { return step_size_; }
    // How far the line lies above the floor its open and last closed buckets show; delay is
    // one-sided, so one early sample proves it. 0 when the line is on or under it.
    int64_t floor_gap_ns() const;
    // New epoch from the next sample; ε stays as the starting guess with keep_rate. Only
    // the first epoch moves onto the floor of its first two agreeing buckets (seed_floor);
    // any epoch moves onto a backlog's (backlog_ns).
    void relock(bool keep_rate);
    // After a step: the mapping onto the floor the step's buckets measured, at once,
    // keeping ε and the phase (mrasrc). A program's STC never steps; it relocks.
    void step_to_floor();
    const ClockLockConfig& config() const { return cfg_; }

  private:
    // The rate fit runs on one floor level: a bucket off it by more than step_ns is a
    // candidate level, which replaces the fit's after step_hold_ns or is left out.
    enum class Level : uint8_t { fit, candidate, out };
    // The last two buckets' minima: within step_ns, or the newer that far above or below.
    enum class Pair : uint8_t { agree, rise, fall };
    struct Point {
        int64_t sigma, house;
        Level level;
        int64_t eps = 0;   // the rate in force when it closed: what judges against it
    };
    void close_bucket(int64_t sigma_now, int64_t house_now);
    Pair seed_floor(int64_t below);
    void classify(int64_t house_now);
    bool fit(int64_t* ppb, int* n) const;
    int64_t eps_ppb() const;

    ClockLockConfig cfg_;
    bool started_ = false;
    bool fresh_ = true;               // no relock yet: the epoch the pipeline started with
    bool floor_found_ = false;        // its floor decided: two buckets agreed, or a dip passed
    StcLine line_;
    int64_t origin_h_ = 0;            // bucket grid of this epoch
    int64_t bucket_ = 0;              // index of the open bucket
    Point cur_{0, 0, Level::fit};     // its min-d sample
    std::deque<Point> hist_;          // closed buckets, newest last
    bool cand_ = false;               // a candidate level is open since cand_h_
    int64_t cand_h_ = 0;
    bool rate_known_ = false;
    int64_t eps_q16_ = 0;             // ε applied, ppb * 2^16
    int rate_n_ = 0;                  // buckets behind the ε in force
    int64_t rate_known_h_ = 0;
    bool fit_valid_ = false;
    int64_t fit_ppb_ = 0;
    int64_t epoch_h_ = 0;
    bool locked_ = false;
    bool run_ = false;                // buckets past step_ns since run_start_h_
    bool run_fall_ = false;           // ... below the line (step_falls)
    int64_t run_start_h_ = 0;
    int64_t run_min_ = 0;
    bool step_fired_ = false;
    int64_t step_size_ = 0;
    int64_t travel_ns_ = 0, travel_at_lock_ = 0;
    int64_t last_sample_h_ = 0, last_seen_h_ = 0;
    std::deque<std::pair<int64_t, int64_t>> resid_;   // (arrival, r)
};

struct PcrValidatorConfig {
    int64_t pcr_interval_warn_ns = 150000000;     // p99 over cadence_window_ns: warning
    int64_t pcr_interval_fail_ns = 500000000;     // three of these in 60 s: fail
    int64_t cadence_window_ns = 10000000000LL;
    int64_t cadence_fail_window_ns = 60000000000LL;
    int cadence_fail_count = 3;
    int64_t rate_max_ppm = 1000;
    int64_t rate_hold_ns = 30000000000LL;
    int freeze_count = 3;
    int64_t freeze_min_dh_ns = 30000000;
    int64_t leap_ns = 500000000;                  // above the gate egress's delivery stalls (WI-P1-6)
    int leap_fail_count = 3;
    int64_t leap_window_ns = 60000000000LL;
    int64_t lead_min_ns = -200000000;             // the stream lead: PTS (DTS for video) less the last PCR
    int64_t lead_max_ns = 4000000000LL;           // the lead against arrival under the PCR line
    int64_t lead_median_window_ns = 1000000000;   // the median that must stay out ...
    int64_t lead_hold_ns = 5000000000LL;          // ... this long
    int64_t recover_ns = 30000000000LL;           // no row failing this long before leaving degraded
    // Degraded: a PID further ahead of arrival under the reference mapping gets its own
    // envelope (lead 0), under the 5 s bus ingress queue (part 4.3, B-8).
    int64_t lead_clamp_ns = 4000000000LL;
};

// The PCR checks of §5.3, one row each (part 4.3's table).
class PcrValidator {
  public:
    // discontinuity, leap: the caller re-locks. fail: the edge of the first failing
    // row; rows fed elsewhere (cadence, rate, lead) show it through failed().
    enum class Verdict { ok, discontinuity, leap, fail };
    enum class Reason { none, cadence, rate, freeze, leap, lead };

    static constexpr int64_t NO_LEAD = INT64_MIN;   // feed_lead: that half not measured

    explicit PcrValidator(const PcrValidatorConfig& cfg = PcrValidatorConfig());

    Verdict feed_pcr(int64_t pcr27, bool di, int64_t arrival_ns);
    // Any other packet of the program: cadence counts PCR gaps only while
    // packets keep arriving, so an outage is not a PCR fault.
    void feed_activity(int64_t arrival_ns);
    void feed_rate(int64_t fit_ppb, int64_t arrival_ns);
    // One PES, timed by the latest feed (B-90): its lead against arrival, judged against
    // lead_max_ns, and its stream lead (its PTS less the program's last PCR), against
    // lead_min_ns, which a late delivery does not move. Either may be NO_LEAD.
    void feed_lead(int pid, int64_t arrival_ns, int64_t stream_ns);
    Reason reason() const { return reason_; }   // the first failing row; sticky
    bool failed() const { return reason_ != Reason::none; }
    bool cadence_warning() const { return warn_; }
    int64_t clean_ns(int64_t now_ns) const;      // since a row last failed (bad())
    void clear_failure() { reason_ = Reason::none; }
    void restart_pcr() { have_pcr_ = false; }    // the PCR PID changed
    int64_t last_leap_ns() const { return last_leap_; }   // Δσ - Δh of the last leap
    int64_t take_interval_max();                 // longest PCR interval since the last take
    const PcrValidatorConfig& config() const { return cfg_; }

  private:
    struct Window {
        std::deque<std::pair<int64_t, int64_t>> w;   // (time, lead)
        bool bad = false;
        int64_t bad_since = 0;
    };
    struct Lead {
        Window arrival, stream;
    };
    void on_packet(int64_t h);
    void bad(int64_t h);
    bool fail(Reason r);
    void judge(Window& l, int64_t lead_ns, int64_t lo, int64_t hi);

    PcrValidatorConfig cfg_;
    Reason reason_ = Reason::none;
    int64_t now_ = 0;
    bool have_pcr_ = false;
    int64_t last_pcr_ = 0, last_pcr_h_ = 0, first_pcr_h_ = 0;
    int64_t fz_pcr_ = 0, fz_h_ = 0;   // freeze anchor: the last PCR >= 30 ms back
    int freeze_run_ = 0;
    bool have_act_ = false;
    int64_t last_act_h_ = 0;
    int64_t open_h_ = 0;              // start of the open PCR interval
    int64_t open_counted_ = 0;        // pcr_interval_fail_ns multiples counted in it
    bool open_outage_ = false;
    std::deque<std::pair<int64_t, int64_t>> intervals_;   // (arrival, interval)
    std::deque<int64_t> longs_, leaps_;
    bool warn_ = false;
    int64_t interval_max_ = 0;
    int64_t last_leap_ = 0;
    int64_t rate_ppb_ = 0;
    bool rate_bad_ = false;
    int64_t rate_bad_since_ = 0;
    std::map<int, Lead> leads_;
    bool any_bad_ = false;
    int64_t last_bad_h_ = 0;
};

const char* reason_name(PcrValidator::Reason r);

struct StcEvent {
    enum class Kind { relock, degraded, recovered, envelope_step, leap, lead_clamp };
    Kind kind;
    const char* reason;   // static: the trigger, or the failing validator row
    int64_t house_ns;     // arrival of the sample that caused it
    uint32_t epoch;       // epoch in force after it
    int64_t value_ns;     // envelope_step: the step; leap: Δσ - Δh; lead_clamp: the lead
    int pid = -1;         // lead_clamp: the PID clamped; else the program
};

const char* event_name(StcEvent::Kind k);

// One program: the PCR lock, a warm lock on the caller's reference PID for
// degraded mode, the validator, and the epochs a straddling PES can still use.
class VirtualStc {
  public:
    enum class State { acquiring, locked, degraded, lost };
    struct Mapping {
        int64_t house_ns = 0;   // the arrival while !valid (no epoch yet)
        uint32_t epoch = 0;
        bool valid = false;
        // !valid: the live line, seeded on a backlog, lies more than lead_max_ns above its
        // floor, or more than backlog_ns above it and would put this PES that far ahead, which
        // the floor explains (B-39, B-48): stale.
        bool stale = false;
    };
    struct Stats {
        State state = State::acquiring;
        PcrValidator::Reason reason = PcrValidator::Reason::none;   // why degraded
        int64_t ppb = 0;
        int64_t offset_drift_ns = 0;
        ClockLock::Residual residual;
        int64_t pcr_interval_max_ns = 0;    // since the previous stats()
        uint64_t relocks = 0;
        uint32_t epoch = 0;
        bool cadence_warning = false;
        bool rate_warning = false;
    };
    struct LeadStats {
        int64_t min_ns = 0, median_ns = 0, max_ns = 0;
        uint32_t count = 0;
    };
    struct EpochInfo {
        uint32_t id;
        int64_t lo_ns, hi_ns;   // source range for the straddle rule
    };

    // OQ-11 (decided): R = [first - 1 s, last + 4 s]; ranges idle 10 s are dropped.
    static constexpr int64_t RANGE_BEFORE_NS = 1000000000;
    static constexpr int64_t RANGE_AFTER_NS = 4000000000LL;
    static constexpr int64_t RANGE_KEEP_NS = 10000000000LL;
    static constexpr int64_t LEAD_WINDOW_NS = 10000000000LL;   // per-PID lead telemetry
    // A clamp in force tells it again this often, so part 10's 60 s alarm holds with it.
    static constexpr int64_t LEAD_CLAMP_REPEAT_NS = 30000000000LL;

    explicit VirtualStc(const ClockLockConfig& clock = ClockLockConfig(),
                        const PcrValidatorConfig& pcr = PcrValidatorConfig());

    void feed_pcr(int64_t pcr27, bool discontinuity, int64_t arrival_ns);
    // The reference PID's PES (PCR PID if it carries PES, else first video, else
    // first audio). For video pass DTS when present, so no frame lands before
    // its arrival in degraded mode.
    void feed_ref_pes(int pid, int64_t pts90k_unwrapped, int64_t arrival_ns);
    Mapping map(int pid, int64_t pts90k_unwrapped, int64_t arrival_ns);
    // The PCR last fed, mapped as a PES is (the straddle rule, on a lead history of its
    // own) but outside the lead row: its lag is minus the delay above the floor, which
    // the envelope step judges, not a PTS-PCR lead (part 4.3). Invalid before a PCR.
    Mapping map_pcr(int64_t arrival_ns);
    void tick(int64_t now_ns);
    void relock();   // external trigger (the PMT's PCR PID changed): the next PCR opens an epoch
    State state() const;
    Stats stats();
    LeadStats lead(int pid) const;
    std::vector<EpochInfo> epochs() const;
    int64_t source_stc_90k() const;    // seed for the PES Unwrapper
    std::vector<StcEvent> take_events();

  private:
    enum class Src { pcr, ref };
    struct Epoch {
        uint32_t id;
        Src src;
        bool live;
        StcLine line;           // frozen copy once superseded
        int64_t lo, hi, last_h;
        bool stepped = false;   // closed by an envelope step: the floor moved, not the timeline
    };
    struct PidLeads {
        std::deque<std::pair<int64_t, int64_t>> w;   // (arrival, lead) under the output mapping
        bool has_before = false;
        int64_t before = 0;                         // median at the last epoch switch
    };
    // Degraded: a PID past lead_clamp_ns on its own lower envelope, until the program recovers.
    struct Clamp {
        explicit Clamp(const ClockLockConfig& c) : lock(c) {}
        ClockLock lock;
        uint32_t epoch = 0;       // its own: a timeline of its own for the PID's gap and guard
        bool have = false;
        int64_t sigma = 0, h = 0;  // its last PES, for the leap check
        int64_t lead_ns = 0;      // its lead under the reference mapping when clamped
        int64_t told_h = 0;       // the last lead_clamp event
    };
    static constexpr int PCR_KEY = -1;   // map_pcr's lead history: no PID is negative
    const ClockLock& lock_of(Src s) const { return s == Src::pcr ? pcr_ : ref_; }
    Mapping map_sigma(int pid, int64_t sigma, int64_t h, bool lead_row);
    bool stale(const ClockLock& lock, int64_t house, int64_t h) const;
    void clamp(int pid, int64_t sigma, int64_t h, Mapping& m);
    int64_t house_in(const Epoch& e, int64_t sigma) const;
    void freeze_current();
    void open_epoch(Src src, int64_t sigma, int64_t h, bool step = false);
    void grow_epoch(Src src, int64_t sigma, int64_t h);
    void check_failure(int64_t h);
    void enter_degraded(int64_t h);
    void try_recover(int64_t sigma, int64_t h);
    void emit(StcEvent::Kind k, const char* why, int64_t h, int64_t value, int pid = -1);

    ClockLock pcr_, ref_;
    PcrValidator val_;
    bool degraded_ = false;
    PcrValidator::Reason degraded_reason_ = PcrValidator::Reason::none;
    bool have_pcr_ = false;
    int64_t pcr_unwrapped_ = 0;      // 27 MHz
    bool pcr_pending_ = false;       // relocked: the next PCR opens an epoch
    const char* pcr_why_ = "";
    bool have_ref_ = false;
    int ref_pid_ = -1;
    int64_t ref_sigma_ = 0, ref_h_ = 0;
    bool ref_pending_ = false;       // degraded with a cold ref lock
    std::vector<Epoch> epochs_;
    uint32_t next_epoch_ = 1;
    std::map<int, PidLeads> leads_;
    std::map<int, Clamp> clamps_;
    std::vector<StcEvent> events_;
    uint64_t relocks_ = 0;
};

}  // namespace mrts
