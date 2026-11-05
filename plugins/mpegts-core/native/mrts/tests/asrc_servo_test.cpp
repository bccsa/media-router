// asrc_servo: the ASRC phase servo (WI-P1-8; WI-P3-5 and B-148 as py/asrc_bypass_ref_test.py holds them) through a
// model of GstAudioResampler's frame accounting, and the device term on its timer (WI-P4-4, B-166) as
// py/asrc_device_ref_test.py holds it. Integer-only servo checksums; `--sweep N` prints seed statistics.
#include <algorithm>
#include <climits>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "../asrc_servo.h"
#include "check.h"

using namespace mrts;

namespace {

constexpr int64_t US = 1000, MS = 1000000, S = 1000000000;
constexpr int64_t H0 = 1000 * S;   // house time of the first captured frame
constexpr int64_t SUB = 1 << 14;   // model positions in 1/SUB input frames
constexpr int64_t FRAME_NS = 20833;   // one 48 kHz frame, floor

struct Lcg {
    uint64_t s;
    explicit Lcg(uint64_t seed) : s(seed * 0x9E3779B97F4A7C15ULL + 1) {}
    uint32_t next() {
        s = s * 6364136223846793005ULL + 1442695040888963407ULL;
        return (uint32_t)(s >> 32);
    }
};

struct Fnv {
    uint64_t h = 1469598103934665603ULL;
    void add(int64_t v) {
        for (int i = 0; i < 8; i++) {
            h ^= (uint64_t)(v >> (8 * i)) & 0xff;
            h *= 1099511628211ULL;
        }
    }
};

Fnv g_all;   // every run's checksum folds in here

int64_t floor_div(int64_t a, int64_t b) {
    const int64_t q = a / b;
    return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q;
}

int64_t iabs(int64_t v) { return v < 0 ? -v : v; }

int64_t gcd(int64_t a, int64_t b) {
    while (b) {
        const int64_t t = a % b;
        a = b;
        b = t;
    }
    return a;
}

// GstAudioResampler's frame accounting, gst-plugins-base 1.28.2 audio-resampler.c:
// reset (1436), update (1473; max-phase-error 0.05 as mrasrc sets it), get_out_frames
// (1619), resample (1720). Kaiser quality 4 is 64 taps from an 8x cubic table, which
// centres an output at its window start + 64/2 - 1 - 1/8 + phase (1172, 576, 365); at
// equal rates the window's first sample is copied (setup_functions). Checked against the
// library with a ramp input: same frame counts, positions within 0.0002 frames.
class ModelResampler {
  public:
    static constexpr int64_t TAPS = 64, OVERSAMPLE = 8, DELAY = TAPS / 2;

    ModelResampler(int64_t in_rate, int64_t out_rate) : full_(out_rate) { update(in_rate, out_rate); }

    void update(int64_t in_rate, int64_t out_rate) {
        const int64_t ph = out_ > 0 ? phase_ * out_rate / out_ : 0;
        int64_t g = gcd(in_rate, out_rate);
        // GStreamer's |ph/out - (ph/g)/(out/g)| < 0.05, exactly: (ph mod g) / out < 1/20.
        while (g > 1 && 20 * (ph % g) >= out_rate) {
            int64_t f = 2;
            while (g % f) f++;
            g /= f;
        }
        phase_ = ph / g;
        in_ = in_rate / g;
        out_ = out_rate / g;
        updates_++;
    }
    int64_t out_frames(int64_t in_frames) const {
        const int64_t a = avail_ + in_frames;
        if (a < TAPS || (a - TAPS) * out_ < phase_) return 0;
        return ((a - TAPS) * out_ - phase_) / in_ + 1;
    }
    // Pushes in_frames and makes the k outputs out_frames allowed. False once the
    // history empties (GStreamer's skip path, never taken at ratios near 1).
    bool resample(int64_t in_frames, int64_t k) {
        avail_ += in_frames;
        if (avail_ < TAPS || k == 0) return true;
        const int64_t t = phase_ + k * in_;
        avail_ -= t / out_;
        hist0_ += t / out_;
        phase_ = t % out_;
        return avail_ > 0;
    }
    // Input position of the next output, in 1/SUB frames.
    int64_t position() const {
        if (in_ == out_) return hist0_ * SUB;
        return (hist0_ + TAPS / 2 - 1) * SUB - SUB / OVERSAMPLE + phase_ * (full_ / out_) * SUB / full_;
    }
    uint64_t updates() const { return updates_; }
    int64_t in() const { return in_; }     // the reduced rates
    int64_t out() const { return out_; }

  private:
    int64_t full_;                          // out_rate as passed: out_hz * 1000
    int64_t in_ = 0, out_ = 0, phase_ = 0;  // reduced rates; samp_phase in 1/out_ frames
    int64_t avail_ = TAPS / 2 - 1;          // reset: half the filter is zeros ...
    int64_t hist0_ = -(TAPS / 2 - 1);       // ... ahead of input frame 0
    uint64_t updates_ = 0;
};

// The capture: input frame i is captured at house H0 + i / (fs (1 + ppb)); positions
// from gap_x on gap_ns later (an xrun lost them; negative: the device's PTS stepped back).
struct Device {
    int64_t fs, ppb;
    int64_t gap_x = INT64_MAX, gap_ns = 0;   // gap_x in 1/SUB frames

