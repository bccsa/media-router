#include "ts_rebase.h"

#include <cstring>
#include <vector>

#include "ts_house.h"
#include "ts_packet.h"
#include "ts_pcr.h"
#include "ts_pes.h"

namespace mrts {
namespace {

int64_t floor_mod(int64_t a, int64_t m) {
    const int64_t r = a % m;
    return r < 0 ? r + m : r;
}

// A signed distance folded into (-m/2, m/2].
int64_t fold(int64_t d, int64_t m) {
    const int64_t r = floor_mod(d, m);
    return r > m / 2 ? r - m : r;
}

// d * (1 + ppm 1e-6), half away from zero: |d| < 2^42 (a folded PCR) and |ppm| <= 1e6 fit.
int64_t scale_round(int64_t d, int64_t ppm) {
    const int64_t n = d * (1000000 + ppm);
    return n >= 0 ? (n + 500000) / 1000000 : -((-n + 500000) / 1000000);
}

// The walk both rewriters share. pes(header, packet offset of its start, pts33&, dts33&): the
// values preset to the header's are written back as the callback leaves them.
template <class Pcr, class Pes>
TsRewrite walk(uint8_t* data, size_t len, Pcr&& pcr, Pes&& pes) {
    TsRewrite r;
    PacketWalker walker;
    PesHeaderSpan span;
    std::vector<size_t> held_at(8192, 0);   // the held PUSI packet's offset, per PID
    uint64_t holding = 0;
    // One feed of the whole buffer: no packet is joined, so every view points into `data`.
    walker.feed(data, len, [&](PacketView& v) {
        // The PCR first: a header the span holds keeps the rewritten field in its copy.
        if (v.af_pcr) {
            write_pcr(v, floor_mod(pcr(read_pcr(v.p)), PCR_MODULO));
            r.pcr++;
        }
        if (v.payload_off >= PKT) return;
        if (span.held(v.pid)) {
            uint8_t first[PKT];
            bool joined = false;
            const size_t at = held_at[v.pid];
            span.complete(v, first, [&](const PesHeader& h, int64_t& pts33, int64_t& dts33) {
                joined = true;
                if (h.pts < 0) return;
                pes(h, at, pts33, dts33);
                r.pes++;
                r.spans++;
            });
            std::memcpy(data + at, first, PKT);
            holding--;
            if (joined) return;
            r.broken++;
            if (!v.pusi) return;              // the PES it continued: no time to place
        }
        if (!v.pusi) return;
        if (span.hold(v)) {                   // the header continues in the PID's next packet
            held_at[v.pid] = (size_t)(v.p - data);
            holding++;
            return;
        }
        PesHeader h;
        // A section on a PES PID, a header without PTS, or a copy's twin the span let pass.
        if (!parse_pes_header(v.p + v.payload_off, PKT - v.payload_off, &h) || !h.complete || h.pts < 0) return;
        int64_t pts33 = h.pts, dts33 = h.dts;
        pes(h, (size_t)(v.p - data), pts33, dts33);
        if (rewrite_pes_timestamps(v, h, pts33, dts33)) r.pes++;
    });
    r.broken += holding;                      // held at the end: left as they were
    return r;
}

}  // namespace

TsRewrite rewrite_timestamps(uint8_t* data, size_t len, const std::function<int64_t(int64_t)>& pts,
                             const std::function<int64_t(int64_t)>& pcr) {
    return walk(data, len, pcr, [&](const PesHeader& h, size_t, int64_t& pts33, int64_t& dts33) {
        pts33 = floor_mod(pts(h.pts), PTS_WRAP);
        if (h.dts >= 0) dts33 = floor_mod(pts(h.dts), PTS_WRAP);
    });
}

int64_t first_pes_pts(const uint8_t* data, size_t len, int* pid) {
    // The rewriters' walk on a copy, every value left as it is: a split header counts at its start.
    std::vector<uint8_t> copy(data, data + len);
    size_t best = SIZE_MAX;
    int64_t pts = -1;
    int best_pid = -1;
    walk(copy.data(), copy.size(), [](int64_t v) { return v; },
         [&](const PesHeader& h, size_t at, int64_t&, int64_t&) {
             if (at >= best) return;
             best = at;
             pts = h.pts;
             best_pid = ts_pid(copy.data() + at);
         });
    if (pid) *pid = best_pid;
    return pts;
}

TsRewrite rebase_ts(uint8_t* data, size_t len, int64_t shift_90k) {
    const int64_t d = floor_mod(shift_90k, PTS_WRAP);
    return rewrite_timestamps(
        data, len, [d](int64_t v) { return v + d; },
        [d](int64_t pcr27) { return (pcr27 / 300 + d) % PTS_WRAP * 300 + pcr27 % 300; });
}

TsRewrite respace_ts(uint8_t* data, size_t len, int64_t origin_90k, int64_t ppm) {
    const int64_t o = floor_mod(origin_90k, PTS_WRAP), o27 = o * 300;
    return rewrite_timestamps(
        data, len, [o, ppm](int64_t v) { return o + scale_round(fold(v - o, PTS_WRAP), ppm); },
        [o27, ppm](int64_t pcr27) { return o27 + scale_round(fold(pcr27 - o27, PCR_MODULO), ppm); });
}

}  // namespace mrts
