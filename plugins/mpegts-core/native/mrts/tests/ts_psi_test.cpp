// Port of ts_psi_test.py — logic tests for the PSI parse/build core.
#include <cstring>
#include <deque>

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

    // PCR read/build round-trip.
    const int64_t pcr = 1234567890123LL;
    uint8_t pk[PKT];
    build_pcr_packet(0x00cc, pcr, 7, pk);
    CHECK("PCR packet is adaptation-only (no payload)", (pk[3] & 0x30) == 0x20);
    CHECK("PCR packet keeps the PID's cc", (pk[3] & 0x0F) == 7);
    CHECK("read_pcr round-trips build_pcr_packet", read_pcr(pk) == pcr);
    CHECK("read_pcr is -1 on a payload-only packet", read_pcr(nullp) == -1);

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

    return test_summary("ts_psi");
}
