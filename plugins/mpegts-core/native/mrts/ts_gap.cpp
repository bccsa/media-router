#include "ts_gap.h"

#include <cstring>

namespace mrts {

void build_gap_packet(int pid, uint8_t cc, int64_t length_ns, uint8_t out[PKT]) {
    std::memset(out, 0xFF, PKT);
    out[0] = SYNC_BYTE;
    out[1] = (uint8_t)((pid >> 8) & 0x1F);          // no PUSI
    out[2] = (uint8_t)(pid & 0xFF);
    out[3] = (uint8_t)(0x20 | (cc & 0x0F));         // adaptation only
    out[4] = 183;                                   // fills the packet
    out[5] = 0x02;                                  // transport_private_data_flag alone
    out[6] = GAP_PRIVATE_BYTES;
    const uint64_t v = length_ns > 0 ? (uint64_t)length_ns : 0;
    for (int i = 0; i < GAP_PRIVATE_BYTES; i++) out[7 + i] = (uint8_t)(v >> (56 - 8 * i));
}

int64_t read_gap_length(const uint8_t* pkt) {
    if (pkt[0] != SYNC_BYTE || (pkt[3] & 0x30) != 0x20) return -1;
    const int af = pkt[4];
    if (af < 1 || af > PKT - 5) return -1;
    const uint8_t flags = pkt[5];
    if (!(flags & 0x02)) return -1;
    // The optional fields that precede the private data (2.4.3.4): PCR, OPCR, splice_countdown.
    int off = 6;
    if (flags & 0x10) off += 6;
    if (flags & 0x08) off += 6;
    if (flags & 0x04) off += 1;
    if (off + 1 + GAP_PRIVATE_BYTES > 5 + af || pkt[off] != GAP_PRIVATE_BYTES) return -1;
    uint64_t v = 0;
    for (int i = 0; i < GAP_PRIVATE_BYTES; i++) v = (v << 8) | pkt[off + 1 + i];
    return v > (uint64_t)INT64_MAX ? -1 : (int64_t)v;
}

}  // namespace mrts
