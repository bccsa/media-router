// The egress writer's core (plan ch. 9 parts 4.2, 4.4, 4.5, WI-P5-2; B-222): bus buffers in,
// an edit list out (PTS/DTS and PCR on the network timeline, the PCR cadence, the PMT with the
// house-time descriptor, D_e). Ports py/egress_core.py byte for byte (OQ-1); no GStreamer.
#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <map>
#include <memory>
#include <optional>
#include <vector>

#include "ts_hcdesc.h"
#include "ts_packet.h"
#include "ts_pcr.h"
#include "ts_pes.h"
#include "ts_psi.h"

namespace mrts {

constexpr int64_t EGRESS_MS = 1000000;

struct EgressConfig {
    int64_t pcr_interval_ns = 35 * EGRESS_MS;
    int64_t margin_ns = 150 * EGRESS_MS;
    int64_t headroom_ns = 20 * EGRESS_MS;
    int64_t floor_ns = 100 * EGRESS_MS;
    int64_t max_ns = 0;                       // 0: none (OQ-36, a hook)
    int64_t gap_lower_min_ns = 500 * EGRESS_MS;
};

// The clock read for a PCR written at packet `packet` of the buffer (the element ignores
// the index; the replay and the tests set `now` per packet).
class ClockReader {
  public:
    virtual ~ClockReader() = default;
    virtual int64_t read(size_t packet) const = 0;
};

// D_e of one program (part 4.4): started from its first timing PES, raised when the
// lateness comes within the headroom, lowered only at a gap and by at most the gap time no
// earlier gap covered, held at max_ns when set.
class EgressDelay {
  public:
    static constexpr int64_t LATE_MAX_NS = 60000000000LL;   // S22: beyond, off house time
    static constexpr int64_t STEP_NS = 10 * EGRESS_MS;
    static constexpr int64_t EPS_CAP_NS = 50 * EGRESS_MS;
    enum class Kind : uint8_t { start, raise, lower, max };
    struct Change {
        Kind kind;
        int64_t from_ns, to_ns, lateness_ns, gap_ns;
    };

    explicit EgressDelay(const EgressConfig& cfg = EgressConfig());
    static int64_t eps_ns(const std::optional<int64_t>& error_us);
    // A gap [end - g, end] in house ns.
    void on_gap(int64_t end_ns, int64_t g_ns);
    // Up to two changes into `out`, their count; D_e changed when one has from != to.
    int on_pes(int64_t lateness_ns, int64_t eps_ns, Change out[2]);
    int64_t d_e() const { return d_e_; }
    bool started() const { return started_; }
    uint64_t changes() const { return changes_; }
    uint64_t off_house() const { return off_house_; }

  private:
    int64_t need(int64_t lam, int64_t eps) const;
    int count(Change* out, int n);

    EgressConfig cfg_;
    int64_t d_e_;
    bool started_ = false;
    int64_t gap_ns_ = 0;                      // gap time since the last lowering chance
    bool have_gap_until_ = false;
    int64_t gap_until_ = 0;                   // the end of the latest gap counted
    bool max_episode_ = false;
    uint64_t off_house_ = 0, changes_ = 0;
};

struct EgressEvent {
    enum class Kind : uint8_t {
        d_e_start, d_e_raise, d_e_lower, d_e_max, re_epoch, pcr_pid_assigned, pmt_grew, cc_lost_in
    };
    Kind kind;
    uint64_t packet = 0;                      // the input packet it came at, from the start
    int program = 0, pid = -1;
    int64_t from_ns = 0, to_ns = 0, lateness_ns = 0, gap_ns = 0;          // d-e-*
    int64_t seq = 0, from_seq = 0, delta_ns = 0;                          // re-epoch
    int in_packets = 0, out_packets = 0;                                  // pmt-grew
};
const char* egress_event_name(EgressEvent::Kind k);   // "d-e-start", ...

struct EgressStats {
    int program = 0;
    int64_t d_e_ns = 0;
    uint64_t d_e_changes = 0, lateness_off_house = 0;
    int pmt_version = 0, pcr_pid = -1;
    uint64_t pes_rewritten = 0, pcr_written = 0, pcr_inserted = 0, pmt_sent = 0;
    std::optional<int64_t> lateness_ns;       // the last timing PES's, within 60 s
    int64_t lateness_max_ns = 0, pcr_interval_max_ns = 0;
};

struct EgressCounters {
    uint64_t dropped_before_pmt = 0, gap_markers = 0, gaps = 0, cc_lost_in = 0, re_epochs = 0,
             held = 0;
};

// One edit over a buffer's whole packets: insert 188 bytes before packet `index` (== the
// packet count: at the end), replace it, or drop it. In index order, inserts before the
// packet's own replace or drop.
struct EgressEdit {
    enum class Op : uint8_t { insert, replace, drop };
    uint32_t index;
    Op op;
    uint32_t at;                              // the bytes' offset in the result's pool
};

// What process() returns, valid until the next call: the buffer's packets (read only; a
// packet split across buffers is joined into the result) and the edits.
class EgressResult {
  public:
    size_t packets() const { return pkts_.size(); }
    const uint8_t* packet(size_t i) const { return pkts_[i]; }
    const std::vector<EgressEdit>& edits() const { return edits_; }
    const uint8_t* bytes(const EgressEdit& e) const { return pool_.data() + e.at; }
    void apply(std::vector<uint8_t>& out) const;    // appends the output bytes

  private:
    friend class EgressCore;
    void clear();
    void push(uint32_t index, EgressEdit::Op op, const uint8_t* b);

