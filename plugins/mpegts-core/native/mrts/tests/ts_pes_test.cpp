// ts_pes: PES header parse and rewrite, the two-packet header span, and
// reassembly (WI-S0-3). Fixtures are built by the helpers below.
#include <algorithm>
#include <cstring>
#include <initializer_list>
#include <iterator>
#include <vector>

#include "../ts_packet.h"
#include "../ts_pes.h"
#include "../ts_psi.h"    // read_pes_pts: the reader parse_pes_header replaces
#include "check.h"

using namespace mrts;

namespace {

using Bytes = std::vector<uint8_t>;
using Units = std::vector<PesUnit>;

constexpr int64_t W33 = 1LL << 33;

// ts_timeline.cpp's private DTS reader and field writer, verbatim: the module
// is pinned to them (and to read_pes_pts) until WI-S0-6 folds them in.
int64_t today_read_pes_dts(const uint8_t* pkt) {
    int off = payload_offset(pkt);
    if (off + 19 > PKT) return -1;
    const uint8_t* p = pkt + off;
    if (!(p[7] & 0x40)) return -1;
    return ((int64_t)((p[14] >> 1) & 0x07) << 30) | ((int64_t)p[15] << 22) |
           ((int64_t)(p[16] >> 1) << 15) | ((int64_t)p[17] << 7) | (p[18] >> 1);
}
void today_write_ts_field(uint8_t* f, int64_t v) {
    f[0] = (uint8_t)((f[0] & 0xF0) | (((v >> 30) & 0x07) << 1) | 0x01);
    f[1] = (uint8_t)((v >> 22) & 0xFF);
    f[2] = (uint8_t)((((v >> 15) & 0x7F) << 1) | 0x01);
    f[3] = (uint8_t)((v >> 7) & 0xFF);
    f[4] = (uint8_t)(((v & 0x7F) << 1) | 0x01);
}

const uint8_t kBareIds[] = {0xBC, 0xBE, 0xBF, 0xF0, 0xF1, 0xF2, 0xF8, 0xFF};
bool bare(uint8_t sid) {
    return std::find(std::begin(kBareIds), std::end(kBareIds), sid) != std::end(kBareIds);
}

// A timestamp field as a mux writes it: 4-bit prefix, marker bits '1'.
void put_field(uint8_t* f, uint8_t prefix, int64_t v) {
    f[0] = (uint8_t)((prefix << 4) | (((v >> 30) & 0x07) << 1) | 1);
    f[1] = (uint8_t)((v >> 22) & 0xFF);
    f[2] = (uint8_t)((((v >> 15) & 0x7F) << 1) | 1);
    f[3] = (uint8_t)((v >> 7) & 0xFF);
    f[4] = (uint8_t)(((v & 0x7F) << 1) | 1);
}

Bytes pattern(size_t n, int seed) {
    Bytes b(n);
    for (size_t i = 0; i < n; i++) b[i] = (uint8_t)(i * 7 + seed * 13 + (i >> 8));
    return b;
}

// One PES: the optional header (none for the bare ids) with PTS, DTS when >= 0
// and `stuffing` extra bytes, then `payload`. Unbounded = PES_packet_length 0.
Bytes pes(uint8_t sid, int64_t pts, int64_t dts, const Bytes& payload, bool bounded = true,
          int stuffing = 0) {
    Bytes b = {0x00, 0x00, 0x01, sid, 0x00, 0x00};
    if (!bare(sid)) {
        const int fields = pts < 0 ? 0 : dts < 0 ? 5 : 10;
        b.push_back(0x84);                // '10', data_alignment_indicator
        b.push_back(pts < 0 ? 0x00 : dts < 0 ? 0x80 : 0xC0);
        b.push_back((uint8_t)(fields + stuffing));
        uint8_t f[5];
        if (pts >= 0) {
            put_field(f, dts < 0 ? 0x2 : 0x3, pts);
            b.insert(b.end(), f, f + 5);
        }
        if (pts >= 0 && dts >= 0) {
            put_field(f, 0x1, dts);
            b.insert(b.end(), f, f + 5);
        }
        b.insert(b.end(), (size_t)stuffing, 0xFF);
    }
    b.insert(b.end(), payload.begin(), payload.end());
    if (bounded) {
        const size_t len = b.size() - 6;
        b[4] = (uint8_t)(len >> 8);
        b[5] = (uint8_t)len;
    }
    return b;
}

// TS packets for `data` on `pid`, CC from `cc` on: `first` payload bytes in
// the PUSI packet (an AF takes the rest), then full packets, the last stuffed
// by its AF so the PES ends with it, as a mux does.
std::vector<Bytes> packetize(int pid, const Bytes& data, int& cc, size_t first = 184) {
    std::vector<Bytes> out;
    size_t at = 0;
    do {
        const size_t take = std::min(out.empty() ? first : (size_t)184, data.size() - at);
        Bytes p(PKT, 0xFF);
        p[0] = SYNC_BYTE;
        p[1] = (uint8_t)((out.empty() ? 0x40 : 0) | ((pid >> 8) & 0x1F));
        p[2] = (uint8_t)pid;
        p[3] = (uint8_t)(0x10 | (cc & 0x0F));
        if (take < 184) {
            p[3] |= 0x20;
            p[4] = (uint8_t)(183 - take);
            if (take < 183) p[5] = 0x00;  // AF flags, 0xFF stuffing after
        }
        std::memcpy(p.data() + PKT - take, data.data() + at, take);
        at += take;
        cc = (cc + 1) & 0x0F;
        out.push_back(p);
    } while (at < data.size());
    return out;
}

// A payload-less packet (a PCR-only one, say); `flags` = its AF flags byte.
Bytes af_only(int pid, int cc, uint8_t flags) {
    Bytes p(PKT, 0xFF);
    p[0] = SYNC_BYTE;
    p[1] = (uint8_t)((pid >> 8) & 0x1F);
    p[2] = (uint8_t)pid;
    p[3] = (uint8_t)(0x20 | (cc & 0x0F));
    p[4] = 183;
    p[5] = flags;
    return p;
}

// One packet: an AF of `af` bytes (-1 = none), then `data` cut at the packet end.
Bytes one_packet(int pid, int af, const Bytes& data, bool pusi = true) {
    Bytes p(PKT, 0xA5);
    p[0] = SYNC_BYTE;
    p[1] = (uint8_t)((pusi ? 0x40 : 0) | ((pid >> 8) & 0x1F));
    p[2] = (uint8_t)pid;
    p[3] = 0x10;
    int i = 4;
    if (af >= 0) {
        p[3] |= 0x20;
        p[i++] = (uint8_t)af;
        for (int k = 0; k < af; k++) p[i + k] = k == 0 ? 0x00 : 0xFF;
        i += af;
    }
    for (size_t k = 0; k < data.size() && i < PKT; k++) p[i++] = data[k];
    return p;
}

PacketView view(Bytes& b) {
    PacketView v;
    parse_packet(b.data(), &v);
    return v;
}

Bytes concat(const std::vector<Bytes>& parts) {
    Bytes out;
    for (const auto& p : parts) out.insert(out.end(), p.begin(), p.end());
    return out;
}

// The packet's PES header as a reader sees it: false without one starting here.
bool parse_pkt(Bytes& b, PesHeader* h) {
    PacketView v = view(b);
    return v.pusi && v.payload_off < PKT &&
           parse_pes_header(b.data() + v.payload_off, PKT - v.payload_off, h);
}

bool same_hdr(const PesHeader& a, const PesHeader& b) {
    return a.sid == b.sid && a.pts == b.pts && a.dts == b.dts && a.header_len == b.header_len &&
           a.payload_len == b.payload_len && a.data_alignment == b.data_alignment &&
           a.pts_off == b.pts_off && a.dts_off == b.dts_off && a.complete == b.complete;
}

bool same(const Units& a, const Units& b, bool payload = true) {
    if (a.size() != b.size()) return false;
    for (size_t i = 0; i < a.size(); i++)
        if (a[i].pid != b[i].pid || a[i].seq != b[i].seq || a[i].discont != b[i].discont ||
            !same_hdr(a[i].hdr, b[i].hdr) || (payload && a[i].payload != b[i].payload))
            return false;
    return true;
}

bool unit_is(const PesUnit& u, int pid, uint64_t seq, bool discont, int64_t pts,
             const Bytes& payload) {
    return u.pid == pid && u.seq == seq && u.discont == discont && u.hdr.pts == pts &&
           u.hdr.complete && u.payload == payload;
}

// Packets through PacketWalker -> CcTracker -> `a`, the stream cut at `cuts`;
// flush() at the end unless `flush` is false.
Units assemble(PesAssembler& a, Bytes stream, const std::vector<size_t>& cuts = {},
               bool flush = true) {
    PacketWalker w;
    CcTracker cc;
    Units out;
    size_t start = 0;
    std::vector<size_t> ends(cuts);
    ends.push_back(stream.size());
    for (size_t end : ends) {
        w.feed(stream.data() + start, end - start,
               [&](PacketView& v) { a.feed(v, cc.feed(v), out); });
        start = end;
    }
    if (flush) a.flush(out);
    return out;
}

PesAssembler selecting(std::initializer_list<int> pids, PesAssembler::Config cfg = {}) {
    PesAssembler a(cfg);
    for (int pid : pids) a.select(pid, true);
    return a;
}

// The loop PesHeaderSpan is made for: every packet goes to complete(), then
// hold(); a header whole in its packet is rewritten in place. Every PTS/DTS
// moves by `shift`.
struct Rewriter {
    int64_t shift = 0;
    PesHeaderSpan span;
    std::vector<Bytes> out;
    int joined = 0;                       // ts callback calls

