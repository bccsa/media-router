// The runner's edge bookkeeping stays on the main loop (B-193): the real bus_edges code on a real
// appsrc ! tee. No ThreadSanitizer on the dev Pi's 47-bit address space, so a test probe holds the
// push a teardown waits for, and the teardown probe fires on the streaming thread every time.
#include <fcntl.h>
#include <gst/gst.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "../bus_edges.h"
#include "../edge_path.h"
#include "../ipc.h"
#include "../json_util.h"
#include "../runner.h"
#include "mrts/tests/check.h"

namespace {

constexpr const char* TEE = "busout_41000";
constexpr int CYCLES_HELD = 40;      // deterministic: each teardown probe on the streaming thread
constexpr int CYCLES_STRESS = 400;   // buffers flowing: each probe on whichever thread holds the pad

// --- events: ipc writes them to fd 4, a file here -----------------------------------------

int g_events_fd = -1;
std::string g_partial;
std::map<std::pair<std::string, std::string>, size_t> g_counts;   // (event, socket) -> seen; "" = any

void read_events() {
    char buf[8192];
    ssize_t n;
    while ((n = ::read(g_events_fd, buf, sizeof buf)) > 0) {
        g_partial.append(buf, (size_t)n);
        size_t nl;
        while ((nl = g_partial.find('\n')) != std::string::npos) {
            std::string line = g_partial.substr(0, nl);
            g_partial.erase(0, nl + 1);
            if (line.rfind("GST_JSON:", 0) != 0) continue;
            JsonObject* o = mr::json_parse_object(line.substr(9), nullptr);
            if (!o) continue;
            std::string name = mr::json_get_string(o, "event"), socket = mr::json_get_string(o, "socket");
            g_counts[{name, ""}]++;
            if (!socket.empty()) g_counts[{name, socket}]++;
            json_object_unref(o);
        }
    }
}

/** Events named `name` (for `socket`, or any when empty) so far. */
size_t count(const char* name, const std::string& socket = "") {
    read_events();
    auto it = g_counts.find({name, socket});
    return it == g_counts.end() ? 0 : it->second;
}

// --- the engine's commands, run where main.cpp runs them: on the main loop's thread ----------

void command(void (*handler)(JsonObject*), const std::string& socket) {
    JsonObject* o = json_object_new();
    json_object_set_string_member(o, "tee", TEE);
    json_object_set_string_member(o, "socket", socket.c_str());
    handler(o);
    json_object_unref(o);
}

void attach(const std::string& socket) { command(mr::bus::handle_bus_attach, socket); }
void detach(const std::string& socket) { command(mr::bus::handle_bus_detach, socket); }

void iterate() {
    while (g_main_context_iteration(nullptr, FALSE)) {
    }
}

/** Poll `pred` for up to `ms`, running the main loop in between only when `loop`. */
bool wait_for(const std::function<bool()>& pred, int ms, bool loop) {
    gint64 end = g_get_monotonic_time() + (gint64)ms * 1000;
    for (;;) {
        if (loop) iterate();
        if (pred()) return true;
        if (g_get_monotonic_time() > end) return false;
        g_usleep(500);
    }
}

// --- the pipeline side -------------------------------------------------------------------

std::atomic<int> g_into_tee{0};   // buffers that reached the tee: one in means the last one left it

GstPadProbeReturn count_cb(GstPad*, GstPadProbeInfo*, gpointer) {
    g_into_tee++;
    return GST_PAD_PROBE_OK;
}

void push(GstElement* src) {
    GstBuffer* b = gst_buffer_new_allocate(nullptr, 188 * 7, nullptr);
    gst_buffer_memset(b, 0, 0xff, 188 * 7);
    GstFlowReturn ret = GST_FLOW_OK;
    g_signal_emit_by_name(src, "push-buffer", b, &ret);
    gst_buffer_unref(b);
}

/** Holds the streaming thread inside one push into an edge, so the tee src pad stays busy. */
struct Hold {
    std::mutex m;
    std::condition_variable cv;
    bool held = false, released = false;
};

GstPadProbeReturn hold_cb(GstPad*, GstPadProbeInfo*, gpointer user) {
    auto* h = static_cast<Hold*>(user);
    std::unique_lock<std::mutex> lk(h->m);
    h->held = true;
    h->cv.notify_all();
    h->cv.wait(lk, [h] { return h->released; });
    return GST_PAD_PROBE_REMOVE;
}

bool wait_held(Hold* h) {
    std::unique_lock<std::mutex> lk(h->m);
    return h->cv.wait_for(lk, std::chrono::seconds(5), [h] { return h->held; });
}

void let_go(Hold* h) {
    std::lock_guard<std::mutex> lk(h->m);
    h->released = true;
    h->cv.notify_all();
}

std::string sink_path(GstElement* branch) {
    std::string out;
    if (!GST_IS_BIN(branch)) return out;
    GstIterator* it = gst_bin_iterate_recurse(GST_BIN(branch));
    GValue v = G_VALUE_INIT;
    for (bool done = false; !done;) {
        switch (gst_iterator_next(it, &v)) {
            case GST_ITERATOR_OK: {
                GstElement* el = GST_ELEMENT(g_value_get_object(&v));
                if (mr::factory_name(el) == "unixfdsink") {
                    gchar* p = nullptr;
                    g_object_get(el, "socket-path", &p, nullptr);
                    if (p) out = p;
                    g_free(p);
                }
                g_value_reset(&v);
                break;
            }
            case GST_ITERATOR_RESYNC: gst_iterator_resync(it); break;
            default: done = true; break;
        }
    }
    g_value_unset(&v);
    gst_iterator_free(it);
    return out;
}

/** Hold the next push into `socket`'s edge (a probe on the tee src pad's peer). Leaked on
 *  purpose: a hold that never fired must not leave its probe a dangling pointer. */
Hold* hold_edge(GstElement* tee, const std::string& socket) {
    const std::string bind = mr::bus::bind_path(socket);
    Hold* h = nullptr;
    GstIterator* it = gst_element_iterate_src_pads(tee);
    GValue v = G_VALUE_INIT;
    for (bool done = false; !done && !h;) {
        switch (gst_iterator_next(it, &v)) {
            case GST_ITERATOR_OK: {
                if (GstPad* peer = gst_pad_get_peer(GST_PAD(g_value_get_object(&v)))) {
                    GstElement* branch = gst_pad_get_parent_element(peer);
                    if (branch && sink_path(branch) == bind) {
                        h = new Hold;
                        gst_pad_add_probe(peer, GST_PAD_PROBE_TYPE_BUFFER, hold_cb, h, nullptr);
                    }
                    if (branch) gst_object_unref(branch);
                    gst_object_unref(peer);
                }
                g_value_reset(&v);
                break;
            }
            case GST_ITERATOR_RESYNC: gst_iterator_resync(it); break;
            default: done = true; break;
        }
    }
    g_value_unset(&v);
    gst_iterator_free(it);
    return h;
}

// --- files -----------------------------------------------------------------------------

struct stat lstat_of(const std::string& p) {
    struct stat st{};
    if (::lstat(p.c_str(), &st) != 0) st.st_ino = 0;
    return st;
}

bool exists(const std::string& p) { return lstat_of(p).st_ino != 0; }

sockaddr_un unix_addr(const std::string& p) {
    sockaddr_un a{};
    a.sun_family = AF_UNIX;
    std::strncpy(a.sun_path, p.c_str(), sizeof a.sun_path - 1);
    return a;
}

bool accepts(const std::string& p) {
    int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    sockaddr_un a = unix_addr(p);
    bool ok = ::connect(fd, (sockaddr*)&a, sizeof a) == 0;
    ::close(fd);
    return ok;
}

/** A successor's listening socket at `p` (fd), or -1. */
int listen_at(const std::string& p) {
    int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    sockaddr_un a = unix_addr(p);
    if (::bind(fd, (sockaddr*)&a, sizeof a) != 0 || ::listen(fd, 1) != 0) {
        ::close(fd);
        return -1;
    }
    return fd;
}

std::vector<std::string> entries(const std::string& dir) {
    std::vector<std::string> out;
    if (GDir* d = g_dir_open(dir.c_str(), 0, nullptr)) {
        while (const gchar* n = g_dir_read_name(d)) out.push_back(n);
        g_dir_close(d);
    }
    return out;
}

// --- the cases -------------------------------------------------------------------------

/** An idle pad: the probe fires inside gst_pad_add_probe, on the main loop, and the record is
 *  dropped there at once, so an attach right after the detach binds without a retry. */
void test_idle_pad(const std::string& dir) {
    std::printf("--- an idle pad: the detach finishes on the main loop, a re-attach binds at once ---\n");
    const std::string s = dir + "/b.sock";
    attach(s);
    CHECK("the attach publishes the edge path", count("bus_attached", s) == 1 && accepts(s));
    detach(s);
    bool detached = count("bus_detached", s) == 1 && !exists(s);
    attach(s);
    bool again = count("bus_attached", s) == 2 && accepts(s);
    CHECK("the detach finishes inside the call: the probe fired on the main loop", detached);
    CHECK("an attach right after it binds at once (the record dropped on the spot, no 250 ms retry)", again);
    detach(s);
    iterate();
    CHECK("and a last detach leaves nothing at the path", count("bus_detached", s) == 2 && !exists(s));
}

/** The teardown probe on the producer's streaming thread, every cycle: the record stays until
 *  the main loop runs, so the bookkeeping never changes off the main loop (the race of MR-018). */
void test_streaming_thread(const std::string& dir, GstElement* src, GstElement* tee) {
    std::printf("\n--- a probe on the streaming thread hands its record to the main loop (%d cycles) ---\n",
                CYCLES_HELD);
    const std::string s = dir + "/a.sock";
    attach(s);
    int held = 0, deferred = 0, finished = 0, released = 0, kept = 0, reattached = 0;
    for (int i = 0; i < CYCLES_HELD; i++) {
        Hold* h = hold_edge(tee, s);
        if (!h) break;
        int into = g_into_tee.load();
        push(src);
        if (!wait_held(h)) {
            let_go(h);
            break;
        }
        held++;
        size_t det0 = count("bus_detached", s);
        detach(s);
        if (count("bus_detached", s) == det0) deferred++;   // the probe waits for the held push
        let_go(h);
        push(src);
        // The next buffer into the tee: the held one, and the probe that fired after it, are done.
        if (!wait_for([&] { return g_into_tee.load() >= into + 2 && count("bus_detached", s) > det0; }, 5000,
                      false))
            break;
        finished++;
        if (!exists(s) && !exists(mr::bus::bind_path(s))) released++;
        size_t att0 = count("bus_attached", s);
        attach(s);   // the main loop has not run since the detach
        if (count("bus_attached", s) == att0) kept++;
        if (wait_for([&] { return count("bus_attached", s) > att0; }, 3000, true)) reattached++;
    }
    const int n = CYCLES_HELD;
    char name[200];
    std::snprintf(name, sizeof name, "every detach met a held push: %d of %d", held, n);
    CHECK(name, held == n);
    std::snprintf(name, sizeof name, "the probe waited for it, so it fired on the streaming thread: %d of %d",
                  deferred, n);
    CHECK(name, deferred == n);
    std::snprintf(name, sizeof name, "and finished there: %d of %d", finished, n);
    CHECK(name, finished == n);
    std::snprintf(name, sizeof name, "the probe released the edge path and the private path: %d of %d", released, n);
    CHECK(name, released == n);
    std::snprintf(name, sizeof name,
                  "the teardown record stayed until the main loop ran: an attach after the probe waited, %d of %d",
                  kept, n);
    CHECK(name, kept == n);
    std::snprintf(name, sizeof name, "the main loop dropped it and that attach went through: %d of %d", reattached,
                  n);
    CHECK(name, reattached == n);
    detach(s);
    wait_for([&] { return !exists(s); }, 3000, true);
    iterate();
}

/** The B-190 corner: an edge whose teardown probe has not fired when the pipeline stops. The
 *  stop releases its path while its sink still listens; the late probe leaves a successor alone. */
void test_stop_mid_teardown(const std::string& dir, GstElement* src, GstElement* tee) {
    std::printf("\n--- a stop while an edge is still detaching releases its path ---\n");
    const std::string s = dir + "/d.sock";
    attach(s);
    Hold* h = hold_edge(tee, s);
    int into = g_into_tee.load();
    if (h) push(src);
    bool held = h && wait_held(h);
    detach(s);
    bool pending = held && count("bus_detached", s) == 0;
    bool listening = accepts(s);
    // What handle_stop and then teardown_pipeline do first.
    mr::bus::clear_pending();
    mr::bus::release_paths();
    CHECK("the detach's probe is still pending at the stop, its sink listening", pending && listening);
    CHECK("the stop releases that edge's path too", !exists(s));
    int successor = !exists(s) ? listen_at(s) : -1;
    ino_t ino = lstat_of(s).st_ino;
    if (h) let_go(h);
    push(src);
    bool fired = wait_for([&] { return g_into_tee.load() >= into + 2 && count("bus_detached", s) == 1; }, 5000,
                          false);
    CHECK("the probe fires later and leaves the path a successor took since alone",
          fired && successor >= 0 && lstat_of(s).st_ino == ino && accepts(s) && !exists(mr::bus::bind_path(s)));
    if (successor >= 0) ::close(successor);
    ::unlink(s.c_str());
    iterate();
}

/** Many cycles with buffers flowing: the main loop attaches and detaches while each teardown
 *  probe fires on whichever thread holds the pad; one edge is detached and re-attached all along. */
void test_stress(const std::string& dir, GstElement* src) {
    std::printf("\n--- %d cycles of attach and detach with buffers flowing ---\n", CYCLES_STRESS);
    size_t warnings0 = count("warning");
    std::atomic<bool> run{true};
    std::thread pusher([&] {
        while (run.load()) {
            push(src);
            g_usleep(200);
        }
    });
    const std::string f = dir + "/f.sock";
    attach(f);
    size_t f_attaches = 1, f_detaches = 0;
    std::vector<std::string> live, all;
    int detaches = 0, later = 0;
    for (int i = 0; i < CYCLES_STRESS; i++) {
        std::vector<std::string> next;
        for (int k = 0; k < 2; k++) next.push_back(dir + "/c" + std::to_string(i) + "-" + std::to_string(k) + ".sock");
        for (const std::string& s : next) attach(s);
        for (const std::string& s : live) {
            detach(s);
            detaches++;
            if (count("bus_detached", s) == 0) later++;
        }
        live = next;
        all.insert(all.end(), next.begin(), next.end());
        if (count("bus_attached", f) == f_attaches) {   // attached: churn it, an attach may wait
            detach(f);
            attach(f);
            f_detaches++;
            f_attaches++;
        }
        iterate();
        g_usleep(1000);
    }
    run = false;
    pusher.join();
    for (const std::string& s : live) detach(s);
    bool settled = wait_for([&] { return count("bus_attached", f) == f_attaches; }, 3000, true);
    detach(f);
    f_detaches++;
    bool drained = wait_for(
        [&] {
            for (const std::string& s : all)
                if (count("bus_detached", s) != 1) return false;
            return count("bus_detached", f) == f_detaches;
        },
        5000, true);
    iterate();
    size_t attached = 0;
    for (const std::string& s : all) attached += count("bus_attached", s) == 1;
    std::printf("INFO %d of %d detaches finished after the call (their probe on the streaming thread)\n", later,
                detaches);
    char name[200];
    std::snprintf(name, sizeof name, "every edge attached once and detached once: %zu of %zu", attached, all.size());
    CHECK(name, attached == all.size() && drained);
    std::snprintf(name, sizeof name, "the churned edge: %zu attaches, %zu detaches, each reported", f_attaches,
                  f_detaches);
    CHECK(name, settled && drained);
    CHECK("no warning on the way", count("warning") == warnings0);
    CHECK("every edge path and private path released", entries(dir).empty());
    attach(f);
    CHECK("an attach after it all binds at once: no teardown record left behind",
          count("bus_attached", f) == f_attaches + 1 && accepts(f));
    detach(f);
    iterate();
}

}  // namespace

