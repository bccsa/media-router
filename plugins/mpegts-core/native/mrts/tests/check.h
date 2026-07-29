// Minimal zero-dependency test harness: CHECK(name, cond) prints PASS/FAIL,
// test_summary() prints the verdict and returns the process exit code.
// Mirrors the check() convention of the python *_test.py scripts.
#pragma once
#include <cstdio>

static int g_failures = 0;

inline void CHECK(const char* name, bool cond) {
    std::printf("%s %s\n", cond ? "PASS" : "FAIL", name);
    if (!cond) g_failures++;
}

inline int test_summary(const char* suite) {
    if (g_failures) {
        std::printf("\n%d FAILURE(S) in %s\n", g_failures, suite);
        return 1;
    }
    std::printf("\nALL %s TESTS PASSED\n", suite);
    return 0;
}
