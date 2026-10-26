// ts_house: the units, the 1 h formula and its inverse, the 33-bit wrap, the
// per-stream unwrap and the bus <-> network boundary (WI-S0-1), and the
// identity stamp (WI-P2-2a). Hard-coded integers were computed with python's
// big ints (py/ts_timeline.py semantics); the identity vectors were recorded
// from the anchored stamper's house-timeline mode (`stamp_house`) at 263bdcd7.
#include <cstdint>
#include <cstdio>
#include <initializer_list>
#include <map>
#include <utility>
#include <vector>

#include "../ts_house.h"
#include "../ts_pcr.h"
#include "../ts_pes.h"
#include "../ts_psi.h"
#include "check.h"

using namespace mrts;

namespace {

constexpr int64_t STEP = 3600;                    // 40 ms in 90 kHz ticks
constexpr int64_t STEP_NS = 40'000'000;
constexpr int64_t MUX = MUX_CLOCK_BASE_90K;
constexpr int64_t E_TAI = 1760283215123456789LL;  // E of a 2026 boot, TAI offset applied
constexpr int64_t MS = 1'000'000, S = 1'000'000'000;

int64_t mod33(int64_t v) { return ((v % PTS_WRAP) + PTS_WRAP) % PTS_WRAP; }

// --- identity-stamp fixtures ---------------------------------------------------

using Bytes = std::vector<uint8_t>;

Bytes cat(std::initializer_list<Bytes> parts) {
    Bytes out;
    for (const auto& p : parts) out.insert(out.end(), p.begin(), p.end());
    return out;
}

// A PUSI packet opening a PES on `pid`: a PTS unless `pts` < 0, a DTS when `dts`
// >= 0, a PCR in its adaptation field when `pcr27` >= 0. `room` > 0 leaves that
// many payload bytes; under 14 the PTS is cut off (a split header).
Bytes pes(int pid, int64_t pts, uint8_t sid = 0xE0, int64_t dts = -1, int64_t pcr27 = -1,
          int room = 0) {
    Bytes b(PKT, 0xFF);
    b[0] = SYNC_BYTE;
    b[1] = (uint8_t)(0x40 | ((pid >> 8) & 0x1F));
    b[2] = (uint8_t)(pid & 0xFF);
    b[3] = 0x10;
    int off = 4;
    if (pcr27 >= 0 || room > 0) {
        b[3] = 0x30;
        b[4] = (uint8_t)(room > 0 ? PKT - 5 - room : 7);
        b[5] = pcr27 >= 0 ? 0x10 : 0x00;
        off = 5 + b[4];
        if (pcr27 >= 0) write_pcr(b.data(), pcr27);
    }
    const bool both = pts >= 0 && dts >= 0;
    uint8_t h[19] = {0x00, 0x00, 0x01, sid, 0x00, 0x00, 0x80,
                     (uint8_t)(pts < 0 ? 0x00 : both ? 0xC0 : 0x80),
                     (uint8_t)(pts < 0 ? 0 : both ? 10 : 5)};
    if (pts >= 0) {
        h[9] = both ? 0x31 : 0x21;
        write_pes_ts_field(h + 9, pts);
    }
    if (both) {
        h[14] = 0x11;
        write_pes_ts_field(h + 14, dts);
    }
    for (int i = 0; i < 9 + h[8] && off + i < PKT; i++) b[off + i] = h[i];
    return b;
}

Bytes payload_pkt(int pid) {   // a PES continuation: payload, no PUSI
    Bytes b(PKT, 0xFF);
    b[0] = SYNC_BYTE;
    b[1] = (uint8_t)((pid >> 8) & 0x1F);
    b[2] = (uint8_t)(pid & 0xFF);
    b[3] = 0x10;
    return b;
}

Bytes null_pkt() { return payload_pkt(PID_NULL); }

Bytes pcr_pkt(int pid, int64_t pcr27) {
    Bytes b(PKT);
    build_pcr_packet(pid, pcr27, 0, b.data());
    return b;
}

// PAT + PMT of a one-PID program, as a splitter output's PSI carousel writes them.
Bytes psi(int es_pid, int pcr_pid, int stream_type) {
    Bytes b(2 * PKT);
    build_pat(1, {{1, 0x1000}}, 0, 0, b.data());
    build_pmt(0x1000, 1, pcr_pid, {{es_pid, stream_type, {}}}, 0, 0, b.data() + PKT);
    return b;
}

// The PTS a mux writes for content at house time `h`: + 1 h, 33 bits.
int64_t P(int64_t h) { return mux_pts_from_house(h); }

int64_t stamp_of(IdentityStamp& id, const Bytes& b, int64_t now, int stream = 0) {
    return id.stamp(b.data(), b.size(), now, stream);
}

// ts_stc_test's LCG and FNV-1a: integer-only, so the corpus and its checksum
// are the same on every machine and compiler.
struct Lcg {
    uint64_t s;
    explicit Lcg(uint64_t seed) : s(seed * 0x9E3779B97F4A7C15ULL + 1) {}
    uint32_t next() {
        s = s * 6364136223846793005ULL + 1442695040888963407ULL;
        return (uint32_t)(s >> 32);
    }
};

struct Fnv {
    uint64_t h = 1469598103934665603ULL;
    void add(int64_t v) {
        for (int i = 0; i < 8; i++) {
            h ^= (uint64_t)(v >> (8 * i)) & 0xff;
            h *= 1099511628211ULL;
        }
    }
};

struct Buf {
    int stream;
    int64_t now;
    Bytes data;
};

// What the generator put in the corpus, to show that it covers every rule.
struct Tally {
    long buffers = 0, media = 0, carrier_media = 0, pes_less = 0, private_only = 0,
         split = 0, no_pts = 0, garbage = 0, partial = 0, dts = 0, empty = 0;
    long back = 0, jump = 0, wraps = 0, late_pcr = 0;
};

// One random scenario: 1-3 streams interleaved by arrival, each a bus egress
// shape, with clock steps, the bus PTS wrap and every buffer kind the rule
// tells apart. Every random draw is a statement of its own (argument order).
std::vector<Buf> scenario(uint64_t seed, Tally& t) {
    Lcg g(seed);
    auto pick = [&g](uint32_t n) { return (int64_t)(g.next() % n); };
    struct Gen {
        int prof, pid, pcr_pid, id, pcr_after;
        int64_t lead, step;
        int n;
        std::map<int, int64_t> last33;
    };
    const int k = 1 + (int)pick(3);
    std::vector<Gen> gs;
    for (int i = 0; i < k; i++) {
        Gen s{};
        s.prof = (int)pick(5);
        // 0 muxed A/V + private data, PCR in the video (or none); 1 s302m/Opus
        // on its carrier; 2 a splitter's KLV output; 3 private data, no PCR;
        // 4 private data ahead of video, on its carrier (or none)
        const bool no_pcr = pick(3) == 0;
        const int pids[5] = {0x100, 0x101, 0x1F0, 0x102, 0x103};
        s.pid = pids[s.prof];
        const bool carrier = s.prof == 1 || s.prof == 2 || (s.prof != 3 && !no_pcr);
        s.pcr_pid = carrier ? s.pid : -1;
        s.id = i * 0x2000 + s.pid;    // distinct, a PID as in mr-tssplit
        s.pcr_after = (int)pick(6);   // buffers before its first PCR
        const bool near = pick(2) == 0;        // arrival - content: a hop, or a backlog
        s.lead = near ? pick(120) * MS - 20 * MS : pick(2400) * MS - 400 * MS;
        gs.push_back(s);
    }
    int64_t now;
    const int64_t base = pick(8);
    if (base == 0) {
        now = pick(500) * MS;                  // just after boot: content before 0
        for (Gen& s : gs) s.lead = pick(600) * MS;
    } else if (base < 3) {
        now = 10 * S + pick(1000) * MS;
    } else if (base < 6) {
        const int64_t periods = pick(4);       // the bus wrap a few seconds ahead
        const int64_t before = 500 + pick(2500);
        now = pts90k_to_ns(periods * PTS_WRAP + PTS_WRAP - MUX) - before * MS;
    } else {
        const int64_t days = pick(40);         // weeks of uptime
        const int64_t secs = pick(86400);
        now = (days * 86400 + secs) * S;
    }
    std::vector<Buf> out;
    const int nbuf = 60 + (int)pick(140);
    for (int b = 0; b < nbuf; b++) {
        now += (1 + pick(30)) * MS;
        Gen& s = gs[pick(k)];
        const int64_t r = pick(1000);   // a clock step at the source, back or forward
        if (r < 15) {
            s.step -= (20 + pick(580)) * MS;
            t.back++;
        } else if (r < 30) {
            s.step += (20 + pick(2980)) * MS;
            t.jump++;
        }
        auto pts_of = [&](int pid) {
            const int64_t jitter = pick(7) - 3;
            const int64_t p = P(now - s.lead + s.step + (pid & 7) * MS + jitter * MS);
            auto it = s.last33.find(pid);
            if (it != s.last33.end() && it->second - p > PTS_WRAP / 2) t.wraps++;
            s.last33[pid] = p;
            return p;
        };
        const bool pcr_now = s.pcr_pid >= 0 && s.n >= s.pcr_after;
        if (s.pcr_pid >= 0 && s.n == s.pcr_after && s.pcr_after > 0) t.late_pcr++;
        const int64_t pcr27 = P(now - s.lead + s.step - 300 * MS) * 300;
        auto media = [&]() {
            Bytes d;
            if (s.prof == 0) {
                const int64_t n = 1 + pick(3);
                for (int64_t j = 0; j < n; j++) {
                    const int64_t w = pick(3);
                    const int pid = 0x100 + (int)w;
                    const int64_t p = pts_of(pid);
                    const bool in_af = pcr_now && w == 0 && pick(2) == 0;
                    const uint8_t sid = w == 0 ? 0xE0 : w == 1 ? 0xC0 : 0xBD;
                    d = cat({d, pes(pid, p, sid, -1, in_af ? pcr27 : -1)});
                    if (pick(2)) d = cat({d, payload_pkt(pid)});
                }
            } else if (s.prof == 1) {
                const bool pcr = pcr_now && pick(3) != 0;
                const bool after = pick(2) != 0;   // a PCR after the PES counts too
                const int64_t p = pts_of(0x101);
                if (pcr && !after) d = pcr_pkt(0x101, pcr27);
                d = cat({d, pes(0x101, p, 0xBD), payload_pkt(0x101)});
                if (pcr && after) d = cat({d, pcr_pkt(0x101, pcr27)});
            } else if (s.prof == 2) {
                if (pick(4) == 0) d = psi(0x1F0, 0x1F0, STREAM_TYPE_KLV);
                if (pcr_now && pick(3) != 0) d = cat({d, pcr_pkt(0x1F0, pcr27)});
                const int64_t p = pts_of(0x1F0);
                d = cat({d, pes(0x1F0, p, 0xBD)});
            } else if (s.prof == 3) {
                const int64_t p = pts_of(0x102);
                d = cat({pes(0x102, p, 0xBD), payload_pkt(0x102)});
            } else {
                if (pcr_now && pick(2) == 0) d = pcr_pkt(0x103, pcr27);
                const int64_t pp = pts_of(0x103);
                const int64_t pv = pts_of(0x100);
                d = cat({d, pes(0x103, pp, 0xBD), pes(0x100, pv)});
            }
            return d;
        };
        Bytes d;
        const int64_t kind = pick(100);
        if (kind < 50) {
            d = media();
            t.media++;
            if ((s.prof == 1 || s.prof == 2) && pcr_now) t.carrier_media++;
        } else if (kind < 62) {        // no PES: continuation, null, PSI, a PCR alone
            const int64_t n = 1 + pick(4);
            for (int64_t j = 0; j < n; j++) {
                const int64_t w = pick(4);
                if (w == 0) d = cat({d, payload_pkt(s.pid)});
                else if (w == 1) d = cat({d, null_pkt()});
                else if (w == 2) d = cat({d, psi(s.pid, s.pcr_pid < 0 ? s.pid : s.pcr_pid, 0x06)});
                else if (pcr_now) d = cat({d, pcr_pkt(s.pcr_pid, pcr27)});
            }
            t.pes_less++;
        } else if (kind < 72) {        // private data on a PID that is not this stream's carrier
            const int others[4] = {0x101, 0x102, 0x103, 0x1F0};
            int pid = others[pick(4)];
            if (pid == s.pcr_pid) pid = 0x104;
            const int64_t p = pts_of(pid);
            d = cat({pes(pid, p, 0xBD), payload_pkt(pid)});
            t.private_only++;
        } else if (kind < 77) {        // a split header: the PTS does not fit the packet
            const int64_t room = 6 + pick(8);
            const int64_t p = pts_of(s.pid);
            d = cat({pes(s.pid, p, 0xE0, -1, -1, (int)room), payload_pkt(s.pid)});
            t.split++;
        } else if (kind < 82) {        // no PTS: flags 0, or padding (no optional header)
            const int64_t p = pts_of(s.pid);
            d = pick(2) ? pes(s.pid, -1) : pes(s.pid, p, 0xBE);
            t.no_pts++;
        } else if (kind < 86) {        // garbage, at times starting on a sync byte
            d.resize(1 + pick(400));
            for (auto& x : d) x = (uint8_t)g.next();
            if (pick(2)) d[0] = SYNC_BYTE;
            t.garbage++;
        } else if (kind < 92) {        // a packet cut by the buffer's end
            d = media();
            const int64_t tail = 1 + pick(PKT - 1);
            for (int64_t j = 0; j < tail; j++) d.push_back((uint8_t)g.next());
            t.partial++;
        } else if (kind < 97) {        // PTS and DTS
            const int64_t p = pts_of(s.pid);
            d = pes(s.pid, p, s.prof == 0 ? 0xE0 : 0xBD, mod33(p - 2 * STEP));
            t.dts++;
        } else {
            t.empty++;
        }
        s.n++;
        out.push_back({s.id, now, std::move(d)});
        t.buffers++;
    }
    return out;
}

constexpr int CORPUS = 300;     // scenarios, seeds 1000..1299
constexpr size_t HEAD = 32;     // stamps kept literally, for a readable diff

// Every stamp of the corpus and each stream's first() in one checksum.
struct CorpusRun {
    uint64_t sum = 0;
    std::vector<int64_t> head;
    Tally t;
    long at_arrival = 0, repeated = 0, moved = 0;   // stamp == house_now, == the last, neither
};

void fold_first(Fnv& f, bool has, int pid, int64_t stamp, int64_t pts) {
    f.add(has ? 1 : 0);
    if (!has) return;
    f.add(pid);
    f.add(stamp);
    f.add(pts);
}

CorpusRun run_corpus() {
    CorpusRun r;
    Fnv f;
    for (int c = 0; c < CORPUS; c++) {
        IdentityStamp id;
        std::map<int, int64_t> last;
        for (const Buf& b : scenario(1000 + c, r.t)) {
            const int64_t s = id.stamp(b.data.data(), b.data.size(), b.now, b.stream);
            const auto it = last.find(b.stream);
            if (it != last.end() && s == it->second) r.repeated++;
            else if (s == b.now) r.at_arrival++;
            else r.moved++;
            last[b.stream] = s;
            f.add(s);
            if (r.head.size() < HEAD) r.head.push_back(s);
        }
        for (const auto& kv : last) {
            int pid = 0;
            int64_t fs = 0, fp = 0;
            const bool has = id.first(kv.first, &pid, &fs, &fp);
            fold_first(f, has, pid, fs, fp);
        }
    }
    r.sum = f.h;
    return r;
}

}  // namespace

