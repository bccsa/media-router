// The fan-out's rebase onto house time (plan ch. 6 WI-P2-5): the anchor, one
// shift for every PID, PCR, re-anchors, the reference PID, what is dropped
// before the anchor, split headers and chunking. No sockets.
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "../house_rebase.h"
#include "mrts/tests/check.h"
#include "mrts/ts_house.h"
#include "mrts/ts_pcr.h"
#include "mrts/ts_pes.h"
#include "mrts/ts_psi.h"

using mrfanout::HouseRebase;
using Bytes = std::vector<uint8_t>;

namespace {

constexpr int PKT = mrts::PKT;
constexpr int VID = 0x100, AUD = 0x101, SUB = 0x110, PMT_PID = 0x1000;
constexpr int64_t STEP = 3600;                     // 40 ms
constexpr int64_t AFRAME = 1920;                   // one 48 kHz AAC frame
constexpr int64_t SEC = 1000000000LL;
constexpr int64_t T0 = 5000 * SEC;                 // house now at the start
constexpr int64_t P0 = 8100000;                    // the source's first video PTS

int64_t mod33(int64_t v) {
    const int64_t r = v % mrts::PTS_WRAP;
    return r < 0 ? r + mrts::PTS_WRAP : r;
}
int64_t mod_pcr(int64_t v) {
    const int64_t r = v % mrts::PCR_MODULO;
    return r < 0 ? r + mrts::PCR_MODULO : r;
}
// What a bus PTS written at house `ns` reads back as (90 kHz floor).
int64_t house_of(int64_t ns) { return mrts::pts90k_to_ns(mrts::ns_to_pts90k(ns)); }

// A stream builder: one CC counter per PID, packets appended in order.
struct Ts {
    Bytes b;
    uint8_t cc[8192] = {};

