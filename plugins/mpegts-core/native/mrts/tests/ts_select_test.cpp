// ts_select: the select-mode formula demux (plan ch. 6 WI-P2-7) that mrtsdemux runs, and the
// read-only PacketWalker::feed it walks with (B-15). Hand-built 302M programs, no GStreamer.
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "../ts_gap.h"
#include "../ts_house.h"
#include "../ts_packet.h"
#include "../ts_psi.h"
#include "../ts_select.h"
#include "check.h"

using namespace mrts;
using Out = SelectDemux::Out;

namespace {

constexpr int PMT_PID = 0x1000, PID_A = 0x41, PID_V = 0x100, PID_B = 0x42;
constexpr int64_t MS = 1000000, S = 1000 * MS;
constexpr int64_t TICKS_20MS = 1800;            // 960 frames: exact in ns and in ticks

const std::vector<uint8_t> BSSD = {0x05, 0x04, 'B', 'S', 'S', 'D'};

// A 302M payload: the AES3 header, then `frames` of 2-channel 16-bit pairs (5 bytes each).
std::vector<uint8_t> s302m(int64_t frames, int channels = 2, int bits = 16, uint8_t fill = 0) {
    const int pair_bytes = (bits + 4) / 4;
    const uint32_t size = (uint32_t)(frames * channels / 2 * pair_bytes);
    const uint32_t h = (size << 16) | ((uint32_t)(channels / 2 - 1) << 14) |
                       ((uint32_t)((bits - 16) / 4) << 4);
    std::vector<uint8_t> p = {(uint8_t)(h >> 24), (uint8_t)(h >> 16), (uint8_t)(h >> 8),
                              (uint8_t)h};
    for (uint32_t i = 0; i < size; i++) p.push_back((uint8_t)(fill + i * 7));
    return p;
}

void put_ts(std::vector<uint8_t>& o, int prefix, int64_t v) {
    o.push_back((uint8_t)((prefix << 4) | (((v >> 30) & 7) << 1) | 1));
    o.push_back((uint8_t)(v >> 22));
    o.push_back((uint8_t)((((v >> 15) & 0x7F) << 1) | 1));
    o.push_back((uint8_t)(v >> 7));
    o.push_back((uint8_t)(((v & 0x7F) << 1) | 1));
}

// A transport stream under construction: PSI, PES, raw packets, CC kept per PID.
struct Ts {
    std::vector<uint8_t> b;
    std::map<int, uint8_t> cc;

