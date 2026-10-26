// mrts::VideoPace (plan ch. 8 part 4.2, WI-P4-3; ch. 15.4 B-161, B-162): when each decoded frame
// leaves mrvideopace, and which frames go so that a display slower than the content keeps up.
// The port of ../../py/video_pace.py, decision for decision (video_pace_parity_test.py holds the
// two equal); its docstring states the rules. Integer ns, no GStreamer, no allocation per frame.
#pragma once
#include <cstddef>
#include <cstdint>

namespace mrts {

// Where the display period came from: presentation feedback or a blocking sink's returns
// (measured), the mode's refresh (nominal), or nothing (none: no decimation).
enum class DisplaySource { none, nominal, measured };
const char* display_source_name(DisplaySource s);
// "none", "nominal" or "measured"; false for anything else.
bool parse_display_source(const char* name, DisplaySource* out);

struct PaceDecision {
    int64_t release_ns;   // the element clock's ns (base time 0) the frame leaves at; a drop's slot
    bool rate_drop;       // dropped at once to match the display
};

struct PaceSummary {
    uint64_t released = 0, late = 0, rate_drops = 0, gaps_collapsed = 0;
    int64_t content_period = 0;   // the median of the last 120 clean deltas; 0 before the first
    int64_t display_period = 0;
    DisplaySource display_source = DisplaySource::none;
    int64_t mean_hold = 0;        // release - arrival over the kept frames since the last take
};

class VideoPace {
  public:
    static constexpr int64_t GAP_THRESHOLD_NS = 250000000;
    static constexpr int PERIOD_WINDOW = 120;   // clean deltas in the content period's median
    static constexpr int64_t NOMINAL_BAND_DEN = 2000;   // the 0.05 % band on a nominal refresh

    explicit VideoPace(int64_t gap_threshold_ns = GAP_THRESHOLD_NS);

    // A frame entering at arrival_ns with PTS pts_ns (ns, unwrapped) and dur_ns (the buffer's
    // duration, else the caps' frame period, else 0).
    PaceDecision on_frame(int64_t pts_ns, int64_t dur_ns, int64_t arrival_ns, bool discont);
    // A GAP event: the next frame's delta collapses.
    void on_gap() { gap_pending_ = true; }
    // period <= 0 reads as none.
    void set_display(int64_t period_ns, DisplaySource source);
    // Counters since construction and the mean hold since the last take, which restarts it.
    PaceSummary take();
    // The same without restarting the mean hold (the element's stats between its messages).
    PaceSummary peek() const;
    int64_t content_period() const { return window_n_ ? ordered_[window_n_ / 2] : 0; }

  private:
    void add_clean(int64_t delta);
    bool decimating(int64_t tc) const;

    int64_t gap_threshold_ns_;
    bool have_prev_ = false;
    int64_t prev_pts_ = 0;        // the previous frame's PTS, kept or dropped
    int64_t prev_release_ = 0;
    bool gap_pending_ = false;
    int64_t window_[PERIOD_WINDOW] = {};    // the last clean deltas, a ring from window_head_
    int64_t ordered_[PERIOD_WINDOW] = {};   // the same, sorted
    int window_head_ = 0, window_n_ = 0;
    int64_t display_period_ = 0;
    DisplaySource display_source_ = DisplaySource::none;
    int64_t lag_ = 0;             // L: the display's lag behind the content, ns
    uint64_t released_ = 0, late_ = 0, rate_drops_ = 0, gaps_collapsed_ = 0;
    __int128 hold_sum_ = 0;
    uint64_t hold_count_ = 0;
};

// A display period and whether the samples behind it span under 60 s.
struct DisplayPeriod {
    int64_t period_ns = 0;
    bool short_span = true;
};

// One wp_presentation_feedback.presented sample: its time (CLOCK_MONOTONIC ns) and the MSC.
struct PresentedSample {
    int64_t presented_ns;
    int64_t seq;
};

// S12: Δt/Δseq over the steps between consecutive samples (oldest first) whose own Δt/Δseq is
// within 10 % of the median step's; {0, true} without a step.
DisplayPeriod display_period_from_feedback(const PresentedSample* samples, size_t n);
// A blocking sink without stats (kmssink) from the times its pushes returned, oldest first:
// whole refreshes per interval, the mode's refresh (prior_ns > 0) as the base when it fits.
DisplayPeriod display_period_from_returns(const int64_t* times, size_t n, int64_t prior_ns);

}  // namespace mrts
