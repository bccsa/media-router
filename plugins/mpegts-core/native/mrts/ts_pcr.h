// The program clock reference (ISO 13818-1 2.4.3.4-2.4.3.5): read, rewrite and
// build the 27 MHz PCR, flag a discontinuity, and pace PCR-only packets on a
// sparse PCR PID at the egress (design §7).
#pragma once
#include <cstdint>

#include "ts_house.h"
#include "ts_packet.h"

namespace mrts {

// 27 MHz PCR carried in the packet's adaptation field, or -1.
int64_t read_pcr(const uint8_t* pkt);

// Rewrite the PCR in place, encoded as build_pcr_packet encodes it (33-bit
// base, reserved bits set). False, nothing written, without a PCR field; the
// raw form applies read_pcr's test to the bytes.
bool write_pcr(PacketView& v, int64_t pcr27);     // only if af_pcr
bool write_pcr(uint8_t* pkt, int64_t pcr27);

// discontinuity_indicator (AF flags bit 7). False without an AF flags byte: the
// caller then inserts build_pcr_packet(..., true, ...) instead.
bool set_discontinuity_indicator(PacketView& v);

// PCR-only packet (adaptation field, no payload) on `pid`; cc is stamped from
// the PID's last payload packet (adaptation-only never advances CC).
void build_pcr_packet(int pid, int64_t pcr27, int cc, bool discontinuity,
                      uint8_t out[PKT]);
inline void build_pcr_packet(int pid, int64_t pcr27, int cc, uint8_t out[PKT]) {
    build_pcr_packet(pid, pcr27, cc, false, out);    // today's 4-argument callers
}

// Egress cadence (§7): a PCR-only packet is due once the PCR PID has carried
// no PCR for PCR_MAX_INTERVAL_NS, and before its first, so a source without a
// PCR gets one. Call saw_pcr for every PCR sent, written or inserted.
class PcrScheduler {
  public:
    void saw_pcr(int64_t house_now_ns) {
        last_pcr_ns_ = house_now_ns;
        have_pcr_ = true;
    }
    void saw_payload(uint8_t cc) { cc_ = cc & 0x0F; }
    bool due(int64_t house_now_ns) const {
        return !have_pcr_ || house_now_ns - last_pcr_ns_ >= PCR_MAX_INTERVAL_NS;
    }
    uint8_t cc() const { return cc_; }    // 0 until the PID's first payload

  private:
    int64_t last_pcr_ns_ = 0;
    bool have_pcr_ = false;
    uint8_t cc_ = 0;
};

}  // namespace mrts
