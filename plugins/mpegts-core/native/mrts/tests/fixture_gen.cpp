// fixture_gen: the deterministic generator of the synthetic fixtures (plan ch. 3 part 7, ch. 5
// part 7.2). --trace writes an arrival trace (.stct, WI-P1-2) from trace_gen.h; --ts a .ts
// fixture from ts_gen.h (WI-S0-9); --drop removes packets from a capture (cap-cc-loss);
// --shift stamps PIDs of a recorded trace further ahead (B-48's window fixtures).
#include <cstdio>
#include <cstdlib>
#include <map>
#include <string>
#include <vector>

#include "../ts_house.h"
#include "../ts_trace.h"
#include "trace_gen.h"
#include "ts_gen.h"

namespace {

const char kUsage[] =
    "usage: fixture_gen --ts KIND -o OUT.ts\n"
    "  KIND: parity (py/native_parity_fixture.py's bytes), mpts-two-programs, wrap-33bit\n"
    "  [--wrap-at S], pes-header-split, pes-no-pts, source-restart [--restart S]\n"
    "       fixture_gen --drop PID@N[,PID@N...] -i IN.ts -o OUT.ts\n"
    "  removes the N-th packet (from 0) of each PID named; PIDs decimal or 0x\n"
    "       fixture_gen --shift PID:MS[,PID:MS...] -i IN.stct -o OUT.stct\n"
    "  copies an arrival trace, the PES of each PID named stamped MS later (ahead of\n"
    "  the rest, mod 2^33); PIDs decimal or 0x\n"
    "       fixture_gen --trace -o OUT.stct [options]\n"
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
    "  --backlog S:MS:MS     what is sent from S queues for the first MS (nothing arrives),\n"
    "                        then drains: all sent until then arrives over the second MS,\n"
    "                        in order (a caller that queues; S 0: the trace starts on it)\n"
    "  --ahead ES:MS         that ES's PES stamped MS ahead of the others (#820)\n"
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

bool write_file(const std::string& path, const ts_gen::Bytes& b) {
    std::FILE* f = std::fopen(path.c_str(), "wb");
    if (!f) {
        std::perror(path.c_str());
        return false;
    }
    const bool ok = std::fwrite(b.data(), 1, b.size(), f) == b.size();
    return std::fclose(f) == 0 && ok;
}

bool read_file(const std::string& path, ts_gen::Bytes* b) {
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) {
        std::perror(path.c_str());
        return false;
    }
    uint8_t buf[65536];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) b->insert(b->end(), buf, buf + n);
    const bool ok = !std::ferror(f);
    std::fclose(f);
    return ok;
}

// The --ts kinds by name; restart_ns and wrap_ns as given (or the kind's default).
bool ts_kind(const std::string& kind, int64_t wrap_ns, int64_t restart_ns, ts_gen::Bytes* out) {
    if (kind == "parity") *out = ts_gen::parity();
    else if (kind == "mpts-two-programs") *out = ts_gen::mpts_two_programs();
    else if (kind == "wrap-33bit") *out = ts_gen::wrap_33bit(wrap_ns);
    else if (kind == "pes-header-split") *out = ts_gen::pes_header_split();
    else if (kind == "pes-no-pts") *out = ts_gen::pes_no_pts();
    else if (kind == "source-restart") *out = ts_gen::source_restart(restart_ns);
    else return false;
    return true;
}

}  // namespace

