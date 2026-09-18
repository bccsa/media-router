#include "source_gate.h"

#include <sys/stat.h>

#include <atomic>
#include <memory>
#include <mutex>
#include <set>
#include <vector>

#include "ipc.h"
#include "json_util.h"
#include "runner.h"

namespace mr {

namespace {

constexpr int DATA_WAIT_POLL_MS = 2000;

/** The pipeline's source elements made by `factory` (owned refs). */
std::vector<GstElement*> sources_by_factory(GstElement* pipe, const char* factory) {
    std::vector<GstElement*> out;
    if (!GST_IS_BIN(pipe)) return out;
    GstIterator* it = gst_bin_iterate_sources(GST_BIN(pipe));
    GValue item = G_VALUE_INIT;
    bool done = false;
    while (!done) {
        switch (gst_iterator_next(it, &item)) {
            case GST_ITERATOR_OK: {
                GstElement* el = GST_ELEMENT(g_value_get_object(&item));
                if (factory_name(el) == factory) out.push_back(GST_ELEMENT(gst_object_ref(el)));
                g_value_reset(&item);
                break;
            }
            case GST_ITERATOR_RESYNC:
                for (GstElement* e : out) gst_object_unref(e);
                out.clear();
                gst_iterator_resync(it);
                break;
            default: done = true; break;
        }
    }
    g_value_unset(&item);
    gst_iterator_free(it);
    return out;
}

struct Probe {
    GstPad* pad;
    gulong id;
};

void remove_probes(std::vector<Probe>& probes) {
    for (Probe& p : probes) {
        gst_pad_remove_probe(p.pad, p.id);
        gst_object_unref(p.pad);
    }
    probes.clear();
}

struct SocketIdentity {
    bool exists = false;
    ino_t ino = 0;
    dev_t dev = 0;
    gint64 ctime_ns = 0;
    bool operator!=(const SocketIdentity& o) const {
        return exists != o.exists || ino != o.ino || dev != o.dev || ctime_ns != o.ctime_ns;
    }
};

SocketIdentity socket_identity(const std::string& path) {
    SocketIdentity id;
    struct stat st{};
    if (::stat(path.c_str(), &st) == 0) {
        id.exists = true;
        id.ino = st.st_ino;
        id.dev = st.st_dev;
        id.ctime_ns = (gint64)st.st_ctim.tv_sec * 1000000000LL + st.st_ctim.tv_nsec;
    }
    return id;
}

}  // namespace

// ===========================================================================
// gate
// ===========================================================================

namespace gate {

namespace {

struct DataWait {
    std::vector<Probe> probes;
    guint warn_id = 0;
    guint poll_id = 0;
    bool warned = false;
    std::mutex lock;
    std::set<GstElement*> pending;     // sources not yet delivered
    std::atomic<bool> fired{false};
    int timeout_ms = 0;
    std::vector<std::string> sockets;
    std::vector<std::pair<std::string, SocketIdentity>> identity;
};

struct UdpSilence {
    gint64 since_us = -1;   // -1 = receiving (or never timed out)
    std::atomic<bool> silent{false};
    std::vector<Probe> probes;
    gint64 restart_ms = 0;
};

std::shared_ptr<DataWait> g_data_wait;
std::shared_ptr<UdpSilence> g_udp;

JsonArray* sockets_array(const std::vector<std::string>& sockets) {
    JsonArray* a = json_array_new();
    for (const std::string& s : sockets) json_array_add_string_element(a, s.c_str());
    return a;
}

bool clear_data_wait() {
    std::shared_ptr<DataWait> dw = g_data_wait;
    g_data_wait.reset();
    if (!dw) return false;
    remove_probes(dw->probes);
    if (dw->warn_id) g_source_remove(dw->warn_id);
    if (dw->poll_id) g_source_remove(dw->poll_id);
    dw->warn_id = dw->poll_id = 0;
    return dw->warned;
}

gboolean data_arrived_idle(gpointer user) {
    auto* holder = static_cast<std::shared_ptr<DataWait>*>(user);
    std::shared_ptr<DataWait> dw = *holder;
    delete holder;
    if (g_data_wait != dw) return G_SOURCE_REMOVE;   // superseded by a stop / newer start
    if (clear_data_wait()) {
        JsonObject* ev = ipc::event("data_arrived");
        json_object_set_array_member(ev, "sockets", sockets_array(dw->sockets));
        ipc::emit(ev);
    }
    Runner& r = runner();
    if (r.pipeline) {
        GstState state = GST_STATE_NULL, pending = GST_STATE_VOID_PENDING;
        gst_element_get_state(r.pipeline, &state, &pending, 0);
        if (state != GST_STATE_PLAYING) r.arm_playing_watchdog(dw->timeout_ms);
    }
    return G_SOURCE_REMOVE;
}

struct FirstProbe {
    std::shared_ptr<DataWait> dw;
    GstElement* el;
};

GstPadProbeReturn on_first_cb(GstPad*, GstPadProbeInfo*, gpointer user) {
    auto* fp = static_cast<FirstProbe*>(user);
    // Streaming thread: the deadline starts when EVERY non-live head has
    // delivered; hand over to the main loop once.
    bool all = false;
    {
        std::lock_guard<std::mutex> lock(fp->dw->lock);
        fp->dw->pending.erase(fp->el);
        all = fp->dw->pending.empty();
    }
    if (all && !fp->dw->fired.exchange(true)) g_idle_add(data_arrived_idle, new std::shared_ptr<DataWait>(fp->dw));
    return GST_PAD_PROBE_OK;
}

void delete_first_probe(gpointer p) { delete static_cast<FirstProbe*>(p); }

gboolean warn_cb(gpointer user) {
    auto* holder = static_cast<std::shared_ptr<DataWait>*>(user);
    std::shared_ptr<DataWait> dw = *holder;
    delete holder;
    if (g_data_wait != dw) return G_SOURCE_REMOVE;
    dw->warn_id = 0;
    dw->warned = true;
    std::string joined;
    for (const std::string& s : dw->sockets) joined += (joined.empty() ? "" : ", ") + s;
    JsonObject* ev = ipc::event("waiting_for_data");
    json_object_set_array_member(ev, "sockets", sockets_array(dw->sockets));
    json_object_set_string_member(ev, "message",
                                  ("no data yet on bus socket(s) " + joined + " after " +
                                   std::to_string(dw->timeout_ms) + " ms — waiting for the producer, not restarting")
                                      .c_str());
    ipc::emit(ev);
    return G_SOURCE_REMOVE;
}

gboolean poll_cb(gpointer user) {
    auto* holder = static_cast<std::shared_ptr<DataWait>*>(user);
    std::shared_ptr<DataWait> dw = *holder;
    if (g_data_wait != dw || dw->fired.load()) {
        bool keep = g_data_wait == dw;   // data won the race: stay quiet, stop polling
        if (!keep) delete holder;
        if (!keep) return G_SOURCE_REMOVE;
        dw->poll_id = 0;
        delete holder;
        return G_SOURCE_REMOVE;
    }
    for (auto& [path, ident] : dw->identity) {
        SocketIdentity now = socket_identity(path);
        if (now != ident) {
            std::string what = now.exists ? "was re-created" : "went away";
            dw->poll_id = 0;
            delete holder;
            clear_data_wait();
            JsonObject* ev = ipc::event("error");
            json_object_set_string_member(ev, "kind", "bus_producer_restarted");
            json_object_set_string_member(
                ev, "message",
                ("producer bus socket " + path + " " + what + " while waiting for its first data — reconnecting")
                    .c_str());
            runner().fail_pipeline(ev);
            return G_SOURCE_REMOVE;
        }
    }
    return G_SOURCE_CONTINUE;
}

void defer_deadline_until_data(const std::vector<GstElement*>& srcs, int timeout_ms) {
    auto dw = std::make_shared<DataWait>();
    dw->timeout_ms = timeout_ms;
    for (GstElement* s : srcs) {
        dw->pending.insert(s);
        if (factory_name(s) == "unixfdsrc") {
            gchar* path = nullptr;
            g_object_get(s, "socket-path", &path, nullptr);
            if (path) {
                dw->sockets.push_back(path);
                dw->identity.push_back({path, socket_identity(path)});
                g_free(path);
            }
        }
    }
    g_data_wait = dw;
    for (GstElement* s : srcs) {
        GstPad* pad = gst_element_get_static_pad(s, "src");
        if (!pad) continue;
        gulong id = gst_pad_add_probe(pad, (GstPadProbeType)(GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_BUFFER_LIST),
                                      on_first_cb, new FirstProbe{dw, s}, delete_first_probe);
        dw->probes.push_back({pad, id});
    }
    // A UDP head leaves the warning to the silence watch; the socket poll only
    // has something to watch when there are bus sockets.
    if (!dw->sockets.empty()) {
        dw->warn_id = g_timeout_add(timeout_ms, warn_cb, new std::shared_ptr<DataWait>(dw));
        dw->poll_id = g_timeout_add(DATA_WAIT_POLL_MS, poll_cb, new std::shared_ptr<DataWait>(dw));
    }
}

// --- udp silence -------------------------------------------------------------

gboolean udp_resumed_idle(gpointer user) {
    auto* holder = static_cast<std::shared_ptr<UdpSilence>*>(user);
    if (g_udp == *holder) {
        JsonObject* ev = ipc::event("input_resumed");
        json_object_set_string_member(ev, "message", "UDP source receiving again");
        ipc::emit(ev);
    }
    delete holder;
    return G_SOURCE_REMOVE;
}

GstPadProbeReturn udp_buffer_cb(GstPad*, GstPadProbeInfo*, gpointer user) {
    auto* holder = static_cast<std::shared_ptr<UdpSilence>*>(user);
    std::shared_ptr<UdpSilence>& st = *holder;
    if (st->silent.exchange(false)) g_idle_add(udp_resumed_idle, new std::shared_ptr<UdpSilence>(st));
    return GST_PAD_PROBE_OK;
}

void delete_udp_holder(gpointer p) { delete static_cast<std::shared_ptr<UdpSilence>*>(p); }

void arm_udp_silence(GstElement* pipe, gint64 restart_ms) {
    std::vector<GstElement*> srcs = sources_by_factory(pipe, "udpsrc");
    if (srcs.empty()) return;
    auto st = std::make_shared<UdpSilence>();
    st->restart_ms = restart_ms > 0 ? restart_ms : 0;
    g_udp = st;
    for (GstElement* s : srcs) {
        GstPad* pad = gst_element_get_static_pad(s, "src");
        if (pad) {
            gulong id = gst_pad_add_probe(pad, (GstPadProbeType)(GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_BUFFER_LIST),
                                          udp_buffer_cb, new std::shared_ptr<UdpSilence>(st), delete_udp_holder);
            st->probes.push_back({pad, id});
        }
        gst_object_unref(s);
    }
}

void clear_udp_silence() {
    std::shared_ptr<UdpSilence> st = g_udp;
    g_udp.reset();
    if (st) remove_probes(st->probes);
}

}  // namespace

bool start(GstElement* pipe, bool ret_async, int timeout_ms, gint64 udp_restart_ms) {
    stop();
    arm_udp_silence(pipe, udp_restart_ms);
    if (!ret_async || timeout_ms <= 0) return false;
    std::vector<GstElement*> srcs = sources_by_factory(pipe, "unixfdsrc");
    for (GstElement* u : sources_by_factory(pipe, "udpsrc")) srcs.push_back(u);
    if (srcs.empty()) return false;
    defer_deadline_until_data(srcs, timeout_ms);
    for (GstElement* s : srcs) gst_object_unref(s);   // the wait keys on element identity only
    return true;
}

bool stop() {
    bool warned = clear_data_wait();
    clear_udp_silence();
    return warned;
}

void on_playing() {
    if (clear_data_wait()) ipc::emit(ipc::event("data_arrived"));
}

void on_udp_timeout(const std::string& src_name) {
    std::shared_ptr<UdpSilence> st = g_udp;
    gint64 now_us = g_get_monotonic_time();
    if (!st) {
        JsonObject* ev = ipc::event("error");
        json_object_set_string_member(ev, "kind", "udp_timeout");
        json_object_set_string_member(ev, "message", "UDP source timeout (no data received)");
        runner().fail_pipeline(ev);
        return;
    }
    if (!st->silent.load()) {
        st->silent.store(true);
        st->since_us = now_us;
        JsonObject* ev = ipc::event("input_silent");
        json_object_set_string_member(ev, "kind", "udp_timeout");
        json_object_set_string_member(ev, "element", src_name.c_str());
        json_object_set_string_member(ev, "message",
                                      ("UDP source " + src_name + " silent — waiting for data, not restarting").c_str());
        ipc::emit(ev);
        return;
    }
    if (st->restart_ms > 0 && (now_us - st->since_us) / 1000 >= st->restart_ms) {
        JsonObject* ev = ipc::event("error");
        json_object_set_string_member(ev, "kind", "udp_timeout");
        json_object_set_string_member(
            ev, "message",
            ("UDP source " + src_name + " silent for " + std::to_string((now_us - st->since_us) / 1000000) +
             " s — restarting to re-join (udpSilenceRestartMs=" + std::to_string(st->restart_ms) + ")")
                .c_str());
        runner().fail_pipeline(ev);
    }
}

}  // namespace gate

// ===========================================================================
// stall watch
// ===========================================================================

namespace stall {

namespace {

constexpr int TICK_MS = 1000;
constexpr const char* ELEMENT_PREFIX = "buswd_";

struct Entry {
    std::string name;
    GstPad* pad = nullptr;   // owned
    gint64 timeout_ms = 0;
    std::atomic<bool> progressed{false};
    gulong probe_id = 0;
    gint64 last_us = 0;
    bool seen = false;
    bool warned = false;
};

struct State {
    std::vector<std::shared_ptr<Entry>> entries;
    guint timer_id = 0;
    bool armed = false;
};

std::shared_ptr<State> g_state;

GstPadProbeReturn progress_cb(GstPad*, GstPadProbeInfo*, gpointer user) {
    (*static_cast<std::shared_ptr<Entry>*>(user))->progressed.store(true, std::memory_order_relaxed);
    return GST_PAD_PROBE_REMOVE;
}

void delete_entry_holder(gpointer p) { delete static_cast<std::shared_ptr<Entry>*>(p); }

void arm_probe(const std::shared_ptr<Entry>& e) {
    if (e->probe_id) return;
    e->probe_id = gst_pad_add_probe(e->pad, (GstPadProbeType)(GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_BUFFER_LIST),
                                    progress_cb, new std::shared_ptr<Entry>(e), delete_entry_holder);
}

gboolean tick_cb(gpointer) {
    std::shared_ptr<State> st = g_state;
    Runner& r = runner();
    if (!st || !r.pipeline) return G_SOURCE_REMOVE;
    gint64 now_us = g_get_monotonic_time();
    for (auto& e : st->entries) {
        if (e->progressed.load(std::memory_order_relaxed)) {
            e->progressed.store(false, std::memory_order_relaxed);
            e->seen = true;
            e->last_us = now_us;
            e->probe_id = 0;   // the one-shot fired: its id is dead
            arm_probe(e);
        } else if ((now_us - e->last_us) / 1000 >= e->timeout_ms) {
            if (!e->seen) {
                if (!e->warned) {
                    e->warned = true;
                    JsonObject* ev = ipc::event("warning");
                    json_object_set_string_member(ev, "kind", "input_silent");
                    json_object_set_string_member(ev, "element", e->name.c_str());
                    json_object_set_string_member(
                        ev, "message",
                        ("Input " + e->name + " has delivered no data since start (" + std::to_string(e->timeout_ms) +
                         " ms) — waiting for the source, not restarting")
                            .c_str());
                    ipc::emit(ev);
                }
                continue;
            }
            std::string name = e->name;
            gint64 timeout_ms = e->timeout_ms;
            stop();
            JsonObject* ev = ipc::event("error");
            json_object_set_string_member(ev, "kind", "bus_stall");
            json_object_set_string_member(
                ev, "message", ("Input stall: no data from " + name + " for " + std::to_string(timeout_ms) + " ms").c_str());
            json_object_set_string_member(ev, "debug", "");
            json_object_set_string_member(ev, "element", (std::string(ELEMENT_PREFIX) + name).c_str());
            r.fail_pipeline(ev, /*drain=*/true, /*errored=*/true);
            return G_SOURCE_REMOVE;
        }
    }
    return G_SOURCE_CONTINUE;
}

}  // namespace

void start(GstElement* pipe, JsonArray* cfg) {
    stop();
    if (!cfg || !GST_IS_BIN(pipe)) return;
    auto st = std::make_shared<State>();
    guint n = json_array_get_length(cfg);
    for (guint i = 0; i < n; i++) {
        JsonNode* node = json_array_get_element(cfg, i);
        if (!JSON_NODE_HOLDS_OBJECT(node)) continue;
        JsonObject* item = json_node_get_object(node);
        std::string name = json_get_string(item, "element");
        gint64 timeout_ms = json_get_int(item, "timeoutMs", 0);
        if (name.empty() || timeout_ms <= 0) continue;
        GstElement* el = gst_bin_get_by_name(GST_BIN(pipe), name.c_str());
        GstPad* pad = el ? gst_element_get_static_pad(el, "src") : nullptr;
        if (el) gst_object_unref(el);
        if (!pad) {
            ipc::warning("inputStallWatch: element '" + name + "' has no src pad — not watched");
            continue;
        }
        auto e = std::make_shared<Entry>();
        e->name = name;
        e->pad = pad;
        e->timeout_ms = timeout_ms;
        st->entries.push_back(e);
    }
    if (!st->entries.empty()) g_state = st;
}

void arm() {
    std::shared_ptr<State> st = g_state;
    if (!st || st->armed) return;
    st->armed = true;
    gint64 now_us = g_get_monotonic_time();
    for (auto& e : st->entries) {
        e->last_us = now_us;
        arm_probe(e);
    }
    st->timer_id = g_timeout_add(TICK_MS, tick_cb, nullptr);
}

void stop() {
    std::shared_ptr<State> st = g_state;
    g_state.reset();
    if (!st) return;
    if (st->timer_id) g_source_remove(st->timer_id);
    for (auto& e : st->entries) {
        // A one-shot that has fired already removed itself; its stored id is dead.
        if (e->probe_id && !e->progressed.load()) gst_pad_remove_probe(e->pad, e->probe_id);
        gst_object_unref(e->pad);
    }
}

}  // namespace stall

}  // namespace mr
