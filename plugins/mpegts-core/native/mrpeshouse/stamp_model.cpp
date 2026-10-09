// Rule-for-rule port of subtitle_stamp_model.py; keep the operation order
// identical (doubles, `u / 90.0`) so the parity vectors match bit for bit.
#include "stamp_model.h"

#include <cmath>

namespace mrpeshouse {

bool timing_stream_id(int sid) { return (sid & 0xF0) == 0xE0 || (sid & 0xE0) == 0xC0; }

int64_t fold_ticks(int64_t d) {
    d %= PTS_WRAP;
    if (d < 0) d += PTS_WRAP;       // python's modulo is never negative
    return d > PTS_WRAP / 2 ? d - PTS_WRAP : d;
}

Reference chunk_reference(const std::vector<Head>& heads, int pcr_pid) {
    std::optional<int64_t> first, pcr;
    for (const Head& h : heads) {
        if (!first && timing_stream_id(h.sid)) first = h.pts;
        if (!pcr && h.pid == pcr_pid) pcr = h.pts;
    }
    if (!pcr) return {first, true};
    return {pcr, !first || *first == *pcr};
}

void StampModel::drop() {
    if (k_) resyncs_++;
    k_.reset();
}

void StampModel::observe(std::optional<double> chunk_ms, std::optional<int64_t> ref_pts, bool sure) {
    if (!chunk_ms) return;
    std::optional<double> prev = prev_;
    prev_ = chunk_ms;
    std::optional<int64_t> u;
    if (ref_pts) u = last_ = unwrap(*ref_pts);
    if (prev && *chunk_ms < *prev) {
        drop();                     // the stream restarted
        return;
    }
    if (!u) return;                 // arrival or floor repeat: K unchanged
    if (!sure) return;              // the rules disagree: keep K (a miss, never wrong)
    if (!prev || *chunk_ms > *prev) {
        double k = *chunk_ms - (double)*u / 90.0;   // the stamp rose: it IS this PES's mapping
        if (k_ && std::fabs(k - *k_) > REANCHOR_FWD_MS) drop();
        else k_ = k;
    } else if (k_) {
        double mapped = *k_ + (double)*u / 90.0;
        if (mapped > *chunk_ms + REANCHOR_FWD_MS || mapped < *chunk_ms - REANCHOR_BACK_MS)
            drop();                 // clamped, yet off the mapping: re-anchored
    }
}

std::optional<double> StampModel::house(std::optional<int64_t> pts) const {
    if (!k_ || !pts) return std::nullopt;
    return *k_ + (double)unwrap(*pts) / 90.0;
}

}  // namespace mrpeshouse
