// mrts::DrainServo: ../../py/drain_servo.py line for line.
#include "drain_servo.h"

#include <algorithm>

namespace mrts {

namespace {

int64_t clamp64(int64_t v, int64_t lo, int64_t hi) { return v < lo ? lo : v > hi ? hi : v; }

// a / b truncated toward 0 (b > 0): C++'s own, as the reference's tdiv.
int64_t tdiv(int64_t a, int64_t b) { return a / b; }

int64_t iabs(int64_t v) { return v < 0 ? -v : v; }

}  // namespace

const char* drain_event_name(DrainEvent::Kind k) {
    switch (k) {
        case DrainEvent::Kind::drain_start: return "drain-start";
        case DrainEvent::Kind::drain_done: return "drain-done";
        case DrainEvent::Kind::underrun: return "underrun";
        case DrainEvent::Kind::raise: return "raise";
        case DrainEvent::Kind::outage: return "outage";
    }
    return "";
}

const char* underrun_reason_name(UnderrunReason r) {
    switch (r) {
        case UnderrunReason::drain: return "drain";
        case UnderrunReason::after_drain: return "after-drain";
        case UnderrunReason::video: return "video";
        case UnderrunReason::warm_up: return "warm-up";
        case UnderrunReason::input: return "input";
        case UnderrunReason::load: return "load";
        case UnderrunReason::not_margin: return "not-margin";
        case UnderrunReason::raised: return "raised";
    }
    return "";
}

const char* drain_state_name(DrainServo::State s) {
    switch (s) {
        case DrainServo::State::idle: return "idle";
        case DrainServo::State::draining: return "draining";
        case DrainServo::State::rising: return "rising";
        default: return "warm-up";
    }
}

void DrainWindow::clear(int64_t now) {
    open_at_ = now;
    n_ = 1;
    have_[0] = false;
}

void DrainWindow::rotate(int64_t now) {
    if (now - open_at_ < BUCKET_NS) return;
    const int64_t k = (now - open_at_) / BUCKET_NS;
    open_at_ += k * BUCKET_NS;
    if (k >= BUCKETS) {
        n_ = 1;
        have_[0] = false;
        return;
    }
    // The oldest go first: shift what stays to the front, the new buckets empty.
    const int keep = std::min<int>(n_, BUCKETS - (int)k);
    const int drop = n_ - keep;
    for (int i = 0; i < keep; i++) {
        mins_[i] = mins_[i + drop];
        have_[i] = have_[i + drop];
    }
    n_ = keep + (int)k;
    for (int i = keep; i < n_; i++) have_[i] = false;
}

void DrainWindow::add(int64_t now, int64_t v) {
    rotate(now);
    const int i = n_ - 1;
    if (!have_[i] || v < mins_[i]) {
        mins_[i] = v;
        have_[i] = true;
    }
}

bool DrainWindow::min(int64_t now, int64_t* out) {
    rotate(now);
    bool any = false;
    for (int i = 0; i < n_; i++) {
        if (!have_[i]) continue;
        if (!any || mins_[i] < *out) *out = mins_[i];
        any = true;
    }
    return any;
}

DrainServo::DrainServo(bool video, int64_t start_ns, int64_t floor_ns)
    : video_(video), floor_(floor_ns), margin_(start_ns) {}

void DrainServo::touch(int64_t now) {
    if (started_) return;
    started_ = true;
    warm_from_ = last_ = now;
    slack_.clear(now);
    queue_.clear(now);
    m_at_ = now + M_EVERY_NS;
}

int64_t DrainServo::bound() const {
    if (!have_learned_) return floor_;
    return std::min(CEILING_NS, std::max(floor_, learned_ + ABOVE_L_NS));
}

// The two decays in time order, L first at a tie.
void DrainServo::decay(int64_t now) {
    for (;;) {
        const bool l_due = have_learned_ && l_at_ <= now;
        const bool m_due = m_at_ <= now;
        if (l_due && (!m_due || l_at_ <= m_at_)) {
            learned_ = std::max(floor_ - UNDER_FLOOR_NS, learned_ - STEP_NS);
            l_at_ += L_EVERY_NS;
        } else if (m_due) {
            margin_ = std::max(bound(), margin_ - STEP_NS);
            m_at_ += M_EVERY_NS;
        } else {
            return;
        }
    }
}

void DrainServo::raise(int64_t now, const Episode& ep, int64_t steady) {
    const int64_t mu = margin_;
    learned_ = mu;
    have_learned_ = true;
    margin_ = std::min(CEILING_NS, std::max(2 * mu, mu + RAISE_MIN_NS));
    raises_++;
    m_at_ = now + M_EVERY_NS;
    l_at_ = now + L_EVERY_NS;
    DrainEvent e{DrainEvent::Kind::raise, now, margin_};
    e.from = mu;
    e.length = ep.length;
    e.trough = ep.trough;
    e.have_trough = ep.have_trough;
    e.steady = steady;
    events_.push_back(e);
}

void DrainServo::outage(int64_t now, int64_t length) {
    outages_++;
    have_hold_ = true;
    hold_until_ = now + WINDOW_NS;
    have_broken_ = true;
    broken_at_ = now;
    events_.push_back(DrainEvent{DrainEvent::Kind::outage, now, length});
}

// The window's trough: the slack's, plus the queue's level where both are fed.
bool DrainServo::trough_at(int64_t now, int64_t* out) {
    int64_t q = 0;
    const bool have = slack_.min(now, out);
    if (have && queue_.min(now, &q)) *out += q;
    return have;
}

void DrainServo::count(int64_t now, UnderrunReason r, int64_t length) {
    reasons_[(int)r]++;
    DrainEvent e{DrainEvent::Kind::underrun, now, length};
    e.reason = r;
    events_.push_back(e);
}

// The first of drain, after-drain and warm-up (S2, Q, S1) that applies to `ep`; false if none.
bool DrainServo::first_reason(const Episode& ep, UnderrunReason* r) {
    if (ep.drain) *r = UnderrunReason::drain;
    else if (ep.have_quiet && ep.quiet >= ep.start - QUIET_NS) *r = UnderrunReason::after_drain;
    else if (!ep.warm) *r = UnderrunReason::warm_up;
    else return false;
    return true;
}

// S1-S4, S6 at t_c (B-240): raise, or count under the first test that fails.
void DrainServo::judge(int64_t now, const Episode& ep, int64_t render_ns) {
    UnderrunReason r;
    if (first_reason(ep, &r)) {
        count(now, r, ep.length);
        return;
    }
    if (have_broken_ && broken_at_ >= ep.start - WINDOW_NS) r = UnderrunReason::input;
    else if (render_ns > ep.render + ep.length + KEEP_UP_NS) r = UnderrunReason::load;
    else if (!ep.have_trough || iabs(ep.trough - ep.margin) > LIMIT_BAND_NS) r = UnderrunReason::not_margin;
    else {
        int64_t since = warm_from_;
        if (have_nonzero_) since = std::max(since, nonzero_at_);
        if (have_broken_) since = std::max(since, broken_at_);
        DrainEvent u{DrainEvent::Kind::underrun, now, ep.length};
        u.reason = UnderrunReason::raised;
        events_.push_back(u);
        raise(now, ep, ep.start - since);
        return;
    }
    count(now, r, ep.length);
}

void DrainServo::sample(int64_t now, int64_t slack_ns) {
    touch(now);
    int64_t any = 0;
    if (sampled_ && !slack_.min(now, &any)) warm_from_ = now;   // a hole emptied the window: warm-up again
    sampled_ = true;
    slack_.add(now, std::max<int64_t>(slack_ns, 0));
}

void DrainServo::queue_level(int64_t now, int64_t level_ns) {
    touch(now);
    queue_.add(now, std::max<int64_t>(level_ns, 0));
}

void DrainServo::starve(int64_t now, bool on) {
    touch(now);
    if (on && !in_episode_) {
        in_episode_ = true;
        episode_at_ = now;
        episode_ = Episode{};
        episode_.start = now;
        episode_.render = render_;
        episode_.have_trough = have_settled_;
        episode_.trough = settled_;
        episode_.margin = margin_;
        // S1 as the window and the hold judge it, not the lock: the starvation itself can stop the render
        // lateness reading (`can`) on the tick before it is detected.
        episode_.warm = sampled_ && now - warm_from_ >= WINDOW_NS && (!have_hold_ || now >= hold_until_);
        episode_.drain = ppb_ != 0;
        episode_.have_quiet = have_nonzero_;
        episode_.quiet = nonzero_at_;
    } else if (!on && in_episode_) {
        const int64_t length = now - episode_at_;
        in_episode_ = false;
        if (length <= SHORT_NS) {
            have_hold_ = true;
            hold_until_ = now + WINDOW_NS;
            underruns_++;
            Episode ep = episode_;
            ep.length = length;
            ep.tc = now + CONFIRM_NS;
            ep.drain = ep.drain || ppb_ != 0;
            pending_.push_back(ep);
        } else {
            outage(now, length);
        }
    }
}

void DrainServo::late(int64_t now, int64_t by_ns) {
    touch(now);
    const bool joins = have_late_ && now - late_at_ <= JOIN_NS;
    have_late_ = true;
    late_at_ = now;
    if (by_ns > SHORT_NS) {
        outage(now, by_ns);
        return;
    }
    if (joins) return;
    underruns_++;
    // Never a raise (B-256): counted drain, after-drain (within Q of delta != 0) or video.
    if (ppb_ != 0) count(now, UnderrunReason::drain, 0);
    else if (have_nonzero_ && now - nonzero_at_ <= QUIET_NS) count(now, UnderrunReason::after_drain, 0);
    else count(now, UnderrunReason::video, 0);
}

void DrainServo::clear(int64_t now) {
    touch(now);
    slack_.clear(now);
    queue_.clear(now);
    warm_from_ = now;
    sampled_ = false;
    ppb_ = 0;
    engaged_ = false;
    if (draining_) events_.push_back(DrainEvent{DrainEvent::Kind::drain_done, now, drained_});
    draining_ = false;
    in_episode_ = false;
    have_late_ = false;
    have_hold_ = false;
    have_broken_ = true;
    broken_at_ = now;
    have_settled_ = have_next_ = have_next_at_ = false;
    // Judged at once: S3's, unless an earlier test fails first.
    for (const Episode& ep : pending_) {
        UnderrunReason r = UnderrunReason::input;
        first_reason(ep, &r);
        count(now, r, ep.length);
    }
    pending_.clear();
}

void DrainServo::set_group(int64_t now, int64_t target_ns) {
    touch(now);
    group_ = target_ns;
    group_at_ = now;
}

int64_t DrainServo::update(int64_t now, int64_t render_ns, bool can) {
    touch(now);
    decay(now);
    const int64_t dt = std::max<int64_t>(now - last_, 0);
    last_ = now;
    if (ppb_ > 0) {
        const __int128 acc = (__int128)ppb_ * dt + drained_rem_;
        drained_ += (int64_t)(acc / SEC);
        drained_rem_ = (int64_t)(acc % SEC);
    }
    if (ppb_ != 0) {   // delta held its value until now
        have_nonzero_ = true;
        nonzero_at_ = now;
        episode_.drain = true;
        for (Episode& ep : pending_) ep.drain = true;
    }
    if (brk_) {
        have_broken_ = true;
        broken_at_ = now;
    }
    while (!pending_.empty() && pending_.front().tc <= now) {
        const Episode ep = pending_.front();
        pending_.erase(pending_.begin());
        judge(now, ep, render_ns);
    }
    int64_t trough = 0;
    const bool have = trough_at(now, &trough);
    if (!have_next_at_ || now - next_at_ >= SETTLE_NS) {
        have_settled_ = have_next_;
        settled_ = next_trough_;
        have_next_ = have;
        next_trough_ = trough;
        have_next_at_ = true;
        next_at_ = now;
    }
    const bool warm = can && have && now - warm_from_ >= WINDOW_NS && (!have_hold_ || now >= hold_until_);
    trough_ = have ? trough : 0;
    const int64_t excess = warm ? trough - margin_ : 0;
    excess_ = excess;
    const int64_t t_now = render_ns - std::max<int64_t>(excess, 0);
    if (ppb_ >= 0) held_ = t_now;
    target_ = ppb_ < 0 ? held_ : t_now;
    const bool grouped = group_ > GROUP_ALONE_NS && now - group_at_ <= GROUP_STALE_NS;
    capped_ = false;
    int64_t cmd;
    if (!warm || in_episode_) {
        cmd = 0;
    } else if (grouped) {
        const int64_t goal = std::min(group_, target_ + RISE_CAP_NS);
        capped_ = group_ > target_ + RISE_CAP_NS;
        const int64_t eg = render_ns - goal;
        cmd = eg >= 0 ? std::max<int64_t>(0, std::min(excess, eg)) : eg;
    } else {
        cmd = std::max<int64_t>(0, excess);
    }
    if (engaged_ && iabs(cmd) <= LETGO_NS) engaged_ = false;
    else if (!engaged_ && iabs(cmd) >= ENGAGE_NS) engaged_ = true;
    // Saturated from 150 ms: a command past 1 s gives the same, and keeps cmd * 1e9 in 64 bits.
    int64_t want = 0;
    if (engaged_) want = clamp64(tdiv(clamp64(cmd, -SEC, SEC) * SEC, TAU_NS), -DMAX_PPB, DMAX_PPB);
    const bool draining = engaged_ && cmd > 0;
    if (draining && !draining_) events_.push_back(DrainEvent{DrainEvent::Kind::drain_start, now, cmd});
    else if (draining_ && !draining) events_.push_back(DrainEvent{DrainEvent::Kind::drain_done, now, drained_});
    draining_ = draining;
    if (brk_) {
        ppb_ = want;
        brk_ = false;
    } else {
        const int64_t step = dt / SLEW_DEN;
        ppb_ = clamp64(want, ppb_ - step, ppb_ + step);
    }
    if (ppb_ != 0) {
        have_nonzero_ = true;
        nonzero_at_ = now;
    }
    render_ = render_ns;
    state_ = !warm ? State::warm_up : ppb_ > 0 ? State::draining : ppb_ < 0 ? State::rising : State::idle;
    return ppb_;
}

std::vector<DrainEvent> DrainServo::take_events() {
    std::vector<DrainEvent> out;
    out.swap(events_);
    return out;
}

}  // namespace mrts
