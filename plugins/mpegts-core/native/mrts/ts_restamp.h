// The ingest restamp (WI-P1-3; plan ch. 5 parts 4.2 and 4.4): every PES PTS/DTS and
// PCR of a TS rewritten in place onto house time, through one virtual STC per program
// (stc) or by a constant (fixed: the capture producers), shifted by the ingest offset
// O and a per-PID trim; overlap dropped, gaps reported, CC kept continuous. No
// GStreamer: the mrtsrestamp element (WI-P1-4) is a thin face on this.
#pragma once
#include <cstddef>
#include <cstdint>
#include <deque>
#include <map>
#include <memory>
#include <utility>
#include <vector>

#include "ts_packet.h"
#include "ts_pes.h"
#include "ts_psi.h"
#include "ts_stc.h"
#include "ts_trace.h"

namespace mrts {

struct RestampConfig {
    enum class Mode { stc, fixed };
    Mode mode = Mode::stc;
    // fixed: the PES are a local mux's running time + 1 h; a pipeline with a natural
    // base time (video-encoder) adds it to land on house time (part 4.6).
    bool add_base_time = false;
    int64_t base_time_ns = 0;
    int64_t offset_ns = 0;                // O (§5.5); clamped to ±10 s (OQ-14)
    std::map<int, int64_t> trims_ns;      // per-PID trim on top of O; clamped to ±2 s
    ClockLockConfig clock;
    PcrValidatorConfig pcr;
};

// The class of a PMT entry: its stream_type, and for private PES (0x06) its
// registration (302M, Opus, AC-3, HEVC...) or a DVB audio descriptor.
StreamClass stream_class(int stream_type, const std::vector<uint8_t>& es_info);

class RestampCore {
  public:
    static constexpr int64_t TRIM_LIMIT_NS = 2000000000;          // §5.5
    static constexpr int64_t OFFSET_LIMIT_NS = 10000000000LL;     // OQ-14
    static constexpr int64_t OUTAGE_NS = 1000000000;              // part 4.4: no packets this long
    static constexpr int64_t GAP_FLAG_NS = 1000000000;            // a gap this long flags the next PCR
    static constexpr int64_t LEAD_WINDOW_NS = 10000000000LL;      // per-PID lead telemetry (part 4.3)
    // Degraded mode writes the conditioner's PCR: the program's PTS floor minus 250 ms,
    // the floor pulled down by a PID with a PES this recent, at most 1 s down.
    static constexpr int64_t DEGRADED_PCR_LEAD_NS = 250000000;
    static constexpr int64_t DEGRADED_RECENT_NS = 500000000;
    static constexpr int64_t DEGRADED_FLOOR_NS = 1000000000;

    struct Range {
        const uint8_t* data;
        size_t len;
    };
    // A gap marker to push (OQ-12): on `pid`, nothing in [start_ns, end_ns), bus house
    // ns with the shift in force, on the PID's guard key (DTS for video, else PTS).
    struct Gap {
        int program, pid;
        int64_t start_ns, end_ns;         // end_ns: the marker's PTS
        const char* reason;               // "epoch", "edit", "outage", "jump", "backlog"
        // Output bytes before the marker: it goes right before the PES that shows the
        // gap, which may follow that PID's earlier PES in the same buffer.
        size_t at;
        uint8_t cc = 0;                   // the PID's last payload CC there: the marker repeats it
    };
    struct Result {
        // The output in order: ranges of the input buffer (rewritten in place) or of
        // core memory, valid until the next process(). in_place: one range, the input.
        std::vector<Range> keep;
        std::vector<Gap> gaps;            // markers to push into the output, by `at`
        bool in_place = false;
        size_t bytes() const;
    };
    // Part 10's mrtsrestamp-event. STC events carry pid -1 (the program), but for
    // `degraded`, which names the reference PID whose PTS the timing then follows, and
    // `lead_clamp`, the PID clamped (value_ns: its lead under the reference mapping).
    struct Event {
        enum class Kind { relock, degraded, recovered, envelope_step, gap, overlap, psi_change, lead_clamp };
        Kind kind = Kind::relock;
        int program = -1;
        int pid = -1;
        const char* reason = "";          // static: trigger, failing row, gap reason
        int64_t gap_ns = 0, dropped_ns = 0;
        int64_t house_ns = 0;             // arrival of what caused it
        uint32_t epoch = 0;
        int64_t value_ns = 0;             // envelope-step: the step; a leap's relock: Δσ - Δh
    };
    struct ProgramStats {
        int program = 0;
        VirtualStc::Stats clock;          // stc mode only
        uint64_t gaps = 0, dropped_pes = 0;
        int64_t gap_ns_total = 0, dropped_ns_total = 0;
    };
    struct PidStats {
        int program = 0, pid = 0, stream_type = 0;
        StreamClass cls = StreamClass::other;
        // house(PTS) - arrival of its PES header over LEAD_WINDOW_NS, before the shift.
        int64_t lead_min_ns = 0, lead_median_ns = 0, lead_max_ns = 0;
        uint32_t lead_count = 0;
        int64_t trim_ns = 0, shift_ns = 0;   // trim set; O + trim in force
        uint64_t dropped_pes = 0;
    };
    struct Stats {
        RestampConfig::Mode mode = RestampConfig::Mode::stc;
        std::vector<ProgramStats> programs;
        std::vector<PidStats> pids;
        // Chapter 3's counters (part 10), then the restamp's own removals.
        uint64_t desync_bytes = 0, cc_lost = 0, header_spans = 0, psi_unsupported_sections = 0,
                 pes_no_pts = 0, dts_discarded = 0;
        uint64_t unmapped_pes = 0;        // PES before their program had a mapping
        uint64_t broken_spans = 0;        // split headers that could not be joined
        uint64_t unknown_pid_packets = 0; // on no PMT's PID: their time cannot be placed
        uint64_t removed_packets = 0, pcr_kept_packets = 0;   // dropped; dropped but kept for the PCR
    };

