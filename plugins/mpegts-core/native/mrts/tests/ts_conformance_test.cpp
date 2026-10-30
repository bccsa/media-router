// ts_conformance_test (WI-S0-9): every fixture of plan ch. 3 part 7.2, tests/fixtures/<name>.ts,
// through PacketWalker + CcTracker + PsiDiscovery + PesAssembler + Unwrapper (PesIndex, what
// `mrts_cli dump` prints) at 188, 1316 and 24 576-byte chunks, line by line against
// <name>.expect.jsonl, and <name>.p<N>.expect.jsonl following program N. A synthetic fixture
// must be fixture_gen's bytes (Phase 3's kinds also pinned by CRC-32, WI-P3-3), a derived one
// its source with the named packets removed or re-spaced, so neither needs Python to
// regenerate. A bus sidecar (<name>.bus.jsonl) must tile its .ts and start on its first PES's
// house time (p3-3b). MRTS_FIXTURES overrides the fixture directory.
#include <dirent.h>
#include <sys/stat.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <functional>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include "../demux_core.h"
#include "../ts_dump.h"
#include "../ts_rebase.h"
#include "check.h"
#include "ts_gen.h"

namespace {

using ts_gen::Bytes;

const size_t kChunks[] = {188, 1316, 24576};
constexpr size_t kMaxFixtureBytes = 2000000;   // OQ-2: <= 2 MB each

// fixture_gen --ts KIND for each synthetic fixture.
struct Synthetic {
    const char* name;
    std::function<Bytes()> gen;
};
const std::vector<Synthetic>& synthetic() {
    static const std::vector<Synthetic> s = {
        {"syn-mpts-two-programs", [] { return ts_gen::mpts_two_programs(); }},
        {"syn-wrap-33bit", [] { return ts_gen::wrap_33bit(); }},
        {"syn-pes-header-split", [] { return ts_gen::pes_header_split(); }},
        {"syn-pes-no-pts", [] { return ts_gen::pes_no_pts(); }},
        {"syn-source-restart", [] { return ts_gen::source_restart(); }},
        {"syn-gap-500ms", [] { return ts_gen::gap_500ms(); }},
        {"syn-gap-marker", [] { return ts_gen::gap_marker(nullptr); }},
        {"syn-video-hole-1s", [] { return ts_gen::video_hole_1s(); }},
        {"syn-private-novdesc", [] { return ts_gen::private_novdesc(); }},
        {"syn-pmt-version-bump", [] { return ts_gen::pmt_version_bump(); }},
        {"syn-adts-mpeg2", [] { return ts_gen::adts_mpeg2(); }},
    };
    return s;
}

// Phase 3's kinds, pinned as B-32 pinned the parity port: size and zlib CRC-32 of the bytes.
struct Pin {
    const char* what;
    std::function<Bytes()> gen;
    size_t size;
    uint32_t crc;
};
const std::vector<Pin>& pins() {
    static const std::vector<Pin> p = {
        {"gap-500ms", [] { return ts_gen::gap_500ms(); }, 534672, 0x2946e974u},
        {"gap-marker", [] { return ts_gen::gap_marker(nullptr); }, 535048, 0xac71bcfcu},
        {"gap-marker's .bus.jsonl", [] {
             std::string bus;
             ts_gen::gap_marker(&bus);
             return Bytes(bus.begin(), bus.end());
         }, 31894, 0xfbd87421u},
        {"video-hole-1s", [] { return ts_gen::video_hole_1s(); }, 683004, 0x2b636cd5u},
        {"private-novdesc", [] { return ts_gen::private_novdesc(); }, 338400, 0x9cfd4076u},
        {"pmt-version-bump", [] { return ts_gen::pmt_version_bump(); }, 562308, 0x69824475u},
        {"adts-mpeg2", [] { return ts_gen::adts_mpeg2(); }, 118628, 0xb5923761u},
    };
    return p;
}

// fixture_gen --drop on a capture: cap-cc-loss is cap-mux-align7-aac-opus with packets cut out
// (each PID's packet index, from 0, in the source): mid-PES on AAC and Opus, an AAC PES start,
// two Opus packets in a row, a PMT packet. fixture_gen --respace 40: syn-foreign-clock-aac is
// the same capture's every timestamp spaced 40 ppm wider about its first PES (WI-P3-3).
struct Derived {
    const char* name;
    const char* from;
    std::function<bool(const Bytes& in, Bytes* out)> edit;
};
const std::vector<Derived>& derived() {
    static const std::vector<Derived> d = {
        {"cap-cc-loss", "cap-mux-align7-aac-opus",
         [](const Bytes& in, Bytes* out) {
             const std::vector<ts_gen::Drop> drops = {{0x100, 977}, {0x100, 1501}, {0x108, 512},
                                                      {0x108, 700}, {0x108, 701}, {0x20, 50}};
             size_t removed = 0;
             *out = ts_gen::drop(in, drops, &removed);
             return removed == drops.size();
         }},
        {"syn-foreign-clock-aac", "cap-mux-align7-aac-opus",
         [](const Bytes& in, Bytes* out) {
             *out = in;
             const int64_t origin = mrts::first_pes_pts(out->data(), out->size());
             return origin >= 0 && mrts::respace_ts(out->data(), out->size(), origin, 40).pcr > 0;
         }},
    };
    return d;
}

std::string dir_of(const char* argv0) {
    if (const char* e = std::getenv("MRTS_FIXTURES")) return e;
    std::string a = argv0;
    const size_t slash = a.rfind('/');
    const std::string here = slash == std::string::npos ? "." : a.substr(0, slash);
    return here + "/../../../tests/fixtures";      // mrts/tests -> mpegts-core/tests/fixtures
}

bool read_file(const std::string& path, Bytes* out) {
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return false;
    uint8_t buf[65536];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) out->insert(out->end(), buf, buf + n);
    const bool ok = !std::ferror(f);
    std::fclose(f);
    return ok;
}

