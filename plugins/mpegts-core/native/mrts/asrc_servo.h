// The ASRC at PCM captures (plan ch. 5 part 4.5, WI-P1-8): ClockLock on input frame
// index against buffer PTS gives the device rate; a phase servo commands the resampler
// so the output is a house-rate counter, PTS_out(m) = T0 + m / out_rate. Integer-only.
#pragma once
#include <cstdint>
#include <vector>

#include "ts_stc.h"

namespace mrts {

// The STC's constants (part 4.3) with part 4.5's 50 ms re-lock step, two-sided: a fall
// of the capture latency (a PipeWire quantum change) makes labels late, as a rise early.
ClockLockConfig asrc_lock_config();

struct AsrcServoConfig {
    ClockLockConfig lock = asrc_lock_config();
    int64_t phase_tau_ns = 10000000000LL;   // ε_cmd = ε + phase_err / tau
    int64_t ratio_max_ppm = 1000;           // ε_cmd clamp; a device rate fit beyond it is an event
};

struct AsrcEvent {
    enum class Kind { relock, ratio_out_of_bounds };
    Kind kind;
    const char* reason;   // relock: "discont" or "envelope-step"; static, "" otherwise
    int64_t house_ns;     // relock: the new T0; out of bounds: the buffer's PTS
    int64_t value;        // relock: the output PTS jump (ns); out of bounds: the device rate fit (ppb)
    int64_t dropped_ns = 0;   // relock: input dropped as overlap with what already left
};

const char* asrc_event_name(AsrcEvent::Kind k);

// Per buffer: push() before resampling (rates, frames to drop), produced() after. The
// resampler is never reset: what it holds back is a new T0's first output. Steering only
// moves the ratio; a relock onto a floor below the last output drops that overlap.
class AsrcServo {
  public:
    // The lock's phase. Its lost needs a tick without samples, and the servo only
    // runs when a buffer arrives.
    enum class State { acquiring, locked };
    struct Command {
        int32_t in_rate;    // gst_audio_resampler_update(in_rate, out_rate) when in_rate changed
        int32_t out_rate;
        bool relock;        // this buffer opened an epoch: its first output is at T0, DISCONT
        uint32_t skip;      // frames to drop from the buffer's head, unresampled: a relock's overlap
    };
    struct Stats {
        State state = State::acquiring;
        int64_t ratio_ppb = 0;      // ε_cmd: commanded out/in against nominal, minus 1
        int64_t phase_err_ns = 0;   // house time of the next output's input minus its PTS_out
        uint64_t relocks = 0;
        uint64_t in_frames = 0, out_frames = 0;
        uint64_t discont_in = 0;    // DISCONT flags after the first buffer
        uint64_t dropped_frames = 0;   // input frames skipped as relock overlap
    };

    // A relock drops at most this much: a fall past it is no capture-latency change,
    // and what is left over is slewed by the ratio.
    static constexpr int64_t DROP_MAX_NS = 1000000000;

    // Rates in Hz, clamped to [1000, 768000] so every product fits 64 bits.
    AsrcServo(int32_t in_hz, int32_t out_hz, const AsrcServoConfig& cfg = AsrcServoConfig());

    // The resampler's lookahead in input frames (gst_audio_resampler_get_max_latency).
    void set_delay(uint32_t frames) { delay_ = frames; }
    // pts_ns: the capture time of the buffer's first frame; every buffer carries one.
    Command push(int64_t pts_ns, uint32_t frames, bool discont);
    void produced(uint32_t frames);

    int64_t t0() const { return t0_; }
    uint64_t epoch_frames() const { return m_; }   // m: output frames since T0
    int64_t pts_at(uint64_t m) const;              // T0 + floor(m * 1e9 / out_hz)
    int64_t next_pts() const { return pts_at(m_); }
    State state() const;
    Stats stats() const;
    std::vector<AsrcEvent> take_events();
    const ClockLock& lock() const { return lock_; }
    const AsrcServoConfig& config() const { return cfg_; }

  private:
    int64_t next_pos2() const;   // input position of the next output, in half frames
    int64_t frames_over(int64_t ns) const;
    int64_t measure_phase() const;
    int32_t in_rate() const;
    void open_epoch(const char* why);
    void check_bounds(int64_t h);

    AsrcServoConfig cfg_;
    int64_t in_hz_, out_hz_;
    ClockLock lock_;
    bool started_ = false;
    int64_t delay_ = 0;
    int64_t n_in_ = 0;           // input frames pushed
    int64_t drop_left_ = 0;      // of the overlap, frames still to skip
    uint64_t dropped_ = 0;       // frames skipped so far
    uint64_t n_out_ = 0;         // output frames produced
    int64_t t0_ = 0;
    uint64_t m_ = 0;
    int64_t start2_ = 0;         // input position of the epoch's first output, half frames
    int64_t eps_cmd_ = 0;        // ppb
    int64_t phase_err_ = 0;
    uint64_t relocks_ = 0, discont_in_ = 0;
    bool oob_ = false;           // out-of-bounds raised and not yet back inside
    std::vector<AsrcEvent> events_;
};

const char* asrc_state_name(AsrcServo::State s);

}  // namespace mrts
