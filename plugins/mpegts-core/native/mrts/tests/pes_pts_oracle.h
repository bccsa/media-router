// read_pes_pts as it was before it forwarded to parse_pes_header (WI-S0-6; the forwarder went in
// B-143), verbatim: the oracle ts_psi_test and ts_pes_test hold the PES header parse to.
#pragma once
#include <cstdint>

#include "../ts_packet.h"

inline int64_t old_read_pes_pts(const uint8_t* pkt) {
    using namespace mrts;
    if (!ts_pusi(pkt) || !ts_has_payload(pkt)) return -1;
    int off = payload_offset(pkt);
    if (off + 14 > PKT) return -1;
    const uint8_t* p = pkt + off;
    if (p[0] != 0x00 || p[1] != 0x00 || p[2] != 0x01) return -1;
    switch (p[3]) {
        case 0xBC: case 0xBE: case 0xBF: case 0xF0:
        case 0xF1: case 0xF2: case 0xF8: case 0xFF:
            return -1;
        default:
            break;
    }
    if ((p[6] & 0xC0) != 0x80) return -1;
    if (!(p[7] & 0x80)) return -1;
    return ((int64_t)((p[9] >> 1) & 0x07) << 30) | ((int64_t)p[10] << 22) |
           ((int64_t)(p[11] >> 1) << 15) | ((int64_t)p[12] << 7) | (p[13] >> 1);
}
