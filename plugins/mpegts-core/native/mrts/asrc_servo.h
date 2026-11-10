// The ASRC (plan ch. 5 part 4.5, WI-P1-8; ch. 7 part 4.4, WI-P3-5, B-148), py/asrc_bypass_ref.py ported rule
// for rule (OQ-1, S30): a ClockLock gives the source rate and a phase servo commands the resampler; its device
// term follows the sink's clock on a timer (ch. 8 WI-P4-4, B-166: py/asrc_device_ref.py). Integer-only.
#pragma once
#include <cstdint>
#include <deque>
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
    // Capture mode, one buffer per graph cycle stamped with the cycle's time (pipewiresrc, B-180): whole cycles
    // missing at a steady cycle size are lost samples, and so is a rise the lock would relock on (its driver
    // restarted, B-181); a cycle-size change moves the stamps only. The decode and device modes ignore it.
    bool cycle_input = false;
};

// Decode mode on the decode lock (S17: bypass_ppb 0 with the device term is the device term alone).
AsrcServoConfig asrc_decode_config(int64_t bypass_ppb, bool device);

// The device term's lock (B-165): the capture lock with a 1000-bucket window and a 1200 s loop, a fit
// taken at once only past the ratio clamp (a short fit after a restart never replaces the rate kept).
ClockLockConfig asrc_device_lock_config();

struct AsrcEvent {
    // gap: lost cycles or time, the output jumps their length; shift: the stamps moved, the samples did not.
    enum class Kind { relock, ratio_out_of_bounds, engaged, gap, shift };
    Kind kind;
    // relock: "discont" or "envelope-step" (decode and device modes also "gap"; decode "jump", B-148); engaged:
    // "ratio" or "phase"; gap: "lost-cycle", "lost-time" or "reverted"; shift: "cycle-size"; static, "" otherwise.
    const char* reason;
    int64_t house_ns;     // relock: the new T0; gap: the next output's PTS; else the buffer's PTS
    // relock, gap: the output PTS jump (ns); out of bounds: the device rate fit (ppb); engaged: the
    // source rate (ppb, as Stats::source_ppb); shift: the step (ns).
    int64_t value;
    int64_t dropped_ns = 0;   // relock, a reverted gap: input dropped as overlap with what already left
    int64_t phase_ns = 0;     // engaged: the bypass phase at the engage
    int64_t lost_frames = 0;  // gap: input frames lost (negative when reverted)
    bool rate_known = false;  // engaged: the lock had measured the rate (a phase engage may come first, B-148)
};

const char* asrc_event_name(AsrcEvent::Kind k);

// A clock's rate against house time in ppb, positive when it runs fast, from its lock's ε
// (house = (1 + ε) x its time): round(-ε / (1 + ε)).
int64_t asrc_rate_of(int64_t eps_ppb);

