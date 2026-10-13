// The MPEG-TS packet layer (ISO 13818-1 2.4.3.2): header helpers, the parsed
// header view, a walker that carries split packets across chunks and resyncs
// on garbage, and the per-PID continuity check.
#pragma once
#include <cstddef>
#include <cstdint>

namespace mrts {

constexpr int PKT = 188;                  // moves here from ts_psi.h
constexpr uint8_t SYNC_BYTE = 0x47;

// Raw header reads for any 188 bytes, sync unchecked (moved from ts_psi.h,
// unchanged). parse_packet is built on them, so the two always agree.
inline int ts_pid(const uint8_t* p) { return ((p[1] & 0x1F) << 8) | p[2]; }
inline bool ts_pusi(const uint8_t* p) { return (p[1] & 0x40) != 0; }
inline bool ts_has_payload(const uint8_t* p) { return (p[3] & 0x10) != 0; }
inline int payload_offset(const uint8_t* p) {
    int off = 4;
    if (p[3] & 0x20) off += 1 + p[4];
    return off;
}

// has_payload is the header flag (what CC counts); payload_off is PKT whenever
// no payload byte is present. af_pcr holds exactly when read_pcr(p) >= 0.
struct PacketView {
    uint8_t* p;                           // mutable: rewriters write in place
    int pid; uint8_t cc;
    bool tei, pusi, scrambled, has_af, has_payload;
    int af_len, payload_off;              // payload_off == PKT: no payload
    bool af_discontinuity, af_rai, af_pcr;
};
bool parse_packet(uint8_t* p, PacketView* out);   // false: not 0x47

// Calls on_packet(PacketView&) per whole packet, in order, carrying an unaligned
// tail into the next feed (a packet split across feeds is joined internally: its
// v.p is not in `data`); a lost sync resyncs by ts_split's rule, bytes counted.
class PacketWalker {
  public:
    template <class F> void feed(uint8_t* data, size_t len, F&& on_packet);
    size_t carried() const { return carry_len_; }   // bytes held for the next feed
    uint64_t desync_bytes() const { return desync_; }
    void reset() { carry_len_ = 0; }      // drops the carry; desync_bytes is lifetime

  private:
    // Byte `i` of carry_ + data, the stream this feed walks.
    uint8_t at(size_t i, const uint8_t* data) const {
        return i < carry_len_ ? carry_[i] : data[i - carry_len_];
    }
    size_t resync(size_t off, const uint8_t* data, size_t n);
    uint8_t* join(size_t off, const uint8_t* data);
    void keep_tail(size_t off, const uint8_t* data, size_t n);

    uint8_t carry_[PKT];
    uint8_t join_[PKT];
    size_t carry_len_ = 0;
    uint64_t desync_ = 0;
};

template <class F>
void PacketWalker::feed(uint8_t* data, size_t len, F&& on_packet) {
    const size_t c = carry_len_, n = c + len;
    size_t off = 0;
    PacketView v;
    while (off + PKT <= n) {
        if (at(off, data) != SYNC_BYTE) {
            off = resync(off, data, n);
            continue;
        }
        parse_packet(off >= c ? data + (off - c) : join(off, data), &v);
        on_packet(v);
        off += PKT;
    }
    keep_tail(off, data, n);
}

// Per-PID continuity counter (ISO 13818-1 2.4.3.3). Adaptation-only packets
// never advance CC; one duplicate (same CC, with payload) is legal and
// reported; af_discontinuity resets expectation. Null packets are not tracked.
class CcTracker {
  public:
    enum class Result { Ok, Duplicate, Lost, Reset };
    Result feed(const PacketView& v);
    uint64_t lost() const { return lost_; }   // Lost results: events, not packets

  private:
    uint8_t state_[8192] = {};            // per PID: known, duplicate seen, last CC
    uint64_t lost_ = 0;
};

}  // namespace mrts
