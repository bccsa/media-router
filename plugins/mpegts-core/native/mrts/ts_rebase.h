// Timestamp rewrites of a whole transport stream held in memory, for the test tools
// (`mrts_cli rebase`, `fixture_gen --respace`; plan ch. 7 WI-P3-3): every PES PTS/DTS and
// every PCR through one mapping, in place, every other byte as it was. A PES header split
// over two packets is rewritten across both (PesHeaderSpan).
#pragma once
#include <cstddef>
#include <cstdint>
#include <functional>

namespace mrts {

struct TsRewrite {
    uint64_t pes = 0;      // PES headers with a PTS, rewritten
    uint64_t pcr = 0;      // PCRs rewritten
    uint64_t spans = 0;    // of those PES, headers split over two packets
    uint64_t broken = 0;   // split headers left as they were: a CC gap, a new PES, a copy or the end cut them
};

// `pts` maps a 33-bit PTS or DTS (written mod 2^33), `pcr` a 27 MHz PCR (written mod
// PCR_MODULO). Bytes between packets (a resync) and a tail shorter than a packet stay.
TsRewrite rewrite_timestamps(uint8_t* data, size_t len, const std::function<int64_t(int64_t)>& pts,
                             const std::function<int64_t(int64_t)>& pcr);

// The PTS of the first PES start in byte order that carries one, a split header's
// included; -1 without one. *pid: its PID.
int64_t first_pes_pts(const uint8_t* data, size_t len, int* pid = nullptr);

// Every PES timestamp and PCR base `shift_90k` ticks later, mod 2^33; the PCR extension kept.
TsRewrite rebase_ts(uint8_t* data, size_t len, int64_t shift_90k);

// Every timestamp's distance from `origin_90k` (a PTS; the PCR's from origin x 300), folded
// to within half the wrap, times (1 + ppm 1e-6), rounded half away from zero.
TsRewrite respace_ts(uint8_t* data, size_t len, int64_t origin_90k, int64_t ppm);

}  // namespace mrts
