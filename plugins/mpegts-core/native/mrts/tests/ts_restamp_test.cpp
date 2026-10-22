// ts_restamp: the ingest restamp core (WI-P1-3) on synthetic programs built here:
// H.264-like video with B-frame DTS carrying the PCR, two audio PIDs, a teletext-like
// private PID and PSI every 100 ms, sent in 7-packet datagrams with one-sided jitter.
// Chapter 3's .ts fixtures plug in at the tests marked WI-S0-9; part 7.2's .stct traces
// go through restamp_replay_test.
#include <algorithm>
#include <climits>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <map>
#include <string>
#include <vector>

#include <unistd.h>

#include "../ts_house.h"
#include "../ts_packet.h"
#include "../ts_pcr.h"
#include "../ts_pes.h"
#include "../ts_psi.h"
#include "../ts_restamp.h"
#include "../ts_trace.h"
#include "check.h"

using namespace mrts;

namespace {

constexpr int64_t US = 1000, MS = 1000000, S = 1000000000;
constexpr int PROGRAM = 1, PID_PMT = 0x1000, PID_V = 0x100, PID_A1 = 0x101, PID_A2 = 0x102,
              PID_T = 0x103, PID_A3 = 0x104, PID_PCR2 = 0x1FF;
// A second program of its own source clock: AAC and a PCR-only PID.
constexpr int PROGRAM2 = 2, PID_PMT2 = 0x1010, PID_B1 = 0x201, PID_PCR3 = 0x2FF;
constexpr int64_t P2_SIGMA_OFF = 5 * 3600 * 1000000000LL, P2_PPB = 200000;
constexpr int64_t TICK_NS = 11112;   // one 90 kHz tick, rounded up
using Bytes = std::vector<uint8_t>;
using Ev = RestampCore::Event;

int64_t fmod64(int64_t a, int64_t m) {
    const int64_t r = a % m;
    return r < 0 ? r + m : r;
}
int64_t iabs(int64_t v) { return v < 0 ? -v : v; }
int64_t at_ppb(int64_t x, int64_t ppb) {   // x >= 0
    const int64_t q = x / S;
    return q * ppb + (x - q * S) * ppb / S;
}

struct Lcg {
    uint64_t s;
    explicit Lcg(uint64_t seed) : s(seed * 0x9E3779B97F4A7C15ULL + 1) {}
    uint32_t next() {
        s = s * 6364136223846793005ULL + 1442695040888963407ULL;
        return (uint32_t)(s >> 32);
    }
};

// --- The synthetic program -------------------------------------------------------

struct EsDef {
    int pid, type;
    uint8_t sid;
    int64_t period, lead;   // PES spacing in decode order; PTS (DTS for video) - mux time
    int bytes;
    Bytes info;
};
const EsDef kV{PID_V, 0x1B, 0xE0, 40 * MS, 600 * MS, 2600, {}};
const EsDef kA1{PID_A1, 0x03, 0xC0, 24 * MS, 400 * MS, 576, {}};
const EsDef kA2{PID_A2, 0x0F, 0xC1, 20 * MS, 450 * MS, 300, {}};
const EsDef kT{PID_T, 0x06, 0xBD, 40 * MS, 600 * MS, 360, {0x56, 0x05, 'e', 'n', 'g', 0x09, 0x00}};
const EsDef kA3{PID_A3, 0x03, 0xC2, 24 * MS, 400 * MS, 576, {}};
const EsDef kB1{PID_B1, 0x0F, 0xC0, 23220 * US, 300 * MS, 400, {}};
const EsDef* const kAll[] = {&kV, &kA1, &kA2, &kT, &kA3, &kB1};

int64_t period_of(int pid) {
    for (const EsDef* e : kAll)
        if (e->pid == pid) return e->period;
    return 0;
}

struct Gen {
    int64_t secs = 60;
    int64_t sigma0 = 3600 * S;            // source STC at mux time 0
    int64_t rewind_at = -1;               // the source STC steps by jump_ns here
    int64_t jump_ns = -1000000000;
    bool jump_flag = true;                // discontinuity_indicator on the first PCR after it
    int64_t late_from = -1, late_to = -1; // audio-1 PES of these slots muxed 300 ms late
    int64_t outage_from = -1, outage_to = -1;   // nothing sent; the PCR runs on
    int64_t pmt_change_at = -1;           // PMT v1: teletext out of the table (still sent), audio-3 in
    int64_t pcr_move_at = -1;             // PMT v2: the PCR on a PID of its own
    int split_every = 0;                  // every n-th audio-2 header split over two packets
    int dup_every = 0;                    // every n-th packet of dup_pid sent twice
    int dup_pid = PID_A1;
    bool dup_cont = false;                // each split header's continuation sent twice
    bool program2 = false;                // PROGRAM2 in the PAT, on its own clock
    int64_t gap_from = -1, gap_to = -1;   // audio-2 PES of these slots never made
    int64_t freeze_from = -1, freeze_to = -1;   // the PCR stuck (the vMix pattern, #820)
    // The path's floor delay rises by delay_rise from send time delay_from on, linearly
    // over delay_ramp (0: at once): a re-route, or a queue building up.
    int64_t delay_from = -1, delay_rise = 0, delay_ramp = 0;
    // A caller that queues while its listener is away (B-39): what it sends from backlog_at
    // waits backlog_len, then drains, all sent until then arriving over backlog_drain.
    int64_t backlog_at = -1, backlog_len = 0, backlog_drain = 0;
    int64_t a2_ahead = 0;                 // audio-2 stamped this far ahead of the rest (#820)
    int pcr_every = 1;                    // the PCR on every n-th video PES (50: every 2 s, vMix's)
};

struct Pkt {
    Bytes b;
    int64_t mux = 0;
    int pid = 0;
    int pes = -1;                         // its PES in Stream::pes; -1: PSI, PCR only
    bool held = false;                    // the first packet of a split header
    bool cont = false;                    // ... and its continuation
    bool copy = false;                    // the second copy of a duplicated packet
    std::vector<int> mask;                // PTS/DTS/PCR bytes: the only ones the core may rewrite
};

struct PesInfo {
    int pid = 0;
    int64_t t = 0;                        // decode slot, ns from the stream start
    int64_t slot_pts = 0, slot_dts = 0;   // mux time at which the source STC equals its PTS / DTS
    int64_t pts = -1, dts = -1;           // raw, as written; dts -1: none
};

struct Stream {
    std::vector<Pkt> pk;
    std::vector<PesInfo> pes;
};

void put_ts(uint8_t* f, int prefix, int64_t v) {
    f[0] = (uint8_t)((prefix << 4) | (((v >> 30) & 0x07) << 1) | 1);
    f[1] = (uint8_t)((v >> 22) & 0xFF);
    f[2] = (uint8_t)((((v >> 15) & 0x7F) << 1) | 1);
    f[3] = (uint8_t)((v >> 7) & 0xFF);
    f[4] = (uint8_t)(((v & 0x7F) << 1) | 1);
}

Bytes pes_bytes(uint8_t sid, int64_t pts, int64_t dts, const Bytes& payload) {
    Bytes b = {0x00, 0x00, 0x01, sid, 0x00, 0x00, 0x84, (uint8_t)(dts >= 0 ? 0xC0 : 0x80),
               (uint8_t)(dts >= 0 ? 10 : 5)};
    uint8_t f[5];
    put_ts(f, dts >= 0 ? 3 : 2, pts);
    b.insert(b.end(), f, f + 5);
    if (dts >= 0) {
        put_ts(f, 1, dts);
        b.insert(b.end(), f, f + 5);
    }
    b.insert(b.end(), payload.begin(), payload.end());
    const size_t len = b.size() - 6;
    b[4] = (uint8_t)(len >> 8);
    b[5] = (uint8_t)len;
    return b;
}

// One PES's packets on `pid`, CC stamped later in send order. The first carries `pcr`
// (>= 0) in its AF (with random_access_indicator if `rai`), or only `first_cap`
// payload bytes: a header split over two packets.
std::vector<Bytes> packetize(int pid, const Bytes& data, int64_t pcr, size_t first_cap, bool rai = false) {
    std::vector<Bytes> out;
    size_t at = 0;
    do {
        const bool first = out.empty();
        size_t cap = first && pcr >= 0 ? 176 : 184;
        if (first && first_cap) cap = first_cap;
        const size_t take = std::min(cap, data.size() - at);
        Bytes p(PKT, 0xFF);
        p[0] = SYNC_BYTE;
        p[1] = (uint8_t)((first ? 0x40 : 0) | ((pid >> 8) & 0x1F));
        p[2] = (uint8_t)pid;
        p[3] = 0x10;
        if (take < 184) {
            p[3] |= 0x20;
            p[4] = (uint8_t)(183 - take);
            if (take < 183) p[5] = 0x00;
            if (first && pcr >= 0) {
                p[5] = rai ? 0x50 : 0x10;
                write_pcr(p.data(), pcr);
            }
        }
        std::memcpy(p.data() + PKT - take, data.data() + at, take);
        at += take;
        out.push_back(p);
    } while (at < data.size());
    return out;
}

// A PCR-only packet numbered in its transport_private_data, so no two are alike.
Pkt pcr_only(int pid, int64_t pcr27, int64_t mux, int n) {
    Pkt p;
    p.b.assign(PKT, 0xFF);
    build_pcr_packet(pid, pcr27, 0, p.b.data());
    p.b[5] |= 0x02;
    p.b[12] = 2;
    p.b[13] = (uint8_t)(n >> 8);
    p.b[14] = (uint8_t)n;
    p.mux = mux;
    p.pid = pid;
    for (int j = 6; j < 12; j++) p.mask.push_back(j);
    return p;
}

Stream generate(const Gen& g) {
    Stream st;
    auto in_outage = [&](int64_t m) { return g.outage_from >= 0 && m >= g.outage_from && m < g.outage_to; };
    auto stc = [&](int64_t t) { return g.sigma0 + t + (g.rewind_at >= 0 && t >= g.rewind_at ? g.jump_ns : 0); };
    auto stc2 = [&](int64_t t) { return g.sigma0 + P2_SIGMA_OFF + t + at_ppb(t, P2_PPB); };
    auto pcr_at = [&](int64_t m) {
        const bool frozen = g.freeze_from >= 0 && m >= g.freeze_from && m < g.freeze_to;
        return ns_to_pcr27(stc(frozen ? g.freeze_from : m));
    };
    std::vector<Pkt> raw;
    for (int64_t t = 5 * MS; t < g.secs * S; t += 100 * MS) {   // the first PES come before the PSI
        if (in_outage(t)) continue;
        const bool v1 = g.pmt_change_at >= 0 && t >= g.pmt_change_at;
        const bool v2 = g.pcr_move_at >= 0 && t >= g.pcr_move_at;
        std::vector<PmtStream> es = {{PID_V, kV.type, {}}, {PID_A1, kA1.type, {}}, {PID_A2, kA2.type, {}}};
        es.push_back(v1 ? PmtStream{PID_A3, kA3.type, {}} : PmtStream{PID_T, kT.type, kT.info});
        Pkt pat, pmt;
        pat.b.resize(PKT);
        pmt.b.resize(PKT);
        std::vector<std::pair<int, int>> programs = {{PROGRAM, PID_PMT}};
        if (g.program2) programs.push_back({PROGRAM2, PID_PMT2});
        build_pat(1, programs, 0, 0, pat.b.data());
        build_pmt(PID_PMT, PROGRAM, v2 ? PID_PCR2 : PID_V, es, 0, (int)v1 + (int)v2, pmt.b.data());
        pat.mux = pmt.mux = t;
        pat.pid = PID_PAT;
        pmt.pid = PID_PMT;
        raw.push_back(pat);
        raw.push_back(pmt);
        if (g.program2) {
            Pkt pmt2;
            pmt2.b.resize(PKT);
            build_pmt(PID_PMT2, PROGRAM2, PID_PCR3, {{PID_B1, kB1.type, {}}}, 0, 0, pmt2.b.data());
            pmt2.mux = t + 50 * MS;
            pmt2.pid = PID_PMT2;
            raw.push_back(pmt2);
        }
    }
    for (const EsDef* e : kAll) {
        const bool video = e->pid == PID_V;
        for (int64_t k = 0; k * e->period < g.secs * S; k++) {
            const int64_t t = k * e->period;
            if (e->pid == PID_A3 && (g.pmt_change_at < 0 || t < g.pmt_change_at)) continue;
            if (e->pid == PID_B1 && !g.program2) break;
            if (e->pid == PID_A2 && g.gap_from >= 0 && t >= g.gap_from && t < g.gap_to) continue;
            const bool late = e->pid == PID_A1 && g.late_from >= 0 && t >= g.late_from && t < g.late_to;
            const int64_t mux0 = t + (late ? 300 * MS : 0);
            // IPBB: a P frame shows 3 slots on, a B frame at once; I and P carry a DTS.
            int64_t reorder = 0;
            if (video) {
                const int64_t disp = k == 0 ? 0 : (k - 1) % 3 == 0 ? k + 2 : k - 1;
                reorder = (disp - k + 1) * e->period;
            }
            const int64_t base = (e->pid == PID_B1 ? stc2(t) : stc(t)) - t +   // this slot's timeline
                                 (e->pid == PID_A2 ? g.a2_ahead : 0);
            PesInfo info;
            info.pid = e->pid;
            info.t = t;
            info.slot_dts = t + e->lead;
            info.slot_pts = info.slot_dts + reorder;
            info.pts = fmod64(ns_to_pts90k(base + info.slot_pts), PTS_WRAP);
            info.dts = reorder > 0 ? fmod64(ns_to_pts90k(base + info.slot_dts), PTS_WRAP) : -1;
            const int idx = (int)st.pes.size();
            const int n = e->bytes * (video && k % 12 == 0 ? 6 : 1);
            Bytes payload((size_t)n);
            for (int i = 0; i < n; i++) payload[i] = (uint8_t)(i * 7 + e->pid * 13 + idx * 31 + (i >> 8));
            // The pattern repeats every 256 PES: these tell the blocks apart, so a long drop
            // cannot pair an output PES with an input 256 PES away.
            payload[0] ^= (uint8_t)(idx >> 8);
            payload[1] ^= (uint8_t)(idx >> 16);
            const Bytes data = pes_bytes(e->sid, info.pts, info.dts, payload);
            // A sparse PCR from the second video PES on: the first after the PSI, as vMix's.
            const bool pcr_here = video && (g.pcr_move_at < 0 || mux0 < g.pcr_move_at) &&
                                  k % g.pcr_every == 1 % g.pcr_every;
            const bool split = e->pid == PID_A2 && g.split_every > 0 && k % g.split_every == g.split_every - 1;
            const std::vector<Bytes> pk =
                packetize(e->pid, data, pcr_here ? pcr_at(mux0) : -1, split ? 10 : 0, video && k % 12 == 0);
            // The bytes the core may rewrite: the PTS (PES bytes 9-13), the DTS (14-18), the PCR.
            size_t cum = 0;
            const int end = info.dts >= 0 ? 19 : 14;
            for (size_t i = 0; i < pk.size(); i++) {
                const int off = payload_offset(pk[i].data());
                const size_t take = (size_t)(PKT - off);
                Pkt p;
                p.b = pk[i];
                p.mux = mux0 + (int64_t)i * 50 * US;
                p.pid = e->pid;
                p.pes = idx;
                p.held = split && i == 0;
                p.cont = split && i == 1;
                for (int j = 9; j < end; j++)
                    if ((size_t)j >= cum && (size_t)j < cum + take) p.mask.push_back(off + (j - (int)cum));
                if (pcr_here && i == 0)
                    for (int j = 6; j < 12; j++) p.mask.push_back(j);
                cum += take;
                if (!in_outage(p.mux)) raw.push_back(p);
            }
            st.pes.push_back(info);
        }
    }
    int n_pcr = 0;
    if (g.pcr_move_at >= 0)
        for (int64_t t = g.pcr_move_at + 7 * MS; t < g.secs * S; t += 40 * MS)
            if (!in_outage(t)) raw.push_back(pcr_only(PID_PCR2, pcr_at(t), t, n_pcr++));
    if (g.program2)
        for (int64_t t = 3 * MS; t < g.secs * S; t += 30 * MS)
            if (!in_outage(t)) raw.push_back(pcr_only(PID_PCR3, ns_to_pcr27(stc2(t)), t, n_pcr++));
    std::stable_sort(raw.begin(), raw.end(), [](const Pkt& a, const Pkt& b) { return a.mux < b.mux; });
    std::map<int, int> cc;
    bool flagged = false;
    for (Pkt& p : raw) {
        int& c = cc[p.pid];
        if (p.b[3] & 0x10) {
            p.b[3] = (uint8_t)((p.b[3] & 0xF0) | c);
            c = (c + 1) & 0x0F;
        } else {
            p.b[3] = (uint8_t)((p.b[3] & 0xF0) | ((c + 15) & 0x0F));   // the last payload CC
        }
        if (!flagged && g.jump_flag && g.rewind_at >= 0 && p.mux >= g.rewind_at &&
            (p.pid == PID_V || p.pid == PID_PCR2) && read_pcr(p.b.data()) >= 0) {
            p.b[5] |= 0x80;
            flagged = true;
        }
    }
    if (g.dup_every > 0) {
        std::vector<Pkt> out;
        int n = 0;
        for (const Pkt& p : raw) {
            out.push_back(p);
            if (p.pid == g.dup_pid && ++n % g.dup_every == 0) {
                out.push_back(p);
                out.back().copy = true;
            }
        }
        raw.swap(out);
    }
    if (g.dup_cont) {
        std::vector<Pkt> out;
        for (const Pkt& p : raw) {
            out.push_back(p);
            if (p.cont) {
                out.push_back(p);
                out.back().copy = true;
            }
        }
        raw.swap(out);
    }
    st.pk = std::move(raw);
    return st;
}

// --- Delivery and the run -----------------------------------------------------------

struct Dg {
    size_t first, n;
    int64_t send, arrival;
};

// 7 packets per datagram; arrival = the house time of the send at the source rate,
// 20 ms floor delay (plus the Gen's rise), one-sided jitter up to 8 ms (mostly small), FIFO.
std::vector<Dg> datagrams(const Stream& st, const Gen& g, int64_t h0, int64_t ppb, uint64_t seed, bool jitter) {
    Lcg r(seed);
    std::vector<Dg> out;
    int64_t last = INT64_MIN;
    for (size_t i = 0; i < st.pk.size(); i += 7) {
        const size_t n = std::min<size_t>(7, st.pk.size() - i);
        const int64_t send = st.pk[i + n - 1].mux;
        int64_t j = 0;
        if (jitter) {
            const int64_t u = r.next() % 1000;
            j = 8 * MS * u / 1000 * u / 1000 * u / 1000;
        }
        int64_t rise = 0;
        if (g.delay_from >= 0 && send >= g.delay_from) {   // in us along the ramp: rise x time fits 64 bits
            const int64_t at = (send - g.delay_from) / US, len = std::max<int64_t>(1, g.delay_ramp / US);
            rise = g.delay_ramp > 0 && at < len ? g.delay_rise * at / len : g.delay_rise;
        }
        int64_t due = send;               // a queued send leaves at its place in the drain
        const int64_t span = g.backlog_len + g.backlog_drain;
        if (g.backlog_at >= 0 && send >= g.backlog_at && send - g.backlog_at < span)
            due = g.backlog_at + g.backlog_len + (int64_t)((__int128)(send - g.backlog_at) * g.backlog_drain / span);
        last = std::max(last, h0 + 20 * MS + rise + due + at_ppb(due, ppb) + j);
        out.push_back(Dg{i, n, send, last});
    }
    return out;
}

struct Case {
    Stream st;
    std::vector<Dg> dg;
    int64_t h0 = 100 * S, ppb = 0;
};

Case make_case(const Gen& g, int64_t h0 = 100 * S, int64_t ppb = 30000, uint64_t seed = 7, bool jitter = true) {
    Case c;
    c.st = generate(g);
    c.h0 = h0;
    c.ppb = ppb;
    c.dg = datagrams(c.st, g, h0, ppb, seed, jitter);
    return c;
}

using Edit = std::function<void(RestampCore&, int64_t send)>;

struct Out {
    Bytes bytes;
    std::vector<RestampCore::Gap> gaps;
    std::vector<size_t> gap_at;           // output packet index the marker goes before
    std::vector<Ev> events;
    RestampCore::Stats stats;
    int calls = 0, in_place = 0, bad_in_place = 0;
    int bad_gap_at = 0;                   // markers off a packet boundary, past the output, out of order
    std::vector<char> in_place_of;        // per process() call
    std::vector<int64_t> arrival_of_out;  // per output packet
};

Out run(const Case& c, const RestampConfig& cfg, Edit edit = nullptr, size_t cut = 0, TraceWriter* tw = nullptr) {
    RestampCore rc(cfg);
    rc.set_trace(tw);
    Out o;
    Bytes buf;
    for (const Dg& d : c.dg) {
        if (edit) edit(rc, d.send);
        buf.clear();
        for (size_t i = d.first; i < d.first + d.n; i++) buf.insert(buf.end(), c.st.pk[i].b.begin(), c.st.pk[i].b.end());
        auto feed = [&](uint8_t* p, size_t n) {
            const RestampCore::Result r = rc.process(p, n, d.arrival);
            o.calls++;
            o.in_place += r.in_place;
            o.in_place_of.push_back(r.in_place);
            if (r.in_place && !(r.keep.size() == 1 && r.keep[0].data == p && r.keep[0].len == n)) o.bad_in_place++;
            size_t prev_at = 0;
            for (const RestampCore::Gap& gp : r.gaps) {
                o.bad_gap_at += gp.at % PKT != 0 || gp.at > r.bytes() || gp.at < prev_at;
                prev_at = gp.at;
                o.gaps.push_back(gp);
                o.gap_at.push_back((o.bytes.size() + gp.at) / PKT);
            }
            for (const RestampCore::Range& k : r.keep) o.bytes.insert(o.bytes.end(), k.data, k.data + k.len);
            o.arrival_of_out.resize(o.bytes.size() / PKT, d.arrival);
        };
        if (cut && cut < buf.size()) {
            feed(buf.data(), cut);
            feed(buf.data() + cut, buf.size() - cut);
        } else {
            feed(buf.data(), buf.size());
        }
        for (const Ev& e : rc.take_events()) o.events.push_back(e);
    }
    o.stats = rc.stats();
    return o;
}

// --- Reading the output back --------------------------------------------------------

struct OutPes {
    int pid;
    int64_t pts, dts;
    long in;                              // its PUSI packet in the input, -1: unmatched
    int pes;                              // its PesInfo, -1: unmatched
    size_t at;
};
struct OutPcr {
    int64_t pcr;
    bool di;
    long in;
};

// What the guard compares: video by DTS when it has one, the rest by PTS.
int64_t key33(const OutPes& p) { return p.pid == PID_V && p.dts >= 0 ? p.dts : p.pts; }

struct Ana {
    bool matched = true, atomic = true, ordered = true;
    long first_unmatched = -1;
    std::vector<long> in_of_out;
    std::vector<char> removed, af_only;
    std::vector<OutPes> pes;
    std::vector<long> out_of_pes;         // per PesInfo: index into pes, -1: not in the output
    std::map<int, std::vector<OutPcr>> pcr;
    uint64_t cc_lost = 0, cc_dup = 0;
    size_t n_af_only = 0, n_removed = 0;
    // Adaptation-only packets whose CC is not their PID's last payload CC (CcTracker
    // does not look at them); duplicate pairs (same PID and CC) that differ but for the PCR.
    size_t af_cc_bad = 0, dup_differ = 0;
    // Per PID: holes no gap marker announces (absence is signalled, §5.2; B-48), ns past a PES
    // length, where its guard key steps more than 1.5 PES lengths between two output PES.
    std::map<int, int64_t> unsignalled;
};

// Equal but for the bytes the core may write: PTS/DTS/PCR fields, the CC nibble
// (renumbering; not in strict mode) and the discontinuity bit of a PCR packet.
bool masked_equal(const Pkt& in, const uint8_t* out, bool strict_cc) {
    for (int i = 0; i < PKT; i++) {
        if (in.b[i] == out[i]) continue;
        if (i == 3 && !strict_cc && ((in.b[3] ^ out[3]) & 0xF0) == 0) continue;
        if (i == 5 && read_pcr(in.b.data()) >= 0 && (in.b[5] | 0x80) == out[5]) continue;
        if (std::find(in.mask.begin(), in.mask.end(), i) != in.mask.end()) continue;
        return false;
    }
    return true;
}

// A dropped packet kept for its PCR: no payload, the AF up to the PCR as it was, stuffing;
// random_access_indicator cleared (the PES it announced is gone).
bool af_only_of(const Pkt& in, const uint8_t* out) {
    if (read_pcr(in.b.data()) < 0 || !(in.b[3] & 0x10) || read_pcr(out) < 0) return false;
    if ((out[3] & 0x30) != 0x20 || out[4] != 183 || ts_pid(out) != in.pid || ts_pusi(out)) return false;
    if (((in.b[5] & 0xBF) | 0x80) != (out[5] | 0x80)) return false;
    for (int i = 12; i < 5 + in.b[4]; i++)
        if (in.b[i] != out[i]) return false;
    for (int i = 5 + in.b[4]; i < PKT; i++)
        if (out[i] != 0xFF) return false;
    return true;
}

Ana analyze(const Case& c, const Out& o, bool strict_cc) {
    const Stream& st = c.st;
    Ana a;
    const size_t n_out = o.bytes.size() / PKT;
    a.in_of_out.assign(n_out, -1);
    a.removed.assign(st.pk.size(), 0);
    a.af_only.assign(st.pk.size(), 0);
    std::map<int, std::vector<long>> by_pid;
    for (size_t i = 0; i < st.pk.size(); i++) by_pid[st.pk[i].pid].push_back((long)i);
    std::map<int, size_t> cur;
    for (size_t j = 0; j < n_out; j++) {
        const uint8_t* out = o.bytes.data() + j * PKT;
        const int pid = ts_pid(out);
        const std::vector<long>& list = by_pid[pid];
        size_t& k = cur[pid];
        while (k < list.size()) {
            const Pkt& in = st.pk[(size_t)list[k]];
            if (masked_equal(in, out, strict_cc)) {
                a.in_of_out[j] = list[k++];
                break;
            }
            if (af_only_of(in, out)) {
                a.af_only[(size_t)list[k]] = 1;
                a.n_af_only++;
                a.in_of_out[j] = list[k++];
                break;
            }
            a.removed[(size_t)list[k++]] = 1;
        }
        if (a.in_of_out[j] < 0 && a.matched) {
            a.matched = false;
            a.first_unmatched = (long)j;
        }
    }
    for (auto& kv : by_pid)
        for (size_t k = cur[kv.first]; k < kv.second.size(); k++) a.removed[(size_t)kv.second[k]] = 1;
    for (char r : a.removed) a.n_removed += r != 0;

    // A PES leaves whole or not at all (its PCR may stay, adaptation only); a duplicate's
    // second copy is optional.
    std::vector<int> n_in(st.pes.size(), 0), n_kept(st.pes.size(), 0);
    for (size_t i = 0; i < st.pk.size(); i++) {
        if (st.pk[i].pes < 0 || st.pk[i].copy) continue;
        n_in[(size_t)st.pk[i].pes]++;
        if (!a.removed[i] && !a.af_only[i]) n_kept[(size_t)st.pk[i].pes]++;
    }
    for (size_t p = 0; p < st.pes.size(); p++)
        if (n_kept[p] != 0 && n_kept[p] != n_in[p]) a.atomic = false;

    // Input order, but for a held header, which leaves right before its continuation.
    std::vector<long> pos(st.pk.size(), -1);
    long last = -1;
    for (size_t j = 0; j < n_out; j++) {
        const long i = a.in_of_out[j];
        if (i < 0) continue;
        pos[(size_t)i] = (long)j;
        if (st.pk[(size_t)i].held) continue;
        if (i <= last) a.ordered = false;
        last = i;
    }
    for (size_t i = 0; i < st.pk.size(); i++) {
        if (!st.pk[i].held || pos[i] < 0) continue;
        size_t k = i + 1;   // its continuation: the PID's next payload packet that is no copy
        while (k < st.pk.size() && !(st.pk[k].pid == st.pk[i].pid && (st.pk[k].b[3] & 0x10) && !st.pk[k].copy)) k++;
        if (k == st.pk.size() || pos[k] != pos[i] + 1) a.ordered = false;
    }

    CcTracker cct;
    std::map<int, Bytes> head;
    std::map<int, size_t> head_at;
    std::map<int, Bytes> last_payload;   // per PID: the last payload packet, PCR field masked
    a.out_of_pes.assign(st.pes.size(), -1);
    for (size_t j = 0; j < n_out; j++) {
        uint8_t pk[PKT];
        std::memcpy(pk, o.bytes.data() + j * PKT, PKT);
        PacketView v;
        parse_packet(pk, &v);
        const CcTracker::Result r = cct.feed(v);
        a.cc_lost += r == CcTracker::Result::Lost;
        a.cc_dup += r == CcTracker::Result::Duplicate;
        const int64_t pcr = read_pcr(pk);
        if (pcr >= 0) a.pcr[v.pid].push_back(OutPcr{pcr, (pk[5] & 0x80) != 0, a.in_of_out[j]});
        Bytes masked(pk, pk + PKT);
        if (pcr >= 0) std::fill(masked.begin() + 6, masked.begin() + 12, 0);   // a copy's PCR may differ
        Bytes& lp = last_payload[v.pid];
        if (!v.has_payload) {
            a.af_cc_bad += !lp.empty() && (lp[3] & 0x0F) != v.cc;
        } else {
            a.dup_differ += r == CcTracker::Result::Duplicate && masked != lp;
            lp = masked;
        }
        if (v.pid == PID_PAT || v.pid == PID_PMT || v.pid == PID_PMT2 || v.payload_off >= PKT) continue;
        Bytes& h = head[v.pid];
        if (v.pusi) {
            h.assign(pk + v.payload_off, pk + PKT);
            head_at[v.pid] = j;
        } else if (!h.empty()) {
            h.insert(h.end(), pk + v.payload_off, pk + PKT);
        } else {
            continue;
        }
        PesHeader ph;
        if (parse_pes_header(h.data(), h.size(), &ph) && ph.complete) {
            const long in = a.in_of_out[head_at[v.pid]];
            const int pes = in >= 0 ? st.pk[(size_t)in].pes : -1;
            a.pes.push_back(OutPes{v.pid, ph.pts, ph.dts, in, pes, head_at[v.pid]});
            if (pes >= 0) a.out_of_pes[(size_t)pes] = (long)a.pes.size() - 1;
            h.clear();
        } else if (h.size() > 64) {
            h.clear();
        }
    }
    std::map<int, const OutPes*> prev;
    for (const OutPes& p : a.pes) {
        const OutPes* q = prev.count(p.pid) ? prev[p.pid] : nullptr;
        prev[p.pid] = &p;
        const int64_t per = period_of(p.pid);
        const int64_t step = q ? pts90k_to_ns(fold33(key33(p) - key33(*q))) : 0;
        if (!q || per <= 0 || step <= per + per / 2) continue;
        bool marked = false;
        for (size_t i = 0; i < o.gaps.size(); i++)
            marked |= o.gaps[i].pid == p.pid && o.gap_at[i] > q->at && o.gap_at[i] <= p.at;
        if (!marked) a.unsignalled[p.pid] += step - per;
    }
    return a;
}

// The house time the model gives a source slot: its PCR's arrival at the floor delay.
int64_t model(const Case& c, int64_t slot) { return c.h0 + 20 * MS + slot + at_ppb(slot, c.ppb); }

// The holes no marker announces, all PIDs: their total span.
int64_t unsignalled_ns(const Ana& a) {
    int64_t n = 0;
    for (const auto& kv : a.unsignalled) n += kv.second;
    return n;
}

// Per PID, every key after the one before it (33-bit folded), and the worst step.
bool monotonic(const Ana& a, int64_t* worst = nullptr) {
    std::map<int, int64_t> last;
    bool ok = true;
    int64_t w = INT64_MAX;
    for (const OutPes& p : a.pes) {
        const auto it = last.find(p.pid);
        if (it != last.end()) {
            const int64_t d = fold33(key33(p) - it->second);
            w = std::min(w, d);
            ok &= d > 0;
        }
        last[p.pid] = key33(p);
    }
    if (worst) *worst = w;
    return ok;
}

int count_events(const Out& o, Ev::Kind k, const char* reason = nullptr) {
    int n = 0;
    for (const Ev& e : o.events) n += e.kind == k && (!reason || !std::strcmp(e.reason, reason));
    return n;
}

// Input index of the first packet of `pid` (with a PCR if `pcr`) after the first PMT.
size_t first_index(const Case& c, int pid, bool pcr) {
    size_t i = 0;
    while (i < c.st.pk.size() && c.st.pk[i].pid != PID_PMT) i++;
    while (i < c.st.pk.size() && !(c.st.pk[i].pid == pid && (!pcr || read_pcr(c.st.pk[i].b.data()) >= 0))) i++;
    return i;
}

// Removed packets all before input index `limit`; each call in place exactly when its
// datagram lost nothing (the element copies only then).
bool removed_before(const Ana& a, size_t limit) {
    for (size_t i = limit; i < a.removed.size(); i++)
        if (a.removed[i]) return false;
    return true;
}
bool in_place_exact(const Case& c, const Ana& a, const Out& o) {
    if (o.in_place_of.size() != c.dg.size()) return false;
    for (size_t k = 0; k < c.dg.size(); k++) {
        bool lost = false;
        for (size_t i = c.dg[k].first; i < c.dg[k].first + c.dg[k].n; i++) lost |= a.removed[i] != 0;
        if (o.in_place_of[k] == lost) return false;
    }
    return true;
}

const RestampCore::PidStats* pid_stats(const Out& o, int pid) {
    for (const RestampCore::PidStats& p : o.stats.pids)
        if (p.pid == pid) return &p;
    return nullptr;
}

void print_events(const char* label, const Out& o, const Case& c) {
    std::printf("  %s:", label);
    int shown = 0;
    for (const Ev& e : o.events) {
        if (e.kind == Ev::Kind::psi_change || e.kind == Ev::Kind::gap) continue;
        if (shown++ == 8) {
            std::printf(" ...");
            break;
        }
        std::printf(" [%s %s @%.3f s epoch %u pid %d drop %.1f ms]", event_kind_name(e.kind), e.reason,
                    (e.house_ns - c.h0 - 20 * MS) / 1e9, e.epoch, e.pid, e.dropped_ns / 1e6);
    }
    for (size_t i = 0; i < o.gaps.size() && i < 8; i++)
        std::printf(" {gap pid 0x%x %s %.3f ms}", o.gaps[i].pid, o.gaps[i].reason,
                    (o.gaps[i].end_ns - o.gaps[i].start_ns) / 1e6);
    if (o.gaps.size() > 8) std::printf(" {%zu gaps}", o.gaps.size());
    std::printf("\n");
}

RestampConfig stc_cfg() { return RestampConfig(); }

// The STC mapping of every PES, from a VirtualStc of the test's own fed as part 4.2
// says: from the first PMT on, each PCR (feed_pcr, then mapped as the core maps it),
// the reference PID's PES (feed_ref_pes), every PES mapped by its PTS (video by its
// DTS) unwrapped from the source STC. Per PesInfo: house ns of the mapped field and
// DTS - PTS in ticks.
struct Mapped {
    bool valid = false, by_dts = false;
    int64_t house = 0, d90 = 0;
};
std::vector<Mapped> replay_mapping(const Case& c, int pcr_pid, int ref_pid) {
    VirtualStc vs;
    std::map<int, Unwrapper> uw;
    std::vector<Mapped> out(c.st.pes.size());
    bool psi = false, have_pcr = false;
    for (const Dg& d : c.dg)
        for (size_t i = d.first; i < d.first + d.n; i++) {
            const Pkt& p = c.st.pk[i];
            if (p.pid == PID_PMT) psi = true;
            if (!psi || p.pid == PID_PAT || p.pid == PID_PMT) continue;
            const int64_t pcr = read_pcr(p.b.data());
            if (pcr >= 0 && p.pid == pcr_pid) {
                vs.feed_pcr(pcr, (p.b[5] & 0x80) != 0, d.arrival);
                if (!have_pcr)
                    for (auto& kv : uw) kv.second.reset();
                have_pcr = true;
                vs.map_pcr(d.arrival);
            }
            if (p.pes < 0 || !ts_pusi(p.b.data())) continue;
            const PesInfo& in = c.st.pes[(size_t)p.pes];
            Unwrapper& u = uw[p.pid];
            const int64_t pu = u.feed(in.pts, vs.source_stc_90k());
            const int64_t du = u.feed_dts(in.dts, pu);
            const bool by_dts = p.pid == PID_V && du != Unwrapper::NO_DTS;
            if (p.pid == ref_pid) vs.feed_ref_pes(p.pid, by_dts ? du : pu, d.arrival);
            const VirtualStc::Mapping m = vs.map(p.pid, by_dts ? du : pu, d.arrival);
            Mapped& r = out[(size_t)p.pes];
            r.valid = m.valid;
            r.by_dts = by_dts;
            r.house = m.house_ns;
            r.d90 = du != Unwrapper::NO_DTS ? du - pu : 0;
        }
    return out;
}

// Output PES whose mapped field is not exactly mux_pts_from_house(mapping + shift(pid)),
// the other at the source's DTS - PTS from it; `both` counts the PES compared, `missing`
// mapped PES not in the output.
template <class F>
int off_mapping(const Case& c, const Ana& a, const std::vector<Mapped>& m, F shift, int* both, int* missing) {
    int bad = 0;
    *both = *missing = 0;
    for (size_t p = 0; p < c.st.pes.size(); p++) {
        if (!m[p].valid) {
            bad += a.out_of_pes[p] >= 0;   // the core keeps nothing it could not map
            continue;
        }
        if (a.out_of_pes[p] < 0) {
            (*missing)++;
            continue;
        }
        const OutPes& o = a.pes[(size_t)a.out_of_pes[p]];
        const int64_t mapped = mux_pts_from_house(m[p].house + shift(o.pid));
        const int64_t pts = m[p].by_dts ? fmod64(mapped - m[p].d90, PTS_WRAP) : mapped;
        (*both)++;
        bad += o.pts != pts || (c.st.pes[p].dts >= 0 && o.dts != fmod64(pts + m[p].d90, PTS_WRAP));
    }
    return bad;
}

RestampConfig fixed_cfg(bool add_base, int64_t base);

// Per output video PES whose PUSI packet carries the PCR: (its arrival, how far PTS - PCR
// moved from the source's), ns. A consumer's tsdemux places the PES by PTS - PCR.
std::vector<std::pair<int64_t, int64_t>> pts_pcr_moves(const Case& c, const Out& o, const Ana& a) {
    std::vector<std::pair<int64_t, int64_t>> v;
    for (const OutPes& p : a.pes) {
        const uint8_t* out = o.bytes.data() + p.at * PKT;
        if (p.pid != PID_V || p.in < 0 || p.pes < 0 || read_pcr(out) < 0) continue;
        const int64_t in = c.st.pes[(size_t)p.pes].pts * 300 - read_pcr(c.st.pk[(size_t)p.in].b.data());
        int64_t d = fmod64(p.pts * 300 - read_pcr(out) - in, PCR_MODULO);
        if (d >= PCR_MODULO / 2) d -= PCR_MODULO;
        v.push_back({o.arrival_of_out[p.at], pcr27_to_ns(d)});
    }
    return v;
}

// Each PCR of `pid` written: its arrival, its input packet (and send time), whether it carries
// discontinuity_indicator and whether the source's packet did.
struct PcrOut {
    int64_t arrival, mux;
    long in;
    bool di, src_di;
};
std::vector<PcrOut> pcrs_of(const Case& c, const Out& o, const Ana& a, int pid) {
    std::vector<PcrOut> v;
    for (size_t j = 0; j < o.bytes.size() / PKT; j++) {
        const uint8_t* pk = o.bytes.data() + j * PKT;
        if (ts_pid(pk) != pid || read_pcr(pk) < 0) continue;
        const long in = a.in_of_out[j];
        const bool src = in >= 0 && (c.st.pk[(size_t)in].b[5] & 0x80) != 0;
        v.push_back(PcrOut{o.arrival_of_out[j], in >= 0 ? c.st.pk[(size_t)in].mux : -1, in, (pk[5] & 0x80) != 0, src});
    }
    return v;
}

// The indices into `v` of the flagged PCRs.
std::vector<size_t> flagged(const std::vector<PcrOut>& v) {
    std::vector<size_t> f;
    for (size_t i = 0; i < v.size(); i++)
        if (v[i].di) f.push_back(i);
    return f;
}

// The index of the first PCR in `v` that arrives after `h` (v.size(): none).
size_t first_pcr_after(const std::vector<PcrOut>& v, int64_t h) {
    size_t i = 0;
    while (i < v.size() && v[i].arrival <= h) i++;
    return i;
}

// --- Acceptance: the mapping --------------------------------------------------------

const int kPids[] = {PID_V, PID_A1, PID_A2, PID_T};

void test_mapping() {
    // WI-S0-9: cap-occ-1080i-h264-aac-ttx.ts, replayed with these arrivals, plugs in here.
    const Case c = make_case(Gen());
    const Out a = run(c, stc_cfg());
    const Ana aa = analyze(c, a, true);
    // Every PES mapped by the one program mapping: house PTS against the model's
    // source-natural landing, after acquisition.
    int64_t worst = 0, worst_dts = 0;
    int n = 0, dts_ok = 0, dts_n = 0;
    std::map<int, int> per_pid;
    for (const OutPes& p : aa.pes) {
        if (p.pes < 0) continue;
        const PesInfo& in = c.st.pes[(size_t)p.pes];
        // B-frame DTS mapped with the PTS: the reorder distance is the source's, exactly.
        if (in.dts >= 0) {
            dts_n++;
            dts_ok += p.dts >= 0 && fold33(p.pts - p.dts) == fold33(in.pts - in.dts);
        }
        if (in.t < 10 * S) continue;
        const int64_t want = model(c, in.slot_pts);
        worst = std::max(worst, iabs(house_from_mux_pts(p.pts, want) - want));
        if (in.dts >= 0) {
            const int64_t wd = model(c, in.slot_dts);
            worst_dts = std::max(worst_dts, iabs(house_from_mux_pts(p.dts, wd) - wd));
        }
        per_pid[p.pid]++;
        n++;
    }
    std::printf("  mapping: %d PES after 10 s, |house - model| max %.3f ms (PTS), %.3f ms (DTS); "
                "%d/%d DTS at the source distance\n",
                n, worst / 1e6, worst_dts / 1e6, dts_ok, dts_n);
    CHECK("mapping: every PID present after acquisition (video, 2 audio, teletext)",
          per_pid.size() == 4 && per_pid[PID_V] > 1000 && per_pid[PID_T] > 1000);
    CHECK("mapping: house PTS/DTS = one source-natural mapping, within 1 ms, every PID", worst <= 1 * MS && worst_dts <= 1 * MS);
    CHECK("mapping: B-frame DTS keeps the source's DTS-PTS distance exactly", dts_n > 400 && dts_ok == dts_n);
    CHECK("mapping: no event but the PMT's, no gap, no drop, monotonic per PID",
          (int)a.events.size() == count_events(a, Ev::Kind::psi_change) && a.gaps.empty() &&
              a.stats.programs.size() == 1 && a.stats.programs[0].dropped_pes == 0 && monotonic(aa));
    CHECK("mapping: locked on epoch 1", a.stats.programs[0].clock.state == VirtualStc::State::locked &&
                                            a.stats.programs[0].clock.epoch == 1 && a.stats.programs[0].clock.relocks == 0);
    // Exactly: the STC mapping, replayed through an independent VirtualStc.
    const std::vector<Mapped> rm = replay_mapping(c, PID_V, PID_V);
    int both0 = 0, miss0 = 0;
    const int bad0 = off_mapping(c, aa, rm, [](int) { return (int64_t)0; }, &both0, &miss0);
    std::printf("  mapping: %d/%d PES at the replayed STC mapping exactly (%d mapped PES missing)\n", both0 - bad0,
                both0, miss0);
    CHECK("mapping: house PTS/DTS = the replayed VirtualStc mapping exactly, every PES of every PID",
          both0 > 8000 && bad0 == 0 && miss0 == 0);

    // House PTS = mapping + shift, exactly: the same input with O and trims from the start.
    RestampConfig sc = stc_cfg();
    sc.offset_ns = -80 * MS;
    sc.trims_ns = {{PID_A1, 200 * MS}, {PID_T, -100 * MS}};
    const Out b = run(c, sc);
    const Ana bb = analyze(c, b, true);
    auto shift_of = [](int pid) {
        return -80 * MS + (pid == PID_A1 ? 200 * MS : pid == PID_T ? -100 * MS : 0);
    };
    int same = 0, both = 0;
    for (size_t p = 0; p < c.st.pes.size(); p++) {
        if (aa.out_of_pes[p] < 0 || bb.out_of_pes[p] < 0) continue;
        const OutPes& x = aa.pes[(size_t)aa.out_of_pes[p]];
        const OutPes& y = bb.pes[(size_t)bb.out_of_pes[p]];
        const int64_t s90 = ns_to_pts90k(shift_of(x.pid));
        both++;
        same += fold33(y.pts - x.pts) == s90 && (x.dts < 0 || fold33(y.dts - x.dts) == s90);
    }
    const std::vector<OutPcr>& pa = aa.pcr.at(PID_V);
    const std::vector<OutPcr>& pb = bb.pcr.at(PID_V);
    bool pcr_ok = pa.size() == pb.size() && !pa.empty();
    for (size_t i = 0; pcr_ok && i < pa.size(); i++)
        pcr_ok = fmod64(pb[i].pcr - pa[i].pcr, PCR_MODULO) == fmod64(-180 * MS * 27 / 1000, PCR_MODULO) && !pb[i].di;
    std::printf("  shifts O -80 ms, trims audio-1 +200, teletext -100: %d/%d PES at mapping + shift\n", same, both);
    int both1 = 0, miss1 = 0;
    const int bad1 = off_mapping(c, bb, rm, shift_of, &both1, &miss1);
    CHECK("mapping: ... = the replayed STC mapping + O + trim[pid] exactly", both1 > 8000 && bad1 == 0 && miss1 == 0);
    CHECK("mapping: house PTS/DTS = the mapping + O + trim[pid], to the tick, every PES",
          both > 5000 && same == both && bb.pes.size() == aa.pes.size());
    CHECK("mapping: the PCR follows min(0, smallest shift) = -180 ms exactly, unflagged", pcr_ok);
    // The PCR is written on the PTS's base (house + 1 h, as mpegtsmux writes it): PTS - PCR
    // is the source's (+ the video's shift - the PCR's), to the mapping's slope over the
    // 600 ms lead: 1.2 ms under the acquisition slew (2000 ppm), 30 us once locked.
    int64_t move_a = 0, move_b = 0, locked_a = 0;
    const std::vector<std::pair<int64_t, int64_t>> ma = pts_pcr_moves(c, a, aa), mb = pts_pcr_moves(c, b, bb);
    for (const auto& x : ma) {
        move_a = std::max(move_a, iabs(x.second));
        if (x.first >= c.h0 + 40 * S) locked_a = std::max(locked_a, iabs(x.second));
    }
    for (const auto& x : mb) move_b = std::max(move_b, iabs(x.second - 100 * MS));
    std::printf("  PTS - PCR on the bus against the source's: %zu video PES, off by %.3f ms at most (%.3f ms once "
                "locked); with the shifts %.3f ms off +100 ms at most\n",
                ma.size(), move_a / 1e6, locked_a / 1e6, move_b / 1e6);
    CHECK("mapping: PTS - PCR on the bus is the source's (the PCR on the PTS's 1 h base)",
          ma.size() > 1400 && move_a <= 1250 * US && locked_a <= 50 * US);
    CHECK("mapping: ... and moves by shift(video) - min(0, smallest shift) = +100 ms with the shifts",
          mb.size() == ma.size() && move_b <= 1250 * US);
    const RestampCore::PidStats* s1 = pid_stats(b, PID_A1);
    const RestampCore::PidStats* st_ = pid_stats(b, PID_T);
    CHECK("mapping: per-PID stats carry trim and shift",
          s1 && st_ && s1->trim_ns == 200 * MS && s1->shift_ns == 120 * MS && st_->shift_ns == -180 * MS &&
              s1->stream_type == 0x03 && s1->cls == StreamClass::audio && st_->cls == StreamClass::other);
    const RestampCore::PidStats* sa = pid_stats(a, PID_A1);
    CHECK("mapping: the lead telemetry is the source lead less the delay above the floor",
          sa && sa->lead_median_ns > 370 * MS && sa->lead_median_ns <= 400 * MS && sa->lead_count > 300);

    // Output byte-identical but for the PTS/DTS/PCR fields and the removed packets.
    std::printf("  bytes: %zu of %zu input packets removed (before the PMT and the first PCR), %d/%d calls in place\n",
                aa.n_removed, c.st.pk.size(), a.in_place, a.calls);
    CHECK("bytes: every output packet is its input packet but for PTS/DTS/PCR (CC untouched)",
          aa.matched && aa.ordered && a.bad_in_place == 0);
    CHECK("bytes: PES leave whole; removals only before the first PCR (no PMT, no clock yet)",
          aa.atomic && aa.n_removed > 0 && removed_before(aa, first_index(c, PID_V, true)) &&
              a.stats.unknown_pid_packets + a.stats.removed_packets == aa.n_removed && a.stats.unmapped_pes > 0);
    CHECK("bytes: the output CC is the input's (a second CcTracker: no loss)", aa.cc_lost == 0);
    CHECK("bytes: a call returns its input in place exactly when nothing was removed from it",
          in_place_exact(c, aa, a));
}

void test_split_header() {
    // WI-S0-9: syn-pes-header-split.ts plugs in here.
    Gen g;
    g.split_every = 3;
    const Case c = make_case(g);
    const Out a = run(c, stc_cfg());
    const Ana aa = analyze(c, a, true);
    int splits = 0, across = 0, ok = 0;
    for (size_t i = 0; i < c.st.pk.size(); i++) {
        if (!c.st.pk[i].held || aa.removed[i]) continue;
        splits++;
        const PesInfo& in = c.st.pes[(size_t)c.st.pk[i].pes];
        const long o = aa.out_of_pes[(size_t)c.st.pk[i].pes];
        if (o >= 0 && in.t >= 10 * S) {
            const int64_t want = model(c, in.slot_pts);
            ok += iabs(house_from_mux_pts(aa.pes[(size_t)o].pts, want) - want) <= 1 * MS;
        } else if (o >= 0) {
            ok++;
        }
        // Held in one datagram, completed in a later one?
        size_t k = i + 1;
        while (k < c.st.pk.size() && c.st.pk[k].pid != PID_A2) k++;
        across += i / 7 != k / 7;
    }
    std::printf("  split headers: %d rewritten across two packets (%d across a datagram boundary), spans %llu\n",
                splits, across, (unsigned long long)a.stats.header_spans);
    CHECK("split: every split header rewritten across its two packets", splits > 900 && ok == splits &&
                                                                            (int)a.stats.header_spans == splits);
    CHECK("split: ... also when the two arrive in different buffers", across > 50);
    CHECK("split: no other PID delayed: input order but for the held packet, which leaves "
          "right before its continuation",
          aa.matched && aa.ordered && aa.atomic);
    CHECK("split: CC continuous, monotonic, nothing broken", aa.cc_lost == 0 && monotonic(aa) && a.stats.broken_spans == 0);

    // Any chunking: datagrams cut mid-packet give the same output, byte for byte.
    const Out b = run(c, stc_cfg(), nullptr, 3 * PKT + 101);
    CHECK("chunking: datagrams cut mid-packet, the same output bytes", b.bytes == a.bytes);
    CHECK("chunking: ... and a call holding part of a packet is never in place", b.in_place <= 1 && b.bad_in_place == 0);
}

// A split header on the PCR PID with an adaptation-only PCR packet before its
// continuation (hand-built, fixed mode): no other PID waits, the PID's packets and PCRs
// leave in order, and the header is rewritten across its two packets.
void test_split_on_pcr_pid() {
    const int64_t b90 = MUX_CLOCK_BASE_90K + 90000;   // 1 s of running time
    auto video = [&](int64_t pts, int64_t pcr90, size_t cap) {
        return packetize(PID_V, pes_bytes(0xE0, pts, pts - 3600, Bytes(400, 0x11)), pcr90 * 300, cap);
    };
    const std::vector<Bytes> v1 = video(b90 + 54000, b90 - 9000, 0), v2 = video(b90 + 57600, b90 - 5400, 10);
    const std::vector<Bytes> a1 = packetize(PID_A1, pes_bytes(0xC0, b90 + 36000, -1, Bytes(100, 0x22)), -1, 0);
    Bytes pat(PKT), pmt(PKT), af(PKT);
    build_pat(1, {{PROGRAM, PID_PMT}}, 0, 0, pat.data());
    build_pmt(PID_PMT, PROGRAM, PID_V, {{PID_V, 0x1B, {}}, {PID_A1, 0x03, {}}}, 0, 0, pmt.data());
    build_pcr_packet(PID_V, (b90 - 5000) * 300, 0, af.data());
    std::vector<Bytes> seq = {pat, pmt};
    seq.insert(seq.end(), v1.begin(), v1.end());
    seq.push_back(v2[0]);
    seq.push_back(af);
    seq.push_back(a1[0]);
    seq.insert(seq.end(), v2.begin() + 1, v2.end());
    std::map<int, int> cc;
    Bytes buf;
    for (Bytes& p : seq) {
        int& c = cc[ts_pid(p.data())];
        if (p[3] & 0x10) {
            p[3] = (uint8_t)((p[3] & 0xF0) | c);
            c = (c + 1) & 0x0F;
        } else {
            p[3] = (uint8_t)((p[3] & 0xF0) | ((c + 15) & 0x0F));
        }
        buf.insert(buf.end(), p.begin(), p.end());
    }
    RestampCore rc(fixed_cfg(true, 1 * S));
    const RestampCore::Result r = rc.process(buf.data(), buf.size(), 1 * S);
    Bytes out;
    for (const RestampCore::Range& k : r.keep) out.insert(out.end(), k.data, k.data + k.len);
    long held = -1, cont = -1, afp = -1, aud = -1;
    std::vector<int64_t> pcrs;
    CcTracker cct;
    uint64_t lost = 0;
    for (size_t j = 0; j + PKT <= out.size(); j += PKT) {
        uint8_t* q = out.data() + j;
        PacketView v;
        parse_packet(q, &v);
        lost += cct.feed(v) == CcTracker::Result::Lost;
        const long at = (long)(j / PKT);
        if (v.pid == PID_A1) aud = at;
        if (v.pid != PID_V) continue;
        if (read_pcr(q) >= 0) pcrs.push_back(read_pcr(q));
        if (v.pusi && v.payload_off == PKT - 10) held = at;
        if (!v.has_payload) afp = at;
        if (held >= 0 && cont < 0 && at == held + 1) cont = at;
    }
    bool pcr_order = pcrs.size() == 3;
    for (size_t i = 1; i < pcrs.size(); i++) pcr_order &= pcrs[i] > pcrs[i - 1];
    Bytes hdr(out.begin() + held * PKT + (PKT - 10), out.begin() + held * PKT + PKT);
    hdr.insert(hdr.end(), out.begin() + cont * PKT + 4, out.begin() + cont * PKT + PKT);
    PesHeader h;
    const bool parsed = held >= 0 && cont >= 0 && parse_pes_header(hdr.data(), hdr.size(), &h) && h.complete;
    CHECK("split on the PCR PID: the other PID is not delayed (audio before the held header)",
          aud >= 0 && held > aud);
    CHECK("split on the PCR PID: held header, continuation, then the adaptation-only PCR packet",
          cont == held + 1 && afp == cont + 1);
    CHECK("split on the PCR PID: the PID's PCRs leave in order", pcr_order);
    CHECK("split on the PCR PID: the header rewritten across its two packets (+1 s base)",
          parsed && h.pts == b90 + 57600 + 90000 && h.dts == b90 + 54000 + 90000 && rc.stats().header_spans == 1);
    CHECK("split on the PCR PID: output CC continuous", lost == 0 && out.size() == buf.size());
}

void test_wrap() {
    // WI-S0-9: syn-wrap-33bit.ts (fixture_gen --wrap-at 5 --trace) plugs in here.
    // The source's PTS/PCR cross 2^33 at 20 s; the output (house + 1 h) at about 30 s.
    Gen g;
    g.sigma0 = pts90k_to_ns(PTS_WRAP) - 20 * S;
    const int64_t h0 = pts90k_to_ns(PTS_WRAP) - 3600 * S - 30 * S;
    const Case c = make_case(g, h0, -40000, 11);
    const Out a = run(c, stc_cfg());
    const Ana aa = analyze(c, a, true);
    int64_t worst_step = 0, worst = 0;
    const bool mono = monotonic(aa, &worst_step);
    bool src_wrapped = false, out_wrapped = false;
    int64_t prev_src = -1, prev_out = -1;
    for (const OutPes& p : aa.pes) {
        if (p.pes < 0 || p.pid != PID_A2) continue;
        const PesInfo& in = c.st.pes[(size_t)p.pes];
        src_wrapped |= prev_src >= 0 && in.pts < prev_src;
        out_wrapped |= prev_out >= 0 && p.pts < prev_out;
        prev_src = in.pts;
        prev_out = p.pts;
        if (in.t < 10 * S) continue;
        const int64_t want = model(c, in.slot_pts);
        worst = std::max(worst, iabs(house_from_mux_pts(p.pts, want) - want));
    }
    std::printf("  wrap: source and output both cross 2^33; smallest step %.3f ms, |house - model| max %.3f ms\n",
                worst_step / 1e6, worst / 1e6);
    CHECK("wrap: both the source and the output 33-bit fields wrap in the run", src_wrapped && out_wrapped);
    CHECK("wrap: no backward PTS/DTS on any PID across either wrap", mono && worst_step > 0);
    CHECK("wrap: the mapping stays exact across it (no 26.5 h error), no event",
          worst <= 1 * MS && a.stats.programs[0].clock.relocks == 0 && a.gaps.empty());
}


// --- Acceptance: live edits -----------------------------------------------------------

Edit at(int64_t when, std::function<void(RestampCore&)> f) {
    auto done = std::make_shared<bool>(false);
    return [=](RestampCore& rc, int64_t send) {
        if (!*done && send >= when) {
            f(rc);
            *done = true;
        }
    };
}

// The first input packet an edit applied before the datagram sent at `when` reaches.
size_t first_after(const Case& c, int64_t when) {
    for (const Dg& d : c.dg)
        if (d.send >= when) return d.first;
    return c.st.pk.size();
}

std::vector<size_t> pusi_index(const Case& c) {
    std::vector<size_t> v(c.st.pes.size(), SIZE_MAX);
    for (size_t i = 0; i < c.st.pk.size(); i++) {
        const Pkt& p = c.st.pk[i];
        if (p.pes >= 0 && v[(size_t)p.pes] == SIZE_MAX && ts_pusi(p.b.data())) v[(size_t)p.pes] = i;
    }
    return v;
}

// PES present in both runs whose PTS (and DTS) in b is not a's + want(pes, its PUSI).
template <class F>
int mismatches(const Case& c, const Ana& a, const Ana& b, F want, int* both = nullptr) {
    const std::vector<size_t> pusi = pusi_index(c);
    int bad = 0, n = 0;
    for (size_t p = 0; p < c.st.pes.size(); p++) {
        if (a.out_of_pes[p] < 0 || b.out_of_pes[p] < 0) continue;
        const OutPes& x = a.pes[(size_t)a.out_of_pes[p]];
        const OutPes& y = b.pes[(size_t)b.out_of_pes[p]];
        const int64_t w = want(c.st.pes[p], pusi[p]);
        bad += fold33(y.pts - x.pts) != w || (x.dts >= 0 && fold33(y.dts - x.dts) != w);
        n++;
    }
    if (both) *both = n;
    return bad;
}

// b's PCRs against a's, in input order: equal before input packet i0, moved by d27 from
// it on, and the first moved one alone flagged.
bool pcr_moved(const Ana& a, const Ana& b, int pid, size_t i0, int64_t d27) {
    if (!a.pcr.count(pid) || !b.pcr.count(pid)) return false;
    const std::vector<OutPcr>& pa = a.pcr.at(pid);
    const std::vector<OutPcr>& pb = b.pcr.at(pid);
    if (pa.size() != pb.size() || pa.empty()) return false;
    bool first = true;
    for (size_t i = 0; i < pa.size(); i++) {
        const bool after = pb[i].in >= (long)i0;
        if (pa[i].in != pb[i].in) return false;
        if (fmod64(pb[i].pcr - pa[i].pcr, PCR_MODULO) != (after ? fmod64(d27, PCR_MODULO) : 0)) return false;
        if (pb[i].di != (after && d27 != 0 && first) || pa[i].di) return false;
        if (after) first = false;
    }
    return true;
}

int64_t ms27(int64_t ms) { return ms * 27000; }

// Each gap's marker goes right before the PES that revealed it: the first output PES of
// its PID after the marker's position starts (on the guard key) at the gap's end.
bool gaps_placed(const Out& o, const Ana& a) {
    if (o.bad_gap_at) return false;
    for (size_t i = 0; i < o.gaps.size(); i++) {
        const RestampCore::Gap& gp = o.gaps[i];
        const OutPes* next = nullptr;
        for (const OutPes& p : a.pes)
            if (p.pid == gp.pid && p.at >= o.gap_at[i]) {
                next = &p;
                break;
            }
        if (!next || iabs(house_from_mux_pts(key33(*next), gp.end_ns) - gp.end_ns) >= 2 * TICK_NS) return false;
    }
    return true;
}

// Each gap's CC is the last payload CC its PID left with before the marker: the marker's
// adaptation-only packet repeats it (WI-P1-4), renumbering included.
bool gaps_cc_ok(const Out& o) {
    for (size_t i = 0; i < o.gaps.size(); i++) {
        int cc = -1;
        for (size_t j = o.gap_at[i]; j-- > 0 && cc < 0;) {
            const uint8_t* pk = o.bytes.data() + j * PKT;
            if (ts_pid(pk) == o.gaps[i].pid && (pk[3] & 0x10)) cc = pk[3] & 0x0F;
        }
        if (cc != o.gaps[i].cc) return false;
    }
    return !o.gaps.empty();
}

std::map<int, int> gap_count(const Out& o, const char* reason, int64_t len, int64_t tol, bool* all_ok) {
    std::map<int, int> n;
    bool ok = true;
    for (const RestampCore::Gap& gp : o.gaps) {
        n[gp.pid]++;
        ok &= !std::strcmp(gp.reason, reason) && iabs(gp.end_ns - gp.start_ns - len) <= tol;
    }
    *all_ok = ok;
    return n;
}

bool one_each(std::map<int, int> n, std::initializer_list<int> pids) {
    size_t want = 0;
    for (int pid : pids) {
        want++;
        if (n[pid] != 1) return false;
    }
    return n.size() == want;
}

// Per PID: dropped PES x period within one PES of `want`, and the overlap events say the
// same to `tol` (the mapped PES length is the source's to a few ppm).
bool dropped_about(const Out& o, int64_t want, std::initializer_list<int> pids, int64_t tol = 50 * US) {
    for (int pid : pids) {
        const RestampCore::PidStats* s = pid_stats(o, pid);
        const int64_t per = period_of(pid);
        if (!s || iabs((int64_t)s->dropped_pes * per - want) > per) return false;
        int64_t ev = 0;
        for (const Ev& e : o.events)
            if (e.kind == Ev::Kind::overlap && e.pid == pid) ev += e.dropped_ns;
        if (iabs(ev - (int64_t)s->dropped_pes * per) > tol) return false;
    }
    return true;
}

// Output packets of the PIDs not in `skip`: the same bytes in both runs.
bool others_identical(const Out& a, const Out& b, int skip) {
    Bytes x, y;
    for (size_t j = 0; j + PKT <= a.bytes.size(); j += PKT)
        if (ts_pid(a.bytes.data() + j) != skip) x.insert(x.end(), a.bytes.begin() + j, a.bytes.begin() + j + PKT);
    for (size_t j = 0; j + PKT <= b.bytes.size(); j += PKT)
        if (ts_pid(b.bytes.data() + j) != skip) y.insert(y.end(), b.bytes.begin() + j, b.bytes.begin() + j + PKT);
    return !x.empty() && x == y;
}

void test_offset_edits() {
    const Case c = make_case(Gen());
    const Out a = run(c, stc_cfg());
    const Ana aa = analyze(c, a, true);
    const int64_t when = 30 * S;
    const size_t i0 = first_after(c, when);

    // O +500 ms: content lands later; each PID leaves one gap of 500 ms.
    {
        const Out p = run(c, stc_cfg(), at(when, [](RestampCore& rc) { rc.set_offset(500 * MS); }));
        const Ana pp = analyze(c, p, true);
        print_events("O +500 ms at 30 s", p, c);
        bool ok = false;
        const std::map<int, int> n = gap_count(p, "edit", 500 * MS, TICK_NS - 1, &ok);
        int both = 0;
        const int bad = mismatches(c, aa, pp, [&](const PesInfo&, size_t pusi) { return pusi >= i0 ? 45000 : 0; }, &both);
        CHECK("O +500 ms: exactly one gap per PID, reason edit, 500 ms to under a tick",
              one_each(n, {PID_V, PID_A1, PID_A2, PID_T}) && ok);
        CHECK("O +500 ms: every PES from the edit on +45000 ticks, none before it moved",
              both > 5000 && bad == 0 && pp.pes.size() == aa.pes.size());
        CHECK("O +500 ms: the PCR does not move (min(0, +500) = 0), nothing flagged", pcr_moved(aa, pp, PID_V, i0, 0));
        CHECK("O +500 ms: markers precede the PES that revealed them; no drop, monotonic, CC intact",
              gaps_placed(p, pp) && p.stats.programs[0].dropped_pes == 0 && monotonic(pp) && pp.cc_lost == 0 &&
                  pp.matched && pp.atomic);
        const RestampCore::PidStats* s = pid_stats(p, PID_V);
        CHECK("O +500 ms: the shift in force is reported", s && s->shift_ns == 500 * MS && s->trim_ns == 0);
    }

    // O -500 ms: the overlap is dropped, the output CC renumbered continuous, the PCR moves.
    {
        const size_t i1 = first_after(c, 45 * S);
        Edit e1 = at(when, [](RestampCore& rc) { rc.set_offset(-500 * MS); });
        Edit e2 = at(45 * S, [](RestampCore& rc) { rc.set_offset(0); });
        const Out m = run(c, stc_cfg(), [&](RestampCore& rc, int64_t send) {
            e1(rc, send);
            e2(rc, send);
        });
        const Ana mm = analyze(c, m, false);
        print_events("O -500 ms at 30 s, back to 0 at 45 s", m, c);
        const RestampCore::PidStats* sv = pid_stats(m, PID_V);
        std::printf("  O -500: dropped PES video %llu, audio-1 %llu, audio-2 %llu, teletext %llu; "
                    "%zu PCR packets kept adaptation-only\n",
                    (unsigned long long)sv->dropped_pes, (unsigned long long)pid_stats(m, PID_A1)->dropped_pes,
                    (unsigned long long)pid_stats(m, PID_A2)->dropped_pes,
                    (unsigned long long)pid_stats(m, PID_T)->dropped_pes, mm.n_af_only);
        CHECK("O -500 ms: 500 ms of PES dropped per PID (to one PES), overlap events agree",
              dropped_about(m, 500 * MS, {PID_V, PID_A1, PID_A2, PID_T}));
        CHECK("O -500 ms: output CC continuous (a second CcTracker on the output)", mm.cc_lost == 0);
        CHECK("O -500 ms: no backward PTS/DTS on any PID", monotonic(mm));
        CHECK("O -500 ms: PES leave whole; a dropped PES's PCR stays, adaptation only, at its PID's CC",
              mm.matched && mm.atomic && mm.n_af_only == sv->dropped_pes &&
                  m.stats.pcr_kept_packets == sv->dropped_pes && mm.af_cc_bad == 0);
        int both = 0;
        const int bad = mismatches(c, aa, mm, [&](const PesInfo&, size_t pusi) {
            return pusi >= i0 && pusi < i1 ? -45000 : 0;
        }, &both);
        CHECK("O -500 ms: the PES kept move -45000 ticks exactly", both > 5000 && bad == 0);
        // The PCR: -500 ms from the edit, flagged once; back at 0 once every PID took O = 0.
        const std::vector<OutPcr>& pa = aa.pcr.at(PID_V);
        const std::vector<OutPcr>& pm = mm.pcr.at(PID_V);
        bool pcr_ok = pa.size() == pm.size();
        int flags = 0, phase = 0;
        for (size_t i = 0; pcr_ok && i < pa.size(); i++) {
            const int64_t d = fmod64(pm[i].pcr - pa[i].pcr, PCR_MODULO);
            const int now = d == 0 ? (phase == 0 ? 0 : 2) : d == fmod64(ms27(-500), PCR_MODULO) ? 1 : -1;
            pcr_ok &= now >= phase && now >= 0 && (now != 1 || pm[i].in >= (long)i0) && (now != 2 || pm[i].in >= (long)i1);
            pcr_ok &= pm[i].di == (now != phase);
            flags += pm[i].di;
            phase = now < 0 ? phase : now;
        }
        CHECK("O -500 ms: the PCR moves by min(0, shift) = -500 ms with the flag, and back with it",
              pcr_ok && phase == 2 && flags == 2);
        bool ok = false;
        const std::map<int, int> n = gap_count(m, "edit", 500 * MS, TICK_NS - 1, &ok);
        CHECK("O back to 0: one gap of 500 ms per PID (the reverse edit), none for the drop",
              one_each(n, {PID_V, PID_A1, PID_A2, PID_T}) && ok);
        CHECK("O back to 0: each gap carries its PID's last CC as renumbered after the drop",
              gaps_cc_ok(m));
    }

    // O +1.5 s: a gap of 1 s or more flags the next rewritten PCR, though the PCR itself
    // does not move (min(0, +1.5 s) = 0): Phases 1-2's tsdemux sees the PTS jump.
    {
        const Out p = run(c, stc_cfg(), at(when, [](RestampCore& rc) { rc.set_offset(1500 * MS); }));
        const Ana pp = analyze(c, p, true);
        bool ok = false;
        const std::map<int, int> n = gap_count(p, "edit", 1500 * MS, TICK_NS - 1, &ok);
        const std::vector<OutPcr>& pa = aa.pcr.at(PID_V);
        const std::vector<OutPcr>& pb = pp.pcr.at(PID_V);
        // The gap shows at the first PES that starts after the edit; a PCR on that very
        // packet was written before its header was read, so the flag goes on the next one.
        size_t rev = i0;
        while (rev < c.st.pk.size() && !(c.st.pk[rev].pes >= 0 && ts_pusi(c.st.pk[rev].b.data()))) rev++;
        long want_flag = -1;
        for (const OutPcr& q : pb)
            if (q.in > (long)rev) {
                want_flag = q.in;
                break;
            }
        int flagged = 0, flagged_right = 0;
        bool same = pa.size() == pb.size();
        for (size_t i = 0; same && i < pb.size(); i++) {
            same &= pb[i].pcr == pa[i].pcr && pb[i].in == pa[i].in;
            flagged += pb[i].di;
            flagged_right += pb[i].di && pb[i].in == want_flag;
        }
        CHECK("O +1.5 s: one gap of 1.5 s per PID", one_each(n, {PID_V, PID_A1, PID_A2, PID_T}) && ok);
        CHECK("O +1.5 s: the PCR unmoved, and the first one after the gap alone carries the flag",
              same && flagged == 1 && flagged_right == 1);
    }

    // Trim +200 ms on audio-1 alone.
    {
        const Out t = run(c, stc_cfg(), at(when, [](RestampCore& rc) { rc.set_trims({{PID_A1, 200 * MS}}); }));
        const Ana tt = analyze(c, t, true);
        bool ok = false;
        const std::map<int, int> n = gap_count(t, "edit", 200 * MS, TICK_NS - 1, &ok);
        const int bad = mismatches(c, aa, tt, [&](const PesInfo& in, size_t pusi) {
            return in.pid == PID_A1 && pusi >= i0 ? 18000 : 0;
        });
        CHECK("trim +200 ms on audio-1: only its PES move, +18000 ticks from the edit on", bad == 0 &&
                                                                                             tt.pes.size() == aa.pes.size());
        CHECK("trim +200 ms on audio-1: one gap of 200 ms, on it alone", one_each(n, {PID_A1}) && ok);
        CHECK("trim +200 ms on audio-1: every other PID's bytes identical, the PCR too",
              others_identical(a, t, PID_A1) && pcr_moved(aa, tt, PID_V, i0, 0));
    }

    // Trim -300 ms on audio-2: the PCR follows min(0, shift), flagged.
    {
        const Out t = run(c, stc_cfg(), at(when, [](RestampCore& rc) { rc.set_trims({{PID_A2, -300 * MS}}); }));
        const Ana tt = analyze(c, t, false);
        const int bad = mismatches(c, aa, tt, [&](const PesInfo& in, size_t pusi) {
            return in.pid == PID_A2 && pusi >= i0 ? -27000 : 0;
        });
        CHECK("trim -300 ms on audio-2: the PCR moves -300 ms exactly from the edit, the first flagged",
              pcr_moved(aa, tt, PID_V, i0, ms27(-300)));
        CHECK("trim -300 ms on audio-2: its overlap dropped (300 ms), the rest unmoved, CC continuous",
              bad == 0 && dropped_about(t, 300 * MS, {PID_A2}) && pid_stats(t, PID_V)->dropped_pes == 0 &&
                  tt.cc_lost == 0 && monotonic(tt));
    }

    // Clamps: trims to ±2 s (§5.5), O to ±10 s (OQ-14).
    {
        const Out k = run(c, stc_cfg(), at(when, [](RestampCore& rc) {
            rc.set_trims({{PID_A1, 5 * S}, {PID_A2, -9 * S}, {PID_T, 0}});
            rc.set_offset(-25 * S);
        }));
        const RestampCore::PidStats* s1 = pid_stats(k, PID_A1);
        const RestampCore::PidStats* s2 = pid_stats(k, PID_A2);
        CHECK("clamps: trims at ±2 s, O at ±10 s", s1 && s2 && s1->trim_ns == 2 * S && s2->trim_ns == -2 * S &&
                                                      s1->shift_ns == -8 * S && s2->shift_ns == -12 * S);
    }
}

// --- Acceptance: fixed mode -----------------------------------------------------------

RestampConfig fixed_cfg(bool add_base, int64_t base) {
    RestampConfig cfg;
    cfg.mode = RestampConfig::Mode::fixed;
    cfg.add_base_time = add_base;
    cfg.base_time_ns = base;
    return cfg;
}

// Every PTS/DTS + d90 and PCR + d90 * 300, exactly, against the input.
bool moved_by(const Case& c, const Ana& a, int64_t d90) {
    int n = 0;
    for (const OutPes& p : a.pes) {
        if (p.pes < 0) return false;
        const PesInfo& in = c.st.pes[(size_t)p.pes];
        if (fmod64(p.pts - in.pts, PTS_WRAP) != fmod64(d90, PTS_WRAP)) return false;
        if (in.dts >= 0 && fmod64(p.dts - in.dts, PTS_WRAP) != fmod64(d90, PTS_WRAP)) return false;
        n++;
    }
    int m = 0;
    for (const OutPcr& p : a.pcr.at(PID_V)) {
        if (p.in < 0 || fmod64(p.pcr - read_pcr(c.st.pk[(size_t)p.in].b.data()), PCR_MODULO) != fmod64(d90 * 300, PCR_MODULO))
            return false;
        m++;
    }
    return n > 5000 && m > 1000;
}

void test_fixed() {
    // A local mux: PES = running time + 1 h; arrival on running time, the base added.
    Gen g;
    g.sigma0 = 3600 * S;
    const Case c = make_case(g, 0, 0, 3, false);
    const int64_t base = 12345600000000LL;   // 12,345.6 s: whole ticks
    const Out f = run(c, fixed_cfg(true, base));
    const Ana ff = analyze(c, f, true);
    CHECK("fixed + add_base_time: every PTS/DTS + the base exactly (1,111,104,000 ticks), PCR alike",
          ns_to_pts90k(base) == 1111104000LL && moved_by(c, ff, 1111104000LL));
    CHECK("fixed: bytes identical but for PTS/DTS/PCR; removals only before the PMT",
          ff.matched && ff.ordered && ff.atomic && ff.cc_lost == 0 && f.stats.unmapped_pes == 0 &&
              ff.n_removed == f.stats.unknown_pid_packets && removed_before(ff, first_index(c, PID_PMT, false)) &&
              in_place_exact(c, ff, f));
    CHECK("fixed: no gap, no event but the PMT's", f.gaps.empty() && (int)f.events.size() == count_events(f, Ev::Kind::psi_change));
    const RestampCore::PidStats* sa = pid_stats(f, PID_A1);
    CHECK("fixed: lead telemetry on house time (PES slot - arrival, the base on both sides)",
          sa && sa->lead_median_ns > 370 * MS && sa->lead_median_ns <= 380 * MS);
    const Out f2 = run(c, fixed_cfg(true, 1000000007));
    CHECK("fixed: a base off the tick grid adds its floor, +90000 ticks", moved_by(c, analyze(c, f2, true), 90000));
    const Out f3 = run(c, fixed_cfg(false, base));
    CHECK("fixed without add_base_time: the bytes are the input's", moved_by(c, analyze(c, f3, true), 0));

    // O edits in fixed mode are exact: the gap is 500 ms to the ns, the drop counts exact.
    const size_t i0 = first_after(c, 30 * S);
    const Out p = run(c, fixed_cfg(true, base), at(30 * S, [](RestampCore& rc) { rc.set_offset(500 * MS); }));
    bool ok = false;
    const std::map<int, int> n = gap_count(p, "edit", 500 * MS, 0, &ok);
    CHECK("fixed O +500 ms: one gap per PID of exactly 500,000,000 ns", one_each(n, {PID_V, PID_A1, PID_A2, PID_T}) && ok);
    const Out m = run(c, fixed_cfg(true, base), at(30 * S, [](RestampCore& rc) { rc.set_offset(-500 * MS); }));
    const Ana mm = analyze(c, m, false);
    CHECK("fixed O -500 ms: audio-2 (20 ms PES) drops exactly 25 = 500 ms, video 12, CC continuous",
          pid_stats(m, PID_A2)->dropped_pes == 25 && pid_stats(m, PID_V)->dropped_pes == 12 && mm.cc_lost == 0 &&
              monotonic(mm) && dropped_about(m, 500 * MS, {PID_V, PID_A1, PID_A2, PID_T}, 0));
    const Ana fa = analyze(c, f, true);
    CHECK("fixed O -500 ms: the PCR moves -500 ms with the flag", pcr_moved(fa, mm, PID_V, i0, ms27(-500)));
    CHECK("fixed O -500 ms: the dropped PES's PCR packets stay, adaptation only, at their PID's CC",
          mm.n_af_only == 12 && mm.af_cc_bad == 0 && mm.matched && mm.atomic);

    // A forward jump of more than two PES (an ASRC re-lock upstream) is a gap marker.
    Gen gj = g;
    gj.gap_from = 20 * S;
    gj.gap_to = 20100 * MS;
    const Case cj = make_case(gj, 0, 0, 3, false);
    const Out j = run(cj, fixed_cfg(true, base));
    bool jok = false;
    const std::map<int, int> nj = gap_count(j, "jump", 100 * MS, 0, &jok);
    CHECK("fixed: 5 missing audio-2 PES: one gap marker of 100 ms on audio-2, reason jump",
          one_each(nj, {PID_A2}) && jok && gaps_placed(j, analyze(cj, j, true)));
}

// --- Acceptance: PMT change, discontinuity, straddle, outage, degraded -------------------

void test_pmt_change() {
    Gen g;
    g.pmt_change_at = 20 * S;
    g.pcr_move_at = 40 * S;
    const Case c = make_case(g);
    const Out a = run(c, stc_cfg());
    const Ana aa = analyze(c, a, true);
    print_events("PMT v1 at 20 s (teletext out, audio-3 in), v2 at 40 s (PCR PID moved)", a, c);
    int pmt = 0, pcr_pid = 0;
    for (const Ev& e : a.events) {
        if (e.kind != Ev::Kind::psi_change) continue;
        pmt += !std::strcmp(e.reason, "pmt");
        pcr_pid += !std::strcmp(e.reason, "pcr-pid");
    }
    CHECK("PMT change: generation bumps reported (first parse, v1), then the PCR PID change",
          pmt == 2 && pcr_pid == 1 && count_events(a, Ev::Kind::psi_change, "pat") == 1);
    CHECK("PMT change: the PCR PID change re-locks (external), once",
          count_events(a, Ev::Kind::relock) == 1 && count_events(a, Ev::Kind::relock, "external") == 1);
    int ttx_after = 0, a3 = 0, a3_ok = 0;
    int64_t worst = 0;
    for (const OutPes& p : aa.pes) {
        if (p.pes < 0) continue;
        const PesInfo& in = c.st.pes[(size_t)p.pes];
        ttx_after += p.pid == PID_T && in.t >= 20100 * MS;
        if (p.pid != PID_A3) continue;
        a3++;
        const int64_t want = model(c, in.slot_pts);
        const int64_t e = iabs(house_from_mux_pts(p.pts, want) - want);
        a3_ok += e <= (in.t >= 40 * S && in.t < 45 * S ? 10 * MS : 1 * MS);
        worst = std::max(worst, e);
    }
    std::printf("  PMT change: audio-3 %d PES, worst |house - model| %.3f ms\n", a3, worst / 1e6);
    CHECK("PMT change: the teletext PID, gone from the table, is dropped from then on",
          ttx_after == 0 && a.stats.unknown_pid_packets > 300);
    CHECK("PMT change: the new audio PID is restamped on the program's mapping", a3 > 1500 && a3_ok == a3);
    const std::vector<OutPcr> none;
    const std::vector<OutPcr>& on2 = aa.pcr.count(PID_PCR2) ? aa.pcr.at(PID_PCR2) : none;
    bool pcr2 = on2.size() > 400;
    for (const OutPcr& p : on2) {
        const int64_t mux = c.st.pk[(size_t)p.in].mux;
        if (mux < 45 * S) continue;
        const int64_t want = model(c, mux) + 3600 * S;   // the bus representation, + 1 h
        pcr2 &= iabs(pcr27_to_ns(p.pcr) - fmod64(want, pcr27_to_ns(PCR_MODULO))) <= 1 * MS;
    }
    CHECK("PMT change: the PCR on its new PID is rewritten onto house time (+ the mux's 1 h)", pcr2);
    const std::vector<PcrOut> pv = pcrs_of(c, a, aa, PID_V), p2 = pcrs_of(c, a, aa, PID_PCR2);
    const std::vector<size_t> f2 = flagged(p2);
    CHECK("PMT change: the relock's PCR, the first on the new PID, alone carries discontinuity_indicator (B-84)",
          flagged(pv).empty() && f2.size() == 1 && f2[0] == 0);
    bool gap_ok = true;
    std::map<int, int> per_pid;
    for (const RestampCore::Gap& gp : a.gaps) {
        gap_ok &= !std::strcmp(gp.reason, "epoch") && gp.end_ns - gp.start_ns < 10 * MS;
        per_pid[gp.pid]++;
    }
    std::printf("  PMT change: epoch gaps per PID:");
    for (const auto& kv : per_pid) std::printf(" 0x%x=%d", kv.first, kv.second);
    std::printf("\n");
    CHECK("PMT change: one epoch gap per PID at most (a return to the old epoch is no new epoch), each "
          "right before the PES that shows it",
          per_pid.size() <= 5 && gaps_placed(a, aa) &&
              std::all_of(per_pid.begin(), per_pid.end(), [](const std::pair<const int, int>& kv) { return kv.second == 1; }));
    CHECK("PMT change: nothing dropped, monotonic, CC intact, bytes as the input's",
          a.stats.programs[0].dropped_pes == 0 && monotonic(aa) && aa.cc_lost == 0 && aa.matched && aa.atomic &&
              aa.ordered && gap_ok);
}

// The source STC steps by `jump` at 30 s, the first PCR after it flagged or not; from
// 29.8 s audio-1 leaves the mux 300 ms later, so its last old-timeline PES arrive after
// the new timeline's first PCR (syn-pcr-discont, syn-rewind-1s, syn-straddle-audio).
void test_discontinuity_straddle(const char* label, int64_t jump, bool flag, const char* reason) {
    Gen g;
    g.rewind_at = 30 * S;
    g.jump_ns = jump;
    g.jump_flag = flag;
    g.late_from = 29800 * MS;
    g.late_to = g.secs * S;
    const Case c = make_case(g);
    const Out a = run(c, stc_cfg());
    const Ana aa = analyze(c, a, true);
    std::printf("  [%s]\n", label);
    print_events(label, a, c);
    int64_t leap = 0;
    for (const Ev& e : a.events)
        if (e.kind == Ev::Kind::relock) leap = e.value_ns;
    CHECK("discontinuity: one relock, for the trigger, nothing degraded",
          count_events(a, Ev::Kind::relock) == 1 && count_events(a, Ev::Kind::relock, reason) == 1 &&
              count_events(a, Ev::Kind::degraded) == 0 && a.stats.programs[0].clock.epoch == 2);
    CHECK("discontinuity: a leap's relock carries the jump (delta sigma - delta h)",
          flag ? leap == 0 : iabs(leap - jump) <= 50 * MS);
    // A relock is a break (B-84): the first PCR after it alone is flagged, the restamp's own flag
    // where the source sent none (a leap), though house time continues.
    const std::vector<PcrOut> pv = pcrs_of(c, a, aa, PID_V);
    const std::vector<size_t> fl = flagged(pv);
    size_t first_new = 0;
    while (first_new < pv.size() && pv[first_new].mux < g.rewind_at) first_new++;
    int src = 0;
    for (const PcrOut& p : pv) src += p.src_di;
    CHECK("discontinuity: the relock's PCR alone carries discontinuity_indicator (the source's only if flagged)",
          fl.size() == 1 && fl[0] == first_new && src == (flag ? 1 : 0));
    int late = 0, late_old = 0, after = 0, after_ok = 0;
    int64_t late_err = 0;
    for (const OutPes& p : aa.pes) {
        if (p.pes < 0) continue;
        const PesInfo& in = c.st.pes[(size_t)p.pes];
        const int64_t want = model(c, in.slot_pts);
        const int64_t e = iabs(house_from_mux_pts(p.pts, want) - want);
        if (p.pid == PID_A1 && in.t >= g.late_from && in.t < g.rewind_at) {
            late++;
            late_old += e <= 2 * MS;   // the new epoch would put it ~1 s later
            late_err = std::max(late_err, e);
        }
        if (in.t >= 34 * S) {
            after++;
            after_ok += e <= 1 * MS;
        }
    }
    std::printf("  straddle: %d late audio-1 PES, %d on the old epoch (worst %.3f ms); %d/%d new-timeline PES "
                "at their source-natural place\n",
                late, late_old, late_err / 1e6, after_ok, after);
    int want_late = 0;
    for (const PesInfo& in : c.st.pes) want_late += in.pid == PID_A1 && in.t >= g.late_from && in.t < g.rewind_at;
    CHECK("straddle: the late old-timeline audio keeps the old epoch (lands where it belongs)",
          want_late == 8 && late == want_late && late_old == late);
    CHECK("discontinuity: house time does not jump: the new timeline lands source-natural", after > 3000 && after_ok == after);
    bool gap_ok = true;
    for (const RestampCore::Gap& gp : a.gaps) gap_ok &= !std::strcmp(gp.reason, "epoch") && gp.end_ns - gp.start_ns < 20 * MS;
    CHECK("discontinuity: no PES dropped, no backward PTS on any PID, at most a small gap per PID, placed",
          a.stats.programs[0].dropped_pes == 0 && monotonic(aa) && gap_ok && a.gaps.size() <= 4 && gaps_placed(a, aa));
    CHECK("discontinuity: CC intact, bytes as the input's", aa.cc_lost == 0 && aa.matched && aa.atomic && aa.ordered);
}

// The path's floor delay at a datagram's send time, as datagrams() makes it.
int64_t floor_at(const Gen& g, int64_t send) {
    if (g.delay_from < 0 || send < g.delay_from) return 0;
    const int64_t at = (send - g.delay_from) / US, len = std::max<int64_t>(1, g.delay_ramp / US);
    return g.delay_ramp > 0 && at < len ? g.delay_rise * at / len : g.delay_rise;
}

// Each output PES against its source-natural landing on the floor in force when the PCR
// equal to its PTS was sent: house - that, ns (negative: it lands before that floor's
// arrival, so content arrives after its house time).
std::vector<std::pair<int64_t, int64_t>> landing(const Case& c, const Gen& g, const Out& o, const Ana& a) {
    std::vector<std::pair<int64_t, int64_t>> v;   // (arrival of the PES, error)
    for (const OutPes& p : a.pes) {
        if (p.pes < 0) continue;
        const PesInfo& in = c.st.pes[(size_t)p.pes];
        const int64_t want = model(c, in.slot_pts) + floor_at(g, in.slot_pts);
        v.push_back({o.arrival_of_out[p.at], house_from_mux_pts(p.pts, want) - want});
    }
    return v;
}

// The path's floor delay rises by `rise` at 30 s for good (over `ramp`; 0: at once): a
// re-route. The program re-locks for it (an envelope step after its 10 s hold, a leap at
// once above 500 ms), never degrades, drops nothing, and lands later by the rise.
void test_reroute(const char* label, int64_t rise, int64_t ramp, const char* reason) {
    Gen g;
    g.secs = 75;
    g.delay_from = 30 * S;
    g.delay_rise = rise;
    g.delay_ramp = ramp;
    const Case c = make_case(g);
    const Out a = run(c, stc_cfg());
    const Ana aa = analyze(c, a, true);
    print_events(label, a, c);
    int64_t relock_h = 0;
    for (const Ev& e : a.events)
        if (e.kind == Ev::Kind::relock) relock_h = e.house_ns;
    const bool step = !std::strcmp(reason, "envelope-step");
    CHECK("re-route: one relock, for the trigger, never degraded",
          count_events(a, Ev::Kind::relock) == 1 && count_events(a, Ev::Kind::relock, reason) == 1 &&
              count_events(a, Ev::Kind::envelope_step) == (step ? 1 : 0) &&
              count_events(a, Ev::Kind::degraded) == 0 && a.stats.programs[0].clock.epoch == 2);
    {
        const std::vector<PcrOut> pv = pcrs_of(c, a, aa, PID_V);
        const std::vector<size_t> fl = flagged(pv);
        CHECK("re-route: the relock's PCR (the new epoch's first) alone carries discontinuity_indicator (B-84)",
              fl.size() == 1 && pv[fl[0]].arrival == relock_h);
    }
    std::map<int, int> n;
    int64_t glo = INT64_MAX, ghi = INT64_MIN;
    bool epoch_only = true;
    for (const RestampCore::Gap& gp : a.gaps) {
        n[gp.pid]++;
        glo = std::min(glo, gp.end_ns - gp.start_ns);
        ghi = std::max(ghi, gp.end_ns - gp.start_ns);
        epoch_only &= !std::strcmp(gp.reason, "epoch");
    }
    CHECK("re-route: nothing dropped; one epoch gap per PID, before the PES that shows it",
          a.stats.programs[0].dropped_pes == 0 && one_each(n, {PID_V, PID_A1, PID_A2, PID_T}) && epoch_only &&
              gaps_placed(a, aa));
    // Every PID leaves the old epoch at the relock: one gap, the rise plus the delay of the
    // new epoch's first PCR above the floor (where its acquisition starts).
    CHECK("re-route: ... the gaps of one size, the rise to 10 ms",
          ghi - glo <= 1 * MS && iabs(glo - rise) <= 10 * MS && iabs(ghi - rise) <= 10 * MS);
    int after = 0, near = 0;
    int64_t worst = 0;
    for (const auto& x : landing(c, g, a, aa)) {
        if (x.first < relock_h + 5 * S) continue;
        after++;
        near += iabs(x.second) <= 1 * MS;
        if (iabs(x.second) > iabs(worst)) worst = x.second;
    }
    // PTS - PCR, which a consumer's tsdemux places by: the PCR moves with its PES, so the
    // source's but for the acquisition slew over the lead (1.2 ms).
    int64_t mlo = INT64_MAX, mhi = INT64_MIN;
    for (const auto& x : pts_pcr_moves(c, a, aa)) {
        mlo = std::min(mlo, x.second);
        mhi = std::max(mhi, x.second);
    }
    std::printf("  re-route: gaps %.3f..%.3f ms; from 5 s after the relock %d/%d PES on the new floor (worst "
                "%+.3f ms); PTS - PCR moved %+.3f..%+.3f ms\n",
                glo / 1e6, ghi / 1e6, near, after, worst / 1e6, mlo / 1e6, mhi / 1e6);
    CHECK("re-route: from 5 s after the relock every PES at its source-natural place on the new floor, within 1 ms",
          after > 3000 && near == after);
    CHECK("re-route: PTS - PCR the source's, to the acquisition slew (1.25 ms)", mlo >= -1250 * US && mhi <= 1250 * US);
    CHECK("re-route: monotonic, CC intact, bytes as the input's",
          monotonic(aa) && aa.cc_lost == 0 && aa.matched && aa.atomic && aa.ordered);
}

// A queue builds up: the floor delay rises by `rise` over `ramp` from 30 s, so the program
// re-locks by envelope steps while the delay still moves. Each relock moves every PID to
// the new epoch at once: nothing dropped, one gap per PID per relock, PTS - PCR kept.
void test_queue_ramp(const char* label, int64_t rise, int64_t ramp, int64_t secs) {
    Gen g;
    g.secs = secs;
    g.delay_from = 30 * S;
    g.delay_rise = rise;
    g.delay_ramp = ramp;
    const Case c = make_case(g);
    const Out a = run(c, stc_cfg());
    const Ana aa = analyze(c, a, true);
    print_events(label, a, c);
    const int relocks = count_events(a, Ev::Kind::relock);
    int64_t last_relock = 0;
    for (const Ev& e : a.events)
        if (e.kind == Ev::Kind::relock) last_relock = e.house_ns;
    std::map<int, int> n;
    bool epoch_only = true;
    for (const RestampCore::Gap& gp : a.gaps) {
        n[gp.pid]++;
        epoch_only &= !std::strcmp(gp.reason, "epoch");
    }
    int after = 0, near = 0;
    for (const auto& x : landing(c, g, a, aa)) {
        if (x.first < last_relock + 5 * S) continue;
        after++;
        near += iabs(x.second) <= 1 * MS;
    }
    int64_t mlo = INT64_MAX, mhi = INT64_MIN;
    for (const auto& x : pts_pcr_moves(c, a, aa)) {
        mlo = std::min(mlo, x.second);
        mhi = std::max(mhi, x.second);
    }
    std::printf("  queue: %d relocks, %llu PES dropped, %zu gaps; after the last relock %d/%d PES on the floor; "
                "PTS - PCR moved %+.3f..%+.3f ms\n",
                relocks, (unsigned long long)a.stats.programs[0].dropped_pes, a.gaps.size(), near, after, mlo / 1e6,
                mhi / 1e6);
    CHECK("queue ramp: re-locked by envelope steps, never degraded",
          relocks >= 1 && relocks == count_events(a, Ev::Kind::relock, "envelope-step") &&
              count_events(a, Ev::Kind::degraded) == 0);
    {
        const std::vector<PcrOut> pv = pcrs_of(c, a, aa, PID_V);
        const std::vector<size_t> fl = flagged(pv);
        bool at = (int)fl.size() == relocks;
        for (size_t i = 0, k = 0; at && i < a.events.size(); i++)
            if (a.events[i].kind == Ev::Kind::relock) at &= pv[fl[k++]].arrival == a.events[i].house_ns;
        CHECK("queue ramp: each relock's PCR carries discontinuity_indicator, no other PCR (B-84)", at);
    }
    bool per_relock = epoch_only && n.size() == 4;
    for (const int pid : kPids) per_relock &= n[pid] == relocks;
    CHECK("queue ramp: nothing dropped; per relock one epoch gap per PID, right before the PES that shows it",
          a.stats.programs[0].dropped_pes == 0 && per_relock && gaps_placed(a, aa));
    CHECK("queue ramp: from 5 s after the last relock every PES on the floor within 1 ms; PTS - PCR the source's",
          after > 1000 && near == after && mlo >= -1250 * US && mhi <= 1250 * US);
    CHECK("queue ramp: monotonic, CC intact, bytes as the input's",
          monotonic(aa) && aa.cc_lost == 0 && aa.matched && aa.atomic && aa.ordered);
}

// The floor falls by `fall` at 30 s (over `ramp`; 0: at once), inside the first rate
// fit's window: a faster path, or a queue draining. One-sided (P1-1): no relock, the
// mapping slews down, so content lands later than it could but never late.
void test_floor_fall(const char* label, int64_t fall, int64_t ramp) {
    Gen g;
    g.secs = 120;
    g.delay_from = 30 * S;
    g.delay_rise = fall;
    g.delay_ramp = ramp;
    const Case c = make_case(g);
    const Out a = run(c, stc_cfg());
    const Ana aa = analyze(c, a, true);
    print_events(label, a, c);
    int64_t lo = INT64_MAX, hi = INT64_MIN;
    for (const auto& x : landing(c, g, a, aa)) {
        lo = std::min(lo, x.second);
        hi = std::max(hi, x.second);
    }
    const VirtualStc::Stats& k = a.stats.programs[0].clock;
    std::printf("  fall: state %d epoch %u ppb %lld; house - floor landing %+.3f..%+.3f ms\n", (int)k.state, k.epoch,
                (long long)k.ppb, lo / 1e6, hi / 1e6);
    CHECK("floor fall: never degraded (the rate row), no relock, the source's rate kept",
          a.events.size() == (size_t)count_events(a, Ev::Kind::psi_change) && k.state == VirtualStc::State::locked &&
              k.epoch == 1 && iabs(k.ppb - 30000) <= 20000);
    CHECK("floor fall: no PES lands before its floor's arrival (never late), none more than the fall later",
          lo >= -1 * MS && hi <= iabs(fall) + 6 * MS);
    CHECK("floor fall: nothing dropped, no gap, monotonic, CC intact, bytes as the input's",
          a.stats.programs[0].dropped_pes == 0 && a.gaps.empty() && monotonic(aa) && aa.cc_lost == 0 && aa.matched &&
              aa.atomic && aa.ordered);
}

void test_outage() {
    // 3 s with nothing, the PCR continuous across it (a sending engine restarting its link).
    Gen g;
    g.outage_from = 40 * S;
    g.outage_to = 43 * S;
    const Case c = make_case(g);
    const std::string path = std::string(std::getenv("TMPDIR") && *std::getenv("TMPDIR") ? std::getenv("TMPDIR") : "/tmp") +
                             "/ts_restamp_test." + std::to_string(getpid()) + ".stct";
    TraceWriter tw;
    tw.open(path);
    const Out a = run(c, stc_cfg(), nullptr, 0, &tw);
    tw.close();
    const Ana aa = analyze(c, a, true);
    print_events("3 s outage at 40 s, PCR continuous", a, c);
    bool ok = false;
    const std::map<int, int> n = gap_count(a, "outage", 3 * S, 1 * MS, &ok);
    CHECK("outage: the epoch is kept (no relock)", a.stats.programs[0].clock.relocks == 0 && a.stats.programs[0].clock.epoch == 1);
    CHECK("outage: one gap of 3 s per PID, reason outage, each right before the PES that shows it",
          one_each(n, {PID_V, PID_A1, PID_A2, PID_T}) && ok && gaps_placed(a, aa));
    int flagged = 0, flagged_after = 0;
    for (const OutPcr& p : aa.pcr.at(PID_V)) {
        flagged += p.di;
        flagged_after += p.di && c.st.pk[(size_t)p.in].mux >= 43 * S && c.st.pk[(size_t)p.in].mux < 43100 * MS;
    }
    CHECK("outage: the first PCR after it carries discontinuity_indicator, no other",
          flagged == 1 && flagged_after == 1);
    CHECK("outage: monotonic, CC intact, bytes as the input's", monotonic(aa) && aa.cc_lost == 0 && aa.matched && aa.atomic);
    CHECK("outage: each gap carries its PID's last payload CC", gaps_cc_ok(a));

    // The recorded trace: every PCR and PES the core saw, raw, with its arrival.
    TraceReader rd;
    const bool opened = rd.open(path);
    TraceRecord r;
    std::map<int, int> kinds;
    int pes_ok = 0, pes_n = 0;
    uint64_t outage = 0;
    std::vector<TraceRecord> pes;
    bool pcr_rec_ok = true;
    while (rd.next(&r)) {
        kinds[(int)r.kind]++;
        if (r.kind == TraceKind::pcr) pcr_rec_ok &= r.pid == PID_V && trace_class(r.flags) == StreamClass::video;
        if (r.kind == TraceKind::outage) outage = r.value;
        if (r.kind == TraceKind::pes) pes.push_back(r);
    }
    // The input PES the core reached (on a known PID: after the first PMT).
    size_t first_pmt = 0;
    while (c.st.pk[first_pmt].pid != PID_PMT) first_pmt++;
    std::vector<const PesInfo*> want;
    for (size_t i = first_pmt; i < c.st.pk.size(); i++)
        if (c.st.pk[i].pes >= 0 && ts_pusi(c.st.pk[i].b.data())) want.push_back(&c.st.pes[(size_t)c.st.pk[i].pes]);
    for (size_t i = 0; i < pes.size() && i < want.size(); i++) {
        pes_n++;
        const int32_t d = want[i]->dts >= 0 ? (int32_t)fold33(want[i]->dts - want[i]->pts) : 0;
        const StreamClass cls = want[i]->pid == PID_V ? StreamClass::video : want[i]->pid == PID_T ? StreamClass::other : StreamClass::audio;
        pes_ok += (int64_t)pes[i].value == want[i]->pts && pes[i].dts_minus_pts_90k == d &&
                  pes[i].pid == want[i]->pid && trace_class(pes[i].flags) == cls;
    }
    int pcrs = 0;
    for (size_t i = first_pmt; i < c.st.pk.size(); i++) pcrs += c.st.pk[i].pid == PID_V && read_pcr(c.st.pk[i].b.data()) >= 0;
    std::printf("  trace: %d PCR, %d PES, %d PSI, %d OUTAGE records (%.3f s)\n", kinds[1], kinds[2], kinds[3], kinds[4],
                outage / 1e9);
    CHECK("trace: a valid .stct, closed", opened && rd.status() == TraceReader::Status::ok && rd.read_count() == tw.count());
    CHECK("trace: every PCR and every PES header the core read, raw, in order, class in the flags",
          kinds[1] == pcrs && pes.size() == want.size() && pes_ok == pes_n && pcr_rec_ok);
    CHECK("trace: the PMT's table (PCR PID + 4 ES) and one OUTAGE of the silence",
          kinds[3] == 5 && kinds[4] == 1 && outage >= 3 * S - 10 * MS && outage <= 3 * S + 50 * MS);
    std::remove(path.c_str());
}

void test_degraded() {
    // The PCR sticks 20-30 s (#820's vMix pattern): degraded, PCR regenerated from the PES,
    // then recovered after 30 s of clean PCR.
    Gen g;
    g.secs = 75;
    g.freeze_from = 20 * S;
    g.freeze_to = 30 * S;
    const Case c = make_case(g);
    const Out a = run(c, stc_cfg());
    const Ana aa = analyze(c, a, false);
    print_events("PCR frozen 20-30 s", a, c);
    CHECK("degraded: entered (freeze), recovered once the PCR was clean 30 s",
          count_events(a, Ev::Kind::degraded, "freeze") == 1 && count_events(a, Ev::Kind::recovered) == 1);
    int deg_pid = -2, rec_pid = -2;
    for (const Ev& e : a.events) {
        if (e.kind == Ev::Kind::degraded) deg_pid = e.pid;
        if (e.kind == Ev::Kind::recovered) rec_pid = e.pid;
    }
    CHECK("degraded: the event names the reference PID (the PCR PID, which carries PES); recovered the program",
          deg_pid == PID_V && rec_pid == -1);
    int64_t deg_at = 0, rec_at = 0;
    for (const Ev& e : a.events) {
        if (e.kind == Ev::Kind::degraded) deg_at = e.house_ns;
        if (e.kind == Ev::Kind::recovered) rec_at = e.house_ns;
    }
    // While regenerated: never back, and 250 ms under the program's PTS floor, which another
    // PID pulls down by up to 1 s: 250 ms to 1.25 s under the video's written keys.
    bool mono = true, under = true;
    int regen = 0, flags = 0;
    int64_t prev = -1, last_v_key = -1, lo = INT64_MAX, hi = INT64_MIN;
    size_t vp = 0;
    for (size_t j = 0; j < a.bytes.size() / PKT; j++) {
        while (vp < aa.pes.size() && aa.pes[vp].at < j) {   // PES written before this packet
            if (aa.pes[vp].pid == PID_V) last_v_key = key33(aa.pes[vp]);
            vp++;
        }
        const uint8_t* pk = a.bytes.data() + j * PKT;
        const int64_t pcr = read_pcr(pk);
        if (ts_pid(pk) != PID_V || pcr < 0) continue;
        flags += (pk[5] & 0x80) != 0;
        const int64_t h = a.arrival_of_out[j];
        if (h <= deg_at + 50 * MS || h >= rec_at) continue;
        regen++;
        if (prev >= 0) mono &= fmod64(pcr - prev, PCR_MODULO) < PCR_MODULO / 2;
        prev = pcr;
        if (last_v_key < 0) continue;
        int64_t below = fmod64(last_v_key * 300 - pcr, PCR_MODULO);
        if (below >= PCR_MODULO / 2) below -= PCR_MODULO;
        lo = std::min(lo, pcr27_to_ns(below));
        hi = std::max(hi, pcr27_to_ns(below));
        under &= pcr27_to_ns(below) >= 250 * MS - TICK_NS && pcr27_to_ns(below) <= 1250 * MS + TICK_NS;
    }
    std::printf("  degraded: %d regenerated PCRs, %.3f..%.3f ms under the video keys; %d flagged PCRs in all\n",
                regen, lo / 1e6, hi / 1e6, flags);
    CHECK("degraded: the PCR is regenerated: never back, 250 ms to 1.25 s under the video's keys",
          regen > 500 && mono && under);
    CHECK("degraded: the two switches (mapped -> regenerated -> mapped) are flagged, nothing else", flags == 2);
    // Video is mapped in decode order, so no epoch switch splits a GOP: the only drops are
    // the lead clamp's at entry (the reference lock lands content earlier), one run per PID.
    std::map<int, int> runs;
    bool runs_at_entry = true;
    for (const Ev& e : a.events) {
        if (e.kind != Ev::Kind::overlap) continue;
        runs[e.pid]++;
        runs_at_entry &= e.house_ns >= deg_at && e.house_ns <= deg_at + 5 * S;
    }
    CHECK("degraded: drops only where the clamp moves content earlier, one run per PID, none at recovery",
          one_each(runs, {PID_V, PID_A1, PID_A2, PID_T}) && runs_at_entry);
    CHECK("degraded: content keeps flowing, monotonic, CC continuous", monotonic(aa) && aa.cc_lost == 0 &&
                                                                          aa.matched && aa.atomic);
    CHECK("degraded: no PID past lead_clamp_ns under the reference mapping, so no lead clamp",
          count_events(a, Ev::Kind::lead_clamp) == 0);
}

void test_degraded_ref_pid() {
    // The PCR on a PID of its own (no PES) from 10 s, then stuck 20-30 s: the reference is
    // the first video PID, not the PCR PID, and the degraded event says so.
    Gen g;
    g.secs = 40;
    g.pcr_move_at = 10 * S;
    g.freeze_from = 20 * S;
    g.freeze_to = 30 * S;
    const Case c = make_case(g);
    const Out a = run(c, stc_cfg());
    int deg = 0, deg_pid = -2;
    for (const Ev& e : a.events)
        if (e.kind == Ev::Kind::degraded) {
            deg++;
            deg_pid = e.pid;
        }
    CHECK("degraded, PCR-only PCR PID: the event names the first video PID", deg == 1 && deg_pid == PID_V);
}

// --- B-84: discontinuity_indicator only where the PCR's timeline breaks --------------

// vMix's VBR mux (B-85): a PCR only on every 50th video PES, every 2 s, steady. Its spacing is
// no break, so nothing flags a PCR for it: mapped (the cadence fail row out of reach), none;
// degraded (the shipped constants), the switch to the regenerated PCR alone; an outage, also the
// first PCR after it. Every step is 2 s or more, each of which the old rule flagged.
void test_sparse_pcr() {
    for (const bool degrade : {false, true})
        for (const bool outage : {false, true}) {
            Gen g;
            g.pcr_every = 50;
            if (outage) {
                g.outage_from = 30 * S;
                g.outage_to = 33 * S;
            }
            RestampConfig cfg = stc_cfg();
            if (!degrade) cfg.pcr.pcr_interval_fail_ns = 3 * S;
            const Case c = make_case(g);
            const Out a = run(c, cfg);
            const Ana aa = analyze(c, a, !degrade);   // degraded: the switch's drop renumbers CC
            char label[96];
            std::snprintf(label, sizeof label, "PCR every 2 s, %s%s", degrade ? "degraded" : "mapped",
                          outage ? ", 3 s outage at 30 s" : "");
            std::printf("  [%s]\n", label);
            print_events(label, a, c);
            const std::vector<PcrOut> pv = pcrs_of(c, a, aa, PID_V);
            int64_t deg_at = -1, lo = INT64_MAX;
            for (const Ev& e : a.events)
                if (e.kind == Ev::Kind::degraded) deg_at = e.house_ns;
            for (size_t i = 1; i < pv.size(); i++) lo = std::min(lo, pv[i].arrival - pv[i - 1].arrival);
            std::vector<size_t> want;
            if (degrade) want.push_back(first_pcr_after(pv, deg_at));
            if (outage) {
                size_t i = 0;
                while (i < pv.size() && pv[i].mux < g.outage_to) i++;
                want.push_back(i);
            }
            int src = 0;
            for (const PcrOut& p : pv) src += p.src_di;
            std::printf("  %s: %zu PCRs, steps %.3f s or more; flagged:", label, pv.size(), lo / 1e9);
            for (size_t i : flagged(pv)) std::printf(" #%zu at %.3f s", i, (pv[i].arrival - c.h0) / 1e9);
            std::printf("; want");
            for (size_t i : want) std::printf(" #%zu", i);
            std::printf("\n");
            CHECK(degrade ? "sparse PCR: degraded on the cadence row, no relock"
                          : "sparse PCR: mapped (cadence fail row out of reach), no relock",
                  count_events(a, Ev::Kind::degraded, "cadence") == (degrade ? 1 : 0) &&
                      count_events(a, Ev::Kind::degraded) == (degrade ? 1 : 0) && count_events(a, Ev::Kind::relock) == 0);
            CHECK(degrade ? (outage ? "sparse PCR, degraded, outage: the switch and the first PCR after the outage flagged"
                                    : "sparse PCR, degraded: the switch to the regenerated PCR alone flagged")
                          : (outage ? "sparse PCR, mapped, outage: the first PCR after the outage alone flagged, once"
                                    : "sparse PCR, mapped: no PCR flagged"),
                  pv.size() >= 26 && lo >= 1900 * MS && src == 0 && flagged(pv) == want);
            CHECK("sparse PCR: monotonic, CC intact, bytes as the input's",
                  monotonic(aa) && aa.cc_lost == 0 && aa.matched && aa.atomic);
        }
}

// Degraded, a leap on the reference PID relocks the warm reference lock: the regenerated PCR
// follows the PES onto the new epoch, so the first one after the relock is flagged too.
void test_degraded_relock() {
    Gen g;
    g.freeze_from = 20 * S;
    g.freeze_to = g.secs * S;
    g.rewind_at = 40 * S;
    g.jump_flag = false;
    const Case c = make_case(g);
    const Out a = run(c, stc_cfg());
    const Ana aa = analyze(c, a, false);
    print_events("PCR frozen from 20 s, the PES rewound 1 s at 40 s", a, c);
    int64_t deg_at = -1, relock_at = -1;
    for (const Ev& e : a.events) {
        if (e.kind == Ev::Kind::degraded) deg_at = e.house_ns;
        if (e.kind == Ev::Kind::relock) relock_at = e.house_ns;
    }
    CHECK("degraded relock: degraded (freeze), then one relock (leap) of the reference lock, never recovered",
          count_events(a, Ev::Kind::degraded, "freeze") == 1 && count_events(a, Ev::Kind::relock) == 1 &&
              count_events(a, Ev::Kind::relock, "leap") == 1 && count_events(a, Ev::Kind::recovered) == 0 &&
              relock_at > deg_at);
    const std::vector<PcrOut> pv = pcrs_of(c, a, aa, PID_V);
    // The frozen PCR that degrades the program is itself written regenerated.
    const std::vector<size_t> want = {first_pcr_after(pv, deg_at - 1), first_pcr_after(pv, relock_at)};
    std::printf("  degraded relock: %zu PCRs; flagged:", pv.size());
    for (size_t i : flagged(pv)) std::printf(" #%zu at %.3f s", i, (pv[i].arrival - c.h0) / 1e9);
    std::printf("; want #%zu, #%zu\n", want[0], want[1]);
    CHECK("degraded relock: the switch and the first regenerated PCR after the relock alone flagged",
          flagged(pv) == want && want[1] < pv.size());
}

// A 3 s backlog at the start, drained in 2 s: under lead_max_ns, so the first epoch's line waits on
// it and moves onto the floor (B-37), within the epoch and mapped throughout. The PCR's step back
// there is the only break: flagged, alone.
void test_floor_move_flag() {
    Gen g;
    g.secs = 30;
    g.backlog_at = 0;
    g.backlog_len = 3 * S;
    g.backlog_drain = 2 * S;
    const Case c = make_case(g);
    const Out a = run(c, stc_cfg());
    const Ana aa = analyze(c, a, false);
    print_events("3 s backlog at the start, drained in 2 s", a, c);
    const std::vector<OutPcr>& op = aa.pcr.at(PID_V);
    std::vector<size_t> back;             // the PCRs that step back
    for (size_t i = 1; i < op.size(); i++)
        if (fmod64(op[i].pcr - op[i - 1].pcr, PCR_MODULO) > PCR_MODULO / 2) back.push_back(i);
    CHECK("floor move: one epoch, never degraded, no relock",
          a.stats.programs[0].clock.epoch == 1 && count_events(a, Ev::Kind::degraded) == 0 &&
              count_events(a, Ev::Kind::relock) == 0);
    CHECK("floor move: the PCR steps back once, and that PCR alone is flagged",
          back.size() == 1 && flagged(pcrs_of(c, a, aa, PID_V)) == back);
}

// The recorder writes each PES's discontinuity_indicator as the source sent it (B-84): a PES on
// a PCR's packet the restamp flags (after an outage) records none; one the source flags (the
// rewind's) records its own. PCR records were always read before the rewrite.
void test_trace_di() {
    Gen g;
    g.secs = 50;
    g.rewind_at = 30 * S;
    g.outage_from = 40 * S;
    g.outage_to = 42 * S;
    const Case c = make_case(g);
    TraceWriter tw;
    tw.open_memory();
    const Out a = run(c, stc_cfg(), nullptr, 0, &tw);
    const Ana aa = analyze(c, a, true);
    size_t first_pmt = 0;
    while (c.st.pk[first_pmt].pid != PID_PMT) first_pmt++;
    std::vector<const Pkt*> pes_in, pcr_in;
    for (size_t i = first_pmt; i < c.st.pk.size(); i++) {
        const Pkt& p = c.st.pk[i];
        if (p.pid == PID_V && read_pcr(p.b.data()) >= 0) pcr_in.push_back(&p);
        if (p.pes >= 0 && ts_pusi(p.b.data())) pes_in.push_back(&p);
    }
    auto af_di = [](const Pkt& p) { return (p.b[3] & 0x20) && p.b[4] > 0 && (p.b[5] & 0x80); };
    size_t np = 0, nc = 0;
    int pes_ok = 0, pcr_ok = 0, src_flags = 0, restamp_flags = 0;
    for (const TraceRecord& r : tw.records()) {
        const bool di = (r.flags & TRACE_FLAG_DISCONTINUITY) != 0;
        if (r.kind == TraceKind::pes && np < pes_in.size()) pes_ok += di == (bool)af_di(*pes_in[np++]);
        if (r.kind == TraceKind::pcr && nc < pcr_in.size()) {
            pcr_ok += di == (bool)af_di(*pcr_in[nc]);
            src_flags += di;
            nc++;
        }
    }
    // The restamp's flags in the output that rode a PES's first packet the source did not flag.
    for (const PcrOut& p : pcrs_of(c, a, aa, PID_V))
        restamp_flags += p.di && !p.src_di && c.st.pk[(size_t)p.in].pes >= 0;
    std::printf("  trace di: %zu PES and %zu PCR records; %d source-flagged PCR, %d restamp flags on a PES's packet\n",
                np, nc, src_flags, restamp_flags);
    CHECK("trace di: every PES record's discontinuity_indicator is its packet's as the source sent it",
          np == pes_in.size() && pes_ok == (int)np && restamp_flags >= 1);
    CHECK("trace di: every PCR record's too (the rewind's flag recorded, none other)",
          nc == pcr_in.size() && pcr_ok == (int)nc && src_flags == 1);
}

// --- B-39: a caller's reconnect backlog; B-8: the degraded lead clamp ------------------

// Per PID over the output: the highest house(PTS) - arrival; the lowest and highest from
// arrival `settled` on; the source PES sent from `live` on that are missing (their slots'
// span, ns) and the last such slot.
struct LeadRun {
    std::map<int, int64_t> max_lead, lo_after, hi_after, lost_ns, last_lost;
};
LeadRun lead_run(const Case& c, const Out& o, const Ana& a, int64_t live, int64_t settled) {
    LeadRun r;
    for (const OutPes& p : a.pes) {
        const int64_t at = o.arrival_of_out[p.at];
        const int64_t lead = house_from_mux_pts(p.pts, at) - at;
        r.max_lead[p.pid] = r.max_lead.count(p.pid) ? std::max(r.max_lead[p.pid], lead) : lead;
        if (at < settled) continue;
        r.lo_after[p.pid] = r.lo_after.count(p.pid) ? std::min(r.lo_after[p.pid], lead) : lead;
        r.hi_after[p.pid] = r.hi_after.count(p.pid) ? std::max(r.hi_after[p.pid], lead) : lead;
    }
    for (size_t i = 0; i < c.st.pes.size(); i++) {
        const PesInfo& in = c.st.pes[i];
        if (in.t < live || a.out_of_pes[i] >= 0) continue;
        r.lost_ns[in.pid] += period_of(in.pid);
        r.last_lost[in.pid] = std::max(r.last_lost.count(in.pid) ? r.last_lost[in.pid] : 0, in.t);
    }
    return r;
}

// Every PCR of `pid` that steps back, or forward by 1 s or more, carries discontinuity_indicator: on
// this 40 ms PCR such a step is a break's (an outage, a relock, the PCR onto another epoch; B-84).
bool pcr_steps_flagged(const Ana& a, int pid) {
    const std::vector<OutPcr>& v = a.pcr.at(pid);
    for (size_t i = 1; i < v.size(); i++) {
        const int64_t d = fmod64(v[i].pcr - v[i - 1].pcr, PCR_MODULO);
        if ((d > PCR_MODULO / 2 || pcr27_to_ns(d) >= 1 * S) && !v[i].di) return false;
    }
    return true;
}

// The PCR while the line is a backlog's: from the first flagged PCR of a dropped PES at or after
// `from` to the next flagged one (the switches mapped <-> regenerated), every PCR of `pid` written
// at its arrival less 250 ms (B-39: never frozen at the last key, which would lag arrival).
// Returns the run's span (0: none); `off` counts its PCRs more than 1 ms off.
int64_t stale_pcr_run(const Out& o, int pid, int64_t from, int* off) {
    *off = 0;
    int64_t first = -1, last = -1;
    for (size_t j = 0; j < o.bytes.size() / PKT; j++) {
        const uint8_t* pk = o.bytes.data() + j * PKT;
        const int64_t pcr = read_pcr(pk), h = o.arrival_of_out[j];
        if (ts_pid(pk) != pid || pcr < 0 || h < from) continue;
        const bool di = (pk[5] & 0x80) != 0;
        if (first < 0) {
            if (!di || (pk[3] & 0x10)) continue;
            first = h;
        } else if (di) {
            break;
        }
        last = h;
        const int64_t lag = h - house_from_mux_pts(pcr / 300, h);
        const int64_t want = RestampCore::DEGRADED_PCR_LEAD_NS;
        *off += lag < want - 1 * MS || lag > want + 1 * MS;
    }
    return first < 0 ? 0 : last - first;
}

// A caller queues for `len` from `at` (0: the pipeline starts on its backlog) and drains in
// `drain`. What it queued is stale: at most lead_max_ns of it leaves (on the seed), none of it
// once the line lies further above its floor, and the line moves onto the floor as two buckets
// agree; then the live content, on the floor (B-39).
void test_backlog(const char* label, int64_t at, int64_t len, int64_t drain) {
    Gen g;
    const int64_t live = at + len + drain;   // sent from here on: in real time
    g.secs = live / S + 40;
    g.backlog_at = at;
    g.backlog_len = len;
    g.backlog_drain = drain;
    const Case c = make_case(g);
    const Out a = run(c, stc_cfg());
    const Ana aa = analyze(c, a, false);
    print_events(label, a, c);
    const int64_t live_h = model(c, live);
    const LeadRun r = lead_run(c, a, aa, live, live_h + 5 * S);
    std::printf("  %s: lead max v/a1/a2/t %.0f/%.0f/%.0f/%.0f ms; live lost %.0f/%.0f/%.0f/%.0f ms; dropped %.1f s\n",
                label, r.max_lead.at(PID_V) / 1e6, r.max_lead.at(PID_A1) / 1e6, r.max_lead.at(PID_A2) / 1e6,
                r.max_lead.at(PID_T) / 1e6, r.lost_ns.count(PID_V) ? r.lost_ns.at(PID_V) / 1e6 : 0.0,
                r.lost_ns.count(PID_A1) ? r.lost_ns.at(PID_A1) / 1e6 : 0.0,
                r.lost_ns.count(PID_A2) ? r.lost_ns.at(PID_A2) / 1e6 : 0.0,
                r.lost_ns.count(PID_T) ? r.lost_ns.at(PID_T) / 1e6 : 0.0, a.stats.programs[0].dropped_ns_total / 1e9);
    const bool fresh = at == 0;
    CHECK("backlog: never degraded, no lead clamp; no relock, or one (leap) where the queue followed live content",
          count_events(a, Ev::Kind::degraded) == 0 && count_events(a, Ev::Kind::lead_clamp) == 0 &&
              count_events(a, Ev::Kind::relock) == (fresh ? 0 : 1) &&
              (fresh || count_events(a, Ev::Kind::relock, "leap") == 1));
    if (!fresh) {
        bool ok = false;
        const std::map<int, int> n = gap_count(a, "epoch", len, 50 * MS, &ok);
        int epoch_gaps = 0;
        for (const RestampCore::Gap& gp : a.gaps) epoch_gaps += !std::strcmp(gp.reason, "epoch");
        CHECK("backlog after live content: one gap per PID of the outage (50 ms), reason epoch",
              epoch_gaps == 4 && n.size() == 4 && std::all_of(n.begin(), n.end(), [](const std::pair<const int, int>& kv) {
                  return kv.second >= 1;
              }));
        (void)ok;
    }
    bool ahead = true;
    for (const auto& kv : r.max_lead) ahead &= kv.second <= 4 * S + 750 * MS;
    CHECK("backlog: no PES leaves further ahead of its arrival than lead_max_ns past its source lead", ahead);
    bool lost_ok = true, kept_after = true;
    for (int pid : kPids) {
        const int64_t lost = r.lost_ns.count(pid) ? r.lost_ns.at(pid) : 0;
        lost_ok &= lost <= 4500 * MS;
        kept_after &= !r.last_lost.count(pid) || r.last_lost.at(pid) < live + 4500 * MS;
    }
    CHECK("backlog: at most 4.5 s of live content lost per PID, all of it within 4.5 s of the drain's end",
          lost_ok && kept_after);
    // A header can ride a datagram up to its last packet's send plus 8 ms of jitter late.
    bool natural = true;
    for (const EsDef* e : {&kV, &kA1, &kA2, &kT}) {
        const int64_t reorder = e->pid == PID_V ? 120 * MS : 0;
        natural &= r.lo_after.count(e->pid) && r.lo_after.at(e->pid) >= e->lead - 40 * MS &&
                   r.hi_after.at(e->pid) <= e->lead + reorder + 1 * MS;
    }
    CHECK("backlog: 5 s after the drain every PID leaves at its source lead (the floor's mapping)", natural);
    std::map<int, int> runs;
    bool reason_ok = true;
    for (const Ev& e : a.events)
        if (e.kind == Ev::Kind::overlap) {
            runs[e.pid]++;
            reason_ok &= !std::strcmp(e.reason, "backlog");
        }
    CHECK("backlog: one overlap run per PID, reason backlog", one_each(runs, {PID_V, PID_A1, PID_A2, PID_T}) && reason_ok);
    bool placed = gaps_placed(a, aa) && unsignalled_ns(aa) == 0;
    for (const RestampCore::Gap& gp : a.gaps)
        placed &= !std::strcmp(gp.reason, "backlog") || !std::strcmp(gp.reason, "epoch");
    CHECK("backlog: any gap it leaves is signalled (reason backlog), right before the PES that shows it", placed);
    CHECK("backlog: monotonic, CC continuous, whole PES; every PCR step back or of 1 s or more flagged",
          monotonic(aa) && aa.cc_lost == 0 && aa.atomic && aa.matched && pcr_steps_flagged(aa, PID_V));
    int off = 0;
    const int64_t span = stale_pcr_run(a, PID_V, model(c, at + len), &off);
    std::printf("  %s: the stale run's PCR %.3f s, %d of it off arrival - 250 ms\n", label, span / 1e9, off);
    CHECK("backlog: while the line is the backlog's the PCR is arrival - 250 ms (flagged in and out, 1.5 s or more)",
          span >= 1500 * MS && off == 0);
}

// A reconnect backlog under lead_max_ns (the second review's D2): the relock seeds the new epoch
// `len` above the floor, and two agreeing buckets past backlog_ns (490 ms) move it there. Never
// degraded; within 10 s of the reconnect every PID leaves at its source lead (V-P1-3). What left
// on the seed overlaps the live content after the move, which the guard drops once (B-37's drop);
// the straddle rule maps the drain's tail on the old epoch, under what left, which goes too.
void test_backlog_relock(const char* label, int64_t at, int64_t len, int64_t drain) {
    Gen g;
    const int64_t live = at + len + drain;
    g.secs = live / S + 40;
    g.backlog_at = at;
    g.backlog_len = len;
    g.backlog_drain = drain;
    const Case c = make_case(g);
    const Out a = run(c, stc_cfg());
    const Ana aa = analyze(c, a, false);
    print_events(label, a, c);
    const int64_t back_h = model(c, at + len);   // the reconnect: the queue's first arrival
    const LeadRun r = lead_run(c, a, aa, live, back_h + 10 * S);
    std::printf("  %s: lead max v/a1/a2/t %.0f/%.0f/%.0f/%.0f ms; live lost %.0f/%.0f/%.0f/%.0f ms; dropped %.1f s\n",
                label, r.max_lead.at(PID_V) / 1e6, r.max_lead.at(PID_A1) / 1e6, r.max_lead.at(PID_A2) / 1e6,
                r.max_lead.at(PID_T) / 1e6, r.lost_ns.count(PID_V) ? r.lost_ns.at(PID_V) / 1e6 : 0.0,
                r.lost_ns.count(PID_A1) ? r.lost_ns.at(PID_A1) / 1e6 : 0.0,
                r.lost_ns.count(PID_A2) ? r.lost_ns.at(PID_A2) / 1e6 : 0.0,
                r.lost_ns.count(PID_T) ? r.lost_ns.at(PID_T) / 1e6 : 0.0, a.stats.programs[0].dropped_ns_total / 1e9);
    CHECK("relock backlog: one relock (leap), never degraded, no lead clamp",
          count_events(a, Ev::Kind::relock) == 1 && count_events(a, Ev::Kind::relock, "leap") == 1 &&
              count_events(a, Ev::Kind::degraded) == 0 && count_events(a, Ev::Kind::lead_clamp) == 0);
    // Per PID the outage's gap; and where the straddle rule mapped the drain's tail on the old epoch,
    // dropped under what the new one sent, the hole its return to the new one shows (B-48).
    std::map<int, int> n, outage;
    bool epoch_only = true;
    for (const RestampCore::Gap& gp : a.gaps) {
        epoch_only &= !std::strcmp(gp.reason, "epoch") && gp.end_ns - gp.start_ns >= period_of(gp.pid);
        if (!n[gp.pid]++) outage[gp.pid] = iabs(gp.end_ns - gp.start_ns - len) <= 50 * MS;
    }
    bool each = n.size() == 4;
    for (int pid : kPids) each &= outage[pid] == 1 && n[pid] <= 2;
    std::printf("  %s: %zu gaps, %.3f ms of holes unsignalled\n", label, a.gaps.size(), unsignalled_ns(aa) / 1e6);
    CHECK("relock backlog: per PID the outage's gap (50 ms), at most one more where a straddler returns; reason epoch, "
          "a PES or more each",
          each && epoch_only);
    CHECK("relock backlog: every hole is signalled (absence, §5.2)", unsignalled_ns(aa) == 0);
    bool ahead = true, natural = true, lost_ok = true;
    for (const EsDef* e : {&kV, &kA1, &kA2, &kT}) {
        ahead &= r.max_lead.at(e->pid) <= 4 * S + 750 * MS;
        const int64_t reorder = e->pid == PID_V ? 120 * MS : 0;
        natural &= r.lo_after.count(e->pid) && r.lo_after.at(e->pid) >= e->lead - 40 * MS &&
                   r.hi_after.at(e->pid) <= e->lead + reorder + 1 * MS;
        lost_ok &= (!r.lost_ns.count(e->pid) || r.lost_ns.at(e->pid) <= len + 1 * S) &&
                   (!r.last_lost.count(e->pid) || r.last_lost.at(e->pid) < at + len + 10 * S);
    }
    CHECK("relock backlog: no PES leaves further ahead of its arrival than lead_max_ns past its source lead", ahead);
    CHECK("relock backlog: from 10 s after the reconnect every PID leaves at its source lead (V-P1-3)", natural);
    CHECK("relock backlog: at most the backlog's length + 1 s of live content lost per PID, none after that",
          lost_ok);
    CHECK("relock backlog: monotonic, CC continuous, whole PES; every PCR step back or of 1 s or more flagged",
          monotonic(aa) && aa.cc_lost == 0 && aa.atomic && aa.matched && pcr_steps_flagged(aa, PID_V) &&
              gaps_placed(a, aa));
}

// #820: audio-2 stamped 12.6 s ahead of the rest. The lead row degrades the program; under
// the reference mapping (video) audio-2 still runs 12.5 s ahead, so it gets its own envelope
// and lands at its earliest arrival, with lead-clamp naming it, told again every 30 s (B-8).
// `fall`: the path's floor falls that much at 3 s, so the lines lie visibly above it for a
// while; audio-2's lead is the source's, not a backlog's: never stale, the clamp still at entry.
void test_lead_clamp(const char* label, int64_t fall) {
    Gen g;
    g.secs = 80;
    g.a2_ahead = 12600 * MS;
    if (fall) {
        g.delay_from = 3 * S;
        g.delay_rise = -fall;
    }
    const Case c = make_case(g);
    const Out a = run(c, stc_cfg());
    const Ana aa = analyze(c, a, false);
    print_events(label, a, c);
    int64_t deg_at = -1;
    int deg_pid = -2;
    for (const Ev& e : a.events)
        if (e.kind == Ev::Kind::degraded) {
            deg_at = e.house_ns;
            deg_pid = e.pid;
        }
    CHECK("lead clamp: degraded once (lead), timing from the video PID",
          count_events(a, Ev::Kind::degraded) == 1 && count_events(a, Ev::Kind::degraded, "lead") == 1 &&
              deg_pid == PID_V && count_events(a, Ev::Kind::recovered) == 0);
    std::vector<const Ev*> clamps;
    for (const Ev& e : a.events)
        if (e.kind == Ev::Kind::lead_clamp) clamps.push_back(&e);
    bool only_a2 = !clamps.empty(), told = true;
    for (size_t i = 0; i < clamps.size(); i++) {
        only_a2 &= clamps[i]->pid == PID_A2 && clamps[i]->value_ns > 12 * S && clamps[i]->value_ns < 13 * S;
        if (i) told &= clamps[i]->house_ns - clamps[i - 1]->house_ns >= 30 * S &&
                       clamps[i]->house_ns - clamps[i - 1]->house_ns <= 30 * S + 100 * MS;
    }
    const int64_t first = clamps.empty() ? -1 : clamps[0]->house_ns;
    std::printf("  lead clamp: %zu events, the first %.3f s after degraded, lead %.3f s\n", clamps.size(),
                (first - deg_at) / 1e9, clamps.empty() ? 0.0 : clamps[0]->value_ns / 1e9);
    CHECK("lead clamp: lead-clamp names audio-2 alone at degraded entry, its lead 12-13 s under the reference mapping",
          only_a2 && first >= deg_at && first <= deg_at + 100 * MS);
    CHECK("lead clamp: told again every 30 s while it holds (part 10's 60 s alarm)",
          told && clamps.size() == (size_t)(1 + (c.dg.back().arrival - first) / (30 * S)));
    // After its overlap (what left at 13 s ahead before the clamp): at its earliest arrival.
    const LeadRun r = lead_run(c, a, aa, INT64_MAX, first + 15 * S);
    std::printf("  lead clamp: from 15 s after it, audio-2 lead %.3f..%.3f ms, video %.3f..%.3f ms\n",
                r.lo_after.at(PID_A2) / 1e6, r.hi_after.at(PID_A2) / 1e6, r.lo_after.at(PID_V) / 1e6,
                r.hi_after.at(PID_V) / 1e6);
    // A fall is slewed: the reference PID's lead keeps up to `fall` of it for a while.
    CHECK("lead clamp: audio-2 then lands at its earliest arrival (lead -40..+1 ms), the reference PID as before",
          r.lo_after.at(PID_A2) >= -40 * MS && r.hi_after.at(PID_A2) <= 1 * MS &&
              r.hi_after.at(PID_V) <= 121 * MS + fall);
    // Drops: the degraded entry's, one run per PID (test_degraded), audio-2's the 13 s it had
    // left ahead before the clamp; none once it holds. After a fall the slew moves what lies
    // 12.6 s ahead by up to 25 ms (2,000 ppm) at the next close: one audio-2 PES before degraded.
    std::map<int, int> runs;
    int64_t a2_dropped = 0;
    bool late_run = false;
    for (const Ev& e : a.events) {
        if (e.kind != Ev::Kind::overlap) continue;
        if (fall && e.pid == PID_A2 && e.house_ns < deg_at && e.dropped_ns <= kA2.period) continue;
        runs[e.pid]++;
        if (e.pid == PID_A2) a2_dropped = e.dropped_ns;
        late_run |= e.house_ns > first + 15 * S;
    }
    bool no_backlog = true;
    for (const Ev& e : a.events) no_backlog &= std::strcmp(e.reason, "backlog") != 0;
    CHECK("lead clamp: one overlap run per PID, audio-2's about its lead, none once the clamp holds, none a backlog's",
          one_each(runs, {PID_V, PID_A1, PID_A2, PID_T}) && a2_dropped > 12 * S && a2_dropped < 14 * S && !late_run &&
              no_backlog && a.gaps.empty());
    CHECK("lead clamp: content keeps flowing, monotonic, CC continuous, whole PES",
          monotonic(aa) && aa.cc_lost == 0 && aa.atomic && aa.matched);
}

// D1's window (B-48): audio-2 stamped 3.5 s ahead (3.95 s on the floor, just under lead_max_ns) and
// the floor 80 ms lower from 3 s, so under the lines it reads past 4 s. A gap under backlog_ns is no
// backlog: audio-2 never goes as a backlog's, and nothing says backlog; it is the lead row's.
void test_lead_window() {
    Gen g;
    g.secs = 80;
    g.a2_ahead = 3500 * MS;
    g.delay_from = 3 * S;
    g.delay_rise = -80 * MS;
    const Case c = make_case(g);
    const Out a = run(c, stc_cfg());
    const Ana aa = analyze(c, a, false);
    print_events("audio-2 3.5 s ahead, the floor 80 ms lower from 3 s", a, c);
    bool no_backlog = true;
    for (const Ev& e : a.events) no_backlog &= std::strcmp(e.reason, "backlog") != 0;
    for (const RestampCore::Gap& gp : a.gaps) no_backlog &= std::strcmp(gp.reason, "backlog") != 0;
    const LeadRun r = lead_run(c, a, aa, INT64_MAX, INT64_MAX);
    std::printf("  lead window: audio-2 lead max %.3f ms; %zu gaps\n", r.max_lead.at(PID_A2) / 1e6, a.gaps.size());
    CHECK("lead window: audio-2 leaves past 4 s ahead (the lead row's to judge), never as a backlog's",
          r.max_lead.at(PID_A2) > 4 * S && no_backlog);
    int deg_pid = -2;
    for (const Ev& e : a.events)
        if (e.kind == Ev::Kind::degraded) deg_pid = e.pid;
    CHECK("lead window: the lead row degrades the program (lead), timing from the video PID, and it recovers",
          count_events(a, Ev::Kind::degraded, "lead") == 1 && deg_pid == PID_V &&
              count_events(a, Ev::Kind::recovered) == 1);
    // At recovery audio-2 leaves its clamp (lead 0) for the program's mapping: a hole, signalled.
    CHECK("lead window: monotonic, CC continuous, whole PES, every hole signalled",
          monotonic(aa) && aa.cc_lost == 0 && aa.atomic && aa.matched && gaps_placed(a, aa) &&
              unsignalled_ns(aa) == 0);
}

// The output PES of `pid` in `bytes`: the last one's guard key (DTS for video, else PTS) on
// house time near `now`, and the CC its PID last left with; false without one.
bool last_emitted(const Bytes& bytes, int pid, int64_t now, int64_t* key_house, int* cc) {
    bool found = false;
    for (size_t j = 0; j + PKT <= bytes.size(); j += PKT) {
        const uint8_t* pk = bytes.data() + j;
        if (ts_pid(pk) != pid || !(pk[3] & 0x10)) continue;
        *cc = pk[3] & 0x0F;
        PesHeader h;
        const int off = payload_offset(pk);
        if (!ts_pusi(pk) || off >= PKT || !parse_pes_header(pk + off, (size_t)(PKT - off), &h) || !h.complete) continue;
        *key_house = house_from_mux_pts(pid == PID_V && h.dts >= 0 ? h.dts : h.pts, now);
        found = true;
    }
    return found;
}

void test_outage_gaps() {
    // test_outage's 3 s silence at 40 s, queried as the element's outage task does (OQ-17).
    Gen g;
    g.outage_from = 40 * S;
    g.outage_to = 43 * S;
    const Case c = make_case(g);
    RestampCore rc(stc_cfg());
    CHECK("outage gaps: none before any PES", rc.outage_gaps(c.h0 + 50 * S).empty());
    Bytes buf, out;
    size_t k = 0;
    int64_t last = 0;
    for (; k < c.dg.size() && c.dg[k].send < g.outage_from; k++) {
        const Dg& d = c.dg[k];
        buf.clear();
        for (size_t i = d.first; i < d.first + d.n; i++) buf.insert(buf.end(), c.st.pk[i].b.begin(), c.st.pk[i].b.end());
        const RestampCore::Result r = rc.process(buf.data(), buf.size(), d.arrival);
        for (const RestampCore::Range& kr : r.keep) out.insert(out.end(), kr.data, kr.data + kr.len);
        last = d.arrival;
    }
    std::map<int, int64_t> start;
    std::map<int, int> cc;
    bool have = true;
    for (int pid : kPids) {
        int64_t key = 0;
        int c_ = -1;
        have &= last_emitted(out, pid, last, &key, &c_);
        start[pid] = key + period_of(pid);
        cc[pid] = c_;
    }
    CHECK("outage gaps: none while each PID's content still runs past now (its lead)",
          have && rc.outage_gaps(last).empty());
    bool all = true, steady = true;
    int queries = 0;
    std::map<int, int64_t> first_start;
    for (int64_t t = last + 1 * S; t <= last + 3 * S; t += 250 * MS) {
        const std::vector<RestampCore::Gap> gs = rc.outage_gaps(t);
        queries++;
        all &= gs.size() == 4;
        for (size_t i = 0; i < gs.size() && i < 4; i++) {
            const RestampCore::Gap& gp = gs[i];
            all &= gp.pid == kPids[i] && gp.program == PROGRAM && gp.end_ns == t && !std::strcmp(gp.reason, "outage") &&
                   iabs(gp.start_ns - start[gp.pid]) <= 2 * TICK_NS && gp.cc == cc[gp.pid];
            if (!first_start.count(gp.pid)) first_start[gp.pid] = gp.start_ns;
            steady &= gp.start_ns == first_start[gp.pid];
        }
    }
    CHECK("outage gaps: every 250 ms from 1 s to 3 s, one per PID in PMT order, from the end of what it "
          "emitted to now, with its last CC",
          queries == 9 && all);
    CHECK("outage gaps: the start stays put while the length grows", steady && first_start.size() == 4);
    // The gap on resume (process()) starts at the end of what the PID emitted, which is the
    // outage's start unless the datagram that ends the outage still carries the PID's older
    // PES (7 packets straddle the silence).
    Bytes sofar = out;
    std::map<int, int64_t> resumed, emitted_end;
    for (; k < c.dg.size(); k++) {
        const Dg& d = c.dg[k];
        buf.clear();
        for (size_t i = d.first; i < d.first + d.n; i++) buf.insert(buf.end(), c.st.pk[i].b.begin(), c.st.pk[i].b.end());
        const RestampCore::Result r = rc.process(buf.data(), buf.size(), d.arrival);
        Bytes chunk;
        for (const RestampCore::Range& kr : r.keep) chunk.insert(chunk.end(), kr.data, kr.data + kr.len);
        for (const RestampCore::Gap& gp : r.gaps) {
            if (resumed.count(gp.pid)) continue;
            Bytes before = sofar;
            before.insert(before.end(), chunk.begin(), chunk.begin() + (std::ptrdiff_t)gp.at);
            int64_t key = 0;
            int c_ = -1;
            if (last_emitted(before, gp.pid, d.arrival, &key, &c_)) emitted_end[gp.pid] = key + period_of(gp.pid);
            resumed[gp.pid] = gp.start_ns;
        }
        sofar.insert(sofar.end(), chunk.begin(), chunk.end());
    }
    bool at_end = resumed.size() == 4, kept = true;
    int unchanged = 0;
    for (const auto& kv : resumed) {
        at_end &= emitted_end.count(kv.first) && iabs(kv.second - emitted_end[kv.first]) <= 2 * TICK_NS;
        if (iabs(emitted_end[kv.first] - start[kv.first]) > 2 * TICK_NS) continue;
        unchanged++;
        kept &= kv.second == first_start[kv.first];
    }
    CHECK("outage gaps: the gap on resume starts at the end of what each PID emitted, exactly the outage's "
          "start where nothing older came after it",
          at_end && kept && unchanged >= 3);
}

void test_flush() {
    // FLUSH_STOP: half a packet carried, then a held split header; neither joins what follows.
    Bytes psi(2 * PKT);
    build_pat(1, {{PROGRAM, PID_PMT}}, 0, 0, psi.data());
    build_pmt(PID_PMT, PROGRAM, PID_NULL, {{PID_A1, 0x03, {}}}, 0, 0, psi.data() + PKT);
    const int64_t b90 = MUX_CLOCK_BASE_90K + 90000;
    int cc = 0;
    auto pes = [&](int64_t pts, size_t first_cap) {
        std::vector<Bytes> pk = packetize(PID_A1, pes_bytes(0xC0, pts, -1, Bytes(100, 0x33)), -1, first_cap);
        Bytes b;
        for (Bytes& p : pk) {
            p[3] = (uint8_t)((p[3] & 0xF0) | (cc++ & 0x0F));
            b.insert(b.end(), p.begin(), p.end());
        }
        return b;
    };
    auto out_of = [](const RestampCore::Result& r) {
        Bytes b;
        for (const RestampCore::Range& k : r.keep) b.insert(b.end(), k.data, k.data + k.len);
        return b;
    };
    {
        cc = 0;
        RestampCore rc(fixed_cfg(false, 0));
        Bytes a = psi;
        const Bytes p0 = pes(b90, 0), p1 = pes(b90 + 2160, 0);
        a.insert(a.end(), p0.begin(), p0.end());
        a.insert(a.end(), p1.begin(), p1.begin() + 94);   // half of the next packet, carried
        rc.process(a.data(), a.size(), 1 * S);
        rc.flush();
        Bytes b = pes(b90 + 4320, 0);
        const Bytes want = b;                            // fixed, O = 0: the bytes as they came
        const Bytes got = out_of(rc.process(b.data(), b.size(), 1024 * MS));
        const RestampCore::Stats s = rc.stats();
        CHECK("flush: a carried half packet is not joined to the next buffer's packets",
              got == want && s.desync_bytes == 0 && s.cc_lost == 1);
    }
    {
        cc = 0;
        RestampCore rc(fixed_cfg(false, 0));
        Bytes a = psi;
        const Bytes p0 = pes(b90, 0), p1 = pes(b90 + 2160, 10), p2 = pes(b90 + 4320, 0);
        a.insert(a.end(), p0.begin(), p0.end());
        a.insert(a.end(), p1.begin(), p1.begin() + PKT);   // a header split over two packets
        const Bytes got0 = out_of(rc.process(a.data(), a.size(), 1 * S));
        rc.flush();
        Bytes b(p1.begin() + PKT, p1.end());             // its continuation, then the next PES
        b.insert(b.end(), p2.begin(), p2.end());
        const Bytes got = out_of(rc.process(b.data(), b.size(), 1024 * MS));
        // Out: PSI and PES 0 (CC 0) before; after it PES 2 alone, CC 1 (the held one and its
        // continuation removed steps).
        CHECK("flush: the held header goes, its continuation after it, the next PES stays",
              got0.size() == 3 * PKT && got.size() == p2.size() && ts_pusi(got.data()) &&
                  (got[3] & 0x0F) == 1 && rc.stats().removed_packets == 2);
    }
}

void test_duplicates() {
    // Every 5th audio-1 packet sent twice (ISO 13818-1 2.4.3.3), with an O -500 ms edit.
    Gen g;
    g.dup_every = 5;
    const Case c = make_case(g);
    const Out a = run(c, stc_cfg(), at(30 * S, [](RestampCore& rc) { rc.set_offset(-500 * MS); }));
    const Ana aa = analyze(c, a, false);
    int pairs = 0, same = 0, both_gone = 0, kept = 0;
    std::vector<long> pos(c.st.pk.size(), -1);
    for (size_t j = 0; j < aa.in_of_out.size(); j++)
        if (aa.in_of_out[j] >= 0) pos[(size_t)aa.in_of_out[j]] = (long)j;
    for (size_t i = 0; i + 1 < c.st.pk.size(); i++) {
        if (c.st.pk[i].pid != PID_A1 || c.st.pk[i + 1].b != c.st.pk[i].b) continue;
        pairs++;
        if (pos[i] < 0 && pos[i + 1] < 0) both_gone++;
        if (pos[i] >= 0 && pos[i + 1] >= 0) {
            kept++;
            same += std::memcmp(a.bytes.data() + pos[i] * PKT, a.bytes.data() + pos[i + 1] * PKT, PKT) == 0;
        }
    }
    std::printf("  duplicates: %d pairs, %d kept (rewritten alike: %d), %d dropped together\n", pairs, kept, same,
                both_gone);
    CHECK("duplicates: a duplicate leaves exactly as its original (same rewrite, same CC)",
          kept > 1000 && same == kept && kept + both_gone == pairs && both_gone > 0);
    CHECK("duplicates: the output reads them as duplicates, never as loss",
          aa.cc_lost == 0 && (int)aa.cc_dup == kept && aa.dup_differ == 0);
}

void test_two_programs() {
    // An MPTS: program 2 on a source clock of its own (+5 h and +200 ppm against program
    // 1's): one discovery and one clock per PAT program, no PES on the other's mapping.
    Gen g;
    g.program2 = true;
    const Case c = make_case(g);
    const Out a = run(c, stc_cfg());
    const Ana aa = analyze(c, a, true);
    std::map<int, int> n, ok;
    std::map<int, int64_t> worst;
    for (const OutPes& p : aa.pes) {
        if (p.pes < 0) continue;
        const PesInfo& in = c.st.pes[(size_t)p.pes];
        if (in.t < 10 * S) continue;
        const int64_t want = model(c, in.slot_pts);
        const int64_t e = iabs(house_from_mux_pts(p.pts, want) - want);
        const int prog = p.pid == PID_B1 ? PROGRAM2 : PROGRAM;
        n[prog]++;
        ok[prog] += e <= 1 * MS;
        worst[prog] = std::max(worst[prog], e);
    }
    const RestampCore::ProgramStats *s1 = nullptr, *s2 = nullptr;
    for (const RestampCore::ProgramStats& ps : a.stats.programs) {
        if (ps.program == PROGRAM) s1 = &ps;
        if (ps.program == PROGRAM2) s2 = &ps;
    }
    // House runs +30 ppm on program 1's source; program 2's source runs +200 ppm on that.
    const int64_t want2 = -169966;
    std::printf("  two programs: %d + %d PES after 10 s, worst |house - model| %.3f / %.3f ms; ppb %lld / %lld "
                "(want 30000 / %lld)\n",
                n[PROGRAM], n[PROGRAM2], worst[PROGRAM] / 1e6, worst[PROGRAM2] / 1e6,
                s1 ? (long long)s1->clock.ppb : 0LL, s2 ? (long long)s2->clock.ppb : 0LL, (long long)want2);
    CHECK("two programs: a clock per PAT program, both locked on epoch 1, no relock",
          a.stats.programs.size() == 2 && s1 && s2 && s1->clock.state == VirtualStc::State::locked &&
              s2->clock.state == VirtualStc::State::locked && s1->clock.epoch == 1 && s2->clock.epoch == 1 &&
              s1->clock.relocks == 0 && s2->clock.relocks == 0);
    CHECK("two programs: every PES lands on its own program's mapping, within 1 ms",
          n[PROGRAM] > 5000 && n[PROGRAM2] > 2000 && ok[PROGRAM] == n[PROGRAM] && ok[PROGRAM2] == n[PROGRAM2]);
    // Each program's clock is a ClockLock on that program's PCRs alone, from its PMT on;
    // the synthetic datagram schedule biases a 60 s fit by ~2 ppm, so the model is coarse.
    std::map<int, int64_t> alone;
    for (const int pid : {PID_V, PID_PCR3}) {
        ClockLock cl;
        bool known = false;
        int64_t unw = 0, last = -1;
        for (const Dg& d : c.dg)
            for (size_t i = d.first; i < d.first + d.n; i++) {
                const Pkt& p = c.st.pk[i];
                known |= p.pid == (pid == PID_V ? PID_PMT : PID_PMT2);
                const int64_t pcr = read_pcr(p.b.data());
                if (!known || p.pid != pid || pcr < 0) continue;
                unw = last < 0 ? pcr : unw + (pcr - last);
                last = pcr;
                cl.feed(pcr27_to_ns(unw), d.arrival);
            }
        alone[pid] = cl.ppb();
    }
    CHECK("two programs: each clock is its own program's PCR lock exactly, the rates 200 ppm apart",
          s1 && s2 && s1->clock.ppb == alone[PID_V] && s2->clock.ppb == alone[PID_PCR3] &&
              iabs(s1->clock.ppb - 30000) <= 5000 && iabs(s2->clock.ppb - want2) <= 5000);
    const RestampCore::PidStats* b1 = pid_stats(a, PID_B1);
    const RestampCore::PidStats* v = pid_stats(a, PID_V);
    CHECK("two programs: each PID in its program's table; bytes as the input's, CC intact, monotonic",
          b1 && v && b1->program == PROGRAM2 && b1->cls == StreamClass::audio && v->program == PROGRAM &&
              aa.matched && aa.atomic && aa.ordered && aa.cc_lost == 0 && monotonic(aa) && a.gaps.empty());
}

void test_no_pts_edit() {
    // O +500 ms, then a PES without a PTS before the next timed one (fixed mode, by hand):
    // the edit applies at the timed PES, gap included; the untimed one leaves as it came.
    const int64_t b90 = MUX_CLOCK_BASE_90K + 90000;   // 1 s of running time
    Bytes pat(PKT), pmt(PKT);
    build_pat(1, {{PROGRAM, PID_PMT}}, 0, 0, pat.data());
    build_pmt(PID_PMT, PROGRAM, PID_NULL, {{PID_A1, 0x03, {}}}, 0, 0, pmt.data());
    int cc = 0;
    auto pes = [&](int64_t pts) {
        Bytes d = pts >= 0 ? pes_bytes(0xC0, pts, -1, Bytes(100, 0x22)) : Bytes{0, 0, 1, 0xC0, 0, 103, 0x84, 0, 0};
        if (pts < 0) d.insert(d.end(), 100, 0x33);
        Bytes p = packetize(PID_A1, d, -1, 0)[0];
        p[3] = (uint8_t)((p[3] & 0xF0) | (cc++ & 0x0F));
        return p;
    };
    RestampCore rc(fixed_cfg(false, 0));
    std::vector<RestampCore::Gap> gaps;
    std::vector<Bytes> out;
    auto feed = [&](Bytes b, int64_t arrival) {
        const RestampCore::Result r = rc.process(b.data(), b.size(), arrival);
        gaps.insert(gaps.end(), r.gaps.begin(), r.gaps.end());
        for (const RestampCore::Range& k : r.keep) out.push_back(Bytes(k.data, k.data + k.len));
    };
    feed(pat, 500 * MS);
    feed(pmt, 500 * MS);
    feed(pes(b90), 600 * MS);
    feed(pes(b90 + 2160), 624 * MS);
    rc.set_offset(500 * MS);
    const Bytes untimed = pes(-1);
    feed(untimed, 648 * MS);
    feed(pes(b90 + 4320), 672 * MS);
    PesHeader h;
    const int off = out.size() == 6 ? payload_offset(out[5].data()) : 0;
    const bool last_ok = out.size() == 6 && parse_pes_header(out[5].data() + off, PKT - off, &h) &&
                         h.pts == b90 + 4320 + 45000;
    CHECK("no PTS: the edit applies at the next timed PES, +45000 ticks", last_ok);
    CHECK("no PTS: ... with its gap, 500 ms exactly, reason edit",
          gaps.size() == 1 && gaps[0].pid == PID_A1 && !std::strcmp(gaps[0].reason, "edit") &&
              gaps[0].end_ns - gaps[0].start_ns == 500 * MS);
    CHECK("no PTS: the untimed PES leaves as it came",
          out.size() == 6 && out[4] == untimed && rc.stats().pes_no_pts == 1);
}

void test_gap_position() {
    // One buffer (fixed mode, by hand): three audio PES 24 ms apart, then one 1 s on (a
    // jump). Its marker goes right before the fourth, behind its PID's three earlier PES.
    const int64_t b90 = MUX_CLOCK_BASE_90K + 90000;   // 1 s of running time
    Bytes psi(2 * PKT);
    build_pat(1, {{PROGRAM, PID_PMT}}, 0, 0, psi.data());
    build_pmt(PID_PMT, PROGRAM, PID_NULL, {{PID_A1, 0x03, {}}}, 0, 0, psi.data() + PKT);
    Bytes buf;
    int cc = 0;
    for (const int64_t pts : {b90, b90 + 2160, b90 + 4320, b90 + 4320 + 90000}) {
        Bytes p = packetize(PID_A1, pes_bytes(0xC0, pts, -1, Bytes(100, 0x22)), -1, 0)[0];
        p[3] = (uint8_t)((p[3] & 0xF0) | (cc++ & 0x0F));
        buf.insert(buf.end(), p.begin(), p.end());
    }
    RestampCore rc(fixed_cfg(false, 0));
    rc.process(psi.data(), psi.size(), 900 * MS);
    const RestampCore::Result r = rc.process(buf.data(), buf.size(), 1 * S);
    CHECK("gap position: one jump gap, its marker right before the PES that shows it, behind the PID's earlier PES",
          r.gaps.size() == 1 && !std::strcmp(r.gaps[0].reason, "jump") && r.gaps[0].at == 3 * PKT &&
              r.gaps[0].end_ns - r.gaps[0].start_ns == 1 * S - 24 * MS && r.in_place && r.bytes() == 4 * PKT);
}

// Fixed mode by hand, as a capture's mux: one 48 kHz audio PID whose PES hold `sizes` samples,
// one PES per buffer at its own time, `extra` ns of nothing before the PES it names, `offsets`
// a live O set before it. The gaps, each with the index of the PES that showed it.
std::vector<std::pair<size_t, RestampCore::Gap>> fixed_run(const std::vector<int64_t>& sizes,
                                                           const std::map<size_t, int64_t>& extra,
                                                           const std::map<size_t, int64_t>& offsets = {}) {
    Bytes psi(2 * PKT);
    build_pat(1, {{PROGRAM, PID_PMT}}, 0, 0, psi.data());
    build_pmt(PID_PMT, PROGRAM, PID_NULL, {{PID_A1, 0x03, {}}}, 0, 0, psi.data() + PKT);
    RestampCore rc(fixed_cfg(false, 0));
    rc.process(psi.data(), psi.size(), 1 * S);
    std::vector<std::pair<size_t, RestampCore::Gap>> out;
    int64_t samples = 0, skip90 = 0;
    for (size_t i = 0; i < sizes.size(); i++) {
        const auto e = extra.find(i);
        if (e != extra.end()) skip90 += ns_to_pts90k(e->second);
        const auto o = offsets.find(i);
        if (o != offsets.end()) rc.set_offset(o->second);
        const int64_t t90 = ns_to_pts90k(1 * S) + samples * 15 / 8 + skip90;   // 48 kHz on 90 kHz
        Bytes p = packetize(PID_A1, pes_bytes(0xC0, MUX_CLOCK_BASE_90K + t90, -1, Bytes(100, 0x22)), -1, 0)[0];
        p[3] = (uint8_t)((p[3] & 0xF0) | (i & 0x0F));
        for (const RestampCore::Gap& g : rc.process(p.data(), p.size(), pts90k_to_ns(t90)).gaps)
            out.emplace_back(i, g);
        samples += sizes[i];
    }
    return out;
}

bool jump_of(const std::pair<size_t, RestampCore::Gap>& g, size_t at, int64_t len, int64_t tol) {
    return g.first == at && !std::strcmp(g.second.reason, "jump") &&
           iabs(g.second.end_ns - g.second.start_ns - len) <= tol;
}

void test_fixed_jump_reference() {
    constexpr int64_t SAMPLE_NS = 20834;   // 1/48 kHz, rounded up
    // mrasrc's first output on 1 ms AES67 packets is 16 of 48 samples, then 47 and 49 alternate
    // with the ratio: as the one spacing a jump was measured against, it made every PES a jump.
    std::vector<int64_t> aes(1, 16);
    for (int i = 0; i < 2000; i++) aes.push_back(i % 2 ? 49 : 47);
    const auto a = fixed_run(aes, {{1500, 60 * MS}});
    std::printf("  AES67 1 ms PES, 16-sample first: %zu gap(s)\n", a.size());
    CHECK("fixed jump: a 16-sample first PES among 1 ms ones marks nothing; a 60 ms jump marks one, 60 ms "
          "(to the PES sizes' 2-sample wobble)",
          a.size() == 1 && jump_of(a[0], 1500, 60 * MS, 2 * SAMPLE_NS + TICK_NS));
    // A relock on a capture-latency fall drops the overlap and leaves a short buffer behind.
    std::vector<int64_t> cap(300, 2880);
    cap[100] = 4;
    const auto c = fixed_run(cap, {{200, 100 * MS}});
    std::printf("  302M 60 ms PES, one of 4 samples: %zu gap(s)\n", c.size());
    CHECK("fixed jump: a 4-sample PES among 60 ms ones marks nothing; a 100 ms jump later marks one, 100 ms",
          c.size() == 1 && jump_of(c[0], 200, 100 * MS, TICK_NS));
    // A lasting cadence rise past 2x, as a PipeWire quantum rise (512 -> 2,048 samples) gives:
    // learned within two PES, a marker each, then none; a 100 ms jump still marks one.
    std::vector<int64_t> q(200, 512);
    q.insert(q.end(), 300, 2048);
    const auto r = fixed_run(q, {{400, 100 * MS}});
    std::printf("  quantum rise 512 -> 2048 samples: %zu gap(s)\n", r.size());
    CHECK("fixed jump: a quantum rise 512 -> 2,048 samples gives two markers, none after; a 100 ms jump marks one",
          r.size() == 3 && r[0].first == 201 && r[1].first == 202 && jump_of(r[2], 400, 100 * MS, TICK_NS));
    // One jump is an outlier too: the reference does not move, so a second two PES on marks.
    const auto t = fixed_run(std::vector<int64_t>(100, 2880), {{50, 100 * MS}, {52, 100 * MS}});
    CHECK("fixed jump: two 100 ms jumps two PES apart mark one each",
          t.size() == 2 && jump_of(t[0], 50, 100 * MS, TICK_NS) && jump_of(t[1], 52, 100 * MS, TICK_NS));
    // An edit's spacing is the mapping's, not the content's: it never joins the reference.
    const auto d = fixed_run(std::vector<int64_t>(100, 2880), {{52, 100 * MS}}, {{50, 100 * MS}, {51, 200 * MS}});
    CHECK("fixed jump: two +100 ms O edits in a row mark one each; a 100 ms jump right after still marks one",
          d.size() == 3 && !std::strcmp(d[0].second.reason, "edit") && !std::strcmp(d[1].second.reason, "edit") &&
              d[0].first == 50 && d[1].first == 51 && jump_of(d[2], 52, 100 * MS, TICK_NS));
}

void test_trace_mid_stream() {
    // A trace begun mid-stream (trace-location set while running) opens with the tables in
    // force, then the PCR and PES from there on: it replays on its own.
    const Case c = make_case(Gen());
    const std::string path = std::string(std::getenv("TMPDIR") && *std::getenv("TMPDIR") ? std::getenv("TMPDIR") : "/tmp") +
                             "/ts_restamp_test_mid." + std::to_string(getpid()) + ".stct";
    TraceWriter tw;
    const bool opened = tw.open(path);
    RestampCore rc(stc_cfg());
    Bytes buf;
    for (size_t k = 0; k < c.dg.size(); k++) {
        if (k == c.dg.size() / 2) rc.set_trace(&tw);
        const Dg& d = c.dg[k];
        buf.clear();
        for (size_t i = d.first; i < d.first + d.n; i++) buf.insert(buf.end(), c.st.pk[i].b.begin(), c.st.pk[i].b.end());
        rc.process(buf.data(), buf.size(), d.arrival);
    }
    rc.set_trace(nullptr);
    tw.close();
    TraceReader rd;
    std::vector<TraceRecord> v;
    TraceRecord r;
    const bool read = rd.open(path);
    while (read && rd.next(&r)) v.push_back(r);
    std::remove(path.c_str());
    const int want_pid[] = {PID_V, PID_V, PID_A1, PID_A2, PID_T};
    const int want_type[] = {0, kV.type, kA1.type, kA2.type, kT.type};
    bool head = v.size() > 5;
    for (int i = 0; head && i < 5; i++)
        head = v[(size_t)i].kind == TraceKind::psi && v[(size_t)i].pid == want_pid[i] &&
               (int)((v[(size_t)i].value >> 16) & 0xFF) == want_type[i] &&
               ((v[(size_t)i].value & TRACE_PSI_PCR) != 0) == (i == 0) && (v[(size_t)i].value & 0xFFFF) == PROGRAM;
    int psi_later = 0;
    for (size_t i = 5; i < v.size(); i++) psi_later += v[i].kind == TraceKind::psi;
    CHECK("trace mid-stream: opens with the PMT's table (PCR PID, then the ES in PMT order)",
          opened && read && head && v[3].flags == trace_flags(false, StreamClass::audio));
    CHECK("trace mid-stream: then only PCR and PES, from the attach on", psi_later == 0 && v.size() > 4000 &&
                                                                              v.back().arrival_ns > c.dg[c.dg.size() / 2].arrival);
}

// Every 4th audio-2 packet sent twice with every 3rd header split, so some copies are of
// a held header's first packet: the original waits for its continuation, the copy goes.
void test_dup_split_held() {
    Gen g;
    g.split_every = 3;
    const Case base = make_case(g);
    g.dup_every = 4;
    g.dup_pid = PID_A2;
    const Case c = make_case(g);
    const Out a0 = run(base, stc_cfg()), a = run(c, stc_cfg());
    const Ana aa = analyze(c, a, true);
    int held = 0, held_gone = 0;
    for (size_t i = 0; i < c.st.pk.size(); i++) {
        if (!c.st.pk[i].copy || !c.st.pk[i].held) continue;
        held++;
        held_gone += aa.removed[i] != 0;
    }
    auto a2_out = [](const Case& k, const Ana& x) {   // distinct PES: a kept copy repeats its header
        int n = 0;
        for (size_t i = 0; i < k.st.pes.size(); i++) n += k.st.pes[i].pid == PID_A2 && x.out_of_pes[i] >= 0;
        return n;
    };
    const int n0 = a2_out(base, analyze(base, a0, true)), n1 = a2_out(c, aa);
    std::map<int, int64_t> last;   // per PID over distinct PES (a kept copy repeats its key)
    bool forward = true;
    for (const OutPes& q : aa.pes) {
        if (q.in >= 0 && c.st.pk[(size_t)q.in].copy) continue;
        if (last.count(q.pid)) forward &= fold33(key33(q) - last[q.pid]) > 0;
        last[q.pid] = key33(q);
    }
    std::printf("  held split headers sent twice: %d copies, %d removed; audio-2 PES out %d (%d without copies),"
                " %llu headers rewritten across the split (%llu), broken %llu\n",
                held, held_gone, n1, n0, (unsigned long long)a.stats.header_spans,
                (unsigned long long)a0.stats.header_spans, (unsigned long long)a.stats.broken_spans);
    CHECK("dup of a held split header: every copy removed, the original joined to its continuation (none broken)",
          held > 100 && held_gone == held && a.stats.broken_spans == 0);
    CHECK("dup of a held split header: every audio-2 PES out as without the copies, every split header rewritten",
          n1 == n0 && n0 > 2500 && a.stats.header_spans == a0.stats.header_spans &&
              a.stats.programs[0].dropped_pes == 0);
    CHECK("dup of a held split header: CC continuous, monotonic, no copy that differs, bytes as the input's",
          aa.cc_lost == 0 && aa.dup_differ == 0 && forward && aa.matched && aa.atomic && aa.ordered);
}

// O -300 ms at 60 ms, after each PID's first mapped PES and before its second: the first
// overlap run comes before any interval is learned, so its length is the PES's own spacing.
void test_first_overlap() {
    const Case c = make_case(Gen());
    const Out m = run(c, stc_cfg(), at(60 * MS, [](RestampCore& rc) { rc.set_offset(-300 * MS); }));
    std::map<int, int64_t> ev;
    for (const Ev& e : m.events)
        if (e.kind == Ev::Kind::overlap) ev[e.pid] += e.dropped_ns;
    std::printf("  O -300 ms at 60 ms: dropped video %llu (%.0f ms), audio-1 %llu (%.0f ms), audio-2 %llu (%.0f ms),"
                " teletext %llu (%.0f ms)\n",
                (unsigned long long)pid_stats(m, PID_V)->dropped_pes, ev[PID_V] / 1e6,
                (unsigned long long)pid_stats(m, PID_A1)->dropped_pes, ev[PID_A1] / 1e6,
                (unsigned long long)pid_stats(m, PID_A2)->dropped_pes, ev[PID_A2] / 1e6,
                (unsigned long long)pid_stats(m, PID_T)->dropped_pes, ev[PID_T] / 1e6);
    CHECK("first overlap run: 300 ms dropped per PID (to one PES), the events' length the PES spacing, not 0",
          dropped_about(m, 300 * MS, {PID_V, PID_A1, PID_A2, PID_T}) &&
              m.stats.programs[0].dropped_ns_total == ev[PID_V] + ev[PID_A1] + ev[PID_A2] + ev[PID_T]);
}

void test_dup_split_cont() {
    // Each split header's continuation sent twice. The core rewrote the first copy across
    // the split, which the second cannot match, so the second goes (a copy never advances CC).
    Gen g;
    g.split_every = 3;
    g.dup_cont = true;
    const Case c = make_case(g);
    const Out a = run(c, stc_cfg());
    const Ana aa = analyze(c, a, true);
    int copies = 0, copies_gone = 0, splits = 0;
    for (size_t i = 0; i < c.st.pk.size(); i++) {
        splits += c.st.pk[i].held && !aa.removed[i];
        if (!c.st.pk[i].copy) continue;
        copies++;
        copies_gone += aa.removed[i] != 0;
    }
    std::printf("  split continuations sent twice: %d copies, %d removed; %d headers rewritten across the split\n",
                copies, copies_gone, splits);
    CHECK("dup of a split continuation: every second copy removed, no output pair that differs",
          copies > 900 && copies_gone == copies && aa.dup_differ == 0 && aa.cc_dup == 0);
    CHECK("dup of a split continuation: every split header still rewritten, CC continuous, bytes as the input's",
          splits > 900 && (int)a.stats.header_spans == splits && aa.cc_lost == 0 && aa.matched && aa.atomic &&
              monotonic(aa));
}

}  // namespace

