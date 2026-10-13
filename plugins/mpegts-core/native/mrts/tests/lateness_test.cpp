// LatenessWindow: window boundaries, negative lateness, untimed counting and
// empty windows (house-clock plan WI-P0-7).
#include <cstdint>

#include "../lateness.h"
#include "check.h"

using namespace mrts;

namespace {

constexpr int64_t MS = 1000000;

void test_boundaries() {
    LatenessWindow w(100 * MS);
    CHECK("default window is 2 s", LatenessWindow().window_ns() == 2000 * MS);
    CHECK("non-positive window falls back to the default",
          LatenessWindow(0).window_ns() == LatenessWindow::DEFAULT_WINDOW_NS);
    CHECK("first due() opens the window, never closes it", !w.due(1000 * MS));
    w.add(5 * MS);
    CHECK("not due 1 ns before the boundary", !w.due(1100 * MS - 1));
    CHECK("due exactly at the boundary", w.due(1100 * MS));
    CHECK("due past the boundary", w.due(1500 * MS));
    LatenessWindow::Summary s = w.take(1100 * MS);
    CHECK("interval is the time the window was open", s.interval_ns == 100 * MS);
    CHECK("one sample", s.count == 1 && s.mean_ns == 5 * MS);
    CHECK("next window opens at take()", !w.due(1199 * MS) && w.due(1200 * MS));
    CHECK("a taken window is empty", w.empty());

    // A late take (no buffers for a while) reports the true span, and the
    // next window starts there instead of catching up in a burst.
    w.add(1 * MS);
    s = w.take(5000 * MS);
    CHECK("late take reports the full span", s.interval_ns == 3900 * MS);
    CHECK("after a late take the window restarts at that take",
          !w.due(5099 * MS) && w.due(5100 * MS));

    LatenessWindow fresh(100 * MS);
    fresh.add(1);
    CHECK("take() before any due() has zero interval", fresh.take(42).interval_ns == 0);
    CHECK("and opens the window there", !fresh.due(42 + 100 * MS - 1) && fresh.due(42 + 100 * MS));
}

void test_stats() {
    LatenessWindow w(100 * MS);
    w.due(0);
    w.add(300 * MS);
    w.add(100 * MS);
    w.add(200 * MS);
    LatenessWindow::Summary s = w.take(100 * MS);
    CHECK("count", s.count == 3);
    CHECK("min", s.min_ns == 100 * MS);
    CHECK("max", s.max_ns == 300 * MS);
    CHECK("mean", s.mean_ns == 200 * MS);
    CHECK("last is the last added, not the max", s.last_ns == 200 * MS);
    CHECK("no untimed", s.untimed == 0);

    // Mean rounds to the nearest ns.
    w.add(1);
    w.add(2);
    s = w.take(200 * MS);
    CHECK("mean rounds half away from zero", s.mean_ns == 2);

    // Stats from the previous window never leak into the next.
    w.add(-7);
    s = w.take(300 * MS);
    CHECK("min/max reset per window", s.min_ns == -7 && s.max_ns == -7 && s.count == 1);
}

void test_negative() {
    LatenessWindow w(100 * MS);
    w.due(0);
    w.add(-40 * MS);   // early: PTS ahead of now
    w.add(-10 * MS);
    w.add(20 * MS);
    LatenessWindow::Summary s = w.take(100 * MS);
    CHECK("negative min kept", s.min_ns == -40 * MS);
    CHECK("max across the sign", s.max_ns == 20 * MS);
    CHECK("negative mean", s.mean_ns == -10 * MS);

    w.add(-5 * MS);
    w.add(-1 * MS);
    s = w.take(200 * MS);
    CHECK("all-negative window: max is the least early", s.max_ns == -1 * MS);
    CHECK("all-negative window: mean", s.mean_ns == -3 * MS);
}

void test_untimed() {
    LatenessWindow w(100 * MS);
    w.due(0);
    w.add_untimed();
    w.add_untimed();
    CHECK("untimed makes the window non-empty", !w.empty());
    LatenessWindow::Summary s = w.take(100 * MS);
    CHECK("untimed counted", s.untimed == 2);
    CHECK("untimed are not samples", s.count == 0);
    CHECK("untimed-only window has zero stats",
          s.min_ns == 0 && s.max_ns == 0 && s.mean_ns == 0 && s.last_ns == 0);

    w.add_untimed();
    w.add(50 * MS);
    s = w.take(200 * MS);
    CHECK("mixed window: untimed do not drag the mean", s.count == 1 && s.untimed == 1
                                                            && s.mean_ns == 50 * MS);
}

void test_empty() {
    LatenessWindow w(100 * MS);
    CHECK("new window is empty", w.empty());
    w.due(0);
    LatenessWindow::Summary s = w.take(100 * MS);
    CHECK("empty window: zero counts", s.count == 0 && s.untimed == 0);
    CHECK("empty window: zero stats",
          s.min_ns == 0 && s.max_ns == 0 && s.mean_ns == 0 && s.last_ns == 0);
    CHECK("empty window still reports its interval", s.interval_ns == 100 * MS);
}

void test_large_values() {
    // A garbage PTS gives λ near the monotonic clock itself; the sum must not
    // overflow over a busy window.
    LatenessWindow w(100 * MS);
    w.due(0);
    const int64_t huge = INT64_C(4000000000000000);   // ~46 days in ns
    for (int i = 0; i < 100000; i++) w.add(huge);
    LatenessWindow::Summary s = w.take(100 * MS);
    CHECK("huge values: mean exact", s.mean_ns == huge);
    CHECK("huge values: count", s.count == 100000);
}

void test_json() {
    LatenessWindow w(100 * MS);
    w.due(0);
    w.add(-1500000);
    w.add(2500000);
    w.add_untimed();
    CHECK("stats-line json in ms",
          lateness_json_ms(w.take(100 * MS))
              == "{\"count\":2,\"untimed\":1,\"min\":-1.500,\"mean\":0.500,\"max\":2.500}");
}

}  // namespace

int main() {
    test_boundaries();
    test_stats();
    test_negative();
    test_untimed();
    test_empty();
    test_large_values();
    test_json();
    return test_summary("lateness");
}
