// ts_packet: the header view, the walker's carry and resync, and the
// continuity check (WI-S0-2).
#include <algorithm>
#include <cstring>
#include <vector>

#include "../ts_packet.h"
#include "../ts_psi.h"
#include "check.h"

using namespace mrts;

namespace {

using Bytes = std::vector<uint8_t>;
using CC = CcTracker::Result;

// One packet: optional adaptation field of `af_len` bytes (`af_flags` in its
// flags byte, stuffing after), the rest `fill`. af_len < 0 = no AF.
Bytes packet(int pid, int cc, bool pusi, bool payload, int af_len = -1, uint8_t af_flags = 0,
             uint8_t fill = 0xA5) {
    Bytes p(PKT, fill);
    p[0] = SYNC_BYTE;
    p[1] = (uint8_t)((pusi ? 0x40 : 0) | ((pid >> 8) & 0x1F));
    p[2] = (uint8_t)(pid & 0xFF);
    p[3] = (uint8_t)((af_len >= 0 ? 0x20 : 0) | (payload ? 0x10 : 0) | (cc & 0x0F));
    if (af_len >= 0) {
        p[4] = (uint8_t)af_len;
        if (af_len >= 1) p[5] = af_flags;
        for (int i = 6; i < 5 + af_len && i < PKT; i++) p[i] = 0xFF;
    }
    return p;
}

Bytes from(const uint8_t* b) { return Bytes(b, b + PKT); }

// PAT, PMT, video with PCR/DI/RAI, a PCR-only packet, audio, a null packet:
// ten packets, all different.
std::vector<Bytes> fixture() {
    uint8_t t[PKT];
    std::vector<Bytes> f;
    build_pat(1, {{1, 0x30}}, 0, 0, t);
    f.push_back(from(t));
    build_pmt(0x30, 1, 0x100, {{0x100, STREAM_TYPE_AVC, {}}, {0x101, STREAM_TYPE_AAC, {}}}, 0, 0, t);
    f.push_back(from(t));
    f.push_back(packet(0x100, 0, true, true, 7, 0xD0, 0xB2));
    f.push_back(packet(0x100, 1, false, true, -1, 0, 0xB3));
    build_pcr_packet(0x100, 27'000'000, 1, t);
    f.push_back(from(t));
    f.push_back(packet(0x101, 0, true, true, -1, 0, 0xB5));
    f.push_back(packet(0x100, 2, false, true, -1, 0, 0xB6));
    null_packet(0, t);
    f.push_back(from(t));
    f.push_back(packet(0x101, 1, false, true, -1, 0, 0xB8));
    f.push_back(packet(0x100, 3, false, true, 10, 0x00, 0xB9));
    return f;
}

Bytes concat(const std::vector<Bytes>& parts) {
    Bytes out;
    for (const auto& p : parts) out.insert(out.end(), p.begin(), p.end());
    return out;
}

// Garbage with no sync byte in it.
Bytes garbage(size_t n, int seed) {
    Bytes g(n);
    for (size_t i = 0; i < n; i++) {
        uint8_t b = (uint8_t)(i * 37 + seed * 11 + 5);
        g[i] = b == SYNC_BYTE ? 0x48 : b;
    }
    return g;
}

struct Walked {
    std::vector<Bytes> pkts;
    size_t carried = 0;
    uint64_t desync = 0;
};

// Feeds `s` cut at `cuts` (ascending offsets), one feed per piece.
Walked walk(Bytes s, const std::vector<size_t>& cuts) {
    PacketWalker w;
    Walked r;
    size_t start = 0;
    std::vector<size_t> ends(cuts);
    ends.push_back(s.size());
    for (size_t end : ends) {
        w.feed(s.data() + start, end - start,
               [&](PacketView& v) { r.pkts.emplace_back(v.p, v.p + PKT); });
        start = end;
    }
    r.carried = w.carried();
    r.desync = w.desync_bytes();
    return r;
}

std::vector<size_t> every(size_t chunk, size_t len) {
    std::vector<size_t> cuts;
    for (size_t c = chunk; c < len; c += chunk) cuts.push_back(c);
    return cuts;
}

CC cc_of(CcTracker& t, Bytes p) {
    PacketView v;
    parse_packet(p.data(), &v);
    return t.feed(v);
}

}  // namespace

