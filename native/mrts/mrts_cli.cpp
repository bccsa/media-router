// mrts_cli — test/parity harness for the mrts packet core.
//
// Feeds a TS file through SplitterCore in fixed-size chunks, writes each
// output PID's joined SPTS to <out-dir>/out_0x<pid>.ts, and emits discovery /
// video-info / desync events as JSON lines on stdout. The Python reference
// runner (packages/engine/src/child-process/native_parity_ref.py) implements
// the identical interface over ts_split.py; the golden parity vitest compares
// the two byte-for-byte.
//
// Usage: mrts_cli --outputs 0x100,0x140:0x0f[,...] [--chunk 1316]
//                 [--ts-id 1] --out-dir DIR input.ts
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

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

}  // namespace

int main(int argc, char** argv) {
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
                     "[--ts-id N] --out-dir DIR input.ts\n");
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
