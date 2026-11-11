#include "queue_watch.h"

#include <json-glib/json-glib.h>

#include <atomic>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <vector>

#include "runner.h"

namespace mr::queue_watch {

namespace {

struct Watch {
    std::string name;
    GstElement* queue = nullptr;   // owned ref
    gulong handler = 0;
    int leaky = 0;
    // Written by whichever streaming thread meets the queue full.
    std::atomic<guint64> overruns{0};
    std::atomic<gint64> first_us{0};   // the first overrun since the last episode closed
    std::atomic<gint64> last_us{0};
    std::atomic<gint64> level_us{0};   // when the level below was last read
    std::atomic<guint64> level_ns{0};  // the episode's highest read
    std::atomic<guint> level_bytes{0};
    std::atomic<bool> removed{false};  // left the pipeline: its episode ends at the next tick
    // Main loop only: the open episode.
    bool open = false;
    bool long_reported = false;
    guint64 base = 0;                  // overruns before it
    gint64 opened_us = 0;
    std::string input;                 // the first unixfdsrc upstream when it opened ("": none)
};

std::mutex g_lock;   // the lists, the tick and the pipeline below
std::vector<std::unique_ptr<Watch>> g_watches;
// Watches whose queue left the pipeline: freed at clear(), as a callback already begun may run on.
std::vector<std::unique_ptr<Watch>> g_gone;
guint g_tick_id = 0;
GstElement* g_pipe = nullptr;   // owned ref while installed
gulong g_added_id = 0, g_removed_id = 0;

template <typename T>
void store_max(std::atomic<T>& a, T v) {
    T cur = a.load(std::memory_order_relaxed);
    while (v > cur && !a.compare_exchange_weak(cur, v, std::memory_order_relaxed)) {
    }
}

void on_overrun(GstElement* queue, gpointer user) {
    auto* w = static_cast<Watch*>(user);
    const gint64 now = g_get_monotonic_time();
    gint64 none = 0;
    w->first_us.compare_exchange_strong(none, now, std::memory_order_relaxed);
    w->last_us.store(now, std::memory_order_relaxed);
    // The level it was full at, read at most once a second (the queue's lock is free while it
    // emits the signal); the episode keeps its highest, as a read can find the queue drained.
    if (now - w->level_us.load(std::memory_order_relaxed) >= G_USEC_PER_SEC) {
        w->level_us.store(now, std::memory_order_relaxed);
        guint64 ns = 0;
        guint bytes = 0;
        g_object_get(queue, "current-level-time", &ns, "current-level-bytes", &bytes, nullptr);
        store_max(w->level_ns, ns);
        store_max(w->level_bytes, bytes);
    }
    w->overruns.fetch_add(1, std::memory_order_release);
}

/** The src pad feeding `sink` across ghost pads (owned ref), or nullptr. */
GstPad* feeding_pad(GstPad* sink) {
    GstPad* peer = gst_pad_get_peer(sink);
    for (int hops = 0; peer && hops < 16; hops++) {
        if (GST_IS_GHOST_PAD(peer)) {   // a bin's src ghost: into the bin
            GstPad* target = gst_ghost_pad_get_target(GST_GHOST_PAD(peer));
            gst_object_unref(peer);
            peer = target;
        } else if (GST_IS_PROXY_PAD(peer)) {   // the inside of a bin's sink ghost: out of the bin
            GstObject* ghost = gst_object_get_parent(GST_OBJECT(peer));
            gst_object_unref(peer);
            peer = ghost && GST_IS_PAD(ghost) ? gst_pad_get_peer(GST_PAD(ghost)) : nullptr;
            if (ghost) gst_object_unref(ghost);
        } else {
            return peer;
        }
    }
    if (peer) gst_object_unref(peer);
    return nullptr;
}

/** The name of the first unixfdsrc upstream of `el`: depth first, its sink pads in turn. */
bool find_input(GstElement* el, std::set<GstElement*>& seen, std::string* out) {
    if (!seen.insert(el).second || seen.size() > 256) return false;
    bool found = false;
    GstIterator* it = gst_element_iterate_sink_pads(el);
    GValue item = G_VALUE_INIT;
    for (bool done = false; !done && !found;) {
        switch (gst_iterator_next(it, &item)) {
            case GST_ITERATOR_OK: {
                GstPad* src = feeding_pad(GST_PAD(g_value_get_object(&item)));
                GstElement* up = src ? gst_pad_get_parent_element(src) : nullptr;
                if (up) {
                    if (factory_name(up) == "unixfdsrc") {
                        *out = GST_OBJECT_NAME(up);
                        found = true;
                    } else {
                        found = find_input(up, seen, out);
                    }
                    gst_object_unref(up);
                }
                if (src) gst_object_unref(src);
                g_value_reset(&item);
                break;
            }
            case GST_ITERATOR_RESYNC: gst_iterator_resync(it); break;
            default: done = true; break;
        }
    }
    g_value_unset(&item);
    gst_iterator_free(it);
    return found;
}

/** The episode so far: each buffer that met the queue full (leaky: pushed an older one out). */
void report(const Watch& w, guint64 total, gint64 last, bool ongoing) {
    JsonObject* o = json_object_new();
    json_object_set_string_member(o, "element", w.name.c_str());
    if (w.input.empty()) json_object_set_null_member(o, "input");
    else json_object_set_string_member(o, "input", w.input.c_str());
    json_object_set_int_member(o, "leaky", w.leaky);
    json_object_set_int_member(o, "levelTimeMs", (gint64)(w.level_ns.load(std::memory_order_relaxed) / GST_MSECOND));
    json_object_set_int_member(o, "levelBytes", (gint64)w.level_bytes.load(std::memory_order_relaxed));
    json_object_set_int_member(o, "overruns", (gint64)(total - w.base));
    json_object_set_int_member(o, "ms", (last - w.opened_us) / 1000);
    json_object_set_int_member(o, "totalOverruns", (gint64)total);
    json_object_set_boolean_member(o, "ongoing", ongoing);
    JsonNode* n = json_node_new(JSON_NODE_OBJECT);
    json_node_take_object(n, o);
    runner().emit_plugin_event(EVENT, n);
}

/** Whether `q` is at a bound now: a level at its nonzero maximum. */
bool at_bound(GstElement* q) {
    guint buffers = 0, bytes = 0, max_buffers = 0, max_bytes = 0;
    guint64 time = 0, max_time = 0;
    g_object_get(q, "current-level-buffers", &buffers, "current-level-bytes", &bytes, "current-level-time", &time,
                 "max-size-buffers", &max_buffers, "max-size-bytes", &max_bytes, "max-size-time", &max_time, nullptr);
    return (max_buffers && buffers >= max_buffers) || (max_bytes && bytes >= max_bytes) ||
           (max_time && time >= max_time);
}

/** Open an episode on a new overrun; close it after QUIET_MS without one (`now` past every
 *  bound: close it now); one report while it is open past LONG_MS. */
void check(Watch& w, gint64 now) {
    const guint64 total = w.overruns.load(std::memory_order_acquire);
    const gint64 last = w.last_us.load(std::memory_order_relaxed);
    if (!w.open) {
        if (total == w.base) return;
        const gint64 first = w.first_us.load(std::memory_order_relaxed);
        w.open = true;
        w.long_reported = false;
        w.opened_us = first ? first : last;
        std::set<GstElement*> seen;
        w.input.clear();
        find_input(w.queue, seen, &w.input);
    }
    if (now - last >= (gint64)QUIET_MS * 1000) {
        // A non-leaky queue met full once and below its bound since: one buffer's label jump (an
        // outage's), not a backlog, which meets it full on every buffer (B-177). A stop reports all.
        const bool stop = now == std::numeric_limits<gint64>::max();
        if (stop || w.leaky || total - w.base > 1 || (w.queue && at_bound(w.queue))) report(w, total, last, false);
        w.open = false;
        w.base = total;
        w.first_us.store(0, std::memory_order_relaxed);
        // The next episode reads its own level, from its first overrun.
        w.level_ns.store(0, std::memory_order_relaxed);
        w.level_bytes.store(0, std::memory_order_relaxed);
        w.level_us.store(0, std::memory_order_relaxed);
    } else if (!w.long_reported && now - w.opened_us >= (gint64)LONG_MS * 1000) {
        report(w, total, last, true);
        w.long_reported = true;
    }
}

gboolean tick_cb(gpointer) {
    const gint64 now = g_get_monotonic_time();
    std::vector<Watch*> live;
    {
        std::lock_guard<std::mutex> lock(g_lock);
        for (auto& w : g_watches) live.push_back(w.get());
    }
    std::set<Watch*> retired;
    for (Watch* w : live) {
        // A queue that left the pipeline ends its episode as at a stop.
        const bool gone = w->removed.load(std::memory_order_acquire);
        check(*w, gone ? std::numeric_limits<gint64>::max() : now);
        if (gone) retired.insert(w);
    }
    if (retired.empty()) return G_SOURCE_CONTINUE;
    std::lock_guard<std::mutex> lock(g_lock);
    for (auto it = g_watches.begin(); it != g_watches.end();) {
        if (retired.count(it->get())) {
            gst_object_unref((*it)->queue);
            (*it)->queue = nullptr;
            g_gone.push_back(std::move(*it));
            it = g_watches.erase(it);
        } else {
            ++it;
        }
    }
    return G_SOURCE_CONTINUE;
}

bool watched(GstElement* el, int* leaky) {
    if (factory_name(el) != "queue") return false;
    gint value = 0;
    g_object_get(el, "leaky", &value, nullptr);
    *leaky = value;
    if (value != 0) return true;
    const gchar* name = GST_OBJECT_NAME(el);
    for (const char* n : NAMES)
        if (name && std::strcmp(name, n) == 0) return true;
    return false;
}

void add(GstElement* el) {
    int leaky = 0;
    if (!watched(el, &leaky)) return;
    std::lock_guard<std::mutex> lock(g_lock);
    if (!g_pipe) return;
    for (auto& w : g_watches)
        if (w->queue == el) return;
    auto w = std::make_unique<Watch>();
    w->name = GST_OBJECT_NAME(el);
    w->queue = GST_ELEMENT(gst_object_ref(el));
    w->leaky = leaky;
    w->handler = g_signal_connect(el, "overrun", G_CALLBACK(on_overrun), w.get());
    g_watches.push_back(std::move(w));
    if (!g_tick_id) g_tick_id = g_timeout_add(TICK_MS, tick_cb, nullptr);
}

/** Any thread: a queue added to the pipeline later (an edge, a live input, a bin's own). */
void deep_added_cb(GstBin*, GstBin*, GstElement* el, gpointer) { add(el); }

/** Any thread: its queue left the pipeline, so no overrun comes after this. */
void deep_removed_cb(GstBin*, GstBin*, GstElement* el, gpointer) {
    std::lock_guard<std::mutex> lock(g_lock);
    for (auto& w : g_watches) {
        if (w->queue != el || w->removed.load(std::memory_order_relaxed)) continue;
        g_signal_handler_disconnect(el, w->handler);
        w->handler = 0;
        w->removed.store(true, std::memory_order_release);
    }
}

}  // namespace

void install(GstElement* pipe) {
    clear();
    if (!GST_IS_BIN(pipe)) return;
    {
        std::lock_guard<std::mutex> lock(g_lock);
        g_pipe = GST_ELEMENT(gst_object_ref(pipe));
    }
    GstIterator* it = gst_bin_iterate_recurse(GST_BIN(pipe));
    GValue item = G_VALUE_INIT;
    for (bool done = false; !done;) {
        switch (gst_iterator_next(it, &item)) {
            case GST_ITERATOR_OK:
                add(GST_ELEMENT(g_value_get_object(&item)));
                g_value_reset(&item);
                break;
            case GST_ITERATOR_RESYNC: gst_iterator_resync(it); break;
            default: done = true; break;
        }
    }
    g_value_unset(&item);
    gst_iterator_free(it);
    g_added_id = g_signal_connect(pipe, "deep-element-added", G_CALLBACK(deep_added_cb), nullptr);
    g_removed_id = g_signal_connect(pipe, "deep-element-removed", G_CALLBACK(deep_removed_cb), nullptr);
}

void clear() {
    std::vector<std::unique_ptr<Watch>> watches, gone;
    GstElement* pipe = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_lock);
        if (g_tick_id) g_source_remove(g_tick_id);
        g_tick_id = 0;
        watches.swap(g_watches);
        gone.swap(g_gone);
        pipe = g_pipe;
        g_pipe = nullptr;
    }
    if (pipe) {
        g_signal_handler_disconnect(pipe, g_added_id);
        g_signal_handler_disconnect(pipe, g_removed_id);
        g_added_id = g_removed_id = 0;
    }
    for (auto& w : watches) {
        check(*w, std::numeric_limits<gint64>::max());
        if (w->handler) g_signal_handler_disconnect(w->queue, w->handler);
        gst_object_unref(w->queue);
    }
    if (pipe) gst_object_unref(pipe);
}

}  // namespace mr::queue_watch