    std::vector<const uint8_t*> pkts_;
    std::vector<EgressEdit> edits_;
    std::vector<uint8_t> pool_;               // the 188-byte copies; capacity kept
    uint8_t join_[PKT];
};

class EgressCore {
  public:
    static constexpr int64_t ERROR_HOLD_NS = 10000000000LL;   // part 4.3
    static constexpr size_t MAX_HELD_AF = 16;

    explicit EgressCore(const EgressConfig& cfg = EgressConfig());
    ~EgressCore();
    EgressCore(const EgressCore&) = delete;
    EgressCore& operator=(const EgressCore&) = delete;

    // The next buffer applies it (the element's `house-clock` set).
    void set_clock(const ClockDecl& decl) { pending_ = decl; }
    // One bus buffer at CLOCK_MONOTONIC `now_ns`; the input is never written.
    const EgressResult& process(const uint8_t* data, size_t len, int64_t now_ns, const ClockReader& clk);
    const EgressResult& process(const uint8_t* data, size_t len, int64_t now_ns);
    // A GAP|DISCONT buffer (OQ-12) whose PTS `end_ns` is the gap's end: its markers read
    // (read_gap_length) and every packet dropped (S8).
    const EgressResult& on_gap(const uint8_t* data, size_t len, int64_t now_ns, int64_t end_ns,
                               const ClockReader& clk);
    const EgressResult& on_gap(const uint8_t* data, size_t len, int64_t now_ns, int64_t end_ns);
    // EOS: a split header never completed and what it held, in order, appended to `out`.
    void flush(std::vector<uint8_t>& out);

    std::vector<EgressEvent> take_events();
    bool stats(int program, EgressStats* out) const;
    std::vector<int> programs() const;        // PAT order
    const EgressCounters& counters() const { return counters_; }

  private:
    struct Prog;
    struct SectionAssembler {
        std::vector<uint8_t> buf;
        bool collecting = false;
        int packets = 0;
        struct Done {
            size_t off, len;
            int packets;
        };
        // Completed sections land in `out` (offsets into `store`).
        void feed(const PacketView& v, std::vector<uint8_t>& store, std::vector<Done>& out);
        void take(std::vector<uint8_t>& store, std::vector<Done>& out);
    };
    enum class Verdict { pass, replace, drop };

    const EgressResult& run(const uint8_t* data, size_t len, int64_t now_ns, const ClockReader& clk,
                            bool gap, int64_t gap_end);
    void apply_clock(int64_t now);
    HouseTimeDecl decl(const Prog& p) const;
    void head();
    void event(size_t i, EgressEvent e);
    int64_t read(size_t i);
    bool all_known() const;
    Verdict on_packet(size_t i, PacketView& v);
    void on_pat(const PacketView& v);
    void map_pids();
    Verdict on_pmt(size_t i, PacketView& v);
    int choose_pcr(const std::vector<PmtStream>& streams) const;
    void new_pmt(size_t i, Prog& p, const Pmt& pmt);
    bool rebuild(Prog& p, bool force = false);
    void emit_pmt(size_t i, Prog& p);
    void insert_pcr(size_t i, Prog& p, bool discontinuity);
    void saw_pcr(Prog& p, int64_t t);
    void discontinuity(size_t i, Prog& p, bool rebuilt);
    void prime(const PacketView& v);
    void sent(int pid, uint8_t cc);
    void pcr_due(size_t i, const PacketView& v);
    void gap(int pid, int64_t end, int64_t g);
    void write_pcr_at(size_t i, uint8_t* buf, Prog& p, int pid);
    void times(size_t i, Prog& p, int pid, const PesHeader& h, int64_t& pts33, int64_t& dts33);
    void lateness(size_t i, Prog& p, int64_t lam);
    Verdict on_es(size_t i, PacketView& v, Prog& p);
    Prog* prog_of(int number) const;

    EgressConfig cfg_;
    PacketWalker walker_;
    PesHeaderSpan span_;
    CcTracker cc_in_;
    std::vector<std::unique_ptr<Prog>> progs_;   // PAT order
    Prog* pid_prog_[8192] = {};
    std::map<int, SectionAssembler> asm_;
    std::map<int, std::vector<std::array<uint8_t, PKT>>> held_af_;
    int8_t last_cc_[8192];                   // the last payload CC sent per PID, -1 none
    uint8_t pmt_cc_[8192] = {};              // per PMT PID: programs may share one
    std::deque<TsPacket> pat_pkts_;
    SectionSig pat_sig_, pat_new_sig_;
    bool pat_resync_ = false, pat_known_ = false;
    ClockDecl clock_;
    std::optional<ClockDecl> pending_;
    int64_t e_ns_ = 0;
    uint8_t pub_class_ = hcdesc::ERROR_CLASS_UNKNOWN;
    bool have_cand_ = false;
    uint8_t cand_class_ = 0;
    int64_t cand_since_ = 0;
    bool started_ = false, dirty_ = false, reepoch_ = false;
    bool have_last_now_ = false;
    int64_t last_now_ = 0;
    std::vector<EgressEvent> events_;
    uint64_t base_ = 0;
    int64_t t_ = 0;
    const ClockReader* clk_ = nullptr;
    EgressResult res_;
    EgressCounters counters_;
    // Scratch kept across calls so the steady path does not allocate.
    std::vector<TsPacket> one_;
    std::vector<uint8_t> sec_store_, pkt_out_;
    std::vector<SectionAssembler::Done> secs_;
};

// ts_house's timing_pes on a parsed header: a video or audio stream_id, or the PCR carrier.
// The writer's D_e rule and pcrcheck's "must stay > 0" check share it.
bool timing_sid(uint8_t sid, int pid, int timing_pid);

}  // namespace mrts
