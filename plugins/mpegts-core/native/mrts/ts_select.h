// The select-mode formula demux (plan ch. 6 WI-P2-7): one elementary stream of one program
// on the formula timeline, PTS = unwrap(PES PTS) - 1 h, with a gap for a hole in its PTS and
// for each bus gap marker (OQ-12) on its PID. GStreamer-free: mrtsdemux is its element, and
// Phase 3's DemuxCore generalises it (WI-P3-1).
#pragma once
#include <cstddef>
#include <cstdint>
#include <vector>

#include "ts_house.h"
#include "ts_packet.h"
#include "ts_pes.h"
#include "ts_psi.h"

namespace mrts {

// The streams `select` names. Phase 2 has one: SMPTE 302M, PMT stream type 0x06 whose first
// ES registration descriptor is 'BSSD' (tsdemux's rule).
enum class SelectStream { none, smpte302m };
SelectStream select_stream(const char* caps_name);   // "audio/x-smpte-302m"; else none
const char* select_caps_name(SelectStream s);        // the caps tsdemux gives the stream
bool select_matches(SelectStream s, const PmtStream& es);

// 48 kHz frames in one 302M PES payload, from its 4-byte AES3 header (SMPTE 302M 7), or -1
// when the payload is no whole 302M frame (ffmpeg's s302m header check).
int64_t s302m_frames(const uint8_t* payload, size_t n);

class SelectDemux {
  public:
    static constexpr int64_t NO_STREAM_NS = 2000000000;    // a PMT without the stream this long
    static constexpr int JUMP_FRAMES = 2;                   // a hole past this many frames is a gap
    static constexpr int SPACING_WINDOW = 8;                // the frame is the median of these
    static constexpr int64_t SPACING_MAX_NS = 1000000000;   // a longer PES spacing is no frame

    struct Config {
        SelectStream stream = SelectStream::smpte302m;
        int program = -1;                     // -1: the PAT's first
        size_t max_pes_bytes = 32u << 20;     // PesAssembler's cap (R9)
    };
    // No PMT yet; the PMT lists the stream; the PMT does not.
    enum class State { waiting, found, missing };
    struct Out {
        enum class Kind { found, unit, gap, no_stream } kind = Kind::unit;
        int pid = -1;
        // unit: PTS, DTS (= PTS without one) and the 302M duration, ns, -1 none.
        // gap: [pts_ns, pts_ns + dur_ns).
        int64_t pts_ns = -1, dts_ns = -1, dur_ns = -1;
        bool discont = false;                 // unit: the pad's first, or content lost before
        const char* reason = "";              // gap: "jump" or "marker"
        std::vector<uint8_t> payload;         // unit: the PES payload
    };
    struct Counters {
        uint64_t pes = 0, gaps = 0, markers = 0, markers_dropped = 0, pes_no_pts = 0;
        uint64_t desync_bytes = 0, cc_lost = 0, pes_oversize = 0, pes_dropped_cc = 0,
                 psi_unsupported_sections = 0, dts_discarded = 0;
    };

    SelectDemux();
    explicit SelectDemux(const Config& cfg);
    // One bus buffer of TS bytes, any chunking. `house_now_ns`: clock - base time, < 0 without
    // a clock (the first PES then seeds on its own value). `discont`: bytes may be missing.
    void feed(const uint8_t* d, size_t n, bool discont, int64_t house_now_ns,
              std::vector<Out>& out);
    // A gap-marker buffer: whole packets, `end_ns` its PTS as running time (< 0: unplaced).
    // Only the selected PID's marker packets count; never fed to the walk.
    void marker(const uint8_t* d, size_t n, int64_t end_ns, std::vector<Out>& out);
    void drain(std::vector<Out>& out);        // EOS: an open unbounded PES
    // FLUSH_STOP: the carry, open PES, CC and unwrap state and the pad's horizon; PSI stays.
    void flush();
    State state() const { return state_; }
    int pid() const { return pid_; }          // the selected PID, -1 none
    int program() const { return psi_.program(); }
    int64_t frame_ns() const;                 // the learned PES spacing, -1 before two
    Counters counters() const;

  private:
    void on_packet(const PacketView& v, std::vector<Out>& out);
    void on_psi(const PacketView& v, std::vector<Out>& out);
    void on_unit(PesUnit& u, std::vector<Out>& out);
    void emit_gap(int64_t start, int64_t end, const char* reason, std::vector<Out>& out);
    void select_pid(int pid);
    void forget_stream();                     // the selected stream's timing state

    Config cfg_;
    PacketWalker walker_;
    CcTracker cc_;
    uint64_t cc_lost_before_ = 0;             // losses of trackers a flush replaced
    PsiDiscovery psi_;
    PesAssembler pes_;
    Unwrapper uw_;
    std::vector<TsPacket> one_;
    std::vector<PesUnit> units_;
    int64_t now_ = -1;                        // the house time of the current feed
    int gen_ = 0;
    State state_ = State::waiting;
    int pid_ = -1;
    int64_t missing_since_ = -1;              // the missing episode's start, -1 unknown
    bool warned_ = false;
    // The pad: the end of what it emitted (data or gap); DISCONT on the next unit.
    bool have_horizon_ = false, emitted_ = false, discont_ = false;
    int64_t horizon_ = 0;
    // The stream: the last PES's PTS; clean_ while nothing came between it and the next.
    bool have_last_ = false, clean_ = false;
    int64_t last_pts_ = 0;
    int64_t spacings_[SPACING_WINDOW] = {};
    int n_spacings_ = 0, next_spacing_ = 0;
    Counters k_;
};

}  // namespace mrts
