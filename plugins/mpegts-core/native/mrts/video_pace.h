// mrts::VideoPace and mrts::DisplayRate (ch. 15.4 B-161, B-162, B-175): when each frame leaves
// mrvideopace, which go so that a slower display keeps up, and the display period it paces to. The
// port of ../../py/video_pace.py by parity (its docstrings state the rules); integer ns, no GStreamer.
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
    bool rate_drop;       // dropped at once to match the display (or the drain's, B-179)
    // For the drain servo (B-179): late: arrival past its drained slot by late_by_ns (not collapsed, not the
    // sink's wait); has_slack: slack_ns = slot' - arrival (neither a first, a collapsed nor a sink-late frame).
    bool late = false, has_slack = false;
    int64_t late_by_ns = 0, slack_ns = 0;
};

struct PaceSummary {
    uint64_t released = 0, late = 0, rate_drops = 0, gaps_collapsed = 0;
    uint64_t behind = 0;          // rate drops of a display a period behind, not foreseen
    uint64_t drain_drops = 0;     // drops the drain made, a shadow lag at delta 0 would not (B-179)
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
    static constexpr int64_t DRAIN_MAX_PPB = 5000000;   // the drain's clamp (B-179): 0.5 %

    explicit VideoPace(int64_t gap_threshold_ns = GAP_THRESHOLD_NS);

    // A frame entering at arrival_ns with PTS pts_ns (ns, unwrapped) and dur_ns (the buffer's
    // duration, else the caps' frame period, else 0); held: it waited for the element's previous
    // push to return (its arrival is the sink's).
    PaceDecision on_frame(int64_t pts_ns, int64_t dur_ns, int64_t arrival_ns, bool discont,
                          bool held = false);
    // A GAP event: the next frame's delta collapses.
    void on_gap() { gap_pending_ = true; }
    // period <= 0 reads as none.
    void set_display(int64_t period_ns, DisplaySource source);
    // The drain's rate (B-179): the cadence on Δ' = Δ·1e9 / (1e9 + δ), clamped to +-0.5 %.
    void set_drain(int64_t ppb);
    int64_t drain() const { return drain_; }
    // Counters since construction and the mean hold since the last take, which restarts it.
    PaceSummary take();
    // The same without restarting the mean hold (the element's stats between its messages).
    PaceSummary peek() const;
    int64_t content_period() const { return window_n_ ? ordered_[window_n_ / 2] : 0; }

  private:
    void add_clean(int64_t delta);
    bool decimating(int64_t tc) const;
    int64_t drained(int64_t d) const;

    int64_t gap_threshold_ns_;
    bool have_prev_ = false;
    int64_t prev_pts_ = 0;        // the previous frame's PTS, kept or dropped
    int64_t prev_release_ = 0;    // the cadence: its release, or its slot when the sink held it
    int64_t prev_slot0_ = 0;      // the cadence at delta 0, the sink's wait read on it (B-179)
    bool gap_pending_ = false;
    int64_t window_[PERIOD_WINDOW] = {};    // the last clean deltas, a ring from window_head_
    int64_t ordered_[PERIOD_WINDOW] = {};   // the same, sorted
    int window_head_ = 0, window_n_ = 0;
    int64_t display_period_ = 0;
    DisplaySource display_source_ = DisplaySource::none;
    int64_t lag_ = 0;             // L: the display's lag behind the content, ns
    uint64_t released_ = 0, late_ = 0, rate_drops_ = 0, gaps_collapsed_ = 0, behind_ = 0;
    int64_t drain_ = 0;           // δ, ppb
    int64_t shadow_ = 0;          // the lag at δ = 0
    int64_t owed_ = 0;            // shadow drops the real lag has not made
    uint64_t drain_drops_ = 0;
    __int128 hold_sum_ = 0;
    uint64_t hold_count_ = 0;
};

// The display period VideoPace paces to (B-175): the presentation period the sink achieves while it
// sets the pace (pushes that left at once on the last one's return, in windows of 10 s, the last 5
// pooled by their median), else S12's refresh, else the prior (nominal), else none.
class DisplayRate {
  public:
    static constexpr int64_t WINDOW_NS = 10000000000LL;
    static constexpr int WINDOWS = 5;
    static constexpr int NEED = 3;
    static constexpr int64_t HICCUP_DEN = 200;    // a window 0.5 % over the median is a hiccup
    static constexpr int64_t RESTART_DEN = 100;   // the refresh or the prior moving 1 %: again

    // The mode's refresh (refresh-mhz), 0 unknown.
    void set_prior(int64_t period_ns);
    // S12's measured refresh; 0 (not measured now) leaves the last one.
    void set_refresh(int64_t period_ns);
    // New caps: the achieved period is measured again.
    void restart();
    // A kept push returned at returned_ns; pressed: it left at once on the last one's return.
    void on_push(int64_t returned_ns, bool pressed);
    // The achieved period, 0 before NEED windows.
    int64_t achieved() const;
    // The windows kept, at most WINDOWS.
    int windows() const { return windows_n_; }
    // S12's refresh and the prior as last set (0 unknown).
    int64_t refresh() const { return refresh_; }
    int64_t prior() const { return prior_; }
    // The period and source for VideoPace::set_display.
    int64_t period(DisplaySource* source) const;

  private:
    struct Window {
        __int128 span;
        int64_t pushes;
    };
    int64_t prior_ = 0, refresh_ = 0;
    bool have_prev_ = false;
    int64_t prev_return_ = 0, run_from_ = 0, run_pushes_ = 0;
    Window windows_[WINDOWS] = {};   // a ring of the last windows from windows_head_
    int windows_head_ = 0, windows_n_ = 0;
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
