// C++ port of subtitle_ts.PesStamper (plugins/subtitle-core/py/subtitle_ts.py):
// assembles the PES of one stream_id (private_stream_1 by default) across bus
// chunks and gives each the house time of the chunk it STARTED in. Packet and
// PES-header reads come from mrts (ts_psi.h); the python module is the spec.
#pragma once
#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <vector>

#include "stamp_model.h"

namespace mrpeshouse {

constexpr int STREAM_ID_PRIVATE_1 = 0xBD;
constexpr size_t MAX_PES_BYTES = 65536;

// One completed PES; `pts` -1 = its header carried none.
struct DonePes {
    int pid;
    int64_t pts;
    std::vector<uint8_t> payload;
    std::optional<double> house_ms;     // nullopt = no mapping when it started
};

// A PES header at the start of `p` (`n` bytes): python's parse_pes_header.
struct PesHeader {
    int sid;
    int64_t pts;                        // -1 = none
    int header_len;
    int64_t need;                       // payload bytes, -1 = unbounded
};
std::optional<PesHeader> parse_pes_header(const uint8_t* pkt, int off);

class PesWalker {
  public:
    explicit PesWalker(int sid = STREAM_ID_PRIVATE_1) : sid_(sid) {}
    // nullopt = every PID of `sid`; else only these (python's `pids`).
    void set_pids(std::optional<std::set<int>> pids) { pids_ = std::move(pids); }
    // Every PES completed in this packet-aligned chunk, in completion order.
    std::vector<DonePes> feed(const uint8_t* data, size_t len, std::optional<double> chunk_ms);
    int pcr_pid() const { return pcr_pid_; }
    const StampModel& model() const { return model_; }

  private:
    struct Open {
        int64_t pts;
        std::optional<double> house_ms;
        std::vector<uint8_t> buf;
        int64_t need;
    };
    using Rec = std::shared_ptr<Open>;
    void add(int pid, const Rec& rec, const uint8_t* p, size_t n,
             std::vector<std::pair<int, Rec>>& done);

    int sid_;
    std::optional<std::set<int>> pids_;
    int pcr_pid_ = -1;
    std::map<int, Rec> open_;
    StampModel model_;
};

}  // namespace mrpeshouse
