// Port of ts_psi_test.py — logic tests for the PSI parse/build core — plus the
// WI-S0-5 additions (descriptors, program selection, generation, multi-packet
// sections), which have no python twin.
#include <algorithm>
#include <cstring>
#include <deque>
#include <vector>

#include "../ts_psi.h"
#include "check.h"

using namespace mrts;

namespace {

TsPacket pkt_of(const uint8_t* p) {
    TsPacket t;
    std::memcpy(t.b, p, PKT);
    return t;
}

// Hand-build one TS packet whose payload starts a PES header (python
// pes_ts_packet parity; af_len < 0 = no adaptation field).
TsPacket pes_ts_packet(int pid, int64_t pts, int64_t dts, uint8_t stream_id,
                       bool pusi, int af_len) {
    TsPacket t;
    std::memset(t.b, 0xFF, PKT);
    t.b[0] = SYNC_BYTE;
    t.b[1] = (pusi ? 0x40 : 0x00) | ((pid >> 8) & 0x1F);
    t.b[2] = pid & 0xFF;
    t.b[3] = 0x10;
    int i = 4;
    if (af_len >= 0) {
        t.b[3] |= 0x20;
        t.b[i++] = (uint8_t)af_len;
        for (int k = 0; k < af_len; k++) t.b[i++] = 0x00;
    }
    t.b[i++] = 0x00;
    t.b[i++] = 0x00;
    t.b[i++] = 0x01;
    t.b[i++] = stream_id;
    t.b[i++] = 0x00;
    t.b[i++] = 0x00;
    uint8_t flags = (pts >= 0 ? 0x80 : 0) | (dts >= 0 ? 0x40 : 0);
    uint8_t fields[10];
    int flen = 0;
    auto stamp = [&](uint8_t prefix, int64_t v) {
        fields[flen++] = (prefix << 4) | ((uint8_t)((v >> 30) & 0x07) << 1) | 1;
        fields[flen++] = (v >> 22) & 0xFF;
        fields[flen++] = ((uint8_t)((v >> 15) & 0x7F) << 1) | 1;
        fields[flen++] = (v >> 7) & 0xFF;
        fields[flen++] = ((uint8_t)(v & 0x7F) << 1) | 1;
    };
    if (pts >= 0 && dts >= 0) {
        stamp(0x3, pts);
        stamp(0x1, dts);
    } else if (pts >= 0) {
        stamp(0x2, pts);
    }
    t.b[i++] = 0x80;
    t.b[i++] = flags;
    t.b[i++] = (uint8_t)flen;
    for (int k = 0; k < flen; k++) t.b[i++] = fields[k];
    return t;
}

// Re-wrap a single-packet PSI packet behind an adaptation field of `af_len`
// bytes (-1 = none) and `ptr` bytes of pointer_field filler — both shift where
// the section starts, which the signature reader must follow.
TsPacket reshape_psi(const uint8_t* src, int af_len, int ptr) {
    int off = payload_offset(src);
    const uint8_t* sec = src + off + 1 + src[off];
    int seclen = 3 + (((sec[1] & 0x0F) << 8) | sec[2]);
    TsPacket t;
    std::memset(t.b, 0xFF, PKT);
    std::memcpy(t.b, src, 4);
    int i = 4;
    if (af_len >= 0) {
        t.b[3] |= 0x20;
        t.b[i++] = (uint8_t)af_len;
        if (af_len > 0) t.b[i] = 0x00;          // AF flags, remainder is stuffing
        i += af_len;
    }
    t.b[i++] = (uint8_t)ptr;
    i += ptr;
    std::memcpy(t.b + i, sec, std::min(seclen, PKT - i));
    return t;
}

int section_offset(const uint8_t* pkt) {
    int off = payload_offset(pkt);
    return off + 1 + pkt[off];
}

using Bytes = std::vector<uint8_t>;

Bytes from_hex(const char* h) {
    auto nib = [](char c) { return c <= '9' ? c - '0' : (c | 0x20) - 'a' + 10; };
    Bytes b;
    for (; h[0] && h[1]; h += 2) b.push_back((uint8_t)(nib(h[0]) << 4 | nib(h[1])));
    return b;
}

// One PSI packet on `pid` whose payload is `payload` (pointer_field + section).
TsPacket psi_packet(int pid, const Bytes& payload) {
    TsPacket t;
    std::memset(t.b, 0xFF, PKT);
    t.b[0] = SYNC_BYTE;
    t.b[1] = 0x40 | ((pid >> 8) & 0x1F);
    t.b[2] = pid & 0xFF;
    t.b[3] = 0x10;
    std::memcpy(t.b + 4, payload.data(), payload.size());
    return t;
}

// Re-seal a one-packet section after a test edited its header.
void fix_crc(TsPacket& t) {
    int so = section_offset(t.b);
    int len = 3 + (((t.b[so + 1] & 0x0F) << 8) | t.b[so + 2]);
    uint32_t crc = crc32_mpeg(t.b + so, len - 4);
    for (int k = 0; k < 4; k++) t.b[so + len - 4 + k] = (uint8_t)(crc >> (24 - 8 * k));
}

std::vector<TsPacket> packets_in(const Bytes& ts) {
    std::vector<TsPacket> v;
    for (size_t i = 0; i + PKT <= ts.size(); i += PKT) v.push_back(pkt_of(ts.data() + i));
    return v;
}

std::deque<TsPacket> deque_in(const Bytes& ts) {
    auto v = packets_in(ts);
    return std::deque<TsPacket>(v.begin(), v.end());
}

// (tag, payload) per descriptor, in walk order.
std::vector<std::pair<int, Bytes>> walk(const Bytes& loop) {
    std::vector<std::pair<int, Bytes>> out;
    for_each_descriptor(loop.data(), (int)loop.size(), [&](const Descriptor& d) {
        out.push_back({d.tag, Bytes(d.data, d.data + d.len)});
    });
    return out;
}

// A descriptor loop of exactly n >= 2 bytes (user-private tag), to size sections.
Bytes filler(int n) {
    Bytes b;
    while (n > 0) {
        int len = n <= 257 ? n - 2 : (n - 257 >= 2 ? 255 : 253);
        b.push_back(0x88);
        b.push_back((uint8_t)len);
        b.insert(b.end(), (size_t)len, (uint8_t)0xA5);
        n -= 2 + len;
    }
    return b;
}

// `section` packetised on PMT PID 0x0030 from CC `cc`.
Bytes packetised(const Bytes& section, uint8_t cc = 0) {
    Bytes ts;
    packetise_section(0x0030, section, cc, ts);
    return ts;
}

bool stuffed(const uint8_t* from, const uint8_t* to) {
    return std::all_of(from, to, [](uint8_t b) { return b == 0xFF; });
}

// read_pes_pts as it was before it forwarded to parse_pes_header (WI-S0-6): the
// oracle the forwarder must match, since the frozen model still calls it.
int64_t old_read_pes_pts(const uint8_t* pkt) {
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

uint32_t lcg_next(uint32_t& s) {
    s = s * 1103515245u + 12345u;
    return s >> 1;
}

// A packet carrying the start of a PES header after an AF of `af_len` bytes (-1 =
// none; past 183 it overruns the packet, as broken wire data does). Both timestamp
// fields are written whatever `flags` says; `broken` 0..2 spoils that start code byte.
TsPacket pes_variant(bool pusi, bool payload, int af_len, uint8_t sid, uint8_t marker,
                     uint8_t flags, uint8_t hdl, uint64_t pts, uint64_t dts, int broken) {
    uint8_t pes[24] = {0x00, 0x00, 0x01, sid, 0x00, 0x00, marker, flags, hdl};
    auto field = [&](int at, uint8_t prefix, uint64_t v) {
        pes[at] = (uint8_t)((prefix << 4) | (((v >> 30) & 0x07) << 1) | 1);
        pes[at + 1] = (uint8_t)(v >> 22);
        pes[at + 2] = (uint8_t)((((v >> 15) & 0x7F) << 1) | 1);
        pes[at + 3] = (uint8_t)(v >> 7);
        pes[at + 4] = (uint8_t)(((v & 0x7F) << 1) | 1);
    };
    field(9, flags == 0xC0 ? 0x3 : 0x2, pts);
    field(14, 0x1, dts);
    pes[19] = pes[20] = pes[21] = pes[22] = pes[23] = 0xFF;
    if (broken >= 0) pes[broken] ^= 0x01;
    TsPacket t;
    std::memset(t.b, 0xFF, PKT);
    t.b[0] = SYNC_BYTE;
    t.b[1] = (uint8_t)((pusi ? 0x40 : 0x00) | 0x01);
    t.b[2] = 0x00;
    t.b[3] = (uint8_t)((payload ? 0x10 : 0x00) | (af_len >= 0 ? 0x20 : 0x00));
    int off = 4;
    if (af_len >= 0) {
        t.b[4] = (uint8_t)af_len;
        if (af_len > 0) t.b[5] = 0x00;
        off = 5 + af_len;
    }
    for (int i = 0; off + i < PKT && i < (int)sizeof pes; i++) t.b[off + i] = pes[i];
    return t;
}

}  // namespace

int main() {
    // CRC-32/MPEG-2 canonical check value + self-consistency.
    CHECK("crc32/mpeg check value",
          crc32_mpeg((const uint8_t*)"123456789", 9) == 0x0376E6E7);
    uint8_t pat[PKT];
    CHECK("PAT builds", build_pat(0x0001, {{1, 0x0100}, {2, 0x0200}}, 0, 0, pat));
    int off = payload_offset(pat);
    const uint8_t* sec = pat + off + 1;
    int seclen = 3 + (((sec[1] & 0x0F) << 8) | sec[2]);
    CHECK("crc self-consistency", crc32_mpeg(sec, seclen) == 0);

    // PAT / PMT build -> parse round-trips (multi-ES program).
    std::deque<TsPacket> patq{pkt_of(pat)};
    auto parsed_pat = parse_pat(patq);
    CHECK("PAT round-trip",
          parsed_pat == std::vector<std::pair<int, int>>({{1, 0x0100}, {2, 0x0200}}));
    uint8_t pmt[PKT];
    build_pmt(0x0100, 1, 0x0100,
              {{0x0100, STREAM_TYPE_AVC, {}}, {0x0141, STREAM_TYPE_AAC, {}}}, 0, 0, pmt);
    auto info = parse_pmt({pkt_of(pmt)}, 0x0100);
    CHECK("PMT pcr/streams",
          info && info->pcr_pid == 0x0100 && info->streams.size() == 2 &&
              info->streams[0].pid == 0x0100 && info->streams[0].stream_type == 0x1b &&
              info->streams[1].pid == 0x0141 && info->streams[1].stream_type == 0x0f);

    // ES descriptors round-trip: Opus identity is ONLY its descriptor loop.
    const std::vector<uint8_t> opus_desc = {0x05, 0x04, 'O', 'p', 'u', 's',
                                            0x7f, 0x02, 0x80, 0x02};
    uint8_t pmt_d[PKT];
    build_pmt(0x0100, 1, 0x0141, {{0x0141, STREAM_TYPE_PRIVATE_PES, opus_desc}},
              0, 0, pmt_d);
    auto info_d = parse_pmt({pkt_of(pmt_d)}, 0x0100);
    CHECK("descriptor round-trip: stream list",
          info_d && info_d->streams.size() == 1 &&
              info_d->streams[0].stream_type == STREAM_TYPE_PRIVATE_PES);
    CHECK("descriptor round-trip: es_info verbatim",
          info_d && info_d->streams[0].es_info == opus_desc);
    uint8_t pmt_b[PKT];
    build_pmt(0x0100, 1, 0x0141, {{0x0141, STREAM_TYPE_AAC, {}}}, 0, 0, pmt_b);
    auto info_b = parse_pmt({pkt_of(pmt_b)}, 0x0100);
    CHECK("bare streams still build (es_info empty)",
          info_b && info_b->streams[0].es_info.empty());

    // PsiDiscovery: PAT and PMT arriving far apart (sparse broadcast PSI).
    PsiDiscovery disc(64);
    uint8_t patD[PKT], pmtD[PKT], nullp[PKT];
    build_pat(2, {{100, 0x0064}}, 0, 0, patD);
    build_pmt(0x0064, 100, 0x0065,
              {{0x0065, STREAM_TYPE_AVC, {}}, {0x00c9, STREAM_TYPE_AAC, {}}}, 0, 0, pmtD);
    null_packet(0, nullp);
    disc.feed({pkt_of(patD)});
    CHECK("discovery learns pmt_pid from PAT alone", disc.pmt_pid() == 0x0064);
    for (int i = 0; i < 300; i++) disc.feed({pkt_of(nullp)});
    CHECK("no PMT yet during the gap", !disc.pmt().has_value());
    CHECK("discovery fires when PMT arrives", disc.feed({pkt_of(pmtD)}));
    CHECK("discovered streams correct",
          disc.pmt() && disc.pmt()->pcr_pid == 0x0065 &&
              disc.pmt()->streams.size() == 2 &&
              disc.pmt()->streams[0].pid == 0x0065 &&
              disc.pmt()->streams[1].pid == 0x00c9);

    // --- section_signature: the cheap change signal ---
    uint8_t sigpmt[PKT];
    build_pmt(0x0030, 0x0101, 0x0065, {{0x0065, STREAM_TYPE_HEVC, {}}}, 0, 3, sigpmt);
    SectionSig s0;
    CHECK("signature reads a PMT packet", section_signature(sigpmt, &s0));
    CHECK("signature: table_id / program / version",
          s0.table_id == TABLE_PMT && s0.table_id_ext == 0x0101 && s0.version == 3);
    CHECK("signature: CRC present when the tail is in this packet", s0.has_crc);
    SectionSig s1;
    CHECK("signature behind an adaptation field + pointer_field filler",
          section_signature(reshape_psi(sigpmt, 10, 7).b, &s1) && s1 == s0);
    // A section longer than this packet: version only, no CRC tail yet.
    TsPacket span = pkt_of(sigpmt);
    int so = section_offset(span.b);
    span.b[so + 1] = 0xB0 | ((300 >> 8) & 0x0F);
    span.b[so + 2] = 300 & 0xFF;
    SectionSig s2;
    CHECK("signature: spanning section falls back to version only",
          section_signature(span.b, &s2) && s2.version == 3 && !s2.has_crc);
    CHECK("signature: version-only differs from the CRC-bearing one", !(s2 == s0));
    TsPacket nxt = pkt_of(sigpmt);
    nxt.b[section_offset(nxt.b) + 5] &= 0xFE;    // current_next_indicator = 0
    SectionSig s3;
    CHECK("signature ignores a next-table section", !section_signature(nxt.b, &s3));
    TsPacket sec1 = pkt_of(sigpmt);
    sec1.b[section_offset(sec1.b) + 6] = 1;      // section_number = 1
    CHECK("signature ignores sections past the first", !section_signature(sec1.b, &s3));
    TsPacket shortsec = pkt_of(sigpmt);
    shortsec.b[section_offset(shortsec.b) + 2] = 5;
    CHECK("signature rejects a section too short to hold a CRC",
          !section_signature(shortsec.b, &s3));
    uint8_t sigpat[PKT];
    build_pat(0x0007, {{1, 0x0030}}, 0, 2, sigpat);
    SectionSig s4;
    CHECK("signature reads a PAT packet",
          section_signature(sigpat, &s4) && s4.table_id == TABLE_PAT &&
              s4.table_id_ext == 0x0007 && s4.version == 2);
    CHECK("PES packets carry no section signature",
          !section_signature(pes_ts_packet(0x65, 90000, -1, 0xE0, true, -1).b, &s4));

    // --- upstream codec change is seen at once, not at the 500-feed backstop ---
    // The carousel has filled the PMT buffer with superseded sections by the
    // time the switch happens; reassembly returns the OLDEST retained section,
    // so detection needs the stale copies dropped as well as the re-parse.
    PsiDiscovery sw(128);
    uint8_t patS[PKT], pmt265[PKT], pmt264[PKT];
    build_pat(3, {{1, 0x0030}}, 0, 0, patS);
    build_pmt(0x0030, 1, 0x0065, {{0x0065, STREAM_TYPE_HEVC, {}}}, 0, 0, pmt265);
    build_pmt(0x0030, 1, 0x0065, {{0x0065, STREAM_TYPE_AVC, {}}}, 0, 1, pmt264);
    sw.feed({pkt_of(patS)});
    CHECK("switch: pmt_pid learned from the PAT", sw.pmt_pid() == 0x0030);
    CHECK("switch: h265 first discovered", sw.feed({pkt_of(pmt265)}) &&
                                               sw.pmt()->streams[0].stream_type ==
                                                   STREAM_TYPE_HEVC);
    int spurious = 0;
    for (int i = 0; i < 300; i++)      // 300 carousel repeats, no 500-boundary
        if (sw.feed({pkt_of(pmt265)})) spurious++;
    CHECK("switch: identical carousel repeats report no change", spurious == 0);
    int fired = -1;
    for (int i = 0; i < 5 && fired < 0; i++)
        if (sw.feed({pkt_of(pmt264)})) fired = i;
    CHECK("switch: h265 -> h264 detected on the very next feed", fired == 0);
    CHECK("switch: new codec latched",
          sw.pmt() && sw.pmt()->streams[0].stream_type == STREAM_TYPE_AVC);

    // Same version_number, different content (a mux that forgets to bump it):
    // the section CRC still separates them.
    PsiDiscovery cr(128);
    uint8_t pmt_a[PKT], pmt_b2[PKT];
    build_pmt(0x0030, 1, 0x0065, {{0x0065, STREAM_TYPE_HEVC, {}}}, 0, 7, pmt_a);
    build_pmt(0x0030, 1, 0x0065,
              {{0x0065, STREAM_TYPE_HEVC, {}}, {0x00c9, STREAM_TYPE_AAC, {}}}, 0, 7,
              pmt_b2);
    cr.feed({pkt_of(patS)});
    cr.feed({pkt_of(pmt_a)});
    for (int i = 0; i < 200; i++) cr.feed({pkt_of(pmt_a)});
    CHECK("crc-only: version unchanged but content differs",
          cr.feed({pkt_of(pmt_b2)}) && cr.pmt()->streams.size() == 2);

    // A new PAT can also move the program to a different PMT PID.
    PsiDiscovery mv(128);
    uint8_t patA[PKT], patB[PKT], pmtB[PKT];
    build_pat(3, {{1, 0x0030}}, 0, 0, patA);
    build_pat(3, {{1, 0x0040}}, 0, 1, patB);
    build_pmt(0x0040, 1, 0x0065, {{0x0065, STREAM_TYPE_AVC, {}}}, 0, 0, pmtB);
    mv.feed({pkt_of(patA)});
    for (int i = 0; i < 50; i++) mv.feed({pkt_of(patA), pkt_of(pmt265)});
    CHECK("pmt pid move: starts on the old pid",
          mv.pmt_pid() == 0x0030 && mv.pmt() &&
              mv.pmt()->streams[0].stream_type == STREAM_TYPE_HEVC);
    mv.feed({pkt_of(patB)});
    CHECK("pmt pid move: new PAT re-learns the pid", mv.pmt_pid() == 0x0040);
    CHECK("pmt pid move: PMT on the new pid is discovered at once",
          mv.feed({pkt_of(pmtB)}) && mv.pmt()->streams[0].stream_type == STREAM_TYPE_AVC);

    // Realistic combined PMT at max fan-in (24 ES, bare) fits one packet.
    std::vector<PmtStream> maxes;
    for (int i = 0; i < 8; i++) maxes.push_back({0x0100 + i, STREAM_TYPE_AVC, {}});
    for (int i = 0; i < 16; i++) maxes.push_back({0x0140 + i, STREAM_TYPE_AAC, {}});
    uint8_t bigpmt[PKT];
    CHECK("24-ES combined PMT fits one packet",
          build_pmt(0x1100, 1, 0x0100, maxes, 0, 0, bigpmt));
    auto big = parse_pmt({pkt_of(bigpmt)}, 0x1100);
    CHECK("24-ES PMT round-trips", big && big->streams == maxes);

    // The PCR read/build cases moved to ts_pcr_test (WI-S0-4).

    // PES PTS extraction.
    const int64_t big_pts = 0x123456789LL & 0x1FFFFFFFFLL;   // exercises PTS[32]
    CHECK("PES PTS round-trip",
          read_pes_pts(pes_ts_packet(0x65, big_pts, -1, 0xE0, true, -1).b) == big_pts);
    CHECK("PES PTS+DTS round-trip",
          read_pes_pts(pes_ts_packet(0x65, 90000, 87000, 0xE0, true, -1).b) == 90000);
    CHECK("PES without PTS -> -1",
          read_pes_pts(pes_ts_packet(0x65, -1, -1, 0xE0, true, -1).b) == -1);
    CHECK("non-PUSI packet -> -1",
          read_pes_pts(pes_ts_packet(0x65, 90000, -1, 0xE0, false, -1).b) == -1);
    CHECK("PSI packet -> -1", read_pes_pts(pat) == -1);
    uint8_t pcronly[PKT];
    build_pcr_packet(0x65, 300, 0, pcronly);
    CHECK("adaptation-only packet -> -1", read_pes_pts(pcronly) == -1);
    CHECK("padding stream -> -1",
          read_pes_pts(pes_ts_packet(0x65, 90000, -1, 0xBE, true, -1).b) == -1);
    CHECK("PES behind adaptation field",
          read_pes_pts(pes_ts_packet(0x65, 4500, -1, 0xE0, true, 10).b) == 4500);

    // --- read_pes_pts forwards to parse_pes_header (WI-S0-6): the old body's answer on
    // every AF length (header cut anywhere), flag, start code, marker and stream id.
    {
        const uint8_t sids[] = {0xE0, 0xC0, 0xBD, 0xFA, 0x00, 0xB9, 0xBC, 0xBE,
                                0xBF, 0xF0, 0xF1, 0xF2, 0xF8, 0xFF};
        const uint8_t flag_set[] = {0x00, 0x40, 0x80, 0xC0};
        const uint8_t marker_set[] = {0x80, 0x84, 0x00, 0x40, 0xC0};
        const uint8_t hdl_set[] = {0, 5, 10, 255};
        uint32_t s = 0x5EED;
        auto rand33 = [&] {
            const uint64_t hi = lcg_next(s);
            return (hi << 2 ^ lcg_next(s)) & 0x1FFFFFFFFull;
        };
        long n = 0, bad = 0, found = 0, at14 = 0, cut13 = 0;
        std::vector<long> found_at(257);       // per AF length + 1
        for (int af = -1; af <= 255; af++)
            for (uint8_t sid : sids)
                for (uint8_t fl : flag_set)
                    for (uint8_t mk : marker_set)
                        for (int broken = -1; broken < 3; broken++)
                            for (int mode = 0; mode < 3; mode++) {   // ok, no PUSI, no payload flag
                                const uint64_t pts = rand33(), dts = rand33();
                                const TsPacket t = pes_variant(mode != 1, mode != 2, af, sid,
                                                               mk, fl, hdl_set[n % 4], pts, dts,
                                                               broken);
                                const int64_t want = old_read_pes_pts(t.b);
                                if (read_pes_pts(t.b) != want) bad++;
                                found += want >= 0;
                                found_at[af + 1] += want >= 0;
                                at14 += want >= 0 && af == 169;   // payload exactly 14 bytes
                                cut13 += want < 0 && af == 170 && broken < 0 && mode == 0 &&
                                         (fl & 0x80) && mk == 0x80 && sid == 0xE0;
                                n++;
                            }
        for (int i = 0; i < 300000; i++) {     // random bytes, half behind a start code
            TsPacket t;
            for (int k = 0; k < PKT; k++) t.b[k] = (uint8_t)lcg_next(s);
            t.b[0] = SYNC_BYTE;
            if (lcg_next(s) & 1) {
                const int off = payload_offset(t.b);
                const uint8_t pre[] = {0x00, 0x00, 0x01, sids[lcg_next(s) % sizeof sids]};
                for (int k = 0; k < 4 && off + k < PKT; k++) t.b[off + k] = pre[k];
                if (off + 6 < PKT && (lcg_next(s) & 1)) t.b[off + 6] = (t.b[off + 6] & 0x3F) | 0x80;
            }
            const int64_t want = old_read_pes_pts(t.b);
            if (read_pes_pts(t.b) != want) bad++;
            found += want >= 0;
            n++;
        }
        std::printf("  read_pes_pts differential: %ld packets, %ld with a PTS, %ld mismatches\n", n,
                    found, bad);
        CHECK("read_pes_pts forwarder == the old body on every generated packet", bad == 0);
        CHECK("... the set reaches PTS at a 14-byte payload and cuts at 13", at14 > 0 && cut13 > 0);
        CHECK("... and finds a PTS behind every AF length that leaves room for one",
              std::all_of(found_at.begin(), found_at.begin() + 171, [](long c) { return c > 0; }));
    }

    // ======================= WI-S0-5: generalised PSI =======================

    auto sig_parsed = parse_pmt({pkt_of(sigpmt)}, 0x0030);
    CHECK("parse_pmt: version_number read", sig_parsed && sig_parsed->version == 3);
    CHECK("parse_pmt: build_pmt writes an empty program_info",
          info && info->version == 0 && info->program_info.empty());

    // --- Descriptor loops. Opus: this file; KLVA: gst 1.28 mpegtsmux's PAT/PMT
    // (subtitle-core py/subtitle_pack_test.py); teletext: TTX_ES_INFO (engine
    // gst_tsprobe_test.py). No BSSD fixture exists: built per ISO 13818-1 2.6.8.
    const Bytes bssd = {0x05, 0x04, 'B', 'S', 'S', 'D'};
    const Bytes ttx = from_hex("560a" "656e671088" "6e6f721692");
    const Bytes mux_pat = from_hex("0000b00d0001c100000001e020a2c32941");
    const Bytes mux_pmt = from_hex("0002b0180001c10000e180f00006e180f00605044b4c5641b78fe6da");

    auto ow = walk(opus_desc);
    CHECK("descriptors: Opus = registration, then the DVB extension",
          ow.size() == 2 && ow[0].first == 0x05 && ow[0].second == Bytes({'O', 'p', 'u', 's'}) &&
              ow[1].first == 0x7f && ow[1].second == Bytes({0x80, 0x02}));
    CHECK("registration_format: 'Opus', big-endian", registration_format(opus_desc) == 0x4F707573);
    CHECK("has_descriptor: Opus carries 0x7f, not 0x56",
          has_descriptor(opus_desc, 0x7f) && !has_descriptor(opus_desc, 0x56));
    CHECK("registration_format: 'BSSD' (302M)",
          registration_format(bssd) == 0x42535344 && walk(bssd).size() == 1);
    auto tw = walk(ttx);
    CHECK("descriptors: teletext = one 0x56 with two 5-byte pages",
          tw.size() == 1 && tw[0].first == 0x56 && tw[0].second.size() == 10 &&
              Bytes(tw[0].second.begin(), tw[0].second.begin() + 3) == Bytes({'e', 'n', 'g'}));
    CHECK("teletext: has 0x56, no registration",
          has_descriptor(ttx, 0x56) && registration_format(ttx) == 0);

    uint8_t gst_pat[PKT];
    build_pat(1, {{1, 0x0020}}, 0, 0, gst_pat);
    std::deque<TsPacket> muxq{psi_packet(PID_PAT, mux_pat), psi_packet(0x0020, mux_pmt)};
    auto mux_parsed = parse_pmt(muxq, 0x0020);
    CHECK("mpegtsmux's PAT: parsed, and build_pat reproduces it",
          parse_pat(muxq) == std::vector<std::pair<int, int>>({{1, 0x0020}}) &&
              std::memcmp(gst_pat + 4, mux_pat.data(), mux_pat.size()) == 0);
    CHECK("mpegtsmux's KLV PMT: program 1, PCR 0x180, version 0, one 0x06 ES",
          mux_parsed && mux_parsed->program_number == 1 && mux_parsed->pcr_pid == 0x180 &&
              mux_parsed->version == 0 && mux_parsed->program_info.empty() &&
              mux_parsed->streams.size() == 1 &&
              mux_parsed->streams[0].stream_type == STREAM_TYPE_PRIVATE_PES);
    CHECK("registration_format: 'KLVA' from mpegtsmux's PMT",
          mux_parsed && registration_format(mux_parsed->streams[0].es_info) == 0x4B4C5641);
    const Bytes klva = mux_parsed ? mux_parsed->streams[0].es_info : Bytes{};
    CHECK("build_pmt_section == mpegtsmux's KLV PMT, CRC included",
          build_pmt_section(1, 0x180, {}, {{0x180, STREAM_TYPE_PRIVATE_PES, klva}}, 0) ==
              Bytes(mux_pmt.begin() + 1, mux_pmt.end()));

    Bytes cut = opus_desc;
    cut.pop_back();                                   // 7f 02 80: one byte short
    CHECK("descriptors: an overrunning descriptor ends the walk",
          walk(cut).size() == 1 && !has_descriptor(cut, 0x7f) &&
              registration_format(cut) == 0x4F707573);
    const Bytes short_first = {0x05, 0x02, 'O', 'p', 0x05, 0x04, 'B', 'S', 'S', 'D'};
    CHECK("registration_format: the first registration decides, < 4 bytes = 0",
          registration_format(short_first) == 0);
    Bytes mixed = {0x0a, 0x04, 'e', 'n', 'g', 0x00};
    mixed.insert(mixed.end(), bssd.begin(), bssd.end());
    mixed.insert(mixed.end(), opus_desc.begin(), opus_desc.end());
    CHECK("registration_format: the first registration, past other descriptors",
          registration_format(mixed) == 0x42535344);
    int visited = 0;
    for_each_descriptor(mixed.data(), (int)mixed.size(), [&](const Descriptor& d) {
        visited++;
        return d.tag != 0x05;
    });
    CHECK("for_each_descriptor: returning false stops the walk", visited == 2);
    CHECK("descriptors: an empty loop",
          walk({}).empty() && registration_format({}) == 0 && !has_descriptor({}, 0x05));

    // --- build_pmt_section + packetise_section ---
    const std::vector<PmtStream> two = {{0x0100, STREAM_TYPE_AVC, {}},
                                        {0x0141, STREAM_TYPE_PRIVATE_PES, opus_desc}};
    uint8_t legacy[PKT];
    build_pmt(0x0030, 1, 0x0100, two, 9, 5, legacy);
    uint8_t cc9 = 9;
    Bytes one;
    packetise_section(0x0030, build_pmt_section(1, 0x0100, {}, two, 5), cc9, one);
    CHECK("one-packet section: packetise_section == build_pmt, byte for byte",
          one.size() == (size_t)PKT && std::memcmp(one.data(), legacy, PKT) == 0 && cc9 == 10);

    // A 300-byte PMT: program_info + seven ES carrying the fixtures' loops.
    const Bytes cuei = {0x05, 0x04, 'C', 'U', 'E', 'I'};      // SCTE 35, program level
    const Bytes hevc_reg = {0x05, 0x04, 'H', 'E', 'V', 'C'};
    const Bytes eng = {0x0a, 0x04, 'e', 'n', 'g', 0x00};       // ISO 639 language
    const std::vector<PmtStream> es300 = {{0x0100, STREAM_TYPE_AVC, {}},
                                          {0x0101, STREAM_TYPE_HEVC, hevc_reg},
                                          {0x0141, STREAM_TYPE_PRIVATE_PES, opus_desc},
                                          {0x0142, STREAM_TYPE_PRIVATE_PES, bssd},
                                          {0x0143, STREAM_TYPE_AAC, eng},
                                          {0x01f0, STREAM_TYPE_PRIVATE_PES, klva},
                                          {0x0200, STREAM_TYPE_PRIVATE_PES, ttx}};
    int es_bytes = 0;
    for (const auto& s : es300) es_bytes += 5 + (int)s.es_info.size();
    Bytes pinfo = cuei;
    const Bytes pad = filler(300 - 16 - es_bytes - (int)cuei.size());
    pinfo.insert(pinfo.end(), pad.begin(), pad.end());
    const Bytes sec300 = build_pmt_section(0x0101, 0x0100, pinfo, es300, 29);  // 5-bit version
    CHECK("300-byte PMT section, CRC valid",
          sec300.size() == 300 && crc32_mpeg(sec300.data(), sec300.size()) == 0);
    uint8_t cc14 = 14;
    Bytes ts300;
    packetise_section(0x0030, sec300, cc14, ts300);
    const bool two_pk = ts300.size() == 2u * PKT && sec300.size() == 300;
    const uint8_t* h0 = ts300.data();
    const uint8_t* h1 = ts300.data() + (two_pk ? PKT : 0);
    CHECK("packetise: 300 bytes -> two packets", two_pk);
    CHECK("packetise: first packet PUSI, payload only, CC 14, pointer_field 0",
          two_pk && h0[0] == SYNC_BYTE && ts_pusi(h0) && ts_pid(h0) == 0x0030 &&
              (h0[3] & 0x30) == 0x10 && (h0[3] & 0x0F) == 14 && h0[4] == 0x00 &&
              std::memcmp(h0 + 5, sec300.data(), 183) == 0);
    CHECK("packetise: second packet without PUSI, CC 15, the next 117 bytes",
          two_pk && h1[0] == SYNC_BYTE && !ts_pusi(h1) && ts_pid(h1) == 0x0030 &&
              (h1[3] & 0x30) == 0x10 && (h1[3] & 0x0F) == 15 &&
              std::memcmp(h1 + 4, sec300.data() + 183, 117) == 0);
    CHECK("packetise: the tail stuffed with 0xFF", two_pk && stuffed(h1 + 4 + 117, h1 + PKT));
    CHECK("packetise: the caller's CC advanced past the wrap", cc14 == 0);
    Bytes re300;
    CHECK("first_section reassembles the two packets into the 300 bytes",
          first_section(deque_in(ts300), 0x0030, re300) && re300 == sec300);
    auto p300 = parse_pmt(deque_in(ts300), 0x0030);
    CHECK("parse_pmt: program, PCR PID, version and program_info intact",
          p300 && p300->program_number == 0x0101 && p300->pcr_pid == 0x0100 &&
              p300->version == 29 && p300->program_info == pinfo);
    CHECK("parse_pmt: every stream and descriptor loop intact", p300 && p300->streams == es300);
    CHECK("parsed loops: the registration per ES",
          p300 && p300->streams.size() == 7 &&
              registration_format(p300->streams[0].es_info) == 0 &&
              registration_format(p300->streams[1].es_info) == 0x48455643 &&   // 'HEVC'
              registration_format(p300->streams[2].es_info) == 0x4F707573 &&   // 'Opus'
              registration_format(p300->streams[3].es_info) == 0x42535344 &&   // 'BSSD'
              registration_format(p300->streams[4].es_info) == 0 &&
              has_descriptor(p300->streams[4].es_info, 0x0a) &&
              registration_format(p300->streams[5].es_info) == 0x4B4C5641 &&   // 'KLVA'
              registration_format(p300->streams[6].es_info) == 0 &&
              has_descriptor(p300->streams[6].es_info, 0x56));
    CHECK("parsed program_info: 'CUEI' then the filler",
          p300 && registration_format(p300->program_info) == 0x43554549 &&
              walk(p300->program_info).size() == 2);
    Bytes over = build_pmt_section(1, 0x0100, cuei, {}, 0);
    over[11] = (uint8_t)(cuei.size() + 9);            // program_info_length past the CRC
    auto over_p = parse_pmt(deque_in(packetised(over)), 0x0030);
    CHECK("parse_pmt: an overlong program_info_length stops at the CRC",
          over_p && over_p->program_info == cuei && over_p->streams.empty());
    const Bytes first_two(ts300.begin(), ts300.begin() + std::min(ts300.size(), (size_t)(2 * PKT)));
    packetise_section(0x0030, sec300, cc14, ts300);
    CHECK("packetise appends; CC runs on across calls (0, 1)",
          ts300.size() == 4u * PKT && ts_pusi(ts300.data() + 2 * PKT) &&
              (ts300[2 * PKT + 3] & 0x0F) == 0 && (ts300[3 * PKT + 3] & 0x0F) == 1 && cc14 == 2);

    const Bytes s183 = build_pmt_section(1, 0x0100, filler(183 - 16), {}, 0);
    const Bytes t183 = packetised(s183);
    CHECK("183-byte section: exactly one packet, no stuffing",
          s183.size() == 183 && t183.size() == (size_t)PKT &&
              std::memcmp(t183.data() + 5, s183.data(), 183) == 0);
    const Bytes s184 = build_pmt_section(1, 0x0100, filler(184 - 16), {}, 0);
    const Bytes t184 = packetised(s184);
    CHECK("184-byte section: its last byte opens a second packet",
          s184.size() == 184 && t184.size() == 2u * PKT && t184[PKT + 4] == s184.back() &&
              !ts_pusi(t184.data() + PKT) && stuffed(t184.data() + PKT + 5, t184.data() + 2 * PKT));
    const Bytes s1024 = build_pmt_section(1, 0x0100, filler(1024 - 16), {}, 0);
    CHECK("1024 bytes is the largest section built",
          s1024.size() == 1024 && build_pmt_section(1, 0x0100, filler(1025 - 16), {}, 0).empty());
    const Bytes t1024 = packetised(s1024, 7);
    Bytes re1024;
    CHECK("1024-byte section: six packets, CC 7..12, reassembled whole",
          t1024.size() == 6u * PKT && (t1024[3] & 0x0F) == 7 && (t1024[5 * PKT + 3] & 0x0F) == 12 &&
              first_section(deque_in(t1024), 0x0030, re1024) && re1024 == s1024);
    uint8_t cc3 = 3;
    Bytes none;
    packetise_section(0x0030, {}, cc3, none);
    CHECK("an empty section writes nothing", none.empty() && cc3 == 3);

    // --- MPTS: select_program ---
    uint8_t mpat[PKT], mpmt1[PKT], mpmt2[PKT];
    build_pat(9, {{1, 0x0100}, {2, 0x0200}}, 0, 0, mpat);
    build_pmt(0x0100, 1, 0x0101, {{0x0101, STREAM_TYPE_AVC, {}}, {0x0102, STREAM_TYPE_AAC, {}}},
              0, 0, mpmt1);
    build_pmt(0x0200, 2, 0x0201,
              {{0x0201, STREAM_TYPE_HEVC, {}}, {0x0202, STREAM_TYPE_PRIVATE_PES, opus_desc}}, 0, 0,
              mpmt2);
    PsiDiscovery dflt(128), sel2(128), sel3(128);
    sel2.select_program(2);
    sel3.select_program(3);
    for (PsiDiscovery* d : {&dflt, &sel2, &sel3}) {
        d->feed({pkt_of(mpat)});
        for (int i = 0; i < 3; i++) d->feed({pkt_of(mpmt1), pkt_of(mpmt2)});
    }
    CHECK("MPTS default: the PAT's first program, as before",
          dflt.pmt_pid() == 0x0100 && dflt.pmt() && dflt.pmt()->program_number == 1);
    CHECK("MPTS select_program(2): the second program's PMT PID", sel2.pmt_pid() == 0x0200);
    CHECK("MPTS select_program(2): its PMT, discovered once",
          sel2.pmt() && sel2.pmt()->program_number == 2 && sel2.pmt()->pcr_pid == 0x0201 &&
              sel2.pmt()->streams.size() == 2 &&
              registration_format(sel2.pmt()->streams[1].es_info) == 0x4F707573 &&
              sel2.generation() == 1);
    CHECK("MPTS select_program(3): a program the PAT lacks finds nothing",
          sel3.pmt_pid() == -1 && !sel3.pmt() && sel3.generation() == 0);
    dflt.select_program(-5);
    CHECK("select_program(<0) on a default discovery keeps its state",
          dflt.pmt_pid() == 0x0100 && dflt.pmt() && dflt.generation() == 1);
    sel2.select_program(1);
    CHECK("select_program switch: the old program's PMT is dropped",
          !sel2.pmt() && sel2.pmt_pid() == -1);
    sel2.feed({});
    CHECK("select_program switch: the retained PAT gives the new PMT PID", sel2.pmt_pid() == 0x0100);
    CHECK("select_program switch: program 1 discovered, generation 2",
          sel2.feed({pkt_of(mpmt1)}) && sel2.pmt()->program_number == 1 && sel2.generation() == 2);

    // --- generation(): every PMT change; feed()'s return keeps today's meaning ---
    PsiDiscovery g(128);
    uint8_t gpat[PKT];
    build_pat(4, {{1, 0x0030}}, 0, 0, gpat);
    const std::vector<PmtStream> g264 = {{0x0065, STREAM_TYPE_AVC, {}}};
    const std::vector<PmtStream> g265 = {{0x0065, STREAM_TYPE_HEVC, {}}};
    auto gpmt = [&](const Bytes& pi, const std::vector<PmtStream>& s, int version) {
        return packets_in(packetised(build_pmt_section(1, 0x0065, pi, s, version)));
    };
    g.feed({pkt_of(gpat)});
    CHECK("generation: 0 before any PMT", g.generation() == 0);
    CHECK("generation: the first PMT is 1",
          g.feed(gpmt({}, g264, 0)) && g.generation() == 1 && g.pmt()->version == 0);
    int fires = 0;
    for (int i = 0; i < 600; i++) fires += g.feed(gpmt({}, g264, 0)) ? 1 : 0;
    CHECK("generation: carousel repeats and the 500-feed re-parse leave it",
          fires == 0 && g.generation() == 1);
    CHECK("PMT version bump with a codec change: feed() true, generation 2",
          g.feed(gpmt({}, g265, 1)) && g.generation() == 2 && g.pmt()->version == 1 &&
              g.pmt()->streams[0].stream_type == STREAM_TYPE_HEVC);
    CHECK("version-only bump: generation 3, feed() false as before",
          !g.feed(gpmt({}, g265, 2)) && g.generation() == 3 && g.pmt()->version == 2);
    CHECK("program_info-only change: generation 4, feed() false",
          !g.feed(gpmt(cuei, g265, 2)) && g.generation() == 4 && g.pmt()->program_info == cuei);

    // A two-packet PMT split across feeds stays pending until its tail arrives.
    uint8_t spat[PKT];
    build_pat(4, {{0x0101, 0x0030}}, 0, 0, spat);
    PsiDiscovery sp(128);
    sp.feed({pkt_of(spat)});
    const auto halves = packets_in(first_two);
    CHECK("two-packet PMT: nothing from its head alone",
          halves.size() == 2 && !sp.feed({halves[0]}) && !sp.pmt());
    CHECK("two-packet PMT: discovered whole with its tail",
          halves.size() == 2 && sp.feed({halves[1]}) && sp.pmt() && p300 && *sp.pmt() == *p300 &&
              sp.generation() == 1);

    // --- unsupported_sections(): section_number != 0 counted, not handed on ---
    uint8_t upat0[PKT], upat1[PKT], upmt[PKT], opmt[PKT];
    build_pat(5, {{1, 0x0030}}, 0, 0, upat0);
    build_pat(5, {{1, 0x0099}}, 1, 0, upat1);        // would move the PMT PID if parsed
    build_pmt(0x0030, 1, 0x0065, g264, 0, 0, upmt);
    build_pmt(0x0030, 2, 0x0065, g264, 0, 0, opmt);  // another program, same PID
    TsPacket u0 = pkt_of(upat0), u1 = pkt_of(upat1), m1 = pkt_of(upmt), o1 = pkt_of(opmt);
    u0.b[section_offset(u0.b) + 7] = 1;              // last_section_number
    u1.b[section_offset(u1.b) + 6] = 1;              // section_number
    u1.b[section_offset(u1.b) + 7] = 1;
    m1.b[section_offset(m1.b) + 6] = 1;
    o1.b[section_offset(o1.b) + 6] = 1;
    TsPacket n1 = u1;
    n1.b[section_offset(n1.b) + 5] &= 0xFE;          // a next-table section 1
    for (TsPacket* t : {&u0, &u1, &m1, &o1, &n1}) fix_crc(*t);
    PsiDiscovery us(128);
    us.feed({u0});
    us.feed({pkt_of(upmt)});
    CHECK("unsupported: section 0 counts nothing",
          us.unsupported_sections() == 0 && us.pmt_pid() == 0x0030 && us.pmt());
    for (int i = 0; i < 3; i++) us.feed({u0, u1});
    CHECK("unsupported: every PAT section 1 start counted, the PMT PID unmoved",
          us.unsupported_sections() == 3 && us.pmt_pid() == 0x0030);
    us.feed({m1});
    CHECK("unsupported: our PMT's section 1 counted", us.unsupported_sections() == 4);
    us.feed({o1, n1});
    CHECK("unsupported: another program's or a next-table section 1 is not",
          us.unsupported_sections() == 4);

    // --- Two programs on one PMT PID. The buffer holds both tables; once
    // eviction leaves the other one oldest, the 500-feed re-parse must not latch it.
    {
        uint8_t spat[PKT], sp1[PKT], sp2[PKT], spts_pat[PKT], spts_pmt[PKT];
        build_pat(6, {{1, 0x0030}, {2, 0x0030}}, 0, 0, spat);
        build_pmt(0x0030, 1, 0x0101, {{0x0101, STREAM_TYPE_AVC, {}}}, 0, 0, sp1);
        build_pmt(0x0030, 2, 0x0201, {{0x0201, STREAM_TYPE_HEVC, {}}}, 0, 0, sp2);
        // One PMT packet per feed, `even` on even feeds and `odd` on odd ones.
        struct Run {
            int changes = 0, wrong_at = -1;
        };
        auto run = [&](PsiDiscovery& d, const uint8_t* pat, const uint8_t* even,
                       const uint8_t* odd, int want) {
            Run r;
            d.feed({pkt_of(pat)});
            for (int f = 2; f <= 1200; f++) {
                r.changes += d.feed({pkt_of(f % 2 ? odd : even)}) ? 1 : 0;
                if (r.wrong_at < 0 && d.pmt() && d.pmt()->program_number != want) r.wrong_at = f;
            }
            return r;
        };
        PsiDiscovery shared(128);
        const Run a = run(shared, spat, sp1, sp2, 1);
        if (a.wrong_at >= 0)
            std::printf("  shared PMT PID: the other program's PMT latched at feed %d\n", a.wrong_at);
        CHECK("shared PMT PID: the followed program is kept through the re-parses",
              a.wrong_at < 0 && a.changes == 1 && shared.pmt() &&
                  shared.pmt()->program_number == 1 && shared.generation() == 1);
        PsiDiscovery other_first(128);
        const Run b = run(other_first, spat, sp2, sp1, 1);
        CHECK("shared PMT PID: ... and never latches the other program's PMT arriving first",
              b.wrong_at < 0 && b.changes == 1 && other_first.pmt() &&
                  other_first.pmt()->program_number == 1);
        PsiDiscovery second(128);
        second.select_program(2);
        const Run c = run(second, spat, sp1, sp2, 2);
        CHECK("shared PMT PID: a selected second program on the shared PID keeps its own PMT",
              c.wrong_at < 0 && c.changes == 1 && second.pmt() &&
                  second.pmt()->program_number == 2);
        // Production and the python reference take a PMT on a PID no other program
        // uses whatever program_number it carries (a muxer that writes another one).
        build_pat(7, {{1, 0x0030}}, 0, 0, spts_pat);
        build_pmt(0x0030, 2, 0x0201, {{0x0201, STREAM_TYPE_HEVC, {}}}, 0, 0, spts_pmt);
        PsiDiscovery own(128);
        const Run d = run(own, spts_pat, spts_pmt, spts_pmt, 2);
        CHECK("one program's PMT PID: its PMT counts whatever program_number it says",
              d.wrong_at < 0 && d.changes == 1 && own.pmt() && own.pmt()->program_number == 2 &&
                  own.pmt()->streams.size() == 1 && own.pmt()->streams[0].pid == 0x0201);
    }

    // --- Only section 0 is the table. A buffered section 1 is skipped, not
    // parsed as the PAT (it would move the PMT PID to another program).
    {
        uint8_t s0p[PKT], s1p[PKT], pmt_a[PKT], pmt_b[PKT];
        build_pat(7, {{1, 0x0030}}, 0, 0, s0p);
        build_pat(7, {{2, 0x0040}, {3, 0x0050}}, 1, 0, s1p);   // longer: its length must not leak
        build_pmt(0x0030, 1, 0x0101, {{0x0101, STREAM_TYPE_AVC, {}}}, 0, 0, pmt_a);
        build_pmt(0x0040, 2, 0x0201, {{0x0201, STREAM_TYPE_HEVC, {}}}, 0, 0, pmt_b);
        TsPacket s0 = pkt_of(s0p), s1 = pkt_of(s1p);
        s0.b[section_offset(s0.b) + 7] = 1;          // last_section_number
        s1.b[section_offset(s1.b) + 6] = 1;          // section_number
        s1.b[section_offset(s1.b) + 7] = 1;
        fix_crc(s0);
        fix_crc(s1);
        Bytes sec;
        const uint8_t* s0sec = s0.b + section_offset(s0.b);
        const Bytes s0_bytes(s0sec, s0sec + 3 + (((s0sec[1] & 0x0F) << 8) | s0sec[2]));
        CHECK("section 0: first_section skips a section 1 to the section 0 behind it",
              first_section({s1, s0}, PID_PAT, sec) && sec == s0_bytes &&
                  parse_pat({s1, s0}) == std::vector<std::pair<int, int>>({{1, 0x0030}}));
        CHECK("section 0: a section 1 alone is no table", !first_section({s1}, PID_PAT, sec) &&
                                                       parse_pat({s1}).empty());
        PsiDiscovery joiner(128);
        joiner.feed({s1});
        joiner.feed({pkt_of(pmt_b)});
        CHECK("section 0: discovery joining at a PAT section 1 learns nothing from it",
              joiner.pmt_pid() == -1 && !joiner.pmt());
        joiner.feed({s0});
        CHECK("section 0: then the first program's PMT PID", joiner.pmt_pid() == 0x0030);
        CHECK("section 0: ... and its PMT",
              joiner.feed({pkt_of(pmt_a)}) && joiner.pmt()->program_number == 1);
    }

    return test_summary("ts_psi");
}