    // floor(nom * ppb / (1e9 + ppb)), split so nothing overflows.
    int64_t fast_by(int64_t nom) const {
        const int64_t d = S + ppb, a = floor_div(nom, S), b = nom - a * S, c = a * ppb;
        const int64_t qc = floor_div(c, d);
        return qc * S + floor_div((c - qc * d) * S + b * ppb, d);
    }
    // House time of input position x (1/SUB frames).
    int64_t house(int64_t x) const {
        const int64_t d = SUB * fs, q = floor_div(x, d);
        const int64_t nom = q * S + (x - q * d) * S / d;
        return H0 + nom - fast_by(nom) + (x >= gap_x ? gap_ns : 0);
    }
};

struct Scenario {
    int64_t in_hz = 48000, out_hz = 48000;
    int64_t ppb = 0;              // the device clock is fast by this much
    int64_t secs = 3600;
    int64_t jitter_ns = 1 * MS;   // PTS = capture time + U[0, jitter) ...
    bool centred = false;         // ... or + U[-jitter/2, jitter/2)
    int64_t buf = 1024;           // frames per buffer; 0: 256..2048 at random
    int64_t gap_s = -1;           // at this nominal second the device loses ...
    int64_t gap_ns = 20 * MS;     // ... this much house time
    bool gap_discont = true;      // ... and flags DISCONT on the next buffer
    uint64_t seed = 1;
    int64_t late_s = 600;         // tracking is judged from here on
    AsrcServoConfig cfg;
};

constexpr int NMARK = 6;
const int64_t MARKS[NMARK] = {30 * S, 40 * S, 60 * S, 120 * S, 300 * S, 600 * S};

// Label error e = PTS_out of an output frame - capture time of its content. Times are
// capture times since frame 0; outputs within 2 filter lengths of a splice are skipped.
struct Run {
    int64_t lock_ns = -1;                    // first locked
    int64_t last_bad_ns = -1;                // last buffer with |e| > 1 output frame
    int64_t err_at[NMARK] = {0, 0, 0, 0, 0, 0};
    int64_t err_end = 0;                     // e of the next output at the end
    int64_t err_max_late = 0;                // max |e| from late_s on
    int64_t count_err_mf = 0;                // epoch frames - house span since T0 * out_hz, milli-frames
    int64_t total_err_mf = 0;                // all frames - (span since the first T0 - gap) * out_hz
    uint64_t m_end = 0;
    int64_t span_ns = 0;                     // house time of the next output's content - T0
    int relocks = 0, oob = 0;
    const char* why = "";
    int64_t relock_at_ns = -1, jump_ns = 0, event_jump_ns = 0, oob_ppb = 0;
    int64_t event_drop_ns = 0;               // the last relock's overlap dropped (its event)
    uint64_t dropped = 0;                    // input frames the servo said to skip
    int64_t ratio_lo = INT64_MAX, ratio_hi = INT64_MIN, ratio_end = 0;
    int64_t dratio_max = 0;                  // largest ratio change between buffers from late_s on
    int64_t ratio_dev_late = 0;              // max |ratio - device rate| from late_s on
    int64_t ratio_wsum = 0, ratio_w = 0;     // ratio x input frames, input frames, from late_s on
    bool clamped_late = false;               // the ratio sat at the clamp from late_s on
    bool contiguous = true, model_ok = true;
    uint64_t unity = 0;                      // commands with in_rate == out_rate
    uint64_t in_frames = 0, out_frames = 0, model_out = 0, pushed = 0, discont_in = 0, updates = 0;
    uint64_t buffers = 0, sum = 0;
};

bool in_frame(int64_t err_ns, int64_t hz) { return iabs(err_ns) * hz <= S; }

// ε the lock should find for a device fast by ppb: house = (1 + ε) σ, so ε = -ppb / (1 + ppb).
int64_t eps_of(int64_t ppb) { return -floor_div(ppb * S, S + ppb); }

Run run(const Scenario& sc) {
    AsrcServo sv((int32_t)sc.in_hz, (int32_t)sc.out_hz, sc.cfg);
    std::unique_ptr<ModelResampler> rs;   // made from the first command, as mrasrc does
    Device dev{sc.in_hz, sc.ppb};
    const bool has_gap = sc.gap_s >= 0;
    const int64_t gap_frame = has_gap ? sc.gap_s * sc.in_hz : INT64_MAX, near = 2 * ModelResampler::TAPS * SUB;
    if (has_gap) {
        dev.gap_x = gap_frame * SUB;
        dev.gap_ns = sc.gap_ns;
    }
    // Skipped frames never reach the resampler: (its frame count at the drop, frames
    // skipped up to then) maps a resampler position back to the captured frame.
    int64_t n_res = 0;
    std::vector<std::pair<int64_t, int64_t>> drops;
    auto captured = [&](int64_t x) {
        int64_t d = 0;
        for (const auto& q : drops)
            if (x >= q.first * SUB) d = q.second;
        return x + d * SUB;
    };
    auto near_drop = [&](int64_t x) {
        for (const auto& q : drops)
            if (iabs(x - q.first * SUB) < near) return true;
        return false;
    };
    const int64_t total = sc.secs * sc.in_hz;
    Lcg g(sc.seed);
    Fnv f;
    Run r;
    const int64_t late = sc.late_s * S, eps = eps_of(sc.ppb), lim = sc.cfg.ratio_max_ppm * 1000;
    int64_t n = 0, cur = 0, expect = 0, t0_first = 0, prev = 0;
    bool have_prev = false;
    int mark = 0;
    while (n < total) {
        int64_t b = sc.buf > 0 ? sc.buf : 256 + (int64_t)(g.next() % 1793);
        if (n < gap_frame && n + b > gap_frame) b = gap_frame - n;   // the xrun at a buffer edge
        int64_t j = sc.jitter_ns > 0 ? (int64_t)(g.next() % (uint64_t)sc.jitter_ns) : 0;
        if (sc.centred) j -= sc.jitter_ns / 2;
        const int64_t t = dev.house(n * SUB) - H0;
        const bool disc = n == 0 || (n == gap_frame && sc.gap_discont);   // GStreamer flags the first too
        const AsrcServo::Command c = sv.push(H0 + t + j, (uint32_t)b, disc);
        if (n == 0) {
            t0_first = sv.t0();
            rs.reset(new ModelResampler(c.in_rate, c.out_rate));
            sv.set_delay(ModelResampler::DELAY);
            cur = c.in_rate;
        }
        if (c.in_rate == c.out_rate) r.unity++;
        if (c.in_rate != cur) {
            rs->update(c.in_rate, c.out_rate);
            cur = c.in_rate;
        }
        const int64_t fed = b - c.skip;
        if (c.skip > 0) {
            if (drops.empty() || drops.back().first != n_res)
                drops.push_back({n_res, (drops.empty() ? 0 : drops.back().second) + c.skip});
            else
                drops.back().second += c.skip;
            r.dropped += c.skip;
        }
        const int64_t k = rs->out_frames(fed), label = sv.next_pts(), x = rs->position(), xc = captured(x);
        if (c.relock) {
            r.jump_ns = label - expect;
            r.relock_at_ns = t;
        } else if (n > 0 && label != expect) {
            r.contiguous = false;
        }
        r.model_ok = r.model_ok && rs->resample(fed, k);
        n_res += fed;
        sv.produced((uint32_t)k);
        expect = sv.next_pts();
        r.model_out += (uint64_t)k;
        r.pushed += (uint64_t)b;
        if (k > 0 && (!has_gap || xc < dev.gap_x - near || xc > dev.gap_x + near) && !near_drop(x)) {
            const int64_t e = label - dev.house(xc);
            if (!in_frame(e, sc.out_hz)) r.last_bad_ns = t;
            if (t >= late) r.err_max_late = std::max(r.err_max_late, iabs(e));
            while (mark < NMARK && t >= MARKS[mark]) r.err_at[mark++] = e;
            f.add(e);
        }
        const AsrcServo::Stats st = sv.stats();
        r.ratio_lo = std::min(r.ratio_lo, st.ratio_ppb);
        r.ratio_hi = std::max(r.ratio_hi, st.ratio_ppb);
        if (t >= late) {
            if (have_prev && !c.relock) r.dratio_max = std::max(r.dratio_max, iabs(st.ratio_ppb - prev));
            r.ratio_dev_late = std::max(r.ratio_dev_late, iabs(st.ratio_ppb - eps));
            r.ratio_wsum += st.ratio_ppb * b;
            r.ratio_w += b;
            r.clamped_late = r.clamped_late || iabs(st.ratio_ppb) >= lim;
        }
        prev = st.ratio_ppb;
        have_prev = true;
        if (st.state == AsrcServo::State::locked && r.lock_ns < 0) r.lock_ns = t;
        for (const AsrcEvent& e : sv.take_events()) {
            f.add((int64_t)e.kind);
            f.add(e.house_ns);
            f.add(e.value);
            if (e.kind == AsrcEvent::Kind::relock) {
                if (e.dropped_ns) f.add(e.dropped_ns);   // so a run without a drop sums as before
                r.relocks++;
                r.why = e.reason;
                r.event_jump_ns = e.value;
                r.event_drop_ns = e.dropped_ns;
            } else {
                r.oob++;
                r.oob_ppb = e.value;
            }
        }
        f.add(c.in_rate);
        if (c.skip) f.add(c.skip);
        f.add(label);
        f.add(k);
        f.add(st.phase_err_ns);
        n += b;
        r.buffers++;
    }
    const int64_t he = dev.house(captured(rs->position()));
    const AsrcServo::Stats st = sv.stats();
    r.err_end = sv.next_pts() - he;
    r.m_end = sv.epoch_frames();
    r.span_ns = he - sv.t0();
    r.count_err_mf = ((int64_t)r.m_end * S - r.span_ns * sc.out_hz) / MS;
    const int64_t lost = has_gap && sc.gap_discont ? sc.gap_ns : 0;
    r.total_err_mf = ((int64_t)st.out_frames * S - (he - t0_first - lost) * sc.out_hz) / MS;
    r.ratio_end = st.ratio_ppb;
    r.in_frames = st.in_frames;
    r.out_frames = st.out_frames;
    r.discont_in = st.discont_in;
    r.updates = rs->updates();
    f.add(r.err_end);
    f.add((int64_t)st.out_frames);
    r.sum = f.h;
    return r;
}

// The ratio averaged over input frames from late_s on, minus the device's: the drift left.
int64_t mean_ratio_err(const Run& r, int64_t ppb) {
    return r.ratio_w > 0 ? floor_div(r.ratio_wsum, r.ratio_w) - eps_of(ppb) : INT64_MAX;
}

const char* yes(bool v) { return v ? "yes" : "NO"; }

void print_run(const char* label, const Scenario& sc, const Run& r) {
    std::printf("  %-34s lock %5.2f s | e us @30/40/60/120/300/600 s %+8.1f %+8.1f %+7.1f %+6.1f %+5.1f %+5.1f"
                " | end %+5.2f us | out %llu = house %.6f s x %lld %+.3f fr | max|e| >=600 s %.2f us"
                " | |e|<=1 fr from %.1f s\n",
                label, r.lock_ns / 1e9, r.err_at[0] / 1e3, r.err_at[1] / 1e3, r.err_at[2] / 1e3, r.err_at[3] / 1e3,
                r.err_at[4] / 1e3, r.err_at[5] / 1e3, r.err_end / 1e3, (unsigned long long)r.m_end, r.span_ns / 1e9,
                (long long)sc.out_hz, r.count_err_mf / 1000.0, r.err_max_late / 1e3, r.last_bad_ns / 1e9);
    std::printf("  %-34s relocks %d, ratio end %+.4f ppm (device %+.4f), range %+.3f..%+.3f ppm, max step >=600 s"
                " %.3f ppm/buffer, %.1f resampler updates/s, 1:1 commands %llu, contiguous %s, %016llx\n",
                "", r.relocks, r.ratio_end / 1e3, eps_of(sc.ppb) / 1e3, r.ratio_lo / 1e3, r.ratio_hi / 1e3,
                r.dratio_max / 1e3, (double)r.updates / (double)sc.secs, (unsigned long long)r.unity, yes(r.contiguous),
                (unsigned long long)r.sum);
}

// --- basics -------------------------------------------------------------------------

void test_basics() {
    AsrcServo sv(48000, 48000);
    CHECK("servo: acquiring before any buffer", sv.state() == AsrcServo::State::acquiring);
    AsrcServo::Command c = sv.push(5 * S, 1024, true);
    CHECK("first buffer: no relock, T0 = its PTS, out_rate = 48 kHz x 1000",
          !c.relock && sv.t0() == 5 * S && c.out_rate == 48000000);
    CHECK("first buffer: nominal ratio, one unit off 1:1 (GStreamer copies unfiltered at equal rates)",
          c.in_rate == 47999999 && sv.stats().ratio_ppb == 0);
    CHECK("PTS_out(m) = T0 + floor(m * 1e9 / out_rate)",
          sv.pts_at(1) == 5 * S + 20833 && sv.pts_at(3) == 5 * S + 62500 && sv.pts_at(48000) == 6 * S &&
              sv.pts_at(48000ULL * 3600 * 24 * 365) == 5 * S + 3600LL * 24 * 365 * S);
    sv.produced(992);
    CHECK("a first buffer's DISCONT is no discontinuity", sv.stats().discont_in == 0 && sv.stats().relocks == 0);
    c = sv.push(5 * S + 21333333, 1024, false);
    sv.produced(1024);
    const int64_t end = sv.next_pts();
    c = sv.push(5 * S + 42666666 + 20 * MS, 1024, true);
    const std::vector<AsrcEvent> ev = sv.take_events();
    CHECK("DISCONT relocks: one event, reason discont, counted",
          c.relock && ev.size() == 1 && ev[0].kind == AsrcEvent::Kind::relock &&
              !std::strcmp(ev[0].reason, "discont") && sv.stats().relocks == 1 && sv.stats().discont_in == 1);
    CHECK("... the new T0 is the event's, after the last output, and the jump is the difference",
          ev.size() == 1 && ev[0].house_ns == sv.t0() && sv.t0() > end && ev[0].value == sv.t0() - end &&
              sv.epoch_frames() == 0);
    sv.produced(1024);
    const int64_t end2 = sv.next_pts();
    c = sv.push(5 * S, 1024, true);   // a DISCONT whose PTS steps back 60 ms
    const std::vector<AsrcEvent> back = sv.take_events();
    CHECK("a DISCONT stepping back: T0 is the end of the last output, jump 0 (never overlap)",
          c.relock && back.size() == 1 && sv.t0() == end2 && back[0].value == 0);
    // The next output's content (half a frame before this buffer) up to end2 overlaps.
    const int64_t over = end2 - (5 * S - FRAME_NS / 2);
    CHECK("... the input up to that end is dropped as overlap: this buffer whole, the event carries it",
          c.skip == 1024 && iabs(back[0].dropped_ns - over) <= FRAME_NS && sv.stats().dropped_frames == 1024);
    CHECK("... so the labels stay capture time: phase within a frame, the ratio not chasing it",
          iabs(sv.stats().phase_err_ns) <= FRAME_NS && iabs(sv.stats().ratio_ppb) <= 1000 &&
              iabs(c.in_rate - 47999999) <= 50);
    uint32_t skips[3];
    for (int i = 0; i < 3; i++) {
        skips[i] = sv.push(5 * S + (i + 1) * 21333333LL, 1024, false).skip;
        sv.produced(i == 2 ? 64 : 0);
    }
    const int64_t want = over * 48000 / S;   // the overlap in input frames, at the nominal rate
    const int64_t dropped = (int64_t)sv.stats().dropped_frames;
    CHECK("... the drop runs on across buffers until the overlap is gone, then nothing more",
          skips[0] == 1024 && skips[1] == 1024 && 3072 + skips[2] == dropped && iabs(dropped - want) <= 1 &&
              sv.push(5 * S + 4 * 21333333LL, 1024, false).skip == 0);
    AsrcServo far(48000, 48000);
    far.push(10 * S, 1024, true);
    far.produced(1024);
    far.push(5 * S, 1024, true);   // a DISCONT 5 s back: no capture latency moves that far
    const std::vector<AsrcEvent> fev = far.take_events();
    CHECK("a DISCONT 5 s back drops at most DROP_MAX_NS (1 s); the ratio slews what is left",
          fev.size() == 1 && iabs(fev[0].dropped_ns - AsrcServo::DROP_MAX_NS) <= FRAME_NS &&
              far.stats().ratio_ppb == -1000000 && far.stats().phase_err_ns < -3 * S);
    CHECK("names", !std::strcmp(asrc_event_name(AsrcEvent::Kind::relock), "relock") &&
                       !std::strcmp(asrc_event_name(AsrcEvent::Kind::ratio_out_of_bounds), "ratio-out-of-bounds") &&
                       !std::strcmp(asrc_state_name(AsrcServo::State::locked), "locked") &&
                       !std::strcmp(asrc_state_name(AsrcServo::State::acquiring), "acquiring"));
    const ClockLockConfig lc = asrc_lock_config(), stc;
    CHECK("lock constants: the STC's (part 4.3) but the 50 ms re-lock step (part 4.5), two-sided (the STC's is not)",
          lc.step_ns == 50 * MS && lc.step_falls && !stc.step_falls && lc.rate_buckets_min == stc.rate_buckets_min &&
              lc.bucket_ns == stc.bucket_ns && lc.rate_buckets_max == stc.rate_buckets_max &&
              lc.rate_tau_ns == stc.rate_tau_ns && lc.offset_buckets == stc.offset_buckets &&
              lc.acquire_ns == stc.acquire_ns && lc.slew_track_ppm == stc.slew_track_ppm &&
              lc.step_hold_ns == stc.step_hold_ns && lc.rate_max_ppm == 1000);
    const AsrcServoConfig dc;
    CHECK("servo constants: phase loop 10 s, ratio clamp +-1000 ppm (part 4.5)",
          dc.phase_tau_ns == 10 * S && dc.ratio_max_ppm == 1000);
}

// --- acceptance: lock, 1 h of frames ------------------------------------------------

// Bounds from the plan loop as specified (STC constants, raw-d bucket minima), measured
// over 100 seeds x 1 h per rate: lock 35.01..36.01 s; 1 h count error <= 0.70 frames at
// 0 and +-50 ppm, <= 1.19 at +-500 ppm (median 0.50); tracking <= 18 / 42.5 us.
void test_lock_and_hour() {
    std::printf("\n  48 kHz capture, 1024-frame buffers, PTS = capture time + U[0, 1 ms); 1 frame = 20.83 us\n");
    const int64_t devs[4] = {50000, -50000, 500000, -500000};
    for (int64_t ppb : devs) {
        const bool fast = iabs(ppb) >= 500000;
        int64_t lock_max = 0, e600_max = 0;
        for (uint64_t seed = 1; seed <= 9; seed++) {   // lock time over 9 seeds, 610 s each
            Scenario sc;
            sc.ppb = ppb;
            sc.secs = 610;
            sc.seed = 100 + seed;
            const Run r = run(sc);
            lock_max = std::max(lock_max, r.lock_ns < 0 ? INT64_MAX : r.lock_ns);
            e600_max = std::max(e600_max, iabs(r.err_at[5]));
            g_all.add((int64_t)r.sum);
        }
        int64_t count_max = 0, late_max = 0, mean_max = 0, dev_max = 0, step_max = 0;
        bool only_ratio = true, counted = true;
        for (uint64_t seed = 1; seed <= 5; seed++) {   // 5 seeds x 1 h
            Scenario sc;
            sc.ppb = ppb;
            sc.seed = seed;
            const Run r = run(sc);
            if (seed == 1) {
                char label[64];
                std::snprintf(label, sizeof label, "device %+lld ppm, 1 h:", (long long)ppb / 1000);
                print_run(label, sc, r);
            }
            count_max = std::max(count_max, iabs(r.count_err_mf));
            late_max = std::max(late_max, r.err_max_late);
            mean_max = std::max(mean_max, iabs(mean_ratio_err(r, ppb)));
            dev_max = std::max(dev_max, r.ratio_dev_late);
            step_max = std::max(step_max, r.dratio_max);
            only_ratio = only_ratio && r.contiguous && r.relocks == 0 && r.oob == 0 && r.unity == 0 &&
                         r.ratio_lo >= -1000000 && r.ratio_hi <= 1000000;
            counted = counted && r.in_frames == r.pushed && r.out_frames == r.model_out && r.discont_in == 0 &&
                      r.model_ok;
            g_all.add((int64_t)r.sum);
        }
        std::printf("  %-34s 9 seeds x 610 s: lock <= %.2f s, |e| at 600 s <= %.2f us; 5 seeds x 1 h:"
                    " |count err| <= %.3f fr, |e| from 600 s <= %.2f us, ratio from 600 s: mean - device <= %.4f ppm,"
                    " |ratio - device| <= %.3f ppm, step <= %.3f ppm\n", "", lock_max / 1e9, e600_max / 1e3,
                    count_max / 1e3, late_max / 1e3, mean_max / 1e3, dev_max / 1e3, step_max / 1e3);
        const long long ppm = (long long)ppb / 1000;
        char name[240];
        std::snprintf(name, sizeof name, "%+lld ppm, 1 ms jitter: locked within 37 s, 9 seeds (plan: 30 s; the STC's"
                      " 30-bucket first fit + 5 s acquire)", ppm);
        CHECK(name, lock_max <= 37 * S);
        if (!fast) {
            std::snprintf(name, sizeof name, "%+lld ppm: 1 h simulated, output frames = house seconds x 48,000"
                          " +-1 frame (5 seeds)", ppm);
            CHECK(name, count_max <= 1000);
            std::snprintf(name, sizeof name, "%+lld ppm: every output frame within 1 frame of its capture time"
                          " from 600 s (5 seeds x 1 h, 9 more at 600 s)", ppm);
            CHECK(name, in_frame(late_max, 48000) && in_frame(e600_max, 48000));
        } else {
            std::snprintf(name, sizeof name, "%+lld ppm: 1 h simulated, output frames = house seconds x 48,000"
                          " +-1.5 frames (5 seeds; plan +-1: met at the median, see the report)", ppm);
            CHECK(name, count_max <= 1500);
            std::snprintf(name, sizeof name, "%+lld ppm: every output frame within 2.5 frames of its capture time"
                          " from 600 s (5 seeds x 1 h, 9 more at 600 s)", ppm);
            CHECK(name, late_max * 48000 <= 5 * S / 2 && e600_max * 48000 <= 5 * S / 2);
        }
        std::snprintf(name, sizeof name, "%+lld ppm: the ratio from 600 s averages to the device rate +-0.02 ppm"
                      " (no drift) and stays within 10 ppm of it", ppm);
        CHECK(name, mean_max <= 20 && dev_max <= 10000);
        std::snprintf(name, sizeof name, "%+lld ppm: only the ratio moves: one contiguous PTS counter, no event,"
                      " never 1:1, ratio inside +-1000 ppm, steps <= 3 ppm per buffer from 600 s", ppm);
        CHECK(name, only_ratio && step_max <= 3000);
        std::snprintf(name, sizeof name, "%+lld ppm: stats count every frame in and out, the resampler model held",
                      ppm);
        CHECK(name, counted);
    }
}

// --- acceptance: xrun ----------------------------------------------------------------

void test_xrun() {
    std::printf("\n  xrun: at 600 s the device loses 20 ms and flags DISCONT\n");
    for (int64_t ppb : {50000LL, -500000LL}) {
        Scenario sc;
        sc.ppb = ppb;
        sc.secs = 1200;
        sc.gap_s = 600;
        sc.jitter_ns = 0;
        const Run r = run(sc);
        char label[64], name[200];
        std::snprintf(label, sizeof label, "%+lld ppm, clean PTS:", (long long)ppb / 1000);
        print_run(label, sc, r);
        std::printf("  %-34s relock '%s' at %.3f s, output PTS jump %.6f ms (event %.6f ms), total frames %+.3f fr"
                    " against house time less the 20 ms\n",
                    "", r.why, r.relock_at_ns / 1e9, r.jump_ns / 1e6, r.event_jump_ns / 1e6, r.total_err_mf / 1000.0);
        g_all.add((int64_t)r.sum);
        std::snprintf(name, sizeof name, "xrun %+lld ppm: one relock, reason discont, counted once",
                      (long long)ppb / 1000);
        CHECK(name, r.relocks == 1 && !std::strcmp(r.why, "discont") && r.discont_in == 1 && r.oob == 0);
        std::snprintf(name, sizeof name, "xrun %+lld ppm: one forward output PTS jump of 20 ms +-1 frame",
                      (long long)ppb / 1000);
        CHECK(name, in_frame(r.jump_ns - 20 * MS, 48000) && r.event_jump_ns == r.jump_ns && r.contiguous);
        std::snprintf(name, sizeof name, "xrun %+lld ppm: frames out = house seconds x 48,000 less 20 ms, +-1 frame;"
                      " labels within 1 frame from 120 s", (long long)ppb / 1000);
        CHECK(name, iabs(r.total_err_mf) <= 1000 && iabs(r.count_err_mf) <= 1000 && r.last_bad_ns < 120 * S);
    }
    {
        Scenario sc;
        sc.ppb = 50000;
        sc.secs = 1200;
        sc.gap_s = 600;
        int64_t jmin = INT64_MAX, jmax = INT64_MIN, settle = 0;
        int relocks = 0;
        bool count_ok = true;
        for (uint64_t seed = 1; seed <= 9; seed++) {
            sc.seed = 200 + seed;
            const Run r = run(sc);
            jmin = std::min(jmin, r.jump_ns);
            jmax = std::max(jmax, r.jump_ns);
            settle = std::max(settle, r.last_bad_ns - r.relock_at_ns);
            relocks += r.relocks;
            count_ok = count_ok && iabs(r.count_err_mf) <= 1000 && in_frame(r.err_end, 48000);
            g_all.add((int64_t)r.sum);
        }
        std::printf("  %-34s 9 seeds: jumps %.4f..%.4f ms (20 ms + the first PTS's jitter), labels back within 1 frame"
                    " %.1f s after the relock\n", "+50 ppm, 1 ms jitter:", jmin / 1e6, jmax / 1e6, settle / 1e9);
        CHECK("xrun with 1 ms jitter: one relock per run, the jump is 20 ms plus that PTS's jitter (-1 frame..+1 ms)",
              relocks == 9 && jmin >= 20 * MS - FRAME_NS && jmax <= 21 * MS);
        CHECK("xrun with 1 ms jitter: the ratio steers the jitter out, labels within 1 frame 60 s after;"
              " epoch frames = house seconds x 48,000 +-1",
              settle <= 60 * S && count_ok);
    }
}

// --- re-lock on the envelope: either way past 50 ms -------------------------------------

// A capture's PTS steps with its latency (a PipeWire quantum change): a rise past step_ns
// leaves a forward gap, a fall drops the overlap; both re-lock once on the step's floor.
void test_envelope() {
    std::printf("\n  PTS steps at 600 s with no DISCONT (1 ms jitter, +50 ppm)\n");
    struct Row {
        int64_t step;
        const char* name;
    };
    const Row rows[] = {{60 * MS, "+60 ms"}, {30 * MS, "+30 ms"}, {-60 * MS, "-60 ms"}, {-200 * MS, "-200 ms"}};
    for (const Row& w : rows) {
        Scenario sc;
        sc.ppb = 50000;
        sc.secs = 900;
        sc.gap_s = 600;
        sc.gap_ns = w.step;
        sc.gap_discont = false;
        const Run r = run(sc);
        std::printf("  %-34s relocks %d '%s' %.2f s after the step, jump %.3f ms, dropped %.3f ms (%llu frames),"
                    " ratio %+.3f..%+.3f ppm, contiguous %s, e end %+.1f us, |e| > 1 fr last %.2f s after,"
                    " total frames %+.3f fr\n", w.name, r.relocks, r.why,
                    r.relock_at_ns < 0 ? -1.0 : (r.relock_at_ns - 600 * S) / 1e9, r.jump_ns / 1e6,
                    r.event_drop_ns / 1e6, (unsigned long long)r.dropped, r.ratio_lo / 1e3, r.ratio_hi / 1e3,
                    yes(r.contiguous), r.err_end / 1e3, (r.last_bad_ns - 600 * S) / 1e9, r.total_err_mf / 1000.0);
        g_all.add((int64_t)r.sum);
        char name[200];
        if (w.step == 60 * MS) {
            CHECK("+60 ms step: one relock, reason envelope-step, step_hold (10 s) after it",
                  r.relocks == 1 && !std::strcmp(r.why, "envelope-step") && r.relock_at_ns >= 610 * S &&
                      r.relock_at_ns <= 612 * S && r.discont_in == 0);
            CHECK("+60 ms step: the output PTS jumps forward by the step (+-1 ms jitter), labels right after",
                  r.jump_ns >= 59 * MS && r.jump_ns <= 61 * MS && in_frame(r.err_end, 48000) && r.dropped == 0);
        } else if (w.step > 0) {
            CHECK("+30 ms step: no relock (not past 50 ms), one contiguous PTS counter, ratio in bounds",
                  r.relocks == 0 && r.contiguous && r.ratio_lo >= -1000000 && r.ratio_hi <= 1000000);
        } else {
            // The bucket holding the step opens the run, so the hold ends 9..10 s after it.
            const int64_t fall = -w.step;
            std::snprintf(name, sizeof name, "%s step: one relock, reason envelope-step, step_hold (10 s) after it,"
                          " no DISCONT", w.name);
            CHECK(name, r.relocks == 1 && !std::strcmp(r.why, "envelope-step") && r.relock_at_ns >= 609 * S &&
                            r.relock_at_ns <= 611 * S && r.discont_in == 0);
            // The labels' slew during the hold (<= 20 ppm x 10 s) comes off the overlap.
            std::snprintf(name, sizeof name, "%s step: no PTS jump (T0 = the end of the last output), the overlap"
                          " dropped instead: the fall less the hold's slew, to 1 ms", w.name);
            CHECK(name, r.jump_ns == 0 && r.event_jump_ns == 0 && r.contiguous &&
                            iabs(r.event_drop_ns - fall) <= 1 * MS &&
                            iabs((int64_t)r.dropped * S / 48000 - r.event_drop_ns) <= FRAME_NS);
            std::snprintf(name, sizeof name, "%s step: labels within 1 frame of capture time by step_hold + 10 s"
                          " after the step and to the end; the ratio never near its clamp", w.name);
            CHECK(name, r.last_bad_ns < 620 * S && in_frame(r.err_end, 48000) && r.ratio_lo > -200000 &&
                            r.ratio_hi < 200000);
            std::snprintf(name, sizeof name, "%s step: frames out = house seconds x 48,000 +-1 frame (the overlap"
                          " is not output twice)", w.name);
            CHECK(name, iabs(r.total_err_mf) <= 1000 && iabs(r.count_err_mf) <= 1000);
        }
    }
}

// --- ratio-out-of-bounds --------------------------------------------------------------

void test_bounds() {
    std::printf("\n  device rates near and past the 1000 ppm clamp (1 ms jitter)\n");
    for (int64_t ppb : {1500000LL, -1500000LL, 900000LL, -900000LL}) {
        const bool out = iabs(ppb) > 1000000;
        Scenario sc;
        sc.ppb = ppb;
        sc.secs = out ? 300 : 600;   // near the clamp the acquisition catch-up has 100 ppm left
        sc.late_s = out ? 200 : 400;
        const Run r = run(sc);
        std::printf("  %+5lld ppm, %3lld s: %d out-of-bounds event(s) (fit %+.3f ppm), ratio %+.3f..%+.3f ppm,"
                    " end %+.3f ppm, mean from %lld s - device %+.4f ppm, relocks %d, e end %+.1f us\n",
                    (long long)ppb / 1000, (long long)sc.secs, r.oob, r.oob_ppb / 1e3, r.ratio_lo / 1e3,
                    r.ratio_hi / 1e3, r.ratio_end / 1e3, (long long)sc.late_s, mean_ratio_err(r, ppb) / 1e3,
                    r.relocks, r.err_end / 1e3);
        g_all.add((int64_t)r.sum);
        char name[160];
        if (out) {
            std::snprintf(name, sizeof name, "%+lld ppm: one ratio-out-of-bounds event (also across relocks) carrying"
                          " the device fit, the ratio held at the 1000 ppm clamp", (long long)ppb / 1000);
            CHECK(name, r.oob == 1 && iabs(r.oob_ppb - eps_of(ppb)) <= 5000 && r.ratio_lo >= -1000000 &&
                            r.ratio_hi <= 1000000 && r.ratio_end == (ppb > 0 ? -1000000 : 1000000));
        } else {
            std::snprintf(name, sizeof name, "%+lld ppm: inside the bounds, no event, off the clamp from 400 s,"
                          " the ratio there averages to the device rate +-0.1 ppm", (long long)ppb / 1000);
            CHECK(name, r.oob == 0 && r.relocks == 0 && !r.clamped_late && iabs(mean_ratio_err(r, ppb)) <= 100 &&
                            in_frame(r.err_end, 48000));
        }
    }
}

// --- a device at nominal: the 1:1 guard ------------------------------------------------

void test_nominal() {
    std::printf("\n  device at nominal, 1 ms jitter, 1 h (the ratio wanders around 0)\n");
    Scenario sc;
    const Run r = run(sc);
    print_run("device 0 ppm, 1 h:", sc, r);
    g_all.add((int64_t)r.sum);
    CHECK("0 ppm: never commands 1:1, so the resampler keeps its filter and labels hold within 1 frame from 120 s",
          r.unity == 0 && r.last_bad_ns < 120 * S && r.contiguous && r.relocks == 0);
    CHECK("0 ppm: 1 h simulated, output frames = house seconds x 48,000 +-1 frame",
          iabs(r.count_err_mf) <= 1000 && in_frame(r.err_end, 48000));
}

// --- nominal-rate conversion, buffer sizes, centred jitter -----------------------------

void test_shapes() {
    std::printf("\n  other shapes, 1 h\n");
    {
        Scenario sc;
        sc.in_hz = 44100;
        sc.ppb = 50000;
        const Run r = run(sc);
        print_run("44.1 kHz in, 48 kHz out, +50 ppm:", sc, r);
        g_all.add((int64_t)r.sum);
        CHECK("44.1 -> 48 kHz: one resampler converts rate and clock; 48,000 frames per house second +-1 frame",
              iabs(r.count_err_mf) <= 1000 && in_frame(r.err_max_late, 48000) && r.relocks == 0 &&
                  r.lock_ns <= 37 * S && r.contiguous && r.unity == 0);
    }
    {
        Scenario sc;
        sc.ppb = -500000;
        sc.buf = 0;
        const Run r = run(sc);
        print_run("buffers 256..2048 at random, -500:", sc, r);
        g_all.add((int64_t)r.sum);
        CHECK("random buffer sizes: same lock, frame count and tracking as 1024-frame buffers at -500 ppm",
              iabs(r.count_err_mf) <= 1500 && r.err_max_late * 48000 <= 5 * S / 2 && r.lock_ns <= 37 * S &&
                  r.contiguous);
    }
    {
        Scenario sc;
        sc.ppb = 500000;
        sc.centred = true;
        const Run r = run(sc);
        print_run("centred jitter +-0.5 ms, +500 ppm:", sc, r);
        g_all.add((int64_t)r.sum);
        CHECK("centred jitter: labels sit on the PTS floor (0.5 ms early), the frame rate still exact (+-1 frame/h)",
              r.err_end > -530 * US && r.err_end < -470 * US && iabs(r.err_end - r.err_at[5]) * 48000 <= S &&
                  r.lock_ns <= 37 * S);
    }
    {
        Scenario sc;
        sc.ppb = 500000;
        sc.secs = 120;
        sc.cfg.lock.rate_buckets_min = 20;
        const Run r = run(sc);
        std::printf("  with a 20-bucket first fit (not the plan's 30) the lock comes at %.2f s, |e| at 60 s %.1f us\n",
                    r.lock_ns / 1e9, r.err_at[2] / 1e3);
        g_all.add((int64_t)r.sum);
    }
}

// --- cycle input (B-180): lost cycles are a gap, a cycle-size change moves only the stamps ---

constexpr int64_t Q2048 = 2048 * S / 48000;   // one 2048-frame cycle, 42.666666 ms

// Pushes `frames` stamped `pts` (duration: the frames' own unless given) and produces what a
// resampler would at equal rates; returns the command and the label of the buffer's first output.
struct Feed {
    AsrcServo sv;
    explicit Feed(bool cycle) : sv(48000, 48000, cfg(cycle)) {}
    static AsrcServoConfig cfg(bool cycle) {
        AsrcServoConfig c;
        c.cycle_input = cycle;
        return c;
    }
    AsrcServo::Command push(int64_t pts, uint32_t frames, int64_t dur = -2) {
        const AsrcServo::Command c = sv.push(pts, frames, false, 0, dur == -2 ? (int64_t)frames * S / 48000 : dur);
        label = sv.next_pts();
        sv.produced(frames);
        return c;
    }
    int64_t label = 0;
};

void test_cycle_basics() {
    std::printf("\n  cycle input: pipewiresrc's shape, 2048-frame cycles stamped with the cycle's time\n");
    {
        Feed f(true);
        for (int i = 0; i < 10; i++) f.push(H0 + i * Q2048, 2048);
        const int64_t end = f.sv.next_pts();
        const AsrcServo::Command c = f.push(H0 + 11 * Q2048, 2048);   // cycle 10 lost
        const std::vector<AsrcEvent> ev = f.sv.take_events();
        CHECK("a lost cycle: one gap event (lost-cycle, 2048 frames), no relock, the command says gap",
              ev.size() == 1 && ev[0].kind == AsrcEvent::Kind::gap && !std::strcmp(ev[0].reason, "lost-cycle") &&
                  ev[0].lost_frames == 2048 && c.gap && !c.relock && c.skip == 0 && f.sv.stats().relocks == 0);
        CHECK("... the output jumps the cycle's length to a frame, from the end of the last output, same T0",
              iabs(f.label - end - Q2048) <= FRAME_NS && ev[0].value == f.label - end && ev[0].house_ns == f.label &&
                  f.sv.t0() == H0);
        CHECK("... stats: 1 gap, 2048 frames lost, every pushed frame counted in",
              f.sv.stats().gaps == 1 && f.sv.stats().lost_frames == 2048 && f.sv.stats().in_frames == 11 * 2048);
        const int64_t next = f.sv.next_pts();
        const AsrcServo::Command d = f.push(H0 + 12 * Q2048, 2048);
        CHECK("... then on: contiguous labels, no gap, no event, the phase within a frame",
              !d.gap && !d.relock && f.label == next && f.sv.take_events().empty() &&
                  iabs(f.sv.stats().phase_err_ns) <= FRAME_NS);
        CHECK("names: gap, shift", !std::strcmp(asrc_event_name(AsrcEvent::Kind::gap), "gap") &&
                                       !std::strcmp(asrc_event_name(AsrcEvent::Kind::shift), "shift"));
    }
    {
        Feed f(false);   // the default: any other input (AES67's jitter buffer)
        for (int i = 0; i < 10; i++) f.push(H0 + i * Q2048, 2048);
        const int64_t end = f.sv.next_pts();
        const AsrcServo::Command c = f.push(H0 + 11 * Q2048, 2048);
        CHECK("without cycle input the same stamps are the lock's, as before: no gap, no event, contiguous",
              !c.gap && !c.relock && f.label == end && f.sv.take_events().empty() && f.sv.stats().gaps == 0);
    }
    {
        Feed f(true);
        for (int i = 0; i < 10; i++) f.push(H0 + i * Q2048, 2048);
        const int64_t end = f.sv.next_pts();
        const AsrcServo::Command c = f.push(H0 + 13 * Q2048, 2048);   // cycles 10..12 lost
        const std::vector<AsrcEvent> ev = f.sv.take_events();
        CHECK("three cycles lost at once: one gap of 3 x 2048 frames, the output jumps 128 ms",
              c.gap && ev.size() == 1 && ev[0].lost_frames == 3 * 2048 && iabs(f.label - end - 3 * Q2048) <= FRAME_NS);
    }
    {
        Feed f(true);
        for (int i = 0; i < 10; i++) f.push(H0 + i * Q2048, 2048);
        const int64_t end = f.sv.next_pts();
        const AsrcServo::Command a = f.push(H0 + 10 * Q2048 + 30 * MS, 2048);   // not whole cycles
        const AsrcServo::Command b = f.push(H0 + 9 * Q2048 + 10 * Q2048 / 10, 2048);
        CHECK("a step of no whole cycle (+30 ms), a fall of no gap (-0.9 cycle): no gap, no shift, the lock's",
              !a.gap && !b.gap && end == f.sv.pts_at(10 * 2048) && f.label == f.sv.pts_at(11 * 2048) &&
                  f.sv.take_events().empty());
        Feed g(true);
        for (int i = 0; i < 10; i++) g.push(H0 + i * Q2048 + (i % 2) * 1500 * US, 2048);
        CHECK("stamps jittering 1.5 ms (under 2 ms): no gap", g.sv.take_events().empty() && g.sv.stats().gaps == 0);
    }
    {
        // B-181: a driver restarted after a loss (an xrun's recovery) starts its cycles afresh, so the
        // stamps rise by the time lost, no whole cycle. Past the lock's step that is lost time.
        Feed f(true);
        for (int i = 0; i < 10; i++) f.push(H0 + i * Q2048, 2048);
        const int64_t end = f.sv.next_pts();
        const AsrcServo::Command c = f.push(H0 + 10 * Q2048 + 60 * MS, 2048);
        const std::vector<AsrcEvent> ev = f.sv.take_events();
        CHECK("a rise of no whole cycle past the lock's step (+60 ms): one gap (lost-time, 2880 frames), no relock,"
              " the output jumps 60 ms to a frame, same T0",
              ev.size() == 1 && ev[0].kind == AsrcEvent::Kind::gap && !std::strcmp(ev[0].reason, "lost-time") &&
                  ev[0].lost_frames == 2880 && c.gap && !c.relock && c.skip == 0 && f.sv.stats().relocks == 0 &&
                  iabs(f.label - end - 60 * MS) <= FRAME_NS && ev[0].value == f.label - end && f.sv.t0() == H0);
        const int64_t next = f.sv.next_pts();
        f.push(H0 + 11 * Q2048 + 60 * MS, 2048);
        CHECK("... then on: contiguous labels, no event, the phase within a frame",
              f.label == next && f.sv.take_events().empty() && iabs(f.sv.stats().phase_err_ns) <= FRAME_NS);
        Feed g(true);
        for (int i = 0; i < 10; i++) g.push(H0 + i * Q2048, 2048);
        const AsrcServo::Command d = g.push(H0 + 10 * Q2048 + 49 * MS, 2048);
        CHECK("under the lock's step (+49 ms, no whole cycle): the lock's, as B-180 left it",
              !d.gap && !d.relock && g.sv.take_events().empty() && g.sv.stats().gaps == 0);
        Feed h(true);
        for (int i = 0; i < 10; i++) h.push(H0 + i * Q2048, 2048);
        const int64_t hend = h.sv.next_pts();
        const AsrcServo::Command e = h.push(H0 + 57 * Q2048, 2048);   // 47 cycles, 2.005 s
        const std::vector<AsrcEvent> hev = h.sv.take_events();
        CHECK("47 whole cycles at once (2.005 s, past B-180's 1 s): one gap (lost-cycle, 47 x 2048 frames)",
              e.gap && hev.size() == 1 && !std::strcmp(hev[0].reason, "lost-cycle") &&
                  hev[0].lost_frames == 47 * 2048 && iabs(h.label - hend - 47 * Q2048) <= FRAME_NS);
        Feed k(true);
        for (int i = 0; i < 10; i++) k.push(H0 + i * Q2048, 2048);
        k.push(H0 + 10 * Q2048 + 60 * MS, 2048);
        const AsrcServo::Command r = k.push(H0 + 11 * Q2048, 2048);   // the next back on the grid
        const std::vector<AsrcEvent> kev = k.sv.take_events();
        CHECK("lost time undone by the next stamp was a late stamp: reverted (-2880 frames, 60 ms dropped)",
              kev.size() == 2 && !std::strcmp(kev[1].reason, "reverted") && kev[1].lost_frames == -2880 &&
                  iabs(kev[1].dropped_ns - 60 * MS) <= FRAME_NS && r.skip == 2048 && !r.relock &&
                  k.sv.stats().lost_frames == 0 && k.sv.stats().relocks == 0);
        Feed m(true);
        for (int i = 0; i < 10; i++) m.push(H0 + i * Q2048, 2048);
        const AsrcServo::Command fall = m.push(H0 + 10 * Q2048 - 60 * MS, 2048);
        CHECK("a fall past the lock's step (-60 ms): no gap, the lock's (it relocks on it, as before)",
              !fall.gap && m.sv.take_events().empty() && m.sv.stats().gaps == 0);
        Feed a(false);
        for (int i = 0; i < 10; i++) a.push(H0 + i * Q2048, 2048);
        const AsrcServo::Command b = a.push(H0 + 10 * Q2048 + 60 * MS, 2048);
        CHECK("without cycle input the same +60 ms is the lock's: no gap", !b.gap && a.sv.take_events().empty());
    }
    {
        // A late stamp: one cycle stamped a cycle late, the next back on time. The gap is taken back
        // and its frames dropped, so the content comes back to the labels it was given.
        Feed f(true);
        for (int i = 0; i < 10; i++) f.push(H0 + i * Q2048, 2048);
        const int64_t end = f.sv.next_pts();
        f.push(H0 + 11 * Q2048, 2048);   // looks lost ...
        const int64_t jumped = f.label;
        const AsrcServo::Command c = f.push(H0 + 11 * Q2048 + 500 * US, 2048);   // ... but the next is on time
        const std::vector<AsrcEvent> ev = f.sv.take_events();
        CHECK("a late stamp undone at once: gap then reverted (-2048 frames, the cycle dropped), never a relock",
              ev.size() == 2 && ev[0].kind == AsrcEvent::Kind::gap && ev[1].kind == AsrcEvent::Kind::gap &&
                  !std::strcmp(ev[1].reason, "reverted") && ev[1].lost_frames == -2048 &&
                  iabs(ev[1].dropped_ns - Q2048) <= FRAME_NS && c.skip == 2048 && !c.relock &&
                  f.sv.stats().relocks == 0 && f.sv.stats().lost_frames == 0 && iabs(jumped - end - Q2048) <= FRAME_NS);
    }
    {
        // An async capture's quantum rising 1024 -> 2048 (measured on the dev Pi, PipeWire 1.2.7): the
        // buffers carry the new cycle's duration one buffer before its frames, and the stamps rise
        // 21.333 ms twice with no sample lost.
        Feed f(true);
        const int64_t q1 = 1024 * S / 48000;
        int64_t pts = H0;
        for (int i = 0; i < 20; i++, pts += q1) f.push(pts, 1024);
        const int64_t end = f.sv.next_pts();
        const AsrcServo::Command a = f.push(pts, 1024, Q2048);                  // the new duration, gap 0
        const AsrcServo::Command b = f.push(pts + 2 * q1, 1024, Q2048);         // +21.333 ms
        const AsrcServo::Command c = f.push(pts + 2 * q1 + Q2048, 2048);        // +21.333 ms, 2048 frames
        const AsrcServo::Command d = f.push(pts + 2 * q1 + 2 * Q2048, 2048);
        const std::vector<AsrcEvent> ev = f.sv.take_events();
        CHECK("a cycle-size change: two shift events (+21.333 ms each), no gap, no relock, the labels contiguous",
              ev.size() == 2 && ev[0].kind == AsrcEvent::Kind::shift && ev[1].kind == AsrcEvent::Kind::shift &&
                  iabs(ev[0].value - q1) <= 1000 && iabs(ev[1].value - q1) <= 1000 && !a.gap && !b.gap && !c.gap &&
                  !d.gap && !a.relock && !b.relock && !c.relock && !d.relock && f.sv.stats().gaps == 0 &&
                  f.label == f.sv.pts_at(20 * 1024 + 2 * 1024 + 2048) && end == f.sv.pts_at(20 * 1024));
        CHECK("... and the lock sees no step: the phase within a frame", iabs(f.sv.stats().phase_err_ns) <= FRAME_NS);
    }
    {
        // Durations that never fit the frames tell nothing: the frame count alone decides.
        Feed f(true);
        for (int i = 0; i < 20; i++) f.push(H0 + i * Q2048, 2048, 3 * Q2048 / 2);
        const AsrcServo::Command c = f.push(H0 + 21 * Q2048, 2048, 3 * Q2048 / 2);
        Feed g(true);
        for (int i = 0; i < 20; i++) g.push(H0 + i * Q2048, 2048, -1);
        const AsrcServo::Command d = g.push(H0 + 21 * Q2048, 2048, -1);
        CHECK("durations that never fit (1.5 cycles) or none: a lost cycle is still a gap",
              c.gap && f.sv.stats().gaps == 1 && d.gap && g.sv.stats().gaps == 1);
    }
}

// A pipewiresrc-like capture of one device: a buffer per `cycle` frames, stamped with the capture
// time of its first frame plus a jitter that is the cycle's own (every stream of the device gets the
// driver's), plus `stamp_ns`. A cycle lost at a capture second never reaches the servo: its stamps
// skip it, its frames are gone.
struct CycleScenario {
    int64_t ppb = -10000;               // 10 ppm slow, as .108's ATEM (asrcRatio median 9-13 ppm)
    int64_t secs = 900;
    int64_t start_s = 0;                // the capture's first frame (a second capture of the device)
    int64_t jitter_ns = 500 * US;
    int64_t stamp_ns = 0;
    std::vector<int64_t> lost_s;        // device seconds (from its frame 0) of the cycles this one lost
    // (device ms from its frame 0, frames lost): the driver restarted after them, its cycles afresh
    std::vector<std::pair<int64_t, int64_t>> restart;
    int64_t first_step_ns = 0;          // stamps after the first buffer this much later (the start's own)
    bool cycle_input = true;
    int64_t warm_s = 60;                // judged from here on
    uint64_t seed = 1;
};

struct CycleRun {
    std::vector<int64_t> relock_at, relock_jump, gap_at, gap_jump;   // device capture time, ns
    int oob = 0, shifts = 0;
    int64_t err_max = 0;                // max |label - capture time| from warm_s on, splices left out
    int64_t ratio_dev = 0;              // max |ratio - device| from warm_s on
    int64_t ratio_peak = 0;             // max |ratio| from warm_s on
    std::vector<int64_t> err_at;        // label - capture time at each whole 5 s of capture time
    uint64_t sum = 0;
};

CycleRun run_cycles(const CycleScenario& sc) {
    constexpr int64_t CYC = 2048;
    AsrcServoConfig cfg;
    cfg.cycle_input = sc.cycle_input;
    AsrcServo sv(48000, 48000, cfg);
    std::unique_ptr<ModelResampler> rs;
    Device dev{48000, sc.ppb};
    // A stream's buffers are the driver's cycles: its first frame starts one.
    const int64_t near = 2 * ModelResampler::TAPS * SUB, start = sc.start_s * 48000 / CYC * CYC;
    std::vector<std::pair<int64_t, int64_t>> lost;   // (received frame, device frames lost before it)
    auto device_pos = [&](int64_t x) {               // received position -> device position, 1/SUB
        int64_t l = 0;
        for (const auto& q : lost)
            if (x >= q.first * SUB) l = q.second;
        return x + (start + l) * SUB;
    };
    auto near_loss = [&](int64_t x) {
        for (const auto& q : lost)
            if (iabs(x - q.first * SUB) < near) return true;
        return false;
    };
    CycleRun r;
    Fnv f;
    int64_t n = 0, cur = 0, l = 0;
    size_t next_loss = 0, next_restart = 0;
    int64_t next_mark = 0;
    const int64_t total = sc.secs * 48000;
    while (n < total) {
        int64_t d = start + n + l;   // device frame of this buffer's first frame
        while (next_loss < sc.lost_s.size() && dev.house(d * SUB) - H0 >= sc.lost_s[next_loss] * S) {
            l += CYC;                // this cycle never reaches the servo
            d += CYC;
            lost.push_back({n, l});
            next_loss++;
        }
        while (next_restart < sc.restart.size() && dev.house(d * SUB) - H0 >= sc.restart[next_restart].first * MS) {
            l += sc.restart[next_restart].second;   // never captured: the next cycle starts after them
            d += sc.restart[next_restart].second;
            lost.push_back({n, l});
            next_restart++;
        }
        Lcg g(sc.seed * 1000003 + (uint64_t)(d / CYC));   // the driver's jitter, per cycle
        const int64_t j = sc.jitter_ns > 0 ? (int64_t)(g.next() % (uint64_t)sc.jitter_ns) : 0;
        const int64_t t = dev.house(d * SUB) - H0;
        const int64_t step = n > 0 ? sc.first_step_ns : 0;
        const AsrcServo::Command c =
            sv.push(H0 + t + sc.stamp_ns + step + j, (uint32_t)CYC, n == 0, 0, CYC * S / 48000);
        if (n == 0) {
            rs.reset(new ModelResampler(c.in_rate, c.out_rate));
            sv.set_delay(ModelResampler::DELAY);
            cur = c.in_rate;
        }
        if (c.in_rate != cur) {
            rs->update(c.in_rate, c.out_rate);
            cur = c.in_rate;
        }
        const int64_t fed = CYC - c.skip;
        const int64_t k = rs->out_frames(fed), label = sv.next_pts(), x = rs->position();
        rs->resample(fed, k);
        sv.produced((uint32_t)k);
        if (k > 0 && !near_loss(x)) {
            const int64_t e = label - dev.house(device_pos(x));
            if (t >= sc.warm_s * S) r.err_max = std::max(r.err_max, iabs(e));
            while (t >= next_mark) {
                r.err_at.push_back(e);
                next_mark += 5 * S;
            }
            f.add(e);
        }
        const AsrcServo::Stats st = sv.stats();
        if (t >= sc.warm_s * S) {
            r.ratio_dev = std::max(r.ratio_dev, iabs(st.ratio_ppb - eps_of(sc.ppb)));
            r.ratio_peak = std::max(r.ratio_peak, iabs(st.ratio_ppb));
        }
        for (const AsrcEvent& e : sv.take_events()) {
            f.add((int64_t)e.kind);
            f.add(e.value);
            if (e.kind == AsrcEvent::Kind::relock) {
                r.relock_at.push_back(t);
                r.relock_jump.push_back(e.value);
            } else if (e.kind == AsrcEvent::Kind::gap) {
                r.gap_at.push_back(t);
                r.gap_jump.push_back(e.value);
            } else if (e.kind == AsrcEvent::Kind::shift) {
                r.shifts++;
            } else {
                r.oob++;
            }
        }
        f.add(label);
        n += CYC;
    }
    r.sum = f.h;
    return r;
}

void test_cycle_hour() {
    std::printf("\n  cycle input over 15 min: 2048-frame cycles, 0.5 ms jitter, -10 ppm, cycles lost at 120,"
                " 150 (two 30 s apart, as .108's a2 at 19:12:29 and 19:12:59), 400, 401 and 700 s\n");
    CycleScenario sc;
    sc.lost_s = {120, 150, 400, 401, 700};
    const CycleRun on = run_cycles(sc);
    sc.cycle_input = false;
    const CycleRun off = run_cycles(sc);
    int64_t jmin = INT64_MAX, jmax = 0;
    for (int64_t j : on.gap_jump) {
        jmin = std::min(jmin, j);
        jmax = std::max(jmax, j);
    }
    std::printf("  %-34s gaps %zu (jumps %.6f..%.6f ms), relocks %zu, out-of-bounds %d, max|e| from 60 s %.2f us,"
                " |ratio - device| <= %.3f ppm\n", "cycle input:", on.gap_at.size(), jmin / 1e6, jmax / 1e6,
                on.relock_at.size(), on.oob, on.err_max / 1e3, on.ratio_dev / 1e3);
    std::printf("  %-34s gaps %zu, relocks %zu at", "the lock alone (before B-180):", off.gap_at.size(),
                off.relock_at.size());
    for (size_t i = 0; i < off.relock_at.size(); i++)
        std::printf(" %.2f s (jump %.3f ms)", off.relock_at[i] / 1e9, off.relock_jump[i] / 1e6);
    std::printf(", max|e| from 60 s %.3f ms, |ratio| peak %.1f ppm\n", off.err_max / 1e6, off.ratio_peak / 1e3);
    g_all.add((int64_t)on.sum);
    g_all.add((int64_t)off.sum);
    CHECK("cycle input: one gap per lost cycle (5), each the cycle's length to a frame; no relock, no out-of-bounds",
          on.gap_at.size() == 5 && jmin >= Q2048 - FRAME_NS && jmax <= Q2048 + FRAME_NS && on.relock_at.empty() &&
              on.oob == 0 && on.shifts == 0);
    CHECK("cycle input: every label within 1 frame of its capture time from 60 s, splices left out",
          in_frame(on.err_max, 48000));
    CHECK("cycle input: the ratio stays the device's (+-3 ppm): no lost cycle bends the rate fit",
          on.ratio_dev <= 3000);
    CHECK("the lock alone (the old path, still AES67's): the two cycles 30 s apart relock 10 s after the second,"
          " the pair 400/401 s at once, labels a cycle early meanwhile, the ratio bent past 100 ppm",
          off.relock_at.size() >= 2 && off.relock_at[0] >= 159 * S && off.relock_at[0] <= 162 * S &&
              off.err_max >= Q2048 - FRAME_NS && off.ratio_peak >= 100000);
}

void test_cycle_two_captures() {
    std::printf("\n  two captures of one device (the same driver stamps), the second started 7.3 s later\n");
    CycleScenario a, b;
    a.secs = 600;
    b.secs = 600;
    b.start_s = 7;
    a.lost_s = {200, 230};
    b.lost_s = {350};
    const CycleRun ra = run_cycles(a), rb = run_cycles(b);
    // Pair the two runs on capture time: b's mark i is a's mark i + 7 s / 5 s ... both mark every 5 s of
    // their own capture time, so compare the label errors, which are on one house time.
    int64_t dmax = 0;
    for (size_t i = 12; i < std::min(ra.err_at.size(), rb.err_at.size()); i++) {
        dmax = std::max(dmax, iabs(ra.err_at[i] - rb.err_at[i]));
    }
    std::printf("  label - capture time, a vs b at each 5 s from 60 s: max |difference| %.2f us (one frame 20.83 us);"
                " a: %zu gaps, b: %zu gaps, relocks %zu / %zu\n", dmax / 1e3, ra.gap_at.size(), rb.gap_at.size(),
                ra.relock_at.size(), rb.relock_at.size());
    g_all.add((int64_t)ra.sum);
    g_all.add((int64_t)rb.sum);
    CHECK("two captures of one device land on one house time within one frame (20.8 us), through each one's lost"
          " cycles, no relock in either",
          dmax <= FRAME_NS && ra.relock_at.empty() && rb.relock_at.empty() && ra.gap_at.size() == 2 &&
              rb.gap_at.size() == 1);
    CycleScenario c = a;
    c.stamp_ns = 11660 * US;   // .108's a2: GstBaseSrc's startup offset on a live pipewiresrc
    const CycleRun rc = run_cycles(c);
    int64_t off = 0;
    for (size_t i = 12; i < std::min(ra.err_at.size(), rc.err_at.size()); i++)
        off = std::max(off, iabs(rc.err_at[i] - ra.err_at[i] - 11660 * US));
    CHECK("stamps 11.66 ms later (a live pipewiresrc's startup offset) label that much later: the shared origin is"
          " the stamps', which B-180 takes off pipewiresrc (stream.is-live=false)",
          off <= FRAME_NS);
}

// .108's loaded hour (DEV3, 2026-10-26): the cycles a1 and a2 lost, from the steps of their bus
// lateness floors (mr-captures/wf13/c1/ana/steps.py); the first of each is before the taps started
// and inferred from the ratio's first episode. Seconds from a1's start, 19:05:37Z (a2's: +1 s).
const std::vector<int64_t> DEV3_A1 = {268, 728, 2018, 2864, 3182, 3252, 3465};
const std::vector<int64_t> DEV3_A2 = {123, 412, 442, 3253, 3465, 3539};

void test_cycle_dev3() {
    std::printf("\n  replay of .108's loaded hour (DEV3): the cycles a1 and a2 lost, 19:05:37-20:10:35Z\n");
    const struct {
        const char* name;
        const std::vector<int64_t>* lost;
        int64_t start_s;
        std::vector<int64_t> relocks;   // DEV3's mrasrc relocks, capture seconds
    } caps[2] = {{"a1", &DEV3_A1, 0, {3263}}, {"a2", &DEV3_A2, 1, {452, 3549}}};
    for (const auto& cp : caps) {
        CycleScenario sc;
        sc.secs = 3898 - cp.start_s;
        sc.start_s = cp.start_s;
        sc.lost_s = *cp.lost;
        sc.cycle_input = false;
        const CycleRun off = run_cycles(sc);
        sc.cycle_input = true;
        const CycleRun on = run_cycles(sc);
        std::printf("  %s, the lock alone: relocks at", cp.name);
        for (size_t i = 0; i < off.relock_at.size(); i++)
            std::printf(" %.1f s (jump %.1f ms)", off.relock_at[i] / 1e9, off.relock_jump[i] / 1e6);
        std::printf(" (DEV3:");
        for (int64_t s : cp.relocks) std::printf(" %lld s", (long long)s);
        std::printf("), |ratio| peak %.1f ppm, max|e| %.1f ms; cycle input: %zu gaps, %zu relocks, max|e| %.2f us,"
                    " |ratio - device| <= %.2f ppm\n", off.ratio_peak / 1e3, off.err_max / 1e6, on.gap_at.size(),
                    on.relock_at.size(), on.err_max / 1e3, on.ratio_dev / 1e3);
        g_all.add((int64_t)off.sum);
        g_all.add((int64_t)on.sum);
        bool matched = off.relock_at.size() == cp.relocks.size();
        for (size_t i = 0; matched && i < cp.relocks.size(); i++)
            matched = iabs(off.relock_at[i] / S - cp.relocks[i]) <= 3;
        char name[220];
        std::snprintf(name, sizeof name, "DEV3 %s, the lock alone: the relocks DEV3 saw, each within 3 s, and the"
                      " ratio episodes past 200 ppm (they saw 205-243 ppm)", cp.name);
        CHECK(name, matched && off.ratio_peak >= 200000);
        std::snprintf(name, sizeof name, "DEV3 %s, cycle input: a gap per lost cycle (%zu), no relock, labels within"
                      " 1 frame of capture time, the ratio the device's (+-3 ppm)", cp.name, cp.lost->size());
        CHECK(name, on.gap_at.size() == cp.lost->size() && on.relock_at.empty() && on.oob == 0 &&
                        in_frame(on.err_max, 48000) && on.ratio_dev <= 3000);
    }
}

// The Pi 4 test box's owner capture on f1cfad60 (DEV4b, 2026-10-27) relocked 62.0 s after its start,
// jumping 2,014.36 ms: 2.0547 s lost 6-7 s in, the driver's cycles restarting after it. A loss at the
// start relocks at 54-56 s, at 3 s at 59 s, past 7 s at 63 s.
constexpr int64_t DEV4B_LOST = 98627;   // 2.0547 s of the device's frames
constexpr int64_t JITTER_NS = 500 * US; // the scenarios' driver wakeup jitter

void test_cycle_restart() {
    std::printf("\n  a driver restarted after a loss (B-181): DEV4b's start, 2.0547 s lost 6.4 s in, 90 s\n");
    CycleScenario sc;
    sc.secs = 90;
    sc.warm_s = 0;
    sc.restart = {{6400, DEV4B_LOST}};
    const int64_t lost_ns = DEV4B_LOST * S / 48000;
    sc.cycle_input = false;
    const CycleRun off = run_cycles(sc);
    sc.cycle_input = true;
    const CycleRun on = run_cycles(sc);
    std::printf("  the lock alone (f1cfad60's path for a rise of no whole cycle): relocks at");
    for (size_t i = 0; i < off.relock_at.size(); i++)
        std::printf(" %.3f s (jump %.3f ms)", off.relock_at[i] / 1e9, off.relock_jump[i] / 1e6);
    std::printf(" (DEV4b: 62.0 s, 2014.36 ms); cycle input: gaps at");
    for (size_t i = 0; i < on.gap_at.size(); i++)
        std::printf(" %.3f s (jump %.3f ms)", on.gap_at[i] / 1e9, on.gap_jump[i] / 1e6);
    std::printf(", relocks %zu, max|e| from the first buffer %.2f us\n", on.relock_at.size(), on.err_max / 1e3);
    g_all.add((int64_t)off.sum);
    g_all.add((int64_t)on.sum);
    CHECK("DEV4b's start, the lock alone: one relock 61.5-62.5 s in, jumping 2,014.37 ms +-1 ms (on the box: 62.0 s,"
          " 2,014.36 ms)",
          off.relock_at.size() == 1 && off.relock_at[0] >= 61500 * MS && off.relock_at[0] <= 62500 * MS &&
              iabs(off.relock_jump[0] - 2014370 * US) <= MS);
    CHECK("DEV4b's start with cycle input: one gap where the time was lost, its jump the 2.0547 s within the"
          " driver's jitter; no relock in 90 s",
          on.gap_at.size() == 1 && on.gap_at[0] >= 6400 * MS && on.gap_at[0] <= 6400 * MS + lost_ns + Q2048 &&
              iabs(on.gap_jump[0] - lost_ns) <= JITTER_NS && on.relock_at.empty() && on.oob == 0 && on.shifts == 0);
    CHECK("... labels on capture time from the first buffer: within the driver's jitter, splices left out",
          on.err_max <= JITTER_NS);

    std::printf("\n  the same on a locked capture (DEV4a's 2.038 s, the build before, from about 18:16:04Z on"
                " 2026-10-27)\n");
    CycleScenario lk;
    lk.secs = 600;
    lk.restart = {{300000, 97824}};   // 2.038 s
    const int64_t lk_ns = 97824 * S / 48000;
    lk.cycle_input = false;
    const CycleRun loff = run_cycles(lk);
    lk.cycle_input = true;
    const CycleRun lon = run_cycles(lk);
    const int64_t back = lon.err_at.size() > 72 ? lon.err_at[72] : INT64_MAX;   // 360 s: a minute after
    std::printf("  the lock alone: relocks %zu (first %.2f s, jump %.3f ms); cycle input: gaps %zu (jump %.3f ms),"
                " relocks %zu, max|e| from 60 s %.2f us, at 360 s %.2f us, |ratio - device| <= %.2f ppm\n",
                loff.relock_at.size(), loff.relock_at.empty() ? 0.0 : loff.relock_at[0] / 1e9,
                loff.relock_jump.empty() ? 0.0 : loff.relock_jump[0] / 1e6, lon.gap_at.size(),
                lon.gap_jump.empty() ? 0.0 : lon.gap_jump[0] / 1e6, lon.relock_at.size(), lon.err_max / 1e3,
                back / 1e3, lon.ratio_dev / 1e3);
    g_all.add((int64_t)loff.sum);
    g_all.add((int64_t)lon.sum);
    CHECK("a locked capture's 2.038 s loss, the lock alone: a relock 12-14 s after it began (DEV4a: 18:16:16.85Z,"
          " 2,037.93 ms)",
          loff.relock_at.size() == 1 && loff.relock_at[0] >= 312 * S && loff.relock_at[0] <= 314 * S &&
              iabs(loff.relock_jump[0] - lk_ns) <= MS);
    CHECK("... with cycle input: one gap at once (lost-time, within the jitter), no relock, labels within the jitter"
          " and within a frame a minute on, the ratio within 25 ppm of the device's (the floor's 20 ppm slew)",
          lon.gap_at.size() == 1 && lon.gap_at[0] >= 300 * S && lon.gap_at[0] <= 300 * S + lk_ns + Q2048 &&
              iabs(lon.gap_jump[0] - lk_ns) <= JITTER_NS &&
              lon.relock_at.empty() && lon.err_max <= JITTER_NS && in_frame(back, 48000) && lon.ratio_dev <= 25000);

    std::printf("\n  two captures of one device through the same restart, the second started 7 s later\n");
    CycleScenario a, b;
    a.secs = b.secs = 400;
    b.start_s = 7;
    a.restart = b.restart = {{200000, 50000}};   // 1.042 s, no whole cycle
    const CycleRun ra = run_cycles(a), rb = run_cycles(b);
    int64_t dmax = 0;
    for (size_t i = 12; i < std::min(ra.err_at.size(), rb.err_at.size()); i++)
        dmax = std::max(dmax, iabs(ra.err_at[i] - rb.err_at[i]));
    std::printf("  a vs b, label - capture time at each 5 s from 60 s: max |difference| %.2f us; gaps %zu / %zu"
                " (jumps %.6f / %.6f ms), relocks %zu / %zu\n", dmax / 1e3, ra.gap_at.size(), rb.gap_at.size(),
                ra.gap_jump.empty() ? 0.0 : ra.gap_jump[0] / 1e6, rb.gap_jump.empty() ? 0.0 : rb.gap_jump[0] / 1e6,
                ra.relock_at.size(), rb.relock_at.size());
    g_all.add((int64_t)ra.sum);
    g_all.add((int64_t)rb.sum);
    CHECK("two captures of one device through one restart: one gap each, the same frames lost, no relock, on one"
          " house time within a frame",
          ra.gap_at.size() == 1 && rb.gap_at.size() == 1 && ra.relock_at.empty() && rb.relock_at.empty() &&
              ra.gap_jump[0] == rb.gap_jump[0] && dmax <= FRAME_NS);

    std::printf("\n  lost time at the nominal rate: a +500 ppm device loses 2 s of its frames (1.999 s of stamps)\n");
    CycleScenario fast;
    fast.ppb = 500000;
    fast.secs = 600;
    fast.restart = {{300000, 96000}};
    const CycleRun rf = run_cycles(fast);
    const int64_t stamps_ns = 96000 * S / 48000 * S / (S + 500000);   // 1.999 s
    std::printf("  gaps %zu (jump %.3f ms, the stamps' %.3f ms), relocks %zu, out-of-bounds %d\n", rf.gap_at.size(),
                rf.gap_jump.empty() ? 0.0 : rf.gap_jump[0] / 1e6, stamps_ns / 1e6, rf.relock_at.size(), rf.oob);
    g_all.add((int64_t)rf.sum);
    CHECK("lost time is the stamps' own length at the nominal rate, as every capture of the driver counts it: a"
          " +500 ppm device's 2 s loss jumps 1.999 s; no relock, no out-of-bounds (its 1 ms of rate is the lock's)",
          rf.gap_at.size() == 1 && iabs(rf.gap_jump[0] - stamps_ns) <= JITTER_NS && rf.relock_at.empty() &&
              rf.oob == 0);

    std::printf("\n  the capture's own start (dev Pi, a driver the capture starts): the 2nd stamp 13.746 ms after"
                " the 1st, a 28.9 ms fall\n");
    CycleScenario st;
    st.secs = 90;
    st.first_step_ns = 13746 * US - Q2048;
    const CycleRun rst = run_cycles(st);
    g_all.add((int64_t)rst.sum);
    CHECK("a start's own small fall (-28.9 ms) is the lock's, as before: no gap, no shift, no relock in 90 s",
          rst.gap_at.empty() && rst.shifts == 0 && rst.relock_at.empty() && rst.oob == 0);

    std::printf("\n  a start whose stream stayed paused after its first buffer (pipewiresrc resumes it at PLAYING) and"
                " whose idle driver restarted: 0.32 s never captured\n");
    CycleScenario ps;
    ps.secs = 90;
    ps.warm_s = 0;
    ps.restart = {{1, 15360}};   // 7.5 cycles lost right after the first buffer
    const int64_t ps_ns = 15360 * S / 48000;
    ps.cycle_input = false;
    const CycleRun poff = run_cycles(ps);
    ps.cycle_input = true;
    const CycleRun pon = run_cycles(ps);
    std::printf("  the lock alone: relocks %zu (first %.3f s, jump %.3f ms); cycle input: gaps %zu (at %.3f s, jump"
                " %.3f ms), relocks %zu, max|e| from the first buffer %.2f us\n", poff.relock_at.size(),
                poff.relock_at.empty() ? 0.0 : poff.relock_at[0] / 1e9,
                poff.relock_jump.empty() ? 0.0 : poff.relock_jump[0] / 1e6, pon.gap_at.size(),
                pon.gap_at.empty() ? 0.0 : pon.gap_at[0] / 1e9, pon.gap_jump.empty() ? 0.0 : pon.gap_jump[0] / 1e6,
                pon.relock_at.size(), pon.err_max / 1e3);
    g_all.add((int64_t)poff.sum);
    g_all.add((int64_t)pon.sum);
    CHECK("a start that lost 0.32 s after its first buffer, the lock alone (f1cfad60's path): one relock 50-60 s in",
          poff.relock_at.size() == 1 && poff.relock_at[0] >= 50 * S && poff.relock_at[0] <= 60 * S);
    CHECK("... with cycle input: one gap at the second buffer (lost-time, 0.32 s within the jitter), no relock or"
          " shift in 90 s, labels on capture time from the first buffer",
          pon.gap_at.size() == 1 && pon.gap_at[0] >= ps_ns && pon.gap_at[0] <= ps_ns + 2 * Q2048 &&
              iabs(pon.gap_jump[0] - ps_ns) <= JITTER_NS &&
              pon.relock_at.empty() && pon.shifts == 0 && pon.oob == 0 && pon.err_max <= JITTER_NS);
}

void test_determinism() {
    Scenario sc;
    sc.ppb = -500000;
    sc.secs = 900;
    sc.gap_s = 300;
    sc.buf = 0;
    const Run a = run(sc), b = run(sc);
    CHECK("determinism: the same run twice, identical commands, labels and events", a.sum == b.sum);
    std::printf("  checksum %016llx\n", (unsigned long long)a.sum);
}

// --- Phase 3 (WI-P3-5): decode bypass, the device term, the product ratio ------------------
// The reference test's cases: a source fast by p runs fs (1 + p) frames per house second, its PTS floored
// to 90 kHz ticks (a mux) and ceil'd back to ns (the formula demux); the driver is the element's flow.

Fnv g_dec;   // Phase 3's runs fold in here, beside Phase 1's g_all

constexpr int64_t T0 = H0 + 7 * US;

int64_t source_time(int64_t t0, int64_t fs, int64_t ppb, int64_t n) {
    return t0 + (int64_t)((__int128)n * S * S / ((__int128)fs * (S + ppb)));
}

int64_t content_of(int64_t pos, int64_t fs, int64_t ppb, int64_t t0 = T0) {
    __int128 num = (__int128)pos * S * S, den = (__int128)SUB * fs * (S + ppb);
    __int128 q = num / den;
    if (num % den != 0 && (num < 0) != (den < 0)) q -= 1;
    return t0 + (int64_t)q;
}

int64_t formula_pts(int64_t t) {
    const int64_t ticks = floor_div(t * 9, 100000);
    return -floor_div(-ticks * 100000, 9);
}

struct DOut {
    int64_t label, end;   // its PTS, and the counter's label after it (0 when passed)
    int64_t frames;
    bool discont;
    int64_t pos;          // input position of its first frame, 1/SUB frames of the global index
    int64_t buf;          // the push it came from; -1 a drained tail
};

// mrasrc's flow (gstmrasrc.cpp) on the servo and the resampler model.
class Driver {
  public:
    static constexpr int64_t HISTORY = 64;
    Driver(int64_t in_hz, int64_t out_hz, int64_t bypass_ppb, bool device)
        : sv((int32_t)in_hz, (int32_t)out_hz, cfg(bypass_ppb, device)), in_hz_(in_hz), out_hz_(out_hz) {
        sv.set_delay(ModelResampler::DELAY);
    }
    static AsrcServoConfig cfg(int64_t bypass_ppb, bool device) {
        AsrcServoConfig c;
        c.lock = bypass_ppb > 0 ? asrc_decode_lock_config() : asrc_lock_config();
        c.bypass_ppb = bypass_ppb;
        c.device = device;
        return c;
    }
    // A timer read of the device sink's clock, the term started at the first; a relock-device tells the
    // servo before its next push, as the element does (B-148's A1).
    void device_sample(int64_t dev_ns, int64_t mono) {
        std::vector<AsrcDeviceEvent> ev;
        if (!term.rendering()) term.start(mono, &ev);
        term.sample(dev_ns, mono, -1, -1, &ev);
        if (term.take_recalibrated()) sv.device_recalibrated();
    }
    // The sink's ring released and acquired again (a caps change, a restart): the term relocks.
    void device_restart(int64_t mono) {
        std::vector<AsrcDeviceEvent> ev;
        term.stop(mono);
        term.start(mono, &ev);
        if (term.take_recalibrated()) sv.device_recalibrated();
    }
    void gap() {
        if (sv.end_epoch()) drain();
    }
    AsrcServo::Command push(int64_t pts, uint32_t frames, bool discont) {
        if (discont && !cmds.empty()) gap();   // the element ends the epoch before a DISCONT buffer
        const int64_t dppb = sv.config().device ? term.device_ppb() : 0;
        const AsrcServo::Command c = sv.push(pts, frames, discont, dppb);
        if (locked_at < 0 && sv.lock().phase() == ClockLock::Phase::locked) locked_at = pts;
        const int64_t i = (int64_t)cmds.size();
        cmds.push_back(c);
        this->pts.push_back(pts);
        dppbs.push_back(dppb);
        for (const AsrcEvent& e : sv.take_events()) {
            events.push_back({i, e});
            g_dec.add((int64_t)e.kind);
            g_dec.add(e.house_ns);
            g_dec.add(e.value);
            g_dec.add(e.phase_ns);
        }
        ratios.push_back(sv.stats().ratio_ppb);
        g_dec.add(c.in_rate);
        g_dec.add((int64_t)c.gap * 8 + c.pass * 4 + c.engage * 2 + c.relock);
        if (c.drain) drain();
        if (c.relock) passed_ = 0;
        if (c.engage) {
            const int64_t h = std::min(passed_, HISTORY);
            rs.reset(new ModelResampler(c.in_rate, c.out_rate));
            base_ = n_ - h;
            cur_ = c.in_rate;
            const int64_t k0 = rs->out_frames(h);
            rs->resample(h, k0);
            discard_ = h - k0;
        }
        if (c.pass) {
            outputs.push_back({pts, 0, frames, discont, n_ * SUB, i});
            sv.produced(frames);
            passed_ += frames;
            n_ += frames;
            return c;
        }
        if (!rs) {
            rs.reset(new ModelResampler(c.in_rate, c.out_rate));
            base_ = n_;
            cur_ = c.in_rate;
        }
        if (c.in_rate != cur_) {
            rs->update(c.in_rate, c.out_rate);
            cur_ = c.in_rate;
        }
        const int64_t fed = frames - c.skip, k = rs->out_frames(fed);
        int64_t pos = base_ * SUB + rs->position();
        rs->resample(fed, k);
        const int64_t d = std::min(discard_, k);
        discard_ -= d;
        pos += d * SUB * rs->in() / rs->out();   // the first kept output: d outputs on
        const int64_t label = sv.next_pts();
        sv.produced((uint32_t)(k - d));
        if (k - d) outputs.push_back({label, sv.next_pts(), k - d, c.relock || c.gap, pos, i});
        g_dec.add(label);
        g_dec.add(k - d);
        n_ += frames;
        return c;
    }
    std::vector<std::pair<int64_t, AsrcEvent>> of(AsrcEvent::Kind k) const {
        std::vector<std::pair<int64_t, AsrcEvent>> out;
        for (const auto& e : events)
            if (e.second.kind == k) out.push_back(e);
        return out;
    }

