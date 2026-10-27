// pcm_fade: the tail of a PCM aligner input and its fades (B-83), as mralignwatch makes them at
// every edge toward an audio aggregator.
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <vector>

#include "../pcm_fade.h"
#include "check.h"

using namespace mrts;

namespace {

const double PI = 3.14159265358979323846;

double window(size_t k, size_t n) { return 0.5 * (1.0 + std::cos(PI * (double)k / (double)n)); }

template <typename T>
T expect(double v) {
    if (std::is_floating_point<T>::value) return (T)v;
    return (T)std::llrint(v);
}

template <typename T>
PcmFormat format_of();
template <> PcmFormat format_of<int16_t>() { return PcmFormat::s16; }
template <> PcmFormat format_of<int32_t>() { return PcmFormat::s32; }
template <> PcmFormat format_of<float>() { return PcmFormat::f32; }
template <> PcmFormat format_of<double>() { return PcmFormat::f64; }

void test_window() {
    const size_t n = 240;
    bool mono = true, sym = true;
    for (size_t k = 1; k < n; k++) {
        mono = mono && window(k, n) < window(k - 1, n);
        sym = sym && std::fabs(window(k, n) + window(n - k, n) - 1.0) < 1e-12;
        mono = mono && fade_window(k, n) == window(k, n);
    }
    CHECK("window: 1 at the edge, half at the middle, falling to 0 at n, the raised cosine",
          fade_window(0, n) == 1.0 && std::fabs(fade_window(n / 2, n) - 0.5) < 1e-12 &&
              std::fabs(fade_window(n, n)) < 1e-12 && mono && sym);
    // Zero slope at both ends: the first and last steps under 1 % of the middle one (a linear
    // ramp's are all equal).
    const double first = 1.0 - fade_window(1, n);
    const double mid = fade_window(n / 2, n) - fade_window(n / 2 + 1, n);
    CHECK("window: zero slope at both ends (the first and last steps under 1 % of the middle one)",
          first < mid / 100 && fade_window(n - 1, n) < mid / 100);
}

void test_ring() {
    PcmTail t;
    t.configure(PcmFormat::s16, 2, 5);
    CHECK("ring: configured empty, cap 5, 4-byte frames",
          t.frames() == 0 && t.cap() == 5 && t.frame_bytes() == 4);
    std::vector<int16_t> all;
    for (int16_t i = 0; i < 9; i++) {   // nine pushes of one frame, then of two
        const int16_t f[2] = {i, (int16_t)(100 + i)};
        t.push(f, 1);
        all.push_back(i);
    }
    bool last5 = t.frames() == 5;
    for (size_t i = 0; i < 5 && last5; i++) {
        const int16_t* f = reinterpret_cast<const int16_t*>(t.frame(i));
        last5 = f[0] == (int16_t)(4 + i) && f[1] == (int16_t)(104 + i);
    }
    CHECK("ring: the last 5 frames of 9 one-frame pushes, oldest first, channels kept", last5);
    const int16_t two[4] = {9, 109, 10, 110};
    t.push(two, 2);
    const int16_t* f0 = reinterpret_cast<const int16_t*>(t.frame(0));
    const int16_t* f4 = reinterpret_cast<const int16_t*>(t.frame(4));
    CHECK("ring: a two-frame push shifts by two", t.frames() == 5 && f0[0] == 6 && f4[0] == 10);
    std::vector<int16_t> big(2 * 12);
    for (int i = 0; i < 12; i++) big[2 * i] = big[2 * i + 1] = (int16_t)(1000 + i);
    t.push(big.data(), 12);
    f0 = reinterpret_cast<const int16_t*>(t.frame(0));
    f4 = reinterpret_cast<const int16_t*>(t.frame(4));
    CHECK("ring: a push longer than the cap keeps its own last 5",
          t.frames() == 5 && f0[0] == 1007 && f4[0] == 1011);
    t.reset();
    CHECK("ring: reset empties it, the format kept", t.frames() == 0 && t.cap() == 5);
    t.configure(PcmFormat::f64, 8, 3);
    CHECK("ring: reconfigured empty, 64-byte frames", t.frames() == 0 && t.frame_bytes() == 64);
}

// A constant tail fades out as the constant times the window, to the sample, on every channel.
template <typename T>
bool constant_fade(int channels, double value, size_t n) {
    PcmTail t;
    t.configure(format_of<T>(), channels, n);
    std::vector<T> in((size_t)channels * (n + 7));
    for (size_t i = 0; i < in.size(); i++)
        in[i] = (T)(value * (1 + (i % (size_t)channels)) / channels);
    t.push(in.data(), n + 7);
    std::vector<T> out((size_t)channels * n);
    fade_out(t, out.data(), n);
    for (size_t k = 0; k < n; k++)
        for (int c = 0; c < channels; c++) {
            const T v = (T)(value * (1 + c) / channels);
            if (out[k * channels + c] != expect<T>((double)v * window(k, n))) return false;
        }
    return true;
}

void test_fade_out() {
    bool all = true;
    for (int ch : {1, 2, 8}) {
        all = all && constant_fade<int16_t>(ch, 1000.0, 240) &&
              constant_fade<int16_t>(ch, -32768.0, 240);
        all = all && constant_fade<int32_t>(ch, 1.5e9, 240) &&
              constant_fade<int32_t>(ch, -2147483648.0, 240);
        all = all && constant_fade<float>(ch, 0.25, 240) && constant_fade<double>(ch, -0.75, 240);
    }
    CHECK("fade-out: a constant tail times the window to the sample, S16/S32/F32/F64 at 1, 2 and 8 "
          "channels", all);

    // A ramp: the fade plays the tail back from its last frame.
    PcmTail t;
    t.configure(PcmFormat::s16, 1, 240);
    std::vector<int16_t> ramp(240);
    for (int i = 0; i < 240; i++) ramp[i] = (int16_t)(10 * i);
    t.push(ramp.data(), 240);
    std::vector<int16_t> out(240);
    fade_out(t, out.data(), 240);
    bool rev = out[0] == 2390;
    for (size_t k = 0; k < 240; k++)
        rev = rev && out[k] == expect<int16_t>(10.0 * (239 - k) * window(k, 240));
    CHECK("fade-out: a ramp's tail reversed: it starts at the last value, 2390", rev);

    // Shorter than the tail: its last n frames, the window over n.
    std::vector<int16_t> short5(5);
    fade_out(t, short5.data(), 5);
    bool sh = true;
    for (size_t k = 0; k < 5; k++)
        sh = sh && short5[k] == expect<int16_t>(10.0 * (239 - k) * window(k, 5));
    CHECK("fade-out: over 5 frames, the last 5 reversed under a 5-frame window", sh);

    PcmTail one;
    one.configure(PcmFormat::s16, 2, 240);
    const int16_t f[2] = {-1234, 4321};
    one.push(f, 1);
    int16_t o[4] = {7, 7, 7, 7};
    fade_out(one, o, 3);
    CHECK("fade-out: a 1-frame tail gives one frame, its own, and writes nothing past it",
          o[0] == -1234 && o[1] == 4321 && o[2] == 7 && o[3] == 7);

    // The extremes never wrap.
    PcmTail ext;
    ext.configure(PcmFormat::s16, 2, 240);
    std::vector<int16_t> e(480);
    for (size_t i = 0; i < e.size(); i++)
        e[i] = i % 2 ? std::numeric_limits<int16_t>::max() : std::numeric_limits<int16_t>::min();
    ext.push(e.data(), 240);
    std::vector<int16_t> eo(480);
    fade_out(ext, eo.data(), 240);
    bool ok = eo[0] == -32768 && eo[1] == 32767;
    for (size_t k = 1; k < 240; k++)
        ok = ok && eo[2 * k] <= 0 && eo[2 * k] >= eo[2 * k - 2] && eo[2 * k + 1] >= 0 &&
             eo[2 * k + 1] <= eo[2 * k - 1];
    CHECK("fade-out: S16 at full scale never overflows: monotone toward 0 on both signs", ok);
}

void test_fade_in() {
    const size_t total = 240;
    std::vector<int16_t> a(2 * 96, 1000), b(2 * 480, 1000);
    // A 2 ms buffer, the first 10 frames before the horizon left alone, then a 10 ms one.
    size_t left = fade_in(PcmFormat::s16, 2, a.data(), 96, 10, total, total);
    CHECK("fade-in: a 2 ms buffer takes 86 frames of the ramp, 154 left", left == 154);
    left = fade_in(PcmFormat::s16, 2, b.data(), 480, 0, left, total);
    bool pre = true, ramp = true, after = true;
    for (size_t k = 0; k < 10; k++) pre = pre && a[2 * k] == 1000 && a[2 * k + 1] == 1000;
    for (size_t j = 0; j < total; j++) {
        const int16_t want = expect<int16_t>(1000.0 * (1.0 - window(j, total)));
        const int16_t* f = j < 86 ? &a[2 * (10 + j)] : &b[2 * (j - 86)];
        ramp = ramp && f[0] == want && f[1] == want;
    }
    for (size_t k = 154; k < 480; k++) after = after && b[2 * k] == 1000;
    CHECK("fade-in: frames before the horizon untouched", pre);
    CHECK("fade-in: the ramp 0 -> 1000 continues across the two buffers, to the sample",
          ramp && a[20] == 0);
    CHECK("fade-in: done, the rest at full scale", left == 0 && after);
    std::vector<float> fl(4, 0.5f);
    CHECK("fade-in: nothing left, nothing touched; a bad count is refused",
          fade_in(PcmFormat::f32, 1, fl.data(), 4, 0, 0, total) == 0 && fl[0] == 0.5f &&
              fade_in(PcmFormat::f32, 1, fl.data(), 4, 0, 300, total) == 0 && fl[3] == 0.5f);
    std::vector<double> d(8, -0.5);
    fade_in(PcmFormat::f64, 2, d.data(), 4, 0, 4, 4);
    CHECK("fade-in: F64, both channels, 4 frames",
          d[0] == 0.0 && d[1] == 0.0 && d[2] == -0.5 * (1.0 - window(1, 4)) && d[7] == d[6] &&
              std::fabs(d[6] - -0.5 * (1.0 - window(3, 4))) < 1e-15);
}

}  // namespace

int main() {
    test_window();
    test_ring();
    test_fade_out();
    test_fade_in();
    return test_summary("pcm_fade");
}
