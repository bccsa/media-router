// What mrfanout::HouseRebase makes of a chunk sequence, for py/house_rebase_parity_test.py: the
// Python reference (py/house_rebase.py, run as a script) must print the same lines. No sockets;
// built by `make test`, never run by it, never installed.
//   house_rebase_ref in.bin
// in.bin, little-endian records: 'C' u32 rebase, i64 house ns, u32 len, bytes (a chunk for that
// numbered rebase, a new one at its first). One JSON line per chunk, the bytes out in hex, then
// each rebase's stats in number order.
#include <cstdio>
#include <map>
#include <string>
#include <vector>

#include "../house_rebase.h"

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

}  // namespace

int main(int argc, char** argv) {
    if (argc != 2) {
        std::fprintf(stderr, "usage: house_rebase_ref in.bin\n");
        return 2;
    }
    std::FILE* f = std::fopen(argv[1], "rb");
    if (!f) {
        std::perror(argv[1]);
        return 2;
    }
    std::map<uint32_t, mrfanout::HouseRebase> rebases;
    std::vector<uint8_t> chunk, out;
    std::string line;
    static const char kHex[] = "0123456789abcdef";
    for (int tag; (tag = std::fgetc(f)) != EOF;) {
        uint32_t rebase = 0, len = 0;
        int64_t now = 0;
        if (tag != 'C' || !get_le(f, &rebase) || !get_le(f, &now) || !get_le(f, &len)) {
            std::fprintf(stderr, "bad record at byte %ld\n", std::ftell(f));
            return 1;
        }
        chunk.resize(len);
        if (len && !get(f, chunk.data(), len)) {
            std::fprintf(stderr, "short chunk at byte %ld\n", std::ftell(f));
            return 1;
        }
        rebases[rebase].process(chunk.data(), chunk.size(), now, out);
        line = "{\"rebase\":" + std::to_string(rebase) + ",\"out\":\"";
        for (const uint8_t b : out) {
            line += kHex[b >> 4];
            line += kHex[b & 0x0F];
        }
        line += "\"}\n";
        std::fwrite(line.data(), 1, line.size(), stdout);
    }
    for (const auto& [rebase, r] : rebases) {
        const mrfanout::HouseRebase::Stats s = r.stats();
        std::printf("{\"rebase\":%u,\"stats\":{\"anchored\":%s,\"shift_90k\":%lld,\"reanchors\":%llu,"
                    "\"kept\":%llu,\"dropped\":%llu,\"desync_bytes\":%llu}}\n",
                    rebase, s.anchored ? "true" : "false", (long long)s.shift_90k,
                    (unsigned long long)s.reanchors, (unsigned long long)s.kept,
                    (unsigned long long)s.dropped, (unsigned long long)s.desync_bytes);
    }
    std::fclose(f);
    return 0;
}
