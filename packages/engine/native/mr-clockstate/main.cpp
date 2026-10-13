// mr-clockstate — the engine's clock sidecar (house-clock design §4.2, §10.3).
// Streams one `sample` JSON line per second (E = TAI - MONO plus the kernel's
// adjtimex sync state) and a `step` line the moment the kernel steps REALTIME.
// Stateless: it reports, the engine's HouseClock latches and decides.
//
//   mr-clockstate          stream until SIGTERM or stdout closes
//   mr-clockstate --once   print one sample and exit 0 (Device Manager, tests)
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <sys/timerfd.h>
#include <unistd.h>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <string>

#include "clock_sample.h"

using namespace mrclock;

static volatile sig_atomic_t g_stop = 0;
static constexpr int64_t SAMPLE_INTERVAL_NS = 1000000000LL;

// Whole line in as few writes as it takes; false once the reader is gone.
static bool emit(const std::string& json) {
    std::string line = json + "\n";
    const char* p = line.data();
    size_t left = line.size();
    while (left) {
        ssize_t n = write(STDOUT_FILENO, p, left);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return false;
        p += n;
        left -= (size_t)n;
    }
    return true;
}

static bool emit_sample() { return emit(sample_json(sample_epoch(), read_kernel())); }

// CANCEL_ON_SET makes the pending read fail with ECANCELED whenever the kernel
// calls clock_was_set (settimeofday, clock_settime, an adjtimex step). The
// expiry only has to be beyond anything the box will reach.
static bool arm_step_watch(int fd) {
    int64_t far = (int64_t)time(nullptr) + 100LL * 365 * 86400;
    if (far > (int64_t)std::numeric_limits<time_t>::max()) far = std::numeric_limits<time_t>::max();
    struct itimerspec its {};
    its.it_value.tv_sec = (time_t)far;
    return timerfd_settime(fd, TFD_TIMER_ABSTIME | TFD_TIMER_CANCEL_ON_SET, &its, nullptr) == 0;
}

int main(int argc, char** argv) {
    bool once = false;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--once") {
            once = true;
        } else {
            std::fprintf(stderr, "usage: mr-clockstate [--once]\n");
            return 2;
        }
    }
    signal(SIGPIPE, SIG_IGN);  // a closed stdout surfaces as a failed write
    if (once) return emit_sample() ? 0 : 1;

    struct sigaction sa {};
    sa.sa_handler = [](int) { g_stop = 1; };
    sigaction(SIGTERM, &sa, nullptr);
    sigaction(SIGINT, &sa, nullptr);

    // Armed before the first sample so no step can fall between the two.
    int tfd = timerfd_create(CLOCK_REALTIME, TFD_CLOEXEC);
    if (tfd >= 0 && !arm_step_watch(tfd)) {
        close(tfd);
        tfd = -1;
    }
    // Without the watch the engine's 1 ms divergence check still catches steps.
    if (tfd < 0)
        std::fprintf(stderr, "mr-clockstate: no timerfd step watch: %s\n", std::strerror(errno));

    int64_t next = read_clock_ns(CLOCK_MONOTONIC);
    while (!g_stop) {
        int64_t now = read_clock_ns(CLOCK_MONOTONIC);
        if (now >= next) {
            if (!emit_sample()) break;
            next += SAMPLE_INTERVAL_NS;
            if (next <= now) next = now + SAMPLE_INTERVAL_NS;  // we slept through ticks
            continue;
        }
        struct pollfd pfd {tfd, POLLIN, 0};
        int timeout_ms = (int)((next - now + 999999) / 1000000);
        int r = poll(&pfd, tfd >= 0 ? 1 : 0, timeout_ms);
        if (r < 0 && errno != EINTR) break;
        if (r <= 0 || !(pfd.revents & POLLIN)) continue;

        uint64_t expirations;
        ssize_t n = read(tfd, &expirations, sizeof expirations);
        if (n < 0 && errno == ECANCELED) {
            if (!emit(step_json(read_clock_ns(CLOCK_MONOTONIC)))) break;
            arm_step_watch(tfd);
            if (!emit_sample()) break;  // the post-step E, without waiting a tick
            next = read_clock_ns(CLOCK_MONOTONIC) + SAMPLE_INTERVAL_NS;
        } else if (n == (ssize_t)sizeof expirations) {
            arm_step_watch(tfd);  // the far expiry was reached: just re-arm
        }
    }
    if (tfd >= 0) close(tfd);
    return 0;
}
