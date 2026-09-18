#include "bus_edges.h"

#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <atomic>
#include <cstring>
#include <map>
#include <memory>
#include <set>
#include <vector>

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
};

struct TeeProgress {
    GstPad* pad = nullptr;          // owned ref (tee sink pad)
    std::atomic<bool> progressed{false};
    gulong probe_id = 0;
};

std::map<std::string, std::shared_ptr<Edge>> g_branches;          // socket -> edge
std::map<std::string, std::shared_ptr<TeeProgress>> g_tee_progress; // tee name -> progress
std::map<std::string, std::pair<std::string, int>> g_pending;      // socket -> (tee, attempts)
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

// --- stale socket handling ----------------------------------------------------

/** Connect-probe a unix socket path (200 ms). */
bool socket_accepts(const std::string& path) {
    int fd = ::socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK, 0);
    if (fd < 0) return false;
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::strncpy(addr.sun_path, path.c_str(), sizeof(addr.sun_path) - 1);
    bool ok = false;
    int r = ::connect(fd, (sockaddr*)&addr, sizeof addr);
    if (r == 0) {
        ok = true;
    } else if (errno == EINPROGRESS || errno == EAGAIN) {
        pollfd p{fd, POLLOUT, 0};
        if (::poll(&p, 1, 200) > 0) {
            int soerr = 0;
            socklen_t len = sizeof soerr;
            ok = ::getsockopt(fd, SOL_SOCKET, SO_ERROR, &soerr, &len) == 0 && soerr == 0;
        }
    }
    ::close(fd);
    return ok;
}

/** unixfdsink cannot bind over an existing socket file, and a runner that
 *  dies hard never unlinks its path. Unlink only if nothing is listening. */
void remove_stale_bus_socket(const std::string& path) {
    if (!g_file_test(path.c_str(), G_FILE_TEST_EXISTS)) return;
    if (socket_accepts(path)) {
        ipc::warning("bus_attach: live producer already on " + path + " — not unlinking");
        return;
    }
    if (::unlink(path.c_str()) == 0) ipc::warning("bus_attach: unlinked stale bus socket " + path);
}

// --- attach ---------------------------------------------------------------------

bool ensure_stall_timer();

/** Attach one branch. True on success (or a structural failure that must not
 *  be retried), false if the tee isn't up yet. */
bool try_bus_attach(const std::string& tee_name, const std::string& socket) {
    Runner& r = runner();
    // No pipeline YET — stay pending (the engine can queue an attach before
    // `start`); `handle_stop` clears the queue.
    if (!r.pipeline) return false;
    if (g_teardowns.count(socket)) return false;   // old branch still detaching
    auto existing = g_branches.find(socket);
    if (existing != g_branches.end()) {
        // Idempotent re-attach: re-sync so a branch stuck at READY by a
        // mid-transition add bumps to the settled parent state.
        gst_element_sync_state_with_parent(existing->second->branch);
        return true;
    }
    GstElement* tee = GST_IS_BIN(r.pipeline) ? gst_bin_get_by_name(GST_BIN(r.pipeline), tee_name.c_str()) : nullptr;
    if (!tee) return false;   // tee not created yet — caller queues a retry

    // Arm the egress stamper BEFORE the branch is linked: once linked, buffers
    // reach the new edge immediately.
    stamper::arm(tee, tee_name);
    remove_stale_bus_socket(socket);

    GError* err = nullptr;
    GstElement* branch = gst_parse_bin_from_description(edge_branch_description(socket).c_str(), TRUE, &err);
    if (!branch) {
        ipc::warning(std::string("bus_attach parse failed: ") + (err && err->message ? err->message : "?"));
        g_clear_error(&err);
        release_stamper_if_unused(tee_name);
        gst_object_unref(tee);
        return true;
    }
    g_clear_error(&err);
    gst_object_ref_sink(branch);
    g_branch_seq++;
    gst_element_set_name(branch, ("busedge_" + std::to_string(g_branch_seq)).c_str());

    // Add the leaf to the tee's OWN parent bin (a tee inside a branch bin
    // cannot link to an element in a different bin).
    GstObject* parent_obj = gst_object_get_parent(GST_OBJECT(tee));
    GstBin* parent = parent_obj && GST_IS_BIN(parent_obj) ? GST_BIN(parent_obj) : GST_BIN(r.pipeline);
    gst_bin_add(parent, branch);

    // Activate BEFORE linking, targeting the pipeline's PENDING state: a
    // branch added mid-transition otherwise stays inactive and the tee's first
    // sticky-event push returns FLUSHING, pausing the producer's task forever.
    GstState cur = GST_STATE_NULL, pend = GST_STATE_VOID_PENDING;
    gst_element_get_state(r.pipeline, &cur, &pend, 0);
    gst_element_set_state(branch, pend != GST_STATE_VOID_PENDING ? pend : cur);

    GstPad* tee_src = gst_element_request_pad_simple(tee, "src_%u");
    if (!tee_src) {
        ipc::warning("bus_attach: no tee src pad (" + tee_name + ")");
        gst_element_set_state(branch, GST_STATE_NULL);
        gst_bin_remove(parent, branch);
        gst_object_unref(branch);
        release_stamper_if_unused(tee_name);
        if (parent_obj) gst_object_unref(parent_obj);
        gst_object_unref(tee);
        return true;   // don't retry a structural failure
    }
    GstPad* branch_sink = gst_element_get_static_pad(branch, "sink");
    GstPadLinkReturn link_ret = gst_pad_link(tee_src, branch_sink);
    gst_object_unref(branch_sink);
    if (link_ret != GST_PAD_LINK_OK) {
        ipc::warning("bus_attach: link failed (" + std::to_string((int)link_ret) + ") " + socket);
        gst_element_release_request_pad(tee, tee_src);
        gst_object_unref(tee_src);
        gst_element_set_state(branch, GST_STATE_NULL);
        gst_bin_remove(parent, branch);
        gst_object_unref(branch);
        release_stamper_if_unused(tee_name);
        if (parent_obj) gst_object_unref(parent_obj);
        gst_object_unref(tee);
        return true;
    }
    if (parent_obj) gst_object_unref(parent_obj);

    auto e = std::make_shared<Edge>();
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
    return true;
}

gboolean retry_pending_cb(gpointer) {
    for (auto it = g_pending.begin(); it != g_pending.end();) {
        const std::string socket = it->first;
        std::string tee_name = it->second.first;
        int attempts = it->second.second;
        if (try_bus_attach(tee_name, socket)) {
            it = g_pending.erase(it);
            continue;
        }
        attempts++;
        if (attempts == BUS_ATTACH_WARN_AFTER) {
            std::string what = runner().pipeline ? "tee " + tee_name : "pipeline";
            ipc::warning("bus_attach: " + what + " not up yet for " + socket + " — still retrying");
        }
        it->second.second = attempts;
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
    if (try_bus_attach(tee_name, socket)) {
        g_pending.erase(socket);
        return;
    }
    g_pending[socket] = {tee_name, 0};
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
    // unixfdsink does not unlink its socket file on NULL.
    ::unlink(socket.c_str());
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
