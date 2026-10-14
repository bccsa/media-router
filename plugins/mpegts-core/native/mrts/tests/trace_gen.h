// Synthetic arrival traces (WI-P1-2) for fixture_gen --trace and ts_trace_test: one program,
// its PCR on the video PID, sent over a path of floor delay plus one-sided jitter, in order.
// Integer LCG and integer -ln, so one seed gives the same bytes on every machine.
#pragma once
#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

#include "../ts_house.h"
#include "../ts_restamp.h"
#include "../ts_trace.h"

namespace trace_gen {

constexpr int64_t MS = 1000000, S = 1000000000;
constexpr int PROGRAM = 1, PCR_PID = 0x100;

// A value over time: the first step's from 0, each later one from its time on.
struct Schedule {
    std::vector<std::pair<int64_t, int64_t>> steps;   // (from_ns, value), ascending
    int64_t at(int64_t t) const {
        int64_t v = steps.empty() ? 0 : steps[0].second;
        for (const auto& s : steps)
            if (s.first <= t) v = s.second;
        return v;
    }
};

struct Jump {
    int64_t at_ns, delta_ns;              // the source timeline moves by delta_ns from at_ns
    bool flagged;                         // discontinuity_indicator on the first PCR after it
};
struct Outage {
    int64_t at_ns, len_ns;                // nothing sent; the source clock runs on
};
struct Late {
    int pid;
    int64_t from_ns, to_ns, by_ns;        // PES of these slots sent by_ns late, stamps kept
};

struct Config {
    uint64_t seed = 1;
    int64_t duration_ns = 120 * S;
    int64_t house0_ns = 1000 * S;         // house time of the first send, before its delay
    int64_t sigma0_ns = 7200 * S;         // source STC at the first send
    int64_t wrap_at_ns = -1;              // >= 0: sigma0 so the PCR base wraps this far in
    std::string pids = "v,a1,a2";
    Schedule ppb{{{0, 0}}};               // the source clock's rate error (ppm * 1000; < 0: slow)
    Schedule pcr_ns{{{0, 100 * MS}}};     // PCR interval
    Schedule delay_ns{{{0, 20 * MS}}};    // the path's floor delay
    int64_t jitter_mean_ns = 5 * MS;      // exponential above the floor, cut at 10 x the mean
    std::vector<Jump> jumps;
    std::vector<Outage> outages;
    std::vector<Late> late;
};

// H.264 IPBB carrying the PCR, MPEG-1 audio, AAC, a teletext-like private stream.
struct Es {
    const char* name;
    int pid, stream_type;
    mrts::StreamClass cls;
    int64_t period_90k, lead_90k;         // PES spacing in decode order; DTS - send time
    bool ipbb;
};
inline const Es* es_table(size_t* n) {
    static const Es t[] = {
        {"v", 0x100, 0x1B, mrts::StreamClass::video, 3600, 54000, true},
        {"a1", 0x101, 0x03, mrts::StreamClass::audio, 2160, 36000, false},
        {"a2", 0x102, 0x0F, mrts::StreamClass::audio, 1920, 40500, false},
        {"t", 0x103, 0x06, mrts::StreamClass::other, 3600, 54000, false},
    };
    *n = sizeof t / sizeof t[0];
    return t;
}
inline const Es* es_by_name(const std::string& name) {
    size_t n;
    const Es* t = es_table(&n);
    for (size_t i = 0; i < n; i++)
        if (name == t[i].name) return &t[i];
    return nullptr;
}

struct Lcg {
    uint64_t s;
    explicit Lcg(uint64_t seed) : s(seed * 0x9E3779B97F4A7C15ULL + 1) {}
    uint32_t next() {
        s = s * 6364136223846793005ULL + 1442695040888963407ULL;
        return (uint32_t)(s >> 32);
    }
};

// -ln((v + 1) / 2^32) in Q24 from a bit-wise log2, as ts_stc_test's: no libm.
inline int64_t neg_ln_q24(uint32_t v) {
    const uint64_t x = (uint64_t)v + 1;
    int k = 0;
    while ((x >> (k + 1)) != 0) k++;
    uint64_t m = k <= 31 ? x << (31 - k) : x >> (k - 31);
    int64_t frac = 0;
    for (int i = 0; i < 24; i++) {
        m = (m * m) >> 31;
        frac <<= 1;
        if (m >= (1ULL << 32)) {
            m >>= 1;
            frac |= 1;
        }
    }
    return (((32LL << 24) - (((int64_t)k << 24) + frac)) * 744261118LL) >> 30;
}

inline int64_t at_ppb(int64_t x, int64_t ppb) {   // x >= 0
    const int64_t q = x / S;
    return q * ppb + (x - q * S) * ppb / S;
}

// "V[,V@T...]": V scaled by `unit` from 0, then each V from T seconds. Decimals are
// read exactly to the unit (ms -> ns: 6 places); false on anything else.
inline bool parse_decimal(const std::string& s, int64_t unit, int64_t* out) {
    size_t i = 0;
    bool neg = false;
    if (i < s.size() && (s[i] == '-' || s[i] == '+')) neg = s[i++] == '-';
    if (i >= s.size()) return false;
    int64_t whole = 0, frac = 0, scale = unit;
    bool digits = false;
    for (; i < s.size() && s[i] >= '0' && s[i] <= '9'; i++, digits = true) {
        if (whole > (INT64_MAX / 10) / unit) return false;
        whole = whole * 10 + (s[i] - '0');
    }
    if (i < s.size() && s[i] == '.') {
        for (i++; i < s.size() && s[i] >= '0' && s[i] <= '9'; i++, digits = true) {
            if (scale % 10 != 0) return false;   // finer than the unit
            scale /= 10;
            frac += (s[i] - '0') * scale;
        }
    }
    if (!digits || i != s.size()) return false;
    *out = (neg ? -1 : 1) * (whole * unit + frac);
    return true;
}

inline bool parse_schedule(const std::string& s, int64_t unit, Schedule* out) {
    Schedule r;
    size_t at = 0;
    while (at <= s.size()) {
        const size_t comma = std::min(s.find(',', at), s.size());
        const std::string item = s.substr(at, comma - at);
        const size_t amp = item.find('@');
        int64_t v, from = 0;
        if (!parse_decimal(item.substr(0, amp), unit, &v)) return false;
        if (r.steps.empty() ? amp != std::string::npos
                            : amp == std::string::npos || !parse_decimal(item.substr(amp + 1), S, &from) ||
                                  from <= r.steps.back().first)
            return false;
        r.steps.push_back({from, v});
        at = comma + 1;
    }
    *out = r;
    return true;
}

// The trace a RestampCore would record from this source: the PMT's table at the first
// send, then every PCR and PES header in send order, an OUTAGE record where arrivals
// fall silent for RestampCore::OUTAGE_NS.
inline std::vector<mrts::TraceRecord> generate(const Config& c) {
    using mrts::TraceKind;
    using mrts::TraceRecord;
    size_t n_table;
    const Es* table = es_table(&n_table);
    std::vector<const Es*> es;
    for (size_t at = 0; at <= c.pids.size();) {
        const size_t comma = std::min(c.pids.find(',', at), c.pids.size());
        const Es* e = es_by_name(c.pids.substr(at, comma - at));
        if (e && std::find(es.begin(), es.end(), e) == es.end()) es.push_back(e);
        at = comma + 1;
    }
    const bool video = std::any_of(es.begin(), es.end(), [](const Es* e) { return e->pid == PCR_PID; });
    const mrts::StreamClass pcr_cls = video ? mrts::StreamClass::video : mrts::StreamClass::other;
    // The source timeline in 90 kHz ticks: PCR and PES share it, jumps included.
    const int64_t sigma0 = c.wrap_at_ns >= 0 ? (1LL << 33) - mrts::ns_to_pts90k(c.wrap_at_ns)
                                             : mrts::ns_to_pts90k(c.sigma0_ns);
    auto jump90 = [&](int64_t t) {
        int64_t j = 0;
        for (const Jump& x : c.jumps)
            if (t >= x.at_ns) j += mrts::ns_to_pts90k(x.delta_ns);
        return j;
    };
    auto sent = [&](int64_t t) {
        for (const Outage& o : c.outages)
            if (t >= o.at_ns && t < o.at_ns + o.len_ns) return false;
        return true;
    };
    // House time of a send: the source's elapsed time at its rate error, piecewise.
    auto house = [&](int64_t t) {
        int64_t h = c.house0_ns, from = 0;
        for (size_t i = 0; i < c.ppb.steps.size(); i++) {
            const int64_t to = i + 1 < c.ppb.steps.size() ? std::min(t, c.ppb.steps[i + 1].first) : t;
            if (to > from) h += (to - from) - at_ppb(to - from, c.ppb.steps[i].second);
            from = std::max(from, to);
        }
        return h + (t > from ? t - from : 0);
    };

    struct Ev {
        int64_t send;
        int order;                        // in one send: the table, the PCR, then PES by PID
        TraceRecord r;
    };
    std::vector<Ev> ev;
    {
        Ev t{0, -2, TraceRecord()};
        t.r.kind = TraceKind::psi;
        t.r.pid = PCR_PID;
        t.r.value = mrts::trace_psi_value(PROGRAM, 0, true);
        ev.push_back(t);
        for (const Es* e : es) {
            t.order = -1;
            t.r.pid = (uint16_t)e->pid;
            t.r.value = mrts::trace_psi_value(PROGRAM, e->stream_type, false);
            t.r.flags = mrts::trace_flags(false, e->cls);
            ev.push_back(t);
        }
    }
    bool flag_next = false;
    size_t next_jump = 0;
    std::vector<Jump> jumps = c.jumps;
    std::stable_sort(jumps.begin(), jumps.end(), [](const Jump& a, const Jump& b) { return a.at_ns < b.at_ns; });
    for (int64_t t = 0; t < c.duration_ns;) {
        while (next_jump < jumps.size() && jumps[next_jump].at_ns <= t) flag_next |= jumps[next_jump++].flagged;
        if (sent(t)) {
            Ev p{t, 0, TraceRecord()};
            p.r.kind = TraceKind::pcr;
            p.r.pid = PCR_PID;
            const int64_t base = sigma0 + jump90(t);
            p.r.value = (uint64_t)(((base * 300 + mrts::ns_to_pcr27(t)) % mrts::PCR_MODULO + mrts::PCR_MODULO) %
                                   mrts::PCR_MODULO);
            p.r.flags = mrts::trace_flags(flag_next, pcr_cls);
            flag_next = false;
            ev.push_back(p);
        }
        t += std::max<int64_t>(c.pcr_ns.at(t), MS);
    }
    for (const Es* e : es) {
        for (int64_t k = 0;; k++) {
            const int64_t slot90 = k * e->period_90k;
            const int64_t slot = mrts::pts90k_to_ns(slot90);
            if (slot >= c.duration_ns) break;
            int64_t send = slot;
            for (const Late& l : c.late)
                if (l.pid == e->pid && slot >= l.from_ns && slot < l.to_ns) send += l.by_ns;
            if (send >= c.duration_ns || !sent(send)) continue;
            // IPBB: a P frame shows 3 slots on, a B frame at once; I and P carry a DTS.
            int64_t reorder = 0;
            if (e->ipbb) {
                const int64_t disp = k == 0 ? 0 : (k - 1) % 3 == 0 ? k + 2 : k - 1;
                reorder = (disp - k + 1) * e->period_90k;
            }
            const int64_t dts = sigma0 + jump90(slot) + slot90 + e->lead_90k;
            Ev p{send, 1 + (int)(e - table), TraceRecord()};
            p.r.kind = TraceKind::pes;
            p.r.pid = (uint16_t)e->pid;
            p.r.value = (uint64_t)(((dts + reorder) % mrts::PTS_WRAP + mrts::PTS_WRAP) % mrts::PTS_WRAP);
            p.r.dts_minus_pts_90k = reorder > 0 ? (int32_t)mrts::fold33(-reorder) : 0;
            p.r.flags = mrts::trace_flags(false, e->cls);
            ev.push_back(p);
        }
    }
    std::stable_sort(ev.begin(), ev.end(), [](const Ev& a, const Ev& b) {
        return a.send != b.send ? a.send < b.send : a.order < b.order;
    });

    // Arrivals: one delay per send (one datagram), never before the previous (FIFO).
    Lcg g(c.seed);
    std::vector<TraceRecord> out;
    out.reserve(ev.size() + 8);
    int64_t last = 0, last_send = -1, arrival = 0;
    bool any = false;
    for (const Ev& e : ev) {
        if (e.send != last_send || !any) {
            const int64_t jitter =
                std::min<int64_t>(10 * c.jitter_mean_ns, (c.jitter_mean_ns * neg_ln_q24(g.next())) >> 24);
            arrival = house(e.send) + c.delay_ns.at(e.send) + jitter;
            if (any && arrival < last) arrival = last;
            if (any && arrival - last >= mrts::RestampCore::OUTAGE_NS) {
                TraceRecord o;
                o.kind = TraceKind::outage;
                o.pid = mrts::PID_NULL;
                o.value = (uint64_t)(arrival - last);
                o.arrival_ns = arrival;
                out.push_back(o);
            }
            last = arrival;
            last_send = e.send;
            any = true;
        }
        TraceRecord r = e.r;
        r.arrival_ns = arrival;
        out.push_back(r);
    }
    return out;
}

}  // namespace trace_gen
