// mrts_bench: median ns/packet and MB/s of three passes for the WI-S0-11 budget: walk;
// + PSI, PES header index and in-place PTS/DTS/PCR rewrite (the restamp); + CC and copied
// reassembly (the demux). --wrap-at S first moves the stream so the 33-bit wrap is S s in.
// Usage: mrts_bench [--chunk N] [--min-ms M] [--wrap-at S [--write OUT]] input.ts
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#include "../ts_house.h"
#include "../ts_packet.h"
#include "../ts_pcr.h"
#include "../ts_pes.h"
#include "../ts_psi.h"

using namespace mrts;

namespace {

using Bytes = std::vector<uint8_t>;

volatile uint64_t g_sink;                 // keeps every pass's work observable

template <class F>
void feed_chunks(PacketWalker& w, Bytes& b, size_t chunk, F& on_packet) {
    for (size_t off = 0; off < b.size(); off += chunk)
        w.feed(b.data() + off, std::min(chunk, b.size() - off), on_packet);
}

// PAT and PMT packets go to discovery one at a time, as in mrts_cli dump, so no
// chunk boundary decides what is known when. True when the PMT changed.
struct Psi {
    PsiDiscovery disc;
    std::vector<TsPacket> one = std::vector<TsPacket>(1);
    int gen = 0;

    bool feed(const PacketView& v) {
        if (v.pid != PID_PAT && v.pid != disc.pmt_pid()) return false;
        std::memcpy(one[0].b, v.p, PKT);
        disc.feed(one);
        if (disc.generation() == gen) return false;
        gen = disc.generation();
        return true;
    }
};

// Every PES PTS/DTS and PCR moved by `shift` (90 kHz) through the unwrapped
// timeline. Chunks are whole packets, so every v.p is in the buffer itself.
struct Restamp {
    int64_t shift = 0;
    PacketWalker walker;
    Psi psi;
    PesHeaderSpan span;
    std::map<int, uint8_t*> held_at;      // the held packet's place in the buffer
    std::map<int, Unwrapper> uw;
    int64_t pcr_base = -1;                // the last PCR in 90 kHz: the unwrap seed
    uint64_t headers = 0, pcrs = 0;

    void move(int pid, const PesHeader& h, int64_t& pts, int64_t& dts) {
        if (h.pts < 0) return;
        Unwrapper& u = uw[pid];
        const int64_t p = u.feed(h.pts, pcr_base >= 0 ? pcr_base : h.pts);
        const int64_t d = u.feed_dts(h.dts, p);
        pts = p + shift;                  // the writer keeps the low 33 bits
        if (h.dts >= 0) dts = (d != Unwrapper::NO_DTS ? d : h.dts) + shift;
        headers++;
    }

    void packet(PacketView& v) {
        psi.feed(v);
        if (v.af_pcr) {
            const int64_t pcr = read_pcr(v.p);
            pcr_base = pcr / 300;
            write_pcr(v, (pcr + shift * 300) % PCR_MODULO);
            pcrs++;
        }
        auto ts = [&](const PesHeader& h, int64_t& pts, int64_t& dts) { move(v.pid, h, pts, dts); };
        uint8_t first[PKT];
        if (span.complete(v, first, ts)) std::memcpy(held_at[v.pid], first, PKT);
        if (span.hold(v)) {
            held_at[v.pid] = v.p;
            return;
        }
        PesHeader h;
        if (v.pusi && v.payload_off < PKT &&
            parse_pes_header(v.p + v.payload_off, PKT - v.payload_off, &h) && h.complete) {
            int64_t pts = h.pts, dts = h.dts;
            move(v.pid, h, pts, dts);
            rewrite_pes_timestamps(v, h, pts, dts);
        }
    }

    void run(Bytes& b, size_t chunk) {
        auto f = [&](PacketView& v) { packet(v); };
        feed_chunks(walker, b, chunk, f);
        g_sink = g_sink + headers + pcrs;
    }
};

// Every ES PID of the program reassembled with its payload copied, PTS and DTS
// unwrapped, and the --wrap-at check: per PID, the 33-bit wraps the raw PTS
// took and the largest step its unwrapped PTS made.
struct Demux {
    PacketWalker walker;
    Psi psi;
    CcTracker cc;
    PesAssembler pes;
    std::map<int, Unwrapper> uw;
    std::vector<PesUnit> units;
    struct Track {
        int64_t raw = -1, unwrapped = 0;
        uint64_t wraps = 0;
    };
    std::map<int, Track> track;
    int64_t ref = INT64_MIN;              // the program's last unwrapped PTS: a new PID's seed
    uint64_t n = 0, bytes = 0;
    int64_t max_step = 0;