int main() {
    const std::vector<Bytes> fx = fixture();
    const Bytes stream = concat(fx);

    // --- parse_packet ----------------------------------------------------------
    {
        Bytes p = fx[2];
        PacketView v;
        CHECK("parse_packet reads a PES start with AF: DI, RAI, PCR",
              parse_packet(p.data(), &v) && v.p == p.data() && v.pid == 0x100 && v.cc == 0 &&
                  v.pusi && !v.tei && !v.scrambled && v.has_af && v.has_payload && v.af_len == 7 &&
                  v.payload_off == 12 && v.af_discontinuity && v.af_rai && v.af_pcr);
        Bytes q = fx[4];
        CHECK("an adaptation-only packet has no payload",
              parse_packet(q.data(), &v) && !v.has_payload && v.payload_off == PKT && v.af_pcr &&
                  !v.af_discontinuity && v.cc == 1);
        Bytes full = packet(0x200, 5, false, true, 183);
        CHECK("an AF filling the packet leaves the payload flag but no payload bytes",
              parse_packet(full.data(), &v) && v.has_payload && v.payload_off == PKT);
        Bytes bad = packet(0x200, 5, false, true, 200);
        CHECK("a corrupt AF length leaves no payload",
              parse_packet(bad.data(), &v) && v.payload_off == PKT);
        Bytes flags = fx[3];
        flags[1] |= 0x80;
        flags[3] |= 0xC0;
        CHECK("TEI and scrambling are reported",
              parse_packet(flags.data(), &v) && v.tei && v.scrambled && v.pid == 0x100);
        Bytes nosync = fx[3];
        nosync[0] = 0x46;
        v.pid = -7;
        CHECK("not 0x47: false, view untouched", !parse_packet(nosync.data(), &v) && v.pid == -7);

        // The helpers ts_psi/ts_timeline call agree with the view on every
        // header: flags, AF length and PCR flag swept.
        bool agree = true;
        uint8_t b[PKT];
        std::memset(b, 0xFF, PKT);
        b[0] = SYNC_BYTE;
        b[2] = 0x34;
        for (int b1 = 0; b1 < 256; b1++)
            for (int b3 = 0; b3 < 256; b3++)
                for (int b4 : {0, 1, 6, 7, 100, 182, 183, 200})
                    for (int b5 : {0x00, 0x10, 0x50, 0x90, 0xF0}) {
                        b[1] = (uint8_t)b1;
                        b[3] = (uint8_t)b3;
                        b[4] = (uint8_t)b4;
                        b[5] = (uint8_t)b5;
                        parse_packet(b, &v);
                        const int off = payload_offset(b);
                        agree &= v.pid == ts_pid(b) && v.pusi == ts_pusi(b) &&
                                 v.has_payload == ts_has_payload(b) && v.cc == (b3 & 0x0F) &&
                                 v.af_pcr == (read_pcr(b) >= 0) &&
                                 v.payload_off == (ts_has_payload(b) && off < PKT ? off : PKT);
                    }
        CHECK("parse_packet agrees with ts_pid/ts_pusi/ts_has_payload/payload_offset/read_pcr",
              agree);
    }

    // --- PacketWalker: chunking ------------------------------------------------
    {
        Walked whole = walk(stream, {});
        CHECK("one feed: ten packets in order, nothing carried or dropped",
              whole.pkts == fx && whole.carried == 0 && whole.desync == 0);
        bool splits = true;
        for (size_t at = 0; at <= stream.size(); at++) {
            Walked r = walk(stream, {at});
            splits &= r.pkts == fx && r.carried == 0 && r.desync == 0;
        }
        CHECK("every split offset of the stream yields the same ten packets", splits);
        bool chunks = true;
        for (size_t c = 1; c <= stream.size(); c++) {
            Walked r = walk(stream, every(c, stream.size()));
            chunks &= r.pkts == fx && r.carried == 0 && r.desync == 0;
        }
        CHECK("every chunk size from 1 to 1880 bytes yields the same ten packets", chunks);
    }

    // --- PacketWalker: garbage -------------------------------------------------
    {
        // 14 + 7 + 100 bytes of garbage between packets; one 0x47 inside the
        // 100 is not confirmed 188 bytes on and must be skipped too.
        Bytes g3 = garbage(100, 3);
        g3[50] = SYNC_BYTE;
        const Bytes dirty = concat({garbage(14, 1), fx[0], fx[1], fx[2], fx[3], garbage(7, 2), fx[4],
                                    fx[5], fx[6], g3, fx[7], fx[8], fx[9]});
        Walked r = walk(dirty, {});
        CHECK("garbage between packets is dropped and counted",
              r.pkts == fx && r.desync == 121 && r.carried == 0);
        // Without the stray 0x47 the result cannot depend on where chunks end.
        const Bytes clean_garbage = concat({garbage(14, 1), fx[0], fx[1], fx[2], fx[3], garbage(7, 2),
                                            fx[4], fx[5], fx[6], garbage(100, 3), fx[7], fx[8], fx[9]});
        bool any_cut = true;
        for (size_t at = 0; at <= clean_garbage.size(); at++) {
            Walked c = walk(clean_garbage, {at});
            any_cut &= c.pkts == fx && c.desync == 121 && c.carried == 0;
        }
        for (size_t c = 1; c <= clean_garbage.size(); c++) {
            Walked w = walk(clean_garbage, every(c, clean_garbage.size()));
            any_cut &= w.pkts == fx && w.desync == 121 && w.carried == 0;
        }
        CHECK("... at every split offset and every chunk size", any_cut);
    }

    // --- PacketWalker: the carry -----------------------------------------------
    {
        Bytes a(fx[0].begin(), fx[0].end()), b;
        a.insert(a.end(), fx[1].begin(), fx[1].begin() + 94);
        b.assign(fx[1].begin() + 94, fx[1].end());
        b.insert(b.end(), fx[2].begin(), fx[2].end());
        PacketWalker w;
        std::vector<Bytes> got;
        std::vector<const uint8_t*> at;
        auto cb = [&](PacketView& v) {
            got.emplace_back(v.p, v.p + PKT);
            at.push_back(v.p);
            v.p[PKT - 1] = 0x00;          // a rewriter's in-place write
        };
        w.feed(a.data(), a.size(), cb);
        CHECK("a tail is carried: one packet out, 94 bytes held",
              got.size() == 1 && w.carried() == 94 && at[0] == a.data());
        CHECK("an aligned packet is viewed in place: the write landed in the caller's buffer",
              a[PKT - 1] == 0x00);
        w.feed(b.data(), b.size(), cb);
        CHECK("the held tail joins the next feed: the split packet comes out whole",
              got.size() == 3 && got[1] == fx[1] && got[2] == fx[2] && w.carried() == 0);
        CHECK("a joined packet is viewed in the walker's own buffer",
              (at[1] < a.data() || at[1] >= a.data() + a.size()) &&
                  (at[1] < b.data() || at[1] >= b.data() + b.size()) && at[2] == b.data() + 94);
        CHECK("... so its write does not touch either chunk", b[93] == fx[1][PKT - 1]);

        PacketWalker r;
        std::vector<Bytes> out;
        auto keep = [&](PacketView& v) { out.emplace_back(v.p, v.p + PKT); };
        Bytes half(fx[0].begin(), fx[0].begin() + 100), next = fx[3];
        r.feed(half.data(), half.size(), keep);
        r.reset();
        r.feed(next.data(), next.size(), keep);
        CHECK("reset drops the carry", out.size() == 1 && out[0] == fx[3] && r.carried() == 0 &&
                                           r.desync_bytes() == 0);
        r.feed(nullptr, 0, keep);
        CHECK("an empty feed is a no-op", out.size() == 1 && r.carried() == 0);

        // A garbage tail is held like any other (it may be a packet's head)
        // and counted once the next feed shows it is not.
        PacketWalker g;
        std::vector<Bytes> pk;
        Bytes first = fx[0], tail = garbage(50, 4), second = fx[5];
        first.insert(first.end(), tail.begin(), tail.end());
        g.feed(first.data(), first.size(), [&](PacketView& v) { pk.emplace_back(v.p, v.p + PKT); });
        CHECK("a garbage tail is carried, not yet counted",
              pk.size() == 1 && g.carried() == 50 && g.desync_bytes() == 0);
        g.feed(second.data(), second.size(), [&](PacketView& v) { pk.emplace_back(v.p, v.p + PKT); });
        CHECK("... and dropped and counted on the next feed",
              pk.size() == 2 && pk[1] == fx[5] && g.desync_bytes() == 50 && g.carried() == 0);
    }

    // --- PacketWalker: the read-only walk (B-15; moved here from ts_select_test) -----
    {
        // The same packets as the mutable walk, joins and resyncs included; the input unwritten.
        Bytes bytes = stream;
        bytes.insert(bytes.begin() + 400, {0x00, 0x47, 0x12});   // garbage mid-stream
        const Bytes copy = bytes;
        std::vector<int> want, got;
        PacketWalker mw, cw;
        Bytes mut = bytes;
        for (size_t at = 0; at < mut.size(); at += 77)
            mw.feed(mut.data() + at, std::min<size_t>(77, mut.size() - at),
                    [&](PacketView& v) { want.push_back(v.pid * 16 + v.cc); });
        const uint8_t* ro = bytes.data();
        for (size_t at = 0; at < bytes.size(); at += 77)
            cw.feed(ro + at, std::min<size_t>(77, bytes.size() - at),
                    [&](const PacketView& v) { got.push_back(v.pid * 16 + v.cc); });
        CHECK("const feed: the same packets as the mutable walk (77-byte feeds, garbage)",
              want.size() == fx.size() && got == want && cw.desync_bytes() == mw.desync_bytes() &&
                  cw.desync_bytes() == 3);
        CHECK("const feed: the input is untouched", bytes == copy);
    }

    // --- CcTracker ---------------------------------------------------------------
    {
        CcTracker t;
        bool ok = true;
        for (int i = 0; i < 40; i++) ok &= cc_of(t, packet(0x100, i & 0x0F, false, true)) == CC::Ok;
        CHECK("cc: a continuous run through 15 -> 0 is Ok", ok && t.lost() == 0);
    }
    {
        CcTracker t;
        CHECK("cc: the first packet of a PID is Ok, whatever its CC",
              cc_of(t, packet(0x100, 9, true, true)) == CC::Ok);
        CHECK("cc: one duplicate is legal",
              cc_of(t, packet(0x100, 9, false, true)) == CC::Duplicate &&
                  cc_of(t, packet(0x100, 10, false, true)) == CC::Ok && t.lost() == 0);
        cc_of(t, packet(0x100, 11, false, true));
        cc_of(t, packet(0x100, 11, false, true));
        CHECK("cc: a third copy is an error", cc_of(t, packet(0x100, 11, false, true)) == CC::Lost &&
                                                  t.lost() == 1);
        CHECK("cc: ... and so is a fourth",
              cc_of(t, packet(0x100, 11, false, true)) == CC::Lost && t.lost() == 2);
        CHECK("cc: a gap is Lost, counted, and the stream resumes from it",
              cc_of(t, packet(0x100, 14, false, true)) == CC::Lost && t.lost() == 3 &&
                  cc_of(t, packet(0x100, 15, false, true)) == CC::Ok);
    }
    {
        CcTracker t;
        cc_of(t, packet(0x100, 3, false, true));
        CHECK("cc: adaptation-only packets never advance CC",
              cc_of(t, packet(0x100, 3, false, false, 183, 0x10)) == CC::Ok &&
                  cc_of(t, packet(0x100, 9, false, false, 183, 0x10)) == CC::Ok &&
                  cc_of(t, packet(0x100, 4, false, true)) == CC::Ok && t.lost() == 0);
    }
    {
        CcTracker t;
        cc_of(t, packet(0x100, 3, false, true));
        CHECK("cc: the discontinuity flag resets on a payload packet",
              cc_of(t, packet(0x100, 9, true, true, 7, 0x90)) == CC::Reset &&
                  cc_of(t, packet(0x100, 10, false, true)) == CC::Ok && t.lost() == 0);
        CHECK("cc: ... and on an adaptation-only one, where the next payload sets the CC",
              cc_of(t, packet(0x100, 0, false, false, 183, 0x90)) == CC::Reset &&
                  cc_of(t, packet(0x100, 0, true, true)) == CC::Ok &&
                  cc_of(t, packet(0x100, 1, false, true)) == CC::Ok && t.lost() == 0);
    }
    {
        CcTracker t;
        bool ok = true;
        for (int cc : {0, 0, 0, 5, 2}) ok &= cc_of(t, packet(PID_NULL, cc, false, true)) == CC::Ok;
        CHECK("cc: null packets are not tracked", ok && t.lost() == 0);
        bool apart = true;
        for (int i = 0; i < 6; i++) {
            apart &= cc_of(t, packet(0x100, i, false, true)) == CC::Ok;
            apart &= cc_of(t, packet(0x101, (7 + i) & 0x0F, false, true)) == CC::Ok;
        }
        CHECK("cc: PIDs are tracked apart", apart && t.lost() == 0);
    }

    return test_summary("ts_packet");
}
