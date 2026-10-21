// mrducker's core (plan ch. 6 WI-P2-10): the envelope against the TS DuckerEnvelope's vectors
// to 0.01 dB, the key meter, and the sample path: the window, the ramp, chunking, reports.
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "../ducker_envelope.h"

using namespace mrducker;

namespace {

int g_failures = 0;

void CHECK(const std::string& name, bool cond) {
    std::printf("%s %s\n", cond ? "PASS" : "FAIL", name.c_str());
    if (!cond) g_failures++;
}

struct Vec {
    double key, dt;
    DuckerParams p;
    bool reset;
    double db;
    Phase phase;
    double write;   // -1: the TS wrote nothing
};
struct VecCase {
    const char* name;
    const Vec* rows;
    size_t n;
};

#include "ducker_vectors.inc"

constexpr double TOL_DB = 0.01;
// The TS wrote its gain rounded to 4 decimals (an IPC value), so a write compares to that.
constexpr double WRITE_TOL = 0.5e-4 + 1e-12;
double db_of(double gain) { return 20 * std::log10(gain); }

void test_vectors() {
    size_t total = 0;
    for (const VecCase& c : kCases) {
        DuckerEnvelope env;
        std::string bad;
        for (size_t i = 0; i < c.n && bad.empty(); i++) {
            const Vec& v = c.rows[i];
            if (v.reset) env.reset();
            const bool moved = env.advance(v.key, v.dt, v.p);
            char buf[200];
            if (std::fabs(env.gain_db() - v.db) > TOL_DB || env.phase() != v.phase) {
                std::snprintf(buf, sizeof buf, "step %zu: %.4f dB %s, want %.4f dB %s", i,
                              env.gain_db(), phase_name(env.phase()), v.db, phase_name(v.phase));
                bad = buf;
            } else if (moved != (v.write >= 0)
                       || (moved && std::fabs(env.gain() - v.write) > WRITE_TOL)) {
                std::snprintf(buf, sizeof buf, "step %zu: write %d %.5f, want %.5f", i, moved,
                              env.gain(), v.write);
                bad = buf;
            }
        }
        total += c.n;
        CHECK(std::string("vectors ") + c.name + ": " + std::to_string(c.n)
                  + " readings, gain within 0.01 dB, phase and writes as the TS's"
                  + (bad.empty() ? "" : " (" + bad + ")"),
              bad.empty());
    }
    CHECK("vectors: every case of duckerEnvelope.test.ts and the walk (" + std::to_string(total)
              + " readings)",
          sizeof kCases / sizeof kCases[0] == 11 && total > 800);
}

void test_envelope_edges() {
    DuckerEnvelope env;
    CHECK("fresh: unity, idle, no key reading yet",
          env.gain_db() == 0 && env.gain() == 1 && env.phase() == Phase::idle
              && std::isnan(env.key_db()));
    const DuckerParams p;
    env.advance(-3, 15, p);
    CHECK("the key reading is kept", env.key_db() == -3);
    env.reset();
    CHECK("reset: unity again", env.gain_db() == 0 && env.gain() == 1 && std::isnan(env.key_db()));
    // Content time is exact: a 0.2 ms partial window integrates 0.2 ms, not the TS's 1 ms.
    DuckerParams slow;
    slow.attack_ms = 500;
    slow.depth_db = -40;
    env.advance(0, 0.2, slow);
    CHECK("a partial window integrates its own content time",
          std::fabs(env.gain_db() + 0.016) < 1e-9);
    DuckerEnvelope neg;
    neg.advance(0, -5, slow);
    CHECK("a negative interval integrates nothing", neg.gain_db() == 0);
    DuckerParams instant;
    instant.attack_ms = 0;
    DuckerEnvelope fast;
    fast.advance(0, 0.2, instant);
    CHECK("attack 0 is the TS's 1 ms: 0.2 ms of content moves 2.4 of a -12 dB floor",
          std::fabs(fast.gain_db() + 2.4) < 1e-9);
    DuckerParams flat;
    flat.depth_db = 0;
    DuckerEnvelope zero;
    zero.advance(0, 15, flat);
    CHECK("depth 0: the key changes nothing", zero.gain_db() == 0 && zero.phase() == Phase::idle);
}

void test_key_meter() {
    KeyMeter m;
    CHECK("an empty window reads the floor", m.take_db() == KeyMeter::FLOOR_DB);
    for (int i = 0; i < 720; i++) m.add(0.0f, 0.5f);
    CHECK("the louder channel counts: DC 0.5 on channel 3 reads -6.02 dB",
          std::fabs(m.take_db() - 20 * std::log10(0.5)) < 1e-9);
    for (int i = 0; i < 720; i++) m.add(0.5f, 0.0f);
    CHECK("...on channel 2 as well", std::fabs(m.take_db() - 20 * std::log10(0.5)) < 1e-9);
    CHECK("a take empties the window", m.frames() == 0);
    for (int i = 0; i < 48000; i++) m.add((float)std::sin(2 * M_PI * 1000 * i / 48000.0), 0.0f);
    CHECK("RMS, not peak: a full-scale sine reads -3.01 dB",
          std::fabs(m.take_db() + 3.0103) < 0.001);
    for (int i = 0; i < 720; i++) m.add(0.0f, 0.0f);
    CHECK("digital silence reads the floor (-120 dB), never -inf",
          m.take_db() == KeyMeter::FLOOR_DB);
}

/* Interleaved 4-channel frames: programme `prog` on 0/1, key on 2/3 for [k0, k1) frames. */
std::vector<float> feed(size_t frames, float prog, float key, size_t k0, size_t k1) {
    std::vector<float> v(frames * 4);
    for (size_t i = 0; i < frames; i++) {
        v[4 * i] = prog;
        v[4 * i + 1] = -prog;
        const float k = (i >= k0 && i < k1) ? key : 0.0f;
        v[4 * i + 2] = k;
        v[4 * i + 3] = k * 0.5f;
    }
    return v;
}

struct Run {
    std::vector<float> out;
    std::vector<DuckerCore::Reading> readings;   // `at` made absolute
};

/* The whole input through `core` in chunks of `chunk` frames (0: one call). */
Run run(DuckerCore& core, const std::vector<float>& in, const DuckerParams& p, size_t chunk = 0,
        bool silent = false) {
    Run r;
    const size_t frames = in.size() / 4;
    r.out.assign(frames * 2, 7.0f);
    size_t done = 0;
    unsigned seed = 1;
    while (done < frames) {
        size_t n = chunk ? chunk : frames;
        if (chunk == 1000000) {   // pseudo-random chunk sizes, 1..1500
            seed = seed * 1103515245u + 12345u;
            n = 1 + (seed >> 8) % 1500;
        }
        n = std::min(n, frames - done);
        std::vector<DuckerCore::Reading> got;
        core.process(in.data() + 4 * done, r.out.data() + 2 * done, n, silent, p, &got);
        for (DuckerCore::Reading g : got) {
            g.at += done;
            r.readings.push_back(g);
        }
        done += n;
    }
    return r;
}

void test_core_window() {
    DuckerCore core;
    CHECK("48 kHz: a 15 ms window is 720 frames", core.window_frames() == 720);
    DuckerCore cd(44100);
    CHECK("44.1 kHz: 662 frames (661.5 rounded)", cd.window_frames() == 662);
    DuckerCore bad(0);
    CHECK("a rate of 0 falls back to 48 kHz", bad.rate() == 48000 && bad.window_frames() == 720);

    const DuckerParams p;
    const std::vector<float> in = feed(48000, 0.25f, 0.0f, 0, 0);
    Run r = run(core, in, p);
    bool same = true, keyless = true;
    for (size_t i = 0; i < 48000; i++) {
        same = same && r.out[2 * i] == in[4 * i] && r.out[2 * i + 1] == in[4 * i + 1];
    }
    for (const DuckerCore::Reading& g : r.readings) keyless = keyless && g.key_db == -120;
    CHECK("no key: the programme passes bit-exact, the key channels are not in it", same);
    CHECK("one reading per 720 frames, at each window end (66 in 1 s)",
          r.readings.size() == 66 && r.readings[0].at == 720 && r.readings[65].at == 47520);
    CHECK("each reading spans 15 ms of content and reads the silent key at the floor",
          keyless && r.readings[3].dt_ms == 15.0);
}

void test_core_onset() {
    // A key burst at frame T (not on a window boundary) ducks from the end of its window.
    const size_t T = 48140;   // 1002.92 ms; its window is [47520, 48240)
    DuckerParams p;          // -35 dB threshold, -12 dB floor, 5 ms attack
    DuckerCore core;
    const std::vector<float> in = feed(96000, 0.5f, 0.5f, T, 96000);
    Run r = run(core, in, p);
    size_t onset = 0;
    for (size_t i = 0; i < 96000 && !onset; i++)
        if (r.out[2 * i] < 0.5f) onset = i;
    CHECK("the first ducked frame is the first of the window after the key's (frame 48240, "
          "got " + std::to_string(onset) + ")",
          onset == 48240);
    CHECK("the key's own window still passes at unity", r.out[2 * 48239] == 0.5f);
    const double floor = std::pow(10.0, -12 / 20.0);
    bool straight = true;
    for (size_t k = 0; k < 720; k++) {
        const double want = -12.0 * (k + 1) / 720;
        straight = straight && std::fabs(db_of(r.out[2 * (48240 + k)] / 0.5) - want) < 1e-3;
    }
    CHECK("the ramp is straight in dB across that window and ends on the floor", straight);
    CHECK("on the floor exactly at the window's last frame, and after it",
          std::fabs(r.out[2 * 48959] / 0.5 - floor) < 1e-6
              && std::fabs(r.out[2 * 60000] / 0.5 - floor) < 1e-6);
    CHECK("the other programme channel gets the same gain",
          std::fabs(r.out[2 * 60000 + 1] / -0.5 - floor) < 1e-6);
    CHECK("the core holds the floor as its applied gain",
          std::fabs(core.applied_gain() - floor) < 1e-9);
    // Release: the key stops; hold 250 ms, then 200 ms of release in 15 ms steps.
    const std::vector<float> rel = feed(48000, 0.5f, 0.5f, 0, 0);
    Run q = run(core, rel, p);
    size_t up = 0;
    for (size_t i = 0; i < 48000 && !up; i++)
        if (q.out[2 * i] > 0.5f * floor * 1.001) up = i;
    // The key's last window ends at 96480 (frame 480 here); the hold ends 250 ms of readings
    // later and its first release ramp starts one window after that.
    CHECK("the hold keeps the floor ~250 ms after the key falls (release from frame "
          + std::to_string(up) + ")",
          up > 480 + 12000 && up <= 480 + 12000 + 2 * 720);
    CHECK("then back at unity", q.out[2 * 47999] == 0.5f);
}

void test_core_chunking() {
    DuckerParams p;
    p.attack_ms = 40;
    p.release_ms = 120;
    p.hold_ms = 30;
    std::vector<float> in = feed(96000, 0.3f, 0.2f, 10000, 30000);
    const std::vector<float> burst = feed(96000, 0.3f, 0.6f, 50000, 52000);
    for (size_t i = 50000 * 4; i < 52000 * 4; i++) in[i] = burst[i];
    DuckerCore a, b, c;
    const Run one = run(a, in, p);
    const Run tiny = run(b, in, p, 7);
    const Run rnd = run(c, in, p, 1000000);
    bool readings = one.readings.size() == tiny.readings.size()
                    && one.readings.size() == rnd.readings.size();
    for (size_t i = 0; readings && i < one.readings.size(); i++) {
        readings = one.readings[i].at == tiny.readings[i].at
                   && one.readings[i].at == rnd.readings[i].at
                   && one.readings[i].gain_db == rnd.readings[i].gain_db
                   && one.readings[i].report == rnd.readings[i].report;
    }
    CHECK("output bit-identical in 7-frame and random chunks",
          one.out == tiny.out && one.out == rnd.out);
    CHECK("readings at the same frames with the same values in any chunking", readings);
}

void test_core_reports() {
    DuckerCore core;
    const DuckerParams p;
    const Run r = run(core, feed(480000, 0.1f, 0.0f, 0, 0), p, 480);
    std::vector<size_t> at;
    for (const DuckerCore::Reading& g : r.readings)
        if (g.report) at.push_back(g.at);
    bool steps = true;
    for (size_t i = 1; i < at.size(); i++) {
        const size_t d = at[i] - at[i - 1];
        steps = steps && (d == 4320 || d == 5040);   // 90 or 105 ms: windows straddle the marks
    }
    CHECK("10 s of content: 99 reports, the first at the first window past 100 ms (got "
              + std::to_string(at.size()) + ")",
          at.size() == 99 && at[0] == 5040);
    CHECK("reports 90 or 105 ms apart, 100 ms on average (10 Hz of content time)",
          steps && std::fabs((at.back() - at.front()) / 98.0 - 4800) < 50);
    // 720 and 4800 frames meet every 300 ms: that window reports on the mark, not one later.
    CHECK("a window that ends on a 100 ms mark reports there (frame 14400, 300 ms)",
          at.size() > 3 && at[2] == 14400 && at[3] == 19440);
}

void test_core_gap_and_finish() {
    DuckerParams p;
    DuckerCore core;
    run(core, feed(9600, 0.5f, 0.5f, 0, 9600), p);
    CHECK("ducked by a live key", core.envelope().gain_db() == -12);
    const Run g = run(core, feed(48000, 0.5f, 0.5f, 0, 48000), p, 480, /*silent=*/true);
    bool zeros = true;
    for (float v : g.out) zeros = zeros && v == 0.0f;
    CHECK("a gap is silence out, whatever its bytes", zeros);
    CHECK("...and a silent key: held, then released to unity",
          core.envelope().gain_db() == 0 && core.envelope().phase() == Phase::idle);

    DuckerCore e;
    DuckerCore::Reading last{};
    CHECK("finish with an empty window: no reading", !e.finish(p, &last));
    run(e, feed(1000, 0.5f, 0.5f, 0, 1000), p);
    CHECK("finish: the partial window's reading over its own content time (280 frames)",
          e.finish(p, &last) && std::fabs(last.dt_ms - 280 / 48.0) < 1e-12 && last.key_db > -7);
    CHECK("...and then an empty window", !e.finish(p, &last));
}

void test_core_live_params() {
    DuckerCore core;
    DuckerParams p;
    run(core, feed(9600, 0.5f, 0.5f, 0, 9600), p);
    p.depth_db = -24;
    run(core, feed(9600, 0.5f, 0.5f, 0, 9600), p);
    CHECK("a deeper floor mid-stream: the envelope walks on to it",
          core.envelope().gain_db() == -24
              && std::fabs(core.applied_gain() - std::pow(10.0, -24 / 20.0)) < 1e-9);
    p.threshold_db = 0;
    run(core, feed(48000, 0.5f, 0.5f, 0, 48000), p);
    CHECK("a threshold over the key level: released", core.envelope().gain_db() == 0);
    core.reset();
    CHECK("reset: unity applied", core.applied_gain() == 1 && core.envelope().gain_db() == 0);
}

}  // namespace

int main() {
    test_vectors();
    test_envelope_edges();
    test_key_meter();
    test_core_window();
    test_core_onset();
    test_core_chunking();
    test_core_reports();
    test_core_gap_and_finish();
    test_core_live_params();
    if (g_failures) {
        std::printf("\n%d FAILURE(S) in ducker_envelope\n", g_failures);
        return 1;
    }
    std::printf("\nALL ducker_envelope TESTS PASSED\n");
    return 0;
}
