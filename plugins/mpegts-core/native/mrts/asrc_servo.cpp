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

__int128 floor_div128(__int128 a, __int128 b) {
    const __int128 q = a / b;
    return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q;
}

int64_t iabs(int64_t v) { return v < 0 ? -v : v; }

int64_t sat_sub(int64_t a, int64_t b) {
    if (b < 0 && a > INT64_MAX + b) return INT64_MAX;
    if (b > 0 && a < INT64_MIN + b) return INT64_MIN;
    return a - b;
}

int64_t sat_add(int64_t a, int64_t b) {
    if (b > 0 && a > INT64_MAX - b) return INT64_MAX;
    if (b < 0 && a < INT64_MIN - b) return INT64_MIN;
    return a + b;
}

// floor(h * 1e9 / (2 * hz)): a position in half frames as ns, without forming h * 1e9.
int64_t half_frames_ns(int64_t h, int64_t hz) {
    const int64_t d = 2 * hz, q = floor_div(h, d);
    return q * E9 + (h - q * d) * E9 / d;
}

// g ns of house time on a clock whose lock reads e (house = (1 + e) x its time): how far that clock
// falls behind house time, floor(g e / (1 + e)), split so no product leaves 64 bits (|e| <= 1e8).
int64_t drift_over(int64_t g, int64_t e) {
    const int64_t d = E9 + e, q = floor_div(g, E9), r = g - q * E9;
    const int64_t c = q * e, qc = floor_div(c, d);
    return qc * E9 + floor_div((c - qc * d) * E9 + r * e, d);
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

ClockLockConfig asrc_device_lock_config() {
    ClockLockConfig c = asrc_lock_config();
    c.rate_buckets_max = 1000;
    c.rate_tau_ns = 1200 * E9;
    c.slew_track_ppm = 1000;
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
        case AsrcEvent::Kind::gap: return "gap";
        case AsrcEvent::Kind::shift: return "shift";
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
    return t0_ - t0_dev_ + half_frames_ns(2 * (int64_t)mh_, out_hz_) + mh_frac_ / out_hz_;
}

int64_t AsrcServo::label_next() const { return ended_ ? tail_pts_at(0) : next_pts(); }

int64_t AsrcServo::pos_ns(int64_t h2) const { return half_frames_ns(h2, in_hz_) + lost_res_; }

// Device mode: labels minus house time for an epoch whose first output's content is at house time h:
// what ran up since the sink's calibration, less the device's drift over the gap from the last
// content's end (B-148). 0 without the device term.
int64_t AsrcServo::offset_at(int64_t h) const {
    if (!cfg_.device) return 0;
    const int64_t hend = house_pts();
    const int64_t off = sat_sub(sat_sub(label_next(), hend), cal_off_);
    return sat_sub(off, drift_over(sat_sub(h, hend), dev_ppb_));
}

void AsrcServo::device_recalibrated() {
    if (cfg_.device) cal_off_ = sat_sub(label_next(), house_pts());
}

// House-rate frames: each output frame is 1 + ε_dev of them.
void AsrcServo::house_advance(uint32_t frames) {
    const int64_t f = mh_frac_ + (int64_t)frames * dev_ppb_;
    mh_ += (uint64_t)((int64_t)frames + floor_div(f, E9));
    mh_frac_ = f - floor_div(f, E9) * E9;
}

// The resampler emits every output its input allows, so the next one sits within a frame
// of N - delay: its mean, N - delay - 1/2 (GStreamer's cubic table centres it 1/8 frame
// earlier still, 2.6 us at 48 kHz). Before the first output it is the epoch's first.
int64_t AsrcServo::next_pos2() const {
    if (passing_) return 2 * (n_in_ + lost_);   // no resampler: the next buffer's first frame
    // A drop still to come counts as made: the frames held back before it are the splice.
    return std::max(2 * (n_in_ + lost_ + drop_left_ - delay_) - 1, start2_);
}

// Input frames spanning `ns` of house time at the lock's rate, rounded down so the next
// output's content lies at most a frame before the end of the last.
int64_t AsrcServo::frames_over(int64_t ns) const {
    return clamp64(ns, 0, DROP_MAX_NS) * in_hz_ / (E9 + lock_.ppb());
}

int64_t AsrcServo::measure_phase() const {
    if (!has_lock_) return 0;
    return sat_sub(lock_.house_of(pos_ns(next_pos2())), house_pts());
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
// clamp ε_cmd for a while with the device well inside the range. Decode modes: past the bound
// while locked for OOB_HOLD_NS (B-148); no fit length, as a source past the clamp keeps cutting it.
void AsrcServo::check_bounds(int64_t h) {
    if (!lock_.has_fit()) return;
    const int64_t f = lock_.fit_ppb(), af = f < 0 ? -f : f, lim = cfg_.ratio_max_ppm * 1000;
    bool past = af > lim;
    if (decode_) {
        if (past && lock_.phase() == ClockLock::Phase::locked) {
            if (!past_) {
                past_ = true;
                oob_since_ = h;
            }
        } else {
            past_ = false;
        }
        past = past_ && h - oob_since_ >= OOB_HOLD_NS;
    }
    if (!oob_ && past) {
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
    if (ended_) house_advance(frames);   // drained before the next push: the house end counts it (B-148)
}

// Decode and device modes: measured afresh from this buffer, labels from its PTS (on the device
// timeline with the device term). The jump is against the end of what left, the drained tail
// included (it may be negative here).
void AsrcServo::new_epoch(int64_t pts, const char* why) {
    const int64_t end = tail_pts_at(0), off = offset_at(pts);
    engaged_ = over_ = past_ = cont_ = false;
    passing_ = decode_ && !cfg_.device && in_hz_ == out_hz_;
    start2_ = 2 * (n_in_ + lost_);
    m_ = mh_ = 0;
    mh_frac_ = 0;
    t0_dev_ = off;
    cal_off_ = 0;
    t0_ = sat_add(pts, off);
    drop_left_ = 0;
    if (has_lock_) lock_.relock(false);
    relocks_++;
    events_.push_back(AsrcEvent{AsrcEvent::Kind::relock, why, t0_, t0_ - end});
}

// Decode modes, an envelope step: labels from where the lock now puts the next output (passing:
// this PTS), the bypass or engaged state kept, nothing drained.
void AsrcServo::step_epoch(int64_t pts) {
    const int64_t end = next_pts(), start2 = next_pos2();
    const int64_t h = passing_ ? pts : lock_.house_of(pos_ns(start2)), off = offset_at(h);
    start2_ = start2;
    m_ = mh_ = 0;
    mh_frac_ = 0;
    t0_dev_ = off;
    cal_off_ = 0;
    t0_ = sat_add(h, off);
    over_ = false;
    relocks_++;
    events_.push_back(AsrcEvent{AsrcEvent::Kind::relock, "envelope-step", t0_, t0_ - end});
}

void AsrcServo::engage(int64_t pts, const char* why, Command* cmd) {
    engaged_ = true;
    over_ = false;
    AsrcEvent e{AsrcEvent::Kind::engaged, why, pts, asrc_rate_of(lock_.ppb())};
    e.phase_ns = phase_err_;
    e.rate_known = lock_.rate_known();
    events_.push_back(e);
    if (!passing_) return;
    // The caller primes its resampler with what passed: its next output is this buffer's
    // first frame, labelled with its PTS.
    passing_ = false;
    cmd->engage = true;
    t0_ = pts;
    m_ = mh_ = 0;
    mh_frac_ = 0;
    start2_ = 2 * (n_in_ + lost_);
}

// Lost time in input frames, to the nearest at the nominal rate: every capture of a driver loses
// the same frames for the same stamps (B-181).
int64_t AsrcServo::frames_in(int64_t ns) const {
    return (2 * clamp64(ns, 0, LOST_MAX_NS) * in_hz_ + E9) / (2 * E9);
}

// Lost cycles or time: the input position moves on by them, so the lock sees no step. Lost cycles
// jump the output their length on the lock's line, keeping the phase (B-180); lost time its frames
// at the nominal rate, the same in every capture of a driver, the phase servo taking the rest (B-181).
void AsrcServo::lose(int64_t frames, bool whole, int64_t res_ns) {
    const int64_t before = lock_.house_of(half_frames_ns(2 * (n_in_ + lost_), in_hz_));
    lost_ += frames;
    lost_res_ += res_ns;
    const int64_t span = lock_.house_of(half_frames_ns(2 * (n_in_ + lost_), in_hz_)) - before;
    const int64_t from = next_pts();
    const uint64_t jump = whole ? (uint64_t)((clamp64(span, 0, 2 * LOST_MAX_NS) * out_hz_ + E9 / 2) / E9)
                                : (uint64_t)((2 * frames * out_hz_ + in_hz_) / (2 * in_hz_));
    m_ += jump;
    mh_ += jump;   // the phase reads the house-rate counter: capture mode's is m_ itself
    t0_ += res_ns;   // decode modes: the hole's part under a frame too (B-148)
    if (cfg_.device) {   // the labels shift by the device's drift over the hole, the house counter not
        const int64_t dr = drift_over(half_frames_ns(2 * (int64_t)jump, out_hz_) + res_ns, dev_ppb_);
        t0_ -= dr;
        t0_dev_ -= dr;
    }
    gaps_++;
    AsrcEvent e{AsrcEvent::Kind::gap, whole ? "lost-cycle" : "lost-time", next_pts(), next_pts() - from};
    e.lost_frames = frames;
    events_.push_back(e);
}

// Decode modes (B-148): this buffer's PTS against the last one's end past the bound (the phase bound, or an
// upstream acquire slew's 2000 ppm of the last span), after a buffer that continued its own: up to LOST_MAX_NS
// lost time, back a break, else 0. A source off its rate past the bound steps every buffer: the lock's.
int64_t AsrcServo::content_step(int64_t pts_ns) {
    if (!decode_ || last_frames_ == 0) return 0;
    const int64_t span = half_frames_ns(2 * (int64_t)last_frames_, in_hz_);
    const int64_t d = sat_sub(pts_ns, sat_add(last_pts_, span));
    const int64_t bound = std::max(cfg_.bypass_phase_ns, span / 500);
    const bool cont = cont_;
    cont_ = d >= -bound && d <= bound;
    return cont && ((d > bound && d <= LOST_MAX_NS) || d < -bound) ? d : 0;
}

// The duration a source stamped fits the frames to a frame; none (< 0) fits.
bool AsrcServo::fits(int64_t dur_ns, uint32_t frames) const {
    return dur_ns < 0 || iabs(dur_ns - half_frames_ns(2 * (int64_t)frames, in_hz_)) <= E9 / in_hz_ + 1;
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
    if (iabs(gap) <= tol) return false;
    // A source whose durations fit its frames stamps a new cycle size on the buffers before their
    // frames show it; durations that never fit tell nothing (dur_trust_).
    if (frames != last_frames_ || (dur_trust_ && (!fits(dur_ns, frames) || !last_fit_))) {
        shift_ += gap;
        events_.push_back(AsrcEvent{AsrcEvent::Kind::shift, "cycle-size", pts_ns - shift_, gap});
        return false;
    }
    if (gap > 0) {
        const int64_t n = (gap + len / 2) / len;
        const bool whole = n >= 1 && iabs(gap - n * len) <= tol;
        if (gap <= LOST_MAX_NS && (whole || gap >= lock_.config().step_ns)) {
            const int64_t lost = whole ? n * last_frames_ : frames_in(gap);
            lose(lost, whole);
            cycle_ = lost;
            cycle_gap_ = gap;
            return true;
        }
    } else if (pending > 0 && iabs(gap + pending_gap) <= tol) {
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

AsrcServo::Command AsrcServo::push(int64_t pts_ns, uint32_t frames, bool discont, int64_t device_ppb,
                                   int64_t dur_ns) {
    const int64_t lim = cfg_.ratio_max_ppm * 1000;
    dev_ppb_ = cfg_.device ? clamp64(device_ppb, -lim, lim) : 0;
    const int64_t sigma = pos_ns(2 * (n_in_ + lost_));
    const int64_t step = !capture_ && started_ && !discont && !ended_ ? content_step(pts_ns) : 0;
    bool relocked = false, drain = false, gapped = false;
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
    } else if (!started_) {
        started_ = true;
        t0_ = pts_ns;
        start2_ = 2 * (n_in_ + lost_);
        if (has_lock_) lock_.feed(sigma, pts_ns);
    } else if (discont || ended_) {
        // The content breaks: measured afresh, labels from this PTS.
        if (discont) discont_in_++;
        drain = end_epoch();
        new_epoch(pts_ns, discont ? "discont" : "gap");
        if (has_lock_) lock_.feed(sigma, pts_ns);
        relocked = true;
    } else if (step < 0) {
        // B-148: the content time stepped back past the bound, unflagged: a break.
        drain = end_epoch();
        new_epoch(pts_ns, "jump");
        lock_.feed(sigma, pts_ns);
        relocked = true;
    } else if (has_lock_) {
        if (step > 0) {
            // B-148: a hole past the bound, unflagged: lost content time, the output jumping it
            // (DISCONT on resampled output, same epoch), its part under a frame too.
            const int64_t lost = frames_in(step);
            const int64_t span = half_frames_ns(2 * (n_in_ + lost_ + lost), in_hz_) -
                                 half_frames_ns(2 * (n_in_ + lost_), in_hz_);
            lose(lost, false, step - span);
            gapped = true;
        }
        lock_.feed(pos_ns(2 * (n_in_ + lost_)), pts_ns);
        if (lock_.envelope_step()) {
            // The timeline stepped, the content did not: the lock onto the new floor, the labels
            // re-anchored on it, the resampler kept.
            lock_.step_to_floor();
            step_epoch(pts_ns);
            relocked = true;
        }
    }
    ended_ = false;
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
    if (has_lock_) check_bounds(pts_ns - shift_);
    phase_err_ = measure_phase();
    Command cmd{0, (int32_t)(out_hz_ * 1000), relocked, 0};
    cmd.drain = drain;
    cmd.gap = gapped && !relocked;
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
    house_advance(frames);
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
    s.gaps = gaps_;
    s.lost_frames = lost_;
    s.mode = mode();
    s.source_ppb = has_lock_ ? asrc_rate_of(lock_.ppb()) : 0;
    s.decode_ppb = eps_cmd_;
    s.rate_known = has_lock_ && lock_.rate_known();
    return s;
}

std::vector<AsrcEvent> AsrcServo::take_events() {
    std::vector<AsrcEvent> out;
    out.swap(events_);
    return out;
}

// --- the device term (py/asrc_device_ref.py's DeviceTerm and RenderLateness, B-165/B-166) -----------------

const char* asrc_device_event_name(AsrcDeviceEvent::Kind k) {
    switch (k) {
        case AsrcDeviceEvent::Kind::relock_device: return "relock-device";
        case AsrcDeviceEvent::Kind::device_stalled: return "device-stalled";
        case AsrcDeviceEvent::Kind::device_resumed: return "device-resumed";
    }
    return "";
}

const char* asrc_device_lock_state_name(AsrcDeviceTerm::LockState s) {
    switch (s) {
        case AsrcDeviceTerm::LockState::idle: return "idle";
        case AsrcDeviceTerm::LockState::settle: return "settle";
        case AsrcDeviceTerm::LockState::acquiring: return "acquiring";
        case AsrcDeviceTerm::LockState::locked: return "locked";
        case AsrcDeviceTerm::LockState::lost: return "lost";
    }
    return "";
}

int64_t asrc_device_ratio(int64_t eps_in_ppb, int64_t eps_dev_ppb, int64_t max_ppm) {
    const __int128 num = (__int128)(E9 + eps_in_ppb) * E9, den = E9 + eps_dev_ppb;
    const __int128 q = (2 * num + den) / (2 * den);   // both positive: floor
    const int64_t lim = max_ppm * 1000;
    return clamp64((int64_t)(q - E9), -lim, lim);
}

AsrcDeviceTerm::AsrcDeviceTerm(const AsrcDeviceConfig& cfg) : cfg_(cfg), lock_(cfg.lock) {
    wait_frames_ = cfg_.waiting_ns * cfg_.rate_hz / E9;
    resume_frames_ = cfg_.resume_ns * cfg_.rate_hz / E9;
}

void AsrcDeviceTerm::start(int64_t mono, std::vector<AsrcDeviceEvent>* events) {
    if (rendering_) return;
    rendering_ = true;
    have_prev_ = moved_ = false;
    beyond_ = 0;
    if (!epoch_) return;
    lock_.relock(true);
    relocks_restart_++;
    recal_ = true;
    events->push_back(AsrcDeviceEvent{AsrcDeviceEvent::Kind::relock_device, "restart", mono, 0});
}

void AsrcDeviceTerm::stop(int64_t) {
    rendering_ = false;
    have_prev_ = stalled_ = waiting_ = have_taken_ = false;
}

void AsrcDeviceTerm::relock_step(int64_t mono, int64_t step_ns, std::vector<AsrcDeviceEvent>* events) {
    lock_.relock(true);
    relocks_step_++;
    recal_ = true;
    events->push_back(AsrcDeviceEvent{AsrcDeviceEvent::Kind::relock_device, "step", mono, step_ns});
    moved_ = true;
    moved_at_ = mono;
    beyond_ = 0;
}

bool AsrcDeviceTerm::take_recalibrated() {
    const bool r = recal_;
    recal_ = false;
    return r;
}

// A flat read is never fed: a clock that stalls must not read as a slow device. The lock starts settle_ns
// after the clock first moves (and after a relock); a fed read past relock_ns relock_samples times in a
// row, or the lock's own envelope step, is a step of the device's clock.
void AsrcDeviceTerm::clock(int64_t dev, int64_t mono, std::vector<AsrcDeviceEvent>* events) {
    const bool had = have_prev_;
    const int64_t pdev = prev_dev_, pmono = prev_mono_;
    have_prev_ = true;
    prev_dev_ = dev;
    prev_mono_ = mono;
    if (!had) return;
    const int64_t dd = dev - pdev, dm = mono - pmono;
    if (dm <= 0 || dd * cfg_.flat_den <= dm) {
        flat_ns_ += std::max<int64_t>(dm, 0);
        return;
    }
    if (!moved_) {
        moved_ = true;
        moved_at_ = mono;
        return;
    }
    if (mono - moved_at_ < cfg_.settle_ns) return;
    if (lock_.started()) {
        const int64_t r = mono - lock_.house_of(dev);
        if (r > cfg_.relock_ns || r < -cfg_.relock_ns) {
            if (++beyond_ >= cfg_.relock_samples) relock_step(mono, r, events);
            return;
        }
        beyond_ = 0;
    }
    lock_.feed(dev, mono);
    epoch_ = true;
    fed_++;
    if (lock_.envelope_step()) relock_step(mono, lock_.step_size_ns(), events);
}

// Device stall (the owner's Q2, skip and resume live), read on the render: stalled once the sink took nothing
// for stall_ns while frames waited past waiting_ns; then a flush every probe_ns, and resumed once it took past
// an empty ring since the last flush, with one more flush. What the flushes discard is dropped.
bool AsrcDeviceTerm::render(int64_t mono, int64_t pushed, int64_t taken, std::vector<AsrcDeviceEvent>* events) {
    const bool had = have_taken_;
    const int64_t prev = taken_prev_;
    have_taken_ = true;
    taken_prev_ = taken;
    const int64_t pending = pushed - taken - discarded_;
    bool flush = false;
    if (!stalled_) {
        if (!had || taken > prev || pending <= wait_frames_) {
            waiting_ = false;
        } else if (!waiting_) {
            waiting_ = true;
            wait_since_ = mono;
        } else if (mono - wait_since_ >= cfg_.stall_ns) {
            stalled_ = true;
            stalls_++;
            events->push_back(AsrcDeviceEvent{AsrcDeviceEvent::Kind::device_stalled, "", mono, pending});
            flush = true;
        }
    } else if (taken - taken_at_flush_ > resume_frames_) {
        stalled_ = waiting_ = false;
        events->push_back(AsrcDeviceEvent{AsrcDeviceEvent::Kind::device_resumed, "", mono, dropped_ + pending});
        flush = true;
    } else if (mono - flush_at_ >= cfg_.probe_ns) {
        // What the sink took since the last flush sat in a ring the stopped device never read.
        dropped_ += taken - taken_at_flush_;
        flush = true;
    }
    if (flush) {
        dropped_ += pending;
        discarded_ += pending;
        flush_at_ = mono;
        taken_at_flush_ = taken;
        flushes_++;
    }
    return flush;
}

bool AsrcDeviceTerm::sample(int64_t dev_ns, int64_t mono_ns, int64_t pushed, int64_t rendered,
                            std::vector<AsrcDeviceEvent>* events) {
    if (!rendering_) return false;   // read only between start() and stop()
    clock(dev_ns, mono_ns, events);
    const bool flush = pushed >= 0 && rendered >= 0 && render(mono_ns, pushed, rendered, events);
    lock_.tick(mono_ns);
    return flush;
}

int64_t AsrcDeviceTerm::device_ppb() const { return lock_.rate_known() ? lock_.ppb() : 0; }

int64_t AsrcDeviceTerm::ratio_ppb(int64_t eps_in_ppb) const {
    return asrc_device_ratio(eps_in_ppb, device_ppb(), cfg_.ratio_max_ppm);
}

AsrcDeviceTerm::LockState AsrcDeviceTerm::lock_state() const {
    if (!rendering_ || !moved_) return LockState::idle;
    if (!lock_.started()) return LockState::settle;
    switch (lock_.phase()) {
        case ClockLock::Phase::locked: return LockState::locked;
        case ClockLock::Phase::lost: return LockState::lost;
        default: return LockState::acquiring;
    }
}

AsrcDeviceTerm::Stats AsrcDeviceTerm::stats() const {
    Stats s;
    s.device_ppb = device_ppb();
    s.device_rate_ppb = asrc_rate_of(s.device_ppb);
    s.relocks_restart = relocks_restart_;
    s.relocks_step = relocks_step_;
    s.device_stalls = stalls_;
    s.dropped = dropped_;
    s.flushes = flushes_;
    s.flat_ns = flat_ns_;
    s.fed = fed_;
    return s;
}

void AsrcRenderLateness::rendered(int64_t write_pos, int64_t frames, int64_t pts_ns) {
    if (!map_.empty() && write_pos < map_.back().write_pos + map_.back().frames)
        map_.clear();   // the ring started again (a restart) or was written over
    map_.push_back(Seg{write_pos, frames, pts_ns});
}

bool AsrcRenderLateness::at(int64_t now_ns, int64_t dev_ns, int64_t* lateness_ns) {
    const int64_t pos = (int64_t)floor_div128((__int128)dev_ns * rate_, E9);
    while (!map_.empty() && map_.front().write_pos + map_.front().frames <= pos) map_.pop_front();
    if (map_.empty() || map_.front().write_pos > pos) return false;
    const Seg& s = map_.front();
    *lateness_ns = now_ns - (s.pts + (int64_t)floor_div128((__int128)(pos - s.write_pos) * E9, rate_));
    return true;
}

}  // namespace mrts
