// ts_stc: the virtual STC (WI-P1-1). Convergence, residual floor, envelope step,
// PCR loss, every validator row, degraded entry and recovery, the straddle rule
// and integer determinism. Traces come from an integer LCG and an integer -ln, so
// the printed checksums compare across machines. `--sweep N` prints seed statistics.
#include <algorithm>
#include <climits>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <initializer_list>
#include <map>
#include <vector>

#include "../asrc_servo.h"
#include "../ts_house.h"
#include "../ts_stc.h"
#include "check.h"

using namespace mrts;

namespace {

constexpr int64_t MS = 1000000;
constexpr int64_t S = 1000000000;
constexpr int64_t H0 = 100 * S;   // house time of source time 0 (plus 20 ms of floor delay)

struct Lcg {
    uint64_t s;
    explicit Lcg(uint64_t seed) : s(seed * 0x9E3779B97F4A7C15ULL + 1) {}
    uint32_t next() {
        s = s * 6364136223846793005ULL + 1442695040888963407ULL;
        return (uint32_t)(s >> 32);
    }
};

// -ln((v + 1) / 2^32) in Q24 from a bit-wise log2: no libm, identical everywhere.
int64_t neg_ln_q24(uint32_t v) {
    const uint64_t x = (uint64_t)v + 1;
    int k = 0;
    while ((x >> (k + 1)) != 0) k++;
    uint64_t m = k <= 31 ? x << (31 - k) : x >> (k - 31);   // mantissa, Q31
    int64_t frac = 0;
    for (int i = 0; i < 24; i++) {
        m = (m * m) >> 31;
        frac <<= 1;
        if (m >= (1ULL << 32)) {
            m >>= 1;
            frac |= 1;
        }
    }
    return (((32LL << 24) - (((int64_t)k << 24) + frac)) * 744261118LL) >> 30;   // * ln 2
}

// One-sided network delay: exponential, mean 5 ms, tail cut at 50 ms.
int64_t net_delay(Lcg& g) { return std::min<int64_t>(50 * MS, (5 * MS * neg_ln_q24(g.next())) >> 24); }

int64_t at_ppb(int64_t x, int64_t ppb) {   // x >= 0
    const int64_t q = x / S;
    return q * ppb + (x - q * S) * ppb / S;
}

struct Fnv {
    uint64_t h = 1469598103934665603ULL;
    void add(int64_t v) {
        for (int i = 0; i < 8; i++) {
            h ^= (uint64_t)(v >> (8 * i)) & 0xff;
            h *= 1099511628211ULL;
        }
    }
};

Fnv g_all;   // every checksum below folds in here too

int64_t iabs(int64_t v) { return v < 0 ? -v : v; }

const char* state_name(VirtualStc::State s) {
    const char* names[] = {"acquiring", "locked", "degraded", "lost"};
    return names[(int)s];
}

// --- ClockLock alone: PCR at 10/s ----------------------------------------------

struct Conv {
    int64_t err[4] = {0, 0, 0, 0};   // ε applied - ε at 60, 120, 300, 600 s (ppb)
    int64_t rmin_locked = INT64_MAX, rmin_all = INT64_MAX;
    int64_t t_locked = -1;
    int steps = 0;
    uint64_t sum = 0;
};

Conv converge(int64_t eps_ppb, uint64_t seed, int loss_pct, int64_t secs) {
    ClockLock lk;
    Lcg g(seed);
    Fnv f;
    Conv c;
    const int64_t marks[4] = {60 * S, 120 * S, 300 * S, 600 * S};
    int mark = 0;
    int64_t first_h = -1;
    for (int64_t k = 0; k * 100 * MS <= secs * S; k++) {
        const int64_t t = k * 100 * MS;
        const uint32_t u = g.next();
        const int64_t delay = net_delay(g);
        if ((int)(u % 100) < loss_pct) continue;
        const int64_t sigma = 7200 * S + t, h = H0 + t + at_ppb(t, eps_ppb) + 20 * MS + delay;
        if (first_h < 0) first_h = h;
        while (mark < 4 && h - first_h >= marks[mark]) c.err[mark++] = lk.ppb() - eps_ppb;
        if (lk.started()) {
            const int64_t r = h - lk.house_of(sigma);
            c.rmin_all = std::min(c.rmin_all, r);
            if (lk.phase() == ClockLock::Phase::locked) c.rmin_locked = std::min(c.rmin_locked, r);
        }
        lk.feed(sigma, h);
        if (c.t_locked < 0 && lk.phase() == ClockLock::Phase::locked) c.t_locked = h - first_h;
        if (lk.envelope_step()) {
            c.steps++;
            lk.relock(true);
            lk.feed(sigma, h);
        }
        f.add(lk.house_of(sigma + 500 * MS));
        f.add(lk.ppb());
    }
    c.sum = f.h;
    return c;
}

void test_line_and_lock_basics() {
    const StcLine l{1000 * S, 5 * S, 500000, 0, 0};
    CHECK("line: the pivot maps to itself", l.house_of(1000 * S) == 5 * S);
    CHECK("line: +500 ppm one second on", l.house_of(1001 * S) == 6 * S + 500000);
    CHECK("line: the rate line behind the pivot", l.house_of(999 * S) == 4 * S - 500000);
    const StcLine up{0, 0, 0, 2000000, 3 * MS}, down{0, 0, 0, 2000000, -3 * MS};
    CHECK("slew: moves at its rate", up.house_of(1 * S) == 1 * S + 2 * MS);
    CHECK("slew: stops once it has travelled", up.house_of(10 * S) == 10 * S + 3 * MS);
    CHECK("slew: either direction", down.house_of(1 * S) == 1 * S - 2 * MS && down.house_of(10 * S) == 10 * S - 3 * MS);
    CHECK("slew: nothing behind the pivot", up.house_of(-1 * S) == -1 * S);
    const StcLine tai{0, 1800000000LL * S, 1000000, 0, 0};
    CHECK("line: TAI-scale house and a garbage σ stay ordered, no overflow (UBSan run)",
          tai.house_of(INT64_MAX) > tai.house_of(0) && tai.house_of(INT64_MIN) < tai.house_of(0));

    ClockLock lk;
    CHECK("lock: acquiring and unstarted before a sample", lk.phase() == ClockLock::Phase::acquiring && !lk.started());
    lk.feed(10 * S, 3 * S);
    CHECK("lock: the first sample maps to its arrival", lk.house_of(10 * S) == 3 * S && lk.started());
    lk.tick(7 * S);
    CHECK("lock: 4 s without a sample is not lost", lk.phase() == ClockLock::Phase::acquiring);
    lk.tick(8 * S);
    CHECK("lock: 5 s without a sample is lost", lk.phase() == ClockLock::Phase::lost);
    lk.feed(15 * S, 8 * S);
    CHECK("lock: the next sample resumes; the mapping was kept",
          lk.phase() == ClockLock::Phase::acquiring && lk.house_of(10 * S) == 3 * S);
    lk.relock(false);
    CHECK("lock: relock drops the mapping and the rate", !lk.started() && lk.ppb() == 0);
}

void test_convergence() {
    std::printf("\n  convergence, 10 PCR/s, delay Exp(5 ms) cut at 50 ms; first seed, then the median of 9:\n");
    std::printf("  %-10s %5s %11s %11s %11s %11s %12s %12s %8s %6s  %s\n", "eps set", "loss", "eps@60s",
                "eps@120s", "eps@300s", "eps@600s", "rmin locked", "rmin all", "lock at", "steps", "checksum");
    struct Row {
        int64_t eps;
        int loss;
    };
    const Row rows[] = {{0, 0},      {50000, 0},  {-50000, 0},  {500000, 0},   {-500000, 0},
                        {50000, 25}, {500000, 25}, {-500000, 25}};
    // |error| bounds in ppb above the maxima of 999 seeds per row (and of a second
    // 1000): median of 9 at 60/120/300/600 s, then any single run; no loss / 25 %.
    const int64_t med_bound[2][4] = {{5000, 1750, 500, 300}, {6000, 2500, 600, 500}};
    const int64_t max_bound[2][4] = {{15000, 5000, 1250, 750}, {16000, 6000, 1600, 1000}};
    uint64_t seed = 11;
    for (const Row& r : rows) {
        std::vector<int64_t> err[4];
        int64_t rmin = INT64_MAX, lock_max = 0;
        int steps = 0;
        for (int k = 0; k < 9; k++) {
            const Conv c = converge(r.eps, seed++, r.loss, 610);
            if (k == 0) {
                std::printf("  %+6.0f ppm %4d%% %+11.3f %+11.3f %+11.3f %+11.3f %9.3f ms %9.3f ms %6.1f s %6d  %016llx\n",
                            r.eps / 1000.0, r.loss, (r.eps + c.err[0]) / 1000.0, (r.eps + c.err[1]) / 1000.0,
                            (r.eps + c.err[2]) / 1000.0, (r.eps + c.err[3]) / 1000.0, c.rmin_locked / 1e6,
                            c.rmin_all / 1e6, c.t_locked / 1e9, c.steps, (unsigned long long)c.sum);
            }
            for (int i = 0; i < 4; i++) err[i].push_back(iabs(c.err[i]));
            rmin = std::min(rmin, c.rmin_locked);
            lock_max = std::max(lock_max, c.t_locked < 0 ? INT64_MAX : c.t_locked);
            steps += c.steps;
            g_all.add((int64_t)c.sum);
        }
        int64_t med[4], top[4];
        bool med_ok = true, max_ok = true;
        const int b = r.loss > 0;
        for (int i = 0; i < 4; i++) {
            std::sort(err[i].begin(), err[i].end());
            med[i] = err[i][4];
            top[i] = err[i][8];
            med_ok &= med[i] <= med_bound[b][i];
            max_ok &= top[i] <= max_bound[b][i];
        }
        std::printf("  %21s |err| median %.3f %.3f %.3f %.3f ppm, max %.3f %.3f %.3f %.3f; rmin %.3f ms, lock <= %.1f s\n",
                    "", med[0] / 1000.0, med[1] / 1000.0, med[2] / 1000.0, med[3] / 1000.0, top[0] / 1000.0,
                    top[1] / 1000.0, top[2] / 1000.0, top[3] / 1000.0, rmin / 1e6, lock_max / 1e9);
        char name[192];
        std::snprintf(name, sizeof name, "eps %+lld ppm loss %d%%: 9 seeds locked within 40 s, residual min >= -1 ms, no step",
                      (long long)r.eps / 1000, r.loss);
        CHECK(name, lock_max <= 40 * S && rmin >= -1 * MS && steps == 0);
        std::snprintf(name, sizeof name, "eps %+lld ppm loss %d%%: median of 9 within %.1f/%.2f/%.1f/%.1f ppm at 60/120/300/600 s",
                      (long long)r.eps / 1000, r.loss, med_bound[b][0] / 1000.0, med_bound[b][1] / 1000.0,
                      med_bound[b][2] / 1000.0, med_bound[b][3] / 1000.0);
        CHECK(name, med_ok);
        std::snprintf(name, sizeof name, "eps %+lld ppm loss %d%%: every run within %.0f/%.0f/%.2f/%.2f ppm",
                      (long long)r.eps / 1000, r.loss, max_bound[b][0] / 1000.0, max_bound[b][1] / 1000.0,
                      max_bound[b][2] / 1000.0, max_bound[b][3] / 1000.0);
        CHECK(name, max_ok);
    }
    const Conv a = converge(-500000, 99, 0, 120), b = converge(-500000, 99, 0, 120);
    CHECK("determinism: the same run twice gives the same mapping sequence", a.sum == b.sum);
}

// Envelope step: the floor delay moves by `step` at 300 s; the caller relocks, or with
// `to_floor` steps the mapping onto the new floor (mrasrc).
struct StepRun {
    int fires = 0;
    int64_t fire_after = -1;       // since the first stepped arrival
    int64_t relock_locked = -1;    // phase locked again, since the fire
    int64_t ppb_at_fire = 0, ppb_after_relock = 0, ppb_end = 0;
    int64_t step_size = 0;
    int64_t rmin_after = INT64_MAX;
    int64_t rmin_10s = INT64_MAX;  // over the 10 s after the fire: where the mapping landed
    int64_t drift_100s = 0;        // offset drift over the 100 s after the step
};

StepRun step_run(int64_t step, const ClockLockConfig& cfg = ClockLockConfig(), bool to_floor = false) {
    ClockLock lk(cfg);
    Lcg g(5);
    StepRun s;
    int64_t step_h = -1, fire_h = -1, drift0 = 0;
    bool drift_taken = false;
    for (int64_t k = 0; k * 100 * MS <= 600 * S; k++) {
        const int64_t t = k * 100 * MS;
        const int64_t sigma = 7200 * S + t;
        const int64_t h = H0 + t + at_ppb(t, 50000) + 20 * MS + net_delay(g) + (t >= 300 * S ? step : 0);
        if (t >= 300 * S && step_h < 0) {
            step_h = h;
            drift0 = lk.offset_drift_ns();
        }
        if (fire_h >= 0 && lk.phase() == ClockLock::Phase::locked) s.rmin_after = std::min(s.rmin_after, h - lk.house_of(sigma));
        if (fire_h >= 0 && h - fire_h <= 10 * S) s.rmin_10s = std::min(s.rmin_10s, h - lk.house_of(sigma));
        lk.feed(sigma, h);
        if (lk.envelope_step()) {
            s.fires++;
            fire_h = h;
            s.fire_after = h - step_h;
            s.ppb_at_fire = lk.ppb();
            s.step_size = lk.step_size_ns();
            if (to_floor) {
                lk.step_to_floor();
            } else {
                lk.relock(true);
                lk.feed(sigma, h);
            }
            s.ppb_after_relock = lk.ppb();
        }
        if (fire_h >= 0 && s.relock_locked < 0 && lk.phase() == ClockLock::Phase::locked) s.relock_locked = h - fire_h;
        if (step_h >= 0 && !drift_taken && h - step_h >= 100 * S) {
            s.drift_100s = lk.offset_drift_ns() - drift0;
            drift_taken = true;
        }
    }
    s.ppb_end = lk.ppb();
    return s;
}

void test_envelope_step() {
    const StepRun up = step_run(30 * MS);
    std::printf("  +30 ms step: fired %d time(s) %.2f s after it, locked again %.2f s after the relock, "
                "ppb %lld -> %lld kept, end %lld, residual min after %.3f ms\n",
                up.fires, up.fire_after / 1e9, up.relock_locked / 1e9, (long long)up.ppb_at_fire,
                (long long)up.ppb_after_relock, (long long)up.ppb_end, up.rmin_after / 1e6);
    CHECK("step +30 ms: envelope_step fires once", up.fires == 1);
    CHECK("step +30 ms: ... step_hold_ns (10 s) after the step, within a bucket",
          up.fire_after >= 10 * S && up.fire_after <= 11 * S + 100 * MS);
    CHECK("step +30 ms: relock(keep_rate) keeps ε exactly", up.ppb_after_relock == up.ppb_at_fire);
    CHECK("step +30 ms: locked again acquire_ns (5 s) after the relock",
          up.relock_locked >= 5 * S && up.relock_locked <= 6 * S + 100 * MS);
    CHECK("step +30 ms: residual min >= -1 ms after the re-lock, ε still +50 ppm ±1",
          up.rmin_after >= -1 * MS && iabs(up.ppb_end - 50000) <= 1000);
    const StepRun down = step_run(-30 * MS);
    std::printf("  -30 ms step: fired %d time(s); offset drift 100 s on %.3f ms\n", down.fires, down.drift_100s / 1e6);
    CHECK("step -30 ms: no relock, the lock slews (one-sided rule)", down.fires == 0);
    CHECK("step -30 ms: ... down at the track slew, 20 ppm (2 ms in 100 s)",
          down.drift_100s <= -1900 * 1000 && down.drift_100s >= -2100 * 1000);

    // Two-sided (mrasrc's lock): a fall fires as a rise does, and step_to_floor puts the
    // mapping on the new floor at once, from the step's buckets: still locked, ε kept.
    ClockLockConfig two;
    two.step_falls = true;
    for (const int64_t step : {-30 * MS, 30 * MS}) {
        const StepRun r = step_run(step, two, true);
        std::printf("  two-sided %+lld ms: fired %d time(s) %.2f s after it, step %.3f ms, still locked %s, ppb %lld"
                    " -> %lld, residual min in the 10 s after %.3f ms, after %.3f ms\n",
                    (long long)(step / MS), r.fires, r.fire_after / 1e9, r.step_size / 1e6,
                    r.relock_locked == 0 ? "yes" : "no", (long long)r.ppb_at_fire, (long long)r.ppb_after_relock,
                    r.rmin_10s / 1e6, r.rmin_after / 1e6);
        char name[200];
        std::snprintf(name, sizeof name, "two-sided %+lld ms: fires once, step_hold_ns after it, the step's size",
                      (long long)(step / MS));
        CHECK(name, r.fires == 1 && r.fire_after >= 9 * S && r.fire_after <= 11 * S + 100 * MS &&
                        iabs(r.step_size - step) <= 1 * MS);
        std::snprintf(name, sizeof name, "two-sided %+lld ms: step_to_floor lands on the new floor at once (residual"
                      " min within 1 ms over the next 10 s), locked throughout, ε kept", (long long)(step / MS));
        CHECK(name, r.relock_locked == 0 && iabs(r.rmin_10s) <= 1 * MS && r.rmin_after >= -1 * MS &&
                        r.ppb_after_relock == r.ppb_at_fire && iabs(r.ppb_end - 50000) <= 1000);
    }
    // With M past the hold, the last M buckets still span the old level: the floor comes
    // from the step's own buckets, else a rise would land on the old one.
    ClockLockConfig wide = two;
    wide.offset_buckets = 30;
    const StepRun w = step_run(30 * MS, wide, true);
    std::printf("  two-sided +30 ms, 30 offset buckets: residual min in the 10 s after %.3f ms, after %.3f ms\n",
                w.rmin_10s / 1e6, w.rmin_after / 1e6);
    CHECK("two-sided +30 ms, 30 offset buckets: still on the new floor at once and after (the step's own buckets)",
          w.fires == 1 && iabs(w.rmin_10s) <= 1 * MS && iabs(w.rmin_after) <= 1 * MS);
    ClockLock idle(two);
    idle.feed(0, H0);
    idle.step_to_floor();
    CHECK("step_to_floor without a step moves nothing", idle.house_of(0) == H0 && !idle.envelope_step());

    // A run keeps one direction: 5 s at +60 ms, then 60 ms under the old floor. The fall's
    // hold counts from its own first bucket, so a rise and a fall never make one step.
    ClockLock dir(two);
    Lcg gd(6);
    int64_t fired = -1, fsize = 0;
    for (int64_t t = 0; t <= 400 * S && fired < 0; t += 100 * MS) {
        const int64_t f = t < 300 * S ? 0 : t < 305 * S ? 60 * MS : -60 * MS;
        dir.feed(7200 * S + t, H0 + t + at_ppb(t, 50000) + 20 * MS + f + net_delay(gd));
        if (dir.envelope_step()) {
            fired = t;
            fsize = dir.step_size_ns();
        }
    }
    std::printf("  two-sided, 5 s at +60 ms then -60 ms: fired at %.1f s, step %.3f ms\n", fired / 1e9, fsize / 1e6);
    CHECK("two-sided: a run keeps its direction (5 s up, then down): fires step_hold after the fall began, for it",
          fired >= 314 * S && fired <= 316 * S && iabs(fsize + 60 * MS) <= 1 * MS);
}

// The rate fit runs on one floor level: a re-route, a queue building up or draining
// moves the floor by floor(t) at send time t; the caller re-locks on an envelope step.
// Against the source's true rate and floor arrival: fit error, landing, lateness.
struct LevelRun {
    std::vector<int64_t> fire_t, fire_ppb;   // send time and ε at each envelope step
    int64_t fit_err = 0;                     // max |raw fit - true rate| once fitted
    int64_t late = INT64_MAX;                // min house(σ) - floor arrival while locked
    int64_t land = 0;                        // max |house(σ) - floor arrival| from `settle`
    int64_t ppb_end = 0;
};

// The source runs at +50 ppm, at `eps2` from `t2` on.
template <class Floor>
LevelRun level_run(int64_t secs, Floor floor, int64_t settle, int64_t eps2 = 50000, int64_t t2 = INT64_MAX,
                   uint64_t seed = 9) {
    ClockLock lk;
    Lcg g(seed);
    LevelRun r;
    for (int64_t t = 0; t <= secs * S; t += 100 * MS) {
        const int64_t drift = t < t2 ? at_ppb(t, 50000) : at_ppb(t2, 50000) + at_ppb(t - t2, eps2);
        const int64_t sigma = 7200 * S + t, at_floor = H0 + t + drift + 20 * MS + floor(t);
        const int64_t h = at_floor + net_delay(g);
        if (lk.phase() == ClockLock::Phase::locked) {
            const int64_t e = lk.house_of(sigma) - at_floor;
            r.late = std::min(r.late, e);
            if (t >= settle) r.land = std::max(r.land, iabs(e));
        }
        lk.feed(sigma, h);
        if (lk.envelope_step()) {
            r.fire_t.push_back(t);
            r.fire_ppb.push_back(lk.ppb());
            lk.relock(true);
            lk.feed(sigma, h);
        }
        if (lk.has_fit() && t < t2) r.fit_err = std::max(r.fit_err, iabs(lk.fit_ppb() - 50000));
    }
    r.ppb_end = lk.ppb();
    return r;
}

auto step_at = [](int64_t at, int64_t by) { return [=](int64_t t) { return t >= at ? by : (int64_t)0; }; };
auto ramp_at = [](int64_t at, int64_t by, int64_t over) {   // in us steps: no 64-bit overflow
    return [=](int64_t t) {
        return t < at ? (int64_t)0 : t >= at + over ? by : by / 1000 * ((t - at) / MS) / (over / MS) * 1000;
    };
};

void print_level(const char* label, const LevelRun& r) {
    std::printf("  %s: %zu envelope step(s)", label, r.fire_t.size());
    for (size_t i = 0; i < r.fire_t.size(); i++)
        std::printf(" [@%.1f s eps %.3f ppm]", r.fire_t[i] / 1e9, r.fire_ppb[i] / 1000.0);
    std::printf("; fit off the true rate <= %.3f ppm, eps end %.3f ppm; landing <= %.3f ms after; "
                "min house - floor %.3f ms\n",
                r.fit_err / 1000.0, r.ppb_end / 1000.0, r.land / 1e6, r.late / 1e6);
}

void test_fit_levels() {
    // The first rate fit is made at 30 s: a step right after it lands in a young window.
    const LevelRun rise = level_run(90, step_at(30 * S, 150 * MS), 50 * S);
    print_level("+150 ms at 30 s (young fit window)", rise);
    // Locked from 35 s, so the step's 10 s hold counts from there; ε within the track
    // slew of the source's, as the fit never saw the step.
    CHECK("fit level: a +150 ms step at 30 s re-locks once, its ε kept the source's (the fit never saw it)",
          rise.fire_t.size() == 1 && rise.fire_t[0] >= 44 * S && rise.fire_t[0] <= 46 * S &&
              iabs(rise.fire_ppb[0] - 50000) <= 20000 && rise.fit_err <= 20000);
    CHECK("fit level: ... the new epoch lands on the new floor within 1 ms from 5 s after the relock",
          rise.land <= 1 * MS && iabs(rise.ppb_end - 50000) <= 20000);
    const LevelRun fall = level_run(120, step_at(30 * S, -100 * MS), 120 * S);
    print_level("-100 ms at 30 s (young fit window)", fall);
    CHECK("fit level: a -100 ms fall at 30 s: no relock (one-sided), the fit unbent (the rate row stays clean)",
          fall.fire_t.empty() && fall.fit_err <= 20000 && iabs(fall.ppb_end - 50000) <= 20000);
    CHECK("fit level: ... and content never late (the mapping stays above the new floor)", fall.late >= -1 * MS);
    const LevelRun drain = level_run(240, ramp_at(120 * S, -100 * MS, 30 * S), 240 * S);
    print_level("queue drains 100 ms over 30 s from 120 s", drain);
    // Its first buckets, inside step_ns, enter the fit (the onset): a transient bend only.
    CHECK("fit level: a draining queue is no rate: the fit bent < 50 ppm, no relock, content never late",
          drain.fire_t.empty() && drain.fit_err <= 50000 && iabs(drain.ppb_end - 50000) <= 2000 &&
              drain.late >= -1 * MS);
    const LevelRun up = level_run(240, ramp_at(120 * S, 100 * MS, 30 * S), 175 * S);
    print_level("queue builds 100 ms over 30 s from 120 s", up);
    bool kept = !up.fire_t.empty();
    for (int64_t e : up.fire_ppb) kept &= iabs(e - 50000) <= 10000;
    CHECK("fit level: a queue building up re-locks by envelope steps, each keeping the source's ε, then lands within 1 ms",
          kept && up.land <= 1 * MS && iabs(up.ppb_end - 50000) <= 10000);
    auto burst_at = [](int64_t t) { return t >= 120 * S && t < 124 * S ? 50 * MS : (int64_t)0; };
    const LevelRun burst = level_run(240, burst_at, 130 * S);
    print_level("a 4 s burst of +50 ms at 120 s", burst);
    CHECK("fit level: a 4 s burst passes: no relock, fit unbent, back on the floor",
          burst.fire_t.empty() && burst.fit_err <= 20000 && burst.land <= 1 * MS);
    // 9 s, under the hold, in a young fit: a quarter of its buckets, more than the refit
    // above the line can drop, so a burst's buckets stay out once it has passed.
    auto long_at = [](int64_t t) { return t >= 36 * S && t < 45 * S ? 50 * MS : (int64_t)0; };
    const LevelRun lng = level_run(150, long_at, 60 * S);
    print_level("a 9 s burst of +50 ms at 36 s (young fit)", lng);
    CHECK("fit level: a 9 s burst in a young fit passes: no relock, fit unbent, back on the floor",
          lng.fire_t.empty() && lng.fit_err <= 20000 && lng.land <= 1 * MS);

    // 2.2 ms/s, just over what the level absorbs, 10 s after the first fit: judged at its
    // reference's rate, the drain's first buckets cannot bend the young fit judging the rest.
    int clean = 0;
    for (uint64_t seed = 1; seed <= 9; seed++) {
        const LevelRun d = level_run(160, ramp_at(40 * S, -66 * MS, 30 * S), 160 * S, 50000, INT64_MAX, seed);
        clean += d.fire_t.empty() && iabs(d.ppb_end - 50000) <= 20000 && d.late >= -1 * MS;
    }
    std::printf("  queue drains 66 ms over 30 s from 40 s: %d/9 seeds unbent at the end and never late\n", clean);
    CHECK("fit level: a 2.2 ms/s drain in a young fit, 9 seeds: ε back within 20 ppm, content never late",
          clean == 9);
    // Before the first fit: the level moved, and the fit restarts after the ramp's tail.
    const LevelRun early = level_run(120, ramp_at(10 * S, 100 * MS, 30 * S), 120 * S);
    print_level("queue builds 100 ms over 30 s from 10 s", early);
    CHECK("fit level: a queue building up before the first fit leaves it unbent (fit within 20 ppm)",
          early.fit_err <= 20000 && iabs(early.ppb_end - 50000) <= 20000);
    // After a fall the fit follows the source again: the source's rate moves +20 ppm.
    const LevelRun moved = level_run(240, step_at(30 * S, -100 * MS), 240 * S, 70000, 60 * S);
    print_level("-100 ms at 30 s, then the source +20 ppm at 60 s", moved);
    CHECK("fit level: after a fall the fit runs on the new floor: it follows the source to +70 ppm +-3",
          moved.fire_t.empty() && iabs(moved.ppb_end - 70000) <= 3000);

    // A +900 ppm source: buckets are judged along its rate, else its 9 ms of drift over the
    // lag would hide most of a -25 ms fall, which would then enter the fit.
    const LevelRun fast = level_run(300, step_at(120 * S, -25 * MS), 300 * S, 900000, 0);
    print_level("-25 ms at 120 s on a +900 ppm source", fast);
    CHECK("fit level: a -25 ms fall on a +900 ppm source stays out of the fit (its ε +-5 ppm throughout)",
          fast.fire_t.empty() && iabs(fast.ppb_end - 900000) <= 5000 && fast.late >= -1 * MS);

    // No lock-out: a re-lock keeps an ε 1800 ppm off the source (+900 to -900 ppm behind one
    // PCR PID); every rate error within the clamps passes the level, so the fit re-learns it.
    ClockLock lk;
    Lcg g(13);
    int64_t drift = 0, ppb = 900000, fit_at = -1;
    for (int64_t t = 0; t <= 300 * S; t += 100 * MS) {
        if (t == 200 * S) {
            lk.relock(true);
            ppb = -900000;
        }
        const int64_t h = H0 + t + drift + 20 * MS + net_delay(g);
        drift += ppb / 10;   // 100 ms at ppb
        lk.feed(7200 * S + t, h);
        if (t > 200 * S && fit_at < 0 && lk.has_fit()) fit_at = t - 200 * S;
    }
    std::printf("  re-lock on a source 1800 ppm off the kept eps: first fit %.1f s after, eps %.3f ppm at 100 s\n",
                fit_at / 1e9, lk.ppb() / 1000.0);
    CHECK("fit level: an ε kept 1800 ppm off is re-learned (first fit within 32 s, -900 ppm +-5 at 100 s)",
          fit_at >= 0 && fit_at <= 32 * S && iabs(lk.ppb() + 900000) <= 5000);

    // An adopted level ends the old one's fit: has_fit() stays false (the validator's rate
    // row and mrasrc's bounds read no stale fit) until the new level has rate_buckets_min.
    ClockLock ad;
    Lcg ga(21);
    int64_t off = -1, on = -1, ppb_on = 0;
    bool before = false;
    for (int64_t t = 0; t <= 240 * S; t += 100 * MS) {
        const int64_t h = H0 + t + at_ppb(t, 50000) + 20 * MS - (t >= 120 * S ? 100 * MS : 0) + net_delay(ga);
        ad.feed(7200 * S + t, h);
        if (t == 119 * S) before = ad.has_fit();
        if (t > 120 * S && off < 0 && !ad.has_fit()) off = t;
        if (off >= 0 && on < 0 && ad.has_fit()) {
            on = t;
            ppb_on = ad.fit_ppb();
        }
    }
    std::printf("  -100 ms fall at 120 s: no fit from %.1f s (the adoption) to %.1f s, then %.3f ppm\n", off / 1e9,
                on / 1e9, ppb_on / 1000.0);
    CHECK("fit level: an adopted level clears the fit until 30 buckets of its own (none stale), then the source's",
          before && off >= 129 * S && off <= 131 * S && on >= off + 29 * S && on <= off + 31 * S &&
              iabs(ppb_on - 50000) <= 20000);
}

// The first epoch's floor (WI-P1-6; chapter 15.4 B-35, B-24). PCR at 10/s on a +50 ppm
// source, 0..2.9 ms of jitter above a 20 ms floor; sends from `at` for `len` arrive `excess`
// late and the next ones queue behind them (FIFO), so a start burst follows. `dip`: from
// at + len the delay is `excess` again, so the first bucket's floor was a dip. With `relock_at`
// the lock relocks there and the burst comes after it. Returns house(σ) - floor arrival.
struct StartRun {
    std::vector<std::pair<int64_t, int64_t>> off;   // (send time, house_of(σ) - floor arrival)
    int64_t locked = -1;
    int64_t at(int64_t t) const {
        for (const auto& o : off)
            if (o.first >= t) return o.second;
        return INT64_MIN;
    }
};

StartRun start_run(const ClockLockConfig& cfg, int64_t excess, int64_t at = 0, int64_t len = 500 * MS, bool dip = false,
                   int64_t relock_at = -1, int64_t secs = 60) {
    ClockLock lk(cfg);
    StartRun r;
    int64_t prev = INT64_MIN;
    for (int64_t k = 0; k * 100 * MS <= secs * S; k++) {
        const int64_t t = k * 100 * MS;
        if (t == relock_at) lk.relock(true);
        const int64_t floor_h = H0 + t + at_ppb(t, 50000) + 20 * MS;
        const bool late = t >= at && (t < at + len || dip);
        const int64_t own = floor_h + (late && !(dip && t >= at + len && t < at + 2 * len) ? excess : 0) +
                            (k * 7919 % 30) * 100000;
        const int64_t h = std::max(prev, own);
        prev = h;
        lk.feed(7200 * S + t, h);
        r.off.push_back({t, lk.house_of(7200 * S + t) - floor_h});
        if (r.locked < 0 && lk.phase() == ClockLock::Phase::locked) r.locked = t;
    }
    return r;
}

void test_start_burst() {
    const ClockLockConfig stc, asrc = asrc_lock_config();
    // 500 ms late for the first 0.5 s, as an SRT listener's start (trace-816-clean-cbr).
    const StartRun b = start_run(stc, 500 * MS);
    std::printf("  start burst +500 ms: house - floor %.3f ms at 1.5 s, %.3f at 2.5 s, %.3f at 60 s; locked %.1f s\n",
                b.at(1500 * MS) / 1e6, b.at(2500 * MS) / 1e6, b.at(60 * S) / 1e6, b.locked / 1e9);
    CHECK("start burst: on the seed until the second bucket closes, then on the floor the two agree on (1 ms)",
          b.at(1500 * MS) >= 490 * MS && iabs(b.at(2500 * MS)) <= 1 * MS && iabs(b.at(60 * S)) <= 1 * MS);
    CHECK("start burst: ... the lock as without a burst (within 40 s)", b.locked >= 0 && b.locked <= 40 * S);
    // A dip the second bucket does not confirm: the delay is back up from 0.6 s.
    const StartRun d = start_run(stc, 300 * MS, 0, 300 * MS, true);
    std::printf("  first-bucket dip, delay +300 ms again from 0.6 s: house - floor %.3f ms at 2.5 s\n",
                d.at(2500 * MS) / 1e6);
    CHECK("start burst: a first-bucket dip the second bucket does not confirm moves nothing (the acquire slew only)",
          d.at(2500 * MS) >= 294 * MS && d.at(2500 * MS) <= 301 * MS);
    // Below step_ns the acquire slew takes it, as before; past a relock the rule is off, but
    // for a burst past backlog_ns (test_backlog_floor).
    const StartRun s = start_run(stc, 15 * MS);
    CHECK("start burst: 15 ms (under step_ns) is slewed, no step (8 ms left at 2.5 s, on the floor by 20 s)",
          s.at(2500 * MS) >= 8 * MS && iabs(s.at(20 * S)) <= 1 * MS);
    const StartRun rl = start_run(stc, 400 * MS, 100 * S, 500 * MS, false, 100 * S, 120);
    const StartRun rl49 = start_run(stc, 490 * MS, 100 * S, 500 * MS, false, 100 * S, 120);
    const StartRun rl495 = start_run(stc, 495 * MS, 100 * S, 500 * MS, false, 100 * S, 120);
    std::printf("  burst after a relock at 100 s: house - floor %.3f ms at 102.5 s; 490 ms: %.3f ms (%.3f at 120 s); "
                "495 ms: %.3f ms (%.3f at 120 s)\n",
                rl.at(102500 * MS) / 1e6, rl49.at(102500 * MS) / 1e6, rl49.at(120 * S) / 1e6,
                rl495.at(102500 * MS) / 1e6, rl495.at(120 * S) / 1e6);
    CHECK("start burst: after a relock a burst under backlog_ns is the acquire slew's (the rule is the pipeline's start)",
          rl.at(102500 * MS) >= 380 * MS);
    // backlog_ns (B-48: 490 ms) takes only a floor more than that below: at the second close a
    // 490 ms burst's two buckets lie 489.4 and 490 ms under the slewed line, so it stays; a 495 ms
    // one's 494.4 and 495 ms, so it moves (at leap_ns's 500 ms it stayed too).
    CHECK("start burst: ... 490 ms too, at backlog_ns (still the acquire slew's at 120 s)",
          rl49.at(102500 * MS) >= 470 * MS && rl49.at(120 * S) >= 470 * MS);
    CHECK("start burst: ... but 495 ms, past it, moves onto the floor at the second bucket's close (1 ms)",
          iabs(rl495.at(102500 * MS)) <= 1 * MS && iabs(rl495.at(120 * S)) <= 1 * MS);
    // mrasrc's lock: its 50 ms step is the threshold.
    const StartRun a40 = start_run(asrc, 40 * MS), a80 = start_run(asrc, 80 * MS);
    CHECK("start burst: mrasrc's lock (50 ms step) slews 40 ms and moves onto the floor under 80 ms",
          a40.at(2500 * MS) >= 30 * MS && iabs(a80.at(2500 * MS)) <= 1 * MS);
    // The first pair moves only when both its buckets lie past step_ns below the line (B-48): the
    // seed 30 ms late, the first bucket on the floor, the second 12 ms above it. They agree, but the
    // second's floor is not past step_ns below: nothing moves, the acquire slew only.
    const StartRun two = [] {
        ClockLock lk;
        StartRun r;
        int64_t prev = INT64_MIN;
        for (int64_t k = 0; k * 100 * MS <= 10 * S; k++) {
            const int64_t t = k * 100 * MS;
            const int64_t floor_h = H0 + t + at_ppb(t, 50000) + 20 * MS;
            const int64_t extra = k == 0 ? 30 * MS : t >= 1100 * MS && t < 2100 * MS ? 12 * MS : 0;
            const int64_t h = std::max(prev, floor_h + extra + (k * 7919 % 30) * 100000);
            prev = h;
            lk.feed(7200 * S + t, h);
            r.off.push_back({t, lk.house_of(7200 * S + t) - floor_h});
        }
        return r;
    }();
    std::printf("  first pair 30 ms and 12 ms late: house - floor %.3f ms at 2.5 s\n", two.at(2500 * MS) / 1e6);
    CHECK("start burst: a first pair with only one bucket past step_ns below the line moves nothing (both must)",
          two.at(2500 * MS) >= 20 * MS && two.at(2500 * MS) <= 30 * MS);
    for (const StartRun* r : {&b, &d, &s, &rl, &rl49, &rl495, &a40, &a80, &two})
        for (const auto& o : r->off) g_all.add(o.second);
}

// A caller that queued (B-39): PCR at 10/s on a +50 ppm source, 0..2.9 ms of jitter above a
// 20 ms floor; what it sent from `at` waited `len`, then all sent until then arrived over
// `drain`, in order. With `relock_at` the lock relocks at that send (a reconnect's leap: the
// queue's first). Returns house(σ) - floor arrival and the floor gap the lock reports, by send time.
struct BacklogRun {
    std::vector<std::pair<int64_t, int64_t>> off, gap;
    int64_t locked = -1;
    int64_t at(int64_t t) const {
        for (const auto& o : off)
            if (o.first >= t) return o.second;
        return INT64_MIN;
    }
    int64_t gap_max(int64_t from, int64_t to) const {
        int64_t m = 0;
        for (const auto& g : gap)
            if (g.first >= from && g.first < to) m = std::max(m, g.second);
        return m;
    }
};

BacklogRun backlog_run(const ClockLockConfig& cfg, int64_t at, int64_t len, int64_t drain, int64_t relock_at = -1,
                       int64_t secs = 120) {
    ClockLock lk(cfg);
    BacklogRun r;
    int64_t prev = INT64_MIN;
    for (int64_t k = 0; k * 100 * MS <= secs * S; k++) {
        const int64_t t = k * 100 * MS;
        if (t == relock_at) lk.relock(true);
        const int64_t span = len + drain;
        const int64_t due =
            t >= at && t - at < span ? at + len + (int64_t)((__int128)(t - at) * drain / span) : t;
        const int64_t floor_h = H0 + t + at_ppb(t, 50000) + 20 * MS;
        const int64_t own = H0 + due + at_ppb(due, 50000) + 20 * MS + (k * 7919 % 30) * 100000;
        const int64_t h = std::max(prev, own);
        prev = h;
        lk.feed(7200 * S + t, h);
        r.off.push_back({t, lk.house_of(7200 * S + t) - floor_h});
        r.gap.push_back({t, lk.floor_gap_ns()});
        if (r.locked < 0 && lk.phase() == ClockLock::Phase::locked) r.locked = t;
    }
    return r;
}

void test_backlog_floor() {
    const ClockLockConfig stc, asrc = asrc_lock_config();
    // The pipeline starts on the backlog: the floor falls bucket by bucket while it drains.
    const BacklogRun f1 = backlog_run(stc, 0, 30 * S, 1 * S), f5 = backlog_run(stc, 0, 90 * S, 5 * S, -1, 160);
    std::printf("  backlog at the start: 30 s/1 s house - floor %.3f ms at 34 s, gap max %.0f ms in the drain; "
                "90 s/5 s %.3f ms at 98 s; locked %.1f / %.1f s\n",
                f1.at(34 * S) / 1e6, f1.gap_max(30 * S, 31 * S) / 1e6, f5.at(98 * S) / 1e6, f1.locked / 1e9,
                f5.locked / 1e9);
    CHECK("backlog floor: the first epoch waits while the floor falls, then moves onto it (1 ms) by 3 s after the drain",
          iabs(f1.at(34 * S)) <= 1 * MS && iabs(f1.at(120 * S)) <= 1 * MS && iabs(f5.at(98 * S)) <= 1 * MS &&
              iabs(f5.at(160 * S)) <= 1 * MS);
    CHECK("backlog floor: ... its floor gap shows the backlog (past 4 s in the drain), then 0 (1 ms)",
          f1.gap_max(30 * S, 31 * S) > 4 * S && f1.gap_max(34 * S, 120 * S) <= 1 * MS &&
              f5.gap_max(95 * S, 96 * S) > 4 * S && f5.gap_max(98 * S, 160 * S) <= 1 * MS);
    // The live floor is a candidate level for step_hold_ns, then 30 buckets fit it, then 5 s.
    CHECK("backlog floor: ... and locks as on a new level, within 50 s of the drain",
          f1.locked >= 0 && f1.locked <= 31 * S + 50 * S && f5.locked >= 0 && f5.locked <= 95 * S + 50 * S);
    const BacklogRun s3 = backlog_run(stc, 0, 3 * S, 2 * S);
    CHECK("backlog floor: a 3 s backlog drained in 2 s (under backlog_ns) is the first epoch's too (1 ms by 8 s)",
          iabs(s3.at(8 * S)) <= 1 * MS);
    // A reconnect on a running pipeline: the relock opens on the backlog's oldest sample.
    const BacklogRun r1 = backlog_run(stc, 60 * S, 30 * S, 1 * S, 60 * S, 160);
    const BacklogRun r5 = backlog_run(stc, 60 * S, 90 * S, 5 * S, 60 * S, 220);
    std::printf("  backlog after a relock: 30 s/1 s house - floor %.3f ms at 94 s; 90 s/5 s %.3f ms at 158 s\n",
                r1.at(94 * S) / 1e6, r5.at(158 * S) / 1e6);
    CHECK("backlog floor: after a relock a backlog past backlog_ns moves too, by 3 s after the drain (1 ms)",
          iabs(r1.at(94 * S)) <= 1 * MS && iabs(r1.at(160 * S)) <= 1 * MS && iabs(r5.at(158 * S)) <= 1 * MS);
    // Under lead_max_ns too: past leap_ns (500 ms) a reconnect's backlog relocks (D2), and backlog_ns
    // is 10 ms less, the most the acquire slew takes before the floor shows (B-48: at 500 ms a 505 ms
    // backlog drained in 2 s stayed 0.5 s early); under it the acquire slew keeps a relock's seed (B-37).
    const BacklogRun r3 = backlog_run(stc, 60 * S, 3 * S, 2 * S, 60 * S, 90);
    const BacklogRun r06 = backlog_run(stc, 60 * S, 600 * MS, 500 * MS, 60 * S, 90);
    const BacklogRun r505 = backlog_run(stc, 60 * S, 505 * MS, 2 * S, 60 * S, 90);
    const BacklogRun r04 = backlog_run(stc, 60 * S, 400 * MS, 500 * MS, 60 * S, 90);
    std::printf("  relock backlogs: 3 s/2 s house - floor %.3f ms at 67 s; 0.6 s/0.5 s %.3f ms at 64 s; "
                "0.505 s/2 s %.3f ms at 65 s; 0.4 s/0.5 s %.3f ms at 70 s\n",
                r3.at(67 * S) / 1e6, r06.at(64 * S) / 1e6, r505.at(65 * S) / 1e6, r04.at(70 * S) / 1e6);
    CHECK("backlog floor: after a relock 3 s and 0.6 s backlogs (past backlog_ns) move too, by 3 s after the drain (1 ms)",
          iabs(r3.at(67 * S)) <= 1 * MS && iabs(r3.at(90 * S)) <= 1 * MS && iabs(r06.at(64 * S)) <= 1 * MS &&
              iabs(r06.at(90 * S)) <= 1 * MS);
    CHECK("backlog floor: ... and a 0.505 s one drained in 2 s, within the acquire slew's 10 ms past leap_ns (1 ms)",
          iabs(r505.at(65 * S)) <= 1 * MS && iabs(r505.at(90 * S)) <= 1 * MS);
    CHECK("backlog floor: ... a 0.4 s one (under backlog_ns) stays the acquire slew's (380 ms left at 70 s)",
          r04.at(70 * S) >= 380 * MS);
    // mrasrc's lock has no backlog rule: its falls are envelope steps (part 4.5).
    const BacklogRun a1 = backlog_run(asrc, 60 * S, 30 * S, 1 * S, 60 * S, 100);
    CHECK("backlog floor: mrasrc's lock leaves it to its envelope step (29 s left 3 s after the drain)",
          a1.at(94 * S) >= 29 * S);
    for (const BacklogRun* r : {&f1, &f5, &s3, &r1, &r5, &r3, &r06, &r505, &r04, &a1})
        for (const auto& o : r->off) g_all.add(o.second);
}

// B-95: a PCR every pcr_ms on a 0 ppm source over a FIFO path whose floor delay steps as `sched`
// (ms from s on, fixture_gen's --delay-ms), net_delay's jitter above it; a step relocks as VirtualStc
// does. A move: past the first step, house_of(σ) - σ jumping over 10 ms between samples, no relock.
struct Seg {
    int64_t at_s, ms;
};

struct FallRun {
    struct Ev {
        int64_t t, v, lvl;   // send time; a step's jump of the mapping, or a move's; the line after it
    };
    std::vector<Ev> steps, moves;
    std::vector<std::pair<int64_t, int64_t>> lvl;   // (send time, the delay the line maps to)
    int64_t dev(int64_t from, int64_t floor) const {   // the line's farthest from `floor` from `from` on
        int64_t d = 0;
        for (const auto& p : lvl)
            if (p.first >= from) d = std::max(d, iabs(p.second - floor));
        return d;
    }
};

// A live set_step_fall_hold before the sample sent at or after at_ns, in order (the Smoothing Cooldown).
struct Hold {
    int64_t at_ns, hold_ns;
};

FallRun fall_run(std::vector<Seg> sched, int64_t secs, const ClockLockConfig& cfg = ClockLockConfig(),
                 int64_t pcr_ms = 60, uint64_t seed = 95, const std::vector<Hold>& live = {}) {
    std::stable_sort(sched.begin(), sched.end(), [](const Seg& a, const Seg& b) { return a.at_s < b.at_s; });
    ClockLock lk(cfg);
    Lcg g(seed);
    FallRun r;
    int64_t prev_h = INT64_MIN, prev_off = INT64_MIN;
    size_t li = 0;
    for (int64_t t = 0; t <= secs * S; t += pcr_ms * MS) {
        while (li < live.size() && t >= live[li].at_ns) lk.set_step_fall_hold(live[li++].hold_ns);
        int64_t floor = sched.front().ms;
        for (const Seg& s : sched)
            if (t >= s.at_s * S) floor = s.ms;
        const int64_t sigma = 7200 * S + t, h = std::max(prev_h, H0 + t + floor * MS + net_delay(g));
        prev_h = h;
        lk.feed(sigma, h);
        if (lk.envelope_step()) {
            const int64_t before = lk.house_of(sigma);
            lk.relock(true, true);
            lk.feed(sigma, h);
            r.steps.push_back({t, lk.house_of(sigma) - before, lk.house_of(sigma) - H0 - t});
        } else if (!r.steps.empty() && iabs(lk.house_of(sigma) - sigma - prev_off) > 10 * MS) {
            r.moves.push_back({t, lk.house_of(sigma) - sigma - prev_off, lk.house_of(sigma) - H0 - t});
        }
        prev_off = lk.house_of(sigma) - sigma;
        r.lvl.push_back({t, lk.house_of(sigma) - H0 - t});
    }
    return r;
}

void print_fall(const char* label, const FallRun& r) {
    std::printf("  %s:", label);
    for (const FallRun::Ev& e : r.steps)
        std::printf(" [step @%.2f s, the line %+.1f ms to %.1f ms]", e.t / 1e9, e.v / 1e6, e.lvl / 1e6);
    for (const FallRun::Ev& e : r.moves) std::printf(" [move @%.2f s %+.1f ms]", e.t / 1e9, e.v / 1e6);
    std::printf(" | the line at the end %.1f ms\n", r.lvl.back().second / 1e6);
}

// The usual level 300 ms; +200/+400 at 60/61 s (a ramp: a step, not a leap), 600 ms under that from 120 s.
std::vector<Seg> fall_at_120(std::vector<Seg> extra = {}) {
    std::vector<Seg> s = {{0, 300}, {60, 500}, {61, 700}, {120, 100}};
    s.insert(s.end(), extra.begin(), extra.end());
    return s;
}

bool within(int64_t t, int64_t lo, int64_t hi) { return t >= lo && t <= hi; }

void test_step_epoch() {
    // C1: TECH01's burst (+200/+400 for 12 s) and its dip (200 ms under the usual level for 11 s).
    const FallRun c1 = fall_run({{0, 300}, {60, 500}, {61, 700}, {72, 500}, {73, 100}, {84, 300}}, 150);
    print_fall("burst and dip (C1)", c1);
    CHECK("step epoch: a burst's dip is no backlog: one step 9-11 s into the rise, seeded 400-440 ms over the old "
          "floor, no move, no second step",
          c1.steps.size() == 1 && within(c1.steps[0].t, 69 * S, 71 * S) &&
              within(c1.steps[0].lvl - 300 * MS, 400 * MS, 440 * MS) && c1.moves.empty());
    // C2: a genuine fall after the step: shed once no run that could have stepped lies in the 300 s.
    const FallRun c2 = fall_run(fall_at_120(), 600);
    print_fall("a fall of 600 ms at 120 s (C2)", c2);
    CHECK("step epoch: a genuine fall is shed 300 s after its last high run: one move of -580..-620 ms at "
          "419-421.5 s, the line on the floor (20 ms) from 425 s",
          c2.steps.size() == 1 && c2.moves.size() == 1 && within(c2.moves[0].t, 419 * S, 421500 * MS) &&
              within(c2.moves[0].v, -620 * MS, -580 * MS) && c2.dev(425 * S, 100 * MS) <= 20 * MS);
    ClockLockConfig half;
    half.bucket_ns = 500 * MS;
    const FallRun c2h = fall_run(fall_at_120(), 600, half);
    print_fall("... at a 0.5 s bucket", c2h);
    CHECK("step epoch: the window is 300 s of house time at any bucket (0.5 s: the move at 419-421.5 s too)",
          c2h.steps.size() == 1 && c2h.moves.size() == 1 && within(c2h.moves[0].t, 419 * S, 421500 * MS) &&
              c2h.dev(425 * S, 100 * MS) <= 20 * MS);
    // C2b: a 3 s dip 100 ms under the floor in the window: L* is no window minimum.
    const FallRun c2b = fall_run(fall_at_120({{300, 0}, {303, 100}}), 600);
    print_fall("... and a 3 s dip at 300 s (C2b)", c2b);
    CHECK("step epoch: the landing is L*, not the window's minimum: the move at 419-421.5 s onto the floor "
          "(20 ms), no step after it",
          c2b.steps.size() == 1 && c2b.moves.size() == 1 && within(c2b.moves[0].t, 419 * S, 421500 * MS) &&
              c2b.dev(425 * S, 100 * MS) <= 20 * MS);
    // C3: 12 s bursts back to the stepped level every 100 s, ramped as TECH01's (an instant one is a leap).
    std::vector<Seg> b;
    for (int64_t t = 150; t <= 650; t += 100) b.insert(b.end(), {{t, 500}, {t + 1, 700}, {t + 12, 100}});
    const FallRun c3 = fall_run(fall_at_120(b), 700);
    print_fall("... and a 12 s burst every 100 s (C3)", c3);
    CHECK("step epoch: a burst in the window keeps the line: one step, no move through 700 s",
          c3.steps.size() == 1 && c3.moves.empty());
    // C4: 3 s spikes to 900 ms every 60 s: shorter than a run, so no hold.
    std::vector<Seg> sp;
    for (int64_t t = 150; t <= 690; t += 60) sp.insert(sp.end(), {{t, 900}, {t + 3, 100}});
    const FallRun c4 = fall_run(fall_at_120(sp), 700);
    print_fall("... and a 3 s spike every 60 s (C4)", c4);
    CHECK("step epoch: a short rise is tolerated lateness: the move at 419-421.5 s onto the floor (20 ms)",
          c4.steps.size() == 1 && c4.moves.size() == 1 && within(c4.moves[0].t, 419 * S, 421500 * MS) &&
              c4.dev(425 * S, 100 * MS) <= 20 * MS);
    // C5: ov700's ramped bursts (200 -> 900 over 6 s, back over 6 s, a 30 ms dip of 11 s) every 170 s.
    std::vector<Seg> ov = {{0, 200}};
    for (int64_t t = 100; t < 1800; t += 170)
        ov.insert(ov.end(), {{t, 400}, {t + 2, 600}, {t + 4, 800}, {t + 6, 900}, {t + 14, 700}, {t + 16, 500},
                             {t + 18, 300}, {t + 20, 30}, {t + 31, 200}});
    const FallRun c5 = fall_run(ov, 1800, ClockLockConfig(), 2000), c5d = fall_run(ov, 1800);
    print_fall("ov700 bursts every 170 s, a 2 s PCR (C5)", c5);
    print_fall("... a 60 ms PCR", c5d);
    CHECK("step epoch: a sparse PCR counts time, not buckets: one step (110 s), no move in 1800 s; at 60 ms alike",
          c5.steps.size() == 1 && iabs(c5.steps[0].t - 110 * S) <= 1500 * MS && c5.moves.empty() &&
              c5d.steps.size() == 1 && c5d.moves.empty());
    // Any other relock (a leap, a discontinuity, a degraded entry, an external one) keeps the backlog
    // rule: test_backlog_floor's relocks.
    ClockLock lk;
    lk.relock(true);
    const bool plain = !lk.after_step();
    lk.relock(true, true);
    CHECK("step epoch: only a step's relock seeds one (after_step); relock(keep_rate) alone does not",
          plain && lk.after_step());
    for (const FallRun* r : {&c1, &c2, &c2h, &c2b, &c3, &c4, &c5, &c5d})
        for (const auto& p : r->lvl) g_all.add(p.second);
}

// The hold set live (an ingest's Smoothing Cooldown, b95s), on test_step_epoch's paths.
void test_live_hold() {
    // A shorter hold acts from the next close: C2's fall, the hold 300 -> 60 s at 250 s.
    const FallRun d = fall_run(fall_at_120(), 600, ClockLockConfig(), 60, 95, {{250 * S, 60 * S}});
    print_fall("C2's fall, the hold 300 -> 60 s at 250 s", d);
    CHECK("live hold: a shorter hold acts at the next close: C2's fall shed at 250-251.5 s (not 420 s), one move "
          "of -580..-620 ms, the line on the floor (20 ms) from 255 s",
          d.steps.size() == 1 && d.moves.size() == 1 && within(d.moves[0].t, 250 * S, 251500 * MS) &&
              within(d.moves[0].v, -620 * MS, -580 * MS) && d.dev(255 * S, 100 * MS) <= 20 * MS);
    // A longer one waits for its own span: a 30 s hold kept up by 12 s bursts every 25 s to 312 s, the hold
    // 120 s at 310 s; the last burst's run (to 311 s) then holds the line until 431 s.
    ClockLockConfig h30;
    h30.step_fall_hold_ns = 30 * S;
    std::vector<Seg> b25;
    for (int64_t t = 125; t <= 300; t += 25) b25.insert(b25.end(), {{t, 500}, {t + 1, 700}, {t + 12, 100}});
    const FallRun i0 = fall_run(fall_at_120(b25), 600, h30);
    const FallRun i = fall_run(fall_at_120(b25), 600, h30, 60, 95, {{310 * S, 120 * S}});
    print_fall("a 30 s hold and bursts every 25 s to 312 s", i0);
    print_fall("... the hold 30 -> 120 s at 310 s", i);
    CHECK("live hold: at 30 s the bursts every 25 s hold the line, the fall shed 30 s after the last (342-344 s)",
          i0.steps.size() == 1 && i0.moves.size() == 1 && within(i0.moves[0].t, 342 * S, 344 * S));
    CHECK("live hold: a longer hold never moves on a shorter history: the last burst's run holds the line 120 s, "
          "one move at 431-433.5 s onto the floor (20 ms)",
          i.steps.size() == 1 && i.moves.size() == 1 && within(i.moves[0].t, 431 * S, 433500 * MS) &&
              within(i.moves[0].v, -620 * MS, -580 * MS) && i.dev(440 * S, 100 * MS) <= 20 * MS);
    // 0 is the backlog rule from the next close; a hold again starts the window afresh. C1's burst and
    // dip at 60 s and again at 160 s, the hold 0 at 71 s (after the step), 300 s at 100 s.
    const std::vector<Seg> two = {{0, 300},   {60, 500},  {61, 700},  {72, 500},  {73, 100}, {84, 300},
                                  {160, 500}, {161, 700}, {172, 500}, {173, 100}, {184, 300}};
    const FallRun z0 = fall_run(two, 300);
    const FallRun z = fall_run(two, 300, ClockLockConfig(), 60, 95, {{71 * S, 0}, {100 * S, 300 * S}});
    print_fall("C1's burst and dip at 60 and 160 s", z0);
    print_fall("... the hold 0 at 71 s, 300 s at 100 s", z);
    CHECK("live hold: at 300 s C1's two bursts give one step, no move (the second at the line's height)",
          z0.steps.size() == 1 && z0.moves.empty());
    CHECK("live hold: 0 is the backlog rule at the dip's second close: a move of -580..-620 ms at 74-76 s and "
          "the pair's second step (93-95 s); 300 s again from 100 s: the next burst steps (169-171 s), its dip held",
          z.steps.size() == 3 && within(z.steps[1].t, 93 * S, 95 * S) && within(z.steps[2].t, 169 * S, 171 * S) &&
              z.moves.size() == 1 && within(z.moves[0].t, 74 * S, 76 * S) &&
              within(z.moves[0].v, -620 * MS, -580 * MS));
    // Off and on again between two closes: the window starts afresh, so C2's fall is shed 300 s later.
    const FallRun o = fall_run(fall_at_120(), 700, ClockLockConfig(), 60, 95, {{250 * S, 0}, {250 * S, 300 * S}});
    print_fall("C2's fall, the hold 0 and back to 300 s at 250 s", o);
    CHECK("live hold: a hold back from 0 starts its window afresh, between two closes too: C2's fall shed at "
          "549-551.5 s (not 420 s)",
          o.steps.size() == 1 && o.moves.size() == 1 && within(o.moves[0].t, 549 * S, 551500 * MS));
    // The constructor's bound applies to a live value: 0-10,000 s, and 100,000 buckets of history.
    ClockLock lk;
    lk.set_step_fall_hold(20000 * S);
    const int64_t hi = lk.config().step_fall_hold_ns;
    lk.set_step_fall_hold(-1);
    const int64_t lo = lk.config().step_fall_hold_ns;
    ClockLockConfig fine;
    fine.bucket_ns = 1 * MS;
    ClockLock lf(fine);
    const int64_t built = lf.config().step_fall_hold_ns;
    lf.set_step_fall_hold(3600 * S);
    CHECK("live hold: clamped as the constructor clamps: 20,000 s -> 10,000 s, -1 -> 0; at 1 ms buckets 300 s and "
          "3,600 s -> 89.998 s (99,998 buckets less the 10 s run)",
          hi == 10000 * S && lo == 0 && built == 89998 * MS && lf.config().step_fall_hold_ns == 89998 * MS);
    for (const FallRun* r : {&d, &i0, &i, &z0, &z, &o})
        for (const auto& p : r->lvl) g_all.add(p.second);
}

// --- B-100: the first fit on a scattered delivery ---------------------------------

// TECH01's 150 s delivery cycle in outline, stretched to p s, from `phase` s into it, in µs: a two-hump
// rise to +h ms over 17 s, the floor 150 ms under the usual level for 6 s, a hump to +h/2 at 31 s, a dip
// and spike at 90 s, a dip at 120 s. Knots: ms of the outline, per mille of h, ms; p 0: none.
int64_t cycle_us(int64_t t, int64_t p, int64_t h, int64_t phase) {
    if (p <= 0) return 0;
    static const int64_t k[][3] = {{0, 300, 0},      {2500, 800, 0},   {4000, 0, -130},   {6000, 400, 0},
                                   {16000, 1000, 0}, {18000, 500, 0},  {20000, 0, -150},  {26000, 0, -150},
                                   {28000, 0, 0},    {31000, 500, 0},  {34000, 500, 0},   {36000, 0, 0},
                                   {89000, 0, 50},   {91000, 0, -140}, {93000, 900, 0},   {95500, 900, 0},
                                   {97000, 0, 0},    {120000, 0, 50},  {122000, 0, -140}, {124000, 0, 0},
                                   {149900, 0, 100}, {150000, 300, 0}};
    const int64_t ph = (t + phase * S) % (p * S) / 1000 * 150 / p;   // µs of the outline
    for (size_t i = 0; i + 1 < sizeof k / sizeof k[0]; i++) {
        const int64_t f0 = k[i][0] * 1000, f1 = k[i + 1][0] * 1000;
        if (ph < f0 || ph > f1) continue;
        const int64_t a = k[i][1] * h + k[i][2] * 1000, b = k[i + 1][1] * h + k[i + 1][2] * 1000;
        return a + (b - a) * (ph - f0) / (f1 - f0);
    }
    return 0;
}

// One draw per second of send time, the same on every machine.
uint64_t sec_mix(int64_t sec, uint64_t salt) {
    uint64_t x = (uint64_t)sec * 0x9E3779B97F4A7C15ULL + salt;
    x ^= x >> 29;
    x *= 0xBF58476D1CE4E5B9ULL;
    x ^= x >> 32;
    return x;
}

// A bursty relay's delivery (TECH01's 1 s minima scatter with an IQR of 105-115 ms): per second a level in
// 0..w ms, or a dense floor edge (the floor on floor_pct % of the seconds, lo..hi ms above it on the rest),
// plus the cycle (p s, h ms, from `phase` s), on 150 ms of base delay.
struct Scatter {
    int64_t w = 200;
    int floor_pct = 0;
    int64_t lo = 0, hi = 0;
    int64_t p = 150, h = 400, phase = 0;
    int64_t delay(int64_t t) const {
        const int64_t sec = t / S;
        int64_t lvl = 0;
        if (floor_pct > 0) {
            if ((int)(sec_mix(sec, 0x12345) % 100) >= floor_pct)
                lvl = lo + (int64_t)(sec_mix(sec, 0x6789) % (uint64_t)(hi - lo + 1));
        } else if (w > 0) {
            lvl = (int64_t)(sec_mix(sec, 0x12345) % (uint64_t)(w + 1));
        }
        return (150 + lvl) * MS + cycle_us(t, p, h, phase) * 1000;
    }
};

// ClockLock alone on a Scatter, the source at ppm (the lock reads it), the PCR every pcr_ms, each arrival
// its own (0..5 ms of jitter); relock(true, true) at an envelope step as the PCR lock does, relock(true) at
// relock_at s.
struct FitRun {
    int64_t lock = -1, first_fit = -1;          // send times
    int64_t ppb_lock = 0, ppb_600 = 0, ppb_end = 0;
    int steps = 0;
    int on = 0, since = 0;                      // the level's share at the last close before the first fit
    int hi_on = 0, hi_since = 1;                // its largest from 30 s to the first fit
    int64_t jump = 0, jump_at = -1;             // the largest ε move between closes after the first fit
                                                // where the level held under half
    bool relocked = false, locked_end = false;
    int64_t kept = 0, refit_at = -1, refit_raw = 0, refit_dev = 0;   // relock_at: the kept ε; the next fit,
    int refit_on = 0, refit_since = 0;          // its share and the ε's largest move off kept within 100 s
};

FitRun fit_run(const Scatter& sh, int64_t ppm, int64_t pcr_ms, int64_t secs, int64_t relock_at = -1) {
    ClockLock lk;
    Lcg g(5);
    FitRun r;
    int64_t last_ppb = 0;
    for (int64_t t = 0; t <= secs * S; t += pcr_ms * MS) {
        const int64_t sigma = 7200 * S + t;
        const int64_t jit = (int64_t)(g.next() % 5001) * 1000;
        const int64_t h = H0 + t + at_ppb(t, ppm * 1000) + 20 * MS + sh.delay(t) + jit;
        if (relock_at >= 0 && !r.relocked && t >= relock_at * S) {
            r.relocked = true;
            r.kept = lk.ppb();
            lk.relock(true);
        }
        lk.feed(sigma, h);
        if (lk.envelope_step()) {
            r.steps++;
            lk.relock(true, true);
            lk.feed(sigma, h);
        }
        int on = 0, since = 0;
        lk.level_share(&on, &since);
        const int64_t ppb = lk.ppb();
        if (r.first_fit < 0 && lk.has_fit()) {
            r.first_fit = t;
        } else if (r.first_fit < 0) {
            r.on = on;
            r.since = since;
            if (t >= 30 * S && (int64_t)on * r.hi_since > (int64_t)r.hi_on * since) {
                r.hi_on = on;
                r.hi_since = since;
            }
        } else if (ppb != last_ppb && on * 2 < since && iabs(ppb - last_ppb) > r.jump) {
            r.jump = iabs(ppb - last_ppb);
            r.jump_at = t;
        }
        if (r.relocked && r.refit_at < 0 && lk.has_fit()) {
            r.refit_at = t;
            r.refit_raw = lk.fit_ppb();
            r.refit_on = on;
            r.refit_since = since;
        }
        if (r.refit_at >= 0 && t <= r.refit_at + 100 * S) r.refit_dev = std::max(r.refit_dev, iabs(ppb - r.kept));
        if (r.lock < 0 && lk.phase() == ClockLock::Phase::locked) {
            r.lock = t;
            r.ppb_lock = ppb;
        }
        if (t == 600 * S) r.ppb_600 = ppb;
        last_ppb = ppb;
        g_all.add(ppb);
    }
    r.ppb_end = lk.ppb();
    r.locked_end = lk.phase() == ClockLock::Phase::locked;
    return r;
}

void print_fit(const char* label, const FitRun& r) {
    std::printf("  %s: first fit %.2f s, locked %.2f s at %.3f ppm (600 s %.3f, end %.3f), %d step(s); the level's "
                "share before the first fit %d/%d, its largest from 30 s %d/%d; the largest scattered move %.3f ppm "
                "at %.2f s",
                label, r.first_fit / 1e9, r.lock / 1e9, r.ppb_lock / 1000.0, r.ppb_600 / 1000.0, r.ppb_end / 1000.0,
                r.steps, r.on, r.since, r.hi_on, r.hi_since, r.jump / 1000.0, r.jump_at / 1e9);
    if (r.relocked)
        std::printf("; kept %.3f ppm, the next fit at %.2f s (raw %.3f, the level %d/%d), within %.3f ppm of the "
                    "kept for 100 s",
                    r.kept / 1000.0, r.refit_at / 1e9, r.refit_raw / 1000.0, r.refit_on, r.refit_since,
                    r.refit_dev / 1000.0);
    std::printf("; %s at the end\n", r.locked_end ? "locked" : "not locked");
}

void test_first_fit() {
    // 1. TECH01's shape at +50 ppm: a level a burst or a dip opened holds a few % of the buckets.
    const Scatter bursty;
    const FitRun a = fit_run(bursty, 50, 60, 700);
    print_fit("0..200 ms a second, TECH01's cycle at 400 ms, phase 0 s, +50 ppm", a);
    CHECK("first fit: a scattered delivery's level waits for the full window (the first fit at 300 s of house "
          "time) and fits on its densest band, locked 5 s later",
          within(a.first_fit, 299500 * MS, 301 * S) && within(a.lock, 304 * S, 306 * S));
    CHECK("first fit: ... its level held under 15 % of the buckets since it opened at every close from 30 s, and "
          "had 30 points before the window (the wait held the fit, not a want of points)",
          a.hi_on * 100 < 15 * a.hi_since && a.on >= 30);
    CHECK("first fit: ... the rate within the 100 ppm alarm bound at the lock; locked at 700 s after one "
          "envelope-step relock",
          iabs(a.ppb_lock) < 100000 && a.steps == 1 && a.locked_end);
    // The band is a horizontal slice of a scatter wider than itself: it reads the floor, not the clock.
    const FitRun a100 = fit_run(bursty, 100, 60, 700);
    print_fit("... +100 ppm", a100);
    CHECK("first fit: ... at +100 ppm the band reads within 40 ppm of zero, the alarm silent (B-100's known limit)",
          within(a100.lock, 304 * S, 306 * S) && iabs(a100.ppb_lock) <= 40000 && iabs(a100.ppb_end) <= 40000);
    // 2. From the dip's floor (the chained level 4 of 299 at the window) and from the usual level.
    bool phases = true;
    for (const int64_t ph : {20, 60}) {
        Scatter s;
        s.phase = ph;
        const FitRun b = fit_run(s, 50, 60, 700);
        char lab[96];
        std::snprintf(lab, sizeof lab, "... phase %lld s", (long long)ph);
        print_fit(lab, b);
        phases &= within(b.lock, 304 * S, 306 * S) && iabs(b.ppb_lock) < 100000 && b.locked_end;
        if (ph == 20) phases &= b.on < 30;
    }
    CHECK("first fit: ... from the dip's floor (a chained level of 4 buckets: the re-seed fits) and from the "
          "usual level too: locked at 304-306 s, within the alarm bound",
          phases);
    // 1b. A dense floor edge: 40 % of the seconds on the floor, the rest 50-250 ms above, no cycle.
    bool edge = true;
    for (const int64_t ppm : {-50, -150}) {
        Scatter s;
        s.floor_pct = 40;
        s.lo = 50;
        s.hi = 250;
        s.p = 0;
        const FitRun e = fit_run(s, ppm, 60, 600);
        char lab[96];
        std::snprintf(lab, sizeof lab, "the floor on 40 %% of the seconds, 50-250 ms on the rest, %lld ppm",
                      (long long)ppm);
        print_fit(lab, e);
        edge &= iabs(e.ppb_lock - ppm * 1000) <= 8000 && iabs(e.ppb_600 - ppm * 1000) <= 1000 &&
                e.first_fit >= 299 * S && e.on * 2 < e.since;
    }
    CHECK("first fit: the band reads the clock where the floor has a dense edge: within 8 ppm at the lock and 1 ppm "
          "at 600 s, at -50 and -150 ppm (the floor seconds under half here: the window's band)",
          edge);
    // 1c. 0..120 ms a second: the level holds a third, so half waits where a fifth would fit at 30 points.
    Scatter w120;
    w120.w = 120;
    w120.p = 0;
    const FitRun c = fit_run(w120, 50, 60, 600);
    print_fit("0..120 ms a second, no cycle, +50 ppm", c);
    CHECK("first fit: half, not a fifth: 0..120 ms a second holds a fifth to a half of its buckets from 30 s, so "
          "it waits: locked at 303-308 s within the alarm bound",
          c.hi_on * 2 < c.hi_since && c.on * 5 >= c.since && within(c.lock, 303 * S, 308 * S) &&
              iabs(c.ppb_lock) < 100000);
    Scatter w120c = w120;
    w120c.p = 150;
    const FitRun cc = fit_run(w120c, 50, 60, 600);
    print_fit("0..120 ms a second, the cycle, +50 ppm", cc);
    CHECK("first fit: ... and with TECH01's cycle at that width: locked at 303-308 s within the alarm bound",
          within(cc.lock, 303 * S, 308 * S) && iabs(cc.ppb_lock) < 100000);
    // 3. A clean level is never scattered: its fit at 30 buckets, as before B-100.
    Scatter clean;
    clean.w = 0;
    clean.p = 0;
    const FitRun d = fit_run(clean, 50, 60, 300);
    print_fit("a clean level, +50 ppm", d);
    CHECK("first fit: a clean level fits at 30 buckets (30 s) and locks at 35 s, the source's rate +-1 ppm at 300 s",
          within(d.first_fit, 29 * S, 31 * S) && within(d.lock, 34 * S, 36 * S) && d.on == d.since &&
              iabs(d.ppb_end - 50000) <= 1000);
    // 11. A 2 s PCR: 150 buckets in 300 s, the window still 300 s of house time.
    Scatter sp;
    sp.p = 0;
    const FitRun f = fit_run(sp, -50, 2000, 700);
    print_fit("a 2 s PCR, 0..200 ms a second, -50 ppm", f);
    CHECK("first fit: a sparse scattered delivery locks at 300 s of house time (150 buckets at a 2 s PCR), within "
          "the alarm bound",
          within(f.first_fit, 299 * S, 304 * S) && within(f.lock, 305 * S, 312 * S) && f.since <= 150 &&
              iabs(f.ppb_lock) < 100000);
}

// KEEP (B-100): once a rate is known, a scattered level's fit on no more points than it pulls it.
void test_first_fit_keep() {
    Scatter w120;
    w120.w = 120;
    w120.p = 0;
    const FitRun a = fit_run(w120, 50, 60, 900, 400);
    print_fit("0..120 ms a second, no cycle, a relock(true) at 400 s", a);
    CHECK("relock: a scattered level's fit on no more points pulls the rate, it does not replace it: the relock "
          "epoch's chained 30-point fit lies over 20 ppm off the kept rate, the rate within 5 ppm of it for 100 s",
          a.refit_at >= 0 && a.refit_on * 2 < a.refit_since && iabs(a.refit_raw - a.kept) > 20000 &&
              a.refit_dev <= 5000);
    // The first epoch: the band's later fits as the window slides, on no more points than the rate in force.
    const FitRun e = fit_run(w120, 50, 60, 900);
    print_fit("0..120 ms a second, no cycle, no relock (the first epoch)", e);
    Scatter b80;
    b80.phase = 80;
    const FitRun e80 = fit_run(b80, 50, 60, 900);
    print_fit("TECH01's shape, phase 80 s, no relock", e80);
    CHECK("relock: ... in the first epoch too: no move over 20 ppm between closes after the first fit while the "
          "level holds under half (0..120 ms a second, TECH01's shape at phase 80 s)",
          e.first_fit >= 0 && e.jump <= 20000 && e80.first_fit >= 0 && e80.jump <= 20000);
    // Controls: a level that holds half is judged as before B-100; TECH01's relock epoch never reaches 30 points.
    Scatter w30;
    w30.w = 30;
    w30.p = 0;
    const FitRun h = fit_run(w30, 50, 60, 900, 400);
    print_fit("0..30 ms a second (the level holds half), a relock(true) at 400 s", h);
    CHECK("relock: ... a level that holds half its buckets after a relock: its fit off by over 20 ppm replaces "
          "the rate, as before B-100",
          h.refit_at >= 0 && h.refit_on * 2 >= h.refit_since && iabs(h.refit_raw - h.kept) > 20000 &&
              h.refit_dev > 100000);
    const Scatter bursty;
    const FitRun b = fit_run(bursty, 50, 60, 700, 400);
    print_fit("TECH01's shape, phase 0 s, a relock(true) at 400 s", b);
    CHECK("relock: ... on TECH01's shape the relock epoch's chained level never has 30 points in 300 s: no fit, "
          "the kept rate to the end",
          b.relocked && b.refit_at < 0 && b.ppb_end == b.kept);
}

// --- PcrValidator, row by row ------------------------------------------------------

struct VRun {
    int leaps = 0, discs = 0, fails = 0;
    int64_t fail_at = -1;
    PcrValidator::Reason reason = PcrValidator::Reason::none;
    bool warned = false;
};

// PCR every `pcr_ms` (σ = t + pcr_off(t), DI per di(t)), other packets every 20 ms unless
// silent(t); rate and leads as given: lead(t) the source's over its PCR, against arrival that
// less the delay and lag(t), a late delivery's. Times are ns from 0.
auto no_lag = [](int64_t) { return (int64_t)0; };
template <class Off, class Di, class Silent, class Rate, class LeadF, class LagF = decltype(no_lag)>
VRun vrun(const PcrValidatorConfig& cfg, int64_t secs, int64_t pcr_ms, Off pcr_off, Di di, Silent silent,
          Rate rate, LeadF lead, LagF lag = no_lag) {
    PcrValidator v(cfg);
    VRun r;
    Lcg g(3);
    const int64_t pcr_every = pcr_ms * MS;
    for (int64_t t = 0; t <= secs * S; t += 4 * MS) {
        const int64_t d = net_delay(g);
        if (silent(t)) continue;
        const int64_t h = 1000 * S + t;
        if (t % (20 * MS) == 0) {
            v.feed_activity(h + d / 4);
            const int64_t ld = lead(t);
            if (ld != INT64_MIN) {
                v.feed_lead(0x100, ld - d - lag(t), ld);
                v.feed_lead(0x101, ld - 300 * MS - d - lag(t), ld - 300 * MS);
            }
        }
        if (pcr_every > 0 && t % pcr_every == 0) {
            const PcrValidator::Verdict vd = v.feed_pcr(ns_to_pcr27(3600 * S + t + pcr_off(t)), di(t), h + d);
            if (vd == PcrValidator::Verdict::leap) r.leaps++;
            if (vd == PcrValidator::Verdict::discontinuity) r.discs++;
            const int64_t rt = rate(t);
            if (rt != INT64_MIN) v.feed_rate(rt, h + d);
            r.warned |= v.cadence_warning();
        }
        if (v.failed() && r.fail_at < 0) {
            r.fail_at = t;
            r.reason = v.reason();
            r.fails++;
        }
    }
    return r;
}

auto no_off = [](int64_t) { return (int64_t)0; };
auto no_di = [](int64_t) { return false; };
auto never = [](int64_t) { return false; };
auto rate_30 = [](int64_t) { return (int64_t)30000; };
auto leads_ok = [](int64_t) { return 600 * MS + 300 * MS; };   // PID 0x100 900 ms, 0x101 600 ms

bool clean(const VRun& r) { return r.fails == 0 && r.leaps == 0 && r.discs == 0; }

// B-86's hand loops: a packet every 20 ms to `secs`, at t a PCR of σ pcr(t) (INT64_MIN: none)
// arriving t + jit(t); at(t, v) after each step.
auto no_jit = [](int64_t) { return (int64_t)0; };
template <class P, class J, class A>
void hand(PcrValidator& v, int64_t secs, P pcr, J jit, A at) {
    for (int64_t t = 0; t <= secs * S; t += 20 * MS) {
        const int64_t s = pcr(t);
        if (s != INT64_MIN) v.feed_pcr(ns_to_pcr27(s), false, t + jit(t));
        v.feed_activity(t);
        at(t, v);
    }
}

// What a hand loop showed: the first failure, the warning's first and last packet, the cadence's
// range from `from` on.
struct Seen {
    int64_t fail_at = -1, gap_at_fail = 0, warn_from = -1, warn_last = -1;
    int64_t cad_lo = INT64_MAX, cad_hi = INT64_MIN;
    void see(int64_t t, const PcrValidator& v, int64_t from = 0) {
        if (fail_at < 0 && v.failed()) {
            fail_at = t;
            gap_at_fail = v.pcr_gap_max_ns();
        }
        if (v.cadence_warning()) {
            if (warn_from < 0) warn_from = t;
            warn_last = t;
        }
        if (t < from) return;
        cad_lo = std::min(cad_lo, v.pcr_cadence_ns());
        cad_hi = std::max(cad_hi, v.pcr_cadence_ns());
    }
};

// A PCR on the grid `every` and at the extra times, none in the gaps ([from, to)) nor from `stop`.
auto grid(int64_t every, int64_t stop = INT64_MAX, std::vector<std::pair<int64_t, int64_t>> gaps = {},
          std::vector<int64_t> extra = {}) {
    return [=](int64_t t) {
        if (t >= stop) return INT64_MIN;
        for (const auto& g : gaps)
            if (t >= g.first && t < g.second) return INT64_MIN;
        if (t % every == 0) return t;
        for (const int64_t x : extra)
            if (t == x) return t;
        return INT64_MIN;
    };
}

void test_validator() {
    using R = PcrValidator::Reason;
    const PcrValidatorConfig def;
    {
        const VRun r = vrun(def, 120, 100, no_off, no_di, never, rate_30, leads_ok);
        CHECK("validator: a clean 120 s stream fails no row, warns no cadence", clean(r) && !r.warned);
    }
    // Cadence (B-86): the PCR judged against its own cadence.
    {
        const VRun r = vrun(def, 60, 600, no_off, no_di, never, rate_30, leads_ok);
        PcrValidator v(def);
        int64_t cad = -1, late = -1;
        hand(v, 2, grid(600 * MS), no_jit, [&](int64_t t, PcrValidator& x) {
            if (t != 600 * MS) return;
            cad = x.pcr_cadence_ns();
            late = x.late_ns();
        });
        CHECK("cadence: a steady 600 ms PCR passes, no warning; cadence 600 ms (late at 1.2 s) from its second PCR",
              clean(r) && !r.warned && cad == 600 * MS && late == 1200 * MS);
    }
    {
        const VRun r = vrun(def, 120, 200, no_off, no_di, never, rate_30, leads_ok);
        CHECK("cadence: a steady 200 ms PCR passes, no warning", clean(r) && !r.warned);
    }
    {
        auto gap = [](int64_t t) { return t >= 10 * S && t < 13 * S; };
        const VRun r = vrun(def, 60, 100, no_off, no_di, gap, rate_30, leads_ok);
        CHECK("cadence: a 3 s outage (nothing arrives) is not a PCR fault", clean(r) && !r.warned);
    }
    for (int64_t every : {500 * MS, 520 * MS}) {   // steady: late only past twice its cadence
        PcrValidator v(def);
        bool warned = false;
        for (int64_t t = 0; t <= 20 * S; t += 20 * MS) {
            if (t % every == 0) v.feed_pcr(ns_to_pcr27(t), false, t);
            v.feed_activity(t);
            warned |= v.cadence_warning();
        }
        CHECK(every == 500 * MS ? "cadence: PCR every 500 ms exactly passes" : "cadence: every 520 ms passes too",
              !v.failed() && !warned);
    }
    for (int64_t gap : {500 * MS, 520 * MS}) {   // on a 100 ms PCR (late at 500 ms) the boundary passes
        PcrValidator v(def);
        bool warned = false;
        for (int64_t t = 0, next = 0; t <= 20 * S; t += 20 * MS) {
            if (t == next) {
                v.feed_pcr(ns_to_pcr27(t), false, t);
                next = t + (t == 10 * S ? gap : 100 * MS);
            }
            v.feed_activity(t);
            warned |= v.cadence_warning();
        }
        CHECK(gap == 500 * MS ? "cadence: on a 100 ms PCR one interval of exactly 500 ms is on time"
                              : "cadence: ... one of 520 ms is late: the warning, no failure",
              !v.failed() && warned == (gap != 500 * MS));
    }
    {
        PcrValidator v(def);
        int64_t fail_at = -1;
        for (int64_t t = 0; t <= 10 * S; t += 20 * MS) {
            if (t <= 2 * S && t % (100 * MS) == 0) v.feed_pcr(ns_to_pcr27(t), false, t);
            v.feed_activity(t);
            if (v.failed() && fail_at < 0) fail_at = t;
        }
        CHECK("cadence: PCR stops while packets flow: fails 1.5 s after the last PCR",
              v.reason() == R::cadence && fail_at >= 3500 * MS && fail_at <= 3520 * MS);
    }
    // B-86: sparse PCRs. A steady one is on time at any cadence up to the cap's half.
    {
        PcrValidator v(def);
        Seen w;
        hand(v, 120, grid(2 * S), no_jit, [&](int64_t t, PcrValidator& x) { w.see(t, x, 2 * S); });
        CHECK("cadence: a steady 2 s PCR (vMix's) never fails or warns; cadence 2 s, late at 4 s",
              w.fail_at < 0 && w.warn_from < 0 && w.cad_lo == 2 * S && w.cad_hi == 2 * S && v.late_ns() == 4 * S);
    }
    {
        // The clip's loop: an extra IDR 60 ms after the PCRs at 20 s and 40 s; arrivals jittered,
        // so a cadence learned at arrival would not read 2 s exactly.
        Lcg g(9);
        auto jit = [&](int64_t) { return (int64_t)(g.next() % 16) * MS; };
        PcrValidator v(def);
        Seen w;
        hand(v, 60, grid(2 * S, INT64_MAX, {}, {20060 * MS, 40060 * MS}), jit,
             [&](int64_t t, PcrValidator& x) { w.see(t, x, 2 * S); });
        CHECK("cadence: the loop step (60 ms, then 1.94 s) under jittered arrival: clean, cadence exactly 2 s throughout",
              w.fail_at < 0 && w.warn_from < 0 && w.cad_lo == 2 * S && w.cad_hi == 2 * S);
    }
    {
        // Scene cuts: an extra IDR 0.4 s after every second PCR (0.4, 1.6, 2.0 s ...): the longest.
        std::vector<int64_t> cuts;
        for (int64_t t = 4 * S; t < 60 * S; t += 4 * S) cuts.push_back(t + 400 * MS);
        PcrValidator v(def);
        Seen w;
        hand(v, 60, grid(2 * S, INT64_MAX, {}, cuts), no_jit, [&](int64_t t, PcrValidator& x) { w.see(t, x, 2 * S); });
        CHECK("cadence: scene cuts under a 2 s keyint (0.4, 1.6, 2.0 s): never late, cadence 2 s (the longest)",
              w.fail_at < 0 && w.warn_from < 0 && w.cad_lo == 2 * S && w.cad_hi == 2 * S);
    }
    {
        PcrValidator v(def);
        Seen w;
        hand(v, 60, grid(2 * S, 20 * S + 1), no_jit, [&](int64_t t, PcrValidator& x) { w.see(t, x); });
        CHECK("cadence: a 2 s PCR that stops after 20 s: the warning at 24 s (late at 4 s), failed at 32 s, gap 12 s",
              w.warn_from >= 24 * S && w.warn_from <= 24020 * MS && w.fail_at >= 32 * S && w.fail_at <= 32020 * MS &&
                  v.reason() == R::cadence && w.gap_at_fail >= 12 * S && w.gap_at_fail <= 12020 * MS);
        PcrValidatorConfig floor_only = def;
        floor_only.pcr_interval_cap_ns = 500 * MS;   // the cap at the floor: the row before B-86
        PcrValidator f(floor_only);
        Seen wf;
        hand(f, 60, grid(2 * S, 20 * S + 1), no_jit, [&](int64_t t, PcrValidator& x) { wf.see(t, x); });
        CHECK("cadence: ... with the cap at the floor (the row before B-86) it fails in its first interval, at 1.5 s",
              wf.fail_at >= 1500 * MS && wf.fail_at <= 1520 * MS && f.reason() == R::cadence);
    }
    {
        // One 6 s interval at 40 s (no PCR at 42 and 44 s): one crossing, the warning for 60 s.
        PcrValidator v(def);
        Seen w;
        int64_t gap50 = -1, gap110 = -1;
        hand(v, 120, grid(2 * S, INT64_MAX, {{41 * S, 45 * S}}), no_jit, [&](int64_t t, PcrValidator& x) {
            w.see(t, x, 2 * S);
            if (t == 50 * S) gap50 = x.pcr_gap_max_ns();
            if (t == 110 * S) gap110 = x.pcr_gap_max_ns();
        });
        CHECK("cadence: one 6 s interval on a 2 s PCR warns from its crossing at 44 s, never fails",
              w.fail_at < 0 && w.warn_from >= 44 * S && w.warn_from <= 44020 * MS);
        CHECK("cadence: ... gaps up to 6 s, the cadence stays 2 s (an interval over the cap teaches nothing)",
              gap50 == 6 * S && w.cad_lo == 2 * S && w.cad_hi == 2 * S);
        CHECK("cadence: ... the warning gone 60 s after the crossing, the gap with it",
              w.warn_last >= 104 * S && w.warn_last <= 104040 * MS && gap110 == 0 && !v.cadence_warning());
        PcrValidator e(def);
        Seen we;
        hand(e, 60, grid(2 * S, INT64_MAX, {{41 * S, 43 * S}}), no_jit, [&](int64_t t, PcrValidator& x) { we.see(t, x); });
        CHECK("cadence: one PCR skipped (an interval of exactly 4 s, the threshold) is on time: no warning",
              we.fail_at < 0 && we.warn_from < 0);
    }
    {
        PcrValidator v(def);
        Seen w;
        hand(v, 90, grid(2 * S, INT64_MAX, {{41 * S, 45 * S}, {51 * S, 55 * S}, {61 * S, 65 * S}}), no_jit,
             [&](int64_t t, PcrValidator& x) { w.see(t, x); });
        CHECK("cadence: three 6 s intervals within 60 s fail as cadence at the third crossing (64 s)",
              v.reason() == R::cadence && w.fail_at >= 64 * S && w.fail_at <= 64020 * MS);
    }
    {
        PcrValidator v(def);
        Seen w;
        bool at_cap = true;
        hand(v, 20, [](int64_t) { return INT64_MIN; }, no_jit, [&](int64_t t, PcrValidator& x) {
            w.see(t, x);
            at_cap &= x.late_ns() == 4 * S;
        });
        CHECK("cadence: a program with no PCR at all fails at its first crossing of the cap, 4 s",
              v.reason() == R::cadence && w.fail_at >= 4 * S && w.fail_at <= 4020 * MS && at_cap);
    }
    {
        // 100 ms until 30 s, then every 2 s: the first long interval crosses 500 ms three times.
        PcrValidator v(def);
        Seen w;
        bool again = false, at4 = true;
        auto d2s = [](int64_t t) { return (t <= 30 * S ? t % (100 * MS) == 0 : t % (2 * S) == 0) ? t : INT64_MIN; };
        hand(v, 120, d2s, no_jit, [&](int64_t t, PcrValidator& x) {
            w.see(t, x);
            if (t == 62 * S) x.clear_failure();   // as the recovery does
            if (t > 62 * S) again |= x.failed();
            if (t >= 32 * S) at4 &= x.late_ns() == 4 * S;
        });
        CHECK("cadence: dense to sparse (100 ms, then 2 s from 30 s) fails at 31.5 s, then late at 4 s from 32 s",
              w.fail_at >= 31500 * MS && w.fail_at <= 31520 * MS && at4);
        CHECK("cadence: ... cleared at 62 s (the crossings 31 s old), it does not fail again", !again && !v.failed());
    }
    {
        PcrValidator v(def);
        Seen w;
        int64_t cad31 = -1;
        auto s2d = [](int64_t t) { return (t < 30 * S ? t % (2 * S) == 0 : t % (100 * MS) == 0) ? t : INT64_MIN; };
        hand(v, 60, s2d, no_jit, [&](int64_t t, PcrValidator& x) {
            w.see(t, x);
            if (t == 31 * S) cad31 = x.pcr_cadence_ns();
        });
        CHECK("cadence: sparse to dense (2 s, then 100 ms from 30 s) never fails or warns; cadence 100 ms by 31 s",
              w.fail_at < 0 && w.warn_from < 0 && cad31 == 100 * MS);
    }
    {
        // clear_failure() itself: three crossings fail; cleared, the next packet neither fails nor warns.
        PcrValidator v(def);
        int64_t t = 0;
        for (; t <= 20 * S && !v.failed(); t += 20 * MS) {
            if (t <= 10 * S && t % (100 * MS) == 0) v.feed_pcr(ns_to_pcr27(t), false, t);
            v.feed_activity(t);
        }
        const bool failed = v.failed() && v.cadence_warning() && v.pcr_gap_max_ns() >= 1500 * MS;
        v.clear_failure();
        v.feed_activity(t);
        CHECK("cadence: clear_failure starts the windowed counts afresh: the next packet fails no row, warns not, gap 0",
              failed && !v.failed() && !v.cadence_warning() && v.pcr_gap_max_ns() == 0);
    }
    {
        // A PCR PID change (restart_pcr): the cadence is learned anew, the cap in force until then.
        PcrValidator v(def);
        Seen w;
        int64_t late_after = -1;
        hand(v, 30, grid(100 * MS, 20 * S + 1), no_jit, [&](int64_t t, PcrValidator& x) {
            w.see(t, x);
            if (t == 20 * S) {
                x.restart_pcr();
                late_after = x.late_ns();
            }
        });
        CHECK("cadence: restart_pcr: the cap (4 s) in force; no PCR from the new PID fails at the first crossing",
              late_after == 4 * S && v.reason() == R::cadence && w.fail_at >= 24 * S && w.fail_at <= 24020 * MS);
        // One late interval (600 ms at 10 s) shortly before the change, the new PID's PCR at once.
        PcrValidator r(def);
        Seen wr;
        hand(r, 40, grid(100 * MS, INT64_MAX, {{10050 * MS, 10600 * MS}}), no_jit, [&](int64_t t, PcrValidator& x) {
            wr.see(t, x);
            if (t == 20 * S) x.restart_pcr();
        });
        CHECK("cadence: ... an earlier late crossing still in the window does not fail the new PID at the change",
              wr.warn_from > 0 && wr.fail_at < 0 && r.pcr_cadence_ns() == 100 * MS);
    }
    // Rate.
    {
        auto fast = [](int64_t) { return (int64_t)1500000; };
        auto slow = [](int64_t) { return (int64_t)-999000; };
        const VRun r = vrun(def, 60, 100, no_off, no_di, never, fast, leads_ok);
        CHECK("rate: |ε_fit| 1500 ppm fails as rate after 30 s", r.reason == R::rate && r.fail_at >= 30 * S && r.fail_at <= 30 * S + 100 * MS);
        CHECK("rate: 999 ppm passes", clean(vrun(def, 60, 100, no_off, no_di, never, slow, leads_ok)));
        PcrValidatorConfig off = def;
        off.rate_max_ppm = 100000;
        CHECK("rate: ... and nothing else fires on it", clean(vrun(off, 60, 100, no_off, no_di, never, fast, leads_ok)));
    }
    // Freeze.
    {
        auto frozen = [](int64_t t) { return t >= 5 * S ? 5 * S - t : 0; };
        const VRun r = vrun(def, 30, 100, frozen, no_di, never, rate_30, leads_ok);
        CHECK("freeze: a stuck PCR fails as freeze at the third interval",
              r.reason == R::freeze && r.fail_at >= 5300 * MS && r.fail_at <= 5320 * MS && r.leaps == 0);
        PcrValidatorConfig off = def;
        off.freeze_count = 1 << 30;
        CHECK("freeze: ... and nothing else fires on it", clean(vrun(off, 30, 100, frozen, no_di, never, rate_30, leads_ok)));
    }
    // Leap.
    {
        auto one = [](int64_t t) { return t >= 5 * S ? 1 * S : 0; };
        const VRun r1 = vrun(def, 30, 100, one, no_di, never, rate_30, leads_ok);
        CHECK("leap: one unflagged +1 s jump re-locks, no failure", r1.leaps == 1 && r1.fails == 0);
        auto three = [](int64_t t) { return t >= 35 * S ? 3 * S : t >= 20 * S ? 2 * S : t >= 5 * S ? 1 * S : 0; };
        const VRun r3 = vrun(def, 60, 100, three, no_di, never, rate_30, leads_ok);
        CHECK("leap: three within 60 s fail as leap (the third)", r3.reason == R::leap && r3.leaps == 2 && r3.fail_at == 35 * S);
        auto di_at = [](int64_t t) { return t == 5 * S || t == 20 * S || t == 35 * S; };
        const VRun rd = vrun(def, 60, 100, three, di_at, never, rate_30, leads_ok);
        CHECK("leap: the same jumps flagged are discontinuities, not leaps", rd.discs == 3 && rd.leaps == 0 && rd.fails == 0);
        auto spread = [](int64_t t) { return t >= 70 * S ? 3 * S : t >= 35 * S ? 2 * S : t >= 5 * S ? 1 * S : 0; };
        const VRun rs = vrun(def, 90, 100, spread, no_di, never, rate_30, leads_ok);
        CHECK("leap: three spread over 65 s re-lock three times, no failure", rs.leaps == 3 && rs.fails == 0);
        auto back = [](int64_t t) { return t >= 5 * S ? -1 * S : 0; };
        const VRun rb = vrun(def, 30, 100, back, no_di, never, rate_30, leads_ok);
        CHECK("leap: a rewind is a leap too", rb.leaps == 1 && rb.fails == 0);
        PcrValidatorConfig off = def;
        off.leap_ns = 1000 * S;
        CHECK("leap: ... and nothing else fires on three", clean(vrun(off, 60, 100, three, no_di, never, rate_30, leads_ok)));
    }
    // Lead.
    {
        auto big = [](int64_t t) { return t >= 10 * S ? 5300 * MS : 900 * MS; };   // PID 0x100 5.3 s, 0x101 5.0 s
        const VRun r = vrun(def, 30, 100, no_off, no_di, never, rate_30, big);
        CHECK("lead: a median lead above 4 s for 5 s fails as lead",
              r.reason == R::lead && r.fail_at >= 15 * S && r.fail_at <= 15600 * MS);
        auto late = [](int64_t t) { return t >= 10 * S ? 0 : 900 * MS; };   // 0x101 at -300 ms
        const VRun rl = vrun(def, 30, 100, no_off, no_di, never, rate_30, late);
        CHECK("lead: a median stream lead (PTS less the PCR) below -200 ms for 5 s fails as lead",
              rl.reason == R::lead && rl.fail_at >= 15 * S && rl.fail_at <= 15600 * MS);
        // B-90: a delivery 400 ms late for 8 s puts 0x101's lead against arrival at -300 ms; its own
        // lead over its PCR stays +100 ms, which the lower bound reads.
        auto mux100 = [](int64_t) { return 400 * MS; };   // 0x100 400 ms, 0x101 100 ms
        auto lag400 = [](int64_t t) { return t >= 10 * S && t < 18 * S ? 400 * MS : 0; };
        CHECK("lead: a 100 ms stream lead delivered 400 ms late for 8 s passes (B-90)",
              clean(vrun(def, 30, 100, no_off, no_di, never, rate_30, mux100, lag400)));
        auto ok3 = [](int64_t t) { return t >= 10 * S ? 3300 * MS : 900 * MS; };
        CHECK("lead: 3.3 s passes", clean(vrun(def, 30, 100, no_off, no_di, never, rate_30, ok3)));
        auto spike = [](int64_t t) { return t >= 10 * S && t < 14 * S ? 5300 * MS : 900 * MS; };
        CHECK("lead: 4 s of a bad lead passes (hold 5 s)", clean(vrun(def, 30, 100, no_off, no_di, never, rate_30, spike)));
        PcrValidatorConfig off = def;
        off.lead_max_ns = 100 * S;
        CHECK("lead: ... and nothing else fires on it", clean(vrun(off, 30, 100, no_off, no_di, never, rate_30, big)));
    }
    {
        PcrValidator v(def);
        for (int64_t t = 0; t <= 2 * S; t += 100 * MS) v.feed_pcr(ns_to_pcr27(t), false, t);
        v.feed_rate(2000000, 2 * S);
        CHECK("recovery clock: one bad observation alone does not restart it (B-90)", v.clean_ns(5 * S) == 5 * S);
        v.feed_rate(2000000, 32 * S);
        CHECK("recovery clock: ... its row failing (the rate held 30 s) does", v.clean_ns(35 * S) == 3 * S);
        v.feed_rate(0, 33 * S);
        CHECK("recovery clock: ... and good ones do not", v.clean_ns(70 * S) == 38 * S);
    }
    // B-90: per row, what restarts the recovery clock: an observation at the row's failure condition
    // (its count or its hold), not an isolated one. `pcr(t)` the PCR's σ at arrival t.
    auto clock_after = [&](int64_t secs, auto pcr, auto lead) {
        PcrValidator v(def);
        for (int64_t t = 0; t <= secs * S; t += 20 * MS) {
            v.feed_activity(t);
            if (t % (100 * MS) == 0) {
                const int64_t s = pcr(t);
                if (s != INT64_MIN) v.feed_pcr(ns_to_pcr27(s), false, t);
            }
            v.feed_lead(0x100, PcrValidator::NO_LEAD, lead(t));
        }
        return std::make_pair(v.clean_ns(secs * S), v.failed());
    };
    auto pcr_ok = [](int64_t t) { return t; };
    auto lead_ok = [](int64_t) { return 100 * MS; };
    {
        auto two = [](int64_t t) { return t >= 10 * S && t < 10300 * MS ? 10 * S : t; };   // frozen at 10.1, 10.2 s
        auto three = [](int64_t t) { return t >= 10 * S && t < 10400 * MS ? 10 * S : t; };
        const auto a = clock_after(20, two, lead_ok), b = clock_after(20, three, lead_ok);
        CHECK("recovery clock: two frozen PCR pairs leave it running; the third (the freeze row) restarts it",
              a.first == 20 * S && !a.second && b.second && b.first == 20 * S - 10300 * MS);
    }
    {
        // The PCR missing 1.1 s while packets flow: two 500 ms crossings; missing 1.6 s: the third fails.
        auto gap = [](int64_t lo, int64_t hi) { return [=](int64_t t) { return t > lo && t < hi ? INT64_MIN : t; }; };
        const auto a = clock_after(20, gap(10 * S, 11100 * MS), lead_ok), b = clock_after(20, gap(10 * S, 11600 * MS), lead_ok);
        CHECK("recovery clock: two cadence crossings leave it running; the third (the cadence row) restarts it",
              a.first == 20 * S && !a.second && b.second && b.first == 20 * S - 11520 * MS);
    }
    {
        auto two = [](int64_t t) { return t + (t >= 10 * S ? 1 * S : 0) + (t >= 20 * S ? 1 * S : 0); };
        auto three = [&](int64_t t) { return two(t) + (t >= 30 * S ? 1 * S : 0); };
        const auto a = clock_after(40, two, lead_ok), b = clock_after(40, three, lead_ok);
        CHECK("recovery clock: two leaps in 60 s leave it running; the third (the leap row) restarts it",
              a.first == 40 * S && !a.second && b.second && b.first == 10 * S);
    }
    {
        auto behind = [](int64_t lo, int64_t hi) {
            return [=](int64_t t) { return t >= lo && t < hi ? -300 * MS : 100 * MS; };
        };
        const auto a = clock_after(30, pcr_ok, behind(10 * S, 14 * S)), b = clock_after(30, pcr_ok, behind(10 * S, 17 * S));
        CHECK("recovery clock: a stream lead out of range 4 s leaves it running; past the 5 s hold it restarts",
              a.first == 30 * S && !a.second && b.second && b.first == 30 * S - 17480 * MS);
    }
}

// --- VirtualStc ---------------------------------------------------------------------

constexpr int PCR_PID = 0x1ff, PID_V = 0x100, PID_A = 0x101, TICK = -1;

struct Pkt {
    int64_t h;       // arrival
    int pid;         // PCR_PID, a PES PID, or TICK
    int64_t v;       // pcr27, or PTS in 90 kHz (unwrapped)
    bool di;
    int64_t t;       // source send time, for the checks
};

struct Shape {
    int64_t pcr_ns = 0, pts_ns = 0;   // added to the PCR value / the PTS (source time)
    int64_t mux_ns = 0;               // the packet leaves the mux this much later
    int64_t net_ns = 0;               // the path's floor delay moves this much (FIFO: none overtakes)
    bool di = false, drop = false;
};

// PCR every 100 ms, audio PES every 24 ms (lead 500 ms), video every 40 ms (lead
// 800 ms); one FIFO path, each packet with its own delay, so nothing reorders.
// `shape` bends a packet per scenario.
template <class F>
std::vector<Pkt> program(int64_t secs, int64_t eps_ppb, uint64_t seed, F shape, int64_t sigma0 = 3600 * S) {
    struct Raw {
        int64_t m, delay;
        Pkt p;
    };
    std::vector<Raw> raw;
    Lcg g(seed);
    for (int64_t t = 0; t <= secs * S; t += 4 * MS) {
        for (int kind = 0; kind < 3; kind++) {
            const int64_t every = kind == 0 ? 100 * MS : kind == 1 ? 24 * MS : 40 * MS;
            if (t % every != 0) continue;
            const int pid = kind == 0 ? PCR_PID : kind == 1 ? PID_A : PID_V;
            const int64_t delay = net_delay(g);
            const Shape sh = shape(pid, t);
            if (sh.drop) continue;
            const int64_t m = t + sh.mux_ns;
            const int64_t lead = kind == 1 ? 500 * MS : 800 * MS;
            const int64_t v = kind == 0 ? ns_to_pcr27(sigma0 + m + sh.pcr_ns) : ns_to_pts90k(sigma0 + t + lead + sh.pts_ns);
            raw.push_back(Raw{m, delay + sh.net_ns, Pkt{0, pid, v, sh.di, t}});
        }
    }
    std::stable_sort(raw.begin(), raw.end(), [](const Raw& a, const Raw& b) { return a.m < b.m; });
    std::vector<Pkt> out;
    int64_t last = INT64_MIN;
    for (Raw& r : raw) {
        last = std::max(last, H0 + r.m + at_ppb(r.m, eps_ppb) + 20 * MS + r.delay);
        r.p.h = last;
        out.push_back(r.p);
    }
    return out;
}

auto plain = [](int, int64_t) { return Shape(); };

// Feeds a program as the restamp would: the reference PID (audio) into
// feed_ref_pes, every PES through map(). Folds mappings and events into `f`.
template <class F>
void drive(VirtualStc& v, const std::vector<Pkt>& pk, Fnv& f, F on_pes) {
    int64_t next_stats = 0;
    for (const Pkt& p : pk) {
        if (p.pid == TICK) {
            v.tick(p.h);
            continue;
        }
        if (p.pid == PCR_PID) {
            v.feed_pcr(p.v, p.di, p.h);
        } else {
            if (p.pid == PID_A) v.feed_ref_pes(p.pid, p.v, p.h);
            const VirtualStc::Mapping m = v.map(p.pid, p.v, p.h);
            f.add(m.house_ns);
            f.add(m.epoch);
            on_pes(p, m);
        }
        if (p.h >= next_stats) {   // stats-interval-ms = 2000
            const VirtualStc::Stats s = v.stats();
            f.add((int64_t)s.state);
            f.add(s.ppb);
            f.add(s.residual.min_ns);
            f.add(s.residual.p99_ns);
            next_stats = p.h + 2 * S;
        }
    }
}

std::vector<StcEvent> fold_events(VirtualStc& v, Fnv& f) {
    std::vector<StcEvent> ev = v.take_events();
    for (const StcEvent& e : ev) {
        f.add((int64_t)e.kind);
        f.add(e.house_ns);
        f.add(e.epoch);
        f.add(e.value_ns);
        for (const char* c = e.reason; *c; c++) f.add(*c);
    }
    return ev;
}

int64_t rel(int64_t h) { return h - H0 - 20 * MS; }   // ≈ source send time of an arrival

void print_events(const char* label, const std::vector<StcEvent>& ev) {
    std::printf("  %s:", label);
    if (ev.empty()) std::printf(" (no events)");
    for (const StcEvent& e : ev)
        std::printf(" [%s%s%s @%.3f s epoch %u value %.3f ms]", event_name(e.kind), *e.reason ? " " : "", e.reason,
                    rel(e.house_ns) / 1e9, e.epoch, e.value_ns / 1e6);
    std::printf("\n");
}

bool kinds_are(const std::vector<StcEvent>& ev, std::initializer_list<StcEvent::Kind> want) {
    if (ev.size() != want.size()) return false;
    size_t i = 0;
    for (StcEvent::Kind k : want)
        if (ev[i++].kind != k) return false;
    return true;
}

void test_vstc_clean_and_wrap() {
    VirtualStc v;
    Fnv f;
    int64_t worst_back = INT64_MAX, last_a = INT64_MIN;
    drive(v, program(120, 50000, 21, plain), f, [&](const Pkt& p, const VirtualStc::Mapping& m) {
        if (p.pid == PID_A && last_a != INT64_MIN) worst_back = std::min(worst_back, m.house_ns - last_a);
        if (p.pid == PID_A) last_a = m.house_ns;
    });
    const std::vector<StcEvent> ev = fold_events(v, f);
    const VirtualStc::Stats s = v.stats();
    const VirtualStc::LeadStats la = v.lead(PID_A), lv = v.lead(PID_V);
    std::printf("  clean +50 ppm: state %s ppb %lld leads a/v median %.2f/%.2f ms, residual min %.3f ms\n",
                state_name(s.state), (long long)s.ppb, la.median_ns / 1e6, lv.median_ns / 1e6, s.residual.min_ns / 1e6);
    CHECK("vstc clean: locked on epoch 1, no events, no relock",
          s.state == VirtualStc::State::locked && s.epoch == 1 && ev.empty() && s.relocks == 0);
    CHECK("vstc clean: source-natural leads (audio 500 ms, video 800 ms, less the delay above the floor)",
          la.median_ns > 480 * MS && la.median_ns <= 500 * MS && lv.median_ns > 780 * MS && lv.median_ns <= 800 * MS);
    CHECK("vstc clean: audio house PTS never steps back", worst_back > 0);
    CHECK("vstc clean: the STC seed is the last PCR in 90 kHz",
          iabs(v.source_stc_90k() - ns_to_pts90k(3600 * S + 120 * S)) <= 1);
    g_all.add((int64_t)f.h);

    // Across the 33-bit wrap: PCR base and PTS cross 2^33 at 20 s.
    const int64_t sigma0 = pts90k_to_ns(PTS_WRAP) - 20 * S;
    VirtualStc w;
    Fnv fw;
    int64_t back = INT64_MAX, prev = INT64_MIN;
    drive(w, program(60, -50000, 22, plain, sigma0), fw, [&](const Pkt& p, const VirtualStc::Mapping& m) {
        if (p.pid == PID_V && prev != INT64_MIN) back = std::min(back, m.house_ns - prev);
        if (p.pid == PID_V) prev = m.house_ns;
    });
    CHECK("vstc wrap: no event across the 33-bit wrap", fold_events(w, fw).empty());
    CHECK("vstc wrap: the STC seed runs past 2^33", w.source_stc_90k() > PTS_WRAP);
    CHECK("vstc wrap: video house PTS never steps back", back > 0);
    g_all.add((int64_t)fw.h);
}

void test_vstc_relocks() {
    {   // +30 ms re-route at 120 s.
        VirtualStc v;
        Fnv f;
        auto reroute = [](int pid, int64_t t) {   // the path's floor rises 30 ms
            Shape s;
            s.mux_ns = t >= 120 * S ? 30 * MS : 0;
            if (pid == PCR_PID) s.pcr_ns = -s.mux_ns;
            return s;
        };
        drive(v, program(200, 50000, 31, reroute), f, [](const Pkt&, const VirtualStc::Mapping&) {});
        const std::vector<StcEvent> ev = fold_events(v, f);
        print_events("re-route +30 ms at 120 s", ev);
        CHECK("vstc step: envelope-step then relock, once", kinds_are(ev, {StcEvent::Kind::envelope_step, StcEvent::Kind::relock}));
        CHECK("vstc step: ... 10 s after the re-route, the step measured",
              ev.size() == 2 && rel(ev[1].house_ns) >= 130 * S && rel(ev[1].house_ns) <= 131500 * MS &&
                  ev[0].value_ns > 25 * MS && ev[0].value_ns < 31 * MS && !std::strcmp(ev[1].reason, "envelope-step"));
        const VirtualStc::LeadStats la = v.lead(PID_A);
        CHECK("vstc step: the new epoch keeps the source lead", v.stats().epoch == 2 && la.median_ns > 480 * MS && la.median_ns <= 500 * MS);
        g_all.add((int64_t)f.h);
    }
    {   // Flagged +10 s discontinuity at 60 s, PCR and PTS together.
        VirtualStc v;
        Fnv f;
        auto jump = [](int pid, int64_t t) {
            Shape s;
            if (t >= 60 * S) s.pcr_ns = s.pts_ns = 10 * S;
            s.di = pid == PCR_PID && t == 60 * S;
            return s;
        };
        int64_t worst = INT64_MAX;
        drive(v, program(90, 0, 32, jump), f, [&](const Pkt& p, const VirtualStc::Mapping& m) {
            if (p.t >= 61 * S) worst = std::min(worst, m.house_ns - p.h);
        });
        const std::vector<StcEvent> ev = fold_events(v, f);
        print_events("flagged +10 s discontinuity", ev);
        CHECK("vstc discontinuity: one relock, reason discontinuity, no leap",
              kinds_are(ev, {StcEvent::Kind::relock}) && !std::strcmp(ev[0].reason, "discontinuity"));
        CHECK("vstc discontinuity: house time does not jump (leads stay source-natural)", worst > 400 * MS);
        g_all.add((int64_t)f.h);
    }
    {   // 6 s outage with the PCR continuous across it (a sending engine restarting).
        VirtualStc v;
        Fnv f;
        auto outage = [](int, int64_t t) {
            Shape s;
            s.drop = t >= 50 * S && t < 56 * S;
            return s;
        };
        std::vector<Pkt> pk = program(90, 50000, 33, outage);
        for (int64_t t = 50 * S; t < 56 * S; t += 500 * MS) pk.push_back(Pkt{H0 + 20 * MS + t, TICK, 0, false, t});
        std::stable_sort(pk.begin(), pk.end(), [](const Pkt& a, const Pkt& b) { return a.h < b.h; });
        bool was_lost = false;
        VirtualStc::State during = VirtualStc::State::acquiring;
        for (const Pkt& p : pk) {
            if (p.pid == TICK) {
                v.tick(p.h);
                if (p.t >= 55500 * MS) during = v.state();
                continue;
            }
            if (p.pid == PCR_PID) v.feed_pcr(p.v, p.di, p.h);
            else {
                if (p.pid == PID_A) v.feed_ref_pes(p.pid, p.v, p.h);
                v.map(p.pid, p.v, p.h);
            }
            was_lost |= v.state() == VirtualStc::State::lost;
        }
        CHECK("vstc outage: lost after 5 s of silence", during == VirtualStc::State::lost);
        CHECK("vstc outage: continuous PCR resumes the epoch without a relock",
              fold_events(v, f).empty() && v.stats().epoch == 1 && v.state() == VirtualStc::State::locked);
    }
    {   // External relock (the PMT's PCR PID changed), the same clock behind it.
        VirtualStc v;
        Fnv f;
        bool done = false;
        std::map<int, uint32_t> last;
        std::map<int, int> switches;
        for (const Pkt& p : program(40, 0, 34, plain)) {
            if (!done && p.t >= 30 * S) {
                v.relock();
                done = true;
            }
            if (p.pid == PCR_PID) {
                v.feed_pcr(p.v, p.di, p.h);
                continue;
            }
            const VirtualStc::Mapping m = v.map(p.pid, p.v, p.h);
            if (last.count(p.pid) && m.epoch != last[p.pid]) switches[p.pid]++;
            last[p.pid] = m.epoch;
        }
        const std::vector<StcEvent> ev = fold_events(v, f);
        CHECK("vstc external relock: one relock, reason external, epoch 2",
              kinds_are(ev, {StcEvent::Kind::relock}) && !std::strcmp(ev[0].reason, "external") && v.stats().epoch == 2);
        std::printf("  external relock: epoch switches audio %d, video %d\n", switches[PID_A], switches[PID_V]);
        CHECK("vstc external relock: each PID switches once (one timeline: no tie-break flips)",
              switches.size() == 2 && switches[PID_A] == 1 && switches[PID_V] == 1);
    }
}

uint64_t degraded_scenario(bool report) {
    // The vMix pattern (#820): the PCR freezes 60-80 s, then resumes at its true value.
    VirtualStc v;
    Fnv f;
    auto freeze = [](int pid, int64_t t) {
        Shape s;
        if (pid == PCR_PID && t >= 60 * S && t < 80 * S) s.pcr_ns = 60 * S - t;
        return s;
    };
    int64_t a_deg = INT64_MIN, v_deg = INT64_MIN, a_after = INT64_MIN;
    uint32_t deg_epoch = 0;
    drive(v, program(150, 50000, 41, freeze), f, [&](const Pkt& p, const VirtualStc::Mapping&) {
        if (p.t >= 100 * S && p.pid == PID_A && a_deg == INT64_MIN) {
            a_deg = v.lead(PID_A).median_ns;
            v_deg = v.lead(PID_V).median_ns;
            deg_epoch = v.stats().epoch;
        }
        if (p.t >= 150 * S && p.pid == PID_A && a_after == INT64_MIN) a_after = v.lead(PID_A).median_ns;
    });
    const std::vector<StcEvent> ev = fold_events(v, f);
    if (!report) return f.h;
    print_events("PCR frozen 60-80 s", ev);
    std::printf("  degraded leads at 100 s: audio %.2f ms, video %.2f ms; audio after recovery %.2f ms\n",
                a_deg / 1e6, v_deg / 1e6, a_after / 1e6);
    CHECK("vstc degraded: degraded (freeze), the PCR leap, then recovered",
          kinds_are(ev, {StcEvent::Kind::degraded, StcEvent::Kind::leap, StcEvent::Kind::recovered}) &&
              !std::strcmp(ev[0].reason, "freeze") && !std::strcmp(ev[2].reason, "freeze"));
    CHECK("vstc degraded: entered at the third frozen interval, the warm reference lock at once",
          ev.size() == 3 && rel(ev[0].house_ns) >= 60200 * MS && rel(ev[0].house_ns) <= 60500 * MS && ev[0].epoch == 2);
    CHECK("vstc degraded: the reference PID lands at its earliest arrival (lead ~0)",
          a_deg >= -15 * MS && a_deg <= 2 * MS && deg_epoch == 2);
    CHECK("vstc degraded: other PIDs keep their offset to it (video +300 ms)", v_deg >= 285 * MS && v_deg <= 305 * MS);
    CHECK("vstc degraded: recovered after 30 s of clean PCR, not before",
          ev.size() == 3 && rel(ev[2].house_ns) >= 110 * S && rel(ev[2].house_ns) <= 111 * S);
    CHECK("vstc degraded: back on the PCR, source-natural again",
          v.state() == VirtualStc::State::locked && v.stats().epoch == 3 && a_after > 480 * MS && a_after <= 500 * MS);
    return f.h;
}

void test_vstc_degraded() {
    const uint64_t a = degraded_scenario(true);
    g_all.add((int64_t)a);

    // #820: PTS 12.1 s ahead of where the PCR puts it; the lead row degrades it.
    VirtualStc v;
    Fnv f;
    auto ahead = [](int pid, int64_t) {
        Shape s;
        if (pid != PCR_PID) s.pts_ns = 12100 * MS;
        return s;
    };
    drive(v, program(60, 0, 42, ahead), f, [](const Pkt&, const VirtualStc::Mapping&) {});
    const std::vector<StcEvent> ev = fold_events(v, f);
    print_events("#820 lead 12.6 s", ev);
    const VirtualStc::LeadStats la = v.lead(PID_A), lv = v.lead(PID_V);
    CHECK("vstc #820: degraded (lead) about 5 s in, never recovered",
          kinds_are(ev, {StcEvent::Kind::degraded}) && !std::strcmp(ev[0].reason, "lead") &&
              rel(ev[0].house_ns) >= 5 * S && rel(ev[0].house_ns) <= 5600 * MS && ev[0].epoch == 2 &&
              v.state() == VirtualStc::State::degraded && v.stats().reason == PcrValidator::Reason::lead);
    CHECK("vstc #820: the 12.6 s lead is gone (audio ~0, video +300 ms)",
          la.median_ns >= -15 * MS && la.median_ns <= 2 * MS && lv.median_ns >= 285 * MS && lv.median_ns <= 305 * MS);
    g_all.add((int64_t)f.h);
}

uint64_t straddle_scenario(bool report) {
    // Unflagged 1 s rewind at 60 s; the audio of 59.8-60 s is muxed 300 ms late,
    // after the new epoch's first PCR (syn-rewind-1s with syn-straddle-audio).
    VirtualStc v;
    Fnv f;
    auto rewind = [](int pid, int64_t t) {
        Shape s;
        if (t >= 60 * S) s.pcr_ns = s.pts_ns = -1 * S;
        if (pid == PID_A && t >= 59800 * MS && t < 60 * S) s.mux_ns = 300 * MS;
        return s;
    };
    int late_old = 0, late_old_ok = 0, late_both = 0, new_n = 0, new_ok = 0, before_bad = 0;
    int64_t late_lead_min = INT64_MAX, late_lead_max = INT64_MIN;
    size_t epochs_at_75 = 0;
    drive(v, program(80, 0, 51, rewind), f, [&](const Pkt& p, const VirtualStc::Mapping& m) {
        const int64_t sigma = pts90k_to_ns(p.v), lead = m.house_ns - p.h;
        if (p.t >= 1 * S && p.t < 59800 * MS) before_bad += m.epoch != 1;   // after the first PCR
        if (p.pid == PID_A && p.t >= 59800 * MS && p.t < 60 * S) {
            late_old++;
            late_old_ok += m.epoch == 1;
            const std::vector<VirtualStc::EpochInfo> ep = v.epochs();
            int in = 0;
            for (const auto& e : ep) in += sigma >= e.lo_ns && sigma <= e.hi_ns;
            late_both += ep.size() == 2 && in == 2;
            late_lead_min = std::min(late_lead_min, lead);
            late_lead_max = std::max(late_lead_max, lead);
        }
        if (p.t >= 60 * S) {
            new_n++;
            const int64_t want = p.pid == PID_A ? 500 * MS : 800 * MS;
            new_ok += m.epoch == 2 && lead > want - 60 * MS && lead < want + 60 * MS;   // re-acquiring
        }
        if (p.t >= 75 * S && !epochs_at_75) epochs_at_75 = v.epochs().size();
    });
    // Neither range: the newest epoch.
    const VirtualStc::Mapping far = v.map(PID_A, ns_to_pts90k(3600 * S + 500 * S), H0 + 80 * S);
    const std::vector<StcEvent> ev = fold_events(v, f);
    f.add(far.house_ns);
    if (!report) return f.h;
    print_events("unflagged 1 s rewind", ev);
    std::printf("  straddle: %d late old-epoch audio PES, %d on epoch 1, %d inside both ranges, leads %.1f..%.1f ms; "
                "%d/%d new PES on epoch 2 at their lead\n",
                late_old, late_old_ok, late_both, late_lead_min / 1e6, late_lead_max / 1e6, new_ok, new_n);
    CHECK("vstc straddle: the rewind is a leap and one relock",
          kinds_are(ev, {StcEvent::Kind::leap, StcEvent::Kind::relock}) && !std::strcmp(ev[1].reason, "leap") &&
              ev[0].value_ns < -950 * MS && ev[0].value_ns > -1050 * MS);
    CHECK("vstc straddle: PES before the rewind all on epoch 1", before_bad == 0);
    CHECK("vstc straddle: late old-epoch audio sits in both ranges ...", late_old > 0 && late_both == late_old);
    CHECK("vstc straddle: ... and keeps the old epoch (lead nearest its median)",
          late_old_ok == late_old && late_lead_min > 130 * MS && late_lead_max < 205 * MS);
    CHECK("vstc straddle: every new-epoch PES on epoch 2 at its source lead", new_n > 0 && new_ok == new_n);
    CHECK("vstc straddle: the old range is dropped once idle 10 s", epochs_at_75 == 1);
    CHECK("vstc straddle: a PES in neither range takes the newest epoch", far.valid && far.epoch == 2);
    return f.h;
}

void test_vstc_straddle() { g_all.add((int64_t)straddle_scenario(true)); }

// A caller that queues: what it sends from `at` leaves `len` later, then all of it over `drain`.
Shape queued_at(int pid, int64_t t, int64_t at, int64_t len, int64_t drain) {
    Shape s;
    const int64_t span = len + drain;
    if (t >= at && t - at < span) s.mux_ns = at + len + (int64_t)((__int128)(t - at) * drain / span) - t;
    if (pid == PCR_PID) s.pcr_ns = -s.mux_ns;   // stamped when sent, as the PES
    return s;
}

// B-39 through the program: what a backlog's seed would map past lead_max_ns ahead is stale
// (no mapping, and no lead row: the program never degrades on it); once the floor is found the
// PES map at their source lead. `at` 0: the pipeline starts on it; else a reconnect, a leap.
void vstc_backlog(const char* label, int64_t at, int64_t len, int64_t drain, int64_t secs) {
    VirtualStc v;
    Fnv f;
    auto queued = [=](int pid, int64_t t) { return queued_at(pid, t, at, len, drain); };
    const int64_t live = at + len + drain;
    int stale = 0, stale_late = 0, valid_ahead = 0, after = 0, after_ok = 0;
    drive(v, program(secs, 50000, 61, queued), f, [&](const Pkt& p, const VirtualStc::Mapping& m) {
        if (m.stale) {
            stale++;
            stale_late += p.t >= live + 4 * S;
            return;
        }
        const int64_t lead = m.house_ns - p.h, want = p.pid == PID_A ? 500 * MS : 800 * MS;
        valid_ahead += m.valid && lead > 4 * S + want;
        if (p.t < live + 4 * S) return;
        after++;
        after_ok += m.valid && lead > want - 55 * MS && lead <= want + 1 * MS;
    });
    const std::vector<StcEvent> ev = fold_events(v, f);
    print_events(label, ev);
    std::printf("  %s: %d stale, %d valid past 4 s ahead; %d/%d at their source lead from 4 s after the drain\n",
                label, stale, valid_ahead, after_ok, after);
    const bool fresh = at == 0;
    CHECK("vstc backlog: no relock or degraded but a reconnect's leap",
          fresh ? ev.empty()
                : kinds_are(ev, {StcEvent::Kind::leap, StcEvent::Kind::relock}) && !std::strcmp(ev[1].reason, "leap"));
    CHECK("vstc backlog: its PES stale while the line lies past lead_max_ns above the floor, none valid past it",
          stale > 100 && valid_ahead == 0 && stale_late == 0);
    CHECK("vstc backlog: from 4 s after the drain every PES maps at its source lead, locked in the end",
          after > 0 && after_ok == after && v.state() == VirtualStc::State::locked);
    g_all.add((int64_t)f.h);
}

void test_vstc_backlog() {
    vstc_backlog("backlog 30 s, 1 s, at the start", 0, 30 * S, 1 * S, 100);
    vstc_backlog("backlog 90 s, 5 s, at the start", 0, 90 * S, 5 * S, 160);
    vstc_backlog("backlog 30 s, 1 s, after 60 s live", 60 * S, 30 * S, 1 * S, 160);

    // A slow drain (B-48): 3.9 s queued at 60 s, drained over 30 s, video 1.5 s further ahead (2.3 s).
    // Under the seed line it reads past 4 s for the drain's last 17 s, stale by the second clause, and
    // so out of the lead row: the drain does not degrade the program.
    VirtualStc v;
    Fnv f;
    auto slow = [](int pid, int64_t t) {
        Shape s = queued_at(pid, t, 60 * S, 3900 * MS, 30 * S);
        if (pid == PID_V) s.pts_ns = 1500 * MS;
        return s;
    };
    int stale = 0, after = 0, after_ok = 0;
    drive(v, program(130, 50000, 62, slow), f, [&](const Pkt& p, const VirtualStc::Mapping& m) {
        stale += p.pid == PID_V && m.stale;
        if (p.t < 100 * S) return;
        const int64_t lead = m.house_ns - p.h, want = p.pid == PID_A ? 500 * MS : 2300 * MS;
        after++;
        after_ok += m.valid && lead > want - 55 * MS && lead <= want + 1 * MS;
    });
    const std::vector<StcEvent> ev = fold_events(v, f);
    print_events("slow drain, 3.9 s over 30 s, video 2.3 s ahead", ev);
    std::printf("  slow drain: %d video PES stale; %d/%d at their source lead from 100 s\n", stale, after_ok, after);
    CHECK("vstc slow drain: what the floor puts past 4 s is stale and kept out of the lead row: never degraded",
          kinds_are(ev, {StcEvent::Kind::leap, StcEvent::Kind::relock}) && stale > 300 &&
              v.state() == VirtualStc::State::locked);
    CHECK("vstc slow drain: ... then every PES at its source lead", after > 0 && after_ok == after);
    g_all.add((int64_t)f.h);
}

// B-8 (#820): the video PES 12.6 s ahead of the audio, the reference. The lead row degrades
// the program; under the reference mapping video still runs 12.9 s ahead, so it gets its own
// envelope (lead 0 at its earliest arrival) and lead_clamp names it, again every 30 s.
struct ClampRun {
    struct Rec {
        int pid;
        int64_t h, t, lead;
        bool valid, stale;
        uint32_t epoch;
    };
    std::vector<StcEvent> ev, clamps;
    std::vector<Rec> recs;
    bool degraded_first() const {
        return !ev.empty() && ev[0].kind == StcEvent::Kind::degraded && !std::strcmp(ev[0].reason, "lead");
    }
    // The clamp told at degraded entry (within 100 ms), naming video at its 12.8-13 s lead, every 30 s.
    bool told(size_t n) const {
        bool ok = degraded_first() && clamps.size() == n && clamps[0].house_ns >= ev[0].house_ns &&
                  clamps[0].house_ns - ev[0].house_ns < 100 * MS;
        for (size_t i = 0; ok && i < clamps.size(); i++) {
            ok = clamps[i].pid == PID_V && clamps[i].value_ns > 12800 * MS && clamps[i].value_ns < 13 * S;
            if (ok && i) {
                const int64_t d = clamps[i].house_ns - clamps[i - 1].house_ns;
                ok = d >= 30 * S && d < 30 * S + 100 * MS;
            }
        }
        return ok;
    }
    // Valid leads of `pid` from arrival `from` on: [lo, hi]; stale PES of it anywhere.
    void leads(int pid, int64_t from, int64_t* lo, int64_t* hi) const {
        *lo = INT64_MAX;
        *hi = INT64_MIN;
        for (const Rec& r : recs)
            if (r.pid == pid && r.valid && r.h >= from) *lo = std::min(*lo, r.lead), *hi = std::max(*hi, r.lead);
    }
    int stale(int pid) const {
        int n = 0;
        for (const Rec& r : recs) n += r.pid == pid && r.stale;
        return n;
    }
};

template <class F>
ClampRun clamp_run(const char* label, F shape, int64_t secs, uint64_t seed,
                   const PcrValidatorConfig& pcr = PcrValidatorConfig()) {
    VirtualStc v(ClockLockConfig(), pcr);
    Fnv f;
    ClampRun r;
    drive(v, program(secs, 50000, seed, shape), f, [&](const Pkt& p, const VirtualStc::Mapping& m) {
        r.recs.push_back(ClampRun::Rec{p.pid, p.h, p.t, m.house_ns - p.h, m.valid, m.stale, m.epoch});
    });
    r.ev = fold_events(v, f);
    for (const StcEvent& e : r.ev)
        if (e.kind == StcEvent::Kind::lead_clamp) r.clamps.push_back(e);
    print_events(label, r.ev);
    g_all.add((int64_t)f.h);
    return r;
}

void test_vstc_lead_clamp() {
    auto ahead = [](int pid, int64_t) {
        Shape s;
        if (pid == PID_V) s.pts_ns = 12600 * MS;
        return s;
    };
    const ClampRun a = clamp_run("#820 video 12.6 s ahead of the reference", ahead, 90, 43);
    int64_t v_lo, v_hi, a_lo, a_hi;
    const int64_t at = a.clamps.empty() ? 0 : a.clamps[0].house_ns;
    a.leads(PID_V, at + 10 * S, &v_lo, &v_hi);
    a.leads(PID_A, at + 10 * S, &a_lo, &a_hi);
    std::printf("  clamp: from 10 s after it, video lead %.3f..%.3f ms, audio %.3f..%.3f ms\n", v_lo / 1e6,
                v_hi / 1e6, a_lo / 1e6, a_hi / 1e6);
    CHECK("vstc clamp: degraded (lead), then lead_clamp naming the video PID, its lead 12.8-13 s, every 30 s",
          a.told(3));
    CHECK("vstc clamp: video lands at its earliest arrival (-55..+1 ms), audio stays on the reference (-55..+1 ms)",
          v_lo >= -55 * MS && v_hi <= 1 * MS && a_lo >= -55 * MS && a_hi <= 1 * MS);

    // The floor falls 100 ms at 3 s: the reference line lies visibly above it for a while, which
    // made the clamp candidate stale (the backlog rule) until the line reached the floor.
    auto fall = [&](int pid, int64_t t) {
        Shape s = ahead(pid, t);
        s.net_ns = t < 3 * S ? 100 * MS : 0;
        return s;
    };
    const ClampRun b = clamp_run("... and the floor 100 ms lower from 3 s", fall, 90, 43);
    b.leads(PID_V, (b.clamps.empty() ? 0 : b.clamps[0].house_ns) + 10 * S, &v_lo, &v_hi);
    std::printf("  clamp, floor fall: %d video PES stale, from 10 s after the clamp video lead %.3f..%.3f ms\n",
                b.stale(PID_V), v_lo / 1e6, v_hi / 1e6);
    CHECK("vstc clamp, floor fall: the clamp still at degraded entry, video never stale (its lead is no backlog's)",
          b.told(3) && b.stale(PID_V) == 0 && b.stale(PID_A) == 0);
    CHECK("vstc clamp, floor fall: ... video then at its earliest arrival (-55..+1 ms)",
          v_lo >= -55 * MS && v_hi <= 1 * MS);

    // Video's own PTS steps back 2 s at 50 s: a leap its envelope relocks on, an epoch of its own.
    auto rewind = [&](int pid, int64_t t) {
        Shape s = ahead(pid, t);
        if (pid == PID_V && t >= 50 * S) s.pts_ns -= 2 * S;
        return s;
    };
    const ClampRun c = clamp_run("... and video 2 s back at 50 s", rewind, 90, 43);
    int switches = 0, off = 0;   // off: a lead past the new seed's jitter (5 ms) after the rewind
    uint32_t last = 0;
    for (const ClampRun::Rec& r : c.recs) {
        if (r.pid != PID_V || !r.valid || c.clamps.empty() || r.h < c.clamps[0].house_ns + 1 * S) continue;
        if (last && r.epoch != last) switches += r.t >= 50 * S && r.t < 50100 * MS ? 1 : 100;
        last = r.epoch;
        off += r.t >= 50 * S && (r.lead < -55 * MS || r.lead > 5 * MS);
    }
    c.leads(PID_V, H0 + 52 * S, &v_lo, &v_hi);
    std::printf("  clamp, video rewound: %d epoch switch(es) on video, %d PES off after it, lead %.3f..%.3f ms "
                "from 52 s\n",
                switches, off, v_lo / 1e6, v_hi / 1e6);
    CHECK("vstc clamp: the clamped PID's own leap relocks its envelope (one new epoch at 50 s), its lead stays 0",
          c.told(3) && switches == 1 && off == 0 && v_lo >= -55 * MS && v_hi <= 1 * MS);

    // PCR mode (the lead row held off): a PID that far ahead under a line visibly above its floor
    // is the source's lead, not a backlog's: never stale, so no gap or overlap names one.
    PcrValidatorConfig hold;
    hold.lead_hold_ns = 1000 * S;
    const ClampRun d = clamp_run("... PCR mode, floor fall, the lead row held", fall, 60, 43, hold);
    d.leads(PID_V, H0 + 4 * S, &v_lo, &v_hi);
    std::printf("  PCR mode, floor fall: %d video PES stale, video lead %.3f..%.3f ms from 4 s\n", d.stale(PID_V),
                v_lo / 1e6, v_hi / 1e6);
    CHECK("vstc PCR mode: a PID 13 s ahead under a line 100 ms above its floor maps (never stale), never degraded",
          d.ev.empty() && d.stale(PID_V) == 0 && v_lo > 13 * S && v_hi < 13600 * MS);

    // A 6 s reconnect backlog at 40 s (drained in 1 s) while video is clamped: its own envelope
    // relocks on the leap, seeded on the backlog's oldest PES, so what that maps more than 4 s
    // ahead is stale too (B-48: the clamp lock's own check), and then lands on the floor again.
    auto backlog = [&](int pid, int64_t t) {
        Shape s = queued_at(pid, t, 40 * S, 6 * S, 1 * S);
        if (pid == PID_V) s.pts_ns = 12600 * MS;
        return s;
    };
    auto drain_leads = [](const ClampRun& r, int64_t* hi, int* stale) {
        *hi = INT64_MIN;
        *stale = 0;
        for (const ClampRun::Rec& x : r.recs)
            if (x.pid == PID_V && x.t >= 40 * S && x.t < 48 * S) {
                if (x.valid) *hi = std::max(*hi, x.lead);
                *stale += x.stale;
            }
    };
    const ClampRun g = clamp_run("... and a 6 s reconnect backlog at 40 s", backlog, 90, 43);
    int64_t g_hi;
    int g_stale;
    drain_leads(g, &g_hi, &g_stale);
    g.leads(PID_V, H0 + 52 * S, &v_lo, &v_hi);
    std::printf("  clamp, backlog: %d video PES of the backlog stale, the rest at most %.3f ms ahead; from 52 s "
                "video lead %.3f..%.3f ms\n",
                g_stale, g_hi / 1e6, v_lo / 1e6, v_hi / 1e6);
    CHECK("vstc clamp, backlog: on the clamped PID's own envelope the backlog past 4 s ahead is stale, none valid past it",
          g.degraded_first() && g_stale > 50 && g_hi <= 4 * S && v_lo >= -55 * MS && v_hi <= 1 * MS);

    // PCR mode, the same backlog: video, 13.4 s ahead, is the source's lead (the floor gap does not
    // explain it), but while the line lies more than lead_max_ns above its floor every PES is stale,
    // video's too (the first clause; the floor shows in the PCR, which a PES leads by up to 100 ms).
    const ClampRun k = clamp_run("... PCR mode, a 6 s reconnect backlog at 40 s", backlog, 90, 43, hold);
    int64_t k_hi;
    int k_stale;
    drain_leads(k, &k_hi, &k_stale);
    std::printf("  PCR mode, backlog: %d video PES of the backlog stale, the rest at most %.3f ms ahead\n", k_stale,
                k_hi / 1e6);
    CHECK("vstc PCR mode, backlog: a PID far ahead maps until the line lies past lead_max_ns above its floor, then stale",
          kinds_are(k.ev, {StcEvent::Kind::leap, StcEvent::Kind::relock}) && k_stale > 50 &&
              k_hi > 13400 * MS + 2 * S && k_hi <= 13400 * MS + 4100 * MS);
}

// D1's window (B-48): video's lead on the floor 3.95 s, just under lead_max_ns, and the floor 100 ms
// lower from 3 s, so under the line, until the slew brings it down, video reads up to 4.05 s. A gap
// under backlog_ns is jitter or a fall, not a backlog: video is never stale; it is the lead row's.
void test_vstc_window() {
    auto window = [](int pid, int64_t t) {
        Shape s;
        if (pid == PID_V) s.pts_ns = 3150 * MS;
        s.net_ns = t < 3 * S ? 100 * MS : 0;
        return s;
    };
    PcrValidatorConfig hold;
    hold.lead_hold_ns = 1000 * S;
    const ClampRun a = clamp_run("video 3.95 s ahead, the floor 100 ms lower from 3 s, PCR mode", window, 60, 44, hold);
    int64_t lo, hi;
    a.leads(PID_V, H0 + 4 * S, &lo, &hi);
    std::printf("  window, PCR mode: %d video PES stale, video lead %.3f..%.3f ms from 4 s\n", a.stale(PID_V),
                lo / 1e6, hi / 1e6);
    CHECK("vstc window: a PID past lead_max_ns under a line less than backlog_ns above its floor is never stale",
          a.ev.empty() && a.stale(PID_V) == 0 && a.stale(PID_A) == 0 && hi > 4 * S && hi < 4100 * MS);
    // Degraded, every PES maps on the reference epoch (one timeline, B-96), where video reads 3.95 s:
    // under lead_clamp_ns, no clamp (the frozen PCR epoch, the straddle pick before, read past 4 s).
    const ClampRun b = clamp_run("... the lead row on", window, 90, 44);
    CHECK("vstc window: ... the lead row degrades the program (lead) and it recovers, no clamp, nothing stale",
          kinds_are(b.ev, {StcEvent::Kind::degraded, StcEvent::Kind::recovered}) && b.degraded_first() &&
              b.clamps.empty() && b.stale(PID_V) == 0 && b.stale(PID_A) == 0);
}

// B-90: the lower bound reads a PES's PTS less its last PCR, not its lead against arrival, which a
// late delivery moves: a 100 ms mux delivered 400 ms above its floor is no PCR fault; a rise that
// holds relocks by the envelope step once locked, and a PTS behind its PCR still degrades.
struct LeadCase {
    std::vector<StcEvent> ev;
    VirtualStc::State end = VirtualStc::State::acquiring;
    int64_t locked_at = -1;   // rel() of the first stats in state locked
};

template <class F>
LeadCase lead_case(const char* label, F shape, int64_t secs, uint64_t seed) {
    VirtualStc v;
    Fnv f;
    LeadCase r;
    drive(v, program(secs, 50000, seed, shape), f, [&](const Pkt& p, const VirtualStc::Mapping&) {
        if (r.locked_at < 0 && v.state() == VirtualStc::State::locked) r.locked_at = rel(p.h);
    });
    r.ev = fold_events(v, f);
    r.end = v.state();
    print_events(label, r.ev);
    g_all.add((int64_t)f.h);
    return r;
}

// Every PES 100 ms ahead of the PCR: audio's 500 ms and video's 800 ms less 400 and 700 ms.
Shape lead100(int pid) {
    Shape s;
    s.pts_ns = pid == PID_A ? -400 * MS : pid == PID_V ? -700 * MS : 0;
    return s;
}

// ... and from `at` for `len` (0: for good) the path's floor 400 ms higher, the PCR's too.
Shape late400(int pid, int64_t t, int64_t at, int64_t len) {
    Shape s = lead100(pid);
    if (t >= at && (len == 0 || t < at + len)) s.net_ns = 400 * MS;
    return s;
}

void test_vstc_stream_lead() {
    const LeadCase a = lead_case("100 ms lead, delivery +400 ms for 8 s at 10 s (acquiring)",
                                 [](int pid, int64_t t) { return late400(pid, t, 10 * S, 8 * S); }, 90, 71);
    CHECK("vstc stream lead: a 100 ms mux delivered 400 ms late for 8 s while acquiring: no event, locked after",
          a.ev.empty() && a.end == VirtualStc::State::locked && a.locked_at > 18 * S);
    const LeadCase b = lead_case("... at 60 s (locked)",
                                 [](int pid, int64_t t) { return late400(pid, t, 60 * S, 8 * S); }, 90, 72);
    CHECK("vstc stream lead: ... once locked: no event (shorter than the step's 10 s hold), still locked",
          b.ev.empty() && b.end == VirtualStc::State::locked && b.locked_at < 60 * S);
    const LeadCase c = lead_case("... from 60 s for good (locked)",
                                 [](int pid, int64_t t) { return late400(pid, t, 60 * S, 0); }, 90, 73);
    CHECK("vstc stream lead: a rise that holds is the envelope step's: one relock about 10 s after it, never degraded",
          kinds_are(c.ev, {StcEvent::Kind::envelope_step, StcEvent::Kind::relock}) &&
              !std::strcmp(c.ev[1].reason, "envelope-step") && rel(c.ev[1].house_ns) >= 69500 * MS &&
              rel(c.ev[1].house_ns) <= 71500 * MS && c.ev[0].value_ns > 380 * MS && c.ev[0].value_ns < 420 * MS &&
              c.end == VirtualStc::State::locked);

    // The PTS 300 ms behind its own PCR (audio -800 ms, video -1100 ms) until 40 s, then 100 ms ahead.
    auto behind = [](int pid, int64_t t) {
        Shape s = lead100(pid);
        if (t < 40 * S && pid != PCR_PID) s.pts_ns -= 400 * MS;
        return s;
    };
    const LeadCase d = lead_case("PTS 300 ms behind its PCR until 40 s, then 100 ms ahead", behind, 90, 74);
    CHECK("vstc stream lead: a PTS behind its own PCR degrades (lead) at 5 s, recovered 30 s after it is back",
          kinds_are(d.ev, {StcEvent::Kind::degraded, StcEvent::Kind::recovered}) && !std::strcmp(d.ev[0].reason, "lead") &&
              rel(d.ev[0].house_ns) >= 5 * S && rel(d.ev[0].house_ns) <= 5600 * MS && rel(d.ev[1].house_ns) >= 70 * S &&
              rel(d.ev[1].house_ns) <= 71 * S && d.end == VirtualStc::State::locked);
    // PTS 300 ms behind the PCR throughout, starting on a 90 s caller backlog drained in 5 s, stale
    // 7 s under the seed line: that keeps the arrival half out, not this, so it degrades 5 s on; one
    // timeline (B-96), nothing maps back on the frozen backlog line, whose 89 s ahead drew a clamp.
    auto backlog = [](int pid, int64_t t) {
        Shape s = queued_at(pid, t, 0, 90 * S, 5 * S);
        s.pts_ns = lead100(pid).pts_ns - (pid != PCR_PID ? 400 * MS : 0);
        return s;
    };
    const LeadCase e = lead_case("... from a 90 s backlog drained in 5 s", backlog, 120, 76);
    CHECK("vstc stream lead: ... a backlog's stale PES still show it: degraded (lead) 5 s after they arrive, no clamp",
          kinds_are(e.ev, {StcEvent::Kind::degraded}) && !std::strcmp(e.ev[0].reason, "lead") &&
              rel(e.ev[0].house_ns) >= 95 * S && rel(e.ev[0].house_ns) <= 95600 * MS);
}

// B-90's exit rule: the PCR stuck 60-61 s degrades the program (freeze); from 62 s the delivery
// stalls 250 ms every 2 s, each stall one frozen PCR pair, which alone fails no row. The recovery
// clock runs from the freeze row's last failing pair: recovered 30 s after it, not held for good.
void test_vstc_recovery() {
    auto jittery = [](int pid, int64_t t) {
        Shape s;
        if (pid == PCR_PID && t >= 60 * S && t < 61 * S) s.pcr_ns = 60 * S - t;
        if (t >= 62 * S && t % (2 * S) < 4 * MS) s.net_ns = 250 * MS;   // what follows queues behind
        return s;
    };
    const LeadCase r = lead_case("PCR stuck 60-61 s, then a 250 ms stall every 2 s", jittery, 150, 75);
    CHECK("vstc recovery: degraded (freeze) at the third frozen pair, the PCR's return a leap",
          r.ev.size() >= 2 && r.ev[0].kind == StcEvent::Kind::degraded && !std::strcmp(r.ev[0].reason, "freeze") &&
              rel(r.ev[0].house_ns) >= 60200 * MS && rel(r.ev[0].house_ns) <= 60500 * MS &&
              r.ev[1].kind == StcEvent::Kind::leap);
    CHECK("vstc recovery: ... recovered 30 s after the freeze row last failed, the stalls' single pairs aside",
          kinds_are(r.ev, {StcEvent::Kind::degraded, StcEvent::Kind::leap, StcEvent::Kind::recovered}) &&
              rel(r.ev[2].house_ns) >= 90800 * MS && rel(r.ev[2].house_ns) <= 91500 * MS &&
              r.end == VirtualStc::State::locked);
}

// B-86: program()'s PCR on every 20th slot only, a steady 2 s PCR (vMix's), and none in
// [from, to) while the PES flow on (audio the reference).
Shape sparse2s(int pid, int64_t t, int64_t from = -1, int64_t to = -1) {
    Shape s;
    s.drop = pid == PCR_PID && (t % (2 * S) != 0 || (from >= 0 && t >= from && t < to));
    return s;
}

struct SparseRun {
    std::vector<StcEvent> ev;
    int64_t locked_at = -1, resid_min = INT64_MAX;   // rel(); the lowest 2 s residual once locked
    VirtualStc::State at102 = VirtualStc::State::acquiring, at104 = VirtualStc::State::acquiring;
    VirtualStc::LeadStats a130, v130;                // the leads at 130 s
    VirtualStc::Stats end;
};

template <class F>
SparseRun sparse_run(const char* label, F shape, int64_t secs, uint64_t seed) {
    VirtualStc v;
    Fnv f;
    SparseRun r;
    int64_t next = 0;
    drive(v, program(secs, 50000, seed, shape), f, [&](const Pkt& p, const VirtualStc::Mapping&) {
        const VirtualStc::State st = v.state();
        if (r.locked_at < 0 && st == VirtualStc::State::locked) r.locked_at = rel(p.h);
        if (p.t < 102 * S) r.at102 = st;
        if (p.t < 104 * S) r.at104 = st;
        if (p.t < 130 * S) {
            r.a130 = v.lead(PID_A);
            r.v130 = v.lead(PID_V);
        }
        if (st == VirtualStc::State::locked && p.h >= next) {
            const VirtualStc::Stats s = v.stats();
            if (s.residual.count) r.resid_min = std::min(r.resid_min, s.residual.min_ns);
            next = p.h + 2 * S;
        }
    });
    r.ev = fold_events(v, f);
    r.end = v.stats();
    print_events(label, r.ev);
    std::printf("  %s: locked at %.1f s, residual min %.3f ms once locked, leads a/v %.2f/%.2f ms at 130 s, "
                "end %s epoch %u cadence %.0f ms\n", label, r.locked_at / 1e9, r.resid_min / 1e6,
                r.a130.median_ns / 1e6, r.v130.median_ns / 1e6, state_name(r.end.state), r.end.epoch,
                r.end.pcr_cadence_ns / 1e6);
    g_all.add((int64_t)f.h);
    return r;
}

void test_vstc_sparse() {
    const SparseRun a = sparse_run("a steady 2 s PCR", [](int pid, int64_t t) { return sparse2s(pid, t); }, 150, 81);
    CHECK("vstc sparse: a steady 2 s PCR locks (60-80 s: 30 one-sample buckets), no event in 150 s",
          a.ev.empty() && a.locked_at >= 60 * S && a.locked_at <= 80 * S && a.end.state == VirtualStc::State::locked &&
              a.end.epoch == 1 && !a.end.cadence_warning && a.end.pcr_cadence_ns == 2 * S);
    CHECK("vstc sparse: ... source-natural leads (audio 480-500 ms, video 780-800 ms), residual min >= -2 ms",
          a.a130.median_ns >= 480 * MS && a.a130.median_ns <= 500 * MS && a.v130.median_ns >= 780 * MS &&
              a.v130.median_ns <= 800 * MS && a.resid_min >= -2 * MS);
    // The PCR stops after 98 s while the PES flow on, back from 140 s.
    const SparseRun r = sparse_run("2 s PCR missing 100-140 s",
                                   [](int pid, int64_t t) { return sparse2s(pid, t, 100 * S, 140 * S); }, 200, 82);
    CHECK("vstc sparse stop: locked before, lost (No PCR) 5 s after the last PCR",
          r.locked_at > 0 && r.locked_at < 98 * S && r.at102 == VirtualStc::State::locked &&
              r.at104 == VirtualStc::State::lost);
    CHECK("vstc sparse stop: degraded (cadence) at the third 4 s crossing (110 s), recovered 30 s after the last (170 s)",
          kinds_are(r.ev, {StcEvent::Kind::degraded, StcEvent::Kind::recovered}) &&
              !std::strcmp(r.ev[0].reason, "cadence") && iabs(rel(r.ev[0].house_ns) - 110 * S) <= 100 * MS &&
              r.ev[0].epoch == 2 && !std::strcmp(r.ev[1].reason, "cadence") &&
              iabs(rel(r.ev[1].house_ns) - 170 * S) <= 500 * MS && r.ev[1].epoch == 3);
    CHECK("vstc sparse stop: degraded, the reference PID at its earliest arrival (audio -15..+2 ms at 130 s); "
          "locked again at the end, the cadence 2 s (the 42 s interval taught nothing)",
          r.a130.median_ns >= -15 * MS && r.a130.median_ns <= 2 * MS && r.end.state == VirtualStc::State::locked &&
              r.end.epoch == 3 && r.end.pcr_cadence_ns == 2 * S);
}

// The restamp maps the PCR too (part 4.2 step 3): map_pcr gives it its PES's epoch choice, outside
// the lead row; its lag is minus the delay above the floor, so a 230 ms re-route relocks by the
// envelope step. Fed as a PID's lead (map) it now does the same: its stream lead is 0 (B-90).
void test_vstc_map_pcr() {
    auto reroute = [](int pid, int64_t t) {   // the path's floor rises 230 ms at 30 s
        Shape s;
        s.mux_ns = t >= 30 * S ? 230 * MS : 0;
        if (pid == PCR_PID) s.pcr_ns = -s.mux_ns;
        return s;
    };
    const std::vector<Pkt> pk = program(70, 50000, 36, reroute);
    for (const bool own : {true, false}) {
        VirtualStc v;
        Fnv f;
        int behind = 0, pcrs = 0;         // audio PES on an older epoch than a PCR before them
        uint32_t pcr_epoch = 0;
        int64_t lag_min = INT64_MAX, lag_max = INT64_MIN;   // house - arrival, before the re-route
        for (const Pkt& p : pk) {
            if (p.pid != PCR_PID) {
                if (p.pid == PID_A) v.feed_ref_pes(p.pid, p.v, p.h);
                const VirtualStc::Mapping m = v.map(p.pid, p.v, p.h);
                if (p.pid == PID_A) behind += m.valid && m.epoch < pcr_epoch;
                continue;
            }
            v.feed_pcr(p.v, p.di, p.h);
            const VirtualStc::Mapping m = own ? v.map_pcr(p.h) : v.map(0x2000, v.source_stc_90k(), p.h);
            if (!m.valid || v.state() == VirtualStc::State::degraded) continue;
            pcrs++;
            pcr_epoch = std::max(pcr_epoch, m.epoch);
            if (p.t >= 10 * S && p.t < 30 * S) {
                lag_min = std::min(lag_min, m.house_ns - p.h);
                lag_max = std::max(lag_max, m.house_ns - p.h);
            }
        }
        const std::vector<StcEvent> ev = fold_events(v, f);
        print_events(own ? "re-route +230 ms at 30 s, PCR by map_pcr" : "... the PCR by map (a PID's lead)", ev);
        if (!own) {
            CHECK("vstc map_pcr: the PCR's lag fed as a PID's lead no longer degrades: the same step relock (B-90)",
                  kinds_are(ev, {StcEvent::Kind::envelope_step, StcEvent::Kind::relock}) &&
                      v.state() == VirtualStc::State::locked);
            continue;
        }
        std::printf("  map_pcr: %d PCRs mapped, house - arrival %.3f..%.3f ms before the re-route, %d audio PES "
                    "behind a PCR's epoch\n",
                    pcrs, lag_min / 1e6, lag_max / 1e6, behind);
        CHECK("vstc map_pcr: the re-route re-locks by the envelope step, never degraded",
              kinds_are(ev, {StcEvent::Kind::envelope_step, StcEvent::Kind::relock}) &&
                  !std::strcmp(ev[1].reason, "envelope-step") && v.state() == VirtualStc::State::locked);
        CHECK("vstc map_pcr: the PCR at its floor arrival (house - arrival = minus its delay above it)",
              pcrs > 600 && lag_max <= 1 * MS && lag_min >= -51 * MS);
        CHECK("vstc map_pcr: no audio PES on an older epoch than a PCR before it (PTS - PCR never shrinks)",
              behind == 0 && pcr_epoch == 2);
    }
    CHECK("vstc map_pcr: invalid before the first PCR", !VirtualStc().map_pcr(H0).valid);
}

// Per PID (the PCR: key -1): epoch switches, those back onto an older epoch, and house
// PTS stepping back.
struct Switches {
    std::map<int, int> n, back, steps_back;
    std::map<int, uint32_t> last;
    std::map<int, int64_t> last_h;
    void note(int key, const VirtualStc::Mapping& m) {
        if (!m.valid) return;
        if (last.count(key) && m.epoch != last[key]) {
            n[key]++;
            back[key] += m.epoch < last[key];
        }
        if (key >= 0 && last_h.count(key) && m.house_ns <= last_h[key]) steps_back[key]++;
        last[key] = m.epoch;
        last_h[key] = m.house_ns;
    }
    int total(const std::map<int, int>& m) const {
        int t = 0;
        for (const auto& kv : m) t += kv.second;
        return t;
    }
};

void test_vstc_floor_moves() {
    {   // The floor falls 100 ms at 30 s, inside the first rate fit's window.
        VirtualStc v;
        Fnv f;
        Switches w;
        auto fall = [](int, int64_t t) {
            Shape s;
            s.net_ns = t < 30 * S ? 100 * MS : 0;
            return s;
        };
        drive(v, program(120, 50000, 37, fall), f, [&](const Pkt& p, const VirtualStc::Mapping& m) { w.note(p.pid, m); });
        const std::vector<StcEvent> ev = fold_events(v, f);
        print_events("floor -100 ms at 30 s", ev);
        const VirtualStc::Stats s = v.stats();
        std::printf("  floor -100 ms: state %s ppb %lld, house PTS steps back %d\n", state_name(s.state),
                    (long long)s.ppb, w.total(w.steps_back));
        CHECK("vstc fall: -100 ms at 30 s never degrades (the rate row) nor re-locks, the rate the source's",
              ev.empty() && s.state == VirtualStc::State::locked && iabs(s.ppb - 50000) <= 5000);
        CHECK("vstc fall: ... house PTS never steps back", w.total(w.steps_back) == 0);
        g_all.add((int64_t)f.h);
    }
    {   // A queue builds up 200 ms over 20 s from 30 s: re-locks while the delay still moves.
        VirtualStc v;
        Fnv f;
        Switches w;
        auto queue = [](int, int64_t t) {
            Shape s;
            s.net_ns = t < 30 * S ? 0 : t >= 50 * S ? 200 * MS : 200 * MS / 1000 * ((t - 30 * S) / MS) / 20000 * 1000;
            return s;
        };
        for (const Pkt& p : program(90, 50000, 38, queue)) {
            if (p.pid == PCR_PID) {
                v.feed_pcr(p.v, p.di, p.h);
                w.note(-1, v.map_pcr(p.h));
                continue;
            }
            if (p.pid == PID_A) v.feed_ref_pes(p.pid, p.v, p.h);
            w.note(p.pid, v.map(p.pid, p.v, p.h));
        }
        const std::vector<StcEvent> ev = fold_events(v, f);
        print_events("queue +200 ms over 20 s", ev);
        int relocks = 0;
        for (const StcEvent& e : ev) relocks += e.kind == StcEvent::Kind::relock;
        std::printf("  queue: %d relock(s); switches audio %d video %d pcr %d, back onto an older epoch %d\n", relocks,
                    w.n[PID_A], w.n[PID_V], w.n[-1], w.total(w.back));
        CHECK("vstc queue: re-locked by envelope steps, never degraded",
              relocks >= 1 && std::all_of(ev.begin(), ev.end(), [](const StcEvent& e) {
                  return e.kind == StcEvent::Kind::envelope_step ||
                         (e.kind == StcEvent::Kind::relock && !std::strcmp(e.reason, "envelope-step"));
              }));
        CHECK("vstc queue: every PID and the PCR leave the old epoch once per relock, never back, house PTS forward",
              w.n[PID_A] == relocks && w.n[PID_V] == relocks && w.n[-1] == relocks && w.total(w.back) == 0 &&
                  w.total(w.steps_back) == 0);
        g_all.add((int64_t)f.h);
    }
}

// B-95 on the program: shapes of the path's floor delay against its usual level, from t0. A burst
// and its dip (C1): +200 for 1 s, +400 for 11 s, +200 for 1 s, 200 under the usual level for 11 s.
int64_t dip_net(int64_t t, int64_t t0) {
    const int64_t d = t - t0;
    if (d < 0 || d >= 24 * S) return 0;
    return d < 1 * S ? 200 * MS : d < 12 * S ? 400 * MS : d < 13 * S ? 200 * MS : -200 * MS;
}

// TECH01's plateau as the fixtures have it: +200 for 1 s, +400 for 12 s, +200 for 1 s, -200 for 11 s.
int64_t plateau_net(int64_t t, int64_t t0) {
    const int64_t d = t - t0;
    if (d < 0 || d >= 25 * S) return 0;
    return d < 1 * S ? 200 * MS : d < 13 * S ? 400 * MS : d < 14 * S ? 200 * MS : -200 * MS;
}

// A rise that stays: +200 for 1 s, then +400.
int64_t held_net(int64_t t, int64_t t0) { return t < t0 ? 0 : t - t0 < 1 * S ? 200 * MS : 400 * MS; }

// A steep onset: +275 twice a second apart (a leap only within one 2 s PCR interval), +550 for 12 s
// from t0, a 200 ms dip of 11 s.
int64_t steep_net(int64_t t, int64_t t0) {
    const int64_t d = t - t0;
    return d < 0 ? 0 : d < 1 * S ? 275 * MS : d < 13 * S ? 550 * MS : d < 24 * S ? -200 * MS : 0;
}

// The onset within one 2 s PCR interval (+550 at once from an odd second, a leap), 12 s, the tail
// stepped down 375 + 375 ms over two intervals (no leap), a 200 ms dip of 11 s.
int64_t onset_net(int64_t t, int64_t t0) {
    const int64_t d = t - t0;
    return d < 0 ? 0 : d < 12 * S ? 550 * MS : d < 14 * S ? 175 * MS : d < 25 * S ? -200 * MS : 0;
}

// Per PID: epoch changes and house PTS stepping back, with their times (rel()); holes, the house
// advance less the arrival advance between consecutive PES after 10 s; stale PES; leads at 50-190 s.
struct HeldRun {
    struct At {
        int pid;
        int64_t t, ns;
    };
    std::vector<StcEvent> ev;
    std::vector<At> changes, backs, holes;   // holes over 300 ms
    std::map<int, int64_t> hole_max, hole_at, stale_first, stale_last, lead50, lead100, lead140, lead190;
    std::map<int, int> stale;
    VirtualStc::State end = VirtualStc::State::acquiring;
    int count(StcEvent::Kind k, const char* why = nullptr) const {
        int n = 0;
        for (const StcEvent& e : ev) n += e.kind == k && (!why || !std::strcmp(e.reason, why));
        return n;
    }
    std::vector<int64_t> relocks_at(const char* why = nullptr) const {
        std::vector<int64_t> v;
        for (const StcEvent& e : ev)
            if (e.kind == StcEvent::Kind::relock && (!why || !std::strcmp(e.reason, why)))
                v.push_back(rel(e.house_ns));
        return v;
    }
    std::vector<const At*> of(const std::vector<At>& v, int pid) const {
        std::vector<const At*> out;
        for (const At& a : v)
            if (a.pid == pid) out.push_back(&a);
        return out;
    }
    int64_t rise(const std::map<int, int64_t>& later, int pid) const { return later.at(pid) - lead50.at(pid); }
};

template <class F>
HeldRun held_run(const char* label, F shape, int64_t secs, uint64_t seed, const std::vector<Hold>& live = {}) {
    VirtualStc v;
    Fnv f;
    HeldRun r;
    std::map<int, uint32_t> last_e;
    std::map<int, int64_t> last_h, last_arr;
    size_t li = 0;
    drive(v, program(secs, 50000, seed, shape), f, [&](const Pkt& p, const VirtualStc::Mapping& m) {
        // A live hold after the first PES sent at or after its time (the restamp's next buffer).
        while (li < live.size() && p.t >= live[li].at_ns) v.set_step_fall_hold(live[li++].hold_ns);
        if (m.stale) {
            r.stale[p.pid]++;
            if (!r.stale_first.count(p.pid)) r.stale_first[p.pid] = p.t;
            r.stale_last[p.pid] = p.t;
        }
        if (m.valid) {
            if (last_e.count(p.pid) && m.epoch != last_e[p.pid]) r.changes.push_back({p.pid, rel(p.h), 0});
            if (last_h.count(p.pid) && m.house_ns <= last_h[p.pid])
                r.backs.push_back({p.pid, rel(p.h), last_h[p.pid] - m.house_ns});
            if (last_h.count(p.pid) && rel(p.h) > 10 * S) {
                const int64_t d = (m.house_ns - last_h[p.pid]) - (p.h - last_arr[p.pid]);
                if (d > 300 * MS) r.holes.push_back({p.pid, rel(p.h), d});
                if (!r.hole_max.count(p.pid) || d > r.hole_max[p.pid]) {
                    r.hole_max[p.pid] = d;
                    r.hole_at[p.pid] = rel(p.h);
                }
            }
            last_e[p.pid] = m.epoch;
            last_h[p.pid] = m.house_ns;
            last_arr[p.pid] = p.h;
        }
        for (const auto& w : {std::make_pair(50 * S, &r.lead50), std::make_pair(100 * S, &r.lead100),
                              std::make_pair(140 * S, &r.lead140), std::make_pair(190 * S, &r.lead190)})
            if (p.t >= w.first && !w.second->count(p.pid)) (*w.second)[p.pid] = v.lead(p.pid).median_ns;
    });
    r.ev = fold_events(v, f);
    r.end = v.state();
    print_events(label, r.ev);
    std::printf("  %s:", label);
    for (const int pid : {PID_V, PID_A}) {
        std::printf(" pid 0x%x changes", pid);
        for (const HeldRun::At* a : r.of(r.changes, pid)) std::printf(" %.2f", a->t / 1e9);
        std::printf(", back");
        for (const HeldRun::At* a : r.of(r.backs, pid)) std::printf(" %.1f ms @%.2f", a->ns / 1e6, a->t / 1e9);
        auto ms = [pid](const std::map<int, int64_t>& m) { return m.count(pid) ? m.at(pid) / 1e6 : 0.0; };
        std::printf(", hole max %.1f ms @%.2f, stale %d, lead 50/100/140/190 s %.0f/%.0f/%.0f/%.0f ms;",
                    ms(r.hole_max), ms(r.hole_at) / 1e3, r.stale.count(pid) ? r.stale[pid] : 0, ms(r.lead50),
                    ms(r.lead100), ms(r.lead140), ms(r.lead190));
    }
    std::printf(" end %s\n", state_name(r.end));
    g_all.add((int64_t)f.h);
    return r;
}

bool near(int64_t t, int64_t want, int64_t tol) { return iabs(t - want) <= tol; }

// The times in `got` are `want`'s, each within tol, and as many.
bool times_are(const std::vector<int64_t>& got, std::initializer_list<int64_t> want, int64_t tol) {
    if (got.size() != want.size()) return false;
    size_t i = 0;
    for (const int64_t w : want)
        if (!near(got[i++], w, tol)) return false;
    return true;
}

void test_vstc_step_epoch() {
    const int64_t T = 1500 * MS;   // the times' tolerance (the jitter's)
    // 8: case 1's burst and dip on the PCR path.
    const HeldRun r8 = held_run("vstc step epoch (burst and dip from 60 s)", [](int, int64_t t) {
        Shape s;
        s.net_ns = dip_net(t, 60 * S);
        return s;
    }, 150, 81);
    bool rises = true;
    for (const int pid : {PID_V, PID_A}) rises &= within(r8.rise(r8.lead100, pid), 380 * MS, 440 * MS);
    CHECK("vstc step epoch: one envelope-step relock, every PID leaves the old epoch once, never back nor steps "
          "back, locked; the leads at 100 s 380-440 ms over 50 s's (the burst's height held)",
          kinds_are(r8.ev, {StcEvent::Kind::envelope_step, StcEvent::Kind::relock}) && r8.changes.size() == 2 &&
              r8.backs.empty() && r8.end == VirtualStc::State::locked && rises);
    // 9: video 2.9 s further ahead (3,695 ms at 50 s): within the held excess of lead_max_ns.
    const HeldRun r9 = held_run("vstc step epoch, video +2900 ms", [](int pid, int64_t t) {
        Shape s;
        s.net_ns = dip_net(t, 60 * S);
        if (pid == PID_V) s.pts_ns = 2900 * MS;
        return s;
    }, 150, 81);
    CHECK("vstc step epoch: the stale clause yields: video's stale run ends within 2 s of the dip's first close "
          "(by 76 s), the line moves as before B-95, the pair follows (relocks at 70.1, 94.2 s), never degraded",
          r9.stale.count(PID_V) && r9.stale_first.at(PID_V) >= 72 * S && r9.stale_last.at(PID_V) <= 76 * S &&
              times_are(r9.relocks_at("envelope-step"), {70110 * MS, 94210 * MS}, T) &&
              r9.count(StcEvent::Kind::relock) == 2 && r9.count(StcEvent::Kind::degraded) == 0);
    // 10: the PCR frozen 60-61 s (degraded, freeze), the burst while degraded: the PCR lock steps
    // silently; its line serves the recovery's epoch as a step epoch's (B-95's scope).
    for (const int64_t t0 : {64 * S, 70 * S}) {
        const HeldRun r10 = held_run(t0 == 64 * S ? "vstc step epoch, freeze 60 s, burst from 64 s"
                                                  : "vstc step epoch, freeze 60 s, burst from 70 s",
                                     [t0](int pid, int64_t t) {
                                         Shape s;
                                         if (pid == PCR_PID && t >= 60 * S && t < 61 * S) s.pcr_ns = 60 * S - t;
                                         s.net_ns = dip_net(t, t0);
                                         return s;
                                     }, 200, 82);
        int64_t rec = -1;
        for (const StcEvent& e : r10.ev)
            if (e.kind == StcEvent::Kind::recovered) rec = rel(e.house_ns);
        bool quiet = rec >= 0;
        for (const StcEvent& e : r10.ev)
            quiet &= !(e.kind == StcEvent::Kind::envelope_step && within(rel(e.house_ns), rec + 1, rec + 60 * S));
        // The recovered line holds the burst's height, as case 8's at 100 s (b95s: B-95's review).
        bool held = rec >= 0 && rec < 140 * S;
        for (const int pid : {PID_V, PID_A}) held &= within(r10.rise(r10.lead140, pid), 380 * MS, 440 * MS);
        CHECK(t0 == 64 * S ? "vstc step epoch: a line the PCR lock seeded while degraded stays a step epoch's: no "
                             "step within 60 s of the recovery, every PID's lead at 140 s 380-440 ms over 50 s's "
                             "(the burst from 64 s)"
                           : "vstc step epoch: ... the burst from 70 s alike",
              r10.count(StcEvent::Kind::degraded, "freeze") == 1 && r10.count(StcEvent::Kind::recovered) == 1 &&
                  quiet && held);
    }
    // 11: video 4.5 s ahead: degraded (lead) at 5 s, B-8's clamp on it; the bursts at 100 and 250 s.
    const HeldRun r11 = held_run("vstc step epoch, video clamped (+4500 ms), bursts at 100 and 250 s",
                                 [](int pid, int64_t t) {
                                     Shape s;
                                     if (pid == PID_V) s.pts_ns = 4500 * MS;
                                     s.net_ns = dip_net(t, 100 * S) + dip_net(t, 250 * S);
                                     return s;
                                 }, 400, 83);
    const std::vector<const HeldRun::At*> c11 = r11.of(r11.changes, PID_V), b11 = r11.of(r11.backs, PID_V);
    CHECK("vstc step epoch: the clamp lock: video changes epoch twice (the clamp at 5 s, its lock's step at 110 s) "
          "and steps back only at the clamp's entry",
          r11.count(StcEvent::Kind::degraded, "lead") == 1 && c11.size() == 2 && near(c11[0]->t, 5050 * MS, T) &&
              near(c11[1]->t, 110090 * MS, T) && b11.size() == 1 && near(b11[0]->t, 5050 * MS, 500 * MS) &&
              b11[0]->ns > 5 * S);
    // 12a: the PCR every 2 s (sparse2s), TECH01's plateau from 61 s: its tail is a leap-sized fall
    // between two PCRs, a leap relock as before B-95 (the stated limit).
    const HeldRun r12a = held_run("vstc step epoch, 2 s PCR, the plateau's tail", [](int pid, int64_t t) {
        Shape s = sparse2s(pid, t);
        s.net_ns = plateau_net(t, 61 * S);
        return s;
    }, 200, 84);
    bool a_ok = r12a.count(StcEvent::Kind::leap) == 1;
    for (const int pid : {PID_V, PID_A}) {
        const std::vector<const HeldRun::At*> b = r12a.of(r12a.backs, pid);
        a_ok &= b.size() == 1 && near(b[0]->t, 75820 * MS, 500 * MS) && within(b[0]->ns, 520 * MS, 580 * MS) &&
                iabs(r12a.rise(r12a.lead190, pid)) <= 10 * MS;
    }
    CHECK("vstc step epoch: at a 2 s PCR a burst's leap-sized tail relocks as a leap (the limit): step, leap, step "
          "(74.4, 75.8, 96.0 s), one step back per PID at the leap, the lead back at 190 s",
          a_ok && times_are(r12a.relocks_at(), {74400 * MS, 75820 * MS, 96010 * MS}, T) &&
              r12a.relocks_at("leap").size() == 1);
    // 12b and 12c: one step held (+400 from 60 s), then the source timeline jumps 1 s forward at 150 s.
    auto jump = [](int pid, int64_t t, bool sparse) {
        Shape s = sparse ? sparse2s(pid, t) : Shape();
        s.net_ns = held_net(t, 60 * S);
        if (t >= 150 * S) (pid == PCR_PID ? s.pcr_ns : s.pts_ns) = 1000 * MS;
        return s;
    };
    const HeldRun r12b = held_run("vstc step epoch, 2 s PCR, a +1 s jump at 150 s",
                                  [&](int pid, int64_t t) { return jump(pid, t, true); }, 200, 85);
    const HeldRun r12c = held_run("vstc step epoch, 100 ms PCR, a +1 s jump at 150 s",
                                  [&](int pid, int64_t t) { return jump(pid, t, false); }, 200, 85);
    bool jumps = true;
    for (const HeldRun* r : {&r12b, &r12c}) {
        const std::vector<int64_t> l = r->relocks_at("leap");
        jumps &= r->count(StcEvent::Kind::relock) == 2 && r->relocks_at("envelope-step").size() == 1 &&
                 l.size() == 1 && within(l[0], 150 * S, 152500 * MS) && r->backs.empty();
        for (const int pid : {PID_V, PID_A}) jumps &= iabs(r->lead190.at(pid) - r->lead140.at(pid)) <= 50 * MS;
    }
    for (const int pid : {PID_V, PID_A})
        jumps &= near(r12b.hole_at.at(pid), 74410 * MS, 1 * S) && r12b.hole_max.at(pid) < 450 * MS;
    CHECK("vstc step epoch: a genuine +1 s jump on a held line relocks as a leap within 2.5 s, at a 2 s PCR and at "
          "100 ms: no step back, the leads as before it, no hole at the jump (the step's own the largest)",
          jumps && times_are(r12b.relocks_at("envelope-step"), {74410 * MS}, T) &&
              times_are(r12c.relocks_at("envelope-step"), {70010 * MS}, T));
    // 12d: a 2 s PCR, the onset over leap_ns within one interval (a leap), the tail stepped down: the leap
    // epoch keeps the backlog rule, the pair stays (the limit's other half). The same from 131 s.
    const HeldRun r12d = held_run("vstc step epoch, 2 s PCR, an onset of +550 ms in one interval",
                                  [](int pid, int64_t t) {
                                      Shape s = sparse2s(pid, t);
                                      s.net_ns = onset_net(t, 61 * S) + onset_net(t, 131 * S);
                                      return s;
                                  }, 200, 86);
    bool d_ok = r12d.count(StcEvent::Kind::leap) == 2;
    for (const StcEvent& e : r12d.ev)
        if (e.kind == StcEvent::Kind::leap) d_ok &= within(e.value_ns, -600 * MS, -500 * MS);
    for (const int pid : {PID_V, PID_A}) {
        const std::vector<const HeldRun::At*> b = r12d.of(r12d.backs, pid), h = r12d.of(r12d.holes, pid);
        d_ok &= b.size() == 2 && near(b[0]->t, 79815 * MS, 1 * S) && near(b[1]->t, 149820 * MS, 1 * S) &&
                h.size() == 2 && near(h[0]->t, 62560 * MS, 500 * MS) && near(h[1]->t, 132560 * MS, 500 * MS) &&
                iabs(r12d.rise(r12d.lead190, pid)) <= 10 * MS;
        for (const HeldRun::At* x : b) d_ok &= within(x->ns, 700 * MS, 740 * MS);
        for (const HeldRun::At* x : h) d_ok &= within(x->ns, 545 * MS, 560 * MS);
    }
    CHECK("vstc step epoch: ... and a steep onset at a 2 s PCR is a leap and keeps the pair: leap, step twice "
          "(62.6/96.0, 132.6/166.0 s), a 700-740 ms move per PID 17 s after each leap, a 545-560 ms hole at each",
          d_ok && times_are(r12d.relocks_at(), {62560 * MS, 96010 * MS, 132560 * MS, 166010 * MS}, T) &&
              r12d.relocks_at("leap").size() == 2);
    // 12e: the +275/+275 onset at the harness's 100 ms PCR: no leap, one step, the burst's height held.
    const HeldRun r12e = held_run("vstc step epoch, 100 ms PCR, a steep onset", [](int, int64_t t) {
        Shape s;
        s.net_ns = steep_net(t, 60 * S) + steep_net(t, 130 * S);
        return s;
    }, 200, 86);
    bool e_ok = r12e.backs.empty() && r12e.count(StcEvent::Kind::leap) == 0 &&
                kinds_are(r12e.ev, {StcEvent::Kind::envelope_step, StcEvent::Kind::relock}) &&
                within(r12e.ev[0].value_ns, 250 * MS, 300 * MS) && near(rel(r12e.ev[0].house_ns), 70060 * MS, T);
    for (const int pid : {PID_V, PID_A})
        e_ok &= within(r12e.rise(r12e.lead100, pid), 540 * MS, 560 * MS) &&
                within(r12e.rise(r12e.lead190, pid), 540 * MS, 560 * MS);
    CHECK("vstc step epoch: ... the same onset at a 100 ms PCR is a step: one relock (70.1 s), no step back, the "
          "leads at 100 and 190 s 540-560 ms over 50 s's",
          e_ok);
    // 12f: TECH01's plateau from 61 and 200 s at a 100 ms PCR, the source timeline 1 s forward at 150 s:
    // the leap relock re-seeds the held line at the usual level, the held excess dropped once per PID.
    const HeldRun r12f = held_run("vstc step epoch, 100 ms PCR, a +1 s jump on the held line",
                                  [](int pid, int64_t t) {
                                      Shape s;
                                      s.net_ns = plateau_net(t, 61 * S) + plateau_net(t, 200 * S);
                                      if (t >= 150 * S) (pid == PCR_PID ? s.pcr_ns : s.pts_ns) = 1000 * MS;
                                      return s;
                                  }, 260, 87);
    bool f_ok = r12f.count(StcEvent::Kind::leap) == 1;
    for (const int pid : {PID_V, PID_A}) {
        const std::vector<const HeldRun::At*> b = r12f.of(r12f.backs, pid);
        f_ok &= b.size() == 1 && near(b[0]->t, 150020 * MS, 500 * MS) && within(b[0]->ns, 335 * MS, 390 * MS) &&
                within(r12f.rise(r12f.lead100, pid), 380 * MS, 420 * MS) &&
                within(r12f.rise(r12f.lead140, pid), 380 * MS, 420 * MS) &&
                iabs(r12f.rise(r12f.lead190, pid)) <= 10 * MS && near(r12f.hole_at.at(pid), 71010 * MS, 500 * MS) &&
                within(r12f.hole_max.at(pid), 380 * MS, 440 * MS);
    }
    CHECK("vstc step epoch: a genuine jump on a held line at a 100 ms PCR drops the held excess once: step, leap, "
          "step (71.0, 150.0, 210.0 s), one 335-390 ms step back per PID at the leap, the leads back at 190 s",
          f_ok && times_are(r12f.relocks_at(), {71000 * MS, 150010 * MS, 210010 * MS}, T) &&
              r12f.relocks_at("leap").size() == 1);
}

// The hold set live on a VirtualStc (b95s): every lock that runs the window rule takes it.
void test_vstc_live_hold() {
    const int64_t T = 1500 * MS;
    auto backs_in = [](const HeldRun& r, int pid, int64_t from, int64_t to) {
        std::vector<const HeldRun::At*> out;
        for (const HeldRun::At* a : r.of(r.backs, pid))
            if (a->t >= from && a->t < to) out.push_back(a);
        return out;
    };
    // The PCR lock: case 8's burst and dip at 60 and 150 s, the hold 0 at 71 s and 300 s at 100 s.
    const HeldRun p = held_run("vstc live hold: bursts at 60 and 150 s, the hold 0 at 71 s, 300 s at 100 s",
                               [](int, int64_t t) {
                                   Shape s;
                                   s.net_ns = dip_net(t, 60 * S) + dip_net(t, 150 * S);
                                   return s;
                               }, 260, 81, {{71 * S, 0}, {100 * S, 300 * S}});
    const HeldRun p0 = held_run("vstc live hold: ... at 300 s throughout", [](int, int64_t t) {
        Shape s;
        s.net_ns = dip_net(t, 60 * S) + dip_net(t, 150 * S);
        return s;
    }, 260, 81);
    auto print_backs = [](const char* label, const HeldRun& r) {
        std::printf("  %s: relocks", label);
        for (const int64_t t : r.relocks_at()) std::printf(" %.2f", t / 1e9);
        for (const int pid : {PID_V, PID_A}) {
            std::printf("; pid 0x%x back", pid);
            for (const HeldRun::At* a : r.of(r.backs, pid)) std::printf(" %.1f ms @%.2f", a->ns / 1e6, a->t / 1e9);
        }
        std::printf("\n");
    };
    print_backs("PCR lock, live", p);
    print_backs("PCR lock, 300 s", p0);
    bool p_ok = times_are(p.relocks_at("envelope-step"), {70110 * MS, 94210 * MS, 160210 * MS}, T) &&
                p.count(StcEvent::Kind::relock) == 3 && times_are(p0.relocks_at(), {70110 * MS}, T) &&
                p.count(StcEvent::Kind::degraded) == 0;
    for (const int pid : {PID_V, PID_A}) {
        const std::vector<const HeldRun::At*> b = p.of(p.backs, pid);
        p_ok &= b.size() == 1 && near(b[0]->t, 75120 * MS, T) && within(b[0]->ns, 540 * MS, 600 * MS) &&
                p0.of(p0.backs, pid).empty();
    }
    CHECK("vstc live hold: the PCR lock: the hold 0 brings the pair back (relocks at 70.1 and 94.2 s, one 540-600 "
          "ms step back per PID at the dip's move, 75.1 s); 300 s again: the next burst's step (160.2 s), its dip "
          "held; at 300 s throughout one relock and no step back",
          p_ok);
    // The reference lock: case 10's freeze at 60 s and burst from 64 s, the hold 0 at 61 s (degraded).
    auto freeze_burst = [](int pid, int64_t t) {
        Shape s;
        if (pid == PCR_PID && t >= 60 * S && t < 61 * S) s.pcr_ns = 60 * S - t;
        s.net_ns = dip_net(t, 64 * S);
        return s;
    };
    const HeldRun r = held_run("vstc live hold: freeze 60 s, burst from 64 s, the hold 0 at 61 s", freeze_burst, 200,
                               82, {{61 * S, 0}});
    const HeldRun r0 = held_run("vstc live hold: ... at 300 s throughout", freeze_burst, 200, 82);
    print_backs("reference lock, live", r);
    print_backs("reference lock, 300 s", r0);
    int64_t rec = -1;
    for (const StcEvent& e : r.ev)
        if (e.kind == StcEvent::Kind::recovered) rec = rel(e.house_ns);
    bool r_ok = r.count(StcEvent::Kind::degraded, "freeze") == 1 && near(rec, 90905 * MS, T) &&
                times_are(r.relocks_at("envelope-step"), {74020 * MS, 98110 * MS}, T);
    for (const int pid : {PID_V, PID_A}) {
        const std::vector<const HeldRun::At*> b = backs_in(r, pid, 61 * S, rec);
        r_ok &= b.size() == 1 && near(b[0]->t, 79020 * MS, T) && within(b[0]->ns, 540 * MS, 600 * MS) &&
                backs_in(r0, pid, 61 * S, 200 * S).empty();
    }
    CHECK("vstc live hold: the reference lock while degraded: the hold 0 moves its step-seeded line at the dip, one "
          "540-600 ms step back per PID at 79.0 s before the recovery (90.9 s); at 300 s none",
          r_ok);
    // The clamp lock: case 11's video 4.5 s ahead, clamped from 5 s, the hold 0 at 105 s.
    auto clamped = [](int pid, int64_t t) {
        Shape s;
        if (pid == PID_V) s.pts_ns = 4500 * MS;
        s.net_ns = dip_net(t, 100 * S) + dip_net(t, 250 * S);
        return s;
    };
    const HeldRun c = held_run("vstc live hold: video clamped, bursts at 100 and 250 s, the hold 0 at 105 s",
                               clamped, 400, 83, {{105 * S, 0}});
    print_backs("clamp lock, live", c);
    const std::vector<const HeldRun::At*> cv = c.of(c.backs, PID_V), cc = c.of(c.changes, PID_V);
    CHECK("vstc live hold: the clamp lock: the hold 0 at 105 s (the clamp made at 5 s) moves the clamped video at "
          "each dip, 540-600 ms back at 115.1 and 265.1 s, the pair's step 24 s after each (134.1, 284.1 s); at "
          "300 s case 11 pins the clamp's entry as the one step back",
          c.count(StcEvent::Kind::degraded, "lead") == 1 && cv.size() == 3 && near(cv[0]->t, 5050 * MS, 500 * MS) &&
              near(cv[1]->t, 115090 * MS, T) && within(cv[1]->ns, 540 * MS, 600 * MS) &&
              near(cv[2]->t, 265100 * MS, T) && within(cv[2]->ns, 540 * MS, 600 * MS) && cc.size() == 5 &&
              near(cc[2]->t, 134090 * MS, T) && near(cc[4]->t, 284100 * MS, T));
}

// B-96: a packet's arrival jitter by its send time and PID alone, 0..max ms.
int64_t jitter_ms(int64_t t, int pid, uint32_t max) {
    uint64_t x = (uint64_t)t * 0x9E3779B97F4A7C15ULL ^ (uint64_t)pid * 0xC2B2AE3D27D4EB4FULL;
    x ^= x >> 29;
    x *= 0xBF58476D1CE4E5B9ULL;
    x ^= x >> 32;
    return (int64_t)((uint32_t)x % (max + 1)) * MS;
}

// B-96: per PID, the PES mapped back on an epoch older than the one a switch opened: while degraded,
// older than the entry's (the epoch the reference PID maps on from the degraded event: opened at the
// entry, or at its first PES on a cold lock), and after the recovery, older than the recovery's.
struct BackRun {
    std::vector<StcEvent> ev;
    int64_t opened = -1;           // rel(): the reference PID's first PES on the entry's epoch
    std::map<int, int> back, back_after;
};

template <class F>
BackRun back_run(const char* label, F shape, int64_t secs, uint64_t seed) {
    VirtualStc v;
    Fnv f;
    struct Rec {
        int pid;
        int64_t h;
        uint32_t epoch;
    };
    std::vector<Rec> recs;
    drive(v, program(secs, 50000, seed, shape), f, [&](const Pkt& p, const VirtualStc::Mapping& m) {
        if (m.valid) recs.push_back(Rec{p.pid, p.h, m.epoch});
    });
    BackRun r;
    r.ev = fold_events(v, f);
    int64_t deg = -1, rec = -1;
    uint32_t open_e = 0, rec_e = 0;
    for (const StcEvent& e : r.ev) {
        if (e.kind == StcEvent::Kind::degraded && deg < 0) deg = e.house_ns, open_e = e.epoch;
        if (e.kind == StcEvent::Kind::recovered && rec < 0) rec = e.house_ns, rec_e = e.epoch;
    }
    int64_t open = deg;
    for (const Rec& x : recs)
        if (deg >= 0 && x.pid == PID_A && x.h >= deg) {
            open = x.h;
            open_e = std::max(open_e, x.epoch);
            break;
        }
    for (const Rec& x : recs) {
        if (deg >= 0 && x.h > open && (rec < 0 || x.h < rec) && x.epoch < open_e) r.back[x.pid]++;
        if (rec >= 0 && x.h > rec && x.epoch < rec_e) r.back_after[x.pid]++;
    }
    r.opened = deg >= 0 ? rel(open) : -1;
    print_events(label, r.ev);
    std::printf("  %s: entry's epoch e%u from %.2f s; back on an older one while degraded audio %d video %d, "
                "after the recovery (e%u) audio %d video %d\n",
                label, open_e, r.opened / 1e9, r.back[PID_A], r.back[PID_V], rec_e, r.back_after[PID_A],
                r.back_after[PID_V]);
    g_all.add((int64_t)f.h);
    return r;
}

void test_vstc_one_timeline() {
    // (a) The degraded scenario's freeze (the PCR stuck 60-80 s), as it is and with 0-150 ms of arrival
    // jitter: the entry and the recovery estimate the same timeline anew, so no PES maps back.
    bool a_ok = true;
    for (const uint32_t j : {0u, 150u}) {
        BackRun a = back_run(j ? "freeze 60-80 s, 0-150 ms jitter" : "freeze 60-80 s", [j](int pid, int64_t t) {
            Shape s;
            if (pid == PCR_PID && t >= 60 * S && t < 80 * S) s.pcr_ns = 60 * S - t;
            if (j) s.net_ns = jitter_ms(t, pid, j);
            return s;
        }, 150, 41);
        int deg = 0, rec = 0;   // the jitter also steps the envelope once, at 58 s
        for (const StcEvent& e : a.ev) {
            deg += e.kind == StcEvent::Kind::degraded && !std::strcmp(e.reason, "freeze");
            rec += e.kind == StcEvent::Kind::recovered;
        }
        a_ok &= deg == 1 && rec == 1 && within(a.opened, 60200 * MS, 60700 * MS);
        for (const int pid : {PID_V, PID_A}) a_ok &= a.back[pid] == 0 && a.back_after[pid] == 0;
    }
    CHECK("vstc one timeline: a freeze entry and its recovery, jittery or not: no PES maps back on the frozen "
          "epoch, none after the recovery on the reference's",
          a_ok);

    // (b) Three leaps in 60 s (+1 s on the PCR and every PES at 20, 35, 50 s): the third degrades (leap),
    // a real jump, so the tie-break stays: the video of 49.8-50 s, muxed 300 ms late, keeps the frozen
    // PCR epoch at its lead (on the reference epoch the entry opened it would read 0).
    VirtualStc v;
    Fnv f;
    auto leaps = [](int pid, int64_t t) {
        Shape s;
        s.pcr_ns = s.pts_ns = ((int64_t)(t >= 20 * S) + (t >= 35 * S) + (t >= 50 * S)) * 1000 * MS;
        if (pid == PID_V && t >= 49800 * MS && t < 50 * S) s.mux_ns = 300 * MS;
        return s;
    };
    uint32_t before = 0;   // the video's epoch before the entry
    int late = 0, late_ok = 0;
    int64_t lo = INT64_MAX, hi = INT64_MIN;
    drive(v, program(70, 0, 51, leaps), f, [&](const Pkt& p, const VirtualStc::Mapping& m) {
        if (p.pid != PID_V) return;
        if (v.state() != VirtualStc::State::degraded) before = m.epoch;
        if (p.t < 49800 * MS || p.t >= 50 * S) return;
        late++;
        late_ok += m.valid && m.epoch == before;
        lo = std::min(lo, m.house_ns - p.h);
        hi = std::max(hi, m.house_ns - p.h);
    });
    const std::vector<StcEvent> ev = fold_events(v, f);
    print_events("three leaps in 60 s, the third's video late", ev);
    std::printf("  leap entry: %d late video PES, %d on the frozen PCR epoch e%u, leads %.1f..%.1f ms\n", late, late_ok,
                before, lo / 1e6, hi / 1e6);
    using K = StcEvent::Kind;
    CHECK("vstc one timeline: a leap entry keeps the tie-break: two leap relocks, degraded (leap) at the third, the "
          "reference's own leap relock; the late video of the old timeline stays on the frozen PCR epoch at its lead",
          kinds_are(ev, {K::leap, K::relock, K::leap, K::relock, K::leap, K::degraded, K::leap, K::relock}) &&
              !std::strcmp(ev[5].reason, "leap") && !std::strcmp(ev[7].reason, "leap") && late > 0 && late_ok == late &&
              lo > 450 * MS && hi < 510 * MS);
    g_all.add((int64_t)f.h);

    // (c) The cold reference lock: the PCR stuck from the start and the audio (the reference) PES missing
    // for the first second, video flowing: the entry finds no reference line, and the first audio PES
    // opens the entry's epoch, one timeline as on the warm path.
    BackRun c = back_run("freeze 0-1 s, audio from 1 s", [](int pid, int64_t t) {
        Shape s;
        if (pid == PCR_PID && t < 1 * S) s.pcr_ns = -t;
        if (pid == PID_A && t < 1 * S) s.drop = true;
        return s;
    }, 60, 42);
    CHECK("vstc one timeline: a cold reference lock: degraded (freeze) at 0.3 s, the entry's epoch opens at the "
          "first audio PES (1.0 s), no video maps back on the frozen PCR epoch after it, none after the recovery",
          kinds_are(c.ev, {K::degraded, K::leap, K::recovered}) && !std::strcmp(c.ev[0].reason, "freeze") &&
              within(rel(c.ev[0].house_ns), 200 * MS, 500 * MS) && within(c.opened, 1 * S, 1100 * MS) &&
              c.back[PID_V] == 0 && c.back[PID_A] == 0 && c.back_after[PID_V] == 0 && c.back_after[PID_A] == 0);
}

// B-100 on the program harness: TECH01's shape on the path (150 ms, the per-second 0..200 ms level and the
// cycle at 400 ms), the source at +50 ppm; the stats posted every 2 s, the reference lock read at each.
struct CourseRun {
    std::vector<StcEvent> ev;
    int64_t locked_at = -1, ppb_lock = 0;   // the first Locked stats post (rel)
    int warn_posts = 0;
    int ref_acq = 0, ref_locked = 0;        // the reference lock's phase at the posts degraded before 310 s
    int64_t ref_first_locked = -1;
    VirtualStc::State end = VirtualStc::State::acquiring;
    int count(StcEvent::Kind k, const char* why = nullptr) const {
        int n = 0;
        for (const StcEvent& e : ev) n += e.kind == k && (!why || !std::strcmp(e.reason, why));
        return n;
    }
    int64_t at(StcEvent::Kind k, const char* why = nullptr) const {   // the first such event (rel), -1: none
        for (const StcEvent& e : ev)
            if (e.kind == k && (!why || !std::strcmp(e.reason, why))) return rel(e.house_ns);
        return -1;
    }
};

auto tech01_path = [](int64_t phase) {
    return [phase](int, int64_t t) {
        Scatter sc;
        sc.phase = phase;
        Shape s;
        s.net_ns = sc.delay(t);
        return s;
    };
};

template <class F>
CourseRun course(const char* label, F shape, int64_t secs, uint64_t seed) {
    VirtualStc v;
    Fnv f;
    CourseRun r;
    int64_t last = INT64_MIN;
    drive(v, program(secs, 50000, seed, shape), f, [&](const Pkt& p, const VirtualStc::Mapping&) {
        if (last != INT64_MIN && p.h - last < 2 * S) return;
        last = p.h;
        const VirtualStc::Stats s = v.stats();
        if (r.locked_at < 0 && s.state == VirtualStc::State::locked) {
            r.locked_at = rel(p.h);
            r.ppb_lock = s.ppb;
        }
        r.warn_posts += s.state == VirtualStc::State::locked && s.rate_warning;
        if (s.state != VirtualStc::State::degraded || rel(p.h) >= 310 * S) return;
        if (v.ref_lock().phase() != ClockLock::Phase::locked) {
            r.ref_acq++;
        } else {
            r.ref_locked++;
            if (r.ref_first_locked < 0) r.ref_first_locked = rel(p.h);
        }
    });
    r.ev = fold_events(v, f);
    r.end = v.state();
    print_events(label, r.ev);
    std::printf("  %s: the first Locked post at %.2f s, %.3f ppm; %d rate-warning post(s); the reference lock "
                "while degraded before 310 s: acquiring at %d posts, locked at %d (from %.2f s); end %s\n",
                label, r.locked_at / 1e9, r.ppb_lock / 1000.0, r.warn_posts, r.ref_acq, r.ref_locked,
                r.ref_first_locked / 1e9, state_name(r.end));
    g_all.add((int64_t)f.h);
    return r;
}

void test_vstc_first_fit() {
    using K = StcEvent::Kind;
    // 6. A periodic bursty delivery from three phases of its cycle: the lock at 300 s of house time.
    bool all = true;
    for (const int64_t ph : {0, 20, 60}) {
        char lab[96];
        std::snprintf(lab, sizeof lab, "TECH01's path from phase %lld s", (long long)ph);
        const CourseRun r = course(lab, tech01_path(ph), 700, 7);
        all &= within(r.locked_at, 304 * S, 308 * S) && iabs(r.ppb_lock) < 100000 && r.count(K::degraded) == 0 &&
               r.count(K::relock) >= 1 && r.count(K::relock) == r.count(K::relock, "envelope-step") &&
               r.warn_posts == 0 && r.end == VirtualStc::State::locked;
    }
    CHECK("vstc first fit: a periodic bursty delivery locks at 304-308 s from any phase of its cycle, within the "
          "alarm bound, no degrade, envelope-step relocks only, no rate warning",
          all);
    const CourseRun nc = course("0..200 ms a second, no cycle", [](int, int64_t t) {
        Scatter sc;
        sc.p = 0;
        Shape s;
        s.net_ns = sc.delay(t);
        return s;
    }, 700, 7);
    CHECK("vstc first fit: ... the scatter without a cycle likewise, no rate-warning post",
          within(nc.locked_at, 304 * S, 308 * S) && nc.warn_posts == 0 && nc.end == VirtualStc::State::locked);
    // Controls: a level that holds its buckets locks as before B-100.
    const CourseRun cl = course("clean", plain, 700, 7);
    const CourseRun q = course("a +100 ms queue over 30 s from 10 s", [](int, int64_t t) {
        Shape s;
        s.net_ns = t < 10 * S ? 0 : t < 40 * S ? 100 * MS * (t - 10 * S) / (30 * S) : 100 * MS;
        return s;
    }, 700, 7);
    const CourseRun sp = course("a steady 2 s PCR", [](int pid, int64_t t) { return sparse2s(pid, t); }, 700, 81);
    CHECK("vstc first fit: ... a clean path, a queue building up and a steady 2 s PCR lock as before (36, 82, 66 s)",
          within(cl.locked_at, 35 * S, 37 * S) && within(q.locked_at, 81 * S, 83 * S) &&
              within(sp.locked_at, 65 * S, 67 * S) && cl.ev.empty() && q.ev.empty() && sp.ev.empty());
    // 7, 7b. The PCR stuck 100-103 s while acquiring: degraded (freeze); the relocked PCR lock's window restarts
    // at the freeze's leap, so the program recovers once it locks; meanwhile the reference lock waits its own.
    const CourseRun fz = course("TECH01's path, the PCR stuck 100-103 s", [](int pid, int64_t t) {
        Scatter sc;
        Shape s;
        s.net_ns = sc.delay(t);
        if (pid == PCR_PID && t >= 100 * S && t < 103 * S) s.pcr_ns = 100 * S - t;
        return s;
    }, 900, 7);
    const int64_t deg = fz.at(K::degraded, "freeze"), leap = fz.at(K::leap), rec = fz.at(K::recovered);
    CHECK("vstc first fit x freeze: a freeze while acquiring degrades at the third frozen pair, recovers once the "
          "relocked lock locks (its window from the leap at the freeze's end: 300-310 s after it), locked at the end",
          fz.count(K::degraded) == 1 && within(deg, 100300 * MS, 100700 * MS) && within(leap, 103 * S, 103500 * MS) &&
              fz.count(K::recovered) == 1 && within(rec - leap, 300 * S, 310 * S) &&
              within(fz.locked_at, rec, rec + 2500 * MS) && fz.end == VirtualStc::State::locked);
    const int64_t ref_step = [&] {
        for (const StcEvent& e : fz.ev)
            if (e.kind == K::relock && !std::strcmp(e.reason, "envelope-step") && rel(e.house_ns) > deg)
                return rel(e.house_ns);
        return (int64_t)-1;
    }();
    CHECK("vstc first fit: a degrade in the first 300 s runs on an acquiring reference lock until its own window: "
          "acquiring at every post to 304 s, locked from 304-308 s, its first envelope step after that",
          fz.ref_acq >= 95 && within(fz.ref_first_locked, 304 * S, 308 * S) && ref_step > fz.ref_first_locked &&
              ref_step < rec);
}

void test_determinism() {
    const uint64_t d1 = degraded_scenario(false), d2 = degraded_scenario(false);
    const uint64_t s1 = straddle_scenario(false), s2 = straddle_scenario(false);
    CHECK("determinism: degraded scenario twice, identical mappings, events, stats", d1 == d2);
    CHECK("determinism: straddle scenario twice, identical", s1 == s2);
    std::printf("  checksums: degraded %016llx straddle %016llx\n", (unsigned long long)d1, (unsigned long long)s1);
}

int sweep(int n) {
    std::printf("sweep: %d seeds per case, |eps applied - eps| in ppm; residual min once locked\n", n);
    for (int loss : {0, 25}) {
        for (int64_t eps : {0LL, 50000LL, -50000LL, 500000LL, -500000LL}) {
            std::vector<int64_t> e[4];
            int64_t worst = INT64_MAX, lock_max = 0;
            int steps = 0;
            for (int s = 1; s <= n; s++) {
                const Conv c = converge(eps, 1000 + s, loss, 610);
                for (int i = 0; i < 4; i++) e[i].push_back(iabs(c.err[i]));
                worst = std::min(worst, c.rmin_locked);
                lock_max = std::max(lock_max, c.t_locked);
                steps += c.steps;
            }
            std::printf("  eps %+5lld ppm loss %2d%%:", (long long)eps / 1000, loss);
            const char* at[4] = {"60s", "120s", "300s", "600s"};
            for (int i = 0; i < 4; i++) {
                std::sort(e[i].begin(), e[i].end());
                const size_t m = e[i].size();
                std::printf(" %s p50 %.2f p99 %.2f max %.2f |", at[i], e[i][m / 2] / 1000.0,
                            e[i][(99 * m + 99) / 100 - 1] / 1000.0, e[i][m - 1] / 1000.0);
            }
            std::printf(" rmin %.3f ms, lock <= %.1f s, steps %d\n", worst / 1e6, lock_max / 1e9, steps);
        }
    }
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc == 3 && !std::strcmp(argv[1], "--sweep")) return sweep(std::atoi(argv[2]));
    test_line_and_lock_basics();
    test_convergence();
    test_envelope_step();
    test_fit_levels();
    test_start_burst();
    test_backlog_floor();
    test_step_epoch();
    test_live_hold();
    test_first_fit();
    test_first_fit_keep();
    test_validator();
    test_vstc_clean_and_wrap();
    test_vstc_relocks();
    test_vstc_degraded();
    test_vstc_backlog();
    test_vstc_lead_clamp();
    test_vstc_window();
    test_vstc_stream_lead();
    test_vstc_recovery();
    test_vstc_sparse();
    test_vstc_straddle();
    test_vstc_map_pcr();
    test_vstc_floor_moves();
    test_vstc_step_epoch();
    test_vstc_live_hold();
    test_vstc_one_timeline();
    test_vstc_first_fit();
    test_determinism();
    std::printf("\n  CHECKSUM ts_stc %016llx (compare across machines)\n", (unsigned long long)g_all.h);
    return test_summary("ts_stc");
}
