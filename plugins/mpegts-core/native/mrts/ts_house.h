// The house-clock timescales (design §4.3, §4.4): 90 kHz PTS, 27 MHz PCR and
// ns, the 33-bit wrap, the mux's 1 h base, the bus <-> network boundary and
// the identity stamp. Floor arithmetic throughout, as python's `//` in
// py/ts_timeline.py.
#pragma once
#include <cstddef>
#include <cstdint>
#include <map>

namespace mrts {

constexpr int64_t PTS_WRAP            = 1LL << 33;
// mpegtsmux (basetsmux CLOCK_BASE) writes PTS/DTS/PCR as running time + 1 h;
// with base_time 0 that is house time + 1 h on the bus.
constexpr int64_t MUX_CLOCK_BASE_90K  = 3600LL * 90000;   // 1 h, mpegtsmux
constexpr int64_t PCR_HZ              = 27000000;          // 90 kHz base * 300 + 9-bit ext
constexpr int64_t PCR_MODULO          = 300LL << 33;       // full PCR wrap
constexpr int64_t PCR_MAX_INTERVAL_NS = 40 * 1000000LL;   // §7

// Exact for any value whose result fits 64 bits: TAI-scale ns (~1.8e18) would
// overflow a plain `v * 27` or `v * 100000`.
int64_t pts90k_to_ns(int64_t ticks);      // floor division, as today
// ceil(ticks x 100000 / 9): the ns mpegtsmux's floor turns back into `ticks` (S12, B-69),
// the formula demux's PTS and DTS.
int64_t pts90k_to_ns_ceil(int64_t ticks);
int64_t ns_to_pts90k(int64_t ns);         // floor; inverse within 11.1 us
int64_t ns_to_pcr27(int64_t ns);          // mod PCR_MODULO
int64_t pcr27_to_ns(int64_t pcr27);
int64_t fold33(int64_t d);                // signed, wrap-folded delta, in (-2^32, 2^32]
// `pts33` moved by the 2^33 period that lands it nearest `ref` (`ref` may
// itself be unwrapped, i.e. outside 33 bits).
int64_t unwrap_near(int64_t pts33, int64_t ref);          // as today
// House ns a mux-written PTS encodes: `pts - 1 h`, unwrapped nearest
// `house_now_ns` (the field wraps every 26.5 h of uptime, the clock does not).
int64_t house_from_mux_pts(int64_t pts33, int64_t house_now_ns); // bus formula
int64_t mux_pts_from_house(int64_t house_ns);             // inverse, 33-bit

// Continuous per-stream unwrap: the first value nearest `seed` (90 kHz, may be
// unwrapped), every later one nearest the previous. DTS is unwrapped nearest
// its own PES's PTS, never on its own: the a1 wrap fault (design §6).
class Unwrapper {
  public:
    // feed_dts' answer for a DTS that is absent (< 0) or fails the sanity check.
    static constexpr int64_t NO_DTS = INT64_MIN;
    // Further than this from its PTS a DTS is damage, not decode order.
    static constexpr int64_t DTS_MAX_GAP_90K = 5 * 90000;

    int64_t feed(int64_t pts33, int64_t seed);
    int64_t feed_dts(int64_t dts33, int64_t pts_unwrapped);
    void reset();                         // the next feed re-seeds; the counter is kept
    bool primed() const { return primed_; }
    uint64_t dts_discarded() const { return dts_discarded_; }

  private:
    int64_t last_ = 0;
    bool primed_ = false;
    uint64_t dts_discarded_ = 0;
};

// E = TAI - MONOTONIC (design §4.2) and the network boundary: one constant for
// the egress writer and a Trust-selected ingest. E = 0 is "unknown E".
struct NetEpoch {
    int64_t e_ns = 0;
    int64_t e_90k() const;                // floor(e_ns * 9 / 100000)
};
int64_t bus_to_net(int64_t pts33, const NetEpoch& e); // + E - 1 h mod 2^33
int64_t net_to_bus(int64_t pts33, const NetEpoch& e); // - E + 1 h mod 2^33
// H(emission) - D_e mod PCR_MODULO; H on the network timescale (MONO + E).
int64_t net_pcr27(int64_t h_emission_ns, int64_t d_e_ns);

// The identity stamp of a bus buffer (P3, plan ch. 6 part 4.1): the house time
// its first timing PES carries, `PES - 1 h`. All state is per `stream`, as
// mr-tssplit's outputs (stream = PID) each carry their own PCR carrier.
class IdentityStamp {
  public:
    // Timing PES: a video/audio stream_id, or on the stream's first PCR carrier.
    // PES, none timing: `house_now`; no PES: the last stamp (`house_now` first).
    // Monotone per stream, never below 0 (to libmrbus a negative stamp is "now").
    int64_t stamp(const uint8_t* data, size_t len, int64_t house_now, int stream = 0);
    // `stream`'s first timing PES: pid, identity stamp (before the floor), PTS.
    // For the one-time log line; any out-pointer may be null.
    bool first(int stream, int* pid, int64_t* stamp_ns, int64_t* pts) const;
    void reset();                         // forgets every stream

  private:
    struct Stream {
        int timing_pid = -1;
        bool stamped = false;             // `floor` is the last stamp
        int64_t floor = 0;
        bool has_first = false;
        int first_pid = 0;
        int64_t first_stamp = 0, first_pts = 0;
    };
    std::map<int, Stream> streams_;
};

}  // namespace mrts