    void packet(const uint8_t* p) { b.insert(b.end(), p, p + PKT); }
    void pat(std::vector<std::pair<int, int>> programs = {{1, PMT_PID}}, int version = 0) {
        uint8_t p[PKT];
        build_pat(1, programs, cc[0]++, version, p);
        packet(p);
    }
    void pmt(std::vector<PmtStream> streams, int pcr_pid, int version = 0, int pmt_pid = PMT_PID,
             int program = 1) {
        uint8_t p[PKT];
        build_pmt(pmt_pid, program, pcr_pid, streams, cc[pmt_pid]++, version, p);
        packet(p);
    }
    void psi_302m(int pid = PID_A, int version = 0) {
        pat();
        pmt({{pid, STREAM_TYPE_PRIVATE_PES, BSSD}}, pid, version);
    }
    // One PES on `pid`: PTS (and DTS) raw 33-bit, -1 none; unbounded: PES_packet_length 0.
    void pes(int pid, int64_t pts33, const std::vector<uint8_t>& payload, bool bounded = true,
             int64_t dts33 = -1) {
        std::vector<uint8_t> opt;
        if (pts33 >= 0) put_ts(opt, dts33 >= 0 ? 3 : 2, pts33);
        if (dts33 >= 0) put_ts(opt, 1, dts33);
        std::vector<uint8_t> body = {0x84, (uint8_t)(pts33 < 0 ? 0 : dts33 >= 0 ? 0xC0 : 0x80),
                                     (uint8_t)opt.size()};
        body.insert(body.end(), opt.begin(), opt.end());
        body.insert(body.end(), payload.begin(), payload.end());
        const size_t len = bounded ? body.size() : 0;
        std::vector<uint8_t> d = {0, 0, 1, 0xBD, (uint8_t)(len >> 8), (uint8_t)len};
        d.insert(d.end(), body.begin(), body.end());
        size_t at = 0;
        for (bool first = true; first || at < d.size(); first = false) {
            uint8_t p[PKT];
            const size_t take = std::min<size_t>(184, d.size() - at);
            p[0] = SYNC_BYTE;
            p[1] = (uint8_t)((first ? 0x40 : 0) | ((pid >> 8) & 0x1F));
            p[2] = (uint8_t)pid;
            uint8_t& c = cc[pid];
            if (take == 184) {
                p[3] = (uint8_t)(0x10 | (c & 0x0F));
                std::memcpy(p + 4, d.data() + at, 184);
            } else {                              // stuffing in the adaptation field
                const int af = (int)(183 - take);
                p[3] = (uint8_t)(0x30 | (c & 0x0F));
                p[4] = (uint8_t)af;
                if (af > 0) {
                    p[5] = 0x00;
                    std::memset(p + 6, 0xFF, (size_t)af - 1);
                }
                std::memcpy(p + 5 + af, d.data() + at, take);
            }
            c = (uint8_t)((c + 1) & 0x0F);
            packet(p);
            at += take;
        }
    }
    // The 302M PES of house tick `t` (the formula's inverse: PES = t + 1 h, 33 bits).
    void frame(int64_t t, int64_t frames = 960, int pid = PID_A) {
        pes(pid, (t + MUX_CLOCK_BASE_90K) % PTS_WRAP, s302m(frames));
    }
    uint8_t last_cc(int pid) { return (uint8_t)((cc[pid] + 15) & 0x0F); }
};

std::vector<uint8_t> marker_packet(int pid, uint8_t cc, int64_t len) {
    std::vector<uint8_t> p(PKT);
    build_gap_packet(pid, cc, len, p.data());
    return p;
}

// Feeds `ts` in `chunk`-byte pieces (0: at once) at house time `now`.
std::vector<Out> run(SelectDemux& d, const std::vector<uint8_t>& ts, int64_t now,
                     size_t chunk = 0) {
    std::vector<Out> out;
    if (!chunk) chunk = ts.size() ? ts.size() : 1;
    for (size_t at = 0; at < ts.size(); at += chunk)
        d.feed(ts.data() + at, std::min(chunk, ts.size() - at), false, now, out);
    return out;
}

std::vector<const Out*> of_kind(const std::vector<Out>& out, Out::Kind k) {
    std::vector<const Out*> r;
    for (const Out& o : out)
        if (o.kind == k) r.push_back(&o);
    return r;
}

void test_select_and_frames() {
    CHECK("select_stream: audio/x-smpte-302m is the one select mode knows",
          select_stream("audio/x-smpte-302m") == SelectStream::smpte302m &&
              select_stream("audio/x-smpte-302m, x=1") == SelectStream::none &&
              select_stream("audio/mpeg") == SelectStream::none && select_stream(nullptr) ==
              SelectStream::none);
    CHECK("select_caps_name: tsdemux's caps for 0x06 + BSSD",
          std::string(select_caps_name(SelectStream::smpte302m)) == "audio/x-smpte-302m");
    const std::vector<uint8_t> opus = {0x05, 0x04, 'O', 'p', 'u', 's'};
    std::vector<uint8_t> lang_then_bssd = {0x0A, 0x04, 'e', 'n', 'g', 0x00};
    lang_then_bssd.insert(lang_then_bssd.end(), BSSD.begin(), BSSD.end());
    std::vector<uint8_t> opus_then_bssd = opus;
    opus_then_bssd.insert(opus_then_bssd.end(), BSSD.begin(), BSSD.end());
    CHECK("select_matches: stream type 0x06 whose first registration is BSSD",
          select_matches(SelectStream::smpte302m, {PID_A, 0x06, BSSD}) &&
              select_matches(SelectStream::smpte302m, {PID_A, 0x06, lang_then_bssd}));
    CHECK("select_matches: not 0x06 without BSSD, nor with another first registration, nor "
          "another stream type with BSSD",
          !select_matches(SelectStream::smpte302m, {PID_A, 0x06, {}}) &&
              !select_matches(SelectStream::smpte302m, {PID_A, 0x06, opus}) &&
              !select_matches(SelectStream::smpte302m, {PID_A, 0x06, opus_then_bssd}) &&
              !select_matches(SelectStream::smpte302m, {PID_A, 0x0F, BSSD}) &&
              !select_matches(SelectStream::none, {PID_A, 0x06, BSSD}));

    const std::vector<uint8_t> a = s302m(1024), b = s302m(480, 8, 24), c = s302m(2000, 6, 20);
    CHECK("s302m_frames: 1024 frames stereo 16-bit (5124 bytes, mpegtsmux's shape)",
          a.size() == 5124 && s302m_frames(a.data(), a.size()) == 1024);
    CHECK("s302m_frames: 480 frames of 8 channels at 24 bits; 2000 of 6 at 20",
          s302m_frames(b.data(), b.size()) == 480 && s302m_frames(c.data(), c.size()) == 2000);
    std::vector<uint8_t> bad = a;
    bad.push_back(0);
    std::vector<uint8_t> reserved = a;
    reserved[3] |= 0x30;                      // bits_per_sample 3: reserved (28 bits)
    CHECK("s302m_frames: -1 when the size disagrees, on the reserved width, at 4 bytes or less",
          s302m_frames(bad.data(), bad.size()) == -1 &&
              s302m_frames(reserved.data(), reserved.size()) == -1 &&
              s302m_frames(a.data(), 4) == -1 && s302m_frames(a.data(), 0) == -1);
}

void test_const_walk() {
    // The read-only walk hands out exactly the mutable walk's packets, joins and resyncs
    // included, and never writes its input.
    Ts t;
    t.psi_302m();
    for (int k = 0; k < 6; k++) t.frame(1000 + k * TICKS_20MS);
    std::vector<uint8_t> bytes = t.b;
    bytes.insert(bytes.begin() + 400, {0x00, 0x47, 0x12});   // garbage mid-stream
    const std::vector<uint8_t> copy = bytes;
    std::vector<int> want, got;
    PacketWalker mw, cw;
    std::vector<uint8_t> mut = bytes;
    for (size_t at = 0; at < mut.size(); at += 77)
        mw.feed(mut.data() + at, std::min<size_t>(77, mut.size() - at),
                [&](PacketView& v) { want.push_back(v.pid * 16 + v.cc); });
    const uint8_t* ro = bytes.data();
    for (size_t at = 0; at < bytes.size(); at += 77)
        cw.feed(ro + at, std::min<size_t>(77, bytes.size() - at),
                [&](const PacketView& v) { got.push_back(v.pid * 16 + v.cc); });
    CHECK("const feed: the same packets as the mutable walk (77-byte feeds, garbage)",
          !want.empty() && got == want && cw.desync_bytes() == mw.desync_bytes() &&
              cw.desync_bytes() == 3);
    CHECK("const feed: the input is untouched", bytes == copy);
}

void test_formula() {
    // House time 100 s; the PES carry it + 1 h, as mpegtsmux writes running time + 1 h.
    const int64_t t0 = 9000000;               // 100 s in ticks, a multiple of 9: exact ns
    Ts t;
    t.psi_302m();
    for (int k = 0; k < 50; k++) t.frame(t0 + k * TICKS_20MS);
    SelectDemux d;
    const std::vector<Out> out = run(d, t.b, 100 * S - 40 * MS);
    const auto units = of_kind(out, Out::Kind::unit);
    bool exact = units.size() == 50, dts = true, dur = true, disc = true;
    for (size_t k = 0; exact && k < units.size(); k++) {
        exact &= units[k]->pts_ns == pts90k_to_ns(t0 + (int64_t)k * TICKS_20MS);
        dts &= units[k]->dts_ns == units[k]->pts_ns;
        dur &= units[k]->dur_ns == 20 * MS && units[k]->payload == s302m(960);
        disc &= units[k]->discont == (k == 0);
    }
    CHECK("formula: one unit per PES, PTS = pts90k_to_ns(PES - 1 h) exactly", exact);
    CHECK("formula: DTS = PTS (302M has none); duration from the AES3 header; the payload",
          dts && dur);
    CHECK("formula: DISCONT on the pad's first unit only", disc);
    CHECK("formula: `found` with the PID before the first unit, nothing else",
          !out.empty() && out[0].kind == Out::Kind::found && out[0].pid == PID_A &&
              of_kind(out, Out::Kind::gap).empty() && out.size() == 51);
    const SelectDemux::Counters c = d.counters();
    CHECK("formula: state found, PID, program, frame 20 ms; counters",
          d.state() == SelectDemux::State::found && d.pid() == PID_A && d.program() == 1 &&
              d.frame_ns() == 20 * MS && c.pes == 50 && c.gaps == 0 && c.cc_lost == 0 &&
              c.pes_dropped_cc == 0 && c.desync_bytes == 0);

    // Any chunking gives the same units.
    bool same = true;
    for (size_t chunk : {(size_t)188, (size_t)1316, (size_t)7, (size_t)1000, (size_t)24576}) {
        SelectDemux e;
        const auto o2 = run(e, t.b, 100 * S - 40 * MS, chunk);
        const auto u2 = of_kind(o2, Out::Kind::unit);
        same &= u2.size() == units.size();
        for (size_t k = 0; same && k < u2.size(); k++)
            same &= u2[k]->pts_ns == units[k]->pts_ns && u2[k]->payload == units[k]->payload &&
                    u2[k]->discont == units[k]->discont;
    }
    CHECK("chunking: 188, 1316, 7, 1000 and 24576-byte feeds give the same units", same);
}

void test_seed() {
    // B-14: 30 h of house time folds the field past 2^33 once; the unwrapped seed lands it.
    const int64_t house = 30 * 3600 * S;
    const int64_t t0 = ns_to_pts90k(house);
    Ts t;
    t.psi_302m();
    for (int k = 0; k < 3; k++) t.frame(t0 + k * TICKS_20MS);
    SelectDemux d;
    const auto units = of_kind(run(d, t.b, house + 5 * MS), Out::Kind::unit);
    CHECK("B-14: at 30 h the PES are 33-bit folded and come out at 30 h, not 26.5 h behind",
          units.size() == 3 && (t0 + MUX_CLOCK_BASE_90K) > PTS_WRAP &&
              units[0]->pts_ns == pts90k_to_ns(t0) && units[2]->pts_ns == pts90k_to_ns(t0 + 3600));
    // The seed is valid within 13 h of the content, either way.
    SelectDemux e;
    const auto late = of_kind(run(e, t.b, house + 12 * 3600 * S), Out::Kind::unit);
    SelectDemux f;
    const auto early = of_kind(run(f, t.b, house - 12 * 3600 * S), Out::Kind::unit);
    CHECK("seed: content 12 h before or after the clock still unwraps to it",
          late.size() == 3 && early.size() == 3 && late[0]->pts_ns == pts90k_to_ns(t0) &&
              early[0]->pts_ns == pts90k_to_ns(t0));
    // No clock: the first PES seeds on its own value (house time taken as the first period).
    SelectDemux g;
    Ts u;
    u.psi_302m();
    u.frame(450000);                          // 5 s
    const auto none = of_kind(run(g, u.b, -1), Out::Kind::unit);
    CHECK("no clock: the PES seeds itself, 1 h + 5 s gives 5 s",
          none.size() == 1 && none[0]->pts_ns == 5 * S);
}

void test_wrap() {
    // A ladder across the 33-bit wrap of the PES field: no step, one frame apart throughout.
    const int64_t wrap_t = PTS_WRAP - MUX_CLOCK_BASE_90K;   // house tick where PES wraps
    const int64_t t0 = wrap_t - 50 * TICKS_20MS;
    Ts t;
    t.psi_302m();
    for (int k = 0; k < 100; k++) t.frame(t0 + k * TICKS_20MS);
    SelectDemux d;
    const auto units = of_kind(run(d, t.b, pts90k_to_ns(t0) + 10 * MS, 1316), Out::Kind::unit);
    bool even = units.size() == 100, crossed = false;
    for (size_t k = 1; even && k < units.size(); k++) {
        const int64_t step = units[k]->pts_ns - units[k - 1]->pts_ns;
        even &= step == 20 * MS;
    }
    if (units.size() == 100)
        crossed = units[49]->pts_ns < pts90k_to_ns(wrap_t) && units[50]->pts_ns ==
                  pts90k_to_ns(wrap_t) && units[99]->pts_ns == pts90k_to_ns(t0 + 99 * TICKS_20MS);
    CHECK("wrap: 100 PES across 2^33, every step 20 ms, the PTS continuous through it",
          even && crossed);
    CHECK("wrap: no gap", d.counters().gaps == 0);
}

void test_jump() {
    const int64_t t0 = 9000000;
    Ts t;
    t.psi_302m();
    for (int k = 0; k < 10; k++) t.frame(t0 + k * TICKS_20MS);
    const int64_t hole_at = t0 + 10 * TICKS_20MS;          // where the 11th frame would be
    t.frame(hole_at + 45000);                               // 500 ms of nothing, CC unbroken
    t.frame(hole_at + 45000 + TICKS_20MS);
    SelectDemux d;
    const std::vector<Out> out = run(d, t.b, 100 * S);
    const auto gaps = of_kind(out, Out::Kind::gap);
    const auto units = of_kind(out, Out::Kind::unit);
    CHECK("jump: a 500 ms hole gives one GAP of exactly 500 ms from the last frame's end",
          gaps.size() == 1 && gaps[0]->pts_ns == pts90k_to_ns(hole_at) &&
              gaps[0]->dur_ns == 500 * MS && std::string(gaps[0]->reason) == "jump");
    bool order = false;
    for (size_t i = 0; i + 1 < out.size(); i++)
        if (out[i].kind == Out::Kind::gap)
            order = out[i + 1].kind == Out::Kind::unit && out[i + 1].discont &&
                    out[i + 1].pts_ns == pts90k_to_ns(hole_at + 45000);
    CHECK("jump: the GAP comes right before the unit after the hole, which is DISCONT", order);
    CHECK("jump: 12 units, gaps 1, the next unit not DISCONT",
          units.size() == 12 && !units[11]->discont && d.counters().gaps == 1);

    // The threshold: a hole of exactly two frames is none, a tick more is one.
    for (const int64_t extra : {(int64_t)0, (int64_t)1}) {
        Ts u;
        u.psi_302m();
        for (int k = 0; k < 5; k++) u.frame(t0 + k * TICKS_20MS);
        u.frame(t0 + 5 * TICKS_20MS + 2 * TICKS_20MS + extra);
        SelectDemux e;
        const auto g = of_kind(run(e, u.b, 100 * S), Out::Kind::gap);
        if (extra == 0)
            CHECK("jump: a hole of exactly two frames is no gap", g.empty());
        else
            CHECK("jump: two frames and a tick is a gap", g.size() == 1);
    }
    // No test before two spacings are known.
    Ts v;
    v.psi_302m();
    v.frame(t0);
    v.frame(t0 + TICKS_20MS + 45000);
    SelectDemux f;
    CHECK("jump: no test before two spacings are known",
          of_kind(run(f, v.b, 100 * S), Out::Kind::gap).empty() && f.frame_ns() == -1);
    // A cadence rise is no hole: the end is the AES3 duration (B-21's false-marker case).
    Ts w;
    w.psi_302m();
    int64_t at = t0;
    for (int k = 0; k < 6; k++, at += 960) w.frame(at, 512);     // 512 frames = 960 ticks
    for (int k = 0; k < 6; k++, at += 3840) w.frame(at, 2048);   // 2048 frames = 3840 ticks
    SelectDemux g;
    const auto wo = run(g, w.b, 100 * S);
    CHECK("jump: a cadence rise 512 -> 2048 frames gives no gap",
          of_kind(wo, Out::Kind::gap).empty() && of_kind(wo, Out::Kind::unit).size() == 12);
    // Without an AES3 duration (no whole 302M frame) the end is one learned frame, and a jump's
    // own spacing joins the median (B-21), so a lasting rise is learned: 4 gaps, then none.
    Ts j;
    j.psi_302m();
    at = t0;
    const std::vector<uint8_t> junk(300, 0x5A);
    for (int k = 0; k < 9; k++, at += TICKS_20MS)
        j.pes(PID_A, (at + MUX_CLOCK_BASE_90K) % PTS_WRAP, junk);
    for (int k = 0; k < 12; k++, at += 4 * TICKS_20MS)
        j.pes(PID_A, (at + MUX_CLOCK_BASE_90K) % PTS_WRAP, junk);
    SelectDemux jd;
    const auto jo = run(jd, j.b, 100 * S);
    const auto jg = of_kind(jo, Out::Kind::gap);
    CHECK("jump: no duration, a lasting 20 -> 80 ms rise: 4 gaps, then the rise is learned",
          jg.size() == 4 && jd.frame_ns() == 80 * MS && of_kind(jo, Out::Kind::unit).size() == 21);
    // The frame is the upper median: the longer of two.
    Ts m2;
    m2.psi_302m();
    m2.frame(t0);
    m2.frame(t0 + TICKS_20MS);
    m2.frame(t0 + TICKS_20MS + 2700);
    SelectDemux md;
    run(md, m2.b, 100 * S);
    CHECK("frame: the upper median of the spacings (20 and 30 ms: 30)", md.frame_ns() == 30 * MS);
    // A backward step is no hole either.
    Ts x;
    x.psi_302m();
    for (int k = 0; k < 5; k++) x.frame(t0 + k * TICKS_20MS);
    x.frame(t0);
    SelectDemux h;
    const auto xo = run(h, x.b, 100 * S);
    CHECK("jump: a backward step is no gap and is emitted at its own PTS",
          of_kind(xo, Out::Kind::gap).empty() && of_kind(xo, Out::Kind::unit).size() == 6 &&
              of_kind(xo, Out::Kind::unit)[5]->pts_ns == pts90k_to_ns(t0));
}

void test_cc_loss() {
    const int64_t t0 = 9000000;
    Ts t;
    t.psi_302m();
    for (int k = 0; k < 4; k++) t.frame(t0 + k * TICKS_20MS);
    const size_t cut = t.b.size() + 3 * PKT;   // a packet inside the 5th PES
    for (int k = 4; k < 8; k++) t.frame(t0 + k * TICKS_20MS);
    std::vector<uint8_t> lost(t.b.begin(), t.b.begin() + (std::ptrdiff_t)cut);
    lost.insert(lost.end(), t.b.begin() + (std::ptrdiff_t)(cut + PKT), t.b.end());
    SelectDemux d;
    const std::vector<Out> out = run(d, lost, 100 * S);
    const auto units = of_kind(out, Out::Kind::unit);
    CHECK("cc loss: the PES it cut is dropped, the next unit DISCONT",
          units.size() == 7 && units[4]->pts_ns == pts90k_to_ns(t0 + 5 * TICKS_20MS) &&
              units[4]->discont && !units[3]->discont && !units[5]->discont);
    const SelectDemux::Counters c = d.counters();
    CHECK("cc loss: cc-lost 1, pes-dropped-cc 1, and no gap for one missing frame",
          c.cc_lost == 1 && c.pes_dropped_cc == 1 && c.gaps == 0);

    // Three PES lost to one CC jump: a hole past two frames, so a gap too.
    Ts u;
    u.psi_302m();
    for (int k = 0; k < 4; k++) u.frame(t0 + k * TICKS_20MS);
    const size_t from = u.b.size();
    for (int k = 4; k < 7; k++) u.frame(t0 + k * TICKS_20MS);
    const size_t to = u.b.size();
    for (int k = 7; k < 10; k++) u.frame(t0 + k * TICKS_20MS);
    std::vector<uint8_t> gone(u.b.begin(), u.b.begin() + (std::ptrdiff_t)from);
    gone.insert(gone.end(), u.b.begin() + (std::ptrdiff_t)to, u.b.end());
    SelectDemux e;
    const std::vector<Out> o2 = run(e, gone, 100 * S);
    const auto g2 = of_kind(o2, Out::Kind::gap);
    CHECK("cc loss: three frames lost give a GAP of 60 ms and a DISCONT unit",
          g2.size() == 1 && g2[0]->dur_ns == 60 * MS && e.counters().cc_lost == 1 &&
              of_kind(o2, Out::Kind::unit)[4]->discont);

    // A spacing across a loss is no frame: three 40 ms ones leave the frame at 20 ms, so a
    // 50 ms hole after them is still a gap (learned, the median would be 40 ms: none).
    Ts w;
    w.psi_302m();
    int64_t at = t0;
    for (int k = 0; k < 3; k++, at += TICKS_20MS) w.frame(at);
    std::vector<uint8_t> lossy = w.b;
    for (int k = 0; k < 3; k++) {
        w.b.clear();
        w.frame(at);                          // lost whole: the CC jump shows at the next
        at += TICKS_20MS;
        w.b.clear();
        w.frame(at);
        lossy.insert(lossy.end(), w.b.begin(), w.b.end());
        at += TICKS_20MS;
    }
    w.b.clear();
    w.frame(at + 4500);
    lossy.insert(lossy.end(), w.b.begin(), w.b.end());
    SelectDemux f;
    const auto g3 = of_kind(run(f, lossy, 100 * S), Out::Kind::gap);
    CHECK("spacing: none across a CC loss is learned; a 50 ms hole after three is a gap",
          f.counters().cc_lost == 3 && f.frame_ns() == 20 * MS && g3.size() == 1 &&
              g3[0]->dur_ns == 50 * MS);
}

void test_spacing_across_markers() {
    // Nor across a marker's GAP (an outage's or an edit's spacing): three 40 ms ones.
    const int64_t t0 = 9000000;
    Ts x;
    x.psi_302m();
    int64_t at = t0;
    for (int k = 0; k < 3; k++, at += TICKS_20MS) x.frame(at);
    SelectDemux d;
    std::vector<Out> out = run(d, x.b, 100 * S);
    for (int k = 0; k < 3; k++) {
        const auto m = marker_packet(PID_A, x.last_cc(PID_A), 20 * MS);
        d.marker(m.data(), m.size(), pts90k_to_ns(at) + 20 * MS, out);
        at += TICKS_20MS;
        x.b.clear();
        x.frame(at);
        const auto o = run(d, x.b, 100 * S);
        out.insert(out.end(), o.begin(), o.end());
        at += TICKS_20MS;
    }
    x.b.clear();
    x.frame(at + 4500);
    const auto g = of_kind(run(d, x.b, 100 * S), Out::Kind::gap);
    CHECK("spacing: none across a marker is learned; a 50 ms hole after three is a gap",
          of_kind(out, Out::Kind::gap).size() == 3 && d.frame_ns() == 20 * MS && g.size() == 1 &&
              g[0]->dur_ns == 50 * MS && std::string(g[0]->reason) == "jump");
}

void test_markers() {
    const int64_t t0 = 9000000;
    const int64_t t_end = pts90k_to_ns(t0 + 5 * TICKS_20MS);   // the 5th frame's end
    Ts t;
    t.psi_302m();
    for (int k = 0; k < 5; k++) t.frame(t0 + k * TICKS_20MS);
    const uint8_t cc = t.last_cc(PID_A);

    {   // On the selected PID, past what the pad emitted: a GAP of its length.
        SelectDemux d;
        std::vector<Out> out = run(d, t.b, 100 * S);
        out.clear();
        const auto m = marker_packet(PID_A, cc, 300 * MS);
        d.marker(m.data(), m.size(), t_end + 400 * MS, out);
        CHECK("marker: [end - length, end) when it starts past the last PES",
              out.size() == 1 && out[0].kind == Out::Kind::gap &&
                  out[0].pts_ns == t_end + 100 * MS && out[0].dur_ns == 300 * MS &&
                  std::string(out[0].reason) == "marker");
        // The next unit after it is DISCONT and no jump gap repeats the hole.
        Ts n = t;
        n.b.clear();
        n.frame(ns_to_pts90k(t_end + 400 * MS));
        out = run(d, n.b, 100 * S);
        CHECK("marker: the unit after it is DISCONT, no jump GAP for the same hole",
              out.size() == 1 && out[0].kind == Out::Kind::unit && out[0].discont);
        const SelectDemux::Counters c = d.counters();
        CHECK("marker: counted (markers 1, dropped 0, gaps 1)",
              c.markers == 1 && c.markers_dropped == 0 && c.gaps == 1);
    }
    {   // Overlapping the last PES: trimmed to its end (B-21).
        SelectDemux d;
        std::vector<Out> out = run(d, t.b, 100 * S);
        out.clear();
        const auto m = marker_packet(PID_A, cc, 50 * MS);
        d.marker(m.data(), m.size(), t_end + 30 * MS, out);
        CHECK("marker: one overlapping the last PES starts at its end",
              out.size() == 1 && out[0].pts_ns == t_end && out[0].dur_ns == 30 * MS);
    }
    {   // Inside the last PES (a cadence rise's false marker): dropped.
        SelectDemux d;
        std::vector<Out> out = run(d, t.b, 100 * S);
        out.clear();
        const auto m = marker_packet(PID_A, cc, 15 * MS);
        d.marker(m.data(), m.size(), t_end - 2 * MS, out);
        d.marker(m.data(), m.size(), t_end, out);
        const SelectDemux::Counters c = d.counters();
        CHECK("marker: ones ending inside or at the last PES's end are dropped",
              out.empty() && c.markers == 2 && c.markers_dropped == 2 && c.gaps == 0);
    }
    {   // Other PIDs, the PCR PID among them, and unplaced ones.
        Ts v;
        v.pat();
        v.pmt({{PID_V, 0x1B, {}}, {PID_A, 0x06, BSSD}}, PID_V);
        for (int k = 0; k < 5; k++) v.frame(t0 + k * TICKS_20MS);
        SelectDemux d;
        std::vector<Out> out = run(d, v.b, 100 * S);
        out.clear();
        std::vector<uint8_t> buf = marker_packet(PID_V, 3, 500 * MS);   // the PCR PID
        const auto other = marker_packet(0x1FF, 3, 500 * MS);
        buf.insert(buf.end(), other.begin(), other.end());
        d.marker(buf.data(), buf.size(), t_end + 600 * MS, out);
        CHECK("marker: ones for other PIDs, the PCR PID's included, are ignored",
              out.empty() && d.counters().markers == 0);
        const auto mine = marker_packet(PID_A, 0, 100 * MS);
        d.marker(mine.data(), mine.size(), -1, out);
        CHECK("marker: one with no placeable PTS is counted and dropped",
              out.empty() && d.counters().markers == 1 && d.counters().markers_dropped == 1);
        // A marker buffer holding the selected PID among others: only that packet counts.
        buf.insert(buf.end(), mine.begin(), mine.end());
        d.marker(buf.data(), buf.size(), t_end + 600 * MS, out);
        CHECK("marker: in a buffer of several PIDs only the selected one's packet counts",
              out.size() == 1 && out[0].pts_ns == t_end + 500 * MS &&
                  out[0].dur_ns == 100 * MS && d.counters().markers == 2);
    }
    {   // Outage markers: every 250 ms from the same start; the gaps never overlap.
        SelectDemux d;
        std::vector<Out> out = run(d, t.b, 100 * S);
        out.clear();
        for (int i = 0; i < 4; i++) {
            const int64_t end = t_end + 1000 * MS + i * 250 * MS;
            const auto m = marker_packet(PID_A, cc, end - t_end);
            d.marker(m.data(), m.size(), end, out);
        }
        bool tiled = out.size() == 4 && out[0].pts_ns == t_end && out[0].dur_ns == 1000 * MS;
        for (size_t i = 1; tiled && i < out.size(); i++)
            tiled &= out[i].pts_ns == out[i - 1].pts_ns + out[i - 1].dur_ns &&
                     out[i].dur_ns == 250 * MS;
        CHECK("marker: an outage's repeated markers tile the timeline, never overlapping", tiled);
    }
    {   // Before any PES, once the stream is known: the whole gap.
        Ts p;
        p.psi_302m();
        SelectDemux d;
        std::vector<Out> out = run(d, p.b, 100 * S);
        out.clear();
        const auto m = marker_packet(PID_A, 0, 250 * MS);
        d.marker(m.data(), m.size(), 100 * S, out);
        CHECK("marker: before the stream's first PES, the gap as given",
              out.size() == 1 && out[0].pts_ns == 100 * S - 250 * MS && out[0].dur_ns == 250 * MS);
        SelectDemux e;                        // no PMT yet: nothing is ours
        out.clear();
        e.marker(m.data(), m.size(), 100 * S, out);
        CHECK("marker: with no stream selected, ignored", out.empty() && e.counters().markers == 0);
    }
}

void test_no_stream() {
    Ts t;
    t.pat();
    t.pmt({{PID_V, 0x1B, {}}, {PID_B, 0x0F, {}}}, PID_V);
    SelectDemux d;
    std::vector<Out> out;
    int64_t now = 50 * S;
    d.feed(t.b.data(), t.b.size(), false, now, out);
    CHECK("no stream: a PMT without 302M is `missing`, no warning yet",
          d.state() == SelectDemux::State::missing && out.empty() && d.pid() == -1);
    for (now = 50 * S + 100 * MS; now < 52 * S; now += 100 * MS)
        d.feed(t.b.data(), t.b.size(), false, now, out);
    CHECK("no stream: none within 2 s of the first PMT", out.empty());
    d.feed(t.b.data(), t.b.size(), false, 52 * S, out);
    CHECK("no stream: one `no_stream` at 2 s", out.size() == 1 && out[0].kind ==
                                                   Out::Kind::no_stream);
    out.clear();
    for (now = 52 * S; now < 60 * S; now += 500 * MS)
        d.feed(t.b.data(), t.b.size(), false, now, out);
    CHECK("no stream: only one per episode", out.empty());
    // A new PMT version adds the stream: found; it goes again: a new episode.
    Ts u = t;
    u.b.clear();
    u.pmt({{PID_V, 0x1B, {}}, {PID_A, 0x06, BSSD}}, PID_V, 1);
    d.feed(u.b.data(), u.b.size(), false, 60 * S, out);
    CHECK("no stream: a later PMT with the stream finds it",
          out.size() == 1 && out[0].kind == Out::Kind::found &&
              d.state() == SelectDemux::State::found);
    out.clear();
    Ts w = u;
    w.b.clear();
    w.pmt({{PID_V, 0x1B, {}}}, PID_V, 2);
    d.feed(w.b.data(), w.b.size(), false, 61 * S, out);
    d.feed(w.b.data(), w.b.size(), false, 62 * S, out);
    CHECK("no stream: the stream gone again is missing, no warning before 2 s",
          out.empty() && d.state() == SelectDemux::State::missing && d.pid() == -1);
    d.feed(w.b.data(), w.b.size(), false, 63 * S, out);
    CHECK("no stream: the new episode warns once at 2 s",
          out.size() == 1 && out[0].kind == Out::Kind::no_stream);
    // No PMT at all: waiting, never a warning.
    SelectDemux e;
    out.clear();
    Ts pat_only;
    pat_only.pat();
    for (now = 0; now < 10 * S; now += S)
        e.feed(pat_only.b.data(), pat_only.b.size(), false, now, out);
    CHECK("no stream: no PMT is `waiting`, with no warning",
          out.empty() && e.state() == SelectDemux::State::waiting);
}

void test_programs_and_pid_change() {
    const int64_t t0 = 9000000;
    Ts t;
    t.pat({{1, 0x100}, {2, 0x200}});
    t.pmt({{PID_B, 0x0F, {}}}, PID_B, 0, 0x100, 1);
    t.pmt({{PID_A, 0x06, BSSD}}, PID_A, 0, 0x200, 2);
    for (int k = 0; k < 3; k++) t.frame(t0 + k * TICKS_20MS);
    SelectDemux first;
    run(first, t.b, 100 * S);
    SelectDemux::Config cfg;
    cfg.program = 2;
    SelectDemux second(cfg);
    const auto units = of_kind(run(second, t.b, 100 * S), Out::Kind::unit);
    CHECK("program-number -1 follows the PAT's first program (no 302M there)",
          first.state() == SelectDemux::State::missing && first.program() == 1);
    CHECK("program-number 2 follows the second, whose 302M comes out",
          second.state() == SelectDemux::State::found && second.program() == 2 &&
              second.pid() == PID_A && units.size() == 3);

    // The PMT moves the stream to another PID: found again, the new PID's first unit DISCONT.
    Ts u;
    u.psi_302m(PID_A, 0);
    for (int k = 0; k < 3; k++) u.frame(t0 + k * TICKS_20MS, 960, PID_A);
    u.pmt({{PID_B, 0x06, BSSD}}, PID_B, 1);
    for (int k = 3; k < 6; k++) u.frame(t0 + k * TICKS_20MS, 960, PID_B);
    SelectDemux d;
    const std::vector<Out> out = run(d, u.b, 100 * S);
    const auto found = of_kind(out, Out::Kind::found);
    const auto u2 = of_kind(out, Out::Kind::unit);
    CHECK("pid change: found on 0x41, then on 0x42; six units, the 4th DISCONT",
          found.size() == 2 && found[1]->pid == PID_B && u2.size() == 6 && u2[3]->discont &&
              u2[3]->pid == PID_B && !u2[4]->discont && d.pid() == PID_B);
    // The new stream seeds anew from the clock: here its content is 20 h after the old's.
    const int64_t t20 = t0 + 20LL * 3600 * 90000;
    Ts v;
    v.psi_302m(PID_A, 0);
    v.frame(t0, 960, PID_A);
    SelectDemux e;
    run(e, v.b, 100 * S);
    v.b.clear();
    v.pmt({{PID_B, 0x06, BSSD}}, PID_B, 1);
    v.frame(t20, 960, PID_B);
    const auto far = of_kind(run(e, v.b, pts90k_to_ns(t20)), Out::Kind::unit);
    CHECK("pid change: the new PID seeds on the clock, not on the old stream's last PTS",
          far.size() == 1 && far[0]->pts_ns == pts90k_to_ns(t20));
}

void test_discont_drain_flush() {
    const int64_t t0 = 9000000;
    Ts t;
    t.psi_302m();
    size_t third = 0;
    for (int k = 0; k < 4; k++) {
        if (k == 2) third = t.b.size() + 5 * PKT;
        t.frame(t0 + k * TICKS_20MS);
    }
    // A bus DISCONT in the middle of the 3rd PES: it is dropped, the 4th is DISCONT.
    SelectDemux d;
    std::vector<Out> out;
    d.feed(t.b.data(), third, false, 100 * S, out);
    d.feed(t.b.data() + third, t.b.size() - third, true, 100 * S, out);
    const auto units = of_kind(out, Out::Kind::unit);
    CHECK("bus discont: the open PES is dropped and the next unit is DISCONT",
          units.size() == 3 && units[2]->pts_ns == pts90k_to_ns(t0 + 3 * TICKS_20MS) &&
              units[2]->discont);

    // An unbounded PES leaves at the next PUSI, or at EOS.
    Ts u;
    u.psi_302m();
    u.pes(PID_A, (t0 + MUX_CLOCK_BASE_90K) % PTS_WRAP, s302m(960), false);
    SelectDemux e;
    out = run(e, u.b, 100 * S);
    const bool held = of_kind(out, Out::Kind::unit).empty();
    out.clear();
    e.drain(out);
    CHECK("drain: an unbounded PES is held, then out at EOS",
          held && out.size() == 1 && out[0].kind == Out::Kind::unit &&
              out[0].pts_ns == pts90k_to_ns(t0) && out[0].payload == s302m(960));

    // Flush: the next unit DISCONT, the horizon forgotten (a marker is not trimmed by it).
    SelectDemux f;
    out = run(f, t.b, 100 * S);
    f.flush();
    out.clear();
    Ts again;                                 // as after a seek: the CC starts afresh
    again.frame(t0);
    std::vector<Out> o2 = run(f, again.b, 100 * S);
    CHECK("flush: the next unit is DISCONT at its own PTS; a fresh CC is no loss",
          o2.size() == 1 && o2[0].discont && o2[0].pts_ns == pts90k_to_ns(t0) &&
              f.counters().cc_lost == 0);
    std::vector<Out> o3;
    f.flush();
    const auto m = marker_packet(PID_A, 0, 40 * MS);
    f.marker(m.data(), m.size(), pts90k_to_ns(t0) + 20 * MS, o3);
    CHECK("flush: a marker after it is not trimmed by the old horizon",
          o3.size() == 1 && o3[0].pts_ns == pts90k_to_ns(t0) - 20 * MS && o3[0].dur_ns == 40 * MS);
}

void test_no_pts() {
    Ts t;
    t.psi_302m();
    t.frame(9000000);
    t.frame(9000000 + TICKS_20MS);
    t.pes(PID_A, -1, s302m(960));
    t.frame(9000000 + 3 * TICKS_20MS);
    SelectDemux d;
    const auto units = of_kind(run(d, t.b, 100 * S), Out::Kind::unit);
    CHECK("no PTS: out untimed, counted as pes-no-pts",
          units.size() == 4 && units[2]->pts_ns == -1 && units[2]->dts_ns == -1 &&
              d.counters().pes_no_pts == 1 &&
              units[3]->pts_ns == pts90k_to_ns(9000000 + 3 * TICKS_20MS));
    CHECK("no PTS: the spacing across it is not learned (one spacing: no frame yet)",
          d.frame_ns() == -1);
}

}  // namespace

int main() {
    test_select_and_frames();
    test_const_walk();
    test_formula();
    test_seed();
    test_wrap();
    test_jump();
    test_cc_loss();
    test_spacing_across_markers();
    test_markers();
    test_no_stream();
    test_programs_and_pid_change();
    test_discont_drain_flush();
    test_no_pts();
    return test_summary("ts_select");
}