bool read_lines(const std::string& path, std::vector<std::string>* out) {
    std::ifstream f(path);
    if (!f) return false;
    std::string line;
    while (std::getline(f, line))
        if (!line.empty()) out->push_back(line);
    return true;
}

bool ends_with(const std::string& s, const std::string& t) {
    return s.size() >= t.size() && s.compare(s.size() - t.size(), t.size(), t) == 0;
}

std::vector<std::string> list_dir(const std::string& dir) {
    std::vector<std::string> v;
    if (DIR* d = opendir(dir.c_str())) {
        while (dirent* e = readdir(d)) v.push_back(e->d_name);
        closedir(d);
    }
    std::sort(v.begin(), v.end());
    return v;
}

std::vector<std::string> index_of(Bytes data, size_t chunk, int program) {
    std::vector<std::string> lines;
    mrts::PesIndex idx([&](const std::string& l) { lines.push_back(l); }, program);
    for (size_t off = 0; off < data.size(); off += chunk)
        idx.feed(data.data() + off, std::min(chunk, data.size() - off));
    idx.finish();
    return lines;
}

std::string cut(const std::string& s) { return s.size() > 160 ? s.substr(0, 160) + "..." : s; }

// A diff of the two JSONL lists: the first line that differs, or a count mismatch.
std::string first_diff(const std::vector<std::string>& got, const std::vector<std::string>& want) {
    for (size_t i = 0; i < std::min(got.size(), want.size()); i++)
        if (got[i] != want[i])
            return "line " + std::to_string(i + 1) + ":\n    got  " + cut(got[i]) + "\n    want " + cut(want[i]);
    if (got.size() != want.size())
        return std::to_string(got.size()) + " lines, want " + std::to_string(want.size());
    return "";
}

// <name>.expect.jsonl -> (name, -1); <name>.p<N>.expect.jsonl -> (name, N).
bool parse_expect(const std::string& file, std::string* name, int* program) {
    const std::string suffix = ".expect.jsonl";
    if (!ends_with(file, suffix)) return false;
    std::string stem = file.substr(0, file.size() - suffix.size());
    *program = -1;
    const size_t dot = stem.rfind(".p");
    if (dot != std::string::npos && dot + 2 < stem.size() &&
        stem.find_first_not_of("0123456789", dot + 2) == std::string::npos) {
        *program = std::atoi(stem.c_str() + dot + 2);
        stem = stem.substr(0, dot);
    }
    *name = stem;
    return true;
}

// A sidecar's lines (mrts_cli rebase's form) must tile its .ts: offsets from 0, back to back.
bool tiles(const std::string& path, size_t ts_size, size_t* lines) {
    std::vector<std::string> l;
    if (!read_lines(path, &l)) return false;
    unsigned long long off = 0, len = 0, flags = 0, at = 0;
    for (const std::string& s : l) {
        char rest[160];
        if (std::sscanf(s.c_str(), "{\"off\":%llu,\"len\":%llu,\"pts\":%159[^}]}", &off, &len, rest) != 3 ||
            off != at || len == 0 || std::strstr(rest, "\"flags\":") == nullptr ||
            std::sscanf(std::strstr(rest, "\"flags\":"), "\"flags\":%llu", &flags) != 1)
            return false;
        at += len;
    }
    *lines = l.size();
    return at == ts_size;
}

// A sidecar's first stamp in ns, -1 without one.
int64_t first_stamp(const std::string& path) {
    std::vector<std::string> l;
    if (!read_lines(path, &l)) return -1;
    for (const std::string& s : l) {
        const char* p = std::strstr(s.c_str(), "\"pts\":");
        long long v = 0;
        if (p && std::sscanf(p, "\"pts\":%lld", &v) == 1) return v;
    }
    return -1;
}

