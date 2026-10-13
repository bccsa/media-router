// mr-clockstate's measuring core with injected readers: sandwich selection,
// adjtimex decoding and the exact JSON lines the engine's HouseClock parses.
#include <cmath>
#include <cstdlib>
#include <string>
#include <vector>

#include "../clock_sample.h"
#include "mrts/tests/check.h"

using namespace mrclock;

namespace {

// A scripted clock: returns `values` in order and records which clock was read.
struct Script {
    std::vector<int64_t> values;
    std::vector<clockid_t> ids;
    size_t i = 0;
    ClockReader reader() {
        return [this](clockid_t id) {
            ids.push_back(id);
            return values[i++];
        };
    }
};

// One sandwich: m1, tai, m2.
void push(Script& s, int64_t m1, int64_t tai, int64_t m2) {
    s.values.insert(s.values.end(), {m1, tai, m2});
}

constexpr int64_t E = 1800000000123456789LL;  // > 2^53: must survive exactly

void test_sandwich_selection() {
    Script s;
    push(s, 1000, E + 1050, 1100);  // bracket 100
    push(s, 2000, E + 2020, 2040);  // bracket 40  <- kept
    push(s, 3000, E + 3030, 3060);  // bracket 60
    push(s, 4000, E + 4999, 4040);  // bracket 40, a tie: the earlier stays
    push(s, 5000, E + 5045, 5090);  // bracket 90
    EpochSample r = sample_epoch(s.reader());
    CHECK("five sandwiches read by default", s.i == 15);
    CHECK("smallest bracket kept", r.bracket_ns == 40);
    CHECK("tie keeps the earlier sandwich", r.mono_ns == 2020);
    CHECK("E = TAI - bracket midpoint", r.e_ns == E);

    bool order = true;
    for (size_t k = 0; k < s.ids.size(); k++) {
        clockid_t want = k % 3 == 1 ? CLOCK_TAI : CLOCK_MONOTONIC;
        if (s.ids[k] != want) order = false;
    }
    CHECK("each sandwich reads MONO, TAI, MONO", order);
}

void test_odd_bracket_and_count() {
    Script s;
    push(s, 10, E + 15, 21);  // bracket 11: midpoint 15 (floor of 15.5)
    EpochSample r = sample_epoch(s.reader(), 1);
    CHECK("n honoured", s.i == 3);
    CHECK("odd bracket midpoint floors", r.mono_ns == 15 && r.bracket_ns == 11);
    CHECK("E from floored midpoint", r.e_ns == E);
}

void test_real_clock() {
    EpochSample r = sample_epoch();
    int64_t tai = read_clock_ns(CLOCK_TAI), mono = read_clock_ns(CLOCK_MONOTONIC);
    CHECK("real bracket is non-negative and under 1 ms",
          r.bracket_ns >= 0 && r.bracket_ns < 1000000);
    CHECK("real E within 1 ms of a single TAI-MONO read",
          std::llabs((tai - mono) - r.e_ns) < 1000000);
}

void test_decode_kernel() {
    struct timex tx {};
    tx.status = STA_PLL | STA_NANO;
    tx.tai = 37;
    tx.esterror = 1234;
    tx.maxerror = 56789;
    tx.freq = (long)(-12.5 * 65536);
    KernelState k = decode_kernel(tx, TIME_OK);
    CHECK("synced without STA_UNSYNC", k.synced);
    CHECK("tai offset", k.tai_offset_s == 37);
    CHECK("est/max error in us", k.est_error_us == 1234 && k.max_error_us == 56789);
    CHECK("freq is 16.16 scaled ppm", std::fabs(k.freq_ppm + 12.5) < 1e-9);
    CHECK("raw status kept", k.status == (STA_PLL | STA_NANO));
    CHECK("return kept", k.ret == TIME_OK);

    tx.status = STA_UNSYNC | STA_PLL;
    tx.tai = 0;
    k = decode_kernel(tx, TIME_ERROR);
    CHECK("STA_UNSYNC -> not synced", !k.synced);
    CHECK("unset tai offset reads 0", k.tai_offset_s == 0);

    tx.status = 0;
    k = decode_kernel(tx, -1);
    CHECK("failed call -> not synced", !k.synced && k.ret == -1 && k.tai_offset_s == 0);
}

void test_read_kernel_injected() {
    int seen_modes = -1;
    KernelState k = read_kernel([&](struct timex* tx) {
        seen_modes = (int)tx->modes;
        tx->status = 0;
        tx->tai = 37;
        return TIME_INS;
    });
    CHECK("adjtimex called read-only (modes = 0)", seen_modes == 0);
    CHECK("injected adjtimex decoded", k.synced && k.tai_offset_s == 37 && k.ret == TIME_INS);
}

void test_leap_names() {
    CHECK("leap names",
          std::string(leap_name(TIME_OK)) == "ok" && std::string(leap_name(TIME_INS)) == "ins" &&
              std::string(leap_name(TIME_DEL)) == "del" &&
              std::string(leap_name(TIME_OOP)) == "oop" &&
              std::string(leap_name(TIME_WAIT)) == "wait" &&
              std::string(leap_name(TIME_ERROR)) == "error" &&
              std::string(leap_name(-1)) == "fail");
}

void test_json() {
    EpochSample s{123456789012LL, E, 417};
    KernelState k;
    k.synced = true;
    k.tai_offset_s = 37;
    k.est_error_us = 250;
    k.max_error_us = 1500;
    k.freq_ppm = -3.25;
    k.status = STA_PLL | STA_NANO;
    k.ret = TIME_OK;
    std::string want =
        "{\"type\":\"sample\",\"monoNs\":\"123456789012\",\"eNs\":\"1800000000123456789\","
        "\"bracketNs\":417,\"synced\":true,\"taiOffsetS\":37,\"estErrorUs\":250,"
        "\"maxErrorUs\":1500,\"freqPpm\":-3.250,\"status\":" +
        std::to_string(STA_PLL | STA_NANO) + ",\"leap\":\"ok\"}";
    CHECK("sample line exact", sample_json(s, k) == want);

    k.synced = false;
    k.ret = TIME_ERROR;
    std::string line = sample_json(s, k);
    CHECK("unsynced sample says so",
          line.find("\"synced\":false") != std::string::npos &&
              line.find("\"leap\":\"error\"") != std::string::npos);
    CHECK("no newline in the line", line.find('\n') == std::string::npos);

    CHECK("step line exact",
          step_json(987654321098LL) == "{\"type\":\"step\",\"monoNs\":\"987654321098\"}");
}

}  // namespace

int main() {
    test_sandwich_selection();
    test_odd_bracket_and_count();
    test_real_clock();
    test_decode_kernel();
    test_read_kernel_injected();
    test_leap_names();
    test_json();
    return test_summary("clock_sample");
}