int main(int argc, char** argv) {
    trace_gen::Config c;
    bool trace = false;
    std::string out, ts_kind_name, drop_spec, shift_spec, in;
    int64_t restart_ns = 3 * trace_gen::S;
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
        } else if (a == "-i") {
            in = v;
        } else if (a == "--ts") {
            ts_kind_name = v;
        } else if (a == "--drop") {
            drop_spec = v;
        } else if (a == "--shift") {
            shift_spec = v;
        } else if (a == "--restart") {
            ok = seconds(v, &restart_ns) && restart_ns > 0;
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
        } else if (a == "--ahead") {
            const std::vector<std::string> f = split(v, ':');
            const trace_gen::Es* e = f.empty() ? nullptr : trace_gen::es_by_name(f[0]);
            int64_t ns = 0;
            ok = f.size() == 2 && e && millis(f[1], &ns);
            if (ok) c.ahead.push_back({e->pid, ns});
        } else if (a == "--backlog") {
            const std::vector<std::string> f = split(v, ':');
            trace_gen::Backlog b{0, 0, 0};
            ok = f.size() == 3 && seconds(f[0], &b.at_ns) && millis(f[1], &b.len_ns) && millis(f[2], &b.drain_ns) &&
                 b.at_ns >= 0 && b.len_ns > 0 && b.drain_ns >= 0;
            c.backlogs.push_back(b);
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
    if (!ts_kind_name.empty()) {
        if (out.empty()) return usage("-o OUT.ts is required");
        ts_gen::Bytes b;
        const int64_t wrap_ns = c.wrap_at_ns >= 0 ? c.wrap_at_ns : 5 * trace_gen::S;
        if (!ts_kind(ts_kind_name, wrap_ns, restart_ns, &b)) return usage(("unknown --ts kind " + ts_kind_name).c_str());
        return write_file(out, b) ? 0 : 1;
    }
    if (!drop_spec.empty()) {
        if (out.empty() || in.empty()) return usage("--drop needs -i IN.ts and -o OUT.ts");
        std::vector<ts_gen::Drop> d;
        for (const std::string& item : split(drop_spec, ',')) {
            const size_t at = item.find('@');
            const std::string p = item.substr(0, at), n = at == std::string::npos ? "" : item.substr(at + 1);
            char* e1 = nullptr;
            char* e2 = nullptr;
            const long pid = std::strtol(p.c_str(), &e1, 0);
            const long idx = std::strtol(n.c_str(), &e2, 10);
            if (p.empty() || n.empty() || *e1 || *e2 || pid < 0 || pid > 0x1FFF || idx < 0)
                return usage(("bad --drop item " + item).c_str());
            d.push_back({(int)pid, idx});
        }
        ts_gen::Bytes b;
        if (!read_file(in, &b)) return 1;
        size_t removed = 0;
        const ts_gen::Bytes o = ts_gen::drop(b, d, &removed);
        if (removed != d.size()) {
            std::fprintf(stderr, "fixture_gen: %zu of %zu packets to drop found\n", removed, d.size());
            return 1;
        }
        return write_file(out, o) ? 0 : 1;
    }
    if (!shift_spec.empty()) {
        if (out.empty() || in.empty()) return usage("--shift needs -i IN.stct and -o OUT.stct");
        std::map<int, int64_t> by;   // PID -> 90 kHz ticks
        for (const std::string& item : split(shift_spec, ',')) {
            const size_t at = item.find(':');
            const std::string p = item.substr(0, at), ms = at == std::string::npos ? "" : item.substr(at + 1);
            char* e = nullptr;
            const long pid = std::strtol(p.c_str(), &e, 0);
            int64_t ns = 0;
            if (p.empty() || *e || pid < 0 || pid > 0x1FFF || !millis(ms, &ns))
                return usage(("bad --shift item " + item).c_str());
            by[(int)pid] = mrts::ns_to_pts90k(ns);
        }
        mrts::TraceReader r;
        if (!r.open(in)) {
            std::fprintf(stderr, "fixture_gen: %s: no arrival trace\n", in.c_str());
            return 1;
        }
        mrts::TraceWriter w;
        if (!w.open(out)) {
            std::perror(out.c_str());
            return 1;
        }
        mrts::TraceRecord rec;
        size_t moved = 0;
        while (r.next(&rec)) {
            const auto it = by.find(rec.pid);
            if (rec.kind == mrts::TraceKind::pes && it != by.end()) {
                rec.value = (uint64_t)((((int64_t)rec.value + it->second) % mrts::PTS_WRAP + mrts::PTS_WRAP) %
                                       mrts::PTS_WRAP);
                moved++;
            }
            w.write(rec);
        }
        const bool whole = r.status() == mrts::TraceReader::Status::ok ||
                           r.status() == mrts::TraceReader::Status::unclosed;
        const bool wrote = w.close();
        if (!whole || !moved || !wrote) {
            const char* why = !whole ? "the input trace is damaged" : !moved ? "no PES of the PIDs named"
                                                                         : "writing failed";
            std::fprintf(stderr, "fixture_gen: %s: %s\n", in.c_str(), why);
            return 1;
        }
        return 0;
    }
    if (!trace) return usage("one of --ts, --drop, --shift or --trace is required");
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