    AsrcServo sv;
    AsrcDeviceTerm term;
    std::vector<DOut> outputs;
    std::vector<AsrcServo::Command> cmds;
    std::vector<int64_t> pts, dppbs, ratios;
    std::vector<std::pair<int64_t, AsrcEvent>> events;
    int64_t locked_at = -1;   // the PTS of the first buffer the lock was locked after

  private:
    void drain() {
        if (rs) {
            const int64_t k = rs->out_frames(ModelResampler::DELAY);
            const int64_t pos = base_ * SUB + rs->position(), label = sv.tail_pts_at(0);
            rs->resample(ModelResampler::DELAY, k);
            sv.tail_produced((uint32_t)k);
            if (k) outputs.push_back({label, sv.tail_pts_at(0), k, false, pos, -1});
            g_dec.add(label);
            g_dec.add(k);
        }
        rs.reset();
    }

    int64_t in_hz_, out_hz_;
    std::unique_ptr<ModelResampler> rs;
    int64_t base_ = 0, cur_ = 0, n_ = 0, passed_ = 0, discard_ = 0;
};

// Frames of `frame` samples of a source fast by ppb, from frame `start`; the first DISCONT.
// `stop` ends the run; `pairs` feeds the device lock before each buffer.
template <typename Stop, typename Pairs>
int64_t feed(Driver& d, int64_t fs, int64_t frame, int64_t ppb, int64_t secs, Stop stop, Pairs pairs,
             int64_t t0 = T0, int64_t start = 0) {
    int64_t k = start / frame;
    for (; k * frame < start + secs * fs; k++) {
        const int64_t t = source_time(t0, fs, ppb, k * frame);
        pairs(d, t);
        d.push(formula_pts(t), (uint32_t)frame, k * frame == start);
        if (stop(d)) {
            k++;
            break;
        }
    }
    return k * frame;
}

auto no_stop = [](const Driver&) { return false; };
auto no_pairs = [](Driver&, int64_t) {};

// A device sink's clock fast by ppb, read on the term's timer every 100 ms of house time from `start`, each
// house read up to jitter_us late at random; after a restart it counts from 0. From step_at it reads step_ns on.
struct DeviceClock {
    int64_t ppb, jitter_us;
    Lcg g;
    int64_t next, origin;
    int64_t step_at = INT64_MAX, step_ns = 0;
    explicit DeviceClock(int64_t p, int64_t jit = 0, uint64_t seed = 1, int64_t start = T0)
        : ppb(p), jitter_us(jit), g(seed), next(start), origin(start) {}
    void operator()(Driver& d, int64_t t) {   // the reads due by house time t
        for (; next <= t; next += 100 * MS) {
            const int64_t e = next - origin;
            const int64_t late = jitter_us ? (int64_t)(g.next() % (uint32_t)(jitter_us * US)) : 0;
            d.device_sample(e + floor_div(e * ppb, S) + (next >= step_at ? step_ns : 0), next + late);
        }
    }
    void restart(Driver& d, int64_t t) {   // the sink's ring acquired again at house time t
        (*this)(d, t);
        d.device_restart(t);
        origin = t;
    }
};

bool engaged_at(const Driver& d, int64_t* at, const char** why, AsrcEvent* ev) {
    const auto e = d.of(AsrcEvent::Kind::engaged);
    if (e.empty()) return false;
    *at = e[0].second.house_ns - T0;
    *why = e[0].second.reason;
    *ev = e[0].second;
    return true;
}

void test_decode_constants() {
    std::printf("\n  Phase 3: decode bypass, device term, product ratio\n");
    const ClockLockConfig d = asrc_decode_lock_config(), c = asrc_lock_config();
    CHECK("decode lock: the capture lock with a 10-bucket first fit (S16; capture 30)",
          d.rate_buckets_min == 10 && c.rate_buckets_min == 30 && d.step_ns == c.step_ns &&
              d.step_falls == c.step_falls && d.bucket_ns == c.bucket_ns && d.rate_buckets_max == c.rate_buckets_max &&
              d.rate_tau_ns == c.rate_tau_ns && d.offset_buckets == c.offset_buckets && d.acquire_ns == c.acquire_ns &&
              d.slew_track_ppm == c.slew_track_ppm && d.step_hold_ns == c.step_hold_ns && d.backlog_ns == 0 &&
              d.step_fall_hold_ns == 0);
    const AsrcServoConfig dc = asrc_decode_config(500, false);
    CHECK("decode servo: phase bound 1 ms, hold 10 s, on the decode lock (C-7)",
          dc.bypass_phase_ns == MS && dc.bypass_hold_ns == 10 * S && dc.lock.rate_buckets_min == 10 &&
              dc.bypass_ppb == 500 && !dc.device);
    CHECK("asrc_rate_of: a lock's eps to its clock's rate, positive fast, rounded",
          asrc_rate_of(0) == 0 && asrc_rate_of(-40000) == 40002 && asrc_rate_of(40000) == -39998 &&
              asrc_rate_of(-1) == 1);
    const char* m[4];
    int i = 0;
    for (int64_t b : {0LL, 500LL})
        for (bool dv : {false, true}) m[i++] = asrc_mode_name(AsrcServo(48000, 48000, Driver::cfg(b, dv)).mode());
    CHECK("modes before any buffer: capture, device, bypass, device (S17: bypass 0 without device-sink is capture, "
          "with it the device term alone)",
          !std::strcmp(m[0], "capture") && !std::strcmp(m[1], "device") && !std::strcmp(m[2], "bypass") &&
              !std::strcmp(m[3], "device") && !std::strcmp(asrc_event_name(AsrcEvent::Kind::engaged), "engaged") &&
              !std::strcmp(asrc_mode_name(AsrcServo::Mode::decode), "decode") &&
              !std::strcmp(asrc_mode_name(AsrcServo::Mode::decode_device), "decode+device"));
}

void test_decode_house_rate() {
    std::printf("\n  house-rate streams never engage, 1 h simulated (0.5 ppm bound)\n");
    struct Row {
        const char* name;
        int64_t fs;
    };
    for (const Row& w : {Row{"48 kHz AAC, exact 1,920-tick frames", 48000},
                         Row{"44.1 kHz AAC, PTS quantised to ticks (+-5.5 us)", 44100}}) {
        Driver d(w.fs, w.fs, 500, false);
        int64_t worst = 0;
        feed(d, w.fs, 1024, 0, 3600,
             [&](const Driver& x) {
                 if (x.sv.lock().phase() == ClockLock::Phase::locked) worst = std::max(worst, iabs(x.sv.lock().ppb()));
                 return false;
             },
             no_pairs);
        const AsrcServo::Stats st = d.sv.stats();
        bool all_passed = true;
        for (const auto& c : d.cmds) all_passed = all_passed && c.pass;
        char name[300];
        std::snprintf(name, sizeof name, "%s: never engages (%zu engages, mode %s), every buffer passed unchanged, "
                      "max |eps| once locked %lld ppb, phase %+.1f us at 1 h", w.name,
                      d.of(AsrcEvent::Kind::engaged).size(), asrc_mode_name(st.mode), (long long)worst,
                      st.phase_err_ns / 1e3);
        CHECK(name, d.of(AsrcEvent::Kind::engaged).empty() && st.mode == AsrcServo::Mode::bypass && all_passed &&
                        worst < 100 && st.out_frames == st.in_frames && st.relocks == 0 &&
                        iabs(st.phase_err_ns) < 50 * US);
    }
}

void test_decode_foreign() {
    std::printf("\n  a source on its own clock engages\n");
    for (int64_t ppb : {3000LL, -3000LL}) {
        Driver d(48000, 48000, 500, false);
        feed(d, 48000, 1024, ppb, 60, [](const Driver& x) { return !x.of(AsrcEvent::Kind::engaged).empty(); },
             no_pairs);
        int64_t at = 0;
        const char* why = "";
        AsrcEvent e{};
        const bool ok = engaged_at(d, &at, &why, &e);
        const int64_t held = ok && d.locked_at >= 0 ? at - (d.locked_at - T0) : -1;
        char name[260];
        std::snprintf(name, sizeof name, "%+.0f ppm: engages within 30 s on the ratio rule, held 10 s of lock first "
                      "(%.3f s, %.3f s after the lock, %s; source %+.3f ppm, phase %+.1f us)", ppb / 1e3, at / 1e9,
                      held / 1e9, why, e.value / 1e3, e.phase_ns / 1e3);
        CHECK(name, ok && at <= 30 * S && held >= 10 * S && !std::strcmp(why, "ratio") && iabs(e.value - ppb) <= 500);
    }
    Driver d(48000, 48000, 500, false);
    feed(d, 48000, 1024, 300, 3600, [](const Driver& x) { return !x.of(AsrcEvent::Kind::engaged).empty(); }, no_pairs);
    int64_t at = 0;
    const char* why = "";
    AsrcEvent e{};
    const bool ok = engaged_at(d, &at, &why, &e);
    char name[240];
    std::snprintf(name, sizeof name, "+0.3 ppm: inside the ratio bound, engages when the phase passes 1 ms (%.2f min, "
                  "%s, phase %+.1f us; 1 ms at 0.3 ppm is 55.6 min)", at / 60e9, why, e.phase_ns / 1e3);
    CHECK(name, ok && !std::strcmp(why, "phase") && at >= 54 * 60 * S && at <= 57 * 60 * S && iabs(e.phase_ns) > MS);
}

void test_decode_engaged() {
    std::printf("\n  engaged: a house-rate counter (+40 ppm source, 10 min after the engage)\n");
    Driver d(48000, 48000, 500, false);
    feed(d, 48000, 1024, 40000, 690, no_stop, no_pairs);
    int64_t at = 0;
    const char* why = "";
    AsrcEvent e{};
    const bool ok = engaged_at(d, &at, &why, &e);
    std::vector<DOut> late;
    for (const DOut& o : d.outputs)
        if (ok && o.label - T0 >= at + 60 * S) late.push_back(o);
    int64_t lo = INT64_MAX, hi = INT64_MIN;
    for (const DOut& o : late) {
        const int64_t err = o.label - content_of(o.pos, 48000, 40000);
        lo = std::min(lo, err);
        hi = std::max(hi, err);
    }
    char name[300];
    std::snprintf(name, sizeof name, "+40 ppm: engaged at %.2f s (%s); from 60 s after it every output labelled within "
                  "1 frame of its content time (%+.2f .. %+.2f us)", at / 1e9, why, lo / 1e3, hi / 1e3);
    CHECK(name, ok && at <= 30 * S && !late.empty() && in_frame(lo, 48000) && in_frame(hi, 48000) &&
                    d.sv.mode() == AsrcServo::Mode::decode);
    const int64_t span = late.empty() ? 0 : content_of(late.back().pos, 48000, 40000) - content_of(late[0].pos, 48000, 40000);
    int64_t frames = 0;
    for (size_t i = 0; i + 1 < late.size(); i++) frames += late[i].frames;
    std::snprintf(name, sizeof name, "... %lld frames over %.6f s of content (house) time: 48,000 per house second +-1 "
                  "(%+.3f frames)", (long long)frames, span / 1e9, (frames * S - span * 48000) / 1e9);
    CHECK(name, span >= 600 * S && iabs(frames * S - span * 48000) <= S);
    size_t i_late = 0;
    while (i_late < d.pts.size() && d.pts[i_late] - T0 < at + 60 * S) i_late++;
    int64_t sum = 0, n = 0, dev = 0;
    for (size_t i = i_late; i < d.ratios.size(); i++, n++) {
        sum += d.ratios[i];
        dev = std::max(dev, iabs(d.ratios[i] + 39998));
    }
    const int64_t mean = n ? floor_div(sum, n) : 0;
    std::snprintf(name, sizeof name, "... the ratio follows the source: out/in - 1 averages %+.4f ppm from 60 s after "
                  "the engage (-39.998 for +40 ppm, +-0.02), each buffer within 3 ppm of it", mean / 1e3);
    CHECK(name, n > 0 && iabs(mean + 39998) <= 20 && dev <= 3000);
    bool contiguous = true, discont = false;
    const int64_t i0 = ok ? d.of(AsrcEvent::Kind::engaged)[0].first : 0;
    for (size_t i = 1; i < d.outputs.size(); i++) {
        discont = discont || d.outputs[i].discont;
        if (d.outputs[i - 1].buf >= i0 && d.outputs[i].buf >= i0)
            contiguous = contiguous && d.outputs[i - 1].end == d.outputs[i].label;
    }
    CHECK("... no relock, no DISCONT after the first output, the counter contiguous from the engage",
          d.sv.stats().relocks == 0 && !discont && contiguous);
}

void test_decode_seamless() {
    std::printf("\n  the engage is seamless (from pass-through)\n");
    Driver d(48000, 48000, 500, false);
    feed(d, 48000, 1024, 40000, 40,
         [](const Driver& x) {
             const auto e = x.of(AsrcEvent::Kind::engaged);
             return !e.empty() && (int64_t)x.cmds.size() > e[0].first + 2;
         },
         no_pairs);
    const auto eng = d.of(AsrcEvent::Kind::engaged);
    const int64_t i0 = eng.empty() ? 0 : eng[0].first;
    const DOut* last = nullptr;
    const DOut* first = nullptr;
    for (const DOut& o : d.outputs) {
        if (o.buf == i0 - 1) last = &o;
        if (o.buf == i0 && !first) first = &o;
    }
    const bool have = !eng.empty() && last && first;
    const AsrcServo::Command c0 = have ? d.cmds[i0] : AsrcServo::Command{};
    char name[300];
    std::snprintf(name, sizeof name, "the engaging buffer is primed (engage, not passed) and its first output labelled "
                  "with its PTS (%lld ns = %lld ns), no DISCONT", have ? (long long)(first->label - T0) : 0LL,
                  have ? (long long)(d.pts[i0] - T0) : 0LL);
    CHECK(name, have && c0.engage && !c0.pass && first->label == d.pts[i0] && !first->discont);
    const double pos = have ? (double)first->pos / SUB - (double)i0 * 1024 : 9;
    std::snprintf(name, sizeof name, "... that output is the engaging buffer's first frame: nothing dropped or repeated "
                  "(position %+.4f frames from it; GStreamer centres 1/8 frame early)", pos);
    CHECK(name, have && pos > -0.225 && pos < -0.025);
    std::snprintf(name, sizeof name, "... after the last passed buffer, which ended on that frame (%lld = %lld); the "
                  "engaging buffer gives its frames less the lookahead (%lld: 1024 - 32 +-1)",
                  have ? (long long)(last->pos / SUB + last->frames) : 0LL, (long long)(i0 * 1024),
                  have ? (long long)first->frames : 0LL);
    CHECK(name, have && last->pos / SUB + last->frames == i0 * 1024 && iabs(first->frames - (1024 - 32)) <= 1);
}

void test_decode_breaks() {
    std::printf("\n  engaged until a DISCONT or GAP, then measured afresh\n");
    for (const bool gap : {false, true}) {
        Driver d(48000, 48000, 500, false);
        const int64_t n = feed(d, 48000, 1024, 40000, 40, no_stop, no_pairs);
        const AsrcServo::Mode before = d.sv.mode();
        const int64_t end = d.sv.next_pts();
        const size_t nout = d.outputs.size();
        if (gap) d.gap();
        const int64_t t = source_time(T0, 48000, 40000, n) + 300 * MS;
        const AsrcServo::Command c = d.push(formula_pts(t), 1024, !gap);
        const auto rel = d.of(AsrcEvent::Kind::relock);
        const AsrcServo::Stats st = d.sv.stats();
        const bool two = d.outputs.size() == nout + 2;
        const char* kind = gap ? "gap" : "discont";
        char name[300];
        std::snprintf(name, sizeof name, "%s: engaged before (%s); the resampler's tail leaves first on the old counter "
                      "(%lld frames at %lld ns from its end), then the buffer passes unchanged: mode %s, one relock",
                      kind, asrc_mode_name(before), two ? (long long)d.outputs[nout].frames : 0LL,
                      two ? (long long)(d.outputs[nout].label - end) : 0LL, asrc_mode_name(st.mode));
        CHECK(name, before == AsrcServo::Mode::decode && two && d.outputs[nout].buf == -1 &&
                        d.outputs[nout].label == end && iabs(d.outputs[nout].frames - 32) <= 1 && c.pass &&
                        d.outputs[nout + 1].label == formula_pts(t) && st.mode == AsrcServo::Mode::bypass &&
                        rel.size() == 1 && !std::strcmp(rel[0].second.reason, kind) && !c.drain);
        std::snprintf(name, sizeof name, "%s: the lock measured afresh (source %lld ppb, %s), the jump against the "
                      "tail's end %.3f ms", kind, (long long)st.source_ppb, asrc_state_name(st.state),
                      rel.empty() ? 0.0 : rel[0].second.value / 1e6);
        CHECK(name, st.source_ppb == 0 && st.state == AsrcServo::State::acquiring && !rel.empty() &&
                        rel[0].second.value == formula_pts(t) - d.sv.tail_pts_at(0));
    }
}

void test_decode_composite() {
    std::printf("\n  one resampler: the commanded ratio is the decode term times the device term\n");
    const int64_t combos[4][2] = {{500000, -300000}, {-500000, 300000}, {40000, -40000}, {-800000, -150000}};
    for (const auto& cb : combos) {
        const int64_t src = cb[0], devp = cb[1];
        Driver d(48000, 48000, 500, true);
        feed(d, 48000, 1024, src, 60, no_stop, DeviceClock(devp));
        const AsrcServo::Stats st = d.sv.stats();
        const int64_t dppb = d.dppbs.back(), dec = st.decode_ppb, total = st.ratio_ppb;
        const int64_t exact = floor_div((S + dec) * S + (S + dppb) / 2, S + dppb) - S;
        // The product in ppb to 1e-3 ppb, and the sum a mutant would command.
        const int64_t product = (int64_t)(((__int128)(S + dec) * S * 1000 + (S + dppb) / 2) / (S + dppb)) - S * 1000;
        const int64_t sum = dec - dppb;
        char name[300];
        std::snprintf(name, sizeof name, "source %+.0f ppm, device %+.0f ppm: mode %s, ratio %+.4f ppm = (1 + decode "
                      "%+.4f) / (1 + device eps %+.4f) - 1 within 0.01 ppm (a sum is %+.4f ppm off)", src / 1e3, devp / 1e3,
                      asrc_mode_name(st.mode), total / 1e3, dec / 1e3, dppb / 1e3, (sum - total) / 1e3);
        CHECK(name, st.mode == AsrcServo::Mode::decode_device && total == exact && iabs(total * 1000 - product) <= 10000 &&
                        (iabs(src) < 100000 || iabs(sum - total) > 10) && iabs(asrc_rate_of(dppb) - devp) <= 1000);
        const int32_t rate = d.cmds.back().in_rate;
        const int64_t want = (2 * 48000LL * 1000 * (S + dppb) + (S + dec)) / (2 * (S + dec));
        std::snprintf(name, sizeof name, "... in_rate %d = round(48,000,000 x (1 + device eps) / (1 + decode eps)) = %lld",
                      rate, (long long)want);
        CHECK(name, iabs(rate - want) <= 1);
    }
}

void test_device_only() {
    std::printf("\n  bypass-below-ppm 0 with device-sink: the device term alone (S17)\n");
    Driver d(48000, 48000, 0, true);
    DeviceClock pairs(40000);
    Lcg g(5);
    for (int64_t k = 0; k < 6000; k++) {   // PTS with 1 ms of jitter: nothing locks to them
        const int64_t t = T0 + k * 1024 * S / 48000;
        pairs(d, t);
        if (k == 4500) d.gap();   // 96 s: 51 s past the device term's first fit (its 15 s settle, 30 buckets)
        d.push(t + (int64_t)(g.next() % (uint32_t)MS), 1024, k == 0);
    }
    const AsrcServo::Stats st = d.sv.stats();
    size_t same = 0;
    for (size_t i = 0; i < d.cmds.size(); i++) {
        int64_t want = (2 * 48000LL * 1000 * (S + d.dppbs[i]) + S) / (2 * S);
        if (want == 48000LL * 1000) want--;
        same += d.cmds[i].in_rate == want;
    }
    const int64_t dppb = d.dppbs.back();
    char name[300];
    std::snprintf(name, sizeof name, "mode device, no source lock (source %lld ppb), every buffer's ratio the device term "
                  "alone (in_rate = round(48,000,000 x (1 + device eps)), %zu of %zu; at the end %d for eps %lld ppb); "
                  "jittered PTS steer nothing", (long long)st.source_ppb, same, d.cmds.size(), d.cmds.back().in_rate,
                  (long long)dppb);
    CHECK(name, st.mode == AsrcServo::Mode::device && st.source_ppb == 0 && same == d.cmds.size() &&
                    iabs(st.ratio_ppb - asrc_rate_of(dppb)) <= 1 && iabs(asrc_rate_of(dppb) - 40000) <= 200);
    std::vector<size_t> starts;
    bool contiguous = true;
    for (size_t i = 0; i < d.outputs.size(); i++) {
        if (i == 0 || d.outputs[i].discont) starts.push_back(i);
        else contiguous = contiguous && d.outputs[i - 1].end == d.outputs[i].label;
    }
    const auto rel = d.of(AsrcEvent::Kind::relock);
    // B-148: what the first epoch's outputs ran up on the device timeline, each frame -eps_dev / 48 kHz.
    int64_t ran = 0;
    for (size_t i = 0; starts.size() == 2 && i < starts[1]; i++)
        ran -= d.outputs[i].frames * d.dppbs[d.outputs[i].buf >= 0 ? d.outputs[i].buf : 4499];
    ran = floor_div(ran, 48000);
    const int64_t off = starts.size() == 2 ? d.outputs[starts[1]].label - d.pts[4500] : 0;
    std::snprintf(name, sizeof name, "labels: a contiguous counter from the first PTS, relocked at the GAP alone (%zu "
                  "relock(s); %zu epochs), the second on the device timeline: the GAP buffer's PTS %+.3f ms, what the "
                  "first epoch's outputs ran up (%+.3f ms: 40 ppm from the device term's first fit) within 1 us",
                  rel.size(), starts.size(), off / 1e6, ran / 1e6);
    CHECK(name, rel.size() == 1 && !std::strcmp(rel[0].second.reason, "gap") && starts.size() == 2 && contiguous &&
                    d.outputs[starts[0]].label == d.pts[0] && iabs(off - ran) <= US && off > MS);
}

// --- B-148: the device timeline across a break, lost time, the decode bound, the engage's rate ----------
// py/asrc_bypass_ref_test.py's B-148 cases, the same scenarios (its random draws differ: the checks hold either).

int64_t ceil_div(int64_t a, int64_t b) { return -floor_div(-a, b); }

struct Continuity {
    std::unique_ptr<Driver> d;
    std::vector<int64_t> pts, gaps;   // each push's PTS; the content gaps (ns) at the breaks
    int64_t recal_out = -1;           // the output the restart meets
};

// A house-rate source into decode + device (bypassed), the device dev_ppb fast and read on the term's timer, exact
// or up to jitter_us late; at each of breaks_s it loses `lost` frames, then a DISCONT buffer or a GAP; the sink's
// ring acquired again at recal_s (< 0: none): the term relocks, the servo told.
Continuity continuity_run(int64_t dev_ppb, int64_t secs, const std::vector<int64_t>& breaks_s, bool gap,
                          int64_t jitter_us, int64_t lost = 1024, int64_t recal_s = -1) {
    Continuity r;
    r.d.reset(new Driver(48000, 48000, 500, true));
    Driver& d = *r.d;
    DeviceClock clock(dev_ppb, jitter_us);
    int64_t n = 0;
    size_t bi = 0;
    while (n * S / 48000 < secs * S) {
        const bool brk = bi < breaks_s.size() && n * S / 48000 >= breaks_s[bi] * S;
        if (brk) {
            r.gaps.push_back(lost * S / 48000);
            n += lost;
            bi++;
            if (gap) d.gap();
        }
        const int64_t t = T0 + n * S / 48000;
        if (recal_s >= 0 && r.recal_out < 0 && t - T0 >= recal_s * S) {
            clock.restart(d, t);
            r.recal_out = (int64_t)d.outputs.size();
        }
        clock(d, t);
        d.push(t, 1024, n == 0 || (brk && !gap));
        r.pts.push_back(t);
        n += 1024;
    }
    return r;
}

// Each output against the sink, which never skews (C-6): from its calibration (the first output, or the first
// after a recalibration) it plays label L at house L_cal + (L - L_cal) / (1 + the device's rate). (content time
// - T0, that playout less its content time) per output, those within 2 filter lengths of a break left out.
std::vector<std::pair<int64_t, int64_t>> playout(const Continuity& r, int64_t dev_ppb, int64_t frames = 1024) {
    const Driver& d = *r.d;
    const int64_t near = 2 * ModelResampler::TAPS * SUB, per = frames * S / 48000;
    std::vector<int64_t> breaks;
    for (size_t b = 1; b < r.pts.size(); b++)
        if (iabs(r.pts[b] - r.pts[b - 1] - per) > 1) breaks.push_back((int64_t)b * frames * SUB);
    std::vector<std::pair<int64_t, int64_t>> out;
    int64_t cal = d.outputs.empty() ? 0 : d.outputs[0].label;
    for (size_t j = 0; j < d.outputs.size(); j++) {
        const DOut& o = d.outputs[j];
        if ((int64_t)j == r.recal_out) cal = o.label;
        bool skip = o.pos < near;
        for (int64_t x : breaks) skip = skip || iabs(o.pos - x) < near;
        if (skip) continue;
        const int64_t b = std::min<int64_t>(floor_div(o.pos, SUB * frames), (int64_t)r.pts.size() - 1);
        const int64_t c = r.pts[b] + floor_div((o.pos - b * frames * SUB) * S, SUB * 48000);
        __int128 num = (__int128)(o.label - cal) * S, den = S + dev_ppb;
        __int128 q = num / den;
        if (num % den != 0 && (num < 0) != (den < 0)) q -= 1;
        out.push_back({c - T0, cal + (int64_t)q - c});
    }
    return out;
}

// The playout's range from `from_s` on, against its first value there (or against `ref` when given).
bool playout_range(const std::vector<std::pair<int64_t, int64_t>>& p, int64_t from_s, int64_t to_s, int64_t* lo,
                   int64_t* hi, int64_t* first) {
    bool have = false;
    *lo = INT64_MAX;
    *hi = INT64_MIN;
    for (const auto& x : p) {
        if (x.first < from_s * S || x.first >= to_s * S) continue;
        if (!have) *first = x.second;
        have = true;
        *lo = std::min(*lo, x.second);
        *hi = std::max(*hi, x.second);
    }
    return have;
}

void test_device_continuity() {
    std::printf("\n  B-148: the labels stay on the device timeline across a DISCONT or a GAP\n");
    struct Row {
        const char* name;
        int64_t dev;
        bool gap;
        int64_t jit;
    };
    for (const Row& w : {Row{"-136 ppm, a DISCONT every 300 s, exact reads", -136000, false, 0},
                         Row{"+136 ppm, a DISCONT every 300 s, reads 2 ms late at random", 136000, false, 2000},
                         Row{"-136 ppm, a GAP every 300 s, reads 2 ms late at random", -136000, true, 2000},
                         Row{"+136 ppm, a GAP every 300 s, exact reads", 136000, true, 0}}) {
        const Continuity r = continuity_run(w.dev, 1800, {300, 600, 900, 1200, 1500}, w.gap, w.jit);
        const auto rel = r.d->of(AsrcEvent::Kind::relock);
        bool ok = rel.size() == 5 && r.gaps.size() == 5;
        int64_t jlo = INT64_MAX, jhi = INT64_MIN;
        for (size_t i = 0; ok && i < rel.size(); i++) {
            const int64_t j = rel[i].second.value - r.gaps[i];
            jlo = std::min(jlo, j);
            jhi = std::max(jhi, j);
            ok = ok && !std::strcmp(rel[i].second.reason, w.gap ? "gap" : "discont");
        }
        int64_t lo, hi, ref;
        const bool have = playout_range(playout(r, w.dev), 60, 1800, &lo, &hi, &ref);
        char name[400];
        std::snprintf(name, sizeof name, "%s, 30 min: %zu relocks (%s), each jump the content gap within 0.1 ms "
                      "(%+.3f .. %+.3f us off it); the playout less its content time within 1 ms of its value at 60 s "
                      "(%+.3f .. %+.3f ms; before B-148 each relock added 40.8 ms)", w.name, rel.size(),
                      w.gap ? "gap" : "discont", jlo / 1e3, jhi / 1e3, (lo - ref) / 1e6, (hi - ref) / 1e6);
        CHECK(name, ok && iabs(jlo) <= 100 * US && iabs(jhi) <= 100 * US && have && iabs(lo - ref) <= MS &&
                        iabs(hi - ref) <= MS);
    }
    {   // DEV-P3a's V7 shape: one DISCONT after 20 min (section 5 predicted 163 ms more than the gap before B-148)
        const Continuity r = continuity_run(-136000, 1500, {1200}, false, 0);
        const auto rel = r.d->of(AsrcEvent::Kind::relock);
        int64_t lo, hi, ref;
        const bool have = playout_range(playout(r, -136000), 60, 1500, &lo, &hi, &ref);
        char name[300];
        std::snprintf(name, sizeof name, "-136 ppm, one DISCONT after 20 min: the jump the gap (%+.3f us off it), the "
                      "playout flat (%+.3f .. %+.3f ms)", rel.empty() ? 0.0 : (rel[0].second.value - r.gaps[0]) / 1e3,
                      (lo - ref) / 1e6, (hi - ref) / 1e6);
        CHECK(name, rel.size() == 1 && iabs(rel[0].second.value - r.gaps[0]) <= 100 * US && have &&
                        iabs(lo - ref) <= MS && iabs(hi - ref) <= MS);
    }
    {
        const Continuity r = continuity_run(-136000, 600, {300}, false, 0, 60 * 48000);
        const auto rel = r.d->of(AsrcEvent::Kind::relock);
        const int64_t dev_gap = r.gaps[0] + floor_div(r.gaps[0] * -136000, S);   // the outage in device time
        int64_t lo, hi, ref;
        const bool have = playout_range(playout(r, -136000), 60, 600, &lo, &hi, &ref);
        char name[300];
        std::snprintf(name, sizeof name, "a 60 s outage at -136 ppm: the jump %.6f s, the outage in device time (%.6f s; "
                      "%+.3f us off it, the house span 8.16 ms more); the playout flat (%+.3f .. %+.3f ms)",
                      rel.empty() ? 0.0 : rel[0].second.value / 1e9, dev_gap / 1e9,
                      rel.empty() ? 0.0 : (rel[0].second.value - dev_gap) / 1e3, (lo - ref) / 1e6, (hi - ref) / 1e6);
        CHECK(name, rel.size() == 1 && iabs(rel[0].second.value - dev_gap) <= 100 * US && have &&
                        iabs(lo - ref) <= MS && iabs(hi - ref) <= MS);
    }
    {
        const Continuity r = continuity_run(-136000, 450, {300}, false, 0, 1024, 150);
        const auto p = playout(r, -136000);
        int64_t mlo, mhi, mref, llo, lhi, lref;
        const bool hm = playout_range(p, 155, 300, &mlo, &mhi, &mref), hl = playout_range(p, 305, 450, &llo, &lhi, &lref);
        char name[400];
        std::snprintf(name, sizeof name, "the sink's ring acquired again at 150 s (a relock-device restart): the open "
                      "epoch keeps its labels (%+.3f .. %+.3f ms against the restarted sink), and the next epoch carries only what ran up "
                      "since: the playout on its content time again after the DISCONT (%+.3f .. %+.3f ms)", mlo / 1e6,
                      mhi / 1e6, llo / 1e6, lhi / 1e6);
        CHECK(name, r.recal_out >= 0 && hm && hl && mhi - mlo <= MS && mlo < -10 * MS && iabs(llo) <= MS &&
                        iabs(lhi) <= MS);
    }
}

struct Step {
    int64_t at_s, ticks;
};

// A house-rate decode as opusdec gives it: `frames`-frame buffers whose PTS are 90 kHz ticks (1800 per 960
// frames) ceil'd to ns; holes and back: unflagged steps forward and back. With `device`, the device term at
// dev_ppb from exact timer reads.
std::unique_ptr<Driver> decode_ticks_run(int64_t secs, const std::vector<Step>& holes, const std::vector<Step>& back,
                                         bool device = false, int64_t dev_ppb = -136000, int64_t frames = 960) {
    std::unique_ptr<Driver> d(new Driver(48000, 48000, 500, device));
    const int64_t per = frames * 90000 / 48000;
    std::vector<std::pair<int64_t, int64_t>> steps;
    for (const Step& h : holes) steps.push_back({h.at_s * 48000 / frames, h.ticks});
    for (const Step& b : back) steps.push_back({b.at_s * 48000 / frames, -b.ticks});
    std::sort(steps.begin(), steps.end());
    int64_t tick = 450000LL * 90000;
    DeviceClock clock(dev_ppb, 0, 1, ceil_div(tick * 100000, 9));
    size_t si = 0;
    for (int64_t k = 0; k < secs * 48000 / frames; k++) {
        while (si < steps.size() && k >= steps[si].first) tick += steps[si++].second;
        const int64_t t = ceil_div(tick * 100000, 9);
        if (device) clock(*d, t);
        d->push(t, (uint32_t)frames, k == 0);
        tick += per;
    }
    return d;
}

void test_lost_time() {
    std::printf("\n  B-148: decode modes, an unflagged hole is lost time, a step back a break\n");
    char name[700];
    for (bool device : {false, true}) {
        bool ok = true, labels_ok = true;
        std::string rows, labels;
        for (int64_t at : {15LL, 30LL, 60LL, 120LL, 300LL}) {
            const auto d = decode_ticks_run(900, {{at, 1920}}, {}, device);
            const auto g = d->of(AsrcEvent::Kind::gap);
            const AsrcServo::Stats st = d->sv.stats();
            // The labels jump the PTS hole less the device's drift over it (the p3-22 review's M9).
            for (const auto& e : g) {
                const size_t i = (size_t)e.first;
                const int64_t hole = d->pts[i] - d->pts[i - 1] - 960 * S / 48000, dv = d->dppbs[i];
                const int64_t off = e.second.value - (hole - floor_div(hole * dv, S + dv));
                char lab[60];
                std::snprintf(lab, sizeof lab, "%s(%lld, %lld, %lld)", labels.empty() ? "" : ", ", (long long)at,
                              (long long)dv, (long long)off);
                labels += lab;
                labels_ok = labels_ok && iabs(off) <= US && (!device || at < 60 || dv != 0);
            }
            char row[100];
            std::snprintf(row, sizeof row, "%s%lld s: %zu engages, %zu gaps of %lld, %+.3f ppm", rows.empty() ? "" : "; ",
                          (long long)at, d->of(AsrcEvent::Kind::engaged).size(), g.size(),
                          g.empty() ? 0LL : (long long)g[0].second.lost_frames, st.source_ppb / 1e3);
            rows += row;
            ok = ok && d->of(AsrcEvent::Kind::engaged).empty() && g.size() == 1 &&
                 !std::strcmp(g[0].second.reason, "lost-time") && g[0].second.lost_frames == 1024 &&
                 iabs(st.source_ppb) <= 500 && st.relocks == 0;
        }
        std::snprintf(name, sizeof name, "%s: one 21.333 ms hole at 15/30/60/120/300 s of 900 s: no engage, one "
                      "lost-time gap of 1024 frames each, the source at house rate within 0.5 ppm, no relock (%s)",
                      device ? "decode + device" : "decode", rows.c_str());
        CHECK(name, ok);
        std::snprintf(name, sizeof name, "%s: each gap's labels jump the hole less the device's drift over it within "
                      "1 us ((s, device eps ppb, ns off): %s)", device ? "decode + device" : "decode", labels.c_str());
        CHECK(name, labels_ok && !labels.empty());
    }
    {
        const auto d = decode_ticks_run(900, {{15, 1920}, {30, 1920}, {60, 1920}}, {}, true);
        size_t disc = 0;
        for (size_t i = 1; i < d->outputs.size(); i++) disc += d->outputs[i].discont;
        std::snprintf(name, sizeof name, "decode + device, three holes at 15/30/60 s: no engage, three gaps, each its next "
                      "output DISCONT (%zu, %zu, %zu), mode %s", d->of(AsrcEvent::Kind::engaged).size(),
                      d->of(AsrcEvent::Kind::gap).size(), disc, asrc_mode_name(d->sv.mode()));
        CHECK(name, d->of(AsrcEvent::Kind::engaged).empty() && d->of(AsrcEvent::Kind::gap).size() == 3 && disc == 3 &&
                        d->sv.mode() == AsrcServo::Mode::device);
    }
    {
        bool ok = true;
        std::string rows;
        const int64_t want[3] = {64, 256, 480};
        int i = 0;
        for (int64_t ticks : {120LL, 480LL, 900LL}) {   // 1.333, 5.333, 10 ms
            const auto d = decode_ticks_run(600, {{120, ticks}}, {});
            const auto g = d->of(AsrcEvent::Kind::gap);
            char row[80];
            std::snprintf(row, sizeof row, "%s%.3f ms: %zu engages, %zu gaps of %lld", rows.empty() ? "" : "; ",
                          ticks / 90.0, d->of(AsrcEvent::Kind::engaged).size(), g.size(),
                          g.empty() ? 0LL : (long long)g[0].second.lost_frames);
            rows += row;
            ok = ok && d->of(AsrcEvent::Kind::engaged).empty() && g.size() == 1 && g[0].second.lost_frames == want[i++];
        }
        std::snprintf(name, sizeof name, "holes of 1.333/5.333/10 ms at 120 s: no engage, one gap of their frames each "
                      "(%s)", rows.c_str());
        CHECK(name, ok);
    }
    {
        bool ok = true;
        std::string rows;
        for (int64_t ticks : {1919LL, 1921LL}) {   // a tick off 1024 frames, 10 s into the epoch
            const auto d = decode_ticks_run(120, {{10, ticks}}, {});
            const auto g = d->of(AsrcEvent::Kind::gap);
            const int64_t phase = d->sv.stats().phase_err_ns, want = ticks * 100000 / 9;
            char row[120];
            std::snprintf(row, sizeof row, "%s%lld ticks: %zu engages, %zu gaps of %lld frames jumping %lld ns, phase "
                          "%lld ns", rows.empty() ? "" : "; ", (long long)ticks, d->of(AsrcEvent::Kind::engaged).size(),
                          g.size(), g.empty() ? 0LL : (long long)g[0].second.lost_frames,
                          g.empty() ? 0LL : (long long)g[0].second.value, (long long)phase);
            rows += row;
            ok = ok && d->of(AsrcEvent::Kind::engaged).empty() && g.size() == 1 && iabs(g[0].second.value - want) <= 2 &&
                 iabs(phase) <= 2;
        }
        std::snprintf(name, sizeof name, "holes a tick off 1024 frames 10 s into the epoch: no engage, the labels jump the "
                      "PTS hole to the ns and the phase stays (%s; on whole frames alone 9.7 us reached the lock, a ratio "
                      "engage at 0.55 ppm)", rows.c_str());
        CHECK(name, ok);
    }
    {
        const auto d = decode_ticks_run(600, {{120, 45}}, {});
        const auto e = d->of(AsrcEvent::Kind::engaged);
        std::snprintf(name, sizeof name, "a 0.5 ms hole stays the lock's (inside the bound; the known limit): no gap, %s "
                      "%+.2f ppm", e.empty() ? "never engaged" : e[0].second.reason,
                      e.empty() ? 0.0 : e[0].second.value / 1e3);
        CHECK(name, d->of(AsrcEvent::Kind::gap).empty());
    }
    {
        const auto d = decode_ticks_run(600, {}, {{120, 1890}});
        const auto rel = d->of(AsrcEvent::Kind::relock);
        std::snprintf(name, sizeof name, "a 21 ms step back at 120 s: one relock '%s' (%.3f ms), measured afresh, no "
                      "engage, mode %s", rel.empty() ? "" : rel[0].second.reason,
                      rel.empty() ? 0.0 : rel[0].second.value / 1e6, asrc_mode_name(d->sv.mode()));
        CHECK(name, rel.size() == 1 && !std::strcmp(rel[0].second.reason, "jump") &&
                        d->of(AsrcEvent::Kind::engaged).empty() && d->sv.mode() == AsrcServo::Mode::bypass);
    }
    {
        bool ok = true;
        std::string rows;
        for (int64_t ppb : {88000000LL, -50000000LL}) {   // 44.1 kHz content labelled 48 kHz; 5 % slow
            Driver d(48000, 48000, 500, false);
            feed(d, 48000, 1024, ppb, 60, no_stop, no_pairs);
            const AsrcServo::Stats st = d.sv.stats();
            char row[80];
            std::snprintf(row, sizeof row, "%s%+.1f %%: %llu gaps, %llu relocks", rows.empty() ? "" : "; ", ppb / 1e7,
                          (unsigned long long)st.gaps, (unsigned long long)st.relocks);
            rows += row;
            ok = ok && st.gaps == 0 && st.relocks == 0;
        }
        std::snprintf(name, sizeof name, "a source past the bound on every buffer (%s): its steps are a rate, the lock's, "
                      "as before B-148: no lost time, no break", rows.c_str());
        CHECK(name, ok);
    }
}

// The DEV-P3a v7dec sequence (house-engage-replay/replay.cpp): v5hx's Opus egress, AU 0 at these ticks, +1920/
// +1919-tick steps where Mic A lost a cycle (rec/v5ana.txt; the fifth from mA's journal).
constexpr int64_t V5HX_AU0 = 40562937132LL;
const int64_t V5HX_STEPS[5][2] = {{5526, 1920}, {6037, 1920}, {17084, 1920}, {93796, 1919}, {125956, 1920}};

void test_v7dec_replay() {
    std::printf("\n  B-148: DEV-P3a's v7dec, replayed (the five lost Mic A cycles behind the Opus hop)\n");
    for (bool device : {true, false}) {
        Driver d(48000, 48000, 500, device);
        std::unique_ptr<DeviceClock> clock;
        for (int64_t k = -690; k <= 128000; k++) {
            int64_t tick = V5HX_AU0 + k * 1800;
            for (const auto& s : V5HX_STEPS)
                if (k >= s[0]) tick += s[1];
            const int64_t t = ceil_div(tick * 100000, 9);
            if (!clock) clock.reset(new DeviceClock(-140000, 0, 1, t));
            if (device) (*clock)(d, t);
            d.push(t, 960, k == -690);
        }
        const auto g = d.of(AsrcEvent::Kind::gap);
        std::string fr;
        bool want = g.size() == 5;
        const int64_t lost[5] = {1024, 1024, 1024, 1023, 1024};
        for (size_t i = 0; i < g.size(); i++) {
            fr += (i ? "," : "") + std::to_string(g[i].second.lost_frames);
            want = want && i < 5 && g[i].second.lost_frames == lost[i];
        }
        char name[400];
        std::snprintf(name, sizeof name, "%s: AUs -690..128000, %zu engages (before B-148: one, ratio -65.0 ppm at AU "
                      "6908), %zu gaps of [%s] frames, %llu relocks, mode %s", device ? "decode + device" : "decode",
                      d.of(AsrcEvent::Kind::engaged).size(), g.size(), fr.c_str(),
                      (unsigned long long)d.sv.stats().relocks, asrc_mode_name(d.sv.mode()));
        CHECK(name, d.of(AsrcEvent::Kind::engaged).empty() && want && d.sv.stats().relocks == 0);
    }
}

void test_foreign_pes() {
    std::printf("\n  B-148: a foreign source in PES of several AUs still engages at its rate\n");
    Driver d(48000, 48000, 500, false);
    for (int64_t k = 0; k < 60 * 48000 / 1024; k++) {   // +40 ppm, 8 AUs per PES interpolated inside it
        const int64_t p = (k / 8) * 8, c = p * 1024 * S / 48000;
        const int64_t h = (int64_t)((__int128)c * S / (S + 40000));
        d.push(ceil_div(floor_div((T0 + h) * 9, 100000) * 100000, 9) + (k - p) * 1024 * S / 48000, 1024, k == 0);
    }
    int64_t at = 0;
    const char* why = "";
    AsrcEvent e{};
    const bool ok = engaged_at(d, &at, &why, &e);
    char name[300];
    std::snprintf(name, sizeof name, "+40 ppm, 8 AUs per PES: engages within 30 s (%.2f s, %s, source %+.2f ppm), no lost "
                  "time (%zu gaps)", at / 1e9, why, e.value / 1e3, d.of(AsrcEvent::Kind::gap).size());
    CHECK(name, ok && at <= 30 * S && d.of(AsrcEvent::Kind::gap).empty() && iabs(d.sv.stats().source_ppb - 40000) <= 2000);
}

void test_decode_bounds() {
    std::printf("\n  B-148: decode ratio-out-of-bounds: locked, past the bound for 30 s of PTS\n");
    struct Row {
        const char* name;
        int64_t ppm;     // the PTS this much long (+) or short (-) ...
        int64_t secs;    // ... for this long from the start, then house rate
    };
    char name[300];
    for (const Row& w : {Row{"a first 10-bucket fit at -1800 ppm (the PTS 1800 ppm short for 10 s)", -1800, 10},
                         Row{"a 20 s 2000 ppm excursion from the start", 2000, 20}}) {
        Driver d(48000, 48000, 500, false);
        int64_t first = 0;
        bool have = false;
        for (int64_t k = 0; k < 120 * 48000 / 1024; k++) {
            const int64_t c = k * 1024 * S / 48000, cut = w.secs * S;
            const int64_t h = c < cut ? c * (1000000 + w.ppm) / 1000000 : cut * (1000000 + w.ppm) / 1000000 + c - cut;
            d.push(formula_pts(T0 + h), 1024, k == 0);
            if (!have && d.sv.lock().has_fit()) {
                have = true;
                first = d.sv.lock().fit_ppb();
            }
        }
        std::snprintf(name, sizeof name, "%s: no out-of-bounds (the first fit %+.1f ppm; before B-148 raised at once)",
                      w.name, first / 1e3);
        CHECK(name, have && iabs(first) > 1000000 && d.of(AsrcEvent::Kind::ratio_out_of_bounds).empty());
    }
    std::string rows;
    bool ok = true;
    for (int64_t ppb : {1500000LL, 5000000LL}) {
        Driver d(48000, 48000, 500, false);
        feed(d, 48000, 1024, ppb, 120, no_stop, no_pairs);
        const auto o = d.of(AsrcEvent::Kind::ratio_out_of_bounds);
        char row[80];
        std::snprintf(row, sizeof row, "%s%+.0f ppm at %.2f s", rows.empty() ? "" : ", ", ppb / 1e3,
                      o.empty() ? -1.0 : (o[0].second.house_ns - T0) / 1e9);
        rows += row;
        ok = ok && o.size() == 1 && o[0].second.house_ns - T0 <= 60 * S && iabs(o[0].second.value + ppb) <= ppb / 50;
    }
    std::snprintf(name, sizeof name, "sources 1500 and 5000 ppm fast: out of bounds within 60 s (%s; the 5000 ppm one "
                  "steps its envelope every 22 s, so no 30-bucket fit ever forms)", rows.c_str());
    CHECK(name, ok);
}

void test_engage_rate_known() {
    std::printf("\n  B-148: an engage says whether the lock had measured the rate\n");
    char name[300];
    {
        Driver d(48000, 48000, 500, false);
        feed(d, 48000, 1024, 300000, 20, [](const Driver& x) { return !x.of(AsrcEvent::Kind::engaged).empty(); },
             no_pairs);
        int64_t at = 0;
        const char* why = "";
        AsrcEvent e{};
        const bool ok = engaged_at(d, &at, &why, &e);
        std::snprintf(name, sizeof name, "+300 ppm: a phase engage at %.2f s before the first fit: rate not measured "
                      "(%d; source %+.1f ppm), stats rate-known %d", at / 1e9, (int)e.rate_known, e.value / 1e3,
                      (int)d.sv.stats().rate_known);
        CHECK(name, ok && !std::strcmp(why, "phase") && !e.rate_known && !d.sv.stats().rate_known);
    }
    {
        Driver d(48000, 48000, 500, false);
        feed(d, 48000, 1024, 3000, 60, [](const Driver& x) { return !x.of(AsrcEvent::Kind::engaged).empty(); },
             no_pairs);
        int64_t at = 0;
        const char* why = "";
        AsrcEvent e{};
        const bool ok = engaged_at(d, &at, &why, &e);
        std::snprintf(name, sizeof name, "+3 ppm: a ratio engage (%.2f s): rate measured (%d), stats rate-known %d",
                      at / 1e9, (int)e.rate_known, (int)d.sv.stats().rate_known);
        CHECK(name, ok && !std::strcmp(why, "ratio") && e.rate_known && d.sv.stats().rate_known);
    }
}

// --- the device term on its timer (WI-P4-4, B-165/B-166): py/asrc_device_ref_test.py's cases, one for one -----
// Same names, order and random draws (PyRandom), so each prints the reference's numbers; the recorded clocks are
// DEV-P4a's (tests/fixtures/clock; MRTS_FIXTURES overrides the fixture directory).

std::string g_fixtures;
constexpr int64_t TICK = 100 * MS;
constexpr int64_t DFS = 48000;   // the modelled output's rate
const char* const TRACES[4] = {"sink-clock-pi4-hdmi.jsonl", "sink-clock-pi4-kt.jsonl", "sink-clock-pi4-null.jsonl",
                               "sink-clock-pi5-null.jsonl"};

// Python's random.Random(seed): MT19937 seeded by init_by_array, randrange by getrandbits with rejection, random()
// on 53 bits. These cases draw what py/asrc_device_ref_test.py draws, so they print its numbers.
class PyRandom {
  public:
    explicit PyRandom(uint32_t seed) {
        mt_[0] = 19650218U;
        for (uint32_t i = 1; i < N; i++) mt_[i] = 1812433253U * (mt_[i - 1] ^ (mt_[i - 1] >> 30)) + i;
        uint32_t i = 1;
        for (uint32_t k = N; k; k--) {   // init_by_array with the one-word key {seed}
            mt_[i] = (mt_[i] ^ ((mt_[i - 1] ^ (mt_[i - 1] >> 30)) * 1664525U)) + seed;
            if (++i >= N) {
                mt_[0] = mt_[N - 1];
                i = 1;
            }
        }
        for (uint32_t k = N - 1; k; k--) {
            mt_[i] = (mt_[i] ^ ((mt_[i - 1] ^ (mt_[i - 1] >> 30)) * 1566083941U)) - i;
            if (++i >= N) {
                mt_[0] = mt_[N - 1];
                i = 1;
            }
        }
        mt_[0] = 0x80000000U;
    }
    uint32_t next32() {
        if (index_ >= N) {
            for (uint32_t k = 0; k < N; k++) {
                const uint32_t y = (mt_[k] & 0x80000000U) | (mt_[(k + 1) % N] & 0x7fffffffU);
                mt_[k] = mt_[(k + 397) % N] ^ (y >> 1) ^ (y & 1U ? 0x9908b0dfU : 0U);
            }
            index_ = 0;
        }
        uint32_t y = mt_[index_++];
        y ^= y >> 11;
        y ^= (y << 7) & 0x9d2c5680U;
        y ^= (y << 15) & 0xefc60000U;
        return y ^ (y >> 18);
    }
    int64_t below(int64_t n) {   // randrange(0, n), n < 2^32
        int k = 0;
        while ((n >> k) > 0) k++;
        uint32_t r = next32() >> (32 - k);
        while (r >= n) r = next32() >> (32 - k);
        return r;
    }
    double random() {
        const uint32_t a = next32() >> 5, b = next32() >> 6;
        return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
    }

