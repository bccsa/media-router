// ts_hcdesc: the house-time descriptor codec (WI-P5-1, B-219), pinned by vectors:
// a format, so no Python reference (S5).
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <string>
#include <vector>

#include "../ts_hcdesc.h"
#include "../ts_psi.h"
#include "check.h"

using namespace mrts;

namespace {

std::vector<uint8_t> enc(const HouseTimeDecl& d) {
    uint8_t b[hcdesc::BYTES];
    hcdesc::encode(d, b);
    return std::vector<uint8_t>(b, b + hcdesc::BYTES);
}

HouseTimeDecl full() {
    HouseTimeDecl d;
    d.house_time_tai = d.disciplined = d.traceable = d.ptp_valid = true;
    d.sync_source = hcdesc::SYNC_PTP;
    d.tai_utc_offset_s = 37;
    d.ptp_domain = 0;
    d.clock_error_class = 11;
    d.gm_identity = 0x2CCF67FFFE76E669ull;
    d.epoch_seq = 0x1234;
    d.d_e_90k = 27000;   // 300 ms
    d.timeline_id = 0x0123456789ABCDEFull;
    return d;
}

bool round_trips(const HouseTimeDecl& d) {
    HouseTimeDecl r;
    const std::vector<uint8_t> b = enc(d);
    return hcdesc::decode(b.data(), (int)b.size(), &r) && r == d;
}

void test_layout() {
    const std::vector<uint8_t> b = enc(full());
    const uint8_t want[hcdesc::BYTES] = {
        0x05, 32, 'M', 'R', 'H', 'T', 1, 0xFF, 3, 37, 0,
        0x2C, 0xCF, 0x67, 0xFF, 0xFE, 0x76, 0xE6, 0x69,
        11, 0x12, 0x34, 0x00, 0x00, 0x69, 0x78,
        0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF};
    CHECK("layout: tag 0x05, length 32, 'MRHT', version 1, flags b7-b4 and reserved 1111",
          std::memcmp(b.data(), want, 8) == 0);
    CHECK("layout: sync_source, TAI-UTC, domain, gm big-endian, class, epoch_seq, d_e, timeline_id",
          std::memcmp(b.data(), want, hcdesc::BYTES) == 0);
    HouseTimeDecl none;
    const std::vector<uint8_t> n = enc(none);
    CHECK("layout: a bare declaration's flags are the reserved 1111 alone", n[7] == 0x0F);
}

void test_round_trip() {
    CHECK("round trip: every field set", round_trips(full()));
    CHECK("round trip: the defaults", round_trips(HouseTimeDecl{}));
    bool flags = true;
    for (int m = 0; m < 16; m++) {
        HouseTimeDecl d = full();
        d.house_time_tai = m & 8;
        d.disciplined = m & 4;
        d.traceable = m & 2;
        d.ptp_valid = m & 1;
        if (!d.ptp_valid) d.ptp_domain = 0xFF, d.gm_identity = ~0ull;
        flags = flags && round_trips(d);
    }
    CHECK("round trip: all 16 flag combinations", flags);
    HouseTimeDecl hi = full();
    hi.version = 0xFF;
    hi.sync_source = 0xFF;
    hi.tai_utc_offset_s = 0xFF;
    hi.ptp_domain = 127;
    hi.clock_error_class = hcdesc::ERROR_CLASS_UNKNOWN;
    hi.gm_identity = ~0ull;
    hi.epoch_seq = 0xFFFF;
    hi.d_e_90k = 0xFFFFFFFFu;
    hi.timeline_id = ~0ull;
    CHECK("round trip: every field at its maximum", round_trips(hi));
    HouseTimeDecl lo = full();
    lo.sync_source = lo.tai_utc_offset_s = lo.ptp_domain = lo.clock_error_class = 0;
    lo.gm_identity = 0;
    lo.epoch_seq = 0;
    lo.d_e_90k = 0;
    lo.timeline_id = 0;
    CHECK("round trip: every field at its minimum (version 1)", round_trips(lo));
    bool src = true;
    for (uint8_t s : {hcdesc::SYNC_NONE, hcdesc::SYNC_NTP, hcdesc::SYNC_SNTP, hcdesc::SYNC_PTP}) {
        HouseTimeDecl d = full();
        d.sync_source = s;
        src = src && round_trips(d);
    }
    CHECK("round trip: each sync_source", src);
}

void test_ptp_invalid() {
    HouseTimeDecl d = full();
    d.ptp_valid = false;   // domain 0 and a gm still in the struct
    const std::vector<uint8_t> b = enc(d);
    bool ones = true;
    for (int i = 11; i < 19; i++) ones = ones && b[i] == 0xFF;
    CHECK("ptp_valid 0: domain written 0xFF and grandmaster all ones", b[10] == 0xFF && ones);
    HouseTimeDecl r;
    CHECK("ptp_valid 0: decodes the wire's 0xFF and all ones",
          hcdesc::decode(b.data(), (int)b.size(), &r) && !r.ptp_valid && r.ptp_domain == 0xFF &&
              r.gm_identity == ~0ull);
}

void test_lengths() {
    HouseTimeDecl d = full();
    std::vector<uint8_t> b = enc(d);
    HouseTimeDecl r;
    std::vector<uint8_t> v24(b.begin(), b.begin() + 26);
    v24[1] = 24;
    CHECK("length 24: decodes, timeline_id 0, the rest as written",
          hcdesc::decode(v24.data(), (int)v24.size(), &r) && r.timeline_id == 0 &&
              r.d_e_90k == d.d_e_90k && r.gm_identity == d.gm_identity && r.epoch_seq == d.epoch_seq);
    std::vector<uint8_t> v40 = b;
    v40[1] = 40;
    v40[6] = 2;
    for (int i = 0; i < 8; i++) v40.push_back(0xA5);
    HouseTimeDecl want = d;
    want.version = 2;
    CHECK("length 40, hc_version 2: version 1's fields, the trailing bytes ignored",
          hcdesc::decode(v40.data(), (int)v40.size(), &r) && r == want);
    std::vector<uint8_t> v23(b.begin(), b.begin() + 25);
    v23[1] = 23;
    CHECK("length 23: rejected", !hcdesc::decode(v23.data(), (int)v23.size(), &r));
    CHECK("a buffer shorter than descriptor_length: rejected",
          !hcdesc::decode(b.data(), hcdesc::BYTES - 1, &r) && !hcdesc::decode(b.data(), 1, &r));
    std::vector<uint8_t> t = b;
    t[0] = 0x0A;
    CHECK("another tag: rejected", !hcdesc::decode(t.data(), (int)t.size(), &r));
    t = b;
    t[5] = 'A';
    CHECK("another format_identifier: rejected", !hcdesc::decode(t.data(), (int)t.size(), &r));
    t = b;
    t[6] = 0;
    CHECK("hc_version 0: rejected", !hcdesc::decode(t.data(), (int)t.size(), &r));
    t = b;
    t[7] = 0x80;
    CHECK("reserved bits read as 0: ignored",
          hcdesc::decode(t.data(), (int)t.size(), &r) && r.house_time_tai && !r.disciplined);
}

const std::vector<uint8_t> KLVA = {0x05, 4, 'K', 'L', 'V', 'A'};
const std::vector<uint8_t> ISO639 = {0x0A, 4, 'e', 'n', 'g', 0x00};

std::vector<uint8_t> cat(std::initializer_list<std::vector<uint8_t>> parts) {
    std::vector<uint8_t> r;
    for (const auto& p : parts) r.insert(r.end(), p.begin(), p.end());
    return r;
}

void test_find_in() {
    const HouseTimeDecl d = full();
    HouseTimeDecl r;
    CHECK("find_in: an MRHT behind a KLVA registration",
          hcdesc::find_in(cat({KLVA, ISO639, enc(d)}), &r) && r == d);
    CHECK("find_in: none in a loop without one", !hcdesc::find_in(cat({KLVA, ISO639}), &r));
    CHECK("find_in: none in an empty loop", !hcdesc::find_in({}, &r));
    std::vector<uint8_t> bad = enc(d);
    bad.resize(25);
    bad[1] = 23;
    HouseTimeDecl d2 = d;
    d2.epoch_seq = 7;
    CHECK("find_in: a short MRHT skipped, the next one taken",
          hcdesc::find_in(cat({bad, enc(d2)}), &r) && r.epoch_seq == 7);
    std::vector<uint8_t> over = enc(d);
    over.pop_back();
    CHECK("find_in: an MRHT that overruns the loop is none",
          !hcdesc::find_in(cat({KLVA, over}), &r));
}

void test_strip_from() {
    HouseTimeDecl d2 = full();
    d2.d_e_90k = 1;
    const std::vector<uint8_t> mrht_bare = {0x05, 4, 'M', 'R', 'H', 'T'};   // even a bare one
    const std::vector<uint8_t> loop = cat({enc(full()), KLVA, mrht_bare, ISO639, enc(d2)});
    CHECK("strip_from: every MRHT removed, KLVA and ISO 639 byte-identical in order",
          hcdesc::strip_from(loop) == cat({KLVA, ISO639}));
    CHECK("strip_from: a loop without MRHT unchanged",
          hcdesc::strip_from(cat({KLVA, ISO639})) == cat({KLVA, ISO639}));
    const std::vector<uint8_t> tail = {0x0A, 9, 'x'};
    CHECK("strip_from: an overrunning tail kept verbatim",
          hcdesc::strip_from(cat({enc(full()), KLVA, tail})) == cat({KLVA, tail}));
    const std::vector<uint8_t> short_reg = {0x05, 2, 'M', 'R'};
    CHECK("strip_from: a registration too short to name a format kept",
          hcdesc::strip_from(short_reg) == short_reg);
}

void test_error_class() {
    CHECK("error_class(1200) == 11", hcdesc::error_class(1200) == 11);
    CHECK("error_class: 0 and 1 us are class 0, 2 is 1, 3 is 2",
          hcdesc::error_class(0) == 0 && hcdesc::error_class(1) == 0 &&
              hcdesc::error_class(2) == 1 && hcdesc::error_class(3) == 2);
    CHECK("error_class: 1024 is 10, 1025 is 11, 0.5 is 0",
          hcdesc::error_class(1024) == 10 && hcdesc::error_class(1025) == 11 &&
              hcdesc::error_class(0.5) == 0);
    CHECK("error_class: saturates at 31",
          hcdesc::error_class(std::ldexp(1.0, 31)) == 31 && hcdesc::error_class(1e18) == 31);
    CHECK("error_class: negative or NaN is unknown (0xFF)",
          hcdesc::error_class(-1) == 0xFF && hcdesc::error_class(std::nan("")) == 0xFF);
    CHECK("error_bound_us: 2^class, -1 for unknown",
          hcdesc::error_bound_us(11) == 2048 && hcdesc::error_bound_us(0) == 1 &&
              hcdesc::error_bound_us(0xFF) == -1);
}

void test_gm() {
    const uint64_t want = 0x2CCF67FFFE76E669ull;
    uint64_t v = 0;
    CHECK("parse_gm: pmc's form", hcdesc::parse_gm("2ccf67.fffe.76e669", &v) && v == want);
    v = 0;
    CHECK("parse_gm: colons", hcdesc::parse_gm("2c:cf:67:ff:fe:76:e6:69", &v) && v == want);
    v = 0;
    CHECK("parse_gm: RFC 7273's dashes, upper case",
          hcdesc::parse_gm("2C-CF-67-FF-FE-76-E6-69", &v) && v == want);
    bool bad = true;
    for (const char* s : {"", "2ccf67fffe76e669", "2ccf67:fffe:76e669", "2c:cf:67-ff:fe:76:e6:69",
                          "2c:cf:67:ff:fe:76:e6:6", "2c:cf:67:ff:fe:76:e6:6g", "2ccf67.fffe.76e66",
                          "2c.cf.67.ff.fe.76.e6.69", "2ccf67.fffe-76e669"})
        bad = bad && !hcdesc::parse_gm(s, &v);
    CHECK("parse_gm: other spellings refused", bad);
    CHECK("gm_text: RFC 7273's form, parsed back",
          hcdesc::gm_text(want) == "2C-CF-67-FF-FE-76-E6-69" &&
              hcdesc::parse_gm(hcdesc::gm_text(want), &v) && v == want);
}

void test_timeline_text() {
    CHECK("timeline_text: 0 is sixteen zeros", hcdesc::timeline_text(0) == "0000000000000000");
    CHECK("timeline_text: lower case, no prefix",
          hcdesc::timeline_text(0x0123456789ABCDEFull) == "0123456789abcdef");
    uint64_t v = 1;
    CHECK("parse_timeline_text: round trip, and none",
          hcdesc::parse_timeline_text("0123456789abcdef", &v) && v == 0x0123456789ABCDEFull &&
              hcdesc::parse_timeline_text("0000000000000000", &v) && v == 0 &&
              hcdesc::parse_timeline_text(hcdesc::timeline_text(~0ull), &v) && v == ~0ull);
    bool bad = true;
    for (const char* s : {"0123456789ABCDEF", "0x0123456789abcd", "123456789abcdef",
                          "00123456789abcdef", "0123456789abcdeg", ""})
        bad = bad && !hcdesc::parse_timeline_text(s, &v);
    CHECK("parse_timeline_text: upper case, a prefix, other lengths refused", bad);
}

void test_in_pmt() {
    // Through S0's PMT builder and parser: the descriptor survives as written.
    const std::vector<uint8_t> pi = cat({KLVA, enc(full())});
    const std::vector<uint8_t> sec =
        build_pmt_section(1, 0x100, pi, {{0x100, STREAM_TYPE_AVC, {}}}, 3);
    std::vector<uint8_t> pkts;
    uint8_t cc = 0;
    packetise_section(0x1000, sec, cc, pkts);
    std::deque<TsPacket> q;
    for (size_t i = 0; i + PKT <= pkts.size(); i += PKT) {
        TsPacket p;
        std::memcpy(p.b, pkts.data() + i, PKT);
        q.push_back(p);
    }
    const auto pmt = parse_pmt(q, 0x1000);
    HouseTimeDecl r;
    CHECK("in a PMT: program_info carried verbatim, find_in reads the declaration",
          pmt && pmt->program_info == pi && hcdesc::find_in(pmt->program_info, &r) && r == full());
    CHECK("in a PMT: registration_format still reads the first (KLVA), as S4 says",
          pmt && registration_format(pmt->program_info) == 0x4B4C5641);
}

}  // namespace

int main() {
    test_layout();
    test_round_trip();
    test_ptp_invalid();
    test_lengths();
    test_find_in();
    test_strip_from();
    test_error_class();
    test_gm();
    test_timeline_text();
    test_in_pmt();
    return test_summary("ts_hcdesc");
}
