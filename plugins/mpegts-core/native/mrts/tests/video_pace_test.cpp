// video_pace: mrts::VideoPace and mrts::DisplayRate (WI-P4-3, ch. 15.4 B-162, B-175), the cases of
// ../../py/video_pace_test.py one for one, same names, same order (its last, the replay format, is
// the reference's own). The element's streaming thread and the sinks are modelled as there: a
// display slower than the content shows only through its back-pressure on the releases.
#include <algorithm>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <set>
#include <string>
#include <vector>

#include "../video_pace.h"
#include "check.h"

using namespace mrts;

namespace {

constexpr int64_t SEC = 1000000000, MS = 1000000, US = 1000;
constexpr int64_t P50 = 20 * MS;                         // 50p
constexpr int64_t P60 = 16666667;                        // 60p
constexpr int64_t LATENCY = 100 * MS;                    // the input's lateness at the element
constexpr int64_t SLOW = 20000800;                       // a 50 Hz display 40 ppm slow
constexpr int64_t DSI = 16656184;                        // the Pi 5 box's DSI panel, 60.038 Hz
constexpr int64_t WRAP_NS = (1LL << 33) * 100000 / 9;    // the 33-bit point in house ns
constexpr DisplaySource MEASURED = DisplaySource::measured;
constexpr DisplaySource NOMINAL = DisplaySource::nominal;

std::string fmt(const char* f, ...) __attribute__((format(printf, 1, 2)));
std::string fmt(const char* f, ...) {
    char buf[512];
    va_list ap;
    va_start(ap, f);
    std::vsnprintf(buf, sizeof buf, f, ap);
    va_end(ap);
    return buf;
}

int64_t floordiv(int64_t a, int64_t b) {
    const int64_t q = a / b;
    return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q;
}

struct Frame {
    int64_t pts, dur, ready;
    bool discont, gap;
};

struct Rec {
    int64_t pts, arrival, release;
    bool drop;
    int64_t shown;   // the presentation (the push's return without a display); unset when dropped
};

// waylandsink present-every-frame=true (Yocto 0008) on a compositor refreshing every `period`
// ns from `phase`: a frame pushed while the previous commit's frame callback is pending waits
// for it, is committed, and the push returns; a commit is presented at the first refresh after it.
struct Wayland {
    int64_t period, phase;
    bool pending = false;
    int64_t callback = 0;
    Wayland(int64_t p, int64_t ph = 0) : period(p), phase(ph) {}
    virtual ~Wayland() {}
    virtual int64_t refresh_after(int64_t t) const {
        return phase + (floordiv(t - phase, period) + 1) * period;
    }
    // A sink without presentation feedback, timed by its returns (kmssink).
    virtual bool blocking() const { return false; }
    // (the push's return, the presentation)
    virtual std::pair<int64_t, int64_t> push(int64_t t) {
        const int64_t commit = !pending || t >= callback ? t : callback;
        callback = refresh_after(commit);
        pending = true;
        return {commit, callback};
    }
};

// kmssink sync=false: show_frame flips at the first vblank after the push and returns then.
struct Kms : Wayland {
    Kms(int64_t p, int64_t ph = 0) : Wayland(p, ph) {}
    bool blocking() const override { return true; }
    std::pair<int64_t, int64_t> push(int64_t t) override {
        const int64_t shown = refresh_after(t);
        return {shown, shown};
    }
};

// Wayland on a compositor that presents at most cap_mhz frames a second (mHz): refresh n can show a
// new frame only when floor(n x period x cap / 10^12) steps there (Weston on the Pi 5 box's DSI).
struct Capped : Wayland {
    int64_t cap;
    Capped(int64_t p, int64_t ph, int64_t cap_mhz) : Wayland(p, ph), cap(cap_mhz) {}
    static __int128 floor12(__int128 v) {   // floor(v / 10^12), as Python's //
        const __int128 q = v / 1000000000000LL;
        return v % 1000000000000LL < 0 ? q - 1 : q;
    }
    bool usable(int64_t n) const {
        const __int128 k = (__int128)period * cap;
        return floor12((n + 1) * k) > floor12(n * k);
    }
    int64_t refresh_after(int64_t t) const override {
        int64_t n = floordiv(t - phase, period) + 1;
        while (!usable(n)) n++;
        return phase + n * period;
    }
};

// kmssink as DEV-P4a and DEV-P4b measured it: the flip at the first vblank after the push, the
// return at the vblank after that, so at most one frame per two refreshes.
struct KmsWait : Kms {
    KmsWait(int64_t p, int64_t ph = 0) : Kms(p, ph) {}
    std::pair<int64_t, int64_t> push(int64_t t) override {
        const int64_t shown = refresh_after(t);
        return {shown + period, shown};
    }
};

// mrvideopace's streaming thread over `frames`: a frame enters when it is ready and the previous
// push has returned, held when it waited for that push; a kept frame is pushed at its release, a
// dropped one frees the thread at once.
std::vector<Rec> drive(VideoPace& pace, const std::vector<Frame>& frames, Wayland* display = nullptr) {
    std::vector<Rec> out;
    out.reserve(frames.size());
    bool have_free = false;
    int64_t free_at = 0;
    for (const Frame& f : frames) {
        if (f.gap) pace.on_gap();
        const bool held = have_free && f.ready < free_at;
        const int64_t arrival = held ? free_at : f.ready;
        const PaceDecision d = pace.on_frame(f.pts, f.dur, arrival, f.discont, held);
        int64_t shown = 0;
        if (d.rate_drop) {
            free_at = arrival;
        } else if (!display) {
            free_at = shown = d.release_ns;
        } else {
            const std::pair<int64_t, int64_t> r = display->push(d.release_ns);
            free_at = r.first;
            shown = r.second;
        }
        have_free = true;
        out.push_back(Rec{f.pts, arrival, d.release_ns, d.rate_drop, shown});
    }
    return out;
}

// S12's refresh as the element reads it once a second: 0008's from its feedback (the model's
// refresh, once a frame has gone), else the last 4,096 returns counted in the prior or, without
// one, in their 25th-percentile interval (B-162 F2); 0 before that.
int64_t s12_refresh(const Wayland& display, const std::vector<int64_t>& returns, int64_t prior) {
    if (returns.empty()) return 0;
    if (!display.blocking()) return display.period;
    const size_t from = returns.size() > 4096 ? returns.size() - 4096 : 0;
    std::vector<int64_t> ivs;
    for (size_t i = from + 1; i < returns.size(); i++)
        if (returns[i] > returns[i - 1]) ivs.push_back(returns[i] - returns[i - 1]);
    if (ivs.empty()) return 0;
    std::sort(ivs.begin(), ivs.end());
    const int64_t base = prior > 0 ? prior : ivs[ivs.size() / 4];
    return display_period_from_returns(returns.data() + from, returns.size() - from, base).period_ns;
}

// drive with mrvideopace's display rate: at the first frame and then once a second of arrivals the
// rate takes the prior and S12's refresh and the pace the rate's period; every kept push's return
// goes to the rate, pressed when the frame left at once on the last push's return.
std::vector<Rec> drive_rate(VideoPace& pace, DisplayRate& rate, const std::vector<Frame>& frames,
                            Wayland* display, int64_t prior = 0) {
    std::vector<Rec> out;
    out.reserve(frames.size());
    std::vector<int64_t> returns;
    bool have_free = false, have_update = false;
    int64_t free_at = 0, update = 0;
    for (const Frame& f : frames) {
        if (f.gap) pace.on_gap();
        const bool held = have_free && f.ready < free_at;
        const int64_t arrival = held ? free_at : f.ready;
        if (!have_update || arrival >= update) {
            rate.set_prior(prior);
            rate.set_refresh(s12_refresh(*display, returns, prior));
            DisplaySource source = DisplaySource::none;
            const int64_t period = rate.period(&source);
            pace.set_display(period, source);
            update = arrival + SEC;
            have_update = true;
        }
        const PaceDecision d = pace.on_frame(f.pts, f.dur, arrival, f.discont, held);
        int64_t shown = 0;
        if (d.rate_drop) {
            free_at = arrival;
        } else {
            const std::pair<int64_t, int64_t> r = display->push(d.release_ns);
            free_at = r.first;
            shown = r.second;
            returns.push_back(free_at);
            rate.on_push(free_at, held && d.release_ns == arrival);
        }
        have_free = true;
        out.push_back(Rec{f.pts, arrival, d.release_ns, d.rate_drop, shown});
    }
    return out;
}

// n PTS at num/den fps from `start`, floored to ns as the demux floors 90 kHz ticks.
std::vector<int64_t> cadence(int64_t n, int64_t num, int64_t den, int64_t start = 0) {
    std::vector<int64_t> v((size_t)n);
    for (int64_t k = 0; k < n; k++) v[(size_t)k] = start + k * den * SEC / num;
    return v;
}

// Frames ready `latency` after their PTS, no flags.
std::vector<Frame> live(const std::vector<int64_t>& pts, int64_t dur, int64_t latency = LATENCY) {
    std::vector<Frame> v;
    v.reserve(pts.size());
    for (int64_t p : pts) v.push_back(Frame{p, dur, p + latency, false, false});
    return v;
}

std::vector<Rec> kept(const std::vector<Rec>& rec) {
    std::vector<Rec> v;
    for (const Rec& r : rec)
        if (!r.drop) v.push_back(r);
    return v;
}

std::vector<int64_t> drop_indices(const std::vector<Rec>& rec) {
    std::vector<int64_t> v;
    for (size_t i = 0; i < rec.size(); i++)
        if (rec[i].drop) v.push_back((int64_t)i);
    return v;
}

std::vector<int64_t> spacings(const std::vector<int64_t>& idx) {
    std::vector<int64_t> v;
    for (size_t i = 1; i < idx.size(); i++) v.push_back(idx[i] - idx[i - 1]);
    return v;
}

std::vector<int64_t> release_lateness(const std::vector<Rec>& rec) {
    std::vector<int64_t> v;
    for (const Rec& r : rec)
        if (!r.drop) v.push_back(r.release - r.pts);
    return v;
}

std::vector<int64_t> shown_lateness(const std::vector<Rec>& rec) {
    std::vector<int64_t> v;
    for (const Rec& r : rec)
        if (!r.drop) v.push_back(r.shown - r.pts);
    return v;
}

int64_t spread(const std::vector<int64_t>& v) {
    return *std::max_element(v.begin(), v.end()) - *std::min_element(v.begin(), v.end());
}

// set(values) == {want}
bool all_equal(const std::vector<int64_t>& v, int64_t want) {
    if (v.empty()) return false;
    for (int64_t x : v)
        if (x != want) return false;
    return true;
}

std::vector<int64_t> tail(const std::vector<int64_t>& v, size_t from) {
    return std::vector<int64_t>(v.begin() + (ptrdiff_t)std::min(from, v.size()), v.end());
}

std::vector<Rec> slice(const std::vector<Rec>& v, size_t from, size_t to) {
    to = std::min(to, v.size());
    return std::vector<Rec>(v.begin() + (ptrdiff_t)from, v.begin() + (ptrdiff_t)to);
}

// The display's deficit over `rec` in frames: the display time all of them would take less the
// content time they span, over one refresh.
double expected_drops(const std::vector<Rec>& rec, int64_t period) {
    const int64_t n = (int64_t)rec.size();
    return (double)((n - 1) * period - (rec.back().pts - rec.front().pts)) / (double)period;
}

struct Lcg {
    uint64_t seed;
    explicit Lcg(uint64_t s) : seed(s) {}
    int64_t next() {
        seed = seed * 6364136223846793005ULL + 1442695040888963407ULL;
        return (int64_t)(seed >> 33);
    }
};

// --- 1 to 6: the rate match --------------------------------------------------------------------

void test_50p_on_60hz() {
    VideoPace pace;
    pace.set_display(16666667, MEASURED);
    Wayland w(16666667, 3700 * US);
    const std::vector<Rec> rec = drive(pace, live(cadence(500, 50, 1), P50), &w);
    const std::vector<Rec> k = kept(rec);
    CHECK("1 50p on a measured 60 Hz: 0 drops", k.size() == 500 && pace.take().rate_drops == 0);
    bool cadenced = true;
    for (size_t i = 1; i < k.size(); i++)
        cadenced = cadenced && std::llabs((k[i].release - k[i - 1].release) - (k[i].pts - k[i - 1].pts)) <= US;
    CHECK("1 50p on a measured 60 Hz: releases on the content cadence to 1 us", cadenced);
    CHECK("1 50p on a measured 60 Hz: every frame released at its input lateness",
          all_equal(release_lateness(rec), LATENCY));
}

void test_60p_on_50hz() {
    {
        VideoPace pace;
        pace.set_display(P50, MEASURED);
        Wayland w(P50, 3700 * US);
        const std::vector<Rec> rec = drive(pace, live(cadence(3600, 60, 1), 16666667), &w);
        const std::vector<int64_t> idx = drop_indices(rec);
        CHECK("2 60p on a measured 50 Hz: exactly 1 in 6 dropped",
              idx.size() == 600 && all_equal(spacings(idx), 6) && pace.take().rate_drops == 600);
        CHECK("2 60p on a measured 50 Hz: release lateness flat, the display within a frame and a refresh",
              spread(release_lateness(rec)) == 0 && spread(shown_lateness(rec)) <= 16666667 + P50);
    }
    // kmssink blocks to the vblank, so it feeds its pace back into the releases.
    VideoPace pace;
    pace.set_display(P50, MEASURED);
    Kms kms(P50, 3700 * US);
    const std::vector<Rec> rec = drive(pace, live(cadence(3600, 60, 1), 16666667), &kms);
    const std::vector<int64_t> late = release_lateness(rec);
    CHECK("2 60p on a measured 50 Hz through kmssink: 1 in 6, lateness up once by under a frame",
          drop_indices(rec).size() == 600 && spread(late) < 16666667 && spread(tail(late, late.size() / 2)) == 0);
}

void test_60_on_5994() {
    VideoPace pace;
    pace.set_display(16683333, MEASURED);   // 60000/1001 Hz
    Wayland w(16683333, 1100 * US);
    const std::vector<Rec> rec = drive(pace, live(cadence(36000, 60, 1), 16666667), &w);
    const std::vector<int64_t> idx = drop_indices(rec);
    bool every = true;
    for (int64_t s : spacings(idx)) every = every && std::llabs(s - 1001) <= 1;
    CHECK("3 60.000 fps on a measured 59.940 Hz: 1 drop per 1,001 +- 1",
          idx.size() >= 35 && every && std::fabs((double)idx.size() - 36000.0 / 1001.0) <= 1);
    CHECK("3 60.000 fps on a measured 59.940 Hz: release lateness flat within a frame",
          spread(release_lateness(rec)) <= 16666667);
}

void test_50p_on_slow_display_measured() {
    VideoPace pace;
    pace.set_display(SLOW, MEASURED);
    Wayland w(SLOW, 1300 * US);
    const std::vector<Rec> rec = drive(pace, live(cadence(180000, 50, 1), P50), &w);
    const std::vector<int64_t> idx = drop_indices(rec);
    bool every = true;
    for (int64_t s : spacings(idx)) every = every && std::llabs(s - 25000) <= 1;
    CHECK("4 50.000p on a measured 49.998 Hz (-40 ppm): 1 drop per 25,000 +- 1",
          idx.size() == 7 && every && std::fabs((double)idx.size() - expected_drops(rec, SLOW)) <= 1);
    CHECK("4 50.000p on a measured 49.998 Hz: release lateness flat within one frame over 1 h",
          spread(release_lateness(rec)) <= P50 && spread(shown_lateness(rec)) <= 2 * P50);
}

void test_50p_on_matched_display() {
    VideoPace pace;
    pace.set_display(P50, MEASURED);
    Wayland w(P50, 1300 * US);
    const std::vector<Rec> rec = drive(pace, live(cadence(180000, 50, 1), P50), &w);
    CHECK("5 50.000p on a measured 50.000 Hz: 0 drops in 1 h",
          drop_indices(rec).empty() && pace.take().rate_drops == 0);
    CHECK("5 50.000p on a measured 50.000 Hz: release lateness flat", spread(release_lateness(rec)) == 0);
}

void test_slow_display_nominal() {
    const std::pair<int64_t, const char*> runs[] = {{P50, "the mode's 50.000 Hz"},
                                                    {SLOW, "its true period inside the band"}};
    for (const auto& run : runs) {
        VideoPace pace;
        pace.set_display(run.first, NOMINAL);
        Wayland w(SLOW, 1300 * US);
        const std::vector<Rec> rec = drive(pace, live(cadence(180000, 50, 1), P50), &w);
        const std::vector<int64_t> shown = shown_lateness(rec), late = release_lateness(rec);
        const int64_t growth = shown.back() - shown.front(), follows = late.back() - late.front();
        CHECK(fmt("6 the -40 ppm display given as nominal (%s): no drops", run.second).c_str(),
              drop_indices(rec).empty());
        // The releases follow once the display is a frame behind: a frame and a refresh later.
        CHECK(fmt("6 the -40 ppm display given as nominal (%s): lateness +144 ms/h (%.1f ms at the "
                  "display, %.1f ms at release)",
                  run.second, (double)growth / MS, (double)follows / MS).c_str(),
              std::llabs(growth - 144 * MS) <= MS && 0 <= growth - follows && growth - follows <= P50 + SLOW);
    }
}

// --- 7 to 10: the cadence -----------------------------------------------------------------------

void test_stall_then_gap() {
    VideoPace pace;
    pace.set_display(P50, MEASURED);
    std::vector<int64_t> pts = cadence(1250, 50, 1);
    for (size_t i = 1000; i < pts.size(); i++) pts[i] += 3 * SEC;   // a 3 s content gap at 20 s
    std::vector<Frame> frames = live(pts, P50);
    const int64_t stall_end = pts[500] + LATENCY + 2 * SEC;          // an arrival stall at 10 s
    for (size_t i = 500; i < 600; i++) frames[i].ready = std::max(frames[i].ready, stall_end);
    const std::vector<Rec> rec = drive(pace, frames);
    const PaceSummary s = pace.take();
    bool cadenced = true;
    for (size_t i = 501; i < 600; i++)
        cadenced = cadenced && rec[i].release - rec[i - 1].release == rec[i].pts - rec[i - 1].pts;
    CHECK("7 a 2 s arrival stall: the backlog leaves on the content cadence, not faster", cadenced);
    CHECK("7 a 2 s arrival stall: lateness +2 s, 0 drops",
          all_equal(release_lateness(slice(rec, 500, 1000)), LATENCY + 2 * SEC) && s.rate_drops == 0);
    CHECK("7 then a 3 s content gap: lateness after it = the input's",
          all_equal(release_lateness(slice(rec, 1000, rec.size())), LATENCY));
    CHECK("7 one collapse; late counts the stall's first frame only, not the gap's",
          s.gaps_collapsed == 1 && s.late == 1);
}

struct CollapseRun {
    int64_t before, after;
    PaceSummary s;
};

// 50p with a backlog (a 2 s stall at frame 100), then from frame 300 the PTS step on by `step_ns`
// more than one frame, flagged as asked.
CollapseRun collapse_run(int64_t step_ns, bool discont, bool gap) {
    VideoPace pace;
    std::vector<int64_t> pts;
    for (int64_t k = 0; k < 400; k++) pts.push_back(k * P50 + (k >= 300 ? step_ns : 0));
    std::vector<Frame> frames = live(pts, P50);
    const int64_t stall_end = pts[100] + LATENCY + 2 * SEC;
    for (size_t i = 100; i < 200; i++) frames[i].ready = std::max(frames[i].ready, stall_end);
    frames[300].discont = discont;
    frames[300].gap = gap;
    const std::vector<int64_t> late = release_lateness(drive(pace, frames));
    return CollapseRun{late[299], late[300], pace.take()};
}

void test_discont_and_gap_collapse() {
    CollapseRun r = collapse_run(40 * MS, true, false);
    CHECK("8 DISCONT collapses like a gap: a 60 ms step inside the threshold takes one frame",
          r.after == r.before - 40 * MS && r.s.gaps_collapsed == 1);
    r = collapse_run(40 * MS, false, true);
    CHECK("8 on_gap() the same", r.after == r.before - 40 * MS && r.s.gaps_collapsed == 1);
    r = collapse_run(3 * SEC, true, true);
    CHECK("8 a GAP and a DISCONT on one 3 s step: one collapse", r.after == LATENCY && r.s.gaps_collapsed == 1);
    r = collapse_run(40 * MS, false, false);
    CHECK("8 unflagged, the same 60 ms step is a clean delta and stays",
          r.after == r.before && r.s.gaps_collapsed == 0);
    // A decoder holding a decreasing PTS (B-160 F7): one PTS for 50 frames after a step back.
    VideoPace pace;
    std::vector<int64_t> pts;
    for (int64_t k = 0; k < 100; k++) pts.push_back(k * P50);
    for (int k = 0; k < 50; k++) pts.push_back(99 * P50);
    for (int64_t k = 1; k <= 50; k++) pts.push_back(99 * P50 + k * P50);
    std::vector<Frame> frames;
    for (size_t i = 0; i < pts.size(); i++)
        frames.push_back(Frame{pts[i], P50, (int64_t)i * P50 + LATENCY, i == 100, i == 100});
    const std::vector<Rec> rec = drive(pace, frames);
    const PaceSummary s = pace.take();
    bool nominal = true;
    for (size_t i = 1; i < rec.size(); i++) nominal = nominal && rec[i].release - rec[i - 1].release == P50;
    CHECK("8 a held PTS (F7) leaves on the nominal cadence, one collapse for its step",
          nominal && s.gaps_collapsed == 1 && s.late == 0);
}

void test_idr_spikes() {
    VideoPace pace;
    std::vector<Frame> frames;
    const std::vector<int64_t> pts = cadence(500, 50, 1);
    for (size_t i = 0; i < pts.size(); i++)
        frames.push_back(Frame{pts[i], P50, pts[i] + LATENCY + (i % 50 == 0 && i ? 80 * MS : 0), false, false});
    const std::vector<int64_t> late = release_lateness(drive(pace, frames));
    CHECK("9 IDR decode spikes (+80 ms every 50th frame): lateness rises once and stays",
          all_equal(std::vector<int64_t>(late.begin(), late.begin() + 50), LATENCY) &&
              all_equal(tail(late, 50), LATENCY + 80 * MS));
    CHECK("9 IDR decode spikes: late counts the first spike only", pace.take().late == 1);
}

void test_wrap_point() {
    bool ok = true;
    const std::pair<int64_t, int64_t> runs[] = {{50, 1}, {60, 2}};
    for (const auto& run : runs) {
        VideoPace pace;
        const std::vector<int64_t> pts = cadence(600, run.first, 1, run.second * WRAP_NS - 5 * SEC);
        const std::vector<Rec> rec = drive(pace, live(pts, SEC / run.first));
        const PaceSummary s = pace.take();
        for (size_t i = 1; i < rec.size(); i++)
            ok = ok && rec[i].release - rec[i - 1].release == rec[i].pts - rec[i - 1].pts;
        ok = ok && s.gaps_collapsed == 0 && s.late == 0 && pts.front() < run.second * WRAP_NS &&
             run.second * WRAP_NS < pts.back();
    }
    CHECK("10 ns PTS across the 2^33-tick point (and the second): no step", ok);
}

// --- 11: the display period -------------------------------------------------------------------

// (presented ns, MSC) of content every `frame_ns` shown at the first refresh after its release on
// a display of `period`: one or two refreshes per frame when the content is slower.
std::vector<PresentedSample> presented(int64_t period, int64_t phase, int64_t frame_ns, int64_t seconds,
                                       int64_t seq0 = 0) {
    std::vector<PresentedSample> samples;
    bool have_last = false;
    int64_t last = 0;
    for (int64_t j = 0; j < seconds * SEC / frame_ns; j++) {
        const int64_t n = floordiv(j * frame_ns - phase, period) + 1;
        if (!have_last || n != last) {
            samples.push_back(PresentedSample{phase + n * period, seq0 + n});
            last = n;
            have_last = true;
        }
    }
    return samples;
}

DisplayPeriod feedback(const std::vector<PresentedSample>& v) {
    return display_period_from_feedback(v.data(), v.size());
}

DisplayPeriod returns(const std::vector<int64_t>& v, int64_t prior = 0) {
    return display_period_from_returns(v.data(), v.size(), prior);
}

bool is(const DisplayPeriod& p, int64_t period, bool short_span) {
    return p.period_ns == period && p.short_span == short_span;
}

void test_display_period() {
    const int64_t t60 = 16666667;
    const std::vector<PresentedSample> fb = presented(t60, 2 * MS, P50, 90);
    const int64_t mean_delta = (fb.back().presented_ns - fb.front().presented_ns) / (int64_t)(fb.size() - 1);
    CHECK(fmt("11 feedback at 50p on 60 Hz: the refresh, not the content period (%lld, mean delta %lld)",
              (long long)feedback(fb).period_ns, (long long)mean_delta).c_str(),
          is(feedback(fb), t60, false) && std::llabs(mean_delta - P50) * 1000 < P50);
    CHECK("11 feedback from 30 s: the refresh, flagged short", is(feedback(presented(t60, 2 * MS, P50, 30)), t60, true));
    // An output off for 30 s inside 120 s: its MSC either counted on or stood still.
    const std::vector<PresentedSample> full = presented(t60, 2 * MS, P50, 120);
    std::vector<PresentedSample> on;
    for (const PresentedSample& x : full)
        if (!(40 * SEC <= x.presented_ns && x.presented_ns < 70 * SEC)) on.push_back(x);
    size_t cut = 0;
    while (on[cut].presented_ns < 70 * SEC) cut++;
    std::vector<PresentedSample> still(on.begin(), on.begin() + (ptrdiff_t)cut);
    for (size_t i = cut; i < on.size(); i++)
        still.push_back(PresentedSample{on[i].presented_ns, on[i].seq - (on[cut].seq - on[cut - 1].seq) + 1});
    std::vector<PresentedSample> reset(full.begin(), full.begin() + 3000);
    for (size_t i = 3000; i < full.size(); i++)
        reset.push_back(PresentedSample{full[i].presented_ns, full[i].seq - full[3000].seq});
    CHECK("11 feedback across an output off 30 s (MSC on or still) and an MSC reset: the refresh",
          feedback(on).period_ns == t60 && feedback(still).period_ns == t60 && feedback(reset).period_ns == t60);
    Kms kms(t60, 2 * MS);
    std::vector<int64_t> rets;
    for (int64_t j = 0; j < 90 * 50; j++) rets.push_back(kms.push(j * P50).first);
    CHECK("11 returns at 50p on 60 Hz: the refresh, not the content period", is(returns(rets), t60, false));
    Lcg rnd(11);
    std::vector<int64_t> jittered;
    for (size_t i = 0; i < 3000; i++) jittered.push_back(rets[i] + rnd.next() % (400 * US) - 200 * US);
    const int64_t period = returns(jittered).period_ns;
    CHECK(fmt("11 returns jittered +-200 us over 60 s: within 10 ppm (%lld)", (long long)period).c_str(),
          std::llabs(period - t60) * 100000 <= t60);
    Kms slow(SLOW, 0);
    std::vector<int64_t> slow25;
    for (int64_t j = 0; j < 90 * 25; j++) slow25.push_back(slow.push(10 * MS + j * 40 * MS).first);
    CHECK("11 returns at 25p on 50 Hz: the refresh with the mode's prior, twice it without",
          returns(slow25, P50).period_ns == SLOW && returns(slow25).period_ns == 2 * SLOW);
}

// --- 12 to 15: what the rate match keeps (beyond the brief's list) ------------------------------

void test_60p_on_slow_50hz() {
    VideoPace pace;
    pace.set_display(SLOW, MEASURED);
    Wayland w(SLOW, 4100 * US);
    const std::vector<Rec> rec = drive(pace, live(cadence(216000, 60, 1), 16666667), &w);
    const double want = expected_drops(rec, SLOW);
    const int64_t got = (int64_t)drop_indices(rec).size();
    CHECK(fmt("12 60p on a measured 50 Hz at -40 ppm: 1 in 6 and the 40 ppm, %lld drops (want %.1f)",
              (long long)got, want).c_str(),
          std::fabs((double)got - want) <= 1);
    CHECK("12 60p on a measured 50 Hz at -40 ppm: release lateness flat within a frame over 1 h",
          spread(release_lateness(rec)) <= 16666667 && spread(shown_lateness(rec)) <= 16666667 + SLOW);
}

void test_foreign_clock_source() {
    // A source 30 ppm fast, on house time with its rate, as 90 kHz ticks on the bus.
    std::vector<int64_t> pts;
    for (int64_t k = 0; k < 180006; k++) pts.push_back((k * 1800 * 999970 / 1000000) * 100000 / 9);
    VideoPace pace;
    pace.set_display(SLOW, MEASURED);
    Wayland w(SLOW, 1300 * US);
    const std::vector<Rec> rec = drive(pace, live(pts, P50), &w);
    const double want = expected_drops(rec, SLOW);
    const int64_t got = (int64_t)drop_indices(rec).size();
    CHECK(fmt("13 50p from a source 30 ppm fast on a -40 ppm display: the 70 ppm, %lld drops (want %.1f)",
              (long long)got, want).c_str(),
          std::fabs((double)got - want) <= 1 && pace.take().content_period == P50);
    CHECK("13 50p from a source 30 ppm fast: release lateness flat within a frame over 1 h",
          spread(release_lateness(rec)) <= P50);
}

void test_faster_display_banks_one_frame() {
    const int64_t t60 = 16667333;   // a 60 Hz display 40 ppm slow
    VideoPace pace;
    pace.set_display(t60, MEASURED);
    const std::vector<int64_t> p50 = cadence(30000, 50, 1);
    const std::vector<int64_t> p60 = cadence(216000, 60, 1, p50.back() + P50);
    std::vector<Frame> frames = live(p50, P50);
    for (size_t i = 0; i < p60.size(); i++) frames.push_back(Frame{p60[i], 16666667, p60[i] + LATENCY, i == 0, false});
    Wayland w(t60, 900 * US);
    const std::vector<Rec> rec = drive(pace, frames, &w);
    const std::vector<Rec> after = slice(rec, 30000, rec.size());
    const double want = expected_drops(after, t60);
    const int64_t got = (int64_t)drop_indices(after).size();
    CHECK("14 10 min of 50p on a 60 Hz display bank a frame at most: no drops then",
          drop_indices(slice(rec, 0, 30000)).empty());
    CHECK(fmt("14 then 60p: the 40 ppm from the switch, %lld drops in 1 h (want %.1f)", (long long)got, want).c_str(),
          std::fabs((double)got - want) <= 1 && spread(release_lateness(after)) <= 16666667);
}

void test_stamp_jitter() {
    // Capture stamps off by up to 8 ms either way: the frames arrive on time, their PTS do not.
    Lcg rnd(15);
    const std::vector<int64_t> real = cadence(180000, 50, 1);
    std::vector<Frame> frames;
    for (int64_t t : real) frames.push_back(Frame{t + rnd.next() % (16 * MS + 1) - 8 * MS, P50, t + LATENCY, false, false});
    const std::pair<int64_t, const char*> runs[] = {{P50, "a measured 50.000 Hz"}, {SLOW, "a measured -40 ppm"}};
    for (const auto& run : runs) {
        VideoPace pace;
        pace.set_display(run.first, MEASURED);
        Wayland w(run.first, 1300 * US);
        const std::vector<Rec> rec = drive(pace, frames, &w);
        const double want = std::max(expected_drops(rec, run.first), 0.0);
        const int64_t got = (int64_t)drop_indices(rec).size();
        const std::vector<int64_t> late = release_lateness(rec);
        CHECK(fmt("15 PTS jittered +-8 ms on %s display: the deficit only, %lld drops in 1 h (want %.1f)",
                  run.second, (long long)got, want).c_str(),
              std::fabs((double)got - want) <= 1);
        CHECK(fmt("15 PTS jittered +-8 ms on %s display: release lateness flat after the first minute", run.second)
                  .c_str(),
              spread(tail(late, 3000)) <= P50);
    }
}

// --- 16 to 20: the rate the sink achieves (p4-3c, B-175) ---------------------------------------

void test_slow_presenting_display() {
    // Weston on the Pi 5 box's 60.038 Hz DSI presents HEVC 1080p60 at about 56.6 fps (DEV-P4b).
    VideoPace pace;
    DisplayRate rate;
    const int64_t achieved = 1000000000000LL / 56600;
    Capped display(DSI, 3700 * US, 56600);
    const std::vector<Rec> rec = drive_rate(pace, rate, live(cadence(36000, 60, 1), P60), &display, DSI);
    const PaceSummary s = pace.take();
    const double want = expected_drops(rec, achieved);
    const int64_t got = (int64_t)drop_indices(rec).size();
    const std::vector<int64_t> late = release_lateness(slice(rec, 3600, rec.size()));
    CHECK(fmt("16 60p on a 60.038 Hz display presenting at most 56.6 fps: drops = the presentation "
              "deficit +- 1 %% over 10 min, %lld (want %.1f)", (long long)got, want).c_str(),
          std::fabs((double)got - want) * 100 <= want);
    CHECK(fmt("16 the decimation runs on the achieved period, not the refresh (%lld ns, %.3f %% off)",
              (long long)s.display_period, 100.0 * (double)(s.display_period - achieved) / (double)achieved)
              .c_str(),
          s.display_source == DisplaySource::measured && std::llabs(s.display_period - achieved) * 200 <= achieved);
    CHECK(fmt("16 release lateness flat within one of the display's frames after the first minute "
              "(%.2f ms)", (double)spread(late) / MS).c_str(),
          spread(late) <= s.display_period);
    CHECK(fmt("16 the rate foresaw the drops: %lld of %lld were the sink's a period behind",
              (long long)s.behind, (long long)got).c_str(),
          (int64_t)s.behind * 10 <= got);
}

void test_kms_every_other_refresh() {
    // kmssink on that DSI shows one frame per two refreshes (DEV-P4a, DEV-P4b).
    const std::pair<int64_t, int64_t> runs[] = {{50, 20}, {60, 30}};
    for (const auto& run : runs) {
        const int64_t num = run.first, per_second = run.second;
        VideoPace pace;
        DisplayRate rate;
        KmsWait display(DSI, 3700 * US);
        const std::vector<Rec> rec =
            drive_rate(pace, rate, live(cadence(600 * num, num, 1), SEC / num), &display, DSI);
        const PaceSummary s = pace.take();
        const int64_t drops = (int64_t)drop_indices(rec).size();
        const double got = (double)drops / 600;
        const std::vector<int64_t> late = release_lateness(slice(rec, (size_t)(60 * num), rec.size()));
        CHECK(fmt("17 %lldp into kmssink presenting every second refresh at 60.038 Hz: %lld drops a "
                  "second +- 1 %% (%.3f)", (long long)num, (long long)per_second, got).c_str(),
              std::fabs(got - (double)per_second) * 100 <= (double)per_second);
        CHECK(fmt("17 %lldp into that kmssink: release lateness flat within a frame after the first "
                  "minute (%.2f ms), the period two refreshes", (long long)num, (double)spread(late) / MS)
                  .c_str(),
              spread(late) <= SEC / num && s.display_period == 2 * DSI);
        CHECK(fmt("17 %lldp into that kmssink: the rate foresaw the drops once measured (%lld of %lld the "
                  "sink's)", (long long)num, (long long)s.behind, (long long)drops).c_str(),
              (int64_t)s.behind * 10 <= drops);
    }
}

bool rate_is(const DisplayRate& rate, int64_t period, DisplaySource source) {
    DisplaySource got = DisplaySource::none;
    const int64_t p = rate.period(&got);
    return p == period && got == source;
}

void test_display_rate() {
    DisplayRate rate;
    rate.set_prior(DSI);
    rate.set_refresh(DSI);
    for (int64_t k = 0; k <= 2000; k++) rate.on_push(k * P50, k > 0);   // 40 s of a sink taking 50/s
    CHECK("18 the prior given and the measurement slower: the measurement rules",
          rate_is(rate, P50, MEASURED) && rate.achieved() == P50);
    DisplayRate paced;
    paced.set_refresh(DSI);
    for (int64_t k = 0; k <= 2000; k++) paced.on_push(k * P50, false);
    CHECK("18 pushes the element paced (none left at once on the last return): the refresh stays",
          rate_is(paced, DSI, MEASURED) && paced.achieved() == 0);
    DisplayRate early;
    for (int64_t k = 0; k <= 1000; k++) early.on_push(k * P50, k > 0);   // two windows only
    CHECK("18 two windows do not make a rate yet", early.achieved() == 0 && rate_is(early, 0, DisplaySource::none));
    for (int64_t k = 1; k <= 500; k++) rate.on_push(2000 * P50 + k * (P50 + P50 / 100), true);
    CHECK(fmt("18 a window 1 %% long among five does not move the rate (%lld)", (long long)rate.achieved()).c_str(),
          rate.windows() == 5 && rate.achieved() == P50);
    rate.set_refresh(DSI * 101 / 100 + 1);
    CHECK("18 the refresh moving more than 1 %: measured again", rate.achieved() == 0 && rate.windows() == 0);
    for (int64_t k = 0; k <= 1500; k++) rate.on_push(k * 2 * DSI, k > 0);
    rate.restart();
    CHECK("18 a restart (new caps): measured again", rate.achieved() == 0 && rate.windows() == 0);
}

void test_keeps_up_as_before() {
    {
        VideoPace pace;
        DisplayRate rate;
        Wayland display(DSI, 3700 * US);
        const std::vector<Rec> rec = drive_rate(pace, rate, live(cadence(6000, 50, 1), P50), &display, DSI);
        const PaceSummary s = pace.take();
        CHECK("19 50p on a 60.038 Hz display that presents every frame: no drop, nothing measured, the "
              "refresh kept",
              drop_indices(rec).empty() && rate.achieved() == 0 && s.display_period == DSI &&
                  all_equal(release_lateness(rec), LATENCY));
    }
    VideoPace pace;
    DisplayRate rate;
    Wayland display(P50, 3700 * US);
    const std::vector<Rec> rec = drive_rate(pace, rate, live(cadence(36000, 60, 1), P60), &display);
    const PaceSummary s = pace.take();
    const std::vector<int64_t> idx = drop_indices(rec);
    std::vector<int64_t> late_idx;
    for (int64_t i : idx)
        if (i > 120) late_idx.push_back(i);
    CHECK(fmt("19 60p on a 50 Hz display, no prior: its every refresh is its achieved period, 1 in 6 "
              "after the first second (%lld drops)", (long long)idx.size()).c_str(),
          s.display_period == P50 && all_equal(spacings(late_idx), 6) &&
              std::fabs((double)idx.size() - expected_drops(rec, P50)) <= 2);
}

// Capped, frozen 300 ms from 35 s: inside the third window, the one that makes the rate.
struct Hiccup : Capped {
    Hiccup(int64_t p, int64_t ph, int64_t cap_mhz) : Capped(p, ph, cap_mhz) {}
    int64_t refresh_after(int64_t t) const override {
        int64_t v = Capped::refresh_after(t);
        while (35 * SEC <= v && v < 35 * SEC + 300 * MS) v = Capped::refresh_after(v);
        return v;
    }
};

void test_hiccup_window() {
    VideoPace pace;
    DisplayRate rate;
    const int64_t achieved = 1000000000000LL / 56600;
    Hiccup display(DSI, 3700 * US, 56600);
    const std::vector<Rec> rec = drive_rate(pace, rate, live(cadence(18000, 60, 1), P60), &display, DSI);
    const PaceSummary s = pace.take();
    const double want = expected_drops(rec, achieved) + (double)(300 * MS) / (double)achieved;
    const int64_t got = (int64_t)drop_indices(rec).size();
    CHECK(fmt("20 a 300 ms freeze inside a window of the measurement does not move the rate (%lld ns), "
              "drops the deficit and the freeze +- 1 %% (%lld, want %.1f)",
              (long long)s.display_period, (long long)got, want).c_str(),
          std::llabs(s.display_period - achieved) * 200 <= achieved && std::fabs((double)got - want) * 100 <= want);
}

// --- 21: the drain (B-179) ------------------------------------------------------------------

void test_drain() {
    const int64_t n = 4000;
    struct Row {
        const char* name;
        int64_t period, drain;
    };
    const Row rows[] = {{"50p on 60 Hz, +0.5 %", 16666667, 5000000},
                        {"50p on 50 Hz, +0.5 %", P50, 5000000},
                        {"50p on 50 Hz, -0.5 %", P50, -5000000},
                        {"50p on 60 Hz, -0.5 %", 16666667, -5000000}};
    for (const Row& r : rows) {
        VideoPace pace;
        pace.set_display(r.period, DisplaySource::measured);
        pace.set_drain(r.drain);
        std::vector<Frame> frames;
        for (int64_t p : cadence(n, 50, 1)) frames.push_back({p, P50, 0, false, false});
        Wayland w(r.period, 3700 * US);
        const std::vector<Rec> rec = drive(pace, frames, &w);
        const PaceSummary s = pace.take();
        const std::vector<int64_t> shown = shown_lateness(rec);
        const int64_t moved = shown.back() - shown[100];
        const int64_t want = -(int64_t)((__int128)r.drain * (rec.back().pts - rec[100].pts) / SEC);
        const bool decimates = r.period == P50 && r.drain > 0;
        char name[200];
        std::snprintf(name, sizeof name, "drain %s: %llu drain drops (%s), rate drops %llu, behind %llu", r.name,
                      (unsigned long long)s.drain_drops, decimates ? "n / 200 +-1" : "none",
                      (unsigned long long)s.rate_drops, (unsigned long long)s.behind);
        CHECK(name, s.rate_drops == 0 && s.behind == 0 &&
                        (decimates ? std::llabs((int64_t)s.drain_drops - n / 200) <= 1 : s.drain_drops == 0));
        std::snprintf(name, sizeof name, "drain %s: the shown lateness moves %+.1f ms (0.5 %% of the content: %+.1f, "
                      "+-10 %%)", r.name, moved / 1e6, want / 1e6);
        CHECK(name, std::llabs(moved - want) <= std::llabs(want) / 10);
    }
    // A sink blocking to its next 20 ms refresh (mrtestvideosink, kmssink), the drain from its 1000th push, the
    // thread back 100 us after each flip: the sink's wait grows by the drain's own lead, the lag foresees it.
    struct KmsDrainAt : Kms {
        VideoPace* pace;
        int64_t pushes = 0, stall_at;
        KmsDrainAt(int64_t p, int64_t ph, VideoPace* v, int64_t stall = 0) : Kms(p, ph), pace(v), stall_at(stall) {}
        std::pair<int64_t, int64_t> push(int64_t t) override {
            if (++pushes == 1000) pace->set_drain(5000000);
            int64_t shown = refresh_after(t);
            if (pushes == stall_at) shown += 5 * period;   // a display frozen 100 ms
            return {shown + 100 * US, shown};
        }
    };
    std::vector<Frame> backlog;
    for (int64_t p : cadence(n + 1000, 50, 1)) backlog.push_back({p, P50, 0, false, false});
    for (int64_t phase : {(int64_t)0, 5 * MS, 13 * MS, 19900 * US}) {
        VideoPace pace;
        pace.set_display(P50, DisplaySource::measured);
        KmsDrainAt k(P50, phase, &pace);
        drive(pace, backlog, &k);
        const PaceSummary s = pace.take();
        CHECK(fmt("drain 50p into a blocking 50 Hz sink at phase %.1f ms, +0.5 %%: %llu drain drops (n / 200 +-1),"
                  " rate drops %llu, behind %llu", phase / 1e6, (unsigned long long)s.drain_drops,
                  (unsigned long long)s.rate_drops, (unsigned long long)s.behind).c_str(),
              std::llabs((int64_t)s.drain_drops - n / 200) <= 1 && s.rate_drops == 0 && s.behind == 0);
    }
    {
        VideoPace pace;
        pace.set_display(P50, DisplaySource::measured);
        KmsDrainAt k(P50, 5 * MS, &pace, 4000);
        const std::vector<Rec> rec = drive(pace, backlog, &k);
        const PaceSummary s = pace.take();
        std::vector<int64_t> shown;
        for (const Rec& r : rec)
            if (!r.drop) shown.push_back(r.shown - r.pts);
        size_t j = 1;
        while (j + 1 < shown.size() && shown[j] - shown[j - 1] <= 50 * MS) j++;
        const int64_t back = shown[j + 1] - shown[j - 1];
        CHECK(fmt("drain into that sink frozen 100 ms at its 4000th push: the freeze's 5 frames are rate drops "
                  "(%llu), the drain's are not (%llu drain drops), the shown lateness back within a frame (%+.1f ms)",
                  (unsigned long long)s.rate_drops, (unsigned long long)s.drain_drops, back / 1e6).c_str(),
              s.rate_drops == 5 && std::llabs((int64_t)s.drain_drops - n / 200) <= 1 && std::llabs(back) <= P50);
    }
    VideoPace pace;
    pace.set_display(P50, DisplaySource::measured);
    pace.on_frame(0, P50, 100 * MS, false);
    const PaceDecision a = pace.on_frame(P50, P50, 105 * MS, false);
    const PaceDecision b = pace.on_frame(2 * P50, P50, 180 * MS, false);
    CHECK("drain fields: a frame's slack is its slot less its arrival (15 ms), a late frame's lateness past it "
          "(40 ms, its slack -40 ms)",
          a.has_slack && a.slack_ns == 15 * MS && !a.late && b.late && b.late_by_ns == 40 * MS && b.has_slack &&
              b.slack_ns == -40 * MS);
}

void (*const CASES[])() = {test_50p_on_60hz,         test_60p_on_50hz,
                           test_60_on_5994,          test_50p_on_slow_display_measured,
                           test_50p_on_matched_display, test_slow_display_nominal,
                           test_stall_then_gap,      test_discont_and_gap_collapse,
                           test_idr_spikes,          test_wrap_point,
                           test_display_period,      test_60p_on_slow_50hz,
                           test_foreign_clock_source, test_faster_display_banks_one_frame,
                           test_stamp_jitter,        test_slow_presenting_display,
                           test_kms_every_other_refresh, test_display_rate,
                           test_keeps_up_as_before,  test_hiccup_window,
                           test_drain};

}  // namespace

int main(int argc, char** argv) {
    const int n = (int)(sizeof CASES / sizeof CASES[0]);
    if (argc == 3 && std::string(argv[1]) == "--case") {
        const int k = std::atoi(argv[2]);
        if (k < 1 || k > n) {
            std::fprintf(stderr, "usage: video_pace_test [--case 1..%d]\n", n);
            return 2;
        }
        CASES[k - 1]();
    } else {
        for (int k = 0; k < n; k++) CASES[k]();
    }
    return test_summary("video_pace");
}