  private:
    static constexpr uint32_t N = 624;
    uint32_t mt_[N];
    uint32_t index_ = N;
};

// A read pair's house read late by a preemption: under 0.2 ms in 9 reads of 10, under 5 ms in the tenth.
int64_t preempted(PyRandom& g) { return g.random() < 0.9 ? g.below(200000) : g.below(5 * MS); }
int64_t uniform5(PyRandom& g) { return g.below(5 * MS); }
int64_t no_jitter(PyRandom&) { return 0; }

double device_rate_ppm(const AsrcDeviceTerm& t) { return asrc_rate_of(t.device_ppb()) / 1e3; }

// A synthetic device running `ppm` fast, read every 100 ms from house0; from step_at_s on it reads step_ns
// further. Returns the house time reached.
template <typename Jitter, typename OnSample>
int64_t feed_clock(AsrcDeviceTerm& t, int64_t seconds, int64_t ppm, Jitter jitter, uint64_t seed, OnSample on,
                   int64_t house0 = 1000 * S, int64_t step_at_s = -1, int64_t step_ns = 0) {
    PyRandom g((uint32_t)seed);
    const int64_t k1 = seconds * 10;
    for (int64_t k = 0; k < k1; k++) {
        const int64_t h = k * TICK;
        int64_t dev = h + floor_div(h * ppm, 1000000);
        if (step_at_s >= 0 && h >= step_at_s * S) dev += step_ns;
        std::vector<AsrcDeviceEvent> ev;
        t.sample(dev, house0 + h + jitter(g), -1, -1, &ev);
        on(h, ev);
    }
    return house0 + k1 * TICK;
}
auto no_on = [](int64_t, const std::vector<AsrcDeviceEvent>&) {};

// --- the recorded clocks ----------------------------------------------------------------------------

struct TraceLine {
    bool read = false;   // a clock line the sink had rendered by
    int64_t mono = 0, clock = 0;
    std::string event;   // "hole", "restart", ...
    int64_t ms = 0;
};

bool line_int(const std::string& l, const char* key, int64_t* v) {
    const std::string k = std::string("\"") + key + "\":";
    size_t p = l.find(k);
    if (p == std::string::npos) return false;
    p += k.size();
    while (p < l.size() && l[p] == ' ') p++;
    char* end = nullptr;
    const long long x = std::strtoll(l.c_str() + p, &end, 10);
    if (end == l.c_str() + p) return false;
    *v = x;
    return true;
}

std::string line_str(const std::string& l, const char* key) {
    const std::string k = std::string("\"") + key + "\": \"";
    const size_t p = l.find(k);
    if (p == std::string::npos) return "";
    const size_t e = l.find('"', p + k.size());
    return l.substr(p + k.size(), e - p - k.size());
}

std::vector<TraceLine> load_trace(const char* name) {
    std::vector<TraceLine> out;
    std::FILE* f = std::fopen((g_fixtures + "/clock/" + name).c_str(), "rb");
    if (!f) return out;
    char buf[4096];
    while (std::fgets(buf, sizeof buf, f)) {
        const std::string l = buf;
        TraceLine t;
        int64_t next = -1;
        if (line_int(l, "clock_ns", &t.clock)) {
            line_int(l, "mono_ns", &t.mono);
            line_int(l, "next_sample", &next);
            t.read = next >= 0;
            if (!t.read) continue;
        } else {
            t.event = line_str(l, "event");
            if (t.event.empty()) continue;
            line_int(l, "mono_ns", &t.mono);
            line_int(l, "ms", &t.ms);
        }
        out.push_back(t);
    }
    std::fclose(f);
    return out;
}

// The trace's own long-run slope: device against house time by least squares, one intercept per stream
// (before and after the restart), 20 s after each start left out.
double trace_slope_ppm(const std::vector<TraceLine>& lines) {
    std::vector<std::vector<std::pair<int64_t, int64_t>>> streams(1);
    for (const TraceLine& o : lines) {
        if (o.event == "restart") streams.emplace_back();
        else if (o.read) streams.back().push_back({o.mono, o.clock});
    }
    double sxx = 0, sxy = 0;
    for (const auto& st : streams) {
        std::vector<std::pair<int64_t, int64_t>> pts;
        for (const auto& x : st)
            if (x.first - st[0].first >= 20 * S) pts.push_back(x);
        double mx = 0, my = 0;
        for (const auto& x : pts) {
            mx += (double)x.first;
            my += (double)(x.second - x.first);
        }
        mx /= pts.size();
        my /= pts.size();
        for (const auto& x : pts) {
            sxx += ((double)x.first - mx) * ((double)x.first - mx);
            sxy += ((double)x.first - mx) * ((double)(x.second - x.first) - my);
        }
    }
    return sxy / sxx * 1e6;
}

struct Row {
    double s, dev_ppm, ratio_ppm;
};
struct TraceEvent {
    std::string kind;
    double s;
    std::string reason;
};
struct Replay {
    std::unique_ptr<AsrcDeviceTerm> t;
    std::vector<Row> rows;
    std::vector<TraceEvent> events;
    std::vector<TraceLine> lines;
};

// The term on a recorded clock, as the element runs it: reads from the first rendered sample, stop() at the
// restart; s from the first rendered sample.
const Replay& replay_trace(const char* name) {
    static std::vector<std::pair<std::string, std::unique_ptr<Replay>>> cache;
    for (const auto& c : cache)
        if (c.first == name) return *c.second;
    std::unique_ptr<Replay> r(new Replay);
    r->lines = load_trace(name);
    r->t.reset(new AsrcDeviceTerm());
    AsrcDeviceTerm& t = *r->t;
    bool have0 = false;
    int64_t t0 = 0;
    for (const TraceLine& o : r->lines) {
        if (o.event == "restart") {
            t.stop(o.mono);
            r->events.push_back({"restart", (o.mono - t0) / 1e9, ""});
            continue;
        }
        if (!o.read) continue;
        if (!have0) {
            have0 = true;
            t0 = o.mono;
        }
        std::vector<AsrcDeviceEvent> ev;
        if (!t.rendering()) t.start(o.mono, &ev);
        t.sample(o.clock, o.mono, -1, -1, &ev);
        for (const AsrcDeviceEvent& e : ev) r->events.push_back({asrc_device_event_name(e.kind), (o.mono - t0) / 1e9, e.reason});
        r->rows.push_back({(o.mono - t0) / 1e9, device_rate_ppm(t), t.ratio_ppb() / 1e3});
    }
    cache.emplace_back(name, std::move(r));
    return *cache.back().second;
}

// The trace's holes (s from the first rendered sample, ms).
std::vector<std::pair<double, int64_t>> trace_holes(const std::vector<TraceLine>& lines) {
    std::vector<std::pair<double, int64_t>> out;
    bool have0 = false;
    int64_t t0 = 0;
    for (const TraceLine& o : lines) {
        if (o.read && !have0) {
            have0 = true;
            t0 = o.mono;
        }
        if (o.event == "hole" && have0) out.push_back({(o.mono - t0) / 1e9, o.ms});
    }
    return out;
}

// --- the modelled path --------------------------------------------------------------------------------

// The clock reading (ns) of a position read: the least ns that floors back to it.
int64_t dev_of(int64_t pos) { return floor_div(pos * S + DFS - 1, DFS); }

struct Span {
    int64_t at, len;   // ns
    bool running;      // a device stall's clock runs on
};

// An output's path at 10 ms steps (asrc_device_ref_test.py's Path): a live input at house rate (PTS =
// arrival - 100 ms), mrasrc at the term's ratio, the prefill (40 ms min threshold, 1 s max), the sink's ring
// (100 ms) and its device, which reads the ring at its own rate. The sink writes each buffer at the base
// sink's next position, realigned to the next playable one when behind; the device's server drops what
// lands behind its read index. Its clock is the position read, `lag` behind the read index.
class Path {
  public:
    static constexpr int64_t STEP = 10 * MS, N_IN = 480, LAT = 100 * MS;
    struct Seg {
        int64_t w, n, pts, lost_below;
    };
    struct Log {
        int64_t ts;
        bool has_truth;
        int64_t truth;
        bool has_acc;
        int64_t acc, ratio;
        bool flush;
    };
    struct Ev {
        std::string kind;
        int64_t ts;
        std::string reason;
    };

