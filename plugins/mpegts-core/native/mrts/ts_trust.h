// Trust at a network ingest (ch. 9 part 4.8, WI-P5-6; p5-6b, B-226): one program's gate, its states
// and the Trust mapping, py/trust_gate.py ported with exact parity (`mrts_cli trust-replay`).
// RestampCore owns one per program; the bytes (hold, guard, gap markers, CC) are the restamp's.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

#include "ts_hcdesc.h"

namespace mrts {

enum class TimingMode { restamp, trust };

struct TrustConfig {
    int64_t l_ns = 0;                         // the transport's latency L (the module's)
    int64_t tau_ns = 200000000;               // trustToleranceMs (Q12)
    int64_t neg_base_ns = 20000000;           // lo's base
    int bad_pcrs = 3;                         // condition (3)'s hysteresis
    int decide_pcrs = 5;
    int64_t decide_max_ns = 1000000000;       // OQ-39
    int64_t decide_max_bytes = 4 << 20;       // OQ-39: the restamp's hold
    int64_t qualify_ns = 2000000000;
    int64_t return_qualified_ns = 10000000000LL;
    int64_t return_gap_wait_ns = 30000000000LL;   // OQ-35
    int64_t pmt_stale_ns = 1000000000;
    int64_t converge_div = 200;               // k falls 1 tick per 200 of content: 0.5 % (Q1 (b))
};

// The local house-clock is ts_hcdesc.h's ClockDecl: Trust reads E (0 unknown), disciplined
// and the error in us (none unknown).

class TrustGate {
  public:
    enum class State { restamp, deciding, qualifying, trust, converging, fallback, returning };
    enum class Decision { none, hold, release_restamp, release_trust, switch_to_trust, switch_to_restamp };
    enum class Mapping { stc, restamp, trust, converging };
    static constexpr int64_t UNKNOWN_TERM_NS = 50000000;   // an unknown class or local error (p5-9)
    static constexpr int RING = 64;

    // One transition, as the reference logs it: `failed` null when qualified; k into
    // converging (has_k), the gap into trust (has_gap).
    struct Transition {
        int64_t t = 0;
        Decision decision = Decision::none;
        State from = State::restamp, state = State::restamp;
        const char* failed = nullptr;
        bool has_k = false, has_gap = false;
        int64_t k_ns = 0, k90k = 0, gap_ns = 0;
    };
    // A PES's mapping: pts/dts 33-bit (-1: none), k in ticks.
    struct Mapped {
        Mapping kind = Mapping::stc;
        int64_t pts = -1, dts = -1, k90k = 0;
    };
    struct Stats {
        State state = State::restamp;
        bool trust_selected = false;
        const char* failed = nullptr;
        uint64_t switches = 0;
        uint64_t pes[4] = {0, 0, 0, 0};       // by Mapping
        uint32_t digest = 0;                  // CRC-32 of the Trust-mapped values, as the reference's
        bool have_transit = false;
        int64_t transit_min_ns = 0, transit_median_ns = 0, transit_max_ns = 0;
        int64_t bound_lo_ns = 0, bound_hi_ns = 0, k_ns = 0;
        bool have_decl = false;
        HouseTimeDecl decl;
    };

    TrustGate(int program, const TrustConfig& cfg, const ClockDecl& clock, bool trust_selected, int64_t now);

    // Inputs. `decl` null: the PMT in force carries no MRHT (or one with house time absent).
    void on_pmt(const HouseTimeDecl* decl, int64_t now);
    void on_pcr(int64_t pcr27, int64_t now);
    void on_natural_gap(int64_t gap_ns, int64_t now);
    // Restamp from deciding releases: the decision is in the log (release_restamp).
    void set_mode(bool trust, int64_t now);
    void set_clock(const ClockDecl& clock, int64_t now);   // a receiver re-epoch switches in Trust
    void set_l(int64_t l_ns) { cfg_.l_ns = l_ns; }
    void set_tau(int64_t tau_ns) { cfg_.tau_ns = tau_ns; }
    void set_config(const TrustConfig& cfg) { cfg_ = cfg; }
    // The table having gone by (the reference's psi line): the PMT's age restarts.
    void pmt_seen(int64_t now) { pmt_at_ = now, have_pmt_ = true; }

    // The decision at `now` (timers, conditions, switches).
    Decision step(int64_t now);
    // The restamp's hold reached decide_max_bytes: deciding ends as at 1 s (C++ only).
    Decision give_up(int64_t now);

    // A PES: map() gives its output (pts/dts 33-bit; dmp the DTS - PTS, 0 for none) from
    // `stc_out`, the bus PTS the STC states give it (-1 none); emitted() records it as sent.
    Mapped map(int64_t pts, int64_t dmp, int64_t stc_out) const;
    void emitted(int pid, int64_t pts, const Mapped& m, int64_t now);

    State state() const { return state_; }
    bool mapped() const { return state_ == State::trust || state_ == State::converging; }
    bool trust_selected() const { return trust_selected_; }
    const char* failed(int64_t now) const;
    int64_t k_at(int64_t x) const;
    // net_to_bus(x) + k(x) on the clock's E (or `e_ns`).
    int64_t f(int64_t x) const { return f_on(x, clock_.e_ns); }
    const ClockDecl& clock() const { return clock_; }
    const TrustConfig& config() const { return cfg_; }
    Stats stats(int64_t now) const;
    std::vector<Transition> take_log();

  private:
    void bounds(int64_t* lo, int64_t* hi) const;
    int64_t f_on(int64_t x, int64_t e_ns) const;
    void go(State s, Decision d, int64_t now);
    void go(const Transition& t);
    void switch_trust(int64_t k, int64_t now);
    void switch_restamp(State s, int64_t now);
    Transition line(State s, Decision d, int64_t now) const;

    int program_;
    TrustConfig cfg_;
    ClockDecl clock_;
    bool trust_selected_;
    State state_;
    int64_t since_;
    bool have_decl_ = false, have_pmt_ = false;
    HouseTimeDecl decl_;
    int64_t pmt_at_ = 0;
    std::vector<int64_t> ring_;
    int bad_run_ = 0;
    const char* bad_side_ = nullptr;
    bool judged_ = false;
    int good_ = 0;
    bool have_qual_ = false, have_ready_ = false, have_pending_ = false;
    int64_t qual_since_ = 0, ready_at_ = 0, restamp_pending_ = 0;
    bool have_gap_ = false;
    int64_t gap_ = 0;
    int64_t k0_ = 0, x0_ = 0;
    bool have_last_ = false;
    int64_t last_pts_ = 0, last_out_ = 0;
    uint64_t switches_ = 0;
    uint64_t counts_[4] = {0, 0, 0, 0};
    uint32_t crc_ = 0;
    std::vector<Transition> log_;
};

const char* trust_state_name(TrustGate::State s);
const char* trust_decision_name(TrustGate::Decision d);
const char* trust_mapping_name(TrustGate::Mapping m);
// zlib's crc32 (the reference's digest), continued from `crc`.
uint32_t crc32_ieee(uint32_t crc, const void* data, size_t n);

}  // namespace mrts