    explicit RestampCore(const RestampConfig& cfg = RestampConfig());
    // Rewrites `data` in place (whole packets, any chunking) at arrival `arrival_ns`:
    // house time for stc and base-0 pipelines, running time with add_base_time.
    Result process(uint8_t* data, size_t len, int64_t arrival_ns);
    void set_offset(int64_t ns);                      // live: per PID from its next PUSI
    void set_trims(const std::map<int, int64_t>& trims_ns);   // replaces the set; live
    void tick(int64_t now_ns);                        // no input: lets a clock go lost
    // During an outage (OQ-17): per PID that emitted a PES, the gap from the end of what it
    // emitted to `now_ns` (arrival time, as process()), where that end is before now. A
    // query: the gap on resume still comes from process().
    std::vector<Gap> outage_gaps(int64_t now_ns) const;
    // FLUSH_STOP: a carried partial packet and the held split headers are dropped, so
    // nothing from before the flush joins what follows; clocks, guards and CC stay.
    void flush();
    // Non-const: the clock's PCR interval maximum runs from one stats() to the next.
    Stats stats();
    std::vector<Event> take_events();
    void set_trace(TraceWriter* w);                   // null: off; not owned

  private:
    struct Program;
    struct Pid {
        enum class Unit : uint8_t { none, keep, drop, pass };
        int pid = -1;
        Program* prog = nullptr;
        int stream_type = -1;             // -1: listed only as the PCR PID
        StreamClass cls = StreamClass::other;
        Unwrapper unwrap;
        int64_t shift = 0;                // O + trim in force: adopted at a timed PUSI
        // The guard and the gap: the last emitted PES's key, the spacing before it.
        bool have_last = false, clean = false;   // clean: no drop since the last emitted
        int64_t last_key = 0, interval = 0, last_h = 0;
        // Fixed mode's jump reference: the last three such spacings, a jump's included, so one
        // short PES or one jump never moves it and a lasting cadence change does.
        int64_t spacing[3] = {0, 0, 0};
        uint8_t n_spacing = 0, spacing_at = 0;
        bool have_src = false;            // the previous PES's guard key on source time
        int64_t last_src = 0;
        uint32_t max_epoch = 0, last_epoch = 0;   // the newest it emitted under; the last PES's
        bool outage = false;              // an outage since its last PES
        bool backlog = false;             // stale PES dropped since its last (B-39)
        // Packets: the open PES's fate, CC renumbering, duplicates, a held header.
        Unit unit = Unit::none;
        uint8_t cc_delta = 0;             // CC steps removed so far, mod 16
        uint8_t out_cc = 0;               // the last payload packet's CC as it left
        bool emitted = false;             // a payload packet has left: CC continuity applies
        bool seen_payload = false, prev_kept = false;
        bool prev_cont = false;           // the last kept payload packet continued a split header
        int64_t pts33 = -1, dts33 = -1;   // the open PES's rewrite, for a duplicate
        int64_t held_h = 0;
        bool held_di = false;
        std::vector<uint8_t> held_af;     // adaptation-only packets behind the held header
        uint64_t run_pes = 0;             // the overlap run in progress
        int64_t run_ns = 0;
        uint64_t dropped_pes = 0;
        std::deque<std::pair<int64_t, int64_t>> leads;   // (house arrival, lead)
    };
    struct Program {
        Program(int number_, int pmt_pid_, const RestampConfig& cfg)
            : number(number_), pmt_pid(pmt_pid_), stc(cfg.clock, cfg.pcr) {
            psi.select_program(number_);
        }
        int number, pmt_pid;
        PsiDiscovery psi;
        int gen = 0;
        int pcr_pid = -1, ref_pid = -1;
        std::vector<int> es;              // PMT order
        VirtualStc stc;
        bool have_pcr = false, degraded = false;
        int64_t pcr_shift = 0;            // min(0, smallest shift): what the PCR follows
        bool flag_pcr = false;            // discontinuity_indicator on the next written PCR
        bool have_wpcr = false, wpcr_regen = false;
        int64_t wpcr_ns = 0, wpcr27 = 0;  // last written PCR: house ns (stc), as written
        int64_t pcr_off27 = 0;            // written - source: a PCR off the PCR PID follows it
        int64_t pending_leap = 0;
        uint64_t gaps = 0, dropped_pes = 0;
        int64_t gap_ns = 0, dropped_ns = 0;
    };
    struct Op {
        bool internal;
        size_t off, len;
    };

