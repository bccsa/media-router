#include "bus_edges.h"

#include <sys/un.h>
#include <unistd.h>

#include <atomic>
#include <cerrno>
#include <cstring>
#include <map>
#include <memory>
#include <set>
#include <vector>

#include "edge_path.h"
#include "ipc.h"
#include "json_util.h"
#include "runner.h"
#include "stamper.h"

namespace mr::bus {

namespace {

constexpr int BUS_EDGE_QUEUE_MS = 5000;
constexpr int BUS_EDGE_QUEUE_BYTES_MS = 500;
constexpr int BUS_EDGE_QUEUE_BYTES_PER_MS = 8000;
constexpr int BUS_EDGE_QUEUE_MAX_BYTES = BUS_EDGE_QUEUE_BYTES_MS * BUS_EDGE_QUEUE_BYTES_PER_MS;
constexpr int BUS_STALL_TICK_MS = 2000;
constexpr int BUS_STALL_TICKS = 3;
constexpr int BUS_ATTACH_WARN_AFTER = 40;   // ~10 s at 250 ms — log once, keep retrying

struct Edge {
    GstElement* branch = nullptr;   // owned ref
    GstElement* tee = nullptr;      // owned ref
    GstPad* tee_src = nullptr;      // owned request pad ref
    std::string tee_name;
    GstPad* sink_pad = nullptr;     // owned ref (unixfdsink sink pad)
    std::atomic<bool> progressed{false};
    int stall = 0;
    gulong probe_id = 0;
    bool soft_healed = false;
    EdgePath path;                  // what this runner published at the edge path (B-190)
};

struct TeeProgress {
    GstPad* pad = nullptr;          // owned ref (tee sink pad)
    std::atomic<bool> progressed{false};
    gulong probe_id = 0;
};

struct Pending {
    std::string tee;
    int attempts = 0;
    bool held_logged = false;       // one warning per attach while another socket holds the path
};

/** Done: attached, or a structural failure not worth retrying. */
enum class Attach { Done, NotReady, Held };

std::map<std::string, std::shared_ptr<Edge>> g_branches;          // socket -> edge
std::map<std::string, std::shared_ptr<TeeProgress>> g_tee_progress; // tee name -> progress
std::map<std::string, Pending> g_pending;                          // socket -> pending attach
std::set<std::string> g_teardowns;
guint g_retry_timer_id = 0;
guint g_stall_timer_id = 0;
int g_branch_seq = 0;

// --- probe user-data holders (shared_ptr through a raw pointer) -------------

template <typename T>
void delete_holder(gpointer p) { delete static_cast<std::shared_ptr<T>*>(p); }

GstPadProbeReturn edge_progress_cb(GstPad*, GstPadProbeInfo*, gpointer user) {
    (*static_cast<std::shared_ptr<Edge>*>(user))->progressed.store(true, std::memory_order_relaxed);
    return GST_PAD_PROBE_REMOVE;
}

GstPadProbeReturn tee_progress_cb(GstPad*, GstPadProbeInfo*, gpointer user) {
    (*static_cast<std::shared_ptr<TeeProgress>*>(user))->progressed.store(true, std::memory_order_relaxed);
    return GST_PAD_PROBE_REMOVE;
}

/** One-shot buffer probe on the edge sink's pad — sets the progress flag.
 *  Single-writer protocol: the callback never writes `probe_id`; only the
 *  watchdog tick does (see the python runner, 2026-07-21). */
void arm_edge_progress_probe(const std::shared_ptr<Edge>& e) {
    if (!e->sink_pad || e->probe_id) return;
    e->probe_id = gst_pad_add_probe(e->sink_pad, GST_PAD_PROBE_TYPE_BUFFER, edge_progress_cb,
                                    new std::shared_ptr<Edge>(e), delete_holder<Edge>);
}

void arm_tee_progress_probe(const std::shared_ptr<TeeProgress>& t) {
    if (t->probe_id) return;
    t->probe_id = gst_pad_add_probe(t->pad, GST_PAD_PROBE_TYPE_BUFFER, tee_progress_cb,
                                    new std::shared_ptr<TeeProgress>(t), delete_holder<TeeProgress>);
}

void release_stamper_if_unused(const std::string& tee_name) {
    for (auto& [sock, e] : g_branches)
        if (e->tee_name == tee_name) return;
    stamper::release(tee_name);
}

// --- attach ---------------------------------------------------------------------

bool ensure_stall_timer();

/** Attach one branch; NotReady and Held stay pending. `held` says what holds
 *  the edge path on Held. */
Attach try_bus_attach(const std::string& tee_name, const std::string& socket, std::string* held) {
    Runner& r = runner();
    // No pipeline YET — stay pending (the engine can queue an attach before
    // `start`); `handle_stop` clears the queue.
    if (!r.pipeline) return Attach::NotReady;
    if (g_teardowns.count(socket)) return Attach::NotReady;   // old branch still detaching
    auto existing = g_branches.find(socket);
    if (existing != g_branches.end()) {
        // Idempotent re-attach: re-sync so a branch stuck at READY by a
        // mid-transition add bumps to the settled parent state.
        gst_element_sync_state_with_parent(existing->second->branch);
        return Attach::Done;
    }
    GstState cur = GST_STATE_NULL, pend = GST_STATE_VOID_PENDING;
    gst_element_get_state(r.pipeline, &cur, &pend, 0);
    if ((pend != GST_STATE_VOID_PENDING ? pend : cur) < GST_STATE_READY) return Attach::NotReady;   // stopped
    GstElement* tee = GST_IS_BIN(r.pipeline) ? gst_bin_get_by_name(GST_BIN(r.pipeline), tee_name.c_str()) : nullptr;
    if (!tee) return Attach::NotReady;   // tee not created yet — caller queues a retry
    // Never bind beside a live listener (B-190): wait until the path is free.
    if (!path_free(socket, held)) {
        gst_object_unref(tee);
        return Attach::Held;
    }
    const std::string bind = bind_path(socket);
    if (bind.size() >= sizeof(sockaddr_un::sun_path)) {
        ipc::warning("bus_attach: socket path too long: " + bind);
        gst_object_unref(tee);
        return Attach::Done;
    }

    // Arm the egress stamper BEFORE the branch is linked: once linked, buffers
    // reach the new edge immediately.
    stamper::arm(tee, tee_name);

    GError* err = nullptr;
    GstElement* branch = gst_parse_bin_from_description(edge_branch_description(bind).c_str(), TRUE, &err);
    if (!branch) {
        ipc::warning(std::string("bus_attach parse failed: ") + (err && err->message ? err->message : "?"));
        g_clear_error(&err);
        release_stamper_if_unused(tee_name);
        gst_object_unref(tee);
        return Attach::Done;
    }
    g_clear_error(&err);
    gst_object_ref_sink(branch);
    g_branch_seq++;
    gst_element_set_name(branch, ("busedge_" + std::to_string(g_branch_seq)).c_str());

    // Bind and publish before the branch joins the pipeline: a failed start
    // then posts to no bus, so it can never fail the producer.
    auto e = std::make_shared<Edge>();
    ::unlink(bind.c_str());
    bool bound = gst_element_set_state(branch, GST_STATE_READY) != GST_STATE_CHANGE_FAILURE;
    int perr = bound ? publish_path(bind, socket, e->path) : -1;
    if (perr != 0) {
        gst_element_set_state(branch, GST_STATE_NULL);
        gst_object_unref(branch);
        release_stamper_if_unused(tee_name);
        gst_object_unref(tee);
        if (perr == EEXIST) {
            *held = socket + " was taken by another socket";
            return Attach::Held;
        }
        ipc::warning("bus_attach: cannot serve " + socket + ": " + (perr > 0 ? std::strerror(perr) : "bind failed"));
        return Attach::Done;
    }

    // Add the leaf to the tee's OWN parent bin (a tee inside a branch bin
    // cannot link to an element in a different bin).
    GstObject* parent_obj = gst_object_get_parent(GST_OBJECT(tee));
    GstBin* parent = parent_obj && GST_IS_BIN(parent_obj) ? GST_BIN(parent_obj) : GST_BIN(r.pipeline);
    gst_bin_add(parent, branch);

    // Activate BEFORE linking, targeting the pipeline's PENDING state: a
    // branch added mid-transition otherwise stays inactive and the tee's first
    // sticky-event push returns FLUSHING, pausing the producer's task forever.
    gst_element_get_state(r.pipeline, &cur, &pend, 0);
    gst_element_set_state(branch, pend != GST_STATE_VOID_PENDING ? pend : cur);

    GstPad* tee_src = gst_element_request_pad_simple(tee, "src_%u");
    if (!tee_src) {
        ipc::warning("bus_attach: no tee src pad (" + tee_name + ")");
        release_path(socket, e->path);
        gst_element_set_state(branch, GST_STATE_NULL);
        gst_bin_remove(parent, branch);
        gst_object_unref(branch);
        release_stamper_if_unused(tee_name);
        if (parent_obj) gst_object_unref(parent_obj);
        gst_object_unref(tee);
        return Attach::Done;   // don't retry a structural failure
    }
    GstPad* branch_sink = gst_element_get_static_pad(branch, "sink");
    GstPadLinkReturn link_ret = gst_pad_link(tee_src, branch_sink);
    gst_object_unref(branch_sink);
    if (link_ret != GST_PAD_LINK_OK) {
        ipc::warning("bus_attach: link failed (" + std::to_string((int)link_ret) + ") " + socket);
        gst_element_release_request_pad(tee, tee_src);
        gst_object_unref(tee_src);
        release_path(socket, e->path);
        gst_element_set_state(branch, GST_STATE_NULL);
        gst_bin_remove(parent, branch);
        gst_object_unref(branch);
        release_stamper_if_unused(tee_name);
        if (parent_obj) gst_object_unref(parent_obj);
        gst_object_unref(tee);
        return Attach::Done;
    }
    if (parent_obj) gst_object_unref(parent_obj);

    e->branch = branch;
    e->tee = tee;
    e->tee_src = tee_src;
    e->tee_name = tee_name;
    // Find the unixfdsink's sink pad for the progress probe.
    GstIterator* it = gst_bin_iterate_recurse(GST_BIN(branch));
    GValue item = G_VALUE_INIT;
    bool done = false;
    while (!done) {
        switch (gst_iterator_next(it, &item)) {
            case GST_ITERATOR_OK: {
                GstElement* el = GST_ELEMENT(g_value_get_object(&item));
                if (factory_name(el) == "unixfdsink") e->sink_pad = gst_element_get_static_pad(el, "sink");
                g_value_reset(&item);
                break;
            }
            case GST_ITERATOR_RESYNC: gst_iterator_resync(it); break;
            default: done = true; break;
        }
    }
    g_value_unset(&item);
    gst_iterator_free(it);

    g_branches[socket] = e;
    arm_edge_progress_probe(e);
    if (!g_tee_progress.count(tee_name)) {
        GstPad* tpad = gst_element_get_static_pad(tee, "sink");
        if (tpad) {
            auto t = std::make_shared<TeeProgress>();
            t->pad = tpad;
            g_tee_progress[tee_name] = t;
            arm_tee_progress_probe(t);
        }
    }
    ensure_stall_timer();
    JsonObject* ev = ipc::event("bus_attached");
    json_object_set_string_member(ev, "tee", tee_name.c_str());
    json_object_set_string_member(ev, "socket", socket.c_str());
    ipc::emit(ev);
    return Attach::Done;
}

/** One warning per pending attach while its path is held, so a second live
 *  producer on one path (a configuration error) never spins silently. */
void note_held(Pending& p, const std::string& held) {
    if (p.held_logged) return;
    p.held_logged = true;
    ipc::warning("bus_attach: " + held + " — attach waits until the path is free");
}

void note_done(const Pending& p, const std::string& socket) {
    if (p.held_logged && g_branches.count(socket)) ipc::log("bus_attach: " + socket + " free again — attached");
}

gboolean retry_pending_cb(gpointer) {
    for (auto it = g_pending.begin(); it != g_pending.end();) {
        const std::string socket = it->first;
        Pending& p = it->second;
        std::string held;
        Attach a = try_bus_attach(p.tee, socket, &held);
        if (a == Attach::Done) {
            note_done(p, socket);
            it = g_pending.erase(it);
            continue;
        }
        if (a == Attach::Held) {
            note_held(p, held);
        } else if (++p.attempts == BUS_ATTACH_WARN_AFTER) {
            std::string what = runner().pipeline ? "tee " + p.tee : "pipeline";
            ipc::warning("bus_attach: " + what + " not up yet for " + socket + " — still retrying");
        }
        ++it;
    }
    if (g_pending.empty()) {
        g_retry_timer_id = 0;
        return G_SOURCE_REMOVE;
    }
    return G_SOURCE_CONTINUE;
}

/** Attach now, or queue the persistent 250 ms retry. */
void attach_or_queue(const std::string& tee_name, const std::string& socket) {
    std::string held;
    Attach a = try_bus_attach(tee_name, socket, &held);
    auto it = g_pending.find(socket);
    if (a == Attach::Done) {
        if (it != g_pending.end()) {
            note_done(it->second, socket);
            g_pending.erase(it);
        }
        return;
    }
    // A duplicate attach keeps the pending entry's one held warning.
    Pending& p = it != g_pending.end() ? it->second : g_pending[socket];
    p.tee = tee_name;
    p.attempts = 0;
    if (a == Attach::Held) note_held(p, held);
    if (!g_retry_timer_id) g_retry_timer_id = g_timeout_add(250, retry_pending_cb, nullptr);
}

// --- stall watchdog -------------------------------------------------------------

gboolean stall_watchdog_cb(gpointer) {
    // Snapshot per-tee progress for this tick, then re-arm the tee probes.
    std::map<std::string, bool> tee_flowing;
    for (auto& [tname, t] : g_tee_progress) {
        bool p = t->progressed.load(std::memory_order_relaxed);
        tee_flowing[tname] = p;
        if (p) {
            t->progressed.store(false, std::memory_order_relaxed);
            t->probe_id = 0;   // progressed ⇒ the one-shot fired ⇒ its id is dead
            arm_tee_progress_probe(t);
        }
    }
    std::vector<std::string> sockets;
    for (auto& [sock, e] : g_branches) sockets.push_back(sock);
    for (const std::string& socket : sockets) {
        auto it = g_branches.find(socket);
        if (it == g_branches.end()) continue;
        std::shared_ptr<Edge> e = it->second;
        if (e->progressed.load(std::memory_order_relaxed)) {
            e->progressed.store(false, std::memory_order_relaxed);
            e->stall = 0;
            e->soft_healed = false;
            e->probe_id = 0;
            arm_edge_progress_probe(e);
            continue;
        }
        // No edge progress this tick. Only a stall when the tee itself IS
        // receiving data (dark source ≠ stuck edge).
        if (!tee_flowing[e->tee_name]) {
            e->stall = 0;
            continue;
        }
        e->stall++;
        if (e->stall < BUS_STALL_TICKS) continue;
        std::string tee_name = e->tee_name;
        if (!e->soft_healed) {
            // First recovery is non-destructive: a state-race latch un-wedges
            // with a plain re-sync and the consumer's socket survives.
            e->soft_healed = true;
            e->stall = 0;
            gst_element_sync_state_with_parent(e->branch);
            ipc::warning("bus edge silent " + std::to_string(BUS_STALL_TICKS) +
                         " ticks (tee flowing) — soft re-sync " + socket);
            continue;
        }
        ipc::warning("bus edge stalled (tee flowing, edge sink silent " + std::to_string(e->stall) +
                     " ticks) — resetting " + socket);
        teardown_branch(socket);
        // Teardown is probe-gated (async): queue the re-create so it lands
        // after the old branch releases the socket and tee pad.
        attach_or_queue(tee_name, socket);
    }
    if (g_branches.empty()) {
        for (auto& [tname, t] : g_tee_progress) {
            if (t->probe_id) gst_pad_remove_probe(t->pad, t->probe_id);
            gst_object_unref(t->pad);
        }
        g_tee_progress.clear();
        g_stall_timer_id = 0;
        return G_SOURCE_REMOVE;
    }
    return G_SOURCE_CONTINUE;
}

bool ensure_stall_timer() {
    if (!g_stall_timer_id && !g_branches.empty())
        g_stall_timer_id = g_timeout_add(BUS_STALL_TICK_MS, stall_watchdog_cb, nullptr);
    return true;
}

// --- teardown -------------------------------------------------------------------

struct Teardown {
    std::shared_ptr<Edge> e;
    std::string socket;
};

struct ReleasePad {
    GstElement* tee;
    GstPad* pad;
};

gboolean release_tee_pad_idle(gpointer data) {
    auto* rp = static_cast<ReleasePad*>(data);
    gst_element_release_request_pad(rp->tee, rp->pad);
    gst_object_unref(rp->pad);
    gst_object_unref(rp->tee);
    delete rp;
    return G_SOURCE_REMOVE;
}

void finish_teardown(const std::shared_ptr<Edge>& e, const std::string& socket, GstPad* pad) {
    // While the sink still listens; its own stop unlinks only the private bind path.
    release_path(socket, e->path);
    GstPad* peer = gst_pad_get_peer(pad);
    if (peer) {
        gst_pad_unlink(pad, peer);
        gst_object_unref(peer);
    }
    gst_element_set_state(e->branch, GST_STATE_NULL);
    GstObject* parent = gst_object_get_parent(GST_OBJECT(e->branch));
    if (parent && GST_IS_BIN(parent)) gst_bin_remove(GST_BIN(parent), e->branch);
    if (parent) gst_object_unref(parent);
    gst_object_unref(e->branch);
    e->branch = nullptr;
    if (e->sink_pad) {
        gst_object_unref(e->sink_pad);
        e->sink_pad = nullptr;
    }
    // Release the request pad from the main loop, not under the probe's lock.
    g_idle_add(release_tee_pad_idle, new ReleasePad{e->tee, e->tee_src});
    e->tee = nullptr;
    e->tee_src = nullptr;
    JsonObject* ev = ipc::event("bus_detached");
    json_object_set_string_member(ev, "socket", socket.c_str());
    ipc::emit(ev);
}

GstPadProbeReturn teardown_probe_cb(GstPad* pad, GstPadProbeInfo*, gpointer user) {
    auto* td = static_cast<Teardown*>(user);
    // Runs with the tee src pad blocked (or idle): the producer's streaming
    // thread cannot be inside this branch anymore.
    finish_teardown(td->e, td->socket, pad);
    g_teardowns.erase(td->socket);
    return GST_PAD_PROBE_REMOVE;
}

void delete_teardown(gpointer p) { delete static_cast<Teardown*>(p); }

}  // namespace

// ---------------------------------------------------------------------------

std::string edge_branch_description(const std::string& socket) {
    return "queue leaky=2 max-size-time=" + std::to_string((gint64)BUS_EDGE_QUEUE_MS * 1000000) +
           " max-size-buffers=0 max-size-bytes=" + std::to_string(BUS_EDGE_QUEUE_MAX_BYTES) +
           " ! unixfdsink socket-path=" + socket + " sync=false async=false wait-for-connection=false";
}

void handle_bus_attach(JsonObject* data) {
    std::string tee = json_get_string(data, "tee"), socket = json_get_string(data, "socket");
    if (tee.empty() || socket.empty()) return;
    attach_or_queue(tee, socket);
}

void handle_bus_detach(JsonObject* data) {
    teardown_branch(json_get_string(data, "socket"));
}

void clear_pending() {
    g_pending.clear();
    g_teardowns.clear();
}

void release_paths() {
    for (auto& [socket, e] : g_branches) release_path(socket, e->path);
}

bool teardown_branch(const std::string& socket) {
    g_pending.erase(socket);
    auto it = g_branches.find(socket);
    if (it == g_branches.end()) return false;
    std::shared_ptr<Edge> e = it->second;
    g_branches.erase(it);
    // The entry is out of the map, so this disarms the stamper exactly when
    // the tee just lost its LAST consumer.
    release_stamper_if_unused(e->tee_name);
    if (e->probe_id && e->sink_pad) {
        gst_pad_remove_probe(e->sink_pad, e->probe_id);
        e->probe_id = 0;
    }
    // Teardown BEHIND A BLOCKING PAD PROBE on the tee src pad (the canonical
    // dynamic-unlink recipe): deactivating mid-push pauses the producer's
    // task forever. IDLE fires at once on a quiet pad.
    g_teardowns.insert(socket);
    gst_pad_add_probe(e->tee_src, (GstPadProbeType)(GST_PAD_PROBE_TYPE_BLOCK_DOWNSTREAM | GST_PAD_PROBE_TYPE_IDLE),
                      teardown_probe_cb, new Teardown{e, socket}, delete_teardown);
    return true;
}

GstObject* busedge_ancestor(GstObject* obj) {
    if (!obj) return nullptr;
    GstObject* cur = GST_OBJECT(gst_object_ref(obj));
    while (cur) {
        const gchar* name = GST_OBJECT_NAME(cur);
        if (name && g_str_has_prefix(name, "busedge_")) return cur;
        GstObject* parent = gst_object_get_parent(cur);
        gst_object_unref(cur);
        cur = parent;
    }
    return nullptr;
}

std::string socket_for_busedge(GstObject* edge_bin) {
    for (auto& [sock, e] : g_branches)
        if (GST_OBJECT(e->branch) == edge_bin) return sock;
    return "";
}

void handle_bus_reinput(JsonObject* data) {
    Runner& r = runner();
    std::string req_id = json_get_string(data, "id");
    std::string name = json_get_string(data, "element"), socket = json_get_string(data, "socket");
    if (!r.pipeline) {
        ipc::command_error(req_id, "bus_reinput: no pipeline");
        return;
    }
    if (name.empty() || socket.empty()) {
        ipc::command_error(req_id, "bus_reinput: element and socket required");
        return;
    }
    GstElement* old = GST_IS_BIN(r.pipeline) ? gst_bin_get_by_name(GST_BIN(r.pipeline), name.c_str()) : nullptr;
    if (!old) {
        ipc::command_error(req_id, "bus_reinput: element '" + name + "' not found");
        return;
    }
    GstPad* src_pad = gst_element_get_static_pad(old, "src");
    GstPad* peer = src_pad ? gst_pad_get_peer(src_pad) : nullptr;
    if (!peer) {
        ipc::command_error(req_id, "bus_reinput: '" + name + "' has no linked src pad");
        if (src_pad) gst_object_unref(src_pad);
        gst_object_unref(old);
        return;
    }
    // Stopping the source stops dataflow on this branch — no pad blocking
    // needed (the ingress queue downstream simply runs dry for the gap).
    gst_element_set_state(old, GST_STATE_NULL);
    gst_pad_unlink(src_pad, peer);
    gst_object_unref(src_pad);
    gst_bin_remove(GST_BIN(r.pipeline), old);
    gst_object_unref(old);

    GstElement* fresh = gst_element_factory_make("unixfdsrc", name.c_str());
    if (!fresh) {
        ipc::command_error(req_id, "bus_reinput: unixfdsrc factory unavailable");
        gst_object_unref(peer);
        return;
    }
    g_object_set(fresh, "socket-path", socket.c_str(), nullptr);
    gst_bin_add(GST_BIN(r.pipeline), fresh);
    GstPad* fresh_src = gst_element_get_static_pad(fresh, "src");
    GstPadLinkReturn link = gst_pad_link(fresh_src, peer);
    gst_object_unref(fresh_src);
    gst_object_unref(peer);
    if (link != GST_PAD_LINK_OK) {
        ipc::command_error(req_id, "bus_reinput: relink failed (" + std::to_string((int)link) + ")");
        return;
    }
    gst_element_sync_state_with_parent(fresh);
    ipc::log("bus_reinput: " + name + " -> " + socket);
    JsonObject* ev = ipc::event("bus_reinput_done");
    if (!req_id.empty()) json_object_set_string_member(ev, "id", req_id.c_str());
    ipc::emit(ev);
}

}  // namespace mr::bus
