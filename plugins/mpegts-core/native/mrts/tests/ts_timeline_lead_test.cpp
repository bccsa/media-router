// A CBR contribution feed through the egress stamper (#816, NO-OCC-Gate01
// 2026-10-07) — py/ts_timeline_lead_test.py, line for line: the same fixture,
// the same checks, the same integers. The feed is a synthetic copy of the one
// Gate01 ingests: an 8-frame hierarchical-B GOP (the PTS of a PES in decode
// order jumps +360 ms from the last B of a mini-GOP to the next P) and an
// encoder buffer that sends each picture 0.7-1.3 s ahead of its DTS, wandering
// over 37 s; the PCR rides the video and tracks arrival exactly, the audio
// arrives 60 ms ahead of its PTS. See the python twin for what was measured.
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <utility>
#include <vector>

#include "../ts_psi.h"
#include "../ts_timeline.h"
#include "check.h"

using namespace mrts;

namespace {

constexpr int V = 0x65, A = 0xC9;
constexpr int64_t STEP = 3600, STEP_NS = 40'000'000LL;   // one 25 fps frame
constexpr int64_t HOUSE = 1'000'000'000'000LL, FIRST = 8'100'000;
constexpr int MINI[8] = {8, 4, 2, 1, 3, 6, 5, 7};         // display slot of each decode position
constexpr int REORDER = 2;                                 // frames between decode and presentation
constexpr int64_t TOP_NS = 1'300'000'000LL;                // the wander's largest lead
constexpr int FRAMES = 7500;                               // 300 s
constexpr int64_t STALL_NS = 520'000'000LL;                // a path stall: 13 frames held back
constexpr int64_t RESTART_BACK = 3600LL * 90'000;          // an encoder restart: every clock an hour back

// The encoder buffer's lead of picture i's DTS over the PCR it leaves at: a
// 924-frame (37 s) triangle from 1.3 s down to 0.7 s and back, top first.
int64_t wander(int i) { return 700'000'000LL + std::llabs((int64_t)(i % 924) - 462) * 600'000'000LL / 462; }
// A buffer filling from 0.2 s to 1.8 s over the first 20 s, then full.
int64_t fill(int i) { return 200'000'000LL + (int64_t)std::min(i, 500) * 1'600'000'000LL / 500; }
// The source's PCR at `src_ns` of its own clock: it IS the transport.
int64_t pcr27(int64_t src_ns) { return (FIRST - TOP_NS * 9 / 100000) * 300 + (src_ns - HOUSE) * 27 / 1000; }

// python's ts_psi_test.pes_ts_packet: PTS, a DTS when `dts` >= 0.
void put_ts(uint8_t* f, int prefix, int64_t v) {
    f[0] = (uint8_t)((prefix << 4) | (((v >> 30) & 0x07) << 1) | 1);
    f[1] = (uint8_t)((v >> 22) & 0xFF);
    f[2] = (uint8_t)((((v >> 15) & 0x7F) << 1) | 1);
    f[3] = (uint8_t)((v >> 7) & 0xFF);
    f[4] = (uint8_t)(((v & 0x7F) << 1) | 1);
}
void put_pes(std::vector<uint8_t>& out, int pid, int64_t pts, int64_t dts, uint8_t sid) {
    uint8_t b[PKT];
    std::memset(b, 0xFF, PKT);
    const uint8_t hdr[13] = {SYNC_BYTE, (uint8_t)(0x40 | ((pid >> 8) & 0x1F)), (uint8_t)(pid & 0xFF), 0x10,
                             0x00, 0x00, 0x01, sid, 0x00, 0x00, 0x80,
                             (uint8_t)(dts >= 0 ? 0xC0 : 0x80), (uint8_t)(dts >= 0 ? 10 : 5)};
    std::memcpy(b, hdr, sizeof hdr);
    put_ts(b + 13, dts >= 0 ? 0x3 : 0x2, pts);
    if (dts >= 0) put_ts(b + 18, 0x1, dts);
    out.insert(out.end(), b, b + PKT);
}
int64_t pes_dts(const uint8_t* pkt) {
    const uint8_t* q = pkt + payload_offset(pkt);
    if (!(q[7] & 0x40)) return -1;
    q += 14;
    return ((int64_t)((q[0] >> 1) & 7) << 30) | ((int64_t)q[1] << 22) | ((int64_t)(q[2] >> 1) << 15) |
           ((int64_t)q[3] << 7) | (q[4] >> 1);
}

struct Run {
    std::vector<TimelineStamper::Reanchor> re;
    int pts_steps = 0;
    int rewritten = 0;
};

// Feed FRAMES pictures and their audio through ONE stamper as mrtsstamp drives
// it (repair-latch on: condition, then stamp, on the same bytes). `late_ns`
// makes the PATH slower from picture `late_from` on (every packet arrives
// later; the clocks it carries do not move). No PCR from `pcr_until` on. The
// path stops for STALL_NS when picture `stall_at` leaves and then delivers what
// it held back at once, in order. The encoder restarts at picture `restart_at`:
// nothing for 2 s, then every clock RESTART_BACK back.
Run run(int64_t (*lead)(int) = wander, int late_from = FRAMES, int64_t late_ns = 0, int pcr_until = FRAMES,
        int stall_at = FRAMES, int restart_at = FRAMES) {
    Run r;
    TimelineStamper st(nullptr, [&](const TimelineStamper::Reanchor& e) { r.re.push_back(e); }, nullptr, true);
    st.set_on_conditioned([&](const TimelineStamper::Conditioned& c) { if (!c.pcr) r.pts_steps++; });
    const int64_t t0 = HOUSE + stall_at * STEP_NS + TOP_NS - lead(stall_at);
    auto path = [t0](int64_t h) { return t0 <= h && h < t0 + STALL_NS ? t0 + STALL_NS - (t0 + STALL_NS - h) / 1000 - 1 : h; };
    struct Buf {
        int64_t h;
        int kind;
        std::vector<uint8_t> data;
        int64_t pts, dts;
    };
    std::vector<Buf> bufs;
    for (int i = 0; i < FRAMES; i++) {
        const int m = i / 8, j = i % 8;
        const int64_t back = i >= restart_at ? RESTART_BACK : 0, gap = i >= restart_at ? 2'000'000'000LL : 0;
        const int64_t dts = (FIRST + i * STEP - back + PTS_WRAP) % PTS_WRAP;
        const int64_t pts = (FIRST + (8 * m + MINI[j] + REORDER) * STEP - back + PTS_WRAP) % PTS_WRAP;
        const int64_t src = HOUSE + i * STEP_NS + TOP_NS - lead(i);    // when it leaves the encoder
        const int64_t delay = (i >= late_from ? late_ns : 0) + gap;
        Buf v{path(src + delay), 0, {}, pts, dts};
        if (i < pcr_until) {
            uint8_t pk[PKT];
            build_pcr_packet(V, (pcr27(src) - back * 300 + PCR_MODULO) % PCR_MODULO, 0, pk);
            v.data.insert(v.data.end(), pk, pk + PKT);
        }
        put_pes(v.data, V, pts, pts != dts ? dts : -1, 0xE0);
        bufs.push_back(std::move(v));
        const int64_t a_src = HOUSE + TOP_NS - lead(0) + 20'000'000LL + i * STEP_NS;   // audio: 60 ms ahead
        Buf a{path(a_src + delay), 1, {}, -1, -1};
        put_pes(a.data, A, (pcr27(a_src) / 300 + 5400 - back + PTS_WRAP) % PTS_WRAP, -1, 0xC0);
        bufs.push_back(std::move(a));
    }
    std::sort(bufs.begin(), bufs.end(),
              [](const Buf& x, const Buf& y) { return x.h != y.h ? x.h < y.h : x.kind < y.kind; });
    for (auto& b : bufs) {
        st.condition(b.data.data(), b.data.size(), b.h);
        st.stamp(b.data.data(), b.data.size(), b.h);
        if (b.kind == 0) {
            const uint8_t* pes = b.data.data() + b.data.size() - PKT;
            if (read_pes_pts(pes) != b.pts || pes_dts(pes) != (b.pts != b.dts ? b.dts : -1)) r.rewritten++;
        }
    }
    return r;
}

// One stamper as mrtsstamp drives it; `feed` conditions then stamps a buffer.
struct Feed {
    std::vector<TimelineStamper::Reanchor> re;
    int pts_steps = 0;
    TimelineStamper st;
    Feed() : st(nullptr, [this](const TimelineStamper::Reanchor& e) { re.push_back(e); }, nullptr, true) {
        st.set_on_conditioned([this](const TimelineStamper::Conditioned& c) { if (!c.pcr) pts_steps++; });
    }
    void feed(std::vector<uint8_t> d, int64_t h) {
        st.condition(d.data(), d.size(), h);
        st.stamp(d.data(), d.size(), h);
    }
};
std::vector<uint8_t> pcr_pes(int pid, int64_t pcr27, int64_t pts, int64_t dts = -1) {
    std::vector<uint8_t> d(PKT);
    build_pcr_packet(pid, pcr27, 0, d.data());
    put_pes(d, pid, pts, dts, 0xE0);
    return d;
}
using Levels = std::vector<std::pair<int64_t, int64_t>>;   // (anchor - HOUSE, delta ticks) per re-anchor
Levels levels(const std::vector<TimelineStamper::Reanchor>& re) {
    Levels l;
    for (const auto& e : re) l.emplace_back(e.anchor_ns - HOUSE, e.delta_ticks);
    return l;
}

// python's vmix_pcr: one PES and its PCR a frame, 1 s apart; the PCR stands
// still for 1.48 s at 20 s and lags for good (or, `reset`, steps back 1 s); the
// path 1.5 s deep drains from 60 s, is 400 ms slower from 100 s; a 250 ms lead
// sag from 160 s.
Levels vmix_pcr(bool reset) {
    Feed f;
    int64_t h = 0;
    for (int i = 0; i < 5000; i++) {
        const int64_t src = HOUSE + i * STEP_NS;
        h = i < 1500 ? src + 1'500'000'000LL : std::max<int64_t>(src + (i >= 2500 ? 400'000'000LL : 0), h + 100'000);
        const int64_t k = i < 500 ? i : reset ? i - 25 : std::max(500, i - 37);   // the PCR's frame
        const int64_t sag = (i >= 4000 && i < 4750) ? 22'500 : 0;
        f.feed(pcr_pes(V, (FIRST - 90'000 + k * STEP) * 300, FIRST + i * STEP - sag), h);
    }
    return levels(f.re);
}

}  // namespace

int main() {
    // --- the feed as captured: nothing on it is a step, nothing is late ------
    {
        Run r = run();
        CHECK("a +360 ms reorder step is never read as a clock step (decode clock: one frame)", r.pts_steps == 0);
        CHECK("... so not one video PES is rewritten in 300 s", r.rewritten == 0);
        CHECK("the PTS lead wandering 0.7-1.7 s (buffer 0.7-1.3 s + reorder) over an on-time transport never re-anchors", r.re.empty());
    }
    // --- the EARLY side alike: the buffer filling by 1.6 s after the anchor ---
    {
        Run r = run(fill);
        CHECK("a buffer filling to a 1.6 s higher lead after the anchor never re-anchors (transport on time)",
              r.re.empty());
    }
    // --- a path that really gets 400 ms slower still re-anchors, once ---------
    // Timed so the re-anchor lands on the wander's top: the lead then sags for
    // 18 s, which only a FRESH transport reference keeps from re-anchoring again.
    {
        constexpr int LATE_AT = 2522;                                // 100.9 s in
        Run r = run(wander, LATE_AT, 400'000'000LL);
        const int64_t late_at_ns = LATE_AT * STEP_NS + TOP_NS - wander(LATE_AT) + 400'000'000LL;
        CHECK("a path 400 ms slower (the PCR's arrival moves with the PES) re-anchors exactly once",
              r.re.size() == 1 && r.re[0].delta_ticks < 0);
        CHECK("... once its hold has matured (10-11 s after the path slowed)",
              r.re.size() == 1 && r.re[0].anchor_ns - HOUSE - late_at_ns >= 10'000'000'000LL &&
                  r.re[0].anchor_ns - HOUSE - late_at_ns <= 11'000'000'000LL);
        CHECK("... on the same PES with the same level as the python twin (parity)",
              r.re.size() == 1 && r.re[0].anchor_ns - HOUSE == 111'610'389'611LL && r.re[0].delta_ticks == -36467);
    }
    // --- without the PCR the PES decide alone again (TX_FRESH_NS) -------------
    {
        constexpr int PCR_UNTIL = 500;                               // 20 s
        Run r = run(wander, FRAMES, 0, PCR_UNTIL);
        CHECK("no PCR on the timing PID for over 1 s: the PES level decides again (re-anchors on the wander)",
              !r.re.empty() && r.re[0].anchor_ns - HOUSE > PCR_UNTIL * STEP_NS + 1'000'000'000LL);
        CHECK("... first on the same PES as the python twin (parity)",
              !r.re.empty() && r.re[0].anchor_ns - HOUSE == 31'541'818'182LL);
    }
    // --- a stalled path is not a broken PCR (one-sided) ------------------------
    // 520 ms of nothing, then the backlog at once: the PCR moved 40 ms against
    // 520 ms of arrival, then 40 ms against none — never ahead of arrival, so the
    // transport keeps judging; read both ways it would stand down at the stall.
    {
        Run r = run(wander, FRAMES, 0, FRAMES, 1000);                // 40 s in
        CHECK("a 520 ms stall of the path, then its backlog at once, leaves the transport judging (no re-anchor)",
              r.re.empty());
    }
    // --- an encoder restart re-anchors once, and its new PCR judges again -----
    // 2 s of nothing, then every clock an hour back: the watch re-anchors, and
    // the new PCR (one step back after an outage, not a pause) qualifies again.
    {
        Run r = run(wander, FRAMES, 0, FRAMES, FRAMES, 2000);        // 80 s in
        CHECK("an encoder restart (2 s gone, clocks an hour back) re-anchors once; the PCR judges again after it",
              levels(r.re) == Levels{{82'238'701'299LL, -323'982'000LL}});
    }
    // --- a PCR that leaps ahead of arrival is no transport clock (vMix, .103) --
    // ts_timeline_test's captured .103 shape, 14-20 s in (after the PCR has
    // tracked arrival for 10 s): the conditioner takes the PES steps back out,
    // the source's PCR leaps +1.19 s and stays. From 34 s the path gets 300 ms
    // slower: a genuine late level, still re-anchored once.
    {
        constexpr int VX = 0x100, AX = 0x140;
        constexpr int64_t A_BACK = 127800, V_BACK = 107100;
        Feed f;
        for (int i = 0; i < 1250; i++) {
            const int64_t h = HOUSE + i * STEP_NS + (i >= 850 ? 300'000'000LL : 0);
            const int64_t v = FIRST + i * STEP - ((i >= 400 && i < 500) ? V_BACK : 0);
            const int64_t a = FIRST + 900 + i * STEP - ((i >= 350 && i < 499) ? A_BACK : 0);
            std::vector<uint8_t> d = pcr_pes(VX, (FIRST - 9000 + i * STEP + (i >= 500 ? V_BACK : 0)) * 300, v);
            put_pes(d, AX, a, (i >= 350 && i < 499) ? a + A_BACK : -1, 0xE0);
            f.feed(std::move(d), h);
        }
        CHECK("vMix's PCR leap is no transport: a later 300 ms late path still re-anchors once, 10 s on (as e1ea55cd)",
              f.re.size() == 1 && f.re[0].anchor_ns - HOUSE == 44'300'000'000LL && f.re[0].delta_ticks == -27000);
    }
    // --- a PCR that stops and then lags never judges again (#820) -------------
    // vMix's pacer stops while its pictures run on and lags from then on: the
    // PES decide every level alone, as on e1ea55cd, for good. A PCR that only
    // steps back stands down until the next anchor, then qualifies again.
    CHECK("a PCR that stops for 1.48 s, then lags (vMix's pacer, #820), never judges: every level as e1ea55cd",
          vmix_pcr(false) == Levels{{71'480'000'000LL, 75411}, {110'400'000'000LL, -36000}, {170'400'000'000LL, -22500}});
    CHECK("... one that steps back 1 s instead judges again after the next anchor: the last sag stays quiet",
          vmix_pcr(true) == Levels{{71'480'000'000LL, 75411}, {110'400'000'000LL, -36000}});
    // --- a PCR that does not track arrival never judges (#820) ----------------
    // The path hands the feed over in 400 ms bursts: arrival wanders 0-360 ms
    // against the PCR, never within LATE_NS for 10 s; a sag re-anchors as ever.
    {
        Feed f;
        for (int i = 0; i < 3000; i++) {
            const int64_t h = HOUSE + (int64_t)(i / 10 * 10 + 9) * STEP_NS + i * 1000LL;   // with the tenth picture
            const int64_t sag = (i >= 1500 && i < 2250) ? 22'500 : 0;
            f.feed(pcr_pes(V, (FIRST - 90'000 + i * STEP) * 300, FIRST + i * STEP - sag), h);
        }
        CHECK("a PCR the path delivers in 400 ms bursts never tracks arrival, never judges: a sag as e1ea55cd",
              levels(f.re) == Levels{{70'361'750'000LL, -22635}});
    }
    // --- an anchor older than half the PCR's 26.5 h period still judges -------
    // One PES and its PCR a second, the PCR an hour before its 33-bit wrap; 30 s
    // of pictures 250 ms closer to their PTS (PES late, transport on time), one
    // hour in and again 13.5 h in (past the 13.26 h at which a PCR folded against
    // a fixed reference reads a whole period off).
    for (int sag_at : {3600, 48600}) {
        Feed f;
        const int64_t pcr0 = PCR_MODULO - 3600LL * 27'000'000;
        for (int i = 0; i < sag_at + 100; i++) {
            const int64_t lead = (i >= sag_at && i < sag_at + 30) ? 75'000 : 90'000;
            f.feed(pcr_pes(V, (pcr0 + (int64_t)i * 27'000'000) % PCR_MODULO,
                           (pcr0 / 300 + (int64_t)i * 90'000 + lead) % PTS_WRAP),
                   HOUSE + (int64_t)i * 1'000'000'000);
        }
        CHECK(sag_at == 3600
                  ? "a 250 ms lead sag over an on-time transport never re-anchors, one hour in (across the PCR wrap)"
                  : "... nor 13.5 h in, past half the PCR period (the PCR unwrapped PCR to PCR)",
              f.re.empty());
    }
    // --- a reconnect backlog at the anchor does not keep the PCR from judging --
    // 45 pictures flushed back to back with the 45th, then live; a 250 ms lead
    // sag from 20 s to 50 s, and from 60 s the path 400 ms slower. Referenced on
    // its earliest arrival in the repair window, the transport qualifies, keeps
    // the sag quiet and reads +400 ms: the tier fires once.
    {
        Feed f;
        for (int i = 0; i < 2000; i++) {
            const int64_t src = HOUSE + i * STEP_NS;
            const int64_t h = i < 45 ? HOUSE + 44 * STEP_NS + i * 100'000LL : src + (i >= 1500 ? 400'000'000LL : 0);
            const int64_t sag = (i >= 500 && i < 1250) ? 22'500 : 0;
            f.feed(pcr_pes(V, (FIRST - 90'000 + i * STEP) * 300, FIRST + i * STEP - sag), h);
        }
        CHECK("a backlog at the anchor, a lead sag, then a path 400 ms slower: re-anchors exactly once, 10 s on",
              f.re.size() == 1 && f.re[0].anchor_ns - HOUSE == 70'400'000'000LL && f.re[0].delta_ticks == -36000);
    }
    // --- the transport is judged net of the drift slew --------------------------
    // A source 20 ppm slow, one PES and PCR a second: by 3 h the servo has locked
    // and slewed the anchor ~173 ms; a 250 ms lead sag there never re-anchors.
    {
        Feed f;
        constexpr int N = 3 * 3600;
        for (int i = 0; i < N; i++) {
            const int64_t src = (int64_t)i * (1'000'000'000LL - 20 * 1000);
            const int64_t lead = (i >= N - 60 && i < N - 30) ? 75'000 : 90'000;
            f.feed(pcr_pes(V, (FIRST * 300 + src * 27 / 1000) % PCR_MODULO,
                           (FIRST + src * 9 / 100000 + lead) % PTS_WRAP),
                   HOUSE + (int64_t)i * 1'000'000'000);
        }
        const TimelineStamper::Drift d = f.st.drift();
        CHECK("a 20 ppm source with the servo locked: a lead sag never re-anchors (the transport net of the slew)",
              f.re.empty() && d.ppb == 19997 && d.slew_ns == 172'784'623);
    }
    // --- and through the conditioner's program correction -----------------------
    // A reordered feed without DTS (every third mini-GOP the 8-frame pyramid) is
    // judged on its PTS, so the conditioner still reads the +360 ms as clock
    // steps. Read through that correction, its PCR never tracks arrival and never
    // judges: the stamps falling behind reach the late tier as on e1ea55cd.
    {
        Feed f;
        for (int i = 0; i < 1500; i++) {
            const int m = i / 8, j = i % 8;
            const int64_t pts = FIRST + ((m % 3 == 0) ? (8 * m + MINI[j]) : i) * STEP + REORDER * STEP;
            f.feed(pcr_pes(V, (FIRST - 90'000 + i * STEP) * 300, pts), HOUSE + i * STEP_NS);
        }
        CHECK("a reordered feed without DTS: the conditioner's error still reaches the late tier (as e1ea55cd)",
              f.pts_steps == 62 && levels(f.re) == Levels{{10'040'000'000LL, -18000}, {20'600'000'000LL, -18000},
                                                          {31'160'000'000LL, -18000}, {41'720'000'000LL, -18000},
                                                          {52'280'000'000LL, -18000}});
    }
    return test_summary("ts_timeline lead");
}
