// What mrts::RestampCore makes of a buffer sequence, for gst_mrtsrestamp_element_test.py and
// gst_ingest_restamp_test.py: the element, and the bus behind it in either runner, must carry
// the same bytes, gaps, events and stats (WI-P1-4). No GStreamer; built by `make -C mrtshouse
// test`, never installed.
//   restamp_ref in.bin [--fixed] [--base-time NS] [--stats-ms N]
// in.bin, little-endian records: 'B' i64 arrival u32 len bytes (a buffer); 'O' i64 ns
// (set_offset before the next buffer); 'T' u32 n, n x (i32 pid, i64 ns) (set_trims); 'C' i64 ns
// (set_step_fall_hold, as smoothing-cooldown-ns); 'F' (flush); 'R' u32 len path (record the trace
// from here, as trace-location); 'E' (EOS: the last stats, the trace closed). Trust (WI-P5-8),
// applied at the next buffer on its arrival as the element applies them: 'H' i64 e_ns u32 seq u8
// flags (1 known, 2 disciplined) i64 error_us (-1 unknown) (house-clock); 'L' i64 ns
// (transport-latency-ms); 'U' i64 ns (trust-tolerance-ms); 'M' u8 trust (timing-mode). One JSON line
// per buffer and at EOS: the bytes out, the gaps, the events, and the stats when the element's
// cadence posts them.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "mrts/ts_hcdesc.h"
#include "mrts/ts_house.h"
#include "mrts/ts_restamp.h"

using namespace mrts;

namespace {

bool get(std::FILE* f, void* p, size_t n) { return std::fread(p, 1, n, f) == n; }

template <class T>
bool get_le(std::FILE* f, T* v) {
    uint8_t b[sizeof(T)];
    if (!get(f, b, sizeof b)) return false;
    uint64_t u = 0;
    for (size_t i = sizeof b; i-- > 0;) u = (u << 8) | b[i];
    *v = (T)u;
    return true;
}

const char* state_name(VirtualStc::State s) {
    switch (s) {
        case VirtualStc::State::locked: return "locked";
        case VirtualStc::State::degraded: return "degraded";
        case VirtualStc::State::lost: return "lost";
        default: return "acquiring";
    }
}

// A JSON object field by field, the keys as the element's message fields.
class Obj {
  public:
    Obj() { std::printf("{"); }
    void i(const char* k, int64_t v) { key(k); std::printf("%lld", (long long)v); }
    void u(const char* k, uint64_t v) { key(k); std::printf("%llu", (unsigned long long)v); }
    void b(const char* k, bool v) { key(k); std::printf("%s", v ? "true" : "false"); }
    void s(const char* k, const char* v) { key(k); std::printf("\"%s\"", v ? v : ""); }
    void key(const char* k) {
        std::printf("%s\"%s\":", first_ ? "" : ",", k);
        first_ = false;
    }
    void end() { std::printf("}"); }

