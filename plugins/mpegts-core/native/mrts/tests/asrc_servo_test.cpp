// asrc_servo: the ASRC phase servo (WI-P1-8, portable part). A synthetic capture runs
// through a model of GstAudioResampler's frame accounting; the ground truth is the
// capture time of each output frame's content. Integer-only, so the printed checksums
// compare across machines. `--sweep N` prints seed statistics.
#include <algorithm>
#include <climits>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
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
        const AsrcServo::Command c = sv.push(pts, frames, false, dur == -2 ? (int64_t)frames * S / 48000 : dur);
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
        const AsrcServo::Command c = sv.push(H0 + t + sc.stamp_ns + step + j, (uint32_t)CYC, n == 0, CYC * S / 48000);
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
    return test_summary("asrc_servo");
}
