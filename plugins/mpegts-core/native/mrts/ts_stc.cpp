#include "ts_stc.h"

#include <algorithm>
#include <climits>
#include <cstddef>
#include <cstring>

namespace mrts {
namespace {

constexpr int64_t E9 = 1000000000;
constexpr int64_t Q16 = 65536;
constexpr int64_t DELTA_LIM = 1LL << 60;     // |σ - σ_ref| a mapping evaluates (36 years)
constexpr int64_t FIT_X_LIM = 1LL << 40;     // fit points within 1100 s of the newest
constexpr int64_t FIT_Y_LIM = 1LL << 30;     // fit d within ±1.07 s of the newest

// Floor semantics as ts_house.cpp (its helpers are file-local there).
int64_t floor_div(int64_t a, int64_t b) {
    const int64_t q = a / b;
    return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q;
}

int64_t clamp64(int64_t v, int64_t lo, int64_t hi) { return v < lo ? lo : v > hi ? hi : v; }

int64_t sat_add(int64_t a, int64_t b) {
    if (b > 0 && a > INT64_MAX - b) return INT64_MAX;
    if (b < 0 && a < INT64_MIN - b) return INT64_MIN;
    return a + b;
}

int64_t sat_sub(int64_t a, int64_t b) {
    if (b < 0 && a > INT64_MAX + b) return INT64_MAX;
    if (b > 0 && a < INT64_MIN + b) return INT64_MIN;
    return a - b;
}

// floor(x * ppb / 1e9) without forming x * ppb: x = q * 1e9 + r, 0 <= r < 1e9.
int64_t mul_ppb(int64_t x, int64_t ppb) {
    x = clamp64(x, -DELTA_LIM, DELTA_LIM);
    ppb = clamp64(ppb, -E9, E9);
    const int64_t q = floor_div(x, E9);
    return q * ppb + floor_div((x - q * E9) * ppb, E9);
}

// a - b on the PCR circle: the 33-bit base folded by fold33, the extension carried.
static_assert(PCR_MODULO == 300 * PTS_WRAP, "the PCR wraps exactly when its 33-bit base does");
int64_t pcr_delta(int64_t a, int64_t b) {
    const int64_t ab = floor_div(a, 300), bb = floor_div(b, 300);
    return fold33(ab - bb) * 300 + ((a - ab * 300) - (b - bb * 300));
}

int64_t median(std::vector<int64_t> v) {
    const size_t k = (v.size() - 1) / 2;
    std::nth_element(v.begin(), v.begin() + k, v.end());
    return v[k];
}

int64_t p99(std::vector<int64_t> v) {   // nearest rank
    const size_t k = (99 * v.size() + 99) / 100 - 1;
    std::nth_element(v.begin(), v.begin() + k, v.end());
    return v[k];
}

// Least squares in ms (x) by ns (y), centred on floor means so the cross terms
// stay tiny: for <= 1000 points, |x| <= 2.2e6 and |y| <= 2^31, every sum < 2^63.
bool ls_fit(const std::vector<int64_t>& X, const std::vector<int64_t>& Y, const std::vector<char>* keep,
            int64_t* mx, int64_t* my, int64_t* ppb) {
    int64_t n = 0, sx = 0, sy = 0;
    for (size_t i = 0; i < X.size(); i++) {
        if (keep && !(*keep)[i]) continue;
        n++;
        sx += X[i];
        sy += Y[i];
    }
    if (n < 3) return false;
    *mx = floor_div(sx, n);
    *my = floor_div(sy, n);
    int64_t cx = 0, cy = 0, sxx = 0, sxy = 0;
    for (size_t i = 0; i < X.size(); i++) {
        if (keep && !(*keep)[i]) continue;
        const int64_t x = X[i] - *mx, y = Y[i] - *my;
        cx += x;
        cy += y;
        sxx += x * x;
        sxy += x * y;
    }
    const int64_t den = sxx - cx * cx / n, num = sxy - cx * cy / n;
    if (den <= 0) return false;
    // ns per ms is ppm: ppb = 1000 * num / den, split so 1000 * remainder fits.
    const int64_t q = clamp64(num / den, -1000000, 1000000);
    *ppb = 1000 * q + 1000 * (num % den) / den;
    return true;
}

}  // namespace

int64_t StcLine::travel(int64_t sigma) const {
    if (slew_ns == 0 || slew_ppb == 0) return 0;
    const int64_t d = sat_sub(sigma, sigma_ref);
    if (d <= 0) return 0;
    const int64_t m = mul_ppb(d, slew_ppb);
    return slew_ns > 0 ? std::min(m, slew_ns) : -std::min(m, -slew_ns);
}

int64_t StcLine::house_of(int64_t sigma) const {
    const int64_t d = clamp64(sat_sub(sigma, sigma_ref), -DELTA_LIM, DELTA_LIM);
    return sat_add(sat_add(sat_add(house_ref, d), mul_ppb(d, rate_ppb)), travel(sigma));
}

ClockLock::ClockLock(const ClockLockConfig& cfg) : cfg_(cfg) {
    // Bounds that keep every product in 64 bits (see ls_fit and the Q16 loop).
    cfg_.bucket_ns = clamp64(cfg_.bucket_ns, 1000000, 10 * E9);
    cfg_.rate_buckets_min = (int)clamp64(cfg_.rate_buckets_min, 3, 1000);
    cfg_.rate_buckets_max = (int)clamp64(cfg_.rate_buckets_max, cfg_.rate_buckets_min, 1000);
    cfg_.rate_tau_ns = clamp64(cfg_.rate_tau_ns, cfg_.bucket_ns, 10000 * E9);
    cfg_.rate_max_ppm = clamp64(cfg_.rate_max_ppm, 0, 100000);
    cfg_.rate_warn_ppm = clamp64(cfg_.rate_warn_ppm, 0, 100000);
    cfg_.rate_refit_mads = (int)clamp64(cfg_.rate_refit_mads, 0, 1000);
    cfg_.offset_buckets = (int)clamp64(cfg_.offset_buckets, 1, 1000);
    cfg_.slew_acquire_ppm = clamp64(cfg_.slew_acquire_ppm, 0, 100000);
    cfg_.slew_track_ppm = clamp64(cfg_.slew_track_ppm, 0, 100000);
}

int64_t ClockLock::eps_ppb() const { return floor_div(eps_q16_ + Q16 / 2, Q16); }

int64_t ClockLock::ppb() const { return eps_ppb(); }

ClockLock::Phase ClockLock::phase() const {
    if (started_ && sat_sub(last_seen_h_, last_sample_h_) >= cfg_.lost_ns) return Phase::lost;
    return locked_ ? Phase::locked : Phase::acquiring;
}

void ClockLock::tick(int64_t now_ns) {
    if (now_ns > last_seen_h_) last_seen_h_ = now_ns;
}

void ClockLock::feed(int64_t sigma, int64_t h) {
    if (!started_) {
        // β from the first sample; the acquisition slew pulls it to the envelope.
        started_ = true;
        line_ = StcLine{sigma, h, eps_ppb(), 0, 0};
        origin_h_ = epoch_h_ = h;
        bucket_ = 0;
        closed_ = 0;
        cur_ = Point{sigma, h, Level::fit};
        last_sample_h_ = last_seen_h_ = h;
        resid_.push_back({h, 0});
        return;
    }
    last_sample_h_ = std::max(last_sample_h_, h);
    last_seen_h_ = std::max(last_seen_h_, h);
    resid_.push_back({h, sat_sub(h, line_.house_of(sigma))});
    while (resid_.front().first < sat_sub(last_sample_h_, cfg_.residual_window_ns)) resid_.pop_front();

    const int64_t k = floor_div(sat_sub(h, origin_h_), cfg_.bucket_ns);
    if (k > bucket_) {
        close_bucket(sigma, h);
        bucket_ = k;
        cur_ = Point{sigma, h, Level::fit};
    } else if (sat_sub(h, sigma) < sat_sub(cur_.house, cur_.sigma)) {
        cur_ = Point{sigma, h, Level::fit};
    }
}

bool ClockLock::fit(int64_t* ppb, int* n_out) const {
    size_t zi = hist_.size();
    while (zi > 0 && hist_[zi - 1].level != Level::fit) zi--;
    if (zi == 0) return false;
    const Point& z = hist_[zi - 1];
    const int64_t dz = sat_sub(z.house, z.sigma);
    const int64_t span = std::min(cfg_.rate_buckets_max * cfg_.bucket_ns, FIT_X_LIM);
    std::vector<int64_t> X, Y;
    for (size_t i = zi; i-- > 0 && (int)X.size() < cfg_.rate_buckets_max;) {
        const Point& p = hist_[i];
        if (p.level != Level::fit) continue;
        if (sat_sub(z.house, p.house) > span) break;   // an outage must not stretch the window
        const int64_t dx = sat_sub(p.sigma, z.sigma);
        if (dx < -FIT_X_LIM || dx > FIT_X_LIM) continue;
        X.push_back(floor_div(dx, 1000000));
        Y.push_back(clamp64(sat_sub(sat_sub(p.house, p.sigma), dz), -FIT_Y_LIM, FIT_Y_LIM));
    }
    const int n = (int)X.size();
    int64_t mx, my, first;
    if (n < cfg_.rate_buckets_min || !ls_fit(X, Y, nullptr, &mx, &my, &first)) return false;

    // Refit once without the points more than k MAD above the first line.
    std::vector<int64_t> r(n), dev(n);
    for (int i = 0; i < n; i++) r[i] = (Y[i] - my) - first * (X[i] - mx) / 1000;
    const int64_t mid = median(r);
    for (int i = 0; i < n; i++) dev[i] = r[i] > mid ? r[i] - mid : mid - r[i];
    const int64_t cut = cfg_.rate_refit_mads * median(dev);
    std::vector<char> keep(n);
    for (int i = 0; i < n; i++) keep[i] = r[i] <= cut;
    int64_t second;
    *ppb = ls_fit(X, Y, &keep, &mx, &my, &second) ? second : first;
    *n_out = n;
    return true;
}

// A bucket joins the fit's level within step_ns of the level's bucket `lag` before it,
// at that bucket's rate. lag: the most buckets in which no rate error within the clamps
// (2 x rate_max) reaches step_ns, so no fit is locked out and a step or faster drift shows.
void ClockLock::classify(int64_t house_now) {
    Point& b = hist_.back();
    const int64_t step = cfg_.step_ns;
    const int64_t drift = 2 * cfg_.rate_max_ppm * cfg_.bucket_ns / 1000000;   // per bucket
    const int lag = (int)clamp64(step / std::max<int64_t>(drift, 1), 1, cfg_.rate_buckets_max);
    const Point* ref = nullptr;
    int seen = 0;
    for (size_t i = hist_.size() - 1; i-- > 0 && seen < lag;)
        if (hist_[i].level == Level::fit) {
            ref = &hist_[i];
            seen++;
        }
    // Its own rate, so a ramp's first buckets cannot bend the fit that judges the rest.
    const int64_t eps = ref ? ref->eps : 0;
    auto u = [&](const Point& p) {   // minimum delay at b's σ along that rate
        return sat_sub(sat_sub(p.house, p.sigma), mul_ppb(sat_sub(p.sigma, b.sigma), eps));
    };
    auto set = [this](Level from, Level to) {
        for (Point& p : hist_)
            if (p.level == from) p.level = to;
    };
    int64_t cmin = INT64_MAX, cmax = INT64_MIN;
    for (const Point& p : hist_)
        if (p.level == Level::candidate) {
            cmin = std::min(cmin, u(p));
            cmax = std::max(cmax, u(p));
        }
    const int64_t ub = u(b);
    if (!ref || (sat_sub(ub, u(*ref)) <= step && sat_sub(u(*ref), ub) <= step)) {
        b.level = Level::fit;   // the first bucket opens the level
        if (cand_) set(Level::candidate, Level::out);   // a burst, or a dip, that passed
        cand_ = false;
        return;
    }
    // A candidate is a level only while its buckets lie within step_ns of each other.
    if (!cand_ || sat_sub(ub, cmin) > step || sat_sub(cmax, ub) > step) {
        set(Level::candidate, Level::out);
        cand_ = true;
        cand_h_ = sat_add(origin_h_, bucket_ * cfg_.bucket_ns);   // start of this bucket
    }
    b.level = Level::candidate;
    // Held step_hold_ns, the floor moved (a re-route either way): the fit restarts at
    // this bucket, as the candidate may open on the tail of a ramp.
    if (sat_sub(house_now, cand_h_) >= cfg_.step_hold_ns) {
        set(Level::fit, Level::out);
        set(Level::candidate, Level::out);
        b.level = Level::fit;
        cand_ = false;
        fit_valid_ = false;   // the last fit was of the old level: none until this one has its own
    }
}

void ClockLock::close_bucket(int64_t sigma_now, int64_t house_now) {
    hist_.push_back(cur_);
    const size_t cap = (size_t)std::max(cfg_.rate_buckets_max, cfg_.offset_buckets);
    while (hist_.size() > cap) hist_.pop_front();

    // Re-pivot where the source is now: the mapping stays continuous.
    travel_ns_ += line_.travel(sigma_now);
    line_.house_ref = line_.house_of(sigma_now);
    line_.sigma_ref = sigma_now;
    line_.slew_ppb = line_.slew_ns = 0;
    hist_.back().eps = eps_ppb();
    classify(house_now);   // before the fit

    int64_t f;
    int n;
    if (fit(&f, &n)) {
        fit_valid_ = true;
        fit_ppb_ = f;
        const int64_t lim = cfg_.rate_max_ppm * 1000;
        const int64_t fc = clamp64(f, -lim, lim);
        const int64_t gap = fc - eps_ppb();
        // A fit on more buckets than the ε in force is strictly better: take it.
        // So is one the track slew could not absorb. Otherwise the τ loop, scaled
        // by n / N_max so a short fit after a re-lock pulls a kept ε only gently.
        if (!rate_known_ || n > rate_n_ || gap > cfg_.slew_track_ppm * 1000 ||
            gap < -cfg_.slew_track_ppm * 1000) {
            if (!rate_known_) rate_known_h_ = house_now;
            rate_known_ = true;
            eps_q16_ = fc * Q16;
            rate_n_ = n;
        } else {
            const int64_t g = std::min(Q16, cfg_.bucket_ns * n * Q16 /
                                                (cfg_.rate_tau_ns * cfg_.rate_buckets_max));
            eps_q16_ += floor_div((fc * Q16 - eps_q16_) * g, Q16);
        }
    }
    line_.rate_ppb = eps_ppb();

    // Fresh, the slew must follow up to rate_max until the first fit; acquire_ns
    // then counts from that fit (or from a re-lock that kept its rate).
    if (!locked_ && rate_known_ && sat_sub(house_now, std::max(epoch_h_, rate_known_h_)) >= cfg_.acquire_ns) {
        locked_ = true;
        travel_at_lock_ = travel_ns_;
    }

    if (fresh_ && ++closed_ == 2) seed_floor();

    // β* - β_applied: min over the last M buckets of d_j - ε·σ_j, against the line
    // through the pivot.
    int64_t e = INT64_MAX;
    for (size_t i = hist_.size() - std::min(hist_.size(), (size_t)cfg_.offset_buckets); i < hist_.size(); i++)
        e = std::min(e, sat_sub(hist_[i].house, line_.house_of(hist_[i].sigma)));
    e = clamp64(e, -DELTA_LIM, DELTA_LIM);
    const Point& b = hist_.back();
    const int64_t rb = sat_sub(b.house, line_.house_of(b.sigma));   // the bucket just closed
    const int64_t cap_ppb = (locked_ ? cfg_.slew_track_ppm : cfg_.slew_acquire_ppm) * 1000;
    const int64_t ae = e < 0 ? -e : e;
    // Reach β* within one bucket when it is that close, else move at the cap.
    line_.slew_ppb = ae >= cap_ppb * cfg_.bucket_ns / E9 ? cap_ppb : ae * E9 / cfg_.bucket_ns;
    line_.slew_ns = e;

    if (!locked_ || step_fired_) {
        run_ = false;
        return;
    }
    const bool fall = cfg_.step_falls && rb < -cfg_.step_ns;
    if (rb > cfg_.step_ns || fall) {
        if (!run_ || run_fall_ != fall) {   // a run keeps one direction
            run_ = true;
            run_fall_ = fall;
            run_start_h_ = sat_add(origin_h_, bucket_ * cfg_.bucket_ns);   // start of that bucket
            run_min_ = rb;
        }
        run_min_ = std::min(run_min_, rb);   // delay is one-sided: the new floor either way
        if (sat_sub(house_now, run_start_h_) >= cfg_.step_hold_ns) {
            step_fired_ = true;
            step_size_ = run_min_;
        }
    } else {
        run_ = false;
    }
}

ClockLock::Residual ClockLock::residual() const {
    Residual out;
    if (resid_.empty()) return out;
    std::vector<int64_t> v;
    v.reserve(resid_.size());
    for (const auto& p : resid_) v.push_back(p.second);
    std::sort(v.begin(), v.end());
    const size_t n = v.size();
    out.min_ns = v.front();
    out.max_ns = v.back();
    out.p50_ns = v[(n - 1) / 2];
    out.p99_ns = v[(99 * n + 99) / 100 - 1];
    out.count = (uint32_t)n;
    return out;
}

// A transport's start burst (an SRT or RTP backlog read at once) seeds the first epoch
// far above the floor its first two buckets agree on: move there at once. What already
// left on the seed and overlaps is the caller's to drop (the ingest guard does, R18).
void ClockLock::seed_floor() {
    const int64_t a = sat_sub(hist_[hist_.size() - 2].house, line_.house_of(hist_[hist_.size() - 2].sigma));
    const int64_t b = sat_sub(hist_.back().house, line_.house_of(hist_.back().sigma));
    const int64_t lo = std::min(a, b), hi = std::max(a, b);
    if (hi >= -cfg_.step_ns || sat_sub(hi, lo) > cfg_.step_ns) return;
    line_.house_ref = sat_add(line_.house_ref, clamp64(lo, -DELTA_LIM, DELTA_LIM));
    resid_.clear();   // against the seed
}

void ClockLock::relock(bool keep_rate) {
    started_ = false;
    fresh_ = false;
    hist_.clear();
    cand_ = false;
    resid_.clear();
    fit_valid_ = false;
    locked_ = false;
    run_ = step_fired_ = false;
    step_size_ = 0;
    travel_ns_ = travel_at_lock_ = 0;
    if (!keep_rate) {
        rate_known_ = false;
        eps_q16_ = 0;
        rate_n_ = 0;
    }
}

// β* over the step's own buckets, not the last M (which may span both levels): the
// floor to bucket-minimum precision, where a relock starts from one sample's delay.
void ClockLock::step_to_floor() {
    if (!step_fired_) return;
    while (!hist_.empty() && hist_.front().house < run_start_h_) hist_.pop_front();   // the old level
    int64_t e = INT64_MAX;
    for (const Point& p : hist_) e = std::min(e, sat_sub(p.house, line_.house_of(p.sigma)));
    if (e != INT64_MAX) {
        e = clamp64(e, -DELTA_LIM, DELTA_LIM);
        line_.house_ref = sat_add(line_.house_ref, e);
        travel_ns_ += e;
    }
    line_.slew_ppb = line_.slew_ns = 0;
    resid_.clear();   // against the old floor
    fit_valid_ = false;   // as at a level adoption: the fit was of the buckets just gone
    run_ = step_fired_ = false;
    step_size_ = 0;
}

// --- PcrValidator ---------------------------------------------------------------

PcrValidator::PcrValidator(const PcrValidatorConfig& cfg) : cfg_(cfg) {
    cfg_.pcr_interval_fail_ns = std::max<int64_t>(cfg_.pcr_interval_fail_ns, 1000000);
    cfg_.rate_max_ppm = clamp64(cfg_.rate_max_ppm, 0, 100000);
}

void PcrValidator::bad(int64_t h) {
    if (!any_bad_ || h > last_bad_h_) last_bad_h_ = h;
    any_bad_ = true;
}

bool PcrValidator::fail(Reason r) {
    if (reason_ != Reason::none) return false;
    reason_ = r;
    return true;
}

void PcrValidator::on_packet(int64_t h) {
    if (h > now_) now_ = h;
    if (!have_act_) {
        have_act_ = true;
        last_act_h_ = h;
        if (!have_pcr_) open_h_ = h;   // a program with no PCR at all fails cadence too
        return;
    }
    const int64_t gap = sat_sub(h, last_act_h_);
    last_act_h_ = std::max(last_act_h_, h);
    const int64_t crossed = std::max<int64_t>(0, (sat_sub(h, open_h_) - 1) / cfg_.pcr_interval_fail_ns);
    if (gap >= cfg_.pcr_interval_fail_ns) {   // silence: an outage, skip what it spanned
        open_outage_ = true;
        open_counted_ = std::max(open_counted_, crossed);
        return;
    }
    while (open_counted_ < crossed) {   // packets keep arriving, the PCR does not
        open_counted_++;
        longs_.push_back(h);
        bad(h);
    }
    while (!longs_.empty() && longs_.front() < sat_sub(h, cfg_.cadence_fail_window_ns)) longs_.pop_front();
    if ((int)longs_.size() >= cfg_.cadence_fail_count) fail(Reason::cadence);
}

void PcrValidator::feed_activity(int64_t arrival_ns) { on_packet(arrival_ns); }

PcrValidator::Verdict PcrValidator::feed_pcr(int64_t pcr27, bool di, int64_t h) {
    on_packet(h);
    if (!have_pcr_) {
        have_pcr_ = true;
        last_pcr_ = fz_pcr_ = pcr27;
        last_pcr_h_ = fz_h_ = first_pcr_h_ = h;
        freeze_run_ = 0;
        open_h_ = h;
        open_counted_ = 0;
        open_outage_ = false;
        return Verdict::ok;
    }
    const int64_t dh = sat_sub(h, last_pcr_h_);
    interval_max_ = std::max(interval_max_, dh);
    if (!open_outage_) intervals_.push_back({h, dh});
    while (!intervals_.empty() && intervals_.front().first < sat_sub(h, cfg_.cadence_window_ns)) intervals_.pop_front();
    if (!intervals_.empty()) {
        std::vector<int64_t> v;
        for (const auto& p : intervals_) v.push_back(p.second);
        warn_ = p99(std::move(v)) > cfg_.pcr_interval_warn_ns;
    }
    open_h_ = h;
    open_counted_ = 0;
    open_outage_ = false;

    const int64_t ds = pcr27_to_ns(pcr_delta(pcr27, last_pcr_));
    last_pcr_ = pcr27;
    last_pcr_h_ = h;
    if (di) {
        freeze_run_ = 0;
        fz_pcr_ = pcr27;
        fz_h_ = h;
        return Verdict::discontinuity;
    }
    // Against the rate in force, so a long outage of a drifting source is no leap.
    const int64_t miss = sat_sub(sat_add(ds, mul_ppb(ds, rate_ppb_)), dh);
    if (miss > cfg_.leap_ns || miss < -cfg_.leap_ns) {
        last_leap_ = sat_sub(ds, dh);
        leaps_.push_back(h);
        while (leaps_.front() < sat_sub(h, cfg_.leap_window_ns)) leaps_.pop_front();
        bad(h);
        freeze_run_ = 0;
        fz_pcr_ = pcr27;
        fz_h_ = h;
        return (int)leaps_.size() >= cfg_.leap_fail_count && fail(Reason::leap) ? Verdict::fail : Verdict::leap;
    }
    // Freeze pairs span >= 30 ms, so a dense PCR still shows its stall.
    const int64_t fdh = sat_sub(h, fz_h_);
    if (fdh >= cfg_.freeze_min_dh_ns) {
        const int64_t fds = pcr27_to_ns(pcr_delta(pcr27, fz_pcr_));
        fz_pcr_ = pcr27;
        fz_h_ = h;
        if (fds < fdh / 2) {
            freeze_run_++;
            bad(h);
            if (freeze_run_ >= cfg_.freeze_count && fail(Reason::freeze)) return Verdict::fail;
        } else {
            freeze_run_ = 0;
        }
    }
    return Verdict::ok;
}

void PcrValidator::feed_rate(int64_t fit_ppb, int64_t h) {
    if (h > now_) now_ = h;
    const int64_t lim = cfg_.rate_max_ppm * 1000;
    rate_ppb_ = clamp64(fit_ppb, -lim, lim);
    if (fit_ppb <= lim && fit_ppb >= -lim) {
        rate_bad_ = false;
        return;
    }
    bad(h);
    if (!rate_bad_) {
        rate_bad_ = true;
        rate_bad_since_ = h;
    }
    if (sat_sub(h, rate_bad_since_) >= cfg_.rate_hold_ns) fail(Reason::rate);
}

void PcrValidator::feed_lead(int pid, int64_t lead_ns) {
    const int64_t t = now_;
    Lead& l = leads_[pid];
    if (!l.w.empty() && sat_sub(t, l.w.back().first) >= cfg_.lead_hold_ns) l.bad = false;   // silent PID: start over
    l.w.push_back({t, lead_ns});
    while (l.w.front().first < sat_sub(t, cfg_.lead_median_window_ns)) l.w.pop_front();
    std::vector<int64_t> v;
    for (const auto& p : l.w) v.push_back(p.second);
    const int64_t med = median(std::move(v));
    if (med >= cfg_.lead_min_ns && med <= cfg_.lead_max_ns) {
        l.bad = false;
        return;
    }
    bad(t);
    if (!l.bad) {
        l.bad = true;
        l.bad_since = t;
    }
    if (sat_sub(t, l.bad_since) >= cfg_.lead_hold_ns) fail(Reason::lead);
}

int64_t PcrValidator::clean_ns(int64_t now_ns) const {
    if (any_bad_) return sat_sub(now_ns, last_bad_h_);
    return have_pcr_ ? sat_sub(now_ns, first_pcr_h_) : 0;
}

int64_t PcrValidator::take_interval_max() {
    const int64_t v = interval_max_;
    interval_max_ = 0;
    return v;
}

const char* reason_name(PcrValidator::Reason r) {
    switch (r) {
        case PcrValidator::Reason::cadence: return "cadence";
        case PcrValidator::Reason::rate: return "rate";
        case PcrValidator::Reason::freeze: return "freeze";
        case PcrValidator::Reason::leap: return "leap";
        case PcrValidator::Reason::lead: return "lead";
        default: return "none";
    }
}

const char* event_name(StcEvent::Kind k) {
    switch (k) {
        case StcEvent::Kind::relock: return "relock";
        case StcEvent::Kind::degraded: return "degraded";
        case StcEvent::Kind::recovered: return "recovered";
        case StcEvent::Kind::envelope_step: return "envelope-step";
        default: return "leap";
    }
}

// --- VirtualStc -----------------------------------------------------------------

VirtualStc::VirtualStc(const ClockLockConfig& clock, const PcrValidatorConfig& pcr)
    : pcr_(clock), ref_(clock), val_(pcr) {}

int64_t VirtualStc::house_in(const Epoch& e, int64_t sigma) const {
    return e.live ? lock_of(e.src).house_of(sigma) : e.line.house_of(sigma);
}

void VirtualStc::freeze_current() {
    if (epochs_.empty() || !epochs_.back().live) return;
    epochs_.back().line = lock_of(epochs_.back().src).line();
    epochs_.back().live = false;
}

void VirtualStc::open_epoch(Src src, int64_t sigma, int64_t h, bool step) {
    freeze_current();
    if (step && !epochs_.empty()) epochs_.back().stepped = true;
    for (auto& kv : leads_) {   // the straddle tie-break compares against these
        PidLeads& p = kv.second;
        while (!p.w.empty() && p.w.front().first < sat_sub(h, LEAD_WINDOW_NS)) p.w.pop_front();
        p.has_before = !p.w.empty();
        if (!p.has_before) continue;
        std::vector<int64_t> v;
        for (const auto& e : p.w) v.push_back(e.second);
        p.before = median(std::move(v));
    }
    epochs_.push_back(Epoch{next_epoch_++, src, true, StcLine(), sat_sub(sigma, RANGE_BEFORE_NS),
                            sat_add(sigma, RANGE_AFTER_NS), h});
}

void VirtualStc::grow_epoch(Src src, int64_t sigma, int64_t h) {
    if (epochs_.empty() || !epochs_.back().live || epochs_.back().src != src) return;
    Epoch& e = epochs_.back();
    e.hi = std::max(e.hi, sat_add(sigma, RANGE_AFTER_NS));
    e.last_h = std::max(e.last_h, h);
}

void VirtualStc::emit(StcEvent::Kind k, const char* why, int64_t h, int64_t value) {
    events_.push_back(StcEvent{k, why, h, epochs_.empty() ? 0u : epochs_.back().id, value});
}

void VirtualStc::check_failure(int64_t h) {
    if (!degraded_ && val_.failed()) enter_degraded(h);
}

void VirtualStc::enter_degraded(int64_t h) {
    degraded_ = true;
    degraded_reason_ = val_.reason();
    freeze_current();
    pcr_.relock(true);   // the bad PCR must not train it; its ε is the guess on recovery
    pcr_pending_ = false;
    ref_pending_ = !ref_.started();
    if (!ref_pending_) open_epoch(Src::ref, ref_sigma_, h);
    emit(StcEvent::Kind::degraded, reason_name(degraded_reason_), h, 0);
}

void VirtualStc::try_recover(int64_t sigma, int64_t h) {
    if (!pcr_.started() || pcr_.phase() != ClockLock::Phase::locked) return;
    if (val_.clean_ns(h) < val_.config().recover_ns) return;
    val_.clear_failure();
    degraded_ = false;
    ref_pending_ = false;
    open_epoch(Src::pcr, sigma, h);
    emit(StcEvent::Kind::recovered, reason_name(degraded_reason_), h, 0);
    degraded_reason_ = PcrValidator::Reason::none;
}

void VirtualStc::feed_pcr(int64_t pcr27, bool discontinuity, int64_t h) {
    pcr_unwrapped_ = have_pcr_ ? pcr_unwrapped_ + pcr_delta(pcr27, pcr_unwrapped_) : pcr27;
    have_pcr_ = true;
    const int64_t sigma = pcr27_to_ns(pcr_unwrapped_);
    const PcrValidator::Verdict v = val_.feed_pcr(pcr27, discontinuity, h);
    const bool leap = v == PcrValidator::Verdict::leap ||
                      (v == PcrValidator::Verdict::fail && val_.reason() == PcrValidator::Reason::leap);
    if (leap) emit(StcEvent::Kind::leap, "", h, val_.last_leap_ns());
    if (v == PcrValidator::Verdict::discontinuity || v == PcrValidator::Verdict::leap) {
        if (!degraded_ && pcr_.started()) {
            freeze_current();
            pcr_pending_ = true;
            pcr_why_ = leap ? "leap" : "discontinuity";
        }
        pcr_.relock(true);
    }
    check_failure(h);   // a failing row degrades (and relocks the PCR lock) first

    pcr_.feed(sigma, h);
    if (pcr_.envelope_step()) {
        const int64_t step = pcr_.step_size_ns();
        if (!degraded_) {
            emit(StcEvent::Kind::envelope_step, "", h, step);
            freeze_current();
            pcr_pending_ = true;
            pcr_why_ = "envelope-step";
        }
        pcr_.relock(true);
        pcr_.feed(sigma, h);
    }
    if (!degraded_) {
        if (epochs_.empty() || pcr_pending_) {
            open_epoch(Src::pcr, sigma, h, pcr_pending_ && !std::strcmp(pcr_why_, "envelope-step"));
            if (pcr_pending_) {
                relocks_++;
                emit(StcEvent::Kind::relock, pcr_why_, h, 0);
            }
            pcr_pending_ = false;
        } else {
            grow_epoch(Src::pcr, sigma, h);
        }
    }
    if (pcr_.has_fit()) val_.feed_rate(pcr_.fit_ppb(), h);
    check_failure(h);
    if (degraded_) try_recover(sigma, h);
}

void VirtualStc::feed_ref_pes(int pid, int64_t pts90k_unwrapped, int64_t h) {
    val_.feed_activity(h);
    check_failure(h);
    pcr_.tick(h);
    const int64_t sigma = pts90k_to_ns(pts90k_unwrapped);
    bool restart = false;
    const char* why = "";
    if (have_ref_ && pid != ref_pid_) {
        restart = true;
        why = "ref-change";
    } else if (have_ref_) {
        const int64_t ds = sat_sub(sigma, ref_sigma_);
        const int64_t miss = sat_sub(sat_add(ds, mul_ppb(ds, ref_.ppb())), sat_sub(h, ref_h_));
        if (miss > val_.config().leap_ns || miss < -val_.config().leap_ns) {
            restart = true;
            why = "leap";
            if (degraded_) emit(StcEvent::Kind::leap, "", h, sat_sub(ds, sat_sub(h, ref_h_)));
        }
    }
    have_ref_ = true;
    ref_pid_ = pid;
    ref_sigma_ = sigma;
    ref_h_ = h;
    bool pending = false;
    if (restart) {
        if (degraded_ && ref_.started()) {
            freeze_current();
            pending = true;
        }
        ref_.relock(true);
    }
    ref_.feed(sigma, h);
    if (ref_.envelope_step()) {
        if (degraded_) {
            emit(StcEvent::Kind::envelope_step, "", h, ref_.step_size_ns());
            freeze_current();
            pending = true;
            why = "envelope-step";
        }
        ref_.relock(true);
        ref_.feed(sigma, h);
    }
    if (!degraded_) return;
    if (pending || ref_pending_) {
        open_epoch(Src::ref, sigma, h, pending && !std::strcmp(why, "envelope-step"));
        if (pending) {
            relocks_++;
            emit(StcEvent::Kind::relock, why, h, 0);
        }
        ref_pending_ = false;
    } else {
        grow_epoch(Src::ref, sigma, h);
    }
}

VirtualStc::Mapping VirtualStc::map(int pid, int64_t pts90k_unwrapped, int64_t h) {
    return map_sigma(pid, pts90k_to_ns(pts90k_unwrapped), h, true);
}

VirtualStc::Mapping VirtualStc::map_pcr(int64_t h) {
    if (!have_pcr_) {
        Mapping m;
        m.house_ns = h;
        return m;
    }
    return map_sigma(PCR_KEY, pcr27_to_ns(pcr_unwrapped_), h, false);
}

VirtualStc::Mapping VirtualStc::map_sigma(int pid, int64_t sigma, int64_t h, bool lead_row) {
    val_.feed_activity(h);
    pcr_.tick(h);
    ref_.tick(h);
    // The lead row judges the PCR mapping, also while degraded (recovery needs it).
    if (lead_row && pcr_.started()) val_.feed_lead(pid, sat_sub(pcr_.house_of(sigma), h));
    check_failure(h);

    for (size_t i = 0; i + 1 < epochs_.size();) {
        if (sat_sub(h, epochs_[i].last_h) > RANGE_KEEP_NS) epochs_.erase(epochs_.begin() + (std::ptrdiff_t)i);
        else i++;
    }
    Mapping m;
    m.house_ns = h;
    if (epochs_.empty()) return m;

    // Straddle (OQ-11): the one range holding σ; none, the newest; several, the
    // lead closest to this PID's median lead before the re-lock (ties: newer).
    // The tie-break tells timelines apart, so one timeline's older ranges give way.
    const int64_t same = pcr_.config().step_ns;
    auto holds = [&](const Epoch& e) { return sigma >= e.lo && sigma <= e.hi; };
    // One timeline: closed by an envelope step, or mapping σ within step_ns of a newer
    // range (a same-clock PCR PID); left to the tie-break, jitter would flip PIDs.
    auto candidate = [&](size_t i) {
        if (epochs_[i].stepped || !holds(epochs_[i])) return false;
        const int64_t at = house_in(epochs_[i], sigma);
        for (size_t j = i + 1; j < epochs_.size(); j++) {
            if (!holds(epochs_[j])) continue;
            const int64_t d = sat_sub(house_in(epochs_[j], sigma), at);
            if (d <= same && d >= -same) return false;
        }
        return true;
    };
    PidLeads& pl = leads_[pid];
    const Epoch* pick = nullptr;
    int hits = 0;
    for (size_t i = 0; i < epochs_.size(); i++) {
        if (!candidate(i)) continue;
        hits++;
        pick = &epochs_[i];
    }
    if (hits == 0) {
        pick = &epochs_.back();
    } else if (hits > 1 && pl.has_before) {
        int64_t best = INT64_MAX;
        for (size_t i = 0; i < epochs_.size(); i++) {
            if (!candidate(i)) continue;
            const Epoch& e = epochs_[i];
            const int64_t d = sat_sub(sat_sub(house_in(e, sigma), h), pl.before);
            const int64_t ad = d < 0 ? sat_sub(0, d) : d;
            if (ad <= best) {
                best = ad;
                pick = &e;
            }
        }
    }
    m.house_ns = house_in(*pick, sigma);
    m.epoch = pick->id;
    m.valid = true;
    pl.w.push_back({h, sat_sub(m.house_ns, h)});
    while (pl.w.front().first < sat_sub(h, LEAD_WINDOW_NS)) pl.w.pop_front();
    return m;
}

void VirtualStc::tick(int64_t now_ns) {
    pcr_.tick(now_ns);
    ref_.tick(now_ns);
}

void VirtualStc::relock() {
    if (!degraded_ && pcr_.started()) {
        freeze_current();
        pcr_pending_ = true;
        pcr_why_ = "external";
    }
    pcr_.relock(true);
    val_.restart_pcr();
}

VirtualStc::State VirtualStc::state() const {
    if (degraded_) return ref_.phase() == ClockLock::Phase::lost ? State::lost : State::degraded;
    switch (pcr_.phase()) {
        case ClockLock::Phase::lost: return State::lost;
        case ClockLock::Phase::locked: return State::locked;
        default: return State::acquiring;
    }
}

VirtualStc::Stats VirtualStc::stats() {
    Stats s;
    const ClockLock& a = degraded_ ? ref_ : pcr_;
    s.state = state();
    s.reason = degraded_ ? degraded_reason_ : PcrValidator::Reason::none;
    s.ppb = a.ppb();
    s.offset_drift_ns = a.offset_drift_ns();
    s.residual = a.residual();
    s.pcr_interval_max_ns = val_.take_interval_max();
    s.relocks = relocks_;
    s.epoch = epochs_.empty() ? 0 : epochs_.back().id;
    s.cadence_warning = val_.cadence_warning();
    const int64_t w = a.config().rate_warn_ppm * 1000;
    s.rate_warning = s.ppb > w || s.ppb < -w;
    return s;
}

VirtualStc::LeadStats VirtualStc::lead(int pid) const {
    LeadStats out;
    const auto it = leads_.find(pid);
    if (it == leads_.end() || it->second.w.empty()) return out;
    std::vector<int64_t> v;
    for (const auto& p : it->second.w) v.push_back(p.second);
    std::sort(v.begin(), v.end());
    out.min_ns = v.front();
    out.max_ns = v.back();
    out.median_ns = v[(v.size() - 1) / 2];
    out.count = (uint32_t)v.size();
    return out;
}

std::vector<VirtualStc::EpochInfo> VirtualStc::epochs() const {
    std::vector<EpochInfo> out;
    for (const Epoch& e : epochs_) out.push_back(EpochInfo{e.id, e.lo, e.hi});
    return out;
}

int64_t VirtualStc::source_stc_90k() const {
    if (have_pcr_) return floor_div(pcr_unwrapped_, 300);
    return have_ref_ ? ns_to_pts90k(ref_sigma_) : 0;
}

std::vector<StcEvent> VirtualStc::take_events() {
    std::vector<StcEvent> out;
    out.swap(events_);
    return out;
}

}  // namespace mrts
