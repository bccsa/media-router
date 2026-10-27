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

int64_t iabs(int64_t v) { return v < 0 ? -v : v; }

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

ClockLockConfig asrc_decode_lock_config() {
    ClockLockConfig c = asrc_lock_config();
    c.rate_buckets_min = 10;
    return c;
}

AsrcServoConfig asrc_decode_config(int64_t bypass_ppb, bool device) {
    AsrcServoConfig c;
    c.lock = asrc_decode_lock_config();
    c.bypass_ppb = bypass_ppb;
    c.device = device;
    return c;
}

const char* asrc_event_name(AsrcEvent::Kind k) {
    switch (k) {
        case AsrcEvent::Kind::relock: return "relock";
        case AsrcEvent::Kind::ratio_out_of_bounds: return "ratio-out-of-bounds";
        case AsrcEvent::Kind::engaged: return "engaged";
    }
    return "";
}

const char* asrc_state_name(AsrcServo::State s) { return s == AsrcServo::State::locked ? "locked" : "acquiring"; }

const char* asrc_mode_name(AsrcServo::Mode m) {
    switch (m) {
        case AsrcServo::Mode::capture: return "capture";
        case AsrcServo::Mode::bypass: return "bypass";
        case AsrcServo::Mode::decode: return "decode";
        case AsrcServo::Mode::device: return "device";
        case AsrcServo::Mode::decode_device: return "decode+device";
    }
    return "";
}

int64_t asrc_rate_of(int64_t eps_ppb) {
    const int64_t e = clamp64(eps_ppb, -E9 / 2, E9 / 2);
    return floor_div(-2 * e * E9 + E9 + e, 2 * (E9 + e));
}

AsrcServo::AsrcServo(int32_t in_hz, int32_t out_hz, const AsrcServoConfig& cfg)
    : cfg_(cfg), in_hz_(clamp64(in_hz, 1000, 768000)), out_hz_(clamp64(out_hz, 1000, 768000)), lock_(cfg.lock) {
    // Bounds that keep phase * 1e9 and the in_rate quotient in 64 bits and in_rate in 32.
    cfg_.phase_tau_ns = clamp64(cfg_.phase_tau_ns, E9, 1000 * E9);
    cfg_.ratio_max_ppm = clamp64(cfg_.ratio_max_ppm, 1, 100000);
    cfg_.bypass_ppb = clamp64(cfg_.bypass_ppb, 0, 1000 * 1000);
    decode_ = cfg_.bypass_ppb > 0;
    capture_ = !decode_ && !cfg_.device;
    has_lock_ = !(cfg_.device && !decode_);
    passing_ = decode_ && !cfg_.device && in_hz_ == out_hz_;
}

int64_t AsrcServo::pts_at(uint64_t m) const { return t0_ + half_frames_ns(2 * (int64_t)m, out_hz_); }

int64_t AsrcServo::tail_pts_at(uint64_t k) const {
    return tail_t0_ + half_frames_ns(2 * (int64_t)(tail_m_ + k), out_hz_);
}

// The device term runs the output off house rate; its label of the next output is next_pts().
int64_t AsrcServo::house_pts() const {
    return t0_ + half_frames_ns(2 * (int64_t)mh_, out_hz_) + mh_frac_ / out_hz_;
}

// The resampler emits every output its input allows, so the next one sits within a frame
// of N - delay: its mean, N - delay - 1/2 (GStreamer's cubic table centres it 1/8 frame
// earlier still, 2.6 us at 48 kHz). Before the first output it is the epoch's first.
int64_t AsrcServo::next_pos2() const {
    if (passing_) return 2 * n_in_;   // no resampler: the next buffer's first frame
    // A drop still to come counts as made: the frames held back before it are the splice.
    return std::max(2 * (n_in_ + drop_left_ - delay_) - 1, start2_);
}

// Input frames spanning `ns` of house time at the lock's rate, rounded down so the next
// output's content lies at most a frame before the end of the last.
int64_t AsrcServo::frames_over(int64_t ns) const {
    return clamp64(ns, 0, DROP_MAX_NS) * in_hz_ / (E9 + lock_.ppb());
}

int64_t AsrcServo::measure_phase() const {
    if (!has_lock_) return 0;
    return sat_sub(lock_.house_of(half_frames_ns(next_pos2(), in_hz_)), house_pts());
}

// The commanded out/in against nominal, minus 1: the decode term times the device term.
int64_t AsrcServo::ratio_ppb() const {
    const int64_t d = E9 + dev_ppb_;
    return floor_div((E9 + eps_cmd_) * E9 + d / 2, d) - E9;
}

