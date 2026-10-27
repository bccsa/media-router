// The ASRC (plan ch. 5 part 4.5, WI-P1-8; ch. 7 part 4.4, WI-P3-5), py/asrc_bypass_ref.py ported rule for
// rule (OQ-1, S30): ClockLock on input frame index against buffer PTS gives the source rate; a phase servo
// commands the resampler so the output is a house-rate counter, PTS_out(m) = T0 + m / out_rate. Integer-only.
#pragma once
#include <cstdint>
#include <vector>

#include "ts_stc.h"

namespace mrts {

// The STC's constants (part 4.3) with part 4.5's 50 ms re-lock step, two-sided: a fall
// of the capture latency (a PipeWire quantum change) makes labels late, as a rise early.
// No backlog rule: a capture's PTS is its capture time.
ClockLockConfig asrc_lock_config();

// The decode lock (S16): the capture lock with a 10-bucket first fit. A demux's PTS are content
// time with no arrival jitter, so fewer buckets fit the rate (B-125 has the prototype's sweep).
ClockLockConfig asrc_decode_lock_config();

struct AsrcServoConfig {
    ClockLockConfig lock = asrc_lock_config();
    int64_t phase_tau_ns = 10000000000LL;   // ε_cmd = ε + phase_err / tau
    int64_t ratio_max_ppm = 1000;           // ε_cmd clamp; a device rate fit beyond it is an event
    // Decode mode (WI-P3-5) when > 0: bypassed while |ε| <= this and |phase| <= bypass_phase_ns;
    // engaged once |ε| has stayed past it for bypass_hold_ns of lock, or the phase passed (C-7).
    int64_t bypass_ppb = 0;
    int64_t bypass_phase_ns = 1000000;
    int64_t bypass_hold_ns = 10000000000LL;
    bool device = false;   // the ratio carries a device term (push's device_ppb), labels device time
};

// Decode mode on the decode lock (S17: bypass_ppb 0 with the device term is the device term alone).
AsrcServoConfig asrc_decode_config(int64_t bypass_ppb, bool device);

struct AsrcEvent {
    enum class Kind { relock, ratio_out_of_bounds, engaged };
    Kind kind;
    // relock: "discont" or "envelope-step" (decode and device modes also "gap"); engaged: "ratio"
    // or "phase"; static, "" otherwise.
    const char* reason;
    int64_t house_ns;     // relock: the new T0; out of bounds: the buffer's PTS; engaged: its PTS
    // relock: the output PTS jump (ns); out of bounds: the device rate fit (ppb); engaged: the
    // source rate (ppb, as Stats::source_ppb).
    int64_t value;
    int64_t dropped_ns = 0;   // relock: input dropped as overlap with what already left
    int64_t phase_ns = 0;     // engaged: the bypass phase at the engage
};

const char* asrc_event_name(AsrcEvent::Kind k);

// A clock's rate against house time in ppb, positive when it runs fast, from its lock's ε
// (house = (1 + ε) x its time): round(-ε / (1 + ε)).
int64_t asrc_rate_of(int64_t eps_ppb);

// Per buffer: push() before resampling (rates, frames to drop), produced() after. Capture mode:
// the resampler is never reset; what it holds back is a new T0's first output. Steering only
// moves the ratio; a relock onto a floor below the last output drops that overlap.
class AsrcServo {
  public:
    // The lock's phase. Its lost needs a tick without samples, and the servo only
    // runs when a buffer arrives.
    enum class State { acquiring, locked };
    // capture: Phase 1. bypass/decode: decode mode, bypassed/engaged. device: the device term
    // alone (device-only, or decode + device bypassed). decode_device: both terms.
    enum class Mode { capture, bypass, decode, device, decode_device };
    struct Command {
        int32_t in_rate;    // gst_audio_resampler_update(in_rate, out_rate) when in_rate changed
        int32_t out_rate;
        bool relock;        // this buffer opened an epoch: its first output is at T0, DISCONT
        uint32_t skip;      // frames to drop from the buffer's head, unresampled: a relock's overlap
        // Decode and device modes: pass leaves the buffer unchanged (zero copy); engage primes
        // the resampler with what passed (reset, then the history fed, as many outputs dropped as
        // frames fed); drain: end_epoch() ran here, so drain the tail first (tail_pts_at), reset.
        bool pass = false, engage = false, drain = false;
    };
    struct Stats {
        State state = State::acquiring;
        int64_t ratio_ppb = 0;      // ε_cmd: commanded out/in against nominal, minus 1
        int64_t phase_err_ns = 0;   // house time of the next output's input minus its PTS_out
        uint64_t relocks = 0;
        uint64_t in_frames = 0, out_frames = 0;
        uint64_t discont_in = 0;    // DISCONT flags after the first buffer
        uint64_t dropped_frames = 0;   // input frames skipped as relock overlap
        Mode mode = Mode::capture;
        int64_t source_ppb = 0;     // the source clock against house (asrc_rate_of); 0 without a lock
        int64_t decode_ppb = 0;     // the decode term of ratio_ppb (ε_cmd); ratio_ppb without a device term
    };

    // A relock drops at most this much: a fall past it is no capture-latency change,
    // and what is left over is slewed by the ratio.
    static constexpr int64_t DROP_MAX_NS = 1000000000;

