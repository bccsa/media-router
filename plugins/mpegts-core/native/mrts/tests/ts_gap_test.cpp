// ts_gap: the bus gap marker's packet (plan ch. 5 OQ-12), built by mrtsrestamp and read by
// Phase 2's aligners, Phase 3's demux and Phase 5's egress.
#include <cstdint>
#include <cstdio>
#include <cstring>

#include "../ts_gap.h"
#include "../ts_packet.h"
#include "../ts_pcr.h"
#include "../ts_pes.h"
#include "check.h"

using namespace mrts;

namespace {

bool all_ff(const uint8_t* p, int from) {
    for (int i = from; i < PKT; i++)
        if (p[i] != 0xFF) return false;
    return true;
}

void test_layout() {
    uint8_t p[PKT];
    build_gap_packet(0x1ABC, 0x17, 500000000, p);
    // The form gst_mrtsstamp_element_test.py (WI-P1-7) hands an identity egress, byte for byte.
    const uint8_t head[] = {0x47, 0x1A, 0xBC, 0x27, 183, 0x02, 8, 0, 0, 0, 0, 0x1D, 0xCD, 0x65, 0x00};
    CHECK("layout: sync, PID 0x1ABC without PUSI, adaptation only with the CC, AF of 183",
          std::memcmp(p, head, 5) == 0);
    CHECK("layout: transport_private_data_flag alone, 8 bytes: 500 ms in ns, big-endian",
          std::memcmp(p + 5, head + 5, sizeof head - 5) == 0);
    CHECK("layout: stuffing to the end", all_ff(p, sizeof head));
    PacketView v;
    CHECK("layout: a packet the walker parses: no payload, no PCR, no discontinuity",
          parse_packet(p, &v) && v.pid == 0x1ABC && v.cc == 7 && !v.has_payload &&
              v.payload_off == PKT && v.has_af && v.af_len == 183 && !v.af_pcr &&
              !v.af_discontinuity && !v.pusi && read_pcr(p) < 0);
    CHECK("round trip: 500 ms", read_gap_length(p) == 500000000);
}

void test_values() {
    uint8_t p[PKT];
    bool ok = true;
    for (const int64_t len : {0LL, 1LL, 11111LL, 250000000LL, 3000000000LL, 86400000000000LL,
                              (long long)INT64_MAX}) {
        build_gap_packet(0x100, 3, len, p);
        ok &= read_gap_length(p) == len;
    }
    CHECK("round trip: 0, 1 ns, a tick, 250 ms, 3 s, a day, INT64_MAX", ok);
    build_gap_packet(0x100, 3, -5, p);
    CHECK("a negative length is written as 0", read_gap_length(p) == 0);
}

void test_cc() {
    // Adaptation-only packets never advance CC: a gap packet between two payload packets
    // with consecutive CCs is no loss, and carries the first one's CC.
    CcTracker cc;
    uint8_t a[PKT], g[PKT], b[PKT];
    std::memset(a, 0xFF, PKT);
    a[0] = 0x47;
    a[1] = 0x01;
    a[2] = 0x00;
    a[3] = 0x10 | 0x0E;
    std::memcpy(b, a, PKT);
    b[3] = 0x10 | 0x0F;
    build_gap_packet(0x100, 0x0E, 40000000, g);
    PacketView va, vg, vb;
    parse_packet(a, &va);
    parse_packet(g, &vg);
    parse_packet(b, &vb);
    const CcTracker::Result ra = cc.feed(va), rg = cc.feed(vg), rb = cc.feed(vb);
    CHECK("cc: a payload CC 14, the gap packet, CC 15: all Ok, nothing lost",
          ra == CcTracker::Result::Ok && rg == CcTracker::Result::Ok && rb == CcTracker::Result::Ok &&
              cc.lost() == 0);
}

void test_not_gaps() {
    uint8_t p[PKT];
    std::memset(p, 0xFF, PKT);
    p[0] = 0x47;
    p[1] = 0x41;
    p[2] = 0x00;
    p[3] = 0x10;                          // payload only
    CHECK("not a gap: a payload packet", read_gap_length(p) == -1);
    build_pcr_packet(0x100, 27000000, 2, p);
    CHECK("not a gap: a PCR-only packet (no private data)", read_gap_length(p) == -1);
    // PCR and 2 bytes of private data, as ts_restamp_test numbers its PCR-only packets.
    p[5] |= 0x02;
    p[12] = 2;
    p[13] = 0;
    p[14] = 9;
    CHECK("not a gap: private data of 2 bytes", read_gap_length(p) == -1);
    // The same AF with 8 bytes behind the PCR is read where 2.4.3.4 puts them.
    p[12] = 8;
    for (int i = 0; i < 8; i++) p[13 + i] = (uint8_t)(i == 7 ? 42 : 0);
    CHECK("a PCR ahead of 8 bytes of private data: the bytes behind it", read_gap_length(p) == 42);
    build_gap_packet(0x100, 1, 7, p);
    p[3] = 0x30 | 1;                      // AF and payload
    CHECK("not a gap: an adaptation field with a payload", read_gap_length(p) == -1);
    build_gap_packet(0x100, 1, 7, p);
    p[4] = 10;                            // the AF ends with the length's last byte
    const bool fits = read_gap_length(p) == 7;
    p[4] = 9;                             // ... or one byte short of it
    CHECK("not a gap: private data past the adaptation field's end (one that ends with it is)",
          fits && read_gap_length(p) == -1);
    build_gap_packet(0x100, 1, 7, p);
    p[0] = 0x00;
    CHECK("not a gap: no sync byte", read_gap_length(p) == -1);
    build_gap_packet(0x100, 1, 7, p);
    p[7] = 0x80;                          // past INT64_MAX
    CHECK("not a gap: a length past INT64_MAX", read_gap_length(p) == -1);
}

}  // namespace

int main() {
    test_layout();
    test_values();
    test_cc();
    test_not_gaps();
    return test_summary("ts_gap");
}