// round(in_hz * 1000 * (1 + ε_dev) / (1 + ε_cmd)): ratio steps of 1 / (in_hz * 1000). Never
// out_rate itself: at equal rates GStreamer copies samples unfiltered (setup_functions), 31
// frames off the filtered path; one unit (0.02 ppm at 48 kHz) keeps the filter in place.
int32_t AsrcServo::in_rate() const {
    const int64_t num = in_hz_ * 1000 * (E9 + dev_ppb_), den = E9 + eps_cmd_;
    int64_t r = (2 * num + den) / (2 * den);
    if (r == out_hz_ * 1000) r += ratio_ppb() < 0 ? 1 : -1;
    return (int32_t)r;
}

AsrcServo::State AsrcServo::state() const {
    return lock_.phase() == ClockLock::Phase::locked ? State::locked : State::acquiring;
}

AsrcServo::Mode AsrcServo::mode() const {
    if (capture_) return Mode::capture;
    if (!decode_) return Mode::device;
    if (cfg_.device) return engaged_ ? Mode::decode_device : Mode::device;
    return engaged_ ? Mode::decode : Mode::bypass;
}

// The new T0 is where the lock puts the next output, never before the end of the last:
// the PTS only jumps forward (a gap downstream). Input captured before that end overlaps
// what left (the floor fell) and is dropped, as the ingest guard does (R18).
void AsrcServo::open_epoch(const char* why) {
    const int64_t end = next_pts();
    const int64_t at = lock_.house_of(half_frames_ns(next_pos2(), in_hz_));
    if (at < end) drop_left_ += frames_over(sat_sub(end, at));
    start2_ = next_pos2();
    m_ = mh_ = 0;
    mh_frac_ = 0;
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

bool AsrcServo::end_epoch() {
    if (capture_ || !started_ || ended_) return false;
    ended_ = true;
    tail_t0_ = t0_;
    tail_m_ = m_;
    return !passing_;
}

void AsrcServo::tail_produced(uint32_t frames) {
    tail_m_ += frames;
    n_out_ += frames;
}

// Decode and device modes: measured afresh from this buffer, labels from its PTS. The jump is
// against the end of what left, the drained tail included (it may be negative here).
void AsrcServo::new_epoch(int64_t pts, const char* why) {
    const int64_t end = tail_pts_at(0);
    engaged_ = over_ = false;
    passing_ = decode_ && !cfg_.device && in_hz_ == out_hz_;
    start2_ = 2 * n_in_;
    m_ = mh_ = 0;
    mh_frac_ = 0;
    t0_ = pts;
    drop_left_ = 0;
    if (has_lock_) lock_.relock(false);
    relocks_++;
    events_.push_back(AsrcEvent{AsrcEvent::Kind::relock, why, t0_, t0_ - end});
}

// Decode modes, an envelope step: labels from where the lock now puts the next output (passing:
// this PTS), the bypass or engaged state kept, nothing drained.
void AsrcServo::step_epoch(int64_t pts) {
    const int64_t end = next_pts();
    start2_ = next_pos2();
    m_ = mh_ = 0;
    mh_frac_ = 0;
    t0_ = passing_ ? pts : lock_.house_of(half_frames_ns(start2_, in_hz_));
    over_ = false;
    relocks_++;
    events_.push_back(AsrcEvent{AsrcEvent::Kind::relock, "envelope-step", t0_, t0_ - end});
}

void AsrcServo::engage(int64_t pts, const char* why, Command* cmd) {
    engaged_ = true;
    over_ = false;
    AsrcEvent e{AsrcEvent::Kind::engaged, why, pts, asrc_rate_of(lock_.ppb())};
    e.phase_ns = phase_err_;
    events_.push_back(e);
    if (!passing_) return;
    // The caller primes its resampler with what passed: its next output is this buffer's
    // first frame, labelled with its PTS.
    passing_ = false;
    cmd->engage = true;
    t0_ = pts;
    m_ = mh_ = 0;
    mh_frac_ = 0;
    start2_ = 2 * n_in_;
}

AsrcServo::Command AsrcServo::push(int64_t pts_ns, uint32_t frames, bool discont, int64_t device_ppb) {
    const int64_t lim = cfg_.ratio_max_ppm * 1000;
    dev_ppb_ = cfg_.device ? clamp64(device_ppb, -lim, lim) : 0;
    const int64_t sigma = half_frames_ns(2 * n_in_, in_hz_);
    bool relocked = false, drain = false;
    if (capture_) {
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
    } else if (!started_) {
        started_ = true;
        t0_ = pts_ns;
        start2_ = 2 * n_in_;
        if (has_lock_) lock_.feed(sigma, pts_ns);
    } else if (discont || ended_) {
        // The content breaks: measured afresh, labels from this PTS.
        if (discont) discont_in_++;
        drain = end_epoch();
        new_epoch(pts_ns, discont ? "discont" : "gap");
        if (has_lock_) lock_.feed(sigma, pts_ns);
        relocked = true;
    } else if (has_lock_) {
        lock_.feed(sigma, pts_ns);
        if (lock_.envelope_step()) {
            // The timeline stepped, the content did not: the lock onto the new floor, the labels
            // re-anchored on it, the resampler kept.
            lock_.step_to_floor();
            step_epoch(pts_ns);
            relocked = true;
        }
    }
    ended_ = false;
    if (has_lock_) check_bounds(pts_ns);
    phase_err_ = measure_phase();
    Command cmd{0, (int32_t)(out_hz_ * 1000), relocked, 0};
    cmd.drain = drain;
    if (decode_ && !engaged_) {
        // Engage once |ε| has stayed past the bound for the hold while locked, or the phase passed.
        if (lock_.phase() == ClockLock::Phase::locked && iabs(lock_.ppb()) > cfg_.bypass_ppb) {
            if (!over_) {
                over_ = true;
                over_since_ = pts_ns;
            }
            if (pts_ns - over_since_ >= cfg_.bypass_hold_ns) engage(pts_ns, "ratio", &cmd);
        } else {
            over_ = false;
        }
        if (!engaged_ && iabs(phase_err_) > cfg_.bypass_phase_ns) engage(pts_ns, "phase", &cmd);
        if (engaged_) phase_err_ = measure_phase();
    }
    if (capture_ || engaged_) {
        const int64_t p = clamp64(phase_err_, -9 * E9, 9 * E9);   // far past the clamp either way
        eps_cmd_ = clamp64(lock_.ppb() + floor_div(p * E9, cfg_.phase_tau_ns), -lim, lim);
    } else {
        eps_cmd_ = 0;
    }
    const uint32_t skip = (uint32_t)std::min<int64_t>(drop_left_, frames);
    drop_left_ -= skip;
    dropped_ += skip;
    n_in_ += frames;
    cmd.in_rate = in_rate();
    cmd.skip = skip;
    cmd.pass = passing_;
    return cmd;
}

void AsrcServo::produced(uint32_t frames) {
    n_out_ += frames;
    m_ += frames;
    // House-rate frames: each output frame is 1 + ε_dev of them.
    const int64_t f = mh_frac_ + (int64_t)frames * dev_ppb_;
    mh_ += (uint64_t)((int64_t)frames + floor_div(f, E9));
    mh_frac_ = f - floor_div(f, E9) * E9;
    phase_err_ = measure_phase();
}

AsrcServo::Stats AsrcServo::stats() const {
    Stats s;
    s.state = state();
    s.ratio_ppb = ratio_ppb();
    s.phase_err_ns = phase_err_;
    s.relocks = relocks_;
    s.in_frames = (uint64_t)n_in_;
    s.out_frames = n_out_;
    s.discont_in = discont_in_;
    s.dropped_frames = dropped_;
    s.mode = mode();
    s.source_ppb = has_lock_ ? asrc_rate_of(lock_.ppb()) : 0;
    s.decode_ppb = eps_cmd_;
    return s;
}

std::vector<AsrcEvent> AsrcServo::take_events() {
    std::vector<AsrcEvent> out;
    out.swap(events_);
    return out;
}

AsrcDeviceLock::AsrcDeviceLock(const ClockLockConfig& cfg) : lock_(cfg) {}

// A step of the device clock against house (a sink that skipped) moves the lock onto its floor,
// keeping the rate: only the rate is used.
void AsrcDeviceLock::feed(int64_t itime_ns, int64_t etime_ns, int64_t read_ns) {
    const int64_t h = etime_ns + std::max<int64_t>(read_ns, 0);
    if (!have_first_) {
        have_first_ = true;
        first_ns_ = h;
    }
    if (h - first_ns_ < SETTLE_NS) return;
    lock_.feed(itime_ns, h);
    if (lock_.envelope_step()) lock_.step_to_floor();
}

void AsrcDeviceLock::discont() {
    lock_.relock(true);
    relocks_++;
    have_first_ = false;
}

}  // namespace mrts
