// fixture_gen: the deterministic generator of the synthetic fixtures (plan ch. 3 part 7, ch. 5
// part 7.2). --trace writes an arrival trace (.stct, WI-P1-2) from trace_gen.h; WI-S0-9's .ts
// fixtures (the native_parity_fixture.py port) join here.
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "../ts_house.h"
#include "../ts_trace.h"
#include "trace_gen.h"

namespace {

const char kUsage[] =
    "usage: fixture_gen --trace -o OUT.stct [options]\n"
    "  An arrival trace of one program: the PCR on the video PID, the chosen PES, sent\n"
    "  over a path of floor delay plus exponential jitter, in order.\n"
    "  --seed N              the jitter's seed (1)\n"
    "  --duration S          seconds sent (120)\n"
    "  --pids LIST           of v (H.264 IPBB, PID 0x100, carries the PCR), a1 (MPEG audio\n"
    "                        0x101), a2 (AAC 0x102), t (teletext-like 0x103) (v,a1,a2)\n"
    "  --ppm SCHED           the source clock's rate error; -300 = slow (0)\n"
    "  --pcr-ms SCHED        PCR interval (100)\n"
    "  --delay-ms SCHED      the path's floor delay (20)\n"
    "  --jitter-ms MEAN      jitter mean above the floor, cut at 10x (5)\n"
    "  --jump S:MS[:di]      the source timeline (PCR and PES) jumps by MS at S seconds;\n"
    "                        di: the first PCR after it flagged (repeatable)\n"
    "  --outage S:MS         nothing sent from S for MS, the source clock running on\n"
    "  --late ES:S0:S1:MS    that ES's PES with slots in [S0, S1) sent MS late, stamps kept\n"
    "  --wrap-at S           the PCR's 33-bit base wraps S seconds in\n"
    "  --house0 S            house time of the first send (1000)\n"
    "  --sigma0 S            source time of the first send (7200; --wrap-at replaces it)\n"
    "  SCHED is V[,V@T...]: V from 0, then each V from T seconds.\n";

int usage(const char* why) {
    if (why) std::fprintf(stderr, "fixture_gen: %s\n", why);
    std::fputs(kUsage, stderr);
    return 2;
}

std::vector<std::string> split(const std::string& s, char sep) {
    std::vector<std::string> out;
    size_t at = 0;
    while (true) {
        const size_t k = s.find(sep, at);
        out.push_back(s.substr(at, k == std::string::npos ? std::string::npos : k - at));
        if (k == std::string::npos) return out;
        at = k + 1;
    }
}

bool seconds(const std::string& s, int64_t* ns) { return trace_gen::parse_decimal(s, trace_gen::S, ns); }
bool millis(const std::string& s, int64_t* ns) { return trace_gen::parse_decimal(s, trace_gen::MS, ns); }

}  // namespace

int main(int argc, char** argv) {
    trace_gen::Config c;
    bool trace = false;
    std::string out;
    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];
        if (a == "--trace") {
            trace = true;
            continue;
        }
        if (a == "-h" || a == "--help") return usage(nullptr), 0;
        if (i + 1 >= argc) return usage(("missing value for " + a).c_str());
        const std::string v = argv[++i];
        bool ok = true;
        if (a == "-o") {
            out = v;
        } else if (a == "--seed") {
            char* end = nullptr;
            c.seed = std::strtoull(v.c_str(), &end, 0);
            ok = !v.empty() && *end == 0;
        } else if (a == "--duration") {
            ok = seconds(v, &c.duration_ns) && c.duration_ns > 0;
        } else if (a == "--pids") {
            c.pids = v;
            for (const std::string& p : split(v, ',')) ok &= trace_gen::es_by_name(p) != nullptr;
        } else if (a == "--ppm") {
            ok = trace_gen::parse_schedule(v, 1000, &c.ppb);
        } else if (a == "--pcr-ms") {
            ok = trace_gen::parse_schedule(v, trace_gen::MS, &c.pcr_ns);
            for (const auto& s : c.pcr_ns.steps) ok &= s.second >= trace_gen::MS;
        } else if (a == "--delay-ms") {
            ok = trace_gen::parse_schedule(v, trace_gen::MS, &c.delay_ns);
            for (const auto& s : c.delay_ns.steps) ok &= s.second >= 0;
        } else if (a == "--jitter-ms") {
            ok = millis(v, &c.jitter_mean_ns) && c.jitter_mean_ns >= 0;
        } else if (a == "--jump") {
            const std::vector<std::string> f = split(v, ':');
            trace_gen::Jump j{0, 0, false};
            ok = (f.size() == 2 || (f.size() == 3 && f[2] == "di")) && seconds(f[0], &j.at_ns) &&
                 millis(f[1], &j.delta_ns);
            j.flagged = f.size() == 3;
            c.jumps.push_back(j);
        } else if (a == "--outage") {
            const std::vector<std::string> f = split(v, ':');
            trace_gen::Outage o{0, 0};
            ok = f.size() == 2 && seconds(f[0], &o.at_ns) && millis(f[1], &o.len_ns) && o.len_ns > 0;
            c.outages.push_back(o);
        } else if (a == "--late") {
            const std::vector<std::string> f = split(v, ':');
            trace_gen::Late l{0, 0, 0, 0};
            const trace_gen::Es* e = f.empty() ? nullptr : trace_gen::es_by_name(f[0]);
            ok = f.size() == 4 && e && seconds(f[1], &l.from_ns) && seconds(f[2], &l.to_ns) &&
                 millis(f[3], &l.by_ns) && l.by_ns >= 0;
            if (e) l.pid = e->pid;
            c.late.push_back(l);
        } else if (a == "--wrap-at") {
            ok = seconds(v, &c.wrap_at_ns) && c.wrap_at_ns >= 0;
        } else if (a == "--house0") {
            ok = seconds(v, &c.house0_ns);
        } else if (a == "--sigma0") {
            ok = seconds(v, &c.sigma0_ns);
        } else {
            return usage(("unknown option " + a).c_str());
        }
        if (!ok) return usage(("bad value for " + a + ": " + v).c_str());
    }
    if (!trace) return usage("only --trace output exists yet (the .ts fixtures are WI-S0-9)");
    if (out.empty()) return usage("-o OUT.stct is required");
    const std::vector<mrts::TraceRecord> recs = trace_gen::generate(c);
    mrts::TraceWriter w;
    if (!w.open(out)) {
        std::perror(out.c_str());
        return 1;
    }
    for (const mrts::TraceRecord& r : recs) w.write(r);
    if (!w.close()) {
        std::fprintf(stderr, "fixture_gen: writing %s failed\n", out.c_str());
        return 1;
    }
    return 0;
}
