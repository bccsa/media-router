// The aligner input's arithmetic (plan ch. 6 part 4.3, WI-P2-6): W from an input's arrival
// rhythm, the pace one aggregator's inputs share and the gaps an absent input gets. Times are
// ns of pipeline running time. No GStreamer, no GLib: mralignwatch is the GStreamer side.
#pragma once
#include <atomic>
#include <cstdint>
#include <deque>
#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace mrts {

// W, the silence limit (part 4.3 job 2): clamp(factor x p95 of the gaps before the last
// WINDOW arrivals, floor, ceiling); the ceiling until MIN_ARRIVALS arrivals, so a fresh input
// is never declared absent on its first buffers.
class ArrivalRhythm {
  public:
    struct Config {
        double factor = 3.0;
        int64_t floor_ns = 100000000;      // 100 ms
        int64_t ceiling_ns = 2000000000;   // 2 s
    };
    static constexpr int WINDOW = 200;
    static constexpr int MIN_ARRIVALS = 10;

    void arrive(int64_t now_ns);
    int64_t limit_ns(const Config& cfg) const;
    // Nearest rank: the ceil(0.95 n)-th smallest of the n gaps kept; 0 before two arrivals.
    int64_t p95_ns() const;
    uint64_t arrivals() const { return arrivals_; }
    int64_t last_ns() const { return last_ns_; }
    void reset();

  private:
    std::vector<int64_t> gaps_;   // a ring of up to WINDOW
    size_t next_ = 0;
    uint64_t arrivals_ = 0;
    int64_t last_ns_ = 0;
};

// The pace of one aggregator's inputs (part 4.3 job 3), under PaceRegistry's lock but `snapshot`:
// its target is the most any member showed over the last `fall_after`, at least 0; the pace steps
// to it before the group runs, then slews to a gapped member's rise (B-80), falls in skips (B-82).
//
// A member's lateness: the median over wall time of its last second, each stretch between two
// arrivals at its midpoint, leaving out those over which it fell (a backlog draining, at any
// speed). It goes into the pace only while a third of the window counts and it is not falling.
class PaceGroup {
  public:
    using Member = uint64_t;
    // What a member's task reads on every pass, without the lock (B-79): the pace at any time
    // before `next_at`, from when time alone can lower it and the group must tick.
    struct Snapshot {
        int64_t target = 0;
        int64_t base = 0;      // the pace a rise slews from, or holds at...
        int64_t base_at = 0;   // ...since then
        int64_t next_at = 0;
        bool started = false;
        int64_t pace_at(int64_t now_ns) const;
    };
    // A skip down that a call applied: its member reports it (B-82).
    struct Event {
        int64_t fell_ns = 0;
    };
    static constexpr int64_t WINDOW_NS = 1000000000;   // a member's lateness: over its last 1 s
    // It counts toward the pace once its stretches span half the second: the first arrivals of
    // a run are no lateness over a second.
    static constexpr int64_t SPAN_NS = WINDOW_NS / 2;
    // Falling: the newer half's median this far under the whole window's.
    static constexpr int64_t FALL_NS = 2000000;
    // Samples are clamped to +-1 h: past that a PTS is garbage.
    static constexpr int64_t LATENESS_LIMIT_NS = 3600LL * 1000000000LL;
    // RISE_RATE 0.5: once the group runs, a ns of wall time lifts the pace half a ns (B-80).
    static constexpr int64_t RISE_DIV = 2;
    // The window: three buckets of fall_after / 2 on the group's clock, the open one the last.
    static constexpr int64_t FALL_AFTER_NS = 180LL * 1000000000LL;
    static constexpr int BUCKETS = 3;
    // Down once the target is this far under the pace, by at most FALL_MAX a skip, the skips
    // FALL_SPACING apart (B-82).
    static constexpr int64_t FALL_MIN_NS = 10000000;
    static constexpr int64_t FALL_MAX_NS = 1000000000;
    static constexpr int64_t FALL_SPACING_NS = 2000000000;

