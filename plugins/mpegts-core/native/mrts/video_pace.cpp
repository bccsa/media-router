// mrts::VideoPace: ../../py/video_pace.py line for line. Sums and products that can leave 64 bits
// on wire input run in 128, so every int64 input gives the reference's answer.
#include "video_pace.h"

#include <algorithm>
#include <cstring>
#include <vector>

namespace mrts {

namespace {

constexpr int64_t MIN_SPAN_NS = 60000000000LL;   // a display period from less is flagged short
constexpr int64_t STEP_TOLERANCE_DEN = 10;        // 10 %: a step near its refresh multiple

int64_t clamp64(__int128 v) {
    if (v > INT64_MAX) return INT64_MAX;
    if (v < INT64_MIN) return INT64_MIN;
    return (int64_t)v;
}

__int128 abs128(__int128 v) { return v < 0 ? -v : v; }

// num / den to the nearest integer, halves up (num >= 0, den > 0).
__int128 round_div(__int128 num, __int128 den) { return (2 * num + den) / (2 * den); }

}  // namespace

const char* display_source_name(DisplaySource s) {
    switch (s) {
        case DisplaySource::nominal: return "nominal";
        case DisplaySource::measured: return "measured";
        default: return "none";
    }
}

bool parse_display_source(const char* name, DisplaySource* out) {
    if (!std::strcmp(name, "none")) *out = DisplaySource::none;
    else if (!std::strcmp(name, "nominal")) *out = DisplaySource::nominal;
    else if (!std::strcmp(name, "measured")) *out = DisplaySource::measured;
    else return false;
    return true;
}

VideoPace::VideoPace(int64_t gap_threshold_ns) : gap_threshold_ns_(gap_threshold_ns) {}

void VideoPace::set_display(int64_t period_ns, DisplaySource source) {
    if (period_ns <= 0 || source == DisplaySource::none) {
        period_ns = 0;
        source = DisplaySource::none;
    }
    display_period_ = period_ns;
    display_source_ = source;
}

// The window keeps the last PERIOD_WINDOW deltas; the sorted copy is the same multiset.
void VideoPace::add_clean(int64_t delta) {
    if (window_n_ == PERIOD_WINDOW) {
        const int64_t old = window_[window_head_];
        window_head_ = (window_head_ + 1) % PERIOD_WINDOW;
        window_n_--;
        int64_t* at = std::lower_bound(ordered_, ordered_ + window_n_ + 1, old);
        std::memmove(at, at + 1, (size_t)(ordered_ + window_n_ - at) * sizeof(int64_t));
    }
    window_[(window_head_ + window_n_) % PERIOD_WINDOW] = delta;
    int64_t* at = std::upper_bound(ordered_, ordered_ + window_n_, delta);
    std::memmove(at + 1, at, (size_t)(ordered_ + window_n_ - at) * sizeof(int64_t));
    *at = delta;
    window_n_++;
}

bool VideoPace::decimating(int64_t tc) const {
    if (display_source_ == DisplaySource::measured) return true;
    return display_source_ == DisplaySource::nominal && tc > 0 &&
           ((__int128)display_period_ - tc) * NOMINAL_BAND_DEN > tc;
}

PaceDecision VideoPace::on_frame(int64_t pts_ns, int64_t dur_ns, int64_t arrival_ns, bool discont) {
    const int64_t tc = content_period();
    const int64_t nominal = dur_ns > 0 ? dur_ns : tc;
    // min(gap threshold, 4 x nominal) without forming a product past the threshold.
    const int64_t threshold =
        nominal > 0 && nominal <= gap_threshold_ns_ / 4 ? 4 * nominal : gap_threshold_ns_;
    bool collapsed = false;
    int64_t delta = 0, release = arrival_ns;
    if (have_prev_) {
        const __int128 d = (__int128)pts_ns - prev_pts_;
        collapsed = gap_pending_ || discont || d < 0 || d > threshold;
        if (collapsed) {
            delta = nominal;
            gaps_collapsed_++;
        } else if (d == 0) {
            delta = nominal;   // a held PTS (B-160 F7) takes the nominal cadence, uncounted
        } else {
            delta = (int64_t)d;
            add_clean(delta);
        }
        const __int128 slot = (__int128)prev_release_ + delta;
        release = clamp64(std::max<__int128>(arrival_ns, slot));
        if (arrival_ns > slot && !collapsed) late_++;
    }
    bool drop = false;
    if (!decimating(tc)) {
        lag_ = 0;
    } else {
        const int64_t whole = nominal > 0 ? nominal : delta;
        __int128 lag = std::max<__int128>((__int128)lag_ - delta, collapsed ? 0 : -(__int128)whole);
        drop = whole > 0 && lag >= whole;
        if (!drop) lag += display_period_;
        lag_ = clamp64(lag);
    }
    prev_pts_ = pts_ns;
    prev_release_ = release;
    have_prev_ = true;
    gap_pending_ = false;
    if (drop) {
        rate_drops_++;
    } else {
        released_++;
        hold_sum_ += (__int128)release - arrival_ns;
        hold_count_++;
    }
    return PaceDecision{release, drop};
}

PaceSummary VideoPace::peek() const {
    PaceSummary s;
    s.released = released_;
    s.late = late_;
    s.rate_drops = rate_drops_;
    s.gaps_collapsed = gaps_collapsed_;
    s.content_period = content_period();
    s.display_period = display_period_;
    s.display_source = display_source_;
    s.mean_hold = hold_count_ ? clamp64(hold_sum_ / (__int128)hold_count_) : 0;
    return s;
}

PaceSummary VideoPace::take() {
    const PaceSummary s = peek();
    hold_sum_ = 0;
    hold_count_ = 0;
    return s;
}

DisplayPeriod display_period_from_feedback(const PresentedSample* samples, size_t n) {
    std::vector<__int128> periods;
    for (size_t i = 1; i < n; i++) {
        const PresentedSample &a = samples[i - 1], &b = samples[i];
        if (b.presented_ns > a.presented_ns && b.seq > a.seq)
            periods.push_back(((__int128)b.presented_ns - a.presented_ns) /
                              ((__int128)b.seq - a.seq));
    }
    if (periods.empty()) return DisplayPeriod{0, true};
    std::nth_element(periods.begin(), periods.begin() + periods.size() / 2, periods.end());
    const __int128 median = periods[periods.size() / 2];
    __int128 t_sum = 0, s_sum = 0;
    for (size_t i = 1; i < n; i++) {
        const PresentedSample &a = samples[i - 1], &b = samples[i];
        if (!(b.presented_ns > a.presented_ns && b.seq > a.seq)) continue;
        const __int128 dt = (__int128)b.presented_ns - a.presented_ns;
        const __int128 ds = (__int128)b.seq - a.seq;
        // |dt - ds m| x 10 <= ds m, in integers: |dt - ds m| <= floor(ds m / 10).
        if (abs128(dt - ds * median) <= ds * median / STEP_TOLERANCE_DEN) {
            t_sum += dt;
            s_sum += ds;
        }
    }
    if (s_sum == 0) return DisplayPeriod{0, true};
    return DisplayPeriod{clamp64(round_div(t_sum, s_sum)), t_sum < MIN_SPAN_NS};
}

DisplayPeriod display_period_from_returns(const int64_t* times, size_t n, int64_t prior_ns) {
    // Each interval as round(interval / base) refreshes, kept within 10 % of the base of it.
    auto fit = [times, n](__int128 base, __int128* t_sum, __int128* n_sum) {
        *t_sum = *n_sum = 0;
        for (size_t i = 1; i < n; i++) {
            if (times[i] <= times[i - 1]) continue;
            const __int128 iv = (__int128)times[i] - times[i - 1];
            const __int128 k = round_div(iv, base);
            if (k >= 1 && abs128(iv - k * base) <= base / STEP_TOLERANCE_DEN) {
                *t_sum += iv;
                *n_sum += k;
            }
        }
    };
    __int128 smallest = -1;
    for (size_t i = 1; i < n; i++) {
        if (times[i] <= times[i - 1]) continue;
        const __int128 iv = (__int128)times[i] - times[i - 1];
        if (smallest < 0 || iv < smallest) smallest = iv;
    }
    if (smallest < 0) return DisplayPeriod{0, true};
    __int128 t_sum = 0, n_sum = 0;
    if (prior_ns > 0) fit(prior_ns, &t_sum, &n_sum);
    if (n_sum == 0) {
        __int128 near_sum = 0, near_n = 0;
        for (size_t i = 1; i < n; i++) {
            if (times[i] <= times[i - 1]) continue;
            const __int128 iv = (__int128)times[i] - times[i - 1];
            if (iv - smallest <= smallest / STEP_TOLERANCE_DEN) {
                near_sum += iv;
                near_n++;
            }
        }
        fit(near_sum / near_n, &t_sum, &n_sum);
    }
    if (n_sum == 0) return DisplayPeriod{0, true};
    return DisplayPeriod{clamp64(round_div(t_sum, n_sum)), t_sum < MIN_SPAN_NS};
}

}  // namespace mrts
