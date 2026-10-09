// C++ port of plugins/subtitle-core/py/subtitle_stamp_model.py — the program's
// house mapping K (house ms = K + PTS/90) read back off the floored bus-chunk
// stamps. The python module is the spec; this is a rule-for-rule port, pinned
// bit-exact by tests/stamp_model_test.cpp against vectors the python dumped.
#pragma once
#include <cstdint>
#include <optional>
#include <vector>

namespace mrpeshouse {

constexpr int64_t PTS_WRAP = 1LL << 33;
// A clamped chunk's reference this far above / below its stamp, or a rise
// implying a K this far off, is a re-anchor (python's constants, verbatim).
constexpr double REANCHOR_FWD_MS = 300.0;
constexpr double REANCHOR_BACK_MS = 2500.0;

// One PES header with a PTS, in packet order: (pid, stream_id, pts).
struct Head {
    int pid;
    int sid;
    int64_t pts;
};

// The PES the engine mapped for a chunk; `sure` = both rules pick it.
struct Reference {
    std::optional<int64_t> pts;
    bool sure;
};

// Video or audio stream_id — what may define a chunk's stamp.
bool timing_stream_id(int sid);

// Signed 33-bit-wrap-folded PTS delta (90 kHz ticks), python `%` semantics.
int64_t fold_ticks(int64_t d);

// The PCR PID's first PES, else the first video/audio PES; `pcr_pid` -1 = none.
Reference chunk_reference(const std::vector<Head>& heads, int pcr_pid);

class StampModel {
  public:
    // Feed EVERY chunk in order; nullopt chunk_ms = an unstamped buffer.
    void observe(std::optional<double> chunk_ms, std::optional<int64_t> ref_pts, bool sure);
    std::optional<double> house(std::optional<int64_t> pts) const;
    std::optional<double> k() const { return k_; }
    // Times a known K was dropped (restart or re-anchor) — observability only.
    uint64_t resyncs() const { return resyncs_; }

  private:
    int64_t unwrap(int64_t pts) const { return last_ ? *last_ + fold_ticks(pts - *last_) : pts; }
    void drop();

    std::optional<double> k_;
    std::optional<double> prev_;     // last chunk stamp (ms)
    std::optional<int64_t> last_;    // last reference PTS, unwrapped
    uint64_t resyncs_ = 0;
};

}  // namespace mrpeshouse
