// The PES index of a transport stream as JSON lines: every PES of the followed program,
// each PAT/PMT change and the final counters. `mrts_cli dump` prints it and
// ts_conformance_test compares it with a fixture's .expect.jsonl (plan ch. 3 part 7.2).
#pragma once
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "ts_house.h"
#include "ts_packet.h"
#include "ts_pes.h"
#include "ts_psi.h"

namespace mrts {

// zlib's CRC-32, not the PSI one (crc32_mpeg): a payload's crc32 then compares
// directly with `ffprobe -show_data_hash CRC32` and python's zlib.crc32.
uint32_t crc32_zlib(const uint8_t* data, size_t n);

// PSI goes to discovery one packet at a time and the PES PIDs follow each PMT change
// at once, so the chunking of feed() changes nothing on intact input; on garbage the
// walker's resync can still land elsewhere near a chunk edge (ts_split's rule).
class PesIndex {
  public:
    using Sink = std::function<void(const std::string& line)>;
    // program: the PAT's program to follow; -1 = its first.
    explicit PesIndex(Sink sink, int program = -1);
    void feed(uint8_t* data, size_t len);
    void finish();                        // flushes open PES, then the counters line

  private:
    void packet(const PacketView& v);
    void psi(const PacketView& v);
    void emit_units();

    Sink sink_;
    PacketWalker walker_;
    CcTracker cc_;
    PsiDiscovery disc_;
    PesAssembler pes_;                    // keep_payload: the crc32 needs the bytes
    std::vector<TsPacket> one_ = std::vector<TsPacket>(1);
    std::vector<PesUnit> units_;
    std::set<int> selected_;
    std::map<int, Unwrapper> uw_;
    uint64_t dts_discarded_ = 0;          // of PIDs the PMT dropped
    int64_t ref_ = 0;
    bool have_ref_ = false;
    int pmt_pid_ = -1, program_ = -1, gen_ = 0;
};

}  // namespace mrts