void test_pins() {
    for (const Pin& p : pins()) {
        const Bytes b = p.gen();
        char got[64];
        std::snprintf(got, sizeof got, "%zu bytes, crc32 %08x", b.size(), mrts::crc32_zlib(b.data(), b.size()));
        CHECK((std::string("pinned: ") + p.what + " is " + got).c_str(),
              b.size() == p.size && mrts::crc32_zlib(b.data(), b.size()) == p.crc);
    }
}

void test_parity_port() {
    // py/native_parity_fixture.py's output, recorded once: the C++ port reproduces it without Python.
    const Bytes p = ts_gen::parity();
    CHECK("parity port: native_parity_fixture.py's 6698476 bytes, zlib crc32 8fedaffa",
          p.size() == 6698476 && mrts::crc32_zlib(p.data(), p.size()) == 0x8fedaffau);
}

}  // namespace

int main(int, char** argv) {
    const std::string dir = dir_of(argv[0]);
    struct stat st;
    if (stat(dir.c_str(), &st) != 0 || !S_ISDIR(st.st_mode)) {
        std::printf("FAIL fixture directory %s not found\n", dir.c_str());
        return 1;
    }
    test_parity_port();
    test_pins();

    const std::vector<std::string> files = list_dir(dir);
    std::map<std::string, Bytes> ts;
    for (const std::string& f : files) {
        if (!ends_with(f, ".ts")) continue;
        Bytes b;
        const bool ok = read_file(dir + "/" + f, &b);
        CHECK((f + ": readable, at most 2 MB (OQ-2)").c_str(), ok && b.size() <= kMaxFixtureBytes);
        ts[f.substr(0, f.size() - 3)] = std::move(b);
    }

    for (const Synthetic& s : synthetic()) {
        const auto it = ts.find(s.name);
        CHECK((std::string(s.name) + ": committed, and fixture_gen's bytes exactly").c_str(),
              it != ts.end() && it->second == s.gen());
    }
    for (const Derived& d : derived()) {
        const auto it = ts.find(d.name);
        const auto src = ts.find(d.from);
        if (it == ts.end() && src == ts.end()) continue;   // neither capture is in this checkout
        Bytes made;
        const bool ok = it != ts.end() && src != ts.end() && d.edit(src->second, &made) && made == it->second;
        CHECK((std::string(d.name) + ": " + d.from + " edited as fixture_gen edits it").c_str(), ok);
    }
    // The generator's sidecar is the committed one; every committed sidecar tiles its .ts.
    std::string bus;
    ts_gen::gap_marker(&bus);
    std::vector<std::string> want;
    std::istringstream lines(bus);
    for (std::string l; std::getline(lines, l);) want.push_back(l);
    std::vector<std::string> got;
    CHECK("syn-gap-marker.bus.jsonl: committed, and fixture_gen's lines exactly",
          read_lines(dir + "/syn-gap-marker.bus.jsonl", &got) && got == want);
    for (const std::string& f : files) {
        if (!ends_with(f, ".bus.jsonl")) continue;
        const auto it = ts.find(f.substr(0, f.size() - 10));
        size_t n = 0;
        CHECK((f + ": its .ts beside it, tiled by its buffers").c_str(),
              it != ts.end() && tiles(dir + "/" + f, it->second.size(), &n) && n > 0);
        // Replays read the stamps and the PES on one clock, the first PES - 1 h: a recording
        // made past the 33-bit wrap (house 25.5 h) is committed rebased, or they part by 26.5 h.
        const int64_t stamp = first_stamp(dir + "/" + f);
        const int64_t house =
            it == ts.end() ? -1 : mrts::first_pes_house_ns(it->second.data(), it->second.size());
        CHECK((f + ": its first stamp within 60 s of its first PES - 1 h").c_str(),
              stamp >= 0 && house >= 0 && std::llabs(stamp - house) <= 60000000000LL);
    }

    std::map<std::string, int> expectations;
    for (const std::string& f : files) {
        std::string name;
        int program;
        if (!parse_expect(f, &name, &program)) continue;
        expectations[name]++;
        const auto it = ts.find(name);
        if (it == ts.end()) {
            CHECK((f + ": its fixture " + name + ".ts exists").c_str(), false);
            continue;
        }
        std::vector<std::string> want;
        if (!read_lines(dir + "/" + f, &want) || want.empty()) {
            CHECK((f + ": readable and not empty").c_str(), false);
            continue;
        }
        for (size_t chunk : kChunks) {
            const std::string d = first_diff(index_of(it->second, chunk, program), want);
            const std::string label = f + " at " + std::to_string(chunk) + "-byte chunks (" +
                                      std::to_string(want.size()) + " lines)";
            CHECK(label.c_str(), d.empty());
            if (!d.empty()) std::printf("  %s\n", d.c_str());
        }
    }
    for (const auto& kv : ts)
        CHECK((kv.first + ".ts: has an .expect.jsonl").c_str(), expectations.count(kv.first) > 0);
    CHECK("fixtures: the synthetic set and at least one field capture are present",
          ts.size() > synthetic().size());
    return test_summary("ts_conformance");
}
