// The ducker on content time (plan ch. 6 part 4.5, WI-P2-10): the gain envelope, ported from
// the engine's DuckerEnvelope (duckerEnvelope.ts), the key meter and the sample path. Times are
// ms of content time. No GStreamer, no GLib: gstmrducker.cpp is the GStreamer side.
#pragma once
#include <cstddef>
#include <cstdint>
#include <limits>
#include <vector>

namespace mrducker {

enum class Phase { idle, attack, hold, release };
const char* phase_name(Phase p);

// The module's duck settings (threshold, duckDepth, attack, release, hold), with their defaults.
struct DuckerParams {
    double threshold_db = -35;   // key level over which the programme is ducked
    double depth_db = -12;       // the floor, <= 0
    double attack_ms = 5;        // full travel to the floor
    double release_ms = 200;     // full travel back to unity
    double hold_ms = 250;        // stays ducked this long after the key falls
};

// Linear in dB: |depth| / attack (or release) dB per ms toward the floor (or unity). dt is
// content time, so the 1 ms floor the TS put under its Date.now() deltas is gone.
class DuckerEnvelope {
  public:
    // A reading never integrates more than this: a late one must not slam the gain.
    static constexpr double MAX_STEP_MS = 100;
    // The applied gain moves only past this, so a settled envelope leaves it alone.
    static constexpr double GAIN_EPSILON = 0.0005;

    void reset() { *this = DuckerEnvelope(); }
    // One key reading over dt_ms of content time. True when the applied gain moved.
    bool advance(double key_db, double dt_ms, const DuckerParams& p);

    double gain_db() const { return db_; }
    double gain() const { return set_gain_; }   // the applied gain, linear
    double key_db() const { return key_db_; }   // the last reading; NaN before one
    Phase phase() const { return phase_; }

  private:
    double db_ = 0;
    double now_ms_ = 0;
    double active_ms_ = -std::numeric_limits<double>::infinity();   // the key last over
    double set_gain_ = 1;
    double key_db_ = std::numeric_limits<double>::quiet_NaN();
    Phase phase_ = Phase::idle;
};

// The key level of a window: the louder key channel's RMS in dB of full scale, as `level`'s
// rms; digital silence reads FLOOR_DB, not -inf (a message carries no -inf).
class KeyMeter {
  public:
    static constexpr double FLOOR_DB = -120;
    void add(float a, float b) {
        sum_a_ += (double)a * a;
        sum_b_ += (double)b * b;
        frames_++;
    }
    size_t frames() const { return frames_; }
    // The window's level, then an empty window.
    double take_db();

  private:
    double sum_a_ = 0, sum_b_ = 0;
    size_t frames_ = 0;
};

// The element's data path, interleaved F32: 4 channels in (0/1 programme, 2/3 key), 2 out.
// Each WINDOW_MS of content advances the envelope; across the next window the gain ramps per
// sample, straight in dB, to where the envelope went.
class DuckerCore {
  public:
    static constexpr double WINDOW_MS = 15;
    static constexpr double REPORT_MS = 100;

    struct Reading {
        size_t at;          // frames into the process() call where its window ended
        double dt_ms;       // the window's content time
        double key_db;
        double gain_db;     // the envelope after it
        Phase phase;
        bool report;        // the first reading at or past a REPORT_MS mark of content time
    };

    explicit DuckerCore(int rate = 48000) { set_rate(rate); }
    // A new rate is a new stream: reset() too.
    void set_rate(int rate);
    // Unity, an empty window, content time from 0.
    void reset();
    // `silent`: the input is a gap, read as zeros. Readings are appended to `readings`.
    void process(const float* in, float* out, size_t frames, bool silent, const DuckerParams& p,
                 std::vector<Reading>* readings);
    // EOS: the reading of the partial window; false when it holds no frames.
    bool finish(const DuckerParams& p, Reading* r);

    int rate() const { return rate_; }
    size_t window_frames() const { return window_; }
    const DuckerEnvelope& envelope() const { return env_; }
    double applied_gain() const { return g_; }   // the gain the last frame out got

  private:
    Reading take(size_t at, const DuckerParams& p);

    int rate_ = 48000;
    size_t window_ = 720;
    uint64_t report_frames_ = 4800;
    KeyMeter meter_;
    DuckerEnvelope env_;
    double g_ = 1, target_ = 1, step_ = 1;   // the ramp: x step_ per frame, target_ at its end
    size_t ramp_left_ = 0;
    uint64_t total_ = 0, next_report_ = 0;
};

}  // namespace mrducker