    // Rates in Hz, clamped to [1000, 768000] so every product fits 64 bits.
    AsrcServo(int32_t in_hz, int32_t out_hz, const AsrcServoConfig& cfg = AsrcServoConfig());

    // The resampler's lookahead in input frames (gst_audio_resampler_get_max_latency).
    void set_delay(uint32_t frames) { delay_ = frames; }
    // pts_ns: the capture time (capture) or content time (decode) of the buffer's first frame;
    // every buffer carries one. device_ppb: AsrcDeviceLock::ppb(), with cfg.device only.
    Command push(int64_t pts_ns, uint32_t frames, bool discont, int64_t device_ppb = 0);
    void produced(uint32_t frames);
    // Decode and device modes: the content breaks at a GAP, or before a DISCONT buffer (so the tail leaves
    // before the relock's jump is measured); the next push opens an epoch. True when the resampler holds a
    // tail: drain it on tail_pts_at(), count it with tail_produced(), then reset. Capture mode: false.
    bool end_epoch();
    int64_t tail_pts_at(uint64_t k) const;
    void tail_produced(uint32_t frames);

    int64_t t0() const { return t0_; }
    uint64_t epoch_frames() const { return m_; }   // m: output frames since T0
    int64_t pts_at(uint64_t m) const;              // T0 + floor(m * 1e9 / out_hz)
    int64_t next_pts() const { return pts_at(m_); }
    State state() const;
    Mode mode() const;
    bool passing() const { return passing_; }   // no resampler in the path: nothing held back
    Stats stats() const;
    std::vector<AsrcEvent> take_events();
    const ClockLock& lock() const { return lock_; }
    const AsrcServoConfig& config() const { return cfg_; }

  private:
    int64_t next_pos2() const;   // input position of the next output, in half frames
    int64_t house_pts() const;   // the house-rate counter's label of the next output
    int64_t frames_over(int64_t ns) const;
    int64_t measure_phase() const;
    int64_t ratio_ppb() const;
    int32_t in_rate() const;
    void open_epoch(const char* why);
    void new_epoch(int64_t pts, const char* why);
    void step_epoch(int64_t pts);
    void engage(int64_t pts, const char* why, Command* cmd);
    void check_bounds(int64_t h);

    AsrcServoConfig cfg_;
    int64_t in_hz_, out_hz_;
    bool decode_, capture_, has_lock_;
    ClockLock lock_;
    bool started_ = false;
    int64_t delay_ = 0;
    int64_t n_in_ = 0;           // input frames pushed
    int64_t drop_left_ = 0;      // of the overlap, frames still to skip
    uint64_t dropped_ = 0;       // frames skipped so far
    uint64_t n_out_ = 0;         // output frames produced
    int64_t t0_ = 0;
    uint64_t m_ = 0;
    // House-rate frames since T0 (m_ with the device term taken out) and their fraction, in
    // ppb of a frame within [0, 1e9).
    uint64_t mh_ = 0;
    int64_t mh_frac_ = 0;
    int64_t start2_ = 0;         // input position of the epoch's first output, half frames
    int64_t eps_cmd_ = 0;        // ppb
    int64_t dev_ppb_ = 0;        // the device ε the last command carried
    int64_t phase_err_ = 0;
    uint64_t relocks_ = 0, discont_in_ = 0;
    bool oob_ = false;           // out-of-bounds raised and not yet back inside
    bool engaged_ = false;       // decode mode: the decode term commands the ratio
    bool passing_ = false;       // ... bypassed at equal rates without a device term: no resampler
    bool over_ = false;          // |ε| past the bound while locked, since over_since_
    int64_t over_since_ = 0;
    bool ended_ = false;         // end_epoch() since the last push
    int64_t tail_t0_ = 0;
    uint64_t tail_m_ = 0;
    std::vector<AsrcEvent> events_;
};

const char* asrc_state_name(AsrcServo::State s);
const char* asrc_mode_name(AsrcServo::Mode m);

// The device term (WI-P3-5): a ClockLock on a sink's custom-slaving (itime, etime) pairs, device
// time against house time. A sink discontinuity relocks it, keeping the rate. Not thread-safe.
class AsrcDeviceLock {
  public:
    // The sink's first callback after its calibration reads the device before its ring runs
    // (measured up to 0.33 ms early): the pairs of a (re)lock's first this much are left out.
    static constexpr int64_t SETTLE_NS = 100000000;
    explicit AsrcDeviceLock(const ClockLockConfig& cfg = asrc_decode_lock_config());
    // read_ns: house time from etime's read to the caller's re-read after itime's. The sink reads
    // etime, then itime, so a preemption between them makes a pair early, which the lower envelope
    // would follow; at the re-read, the latest instant itime can have been read, every pair is late.
    void feed(int64_t itime_ns, int64_t etime_ns, int64_t read_ns = 0);
    void discont();
    int64_t ppb() const { return lock_.ppb(); }   // ε: house = (1 + ε) device time
    int64_t rate_ppb() const { return asrc_rate_of(lock_.ppb()); }
    bool locked() const { return lock_.phase() == ClockLock::Phase::locked; }
    uint64_t relocks() const { return relocks_; }
    const ClockLock& lock() const { return lock_; }

  private:
    ClockLock lock_;
    uint64_t relocks_ = 0;
    bool have_first_ = false;
    int64_t first_ns_ = 0;   // the house time of the (re)lock's first pair
};

}  // namespace mrts
