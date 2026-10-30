#include "shed_watch.h"

#include <json-glib/json-glib.h>

#include <atomic>
#include <limits>
#include <memory>
#include <string>
#include <vector>

#include "runner.h"

namespace mr::shed_watch {

namespace {

struct Watch {
    std::string name;
    GstElement* queue = nullptr;   // owned ref
    gulong handler = 0;
    guint max_bytes = 0;
    // Written by whichever streaming thread meets the queue full.
    std::atomic<guint64> overruns{0};
    std::atomic<gint64> first_us{0};   // the first overrun since the last episode closed
    std::atomic<gint64> last_us{0};
    // Main loop only: the open episode.
    bool open = false;
    bool long_reported = false;
    guint64 base = 0;                  // overruns before it
    gint64 opened_us = 0;
};

std::vector<std::unique_ptr<Watch>> g_watches;
guint g_tick_id = 0;

void on_overrun(GstElement*, gpointer user) {
    auto* w = static_cast<Watch*>(user);
    const gint64 now = g_get_monotonic_time();
    gint64 none = 0;
    w->first_us.compare_exchange_strong(none, now, std::memory_order_relaxed);
    w->last_us.store(now, std::memory_order_relaxed);
    w->overruns.fetch_add(1, std::memory_order_release);
}

/** The episode so far: each buffer that met the queue full pushed older data out. */
void report(const Watch& w, guint64 total, gint64 last, bool ongoing) {
    JsonObject* o = json_object_new();
    json_object_set_string_member(o, "element", w.name.c_str());
    json_object_set_int_member(o, "overruns", (gint64)(total - w.base));
    json_object_set_int_member(o, "durationMs", (last - w.opened_us) / 1000);
    json_object_set_int_member(o, "totalOverruns", (gint64)total);
    json_object_set_int_member(o, "maxSizeBytes", (gint64)w.max_bytes);
    json_object_set_boolean_member(o, "ongoing", ongoing);
    JsonNode* n = json_node_new(JSON_NODE_OBJECT);
    json_node_take_object(n, o);
    runner().emit_plugin_event(EVENT, n);
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
    }
    if (now - last >= (gint64)QUIET_MS * 1000) {
        report(w, total, last, false);
        w.open = false;
        w.base = total;
        w.first_us.store(0, std::memory_order_relaxed);
    } else if (!w.long_reported && now - w.opened_us >= (gint64)LONG_MS * 1000) {
        report(w, total, last, true);
        w.long_reported = true;
    }
}

gboolean tick_cb(gpointer) {
    const gint64 now = g_get_monotonic_time();
    for (auto& w : g_watches) check(*w, now);
    return G_SOURCE_CONTINUE;
}

/** The pipeline's queues named PREFIX…, as owned refs. */
std::vector<GstElement*> ingest_queues(GstElement* pipe) {
    std::vector<GstElement*> found;
    GstIterator* it = gst_bin_iterate_recurse(GST_BIN(pipe));
    GValue item = G_VALUE_INIT;
    for (bool done = false; !done;) {
        switch (gst_iterator_next(it, &item)) {
            case GST_ITERATOR_OK: {
                GstElement* el = GST_ELEMENT(g_value_get_object(&item));
                const gchar* name = GST_OBJECT_NAME(el);
                if (name && g_str_has_prefix(name, PREFIX) && factory_name(el) == "queue")
                    found.push_back(GST_ELEMENT(gst_object_ref(el)));
                g_value_reset(&item);
                break;
            }
            case GST_ITERATOR_RESYNC:
                for (GstElement* el : found) gst_object_unref(el);
                found.clear();
                gst_iterator_resync(it);
                break;
            default: done = true; break;
        }
    }
    g_value_unset(&item);
    gst_iterator_free(it);
    return found;
}

}  // namespace

void install(GstElement* pipe) {
    clear();
    if (!GST_IS_BIN(pipe)) return;
    for (GstElement* el : ingest_queues(pipe)) {
        auto w = std::make_unique<Watch>();
        w->name = GST_OBJECT_NAME(el);
        w->queue = el;
        g_object_get(el, "max-size-bytes", &w->max_bytes, nullptr);
        w->handler = g_signal_connect(el, "overrun", G_CALLBACK(on_overrun), w.get());
        g_watches.push_back(std::move(w));
    }
    if (!g_watches.empty()) g_tick_id = g_timeout_add(TICK_MS, tick_cb, nullptr);
}

void clear() {
    if (g_tick_id) {
        g_source_remove(g_tick_id);
        g_tick_id = 0;
    }
    for (auto& w : g_watches) {
        check(*w, std::numeric_limits<gint64>::max());
        g_signal_handler_disconnect(w->queue, w->handler);
        gst_object_unref(w->queue);
    }
    g_watches.clear();
}

}  // namespace mr::shed_watch
