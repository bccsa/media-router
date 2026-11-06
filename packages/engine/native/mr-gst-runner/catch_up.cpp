#include "catch_up.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "json_util.h"
#include "runner.h"

namespace mr::catchup {

namespace {

/** What one input skipped. */
struct Skip {
    std::string element;
    double skipped_ms = 0;
    guint64 buffers = 0;
};

/** One launch: when its first buffer came (running time, -1 before) and its report. */
struct Launch {
    GstElement* pipe = nullptr;   // borrowed: the runner's pipeline
    std::string prefix;
    gulong added_id = 0;
    std::atomic<gint64> start_rt{-1};
    std::atomic<gint64> kept_late{0};   // the most an input's first kept buffer came after its end
    std::mutex m;                 // the fields below
    int pending = 0;              // launch inputs that have not delivered yet
    bool reported = false;        // the launch's report went out
    std::vector<Skip> skips;
    guint timer_id = 0;           // the deadline (main loop)
};

/** One probed input; its fields are its streaming thread's. */
struct Input {
    std::shared_ptr<Launch> launch;
    std::string element;
    bool at_launch = false;
    bool render = false;   // the render point: its own line, set at its first buffer
    gint64 line = -1;
    guint64 buffers = 0;   // buffers and GAPs skipped
    gint64 first_ns = -1;
    gint64 end_ns = -1;
    // The reading that tells a live stream behind the house clock from a backlog (`streams`).
    gint64 stream_from = -1, stream_c0 = -1, last_at = -1;
};

// A stream behind the house clock, not a backlog: its content advances at most 1.5x as fast as it
// arrives, read over STREAM_NS; a pause of STREAM_PAUSE_NS restarts the reading.
constexpr gint64 STREAM_NS = GST_SECOND;
constexpr gint64 STREAM_PAUSE_NS = GST_SECOND;

std::shared_ptr<Launch> g_launch;

/** Emit `skips` (none: nothing) on the main loop. */
struct Emit {
    std::vector<Skip> skips;
};

gboolean emit_idle(gpointer p) {
    std::unique_ptr<Emit> e(static_cast<Emit*>(p));
    if (e->skips.empty()) return G_SOURCE_REMOVE;
    JsonArray* inputs = json_array_new();
    double longest = 0;
    for (const Skip& s : e->skips) {
        JsonObject* o = json_object_new();
        json_object_set_string_member(o, "element", s.element.c_str());
        json_object_set_double_member(o, "skippedMs", std::round(s.skipped_ms * 10.0) / 10.0);
        json_object_set_int_member(o, "buffers", (gint64)s.buffers);
        json_array_add_object_element(inputs, o);
        longest = std::max(longest, s.skipped_ms);
    }
    JsonObject* o = json_object_new();
    json_object_set_array_member(o, "inputs", inputs);
    json_object_set_double_member(o, "skippedMs", std::round(longest * 10.0) / 10.0);
    JsonNode* n = json_node_new(JSON_NODE_OBJECT);
    json_node_take_object(n, o);
    runner().emit_plugin_event(EVENT, n);
    return G_SOURCE_REMOVE;
}

void post(std::vector<Skip> skips) {
    if (!skips.empty()) g_idle_add(emit_idle, new Emit{std::move(skips)});
}

/** The deadline: the launch reports with the inputs that delivered by now. */
gboolean deadline_cb(gpointer p) {
    auto launch = *static_cast<std::shared_ptr<Launch>*>(p);
    std::vector<Skip> skips;
    {
        std::lock_guard<std::mutex> lk(launch->m);
        launch->timer_id = 0;
        if (launch->reported) return G_SOURCE_REMOVE;
        launch->reported = true;
        skips.swap(launch->skips);
    }
    post(std::move(skips));
    return G_SOURCE_REMOVE;
}

void delete_launch_ref(gpointer p) { delete static_cast<std::shared_ptr<Launch>*>(p); }

/** Main loop: arm the deadline once the launch's first buffer came. */
gboolean arm_idle(gpointer p) {
    auto launch = *static_cast<std::shared_ptr<Launch>*>(p);
    std::lock_guard<std::mutex> lk(launch->m);
    if (!launch->reported && !launch->timer_id && g_launch == launch)
        launch->timer_id = g_timeout_add_full(G_PRIORITY_DEFAULT, REPORT_MS, deadline_cb,
                                              new std::shared_ptr<Launch>(launch), delete_launch_ref);
    return G_SOURCE_REMOVE;
}

/** An input delivered its first buffer it keeps: into the launch's report, or one of its own. */
void resolved(Input& in) {
    Launch& l = *in.launch;
    std::vector<Skip> alone, all;
    Skip s{in.element, in.buffers ? (double)(in.end_ns - in.first_ns) / 1e6 : 0, in.buffers};
    {
        std::lock_guard<std::mutex> lk(l.m);
        if (!in.at_launch || l.reported) {
            if (s.buffers) alone.push_back(s);
        } else {
            if (s.buffers) l.skips.push_back(s);
            if (--l.pending == 0) {
                l.reported = true;
                all.swap(l.skips);
            }
        }
    }
    post(std::move(alone));
    post(std::move(all));
}

/** `t` as running time on `pad`'s segment; -1 without one, or outside it. */
gint64 running_time(GstPad* pad, GstClockTime t) {
    if (!GST_CLOCK_TIME_IS_VALID(t)) return -1;
    GstEvent* ev = gst_pad_get_sticky_event(pad, GST_EVENT_SEGMENT, 0);
    if (!ev) return -1;
    const GstSegment* seg = nullptr;
    gst_event_parse_segment(ev, &seg);
    gint64 rt = -1;
    if (seg && seg->format == GST_FORMAT_TIME) {
        GstClockTime r = gst_segment_to_running_time(seg, GST_FORMAT_TIME, t);
        if (GST_CLOCK_TIME_IS_VALID(r)) rt = (gint64)r;
    }
    gst_event_unref(ev);
    return rt;
}

/** The running time [start, end) a buffer, a list or a GAP covers (a GAP is the outage's hole:
 *  let through, it starts a mix that far back); false for anything else or untimed. */
bool span(GstPad* pad, GstPadProbeInfo* info, gint64* start, gint64* end) {
    GstClockTime first = GST_CLOCK_TIME_NONE, last = GST_CLOCK_TIME_NONE, dur = GST_CLOCK_TIME_NONE;
    if (GST_PAD_PROBE_INFO_TYPE(info) & GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM) {
        GstEvent* ev = GST_PAD_PROBE_INFO_EVENT(info);
        if (!ev || GST_EVENT_TYPE(ev) != GST_EVENT_GAP) return false;
        gst_event_parse_gap(ev, &first, &dur);
        last = first;
    } else {
        GstBuffer* a = nullptr;
        GstBuffer* b = nullptr;
        if (GST_PAD_PROBE_INFO_TYPE(info) & GST_PAD_PROBE_TYPE_BUFFER_LIST) {
            GstBufferList* l = GST_PAD_PROBE_INFO_BUFFER_LIST(info);
            const guint n = l ? gst_buffer_list_length(l) : 0;
            if (n) {
                a = gst_buffer_list_get(l, 0);
                b = gst_buffer_list_get(l, n - 1);
            }
        } else {
            a = b = GST_PAD_PROBE_INFO_BUFFER(info);
        }
        if (!a) return false;
        first = GST_BUFFER_PTS(a);
        last = GST_BUFFER_PTS(b);
        dur = GST_BUFFER_DURATION(b);
    }
    *start = running_time(pad, first);
    const gint64 last_start = running_time(pad, last);
    if (*start < 0 || last_start < 0) return false;
    *end = last_start + (GST_CLOCK_TIME_IS_VALID(dur) ? (gint64)dur : 0);
    return true;
}

/** Old content arriving about as fast as it plays is a stream behind the house clock, not a
 *  backlog (one comes at once): after STREAM_NS it goes on as it comes, to be re-anchored
 *  downstream, never dropped (the owner's rule, 2026-10-08). */
bool streams(Input& in, gint64 now, gint64 end) {
    if (in.stream_from < 0 || now - in.last_at >= STREAM_PAUSE_NS) {
        in.stream_from = now;
        in.stream_c0 = end;
    }
    in.last_at = now;
    const gint64 waited = now - in.stream_from;
    return waited >= STREAM_NS && (end - in.stream_c0) * 2 <= waited * 3;
}

GstPadProbeReturn probe_cb(GstPad* pad, GstPadProbeInfo* info, gpointer user) {
    Input& in = *static_cast<Input*>(user);
    gint64 start = 0, end = 0;
    if (!span(pad, info, &start, &end)) return GST_PAD_PROBE_OK;   // not ours to judge
    GstElement* el = gst_pad_get_parent_element(pad);
    const GstClockTime now = el ? gst_element_get_current_running_time(el) : GST_CLOCK_TIME_NONE;
    if (el) gst_object_unref(el);
    if (!GST_CLOCK_TIME_IS_VALID(now)) return GST_PAD_PROBE_OK;   // not PLAYING yet
    gint64 line;
    if (in.render) {
        // What came this much later than the inputs did was queued here, before it first played.
        if (in.line < 0) in.line = (gint64)now - in.launch->kept_late.load() - RENDER_SLACK_NS;
        line = in.line;
    } else {
        gint64 none = -1;
        if (in.launch->start_rt.compare_exchange_strong(none, (gint64)now))
            g_idle_add_full(G_PRIORITY_DEFAULT_IDLE, arm_idle, new std::shared_ptr<Launch>(in.launch),
                            delete_launch_ref);
        line = in.launch->start_rt.load();
    }
    // Content that ends before the line was due while this output was not playing: its outage
    // (or, at the render point, its own wait), skipped whole.
    if (end <= line && !streams(in, (gint64)now, end)) {
        if (in.first_ns < 0) in.first_ns = start;
        in.end_ns = end;
        in.buffers++;
        return GST_PAD_PROBE_DROP;
    }
    if (!in.render) {
        gint64 late = (gint64)now - end, was = in.launch->kept_late.load();
        while (late > was && !in.launch->kept_late.compare_exchange_weak(was, late)) {
        }
    }
    resolved(in);
    return GST_PAD_PROBE_REMOVE;
}

void delete_input(gpointer p) { delete static_cast<Input*>(p); }

void probe(GstElement* el, Input* in) {
    GstPad* pad = gst_element_get_static_pad(el, "sink");
    if (!pad) {
        delete in;
        return;
    }
    if (in->at_launch) in->launch->pending++;   // install() runs before any data, on the main loop
    gst_pad_add_probe(pad,
                      (GstPadProbeType)(GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_BUFFER_LIST |
                                        GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM),
                      probe_cb, in, delete_input);
    gst_object_unref(pad);
}

void watch(const std::shared_ptr<Launch>& launch, GstElement* el, bool at_launch) {
    const gchar* name = GST_OBJECT_NAME(el);
    if (!name || !g_str_has_prefix(name, launch->prefix.c_str())) return;
    probe(el, new Input{launch, name, at_launch});
}

void deep_added_cb(GstBin*, GstBin*, GstElement* el, gpointer user) {
    watch(*static_cast<std::shared_ptr<Launch>*>(user), el, false);
}

void delete_closure_ref(gpointer p, GClosure*) { delete static_cast<std::shared_ptr<Launch>*>(p); }

}  // namespace

void install(GstElement* pipe, JsonObject* cfg) {
    clear();
    if (!cfg || !GST_IS_BIN(pipe)) return;
    auto launch = std::make_shared<Launch>();
    launch->pipe = pipe;
    launch->prefix = json_get_string(cfg, "prefix");
    if (launch->prefix.empty()) return;
    GstIterator* it = gst_bin_iterate_recurse(GST_BIN(pipe));
    GValue item = G_VALUE_INIT;
    for (bool done = false; !done;) {
        switch (gst_iterator_next(it, &item)) {
            case GST_ITERATOR_OK:
                watch(launch, GST_ELEMENT(g_value_get_object(&item)), true);
                g_value_reset(&item);
                break;
            case GST_ITERATOR_RESYNC: gst_iterator_resync(it); break;
            default: done = true; break;
        }
    }
    g_value_unset(&item);
    gst_iterator_free(it);
    const std::string render = json_get_string(cfg, "render");
    if (GstElement* el = render.empty() ? nullptr : gst_bin_get_by_name(GST_BIN(pipe), render.c_str())) {
        Input* in = new Input{launch, render, true};
        in->render = true;
        probe(el, in);
        gst_object_unref(el);
    }
    // A branch added live (a join, a re-link) catches up against the same launch.
    launch->added_id = g_signal_connect_data(pipe, "deep-element-added", G_CALLBACK(deep_added_cb),
                                             new std::shared_ptr<Launch>(launch), delete_closure_ref,
                                             (GConnectFlags)0);
    g_launch = launch;
}

void clear() {
    std::shared_ptr<Launch> launch = g_launch;
    g_launch.reset();
    if (!launch) return;
    {
        std::lock_guard<std::mutex> lk(launch->m);
        if (launch->timer_id) g_source_remove(launch->timer_id);
        launch->timer_id = 0;
        launch->reported = true;
    }
    // Only on the pipeline that still runs: a torn-down one took its handler with it.
    if (launch->added_id && launch->pipe == runner().pipeline)
        g_signal_handler_disconnect(launch->pipe, launch->added_id);
}

}  // namespace mr::catchup