int main() {
    // --- constants -----------------------------------------------------------
    CHECK("the PCR is the 90 kHz base times 300",
          PCR_HZ == 300 * 90000 && PCR_MODULO == 300 * PTS_WRAP);
    CHECK("PCR interval bound is 40 ms", PCR_MAX_INTERVAL_NS == 40'000'000);
    CHECK("the mux base is one hour", pts90k_to_ns(MUX) == 3'600'000'000'000LL);

    // --- units: floor everywhere, as python's // -----------------------------
    CHECK("90k->ns one second", pts90k_to_ns(90000) == 1'000'000'000);
    CHECK("90k->ns one tick floors", pts90k_to_ns(1) == 11111);
    CHECK("90k->ns floors a negative like python //", pts90k_to_ns(-1) == -11112);
    CHECK("ns->90k one second", ns_to_pts90k(1'000'000'000) == 90000);
    CHECK("ns->90k floors both ways",
          ns_to_pts90k(11111) == 0 && ns_to_pts90k(11112) == 1 && ns_to_pts90k(-1) == -1);
    CHECK("ns->27M one second", ns_to_pcr27(1'000'000'000) == 27'000'000);
    CHECK("27M->ns floors", pcr27_to_ns(1) == 37 && pcr27_to_ns(27'000'000) == 1'000'000'000);
    CHECK("ns->27M wraps at 300 * 2^33", ns_to_pcr27(100'000'000'000'000LL) == 123'019'622'400LL);
    CHECK("ns->27M folds a negative into [0, PCR_MODULO)", ns_to_pcr27(-1) == PCR_MODULO - 1);
    CHECK("ns->90k on TAI-scale ns, no overflow", ns_to_pts90k(E_TAI) == 158425489361111LL);
    CHECK("90k->ns on TAI-scale ticks, no overflow",
          pts90k_to_ns(158425489361111LL) == 1760283215123455555LL);
    {
        // ns -> 90k -> ns lands at most one tick below ("inverse within 11.1 us"),
        // exactly on the 100 us grid; 90k -> ns -> 90k is exact on the 9-tick grid.
        bool within = true, grid = true;
        for (int64_t h = -3'000'000; h <= 3'000'000; h += 7919) {
            for (int64_t base : {(int64_t)0, E_TAI}) {
                const int64_t back = pts90k_to_ns(ns_to_pts90k(base + h));
                within &= base + h - back >= 0 && base + h - back < 11112;
            }
        }
        for (int64_t k = -50; k <= 50; k++) {
            grid &= pts90k_to_ns(ns_to_pts90k(k * 100000)) == k * 100000;
            grid &= ns_to_pts90k(pts90k_to_ns(9 * k)) == 9 * k;
            grid &= ns_to_pcr27(pcr27_to_ns(27 * (k + 50))) == 27 * (k + 50);
        }
        CHECK("ns -> 90k -> ns is within one tick, never above", within);
        CHECK("the round trips are exact on their grids", grid);
    }
    {
        // S12: the demux's ceil; ns_to_pts90k (mpegtsmux's floor) gives every tick back.
        bool back = true, above = true;
        for (int64_t t = -1000; t <= 1000; t++)
            for (int64_t base : {(int64_t)0, (int64_t)(3 * PTS_WRAP + MUX), (int64_t)158425489361111LL}) {
                const int64_t ns = pts90k_to_ns_ceil(base + t);
                back &= ns_to_pts90k(ns) == base + t;
                above &= ns - pts90k_to_ns(base + t) == ((base + t) % 9 != 0 ? 1 : 0);
            }
        CHECK("90k->ns ceil: one tick 11112, a negative like -(-t // 9), 9 ticks exact",
              pts90k_to_ns_ceil(1) == 11112 && pts90k_to_ns_ceil(-1) == -11111 &&
                  pts90k_to_ns_ceil(9) == 100000 && pts90k_to_ns_ceil(0) == 0);
        CHECK("90k->ns ceil: ns_to_pts90k gives every tick back (TAI scale too), 1 ns above the "
              "floor off the 9-tick grid", back && above);
    }

    // --- fold33 and unwrap_near ----------------------------------------------
    CHECK("fold33 passes small deltas through", fold33(5) == 5 && fold33(-5) == -5);
    CHECK("fold33 folds across the wrap", fold33(PTS_WRAP - 5) == -5 && fold33(5 - PTS_WRAP) == 5);
    CHECK("fold33 keeps half a period positive",
          fold33(PTS_WRAP / 2) == PTS_WRAP / 2 && fold33(PTS_WRAP / 2 + 1) == 1 - PTS_WRAP / 2);
    CHECK("fold33 ignores whole periods", fold33(3 * PTS_WRAP + 7) == 7 && fold33(-3 * PTS_WRAP - 7) == -7);
    CHECK("unwrap_near identity", unwrap_near(900000, 900900) == 900000);
    CHECK("unwrap_near forward across the wrap", unwrap_near(4500, PTS_WRAP - 9000) == PTS_WRAP + 4500);
    CHECK("unwrap_near back across the wrap", unwrap_near(PTS_WRAP - 9000, 4500) == -9000);
    CHECK("unwrap_near onto an unwrapped reference",
          unwrap_near(4500, 5 * PTS_WRAP + 100) == 5 * PTS_WRAP + 4500);

    // --- the bus formula (moved from ts_timeline_test) -----------------------
    {
        const int64_t H = 10'000'000'000LL;           // 10 s of house time
        CHECK("house_from_mux_pts inverts the mux's 1 h offset exactly",
              house_from_mux_pts(MUX + 900000, H) == H);
        CHECK("... to the 2^33 period nearest the house clock",
              house_from_mux_pts((MUX + 900000 + 3 * PTS_WRAP) % PTS_WRAP,
                                 3 * PTS_WRAP * 100000 / 9 + H)
              == pts90k_to_ns(3 * PTS_WRAP + 900000));
        CHECK("mux_pts_from_house adds exactly 1 h",
              mux_pts_from_house(0) == MUX && mux_pts_from_house(H) == MUX + 900000);
        // A negative clock at the half-period tie: python floors it to -1 tick,
        // C's truncation would read 0 and pick the other period.
        CHECK("a negative house clock floors like python",
              house_from_mux_pts(4618967295LL, -1) == -47721858855556LL);
    }
    {
        // T: the house tick at which the bus PTS (house + 1 h) wraps to 0.
        const int64_t T = PTS_WRAP - MUX;
        CHECK("wrap: content before the bus wrap, clock after it",
              house_from_mux_pts(PTS_WRAP - 900, pts90k_to_ns(T + 900)) == pts90k_to_ns(T - 900));
        CHECK("wrap: content after the bus wrap, clock before it",
              house_from_mux_pts(900, pts90k_to_ns(T - 900)) == pts90k_to_ns(T + 900));
        const int64_t h0 = pts90k_to_ns(T) / 100000 * 100000 - 5 * STEP_NS;   // 100 us grid
        const int64_t H12 = 12 * 3'600'000'000'000LL;
        int wraps = 0;
        bool exact = true, in_range = true;
        int64_t prev = -1;
        for (int i = 0; i < 10; i++) {
            const int64_t h = h0 + i * STEP_NS, m = mux_pts_from_house(h);
            if (prev >= 0 && m < prev) wraps++;
            in_range &= m >= 0 && m < PTS_WRAP;
            // Valid while |lateness| < 13 h: a clock 12 h off still finds the period.
            exact &= house_from_mux_pts(m, h) == h && house_from_mux_pts(m, h + H12) == h &&
                     house_from_mux_pts(m, h - H12) == h;
            prev = m;
        }
        CHECK("mux_pts_from_house wraps at 2^33 exactly once across the boundary",
              wraps == 1 && in_range);
        CHECK("... and house_from_mux_pts gives every house time back exactly", exact);
        bool near = true;
        for (int64_t h = h0; h < h0 + 400 * STEP_NS; h += 1'234'567) {
            const int64_t back = house_from_mux_pts(mux_pts_from_house(h), h);
            near &= h - back >= 0 && h - back < 11112;
        }
        CHECK("off the grid the inverse is within one tick, never above", near);
    }

    // --- Unwrapper -----------------------------------------------------------
    {
        Unwrapper u;
        CHECK("a fresh unwrapper is not primed", !u.primed());
        CHECK("the first value lands nearest the seed",
              u.feed(4500, 5 * PTS_WRAP - 100) == 5 * PTS_WRAP + 4500 && u.primed());
        CHECK("later values follow the previous one, not the seed",
              u.feed(4500 + STEP, 0) == 5 * PTS_WRAP + 4500 + STEP);
        u.reset();
        CHECK("reset re-seeds", !u.primed() && u.feed(4500, 0) == 4500);
    }
    {
        Unwrapper u;
        bool cont = true;
        for (int i = 0; i < 20; i++) {
            const int64_t want = PTS_WRAP - 10 * STEP + i * STEP;
            cont &= u.feed(want % PTS_WRAP, PTS_WRAP - 10 * STEP) == want;
        }
        CHECK("PTS unwraps continuously through 2^33", cont);
    }
    {
        // The a1 fault (design §6): B-frame DTS two frames behind its PTS while
        // the 33-bit field wraps, so for two PES the DTS sits before the wrap
        // and the PTS after it. Three periods in, so a raw DTS is wrong too.
        Unwrapper u;
        const int64_t first = 4 * PTS_WRAP - 3 * STEP;
        bool ok = true;
        int straddles = 0;
        for (int i = 0; i < 10; i++) {
            const int64_t pts = first + i * STEP, dts = pts - 2 * STEP;
            const int64_t pts33 = mod33(pts), dts33 = mod33(dts);
            if (dts33 > pts33) straddles++;
            const int64_t pu = u.feed(pts33, first);
            ok &= pu == pts && u.feed_dts(dts33, pu) == dts;
        }
        CHECK("a1: DTS < PTS across the wrap unwraps beside its own PTS", ok && straddles == 2);
        CHECK("a1: nothing discarded", u.dts_discarded() == 0);
    }
    {
        // The fault itself: the first PES straddles the wrap and the seed sits
        // 13 h off, nearer the PTS's period than the DTS's.
        Unwrapper u;
        const int64_t seed = 5 * PTS_WRAP + 1800 + PTS_WRAP / 2 - 1000;
        const int64_t pu = u.feed(1800, seed);
        CHECK("a1: the PTS lands nearest the seed", pu == 5 * PTS_WRAP + 1800);
        CHECK("a1: a DTS unwrapped on its own would land a whole period late",
              unwrap_near(PTS_WRAP - 1800, seed) == 6 * PTS_WRAP - 1800);
        CHECK("a1: feed_dts keeps it 3600 ticks before its PTS",
              u.feed_dts(PTS_WRAP - 1800, pu) == 5 * PTS_WRAP - 1800);
        Unwrapper fresh;
        CHECK("feed_dts unwraps against the PTS it is given, not the stream's state",
              fresh.feed_dts(PTS_WRAP - 1800, pu) == 5 * PTS_WRAP - 1800);
    }
    {
        Unwrapper u;
        const int64_t pu = u.feed(1'000'000, 0);
        CHECK("a DTS exactly 5 s before its PTS is kept",
              u.feed_dts(1'000'000 - 450000, pu) == 1'000'000 - 450000 && u.dts_discarded() == 0);
        CHECK("a DTS more than 5 s off either way is discarded and counted",
              u.feed_dts(1'000'000 - 450001, pu) == Unwrapper::NO_DTS &&
                  u.feed_dts(1'000'000 + 450001, pu) == Unwrapper::NO_DTS &&
                  u.dts_discarded() == 2);
        CHECK("an absent DTS is not a discard",
              u.feed_dts(-1, pu) == Unwrapper::NO_DTS && u.dts_discarded() == 2);
        u.reset();
        CHECK("the discard counter survives reset", u.dts_discarded() == 2);
    }

    // --- the network boundary ------------------------------------------------
    {
        const NetEpoch e0{0};
        CHECK("E = 0: bus_to_net takes the hour off",
              bus_to_net(MUX + 900000, e0) == 900000 && bus_to_net(900000, e0) == mod33(900000 - MUX));
        bool rt = true;
        for (int64_t p : {(int64_t)0, (int64_t)1, (int64_t)900000, MUX - 1, MUX, PTS_WRAP / 2,
                          PTS_WRAP - 1})
            rt &= net_to_bus(bus_to_net(p, e0), e0) == p && bus_to_net(net_to_bus(p, e0), e0) == p;
        CHECK("E = 0: round trip both ways", rt);
    }
    {
        const NetEpoch e{E_TAI};
        CHECK("e_90k floors a TAI-scale E without overflow", e.e_90k() == 158425489361111LL);
        bool rt = true;
        for (int64_t p = 0; p < PTS_WRAP; p += 123456789) {
            const int64_t n = bus_to_net(p, e);
            rt &= n >= 0 && n < PTS_WRAP && net_to_bus(n, e) == p && bus_to_net(net_to_bus(p, e), e) == p;
        }
        CHECK("E = boot + 37 s: every bus PTS round-trips", rt);
        // With E on the 100 us grid the wire is exactly (MONO + E) x 90 kHz mod 2^33.
        const NetEpoch eg{E_TAI / 100000 * 100000};
        bool wire = true;
        for (int64_t h = 0; h < 200'000'000'000'000LL; h += 7'777'777'777'777LL)
            wire &= bus_to_net(mux_pts_from_house(h), eg) == mod33(ns_to_pts90k(h + eg.e_ns));
        CHECK("the wire PTS is (MONO + E) x 90 kHz mod 2^33", wire);
    }
    {
        // An E whose network wrap falls inside a run of bus PTS: bus `base +
        // 5 * STEP` goes out as network 0. TAI-sized, and the smallest E (a
        // ceiling) that floors to that e_90k.
        const int64_t base = MUX + 900000;
        const int64_t e90 = 18443 * PTS_WRAP - (900000 + 5 * STEP);
        const NetEpoch ew{-pts90k_to_ns(-e90)};
        CHECK("E across a wrap: the epoch is as constructed",
              ew.e_ns == 1760268475136177778LL && ew.e_90k() == e90);
        bool cont = true, rt = true;
        int64_t prev = 0;
        for (int i = 0; i < 10; i++) {
            const int64_t bus = mod33(base + i * STEP), net = bus_to_net(bus, ew);
            if (i == 4) cont &= net == PTS_WRAP - STEP;
            if (i == 5) cont &= net == 0;
            if (i > 0) cont &= fold33(net - prev) == STEP;
            rt &= net_to_bus(net, ew) == bus;
            prev = net;
        }
        CHECK("E across a wrap: the network PTS wraps to 0 and stays continuous", cont);
        CHECK("E across a wrap: round trip", rt);
    }
    CHECK("net_pcr27 is H - D_e at 27 MHz", net_pcr27(1'500'000'000, 500'000'000) == 27'000'000);
    CHECK("net_pcr27 on a TAI-scale H, no overflow",
          net_pcr27(E_TAI, 500'000'000) == 397690756533LL);
    CHECK("the PCR base is the PTS of the same instant",
          net_pcr27(E_TAI, 500'000'000) / 300 == mod33(ns_to_pts90k(E_TAI - 500'000'000)));
    CHECK("net_pcr27 stays in [0, PCR_MODULO)", net_pcr27(0, 1) == PCR_MODULO - 1);

    // --- IdentityStamp (WI-P2-2a) --------------------------------------------
    // The two house-timeline cases ts_timeline_test held until WI-P2-2b, as buffers:
    // (house_now, bytes).
    const int64_t H = 10 * S;
    std::vector<std::pair<int64_t, Bytes>> ladder, priv;
    for (int i = 0; i < 10; i++)   // content 10 s + i * 40 ms; arrival late and jittery
        ladder.push_back({H + i * STEP_NS + 170 * MS + (i % 3) * 7 * MS,
                          pes(0x41, mod33(MUX + 900000 + i * STEP))});
    ladder.push_back({H + 10 * STEP_NS, null_pkt()});
    ladder.push_back({H + 11 * STEP_NS, pes(0x41, mod33(MUX + 900000 + 10 * STEP - 90000))});
    priv.push_back({H + 5 * MS, pes(0x101, mod33(MUX + 900000), 0xBD)});
    priv.push_back({H + 200 * MS, cat({pcr_pkt(0x101, (MUX + 900000 + STEP) * 300),
                                       pes(0x101, mod33(MUX + 900000 + STEP), 0xBD)})});
    // Recorded from the house-timeline mode of the anchored stamper at 263bdcd7: the
    // two cases, and the corpus scenario(1000..1299) as its first stamps and checksum.
    const std::vector<int64_t> LADDER = {
        10000000000, 10040000000, 10080000000, 10120000000, 10160000000, 10200000000,
        10240000000, 10280000000, 10320000000, 10360000000, 10360000000, 10360000000};
    const std::vector<int64_t> PRIV = {10005000000, 10040000000};
    const std::vector<int64_t> CORPUS_HEAD = {
        378174138755555, 378174162755555, 378174162755555, 378174203755555, 378174203755555,
        378174203755555, 378174203755555, 378174203755555, 378174208744444, 378174344744444,
        378174255744444, 378174332755555, 378174272744444, 378174272744444, 378174344744444,
        378174411744444, 378174417744444, 378174497744444, 378174323744444, 378174497744444,
        378174349744444, 378174488744444, 378174372744444, 378174570744444, 378174488744444,
        378174570744444, 378174541744444, 378174552744444, 378174552744444, 378174603744444,
        378174570744444, 378174372744444};
    const uint64_t CORPUS_SUM = 0x047423b83c74b0a7ULL;
    auto run = [](IdentityStamp& id, const std::vector<std::pair<int64_t, Bytes>>& bufs) {
        std::vector<int64_t> out;
        for (const auto& b : bufs) out.push_back(stamp_of(id, b.second, b.first));
        return out;
    };

    // The recorded vectors, through IdentityStamp alone.
    {
        IdentityStamp il, ip;
        CHECK("identity: ts_timeline_test's house-timeline ladder, as recorded",
              run(il, ladder) == LADDER);
        CHECK("identity: ... and its private PES on the PCR carrier, as recorded",
              run(ip, priv) == PRIV);
        int pid = 0;
        int64_t fs = 0, fp = 0;
        CHECK("identity: the ladder's first() is the identity mapping of its first PES",
              il.first(0, &pid, &fs, &fp) && pid == 0x41 && fs == H && fp == MUX + 900000);
        CHECK("identity: the private case's first() is its first PES on the carrier",
              ip.first(0, &pid, &fs, &fp) && pid == 0x101 && fs == H + STEP_NS &&
                  fp == MUX + 900000 + STEP);
        const CorpusRun r = run_corpus();
        const Tally& t = r.t;
        std::printf("  corpus: %ld buffers (%ld media, %ld on a private carrier, %ld no PES,"
                    " %ld private only, %ld split, %ld no PTS, %ld garbage, %ld cut, %ld DTS,"
                    " %ld empty), %ld back and %ld forward steps, %ld wraps, %ld late PCRs;"
                    " %ld identity, %ld arrival, %ld repeated; checksum %016llx\n",
                    t.buffers, t.media, t.carrier_media, t.pes_less, t.private_only, t.split,
                    t.no_pts, t.garbage, t.partial, t.dts, t.empty, t.back, t.jump, t.wraps,
                    t.late_pcr, r.moved, r.at_arrival, r.repeated, (unsigned long long)r.sum);
        CHECK("identity: the corpus covers every buffer kind",
              t.media > 1000 && t.carrier_media > 1000 && t.pes_less > 1000 &&
                  t.private_only > 1000 && t.split > 500 && t.no_pts > 500 && t.garbage > 500 &&
                  t.partial > 500 && t.dts > 500 && t.empty > 500);
        CHECK("identity: ... clock steps both ways, the bus wrap and PCRs that come late",
              t.back > 500 && t.jump > 300 && t.wraps > 20 && t.late_pcr > 100);
        CHECK("identity: ... and every outcome: identity, arrival, the last stamp held",
              r.moved > 5000 && r.at_arrival > 1000 && r.repeated > 1000);
        CHECK("identity: the corpus's first stamps, as recorded", r.head == CORPUS_HEAD);
        CHECK("identity: the whole corpus and every stream's first(), as recorded",
              r.sum == CORPUS_SUM);
    }

    // Per stream: its own timing PID, first record and floor.
    {
        IdentityStamp id;
        const int A = 0x101, B = 0x1F0;   // streams named by PID, as mr-tssplit's outputs
        const Bytes a = cat({pcr_pkt(A, P(H) * 300), pes(A, P(H), 0xBD)});
        const Bytes b = cat({psi(B, B, STREAM_TYPE_KLV), pcr_pkt(B, P(H) * 300),
                             pes(B, P(H + 500 * MS), 0xBD)});
        const int64_t a1 = stamp_of(id, a, H + 200 * MS, A);
        const int64_t b1 = stamp_of(id, b, H + 300 * MS, B);
        CHECK("per stream: two PCR carriers, each stream's private PES is its timing PES",
              a1 == H && b1 == H + 500 * MS);
        const int64_t b2 = stamp_of(id, pes(A, P(H + 600 * MS), 0xBD), H + 700 * MS, B);
        const int64_t a2 = stamp_of(id, pes(B, P(H + 600 * MS), 0xBD), H + 710 * MS, A);
        CHECK("per stream: ... and not the other's: there that PID's PES is stamped at arrival",
              b2 == H + 700 * MS && a2 == H + 710 * MS);
    }
    {
        // mr-tssplit: the video output carries the source PCR, the KLV output the same
        // program PCR injected on its own PID (plan WI-P2-4, acceptance 3).
        IdentityStamp id;
        const int V = 0x100, K = 0x1F0;
        const int64_t pcr = P(H - 300 * MS) * 300;
        const Bytes video = cat({psi(V, V, STREAM_TYPE_AVC), pes(V, P(H), 0xE0, -1, pcr)});
        const Bytes klv = cat({psi(K, K, STREAM_TYPE_KLV), pcr_pkt(K, pcr),
                               pes(K, P(H + 40 * MS), 0xBD)});
        const int64_t v = stamp_of(id, video, H + 150 * MS, V);
        const int64_t k = stamp_of(id, klv, H + 160 * MS, K);
        CHECK("per stream: a KLV output with its injected PCR stamps from its PES, by the video",
              v == H && k == H + 40 * MS);
    }
    {
        IdentityStamp id;
        const int X = 1, Y = 2;
        const int64_t x1 = stamp_of(id, pes(0x100, P(H + 8 * S)), H, X);
        const int64_t y1 = stamp_of(id, pes(0x100, P(H)), H + 10 * MS, Y);
        const int64_t y2 = stamp_of(id, null_pkt(), H + 20 * MS, Y);
        const int64_t x2 = stamp_of(id, pes(0x100, P(H + 7 * S)), H + 30 * MS, X);
        const int64_t y3 = stamp_of(id, pes(0x100, P(H + 40 * MS)), H + 40 * MS, Y);
        CHECK("per stream: floors are separate, a stream behind another is not held",
              x1 == H + 8 * S && y1 == H);
        CHECK("per stream: ... a buffer without PES repeats its own stream's last stamp", y2 == H);
        CHECK("per stream: ... a step back holds at its own stream's floor",
              x2 == H + 8 * S && y3 == H + 40 * MS);
    }
    {
        // The rule within one stream, as `stamp_house` had it.
        IdentityStamp id;
        const int64_t G = 40 * S;
        CHECK("stream: a first buffer without PES is stamped at arrival",
              stamp_of(id, cat({null_pkt(), payload_pkt(0x100)}), G) == G);
        CHECK("stream: an empty buffer repeats the last stamp",
              id.stamp(nullptr, 0, G + 5 * MS) == G);
        CHECK("stream: private PES only, no PCR carrier yet: arrival",
              stamp_of(id, pes(0x102, P(G - 3 * S), 0xBD), G + 10 * MS) == G + 10 * MS);
        const Bytes three = cat({pes(0x102, P(G + 900 * MS), 0xBD),
                                 pes(0x101, P(G + 20 * MS), 0xC0), pes(0x100, P(G + 60 * MS))});
        CHECK("stream: the first timing PES wins, not a private PES before it nor a later one",
              stamp_of(id, three, G + 100 * MS) == G + 20 * MS);
        CHECK("stream: a split header (the PTS cut off) is no PES: the last stamp repeats",
              stamp_of(id, pes(0x100, P(G + 200 * MS), 0xE0, -1, -1, 10), G + 210 * MS) ==
                  G + 20 * MS);
        const Bytes whole = pes(0x100, P(G + 230 * MS));
        CHECK("stream: nor is a PES without PTS, or past the last whole packet",
              stamp_of(id, pes(0x100, -1), G + 220 * MS) == G + 20 * MS &&
                  id.stamp(whole.data(), PKT - 1, G + 230 * MS) == G + 20 * MS);
        const Bytes pcr_after = cat({pes(0x103, P(G + 240 * MS), 0xBD), pcr_pkt(0x103, 0)});
        CHECK("stream: a PCR after the PES in the same buffer makes that PID timing",
              stamp_of(id, pcr_after, G + 300 * MS) == G + 240 * MS);
        const Bytes second = cat({pcr_pkt(0x104, 0), pes(0x104, P(G + 280 * MS), 0xBD)});
        CHECK("stream: the timing PID stays the first PCR carrier",
              stamp_of(id, second, G + 310 * MS) == G + 310 * MS &&
                  stamp_of(id, pes(0x103, P(G + 320 * MS), 0xBD), G + 330 * MS) == G + 320 * MS);
        const int64_t p = P(G + 360 * MS);
        CHECK("stream: a DTS changes nothing, the stamp is the PTS's",
              stamp_of(id, pes(0x100, p, 0xE0, mod33(p - 2 * STEP)), G + 400 * MS) == G + 360 * MS);
        Bytes lost = pes(0x100, P(G + 380 * MS));
        lost[0] = 0x00;
        CHECK("stream: without its sync byte a packet carries no PES",
              stamp_of(id, lost, G + 410 * MS) == G + 360 * MS);
        IdentityStamp q;
        Bytes lost_pcr = pcr_pkt(0x105, 0);
        lost_pcr[0] = 0x00;
        CHECK("stream: ... and no PCR, so its PID does not become the carrier",
              stamp_of(q, cat({lost_pcr, pes(0x105, P(G), 0xBD)}), G + 10 * MS) == G + 10 * MS);
        // The bus PTS wraps 1 h of house time before the 90 kHz count does; 3 periods in.
        const int64_t T = (pts90k_to_ns(3 * PTS_WRAP + PTS_WRAP - MUX) / 100000) * 100000;
        IdentityStamp w;
        const int64_t w1 = stamp_of(w, pes(0x100, P(T - 20 * MS)), T + 100 * MS);
        const int64_t w2 = stamp_of(w, pes(0x100, P(T + 20 * MS)), T + 140 * MS);
        CHECK("stream: across the bus PTS wrap the stamps run on",
              P(T + 20 * MS) < P(T - 20 * MS) && w1 == T - 20 * MS && w2 == T + 20 * MS);
        // Below 0 the bus would read "stamp at send time" (libmrbus broadcast).
        IdentityStamp z;
        CHECK("stream: never below 0, the floor starts there",
              stamp_of(z, pes(0x100, P(-2 * S)), 500 * MS) == 0 &&
                  stamp_of(z, pes(0x100, P(-1 * S)), 600 * MS) == 0 &&
                  stamp_of(z, pes(0x100, P(100 * MS)), 700 * MS) == 100 * MS);
    }

    // first() once per stream; reset() forgets everything.
    {
        IdentityStamp id;
        int pid = -1;
        int64_t fs = -1, fp = -1;
        stamp_of(id, pes(0x102, P(H), 0xBD), H);   // private only
        stamp_of(id, null_pkt(), H + 1 * MS);       // no PES
        const bool none = !id.first(0, &pid, &fs, &fp) && pid == -1 && fs == -1 && fp == -1;
        stamp_of(id, pes(0x100, P(H + 40 * MS)), H + 50 * MS);
        const bool one = id.first(0, &pid, &fs, &fp) && pid == 0x100 && fs == H + 40 * MS &&
                         fp == P(H + 40 * MS);
        stamp_of(id, pes(0x101, P(H + 80 * MS), 0xC0), H + 90 * MS);
        stamp_of(id, pes(0x100, P(H - 1 * S)), H + 100 * MS);   // a step back, held
        const bool kept = id.first(0, &pid, &fs, &fp) && pid == 0x100 && fs == H + 40 * MS;
        CHECK("first(): false until the stream's first timing PES, outputs untouched", none);
        CHECK("first(): then that PES's pid, identity stamp and PTS", one);
        CHECK("first(): kept, whatever the stream carries later", kept);
        const bool other_none = !id.first(7, &pid, &fs, &fp);
        stamp_of(id, pes(0x200, P(H + 200 * MS)), H + 210 * MS, 7);
        const bool other = id.first(7, &pid, &fs, &fp) && pid == 0x200 && fs == H + 200 * MS &&
                           fp == P(H + 200 * MS);
        const bool zero_kept = id.first(0, &pid, &fs, &fp) && pid == 0x100 && fs == H + 40 * MS;
        CHECK("first(): per stream, each its own", other_none && other && zero_kept);
        CHECK("first(): any out-pointer may be null",
              id.first(7, nullptr, nullptr, nullptr) && !id.first(8, nullptr, nullptr, nullptr));
        IdentityStamp late;
        stamp_of(late, null_pkt(), 3 * S);
        const int64_t held = stamp_of(late, pes(0x100, P(2 * S)), 3 * S + 1 * MS);
        CHECK("first(): the identity stamp before the floor, the buffer's stamp after it",
              held == 3 * S && late.first(0, &pid, &fs, &fp) && fs == 2 * S);

        id.reset();
        CHECK("reset(): every stream's first record goes",
              !id.first(0, &pid, &fs, &fp) && !id.first(7, &pid, &fs, &fp));
        IdentityStamp c;
        stamp_of(c, cat({pcr_pkt(0x101, 0), pes(0x101, P(H), 0xBD)}), H + 10 * MS);   // the carrier
        stamp_of(c, pes(0x100, P(H + 10 * S)), H + 20 * MS);                          // floor 20 s
        c.reset();
        CHECK("reset(): the floor goes: a stamp below the old one is not held",
              stamp_of(c, pes(0x100, P(H + 2 * S)), H + 30 * MS) == H + 2 * S);
        c.reset();
        CHECK("reset(): ... and a buffer without PES is stamped at arrival",
              stamp_of(c, null_pkt(), H + 40 * MS) == H + 40 * MS);
        c.reset();
        CHECK("reset(): the PCR carrier goes: its private PES is stamped at arrival again",
              stamp_of(c, pes(0x101, P(H + 40 * MS), 0xBD), H + 50 * MS) == H + 50 * MS);
    }

    return test_summary("ts_house");
}
