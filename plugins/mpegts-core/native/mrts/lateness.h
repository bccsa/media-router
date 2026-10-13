// Lateness window (house-clock design §9.5): the one accumulator behind every
// module's lateness reading. The `mrlateness` element, mr-tssplit and
// mr-bus-fanout all feed it, so a window means the same thing everywhere.
// Lateness λ = now − PTS on the house clock; negative means early.
#pragma once
#include <cstdint>
#include <string>

namespace mrts {

class LatenessWindow {
  public:
    // One closed window. The ns fields are 0 when count is 0 (untimed only).
    struct Summary {
        uint64_t count = 0;        // timed samples
        uint64_t untimed = 0;      // buffers with no usable timestamp
        int64_t min_ns = 0;
        int64_t max_ns = 0;
        int64_t mean_ns = 0;
        int64_t last_ns = 0;
        int64_t interval_ns = 0;   // how long the window was open
    };

    static constexpr int64_t DEFAULT_WINDOW_NS = 2000000000;   // module stats cadence

    explicit LatenessWindow(int64_t window_ns = DEFAULT_WINDOW_NS);

    void add(int64_t lateness_ns);
    void add_untimed();

    // The window opens at the first due() call, so a tap built long before
    // its first buffer does not close a window that spans the wait.
    bool due(int64_t now_ns);
    // Closes the window at now_ns and opens the next one there.
    Summary take(int64_t now_ns);

    int64_t window_ns() const { return window_ns_; }
    bool empty() const { return count_ == 0 && untimed_ == 0; }

  private:
    int64_t window_ns_;
    int64_t start_ns_ = 0;
    bool open_ = false;
    uint64_t count_ = 0;
    uint64_t untimed_ = 0;
    int64_t min_ns_ = 0;
    int64_t max_ns_ = 0;
    int64_t last_ns_ = 0;
    // A double sum: an int64 one overflows on a garbage PTS (λ ~1e15 ns) at
    // ~10k buffers, and 53 bits stay exact far past any real window's total.
    double sum_ns_ = 0;
};

// A window as the sidecars' stats-line object, in ms (house-clock plan
// WI-P0-8): {"count","untimed","min","mean","max"}. The engine's
// LatenessReporter reads this shape from mr-tssplit and mr-bus-fanout.
std::string lateness_json_ms(const LatenessWindow::Summary& s);

}  // namespace mrts
