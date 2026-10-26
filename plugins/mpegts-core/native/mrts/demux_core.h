// The formula demux of one program (plan ch. 7 parts 4.1 and 4.2, WI-P3-1; register B-121,
// B-122): every PES of the program's elementary streams on the formula timeline, PTS =
// ceil((unwrap(PES PTS) - 1 h) x 100000 / 9) ns, DTS likewise; pads named and capped as
// tsdemux 1.28.2 names and caps them; GAP events for holes, bus gap markers and sparse pads.
// With `select` set it is Phase 2's select mode (one stream, one pad). GStreamer-free:
// mrtsdemux is its element. py/demux_core.py is the reference it ports rule for rule (OQ-1).
#pragma once
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "ts_house.h"
#include "ts_packet.h"
#include "ts_pes.h"
#include "ts_psi.h"

namespace mrts {

// The pad classes, tsdemux's template names; a `media` mask holds 1 << class.
enum class EsClass { Video, Audio, Private, Subpicture };
const char* es_class_name(EsClass c);                 // "video", "audio", "private", "subpicture"
bool es_class_from_name(const std::string& name, EsClass* out);
constexpr uint32_t MEDIA_ALL = 0xF;
constexpr uint32_t media_bit(EsClass c) { return 1u << (int)c; }

// What the element does to a unit before it pushes it (part 4.2's last column).
enum class AuPost { None, Adts, Opus, Klv };
const char* au_post_name(AuPost p);                   // "none", "adts", "opus", "klv"

constexpr const char* CAPS_302M = "audio/x-smpte-302m";

// One ES's row of part 4.2: tsdemux's caps as a string (gst_caps_from_string reads it).
struct EsPlan {
    EsClass cls = EsClass::Private;
    std::string caps;
    bool sparse = false;
    AuPost post = AuPost::None;
    std::string lang;                     // the ISO 639-2 code tsdemux tags, "" none
    uint32_t reg = 0;                     // the first registration's format_identifier
    std::vector<uint8_t> opus_ext;        // the first 0x7F descriptor's body (Opus)
    std::vector<uint8_t> av1_desc;        // the first 0x80 descriptor's body (AV1)
};
// The row of a PMT entry, none for no pad. Where two rows match one 0x06 loop tsdemux's order
// decides (AC-4's extension, 0x6A, 0x7A, 0x56, 0x59, then the registration).
std::optional<EsPlan> classify(int stream_type, const std::vector<uint8_t>& es_info);
// The class tsdemux gives an ES with no row (DTS in any form audio), else Private: an
// unknown stream warns only where `media` holds it.
EsClass unknown_class(int stream_type, const std::vector<uint8_t>& es_info);
bool section_only_type(int stream_type);             // tsdemux's PSI stream types: no warning
std::string pad_name(EsClass c, int generation, int pid);   // "%s_%01x_%04x", 4-bit generation
// tsdemux's mpegts_base_is_same_program on two PMTs: the PCR PID, the stream count and each
// (PID, stream type) as before; a version, language or descriptor change keeps the pads.
bool same_program(const Pmt& old_pmt, const Pmt& new_pmt);

// The descriptor helpers classify reads with. find_descriptor: the first `tag` whose first
// body byte is `ext` when ext >= 0; false without one.
bool find_descriptor(const std::vector<uint8_t>& loop, int tag, int ext,
                     std::vector<uint8_t>* body);
std::string language(const std::vector<uint8_t>& loop);    // the first 0x0A's last entry, else 0x59's
uint32_t metadata_format(const std::vector<uint8_t>& loop); // a 0x26's format_identifier, 0 none
// tsdemux's Opus caps from the 0x7F extension's body (tag_extension 0x80, channel_config_code
// next), through gst_codec_utils_opus_create_caps' rules; none where tsdemux makes no pad.
std::optional<std::string> opus_caps(const std::vector<uint8_t>& ext);
std::string reg_text(uint32_t reg);                   // printable fourcc, else 0x%08x; "" for 0

// 48 kHz frames in one 302M PES payload from its AES3 header (SMPTE 302M 7), or -1.
int64_t s302m_frames(const uint8_t* payload, size_t n);

// AU post-processing (applied by the element), tsdemux's parses as pure functions.
int adts_mpegversion(const uint8_t* payload, size_t n);    // 2 for the ID bit, else 4
struct OpusAu {
    size_t off = 0, len = 0;              // the packet within the payload
    int trim_start = 0, trim_end = 0;     // samples, from the control header
};
// parse_opus_access_unit: the control headers stripped; false where tsdemux fails the PES.
bool opus_access_units(const uint8_t* payload, size_t n, std::vector<OpusAu>* out);
struct KlvCell {
    uint8_t service_id = 0, sequence = 0, flags = 0;
    size_t off = 0, len = 0;              // the cell within the payload, cut to what remains
};
// parse_pes_metadata_frame (0x15 KLV): false where tsdemux fails the PES.
bool klv_metadata_cells(const uint8_t* payload, size_t n, std::vector<KlvCell>* out);

// A pad of a plan: its name, PID, stream type and row.
struct DemuxPad {
    std::string name;
    int pid = -1;
    int stream_type = 0;
    EsPlan es;
};

struct DemuxEvent {
    enum class Kind { section, plan, gone, unit, gap, unknown, not_house_time, no_stream };
    Kind kind = Kind::unit;
    int pid = -1;                         // section, unit, gap, unknown, not_house_time
    std::string pad;                      // unit, gap: the pad's name ("src" in select mode)
    int generation = -1;                  // plan, gone, unknown: the program's
    // unit: PTS, DTS (= PTS without one) and the 302M duration, ns, -1 none.
    // gap: [pts_ns, pts_ns + dur_ns).
    int64_t pts_ns = -1, dts_ns = -1, dur_ns = -1;
    bool discont = false;                 // unit: the pad's first, or content lost before it
    const char* reason = "";              // gap: "jump", "marker", "sparse"; section: "pat", "pmt"
    std::vector<uint8_t> bytes;           // unit: the PES payload; section: the section
    PesHeader hdr;                        // unit: its header (raw 33-bit PTS, DTS)
    // unit: the unwrapped 90 kHz PTS and DTS, Unwrapper::NO_DTS for none.
    int64_t pts_u = Unwrapper::NO_DTS, dts_u = Unwrapper::NO_DTS;
    int version = -1;                     // section
    int program = -1, pcr_pid = -1;       // plan
    std::vector<DemuxPad> pads;           // plan
    int stream_type = -1;                 // unknown
    uint32_t reg = 0;                     // unknown
    int64_t offset_ms = 0;                // not_house_time: first PTS - house now, toward 0
};

class DemuxCore {
  public:
    static constexpr int64_t NO_STREAM_NS = 2000000000;    // a plan without a stream this long
    static constexpr int JUMP_FRAMES = 2;                   // an audio hole past this is a gap
    static constexpr int SPACING_WINDOW = 8;                // the frame: their upper median
    static constexpr int64_t SPACING_MAX_NS = 1000000000;   // a longer spacing is no frame
    static constexpr int64_t VIDEO_HOLE_NS = 1000000000;    // B-89: a video hole from 1 s
    static constexpr int64_t NOT_HOUSE_NS = 60000000000LL;  // a first PTS this far from now

