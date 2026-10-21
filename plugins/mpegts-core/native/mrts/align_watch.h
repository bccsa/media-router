// The aligner input's arithmetic (plan ch. 6 part 4.3, WI-P2-6): W from an input's arrival
// rhythm, the pace one aggregator's inputs share and the gaps an absent input gets. Times are
// ns of pipeline running time. No GStreamer, no GLib: mralignwatch is the GStreamer side.
#pragma once
#include <cstdint>
#include <deque>
#include <map>
#include <mutex>
#include <string>
#include <utility>
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

// The pace of one aggregator's inputs (part 4.3 job 3): at least 0, each member's seed and
// each lateness a member showed over a second. It rises only, and is recomputed from the
// members that remain when one leaves. PaceRegistry's lock guards it.
//
// A member's lateness: the median over wall time of its last second, each stretch between two
// arrivals at its midpoint, leaving out those over which it fell (a backlog draining, at any
// speed). It goes into the pace only while a third of the window counts and it is not falling.
class PaceGroup {
  public:
    using Member = uint64_t;
    static constexpr int64_t WINDOW_NS = 1000000000;   // a member's lateness: over its last 1 s
    // It counts toward the pace once its stretches span half the second: the first arrivals of
    // a run are no lateness over a second.
    static constexpr int64_t SPAN_NS = WINDOW_NS / 2;
    // Falling: the newer half's median this far under the whole window's.
    static constexpr int64_t FALL_NS = 2000000;
    // Samples are clamped to +-1 h: past that a PTS is garbage.
    static constexpr int64_t LATENESS_LIMIT_NS = 3600LL * 1000000000LL;

    // seed_ns < 0: none.
    void join(Member m, int64_t seed_ns);
    void leave(Member m);
    // An arrival. `fresh` starts a run (after waiting, an absence or a flush): no stretch
    // reaches back to the member's previous arrival. The lateness goes into the pace when it
    // counts.
    void observe(Member m, int64_t now_ns, int64_t lateness_ns, bool fresh = false);
    void raise(int64_t pace_ns);
    // A member pushed something timed: the aggregator runs, for the rest of the group's life.
    void start() { started_ = true; }
    bool started() const { return started_; }

    int64_t pace() const { return pace_; }
    // The member's lateness over the second before its last arrival (that arrival's own
    // before any stretch counts); false before any.
    bool lateness(Member m, int64_t* out) const;
    size_t size() const { return members_.size(); }

  private:
    struct Stretch {
        int64_t end;   // the arrival that closed it
        int64_t len;
        int64_t mid;   // the lateness halfway through it
        bool counts;   // the lateness did not fall over it
    };
    struct State {
        int64_t seed = -1;
        bool has_last = false;
        int64_t last_at = 0, last_lateness = 0;
        std::deque<Stretch> window;   // the stretches that end in the last second
        int64_t span = 0;             // their total length
        int64_t len = 0;              // the length of those that count
        bool has_level = false;
        int64_t level = 0;   // the median at the last arrival, shown
        bool has_need = false;
        int64_t need = 0;    // the last level that counted: an absent member's need
    };
    static bool median(const std::deque<Stretch>& w, int64_t after, int64_t* out,
                       std::vector<std::pair<int64_t, int64_t>>* scratch);
    std::map<Member, State> members_;
    std::vector<std::pair<int64_t, int64_t>> scratch_;   // (mid, len), sorted per arrival
    int64_t pace_ = 0;
    bool started_ = false;
};

// The process's pace groups, keyed by pipeline and aligner name ("all watchdogs of one
// aggregator share a pace group"); thread-safe. A group goes with its last member.
class PaceRegistry {
  public:
    struct Membership {
        std::string key;
        PaceGroup::Member member = 0;   // 0: not joined
        bool late = false;              // joined a running group: gapped while it waits
    };
    struct View {
        int64_t pace_ns = 0;
        bool has_lateness = false;
        int64_t lateness_ns = 0;   // this member's
        size_t members = 0;
    };

    static PaceRegistry& global();

    Membership join(const std::string& key, int64_t seed_ns);
    void leave(Membership* m);   // and clears it; a second call is a no-op
    void observe(const Membership& m, int64_t now_ns, int64_t lateness_ns, bool fresh = false);
    void raise(const Membership& m, int64_t pace_ns);
    // The member pushed something timed: whoever joins its group from now on is `late`.
    void start(const Membership& m);
    View view(const Membership& m) const;
    size_t groups() const;

  private:
    View view_locked(const Membership& m) const;
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
