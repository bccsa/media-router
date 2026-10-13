// The measuring half of the house epoch E = TAI - MONOTONIC (design §4.2, §10.3): a tight
// clock sample, the kernel's sync state and the JSON lines mr-clockstate streams. Readers are
// injectable so selection, decoding and formatting are unit-tested without a real clock.
#pragma once
#include <sys/timex.h>
#include <time.h>

#include <cstdint>
#include <functional>
#include <string>

namespace mrclock {

using ClockReader = std::function<int64_t(clockid_t)>;
using AdjtimexFn = std::function<int(struct timex*)>;

// Five MONO -> TAI -> MONO sandwiches; the tightest bracket bounds how far the
// TAI read can sit from the MONO midpoint (preemption shows up as a wide one).
constexpr int SANDWICHES = 5;

struct EpochSample {
    int64_t mono_ns = 0;     // midpoint of the kept bracket
    int64_t e_ns = 0;        // TAI - mono_ns
    int64_t bracket_ns = 0;  // m2 - m1 of the kept sandwich (the uncertainty)
};

struct KernelState {
    bool synced = false;
    int tai_offset_s = 0;
    long est_error_us = 0;
    long max_error_us = 0;
    double freq_ppm = 0.0;
    int status = 0;  // raw STA_* bits
    int ret = -1;    // adjtimex() return: TIME_OK..TIME_ERROR, -1 = call failed
};

int64_t read_clock_ns(clockid_t id);
EpochSample sample_epoch(const ClockReader& read = read_clock_ns, int n = SANDWICHES);

KernelState decode_kernel(const struct timex& tx, int ret);
KernelState read_kernel(const AdjtimexFn& adj = ::adjtimex);

// The adjtimex() return as a name ("ok", "ins", ... "error"; "fail" for -1).
const char* leap_name(int ret);

// One JSON line each, no trailing newline. ns values are decimal strings
// because E (~1.8e18) is beyond a JS number's 2^53.
std::string sample_json(const EpochSample& s, const KernelState& k);
std::string step_json(int64_t mono_ns);

}  // namespace mrclock