    struct Config {
        int program = -1;                 // -1: the PAT's first
        uint32_t media_mask = MEDIA_ALL;  // the classes with pads; others never reassembled
        std::string select;               // "": demux mode; CAPS_302M: select mode
        int64_t sparse_gap_lag_ns = 500000000;   // 0: no sparse gaps
        size_t max_pes_bytes = 32u << 20;
    };
    // No PMT yet; the plan has a pad (select: the PMT lists the stream); it has none.
    enum class State { waiting, found, missing };
    struct Counters {
        uint64_t pes = 0, gaps = 0, markers = 0, markers_dropped = 0, pes_no_pts = 0;
        uint64_t desync_bytes = 0, cc_lost = 0, pes_oversize = 0, pes_dropped_cc = 0,
                 psi_unsupported_sections = 0, dts_discarded = 0, unknown_streams = 0;
        int generation = -1;              // the planned program's, -1 none
    };

    // The streams `select` names: CAPS_302M (0x06 with registration BSSD), or "" (demux mode).
    static bool selectable(const std::string& select);

    DemuxCore();
    explicit DemuxCore(const Config& cfg);   // an unselectable `select` matches no stream
    // One bus buffer, any chunking. `house_now_ns`: clock - base time, < 0 without a clock (a
    // first PES then seeds on itself). `bus_discont`: bytes may be missing before it.
    void feed(const uint8_t* d, size_t n, bool bus_discont, int64_t house_now_ns,
              std::vector<DemuxEvent>& out);
    // A gap-marker buffer (OQ-12): whole packets, `end_ns` its PTS as running time (< 0:
    // unplaced). Each marker packet on a pad's PID is a GAP [max(horizon, end - length), end),
    // dropped when empty, after the PID's open PES; never walked (B-60).
    void marker(const uint8_t* d, size_t n, int64_t end_ns, std::vector<DemuxEvent>& out);
    void drain(std::vector<DemuxEvent>& out);   // EOS: the open unbounded PES out
    // FLUSH_STOP: the carry, open PES, CC and unwrap state, horizons, program time; PSI and the
    // plan stay.
    void flush();

