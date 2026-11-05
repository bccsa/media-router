// B-208 on bus_inputs.cpp itself, deterministic: an Audio Mixer's aggregator (non-live, latency 0) on the
// house clock, its branches identity bins fed from the test's own pads; the twin of gst_live_inputs_test.py's
// test_kept_pad_* (the python runner). Events go to ipc's data-pipe fd 4, a file here.
#include <fcntl.h>
#include <gst/gst.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "../bus_inputs.h"
#include "../ipc.h"
#include "../json_util.h"
#include "../runner.h"
#include "mrts/tests/check.h"

namespace {

constexpr GstClockTime BLOCK = 10 * GST_MSECOND;
constexpr GstClockTime SAMPLE = GST_SECOND / 48000 + 1;
constexpr const char* PCM = "audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved";

GstClock* g_clock = nullptr;
int g_events_fd = -1;

GstClockTime now() { return gst_clock_get_time(g_clock); }
GstClockTime grid() { return now() / BLOCK * BLOCK; }

/** Event names written since the last call. */
std::vector<std::string> take_events() {
    std::string all;
    char buf[4096];
    ssize_t n;
    while ((n = ::read(g_events_fd, buf, sizeof buf)) > 0) all.append(buf, (size_t)n);
    std::vector<std::string> out;
    size_t at = 0, nl;
    while ((nl = all.find('\n', at)) != std::string::npos) {
        const std::string line = all.substr(at, nl - at);
        at = nl + 1;
        if (line.rfind("GST_JSON:", 0) != 0) continue;
        if (JsonObject* o = mr::json_parse_object(line.substr(9), nullptr)) {
            out.push_back(mr::json_get_string(o, "event"));
            json_object_unref(o);
        }
    }
    return out;
}

bool has(const std::vector<std::string>& events, const char* name) {
    for (const auto& e : events)
        if (e == name) return true;
    return false;
}

struct Out {
    GstClockTime wall, pts, dur;
};

/** The mixer, its outputs, and a hold of its src thread at its first CAPS or buffer push. */
struct Mixer {
    GstElement* pipe = nullptr;
    GstElement* mixin = nullptr;
    std::mutex m;
    std::condition_variable cv;
    std::vector<Out> outs;
    std::string hold;
    bool held = false, go = false;
};

GstPadProbeReturn on_src(GstPad*, GstPadProbeInfo* info, gpointer user) {
    auto* mx = static_cast<Mixer*>(user);
    std::unique_lock<std::mutex> lock(mx->m);
    std::string kind;
    if (GST_PAD_PROBE_INFO_TYPE(info) & GST_PAD_PROBE_TYPE_BUFFER) {
        GstBuffer* b = GST_PAD_PROBE_INFO_BUFFER(info);
        if (mx->outs.size() < 5000) mx->outs.push_back({now(), GST_BUFFER_PTS(b), GST_BUFFER_DURATION(b)});
        kind = "buffer";
    } else if (GST_EVENT_TYPE(GST_PAD_PROBE_INFO_EVENT(info)) == GST_EVENT_CAPS) {
        kind = "caps";
    }
    if (!kind.empty() && kind == mx->hold) {
        mx->hold.clear();
        mx->held = true;
        mx->cv.notify_all();
        mx->cv.wait_for(lock, std::chrono::seconds(5), [mx] { return mx->go; });
    }
    return GST_PAD_PROBE_OK;
}

/** One branch `a` (two with `c`), the runner's pipeline, its live branches declared. */
Mixer* make(const char* hold, bool two = false) {
    auto* mx = new Mixer();
    mx->hold = hold ? hold : "";
    std::string desc =
        "audiomixer name=mixin latency=0 start-time-selection=first ! capsfilter caps=audio/x-raw,rate=48000,channels=2"
        " ! fakesink sync=false async=false  ( name=mixin_in_a identity name=a_id ) ! mixin.sink_0";
    if (two) desc += "  ( name=mixin_in_c identity name=c_id ) ! mixin.sink_1";
    GError* err = nullptr;
    mx->pipe = gst_parse_launch(desc.c_str(), &err);
    if (err) {
        std::printf("FAIL parse: %s\n", err->message);
        std::exit(1);
    }
    gst_pipeline_use_clock(GST_PIPELINE(mx->pipe), g_clock);
    gst_element_set_start_time(mx->pipe, GST_CLOCK_TIME_NONE);
    gst_element_set_base_time(mx->pipe, 0);
    mr::runner().pipeline = mx->pipe;
    JsonArray* names = json_array_new();
    json_array_add_string_element(names, "mixin_in_a");
    if (two) json_array_add_string_element(names, "mixin_in_c");
    mr::inputs::declare(names);
    json_array_unref(names);
    mx->mixin = gst_bin_get_by_name(GST_BIN(mx->pipe), "mixin");
    GstPad* src = gst_element_get_static_pad(mx->mixin, "src");
    gst_pad_add_probe(src, (GstPadProbeType)(GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM), on_src,
                      mx, nullptr);
    gst_object_unref(src);
    gst_element_set_state(mx->pipe, GST_STATE_PLAYING);
    gst_element_get_state(mx->pipe, nullptr, nullptr, 2 * GST_SECOND);
    take_events();
    return mx;
}

bool wait_held(Mixer* mx) {
    std::unique_lock<std::mutex> lock(mx->m);
    return mx->cv.wait_for(lock, std::chrono::seconds(5), [mx] { return mx->held; });
}

void release(Mixer* mx) {
    std::lock_guard<std::mutex> lock(mx->m);
    mx->go = true;
    mx->cv.notify_all();
}

void destroy(Mixer* mx) {
    release(mx);
    mr::inputs::clear();
    gst_element_set_state(mx->pipe, GST_STATE_NULL);
    mr::runner().pipeline = nullptr;
    gst_object_unref(mx->mixin);
    gst_object_unref(mx->pipe);
    delete mx;
}

/** A pad of the test's own on `element`'s sink pad, its stream started. Owned. */
GstPad* head(Mixer* mx, const char* element, const char* tag) {
    GstElement* el = gst_bin_get_by_name(GST_BIN(mx->pipe), element);
    GstPad* sink = el ? gst_element_get_static_pad(el, "sink") : nullptr;
    GstPad* src = gst_pad_new(tag, GST_PAD_SRC);
    gst_pad_set_active(src, TRUE);
    if (!sink || gst_pad_link(src, sink) != GST_PAD_LINK_OK) {
        std::printf("FAIL cannot feed %s\n", element);
        std::exit(1);
    }
    gst_object_unref(sink);
    gst_object_unref(el);
    GstSegment seg;
    gst_segment_init(&seg, GST_FORMAT_TIME);
    GstCaps* caps = gst_caps_from_string(PCM);
    gst_pad_push_event(src, gst_event_new_stream_start(tag));
    gst_pad_push_event(src, gst_event_new_caps(caps));
    gst_pad_push_event(src, gst_event_new_segment(&seg));
    gst_caps_unref(caps);
    return src;
}

GstBuffer* block(GstClockTime pts, GstClockTime dur = BLOCK) {
    gsize size = (gsize)(dur * 48000 / GST_SECOND * 4);
    GstBuffer* b = gst_buffer_new_allocate(nullptr, size, nullptr);
    gst_buffer_memset(b, 0, 0, size);
    GST_BUFFER_PTS(b) = pts;
    GST_BUFFER_DURATION(b) = dur;
    return b;
}

void push_async(GstPad* src, GstBuffer* b) {
    gst_object_ref(src);
    std::thread([src, b] {
        gst_pad_push(src, b);
        gst_object_unref(src);
    }).detach();
}

/** bus_input_add of an identity branch `<name>_id`, or of `desc`; true on its done event. */
bool add(const std::string& name, const std::string& desc = "") {
    JsonObject* o = json_object_new();
    json_object_set_string_member(o, "id", name.c_str());
    json_object_set_string_member(o, "element", "mixin");
    json_object_set_string_member(o, "name", ("mixin_in_" + name).c_str());
    json_object_set_string_member(o, "description", (desc.empty() ? "identity name=" + name + "_id" : desc).c_str());
    mr::inputs::handle_bus_input_add(o);
    json_object_unref(o);
    return has(take_events(), "bus_input_add_done");
}

struct Window {
    size_t n = 0;
    double worst_s = 0, rate = 0;
};

/** 10 ms blocks at house time on `src` in real time from a thread (a runaway mixer never takes one,
 *  its push blocks) for `seconds`; that window's outputs. */
Window feed(Mixer* mx, GstPad* src, double seconds = 0.6) {
    auto stop = std::make_shared<std::atomic<bool>>(false);
    gst_object_ref(src);
    std::thread([src, stop] {
        GstClockTime t = grid();
        while (!*stop) {
            while (now() < t && !*stop) g_usleep(1000);
            if (*stop || gst_pad_push(src, block(t)) != GST_FLOW_OK) break;
            t += BLOCK;
        }
        gst_object_unref(src);
    }).detach();
    const GstClockTime t0 = now();
    g_usleep((gulong)(seconds * 1e6));
    const GstClockTime t1 = now();
    *stop = true;
    Window w;
    GstClockTime played = 0, worst = 0;
    std::lock_guard<std::mutex> lock(mx->m);
    for (const Out& o : mx->outs) {
        if (o.wall < t0 || o.wall >= t1) continue;
        w.n++;
        const GstClockTime off = o.pts > o.wall ? o.pts - o.wall : o.wall - o.pts;
        if (off > worst) worst = off;
        if (o.dur > 0 && o.dur < GST_SECOND) played += o.dur;
    }
    w.worst_s = (double)worst / 1e9;
    w.rate = (double)played / (double)(t1 - t0);
    return w;
}

bool on_house_time(const Window& w) { return w.n > 0 && w.worst_s < 1.0 && w.rate <= 1.5; }

/** Outputs that do not start where the one before them ended (more than a sample off). */
size_t breaks(Mixer* mx) {
    std::lock_guard<std::mutex> lock(mx->m);
    size_t n = 0;
    for (size_t i = 1; i < mx->outs.size(); i++) {
        const GstClockTime end = mx->outs[i - 1].pts + mx->outs[i - 1].dur, pts = mx->outs[i].pts;
        if ((pts > end ? pts - end : end - pts) > SAMPLE) n++;
    }
    return n;
}

int sink_pads(Mixer* mx) {
    GST_OBJECT_LOCK(mx->mixin);
    const int n = mx->mixin->numsinkpads;
    GST_OBJECT_UNLOCK(mx->mixin);
    return n;
}

/** sink_0 kept: still the mixer's, its only sink pad, unlinked. */
bool kept_unlinked(Mixer* mx, const char* pad_name) {
    GstPad* pad = gst_element_get_static_pad(mx->mixin, pad_name);
    const bool ok = pad && !gst_pad_is_linked(pad) && sink_pads(mx) == 1;
    if (pad) gst_object_unref(pad);
    return ok;
}

bool linked(Mixer* mx, const char* pad_name) {
    GstPad* pad = gst_element_get_static_pad(mx->mixin, pad_name);
    const bool ok = pad && gst_pad_is_linked(pad);
    if (pad) gst_object_unref(pad);
    return ok;
}

char g_text[512];
const char* text(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
const char* text(const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(g_text, sizeof g_text, fmt, ap);
    va_end(ap);
    return g_text;
}

// The race MR-046 met: the mixer's first buffer on its only pad, its src thread held in its first
// negotiation while the branch is dropped as a lost input; then a branch added brings data.
void race() {
    Mixer* mx = make("caps");
    GstPad* a = head(mx, "a_id", "feed_a");
    push_async(a, block(grid()));
    CHECK("race: the mixer took its first buffer, its first negotiation held", wait_held(mx));
    CHECK("race: the branch dropped as a lost input", mr::inputs::drop_branch("mixin_in_a"));
    CHECK("race: its pad kept, unlinked, the mixer's only sink pad", kept_unlinked(mx, "sink_0"));
    release(mx);
    g_usleep(50000);
    const bool done = add("b");
    CHECK("race: the next add takes the kept pad (sink_0 linked, one sink pad)",
          done && linked(mx, "sink_0") && sink_pads(mx) == 1);
    GstPad* b = head(mx, "b_id", "feed_b");
    Window w = feed(mx, b);
    CHECK(text("race: the mix stays on house time, within 1 s at 1.5x real time or less (%zu outputs, "
               "worst %.3f s, %.2fx)", w.n, w.worst_s, w.rate),
          on_house_time(w));
    gst_object_unref(a);
    gst_object_unref(b);
    destroy(mx);
}

// The kept pad still holds 5 ms of a 15 ms buffer being mixed and a 20 ms GAP behind it when the
// next branch takes it 100 ms later: the mix goes on where it was, each output where the last ended.
void stale_data() {
    Mixer* mx = make("buffer");
    GstPad* a = head(mx, "a_id", "feed_a");
    const GstClockTime x = grid();
    push_async(a, block(x, 15 * GST_MSECOND));
    CHECK("stale data: the mixer held in its first 10 ms output of a 15 ms buffer", wait_held(mx));
    gst_pad_push_event(a, gst_event_new_gap(x + 15 * GST_MSECOND, 20 * GST_MSECOND));
    mr::inputs::drop_branch("mixin_in_a");
    CHECK("stale data: the pad kept with the partial buffer and the GAP on it", kept_unlinked(mx, "sink_0"));
    release(mx);
    g_usleep(100000);
    GstClockTime held_to = 0, first = 0;
    size_t n_before = 0;
    {
        std::lock_guard<std::mutex> lock(mx->m);
        n_before = mx->outs.size();
        for (const Out& o : mx->outs) held_to = std::max(held_to, o.pts + o.dur - x);
    }
    const bool done = add("b");
    GstPad* b = head(mx, "b_id", "feed_b");
    Window w = feed(mx, b);
    {
        std::lock_guard<std::mutex> lock(mx->m);
        first = mx->outs.size() > n_before ? mx->outs[n_before].pts - x : 0;
    }
    CHECK(text("stale data: what the kept pad held was mixed before the add (%.1f ms of the old 35 ms)",
               held_to / 1e6),
          held_to >= 20 * GST_MSECOND && held_to <= 35 * GST_MSECOND);
    CHECK(text("stale data: the add takes the kept pad and the mix goes on where it was, each output where "
               "the one before it ended (first after the add at %.1f ms; %zu breaks)",
               first / 1e6, breaks(mx)),
          done && first == held_to && breaks(mx) == 0);
    CHECK(text("stale data: on house time, within 1 s at 1.5x real time or less (%zu outputs, worst %.3f s, "
               "%.2fx)", w.n, w.worst_s, w.rate),
          on_house_time(w));
    gst_object_unref(a);
    gst_object_unref(b);
    destroy(mx);
}

// A branch never added back: the mixer waits on its kept pad; a failed add leaves it kept; the stop
// (clear) gives the kept reference back.
void never_taken() {
    Mixer* mx = make(nullptr);
    GstPad* a = head(mx, "a_id", "feed_a");
    feed(mx, a, 0.3);
    g_usleep(50000);
    mr::inputs::drop_branch("mixin_in_a");
    size_t n0;
    {
        std::lock_guard<std::mutex> lock(mx->m);
        n0 = mx->outs.size();
    }
    g_usleep(400000);
    GstState state = GST_STATE_NULL;
    gst_element_get_state(mx->pipe, &state, nullptr, 0);
    size_t after;
    {
        std::lock_guard<std::mutex> lock(mx->m);
        after = mx->outs.size() - n0;
    }
    CHECK(text("never taken: the mixer waits on its kept pad, nothing mixed after the drop (%zu outputs), "
               "still PLAYING", after),
          after <= 1 && state == GST_STATE_PLAYING && kept_unlinked(mx, "sink_0"));
    const bool linked_bad = add("v", "capsfilter caps=video/x-raw");
    CHECK("never taken: an add whose branch cannot link fails and leaves the pad kept",
          !linked_bad && kept_unlinked(mx, "sink_0"));
    GstPad* pad = gst_element_get_static_pad(mx->mixin, "sink_0");
    const int refs = pad ? GST_OBJECT_REFCOUNT_VALUE(pad) : 0;
    mr::inputs::clear();
    const int left = pad ? GST_OBJECT_REFCOUNT_VALUE(pad) : 0;
    CHECK(text("never taken: the stop's clear() gives the kept reference back (%d -> %d)", refs, left),
          pad && left == refs - 1);
    if (pad) gst_object_unref(pad);
    gst_object_unref(a);
    destroy(mx);
}

/** bus_input_remove of `mixin_in_<name>`, as the engine sends it; true on its done event. */
bool remove_input(const std::string& name) {
    JsonObject* o = json_object_new();
    json_object_set_string_member(o, "id", name.c_str());
    json_object_set_string_member(o, "element", "mixin");
    json_object_set_string_member(o, "name", ("mixin_in_" + name).c_str());
    mr::inputs::handle_bus_input_remove(o);
    json_object_unref(o);
    return has(take_events(), "bus_input_remove_done");
}

// Of two inputs, the lost one's pad is released as before and its re-add gets a new request pad;
// the engine's remove releases one of two as well, and keeps the last.
void two_inputs() {
    Mixer* mx = make(nullptr, true);
    CHECK("two inputs: the branch dropped", mr::inputs::drop_branch("mixin_in_a"));
    GstPad* gone = gst_element_get_static_pad(mx->mixin, "sink_0");
    CHECK("two inputs: its pad released beside the other input (2 -> 1)", !gone && sink_pads(mx) == 1);
    if (gone) gst_object_unref(gone);
    CHECK("two inputs: the re-add gets a new request pad (sink_2)",
          add("a2") && linked(mx, "sink_2") && sink_pads(mx) == 2);
    const bool removed = remove_input("c");
    gone = gst_element_get_static_pad(mx->mixin, "sink_1");
    CHECK("two inputs: bus_input_remove of one of two releases its pad", removed && !gone && sink_pads(mx) == 1);
    if (gone) gst_object_unref(gone);
    CHECK("two inputs: bus_input_remove of the last keeps its pad (sink_2), unlinked",
          remove_input("a2") && kept_unlinked(mx, "sink_2"));
    CHECK("two inputs: the next add takes it", add("a3") && linked(mx, "sink_2") && sink_pads(mx) == 1);
    destroy(mx);
}

}  // namespace

int main(int argc, char** argv) {
    std::setvbuf(stdout, nullptr, _IOLBF, 0);
    gchar* tmp = g_dir_make_tmp("mr-kept-pad-XXXXXX", nullptr);
    if (!tmp) {
        std::printf("FAIL no temp dir\n");
        return 1;
    }
    const std::string events = std::string(tmp) + "/events";
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
    if (!gst_element_factory_find("audiomixer")) {
        std::printf("SKIP bus_inputs_kept_pad_test: audiomixer unavailable\n");
        return 0;
    }
    g_clock = gst_system_clock_obtain();
    g_object_set(g_clock, "clock-type", GST_CLOCK_TYPE_MONOTONIC, nullptr);

    race();
    stale_data();
    never_taken();
    two_inputs();

    gst_object_unref(g_clock);
    ::close(g_events_fd);
    ::unlink(events.c_str());
    ::rmdir(tmp);
    g_free(tmp);
    return test_summary("bus_inputs_kept_pad");
}
