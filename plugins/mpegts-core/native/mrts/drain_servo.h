// mrts::DrainServo (ch. 15.4 B-179, WI-P4-18, issue #862): how fast a device output plays its built-up
// latency back down to the smallest buffer that plays clean. The port of ../../py/drain_servo.py by parity (its
// docstring states the law); integer ns and ppb, no GStreamer.
#pragma once
#include <cstdint>
#include <vector>

namespace mrts {

// The minimum over 3 buckets of 10 s on the servo's clock, the newest open.
class DrainWindow {
  public:
    static constexpr int64_t BUCKET_NS = 10000000000LL;
    static constexpr int BUCKETS = 3;
    void clear(int64_t now);
    void add(int64_t now, int64_t v);
    // False while no bucket holds a sample.
    bool min(int64_t now, int64_t* out);

  private:
    void rotate(int64_t now);
    int64_t open_at_ = 0;
    int64_t mins_[BUCKETS] = {};
    bool have_[BUCKETS] = {};   // oldest first, the last open
    int n_ = 1;
};

struct DrainEvent {
    enum class Kind { drain_start, drain_done, underrun, raise, outage };
    Kind kind;
    int64_t at;
    // drain_start: the command (ns); drain_done: drained so far; underrun, outage: the episode's length (a
    // video underrun 0); raise: the new margin.
    int64_t value;
};

const char* drain_event_name(DrainEvent::Kind k);

class DrainServo {
  public:
    static constexpr int64_t SEC = 1000000000LL, MS = 1000000LL;
    static constexpr int64_t WINDOW_NS = DrainWindow::BUCKETS * DrainWindow::BUCKET_NS;
    static constexpr int64_t TAU_NS = 30 * SEC;
    static constexpr int64_t DMAX_PPB = 5000000;   // 0.5 %, the owner's (9 Nov)
    static constexpr int64_t SLEW_DEN = 2000;      // 500 ppm/s
    static constexpr int64_t ENGAGE_NS = 20 * MS, LETGO_NS = 5 * MS;
    static constexpr int64_t CEILING_NS = 500 * MS;
    static constexpr int64_t SHORT_NS = 250 * MS;   // a starvation up to this raises; longer: an outage
    static constexpr int64_t JOIN_NS = SEC;         // video late frames this close are one episode
    static constexpr int64_t M_EVERY_NS = 600 * SEC, L_EVERY_NS = 3600 * SEC, STEP_NS = 5 * MS;
    static constexpr int64_t ABOVE_L_NS = 10 * MS, UNDER_FLOOR_NS = 10 * MS, RAISE_MIN_NS = 20 * MS;
    static constexpr int64_t GROUP_STALE_NS = 10 * SEC, RISE_CAP_NS = SEC;
    static constexpr int64_t GROUP_ALONE_NS = -3600 * SEC;   // alone; any other target, even <= 0, groups
    static constexpr int64_t AUDIO_START_NS = 20 * MS, AUDIO_FLOOR_NS = 20 * MS;

    enum class State { warm_up, idle, draining, rising };

    explicit DrainServo(bool video = false, int64_t start_ns = AUDIO_START_NS, int64_t floor_ns = AUDIO_FLOOR_NS);

    // A slack sample: content ready before it was needed (below 0 reads 0).
    void sample(int64_t now, int64_t slack_ns);
    // Video: the backlog queue's level, a second window added to the slack's trough.
    void queue_level(int64_t now, int64_t level_ns);
    // Audio, each tick: whether the device starved since the last one.
    void starve(int64_t now, bool on);
    bool starving() const { return in_episode_; }
    // Video: a release by_ns past its drained slot, neither collapsed nor sink-late.
    void late(int64_t now, int64_t by_ns);
    // A window clear (a relock, a stall's flush, caps, a flush, PAUSED): warm-up again, delta 0.
    void clear(int64_t now);
    // A DISCONT or GAP: the next update steps delta to its command.
    void epoch_break() { brk_ = true; }
    bool break_pending() const { return brk_; }
    // The engine's group target (GROUP_ALONE_NS: alone), honoured while refreshed within GROUP_STALE_NS.
    void set_group(int64_t now, int64_t target_ns);
    // The law at now: render the render lateness, can: it can drain (locked, a display rate). Returns delta.
    int64_t update(int64_t now, int64_t render_ns, bool can);
    std::vector<DrainEvent> take_events();

    int64_t ppb() const { return ppb_; }
    int64_t excess() const { return excess_; }
    int64_t margin() const { return margin_; }
    bool has_learned() const { return have_learned_; }
    int64_t learned() const { return learned_; }
    int64_t trough() const { return trough_; }
    int64_t target() const { return target_; }   // the published target T
    int64_t drained() const { return drained_; }
    uint64_t raises() const { return raises_; }
    uint64_t underruns() const { return underruns_; }
    uint64_t outages() const { return outages_; }
    State state() const { return state_; }
    bool capped() const { return capped_; }
    bool started() const { return started_; }
    int64_t group() const { return group_; }

  private:
    void touch(int64_t now);
    int64_t bound() const;
    void decay(int64_t now);
    void raise(int64_t now);
    void outage(int64_t now, int64_t length);

    bool video_;
    int64_t floor_, margin_;
    bool have_learned_ = false;
    int64_t learned_ = 0;
    DrainWindow slack_, queue_;
    bool started_ = false;
    bool sampled_ = false;   // a slack sample since the last clear
    int64_t warm_from_ = 0, last_ = 0, m_at_ = 0, l_at_ = 0;
    int64_t ppb_ = 0;
    bool engaged_ = false, draining_ = false, brk_ = false;
    bool in_episode_ = false, have_late_ = false, have_positive_ = false, have_hold_ = false;
    int64_t episode_at_ = 0, late_at_ = 0, positive_at_ = 0, hold_until_ = 0;
    int64_t group_ = GROUP_ALONE_NS, group_at_ = 0;
    int64_t held_ = 0, target_ = 0, excess_ = 0, trough_ = 0;
    bool capped_ = false;
    State state_ = State::warm_up;
    int64_t drained_ = 0, drained_rem_ = 0;
    uint64_t raises_ = 0, underruns_ = 0, outages_ = 0;
    std::vector<DrainEvent> events_;
};

const char* drain_state_name(DrainServo::State s);

}  // namespace mrts