    void take(const PesUnit& u) {
        n++;
        bytes += u.size;
        if (u.hdr.pts < 0) return;
        Unwrapper& w = uw[u.pid];
        const int64_t p = w.feed(u.hdr.pts, ref != INT64_MIN ? ref : u.hdr.pts);
        g_sink = g_sink + (uint64_t)w.feed_dts(u.hdr.dts, p);
        ref = p;
        Track& t = track[u.pid];
        if (t.raw >= 0) {
            t.wraps += u.hdr.pts < t.raw - PTS_WRAP / 2;
            max_step = std::max<int64_t>(max_step, std::llabs(p - t.unwrapped));
        }
        t.raw = u.hdr.pts;
        t.unwrapped = p;
    }

    void packet(const PacketView& v) {
        const CcTracker::Result r = cc.feed(v);
        if (psi.feed(v) && psi.disc.pmt())
            for (const PmtStream& s : psi.disc.pmt()->streams) pes.select(s.pid, true);
        pes.feed(v, r, units);
        for (const PesUnit& u : units) take(u);
        units.clear();
    }

    void run(Bytes& b, size_t chunk) {
        auto f = [&](PacketView& v) { packet(v); };
        feed_chunks(walker, b, chunk, f);
        pes.flush(units);
        for (const PesUnit& u : units) take(u);
        units.clear();
        g_sink = g_sink + bytes;
    }
};

struct Timing {
    double ns_per_packet, mb_per_s;
    size_t repeats;
};

// The median of repeats over a fresh copy each; the copy is not timed.
template <class Pass>
Timing time_pass(const Bytes& pristine, size_t packets, double min_ms, Pass pass) {
    Bytes work(pristine.size());
    std::vector<double> ns;
    double total = 0;
    while (ns.size() < 5 || total < min_ms * 1e6) {
        std::memcpy(work.data(), pristine.data(), pristine.size());
        const auto t0 = std::chrono::steady_clock::now();
        pass(work);
        const auto t1 = std::chrono::steady_clock::now();
        ns.push_back(std::chrono::duration<double, std::nano>(t1 - t0).count());
        total += ns.back();
    }
    std::nth_element(ns.begin(), ns.begin() + ns.size() / 2, ns.end());
    const double med = ns[ns.size() / 2];
    return {med / (double)packets, (double)pristine.size() / med * 1e3, ns.size()};
}

bool read_file(const std::string& path, Bytes& out) {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return false;
    uint8_t buf[65536];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) out.insert(out.end(), buf, buf + n);
    std::fclose(f);
    return true;
}

int usage() {
    std::fprintf(stderr,
                 "usage: mrts_bench [--chunk N] [--min-ms M] [--wrap-at S [--write OUT]] "
                 "input.ts\n  --chunk    feed size in bytes, a multiple of 188 (default 1316)\n"
                 "  --min-ms   time spent per pass at least (default 500)\n"
                 "  --wrap-at  move every PTS/DTS/PCR so the 33-bit wrap lands S s in\n"
                 "  --write    save the moved stream\n");
    return 2;
}

}  // namespace

