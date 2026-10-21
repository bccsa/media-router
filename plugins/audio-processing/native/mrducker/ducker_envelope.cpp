#include "ducker_envelope.h"

#include <algorithm>
#include <cmath>

namespace mrducker {

const char* phase_name(Phase p) {
    switch (p) {
        case Phase::attack: return "attack";
        case Phase::hold: return "hold";
        case Phase::release: return "release";
        default: return "idle";
    }
}

bool DuckerEnvelope::advance(double key_db, double dt_ms, const DuckerParams& p) {
    const double floor = p.depth_db;
    const double attack = std::max(1.0, p.attack_ms);
    const double release = std::max(1.0, p.release_ms);
    const double hold = std::max(0.0, p.hold_ms);

    // The hold runs on the whole interval, the ramp on at most MAX_STEP_MS of it.
    const double dt_in = std::max(0.0, dt_ms);
    now_ms_ += dt_in;
    const double dt = std::min(MAX_STEP_MS, dt_in);

    key_db_ = key_db;
    if (key_db > p.threshold_db) active_ms_ = now_ms_;
    const bool active = key_db > p.threshold_db || now_ms_ - active_ms_ < hold;
    const double target = active ? floor : 0;

    if (db_ > target) {
        db_ = std::max(target, db_ - std::fabs(floor) / attack * dt);
    } else if (db_ < target) {
        db_ = std::min(target, db_ + std::fabs(floor) / release * dt);
    }
    // Direction of travel, not elapsed time: at the floor while the key is live is the hold.
    phase_ = target < 0 ? (db_ > target ? Phase::attack : Phase::hold)
                        : (db_ < 0 ? Phase::release : Phase::idle);

    const double gain = std::pow(10.0, db_ / 20);
    if (std::fabs(gain - set_gain_) <= GAIN_EPSILON) return false;
    set_gain_ = gain;
    return true;
}

double KeyMeter::take_db() {
    const double ms = frames_ ? std::max(sum_a_, sum_b_) / (double)frames_ : 0.0;
    sum_a_ = sum_b_ = 0;
    frames_ = 0;
    const double db = ms > 0 ? 10 * std::log10(ms) : FLOOR_DB;
    return std::max(FLOOR_DB, db);
}

void DuckerCore::set_rate(int rate) {
    rate_ = rate > 0 ? rate : 48000;
    window_ = std::max<size_t>(1, (size_t)std::lround(rate_ * WINDOW_MS / 1000));
    report_frames_ = std::max<uint64_t>(1, (uint64_t)std::llround(rate_ * REPORT_MS / 1000));
    reset();
}

void DuckerCore::reset() {
    meter_ = KeyMeter();
    env_.reset();
    g_ = target_ = step_ = 1;
    ramp_left_ = 0;
    total_ = 0;
    next_report_ = report_frames_;
}

DuckerCore::Reading DuckerCore::take(size_t at, const DuckerParams& p) {
    const double dt = meter_.frames() * 1000.0 / rate_;
    const double key = meter_.take_db();
    if (env_.advance(key, dt, p)) {
        // A geometric ramp is straight in dB; its last frame lands on the target exactly.
        target_ = env_.gain();
        step_ = std::pow(target_ / g_, 1.0 / (double)window_);
        ramp_left_ = window_;
    }
    Reading r{at, dt, key, env_.gain_db(), env_.phase(), false};
    if (total_ >= next_report_) {
        r.report = true;
        while (next_report_ <= total_) next_report_ += report_frames_;
    }
    return r;
}

void DuckerCore::process(const float* in, float* out, size_t frames, bool silent,
                         const DuckerParams& p, std::vector<Reading>* readings) {
    for (size_t i = 0; i < frames; i++) {
        if (ramp_left_ > 0) {
            if (--ramp_left_ == 0) g_ = target_;
            else g_ *= step_;
        }
        if (silent) {
            out[2 * i] = out[2 * i + 1] = 0.0f;
            meter_.add(0.0f, 0.0f);
        } else {
            const float* f = in + 4 * i;
            out[2 * i] = (float)(f[0] * g_);
            out[2 * i + 1] = (float)(f[1] * g_);
            meter_.add(f[2], f[3]);
        }
        total_++;
        if (meter_.frames() < window_) continue;
        const Reading r = take(i + 1, p);
        if (readings) readings->push_back(r);
    }
}

bool DuckerCore::finish(const DuckerParams& p, Reading* r) {
    if (meter_.frames() == 0) return false;
    *r = take(0, p);
    return true;
}

}  // namespace mrducker