    explicit PaceGroup(int64_t fall_after_ns = FALL_AFTER_NS);
    PaceGroup(const PaceGroup&) = delete;
    PaceGroup& operator=(const PaceGroup&) = delete;

    // seed_ns < 0: none. A seed enters the member's window; `now_ns` < 0 anywhere: no time of
    // the caller's, the group's clock stands in.
    void join(Member m, int64_t seed_ns, int64_t now_ns = -1);
    // The target from the members that remain; the fall follows at once, and reports nothing.
    void leave(Member m, int64_t now_ns = -1);
    // An arrival. `fresh` starts a run (after waiting, an absence or a flush): no stretch
    // reaches back to the member's previous arrival. The lateness enters the window when it
    // counts; from a member not `gapped` it lifts the pace at once (its data is waited for).
    void observe(Member m, int64_t now_ns, int64_t lateness_ns, bool fresh = false,
                 bool gapped = false, Event* ev = nullptr);
    // A late sparse cue's lateness enters the member's window (C-3).
    void raise(Member m, int64_t pace_ns, int64_t now_ns = -1, Event* ev = nullptr);
    // Time alone: the buckets rotate when due, and a due skip falls.
    void tick(int64_t now_ns, Event* ev = nullptr);
    // A member pushed something timed: the aggregator runs, for the rest of the group's life.
    void start();
    bool started() const { return started_; }
    int64_t fall_after() const { return fall_after_ns_; }

    // The pace at `now_ns` (the snapshot's formula, under the lock); pace() at the group's clock.
    int64_t pace_at(int64_t now_ns) const;
    int64_t pace() const;
    int64_t target() const { return target_; }
    // The last state published, on any thread, lock-free: a seqlock the writers (under the
    // registry's lock, or one thread) update whenever a field changes.
    Snapshot snapshot() const;
    // The member's lateness over the second before its last arrival (that arrival's own
    // before any stretch counts); false before any.
    bool lateness(Member m, int64_t* out) const;
    // The member's need: its lateness when it last counted; false before any.
    bool need(Member m, int64_t* out) const;
    // The member's peak over its window; false while it holds none.
    bool peak(Member m, int64_t* out) const;
    size_t size() const { return members_.size(); }

  private:
    static constexpr int64_t NONE = INT64_MIN;
    struct Stretch {
        int64_t end;   // the arrival that closed it
        int64_t len;
        int64_t mid;   // the lateness halfway through it
        bool counts;   // the lateness did not fall over it
    };
    // A stretch that counts, in the order the median reads them: by mid, then length (B-57).
    // Its end finds it again when it leaves the window.
    struct Counted {
        int64_t mid, len, end;
        bool operator<(const Counted& o) const {
            return mid != o.mid ? mid < o.mid : len != o.len ? len < o.len : end < o.end;
        }
    };
    struct State {
        bool has_last = false;
        int64_t last_at = 0, last_lateness = 0;
        std::deque<Stretch> window;   // the stretches that end in the last second
        int64_t span = 0;             // their total length
        int64_t len = 0;              // the length of those that count
        std::vector<Counted> counted; // those, in order
        bool has_level = false;
        int64_t level = 0;   // the median at the last arrival, shown
        bool has_need = false;
        int64_t need = 0;    // the last level that counted
        int64_t peaks[BUCKETS] = {NONE, NONE, NONE};   // the window's, oldest first
    };
    static bool falling(const State& s, int64_t now_ns);
    // The group's clock moved to `now_ns`; the time a call works at, -1 before any.
    int64_t advance(int64_t now_ns);
    void rotate();
    void enter(State& s, int64_t v);
    int64_t window_target() const;
    // After a call moved the target from `was` while the pace was `cur`: a rise steps to `floor`
    // and slews on from there, a target at or under cur ends the rise and falls by the rule
    // (`skip` false: not now).
    void settle(int64_t t, int64_t cur, int64_t was, Event* ev, bool skip = true,
                int64_t floor = NONE);
    int64_t next_at() const;
    void publish();