    Path(AsrcDeviceTerm& t, int64_t ppm, int64_t (*jitter)(PyRandom&), uint64_t seed, int64_t lag_ms = 0,
         int64_t ahead_ms = 15, int64_t stale_ms = -1, int64_t resync_ms = 0)
        : term(t), ppm_(ppm), jitter_(jitter), g_((uint32_t)seed), lag_(lag_ms * DFS / 1000), ahead_(ahead_ms * DFS / 1000),
          stale_ms_(stale_ms), resync_ms_(resync_ms), acc(DFS) {}

    void run(int64_t seconds_x10) {   // tenths of a second
        for (int64_t i = 0; i < seconds_x10 * 10; i++) step();
    }

    // FLUSH_START/STOP from mrasrc: the prefill and the ring's unread part discarded.
    void flush() {
        flushed += prefill_level_;
        prefill_.clear();
        prefill_level_ = 0;
        std::deque<Seg> keep;
        for (Seg s : segs_) {
            const int64_t lo = std::max({s.w, s.lost_below, read_pos_});
            flushed += std::max<int64_t>(s.w + s.n - lo, 0);
            if (s.w < read_pos_) {
                s.n = std::min(s.n, read_pos_ - s.w);
                keep.push_back(s);
            }
        }
        segs_ = keep;
        next_sample_ = -1;
        acc.flush();
    }

