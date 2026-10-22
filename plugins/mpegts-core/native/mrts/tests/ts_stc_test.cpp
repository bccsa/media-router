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

void test_validator() {
    using R = PcrValidator::Reason;
    const PcrValidatorConfig def;
    {
        const VRun r = vrun(def, 120, 100, no_off, no_di, never, rate_30, leads_ok);
        CHECK("validator: a clean 120 s stream fails no row, warns no cadence", clean(r) && !r.warned);
    }
    // Cadence.
    {
        const VRun r = vrun(def, 60, 600, no_off, no_di, never, rate_30, leads_ok);
        CHECK("cadence: PCR every 600 ms fails as cadence", r.reason == R::cadence);
        CHECK("cadence: ... at the third 500 ms gap (1.7 s)", r.fail_at >= 1600 * MS && r.fail_at <= 1800 * MS);
        PcrValidatorConfig off = def;
        off.pcr_interval_fail_ns = 100 * S;
        off.pcr_interval_warn_ns = 100 * S;
        CHECK("cadence: ... and nothing else fires on it", clean(vrun(off, 60, 600, no_off, no_di, never, rate_30, leads_ok)));
    }
    {
        const VRun r = vrun(def, 120, 200, no_off, no_di, never, rate_30, leads_ok);
        CHECK("cadence: PCR every 200 ms warns (p99 > 150 ms) but does not fail", r.warned && clean(r));
    }
    {
        auto gap = [](int64_t t) { return t >= 10 * S && t < 13 * S; };
        const VRun r = vrun(def, 60, 100, no_off, no_di, gap, rate_30, leads_ok);
        CHECK("cadence: a 3 s outage (nothing arrives) is not a PCR fault", clean(r) && !r.warned);
    }
    for (int64_t every : {500 * MS, 520 * MS}) {   // "> 500 ms": the boundary itself passes
        PcrValidator v(def);
        for (int64_t t = 0; t <= 20 * S; t += 20 * MS) {
            if (t % every == 0) v.feed_pcr(ns_to_pcr27(t), false, t);
            v.feed_activity(t);
        }
        CHECK(every == 500 * MS ? "cadence: PCR every 500 ms exactly passes" : "cadence: every 520 ms fails",
              v.failed() == (every != 500 * MS));
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
    // On the frozen PCR epoch (the straddle rule's pick) video still reads past 4 s: clamped.
    const ClampRun b = clamp_run("... the lead row on", window, 90, 44);
    bool between = b.ev.size() >= 2;
    for (size_t i = 1; between && i + 1 < b.ev.size(); i++)
        between = b.ev[i].kind == StcEvent::Kind::lead_clamp && b.ev[i].pid == PID_V;
    CHECK("vstc window: ... the lead row degrades the program (lead), video is clamped, it recovers; nothing stale",
          between && b.degraded_first() && b.ev.back().kind == StcEvent::Kind::recovered && b.stale(PID_V) == 0 &&
              b.stale(PID_A) == 0);
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
    // 7 s under the seed line: that keeps the arrival half out, not this, so it degrades 5 s on.
    auto backlog = [](int pid, int64_t t) {
        Shape s = queued_at(pid, t, 0, 90 * S, 5 * S);
        s.pts_ns = lead100(pid).pts_ns - (pid != PCR_PID ? 400 * MS : 0);
        return s;
    };
    const LeadCase e = lead_case("... from a 90 s backlog drained in 5 s", backlog, 120, 76);
    CHECK("vstc stream lead: ... a backlog's stale PES still show it: degraded (lead) 5 s after they arrive",
          !e.ev.empty() && e.ev[0].kind == StcEvent::Kind::degraded && !std::strcmp(e.ev[0].reason, "lead") &&
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
    test_validator();
    test_vstc_clean_and_wrap();
    test_vstc_relocks();
    test_vstc_degraded();
    test_vstc_backlog();
    test_vstc_lead_clamp();
    test_vstc_window();
    test_vstc_stream_lead();
    test_vstc_recovery();
    test_vstc_straddle();
    test_vstc_map_pcr();
    test_vstc_floor_moves();
    test_determinism();
    std::printf("\n  CHECKSUM ts_stc %016llx (compare across machines)\n", (unsigned long long)g_all.h);
    return test_summary("ts_stc");
}