    std::map<Member, State> members_;
    const int64_t fall_after_ns_, bucket_ns_;
    int64_t target_ = 0;
    int64_t base_ = 0, base_at_ = 0;
    bool started_ = false;
    bool has_clock_ = false;
    int64_t clock_ = 0, next_rotation_ = 0;
    int64_t next_skip_ = NONE;
    bool quiet_ = false;   // the fall under way is for a member that left: its skips report nothing
    // The snapshot: odd `seq_` while it is written.
    std::atomic<uint32_t> seq_{0};
    std::atomic<int64_t> pub_target_{0}, pub_base_{0}, pub_base_at_{0}, pub_next_at_{0};
    std::atomic<bool> pub_started_{false};
};

// The process's pace groups, keyed by pipeline and aligner name ("all watchdogs of one
// aggregator share a pace group"); thread-safe. A group goes with its last member.
class PaceRegistry {
  public:
    struct Membership {
        std::string key;
        PaceGroup::Member member = 0;   // 0: not joined
        bool late = false;              // joined a running group: gapped while it catches up
        // The member's group while joined: only its last member's leave erases it.
        PaceGroup* group = nullptr;
        // The group's pace at `now_ns`, lock-free; 0 when not joined.
        int64_t pace_ns(int64_t now_ns) const;
        PaceGroup::Snapshot snapshot() const;
    };
    struct View {
        int64_t pace_ns = 0;
        int64_t target_ns = 0;
        bool has_lateness = false;
        int64_t lateness_ns = 0;   // this member's
        size_t members = 0;
    };

    static PaceRegistry& global();

    // A new group takes `fall_after_ns`; a group that exists keeps its own.
    Membership join(const std::string& key, int64_t seed_ns,
                    int64_t fall_after_ns = PaceGroup::FALL_AFTER_NS, int64_t now_ns = -1);
    void leave(Membership* m, int64_t now_ns = -1);   // and clears it; a second call is a no-op
    void observe(const Membership& m, int64_t now_ns, int64_t lateness_ns, bool fresh = false,
                 bool gapped = false, PaceGroup::Event* ev = nullptr);
    void raise(const Membership& m, int64_t pace_ns, int64_t now_ns = -1,
               PaceGroup::Event* ev = nullptr);
    void tick(const Membership& m, int64_t now_ns, PaceGroup::Event* ev = nullptr);
    // The member pushed something timed: whoever joins its group from now on is `late`.
    void start(const Membership& m);
    // The pace at `now_ns` (< 0: at the group's clock), the target and this member's lateness.
    View view(const Membership& m, int64_t now_ns = -1) const;
    size_t groups() const;

  private:
    mutable std::mutex mu_;
    std::map<std::string, PaceGroup> groups_;
    PaceGroup::Member next_ = 0;
};

// One input's emitted horizon and the gaps it needs (part 4.3 job 4).
class GapPlanner {
  public:
    struct Gap {
        int64_t start_ns;
        int64_t end_ns;   // == start_ns: no span, only the zero-length GAP that ends one
    };
    bool has_horizon() const { return has_; }
    int64_t horizon_ns() const { return horizon_; }
    // [start, end) is stale: it ends before the horizon, or at it with content before it.
    bool stale(int64_t start_ns, int64_t end_ns) const;
    // Something that ends at end_ns went out: the horizon never moves back.
    void emitted(int64_t end_ns);
    // This tick's gap, the horizon to min(now - pace, *next_ns): no gap passes a queued item.
    // Without a horizon, a zero-length one there. Moves the horizon; false: nothing to push.
    bool take(int64_t now_ns, int64_t pace_ns, const int64_t* next_ns, Gap* out);
    // The next `piece_ns` from the horizon (from now - pace without one), due as data of that
    // length would be: once now - pace reaches its start. Never past *next_ns; moves the
    // horizon; false: none due.
    bool take_piece(int64_t now_ns, int64_t pace_ns, int64_t piece_ns, const int64_t* next_ns,
                    Gap* out);
    void reset();

  private:
    bool has_ = false;
    int64_t horizon_ = 0;
};

}  // namespace mrts