int main(int argc, char** argv) {
    size_t chunk = 7 * PKT;
    double min_ms = 500, wrap_at = -1;
    std::string input, out;
    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];
        if (a == "--chunk" && i + 1 < argc) {
            chunk = (size_t)std::atol(argv[++i]);
        } else if (a == "--min-ms" && i + 1 < argc) {
            min_ms = std::atof(argv[++i]);
        } else if (a == "--wrap-at" && i + 1 < argc) {
            wrap_at = std::atof(argv[++i]);
        } else if (a == "--write" && i + 1 < argc) {
            out = argv[++i];
        } else if (a[0] != '-' && input.empty()) {
            input = a;
        } else {
            return usage();
        }
    }
    // Rewriting in place needs every packet whole inside one chunk.
    if (input.empty() || chunk == 0 || chunk % PKT != 0 || (!out.empty() && wrap_at < 0))
        return usage();
    Bytes data;
    if (!read_file(input, data)) {
        std::perror(input.c_str());
        return 1;
    }

    size_t packets = 0;
    int64_t first_pts = -1;
    {
        PacketWalker w;
        w.feed(data.data(), data.size(), [&](PacketView& v) {
            packets++;
            if (first_pts < 0) first_pts = read_pes_pts(v.p);
        });
    }
    if (!packets) {
        std::fprintf(stderr, "%s: no TS packets\n", input.c_str());
        return 1;
    }

    if (wrap_at >= 0) {
        if (first_pts < 0) {
            std::fprintf(stderr, "%s: no PES PTS to place the wrap by\n", input.c_str());
            return 1;
        }
        Restamp r;
        r.shift = (PTS_WRAP - std::llround(wrap_at * 90000) - first_pts) % PTS_WRAP;
        if (r.shift < 0) r.shift += PTS_WRAP;
        r.run(data, data.size());
        Bytes rest;
        r.span.flush(rest);               // a header cut by the file's end stays as it was
        std::printf("wrap-at %.3f s: every PTS/DTS/PCR moved by %lld ticks (%llu headers, %llu "
                    "PCRs, %llu split, %llu left unmoved)\n",
                    wrap_at, (long long)r.shift, (unsigned long long)r.headers,
                    (unsigned long long)r.pcrs, (unsigned long long)r.span.spans(),
                    (unsigned long long)r.span.broken());
        if (!out.empty()) {
            FILE* f = std::fopen(out.c_str(), "wb");
            bool ok = f && std::fwrite(data.data(), 1, data.size(), f) == data.size();
            if (f) ok = std::fclose(f) == 0 && ok;
            if (!ok) {
                std::perror(out.c_str());
                return 1;
            }
        }
    }

    const Timing walk = time_pass(data, packets, min_ms, [&](Bytes& b) {
        PacketWalker w;
        uint64_t s = 0;
        auto f = [&](PacketView& v) { s += (uint64_t)v.pid ^ v.cc; };
        feed_chunks(w, b, chunk, f);
        g_sink = g_sink + s;
    });
    const Timing rewrite = time_pass(data, packets, min_ms, [&](Bytes& b) {
        Restamp r;
        r.shift = 90000;                  // one second later, the restamp's kind of move
        r.run(b, chunk);
    });
    const Timing reassemble = time_pass(data, packets, min_ms, [&](Bytes& b) {
        Demux d;
        d.run(b, chunk);
    });

    // One untimed run of each for the counts the timings were taken over.
    Bytes copy = data;
    Restamp r;
    r.shift = 90000;
    r.run(copy, chunk);
    copy = data;
    Demux d;
    d.run(copy, chunk);

    std::printf("mrts_bench %s: %zu bytes, %zu packets, chunk %zu bytes\n", input.c_str(),
                data.size(), packets, chunk);
    std::printf("%-11s %10s %10s %8s\n", "pass", "ns/packet", "MB/s", "repeats");
    std::printf("%-11s %10.1f %10.1f %8zu\n", "walk", walk.ns_per_packet, walk.mb_per_s,
                walk.repeats);
    std::printf("%-11s %10.1f %10.1f %8zu  %llu PES headers (%llu split), %llu PCRs\n", "rewrite",
                rewrite.ns_per_packet, rewrite.mb_per_s, rewrite.repeats,
                (unsigned long long)r.headers, (unsigned long long)r.span.spans(),
                (unsigned long long)r.pcrs);
    std::printf("%-11s %10.1f %10.1f %8zu  %llu PES, %llu payload bytes, %llu malformed\n",
                "reassemble", reassemble.ns_per_packet, reassemble.mb_per_s, reassemble.repeats,
                (unsigned long long)d.n, (unsigned long long)d.bytes,
                (unsigned long long)d.pes.malformed());
    if (wrap_at >= 0) {
        size_t crossed = 0;
        for (const auto& kv : d.track) crossed += kv.second.wraps > 0;
        std::printf("wrap: crossed by %zu of %zu PIDs; largest unwrapped PTS step %.1f ms\n",
                    crossed, d.track.size(), (double)d.max_step / 90.0);
    }
    return 0;
}
