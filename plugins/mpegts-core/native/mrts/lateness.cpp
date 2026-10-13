#include "lateness.h"

#include <cmath>
#include <cstdio>

namespace mrts {

LatenessWindow::LatenessWindow(int64_t window_ns)
    : window_ns_(window_ns > 0 ? window_ns : DEFAULT_WINDOW_NS) {}

void LatenessWindow::add(int64_t lateness_ns) {
    if (count_ == 0) {
        min_ns_ = max_ns_ = lateness_ns;
    } else {
        if (lateness_ns < min_ns_) min_ns_ = lateness_ns;
        if (lateness_ns > max_ns_) max_ns_ = lateness_ns;
    }
    last_ns_ = lateness_ns;
    sum_ns_ += (double)lateness_ns;
    count_++;
}

void LatenessWindow::add_untimed() { untimed_++; }

bool LatenessWindow::due(int64_t now_ns) {
    if (!open_) {
        open_ = true;
        start_ns_ = now_ns;
        return false;
    }
    return now_ns - start_ns_ >= window_ns_;
}

LatenessWindow::Summary LatenessWindow::take(int64_t now_ns) {
    Summary s;
    s.count = count_;
    s.untimed = untimed_;
    if (count_ > 0) {
        s.min_ns = min_ns_;
        s.max_ns = max_ns_;
        s.last_ns = last_ns_;
        s.mean_ns = (int64_t)std::llround(sum_ns_ / (double)count_);
    }
    s.interval_ns = open_ ? now_ns - start_ns_ : 0;
    open_ = true;
    start_ns_ = now_ns;
    count_ = untimed_ = 0;
    min_ns_ = max_ns_ = last_ns_ = 0;
    sum_ns_ = 0;
    return s;
}

std::string lateness_json_ms(const LatenessWindow::Summary& s) {
    char buf[192];
    std::snprintf(buf, sizeof buf,
                  "{\"count\":%llu,\"untimed\":%llu,\"min\":%.3f,\"mean\":%.3f,\"max\":%.3f}",
                  (unsigned long long)s.count, (unsigned long long)s.untimed, s.min_ns / 1e6,
                  s.mean_ns / 1e6, s.max_ns / 1e6);
    return buf;
}

}  // namespace mrts
