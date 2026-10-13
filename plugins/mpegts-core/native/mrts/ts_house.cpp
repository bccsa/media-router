#include "ts_house.h"

namespace mrts {
namespace {

// Python's `//` and `%` for a positive divisor: C++ truncates toward zero,
// which would round a negative delta the other way from the reference.
int64_t floor_div(int64_t a, int64_t b) {
    const int64_t q = a / b;
    return (a % b != 0 && a < 0) ? q - 1 : q;
}

int64_t floor_mod(int64_t a, int64_t m) {
    const int64_t r = a % m;
    return r < 0 ? r + m : r;
}

// floor(v * num / den) without forming v * num: v = q * den + r, 0 <= r < den,
// so the product left is r * num, which is tiny.
int64_t scale_floor(int64_t v, int64_t num, int64_t den) {
    const int64_t q = floor_div(v, den);
    return q * num + (v - q * den) * num / den;
}

}  // namespace

int64_t pts90k_to_ns(int64_t ticks) { return scale_floor(ticks, 100000, 9); }

int64_t ns_to_pts90k(int64_t ns) { return scale_floor(ns, 9, 100000); }

int64_t ns_to_pcr27(int64_t ns) { return floor_mod(scale_floor(ns, 27, 1000), PCR_MODULO); }

int64_t pcr27_to_ns(int64_t pcr27) { return scale_floor(pcr27, 1000, 27); }

int64_t fold33(int64_t d) {
    const int64_t r = floor_mod(d, PTS_WRAP);
    return r > PTS_WRAP / 2 ? r - PTS_WRAP : r;
}

int64_t unwrap_near(int64_t pts33, int64_t ref) { return ref - fold33(ref - pts33); }

int64_t house_from_mux_pts(int64_t pts33, int64_t house_now_ns) {
    const int64_t raw = floor_mod(pts33 - MUX_CLOCK_BASE_90K, PTS_WRAP);
    return pts90k_to_ns(unwrap_near(raw, ns_to_pts90k(house_now_ns)));
}

int64_t mux_pts_from_house(int64_t house_ns) {
    return floor_mod(ns_to_pts90k(house_ns) + MUX_CLOCK_BASE_90K, PTS_WRAP);
}

int64_t Unwrapper::feed(int64_t pts33, int64_t seed) {
    last_ = unwrap_near(pts33, primed_ ? last_ : seed);
    primed_ = true;
    return last_;
}

int64_t Unwrapper::feed_dts(int64_t dts33, int64_t pts_unwrapped) {
    if (dts33 < 0) return NO_DTS;
    const int64_t dts = unwrap_near(dts33, pts_unwrapped);
    if (dts < pts_unwrapped - DTS_MAX_GAP_90K || dts > pts_unwrapped + DTS_MAX_GAP_90K) {
        dts_discarded_++;
        return NO_DTS;
    }
    return dts;
}

void Unwrapper::reset() {
    last_ = 0;
    primed_ = false;
}

int64_t NetEpoch::e_90k() const { return ns_to_pts90k(e_ns); }

int64_t bus_to_net(int64_t pts33, const NetEpoch& e) {
    return floor_mod(pts33 + e.e_90k() - MUX_CLOCK_BASE_90K, PTS_WRAP);
}

int64_t net_to_bus(int64_t pts33, const NetEpoch& e) {
    return floor_mod(pts33 - e.e_90k() + MUX_CLOCK_BASE_90K, PTS_WRAP);
}

int64_t net_pcr27(int64_t h_emission_ns, int64_t d_e_ns) {
    return ns_to_pcr27(h_emission_ns - d_e_ns);
}

}  // namespace mrts