// Per buffer: push() before resampling (rates, frames to drop), produced() after. Steering moves only the
// ratio; a capture relock keeps the resampler and drops input under the last output. Lost time, breaks and
// the device timeline across a break: ADR-0029's ASRC section (B-148, B-180).
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
        bool gap = false;   // lost cycles or time before this buffer: its output jumps, DISCONT, same epoch
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
        uint64_t gaps = 0;          // cycle_input, decode modes: gaps the output jumped (lost cycles or time)
        int64_t lost_frames = 0;    // ... the input frames they lost (reverted ones taken back)
        Mode mode = Mode::capture;
        int64_t source_ppb = 0;     // the source clock against house (asrc_rate_of); 0 without a lock
        int64_t decode_ppb = 0;     // the decode term of ratio_ppb (ε_cmd); ratio_ppb without a device term
        bool rate_known = false;    // the lock has measured the source's rate (a fit since its relock)
        int64_t drain_ppb = 0;      // the drain the last command carried (B-179); not in ratio_ppb
    };

    // A relock drops at most this much: a fall past it is no capture-latency change,
    // and what is left over is slewed by the ratio.
    static constexpr int64_t DROP_MAX_NS = 1000000000;
    // cycle_input: a gap is whole cycles to within this, or an eighth of a cycle when that is
    // less: the jitter of a driver's wakeup, never a share of a cycle (B-180).
    static constexpr int64_t CYCLE_TOL_NS = 2000000;
    // cycle_input, decode modes: the longest loss the output jumps at once (every product stays in
    // 64 bits); a longer one is the lock's.
    static constexpr int64_t LOST_MAX_NS = 1000 * DROP_MAX_NS;
    // Decode modes (B-148): a fit past the ratio bound this long while locked before ratio-out-of-bounds:
    // a relock's first short fit and an upstream slew are no source's rate.
    static constexpr int64_t OOB_HOLD_NS = 30 * DROP_MAX_NS;
    // The drain's own clamp (B-179): 0.5 %.
    static constexpr int64_t DRAIN_MAX_PPB = 5000000;

    // Rates in Hz, clamped to [1000, 768000] so every product fits 64 bits.
    AsrcServo(int32_t in_hz, int32_t out_hz, const AsrcServoConfig& cfg = AsrcServoConfig());

    // The resampler's lookahead in input frames (gst_audio_resampler_get_max_latency).
    void set_delay(uint32_t frames) { delay_ = frames; }
    // pts_ns: the capture time (capture) or content time (decode) of the buffer's first frame;
    // every buffer carries one. device_ppb: AsrcDeviceTerm::device_ppb(), with cfg.device only. dur_ns:
    // the buffer's duration as its source stamped it (a cycle's size), < 0 when it has none. drain_ppb:
    // DrainServo's rate (B-179), device modes only: input consumed (1 + drain) times faster, clamped to +-0.5 %.
    Command push(int64_t pts_ns, uint32_t frames, bool discont, int64_t device_ppb = 0,
                 int64_t dur_ns = -1, int64_t drain_ppb = 0);
    void produced(uint32_t frames);
    // Decode and device modes: the content breaks at a GAP, or before a DISCONT buffer (so the tail leaves
    // before the relock's jump is measured); the next push opens an epoch. True when the resampler holds a
    // tail: drain it on tail_pts_at(), count it with tail_produced(), then reset. Capture mode: false.
    bool end_epoch();
    int64_t tail_pts_at(uint64_t k) const;
    void tail_produced(uint32_t frames);
    // Device mode: the device term relocked (AsrcDeviceTerm::take_recalibrated). The device offset a new
    // epoch carries restarts from the next output (B-148); the open epoch keeps its labels.
    void device_recalibrated();

    int64_t t0() const { return t0_; }
    uint64_t epoch_frames() const { return m_; }   // m: output frames since T0
    int64_t pts_at(uint64_t m) const;              // T0 + floor(m * 1e9 / out_hz)
    int64_t next_pts() const { return pts_at(m_); }
    // The next output's content time: its label on the house-rate counter (render lateness, B-166).
    int64_t next_content_pts() const { return house_pts(); }
    State state() const;
    Mode mode() const;
    bool passing() const { return passing_; }   // no resampler in the path: nothing held back
    Stats stats() const;
    std::vector<AsrcEvent> take_events();
    const ClockLock& lock() const { return lock_; }
    const AsrcServoConfig& config() const { return cfg_; }

  private:
    int64_t next_pos2() const;   // input position of the next output, in half frames
    int64_t pos_ns(int64_t h2) const;   // an input position as the lock's time: with lost_res_
    int64_t house_pts() const;   // the house-rate counter's label of the next output
    int64_t label_next() const;  // the next output's label, the drained tail's end after end_epoch()
    int64_t offset_at(int64_t h) const;
    int64_t content_step(int64_t pts_ns);
    void house_advance(uint32_t frames);
    int64_t frames_over(int64_t ns) const;
    int64_t measure_phase() const;
    int64_t ratio_ppb() const;
    int32_t in_rate() const;
    void open_epoch(const char* why);
    void new_epoch(int64_t pts, const char* why);
    void step_epoch(int64_t pts);
    void engage(int64_t pts, const char* why, Command* cmd);
    void check_bounds(int64_t h);
    bool check_cycle(int64_t pts_ns, uint32_t frames, int64_t dur_ns);
    int64_t frames_in(int64_t ns) const;
    void lose(int64_t frames, bool whole, int64_t res_ns = 0);
    bool fits(int64_t dur_ns, uint32_t frames) const;

    AsrcServoConfig cfg_;
    int64_t in_hz_, out_hz_;
    bool decode_, capture_, has_lock_;
    ClockLock lock_;
    bool started_ = false;
    int64_t delay_ = 0;
    int64_t n_in_ = 0;           // input frames pushed
    int64_t lost_ = 0;           // input frames lost between buffers: counted on the input position
    int64_t lost_res_ = 0;       // decode modes: lost time's remainder under a frame (ns), on it too (B-148)
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
    int64_t drain_ppb_ = 0;      // the drain the last command carried (device modes)
    int64_t run_ppb_ = 0;        // (1 + ε_dev)(1 + drain) - 1: the output's house-rate frames per frame
    int64_t phase_err_ = 0;
    uint64_t relocks_ = 0, discont_in_ = 0, gaps_ = 0;
    bool oob_ = false;           // out-of-bounds raised and not yet back inside
    bool past_ = false;          // decode: the fit past the bound while locked, since oob_since_
    int64_t oob_since_ = 0;
    bool cont_ = false;          // decode: the last buffer continued its predecessor within the lost-time bound
    // Device mode (B-148): labels minus house time at T0, and that offset at the sink's last calibration.
    int64_t t0_dev_ = 0, cal_off_ = 0;
    bool engaged_ = false;       // decode mode: the decode term commands the ratio
    bool passing_ = false;       // ... bypassed at equal rates without a device term: no resampler
    bool over_ = false;          // |ε| past the bound while locked, since over_since_
    int64_t over_since_ = 0;
    bool ended_ = false;         // end_epoch() since the last push
    int64_t tail_t0_ = 0;
    uint64_t tail_m_ = 0;
    // The last buffer as its source stamped it (decode modes: content_step); cycle_input: the stamps'
    // shift so far, and the last gap while its next buffer may still show it was a late stamp (cycle_ = 0: none).
    int64_t last_pts_ = 0, shift_ = 0;
    uint32_t last_frames_ = 0;
    int64_t cycle_ = 0, cycle_gap_ = 0;
    // Whether the last buffer's duration fit its frames, and whether this source's do: runs of each.
    bool last_fit_ = true, dur_trust_ = false;
    int fit_run_ = 0, miss_run_ = 0;
    std::vector<AsrcEvent> events_;
};