    uint8_t* add(int pid, bool pusi, int afc) {
        b.resize(b.size() + PKT, 0xAA);
        uint8_t* p = b.data() + b.size() - PKT;
        p[0] = 0x47;
        p[1] = (uint8_t)((pusi ? 0x40 : 0) | ((pid >> 8) & 0x1F));
        p[2] = (uint8_t)(pid & 0xFF);
        const uint8_t c = (afc & 1) ? cc[pid]++ & 0x0F : (uint8_t)((cc[pid] - 1) & 0x0F);
        p[3] = (uint8_t)((afc << 4) | c);
        return p;
    }
    // A PES start; `af` adaptation bytes (flags included) before it, with a PCR when pcr >= 0.
    void pes(int pid, uint8_t sid, int64_t pts, int64_t dts = -1, int64_t pcr = -1, int af = -1) {
        if (af < 0) af = pcr >= 0 ? 7 : 0;
        uint8_t* p = add(pid, true, af > 0 ? 3 : 1);
        int off = 4;
        if (af > 0) {
            p[4] = (uint8_t)af;
            p[5] = pcr >= 0 ? 0x10 : 0x00;
            std::memset(p + 6, 0xFF, af - 1);
            if (pcr >= 0) mrts::write_pcr(p, pcr);
            off = 5 + af;
        }
        uint8_t e[19] = {0, 0, 1, sid, 0, 0, 0x80, (uint8_t)(dts >= 0 ? 0xC0 : 0x80),
                         (uint8_t)(dts >= 0 ? 10 : 5), (uint8_t)(dts >= 0 ? 0x30 : 0x20)};
        mrts::write_pes_ts_field(e + 9, pts);
        if (dts >= 0) {
            e[14] = 0x10;
            mrts::write_pes_ts_field(e + 14, dts);
        }
        const int n = std::min(dts >= 0 ? 19 : 14, PKT - off);
        std::memcpy(p + off, e, n);
        if (n < (dts >= 0 ? 19 : 14)) spill.assign(e + n, e + (dts >= 0 ? 19 : 14));
    }
    // The next payload packet of `pid`; it starts with what a split header left over.
    void cont(int pid) {
        uint8_t* p = add(pid, false, 1);
        std::memcpy(p + 4, spill.data(), spill.size());
        spill.clear();
    }
    void pcr(int pid, int64_t pcr27) {
        uint8_t* p = add(pid, false, 2);
        mrts::build_pcr_packet(pid, pcr27, p[3] & 0x0F, false, p);
    }
    void af_only(int pid) {                        // adaptation only, no PCR
        uint8_t* p = add(pid, false, 2);
        p[4] = 183;
        p[5] = 0x00;
        std::memset(p + 6, 0xFF, PKT - 6);
    }
    void null() { add(mrts::PID_NULL, false, 1); }
    void psi(int pcr_pid) {
        uint8_t pkt[PKT];
        mrts::build_pat(1, {{1, PMT_PID}}, cc[0]++ & 0x0F, 0, pkt);
        b.insert(b.end(), pkt, pkt + PKT);
        mrts::build_pmt(PMT_PID, 1, pcr_pid,
                        {{VID, mrts::STREAM_TYPE_AVC, {}}, {AUD, mrts::STREAM_TYPE_AAC, {}},
                         {SUB, mrts::STREAM_TYPE_PRIVATE_PES, {}}},
                        cc[PMT_PID]++ & 0x0F, 0, pkt);
        b.insert(b.end(), pkt, pkt + PKT);
    }
    Bytes take() {
        Bytes out;
        out.swap(b);
        return out;
    }
    Bytes spill;
};

struct Seen {
    int pid = -1;
    bool pusi = false, di = false;
    int64_t pts = -1, dts = -1, pcr = -1;
};

std::vector<Seen> scan(const Bytes& out) {
    std::vector<Seen> s;
    for (size_t off = 0; off + PKT <= out.size(); off += PKT) {
        Bytes copy(out.begin() + off, out.begin() + off + PKT);
        mrts::PacketView v;
        Seen e;
        if (!mrts::parse_packet(copy.data(), &v)) {
            s.push_back(e);
            continue;
        }
        e.pid = v.pid;
        e.pusi = v.pusi;
        e.di = v.af_discontinuity;
        if (v.af_pcr) e.pcr = mrts::read_pcr(copy.data());
        mrts::PesHeader h;
        const uint8_t* pes = copy.data() + v.payload_off;
        if (v.pusi && v.payload_off < PKT && mrts::parse_pes_header(pes, PKT - v.payload_off, &h) &&
            h.complete) {
            e.pts = h.pts;
            e.dts = h.dts;
        }
        s.push_back(e);
    }
    return s;
}

// One chunk through the rebase.
Bytes run(HouseRebase& r, const Bytes& in, int64_t now) {
    Bytes out;
    r.process(in.data(), in.size(), now, out);
    return out;
}

// Every byte but the PTS/DTS fields and the PCR equal (the DI flag compared apart).
bool same_but_time(const Bytes& a, const Bytes& b) {
    if (a.size() != b.size()) return false;
    for (size_t off = 0; off + PKT <= a.size(); off += PKT) {
        Bytes x(a.begin() + off, a.begin() + off + PKT), y(b.begin() + off, b.begin() + off + PKT);
        for (Bytes* z : {&x, &y}) {
            mrts::PacketView v;
            mrts::parse_packet(z->data(), &v);
            if (v.af_len >= 1) (*z)[5] &= 0x7F;
            if (v.af_pcr) std::memset(z->data() + 6, 0, 6);
            mrts::PesHeader h;
            if (v.pusi && v.payload_off < PKT &&
                mrts::parse_pes_header(z->data() + v.payload_off, PKT - v.payload_off, &h) &&
                h.complete) {
                if (h.pts_off >= 0) std::memset(z->data() + v.payload_off + h.pts_off, 0, 5);
                if (h.dts_off >= 0) std::memset(z->data() + v.payload_off + h.dts_off, 0, 5);
            }
        }
        if (x != y) return false;
    }
    return true;
}

// An A/V rung: video (PCR in its AF, B-frame order: DTS 2 frames before PTS), one audio PES.
void av_rung(Ts& ts, int64_t vpts, int64_t apts, int64_t lead = 2 * STEP) {
    ts.pes(VID, 0xE0, vpts, mod33(vpts - lead), mod_pcr((vpts - lead - 9000) * 300));
    ts.pes(AUD, 0xC0, apts);
    ts.null();
}

// The same with two audio PES half a frame apart, `ahead` of them muxed before the video.
void av2_rung(Ts& ts, int64_t vpts, int64_t apts, int ahead = 0) {
    for (int k = 0; k <= 2; k++) {
        if (k == ahead)
            ts.pes(VID, 0xE0, vpts, mod33(vpts - 2 * STEP),
                   mod_pcr((vpts - 2 * STEP - 9000) * 300));
        if (k < 2) ts.pes(AUD, 0xC0, mod33(apts + k * (STEP / 2)));
    }
}

// What left, in order: the video and audio PES PTS, the video PID's PCRs and their flag.
struct Tracks {
    std::vector<int64_t> v, a, pcr;
    std::vector<bool> di;
    void add(const Bytes& out) {
        for (const Seen& e : scan(out)) {
            if (e.pid == VID && e.pts >= 0) v.push_back(e.pts);
            if (e.pid == AUD && e.pts >= 0) a.push_back(e.pts);
            if (e.pid == VID && e.pcr >= 0) {
                pcr.push_back(e.pcr);
                di.push_back(e.di);
            }
        }
    }
};

void test_anchor() {
    HouseRebase r;
    Ts ts;
    ts.psi(VID);
    av_rung(ts, P0, P0 + 100);
    const Bytes in = ts.take();
    const Bytes out = run(r, in, T0);
    const auto s = scan(out);
    CHECK("anchor: every packet out, in order", out.size() == in.size() && s.size() == 5);
    CHECK("anchor: the first timing PES's PTS lands at house now",
          s[2].pid == VID && mrts::house_from_mux_pts(s[2].pts, T0) == house_of(T0));
    CHECK("anchor: DTS keeps its distance", mod33(s[2].pts - s[2].dts) == 2 * STEP);
    const int64_t shift = mod33(s[2].pts - P0);
    CHECK("anchor: PCR moved by the same shift, 27 MHz",
          s[2].pcr == mod_pcr((P0 - 2 * STEP - 9000) * 300 + shift * 300));
    CHECK("anchor: audio moved by the same shift", s[3].pts == mod33(P0 + 100 + shift));
    CHECK("anchor: no discontinuity flagged", !s[2].di);
    CHECK("anchor: PSI and stuffing untouched",
          std::equal(in.begin(), in.begin() + 2 * PKT, out.begin()) &&
              std::equal(in.end() - PKT, in.end(), out.end() - PKT));
    const auto st = r.stats();
    CHECK("anchor: stats", st.anchored && st.reanchors == 0 && st.dropped == 0 &&
                               mod33(st.shift_90k) == shift);
    mrts::IdentityStamp id;
    CHECK("anchor: the identity stamp of the output is house now",
          id.stamp(out.data(), out.size(), T0) == house_of(T0));
}

void test_one_shift() {
    HouseRebase r;
    Ts ts;
    std::vector<Bytes> ins, outs;
    int64_t now = T0;
    for (int i = 0; i < 60; i++) {
        if (i % 10 == 0) ts.psi(VID);
        av_rung(ts, P0 + i * STEP, P0 + 300 + i * AFRAME);
        ins.push_back(ts.take());
        outs.push_back(run(r, ins.back(), now));
        now += (i * 7919) % 50 * 1000000LL;        // irregular arrival, ahead or behind
    }
    const int64_t shift = mod33(scan(outs[0])[2].pts - P0);
    bool same = true, pts_ok = true, dts_ok = true, pcr_ok = true, di = false;
    int pes = 0, pcrs = 0;
    for (size_t k = 0; k < ins.size(); k++) {
        const auto a = scan(ins[k]), b = scan(outs[k]);
        same = same && same_but_time(ins[k], outs[k]);
        for (size_t j = 0; j < a.size() && j < b.size(); j++) {
            if (a[j].pts >= 0) {
                pes++;
                pts_ok = pts_ok && b[j].pts == mod33(a[j].pts + shift);
            }
            if (a[j].dts >= 0) dts_ok = dts_ok && b[j].dts == mod33(a[j].dts + shift);
            if (a[j].pcr >= 0) {
                pcrs++;
                pcr_ok = pcr_ok && b[j].pcr == mod_pcr(a[j].pcr + shift * 300);
            }
            di = di || b[j].di;
        }
    }
    CHECK("one shift: 60 chunks, arrival jitter, bytes equal but the time fields", same);
    CHECK("one shift: every PTS of both PIDs moved by one constant", pts_ok && pes == 120);
    CHECK("one shift: every DTS by the same", dts_ok);
    CHECK("one shift: every PCR by 300 times it", pcr_ok && pcrs == 60);
    CHECK("one shift: no PCR flagged, no re-anchor", !di && r.stats().reanchors == 0);
}

void test_wrap() {
    HouseRebase r;
    Ts ts;
    const int64_t first = mrts::PTS_WRAP - 3 * STEP;
    std::vector<int64_t> pts;
    for (int i = 0; i < 8; i++) {
        av_rung(ts, mod33(first + i * STEP), mod33(first + 100 + i * STEP));
        for (const Seen& e : scan(run(r, ts.take(), T0 + i * 40 * 1000000LL)))
            if (e.pid == VID && e.pts >= 0) pts.push_back(e.pts);
    }
    bool steps = pts.size() == 8;
    for (size_t i = 1; i < pts.size(); i++) steps = steps && mod33(pts[i] - pts[i - 1]) == STEP;
    CHECK("wrap: a legal 2^33 wrap is one continuous timeline", steps && r.stats().reanchors == 0);
}

// The source loops back to near zero, delivered ahead of house time.
void test_loop_reanchor() {
    HouseRebase r;
    Ts ts;
    std::vector<Seen> seen;
    std::vector<int64_t> stamps;
    mrts::IdentityStamp id;
    for (int i = 0; i < 16; i++) {
        const int64_t src = i < 6 ? P0 + i * STEP : 4500 + (i - 6) * STEP;
        av_rung(ts, src, src + 100);
        const int64_t now = T0 + i * 5 * 1000000LL;   // arrives faster than 40 ms a rung
        const Bytes out = run(r, ts.take(), now);
        stamps.push_back(id.stamp(out.data(), out.size(), now));
        for (const Seen& e : scan(out)) seen.push_back(e);
    }
    bool steps = true;
    for (size_t i = 1; i < stamps.size(); i++) steps = steps && stamps[i] - stamps[i - 1] == 40000000;
    CHECK("loop: stamps keep their 40 ms step across the loop", steps);
    std::vector<int64_t> vpts, apts, pcr;
    std::vector<bool> di;
    for (const Seen& e : seen) {
        if (e.pid == VID && e.pts >= 0) vpts.push_back(e.pts);
        if (e.pid == AUD && e.pts >= 0) apts.push_back(e.pts);
        if (e.pcr >= 0) {
            pcr.push_back(e.pcr);
            di.push_back(e.di);
        }
    }
    bool cont = vpts.size() == 16 && apts.size() == 16;
    for (size_t i = 1; i < vpts.size(); i++)
        cont = cont && mod33(vpts[i] - vpts[i - 1]) == STEP && mod33(apts[i] - apts[i - 1]) == STEP;
    CHECK("loop: video and audio continue one spacing on", cont);
    bool pcr_steps = pcr.size() == 16;
    for (size_t i = 1; i < pcr.size(); i++)
        pcr_steps = pcr_steps && mod_pcr(pcr[i] - pcr[i - 1]) == STEP * 300;
    CHECK("loop: the PCR continues too", pcr_steps);
    CHECK("loop: the first PCR after the loop is flagged, no other",
          std::count(di.begin(), di.end(), true) == 1 && di[6]);
    CHECK("loop: one re-anchor", r.stats().reanchors == 1);
}

// A jump after a pause: house time went on, so the new timeline starts at house now.
void test_jump_after_pause_lands_at_now() {
    HouseRebase r;
    Ts ts;
    for (int i = 0; i < 4; i++) {
        av_rung(ts, P0 + i * STEP, P0 + 100 + i * STEP, 0);
        run(r, ts.take(), T0 + i * 1000000LL);
    }
    const int64_t later = T0 + 10 * SEC;
    av_rung(ts, P0 + 90000 * 600, P0 + 100 + 90000 * 600, 0);
    const auto s = scan(run(r, ts.take(), later));
    CHECK("pause: the jump after a pause lands at house now, not late",
          mrts::house_from_mux_pts(s[0].pts, later) == house_of(later));
    CHECK("pause: audio keeps its offset", s[1].pts == mod33(s[0].pts + 100));
    CHECK("pause: one re-anchor, the next PCR flagged", r.stats().reanchors == 1 && s[0].di);
}

// No source jump, only late delivery: no re-anchor, the content stays continuous (late).
void test_stall_without_jump() {
    HouseRebase r;
    Ts ts;
    av_rung(ts, P0, P0 + 100);
    const int64_t first = scan(run(r, ts.take(), T0))[0].pts;
    av_rung(ts, P0 + STEP, P0 + 100 + STEP);
    const int64_t next = scan(run(r, ts.take(), T0 + 5 * SEC))[0].pts;
    CHECK("stall: continuous PES after a 5 s stall are not re-anchored",
          mod33(next - first) == STEP && r.stats().reanchors == 0);
}

// A gap on a non-reference PID is content: no re-anchor, the gap is kept.
void test_gap_on_audio() {
    HouseRebase r;
    Ts ts;
    ts.psi(VID);
    int64_t vfirst = -1, a5 = -1, a6 = -1;
    for (int i = 0; i < 10; i++) {
        const int64_t apts = P0 + 100 + i * STEP + (i >= 6 ? 6 * 90000 : 0);
        av_rung(ts, P0 + i * STEP, apts);
        const auto s = scan(run(r, ts.take(), T0 + i * 40 * 1000000LL));
        for (const Seen& e : s) {
            if (e.pid == VID && e.pts >= 0 && vfirst < 0) vfirst = e.pts;
            if (e.pid == AUD && i == 5) a5 = e.pts;
            if (e.pid == AUD && i == 6) a6 = e.pts;
        }
    }
    CHECK("audio gap: no re-anchor", r.stats().reanchors == 0);
    CHECK("audio gap: the 6 s gap stays in the audio", mod33(a6 - a5) == STEP + 6 * 90000);
}

// Without PSI the reference is video over audio, so an audio-only jump is no new timeline.
void test_reference_prefers_video() {
    HouseRebase r;
    Ts ts;
    ts.pes(AUD, 0xC0, P0);                         // audio anchors
    ts.pes(VID, 0xE0, P0 + 200);
    run(r, ts.take(), T0);
    ts.pes(AUD, 0xC0, P0 + AFRAME + 90000 * 600);
    ts.pes(VID, 0xE0, P0 + 200 + STEP);
    run(r, ts.take(), T0 + 40000000);
    CHECK("reference: an audio-only jump does not re-anchor while video runs",
          r.stats().reanchors == 0);
    ts.pes(VID, 0xE0, 4500);
    const auto s = scan(run(r, ts.take(), T0 + 80000000));
    CHECK("reference: a video jump does", r.stats().reanchors == 1);
    ts.pes(AUD, 0xC0, 4500 - 200 + AFRAME);
    ts.pes(VID, 0xE0, 4500 + STEP);
    const auto t = scan(run(r, ts.take(), T0 + 120000000));
    CHECK("reference: both continue after it",
          mod33(t[1].pts - s[0].pts) == STEP && r.stats().reanchors == 1);
}

// The PMT's PCR PID ranks above video.
void test_reference_pcr_pid() {
    HouseRebase r;
    Ts ts;
    ts.psi(AUD);                                   // audio carries the PCR
    ts.pes(VID, 0xE0, P0, -1, mod_pcr((P0 - 9000) * 300));   // a PCR off the PCR PID first
    ts.pes(AUD, 0xC0, P0 + 100, -1, mod_pcr((P0 - 9000) * 300));
    run(r, ts.take(), T0);
    ts.pes(VID, 0xE0, P0 + STEP + 90000 * 600);
    ts.pes(AUD, 0xC0, P0 + 100 + AFRAME, -1, mod_pcr((P0 + AFRAME - 9000) * 300));
    run(r, ts.take(), T0 + 40000000);
    CHECK("reference: a video-only jump does not re-anchor when audio is the PCR PID",
          r.stats().reanchors == 0);
}

// A reference silent for REF_STALE_NS gives way: the jump on the PID that remains re-anchors.
void test_stale_reference() {
    HouseRebase r;
    Ts ts;
    av_rung(ts, P0, P0 + 100);
    run(r, ts.take(), T0);
    int64_t now = T0, last = -1;
    for (int i = 1; i <= 60; i++) {                // video gone, audio on for 2.4 s
        now += 40000000;
        ts.pes(AUD, 0xC0, P0 + 100 + i * STEP);
        last = scan(run(r, ts.take(), now))[0].pts;
    }
    ts.pes(AUD, 0xC0, 4500);
    const auto s = scan(run(r, ts.take(), now + 40000000));
    CHECK("stale reference: audio took over and its jump re-anchors", r.stats().reanchors == 1);
    CHECK("stale reference: and lands one spacing on", mod33(s[0].pts - last) == STEP);
}

void test_before_anchor() {
    HouseRebase r;
    Ts ts;
    ts.psi(VID);
    ts.pes(SUB, 0xBD, P0 + 90000);                 // private, timed: cannot be placed yet
    ts.cont(SUB);
    ts.pcr(VID, mod_pcr((P0 - 9000) * 300));       // a PCR with no shift to move it by
    ts.af_only(VID);                               // no time: passes
    {
        uint8_t* p = ts.add(0x111, true, 1);       // a PES without PTS (padding): passes
        const uint8_t e[6] = {0, 0, 1, 0xBE, 0, 20};
        std::memcpy(p + 4, e, 6);
        uint8_t* q = ts.add(0x112, true, 1);       // a section on an ES PID: passes
        q[4] = 0;
        q[5] = 0xFC;
    }
    const Bytes before = ts.take();
    ts.pes(VID, 0xE0, P0, P0 - STEP, mod_pcr((P0 - STEP - 9000) * 300));   // the anchor
    ts.cont(SUB);                                  // still the PES dropped before the anchor
    ts.pes(SUB, 0xBD, P0 + 2 * 90000);             // a new one: placed
    ts.cont(SUB);                                  // with its continuation
    const Bytes after = ts.take();
    Bytes in = before;
    in.insert(in.end(), after.begin(), after.end());
    const Bytes out = run(r, in, T0);
    const auto s = scan(out);
    std::vector<int> pids;
    for (const Seen& e : s) pids.push_back(e.pid);
    const std::vector<int> want = {0, PMT_PID, VID, 0x111, 0x112, VID, SUB, SUB};
    CHECK("before the anchor: only what carries no time passes", pids == want);
    CHECK("before the anchor: 4 packets dropped", r.stats().dropped == 4);
    const int64_t shift = mod33(s[5].pts - P0);
    CHECK("before the anchor: the private PES after it is placed",
          s[6].pts == mod33(P0 + 2 * 90000 + shift));
    CHECK("before the anchor: the AF-only packet is byte-identical",
          std::equal(out.begin() + 2 * PKT, out.begin() + 3 * PKT, in.begin() + 5 * PKT));
}

// A PES header split over two packets (an AF leaving 13 bytes): held to its next payload
// packet, both rewritten, and the AF-only PCR packet behind it kept in order.
void test_split_header() {
    HouseRebase r;
    Ts ts;
    av_rung(ts, P0, P0 + 100);
    run(r, ts.take(), T0);
    const int64_t shift = [&] {
        Ts t2;
        av_rung(t2, P0 + STEP, P0 + 100 + STEP);
        return mod33(scan(run(r, t2.take(), T0 + 40000000))[0].pts - (P0 + STEP));
    }();
    ts.pes(VID, 0xE0, P0 + 2 * STEP, P0, -1, 170);   // 13 bytes of PES header here
    ts.pes(AUD, 0xC0, P0 + 100 + 2 * STEP);
    const Bytes c1 = ts.take();
    ts.pcr(VID, mod_pcr((P0 + STEP - 9000) * 300));
    ts.cont(VID);
    const Bytes c2 = ts.take();
    const Bytes o1 = run(r, c1, T0 + 80000000);
    const Bytes o2 = run(r, c2, T0 + 81000000);
    const auto s1 = scan(o1), s2 = scan(o2);
    CHECK("split: the held header leaves with its next packet",
          s1.size() == 1 && s1[0].pid == AUD && s2.size() == 3 && s2[0].pid == VID && s2[0].pusi &&
              s2[1].pcr >= 0 && s2[2].pid == VID && !s2[2].pusi);
    // Join the header back across the two packets and read it.
    Bytes hdr(o2.begin() + 5 + 170, o2.begin() + PKT);
    hdr.insert(hdr.end(), o2.begin() + 2 * PKT + 4, o2.begin() + 2 * PKT + 4 + 6);
    mrts::PesHeader h;
    const bool ok = mrts::parse_pes_header(hdr.data(), hdr.size(), &h) && h.complete;
    CHECK("split: PTS and DTS rewritten across both packets",
          ok && h.pts == mod33(P0 + 2 * STEP + shift) && h.dts == mod33(P0 + shift));
    CHECK("split: the PCR behind it rebased",
          s2[1].pcr == mod_pcr((P0 + STEP - 9000) * 300 + shift * 300));
    CHECK("split: nothing dropped", r.stats().dropped == 0);
}

// A held header whose next packet comes after a CC gap cannot be joined: both go.
void test_broken_split_header() {
    HouseRebase r;
    Ts ts;
    av_rung(ts, P0, P0 + 100);
    run(r, ts.take(), T0);
    ts.pes(VID, 0xE0, P0 + STEP, P0 - STEP, -1, 170);
    ts.cc[VID]++;                                  // one packet lost
    ts.cont(VID);
    ts.pes(VID, 0xE0, P0 + 2 * STEP);
    ts.cont(VID);
    const auto s = scan(run(r, ts.take(), T0 + 40000000));
    CHECK("broken split: the held packet and its continuation dropped, the next PES passes",
          s.size() == 2 && s[0].pts >= 0 && !s[1].pusi && r.stats().dropped == 2);
}

void test_damaged_dts_and_untimed() {
    HouseRebase r;
    Ts ts;
    av_rung(ts, P0, P0 + 100);
    const int64_t shift = mod33(scan(run(r, ts.take(), T0))[0].pts - P0);
    ts.pes(VID, 0xE0, P0 + STEP, P0 + STEP - 10 * 90000);   // DTS 10 s off its PTS
    {
        uint8_t* p = ts.add(0x111, true, 1);       // PES without PTS after the anchor
        const uint8_t e[6] = {0, 0, 1, 0xBE, 0, 20};
        std::memcpy(p + 4, e, 6);
    }
    uint8_t* q = ts.add(AUD, true, 3);             // scrambled, with a PCR in its clear AF
    q[3] |= 0x80;
    q[4] = 7;
    q[5] = 0x10;
    mrts::write_pcr(q, 123456789);
    const uint8_t fake[14] = {0, 0, 1, 0xC0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1};
    std::memcpy(q + 12, fake, sizeof fake);        // reads as a PES, but is ciphertext
    const Bytes in = ts.take();
    const Bytes out = run(r, in, T0 + 40000000);
    const auto s = scan(out);
    CHECK("damaged DTS: written at its PTS",
          s[0].dts == s[0].pts && s[0].pts == mod33(P0 + STEP + shift));
    CHECK("untimed PES: untouched",
          std::equal(in.begin() + PKT, in.begin() + 2 * PKT, out.begin() + PKT));
    CHECK("scrambled: payload untouched, PCR rebased",
          std::equal(in.begin() + 2 * PKT + 12, in.end(), out.begin() + 2 * PKT + 12) &&
              s[2].pcr == mod_pcr(123456789 + shift * 300));
}

// The rebase does not depend on how the bytes are cut, and drops garbage.
void test_chunking() {
    Ts ts;
    ts.psi(VID);
    for (int i = 0; i < 30; i++) {
        av_rung(ts, P0 + i * STEP, P0 + 100 + i * STEP);
        if (i == 7) ts.pes(VID, 0xE0, P0 + i * STEP + STEP / 2, -1, -1, 170), ts.cont(VID);
    }
    const Bytes stream = ts.take();
    HouseRebase a;
    const Bytes whole = run(a, stream, T0);
    Bytes cut, junk = stream;
    junk.insert(junk.begin() + 40 * PKT, {1, 2, 3, 4, 5, 6, 7});
    HouseRebase b;
    size_t off = 0;
    for (size_t n = 1; off < junk.size(); n = n * 7 % 1013 + 1) {
        const size_t k = std::min(n, junk.size() - off);
        Bytes o;
        b.process(junk.data() + off, k, T0, o);
        cut.insert(cut.end(), o.begin(), o.end());
        off += k;
    }
    CHECK("chunking: any cut, garbage left out, the same bytes",
          cut == whole && cut.size() == stream.size());
    CHECK("chunking: the garbage counted", b.stats().desync_bytes == 7 && a.stats().desync_bytes == 0);
}

// A duplicate packet (ISO 13818-1 2.4.3.3) is rewritten like its first copy.
void test_duplicate() {
    HouseRebase r;
    Ts ts;
    av_rung(ts, P0, P0 + 100);
    Bytes in = ts.take();
    in.insert(in.begin() + PKT, in.begin(), in.begin() + PKT);
    const Bytes out = run(r, in, T0);
    CHECK("duplicate: both copies identical, no re-anchor",
          std::equal(out.begin(), out.begin() + PKT, out.begin() + PKT) && r.stats().reanchors == 0);
}


// A private PES on the PCR PID (302M-style 0xBD) is a timing PES: it anchors.
void test_private_on_pcr_pid() {
    HouseRebase r;
    Ts ts;
    ts.psi(SUB);
    ts.pes(SUB, 0xBD, P0, -1, mod_pcr((P0 - 9000) * 300));
    const auto s = scan(run(r, ts.take(), T0));
    CHECK("PCR PID: its private PES anchors at house now",
          s.size() == 3 && mrts::house_from_mux_pts(s[2].pts, T0) == house_of(T0) &&
              r.stats().dropped == 0);
}

// After a pause the jumped PTS lands at house now, whatever its reorder delay.
void test_pause_with_reorder() {
    HouseRebase r;
    Ts ts;
    av_rung(ts, P0, P0 + 100);
    run(r, ts.take(), T0);
    const int64_t later = T0 + 10 * SEC;
    av_rung(ts, P0 + 90000 * 600, P0 + 100 + 90000 * 600);   // DTS two frames before
    const auto s = scan(run(r, ts.take(), later));
    CHECK("pause: the PTS lands at house now, its DTS two frames before",
          mrts::house_from_mux_pts(s[0].pts, later) == house_of(later) &&
              mod33(s[0].pts - s[0].dts) == 2 * STEP);
}

// A jump on the reference's second PES, before any spacing: one tick on, never back.
void test_jump_before_spacing() {
    HouseRebase r;
    Ts ts;
    ts.pes(VID, 0xE0, P0);
    const int64_t first = scan(run(r, ts.take(), T0))[0].pts;
    ts.pes(VID, 0xE0, 4500);                       // at the same house time
    const int64_t next = scan(run(r, ts.take(), T0))[0].pts;
    CHECK("no spacing yet: the jump lands one tick on",
          mod33(next - first) == 1 && r.stats().reanchors == 1);
}

// The flag goes on the PCR PID's next PCR, not on a PCR elsewhere.
void test_flag_on_pcr_pid_only() {
    HouseRebase r;
    Ts ts;
    ts.psi(VID);
    av_rung(ts, P0, P0 + 100);
    ts.pcr(AUD, mod_pcr((P0 - 9000) * 300));       // the audio carries a PCR too
    run(r, ts.take(), T0);
    ts.pes(VID, 0xE0, 4500);                       // re-anchors; no PCR in its packet
    ts.pes(AUD, 0xC0, 4600, -1, mod_pcr(4600 * 300));
    ts.pcr(VID, mod_pcr((4500 - 9000) * 300));
    const auto s = scan(run(r, ts.take(), T0 + 40000000));
    CHECK("flag: the audio PID's moved PCR is not flagged, the PCR PID's next is",
          r.stats().reanchors == 1 && s[1].pcr >= 0 && !s[1].di && s[2].pcr >= 0 && s[2].di);
}

// Jumps are judged on the bus: a PID taking over after another re-anchored is continuous.
void test_takeover_after_reanchor() {
    HouseRebase r;
    Ts ts;
    av_rung(ts, P0, P0 + 100);
    const int64_t a0 = scan(run(r, ts.take(), T0))[1].pts;
    const int64_t J = 90000 * 600;
    ts.pes(VID, 0xE0, P0 + STEP + J, P0 - STEP + J);   // re-anchors; the last video PES
    run(r, ts.take(), T0 + 40000000);
    ts.pes(AUD, 0xC0, P0 + 100 + STEP + J);        // audio, 3 s later: takes over the reference
    const auto s = scan(run(r, ts.take(), T0 + 3 * SEC));
    CHECK("takeover: continuous on the bus, so no second re-anchor",
          r.stats().reanchors == 1 && mod33(s[0].pts - a0) == STEP);
}

// A B-frame stream re-anchors on its decode order: DTS continues one frame on.
void test_bframes_reanchor_on_dts() {
    HouseRebase r;
    Ts ts;
    // Decode order I P B B ...: DTS n frames, PTS of display frame order[n], 2 frames later.
    const int order[] = {0, 3, 1, 2, 6, 4, 5, 9, 7, 8};
    std::vector<int64_t> dts;
    for (int i = 0; i < 20; i++) {
        const int64_t base = i < 10 ? P0 : 4500 - 10 * STEP;
        const int n = i % 10 + (i < 10 ? 0 : 10);
        const int64_t pts = base + (order[i % 10] + (n - i % 10) + 2) * STEP;
        ts.pes(VID, 0xE0, mod33(pts), mod33(base + n * STEP));
        for (const Seen& e : scan(run(r, ts.take(), T0 + i * 5000000LL)))
            if (e.dts >= 0) dts.push_back(e.dts);
    }
    bool steps = dts.size() == 20;
    for (size_t i = 1; i < dts.size(); i++) steps = steps && mod33(dts[i] - dts[i - 1]) == STEP;
    CHECK("B-frames: DTS continues one frame on across the loop", steps && r.stats().reanchors == 1);
}

// A duplicate of a held split header (ISO 13818-1 2.4.3.3) goes alone; the first joins.
void test_duplicate_of_held_header() {
    HouseRebase r;
    Ts ts;
    av_rung(ts, P0, P0 + 100);
    const int64_t shift = mod33(scan(run(r, ts.take(), T0))[0].pts - P0);
    ts.pes(VID, 0xE0, P0 + STEP, -1, -1, 170);
    const Bytes held(ts.b.end() - PKT, ts.b.end());
    ts.b.insert(ts.b.end(), held.begin(), held.end());
    ts.cont(VID);
    const Bytes out = run(r, ts.take(), T0 + 40000000);
    Bytes hdr(out.begin() + 5 + 170, out.begin() + PKT);
    hdr.insert(hdr.end(), out.begin() + PKT + 4, out.begin() + PKT + 5);
    mrts::PesHeader h;
    CHECK("held duplicate: dropped alone, the header joins its continuation",
          out.size() == 2 * PKT && r.stats().dropped == 1 &&
              mrts::parse_pes_header(hdr.data(), hdr.size(), &h) && h.complete &&
              h.pts == mod33(P0 + STEP + shift));
}

// The threshold: a step of more than 1 s past one spacing re-anchors, one below it is content.
void test_threshold() {
    HouseRebase r;
    Ts ts;
    for (int i = 0; i < 3; i++) {
        ts.pes(VID, 0xE0, P0 + i * STEP);
        run(r, ts.take(), T0 + i * 40000000LL);
    }
    ts.pes(VID, 0xE0, P0 + 3 * STEP + 81000);     // a 0.9 s hole
    run(r, ts.take(), T0 + 120000000);
    CHECK("threshold: 0.9 s past one spacing is a hole in the content", r.stats().reanchors == 0);
    ts.pes(VID, 0xE0, P0 + 4 * STEP + 81000 + 99000);   // 1.1 s
    run(r, ts.take(), T0 + 160000000);
    CHECK("threshold: 1.1 s past it re-anchors", r.stats().reanchors == 1);
}

// SI and stuffing carry no time, even when their bytes read as a PES.
void test_si_untouched() {
    HouseRebase r;
    Ts ts;
    for (int pid : {mrts::PID_NULL, 0x11}) {
        uint8_t* p = ts.add(pid, true, 1);
        const uint8_t e[14] = {0, 0, 1, 0xE0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1};
        std::memcpy(p + 4, e, sizeof e);
    }
    const Bytes in = ts.take();
    const Bytes out = run(r, in, T0);
    CHECK("SI and stuffing: untouched, no anchor", out == in && !r.stats().anchored);
}

// Jumps never become the spacing: three discontinuities in a row each land one frame on.
void test_repeated_jumps() {
    HouseRebase r;
    Ts ts;
    std::vector<int64_t> out;
    const int64_t src[] = {P0, P0 + STEP, P0 + 2 * STEP, P0 + 2 * STEP + 900000,
                           P0 + 2 * STEP + 1800000, P0 + 2 * STEP + 2700000};
    for (int i = 0; i < 6; i++) {
        ts.pes(VID, 0xE0, src[i]);
        out.push_back(scan(run(r, ts.take(), T0 + i * 1000000LL))[0].pts);
    }
    bool steps = true;
    for (int i = 1; i < 6; i++) steps = steps && mod33(out[i] - out[i - 1]) == STEP;
    CHECK("repeated jumps: each lands one frame on", steps && r.stats().reanchors == 3);
}

// What waits behind a held header is bounded: past MAX_HELD_AF the PCR packets go on.
void test_held_af_bounded() {
    HouseRebase r;
    Ts ts;
    av_rung(ts, P0, P0 + 100);
    run(r, ts.take(), T0);
    ts.pes(VID, 0xE0, P0 + STEP, -1, -1, 170);
    for (int i = 0; i < 20; i++) ts.pcr(VID, mod_pcr((P0 + i * 90) * 300));
    const auto s = scan(run(r, ts.take(), T0 + 40000000));
    CHECK("held: past 16 waiting packets the PCR packets go on", s.size() == 4);
    ts.cont(VID);
    const auto t = scan(run(r, ts.take(), T0 + 41000000));
    CHECK("held: the header, 16 PCR packets, its continuation", t.size() == 18 && t[0].pusi);
}

// hls-pipe's inline audio continues across a discontinuity while its video jumps: after
// the video re-anchors, the audio stays on its own timeline (backward jump, video first).
void test_inline_audio_stays() {
    HouseRebase r;
    Ts ts;
    ts.psi(VID);
    std::vector<int64_t> v, a;
    for (int i = 0; i < 12; i++) {
        const int64_t vsrc = i < 6 ? P0 + i * STEP : 4500 + (i - 6) * STEP;
        av_rung(ts, vsrc, P0 + 100 + i * STEP);    // the audio never jumps
        for (const Seen& e : scan(run(r, ts.take(), T0 + i * 5000000LL))) {
            if (e.pid == VID && e.pts >= 0) v.push_back(e.pts);
            if (e.pid == AUD && e.pts >= 0) a.push_back(e.pts);
        }
    }
    bool steps = v.size() == 12 && a.size() == 12;
    for (size_t i = 1; i < v.size() && i < a.size(); i++)
        steps = steps && mod33(v[i] - v[i - 1]) == STEP && mod33(a[i] - a[i - 1]) == STEP;
    CHECK("inline audio: video re-anchors, the audio keeps its place, both continue",
          steps && mod33(a[11] - v[11]) == 100);
    CHECK("inline audio: one re-anchor, one PID kept", r.stats().reanchors == 1 && r.stats().kept == 1);
    // The video stops; the kept audio runs on in real time and takes over, then jumps.
    int64_t last = a[11];
    bool on = true;
    for (int i = 12; i < 70; i++) {
        ts.pes(AUD, 0xC0, P0 + 100 + i * STEP);
        const int64_t t = scan(run(r, ts.take(), T0 + 55000000 + (i - 11) * 40000000LL))[0].pts;
        on = on && mod33(t - last) == STEP;
        last = t;
    }
    ts.pes(AUD, 0xC0, P0 + 100 + 70 * STEP + 90000 * 600);
    const int64_t t = scan(run(r, ts.take(), T0 + 55000000 + 59 * 40000000LL))[0].pts;
    CHECK("inline audio: taking over keeps it in place, its own jump lands one spacing on",
          on && mod33(t - last) == STEP && r.stats().reanchors == 2);
}

// The same forward (a live skip): muxed by DTS, the continuous audio comes first.
void test_inline_audio_stays_forward() {
    HouseRebase r;
    Ts ts;
    ts.psi(VID);
    std::vector<int64_t> v, a;
    const int64_t J = 90000 * 600;
    for (int i = 0; i < 12; i++) {
        const int64_t asrc = P0 + 100 + i * STEP;
        if (i < 6) {
            av_rung(ts, P0 + i * STEP, asrc);
        } else {
            ts.pes(AUD, 0xC0, asrc);
            ts.pes(VID, 0xE0, P0 + i * STEP + J, P0 + (i - 2) * STEP + J,
                   mod_pcr((P0 + (i - 2) * STEP + J - 9000) * 300));
        }
        for (const Seen& e : scan(run(r, ts.take(), T0 + i * 5000000LL))) {
            if (e.pid == VID && e.pts >= 0) v.push_back(e.pts);
            if (e.pid == AUD && e.pts >= 0) a.push_back(e.pts);
        }
    }
    bool steps = v.size() == 12 && a.size() == 12;
    for (size_t i = 1; i < v.size() && i < a.size(); i++)
        steps = steps && mod33(v[i] - v[i - 1]) == STEP && mod33(a[i] - a[i - 1]) == STEP;
    CHECK("inline audio, forward: both continue", steps && r.stats().reanchors == 1 && r.stats().kept == 1);
}

// A passthrough where both jump but the audio's new PES comes first: that one lands on the
// old shift (the edge), then the audio follows the program again; nothing is kept apart.
void test_both_jump_audio_first() {
    HouseRebase r;
    Ts ts;
    ts.psi(VID);
    std::vector<int64_t> a;
    const int64_t J = 90000 * 600;
    for (int i = 0; i < 10; i++) {
        const int64_t off = i < 5 ? 0 : J;
        if (i < 5) {
            av_rung(ts, P0 + i * STEP, P0 + 100 + i * STEP);
        } else {
            ts.pes(AUD, 0xC0, P0 + 100 + i * STEP + off);
            ts.pes(VID, 0xE0, P0 + i * STEP + off, P0 + (i - 2) * STEP + off,
                   mod_pcr((P0 + (i - 2) * STEP + off - 9000) * 300));
        }
        for (const Seen& e : scan(run(r, ts.take(), T0 + i * 5000000LL)))
            if (e.pid == AUD && e.pts >= 0) a.push_back(e.pts);
    }
    CHECK("both jump, audio first: the first new audio PES is off by the jump",
          a.size() == 10 && mod33(a[5] - a[4]) == mod33(STEP + J));
    bool back = a.size() == 10 && mod33(a[6] - a[4]) == 2 * STEP;
    for (size_t i = 7; i < a.size(); i++) back = back && mod33(a[i] - a[i - 1]) == STEP;
    CHECK("both jump, audio first: then the audio is back with the program",
          back && r.stats().reanchors == 1 && r.stats().kept == 0);
}

// The same with two audio PES of each new rung ahead of the video (two AAC frames a video
// frame), forward and back: the two before the re-anchor are off, nothing after them.
void test_both_jump_two_audio_first() {
    const int64_t jumps[] = {90000 * 600, 4500 - P0 - 6 * STEP};
    for (const int64_t J : jumps) {
        HouseRebase r;
        Ts ts;
        ts.psi(VID);
        Tracks t;
        for (int i = 0; i < 14; i++) {
            const int64_t off = i < 6 ? 0 : J;
            av2_rung(ts, P0 + i * STEP + off, P0 + 100 + i * STEP + off, i < 6 ? 0 : 2);
            t.add(run(r, ts.take(), T0 + i * 5000000LL));
        }
        bool ok = t.v.size() == 14 && t.a.size() == 28;
        for (size_t i = 1; ok && i < 14; i++) ok = mod33(t.v[i] - t.v[i - 1]) == STEP;
        for (size_t i = 7; ok && i < 14; i++)
            ok = mod33(t.a[2 * i] - t.v[i]) == 100 &&
                 mod33(t.a[2 * i + 1] - t.a[2 * i]) == STEP / 2;
        CHECK(J > 0 ? "two audio first, forward: the source's A/V offset from the next rung on"
                    : "two audio first, back: the source's A/V offset from the next rung on",
              ok);
        CHECK(J > 0 ? "two audio first, forward: only those two off by the jump"
                    : "two audio first, back: only those two off by the jump",
              t.a.size() == 28 && mod33(t.a[12] - t.a[11]) == mod33(STEP / 2 + J) &&
                  mod33(t.a[13] - t.a[12]) == STEP / 2);
        CHECK(J > 0 ? "two audio first, forward: nothing kept apart"
                    : "two audio first, back: nothing kept apart",
              r.stats().reanchors == 1 && r.stats().kept == 0);
    }
}

// A PID that jumped first is on the new mapping from the re-anchor on, also when it next
// speaks as the reference (after a stall): it continues, no second re-anchor.
void test_jumped_first_takes_over() {
    HouseRebase r;
    Ts ts;
    ts.psi(VID);
    const int64_t J = 90000 * 600;
    for (int i = 0; i < 5; i++) {
        av_rung(ts, P0 + i * STEP, P0 + 100 + i * STEP);
        run(r, ts.take(), T0 + i * 5000000LL);
    }
    ts.pes(AUD, 0xC0, P0 + 100 + 5 * STEP + J);    // the audio's new timeline first
    ts.pes(VID, 0xE0, P0 + 5 * STEP + J, P0 + 3 * STEP + J,
           mod_pcr((P0 + 3 * STEP + J - 9000) * 300));
    const auto s = scan(run(r, ts.take(), T0 + 25000000LL));
    ts.pes(AUD, 0xC0, P0 + 100 + 6 * STEP + J);    // 3 s later: the audio takes over
    const auto t = scan(run(r, ts.take(), T0 + 3 * SEC));
    CHECK("jumped first, then the reference: it continues on the new mapping",
          s.size() == 2 && t.size() == 1 && mod33(t[0].pts - s[1].pts) == STEP + 100 &&
              r.stats().reanchors == 1);
}

// An audio gap is content, also when the video's inline jump follows: the audio stays (kept).
void test_gap_then_inline_jump() {
    HouseRebase r;
    Ts ts;
    ts.psi(VID);
    Tracks t;
    for (int i = 0; i < 14; i++) {
        const int64_t vsrc = i < 10 ? P0 + i * STEP : 4500 + (i - 10) * STEP;
        av_rung(ts, vsrc, P0 + 100 + i * STEP + (i >= 6 ? 6 * 90000 : 0));   // 6 s gap at rung 6
        t.add(run(r, ts.take(), T0 + i * 5000000LL));
    }
    bool ok = t.v.size() == 14 && t.a.size() == 14 && mod33(t.a[6] - t.a[5]) == STEP + 6 * 90000;
    for (size_t i = 1; ok && i < 14; i++)
        ok = mod33(t.v[i] - t.v[i - 1]) == STEP && (i == 6 || mod33(t.a[i] - t.a[i - 1]) == STEP);
    CHECK("gap, then the video's inline jump: the gap stays, the audio is kept",
          ok && r.stats().reanchors == 1 && r.stats().kept == 1);
}

// What has no timeline of its own moves with the program at a re-anchor: a subtitle PES
// and a dedicated PCR PID, whose first PCR after it is flagged.
void test_untimed_follow() {
    constexpr int PCR_ONLY = 0x120;
    HouseRebase r;
    Ts ts;
    ts.psi(PCR_ONLY);
    std::vector<int64_t> v, vd, sub, pcr;
    std::vector<bool> di;
    for (int i = 0; i < 10; i++) {
        const int64_t src = i < 5 ? P0 + i * STEP : 4500 + (i - 5) * STEP;
        av_rung(ts, src, src + 100);
        ts.pes(SUB, 0xBD, src + 500);
        ts.pcr(PCR_ONLY, mod_pcr((src - 2 * STEP - 9000) * 300));
        for (const Seen& e : scan(run(r, ts.take(), T0 + i * 5000000LL))) {
            if (e.pid == VID && e.pts >= 0) {
                v.push_back(e.pts);
                vd.push_back(e.dts);
            }
            if (e.pid == SUB && e.pts >= 0) sub.push_back(e.pts);
            if (e.pid == PCR_ONLY && e.pcr >= 0) {
                pcr.push_back(e.pcr);
                di.push_back(e.di);
            }
        }
    }
    bool ok = v.size() == 10 && sub.size() == 10 && pcr.size() == 10;
    for (size_t i = 0; ok && i < 10; i++)
        ok = mod33(sub[i] - v[i]) == 500 && mod33(pcr[i] / 300 - vd[i]) == mod33(-9000);
    CHECK("untimed: the subtitle PES and the PCR-only PID move with the program", ok);
    CHECK("untimed: the PCR PID's first PCR after the re-anchor flagged, no other",
          r.stats().reanchors == 1 && std::count(di.begin(), di.end(), true) == 1 && di[5]);
}

// A jump counts for one re-anchor: the audio that joined one does not follow the next.
void test_join_once() {
    HouseRebase r;
    Ts ts;
    ts.psi(VID);
    Tracks t;
    const int64_t vsrc[] = {P0,   P0 + STEP,     P0 + 2 * STEP,
                            4500, 4500 + 900000, 4500 + 900000 + STEP};
    for (int i = 0; i < 6; i++) {
        // Both loop at rung 3; at rung 4 only the video jumps.
        av_rung(ts, vsrc[i], i < 3 ? P0 + 100 + i * STEP : 4600 + (i - 3) * STEP);
        t.add(run(r, ts.take(), T0 + i * 5000000LL));
    }
    bool steps = t.v.size() == 6 && t.a.size() == 6;
    for (size_t i = 1; steps && i < 6; i++)
        steps = mod33(t.v[i] - t.v[i - 1]) == STEP && mod33(t.a[i] - t.a[i - 1]) == STEP;
    CHECK("join once: both continue, the audio kept at the second re-anchor",
          steps && r.stats().reanchors == 2 && r.stats().kept == 1);
}

// A pending PID takes the mapping of the reference that re-anchored, also when another PID
// took the reference over before it spoke (the video silent past REF_STALE_NS).
void test_join_target_recorded() {
    constexpr int AUD2 = 0x102;
    HouseRebase r;
    Ts ts;
    ts.psi(VID);
    const int64_t J = 90000 * 600;
    std::vector<int64_t> a2;
    auto take = [&](int64_t now) {
        for (const Seen& e : scan(run(r, ts.take(), now)))
            if (e.pid == AUD2 && e.pts >= 0) a2.push_back(e.pts);
    };
    for (int i = 0; i < 5; i++) {
        av_rung(ts, P0 + i * STEP, P0 + 100 + i * STEP);
        ts.pes(AUD2, 0xC1, P0 + 200 + i * STEP);
        take(T0 + i * 5000000LL);
    }
    ts.pes(VID, 0xE0, P0 + 5 * STEP + J, P0 + 3 * STEP + J);   // jumps, then goes silent
    take(T0 + 25000000LL);
    ts.pes(AUD, 0xC0, P0 + 100 + 5 * STEP);        // 3 s on: continues (kept), takes over
    ts.pes(AUD2, 0xC1, P0 + 200 + 5 * STEP + J);   // jumped with the video
    take(T0 + 3 * SEC);
    CHECK("join: the re-anchoring reference's mapping, though another took over since",
          a2.size() == 6 && mod33(a2[5] - a2[4]) == STEP && r.stats().reanchors == 1 &&
              r.stats().kept == 1);
}

// A runner respawn after the inline audio was kept apart: the new process has both PIDs on
// the origin's timeline, so the audio takes the reference's mapping again. Video first, two
// audio PES first, and audio first after a pause past REF_STALE_NS (the audio re-anchors).
void test_respawn_after_kept() {
    const char* names[] = {"respawn, video first: A/V back to the source's",
                           "respawn, two audio first: A/V back to the source's",
                           "respawn, audio first after a pause: A/V back to the source's"};
    const int64_t Q = 90000LL * 3000;              // the origin's timeline at the respawn
    for (int variant = 0; variant < 3; variant++) {
        HouseRebase r;
        Ts ts;
        ts.psi(VID);
        Tracks t;
        int64_t now = T0;
        for (int i = 0; i < 12; i++, now += 5000000LL) {
            // hls-pipe's inline discontinuity: the video jumps back, the audio continues.
            av2_rung(ts, i < 6 ? P0 + i * STEP : 4500 + (i - 6) * STEP, P0 + 100 + i * STEP);
            t.add(run(r, ts.take(), now));
        }
        const bool kept = r.stats().kept == 1;
        if (variant == 2) now += 3 * SEC;
        ts.psi(VID);
        for (int i = 0; i < 8; i++, now += 5000000LL) {
            av2_rung(ts, Q + i * STEP, Q + 100 + i * STEP, variant ? 2 : 0);
            t.add(run(r, ts.take(), now));
        }
        bool ok = kept && t.v.size() == 20 && t.a.size() == 40;
        for (size_t i = 13; ok && i < 20; i++)
            ok = mod33(t.a[2 * i] - t.v[i]) == 100 &&
                 mod33(t.a[2 * i + 1] - t.a[2 * i]) == STEP / 2;
        CHECK(names[variant], ok && r.stats().reanchors == 2 && r.stats().kept == 1);
    }
}

// The PCR PID left behind: the video stops past REF_STALE_NS, the audio takes over and
// jumps. Back on its own timeline the video stays (kept), its PCR with its PES and not
// flagged; back with the audio it takes the program's mapping, and its next PCR is flagged.
void test_pcr_pid_after_takeover() {
    const int64_t J = 90000 * 600;
    for (const bool with_audio : {false, true}) {
        HouseRebase r;
        Ts ts;
        ts.psi(VID);
        Tracks t;
        int64_t now = T0;
        int i = 0;
        for (; i < 6; i++, now += 30000000LL) {
            av_rung(ts, P0 + i * STEP, P0 + 100 + i * STEP);
            t.add(run(r, ts.take(), now));
        }
        for (; i < 86; i++, now += 30000000LL) {   // 2.4 s of audio alone
            ts.pes(AUD, 0xC0, P0 + 100 + i * STEP);
            t.add(run(r, ts.take(), now));
        }
        for (int k = 0; k < 5; k++, i++, now += 30000000LL) {
            // The audio jumps; then the video comes back, on its own timeline or the audio's.
            const int64_t vsrc = with_audio ? P0 + i * STEP + J : P0 + (5 + k) * STEP;
            if (k == 0) ts.pes(AUD, 0xC0, P0 + 100 + i * STEP + J);
            else av_rung(ts, vsrc, P0 + 100 + i * STEP + J);
            t.add(run(r, ts.take(), now));
        }
        bool together = t.v.size() == 10 && t.pcr.size() == 10;
        for (size_t k = 0; together && k < t.v.size(); k++)
            together = mod33(t.pcr[k] / 300 - t.v[k]) == mod33(-(2 * STEP + 9000));
        const auto flags = std::count(t.di.begin(), t.di.end(), true);
        if (!with_audio) {
            CHECK("PCR PID kept: its PES continue, its PCR moves with them",
                  together && mod33(t.v[6] - t.v[5]) == STEP);
            CHECK("PCR PID kept: its PCR not flagged, one re-anchor",
                  flags == 0 && r.stats().reanchors == 1 && r.stats().kept == 1);
        } else {
            bool av = together && t.a.size() == 91 && mod33(t.a[87] - t.a[86]) == STEP;
            for (size_t k = 6; av && k < 10; k++) av = mod33(t.a[81 + k] - t.v[k]) == 100;
            CHECK("PCR PID joins: the program's mapping, the audio steps on, its PCR with it", av);
            CHECK("PCR PID joins: its first PCR on it flagged, no second re-anchor",
                  flags == 1 && t.di[6] && r.stats().reanchors == 1 && r.stats().kept == 0);
        }
    }
}

}  // namespace

int main() {
    test_anchor();
    test_one_shift();
    test_wrap();
    test_loop_reanchor();
    test_jump_after_pause_lands_at_now();
    test_stall_without_jump();
    test_gap_on_audio();
    test_reference_prefers_video();
    test_reference_pcr_pid();
    test_stale_reference();
    test_before_anchor();
    test_split_header();
    test_broken_split_header();
    test_damaged_dts_and_untimed();
    test_chunking();
    test_duplicate();
    test_private_on_pcr_pid();
    test_pause_with_reorder();
    test_jump_before_spacing();
    test_flag_on_pcr_pid_only();
    test_takeover_after_reanchor();
    test_bframes_reanchor_on_dts();
    test_duplicate_of_held_header();
    test_threshold();
    test_si_untouched();
    test_repeated_jumps();
    test_held_af_bounded();
    test_inline_audio_stays();
    test_inline_audio_stays_forward();
    test_both_jump_audio_first();
    test_both_jump_two_audio_first();
    test_jumped_first_takes_over();
    test_gap_then_inline_jump();
    test_untimed_follow();
    test_join_once();
    test_join_target_recorded();
    test_respawn_after_kept();
    test_pcr_pid_after_takeover();
    return test_summary("house_rebase");
}