  private:
    bool first_ = true;
};

void print_events(Obj& line, RestampCore& rc) {
    line.key("events");
    std::printf("[");
    const std::vector<RestampCore::Event> ev = rc.take_events();
    for (size_t n = 0; n < ev.size(); n++) {
        const RestampCore::Event& e = ev[n];
        if (n) std::printf(",");
        Obj o;
        o.s("kind", event_name(e));
        o.i("program", e.program);
        o.i("pid", e.pid);
        o.s("reason", e.reason);
        o.i("gap-ns", e.gap_ns);
        o.i("dropped-ns", e.dropped_ns);
        o.i("house-ns", e.house_ns);
        o.u("epoch", e.epoch);
        o.i("value-ns", e.value_ns);
        if (e.kind >= RestampCore::Event::Kind::trust_switch && e.kind != RestampCore::Event::Kind::sender_reepoch) {
            o.s("state", e.state);
            o.s("from", e.from);
            o.s("failed", e.failed);
            if (!std::strcmp(e.state, "converging")) o.i("converging-ns", e.value_ns);
        }
        o.end();
    }
    std::printf("]");
}

void print_stats(Obj& line, RestampCore& rc) {
    const RestampCore::Stats s = rc.stats();
    line.key("stats");
    Obj st;
    st.key("programs");
    std::printf("[");
    for (size_t n = 0; n < s.programs.size(); n++) {
        const RestampCore::ProgramStats& p = s.programs[n];
        const VirtualStc::Stats& c = p.clock;
        if (n) std::printf(",");
        Obj o;
        o.i("program", p.program);
        o.s("state", state_name(c.state));
        o.s("reason", reason_name(c.reason));
        o.i("ppb", c.ppb);
        o.i("offset-drift-ns", c.offset_drift_ns);
        o.i("residual-min-ns", c.residual.min_ns);
        o.i("residual-p50-ns", c.residual.p50_ns);
        o.i("residual-p99-ns", c.residual.p99_ns);
        o.i("residual-max-ns", c.residual.max_ns);
        o.u("residual-count", c.residual.count);
        o.i("pcr-interval-max-ns", c.pcr_interval_max_ns);
        o.b("cadence-warning", c.cadence_warning);
        o.b("rate-warning", c.rate_warning);
        o.i("pcr-cadence-ns", c.pcr_cadence_ns);
        o.i("pcr-gap-max-ns", c.pcr_gap_max_ns);
        o.u("relocks", c.relocks);
        o.u("epoch", c.epoch);
        o.u("gaps", p.gaps);
        o.i("gap-ns-total", p.gap_ns_total);
        o.u("dropped-pes", p.dropped_pes);
        o.i("dropped-ns-total", p.dropped_ns_total);
        o.u("cc-lost", s.cc_lost);
        o.u("desync-bytes", s.desync_bytes);
        o.end();
    }
    std::printf("]");
    st.key("trust");
    std::printf("[");
    bool any = false;
    for (const RestampCore::ProgramStats& p : s.programs) {
        if (!p.has_trust) continue;
        const TrustGate::Stats& t = p.trust;
        if (any) std::printf(",");
        any = true;
        Obj o;
        o.i("program", p.program);
        o.s("selected", t.trust_selected ? "trust" : "restamp");
        o.s("effective", trust_state_name(t.state));
        o.b("qualifies", !t.failed);
        o.s("failed", t.failed);
        o.u("switches", t.switches);
        if (t.have_transit) {
            o.i("transit-min-ns", t.transit_min_ns);
            o.i("transit-median-ns", t.transit_median_ns);
            o.i("transit-max-ns", t.transit_max_ns);
        }
        o.i("bound-lo-ns", t.bound_lo_ns);
        o.i("bound-ns", t.bound_hi_ns);
        o.i("l-ns", t.l_ns);
        o.i("tau-ns", t.tau_ns);
        o.i("converging-remaining-ns", t.k_left_ns);
        o.b("decl-present", t.have_decl);
        if (t.have_decl) {
            const HouseTimeDecl& d = t.decl;
            o.b("decl-tai", d.house_time_tai);
            o.b("decl-disciplined", d.disciplined);
            o.b("decl-traceable", d.traceable);
            o.s("decl-source", decl_source_name(d.sync_source));
            o.i("decl-tai-offset-s", d.tai_utc_offset_s);
            o.i("decl-ptp-domain", d.ptp_valid ? d.ptp_domain : -1);
            o.s("decl-gm", d.ptp_valid ? hcdesc::gm_text(d.gm_identity).c_str() : "");
            o.u("decl-error-class", d.clock_error_class);
            o.u("decl-epoch-seq", d.epoch_seq);
            o.i("decl-d-e-ns", pts90k_to_ns(d.d_e_90k));
            o.s("decl-timeline-id", hcdesc::timeline_text(d.timeline_id).c_str());
        }
        o.end();
    }
    std::printf("]");
    st.key("pids");
    std::printf("[");
    for (size_t n = 0; n < s.pids.size(); n++) {
        const RestampCore::PidStats& q = s.pids[n];
        if (n) std::printf(",");
        Obj o;
        o.i("program", q.program);
        o.i("pid", q.pid);
        o.i("stream-type", q.stream_type);
        o.u("lead-count", q.lead_count);
        o.i("trim-ns", q.trim_ns);
        o.i("shift-ns", q.shift_ns);
        o.u("dropped-pes", q.dropped_pes);
        if (q.lead_count) {
            o.i("lead-min-ns", q.lead_min_ns);
            o.i("lead-median-ns", q.lead_median_ns);
            o.i("lead-max-ns", q.lead_max_ns);
        }
        o.end();
    }
    std::printf("]");
    st.key("counters");
    Obj k;
    k.u("desync-bytes", s.desync_bytes);
    k.u("cc-lost", s.cc_lost);
    k.u("header-spans", s.header_spans);
    k.u("psi-unsupported-sections", s.psi_unsupported_sections);
    k.u("pes-no-pts", s.pes_no_pts);
    k.u("dts-discarded", s.dts_discarded);
    k.u("unmapped-pes", s.unmapped_pes);
    k.u("broken-spans", s.broken_spans);
    k.u("unknown-pid-packets", s.unknown_pid_packets);
    k.u("removed-packets", s.removed_packets);
    k.u("pcr-kept-packets", s.pcr_kept_packets);
    k.end();
    st.end();
}

void print_buffer(Obj& line, const RestampCore::Result& r) {
    line.key("out");
    std::printf("\"");
    for (const RestampCore::Range& k : r.keep)
        for (size_t i = 0; i < k.len; i++) std::printf("%02x", k.data[i]);
    std::printf("\"");
    line.b("in_place", r.in_place);
    line.key("gaps");
    std::printf("[");
    for (size_t n = 0; n < r.gaps.size(); n++) {
        const RestampCore::Gap& g = r.gaps[n];
        if (n) std::printf(",");
        Obj o;
        o.i("program", g.program);
        o.i("pid", g.pid);
        o.i("start", g.start_ns);
        o.i("end", g.end_ns);
        o.u("at", g.at);
        o.u("cc", g.cc);
        o.s("reason", g.reason);
        o.end();
    }
    std::printf("]");
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr,
                     "usage: restamp_ref in.bin [--fixed] [--base-time NS] [--stats-ms N]\n");
        return 2;
    }
    RestampConfig cfg;
    int64_t stats_ns = 2000000000;
    for (int i = 2; i < argc; i++) {
        const std::string a = argv[i];
        if (a == "--fixed") {
            cfg.mode = RestampConfig::Mode::fixed;
        } else if (a == "--base-time" && i + 1 < argc) {
            cfg.add_base_time = true;
            cfg.base_time_ns = std::strtoll(argv[++i], nullptr, 10);
        } else if (a == "--stats-ms" && i + 1 < argc) {
            stats_ns = std::strtoll(argv[++i], nullptr, 10) * 1000000;
        } else {
            std::fprintf(stderr, "unknown argument %s\n", argv[i]);
            return 2;
        }
    }
    std::FILE* f = std::fopen(argv[1], "rb");
    if (!f) {
        std::perror(argv[1]);
        return 1;
    }
    RestampCore rc(cfg);
    TraceWriter tw;
    auto close_trace = [&]() {
        if (!tw.is_open()) return true;
        rc.set_trace(nullptr);
        return tw.close();
    };
    // The element's cadence: the first buffer starts it, then a post every stats_ns.
    bool have_stats_at = false;
    int64_t stats_at = 0;
    std::vector<uint8_t> buf;
    // Trust's settings wait for the next buffer, as the element takes them: clock, L, tau, mode.
    bool have_clock = false, have_l = false, have_tau = false, have_mode = false;
    ClockDecl clock;
    int64_t l_ns = 0, tau_ns = 0;
    bool trust = false;
    int kind;
    while ((kind = std::fgetc(f)) != EOF) {
        if (kind == 'H') {
            int64_t e = 0, err = 0;
            uint32_t seq = 0;
            uint8_t flags = 0;
            if (!get_le(f, &e) || !get_le(f, &seq) || !get_le(f, &flags) || !get_le(f, &err)) return 1;
            clock = ClockDecl();
            clock.e_ns = e;
            clock.seq = seq;
            clock.known = flags & 1;
            clock.disciplined = flags & 2;
            if (err >= 0) clock.error_us = err;
            have_clock = true;
        } else if (kind == 'L') {
            if (!get_le(f, &l_ns)) return 1;
            have_l = true;
        } else if (kind == 'U') {
            if (!get_le(f, &tau_ns)) return 1;
            have_tau = true;
        } else if (kind == 'M') {
            uint8_t m = 0;
            if (!get_le(f, &m)) return 1;
            trust = m != 0;
            have_mode = true;
        } else if (kind == 'O') {
            int64_t ns = 0;
            if (!get_le(f, &ns)) return 1;
            rc.set_offset(ns);
        } else if (kind == 'T') {
            uint32_t n = 0;
            if (!get_le(f, &n)) return 1;
            std::map<int, int64_t> trims;
            for (uint32_t i = 0; i < n; i++) {
                int32_t pid = 0;
                int64_t ns = 0;
                if (!get_le(f, &pid) || !get_le(f, &ns)) return 1;
                trims[pid] = ns;
            }
            rc.set_trims(trims);
        } else if (kind == 'C') {
            int64_t ns = 0;
            if (!get_le(f, &ns)) return 1;
            rc.set_step_fall_hold(ns);
        } else if (kind == 'F') {
            rc.flush();
        } else if (kind == 'R') {
            uint32_t n = 0;
            if (!get_le(f, &n)) return 1;
            std::string path(n, '\0');
            if (n && !get(f, &path[0], n)) return 1;
            if (!close_trace() || !tw.open(path)) return 1;
            rc.set_trace(&tw);
        } else if (kind == 'E') {
            Obj line;
            line.b("eos", true);
            print_events(line, rc);
            print_stats(line, rc);
            line.end();
            std::printf("\n");
            if (!close_trace()) return 1;
        } else if (kind == 'B') {
            int64_t arrival = 0;
            uint32_t len = 0;
            if (!get_le(f, &arrival) || !get_le(f, &len)) return 1;
            buf.resize(len);
            if (len && !get(f, buf.data(), len)) return 1;
            if (have_clock) rc.set_house_clock(clock, arrival);
            if (have_l) rc.set_transport_latency(l_ns);
            if (have_tau) rc.set_trust_tolerance(tau_ns);
            if (have_mode) rc.set_timing_mode(trust ? TimingMode::trust : TimingMode::restamp, arrival);
            have_clock = have_l = have_tau = have_mode = false;
            const RestampCore::Result r = rc.process(buf.data(), buf.size(), arrival);
            Obj line;
            print_buffer(line, r);
            print_events(line, rc);
            if (!have_stats_at) {
                have_stats_at = true;
                stats_at = arrival;
            }
            if (arrival - stats_at >= stats_ns) {
                print_stats(line, rc);
                stats_at = arrival;
            }
            line.end();
            std::printf("\n");
        } else {
            std::fprintf(stderr, "bad record kind %d\n", kind);
            return 1;
        }
    }
    std::fclose(f);
    return close_trace() ? 0 : 1;
}
