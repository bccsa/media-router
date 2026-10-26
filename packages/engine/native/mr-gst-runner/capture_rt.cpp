#include "capture_rt.h"

#include <gio/gio.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>
#include <mutex>
#include <set>
#include <string>

#include "ipc.h"
#include "runner.h"

namespace mr::capture_rt {

namespace {

const char* const RTKIT = "org.freedesktop.RealtimeKit1";
const char* const RTKIT_PATH = "/org/freedesktop/RealtimeKit1";

std::mutex g_lock;              // the marks: written before PLAYING, read by each entering task
std::set<GstElement*> g_path;   // reffed
// Main loop only: the requests run there, so no streaming thread waits on rtkit or the bus.
bool g_refused = false;
GDBusConnection* g_bus = nullptr;

struct Request {
    guint64 tid;
    std::string task;
};

bool is_muxer(GstElement* el) {
    GstElementFactory* f = gst_element_get_factory(el);
    return f && gst_element_factory_list_is_type(f, GST_ELEMENT_FACTORY_TYPE_MUXER);
}

/** `el` and everything downstream of it; a muxer ends its branch. */
void mark(GstElement* el) {
    if (!g_path.insert(el).second) return;
    gst_object_ref(el);
    if (is_muxer(el)) return;
    GstIterator* it = gst_element_iterate_src_pads(el);
    GValue item = G_VALUE_INIT;
    for (bool done = false; !done;) {
        switch (gst_iterator_next(it, &item)) {
            case GST_ITERATOR_OK:
                if (GstPad* peer = gst_pad_get_peer(GST_PAD(g_value_get_object(&item)))) {
                    if (GstElement* next = gst_pad_get_parent_element(peer)) {
                        mark(next);
                        gst_object_unref(next);
                    }
                    gst_object_unref(peer);
                }
                g_value_reset(&item);
                break;
            case GST_ITERATOR_RESYNC: gst_iterator_resync(it); break;
            default: done = true; break;
        }
    }
    g_value_unset(&item);
    gst_iterator_free(it);
}

/** Said once per runner; the capture runs on at normal priority. */
void refused(const Request* req, const std::string& why) {
    if (g_refused) return;
    g_refused = true;
    ipc::warning("real-time priority refused for " + req->task + " (" + why +
                 "): the capture runs at normal priority");
}

/** rtkit grants only to a process whose RLIMIT_RTTIME hard limit is within its maximum. */
bool bound_rttime(std::string* why) {
    struct rlimit rl;
    if (getrlimit(RLIMIT_RTTIME, &rl) == 0 && rl.rlim_max != RLIM_INFINITY && rl.rlim_max <= (rlim_t)RTTIME_US)
        return true;
    rl.rlim_cur = rl.rlim_max = (rlim_t)RTTIME_US;
    if (setrlimit(RLIMIT_RTTIME, &rl) == 0) return true;
    *why = std::string("RLIMIT_RTTIME: ") + std::strerror(errno);
    return false;
}

void on_reply(GObject* bus, GAsyncResult* res, gpointer data) {
    Request* req = static_cast<Request*>(data);
    GError* err = nullptr;
    if (GVariant* r = g_dbus_connection_call_finish(G_DBUS_CONNECTION(bus), res, &err)) {
        g_variant_unref(r);
        ipc::logf("real-time: %s at SCHED_RR %d (rtkit)", req->task.c_str(), PRIORITY);
    } else {
        refused(req, err && err->message ? err->message : "no answer");
        g_clear_error(&err);
    }
    delete req;
}

/** module-rt's call (B-88), inside the same rtkit limits. */
void call(Request* req) {
    g_dbus_connection_call(g_bus, RTKIT, RTKIT_PATH, RTKIT, "MakeThreadRealtimeWithPID",
                           g_variant_new("(ttu)", (guint64)getpid(), req->tid, (guint32)PRIORITY), nullptr,
                           G_DBUS_CALL_FLAGS_NONE, TIMEOUT_MS, nullptr, on_reply, req);
}

void on_bus(GObject*, GAsyncResult* res, gpointer data) {
    Request* req = static_cast<Request*>(data);
    GError* err = nullptr;
    GDBusConnection* bus = g_bus_get_finish(res, &err);
    if (!bus) {
        refused(req, err && err->message ? err->message : "no system bus");
        g_clear_error(&err);
        delete req;
        return;
    }
    // The shared connection would SIGTERM the runner if the bus went away.
    g_dbus_connection_set_exit_on_close(bus, FALSE);
    if (g_bus) g_object_unref(bus);
    else g_bus = bus;
    call(req);
}

gboolean request(gpointer data) {
    Request* req = static_cast<Request*>(data);
    std::string why;
    if (!bound_rttime(&why)) {
        refused(req, why);
        delete req;
    } else if (g_bus) {
        call(req);
    } else {
        g_bus_get(G_BUS_TYPE_SYSTEM, nullptr, on_bus, req);
    }
    return G_SOURCE_REMOVE;
}

/** On the entering task's own thread: its tid, then the request on the main loop. */
void on_stream_status(GstBus*, GstMessage* msg, gpointer) {
    GstStreamStatusType type;
    GstElement* owner = nullptr;
    gst_message_parse_stream_status(msg, &type, &owner);
    if (type != GST_STREAM_STATUS_TYPE_ENTER || !owner) return;
    {
        std::lock_guard<std::mutex> lock(g_lock);
        if (!g_path.count(owner)) return;
    }
    GstObject* pad = GST_MESSAGE_SRC(msg);
    g_idle_add(request, new Request{(guint64)syscall(SYS_gettid), std::string(GST_OBJECT_NAME(owner)) + ":" +
                                                                       (pad ? GST_OBJECT_NAME(pad) : "")});
}

}  // namespace

void install(GstElement* pipe) {
    if (!GST_IS_BIN(pipe)) return;
    std::lock_guard<std::mutex> lock(g_lock);
    GstIterator* it = gst_bin_iterate_recurse(GST_BIN(pipe));
    GValue item = G_VALUE_INIT;
    for (bool done = false; !done;) {
        switch (gst_iterator_next(it, &item)) {
            case GST_ITERATOR_OK: {
                GstElement* el = GST_ELEMENT(g_value_get_object(&item));
                if (factory_name(el) == "pipewiresrc") mark(el);
                g_value_reset(&item);
                break;
            }
            case GST_ITERATOR_RESYNC: gst_iterator_resync(it); break;
            default: done = true; break;
        }
    }
    g_value_unset(&item);
    gst_iterator_free(it);
    if (g_path.empty()) return;
    GstBus* bus = gst_element_get_bus(pipe);
    gst_bus_enable_sync_message_emission(bus);
    g_signal_connect(bus, "sync-message::stream-status", G_CALLBACK(on_stream_status), nullptr);
    gst_object_unref(bus);
}

void clear() {
    std::lock_guard<std::mutex> lock(g_lock);
    for (GstElement* el : g_path) gst_object_unref(el);
    g_path.clear();
}

}  // namespace mr::capture_rt