const char* asrc_state_name(AsrcServo::State s);
const char* asrc_mode_name(AsrcServo::Mode m);

// The device term (WI-P4-4, B-165/B-166): py/asrc_device_ref.py's DeviceTerm. A timer reads the device sink's
// clock against house time into a ClockLock; the ratio (1 + eps_in) / (1 + eps_dev) - 1 follows the device.
// The stall rule reads two counts (frames pushed, frames at the sink), never a level. Not thread-safe.
struct AsrcDeviceConfig {
    int64_t sample_ns = 100000000;       // the timer
    int64_t settle_ns = 15000000000LL;   // after the clock first moves, and after a relock
    int64_t relock_ns = 50000000;        // a device-clock step ...
    int relock_samples = 2;              // ... in this many fed samples in a row
    int64_t flat_den = 10;               // flat: the clock moved under 1/flat_den of house time
    int64_t stall_ns = 1000000000;       // the sink took nothing this long while samples waited
    int64_t waiting_ns = 100000000;      // samples waiting beyond what the 40 ms prefill holds back
    int64_t probe_ns = 500000000;        // while stalled, a flush this often
    int64_t resume_ns = 200000000;       // taken since a flush past an empty 100 ms ring: resumed
    int64_t rate_hz = 48000;
    int64_t ratio_max_ppm = 1000;
    ClockLockConfig lock = asrc_device_lock_config();
};

struct AsrcDeviceEvent {
    enum class Kind { relock_device, device_stalled, device_resumed };
    Kind kind;
    const char* reason;   // relock_device: "restart" or "step"; "" otherwise
    int64_t at;           // house time of the read (a restart: of the start)
    // relock_device step: the step (ns, 0 for a restart); stalled: frames waiting; resumed: frames dropped so far.
    int64_t value;
};

const char* asrc_device_event_name(AsrcDeviceEvent::Kind k);

// (1 + eps_in) / (1 + eps_dev) - 1 in ppb, rounded, clamped to +-max_ppm.
int64_t asrc_device_ratio(int64_t eps_in_ppb, int64_t eps_dev_ppb, int64_t max_ppm);