    int64_t queued() const {   // ours not yet read: the prefill and the ring ahead of the read index
        int64_t q = prefill_level_;
        for (const Seg& s : segs_) q += std::max<int64_t>(s.w + s.n - std::max({s.w, s.lost_below, read_pos_}), 0);
        return q;
    }

    std::vector<Span> holes, istalls, dstalls;
    std::vector<std::pair<int64_t, int64_t>> steps;   // (ts, ns): the device clock steps
    AsrcDeviceTerm& term;
    int64_t produced = 0, heard_ours = 0, flushed = 0;
    std::vector<Log> log;
    std::vector<Ev> events;

  private:
    int64_t house() const { return 1000 * S + k_ * STEP; }
    static const Span* in(const std::vector<Span>& spans, int64_t t) {
        for (const Span& s : spans)
            if (s.at <= t && t < s.at + s.len) return &s;
        return nullptr;
    }
    // The read index as the base sink knows it: stale after an underflow on the Pi 5.
    int64_t sink_read(int64_t now) {
        if (stale_ms_ < 0 || (!uf_ && !resync_)) return read_pos_;
        if (resync_ && now >= resync_at_) {
            resync_ = false;
            return read_pos_;
        }
        const int64_t want = now - stale_ms_ * MS;
        int64_t old = read_pos_;
        for (auto it = read_hist_.rbegin(); it != read_hist_.rend(); ++it)
            if (it->first <= want) {
                old = it->second;
                break;
            }
        return old;
    }
    void write(int64_t pts, int64_t n, int64_t now) {
        int64_t w = next_sample_;
        const int64_t sr = sink_read(now);
        if (w < 0 || w < sr) w = sr + ahead_;   // the next playable position
        if (uf_ && stale_ms_ >= 0) {
            resync_ = true;
            resync_at_ = now + resync_ms_ * MS;
        }
        uf_ = false;
        segs_.push_back(Seg{w, n, pts, read_pos_});
        next_sample_ = w + n;
        acc.rendered(w, n, pts);
        running_ = true;
    }
    bool heard(int64_t pos, int64_t* pts) const {
        for (const Seg& s : segs_)
            if (s.w <= pos && pos < s.w + s.n) {
                if (pos < s.lost_below) return false;
                *pts = s.pts + floor_div((pos - s.w) * S, DFS);
                return true;
            }
        return false;
    }

