// mrts_cli: test harness for the mrts core. Splitter mode writes out_0x<pid>.ts per output
// and JSON events, the contract py/native_parity_ref.py implements (nativeSplitParity.test.ts);
// `dump` prints every PES of the followed program, PSI events and counters as JSON lines.
// Usage: mrts_cli --outputs 0x100,0x140:0x0f[,...] [--chunk 1316]
//                 [--ts-id 1] --out-dir DIR input.ts
//        mrts_cli dump [--chunk 1316] input.ts
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "ts_house.h"
#include "ts_packet.h"
#include "ts_pes.h"
#include "ts_psi.h"
#include "ts_split.h"

using namespace mrts;

namespace {

void emit_videoinfo(int pid, const VideoInfo& v) {
    std::string display = format_video_info(v);
    std::printf("{\"event\":\"videoinfo\",\"pid\":%d,\"codec\":\"%s\"", pid, v.codec);
    if (v.width) std::printf(",\"width\":%d", *v.width);
    if (v.height) std::printf(",\"height\":%d", *v.height);
    if (v.interlaced) std::printf(",\"interlaced\":%s", *v.interlaced ? "true" : "false");
    if (v.fps) std::printf(",\"fps\":%.6g", *v.fps);
    if (v.scrambled) std::printf(",\"scrambled\":true");
    if (!display.empty()) std::printf(",\"display\":\"%s\"", display.c_str());
    std::printf("}\n");
}

void emit_discovered(const std::vector<std::pair<int, int>>& streams, int pcr_pid,
                     const std::vector<std::pair<int, std::vector<uint8_t>>>& es_info) {
    std::printf("{\"event\":\"discovered\",\"streams\":[");
    for (size_t i = 0; i < streams.size(); i++)
        std::printf("%s[%d,%d]", i ? "," : "", streams[i].first, streams[i].second);
    std::printf("],\"pcrPid\":%d,\"esInfo\":[", pcr_pid);
    for (size_t i = 0; i < es_info.size(); i++) {
        std::printf("%s[%d,\"", i ? "," : "", es_info[i].first);
        for (uint8_t b : es_info[i].second) std::printf("%02x", b);
        std::printf("\"]");
    }
    std::printf("]}\n");
}

// zlib's CRC-32, not the PSI one (crc32_mpeg): a payload's crc32 then compares
// directly with `ffprobe -show_data_hash CRC32` and python's zlib.crc32.
uint32_t crc32_zlib(const std::vector<uint8_t>& b) {
    static const std::array<uint32_t, 256> table = [] {
        std::array<uint32_t, 256> t{};
        for (uint32_t i = 0; i < 256; i++) {
            uint32_t c = i;
            for (int k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            t[i] = c;
        }
        return t;
    }();
    uint32_t c = 0xFFFFFFFFu;
    for (uint8_t x : b) c = table[(c ^ x) & 0xFF] ^ (c >> 8);
    return c ^ 0xFFFFFFFFu;
}

void print_hex(const std::vector<uint8_t>& b) {
    for (uint8_t x : b) std::printf("%02x", x);
}

void print_value(const char* key, bool present, int64_t v) {
    if (present)
        std::printf(",\"%s\":%lld", key, (long long)v);
    else
        std::printf(",\"%s\":null", key);
}

// PSI goes to discovery one packet at a time and the PES PIDs follow each PMT change
// at once, so --chunk changes nothing on intact input; on garbage the walker's resync
// can still land elsewhere near a chunk edge (ts_split's rule).
class Dump {
  public:
    void feed(uint8_t* data, size_t len) {
        walker_.feed(data, len, [&](PacketView& v) { packet(v); });
    }

    void finish() {
        pes_.flush(units_);
        print_units();
        uint64_t discarded = dts_discarded_;
        for (const auto& kv : uw_) discarded += kv.second.dts_discarded();
        std::printf("{\"counters\":{\"desyncBytes\":%llu,\"ccLost\":%llu,\"pesOversize\":%llu,"
                    "\"pesDroppedCc\":%llu,\"pesMalformed\":%llu,\"unsupportedSections\":%llu,"
                    "\"dtsDiscarded\":%llu}}\n",
                    (unsigned long long)walker_.desync_bytes(), (unsigned long long)cc_.lost(),
                    (unsigned long long)pes_.oversize(), (unsigned long long)pes_.dropped_cc(),
                    (unsigned long long)pes_.malformed(),
                    (unsigned long long)disc_.unsupported_sections(),
                    (unsigned long long)discarded);
    }

  private:
    void packet(const PacketView& v) {
        const CcTracker::Result cc = cc_.feed(v);
        if (v.pid == PID_PAT || v.pid == disc_.pmt_pid()) psi(v);
        pes_.feed(v, cc, units_);
        print_units();
    }

    void psi(const PacketView& v) {
        std::memcpy(one_[0].b, v.p, PKT);
        disc_.feed(one_);
        if (disc_.pmt_pid() != pmt_pid_ || disc_.program() != program_) {
            pmt_pid_ = disc_.pmt_pid();
            program_ = disc_.program();
            std::printf("{\"psi\":\"pat\",\"program\":%d,\"pmtPid\":%d}\n", program_, pmt_pid_);
        }
        if (disc_.generation() == gen_ || !disc_.pmt()) return;
        gen_ = disc_.generation();
        const Pmt& m = *disc_.pmt();
        std::printf("{\"psi\":\"pmt\",\"program\":%d,\"version\":%d,\"gen\":%d,\"pcrPid\":%d,"
                    "\"programInfo\":\"",
                    m.program_number, m.version, gen_, m.pcr_pid);
        print_hex(m.program_info);
        std::printf("\",\"streams\":[");
        std::set<int> now;
        for (size_t i = 0; i < m.streams.size(); i++) {
            const PmtStream& s = m.streams[i];
            std::printf("%s{\"pid\":%d,\"type\":%d,\"esInfo\":\"", i ? "," : "", s.pid,
                        s.stream_type);
            print_hex(s.es_info);
            std::printf("\"}");
            now.insert(s.pid);
        }
        std::printf("]}\n");
        for (int pid : selected_)
            if (!now.count(pid)) {
                pes_.select(pid, false);
                auto it = uw_.find(pid);
                if (it != uw_.end()) {
                    dts_discarded_ += it->second.dts_discarded();
                    uw_.erase(it);
                }
            }
        for (int pid : now) pes_.select(pid, true);
        selected_ = std::move(now);
    }

    // Each PID unwraps continuously; its first PTS lands nearest the program's
    // latest one, so PIDs that start on either side of a wrap agree.
    void print_units() {
        for (const PesUnit& u : units_) {
            const PesHeader& h = u.hdr;
            int64_t pts_u = 0, dts_u = Unwrapper::NO_DTS;
            if (h.pts >= 0) {
                Unwrapper& w = uw_[u.pid];
                pts_u = w.feed(h.pts, have_ref_ ? ref_ : h.pts);
                dts_u = w.feed_dts(h.dts, pts_u);
                ref_ = pts_u;
                have_ref_ = true;
            }
            std::printf("{\"pid\":%d,\"sid\":%d", u.pid, h.sid);
            print_value("pts", h.pts >= 0, h.pts);
            print_value("dts", h.dts >= 0, h.dts);
            print_value("ptsUnwrapped", h.pts >= 0, pts_u);
            print_value("dtsUnwrapped", dts_u != Unwrapper::NO_DTS, dts_u);
            std::printf(",\"len\":%zu,\"crc32\":\"%08x\",\"discont\":%s,\"seq\":%llu}\n", u.size,
                        crc32_zlib(u.payload), u.discont ? "true" : "false",
                        (unsigned long long)u.seq);
        }
        units_.clear();
    }

    PacketWalker walker_;
    CcTracker cc_;
    PsiDiscovery disc_;
    PesAssembler pes_;                    // keep_payload: the crc32 needs the bytes
    std::vector<TsPacket> one_ = std::vector<TsPacket>(1);
    std::vector<PesUnit> units_;
    std::set<int> selected_;
    std::map<int, Unwrapper> uw_;
    uint64_t dts_discarded_ = 0;          // of PIDs the PMT dropped
    int64_t ref_ = 0;
    bool have_ref_ = false;
    int pmt_pid_ = -1, program_ = -1, gen_ = 0;
};

int dump_main(int argc, char** argv) {
    long chunk = 1316;
    std::string input;
    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];
        if (a == "--chunk" && i + 1 < argc) {
            chunk = std::atol(argv[++i]);
        } else if (a[0] != '-' && input.empty()) {
            input = a;
        } else {
            input.clear();
            break;
        }
    }
    if (input.empty() || chunk <= 0) {
        std::fprintf(stderr, "usage: mrts_cli dump [--chunk N] input.ts\n");
        return 2;
    }
    FILE* f = std::fopen(input.c_str(), "rb");
    if (!f) {
        std::perror("open input");
        return 1;
    }
    std::vector<uint8_t> buf((size_t)chunk);
    Dump dump;
    size_t n;
    while ((n = std::fread(buf.data(), 1, buf.size(), f)) > 0) dump.feed(buf.data(), n);
    const bool failed = std::ferror(f);
    std::fclose(f);
    if (failed) {
        std::perror("read input");
        return 1;
    }
    dump.finish();
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc > 1 && std::strcmp(argv[1], "dump") == 0) return dump_main(argc - 1, argv + 1);
    std::vector<SplitterCore::OutputSpec> outputs;
    long chunk = 1316;
    int ts_id = 1;
    std::string out_dir, input;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--chunk" && i + 1 < argc) {
            chunk = std::atol(argv[++i]);
        } else if (a == "--ts-id" && i + 1 < argc) {
            ts_id = std::atoi(argv[++i]);
        } else if (a == "--out-dir" && i + 1 < argc) {
            out_dir = argv[++i];
        } else if (a == "--outputs" && i + 1 < argc) {
            char* spec = argv[++i];
            for (char* tok = std::strtok(spec, ","); tok; tok = std::strtok(nullptr, ",")) {
                SplitterCore::OutputSpec o;
                char* colon = std::strchr(tok, ':');
                if (colon) {
                    *colon = 0;
                    o.stream_type = (int)std::strtol(colon + 1, nullptr, 0);
                }
                o.pid = (int)std::strtol(tok, nullptr, 0);
                outputs.push_back(o);
            }
        } else if (a[0] != '-') {
            input = a;
        } else {
            std::fprintf(stderr, "unknown arg: %s\n", a.c_str());
            return 2;
        }
    }
    if (outputs.empty() || out_dir.empty() || input.empty() || chunk <= 0) {
        std::fprintf(stderr,
                     "usage: mrts_cli --outputs 0x100[:0x1b],... [--chunk N] "
                     "[--ts-id N] --out-dir DIR input.ts\n"
                     "       mrts_cli dump [--chunk N] input.ts\n");
        return 2;
    }

    FILE* f = std::fopen(input.c_str(), "rb");
    if (!f) {
        std::perror("open input");
        return 1;
    }
    std::fseek(f, 0, SEEK_END);
    long sz = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    std::vector<uint8_t> data((size_t)sz);
    if (sz && std::fread(data.data(), 1, (size_t)sz, f) != (size_t)sz) {
        std::perror("read input");
        return 1;
    }
    std::fclose(f);

    std::vector<std::pair<int, FILE*>> files;
    for (const auto& o : outputs) {
        char path[4096];
        std::snprintf(path, sizeof path, "%s/out_0x%x.ts", out_dir.c_str(), o.pid);
        FILE* of = std::fopen(path, "wb");
        if (!of) {
            std::perror("open output");
            return 1;
        }
        files.push_back({o.pid, of});
    }

    SplitterCallbacks cb;
    cb.on_discovered = emit_discovered;
    cb.on_videoinfo = emit_videoinfo;
    cb.on_desync = [](long long dropped) {
        std::printf("{\"event\":\"desync\",\"dropped\":%lld}\n", dropped);
    };
    SplitterCore core(ts_id, outputs, cb);

    for (long off = 0; off < sz; off += chunk) {
        long n = std::min(chunk, sz - off);
        for (const auto& b : core.feed(data.data() + off, (size_t)n))
            for (auto& [pid, of] : files)
                if (pid == b.pid)
                    std::fwrite(b.data->data(), 1, b.data->size(), of);
    }
    for (auto& [pid, of] : files) std::fclose(of);
    std::printf("{\"event\":\"done\",\"desyncBytes\":%lld}\n", core.desync_bytes());
    return 0;
}
