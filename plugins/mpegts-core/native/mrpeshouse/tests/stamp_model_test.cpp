// Bit-exact parity of the C++ floor model with subtitle_stamp_model.py: replay
// the python's recorded observe() inputs (README.md: generator) and compare K
// and every private PES house time with ==, plus a few hand cases.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>

#include "../stamp_model.h"
#include "mrts/tests/check.h"

using namespace mrpeshouse;

namespace {

std::optional<double> opt_double(const std::string& s) {
    if (s == "-") return std::nullopt;
    return std::strtod(s.c_str(), nullptr);
}
std::optional<int64_t> opt_int(const std::string& s) {
    if (s == "-") return std::nullopt;
    return std::strtoll(s.c_str(), nullptr, 10);
}
bool same(std::optional<double> a, std::optional<double> b) {
    return a.has_value() == b.has_value() && (!a || *a == *b);
}

void replay(const char* path) {
    std::ifstream in(path);
    CHECK("vectors file opens", in.good());
    std::string line, run;
    StampModel m;
    long chunks = 0, houses = 0, k_bad = 0, h_bad = 0, runs = 0;
    while (std::getline(in, line)) {
        std::istringstream f(line);
        std::string tag;
        f >> tag;
        if (tag == "R") {
            if (runs++ && (k_bad || h_bad)) break;
            m = StampModel();
            std::getline(f, run);
        } else if (tag == "C") {
            std::string stamp, ref, k;
            int sure = 0;
            f >> stamp >> ref >> sure >> k;
            std::optional<int64_t> ns = opt_int(stamp);
            m.observe(ns ? std::optional<double>((double)*ns / 1e6) : std::nullopt, opt_int(ref), sure != 0);
            chunks++;
            if (!same(m.k(), opt_double(k)) && k_bad++ < 3)
                std::printf("  K mismatch in run%s: %s\n", run.c_str(), line.c_str());
        } else if (tag == "H") {
            std::string pts, house;
            f >> pts >> house;
            houses++;
            if (!same(m.house(opt_int(pts)), opt_double(house)) && h_bad++ < 3)
                std::printf("  house mismatch in run%s: %s\n", run.c_str(), line.c_str());
        }
    }
    std::printf("  %ld runs, %ld chunks, %ld private PES replayed\n", runs, chunks, houses);
    CHECK("vectors: several runs, thousands of chunks", runs >= 5 && chunks > 1000 && houses > 500);
    CHECK("vectors: K identical to python after every chunk", k_bad == 0);
    CHECK("vectors: every private PES house time identical to python", h_bad == 0);
}

void hand_cases() {
    CHECK("fold wraps both ways", fold_ticks(5) == 5 && fold_ticks(-5) == -5 && fold_ticks(PTS_WRAP - 5) == -5);
    Reference r = chunk_reference({{0x101, 0xC0, 5}, {0x100, 0xE0, 9}}, 0x100);
    CHECK("reference: PCR PID's PES, not sure when audio came first", r.pts == 9 && !r.sure);
    r = chunk_reference({{0x120, 0xBD, 7}}, -1);
    CHECK("reference: private only, no PCR PID → none, sure", !r.pts && r.sure);
    StampModel m;
    m.observe(1000.0, 90000, true);
    CHECK("first rise learns K", m.k() == 1000.0 - 90000 / 90.0);
    m.observe(std::nullopt, 99999, true);
    CHECK("unstamped chunk changes nothing", m.k() == 0.0);
    m.observe(900.0, std::nullopt, true);
    CHECK("stamp backwards drops K and counts a resync", !m.k() && m.resyncs() == 1);
    CHECK("no K → no house", !m.house(90000));
}

}  // namespace

int main(int argc, char** argv) {
    hand_cases();
    replay(argc > 1 ? argv[1] : "stamp_model_vectors.txt");
    return test_summary("mrpeshouse stamp_model");
}
