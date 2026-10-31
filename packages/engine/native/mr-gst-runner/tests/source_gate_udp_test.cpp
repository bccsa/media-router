// The udp silence watch on a real udpsrc, through the runner's own start, bus watch and gate. A
// timeout the main loop meets only after packets that came since it was posted is no new silence:
// the loop is held while udpsrc posts a timeout and the packets then pass the source's probes.
#include <arpa/inet.h>
#include <fcntl.h>
#include <gst/gst.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <cstdio>
#include <functional>
#include <mutex>
#include <string>
#include <vector>

#include "../ipc.h"
#include "../json_util.h"
#include "../paths.h"
#include "../runner.h"
#include "mrts/tests/check.h"

namespace {

constexpr guint64 TIMEOUT_NS = 300000000;   // udpsrc's silence timeout here: 300 ms
constexpr int CYCLES = 5;

// --- events: ipc writes them to fd 4, a file here -----------------------------------------

struct Event {
    std::string event, kind, element;
};

int g_events_fd = -1;
std::string g_partial;
std::vector<Event> g_events;

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
            g_events.push_back({mr::json_get_string(o, "event"), mr::json_get_string(o, "kind"),
                                mr::json_get_string(o, "element")});
            json_object_unref(o);
        }
    }
}

size_t count(const char* name, const char* kind = nullptr) {
    read_events();
    size_t n = 0;
    for (const Event& e : g_events) n += e.event == name && (!kind || e.kind == kind);
    return n;
}

// --- the main loop: run only where a step says so ----------------------------------------

void iterate() {
    while (g_main_context_iteration(nullptr, FALSE)) {
    }
}

void spin(int ms) {
    gint64 end = g_get_monotonic_time() + (gint64)ms * 1000;
    while (g_get_monotonic_time() < end) {
        iterate();
        g_usleep(5000);
    }
}

/** Poll `pred` for up to `ms`, running the main loop in between only when `loop`. */
bool wait_for(const std::function<bool()>& pred, int ms, bool loop) {
    gint64 end = g_get_monotonic_time() + (gint64)ms * 1000;
    for (;;) {
        if (loop) iterate();
        if (pred()) return true;
        if (g_get_monotonic_time() > end) return false;
        g_usleep(loop ? 5000 : 2000);
    }
}

// --- the pipeline side -------------------------------------------------------------------

std::mutex g_posts_lock;
std::vector<gint64> g_posts;      // when udpsrc posted each timeout (its streaming thread)
std::atomic<int> g_buffers{0};    // buffers past the runner's probes (this probe comes after theirs)

void on_sync_message(GstBus*, GstMessage* msg, gpointer) {
    const GstStructure* s = gst_message_get_structure(msg);
    if (!s || !gst_structure_has_name(s, "GstUDPSrcTimeout")) return;
    std::lock_guard<std::mutex> lk(g_posts_lock);
    g_posts.push_back(g_get_monotonic_time());
}

bool posted_after(gint64 t) {
    std::lock_guard<std::mutex> lk(g_posts_lock);
    for (gint64 p : g_posts)
        if (p > t) return true;
    return false;
}

GstPadProbeReturn count_cb(GstPad*, GstPadProbeInfo*, gpointer) {
    g_buffers++;
    return GST_PAD_PROBE_OK;
}

int free_port() {
    int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    socklen_t len = sizeof a;
    ::bind(fd, (sockaddr*)&a, sizeof a);
    ::getsockname(fd, (sockaddr*)&a, &len);
    ::close(fd);
    return ntohs(a.sin_port);
}

void send_packets(int port, int n = 3) {
    int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    a.sin_port = htons((uint16_t)port);
    unsigned char ts[188] = {0x47};
    for (int i = 0; i < n; i++) ::sendto(fd, ts, sizeof ts, 0, (sockaddr*)&a, sizeof a);
    ::close(fd);
}

/** The engine's start command, run where main.cpp runs it: on the main loop's thread. */
void start(int port, gint64 restart_ms) {
    std::string desc = "udpsrc name=netsrc port=" + std::to_string(port) + " timeout=" + std::to_string(TIMEOUT_NS) +
                       " caps=\"video/mpegts, systemstream=(boolean)true, packetsize=(int)188\" ! fakesink sync=false";
    JsonObject* o = json_object_new();
    json_object_set_string_member(o, "pipeline", desc.c_str());
    if (restart_ms > 0) json_object_set_int_member(o, "udpSilenceRestartMs", restart_ms);
    mr::runner().handle_start(o);
    json_object_unref(o);
}

void stop() {
    mr::runner().handle_stop();
    mr::runner().stopping = false;   // one pipeline per process in the field; this test starts again
    iterate();
}

// --- the cases -------------------------------------------------------------------------

/** Each round: a silence, the loop held until udpsrc has posted its next timeout, packets that
 *  pass the probes, then the loop meets that timeout. Before the fix it read as a new silence,
 *  and the next packet resumed a second time. */
