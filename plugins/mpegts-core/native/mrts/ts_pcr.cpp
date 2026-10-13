#include "ts_pcr.h"

#include <cstring>

namespace mrts {
namespace {

// read_pcr's test: an adaptation field with its flags byte, PCR_flag, and room
// for the six PCR bytes.
bool has_pcr_field(const uint8_t* pkt) {
    return (pkt[3] & 0x20) && pkt[4] >= 7 && (pkt[5] & 0x10);
}

// The six PCR bytes at `f`, shared by the builder and both writers so the three
// can never encode differently. The base keeps its low 33 bits (the PCR wrap).
void put_pcr(uint8_t* f, int64_t pcr27) {
    const int64_t base = (pcr27 / 300) & 0x1FFFFFFFFLL;   // 33-bit 90 kHz base
    const int ext = (int)(pcr27 % 300);                    // 9-bit 27 MHz remainder
    f[0] = (uint8_t)(base >> 25);
    f[1] = (uint8_t)(base >> 17);
    f[2] = (uint8_t)(base >> 9);
    f[3] = (uint8_t)(base >> 1);
    f[4] = (uint8_t)(((base & 0x01) << 7) | 0x7E | ((ext >> 8) & 0x01));
    f[5] = (uint8_t)(ext & 0xFF);
}

}  // namespace

int64_t read_pcr(const uint8_t* pkt) {
    if (!has_pcr_field(pkt)) return -1;
    int64_t base = ((int64_t)pkt[6] << 25) | ((int64_t)pkt[7] << 17) |
                   ((int64_t)pkt[8] << 9) | ((int64_t)pkt[9] << 1) | (pkt[10] >> 7);
    int64_t ext = ((pkt[10] & 0x01) << 8) | pkt[11];
    return base * 300 + ext;
}

bool write_pcr(PacketView& v, int64_t pcr27) {
    if (!v.af_pcr) return false;
    put_pcr(v.p + 6, pcr27);
    return true;
}

bool write_pcr(uint8_t* pkt, int64_t pcr27) {
    if (!has_pcr_field(pkt)) return false;
    put_pcr(pkt + 6, pcr27);
    return true;
}

bool set_discontinuity_indicator(PacketView& v) {
    // An AF of length 0 is one stuffing byte: p[5] is already payload.
    if (!v.has_af || v.af_len < 1) return false;
    v.p[5] |= 0x80;
    v.af_discontinuity = true;
    return true;
}

void build_pcr_packet(int pid, int64_t pcr27, int cc, bool discontinuity,
                      uint8_t out[PKT]) {
    std::memset(out, 0xFF, PKT);
    out[0] = SYNC_BYTE;
    out[1] = (pid >> 8) & 0x1F;                     // no PUSI
    out[2] = pid & 0xFF;
    out[3] = 0x20 | (cc & 0x0F);                    // adaptation only, no payload
    out[4] = 183;                                   // fills the packet
    out[5] = discontinuity ? 0x90 : 0x10;           // PCR_flag, + discontinuity_indicator
    put_pcr(out + 6, pcr27);
}

}  // namespace mrts