class AsrcDeviceTerm {
  public:
    enum class LockState { idle, settle, acquiring, locked, lost };
    struct Stats {
        int64_t device_ppb = 0, device_rate_ppb = 0;
        uint64_t relocks_restart = 0, relocks_step = 0, device_stalls = 0;
        int64_t dropped = 0;   // frames the stall rule dropped (never taken, or taken into a stopped ring)
        uint64_t flushes = 0;
        int64_t flat_ns = 0;   // house time read flat, never fed
        uint64_t fed = 0;
    };

    explicit AsrcDeviceTerm(const AsrcDeviceConfig& cfg = AsrcDeviceConfig());
    // The first buffer the sink renders after it acquired its ring: reads may begin. After a stop it
    // relocks keeping the rate (reason restart): the stream's clock starts again from 0.
    void start(int64_t mono, std::vector<AsrcDeviceEvent>* events);
    void stop(int64_t mono);   // the ring released: no read until the next start
    // One timer read: the device clock, then house time; the counts or < 0 for none. True: flush downstream now.
    bool sample(int64_t dev_ns, int64_t mono_ns, int64_t pushed, int64_t rendered,
                std::vector<AsrcDeviceEvent>* events);
    bool rendering() const { return rendering_; }
    bool stalled() const { return stalled_; }
    int64_t device_ppb() const;   // eps_dev in ClockLock's sense; 0 until the lock has a rate
    int64_t ratio_ppb(int64_t eps_in_ppb = 0) const;
    LockState lock_state() const;
    // A relock-device since the last call: the servo's device_recalibrated() (B-148's A1).
    bool take_recalibrated();
    Stats stats() const;
    const ClockLock& lock() const { return lock_; }
    const AsrcDeviceConfig& config() const { return cfg_; }

  private:
    void clock(int64_t dev, int64_t mono, std::vector<AsrcDeviceEvent>* events);
    bool render(int64_t mono, int64_t pushed, int64_t taken, std::vector<AsrcDeviceEvent>* events);
    void relock_step(int64_t mono, int64_t step_ns, std::vector<AsrcDeviceEvent>* events);

    AsrcDeviceConfig cfg_;
    ClockLock lock_;
    bool rendering_ = false;
    bool have_prev_ = false;   // the last read: (prev_dev_, prev_mono_)
    int64_t prev_dev_ = 0, prev_mono_ = 0;
    bool moved_ = false;       // the clock moved since the start or relock, at moved_at_
    int64_t moved_at_ = 0;
    bool epoch_ = false;       // the lock was fed since the term began
    int beyond_ = 0;           // fed reads in a row past relock_ns
    uint64_t relocks_restart_ = 0, relocks_step_ = 0;
    bool recal_ = false;
    int64_t flat_ns_ = 0;
    uint64_t fed_ = 0;
    bool stalled_ = false;
    bool have_taken_ = false;
    int64_t taken_prev_ = 0;
    int64_t discarded_ = 0;   // pushed frames the flushes discarded before the sink took them
    bool waiting_ = false;    // frames waiting since wait_since_
    int64_t wait_since_ = 0;
    int64_t flush_at_ = 0, taken_at_flush_ = 0;
    uint64_t stalls_ = 0, flushes_ = 0;
    int64_t dropped_ = 0;
    int64_t wait_frames_, resume_frames_;
};

const char* asrc_device_lock_state_name(AsrcDeviceTerm::LockState s);

// Render lateness (B-165): now less the PTS of the sample at the device. Each rendered buffer's write position
// (the base sink's next_sample after its render, less its frames) maps to its content time; the device clock
// gives the position played. A buffer wholly behind that position is dropped before the look-up.
class AsrcRenderLateness {
  public:
    explicit AsrcRenderLateness(int64_t rate_hz) : rate_(rate_hz > 0 ? rate_hz : 1) {}
    void rendered(int64_t write_pos, int64_t frames, int64_t pts_ns);
    void flush() { map_.clear(); }
    // False while no buffer of the map is at the device's position.
    bool at(int64_t now_ns, int64_t dev_ns, int64_t* lateness_ns);

  private:
    struct Seg {
        int64_t write_pos, frames, pts;
    };
    int64_t rate_;
    std::deque<Seg> map_;
};

}  // namespace mrts