void test_stale_timeouts() {
    std::printf("--- a timeout posted before the packets come back and met after them is no new silence ---\n");
    int port = free_port();
    start(port, 0);
    CHECK("the runner starts the udpsrc pipeline", mr::runner().pipeline && count("started") == 1);
    if (!mr::runner().pipeline) return;
    GstBus* bus = gst_element_get_bus(mr::runner().pipeline);
    gst_bus_enable_sync_message_emission(bus);
    gulong sig = g_signal_connect(bus, "sync-message::element", G_CALLBACK(on_sync_message), nullptr);
    GstElement* src = gst_bin_get_by_name(GST_BIN(mr::runner().pipeline), "netsrc");
    GstPad* pad = gst_element_get_static_pad(src, "src");
    gst_pad_add_probe(pad, (GstPadProbeType)(GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_BUFFER_LIST), count_cb,
                      nullptr, nullptr);

    int reported = 0, held = 0, no_silence = 0, resumed_once = 0, quiet = 0;
    bool named = false;
    for (int i = 0; i < CYCLES; i++) {
        size_t n = count("input_silent");
        reported += wait_for([&] { return count("input_silent") > n; }, 2000, true);   // this round's silence
        if (i == 0) {
            read_events();
            for (const Event& e : g_events)
                if (e.event == "input_silent") named = e.element == "netsrc" && e.kind == "udp_timeout";
        }
        gint64 t = g_get_monotonic_time();
        bool queued = wait_for([&] { return posted_after(t); }, 2000, false);   // posted, not met yet
        int seen = g_buffers.load();
        size_t silent0 = count("input_silent"), resumed0 = count("input_resumed");
        send_packets(port);
        held += queued && wait_for([&] { return g_buffers.load() > seen; }, 2000, false);
        spin(100);   // the loop meets that timeout now, after the packets
        no_silence += count("input_silent") == silent0;
        resumed_once += count("input_resumed") == resumed0 + 1;
        send_packets(port);
        spin(100);
        quiet += count("input_resumed") == resumed0 + 1;
    }
    size_t n = count("input_silent");
    reported += wait_for([&] { return count("input_silent") > n; }, 2000, true);

    char name[200];
    CHECK("the first silence names the element (netsrc, udp_timeout)", named);
    std::snprintf(name, sizeof name,
                  "a timeout was posted while the loop was held and the packets passed after it: %d of %d", held,
                  CYCLES);
    CHECK(name, held == CYCLES);
    std::snprintf(name, sizeof name, "met after those packets it is no new silence: %d of %d", no_silence, CYCLES);
    CHECK(name, no_silence == CYCLES);
    std::snprintf(name, sizeof name, "the packets resume once: %d of %d", resumed_once, CYCLES);
    CHECK(name, resumed_once == CYCLES);
    std::snprintf(name, sizeof name, "and a later packet does not resume again: %d of %d", quiet, CYCLES);
    CHECK(name, quiet == CYCLES);
    std::snprintf(name, sizeof name, "each silence after the data is still reported: %d of %d", reported, CYCLES + 1);
    CHECK(name, reported == CYCLES + 1);
    CHECK("no error", count("error") == 0);

    g_signal_handler_disconnect(bus, sig);
    gst_bus_disable_sync_message_emission(bus);
    gst_object_unref(pad);
    gst_object_unref(src);
    gst_object_unref(bus);
    stop();
}

/** The multicast re-join bound still turns a long silence into the old udp_timeout error. */
void test_restart_bound() {
    std::printf("\n--- a multicast-style restart bound turns a long silence into the udp_timeout error ---\n");
    size_t silent0 = count("input_silent"), errors0 = count("error");
    start(free_port(), 800);
    spin(500);
    CHECK("under the bound: input_silent only, no error",
          count("input_silent") == silent0 + 1 && count("error") == errors0);
    spin(1200);
    GstState state = GST_STATE_VOID_PENDING;
    if (mr::runner().pipeline) gst_element_get_state(mr::runner().pipeline, &state, nullptr, 0);
    CHECK("past the bound: one udp_timeout error, the pipeline torn down",
          count("error") == errors0 + 1 && count("error", "udp_timeout") == 1 && state == GST_STATE_NULL);
    stop();
}

}  // namespace

int main(int argc, char** argv) {
    gchar* tmp = g_dir_make_tmp("mr-udpgate-XXXXXX", nullptr);
    if (!tmp) {
        std::printf("FAIL no temp dir\n");
        return 1;
    }
    const std::string root = tmp, events = root + "/events";
    g_free(tmp);
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
    // The runner finds the native plugins from its own path; this binary sits one level deeper.
    g_setenv("MR_PLUGINS_DIR", (mr::paths::exe_dir() + "/../../../../../plugins").c_str(), FALSE);

    gst_init(&argc, &argv);
    mr::ipc::init();
    for (const char* f : {"udpsrc", "fakesink"}) {
        GstElementFactory* fac = gst_element_factory_find(f);
        if (!fac) {
            std::printf("SKIP source_gate_udp_test — %s unavailable\n", f);
            return 0;
        }
        gst_object_unref(fac);
    }
    // This thread runs the main loop, as main.cpp's g_main_loop_run does.
    g_main_context_acquire(nullptr);

    test_stale_timeouts();
    test_restart_bound();

    ::unlink(events.c_str());
    ::rmdir(root.c_str());
    return test_summary("source_gate_udp");
}
