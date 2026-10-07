// Port of ts_timeline_gap_test.py: TimelineStamper across a delivery gap — the
// gap carry, the held frame and the late hold (.24 Translation Station,
// 2026-10-06; ADR-0005 decision 2 and Stage 3f amendments 2026-10-07). The same
// checks, names and order as the python suite, plus the event's JSON at the end.
#include <algorithm>
#include <cstdio>
#include <set>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

#include "../ts_psi.h"
#include "../ts_timeline.h"
#include "check.h"
#include "timeline_fixture.h"

using namespace mrts;

namespace {

// .21's wire PTS is its house clock + mpegtsmux's 1 h, so every .21 muxer restart
// reached .24 as a 5-17 s SRT outage inside ONE timeline, the first PES back the
// head of the reconnect's backlog (-26..+160 ms on the mapping before the gap at
// 30 of 34 reconnects; -132..-169 ms, an early transient, at the 4 right after a
// .21 producer restart). The watch re-anchored on each: a fresh latch per
// reconnect, the splitter's mapping stepping -36..+46 ms and the Hall
// transcoder's egress -70..+59 ms.
constexpr int GV = 250, GA = 251, GH = 0x41;
constexpr int64_t GVSTEP = 3600, GASTEP = 1920;            // 40 ms video, 21.333 ms AAC / 302M
constexpr int64_t GFIRST = 3600LL * 90000 + FIRST_PES;     // .21's wire: house + 1 h
constexpr int64_t GTRANSIT = 100'000'000LL, MS = 1'000'000LL;

// A PES start, carrying the PCR 250 ms behind its PTS when `pcr` (mpegtsmux's layout).
TsPacket gpes(int pid, int64_t pts, uint8_t sid, bool pcr) {
    return pcr ? pes_pcr_packet(pid, pts, (pts - 22500) * 300, sid) : pes_packet(pid, pts, sid);
}

struct Ev {
    std::vector<TimelineStamper::Reanchor> re;
    std::vector<TimelineStamper::Settled> se;
    std::vector<TimelineStamper::Gap> gap;
    std::vector<TimelineStamper::Conditioned> cond;   // PTS steps only
};

TimelineStamper stamper(Ev& ev, bool repair) {
    return TimelineStamper(nullptr, [&ev](const TimelineStamper::Reanchor& r) { ev.re.push_back(r); },
                           [&ev](const TimelineStamper::Settled& s) { ev.se.push_back(s); }, repair);
}

void wire(TimelineStamper& st, Ev& ev) {
    st.set_on_gap([&ev](const TimelineStamper::Gap& g) { ev.gap.push_back(g); });
    st.set_on_conditioned([&ev](const TimelineStamper::Conditioned& c) { if (!c.pcr) ev.cond.push_back(c); });
}

// mr-tssplit across one SRT outage: video (PCR on every other PES) + audio 10 ms
// on, one stamper, one stream per output PID, the input conditioned first; 60 s,
// the outage, 20 s. The first PES back is `head_ms` late on the source's timeline
// (the backlog head, drained over 1 s); every later one `late_ms` (a level the
// reconnect really moved). `epoch` (>= 0) restarts the PTS (a reboot), `jump_s`
// steps them with no outage at all, `first` is the first PTS (2^33 wraps it).
struct Row { int64_t k, h, vs, as; };
struct Split { Ev ev; std::vector<Row> rows; int64_t anchor; };
Split split(int64_t gap_ms, int64_t head_ms, int64_t late_ms = 0, int64_t epoch = -1, bool repair = true,
            int64_t jump_s = 0, int64_t first = GFIRST) {
    Split r;
    TimelineStamper st = stamper(r.ev, repair);
    wire(st, r.ev);
    const int n_pre = 1500, g = (int)(gap_ms / 40);
    for (int i = 0; i < n_pre + g + 500; i++) {
        if (i >= n_pre && i < n_pre + g) continue;
        int64_t v = (first + i * GVSTEP + (i >= n_pre ? jump_s * 90000 : 0)) % PTS_WRAP;
        if (epoch >= 0 && i >= n_pre) v = epoch + (int64_t)(i - n_pre - g) * GVSTEP;
        int64_t h = HOUSE + i * STEP_NS + GTRANSIT;
        if (i >= n_pre) {
            const int64_t back = (int64_t)(i - n_pre - g) * STEP_NS;
            if (back < 1'000'000'000LL) h += head_ms * MS - head_ms * MS * back / 1'000'000'000LL;
            h += late_ms * MS;
        }
        auto data = bytes_of({gpes(GV, v, 0xE0, i % 2 == 0), gpes(GA, v + 900, 0xC0, false)});
        st.condition(data.data(), data.size(), h);
        const int64_t vs = st.stamp(data.data(), PKT, h, GV);
        const int64_t as = st.stamp(data.data() + PKT, PKT, h, GA);
        r.rows.push_back({i - n_pre - g, h, vs, as});
    }
    r.anchor = st.anchor_ns();
    return r;
}

// THE HALL TRANSCODER'S EGRESS: one 302M PID carrying the PCR on every other PES.
// Its aacparse holds the last frame before an input gap and releases it WITH the
// first frame after it, so the gap arrives as a PTS jump with no arrival change:
// "absorbed a +6.95s PTS step" (.24, 13:42:48). The first frame back lands
// `head_ms` late on the source's timeline (drained over 1 s).
struct HRow { int64_t k, h, s, v; std::vector<uint8_t> data; };
std::vector<HRow> hall(int64_t gap_ms, bool held, int64_t head_ms, Ev& ev) {
    std::vector<HRow> rows;
    TimelineStamper st = stamper(ev, true);
    wire(st, ev);
    const int n_pre = 2813, g = (int)(gap_ms * 90 / GASTEP);
    const int64_t resume = HOUSE + pts90k_to_ns((int64_t)(n_pre + g) * GASTEP) + GTRANSIT + head_ms * MS;
    for (int i = 0; i < n_pre + g + 938; i++) {
        if (i >= n_pre && i < n_pre + g) continue;
        const int64_t v = GFIRST + i * GASTEP;
        int64_t h = HOUSE + pts90k_to_ns(i * GASTEP) + GTRANSIT;
        const int64_t back = pts90k_to_ns((int64_t)(i - n_pre - g) * GASTEP);
        if (back >= 0 && back < 1'000'000'000LL) h += head_ms * MS - head_ms * MS * back / 1'000'000'000LL;
        if (held && i == n_pre - 1) h = resume - MS;
        auto data = bytes_of({gpes(GH, v, 0xBD, i % 2 == 0)});
        st.condition(data.data(), data.size(), h);
        const int64_t s = st.stamp(data.data(), data.size(), h);
        rows.push_back({i - n_pre - g, h, s, v, data});
    }
    return rows;
}

// The due chain: one audio PID, delivery `late_ms` late from 10 s on for good, its
// PTS stepping by `step` `k` frames in; `bframes` reorders a video PID's PTS
// (+160/-80/+40 ms deltas). The PTS steps the conditioner absorbed.
std::vector<int64_t> chain(int64_t late_ms, int64_t step, int k, bool bframes = false) {
    Ev ev;
    TimelineStamper st = stamper(ev, true);
    wire(st, ev);
    for (int i = 0; i < 1875; i++) {
        const int64_t n = bframes ? (i % 3 == 0 ? i + 2 : i - 1) : i;
        const int64_t pts = GFIRST + n * (bframes ? GVSTEP : GASTEP) + (i >= 469 + k ? step : 0);
        const int64_t h = HOUSE + (bframes ? (int64_t)i * STEP_NS : pts90k_to_ns((int64_t)i * GASTEP)) +
                          (i >= 469 ? late_ms * MS : 0);
        auto data = bytes_of({gpes(0x44, pts, bframes ? 0xE0 : 0xC0, true)});
        st.condition(data.data(), data.size(), h);
        st.stamp(data.data(), data.size(), h);
    }
    std::vector<int64_t> steps;
    for (const auto& c : ev.cond) steps.push_back(c.step_ticks);
    return steps;
}

// Video (the reference, PCR on every PES) and audio (two 20 ms PES per frame, 900
// ticks on), one PES per buffer: from 20 s delivery runs `stall_ms` late, catching
// up at cu_num/cu_den of media time, and `step_at_ms` in every PID steps by `step`;
// 60 s. Collects every PES's written-minus-source PTS (the pre-step source).
struct SRec { int64_t h; int pid; int64_t pts, src, m; };
void stall_step(int64_t stall_ms, int64_t step, int64_t step_at_ms, int64_t cu_num, int64_t cu_den, Ev& ev,
                std::set<int64_t>& offv, std::set<int64_t>& offa) {
    TimelineStamper st = stamper(ev, true);
    wire(st, ev);
    const int64_t at = 20'000 * MS;
    std::vector<SRec> recs;
    for (int i = 0; i < 1500; i++) {
        for (const auto& pk : {std::make_pair(GV, 0), std::make_pair(GA, 0), std::make_pair(GA, 1)}) {
            const int pid = pk.first, k = pk.second;
            const int64_t m = (int64_t)i * STEP_NS + k * 20 * MS;
            const int64_t src = GFIRST + (int64_t)i * GVSTEP + (pid == GA ? 900 + k * 1800 : 0);
            const int64_t lat = m >= at ? std::max<int64_t>(0, stall_ms * MS - (m - at) * cu_num / cu_den) : 0;
            recs.push_back({HOUSE + m + (pid == GV ? 50 : 52) * MS + lat, pid,
                            src + (m >= at + step_at_ms * MS ? step : 0), src, m});
        }
    }
    std::sort(recs.begin(), recs.end(), [](const SRec& a, const SRec& b) {
        return std::tie(a.h, a.pid, a.pts, a.src, a.m) < std::tie(b.h, b.pid, b.pts, b.src, b.m);
    });
    for (const SRec& r : recs) {
        auto data = bytes_of({gpes(r.pid, r.pts, r.pid == GV ? 0xE0 : 0xC0, r.pid == GV)});
        st.condition(data.data(), data.size(), r.h);
        st.stamp(data.data(), data.size(), r.h, r.pid);
        (r.pid == GV ? offv : offa).insert(wrap_fold(read_pes_pts(data.data()) - r.src, PTS_WRAP));
    }
}

// From 60 s, bursts every `period_ms`, the newest frame of each 300 ms late.
Ev bursts(bool repair, int64_t period_ms) {
    Ev ev;
    TimelineStamper st = stamper(ev, repair);
    wire(st, ev);
    for (int i = 0; i < 3000; i++) {
        const int64_t m = (int64_t)i * STEP_NS;
        int64_t h = HOUSE + m + 50 * MS;
        if (m >= 60'000 * MS)
            h = HOUSE + 60'000 * MS + ((m - 60'000 * MS) / (period_ms * MS) + 1) * period_ms * MS + 350 * MS;
        auto data = bytes_of({gpes(GV, GFIRST + (int64_t)i * GVSTEP, 0xE0, true)});
        if (repair) st.condition(data.data(), data.size(), h);   // the HLS path does not condition
        st.stamp(data.data(), data.size(), h);
    }
    return ev;
}

}  // namespace

int main() {
    // --- the gap carry: a reconnect keeps the timeline ---------------------------
    {
        Split r = split(6950, 62);
        CHECK("gap carry: a 6.95 s SRT reconnect (+62 ms backlog head) does not re-anchor the splitter",
              r.ev.re.empty() && r.ev.se.size() == 1);
        CHECK("... it is reported once, on the video PID, +62 ms on the kept anchor",
              r.ev.gap.size() == 1 && r.ev.gap[0].pid == GV && r.ev.gap[0].margin_ns == 62 * MS &&
                  r.ev.gap[0].anchor_ns == HOUSE + GTRANSIT && r.ev.gap[0].count == 1 &&
                  r.anchor == HOUSE + GTRANSIT);
        bool head = false, mapped = true, av = true;
        for (const Row& w : r.rows) {
            if (w.k == 0) head = w.vs == w.h - 62 * MS;
            if (w.k >= 25) mapped &= w.vs == w.h;
            av &= w.as - w.vs == 10 * MS;
        }
        CHECK("... the backlog head leaves on its mapped time (late, not fast-forwarded), then every "
              "stamp is its arrival on the pre-gap mapping", head && mapped);
        CHECK("... audio stays the source's 10 ms on the video throughout, and nothing is conditioned",
              av && r.ev.cond.empty());
    }
    {
        Split r = split(17300, 146);
        CHECK("gap carry: a 17.3 s outage (+146 ms head) is carried too", r.ev.re.empty() && r.ev.gap.size() == 1);
    }
    {
        // .21's PTS (house + 1 h) wraps 2^33 every 26.5 h: the gap is judged on the unwrapped PES.
        Split r = split(6950, 62, 0, -1, true, 0, PTS_WRAP - 1580 * GVSTEP);
        bool mapped = true;
        for (const Row& w : r.rows)
            if (w.k >= 25) mapped &= w.vs == w.h;
        CHECK("gap carry: an outage across the 2^33 PTS wrap is carried the same way "
              "(+62 ms, stamps on the kept mapping)",
              r.ev.re.empty() && r.ev.gap.size() == 1 && r.ev.gap[0].margin_ns == 62 * MS && mapped);
    }
    for (const auto& hc : std::vector<std::pair<int64_t, bool>>{{330, true}, {800, true}, {1100, false}}) {
        Split r = split(6950, hc.first);
        const std::string name = "gap carry: a +" + std::to_string(hc.first) + " ms first PES is " +
                                 (hc.second ? "carried" : "a re-latch (past _GAP_LATE_NS)");
        CHECK(name.c_str(), hc.second ? r.ev.re.empty() && r.ev.gap.size() == 1
                                      : r.ev.re.size() == 1 && r.ev.gap.empty() && r.ev.se.size() == 2);
    }
    for (const auto& lc : std::vector<std::pair<int64_t, bool>>{{-200, true}, {-280, true}, {-350, false}}) {
        Split r = split(6950, 0, lc.first);
        const std::string name = "gap carry: a mapping " + std::to_string(-lc.first) + " ms EARLY after the gap is " +
                                 (lc.second ? "carried" : "re-anchored (past _GAP_EARLY_NS)");
        CHECK(name.c_str(), lc.second ? r.ev.re.empty() && r.ev.gap.size() == 1
                                      : r.ev.re.size() == 1 && r.ev.gap.empty());
    }
    {
        Split a = split(660'000, 50), b = split(60'000, 50, 0, 3630LL * 90000), c = split(6950, 62, 0, -1, false);
        CHECK("gap carry: an 11 min outage (past _GAP_MAX_TICKS) re-anchors as before, no gap event",
              a.ev.re.size() == 1 && a.ev.gap.empty());
        CHECK("gap carry: a reboot's new epoch (PTS = uptime + 1 h) re-anchors as before, no gap event",
              b.ev.re.size() == 1 && b.ev.gap.empty());
        CHECK("gap carry: repair off (the HLS fan-out) re-anchors as before, no gap event",
              c.ev.re.size() == 1 && c.ev.gap.empty());
    }
    {
        Split r = split(0, 0, 0, -1, true, 6);
        CHECK("gap carry: a +6 s PTS step with NO outage is a clock step for the conditioner, never a gap",
              r.ev.gap.empty() && r.ev.re.empty() && !r.ev.cond.empty());
    }
    {
        Split r = split(6950, 0, 180);
        int64_t res = 0;
        for (const Row& w : r.rows)
            if (w.k == 0) res = w.h;
        CHECK("gap carry: a kept anchor that turns out 180 ms late is the late tier's: one re-anchor, 10 s of "
              "delivery on",
              r.ev.gap.size() == 1 && r.ev.gap[0].margin_ns == 180 * MS && r.ev.re.size() == 1 &&
                  r.ev.re[0].delta_ticks < 0 && std::llabs(r.ev.re[0].anchor_ns - res - 10'000'000'000LL) <= STEP_NS);
    }

    // The drift servo's state crosses a carried gap: 30 min of a source 20 ppm
    // fast (the servo engaged), then a 60 s outage. The locked rate slews the
    // anchor through it, and the gap is judged on the anchor AS SLEWED.
    {
        Ev ev;
        TimelineStamper st = stamper(ev, true);
        wire(st, ev);
        TimelineStamper::Drift d0{};
        int64_t margin = 0, slewed = 0;
        for (int i = 0; i < 9900; i++) {
            if (i >= 9000 && i < 9300) continue;
            const int64_t h = HOUSE + (int64_t)i * 200 * MS + GTRANSIT;
            if (i == 9300) d0 = st.drift();
            const int64_t v = GFIRST + (int64_t)i * 200 * MS * 1'000'000 / 999'980 * 9 / 100'000;
            const int64_t s = stamp_of(st, {pes_packet(GV, v)}, h);
            if (i == 9300) {
                margin = h - s;
                slewed = st.drift().slew_ns - d0.slew_ns;
            }
        }
        CHECK("gap carry: drift — the servo had locked a rate before the gap", d0.samples == 10 && d0.ppb != 0);
        CHECK("... the 60 s gap is carried: no re-anchor, the trend window kept",
              ev.re.empty() && ev.gap.size() == 1 && st.drift().samples == 10);
        CHECK("... the locked rate ran on through it (rate x 60.2 s, to the microsecond)",
              std::llabs(slewed - fdiv(d0.ppb * 301 * 200 * MS, 1'000'000'000LL)) <= 1000);
        CHECK("... and the gap's margin is the one its PES was stamped with",
              ev.gap.size() == 1 && ev.gap[0].margin_ns == margin);
    }

    // The Hall egress behind a held frame.
    for (const int64_t gap : {700LL, 3000LL, 6950LL, 16200LL}) {
        Ev ev;
        const std::vector<HRow> rows = hall(gap, true, 0, ev);
        const std::string tag = std::to_string(gap) + " ms";
        const std::string n1 = "Hall egress, " + tag + " gap behind a held frame: not a clock step, not a re-anchor" +
                               (gap > 5000 ? ", one gap carried" : "");
        CHECK(n1.c_str(), ev.cond.empty() && ev.re.empty() && ev.gap.size() == (gap > 5000 ? 1u : 0u));
        bool raw = true, mapped = true, on_lead = true;
        int pcrs = 0;
        for (const HRow& w : rows) {
            raw &= read_pes_pts(w.data.data()) == w.v;
            if (w.k >= 0) mapped &= w.s == w.h;
            if (w.k >= -1 && read_pcr(w.data.data()) >= 0) {
                const int64_t lead = wrap_fold(read_pes_pts(w.data.data()) - read_pcr(w.data.data()) / 300, PTS_WRAP);
                on_lead &= lead >= 22500 && lead <= 22500 + GASTEP;
                pcrs++;
            }
        }
        const std::string n2 = "... (" + tag + ") the wire PTS are the source's and every post-gap stamp is its "
                               "arrival on the pre-gap mapping (Headphone1 does not move)";
        CHECK(n2.c_str(), raw && mapped);
        if (gap > 1000) {
            // A PCR from the held frame on trails its OWN PES by the lead (+ one
            // frame), never the pre-gap floor by the gap (#806's PCR-after-gap
            // rule, on the DUE time).
            const std::string n3 = "... (" + tag + ") every PCR past the gap trails its own PES by the lead";
            CHECK(n3.c_str(), pcrs > 0 && on_lead);
        }
    }
    {
        Ev ev;
        bool mapped = true;
        for (const HRow& w : hall(6950, false, 0, ev))
            if (w.k >= 0) mapped &= w.s == w.h;
        CHECK("Hall egress, the same gap with no held frame: carried the same way", mapped);
    }

    // The late tier's hold counts DELIVERED time across a gap (.24 Hall egress,
    // 14:15:04 and 14:17:51: "-0.11s / -0.10s" re-anchors past 16-17 s gaps).
    // +105 ms (> LATE_NS) for the last 2 s before the gap, a +60 ms head on it for
    // 1 s after, then +90 ms: 3 s of late DELIVERY, never 10.
    for (const int64_t gap : {12000LL, 16200LL}) {
        for (const bool held : {true, false}) {
            Ev ev;
            TimelineStamper st = stamper(ev, true);
            wire(st, ev);
            const int n_pre = 375, g = (int)(gap * 90 / GASTEP);
            std::vector<std::pair<int64_t, int>> sched;
            for (int i = 0; i < n_pre + g + 1406; i++) {
                if (i >= n_pre && i < n_pre + g) continue;
                const int64_t back = pts90k_to_ns((int64_t)(i - n_pre - g) * GASTEP);
                int64_t lvl;
                if (i < n_pre) lvl = i < 140 ? 0 : (i < 281 ? 90 * MS : 105 * MS);
                else lvl = back < 1'000'000'000LL ? 105 * MS + std::max<int64_t>(0, 60 * MS - 60 * MS * back / 1'000'000'000LL)
                                                  : 90 * MS;
                sched.push_back({HOUSE + pts90k_to_ns(i * GASTEP) + 30 * MS + lvl, i});
            }
            if (held) {
                int64_t first = 0;
                for (const auto& e : sched)
                    if (e.second >= n_pre + g) { first = e.first; break; }
                for (auto& e : sched)
                    if (e.second == n_pre - 1) e.first = first - 1;
                std::sort(sched.begin(), sched.end());
            }
            for (const auto& e : sched) {
                auto data = bytes_of({gpes(GH, GFIRST + e.second * GASTEP, 0xBD, true)});
                st.condition(data.data(), data.size(), e.first);
                st.stamp(data.data(), data.size(), e.first);
            }
            const std::string name = "late hold across a " + std::to_string(gap) + " ms gap (" +
                                     (held ? "held frame" : "no held frame") + "): no re-anchor, the gap carried";
            CHECK(name.c_str(), ev.re.empty() && ev.cond.empty() && ev.gap.size() == 1);
        }
    }
    // ... the LONGEST pause in the hold, once per hold: a 1.5 s stall in the 4 s of
    // late delivery before a 16.2 s gap must not use the hold's allowance up, and
    // the same again 30 s later is a new hold with its own.
    {
        Ev ev;
        TimelineStamper st = stamper(ev, true);
        wire(st, ev);
        const int g = (int)(16200 * 90 / GASTEP);
        const int starts[2] = {375, 375 + g + 1406 + 375};
        std::vector<std::pair<int64_t, int>> sched;
        for (int i = 0; i < starts[1] + g + 1406; i++) {
            if ((i >= starts[0] && i < starts[0] + g) || (i >= starts[1] && i < starts[1] + g)) continue;
            int64_t lvl = i < 140 ? 0 : 90 * MS;
            int at = i;
            for (const int s : starts) {
                const int64_t back = pts90k_to_ns((int64_t)(i - s - g) * GASTEP);
                if (i >= s - 188 && i < s) {
                    lvl = 105 * MS;
                    if (i >= s - 140 && i < s - 70) at = s - 70;   // the stall: delivered with frame s - 70
                } else if (back >= 0 && back < 1'000'000'000LL) {
                    lvl = 105 * MS + 60 * MS - 60 * MS * back / 1'000'000'000LL;
                }
            }
            sched.push_back({HOUSE + pts90k_to_ns((int64_t)at * GASTEP) + 30 * MS + lvl, i});
        }
        std::sort(sched.begin(), sched.end());
        for (const auto& e : sched) {
            auto data = bytes_of({gpes(GH, GFIRST + e.second * GASTEP, 0xBD, true)});
            st.condition(data.data(), data.size(), e.first);
            st.stamp(data.data(), data.size(), e.first);
        }
        CHECK("late hold, its longest pause once per hold: a 1.5 s stall in the hold before each of two 16200 ms "
              "gaps 30 s apart: no re-anchor, both gaps carried",
              ev.re.empty() && ev.cond.empty() && ev.gap.size() == 2);
    }

    // The due-time rule is BOUNDED (COND_GAP_NS of media past the last on-time
    // PES): after a stall delivery never recovers from, a genuine +-1.1 s pacer
    // reset 5 s later is still a clock step.
    for (const int64_t stall : {0LL, 900LL, 3000LL}) {
        for (const int64_t step : {99000LL, -99000LL}) {
            Ev ev;
            TimelineStamper st = stamper(ev, true);
            wire(st, ev);
            for (int i = 0; i < 1875; i++) {
                const int64_t pts = GFIRST + i * GASTEP + (i >= 703 ? step : 0);
                const int64_t h = HOUSE + pts90k_to_ns(i * GASTEP) + (i >= 469 ? stall * MS : 0);
                auto data = bytes_of({gpes(0x44, pts, 0xC0, true)});
                st.condition(data.data(), data.size(), h);
                st.stamp(data.data(), data.size(), h);
            }
            char name[160];
            std::snprintf(name, sizeof name, "a %+.1f s pacer reset %s is still absorbed", step / 90000.0,
                          stall ? ("5 s after a " + std::to_string(stall) + " ms stall that never recovers").c_str()
                                : "with continuous delivery");
            CHECK(name, ev.cond.size() == 1 && ev.cond[0].step_ticks == step);
        }
    }
    // ... pinned at 1 s from both sides, and FORWARD jumps only; a B-frame's
    // negative delta is never held (it would walk the due time back).
    CHECK("a +0.6 s step 0.7 s into a 600 ms stall that persists is the held chain's time that passed, "
          "not a step (the due chain runs 1 s)", chain(600, 54000, 33).empty());
    CHECK("... 1.3 s into it, it is absorbed (the due chain ends 1 s past the last on-time PES)",
          chain(600, 54000, 61) == std::vector<int64_t>{54000});
    CHECK("a -1.1 s step 0.5 s into a 1.2 s stall that persists is absorbed: the due time never vetoes a backward jump",
          chain(1200, -99000, 23) == std::vector<int64_t>{-99000});
    CHECK("a video PID with B-frames, a +0.6 s step 0.5 s into a 600 ms stall that persists: absorbed "
          "(a negative delta is never held)", chain(600, 54000, 13, true) == std::vector<int64_t>{54000});

    // On a PROGRAM every PID decides on arrival, as on #806: the due-time veto is
    // one-PID only. Applied per PID (earlier drafts), a program step landing in a
    // stall reached the PIDs differently and split A/V by the whole step.
    const int64_t shapes[3][4] = {{400, 120, 1, 3}, {700, 120, 1, 3}, {1000, 40, 9, 10}};
    for (const auto& sh : shapes) {
        for (const int64_t step : {99000LL, -99000LL}) {
            Ev ev;
            std::set<int64_t> offv, offa;
            stall_step(sh[0], step, sh[1], sh[2], sh[3], ev, offv, offa);
            char tag[96];
            std::snprintf(tag, sizeof tag, "%+.1f s program step %lld ms into a %lld ms stall", step / 90000.0,
                          (long long)sh[1], (long long)sh[0]);
            CHECK((std::string(tag) + ": the reference absorbs it and the second PID adopts it, one event each, "
                                      "no re-anchor").c_str(),
                  ev.cond.size() == 2 && ev.cond[0].pid == GV && ev.cond[0].step_ticks == step && ev.cond[1].pid == GA &&
                      ev.cond[1].step_ticks == step && ev.re.empty());
            CHECK(("... (" + std::string(tag) + ") A/V holds at every PES: both PIDs' written PTS stay on the "
                                                "pre-step timeline, nothing booked as the audio's own to release").c_str(),
                  offv == std::set<int64_t>{0} && offa == std::set<int64_t>{0});
        }
    }

    // The repo's vMix pacer reset (ts_timeline_test.cpp) on its muxed egress, with
    // a 1.5 s delivery stall (draining at 2x) from frame 149, where the video's
    // 1.19 s step back lands in it, or 248, where the leap forward does.
    for (const int at : {149, 248}) {
        constexpr int VX = 0x100, AX = 0x140;
        constexpr int64_t A_BACK = 127800, V_BACK = 107100;
        Ev ev;
        TimelineStamper st = stamper(ev, true);
        wire(st, ev);
        bool kept = true;
        for (int i = 0; i < 1500; i++) {
            const int64_t lat = i >= at ? std::max<int64_t>(0, 1500 * MS - (int64_t)(i - at) * 20 * MS) : 0;
            const int64_t h = HOUSE + i * STEP_NS + lat;
            const int64_t v = FIRST_PES + i * STEP - (i >= 150 && i < 250 ? V_BACK : 0);
            const int64_t a = FIRST_PES + 900 + i * STEP - (i >= 100 && i < 249 ? A_BACK : 0);
            const bool dts = i >= 100 && i < 249;     // vMix's marker: a DTS after the PTS
            auto data = bytes_of({pcr_packet(VX, (FIRST_PES - 9000 + i * STEP + (i >= 250 ? V_BACK : 0)) * 300),
                                  pes_packet(VX, v),
                                  dts ? pes_dts_packet(AX, a, a + A_BACK, 0xC0) : pes_packet(AX, a, 0xC0)});
            st.condition(data.data(), data.size(), h);
            st.stamp(data.data(), data.size(), h);
            const int64_t rel = read_pes_pts(data.data() + 2 * PKT) - read_pes_pts(data.data() + PKT);
            if (i >= 260) kept &= wrap_fold(rel, PTS_WRAP) == 900;
        }
        CHECK(("vMix pacer reset under a 1.5 s delivery stall from frame " + std::to_string(at) +
               " (draining at 2x): A/V after the reset is the source's").c_str(), kept);
    }

    // On a one-PID egress a content gap behind a late burst is a gap, never a step,
    // whether delivery is on time again after it (#806 read the burst's lateness as
    // the step; a program still does) or stays late through it: three frames 450 ms
    // late, then 400 ms of frames never produced, then 10 more on time or still late.
    for (const bool late_after : {false, true}) {
        Ev ev;
        TimelineStamper st = stamper(ev, true);
        wire(st, ev);
        const int k = 1500, g = 10;
        for (int i = 0; i < k + 200; i++) {
            if (i >= k + 3 && i < k + 3 + g) continue;
            int64_t h = HOUSE + (int64_t)i * STEP_NS + GTRANSIT;
            if ((i >= k && i < k + 3) || (late_after && i >= k + 3 + g && i < k + 13 + g)) h += 450 * MS;
            auto data = bytes_of({gpes(GV, GFIRST + (int64_t)i * GVSTEP, 0xE0, true)});
            st.condition(data.data(), data.size(), h);
            st.stamp(data.data(), data.size(), h);
        }
        const std::string name = std::string("a 400 ms content gap behind a 450 ms late burst, delivery ") +
                                 (late_after ? "staying late through it" : "on time after it") +
                                 ": no clock step, no re-anchor";
        CHECK(name.c_str(), ev.cond.empty() && ev.re.empty());
    }

    // The held frame's successor is judged from the held frame's due time on BOTH
    // counts — the jump against the time that passed, and the delivery-gap bound —
    // so a backlog head past the step threshold does not turn a gap of 700 ms or more
    // back into a clock step (a 320-600 ms gap with a 300-600 ms head still does).
    for (const int64_t gap : {700LL, 6950LL}) {
        Ev ev;
        bool mapped = true;
        for (const HRow& w : hall(gap, true, 450, ev))
            if (w.k >= 47) mapped &= w.s == w.h;
        const std::string name = "Hall egress, " + std::to_string(gap) +
                                 " ms gap behind a held frame, a +450 ms backlog head: still not a clock step, "
                                 "not a re-anchor" + (gap > 5000 ? ", one gap carried" : "");
        CHECK(name.c_str(), ev.cond.empty() && ev.re.empty() && ev.gap.size() == (gap > 5000 ? 1u : 0u) && mapped);
    }

    // A hold takes out ONE delivery pause: a link that delivers in bursts more than
    // 1 s apart and stays late is late; in house time the hold matures 10 s after
    // the first late burst, as it still does with the repair off (HLS) or bursts
    // under 1 s apart.
    {
        const Ev ev = bursts(true, 1500), off = bursts(false, 1500), fast = bursts(true, 750);
        CHECK("bursts 1.5 s apart, the newest frame 300 ms late: the late tier still re-anchors, once, "
              "one burst later than in house time",
              ev.cond.empty() && ev.re.size() == 1 && ev.re[0].anchor_ns - HOUSE == 73'850 * MS);
        CHECK("... with the repair off (HLS) the hold counts house time, as before: once, at the first burst past 10 s",
              off.re.size() == 1 && off.re[0].anchor_ns - HOUSE == 72'350 * MS);
        CHECK("... bursts 0.75 s apart pause under 1 s: the hold counts house time, once, at the first burst past 10 s",
              fast.re.size() == 1 && fast.re[0].anchor_ns - HOUSE == 71'600 * MS);
    }

    // C++ only: the event as the native producers emit it (mr-tssplit), field for
    // field what python's `on_gap` payload carries.
    CHECK("gap_event_json carries python's field names verbatim",
          gap_event_json({GV, 100, 625600, 625500, 62 * MS, HOUSE, 3}) ==
              "{\"event\":\"timeline_gap\",\"pid\":250,\"lastPts90k\":100,\"pts90k\":625600,"
              "\"deltaTicks\":625500,\"marginNs\":62000000,\"anchorNs\":1000000000000,\"count\":3}");

    return test_summary("ts_timeline_gap");
}