int main() {
    test_mapping();
    test_split_header();
    test_split_on_pcr_pid();
    test_wrap();
    test_offset_edits();
    test_fixed();
    test_pmt_change();
    test_discontinuity_straddle("flagged 1 s rewind at 30 s, audio-1 straddling", -1 * S, true, "discontinuity");
    test_discontinuity_straddle("unflagged 1 s rewind at 30 s (a leap), audio-1 straddling", -1 * S, false, "leap");
    // 30 ms short of half the wrap: the PCR's continuous unwrap folds back, the 20-24 ms
    // audio PES's forward, so only the PCR's period lands them on house time.
    test_discontinuity_straddle("flagged jump 2^32 ticks - 30 ms at 30 s, audio-1 straddling",
                                pts90k_to_ns(1LL << 32) - 30 * MS, true, "discontinuity");
    // Re-routes: rises the envelope step re-locks after its hold, also past the lead row's
    // -200 ms (a PCR's lag is no lead), a queue building up as fast, and a leap (> 500 ms,
    // above the delivery stalls of the gate's egress, WI-P1-6).
    test_reroute("re-route +150 ms at 30 s", 150 * MS, 0, "envelope-step");
    test_reroute("re-route +230 ms at 30 s", 230 * MS, 0, "envelope-step");
    test_reroute("queue +240 ms over 3 s from 30 s", 240 * MS, 3 * S, "envelope-step");
    test_reroute("re-route +300 ms at 30 s", 300 * MS, 0, "envelope-step");
    test_reroute("re-route +600 ms at 30 s (a leap)", 600 * MS, 0, "leap");
    // Queues building at 10 and 20 ms/s: at 20 ms/s the relocks' epochs lie ~290 ms apart.
    test_queue_ramp("queue +200 ms over 20 s from 30 s", 200 * MS, 20 * S, 75);
    test_queue_ramp("queue +600 ms over 30 s from 30 s", 600 * MS, 30 * S, 100);
    test_floor_fall("floor -100 ms at 30 s", -100 * MS, 0);
    test_floor_fall("queue drains 100 ms over 30 s from 30 s", -100 * MS, 30 * S);
    test_outage();
    test_outage_gaps();
    test_degraded();
    test_degraded_ref_pid();
    test_sparse_pcr();
    test_degraded_relock();
    test_floor_move_flag();
    test_backlog("fresh, 30 s queued, drained in 1 s", 0, 30 * S, 1 * S);
    test_backlog("fresh, 90 s queued, drained in 5 s", 0, 90 * S, 5 * S);
    test_backlog("30 s queued after 30 s live, drained in 1 s", 30 * S, 30 * S, 1 * S);
    test_backlog_relock("2 s queued after 30 s live, drained in 1 s", 30 * S, 2 * S, 1 * S);
    test_backlog_relock("3.7 s queued after 30 s live, drained in 1 s", 30 * S, 3700 * MS, 1 * S);
    test_backlog_relock("0.6 s queued after 30 s live, drained in 0.5 s", 30 * S, 600 * MS, 500 * MS);
    test_lead_clamp("audio-2 12.6 s ahead (#820)", 0);
    test_lead_clamp("audio-2 12.6 s ahead, the floor 80 ms lower from 3 s", 80 * MS);
    test_lead_window();
    test_flush();
    test_duplicates();
    test_two_programs();
    test_trace_mid_stream();
    test_trace_di();
    test_no_pts_edit();
    test_gap_position();
    test_fixed_jump_reference();
    test_dup_split_cont();
    test_dup_split_held();
    test_first_overlap();
    return test_summary("ts_restamp");
}
