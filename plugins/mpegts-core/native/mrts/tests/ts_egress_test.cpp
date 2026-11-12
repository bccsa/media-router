// ts_egress: mrts::EgressCore and EgressDelay (plan ch. 9 WI-P5-2's acceptance, p5-2b, B-222)
// on generated streams: PTS/DTS on the network across the wire wrap, a split header, the sparse
// and the missing PCR PID, D_e's start, raises, max and lowering at a gap, the descriptor once on
// a relay, the re-epoch, the error class's hold, S22's lateness cut, and the bytes outside the
// rewritten fields; the input never written. Byte parity with py/egress_core.py is
// egress_parity_test.py's.
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <deque>
#include <functional>
#include <map>
#include <string>
#include <vector>

#include "../ts_egress.h"
#include "../ts_gap.h"
#include "../ts_house.h"
#include "check.h"
#include "ts_gen.h"

using namespace mrts;
using ts_gen::Bytes;

namespace {

constexpr int64_t MS = 1000000, SEC = 1000000000;
constexpr int64_t E1 = 1760283215123456789LL;    // a TAI - MONOTONIC of 2025

ClockDecl clock_e(int64_t e = E1) {
    ClockDecl c;
    c.e_ns = e;
    c.seq = 3;
    c.known = c.traceable = c.disciplined = true;
    c.source = hcdesc::SYNC_NTP;
    c.tai_offset_s = 37;
    c.error_us = 1200;
    return c;
}

int64_t floor_div128(__int128 a, __int128 b) {
    __int128 q = a / b;
    if (a % b != 0 && ((a < 0) != (b < 0))) q -= 1;
    return (int64_t)q;
}

// The content clock of a recording (py/egress_core.py content_anchors): the first PCR PID's
// PCRs - 1 h, else the first timing PID's DTS/PTS, linear by byte offset, held outside.
struct Content {
    std::vector<std::pair<int64_t, int64_t>> pts;
    explicit Content(const Bytes& d) {
        int pcr_pid = -1;
        for (size_t o = 0; o + PKT <= d.size() && pcr_pid < 0; o += PKT)
            if (read_pcr(d.data() + o) >= 0) pcr_pid = ts_pid(d.data() + o);
        int64_t last = 0, u = 0;
        bool have = false;
        int tpid = -1;
        for (size_t o = 0; o + PKT <= d.size(); o += PKT) {
            const uint8_t* p = d.data() + o;
            if (pcr_pid >= 0) {
                const int64_t v = read_pcr(p);
                if (ts_pid(p) != pcr_pid || v < 0) continue;
                int64_t dd = ((v - last) % PCR_MODULO + PCR_MODULO) % PCR_MODULO;
                u = have ? u + (dd > PCR_MODULO / 2 ? dd - PCR_MODULO : dd) : v;
                last = v;
                have = true;
                pts.emplace_back((int64_t)o, pcr27_to_ns(u) - 3600 * SEC);
                continue;
            }
            uint8_t b[PKT];
            std::memcpy(b, p, PKT);
            PacketView v;
            parse_packet(b, &v);
            PesHeader h;
            if (!v.pusi || v.payload_off >= PKT || !parse_pes_header(b + v.payload_off, PKT - v.payload_off, &h) ||
                !h.complete || h.pts < 0 || !((h.sid & 0xF0) == 0xE0 || (h.sid & 0xE0) == 0xC0))
                continue;
            if (tpid < 0) tpid = v.pid;
            if (v.pid != tpid) continue;
            const int64_t t = h.dts >= 0 ? h.dts : h.pts;
            u = have ? u + fold33(t - last) : t;
            last = t;
            have = true;
            pts.emplace_back((int64_t)o, pts90k_to_ns(u) - 3600 * SEC);
        }
    }
    int64_t at(int64_t off) const {
        if (pts.empty()) return 0;
        size_t k = 0;
        while (k < pts.size() && pts[k].first <= off) k++;
        if (k == 0) return pts[0].second;
        if (k == pts.size()) return pts.back().second;
        const auto &a = pts[k - 1], &b = pts[k];
        return a.second + floor_div128((__int128)(b.second - a.second) * (off - a.first), b.first - a.first);
    }
};

struct OffClock : ClockReader {
    std::function<int64_t(int64_t)> now;
    int64_t off = 0;
    int64_t read(size_t i) const override { return now(off + (int64_t)i * PKT); }
};

struct Change {
    int64_t at_ns;                               // content since the first anchor
    std::function<void(ClockDecl&)> edit;
};

// A replay as the CLI's: `chunk`-byte buffers, now = content + lateness(content - first).
struct Run {
    Bytes out;
    std::vector<EgressEvent> ev;
    std::vector<EgressStats> st;
    EgressCounters counters;
    bool input_kept = true;                      // every buffer's bytes unchanged by process()
    bool apply_ok = true;                        // edits in index order, inserts first
};

Run replay(const Bytes& in, std::function<int64_t(int64_t)> lateness, size_t chunk = 1316,
           const ClockDecl& clock0 = clock_e(), const EgressConfig& cfg = EgressConfig(),
           std::vector<Change> changes = {}) {
    Run r;
    const Content content(in);
    const int64_t c0 = content.pts.empty() ? 0 : content.pts[0].second;
    OffClock clk;
    clk.now = [&](int64_t off) {
        const int64_t c = content.at(off);
        return c + lateness(c - c0);
    };
    EgressCore core(cfg);
    ClockDecl clock = clock0;
    core.set_clock(clock);
    for (size_t off = 0; off < in.size(); off += chunk) {
        while (!changes.empty() && content.at((int64_t)off) - c0 >= changes.front().at_ns) {
            changes.front().edit(clock);
            core.set_clock(clock);
            changes.erase(changes.begin());
        }
        const size_t n = std::min(chunk, in.size() - off);
        const Bytes before(in.begin() + off, in.begin() + off + n);
        clk.off = (int64_t)off;
        const EgressResult& res = core.process(in.data() + off, n, clk.now((int64_t)off), clk);
        r.input_kept = r.input_kept && std::equal(before.begin(), before.end(), in.begin() + off);
        uint32_t last = 0;
        bool own = false;
        for (const EgressEdit& e : res.edits()) {
            if (e.index < last || (e.index == last && own)) r.apply_ok = false;
            own = e.op != EgressEdit::Op::insert;
            last = e.index;
        }
        res.apply(r.out);
        for (const EgressEvent& e : core.take_events()) r.ev.push_back(e);
    }
    core.flush(r.out);
    for (int p : core.programs()) {
        EgressStats s;
        core.stats(p, &s);
        r.st.push_back(s);
    }
    r.counters = core.counters();
    return r;
}

std::function<int64_t(int64_t)> fixed(int64_t ms) {
    return [ms](int64_t) { return ms * MS; };
}

// A ramp of (content ms, lateness ms) points, linear between, held outside.
std::function<int64_t(int64_t)> ramp(std::vector<std::pair<int64_t, int64_t>> p) {
    return [p](int64_t c) {
        if (c <= p[0].first * MS) return p[0].second * MS;
        for (size_t k = 1; k < p.size(); k++) {
            if (c < p[k].first * MS) {
                const int64_t x0 = p[k - 1].first * MS, x1 = p[k].first * MS;
                return p[k - 1].second * MS + floor_div128((__int128)(p[k].second - p[k - 1].second) * MS * (c - x0), x1 - x0);
            }
        }
        return p.back().second * MS;
    };
}

int count(const std::vector<EgressEvent>& ev, EgressEvent::Kind k) {
    return (int)std::count_if(ev.begin(), ev.end(), [k](const EgressEvent& e) { return e.kind == k; });
}

// The records of an output TS in order: pes (a split header joined), pcr, pmt.
struct Rec {
    enum Kind { pes, pcr, pmt } kind;
    size_t idx;
    int pid;
    int64_t pts = -1, dts = -1, pcr27 = -1;
    uint8_t sid = 0;
    bool disc = false, af_only = false;
    uint8_t cc = 0;
    Pmt pmt_v;
    std::vector<uint8_t> section;
    Rec(Kind k, size_t i, int p) : kind(k), idx(i), pid(p) {}
};

struct Walk {
    std::vector<Rec> recs;
    std::vector<const uint8_t*> pkts;
    int pmt_pid = -1;
    explicit Walk(const Bytes& d) {
        for (size_t o = 0; o + PKT <= d.size(); o += PKT) pkts.push_back(d.data() + o);
        std::deque<TsPacket> pat;
        for (const uint8_t* p : pkts) {
            if (ts_pid(p) != PID_PAT) continue;
            TsPacket t;
            std::memcpy(t.b, p, PKT);
            pat.push_back(t);
            const auto progs = parse_pat(pat);
            if (!progs.empty()) {
                pmt_pid = progs[0].second;
                break;
            }
        }
        std::map<int, size_t> open;              // a PID's PUSI packet whose header continues
        for (size_t i = 0; i < pkts.size(); i++) {
            uint8_t b[PKT];
            std::memcpy(b, pkts[i], PKT);
            PacketView v;
            parse_packet(b, &v);
            if (v.af_pcr) {
                Rec r{Rec::pcr, i, v.pid};
                r.pcr27 = read_pcr(b);
                r.disc = v.af_discontinuity;
                r.af_only = v.payload_off >= PKT;
                r.cc = v.cc;
                recs.push_back(r);
            }
            if (v.pid == pmt_pid && v.pusi) {
                std::deque<TsPacket> one(1);
                std::memcpy(one[0].b, b, PKT);
                std::vector<uint8_t> sec;
                if (first_section(one, pmt_pid, sec)) {
                    Rec r{Rec::pmt, i, v.pid};
                    if (auto pm = parse_pmt(one, pmt_pid)) r.pmt_v = *pm;
                    r.section = sec;
                    recs.push_back(r);
                }
                continue;
            }
            if (v.payload_off >= PKT || v.pid == PID_PAT || v.pid == PID_NULL) continue;
            auto it = open.find(v.pid);
            if (it != open.end()) {
                uint8_t a[PKT];
                std::memcpy(a, pkts[it->second], PKT);
                PacketView va;
                parse_packet(a, &va);
                std::vector<uint8_t> buf(a + va.payload_off, a + PKT);
                buf.insert(buf.end(), b + v.payload_off, b + PKT);
                PesHeader h;
                if (!v.pusi && parse_pes_header(buf.data(), buf.size(), &h) && h.complete && h.pts >= 0) {
                    Rec r{Rec::pes, it->second, v.pid};
                    r.pts = h.pts, r.dts = h.dts, r.sid = h.sid;
                    recs.push_back(r);
                }
                open.erase(it);
            }
            if (!v.pusi) continue;
            PesHeader h;
            if (!parse_pes_header(b + v.payload_off, PKT - v.payload_off, &h)) continue;
            if (!h.complete) {
                open[v.pid] = i;
                continue;
            }
            if (h.pts < 0) continue;
            Rec r{Rec::pes, i, v.pid};
            r.pts = h.pts, r.dts = h.dts, r.sid = h.sid;
            recs.push_back(r);
        }
    }
    std::vector<Rec> of(Rec::Kind k, int pid = -1) const {
        std::vector<Rec> r;
        for (const Rec& x : recs)
            if (x.kind == k && (pid < 0 || x.pid == pid)) r.push_back(x);
        return r;
    }
};

bool decl_of(const Rec& pmt, HouseTimeDecl* d) { return hcdesc::find_in(pmt.pmt_v.program_info, d); }

int mrht_count(const std::vector<uint8_t>& pi) {
    int n = 0;
    for_each_descriptor(pi.data(), (int)pi.size(), [&](const Descriptor& d) {
        if (d.tag == 0x05 && d.len >= 4 && std::memcmp(d.data, "MRHT", 4) == 0) n++;
    });
    return n;
}

// --- the cases ---------------------------------------------------------------------------------

// Every output PES PTS/DTS is bus_to_net of its input's, PID by PID in order.
bool pes_mapped(const Bytes& in, const Bytes& out, int64_t e, bool* b_frames_ok = nullptr) {
    const Walk wi(in), wo(out);
    std::map<int, std::vector<Rec>> a, b;
    for (const Rec& r : wi.of(Rec::pes)) a[r.pid].push_back(r);
    for (const Rec& r : wo.of(Rec::pes)) b[r.pid].push_back(r);
    if (a.size() != b.size() || a.empty()) return false;
    bool bf = true;
    int behind = 0;
    for (auto& [pid, xs] : a) {
        const auto& ys = b[pid];
        if (xs.size() != ys.size()) return false;
        for (size_t k = 0; k < xs.size(); k++) {
            if (ys[k].pts != bus_to_net(xs[k].pts, NetEpoch{e})) return false;
            if ((xs[k].dts >= 0) != (ys[k].dts >= 0)) return false;
            if (xs[k].dts >= 0 && ys[k].dts != bus_to_net(xs[k].dts, NetEpoch{e})) return false;
            if (ys[k].dts >= 0) {
                bf = bf && fold33(ys[k].pts - ys[k].dts) >= 0;
                behind += fold33(ys[k].pts - ys[k].dts) > 0;
            }
        }
    }
    if (b_frames_ok) *b_frames_ok = bf && behind > 0;
    return true;
}

// An E of 2025 that puts the wire's 2^33 wrap at this bus PTS.
int64_t e_wrapping_at(int64_t pts_bus) {
    const int64_t e90 = 18400 * PTS_WRAP + (((MUX_CLOCK_BASE_90K - pts_bus) % PTS_WRAP) + PTS_WRAP) % PTS_WRAP;
    return -floor_div128(-(__int128)e90 * 100000, 9);
}

void test_wrap() {
    const Bytes in = ts_gen::wrap_33bit(5 * trace_gen::S);
    const Run r1 = replay(in, fixed(100));
    bool bf1 = false, bf2 = false;
    CHECK("wrap: every PES PTS/DTS = bus_to_net(in), E of 2025", pes_mapped(in, r1.out, E1, &bf1));
    const auto pes = Walk(in).of(Rec::pes);
    const int64_t e2 = e_wrapping_at(pes[pes.size() / 2].pts);
    const Run r2 = replay(in, fixed(100), 1316, clock_e(e2));
    const auto po = Walk(r2.out).of(Rec::pes);
    bool wraps = false;
    for (size_t k = 1; k < po.size(); k++)
        if (po[k].pid == po[0].pid) wraps = wraps || po[k].pts < 1000000;
    CHECK("wrap: an E that wraps the wire mid-file, every PES = bus_to_net(in), the wrap inside",
          pes_mapped(in, r2.out, e2, &bf2) && wraps);
    CHECK("wrap: B-frame DTS behind PTS across the wrap", bf1 && bf2);
    CHECK("wrap: the input array unchanged after every process()", r1.input_kept && r2.input_kept);
    CHECK("wrap: edits in index order, inserts before the packet's own", r1.apply_ok && r2.apply_ok);
}

void test_header_split() {
    const Bytes in = ts_gen::pes_header_split();
    const Run r = replay(in, fixed(100));
    CHECK("header split: every PES rewritten (PTS/DTS = bus_to_net(in))", pes_mapped(in, r.out, E1));
    // Other PIDs are never delayed behind the held video: each AAC packet has no more video
    // packets before it in the output than in the input.
    auto before_counts = [](const Bytes& d, int pid, int held) {
        std::vector<int> r;
        int n = 0;
        for (size_t o = 0; o + PKT <= d.size(); o += PKT) {
            const int p = ts_pid(d.data() + o);
            if (p == held && ts_has_payload(d.data() + o)) n++;   // inserted PCR-only packets aside
            if (p == pid) r.push_back(n);
        }
        return r;
    };
    const auto a = before_counts(in, 0x101, 0x100), b = before_counts(r.out, 0x101, 0x100);
    bool kept = a.size() == b.size() && !a.empty();
    for (size_t k = 0; kept && k < a.size(); k++) kept = b[k] <= a[k];
    CHECK("header split: AAC not delayed behind the held video", kept);
    CHECK("header split: held packets counted, nothing left held", r.counters.held > 0 && r.out.size() % PKT == 0);
}

// ns between consecutive PCRs on pid, a flagged one starting anew.
int64_t max_pcr_interval(const Bytes& out, int pid, size_t* n = nullptr) {
    int64_t worst = 0, last = -1;
    size_t k = 0;
    for (const Rec& r : Walk(out).of(Rec::pcr, pid)) {
        if (last >= 0 && !r.disc) {
            worst = std::max(worst, pcr27_to_ns(((r.pcr27 - last) % PCR_MODULO + PCR_MODULO) % PCR_MODULO));
            k++;
        }
        last = r.pcr27;
    }
    if (n) *n = k;
    return worst;
}

void test_sparse_pcr() {
    const Bytes in = ts_gen::egress(10 * SEC, true, false);
    // One packet a buffer, now 2 ms on per packet: the interval holds to 35 + 2 ms.
    EgressCore core;
    core.set_clock(clock_e());
    Bytes direct;
    for (size_t off = 0; off < in.size(); off += PKT)
        core.process(in.data() + off, PKT, 5000 * SEC + (int64_t)(off / PKT) * 2 * MS).apply(direct);
    size_t n = 0;
    EgressStats st;
    core.stats(1, &st);
    CHECK("sparse PCR: buffers 2 ms apart, the PCR PID's interval <= 35 + 2 ms",
          max_pcr_interval(direct, 0x101, &n) <= 37 * MS && n >= 20 && st.pcr_inserted > st.pcr_written);
    const Run r = replay(in, fixed(100));
    const Content c(in);
    int64_t spacing = 0;
    for (size_t o = 1316; o < in.size(); o += 1316) spacing = std::max(spacing, c.at((int64_t)o) - c.at((int64_t)o - 1316));
    CHECK("sparse PCR: a 1316-byte replay within 35 ms plus its buffer spacing",
          max_pcr_interval(r.out, 0x101) <= 35 * MS + spacing);
    const Walk w(direct);
    bool af = true, ccok = true;
    int last_cc = -1;
    CcTracker t;
    bool loss = false;
    for (const uint8_t* p : w.pkts) {
        uint8_t b[PKT];
        std::memcpy(b, p, PKT);
        PacketView v;
        parse_packet(b, &v);
        loss = loss || t.feed(v) == CcTracker::Result::Lost;
        if (v.pid != 0x101) continue;
        if (v.payload_off < PKT) {
            last_cc = v.cc;
        } else if (v.af_pcr && last_cc >= 0) {
            ccok = ccok && v.cc == last_cc;
            af = af && !v.has_payload;
        }
    }
    CHECK("sparse PCR: inserted packets adaptation-only with the PID's last payload CC", af && ccok);
    CHECK("sparse PCR: an output CcTracker reports no loss", !loss);
}

void test_no_pcr_pid() {
    const Bytes in = ts_gen::egress(5 * SEC, false, true);
    const Run r = replay(in, fixed(100));
    const auto pmts = Walk(r.out).of(Rec::pmt);
    bool crc = !pmts.empty(), pid = !pmts.empty();
    for (const Rec& p : pmts) {
        crc = crc && crc32_mpeg(p.section.data(), p.section.size()) == 0;
        pid = pid && p.pmt_v.pcr_pid == 0x100;
    }
    CHECK("no PCR PID: the video PID chosen, the PMT rewritten with it", pid && r.st[0].pcr_pid == 0x100);
    CHECK("no PCR PID: every output PMT's CRC valid", crc);
    CHECK("no PCR PID: one pcr-pid-assigned", count(r.ev, EgressEvent::Kind::pcr_pid_assigned) == 1);
    const Run ra = replay(ts_gen::egress(5 * SEC, true, true), fixed(100));
    CHECK("no PCR PID, audio only: the audio PID chosen", ra.st[0].pcr_pid == 0x101);
}

int64_t ceil10(int64_t v) { return (v + 10 * MS - 1) / (10 * MS) * (10 * MS); }

// DTS (PTS without) - the PCR in force when the PES left, per timing PES after the first.
int64_t dts_pcr_min(const Bytes& out, int pcr_pid) {
    const Walk w(out);
    int64_t pcr = -1, worst = INT64_MAX;
    bool first = true;
    for (const Rec& r : w.recs) {
        if (r.kind == Rec::pcr && r.pid == pcr_pid) pcr = r.pcr27;
        if (r.kind != Rec::pes || pcr < 0 || !((r.sid & 0xF0) == 0xE0 || (r.sid & 0xE0) == 0xC0)) continue;
        if (first) {
            first = false;
            continue;
        }
        const int64_t t = (r.dts >= 0 ? r.dts : r.pts) * 300;
        int64_t d = ((t - pcr) % PCR_MODULO + PCR_MODULO) % PCR_MODULO;
        if (d > PCR_MODULO / 2) d -= PCR_MODULO;
        worst = std::min(worst, pcr27_to_ns(d));
    }
    return worst;
}

void test_d_e() {
    const Bytes in = ts_gen::egress(20 * SEC, false, false);
    const Run r0 = replay(in, fixed(200));
    std::vector<EgressEvent> st;
    for (const EgressEvent& e : r0.ev)
        if (e.kind == EgressEvent::Kind::d_e_start) st.push_back(e);
    CHECK("D_e: start from the first PES, ceil10(lateness + margin + |eps|)",
          st.size() == 1 && st[0].to_ns == ceil10(st[0].lateness_ns + 150 * MS + 1200 * 1000) &&
              st[0].lateness_ns > 50 * MS && st[0].lateness_ns < 150 * MS);
    const Run r = replay(in, ramp({{0, 200}, {20000, 1000}}));
    std::vector<EgressEvent> raises;
    for (const EgressEvent& e : r.ev)
        if (e.kind == EgressEvent::Kind::d_e_raise) raises.push_back(e);
    bool apart = raises.size() >= 4;
    for (const EgressEvent& e : raises) apart = apart && e.to_ns - e.from_ns >= 130 * MS;
    CHECK("D_e: a lateness ramp 200 -> 1000 ms raises several times, each >= 130 ms", apart);
    // Each change: the PMT one version on, then a flagged PCR, nothing between.
    const Walk w(r.out);
    int flagged = 0;
    bool order = true;
    for (size_t k = 0; k < w.recs.size(); k++) {
        if (w.recs[k].kind != Rec::pcr || !w.recs[k].disc) continue;
        flagged++;
        order = order && k >= 1 && w.recs[k - 1].kind == Rec::pmt && w.recs[k - 1].idx + 1 == w.recs[k].idx;
        int prev = -1;
        for (size_t j = k - 1; j-- > 0;)
            if (w.recs[j].kind == Rec::pmt) {
                prev = w.recs[j].pmt_v.version;
                break;
            }
        order = order && prev >= 0 && w.recs[k - 1].pmt_v.version == (prev + 1) % 32;
    }
    CHECK("D_e: each change a PMT one version on, then a flagged PCR", order && flagged == (int)raises.size() + 1);
    CHECK("D_e: DTS - PCR >= headroom for every timing PES after the first", dts_pcr_min(r.out, 0x100) >= 20 * MS);
    EgressConfig cm;
    cm.max_ns = 500 * MS;
    const Run rm = replay(in, ramp({{0, 200}, {20000, 1000}}), 1316, clock_e(), cm);
    uint32_t top = 0;
    for (const Rec& p : Walk(rm.out).of(Rec::pmt)) {
        HouseTimeDecl d;
        if (decl_of(p, &d)) top = std::max(top, d.d_e_90k);
    }
    CHECK("D_e: max 500 ms holds, one d-e-max", count(rm.ev, EgressEvent::Kind::d_e_max) == 1 &&
                                                    top == (uint32_t)ns_to_pts90k(500 * MS) && rm.st[0].d_e_ns == 500 * MS);
}

void test_delay_unit() {
    EgressDelay d;
    EgressDelay::Change ch[2];
    d.on_pes(0, 0, ch);
    CHECK("delay: floor + margin before, max(floor, need) at the first PES", d.started() && d.d_e() == 150 * MS);
    d.on_pes(2900 * MS, 0, ch);
    const int64_t big = d.d_e();
    d.on_gap(10 * SEC, 2 * SEC);
    d.on_gap(10 * SEC, 1900 * MS);               // the same hole on another PID: no more
    const int n = d.on_pes(0, 0, ch);
    CHECK("delay: a 2 s gap lowers by at most 2 s, its twin on another PID counted once",
          big == 3050 * MS && n == 1 && ch[0].kind == EgressDelay::Kind::lower && d.d_e() == big - 2 * SEC &&
              ch[0].gap_ns == 2 * SEC);
    EgressDelay s;
    s.on_pes(1000 * MS, 0, ch);
    s.on_gap(20 * SEC, 4 * MS);                  // under one 10 ms step
    CHECK("delay: a gap under one step moves nothing and reports no d-e-lower",
          s.d_e() == 1150 * MS && s.on_pes(0, 0, ch) == 0 && s.d_e() == 1150 * MS);
    EgressDelay e;
    e.on_pes(-500 * MS, 0, ch);
    CHECK("S22: a lateness below 0 counts as 0", e.d_e() == 150 * MS && ch[0].lateness_ns == 0);
    CHECK("S22: past 60 s: counted off house, ignored",
          e.on_pes(61 * SEC, 0, ch) == 0 && e.off_house() == 1 && e.d_e() == 150 * MS);
    CHECK("S22: exactly 60 s still drives D_e", e.on_pes(60 * SEC, 0, ch) == 1 && e.d_e() == ceil10(60 * SEC + 150 * MS));
    CHECK("delay: |eps| = error capped at 50 ms, unknown 50 ms",
          EgressDelay::eps_ns(1200) == 1200000 && EgressDelay::eps_ns(90000) == 50 * MS &&
              EgressDelay::eps_ns(std::nullopt) == 50 * MS);
}

void test_gap_marker() {
    std::string bus;
    const Bytes in = ts_gen::gap_marker(&bus);
    // The sidecar's buffers: a GAP one goes to on_gap with its PTS, the others to process.
    const Content c(in);
    const int64_t c0 = c.pts[0].second;
    auto lat = ramp({{0, 1100}, {2900, 1100}, {2950, 200}});
    EgressCore core;
    core.set_clock(clock_e());
    Bytes out;
    std::vector<EgressEvent> ev;
    OffClock clk;
    clk.now = [&](int64_t off) { return c.at(off) + lat(c.at(off) - c0); };
    for (size_t at = 0; at < bus.size();) {
        size_t nl = bus.find('\n', at);
        const std::string l = bus.substr(at, nl - at);
        at = nl + 1;
        auto num = [&](const char* k) {
            const size_t p = l.find(std::string("\"") + k + "\":");
            return p == std::string::npos ? int64_t(-1) : std::strtoll(l.c_str() + p + std::strlen(k) + 3, nullptr, 10);
        };
        const int64_t off = num("off"), len = num("len"), flags = num("flags"), pts = num("pts");
        clk.off = off;
        const EgressResult& r = (flags & 2048) && pts >= 0
                                    ? core.on_gap(in.data() + off, (size_t)len, clk.now(off), pts, clk)
                                    : core.process(in.data() + off, (size_t)len, clk.now(off), clk);
        if ((flags & 2048) && pts >= 0) {
            bool all_dropped = r.edits().size() >= r.packets();
            for (const EgressEdit& e : r.edits())
                if (e.op == EgressEdit::Op::replace) all_dropped = false;
            CHECK("gap: a GAP buffer's every packet dropped", all_dropped);
        }
        r.apply(out);
        for (const EgressEvent& e : core.take_events()) ev.push_back(e);
    }
    std::vector<EgressEvent> low;
    for (const EgressEvent& e : ev)
        if (e.kind == EgressEvent::Kind::d_e_lower) low.push_back(e);
    CHECK("gap: one hole's two markers lower D_e once, by at most the gap",
          low.size() == 1 && low[0].from_ns - low[0].to_ns > 0 && low[0].from_ns - low[0].to_ns <= low[0].gap_ns);
    int markers = 0;
    for (size_t o = 0; o + PKT <= out.size(); o += PKT) markers += read_gap_length(out.data() + o) >= 0;
    CHECK("gap: markers consumed and not sent", markers == 0 && core.counters().gap_markers == 2);
}

void test_descriptor_relay() {
    const Bytes in = ts_gen::egress(5 * SEC, false, false);
    const Run r1 = replay(in, fixed(100));
    const Run r2 = replay(r1.out, fixed(150));
    bool once = true;
    int n = 0;
    for (const Rec& p : Walk(r2.out).of(Rec::pmt)) {
        once = once && mrht_count(p.pmt_v.program_info) == 1;
        n++;
    }
    CHECK("descriptor: present once in program_info on a relay of our own output", once && n > 5);
    const auto p1 = Walk(r1.out).of(Rec::pmt);
    HouseTimeDecl d;
    CHECK("descriptor: the declaration as given (TAI, traceable, NTP, 37 s, seq 3, class 11)",
          !p1.empty() && decl_of(p1[0], &d) && d.house_time_tai && d.traceable && d.disciplined &&
              d.sync_source == hcdesc::SYNC_NTP && d.tai_utc_offset_s == 37 && d.epoch_seq == 3 &&
              d.clock_error_class == 11 && !d.ptp_valid && d.ptp_domain == 0xFF);
}

void test_reepoch() {
    const Bytes in = ts_gen::egress(6 * SEC, false, false);
    const Run r = replay(in, fixed(100), 1316, clock_e(), EgressConfig(),
                         {{3 * SEC, [](ClockDecl& c) { c.e_ns += 2 * SEC; c.seq = 4; }}});
    const auto pmts = Walk(r.out).of(Rec::pmt);
    int seq3 = 0, seq4 = 0, bump = -1;
    for (size_t k = 0; k < pmts.size(); k++) {
        HouseTimeDecl d;
        if (!decl_of(pmts[k], &d)) continue;
        if (d.epoch_seq == 4 && seq4++ == 0 && k > 0) bump = (pmts[k].pmt_v.version - pmts[k - 1].pmt_v.version + 32) % 32;
        seq3 += d.epoch_seq == 3;
    }
    CHECK("re-epoch: epoch_seq 3 then 4, the PMT version one on", seq3 > 0 && seq4 > 0 && bump == 1);
    CHECK("re-epoch: one re-epoch event (seq 4 from 3, +2 s)",
          count(r.ev, EgressEvent::Kind::re_epoch) == 1 && r.counters.re_epochs == 1);
    int flagged = 0;
    for (const Rec& p : Walk(r.out).of(Rec::pcr)) flagged += p.disc;
    CHECK("re-epoch: a flagged PCR for it", flagged == 2);   // the start's and the re-epoch's
}

void test_error_hold() {
    const Bytes in = ts_gen::egress(16 * SEC, false, false);
    const Run r = replay(in, fixed(100), 1316, clock_e(), EgressConfig(),
                         {{2 * SEC, [](ClockDecl& c) { c.error_us = 5000; }},
                          {4 * SEC, [](ClockDecl& c) { c.error_us = 1300; }},
                          {4500 * MS, [](ClockDecl& c) { c.error_us = 5000; }}});
    const Content c(in);
    const int64_t c0 = c.pts[0].second;
    int64_t first13 = -1;
    std::vector<int> classes;
    for (const Rec& p : Walk(r.out).of(Rec::pmt)) {
        HouseTimeDecl d;
        if (!decl_of(p, &d)) continue;
        if (classes.empty() || classes.back() != d.clock_error_class) classes.push_back(d.clock_error_class);
        if (d.clock_error_class == 13 && first13 < 0) first13 = c.at((int64_t)(p.idx * PKT)) - c0;
    }
    CHECK("error class: 11 at start, 13 only once held 10 s (the return inside 10 s publishes nothing)",
          classes == std::vector<int>({11, 13}) && first13 >= 14500 * MS && first13 < 15000 * MS);
}

void test_timeline() {
    const Bytes in = ts_gen::egress(5 * SEC, false, false);
    const Run r = replay(in, fixed(100), 1316, clock_e(), EgressConfig(),
                         {{2500 * MS, [](ClockDecl& c) { c.timeline_id = 0x0123456789ABCDEFull; }}});
    int flagged = 0;
    for (const Rec& p : Walk(r.out).of(Rec::pcr)) flagged += p.disc;
    const auto pmts = Walk(r.out).of(Rec::pmt);
    HouseTimeDecl a, b;
    CHECK("timeline_id: 0, then the id; no flagged PCR, no D_e change for it",
          decl_of(pmts.front(), &a) && decl_of(pmts.back(), &b) && a.timeline_id == 0 &&
              b.timeline_id == 0x0123456789ABCDEFull && flagged == 1 && r.st[0].d_e_changes == 1);
}

void test_unknown_e() {
    const Bytes in = ts_gen::egress(3 * SEC, false, false);
    ClockDecl c;
    c.ptp_domain = 0;
    c.gm = 0x2CCF67FFFE76E669ull;
    c.source = hcdesc::SYNC_PTP;
    c.traceable = true;
    const Run r = replay(in, fixed(100), 1316, c);
    HouseTimeDecl d;
    const auto pmts = Walk(r.out).of(Rec::pmt);
    CHECK("unknown E: E 0 (PES = bus - 1 h), house_time_tai and traceable 0, the PTP grandmaster kept",
          pes_mapped(in, r.out, 0) && decl_of(pmts[0], &d) && !d.house_time_tai && !d.traceable && d.ptp_valid &&
              d.ptp_domain == 0 && d.gm_identity == 0x2CCF67FFFE76E669ull &&
              d.clock_error_class == hcdesc::ERROR_CLASS_UNKNOWN);
}

void test_lateness_cut() {
    const Bytes in = ts_gen::egress(10 * SEC, false, false);
    const Run r = replay(in, ramp({{0, 100}, {2000, -500}, {3000, -500}, {3001, 61000}, {6000, 61000}, {6001, 100}}));
    CHECK("S22: past 60 s counted latenessOffHouse, D_e not moved by it",
          r.st[0].lateness_off_house > 0 && r.st[0].lateness_max_ns <= 60 * SEC && r.st[0].d_e_ns < SEC);
}

// Outside PTS/DTS/PCR, PMT, inserted and dropped packets the output is the input.
void test_bytes() {
    const Bytes in = ts_gen::egress(4 * SEC, false, false);
    EgressCore core;
    core.set_clock(clock_e());
    const Content c(in);
    bool same = true;
    size_t passed = 0, replaced = 0;
    for (size_t off = 0; off < in.size(); off += 1316) {
        const size_t n = std::min<size_t>(1316, in.size() - off);
        const EgressResult& r = core.process(in.data() + off, n, c.at((int64_t)off) + 100 * MS);
        std::vector<const uint8_t*> own(r.packets(), nullptr);
        std::vector<bool> dropped(r.packets(), false);
        for (const EgressEdit& e : r.edits()) {
            if (e.op == EgressEdit::Op::replace) own[e.index] = r.bytes(e);
            if (e.op == EgressEdit::Op::drop) dropped[e.index] = true;
        }
        for (size_t i = 0; i < r.packets(); i++) {
            const uint8_t* a = r.packet(i);
            if (dropped[i] || ts_pid(a) == 0x1000) continue;
            if (!own[i]) {
                passed++;
                continue;
            }
            replaced++;
            uint8_t x[PKT], y[PKT];
            std::memcpy(x, a, PKT);
            std::memcpy(y, own[i], PKT);
            PacketView vx, vy;
            parse_packet(x, &vx);
            parse_packet(y, &vy);
            if (vx.af_pcr) std::memset(x + 6, 0, 6), std::memset(y + 6, 0, 6);
            PesHeader h;
            if (vx.pusi && vx.payload_off < PKT &&
                parse_pes_header(x + vx.payload_off, PKT - vx.payload_off, &h) && h.complete) {
                if (h.pts_off >= 0) std::memset(x + vx.payload_off + h.pts_off, 0, 5), std::memset(y + vx.payload_off + h.pts_off, 0, 5);
                if (h.dts_off >= 0) std::memset(x + vx.payload_off + h.dts_off, 0, 5), std::memset(y + vx.payload_off + h.dts_off, 0, 5);
            }
            same = same && std::memcmp(x, y, PKT) == 0;
        }
    }
    CHECK("bytes: outside PTS/DTS/PCR, PMT, inserted and dropped packets the output is the input",
          same && replaced > 100 && passed > 100);
    const EgressResult& r = core.process(nullptr, 0, 0);
    CHECK("bytes: an empty buffer gives no packets, no edits", r.packets() == 0 && r.edits().empty());
}

}  // namespace

int main() {
    test_wrap();
    test_header_split();
    test_sparse_pcr();
    test_no_pcr_pid();
    test_d_e();
    test_delay_unit();
    test_gap_marker();
    test_descriptor_relay();
    test_reepoch();
    test_error_hold();
    test_timeline();
    test_unknown_e();
    test_lateness_cut();
    test_bytes();
    return test_summary("ts_egress");
}
