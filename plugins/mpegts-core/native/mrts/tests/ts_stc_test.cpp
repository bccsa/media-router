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
#include <vector>

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

// Envelope step: the floor delay moves by `step` at 300 s; the caller relocks.
struct StepRun {
    int fires = 0;
    int64_t fire_after = -1;       // since the first stepped arrival
    int64_t relock_locked = -1;    // phase locked again, since the fire
    int64_t ppb_at_fire = 0, ppb_after_relock = 0, ppb_end = 0;
    int64_t rmin_after = INT64_MAX;
    int64_t drift_100s = 0;        // offset drift over the 100 s after the step
};

StepRun step_run(int64_t step) {
    ClockLock lk;
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
        lk.feed(sigma, h);
        if (lk.envelope_step()) {
            s.fires++;
            fire_h = h;
            s.fire_after = h - step_h;
            s.ppb_at_fire = lk.ppb();
            lk.relock(true);
            lk.feed(sigma, h);
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
}

// --- PcrValidator, row by row ------------------------------------------------------

struct VRun {
    int leaps = 0, discs = 0, fails = 0;
    int64_t fail_at = -1;
    PcrValidator::Reason reason = PcrValidator::Reason::none;
    bool warned = false;
};

// PCR every `pcr_ms` (σ = t + pcr_off(t), DI per di(t)), other packets every 20 ms
// unless silent(t); rate and leads fed as given. Times are ns from 0.
template <class Off, class Di, class Silent, class Rate, class LeadF>
VRun vrun(const PcrValidatorConfig& cfg, int64_t secs, int64_t pcr_ms, Off pcr_off, Di di, Silent silent,
          Rate rate, LeadF lead) {
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
                v.feed_lead(0x100, ld - d);
                v.feed_lead(0x101, ld - 300 * MS - d);
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
        CHECK("lead: a median lead below -200 ms for 5 s fails as lead", rl.reason == R::lead);
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
        CHECK("recovery clock: a bad observation restarts it", v.clean_ns(5 * S) == 3 * S);
        v.feed_rate(0, 3 * S);
        CHECK("recovery clock: ... and good ones do not", v.clean_ns(40 * S) == 38 * S);
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
            raw.push_back(Raw{m, delay, Pkt{0, pid, v, sh.di, t}});
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
    {   // External relock (the PMT's PCR PID changed).
        VirtualStc v;
        Fnv f;
        bool done = false;
        for (const Pkt& p : program(40, 0, 34, plain)) {
            if (!done && p.t >= 30 * S) {
                v.relock();
                done = true;
            }
            if (p.pid == PCR_PID) v.feed_pcr(p.v, p.di, p.h);
            else v.map(p.pid, p.v, p.h);
        }
        const std::vector<StcEvent> ev = fold_events(v, f);
        CHECK("vstc external relock: one relock, reason external, epoch 2",
              kinds_are(ev, {StcEvent::Kind::relock}) && !std::strcmp(ev[0].reason, "external") && v.stats().epoch == 2);
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
    test_validator();
    test_vstc_clean_and_wrap();
    test_vstc_relocks();
    test_vstc_degraded();
    test_vstc_straddle();
    test_determinism();
    std::printf("\n  CHECKSUM ts_stc %016llx (compare across machines)\n", (unsigned long long)g_all.h);
    return test_summary("ts_stc");
}