    void on_packet(PacketView& v);
    void on_psi(const PacketView& v);
    void update_programs(const std::vector<std::pair<int, int>>& pat);
    void rebuild(Program& g);
    Pid* pid_entry(int pid, Program& g);
    void on_pcr(Pid& p, PacketView& v);
    int64_t degraded_pcr(const Program& g) const;
    void on_es(Pid& p, PacketView& v, CcTracker::Result cc);
    bool in_epoch(const Program& g, int64_t pts90k) const;
    int64_t unwrap_pes(Pid& p, int64_t pts33);
    bool start_pes(Pid& p, const PesHeader& h, int64_t arrival, bool di, int64_t& pts33,
                   int64_t& dts33);
    void push_gap(Pid& p, int64_t start, int64_t end, const char* why, uint32_t epoch);
    int64_t target_shift(int pid) const;
    void update_pcr_shift(Program& g);
    void pull_events(Program& g);
    void record_psi(const Program& g);
    void record(TraceKind k, int pid, uint64_t value, int32_t d, uint8_t flags, int64_t arrival);
    void keep_es(Pid& p, uint8_t* pkt, bool span_cont = false);
    void drop_es(Pid& p, uint8_t* pkt, bool duplicate);
    void release_held_af(Pid& p);
    void put(const uint8_t* pkt);

    RestampConfig cfg_;
    int64_t base_ = 0;                    // added to the PES in fixed mode
    int64_t offset_ = 0;
    std::map<int, int64_t> trims_;
    PacketWalker walker_;
    CcTracker cc_in_;
    PesHeaderSpan span_;
    std::vector<std::unique_ptr<Program>> progs_;
    std::vector<std::unique_ptr<Pid>> pids_;   // by PID
    std::vector<uint8_t> pmt_ref_;             // by PID: programs whose PMT it carries
    std::deque<TsPacket> pat_pkts_;
    SectionSig pat_sig_;
    std::vector<std::pair<int, int>> pat_;
    std::vector<Event> events_;
    TraceWriter* trace_ = nullptr;
    // The buffer in process().
    Result* res_ = nullptr;
    uint8_t* in_ = nullptr;
    size_t in_len_ = 0;
    std::vector<Op> ops_;
    std::vector<uint8_t> scratch_;
    size_t out_bytes_ = 0;                     // put so far: where a gap marker goes
    int64_t arrival_ = 0, arrival_h_ = 0;      // as given; on house time
    bool have_arrival_ = false;
    int64_t outage_h_ = 0;                     // arrival of the buffer that ended the last outage
    uint64_t pes_no_pts_ = 0, dts_bad_fixed_ = 0, unmapped_ = 0, broken_ = 0, unknown_ = 0,
             removed_ = 0, pcr_kept_ = 0;
};

const char* event_kind_name(RestampCore::Event::Kind k);

}  // namespace mrts
