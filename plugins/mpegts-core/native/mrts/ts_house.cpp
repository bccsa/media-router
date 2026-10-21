#include "ts_house.h"

#include "ts_packet.h"
#include "ts_pcr.h"
#include "ts_pes.h"
#include "ts_timeline.h"                  // timing_pes, kept until Phase 3

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

// PTS of the PES header that starts in `pkt`, or -1: read_pes_pts on a synced packet.
int64_t pes_pts(const uint8_t* pkt) {
    if (pkt[0] != SYNC_BYTE || !ts_pusi(pkt) || !ts_has_payload(pkt)) return -1;
    const int off = payload_offset(pkt);
    PesHeader h;
    return off < PKT && parse_pes_header(pkt + off, PKT - off, &h) ? h.pts : -1;
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

int64_t IdentityStamp::stamp(const uint8_t* data, size_t len, int64_t house_now, int stream) {
    Stream& st = streams_[stream];
    // The whole buffer first: a PCR after the PES still makes its PID timing.
    for (size_t off = 0; st.timing_pid < 0 && off + PKT <= len; off += PKT)
        if (data[off] == SYNC_BYTE && read_pcr(data + off) >= 0) st.timing_pid = ts_pid(data + off);
    bool any_pes = false, timing = false;
    int64_t s = 0;
    for (size_t off = 0; off + PKT <= len; off += PKT) {
        const uint8_t* pkt = data + off;
        const int64_t pts = pes_pts(pkt);
        if (pts < 0) continue;
        any_pes = true;
        const int pid = ts_pid(pkt);
        if (!timing_pes(pkt, pid, st.timing_pid)) continue;
        timing = true;
        s = house_from_mux_pts(pts, house_now);
        if (!st.has_first) {
            st.has_first = true;
            st.first_pid = pid;
            st.first_stamp = s;
            st.first_pts = pts;
        }
        break;
    }
    if (!timing) s = (any_pes || !st.stamped) ? house_now : st.floor;
    if (s < st.floor) s = st.floor;
    st.floor = s;
    st.stamped = true;
    return s;
}

bool IdentityStamp::first(int stream, int* pid, int64_t* stamp_ns, int64_t* pts) const {
    const auto it = streams_.find(stream);
    if (it == streams_.end() || !it->second.has_first) return false;
    if (pid) *pid = it->second.first_pid;
    if (stamp_ns) *stamp_ns = it->second.first_stamp;
    if (pts) *pts = it->second.first_pts;
    return true;
}

void IdentityStamp::reset() { streams_.clear(); }

}  // namespace mrts
