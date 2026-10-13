#include "clock_sample.h"

#include <cstdio>

namespace mrclock {

int64_t read_clock_ns(clockid_t id) {
    struct timespec ts {};
    clock_gettime(id, &ts);
    return (int64_t)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

EpochSample sample_epoch(const ClockReader& read, int n) {
    EpochSample best;
    bool have = false;
    for (int i = 0; i < n; i++) {
        int64_t m1 = read(CLOCK_MONOTONIC);
        int64_t tai = read(CLOCK_TAI);
        int64_t m2 = read(CLOCK_MONOTONIC);
        int64_t bracket = m2 - m1;
        // Strictly smaller: on a tie the earlier sandwich stays.
        if (have && bracket >= best.bracket_ns) continue;
        int64_t mid = m1 + bracket / 2;
        best = {mid, tai - mid, bracket};
        have = true;
    }
    return best;
}

KernelState decode_kernel(const struct timex& tx, int ret) {
    KernelState k;
    k.ret = ret;
    if (ret < 0) return k;  // nothing in tx is trustworthy
    k.synced = !(tx.status & STA_UNSYNC);
    k.tai_offset_s = tx.tai;
    k.est_error_us = tx.esterror;
    k.max_error_us = tx.maxerror;
    k.freq_ppm = tx.freq / 65536.0;  // scaled ppm, 16.16 fixed point
    k.status = tx.status;
    return k;
}

KernelState read_kernel(const AdjtimexFn& adj) {
    struct timex tx {};
    tx.modes = 0;  // read only: no privilege needed, nothing changes
    int ret = adj(&tx);
    return decode_kernel(tx, ret);
}

const char* leap_name(int ret) {
    switch (ret) {
        case TIME_OK: return "ok";
        case TIME_INS: return "ins";
        case TIME_DEL: return "del";
        case TIME_OOP: return "oop";
        case TIME_WAIT: return "wait";
        case TIME_ERROR: return "error";
        default: return "fail";
    }
}

std::string sample_json(const EpochSample& s, const KernelState& k) {
    char buf[512];
    std::snprintf(buf, sizeof buf,
                  "{\"type\":\"sample\",\"monoNs\":\"%lld\",\"eNs\":\"%lld\",\"bracketNs\":%lld,"
                  "\"synced\":%s,\"taiOffsetS\":%d,\"estErrorUs\":%ld,\"maxErrorUs\":%ld,"
                  "\"freqPpm\":%.3f,\"status\":%d,\"leap\":\"%s\"}",
                  (long long)s.mono_ns, (long long)s.e_ns, (long long)s.bracket_ns,
                  k.synced ? "true" : "false", k.tai_offset_s, k.est_error_us, k.max_error_us,
                  k.freq_ppm, k.status, leap_name(k.ret));
    return buf;
}

std::string step_json(int64_t mono_ns) {
    return "{\"type\":\"step\",\"monoNs\":\"" + std::to_string(mono_ns) + "\"}";
}

}  // namespace mrclock
