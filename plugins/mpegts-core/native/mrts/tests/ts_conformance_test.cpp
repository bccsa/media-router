// ts_conformance_test (WI-S0-9): every fixture of plan ch. 3 part 7.2, tests/fixtures/<name>.ts,
// through PacketWalker + CcTracker + PsiDiscovery + PesAssembler + Unwrapper (PesIndex, what
// `mrts_cli dump` prints) at 188, 1316 and 24 576-byte chunks, line by line against
// <name>.expect.jsonl, and <name>.p<N>.expect.jsonl following program N. A synthetic fixture
// must be fixture_gen's bytes, a derived one its source with the named packets removed, so
// neither needs Python to regenerate. MRTS_FIXTURES overrides the fixture directory.
#include <dirent.h>
#include <sys/stat.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <functional>
#include <map>
#include <string>
#include <vector>

#include "../ts_dump.h"
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
    };
    return s;
}

// fixture_gen --drop on a capture: cap-cc-loss is cap-mux-align7-aac-opus with packets cut out
// (each PID's packet index, from 0, in the source): mid-PES on AAC and Opus, an AAC PES start,
// two Opus packets in a row, a PMT packet.
struct Derived {
    const char* name;
    const char* from;
    std::vector<ts_gen::Drop> drops;
};
const std::vector<Derived>& derived() {
    static const std::vector<Derived> d = {
        {"cap-cc-loss", "cap-mux-align7-aac-opus",
         {{0x100, 977}, {0x100, 1501}, {0x108, 512}, {0x108, 700}, {0x108, 701}, {0x20, 50}}},
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
        size_t removed = 0;
        const bool ok = it != ts.end() && src != ts.end() && !d.drops.empty() &&
                        ts_gen::drop(src->second, d.drops, &removed) == it->second && removed == d.drops.size();
        CHECK((std::string(d.name) + ": " + d.from + " with its packets removed").c_str(), ok);
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