    void feed(Bytes b) {
        PacketView v = view(b);
        auto ts = [&](const PesHeader& h, int64_t& pts, int64_t& dts) {
            joined++;
            pts = h.pts + shift;
            dts = h.dts + shift;
        };
        uint8_t first[PKT];
        if (span.complete(v, first, ts)) out.emplace_back(first, first + PKT);
        if (span.hold(v)) return;
        PesHeader h;
        if (v.pusi && v.payload_off < PKT &&
            parse_pes_header(v.p + v.payload_off, PKT - v.payload_off, &h) && h.complete)
            rewrite_pes_timestamps(v, h, h.pts + shift, h.dts + shift);
        out.push_back(b);
    }
    void feed(const std::vector<Bytes>& pkts) {
        for (const Bytes& b : pkts) feed(b);
    }
};

}  // namespace

int main() {
    const int64_t P = 0x1ABCDEF01, D = 0x0FEDCBA98;     // every byte of both fields differs

    // --- parse_pes_header --------------------------------------------------------
    {
        PesHeader h;
        const Bytes a = pes(0xE0, P, -1, pattern(100, 1));
        CHECK("PTS only: pts, no dts, header 14, bounded payload 100, offsets",
              parse_pes_header(a.data(), a.size(), &h) && h.sid == 0xE0 && h.pts == P &&
                  h.dts == -1 && h.header_len == 14 && h.payload_len == 100 && h.data_alignment &&
                  h.pts_off == 9 && h.dts_off == -1 && h.complete);
        const Bytes b = pes(0xE0, P, D, pattern(50, 2));
        CHECK("PTS+DTS: both, header 19, offsets 9 and 14",
              parse_pes_header(b.data(), b.size(), &h) && h.pts == P && h.dts == D &&
                  h.header_len == 19 && h.payload_len == 50 && h.pts_off == 9 && h.dts_off == 14 &&
                  h.complete);
        const Bytes c = pes(0xBD, -1, -1, pattern(20, 3));
        CHECK("no PTS: header 9, nothing read",
              parse_pes_header(c.data(), c.size(), &h) && h.sid == 0xBD && h.pts == -1 &&
                  h.dts == -1 && h.pts_off == -1 && h.dts_off == -1 && h.header_len == 9 &&
                  h.payload_len == 20 && h.complete);
        const Bytes d = pes(0xE0, P, D, pattern(30, 4), false, 7);
        CHECK("unbounded with 7 stuffing bytes: header 26, payload_len -1",
              parse_pes_header(d.data(), d.size(), &h) && h.header_len == 26 &&
                  h.payload_len == -1 && h.pts == P && h.dts == D && h.complete);
        Bytes e = pes(0xC0, P, -1, {});
        CHECK("a header-only PES: payload_len 0",
              parse_pes_header(e.data(), e.size(), &h) && h.payload_len == 0 && h.complete);
        e[6] = 0x80;
        CHECK("data_alignment_indicator read from its bit",
              parse_pes_header(e.data(), e.size(), &h) && !h.data_alignment);
    }
    {
        // The bytes after PES_packet_length look like an optional header with
        // PTS and DTS: for these ids they are data.
        const Bytes fake = {0x80, 0xC0, 0x0A, 0x31, 0x00, 0x01, 0x00,
                            0x01, 0x11, 0x00, 0x01, 0x00, 0x01};
        bool all = true;
        for (uint8_t sid : kBareIds) {
            PesHeader h;
            const Bytes b = pes(sid, -1, -1, fake);
            all &= parse_pes_header(b.data(), b.size(), &h) && h.sid == sid && h.pts == -1 &&
                   h.dts == -1 && h.header_len == 6 && h.payload_len == 13 && h.complete &&
                   !h.data_alignment;
            all &= parse_pes_header(b.data(), 5, &h) && !h.complete && h.header_len == 6;
        }
        CHECK("no-header ids (BC BE BF F0 F1 F2 F8 FF): header_len 6, no PTS/DTS", all);
    }
    {
        PesHeader h;
        const Bytes full = pes(0xE0, P, D, pattern(10, 5));
        bool partial = true;
        for (size_t n = 0; n < 19; n++)
            partial &= parse_pes_header(full.data(), n, &h) && !h.complete &&
                       h.header_len == (n >= 9 ? 19 : 0) && h.sid == (n >= 4 ? 0xE0 : 0) &&
                       h.pts == (n >= 14 ? P : -1) && h.pts_off == (n >= 14 ? 9 : -1) &&
                       h.dts == -1 && h.payload_len == (n >= 9 ? 10 : -1);
        CHECK("cut short: true, !complete, the fields the bytes cover", partial);
        CHECK("... complete at header_len",
              parse_pes_header(full.data(), 19, &h) && h.complete && h.dts == D);

        Bytes bad = full;
        bad[2] = 0x02;
        CHECK("no start code: false", !parse_pes_header(bad.data(), bad.size(), &h));
        CHECK("... checked on the bytes present",
              !parse_pes_header(bad.data(), 3, &h) && parse_pes_header(bad.data(), 2, &h));
        bool markers = true;
        for (uint8_t m : {0x00, 0x40, 0xC0}) {
            Bytes x = full;
            x[6] = (uint8_t)(m | (x[6] & 0x3F));
            markers &= !parse_pes_header(x.data(), x.size(), &h) &&
                       parse_pes_header(x.data(), 6, &h);
        }
        CHECK("'10' marker missing: false, once byte 6 is present", markers);
    }
    {
        // Lenient, as the readers it replaces.
        PesHeader h;
        Bytes forbidden = pes(0xE0, P, -1, pattern(8, 6));
        forbidden[7] = 0x40;
        CHECK("PTS_DTS_flags '01' (forbidden): no PTS, as read_pes_pts",
              parse_pes_header(forbidden.data(), forbidden.size(), &h) && h.pts == -1 &&
                  h.dts == -1 && h.header_len == 14 && h.complete);
        Bytes thin = pes(0xE0, P, -1, pattern(8, 7));
        thin[8] = 0;
        CHECK("PES_header_data_length 0 with a PTS flagged: PTS read, complete only with it",
              parse_pes_header(thin.data(), thin.size(), &h) && h.pts == P &&
                  h.header_len == 9 && h.complete && parse_pes_header(thin.data(), 13, &h) &&
                  !h.complete);
        Bytes shortlen = pes(0xE0, P, -1, pattern(8, 8));
        shortlen[4] = 0;
        shortlen[5] = 4;
        CHECK("PES_packet_length shorter than the header: unbounded, as mrpeshouse",
              parse_pes_header(shortlen.data(), shortlen.size(), &h) && h.payload_len == -1 &&
                  h.pts == P);
    }

    // --- agreement with today's readers ------------------------------------------
    {
        // Every AF length, header shape, stream id and corruption: parse_pes_header's
        // PTS is read_pes_pts's, its DTS today's read_pes_dts, on the same bytes.
        bool agree = true;
        int with_pts = 0, compared = 0;
        for (int af = -1; af <= 183; af++)
            for (int shape = 0; shape < 5; shape++)
                for (uint8_t sid : {0xE0, 0xC0, 0xBD, 0xBC, 0xBE, 0xBF, 0xF0, 0xF8, 0xFF, 0x00})
                    for (int fault = 0; fault < 4; fault++) {
                        Bytes body = pes(sid, shape >= 1 ? P : -1, shape == 2 ? D : -1,
                                         pattern(200, af + 2));
                        if (shape == 3 && body.size() > 8) body[7] = 0x40;   // '01'
                        if (shape == 4 && body.size() > 8) body[8] = 0;      // too short
                        if (fault == 1) body[1] = 0x01;
                        if (fault == 2) body[6] = 0x40;
                        Bytes pkt = one_packet(0x100, af, body, fault != 3);
                        const int64_t want = read_pes_pts(pkt.data());
                        PesHeader h;
                        const bool ok = parse_pkt(pkt, &h);
                        agree &= (ok ? h.pts : -1) == want;
                        if (want >= 0) {
                            agree &= h.dts == today_read_pes_dts(pkt.data());
                            with_pts++;
                        }
                        compared++;
                    }
        CHECK("pts == read_pes_pts and dts == today's read_pes_dts on 37000 packets",
              agree && compared == 185 * 5 * 10 * 4 && with_pts > 2000);
    }
    {
        // Byte parity with today's writer, prefix nibble and its low bits included.
        const std::initializer_list<int64_t> values = {
            0, 1, 0x7F, 0x80, 0x7FFF, 0x8000, 0x3FFFFFFF, 0x40000000, 0xFFFFFFFF,
            0x100000000, W33 - 1, P, D};
        bool parity = true;
        for (int b0 = 0; b0 < 256; b0++)
            for (int64_t v : values) {
                uint8_t a[5] = {(uint8_t)b0, 0x5A, 0xA5, 0x5A, 0xA5}, b[5];
                std::memcpy(b, a, 5);
                write_pes_ts_field(a, v);
                today_write_ts_field(b, v);
                parity &= std::memcmp(a, b, 5) == 0;
            }
        CHECK("write_pes_ts_field writes today's write_ts_field bytes", parity);
        uint8_t f[5] = {0x31, 0, 0, 0, 0};
        write_pes_ts_field(f, -1);
        uint8_t g[5] = {0x31, 0, 0, 0, 0};
        write_pes_ts_field(g, W33 + 5);
        PesHeader h;
        Bytes e = pes(0xE0, 5, -1, {});
        std::memcpy(e.data() + 9, g, 5);
        CHECK("... the low 33 bits: -1 -> 2^33 - 1, 2^33 + 5 -> 5",
              f[0] == 0x3F && f[1] == 0xFF && f[2] == 0xFF && f[3] == 0xFF && f[4] == 0xFF &&
                  parse_pes_header(e.data(), e.size(), &h) && h.pts == 5);
    }

    // --- rewrite_pes_timestamps ----------------------------------------------------
    {
        // parse -> rewrite -> parse: the new values, every bit outside the two
        // 33-bit values unchanged (prefixes, markers, the rest of the packet).
        static const uint8_t kValueBits[5] = {0x0E, 0xFF, 0xFE, 0xFF, 0xFE};
        const std::initializer_list<int64_t> values = {
            0, 1, W33 - 1, 0x100000000, 0x0AAAAAAAA, 0x155555555};
        bool round = true;
        int cases = 0;
        for (int shape = 0; shape < 3; shape++)
            for (int af : {-1, 0, 7, 100, 160})
                for (int64_t nv : values) {
                    const int64_t pts = shape >= 1 ? P : -1, dts = shape == 2 ? D : -1;
                    const Bytes data = pes(0xE0, pts, dts, pattern(300, af + 9), true,
                                           shape == 0 ? 0 : 3);
                    Bytes pkt = one_packet(0x100, af, data);
                    PesHeader h1, h2;
                    if (!parse_pkt(pkt, &h1) || !h1.complete) {
                        round = false;
                        continue;
                    }
                    Bytes after = pkt;
                    PacketView v = view(after);
                    const int64_t ndts = (nv + 12345) % W33;
                    round &= rewrite_pes_timestamps(v, h1, nv, ndts) && parse_pkt(after, &h2);
                    round &= h2.pts == (pts >= 0 ? nv : -1) && h2.dts == (dts >= 0 ? ndts : -1);
                    PesHeader same = h2;
                    same.pts = h1.pts;
                    same.dts = h1.dts;
                    round &= same_hdr(same, h1);
                    for (int i = 0; i < PKT; i++) {
                        uint8_t allowed = 0;
                        for (int off : {h1.pts_off, h1.dts_off}) {
                            const int at = i - v.payload_off - off;
                            if (off >= 0 && at >= 0 && at < 5) allowed = kValueBits[at];
                        }
                        round &= ((pkt[i] ^ after[i]) & ~allowed) == 0;
                    }
                    cases++;
                }
        CHECK("rewrite round-trip: new values, every other bit unchanged (90 cases)",
              round && cases == 90);

        int cc = 0;
        Bytes split = packetize(0x100, pes(0xE0, P, D, pattern(300, 1)), cc, 10)[0];
        const Bytes before = split;
        PesHeader h;
        PacketView v = view(split);
        CHECK("a header not complete in the packet: false, nothing written",
              parse_pkt(split, &h) && !h.complete && !rewrite_pes_timestamps(v, h, 1, 2) &&
                  split == before);
        Bytes whole = pes(0xE0, P, D, pattern(10, 2));
        parse_pes_header(whole.data(), whole.size(), &h);
        Bytes late = one_packet(0x100, 175, whole);   // payload_off 180: 8 bytes of room
        const Bytes late_before = late;
        PacketView lv = view(late);
        CHECK("a header from other bytes that would write past the packet: false",
              h.complete && !rewrite_pes_timestamps(lv, h, 1, 2) && late == late_before);
    }

    // --- PesHeaderSpan -------------------------------------------------------------
    {
        // The header split after k payload bytes (an AF fills the rest of the
        // PUSI packet); another PID and a payload-less packet of the same PID
        // come between. Output = the same PES written with the new values.
        const int64_t shift = W33 - 1000;  // wraps: P + shift = P - 1000 mod 2^33
        auto moved = [&](int64_t t) { return t < 0 ? -1 : (t + shift) % W33; };
        struct Shape {
            int64_t pts, dts;
            int stuffing;
            size_t kmax;                    // header_len - 1: the last k that spills
        };
        bool all = true, order = true;
        int spans = 0;
        for (Shape s : {Shape{P, D, 0, 18}, Shape{P, -1, 0, 13}, Shape{P, D, 12, 30}})
            for (size_t k = 1; k <= s.kmax + 2; k++) {
                const Bytes body = pattern(400, (int)k), sound = pattern(90, 1);
                int cv = 7, ca = 3, wv = 7, wa = 3;
                const auto vid = packetize(0x100, pes(0xE0, s.pts, s.dts, body, false, s.stuffing),
                                           cv, k);
                const auto aud = packetize(0x101, pes(0xC0, P + 10, -1, sound), ca);
                const auto vid_want = packetize(
                    0x100, pes(0xE0, moved(s.pts), moved(s.dts), body, false, s.stuffing), wv, k);
                const auto aud_want = packetize(0x101, pes(0xC0, moved(P + 10), -1, sound), wa);
                const Bytes pcr = af_only(0x100, vid[0][3] & 0x0F, 0x10);
                Rewriter r;
                r.shift = shift;
                r.feed({vid[0], aud[0], pcr, vid[1], vid[2], vid[3]});
                const bool spanned = k <= s.kmax;
                const std::vector<Bytes> want =
                    spanned ? std::vector<Bytes>{aud_want[0], pcr, vid_want[0], vid_want[1],
                                                 vid_want[2], vid_want[3]}
                            : std::vector<Bytes>{vid_want[0], aud_want[0], pcr, vid_want[1],
                                                 vid_want[2], vid_want[3]};
                all &= r.out == want && r.span.broken() == 0 && !r.span.held(0x100) &&
                       r.span.spans() == (spanned ? 1u : 0u) && r.joined == (spanned ? 1 : 0);
                order &= !spanned || (r.out[0] == aud_want[0] && r.out[1] == pcr);
                spans += (int)r.span.spans();
            }
        CHECK("a header split after 1..18 bytes is rewritten across both packets", all);
        CHECK("... other PIDs and payload-less packets of the PID are not delayed", order);
        CHECK("... (PTS+DTS 1..18, PTS 1..13, a 31-byte header 1..30 held; none past it)",
              spans == 18 + 13 + 30);
    }
    {
        int cc = 4, cc2 = 4;
        const auto vid = packetize(0x100, pes(0xE0, P, D, pattern(400, 2), false), cc, 10);
        const auto next =
            packetize(0x100, pes(0xE0, P + 3600, D + 3600, pattern(50, 3), false), cc2);
        Bytes next_pusi = next[0];
        next_pusi[3] = (uint8_t)((next_pusi[3] & 0xF0) | ((vid[0][3] + 1) & 0x0F));

        Rewriter gap;
        gap.feed({vid[0], vid[2]});
        CHECK("span: a CC gap releases the held packet unchanged, counted",
              gap.out == std::vector<Bytes>({vid[0], vid[2]}) && gap.span.broken() == 1 &&
                  gap.span.spans() == 0 && gap.joined == 0);

        Rewriter cut;
        cut.shift = 90;
        cut.feed({vid[0], next_pusi});
        PesHeader h;
        Bytes got = cut.out.size() == 2 ? cut.out[1] : Bytes(PKT);
        CHECK("span: a new PES start releases it unchanged; the new header is rewritten",
              cut.out.size() == 2 && cut.out[0] == vid[0] && cut.span.broken() == 1 &&
                  parse_pkt(got, &h) && h.pts == P + 3600 + 90 && h.dts == D + 3600 + 90);

        // A legal duplicate of the held packet (2.4.3.3; its PCR may differ): the
        // decoder keeps the first copy, so no copy may be rewritten alone.
        const Bytes dup = vid[0];
        Rewriter twice;
        twice.shift = 90;
        twice.feed({vid[0], dup, vid[1], vid[2]});
        PesHeader kept;
        const Bytes first_copy = twice.out.empty() ? Bytes(PKT) : twice.out[0];
        Bytes joined(first_copy.begin() + 178, first_copy.end());
        if (twice.out.size() > 2)
            joined.insert(joined.end(), twice.out[2].begin() + 4, twice.out[2].end());
        CHECK("span: a duplicate of the held packet: every copy and the rest pass unchanged",
              twice.out == std::vector<Bytes>({vid[0], dup, vid[1], vid[2]}) &&
                  twice.span.broken() == 1 && twice.span.spans() == 0 &&
                  parse_pes_header(joined.data(), joined.size(), &kept) && kept.pts == P &&
                  kept.dts == D);

        Rewriter eos;
        eos.feed(vid[0]);
        Bytes tail;
        eos.span.flush(tail);
        CHECK("span: flush() at EOS releases it unchanged, counted",
              eos.out.empty() && tail == vid[0] && eos.span.broken() == 1 &&
                  !eos.span.held(0x100));

        PesHeaderSpan s;
        Bytes a = vid[0], b = vid[1], c = vid[0];
        PacketView va = view(a), vb = view(b), vc = view(c);
        CHECK("span: one packet per PID", s.hold(va) && s.held(0x100) && !s.hold(vc));
        uint8_t first[PKT];
        int calls = 0;
        auto ts = [&](const PesHeader&, int64_t&, int64_t&) { calls++; };
        int co = 0, cw = 0;
        Bytes other = packetize(0x101, pes(0xC0, P, -1, pattern(10, 1)), co, 5)[0];
        PacketView vo = view(other);
        CHECK("span: other PIDs pass through complete() untouched",
              !s.complete(vo, first, ts) && calls == 0 && s.held(0x100));
        PesHeader jh;
        Bytes skip = vid[2];
        PacketView vg = view(skip);
        CHECK("span: joined() reads the header its continuation completes and leaves it held; not across a CC "
              "gap, from a duplicate or for another PID (B-185)",
              s.joined(vb, &jh) && jh.complete && jh.pts == P && jh.dts == D && s.held(0x100) && s.spans() == 0 &&
                  !s.joined(vg, &jh) && !s.joined(vc, &jh) && !s.joined(vo, &jh) && s.held(0x100));
        s.reset();
        CHECK("span: reset() drops it",
              !s.held(0x100) && !s.complete(vb, first, ts) && calls == 0);

        Bytes whole = packetize(0x100, pes(0xE0, P, D, pattern(10, 1)), cw)[0];
        Bytes cont = vid[1], empty = af_only(0x100, 0, 0x10);
        Bytes junk = one_packet(0x100, 173, Bytes(10, 0x47));
        PacketView vw = view(whole), vn = view(cont), ve = view(empty), vj = view(junk);
        CHECK("span: not held: a whole header, no PUSI, no payload, no PES start",
              !s.hold(vw) && !s.hold(vn) && !s.hold(ve) && !s.hold(vj) && !s.held(0x100));
    }
    {
        // Two PIDs held at once, each released in front of its own continuation.
        int c1 = 0, c2 = 0, w1 = 0, w2 = 0;
        const Bytes b1 = pattern(300, 1), b2 = pattern(300, 2);
        const auto v1 = packetize(0x100, pes(0xE0, P, D, b1, false), c1, 5);
        const auto v2 = packetize(0x102, pes(0xE1, D, -1, b2, false), c2, 7);
        const auto v1w = packetize(0x100, pes(0xE0, P + 1, D + 1, b1, false), w1, 5);
        const auto v2w = packetize(0x102, pes(0xE1, D + 1, -1, b2, false), w2, 7);
        Rewriter r;
        r.shift = 1;
        r.feed({v1[0], v2[0], v2[1], v1[1]});
        CHECK("span: two PIDs held at once, each released before its own next packet",
              r.out == std::vector<Bytes>({v2w[0], v2w[1], v1w[0], v1w[1]}) &&
                  r.span.spans() == 2);
    }

    // --- PesAssembler: bounded and unbounded across chunk boundaries ---------------
    {
        // Unbounded video, bounded audio, a bounded private_stream_1 without
        // PTS, and a PID not selected, interleaved packet by packet.
        const std::vector<size_t> vsz = {1000, 2500, 61}, asz = {300, 184, 183, 1};
        const std::vector<size_t> ssz = {20, 400};
        auto vpts = [](size_t i) { return 9000 + 3600 * (int64_t)i; };
        auto apts = [](size_t i) { return 9100 + 1920 * (int64_t)i; };
        auto vdata = [&](size_t i) { return pattern(vsz[i], (int)i); };
        auto adata = [&](size_t i) { return pattern(asz[i], 10 + (int)i); };
        auto sdata = [&](size_t i) { return pattern(ssz[i], 20 + (int)i); };
        std::vector<std::vector<Bytes>> q(4);
        int cv = 0, ca = 5, cs = 9, cx = 0;
        auto queue = [](std::vector<Bytes>& to, const std::vector<Bytes>& pkts) {
            to.insert(to.end(), pkts.begin(), pkts.end());
        };
        for (size_t i = 0; i < vsz.size(); i++)
            queue(q[0], packetize(0x100, pes(0xE0, vpts(i), vpts(i) - 3000, vdata(i), false), cv));
        for (size_t i = 0; i < asz.size(); i++)
            queue(q[1], packetize(0x101, pes(0xC0, apts(i), -1, adata(i)), ca));
        for (size_t i = 0; i < ssz.size(); i++)
            queue(q[2], packetize(0x102, pes(0xBD, -1, -1, sdata(i)), cs));
        queue(q[3], packetize(0x1FF, pes(0xE0, 1, -1, pattern(500, 30)), cx));
        std::vector<Bytes> pkts;
        const size_t total = q[0].size() + q[1].size() + q[2].size() + q[3].size();
        for (size_t i = 0; pkts.size() < total; i++)
            for (auto& l : q)
                if (i < l.size()) pkts.push_back(l[i]);
        const Bytes stream = concat(pkts);

        PesAssembler a = selecting({0x100, 0x101, 0x102});
        const Units ref = assemble(a, stream);
        bool content = ref.size() == 9;
        size_t nv = 0, na = 0, ns = 0;
        for (const PesUnit& u : ref) {
            if (u.pid == 0x100) {
                content &= unit_is(u, 0x100, nv, false, vpts(nv), vdata(nv)) &&
                           u.hdr.dts == vpts(nv) - 3000 && u.hdr.payload_len == -1;
                nv++;
            } else if (u.pid == 0x101) {
                content &= unit_is(u, 0x101, na, false, apts(na), adata(na)) &&
                           u.hdr.payload_len == (int64_t)asz[na];
                na++;
            } else {
                content &= unit_is(u, 0x102, ns, false, -1, sdata(ns));
                ns++;
            }
        }
        CHECK("every PES of the three PIDs, whole, in order per PID; the fourth PID ignored",
              content && nv == 3 && na == 4 && ns == 2 && a.oversize() == 0 &&
                  a.dropped_cc() == 0 && a.malformed() == 0);
        CHECK("bounded units complete at their length, the last unbounded one at flush()",
              ref.back().pid == 0x100 && ref.back().seq == 2);
        PesAssembler nf = selecting({0x100, 0x101, 0x102});
        CHECK("... (without flush() it stays open)", assemble(nf, stream, {}, false).size() == 8);

        bool splits = true;
        for (size_t at = 1; at < stream.size(); at++) {
            PesAssembler b = selecting({0x100, 0x101, 0x102});
            splits &= same(assemble(b, stream, {at}), ref);
        }
        CHECK("every split offset of the stream gives the same units", splits);
        bool chunks = true;
        for (size_t c : {1, 7, 100, 187, 188, 189, 376, 1000, 4096}) {
            std::vector<size_t> cuts;
            for (size_t at = c; at < stream.size(); at += c) cuts.push_back(at);
            PesAssembler b = selecting({0x100, 0x101, 0x102});
            chunks &= same(assemble(b, stream, cuts), ref);
        }
        CHECK("chunks of 1, 7, 100, 187, 188, 189, 376, 1000, 4096 bytes: the same units",
              chunks);

        PesAssembler idx = selecting({0x100, 0x101, 0x102}, {32u << 20, false});
        const Units headers = assemble(idx, stream, {1000});
        bool empty = true;
        for (const PesUnit& u : headers) empty &= u.payload.empty();
        CHECK("keep_payload=false: the same units and headers, no payload",
              same(headers, ref, false) && empty);

        PesAssembler some = selecting({0x101, 0x102});
        some.select(0x102, false);
        const Units only = assemble(some, stream);
        bool audio = only.size() == 4;
        for (const PesUnit& u : only) audio &= u.pid == 0x101;
        CHECK("select(pid, false) forgets the PID", audio);
    }
    {
        // 64 KB + 1: the unbounded form mpegtsmux writes for video over 64 KB
        // (mrpeshouse's PesWalker drops it at 65536); and the largest bounded PES.
        int cc = 0;
        const Bytes big = pattern(65537, 4);
        const Bytes stream = concat(packetize(0x100, pes(0xE0, P, D, big, false), cc));
        const Bytes next =
            concat(packetize(0x100, pes(0xE0, P + 3600, D + 3600, pattern(10, 1), false), cc));
        PesAssembler a = selecting({0x100});
        const Units u = assemble(a, concat({stream, next}), {}, false);
        CHECK("64 KB + 1 payload: one unit, every byte",
              u.size() == 1 && unit_is(u[0], 0x100, 0, false, P, big));
        int cb = 0;
        const Bytes max = pattern(65535 - 8, 5);
        PesAssembler b = selecting({0x100});
        const Units m = assemble(b, concat(packetize(0x100, pes(0xC0, P, -1, max), cb)), {}, false);
        CHECK("PES_packet_length 65535: complete at its length, no PUSI after it",
              m.size() == 1 && unit_is(m[0], 0x100, 0, false, P, max) &&
                  m[0].hdr.payload_len == 65527);
    }

    // --- PesAssembler: losses and drops ---------------------------------------------
    {
        int cc = 0;
        const auto A = packetize(0x101, pes(0xC0, 100, -1, pattern(300, 1)), cc);
        const auto B = packetize(0x101, pes(0xC0, 200, -1, pattern(600, 2)), cc);
        const auto C = packetize(0x101, pes(0xC0, 300, -1, pattern(100, 3)), cc);
        PesAssembler a = selecting({0x101});
        const Units u = assemble(a, concat({A[0], A[1], B[0], B[2], B[3], C[0]}));
        CHECK("CC loss mid-PES (bounded): the unit dropped, the next discont, seq gap",
              u.size() == 2 && unit_is(u[0], 0x101, 0, false, 100, pattern(300, 1)) &&
                  unit_is(u[1], 0x101, 2, true, 300, pattern(100, 3)) && a.dropped_cc() == 1 &&
                  a.malformed() == 0);

        int cv = 0;
        const auto V1 = packetize(0x100, pes(0xE0, 100, -1, pattern(400, 4), false), cv);
        const auto V2 = packetize(0x100, pes(0xE0, 200, -1, pattern(400, 5), false), cv);
        const auto V3 = packetize(0x100, pes(0xE0, 300, -1, pattern(400, 6), false), cv);
        PesAssembler b = selecting({0x100});
        const Units w =
            assemble(b, concat({V1[0], V1[1], V1[2], V2[0], V2[2], V3[0], V3[1], V3[2]}));
        CHECK("CC loss mid-PES (unbounded): the same",
              w.size() == 2 && unit_is(w[0], 0x100, 0, false, 100, pattern(400, 4)) &&
                  unit_is(w[1], 0x100, 2, true, 300, pattern(400, 6)) && b.dropped_cc() == 1);
        PesAssembler c = selecting({0x100});
        const Units x = assemble(c, concat({V1[0], V1[1], V2[0], V2[1], V2[2]}));
        CHECK("a loss just before a PUSI drops the open unit; the new one is discont",
              x.size() == 1 && unit_is(x[0], 0x100, 1, true, 200, pattern(400, 5)) &&
                  c.dropped_cc() == 1);

        const Bytes dup = V1[1];
        PesAssembler d = selecting({0x100});
        const Units y = assemble(d, concat({V1[0], V1[1], dup, V1[2], V2[0], V2[1], V2[2]}));
        CHECK("a duplicate packet is skipped, not appended",
              y.size() == 2 && unit_is(y[0], 0x100, 0, false, 100, pattern(400, 4)) &&
                  d.dropped_cc() == 0);

        PesAssembler e = selecting({0x100});
        const Bytes disc = af_only(0x100, V1[1][3] & 0x0F, 0x80);
        const Units z = assemble(e, concat({V1[0], V1[1], disc, V1[2], V2[0], V2[1], V2[2]}));
        CHECK("the discontinuity flag mid-PES (Reset) drops it like a loss",
              z.size() == 1 && unit_is(z[0], 0x100, 1, true, 200, pattern(400, 5)) &&
                  e.dropped_cc() == 1);

        PesAssembler f = selecting({0x100});
        const Units mid = assemble(f, concat({V1[1], V1[2], V2[0], V2[1], V2[2]}));
        CHECK("a PUSI-less start: the first whole unit is discont, seq 0",
              mid.size() == 1 && unit_is(mid[0], 0x100, 0, true, 200, pattern(400, 5)));

        PesAssembler g = selecting({0x101});
        const Units lp = assemble(g, concat({A[0], A[1], B[1], B[2], B[3], C[0]}));
        CHECK("a lost PUSI packet: nothing open to drop, the next unit is discont",
              lp.size() == 2 && unit_is(lp[1], 0x101, 1, true, 300, pattern(100, 3)) &&
                  g.dropped_cc() == 0 && g.malformed() == 0);

        // A sloppy mux pads the last packet with payload bytes, not AF stuffing.
        const Bytes data = pes(0xC0, 400, -1, pattern(200, 7));
        Bytes p0 = one_packet(0x101, -1, Bytes(data.begin(), data.begin() + 184));
        Bytes p1 = one_packet(0x101, -1, Bytes(data.begin() + 184, data.end()), false);
        p1[3] = (uint8_t)((p1[3] & 0xF0) | 1);
        int cn = 2;
        const auto N = packetize(0x101, pes(0xC0, 500, -1, pattern(9, 8)), cn);
        PesAssembler h = selecting({0x101});
        const Units pad = assemble(h, concat({p0, p1, N[0]}));
        CHECK("bytes past a bounded PES's length are not payload, and not a loss",
              pad.size() == 2 && unit_is(pad[0], 0x101, 0, false, 400, pattern(200, 7)) &&
                  unit_is(pad[1], 0x101, 1, false, 500, pattern(9, 8)));
    }
    {
        PesAssembler::Config cfg;
        cfg.max_bytes = 1000;
        int cc = 0;
        const auto ok = packetize(0x100, pes(0xE0, 100, -1, pattern(1000, 1), false), cc);
        const auto big = packetize(0x100, pes(0xE0, 200, -1, pattern(1001, 2), false), cc);
        const auto bbig = packetize(0x100, pes(0xC0, 300, -1, pattern(1001, 3)), cc);
        const auto after = packetize(0x100, pes(0xE0, 400, -1, pattern(10, 4), false), cc);
        const Bytes stream = concat({concat(ok), concat(big), concat(bbig), concat(after)});
        PesAssembler a = selecting({0x100}, cfg);
        const Units u = assemble(a, stream);
        CHECK("oversize: max_bytes kept, max_bytes + 1 dropped, counted (unbounded, bounded)",
              u.size() == 2 && unit_is(u[0], 0x100, 0, false, 100, pattern(1000, 1)) &&
                  unit_is(u[1], 0x100, 3, true, 400, pattern(10, 4)) && a.oversize() == 2 &&
                  a.dropped_cc() == 0);
        cfg.keep_payload = false;
        PesAssembler b = selecting({0x100}, cfg);
        const Units w = assemble(b, stream);
        CHECK("... the same without keeping payload", same(w, u, false) && b.oversize() == 2);
    }
    {
        int cc = 0;
        const auto A = packetize(0x101, pes(0xC0, 100, -1, pattern(300, 1)), cc);
        const auto B = packetize(0x101, pes(0xC0, 200, -1, pattern(30, 2)), cc);
        Bytes b0 = B[0];
        b0[3] = (uint8_t)((b0[3] & 0xF0) | ((A[0][3] + 1) & 0x0F));   // CC follows A[0]
        PesAssembler a = selecting({0x101});
        const Units u = assemble(a, concat({A[0], b0}));
        CHECK("a bounded unit cut short by a PUSI: dropped (malformed), the next discont",
              u.size() == 1 && unit_is(u[0], 0x101, 1, true, 200, pattern(30, 2)) &&
                  a.malformed() == 1 && a.dropped_cc() == 0);

        PesAssembler f = selecting({0x101});
        const Units v = assemble(f, concat({A[0]}));
        CHECK("flush(): a bounded unit short of its length is dropped (malformed)",
              v.empty() && f.malformed() == 1);
        int cv = 0;
        const auto V = packetize(0x100, pes(0xE0, 100, -1, pattern(250, 1), false), cv);
        PesAssembler g = selecting({0x100});
        Units w;
        CcTracker t;
        for (Bytes p : V) {
            PacketView pv = view(p);
            g.feed(pv, t.feed(pv), w);
        }
        const bool open_before = w.empty();
        g.flush(w);
        CHECK("flush(): the open unbounded unit is emitted",
              open_before && w.size() == 1 && unit_is(w[0], 0x100, 0, false, 100, pattern(250, 1)));

        PesAssembler r = selecting({0x100});
        Units x;
        Bytes v0 = V[0];
        PacketView pv = view(v0);
        r.feed(pv, CcTracker::Result::Ok, x);
        r.reset();
        int c2 = 0;
        const auto N = packetize(0x100, pes(0xE0, 500, -1, pattern(50, 2), false), c2);
        x = assemble(r, concat(N));
        CHECK("reset(): the open unit is dropped silently; seq goes on",
              x.size() == 1 && unit_is(x[0], 0x100, 1, false, 500, pattern(50, 2)) &&
                  r.malformed() == 0);

        const Bytes notpes = one_packet(0x100, -1, Bytes(184, 0x47));
        PesAssembler n = selecting({0x100});
        int c3 = 1;
        const auto M = packetize(0x100, pes(0xE0, 600, -1, pattern(20, 3), false), c3);
        const Units y = assemble(n, concat({notpes, M[0]}));
        CHECK("a PUSI with no PES start: counted malformed, the next unit discont",
              y.size() == 1 && unit_is(y[0], 0x100, 0, true, 600, pattern(20, 3)) &&
                  n.malformed() == 1);
    }
    {
        // A header split after k bytes, assembled; and one whose joined bytes
        // prove it was no PES after all.
        bool split = true;
        for (size_t k = 1; k <= 30; k++) {
            int cc = 0;
            const Bytes body = pattern(500, (int)k);
            const auto pk = packetize(0x100, pes(0xE0, P, D, body, true, 8), cc, k);
            PesAssembler a = selecting({0x100});
            const Units u = assemble(a, concat(pk), {}, false);
            split &= u.size() == 1 && unit_is(u[0], 0x100, 0, false, P, body) &&
                     u[0].hdr.dts == D && u[0].hdr.header_len == 27 && u[0].hdr.payload_len == 500;
        }
        CHECK("assembler: a header split after 1..30 bytes is joined", split);
        int cc = 0;
        const Bytes first = packetize(0x100, Bytes{0x00, 0x00}, cc, 2)[0];
        Bytes second = one_packet(0x100, -1, Bytes(184, 0x02), false);
        second[3] = (uint8_t)((second[3] & 0xF0) | 1);
        PesAssembler a = selecting({0x100});
        const Units u = assemble(a, concat({first, second}));
        CHECK("... and a start code that the next packet breaks is dropped (malformed)",
              u.empty() && a.malformed() == 1);

        bool padding = true;
        for (uint8_t sid : {0xBE, 0xBF}) {
            int c = 0;
            const Bytes data = pattern(500, sid);
            PesAssembler b = selecting({0x1E0});
            const Bytes s = concat(packetize(0x1E0, pes(sid, -1, -1, data), c));
            const Units w = assemble(b, s, {}, false);
            padding &= w.size() == 1 && w[0].hdr.header_len == 6 && w[0].hdr.sid == sid &&
                       unit_is(w[0], 0x1E0, 0, false, -1, data);
        }
        CHECK("assembler: padding and private_stream_2 PES (no optional header)", padding);
    }

    return test_summary("ts_pes");
}