    const Config& config() const { return cfg_; }
    bool select_mode() const { return select_; }
    State state() const { return state_; }
    int pid() const { return select_ ? one_.pid : -1; }      // select mode's PID, -1 none
    int program() const { return psi_.program(); }
    int64_t frame_ns() const { return select_ ? one_.frame() : -1; }
    int64_t program_time_ns() const { return have_pt_ ? pt_ : -1; }
    std::vector<std::string> pads() const;                   // the live pads, plan order
    std::vector<int> selected_pids() const { return pes_.selected(); }
    Counters counters() const;

  private:
    struct Pad {
        std::string name;
        int pid = -1, stream_type = 0;
        EsPlan es;
        bool sparse = false, s302m = false, video = false;
        Unwrapper uw;
        bool emitted = false, discont = false;      // the next unit is DISCONT
        bool have_horizon = false;                  // the end of what it emitted, data or gap
        int64_t horizon = 0;
        bool have_last = false, clean = false;      // clean: nothing came between it and the next
        int64_t last_t = 0;                         // the last spacing time: DTS on video, else PTS
        int64_t spacings[SPACING_WINDOW] = {};
        int n_spacings = 0, next_spacing = 0;
        bool house_checked = false;
        int64_t frame() const;                      // the upper median, -1 before two
        void learn(int64_t spacing);
        void forget_stream();
    };

    Pad* pad_of(int pid);
    void on_packet(const PacketView& v, std::vector<DemuxEvent>& out);
    void on_psi(const PacketView& v, std::vector<DemuxEvent>& out);
    void on_psi_select();
    void section(const char* table, int pid, bool pat, std::vector<DemuxEvent>& out);
    void on_pmt(const Pmt& pmt, std::vector<DemuxEvent>& out);
    void missing();
    void on_pcr(const PacketView& v, std::vector<DemuxEvent>& out);
    void advance(int64_t t, std::vector<DemuxEvent>& out);
    void gap(Pad& pad, int64_t start, int64_t end, const char* reason,
             std::vector<DemuxEvent>& out);
    void on_unit(Pad& pad, PesUnit& u, std::vector<DemuxEvent>& out);
    void unit(Pad& pad, PesUnit& u, int64_t pts, int64_t dts, int64_t dur, bool discont,
              int64_t pts_u, int64_t dts_u, std::vector<DemuxEvent>& out);
    int64_t seed(int64_t own) const;            // B-14's unwrapped seed, `own` without a clock

    Config cfg_;
    bool select_ = false;
    PacketWalker walker_;
    CcTracker cc_;
    uint64_t cc_lost_before_ = 0;               // losses of trackers a flush replaced
    PsiDiscovery psi_;
    PesAssembler pes_;
    std::vector<TsPacket> one_pkt_ = std::vector<TsPacket>(1);
    std::vector<PesUnit> units_;
    int64_t now_ = -1;                          // the current feed's house time
    int gen_ = 0, pat_gen_ = 0;                 // the PSI generations acted on
    State state_ = State::waiting;
    int64_t missing_since_ = -1;
    bool warned_ = false;
    // Demux mode: the planned program, its pads in plan order, PID -> pad index.
    bool have_program_ = false;
    int program_gen_ = -1;
    Pmt program_pmt_;
    std::vector<Pad> pads_;
    int16_t pad_index_[8192];
    Unwrapper pcr_uw_;
    bool have_pt_ = false;                      // program time: the newest PCR or non-sparse end
    int64_t pt_ = 0;
    Pad one_;                                   // select mode's pad, the stream's PID on it
    Counters k_;
    uint64_t dts_discarded_before_ = 0;         // of pads a new program replaced
};

// The .demux.jsonl lines (tests/fixtures/README.md), byte for byte the reference's: `mrts_cli
// demux` prints them, demux_core_test compares them.
std::string demux_jsonl(const DemuxEvent& e);
std::string demux_jsonl(const DemuxCore::Counters& c);
// A recording's own house time: its first PES PTS - 1 h on the ceil, -1 without one.
int64_t first_pes_house_ns(const uint8_t* d, size_t n);

}  // namespace mrts