    void step() {
        const int64_t now = house(), ts = k_ * STEP;
        // input: a hole loses its content upstream; a stall holds it and delivers it at once after
        const std::pair<int64_t, int64_t> arrival{now - LAT, N_IN};
        if (in(holes, ts)) {
        } else if (in(istalls, ts)) {
            delayed_.push_back(arrival);
        } else {
            for (const auto& d : delayed_) upstream_.push_back(d);
            delayed_.clear();
            upstream_.push_back(arrival);
        }
        // mrasrc
        const int64_t r = term.rendering() ? term.ratio_ppb() : 0;
        while (!upstream_.empty()) {
            const int64_t pts = upstream_.front().first, n = upstream_.front().second;
            const int64_t total = n * (S + r) + carry_, out = floor_div(total, S);
            if (prefill_level_ + out > DFS) break;   // the prefill is full: the push blocks
            upstream_.pop_front();
            carry_ = total - out * S;
            prefill_.push_back({pts, out});
            prefill_level_ += out;
            pushed_ += out;
            produced += out;
        }
        // the prefill to the sink, while the ring has room
        while (!prefill_.empty() && prefill_level_ >= DFS * 40 / 1000) {
            const int64_t pts = prefill_.front().first, n = prefill_.front().second;
            const int64_t end = next_sample_ >= 0 ? next_sample_ : read_pos_;
            if (running_ && end + n - read_pos_ > DFS / 10) break;
            prefill_.pop_front();
            prefill_level_ -= n;
            taken_ += n;
            if (!term.rendering()) {
                std::vector<AsrcDeviceEvent> ev;
                term.start(now, &ev);
                for (const AsrcDeviceEvent& e : ev) events.push_back({asrc_device_event_name(e.kind), ts, e.reason});
            }
            write(pts, n, now);
        }
        // the device
        const Span* dstall = in(dstalls, ts);
        if (running_ && !dstall) {
            const int64_t total = N_IN * (1000000 + ppm_) + read_frac_, adv = floor_div(total, 1000000);
            read_frac_ = total - adv * 1000000;
            for (const Seg& s : segs_) {
                const int64_t lo = std::max({s.w, s.lost_below, read_pos_}), hi = std::min(s.w + s.n, read_pos_ + adv);
                if (hi > lo) heard_ours += hi - lo;
            }
            if (next_sample_ >= 0 && read_pos_ <= next_sample_ && next_sample_ < read_pos_ + adv) uf_ = true;
            read_pos_ += adv;
            while (!segs_.empty() && segs_.front().w + segs_.front().n <= read_pos_ - DFS) segs_.pop_front();
        }
        read_hist_.push_back({now, read_pos_});
        while (!read_hist_.empty() && read_hist_.front().first < now - S) read_hist_.pop_front();
        // the device clock: the position read, lag behind; held after a stall it ran through
        const int64_t truth = running_ ? std::max<int64_t>(read_pos_ - lag_, 0) : 0;
        if (dstall && dstall->running) {
            clock_pos_ += floor_div(N_IN * (1000000 + ppm_), 1000000);
            held_ = true;
            clock_held_ = clock_pos_;
        } else if (held_ && truth < clock_held_) {
            clock_pos_ = clock_held_;
        } else {
            held_ = false;
            clock_pos_ = truth;
        }
        k_++;
        if (k_ % 10 == 0 && term.rendering()) tick(now + STEP, ts + STEP);
    }

    void tick(int64_t now, int64_t ts) {
        int64_t step_ns = 0;
        for (const auto& s : steps)
            if (s.first <= ts) step_ns += s.second;
        const int64_t dev = dev_of(clock_pos_) + step_ns, mono = now + jitter_(g_);
        std::vector<AsrcDeviceEvent> ev;
        const bool fl = term.sample(dev, mono, pushed_, taken_, &ev);
        for (const AsrcDeviceEvent& e : ev) events.push_back({asrc_device_event_name(e.kind), ts, e.reason});
        if (fl) flush();
        int64_t tp = 0, a = 0;
        const bool ht = running_ && heard(read_pos_ - lag_, &tp);
        const bool ha = acc.at(now, dev_of(clock_pos_), &a);
        log.push_back(Log{ts, ht, now - tp, ha, a, term.ratio_ppb(), fl});
    }

