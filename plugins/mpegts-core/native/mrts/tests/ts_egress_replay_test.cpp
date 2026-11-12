// ts_egress replay (WI-P5-2, p5-2b, B-222): every tests/fixtures/egress case through `mrts_cli
// egress` against its hand-reviewed .expect.jsonl and output digest. MRTS_FIXTURES overrides
// tests/fixtures.
#include <dirent.h>
#include <sys/wait.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "check.h"

namespace {

std::string dir_of(const char* argv0) {
    const std::string a = argv0;
    const size_t slash = a.rfind('/');
    return slash == std::string::npos ? std::string(".") : a.substr(0, slash);
}

std::string read_text(const std::string& path) {
    std::string s;
    if (std::FILE* f = std::fopen(path.c_str(), "rb")) {
        char b[65536];
        size_t n;
        while ((n = std::fread(b, 1, sizeof b, f)) > 0) s.append(b, n);
        std::fclose(f);
    }
    return s;
}

// A top-level string field of a clock file ("input", "bus"); "" when absent or null.
std::string field(const std::string& json, const std::string& key) {
    const size_t k = json.find("\"" + key + "\"");
    if (k == std::string::npos) return "";
    const size_t q = json.find_first_not_of(" \t\r\n:", k + key.size() + 2);
    if (q == std::string::npos || json[q] != '"') return "";
    const size_t e = json.find('"', q + 1);
    return e == std::string::npos ? "" : json.substr(q + 1, e - q - 1);
}

int run(const std::string& cmd) {
    const int rc = std::system((cmd + " 2>/dev/null").c_str());
    return rc == -1 || !WIFEXITED(rc) ? -1 : WEXITSTATUS(rc);
}

}  // namespace

int main(int, char** argv) {
    const std::string here = dir_of(argv[0]);
    const char* env = std::getenv("MRTS_FIXTURES");
    const std::string fix = env ? env : here + "/../../../tests/fixtures";
    const std::string egress = fix + "/egress", cli = here + "/../mrts_cli";
    std::vector<std::string> names;
    if (DIR* d = opendir(egress.c_str())) {
        while (dirent* e = readdir(d)) {
            const std::string n = e->d_name;
            const std::string suf = ".clock.json";
            if (n.size() > suf.size() && n.compare(n.size() - suf.size(), suf.size(), suf) == 0)
                names.push_back(n.substr(0, n.size() - suf.size()));
        }
        closedir(d);
    }
    std::sort(names.begin(), names.end());
    std::string first_cmd;
    for (const std::string& n : names) {
        const std::string clock = egress + "/" + n + ".clock.json";
        const std::string spec = read_text(clock);
        const std::string input = field(spec, "input"), bus = field(spec, "bus");
        std::string cmd = cli + " egress " + fix + "/" + input + " --clock " + clock;
        if (!bus.empty()) cmd += " --bus " + fix + "/" + bus;
        cmd += " --expect " + egress + "/" + n + ".expect.jsonl";
        if (first_cmd.empty()) first_cmd = cli + " egress " + fix + "/" + input + " --clock " + clock +
                                           (bus.empty() ? "" : " --bus " + fix + "/" + bus);
        CHECK(("replay " + n + ": mrts_cli egress equals its .expect.jsonl").c_str(), !input.empty() && run(cmd) == 0);
    }
    CHECK("replay: at least twelve egress cases", names.size() >= 12);
    // A changed expectation is caught: the first case against an empty and a one-line file.
    const std::string tmp = std::string(std::getenv("TMPDIR") ? std::getenv("TMPDIR") : "/tmp") + "/egress-replay-test.jsonl";
    bool caught = false;
    if (std::FILE* f = std::fopen(tmp.c_str(), "w")) {
        std::fputs("{\"counters\":{}}\n", f);
        std::fclose(f);
        caught = !first_cmd.empty() && run(first_cmd + " --expect " + tmp) == 1;
        std::remove(tmp.c_str());
    }
    CHECK("replay: a changed expectation fails (exit 1)", caught);
    CHECK("replay: a missing clock file is a usage error (exit 2)",
          run(cli + " egress " + fix + "/syn-wrap-33bit.ts --clock " + egress + "/none.clock.json") == 2);
    return test_summary("ts_egress_replay");
}
