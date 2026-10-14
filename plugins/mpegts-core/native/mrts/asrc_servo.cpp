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
    return c;
}

const char* asrc_event_name(AsrcEvent::Kind k) {
    return k == AsrcEvent::Kind::relock ? "relock" : "ratio-out-of-bounds";
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
    return std::max(2 * (n_in_ + drop_left_ - delay_) - 1, start2_);
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

AsrcServo::Command AsrcServo::push(int64_t pts_ns, uint32_t frames, bool discont) {
    const int64_t sigma = half_frames_ns(2 * n_in_, in_hz_);
    bool relocked = false;
    if (!started_) {   // a first buffer's DISCONT is no discontinuity
        started_ = true;
        lock_.feed(sigma, pts_ns);
        t0_ = lock_.house_of(sigma);
    } else {
        const char* why = nullptr;
        if (discont) {
            discont_in_++;
            lock_.relock(true);
            why = "discont";
        }
        lock_.feed(sigma, pts_ns);
        if (!why && lock_.envelope_step()) {
            // step_hold_ns of the new floor is measured: the lock moves onto it, where a
            // relock would start from this one PTS and its jitter.
            lock_.step_to_floor();
            why = "envelope-step";
        }
        if (why) {
            open_epoch(why);
            relocked = true;
        }
    }
    check_bounds(pts_ns);
    phase_err_ = measure_phase();
    const int64_t lim = cfg_.ratio_max_ppm * 1000;
    const int64_t p = clamp64(phase_err_, -9 * E9, 9 * E9);   // far past the clamp either way
    eps_cmd_ = clamp64(lock_.ppb() + floor_div(p * E9, cfg_.phase_tau_ns), -lim, lim);
    const uint32_t skip = (uint32_t)std::min<int64_t>(drop_left_, frames);
    drop_left_ -= skip;
    dropped_ += skip;
    n_in_ += frames;
    return Command{in_rate(), (int32_t)(out_hz_ * 1000), relocked, skip};
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
    return s;
}

std::vector<AsrcEvent> AsrcServo::take_events() {
    std::vector<AsrcEvent> out;
    out.swap(events_);
    return out;
}

}  // namespace mrts
