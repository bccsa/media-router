#include "asrc_servo.h"

#include <algorithm>
#include <climits>

namespace mrts {
namespace {

constexpr int64_t E9 = 1000000000;

// Floor semantics as ts_stc.cpp (its helpers are file-local there).
int64_t floor_div(int64_t a, int64_t b) {
    const int64_t q = a / b;
    return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q;
}

int64_t clamp64(int64_t v, int64_t lo, int64_t hi) { return v < lo ? lo : v > hi ? hi : v; }

int64_t iabs64(int64_t v) { return v < 0 ? -v : v; }

int64_t sat_sub(int64_t a, int64_t b) {
    if (b < 0 && a > INT64_MAX + b) return INT64_MAX;
    if (b > 0 && a < INT64_MIN + b) return INT64_MIN;
    return a - b;
}

// floor(h * 1e9 / (2 * hz)): a position in half frames as ns, without forming h * 1e9.
int64_t half_frames_ns(int64_t h, int64_t hz) {
    const int64_t d = 2 * hz, q = floor_div(h, d);
    return q * E9 + (h - q * d) * E9 / d;
}

}  // namespace

ClockLockConfig asrc_lock_config() {
    ClockLockConfig c;
    c.step_ns = 50000000;
    c.step_falls = true;
    c.backlog_ns = 0;   // a capture's PTS is its capture time: a fall is an envelope step
    c.step_fall_hold_ns = 0;   // so no backlog rule to hold either (B-95)
    return c;
}

const char* asrc_event_name(AsrcEvent::Kind k) {
    switch (k) {
        case AsrcEvent::Kind::relock: return "relock";
        case AsrcEvent::Kind::gap: return "gap";
        case AsrcEvent::Kind::shift: return "shift";
        default: return "ratio-out-of-bounds";
    }
}

const char* asrc_state_name(AsrcServo::State s) { return s == AsrcServo::State::locked ? "locked" : "acquiring"; }

AsrcServo::AsrcServo(int32_t in_hz, int32_t out_hz, const AsrcServoConfig& cfg)
    : cfg_(cfg), in_hz_(clamp64(in_hz, 1000, 768000)), out_hz_(clamp64(out_hz, 1000, 768000)), lock_(cfg.lock) {
    // Bounds that keep phase * 1e9 and the in_rate quotient in 64 bits and in_rate in 32.
    cfg_.phase_tau_ns = clamp64(cfg_.phase_tau_ns, E9, 1000 * E9);
    cfg_.ratio_max_ppm = clamp64(cfg_.ratio_max_ppm, 1, 100000);
}

int64_t AsrcServo::pts_at(uint64_t m) const { return t0_ + half_frames_ns(2 * (int64_t)m, out_hz_); }

// The resampler emits every output its input allows, so the next one sits within a frame
// of N - delay: its mean, N - delay - 1/2 (GStreamer's cubic table centres it 1/8 frame
// earlier still, 2.6 us at 48 kHz). Before the first output it is the epoch's first.
int64_t AsrcServo::next_pos2() const {
    // A drop still to come counts as made: the frames held back before it are the splice.
    return std::max(2 * (n_in_ + lost_ + drop_left_ - delay_) - 1, start2_);
}

// Input frames spanning `ns` of house time at the lock's rate, rounded down so the next
// output's content lies at most a frame before the end of the last.
int64_t AsrcServo::frames_over(int64_t ns) const {
    return clamp64(ns, 0, DROP_MAX_NS) * in_hz_ / (E9 + lock_.ppb());
}

int64_t AsrcServo::measure_phase() const {
    return sat_sub(lock_.house_of(half_frames_ns(next_pos2(), in_hz_)), next_pts());
}

// round(in_hz * 1000 / (1 + ε_cmd)): ratio steps of 1 / (in_hz * 1000). Never out_rate
// itself: at equal rates GStreamer copies samples unfiltered (setup_functions), 31 frames
// off the filtered path; one unit (0.02 ppm at 48 kHz) keeps the filter in place.
int32_t AsrcServo::in_rate() const {
    const int64_t num = in_hz_ * 1000 * E9, den = E9 + eps_cmd_;
    int64_t r = (2 * num + den) / (2 * den);
    if (r == out_hz_ * 1000) r += eps_cmd_ < 0 ? 1 : -1;
    return (int32_t)r;
}

AsrcServo::State AsrcServo::state() const {
    return lock_.phase() == ClockLock::Phase::locked ? State::locked : State::acquiring;
}

// The new T0 is where the lock puts the next output, never before the end of the last:
// the PTS only jumps forward (a gap downstream). Input captured before that end overlaps
// what left (the floor fell) and is dropped, as the ingest guard does (R18).
void AsrcServo::open_epoch(const char* why) {
    const int64_t end = next_pts();
    const int64_t at = lock_.house_of(half_frames_ns(next_pos2(), in_hz_));
    if (at < end) drop_left_ += frames_over(sat_sub(end, at));
    start2_ = next_pos2();
    m_ = 0;
    const int64_t first = lock_.house_of(half_frames_ns(start2_, in_hz_));
    t0_ = std::max(end, first);
    relocks_++;
    AsrcEvent e{AsrcEvent::Kind::relock, why, t0_, t0_ - end};
    e.dropped_ns = first - at;
    events_.push_back(e);
}

// Judged on the device rate fit, not on ε_cmd: acquisition and a relock's catch-up
// clamp ε_cmd for a while with the device well inside the range.
void AsrcServo::check_bounds(int64_t h) {
    if (!lock_.has_fit()) return;
    const int64_t f = lock_.fit_ppb(), af = f < 0 ? -f : f, lim = cfg_.ratio_max_ppm * 1000;
    if (!oob_ && af > lim) {
        oob_ = true;
        events_.push_back(AsrcEvent{AsrcEvent::Kind::ratio_out_of_bounds, "", h, f});
    } else if (oob_ && af < lim - lim / 10) {
        oob_ = false;
    }
}

// Lost time in input frames, to the nearest at the nominal rate: every capture of a driver loses
// the same frames for the same stamps (B-181).
int64_t AsrcServo::frames_in(int64_t ns) const {
    return (2 * clamp64(ns, 0, LOST_MAX_NS) * in_hz_ + E9) / (2 * E9);
}

// Lost cycles or time: the input position moves on by them, so the lock sees no step. Lost cycles
// jump the output their length on the lock's line, keeping the phase (B-180); lost time its frames
// at the nominal rate, the same in every capture of a driver, the phase servo taking the rest (B-181).
void AsrcServo::lose(int64_t frames, bool whole) {
    const int64_t before = lock_.house_of(half_frames_ns(2 * (n_in_ + lost_), in_hz_));
    lost_ += frames;
    const int64_t span = lock_.house_of(half_frames_ns(2 * (n_in_ + lost_), in_hz_)) - before;
    const int64_t from = next_pts();
    m_ += whole ? (uint64_t)((clamp64(span, 0, 2 * LOST_MAX_NS) * out_hz_ + E9 / 2) / E9)
                : (uint64_t)((2 * frames * out_hz_ + in_hz_) / (2 * in_hz_));
    gaps_++;
    AsrcEvent e{AsrcEvent::Kind::gap, whole ? "lost-cycle" : "lost-time", next_pts(), next_pts() - from};
    e.lost_frames = frames;
    events_.push_back(e);
}

// The duration a source stamped fits the frames to a frame; none (< 0) fits.
bool AsrcServo::fits(int64_t dur_ns, uint32_t frames) const {
    return dur_ns < 0 || iabs64(dur_ns - half_frames_ns(2 * (int64_t)frames, in_hz_)) <= E9 / in_hz_ + 1;
}

// cycle_input (B-180): this buffer's stamp against the end of the last one. Lost: whole cycles missing at
// a steady size, or a rise the lock would relock on (a driver restarted after a loss, B-181). A step where
// the size changes is the stamps'; a fall undoing the last gap at once a late stamp; else the lock's.
bool AsrcServo::check_cycle(int64_t pts_ns, uint32_t frames, int64_t dur_ns) {
    const int64_t pending = cycle_, pending_gap = cycle_gap_;
    cycle_ = 0;
    if (last_frames_ == 0 || frames == 0) return false;
    const int64_t len = half_frames_ns(2 * (int64_t)last_frames_, in_hz_);
    const int64_t gap = pts_ns - (last_pts_ + len);
    const int64_t tol = std::min(CYCLE_TOL_NS, len / 8);
    if (iabs64(gap) <= tol) return false;
    // A source whose durations fit its frames stamps a new cycle size on the buffers before their
    // frames show it; durations that never fit tell nothing (dur_trust_).
    if (frames != last_frames_ || (dur_trust_ && (!fits(dur_ns, frames) || !last_fit_))) {
        shift_ += gap;
        events_.push_back(AsrcEvent{AsrcEvent::Kind::shift, "cycle-size", pts_ns - shift_, gap});
        return false;
    }
    if (gap > 0) {
        const int64_t n = (gap + len / 2) / len;
        const bool whole = n >= 1 && iabs64(gap - n * len) <= tol;
        if (gap <= LOST_MAX_NS && (whole || gap >= lock_.config().step_ns)) {
            const int64_t lost = whole ? n * last_frames_ : frames_in(gap);
            lose(lost, whole);
            cycle_ = lost;
            cycle_gap_ = gap;
            return true;
        }
    } else if (pending > 0 && iabs64(gap + pending_gap) <= tol) {
        // Not lost after all: the frames come back off the input position, and as many are
        // dropped so the content returns to the labels the jump already gave out.
        lost_ -= pending;
        drop_left_ += pending;
        AsrcEvent e{AsrcEvent::Kind::gap, "reverted", pts_ns - shift_, 0};
        e.dropped_ns = half_frames_ns(2 * pending, in_hz_);
        e.lost_frames = -pending;
        events_.push_back(e);
    }
    return false;
}

AsrcServo::Command AsrcServo::push(int64_t pts_ns, uint32_t frames, bool discont, int64_t dur_ns) {
    bool relocked = false, gapped = false;
    if (!started_) {   // a first buffer's DISCONT is no discontinuity
        started_ = true;
        const int64_t sigma = half_frames_ns(2 * (n_in_ + lost_), in_hz_);
        lock_.feed(sigma, pts_ns);
        t0_ = lock_.house_of(sigma);
    } else {
        const char* why = nullptr;
        if (discont) {
            discont_in_++;
            lock_.relock(true);
            why = "discont";
            cycle_ = 0;
        } else if (cfg_.cycle_input) {
            gapped = check_cycle(pts_ns, frames, dur_ns);
        }
        lock_.feed(half_frames_ns(2 * (n_in_ + lost_), in_hz_), pts_ns - shift_);
        if (!why && lock_.envelope_step()) {
            // step_hold_ns of the new floor is measured: the lock moves onto it, where a
            // relock would start from this one PTS and its jitter.
            lock_.step_to_floor();
            why = "envelope-step";
        }
        if (why) {
            open_epoch(why);
            relocked = true;
            cycle_ = 0;
        }
    }
    if (frames > 0) {
        last_pts_ = pts_ns;
        last_frames_ = frames;
        last_fit_ = fits(dur_ns, frames);
        // Trusted after 8 fitting buffers in a row; a misfit lasting past a size change ends it.
        fit_run_ = last_fit_ ? std::min(fit_run_ + 1, 8) : 0;
        miss_run_ = last_fit_ ? 0 : std::min(miss_run_ + 1, 8);
        if (fit_run_ >= 8) dur_trust_ = true;
        if (miss_run_ > 4) dur_trust_ = false;
    }
    check_bounds(pts_ns - shift_);
    phase_err_ = measure_phase();
    const int64_t lim = cfg_.ratio_max_ppm * 1000;
    const int64_t p = clamp64(phase_err_, -9 * E9, 9 * E9);   // far past the clamp either way
    eps_cmd_ = clamp64(lock_.ppb() + floor_div(p * E9, cfg_.phase_tau_ns), -lim, lim);
    const uint32_t skip = (uint32_t)std::min<int64_t>(drop_left_, frames);
    drop_left_ -= skip;
    dropped_ += skip;
    n_in_ += frames;
    return Command{in_rate(), (int32_t)(out_hz_ * 1000), relocked, skip, gapped && !relocked};
}

void AsrcServo::produced(uint32_t frames) {
    n_out_ += frames;
    m_ += frames;
    phase_err_ = measure_phase();
}

AsrcServo::Stats AsrcServo::stats() const {
    Stats s;
    s.state = state();
    s.ratio_ppb = eps_cmd_;
    s.phase_err_ns = phase_err_;
    s.relocks = relocks_;
    s.in_frames = (uint64_t)n_in_;
    s.out_frames = n_out_;
    s.discont_in = discont_in_;
    s.dropped_frames = dropped_;
    s.gaps = gaps_;
    s.lost_frames = lost_;
    return s;
}

std::vector<AsrcEvent> AsrcServo::take_events() {
    std::vector<AsrcEvent> out;
    out.swap(events_);
    return out;
}

}  // namespace mrts
