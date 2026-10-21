// hls-player's TS onto house time (plan ch. 6 WI-P2-5, design §5.4: house time at
// playout start plus the media offset), on the shared mrts primitives. The first
// timing PES lands at house now and every PES and PCR moves by that shift; a source
// jump on the reference PID re-anchors it, and a PID that did not jump keeps its place.
#pragma once
#include <cstddef>
#include <cstdint>
#include <map>
#include <vector>

#include "mrts/ts_house.h"
#include "mrts/ts_packet.h"
#include "mrts/ts_pes.h"
#include "mrts/ts_psi.h"

namespace mrfanout {

class HouseRebase {
  public:
    // A step of more than this on the reference PID, against its last PES plus
    // one spacing, is a new source timeline (an HLS discontinuity or a skip).
    static constexpr int64_t JUMP_90K = 90000;                 // 1 s
    // A reference PID with no timing PES for this long gives way to another.
    static constexpr int64_t REF_STALE_NS = 2000000000;        // 2 s
    // Adaptation-only packets kept behind a held split header, at most (R9).
    static constexpr size_t MAX_HELD_AF = 16;

    struct Stats {
        bool anchored = false;
        int64_t shift_90k = 0;            // bus - source, wrap-folded
        uint64_t reanchors = 0;
        uint64_t kept = 0;                // PIDs left on their own timeline at a re-anchor
        uint64_t dropped = 0;             // packets whose time could not be placed
        uint64_t desync_bytes = 0;        // skipped by the packet walk's resync
    };

    // Rewrites one ingest chunk at house time `now_ns`; `out` gets the bytes to
    // send: whole packets in order, a split PES header held until its next packet.
    void process(const uint8_t* data, size_t len, int64_t now_ns, std::vector<uint8_t>& out);
    Stats stats() const;

  private:
    struct Pid {
        mrts::Unwrapper unwrap;
        int cls = 0;                      // 2 video, 1 audio, 0 other (its last timing PES)
        bool have_key = false;
        int64_t key = 0;                  // last timing PES's DTS, else PTS: unwrapped source
        int64_t key_out = 0;              // the same on the bus, on its mapping
        int64_t steps[3] = {0, 0, 0};     // its last key steps of at most JUMP_90K
        uint8_t n_steps = 0, step_at = 0;
        bool jumped = false;              // it left its own timeline since the reference's last PES
        // Its mapping is shift_ + delta. A re-anchor leaves it in place (`pending`) until its
        // next timing PES shows whether it jumped too, and so takes that reference's (`join`).
        int64_t delta = 0, join = 0;
        bool pending = false;
        int64_t seen_ns = 0;              // house time of that PES
        bool pcr_sent = false;
        int64_t pcr_map = 0;              // the mapping its last PCR was written with
        int cc = -1;                      // its last payload packet's CC
        bool drop = false;                // drop its payload packets until its next PUSI
        std::vector<uint8_t> held_af;     // adaptation-only packets behind a held header
    };

    void on_packet(mrts::PacketView& v);
    bool release(Pid& p, mrts::PacketView& v);
    bool retime(Pid& p, int pid, const mrts::PesHeader& h, int64_t& pts33, int64_t& dts33);
    void track(Pid& p, int pid, uint8_t sid, int64_t key, int64_t pts);
    // One nominal spacing: the upper median of its last three steps (as B-21's PES
    // length), so one hole is no spacing.
    static int64_t spacing(const Pid& p);
    int rank(int pid) const;
    int pcr_pid() const;
    bool send(mrts::PacketView& v);
    bool send(uint8_t* pkt);
    void put(const uint8_t* pkt) { out_->insert(out_->end(), pkt, pkt + mrts::PKT); }

    mrts::PacketWalker walker_;
    mrts::PesHeaderSpan span_;
    mrts::PsiDiscovery psi_;
    std::vector<mrts::TsPacket> one_ = std::vector<mrts::TsPacket>(1);
    std::map<int, Pid> pids_;
    std::vector<uint8_t> in_;             // the chunk, owned here: rewritten in place
    std::vector<uint8_t>* out_ = nullptr;
    bool anchored_ = false;
    int64_t shift_ = 0;                   // bus 90 kHz - source 90 kHz
    int first_pcr_pid_ = -1;              // the PCR PID until a PMT names one
    int ref_ = -1;                        // the PID whose jumps re-anchor
    int64_t now_ = 0, now_bus_ = 0;       // house ns; the same as a bus PTS, unwrapped
    uint64_t reanchors_ = 0, kept_ = 0, dropped_ = 0;
};

}  // namespace mrfanout