int main(int argc, char** argv) {
    gchar* tmp = g_dir_make_tmp("mr-edges-XXXXXX", nullptr);
    if (!tmp) {
        std::printf("FAIL no temp dir\n");
        return 1;
    }
    const std::string root = tmp, dir = root + "/s", events = root + "/events";
    g_free(tmp);
    ::mkdir(dir.c_str(), 0700);
    // ipc's data-pipe mode: commands on fd 3 (never read here), events on fd 4, a file.
    int in = ::open("/dev/null", O_RDONLY), out = ::open(events.c_str(), O_WRONLY | O_CREAT | O_APPEND, 0600);
    int in_hi = ::fcntl(in, F_DUPFD, 10), out_hi = ::fcntl(out, F_DUPFD, 10);
    ::close(in);
    ::close(out);
    ::dup2(in_hi, 3);
    ::dup2(out_hi, 4);
    ::close(in_hi);
    ::close(out_hi);
    g_events_fd = ::open(events.c_str(), O_RDONLY);

    gst_init(&argc, &argv);
    mr::ipc::init();
    for (const char* f : {"appsrc", "tee", "queue", "unixfdsink"}) {
        GstElementFactory* fac = gst_element_factory_find(f);
        if (!fac) {
            std::printf("SKIP bus_edges_thread_test — %s unavailable\n", f);
            return 0;
        }
        gst_object_unref(fac);
    }
    // This thread runs the main loop, as main.cpp's g_main_loop_run does.
    g_main_context_acquire(nullptr);

    GstElement* pipe = gst_parse_launch(
        "appsrc name=src is-live=true format=time"
        " caps=\"video/mpegts,systemstream=(boolean)true,packetsize=(int)188\""
        " ! tee name=busout_41000 allow-not-linked=true",
        nullptr);
    GstElement* src = gst_bin_get_by_name(GST_BIN(pipe), "src");
    GstElement* tee = gst_bin_get_by_name(GST_BIN(pipe), TEE);
    GstPad* tee_sink = gst_element_get_static_pad(tee, "sink");
    gst_pad_add_probe(tee_sink, GST_PAD_PROBE_TYPE_BUFFER, count_cb, nullptr, nullptr);
    gst_object_unref(tee_sink);
    mr::runner().pipeline = pipe;
    gst_element_set_state(pipe, GST_STATE_PLAYING);
    gst_element_get_state(pipe, nullptr, nullptr, 3 * GST_SECOND);

    test_idle_pad(dir);
    test_streaming_thread(dir, src, tee);
    test_stop_mid_teardown(dir, src, tee);
    test_stress(dir, src);

    gst_element_set_state(pipe, GST_STATE_NULL);
    mr::runner().pipeline = nullptr;
    CHECK("nothing left in the socket directory at the end", entries(dir).empty());
    gst_object_unref(src);
    gst_object_unref(tee);
    gst_object_unref(pipe);
    for (const std::string& n : entries(dir)) ::unlink((dir + "/" + n).c_str());
    ::rmdir(dir.c_str());
    ::unlink(events.c_str());
    ::rmdir(root.c_str());
    return test_summary("bus_edges_thread");
}