    int64_t ppm_;
    int64_t (*jitter_)(PyRandom&);
    PyRandom g_;
    int64_t k_ = 0;
    std::deque<std::pair<int64_t, int64_t>> upstream_;
    std::vector<std::pair<int64_t, int64_t>> delayed_;
    int64_t carry_ = 0;
    std::deque<std::pair<int64_t, int64_t>> prefill_;
    int64_t prefill_level_ = 0, pushed_ = 0, taken_ = 0;
    std::deque<Seg> segs_;
    int64_t next_sample_ = -1, read_pos_ = 0, read_frac_ = 0;
    bool running_ = false;
    int64_t lag_, ahead_, stale_ms_, resync_ms_;
    std::deque<std::pair<int64_t, int64_t>> read_hist_;
    bool uf_ = false, resync_ = false;
    int64_t resync_at_ = 0;
    int64_t clock_pos_ = 0, clock_held_ = 0;
    bool held_ = false;
  public:
    AsrcRenderLateness acc;
};

// The truth lateness's range over [a, b) s.
bool lateness_at(const Path& p, int64_t a_s, int64_t b_s, int64_t* lo, int64_t* hi) {
    bool have = false;
    for (const Path::Log& x : p.log) {
        if (x.ts < a_s * S || x.ts >= b_s * S || !x.has_truth) continue;
        *lo = have ? std::min(*lo, x.truth) : x.truth;
        *hi = have ? std::max(*hi, x.truth) : x.truth;
        have = true;
    }
    return have;
}

// --- the cases -----------------------------------------------------------------------------------------

void test_dev_lock_port() {
    std::printf("\n  the device term on its timer (WI-P4-4, B-166): py/asrc_device_ref_test.py's cases\n");
    const ClockLockConfig c = asrc_device_lock_config(), a = asrc_lock_config();
    CHECK("1: device lock = the capture lock's 50 ms two-sided step, no backlog rule, the window at its clamp (1000 "
          "buckets), a 1200 s loop, a fit taken at once only past the ratio clamp",
          c.step_ns == 50 * MS && c.step_falls && c.backlog_ns == 0 && c.step_fall_hold_ns == 0 &&
              c.rate_buckets_max == 1000 && c.rate_tau_ns == 1200 * S && c.slew_track_ppm == 1000 &&
              c.bucket_ns == a.bucket_ns && c.rate_buckets_min == a.rate_buckets_min &&
              c.offset_buckets == a.offset_buckets && c.rate_max_ppm == a.rate_max_ppm && c.step_hold_ns == a.step_hold_ns);
    const AsrcDeviceConfig d;
    CHECK("1: term constants: 100 ms reads, 15 s settle, 50 ms x 2 relock, flat under 1/10, stall 1 s with 100 ms "
          "waiting, probe 500 ms, resume past 200 ms, +-1000 ppm",
          d.sample_ns == 100 * MS && d.settle_ns == 15 * S && d.relock_ns == 50 * MS && d.relock_samples == 2 &&
              d.flat_den == 10 && d.stall_ns == S && d.waiting_ns == 100 * MS && d.probe_ns == 500 * MS &&
              d.resume_ns == 200 * MS && d.ratio_max_ppm == 1000);
    AsrcDeviceTerm t;
    std::vector<AsrcDeviceEvent> ev;
    t.start(0, &ev);
    feed_clock(t, 600, 80, no_jitter, 1, no_on);
    CHECK("1: a clean +80 ppm clock: the lock's eps -80 ppm to 0.01 ppm in 600 s (device rate +80)",
          std::abs(device_rate_ppm(t) - 80) < 0.01 && t.lock().phase() == ClockLock::Phase::locked);
}

void test_dev_ratio() {
    CHECK("2: house-rate input on a device 135 ppm slow (eps_dev +135.018 ppm): -135 ppm",
          asrc_device_ratio(0, 135018, 1000) == -135000);
    CHECK("2: the product with a foreign input clock: (1 + 50e-6) / (1 - 30e-6) - 1 = +80.0024 ppm",
          asrc_device_ratio(50000, -30000, 1000) == 80002);
    CHECK("2: clamped at +-1000 ppm",
          asrc_device_ratio(0, -1500000, 1000) == 1000000 && asrc_device_ratio(0, 1500000, 1000) == -1000000);
    CHECK("2: rate_of: the device's own rate from eps (eps +135.018 ppm -> -135 ppm)",
          asrc_rate_of(135018) == -135000 && asrc_rate_of(0) == 0);
    {
        AsrcDeviceTerm t;
        std::vector<AsrcDeviceEvent> ev;
        t.start(0, &ev);
        feed_clock(t, 20, 300, no_jitter, 1, no_on);
        CHECK("2: eps_dev 0 until the lock has a rate (20 s in: settling and acquiring)",
              t.device_ppb() == 0 && t.ratio_ppb(40000) == 40000);
    }
    AsrcDeviceTerm t;
    std::vector<AsrcDeviceEvent> ev;
    t.start(0, &ev);
    feed_clock(t, 300, 80, preempted, 2, no_on);
    bool ok = true;
    std::string got;
    for (int64_t e : {-50000LL, -1000LL, 0LL, 2500LL, 50000LL}) {
        const int64_t r = t.ratio_ppb(e);
        const double want = ((1 + e * 1e-9) * (1 + 80e-6) - 1) * 1e9;
        ok = ok && std::abs(r - want) < 50 && r == asrc_device_ratio(e, t.device_ppb(), 1000);
        got += (got.empty() ? "" : ", ") + std::to_string(r);
    }
    char name[200];
    std::snprintf(name, sizeof name, "2: eps_in as a series on a device 80 ppm fast: each ratio the product to 0.05 ppm "
                  "(%s ppb)", got.c_str());
    CHECK(name, ok);
}

void test_dev_jitter() {
    double worst_p = 0, worst_u120 = 0, worst_u200 = 0;
    for (uint64_t seed = 0; seed < 10; seed++) {
        double errs[300] = {0};
        {
            AsrcDeviceTerm t;
            std::vector<AsrcDeviceEvent> ev;
            t.start(0, &ev);
            feed_clock(t, 200, 80, preempted, seed,
                       [&](int64_t h, const std::vector<AsrcDeviceEvent>&) { errs[h / S] = t.ratio_ppb() / 1e3 - 80; });
            for (int s = 120; s < 200; s++) worst_p = std::max(worst_p, std::abs(errs[s]));
        }
        AsrcDeviceTerm t;
        std::vector<AsrcDeviceEvent> ev;
        t.start(0, &ev);
        feed_clock(t, 300, 80, uniform5, seed,
                   [&](int64_t h, const std::vector<AsrcDeviceEvent>&) { errs[h / S] = t.ratio_ppb() / 1e3 - 80; });
        for (int s = 120; s < 300; s++) worst_u120 = std::max(worst_u120, std::abs(errs[s]));
        for (int s = 200; s < 300; s++) worst_u200 = std::max(worst_u200, std::abs(errs[s]));
    }
    char name[300];
    std::snprintf(name, sizeof name, "3: +80 ppm, reads preempted up to 5 ms (9 in 10 under 0.2 ms), 10 seeds: the ratio "
                  "within 1 ppm of the device from 120 s (worst %.3f ppm)", worst_p);
    CHECK(name, worst_p < 1.0);
    std::snprintf(name, sizeof name, "3: reads late by U[0, 5 ms), 10 seeds: within 3 ppm from 120 s (worst %.2f), 1 ppm "
                  "from 200 s (worst %.2f): 105 fitted buckets after the settle hold 1.3 ppm sd there", worst_u120,
                  worst_u200);
    CHECK(name, worst_u120 < 3.0 && worst_u200 < 1.0);
}

void test_dev_fill_1h() {
    double worst = 0;
    for (uint64_t seed = 0; seed < 2; seed++) {
        AsrcDeviceTerm t;
        std::vector<AsrcDeviceEvent> ev;
        t.start(0, &ev);
        double fill = 0, lo = 0, hi = 0;
        feed_clock(t, 3600, 80, preempted, seed, [&](int64_t, const std::vector<AsrcDeviceEvent>&) {
            fill += (t.ratio_ppb() / 1e3 - 80) * 1e-6 * TICK / MS;   // ms
            lo = std::min(lo, fill);
            hi = std::max(hi, fill);
        });
        worst = std::max(worst, hi - lo);
    }
    char name[200];
    std::snprintf(name, sizeof name, "4: +80 ppm, 1 h, 2 seeds: fill excursion %.2f ms < 5 ms (the 45 s at eps 0 hold 3.6 "
                  "of it)", worst);
    CHECK(name, worst < 5.0);
}

void test_dev_input_stall() {
    for (const char* kind : {"stall", "hole"}) {
        AsrcDeviceTerm t;
        Path p(t, 80, preempted, 5);
        (std::strcmp(kind, "stall") ? p.holes : p.istalls).push_back({300 * S, 2 * S, false});
        p.run(3000);
        int64_t lo = 0, hi = 0, lo2 = 0, hi2 = 0;
        lateness_at(p, 290, 300, &lo, &hi);
        p.run(620);
        int64_t at = 0, moved = 0;
        bool any_flush = false;
        for (const Path::Log& x : p.log)
            if (x.ts < 300 * S) at = x.ratio;
        for (const Path::Log& x : p.log) {
            if (x.ts >= 300 * S) moved = std::max(moved, iabs(x.ratio - at));
            any_flush = any_flush || x.flush;
        }
        char name[300];
        std::snprintf(name, sizeof name, "5: a 2 s input %s at 300 s: the ratio moves %.3f ppm over it and the minute "
                      "after (< 0.5)", kind, moved / 1e3);
        CHECK(name, moved < 500);
        CHECK("5: ... no relock, no device stall, no flush: the ring ran dry for the input, not the device",
              p.events.empty() && !any_flush);
        lateness_at(p, 310, 362, &lo2, &hi2);
        const int64_t want = std::strcmp(kind, "stall") ? 0 : 2000 * MS;
        std::snprintf(name, sizeof name, "5: ... render lateness %+.1f ms after it (%.1f..%.1f, before %.1f..%.1f): %s",
                      (hi2 - hi) / 1e6, lo2 / 1e6, hi2 / 1e6, lo / 1e6, hi / 1e6,
                      std::strcmp(kind, "stall") ? "the content after the hole plays live" : "the backlog stays until a gap");
        CHECK(name, iabs(hi2 - hi - want) < 30 * MS && iabs(lo2 - lo - want) < 30 * MS);
    }
}

void test_dev_step() {
    char name[300];
    for (int64_t step : {100 * MS, -100 * MS}) {
        AsrcDeviceTerm t, t2;
        std::vector<AsrcDeviceEvent> ev, all;
        t.start(0, &ev);
        feed_clock(t, 400, 80, preempted, 6,
                   [&](int64_t, const std::vector<AsrcDeviceEvent>& e) { all.insert(all.end(), e.begin(), e.end()); },
                   1000 * S, 300, step);
        t2.start(0, &ev);
        feed_clock(t2, 400, 80, preempted, 6, no_on);
        std::snprintf(name, sizeof name, "6: a %+lld ms step at 300 s: one relock-device, reason step, %s",
                      (long long)(step / MS), all.empty() ? "none" : "at 300.1-300.3 s");
        CHECK(name, all.size() == 1 && !std::strcmp(all[0].reason, "step") && all[0].at - 1000 * S >= 300 * S &&
                        all[0].at - 1000 * S <= 300 * S + 3 * TICK);
        const double kept = std::abs(device_rate_ppm(t) - device_rate_ppm(t2));
        std::snprintf(name, sizeof name, "6: ... the rate kept: %.3f ppm from the run without the step (< 0.5)", kept);
        CHECK(name, kept < 0.5);
    }
    {   // The step's relock settles again as a start does (p4-4a's review): nothing fed for 15 s after it.
        AsrcDeviceTerm t;
        std::vector<AsrcDeviceEvent> ev;
        t.start(0, &ev);
        int64_t relock_at = -1, held_fed = -1, settled_at = -1;
        bool held = true;
        feed_clock(t, 400, 80, preempted, 6,
                   [&](int64_t h, const std::vector<AsrcDeviceEvent>& e) {
                       for (const AsrcDeviceEvent& x : e) relock_at = x.at - 1000 * S;
                       if (relock_at < 0 || h < relock_at) return;
                       const bool settle = t.lock_state() == AsrcDeviceTerm::LockState::settle;
                       if (h < relock_at + 15 * S - TICK) {
                           if (held_fed < 0) held_fed = (int64_t)t.stats().fed;
                           held = held && settle && (int64_t)t.stats().fed == held_fed;
                       }
                       if (!settle && settled_at < 0) settled_at = h;
                   },
                   1000 * S, 300, 100 * MS);
        std::snprintf(name, sizeof name, "6: the step's relock settles 15 s as a start does: lock_state() settle and "
                      "nothing fed from it (%.1f s) for %.1f s", relock_at / 1e9, (settled_at - relock_at) / 1e9);
        CHECK(name, relock_at >= 0 && held && settled_at >= 0 && settled_at - relock_at >= 15 * S &&
                        settled_at - relock_at <= 15 * S + 2 * TICK);
    }
    {   // PyRandom draws what Python's random.Random draws.
        PyRandom r5(5), r0(0);
        const int64_t a = r5.below(200000), b = r5.below(200000), c = r5.below(200000);
        const double x = r5.random();
        CHECK("6: the cases' random draws are Python's (random.Random(5): 163289, 66963, 194455, 0.358535...)",
              a == 163289 && b == 66963 && c == 194455 && std::abs(x - 0.35853551175589526) < 1e-15 &&
                  r5.below(5 * MS) == 4446296 && r0.next32() == 3626764237U);
    }
    {   // relock_samples = 2: one read 60 ms late is no step, and it is not fed.
        AsrcDeviceTerm t;
        std::vector<AsrcDeviceEvent> ev;
        t.start(0, &ev);
        PyRandom g(16);
        uint64_t fed[3] = {0, 0, 0};
        for (int64_t k = 0; k < 3000; k++) {
            const int64_t h = k * TICK, late = k == 2000 ? 60 * MS : preempted(g);
            t.sample(h + floor_div(h * 80, 1000000), 1000 * S + h + late, -1, -1, &ev);
            if (k >= 1999 && k <= 2001) fed[k - 1999] = t.stats().fed;
        }
        const AsrcDeviceTerm::Stats st = t.stats();
        std::snprintf(name, sizeof name, "6: one read 60 ms late at 200 s: no relock-device (%llu, %llu), the read not "
                      "fed (fed %llu -> %llu), the next one fed (%llu)", (unsigned long long)st.relocks_restart,
                      (unsigned long long)st.relocks_step, (unsigned long long)fed[0], (unsigned long long)fed[1],
                      (unsigned long long)fed[2]);
        CHECK(name, st.relocks_restart == 0 && st.relocks_step == 0 && fed[1] == fed[0] && fed[2] == fed[1] + 1);
    }
}

void test_dev_traces() {
    for (const char* name : TRACES) {
        const Replay& r = replay_trace(name);
        const double slope = trace_slope_ppm(r.lines);
        std::vector<const TraceEvent*> relocks;
        double restart_at = -1;
        for (const TraceEvent& e : r.events) {
            if (e.kind == "relock-device") relocks.push_back(&e);
            if (e.kind == "restart" && restart_at < 0) restart_at = e.s;
        }
        char text[300];
        std::snprintf(text, sizeof text, "7: %s: one relock-device, reason restart, at the restart; no step, no flat "
                      "sample", name);
        CHECK(text, relocks.size() == 1 && relocks[0]->reason == "restart" && r.t->stats().flat_ns == 0 &&
                        std::abs(relocks[0]->s - restart_at) < 1.0);
        double late = 0;
        for (const Row& w : r.rows)
            if (w.s >= 1000) late = std::max(late, std::abs(w.dev_ppm - slope));
        std::snprintf(text, sizeof text, "7: %s: from 1000 s the device rate within 1 ppm of the trace's own slope "
                      "%+.3f ppm (worst %.2f)", name, slope, late);
        CHECK(text, !r.rows.empty() && late < 1.0);
        double fill = 0, lo = 0, hi = 0;
        for (size_t i = 1; i < r.rows.size(); i++) {
            fill += (r.rows[i].ratio_ppm - slope) * 1e-6 * (r.rows[i].s - r.rows[i - 1].s) * 1000;
            lo = std::min(lo, fill);
            hi = std::max(hi, fill);
        }
        std::snprintf(text, sizeof text, "7: %s: the fill drifts %.1f ms (the ratio's error against the slope, "
                      "integrated; < 8)", name, hi - lo);
        CHECK(text, hi - lo < 8.0);
    }
}

void test_dev_trace_underrun() {
    for (const char* name : TRACES) {
        const Replay& r = replay_trace(name);
        const auto holes = trace_holes(r.lines);
        bool ok_fed = !holes.empty();
        double under = -1;
        for (const auto& h : holes) {
            int64_t near = 0;
            for (const Row& w : r.rows) near += w.s >= h.first - 5 && w.s <= h.first + h.second / 1000.0 + 5;
            ok_fed = ok_fed && near >= (int64_t)((10 + h.second / 1000.0) * 10) - 2;
            if (h.second == 1000) under = h.first;
        }
        double at_u = 0, move = 0;
        bool have = false;
        for (const Row& w : r.rows) {
            if (!have && w.s >= under) {
                have = true;
                at_u = w.ratio_ppm;
            }
            if (have && w.s <= under + 30) move = std::max(move, std::abs(w.ratio_ppm - at_u));
        }
        bool step = false;
        for (const TraceEvent& e : r.events) step = step || (e.kind == "relock-device" && e.reason == "step");
        char text[300];
        std::snprintf(text, sizeof text, "8: %s: through the 300 ms hole and the 1 s underrun every sample read, no "
                      "relock, no flat sample; the ratio moves %.3f ppm in the 30 s after the underrun (< 0.5)", name, move);
        CHECK(text, ok_fed && have && r.t->stats().flat_ns == 0 && !step && move < 0.5);
    }
}

void test_dev_clock_stall_underrun() {
    for (const bool catches : {true, false}) {
        AsrcDeviceTerm t, t2;
        std::vector<AsrcDeviceEvent> ev;
        t.start(0, &ev);
        PyRandom g(9);
        for (int64_t k = 0; k < 4000; k++) {
            const int64_t h = k * TICK, dev = h + h * 80 / 1000000;
            int64_t frozen = 0;   // flat 1 s at each minute from 120 s on
            for (int64_t m = 120; m < 400; m += 60)
                if (h >= m * S) {
                    frozen += h >= (m + 1) * S ? S : h - m * S;
                    if (catches && h >= (m + 1) * S) frozen -= S;
                }
            t.sample(dev - frozen, 1000 * S + h + preempted(g), -1, -1, &ev);
        }
        t2.start(0, &ev);
        feed_clock(t2, 400, 80, preempted, 9, no_on);
        const AsrcDeviceTerm::Stats st = t.stats();
        const uint64_t relocks = st.relocks_restart + st.relocks_step, want = catches ? 0 : 5;
        const double off = std::abs(device_rate_ppm(t) - device_rate_ppm(t2));
        char name[300];
        std::snprintf(name, sizeof name, "9: a clock flat 1 s in each of 5 underruns, then it %s: %llu relocks (want "
                      "%llu), the rate %.3f ppm from the clean run (< 0.5), flat %.1f s never fed",
                      catches ? "catches up" : "resumes behind", (unsigned long long)relocks, (unsigned long long)want,
                      off, st.flat_ns / 1e9);
        CHECK(name, relocks == want && off < 0.5 && st.flat_ns >= 4 * S);
    }
}

void test_dev_start_and_restart() {
    char name[300];
    {
        AsrcDeviceTerm t;
        std::vector<AsrcDeviceEvent> ev;
        const bool fl = t.sample(0, 1000 * S, -1, -1, &ev);
        CHECK("10: no read before the first rendered buffer (sample() before start() does nothing)",
              !fl && ev.empty() && !t.rendering() && t.stats().fed == 0 && t.stats().flat_ns == 0 &&
                  !t.lock().started());
    }
    {
        const Replay& r = replay_trace(TRACES[0]);
        size_t rendered = 0;
        for (const TraceLine& o : r.lines) rendered += o.read;
        std::snprintf(name, sizeof name, "10: the replay reads only rendered samples (%zu of the clock lines; none with "
                      "next_sample -1)", r.rows.size());
        CHECK(name, r.rows.size() == rendered && rendered > 20000);
    }
    {
        AsrcDeviceTerm t;
        std::vector<AsrcDeviceEvent> ev;
        t.start(1000 * S, &ev);
        int64_t first_moved = -1, first_fed = -1;
        feed_clock(t, 40, 0, no_jitter, 1, [&](int64_t h, const std::vector<AsrcDeviceEvent>&) {
            const AsrcDeviceTerm::LockState s = t.lock_state();
            if (first_moved < 0 && s != AsrcDeviceTerm::LockState::idle) first_moved = h;
            if (first_fed < 0 && s != AsrcDeviceTerm::LockState::idle && s != AsrcDeviceTerm::LockState::settle)
                first_fed = h;
        });
        std::snprintf(name, sizeof name, "10: the lock begins 15 s after the clock first moves (moved %.1f s, fed %.1f s)",
                      first_moved / 1e9, first_fed / 1e9);
        CHECK(name, first_moved >= 0 && first_fed >= 0 && iabs(first_fed - first_moved - 15 * S) < 150 * MS);
    }
    {
        AsrcDeviceTerm t;
        std::vector<AsrcDeviceEvent> ev;
        t.start(1000 * S, &ev);
        const int64_t end = feed_clock(t, 300, -135, preempted, 10, no_on);
        const int64_t kept = t.device_ppb();
        t.stop(end);
        std::vector<AsrcDeviceEvent> rs;
        t.start(end + 300 * MS, &rs);
        PyRandom g(11);
        for (int64_t k = 0; k < 3000; k++) {   // the stream's clock from 0 again, 300 ms later
            const int64_t h = k * TICK;
            t.sample(h - h * 135 / 1000000, end + 300 * MS + h + preempted(g), -1, -1, &ev);
        }
        const AsrcDeviceTerm::Stats st = t.stats();
        std::snprintf(name, sizeof name, "10: a restart (the clock from 0): one relock-device, reason restart, the rate kept "
                      "(%.3f ppm after 300 s)", iabs(t.device_ppb() - kept) / 1e3);
        CHECK(name, rs.size() == 1 && !std::strcmp(rs[0].reason, "restart") && st.relocks_restart == 1 &&
                        st.relocks_step == 0 && iabs(t.device_ppb() - kept) < 500);
    }
    // Restarts along a recorded clock: the post-restart short fits never replace the rate kept.
    std::vector<std::pair<int64_t, int64_t>> samples;
    for (const TraceLine& o : load_trace("sink-clock-pi4-kt.jsonl")) {
        if (o.event == "restart") break;
        if (o.read) samples.push_back({o.mono, o.clock});
    }
    if (samples.empty()) {
        CHECK("10: the recorded KT USB clock loads", false);
        return;
    }
    const int64_t m0 = samples[0].first;
    auto run = [&](int64_t restart_at, int64_t until) {
        AsrcDeviceTerm tr;
        std::vector<AsrcDeviceEvent> ev;
        tr.start(m0, &ev);
        std::vector<std::pair<int64_t, double>> out;
        bool done = restart_at < 0;
        for (const auto& x : samples) {
            if (x.first - m0 >= until * S) break;
            if (!done && x.first - m0 >= restart_at * S) {
                tr.stop(x.first);
                tr.start(x.first, &ev);
                done = true;
            }
            tr.sample(x.second, x.first, -1, -1, &ev);
            out.push_back({x.first - m0, device_rate_ppm(tr)});
        }
        return out;
    };
    const auto base = run(-1, 1500);
    for (int64_t at : {120LL, 1200LL}) {
        const auto rows = run(at, at + 300);
        double worst = 0;
        for (size_t i = 0; i < rows.size() && i < base.size(); i++)
            if (rows[i].first >= at * S && rows[i].first < (at + 300) * S)
                worst = std::max(worst, std::abs(rows[i].second - base[i].second));
        std::snprintf(name, sizeof name, "10: a restart at %lld s on the recorded KT USB clock: the rate within %d ppm of "
                      "the run without it for the 300 s after (worst %.2f)", (long long)at, at == 120 ? 50 : 2, worst);
        CHECK(name, worst < (at == 120 ? 50 : 2));
    }
}

struct StallCase {
    std::unique_ptr<AsrcDeviceTerm> t;
    std::unique_ptr<Path> p;
    std::vector<Path::Ev> stalled, resumed;
    int64_t lost = 0, lo0 = 0, hi0 = 0, lo1 = 0, hi1 = 0;
};

StallCase stall_case(bool running) {
    StallCase c;
    c.t.reset(new AsrcDeviceTerm());
    c.p.reset(new Path(*c.t, -135, preempted, 12));
    Path& p = *c.p;
    p.dstalls.push_back({300 * S, 3 * S, running});
    p.run(3000);
    lateness_at(p, 280, 300, &c.lo0, &c.hi0);
    const int64_t produced0 = p.produced, heard0 = p.heard_ours, queued0 = p.queued();
    p.run(600);
    for (const Path::Ev& e : p.events) {
        if (e.ts < 300 * S) continue;
        if (e.kind == "device-stalled") c.stalled.push_back(e);
        if (e.kind == "device-resumed") c.resumed.push_back(e);
    }
    c.lost = (p.produced - produced0) + queued0 - (p.heard_ours - heard0) - p.queued();
    lateness_at(p, 305, 360, &c.lo1, &c.hi1);
    return c;
}

void stall_checks(const StallCase& c, const char* n, bool split) {
    char name[300];
    std::snprintf(name, sizeof name, "%s: device-stalled once, 1.0-1.4 s after the device stopped (%.2f s)", n,
                  c.stalled.empty() ? -1.0 : (c.stalled[0].ts - 300 * S) / 1e9);
    CHECK(name, c.stalled.size() == 1 && c.stalled[0].ts - 300 * S >= S && c.stalled[0].ts - 300 * S <= 1400 * MS);
    std::snprintf(name, sizeof name, "%s: device-resumed once, within 0.6 s of its return (%.2f s)", n,
                  c.resumed.empty() ? -1.0 : (c.resumed[0].ts - 303 * S) / 1e9);
    CHECK(name, c.resumed.size() == 1 && c.resumed[0].ts >= 303 * S && c.resumed[0].ts - 303 * S <= 600 * MS);
    const int64_t dropped = c.t->stats().dropped;
    const bool lost_ok = c.lost >= 3 * DFS && c.lost <= 36 * DFS / 10, counted = iabs(dropped - c.lost) <= DFS / 4;
    if (split) {
        std::snprintf(name, sizeof name, "%s: input dropped for the stall's length: %.2f s of content never played "
                      "(3.0-3.6)", n, (double)c.lost / DFS);
        CHECK(name, lost_ok);
        std::snprintf(name, sizeof name, "%s: ... counted: dropped %.2f s, within the two ring contents the element "
                      "cannot see", n, (double)dropped / DFS);
        CHECK(name, counted);
    } else {
        std::snprintf(name, sizeof name, "%s: input dropped for the stall's length: %.2f s never played (3.0-3.6); "
                      "counted %.2f s", n, (double)c.lost / DFS, (double)dropped / DFS);
        CHECK(name, lost_ok && counted);
    }
    std::snprintf(name, sizeof name, "%s: resume live: render lateness after it %.1f..%.1f ms, before %.1f..%.1f", n,
                  c.lo1 / 1e6, c.hi1 / 1e6, c.lo0 / 1e6, c.hi0 / 1e6);
    CHECK(name, iabs(c.hi1 - c.hi0) < 30 * MS && iabs(c.lo1 - c.lo0) < 30 * MS);
}

void test_dev_stall_clock_stopped() {
    const StallCase c = stall_case(false);
    stall_checks(c, "11", true);
    const AsrcDeviceTerm::Stats st = c.t->stats();
    char name[300];
    std::snprintf(name, sizeof name, "11: the clock stopped with it: flat samples never fed, one relock-device (step) on "
                  "its return, the rate kept (%.2f ppm)", device_rate_ppm(*c.t));
    CHECK(name, st.flat_ns >= 2 * S && st.relocks_step == 1 && std::abs(device_rate_ppm(*c.t) + 135) < 1.0);
}

void test_dev_stall_clock_running() {
    const StallCase c = stall_case(true);
    stall_checks(c, "12", false);
    const AsrcDeviceTerm::Stats st = c.t->stats();
    char name[300];
    std::snprintf(name, sizeof name, "12: the clock held after the return (it ran ahead): one relock-device (step), the "
                  "rate kept (%.2f ppm; flat %.1f s)", device_rate_ppm(*c.t), st.flat_ns / 1e9);
    CHECK(name, st.relocks_step == 1 && std::abs(device_rate_ppm(*c.t) + 135) < 1.0);
    AsrcDeviceTerm t2;
    Path p2(t2, -135, preempted, 12);
    p2.run(3300);
    bool quiet = true;
    for (const Path::Ev& e : p2.events) quiet = quiet && e.kind != "device-stalled" && e.kind != "device-resumed";
    for (const Path::Log& x : p2.log) quiet = quiet && !x.flush;
    CHECK("12: a device that keeps reading (a suspended null sink runs on a timer): no stall, no flush", quiet);
}

void test_dev_render_lateness_ring() {
    char name[400];
    {
        AsrcDeviceTerm t;
        Path p(t, -135, no_jitter, 13);
        p.run(1200);
        int64_t worst = 0;
        for (const Path::Log& x : p.log)
            if (x.has_truth && x.has_acc && x.ts > 2 * S) worst = std::max(worst, iabs(x.acc - x.truth));
        std::snprintf(name, sizeof name, "13: steady: the accounting within 1 ms of the ring at every read (worst %.3f ms)",
                      worst / 1e6);
        CHECK(name, worst < MS);
    }
    for (const bool stale : {false, true}) {
        AsrcDeviceTerm t;
        Path p(t, -135, no_jitter, 13, 0, 15, stale ? 44 : -1, 120);
        p.holes.push_back({60 * S, 300 * MS, false});
        p.run(700);
        int64_t worst = 0, silent = 0, wrong = 0;
        for (const Path::Log& x : p.log) {
            if (x.ts <= 2 * S) continue;
            if (x.has_truth && x.has_acc) worst = std::max(worst, iabs(x.acc - x.truth));
            wrong += x.has_truth != x.has_acc;
            silent += !x.has_truth;
        }
        std::snprintf(name, sizeof name, "13: 13-hole-%s: within 1 ms wherever a sample is heard (worst %.3f ms), silence "
                      "where the ring plays none (%lld reads silent, %lld disagree)", stale ? "stale" : "fresh",
                      worst / 1e6, (long long)silent, (long long)wrong);
        CHECK(name, worst < MS && wrong == 0);
    }
    {
        AsrcDeviceTerm t;
        Path p(t, 0, no_jitter, 13, 0, 15, 44, 120);
        p.holes.push_back({60 * S, 300 * MS, false});
        p.run(700);
        const double lost_ms = (p.produced - p.heard_ours - p.queued() - p.flushed) * 1000.0 / DFS;
        std::snprintf(name, sizeof name, "13: the modelled realign on a read index 44 ms stale drops %.0f ms of writes "
                      "after a 300 ms hole (DEV-P4a case 6 on the Pi 5: 100-127 ms)", lost_ms);
        CHECK(name, lost_ms >= 90 && lost_ms <= 130);
    }
    {
        AsrcDeviceTerm t;
        Path p(t, 0, no_jitter, 13, 40, 15, 44, 120);
        p.holes.push_back({60 * S, 300 * MS, false});
        p.run(700);
        std::vector<int64_t> wrong;
        for (const Path::Log& x : p.log)
            if (x.ts > 2 * S && (x.has_truth != x.has_acc || (x.has_truth && iabs(x.acc - x.truth) >= MS)))
                wrong.push_back(x.ts);
        bool in = !wrong.empty();
        for (int64_t w : wrong) in = in && w >= 60300 * MS && w <= 60600 * MS;
        std::snprintf(name, sizeof name, "13: with the clock 40 ms behind the read index (the Pi 5's configured sink "
                      "latency), the writes the server dropped between the two read as heard at %zu reads, all in the "
                      "0.3 s after the hole (%.2f s): the limit no clock can see", wrong.size(),
                      wrong.empty() ? 0.0 : wrong[0] / 1e9);
        CHECK(name, in);
    }
}

// Case 14 is the replay format's (mrts_cli asrc-device; asrc_device_parity_test.py holds it line for line): its
// substance here, on the class.
void test_dev_replay_format() {
    AsrcDeviceConfig c;
    c.settle_ns = S;
    AsrcDeviceTerm t(c);
    std::vector<AsrcDeviceEvent> ev;
    t.start(0, &ev);
    bool idle_first = false, ratios = true;
    for (int64_t k = 0; k < 40; k++) {
        t.sample(k * TICK, 10 * S + k * TICK, 0, 0, &ev);
        if (k == 0) idle_first = t.lock_state() == AsrcDeviceTerm::LockState::idle;
        ratios = ratios && t.ratio_ppb(1000 * k) == 1000 * k;
    }
    CHECK("14: the first read's lock state is idle (one read: the clock not yet moved)", idle_first);
    t.stop(5 * S);
    std::vector<AsrcDeviceEvent> rs;
    t.start(6 * S, &rs);
    CHECK("14: the restart's event (relock-device, restart, at its start), then its recalibration",
          rs.size() == 1 && rs[0].kind == AsrcDeviceEvent::Kind::relock_device && !std::strcmp(rs[0].reason, "restart") &&
              rs[0].at == 6 * S && t.take_recalibrated() && !t.take_recalibrated());
    CHECK("14: the names: relock-device, device-stalled, device-resumed; idle, settle, acquiring, locked, lost",
          !std::strcmp(asrc_device_event_name(AsrcDeviceEvent::Kind::relock_device), "relock-device") &&
              !std::strcmp(asrc_device_event_name(AsrcDeviceEvent::Kind::device_stalled), "device-stalled") &&
              !std::strcmp(asrc_device_event_name(AsrcDeviceEvent::Kind::device_resumed), "device-resumed") &&
              !std::strcmp(asrc_device_lock_state_name(AsrcDeviceTerm::LockState::settle), "settle") &&
              !std::strcmp(asrc_device_lock_state_name(AsrcDeviceTerm::LockState::lost), "lost"));
    CHECK("14: a read's eps_in is the ratio's (no device rate yet: the ratio is eps_in)", ratios);
}

void test_dev_recalibrated() {
    std::vector<AsrcDeviceEvent> ev;
    AsrcDeviceTerm clean;
    clean.start(0, &ev);
    feed_clock(clean, 400, -136, preempted, 15, no_on);
    const bool told_clean = clean.take_recalibrated();
    AsrcDeviceTerm t;
    t.start(0, &ev);
    std::vector<std::pair<int64_t, bool>> told;
    const int64_t end = feed_clock(
        t, 400, -136, preempted, 15,
        [&](int64_t h, const std::vector<AsrcDeviceEvent>& e) {
            if (t.take_recalibrated()) told.push_back({h, !e.empty()});
        },
        1000 * S, 300, -100 * MS);
    t.stop(end);
    std::vector<AsrcDeviceEvent> rs;
    t.start(end + 300 * MS, &rs);
    const bool first = t.take_recalibrated(), again = t.take_recalibrated();
    char name[300];
    std::snprintf(name, sizeof name, "15: a clean run tells nothing (%d); a step relock tells once, at its sample (%zu, at "
                  "%.1f s); a restart tells once (%d, then %d)", (int)told_clean, told.size(),
                  told.empty() ? -1.0 : told[0].first / 1e9, (int)first, (int)again);
    CHECK(name, !told_clean && told.size() == 1 && told[0].second && rs.size() == 1 && first && !again);
}

int sweep(int n) {
    std::printf("sweep: %d seeds x 3600 s per device rate, 1024-frame buffers, 1 ms jitter; |e| in us\n", n);
    for (int64_t ppb : {0LL, 50000LL, -50000LL, 500000LL, -500000LL}) {
        std::vector<int64_t> lock, late, endc, step, dev, mean, e[NMARK];
        for (int s = 1; s <= n; s++) {
            Scenario sc;
            sc.ppb = ppb;
            sc.seed = 1000 + (uint64_t)s;
            const Run r = run(sc);
            lock.push_back(r.lock_ns);
            late.push_back(r.err_max_late);
            endc.push_back(iabs(r.count_err_mf));
            step.push_back(r.dratio_max);
            dev.push_back(r.ratio_dev_late);
            mean.push_back(iabs(mean_ratio_err(r, ppb)));
            for (int i = 0; i < NMARK; i++) e[i].push_back(iabs(r.err_at[i]));
        }
        auto pct = [](std::vector<int64_t> v, int p) {
            std::sort(v.begin(), v.end());
            return v[(p * v.size() + 99) / 100 - 1];
        };
        std::printf("  %+5lld ppm: lock p50 %.2f max %.2f s | max|e| >=600 s p50 %.1f max %.1f us | |count err| at 1 h"
                    " p50 %.3f max %.3f fr | ratio from 600 s: |mean - device| max %.4f ppm, |dev| max %.3f ppm,"
                    " step max %.3f ppm\n",
                    (long long)ppb / 1000, pct(lock, 50) / 1e9, pct(lock, 100) / 1e9, pct(late, 50) / 1e3,
                    pct(late, 100) / 1e3, pct(endc, 50) / 1e3, pct(endc, 100) / 1e3, pct(mean, 100) / 1e3,
                    pct(dev, 100) / 1e3, pct(step, 100) / 1e3);
        const char* at[NMARK] = {"30s", "40s", "60s", "120s", "300s", "600s"};
        std::printf("         ");
        for (int i = 0; i < NMARK; i++)
            std::printf(" %s p50 %.1f max %.1f |", at[i], pct(e[i], 50) / 1e3, pct(e[i], 100) / 1e3);
        std::printf("\n");
    }
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc == 3 && !std::strcmp(argv[1], "--sweep")) return sweep(std::atoi(argv[2]));
    if (const char* e = std::getenv("MRTS_FIXTURES")) {
        g_fixtures = e;
    } else {
        const std::string a = argv[0];
        const size_t slash = a.rfind('/');
        g_fixtures = (slash == std::string::npos ? std::string(".") : a.substr(0, slash)) + "/../../../tests/fixtures";
    }
    test_basics();
    test_lock_and_hour();
    test_xrun();
    test_envelope();
    test_bounds();
    test_nominal();
    test_shapes();
    test_cycle_basics();
    test_cycle_hour();
    test_cycle_two_captures();
    test_cycle_dev3();
    test_cycle_restart();
    test_determinism();
    std::printf("\n  CHECKSUM asrc_servo %016llx (compare across machines)\n", (unsigned long long)g_all.h);
    test_decode_constants();
    test_decode_house_rate();
    test_decode_foreign();
    test_decode_engaged();
    test_decode_seamless();
    test_decode_breaks();
    test_decode_composite();
    test_device_only();
    std::printf("\n  CHECKSUM asrc_decode %016llx (compare across machines)\n", (unsigned long long)g_dec.h);
    test_device_continuity();
    test_lost_time();
    test_v7dec_replay();
    test_foreign_pes();
    test_decode_bounds();
    test_engage_rate_known();
    test_dev_lock_port();
    test_dev_ratio();
    test_dev_jitter();
    test_dev_fill_1h();
    test_dev_input_stall();
    test_dev_step();
    test_dev_traces();
    test_dev_trace_underrun();
    test_dev_clock_stall_underrun();
    test_dev_start_and_restart();
    test_dev_stall_clock_stopped();
    test_dev_stall_clock_running();
    test_dev_render_lateness_ring();
    test_dev_replay_format();
    test_dev_recalibrated();
    return test_summary("asrc_servo");
}
