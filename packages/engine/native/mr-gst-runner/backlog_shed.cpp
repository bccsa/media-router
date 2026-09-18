#include "backlog_shed.h"

#include <gst/base/gstbasesink.h>

#include "gates.h"

#include <atomic>
#include <cmath>
#include <cstdio>
#include <memory>
#include <mutex>

#include "ipc.h"
#include "json_util.h"
#include "runner.h"

namespace mr::shed {

namespace {

constexpr double KEYFRAME_WARN_MS = 3000.0;
constexpr double STALE_MS = 4000.0;
constexpr double DEFAULT_STALL_GRACE_MS = 10000.0;

std::string fmt(const char* f, ...) __attribute__((format(printf, 1, 2)));
std::string fmt(const char* f, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, f);
    std::vsnprintf(buf, sizeof buf, f, ap);
    va_end(ap);
    return buf;
}

double round1(double v) { return std::round(v * 10.0) / 10.0; }

double stall_grace_ms() {
    const char* s = g_getenv("MR_SHED_STALL_GRACE_S");
    if (!s || !*s) return DEFAULT_STALL_GRACE_MS;
    char* end = nullptr;
    double secs = std::strtod(s, &end);
    return (end && end != s && secs > 0) ? secs * 1000.0 : DEFAULT_STALL_GRACE_MS;
}

/** Did the decoder survive the shed? idle → watching → flushed → idle. */
struct StallWatch {
    double grace_ms = stall_grace_ms();
    bool enabled = true;
    enum Stage { IDLE, WATCHING, FLUSHED } stage = IDLE;
    double deadline_ms = 0;
    bool armed() const { return stage != IDLE; }
    bool arm(double now_ms) {
        if (!enabled) return false;
        stage = WATCHING;
        deadline_ms = now_ms + grace_ms;
        return true;
    }
    void disarm() { stage = IDLE; }
    double remaining_ms(double now_ms) const { return armed() ? std::max(0.0, deadline_ms - now_ms) : 0; }
    /** "flush", "error" or nullptr. */
    const char* tick(double now_ms) {
        if (!armed() || now_ms < deadline_ms) return nullptr;
        if (stage == WATCHING) {
            stage = FLUSHED;
            deadline_ms = now_ms + grace_ms;
            return "flush";
        }
        disarm();
        return "error";
    }
};

/** WHEN a clock-paced leg must hand its retained backlog back (backlog_shed.py). */
struct Policy {
    double tolerance_ms, hold_ms, cooldown_ms, sanity_ms;
    int sheds = 0;
    bool has_above_since = false;
    double above_since = 0;
    bool has_last_shed_end = false;
    double last_shed_end = 0;
    bool implausible = false;
    bool timeline = false;
    void reset() {
        has_above_since = false;
        implausible = false;
        timeline = false;
    }
    /** nullptr, "shed", "implausible" or "timeline". `queued` is lazy. */
    template <typename Queued>
    const char* observe(double lateness_ms, double now_ms, Queued queued) {
        if (std::isnan(lateness_ms)) return nullptr;
        if (std::fabs(lateness_ms) > sanity_ms) {
            has_above_since = false;
            if (implausible) return nullptr;
            implausible = true;
            return "implausible";
        }
        implausible = false;
        if (lateness_ms <= tolerance_ms) {
            has_above_since = false;
            timeline = false;
            return nullptr;
        }
        if (!has_above_since) {
            has_above_since = true;
            above_since = now_ms;
            return nullptr;
        }
        if (now_ms - above_since < hold_ms) return nullptr;
        if (has_last_shed_end && now_ms - last_shed_end < cooldown_ms) return nullptr;
        double q = queued();
        if (q < tolerance_ms) {
            above_since = now_ms;   // ask again after another hold
            if (timeline) return nullptr;
            timeline = true;
            return "timeline";
        }
        return "shed";
    }
    void shed_finished(double now_ms) {
        sheds++;
        has_last_shed_end = true;
        last_shed_end = now_ms;
        has_above_since = false;
    }
};

struct State {
    GstElement* pipe = nullptr;       // borrowed (the runner's pipeline)
    GstPad* pad = nullptr;            // owned
    std::string element;
    GstElement* sink = nullptr;       // owned
    Policy policy{};
    gulong probe_id = 0;
    GstSegment* segment = nullptr;
    bool keyframe_aligned = true;
    bool shedding = false;
    int64_t dropped = 0;
    int sheds = 0;
    double shed_at = 0;
    double before_ms = 0;
    bool has_caught_up_at = false;
    double caught_up_at = 0;
    bool keyframe_warned = false;
    double budget_ms = 0;
    // Written by the probe, read by the render watch on the main loop: a
    // benign race on floats that are only ever replaced (python does the same).
    std::atomic<bool> has_last{false};
    std::atomic<double> last_ms{0}, last_at{0};
    std::atomic<bool> has_win_min{false};
    std::atomic<double> win_min{0};
    // post-shed stall watch
    std::mutex stall_m;
    StallWatch stall;
    GstPad* out_pad = nullptr;        // owned or nullptr
    gulong stall_probe_id = 0;
    std::atomic<int> stall_gen{0};
};

std::shared_ptr<State> g_state;

void log_line(State& st, const std::string& line) {
    ipc::log("backlog shed: " + st.element + " " + line);
}

double ts_offset_ms(State& st) {
    if (!g_object_class_find_property(G_OBJECT_GET_CLASS(st.sink), "ts-offset")) return 0.0;
    gint64 v = 0;
    g_object_get(st.sink, "ts-offset", &v, nullptr);
    return (double)v / 1e6;
}

/** The sink's negotiated pipeline latency — a `sync=true` sink renders at
 *  `rt + ts-offset + latency`, so the budget is measured against that. */
double sink_latency_ms(State& st) {
    if (!GST_IS_BASE_SINK(st.sink)) return 0.0;
    GstClockTime lat = gst_base_sink_get_latency(GST_BASE_SINK(st.sink));
    return GST_CLOCK_TIME_IS_VALID(lat) ? (double)lat / 1e6 : 0.0;
}

/** ms of stamp time parked in the queues UPSTREAM of `pad` right now. */
double upstream_queued_ms(GstPad* start) {
    guint64 total_ns = 0;
    GstPad* pad = GST_PAD(gst_object_ref(start));
    for (int hops = 0; pad && hops < 64; hops++) {
        GstPad* peer = gst_pad_get_peer(pad);
        gst_object_unref(pad);
        pad = nullptr;
        if (!peer) break;
        GstElement* el = gst_pad_get_parent_element(peer);
        gst_object_unref(peer);
        if (!el) break;
        std::string fname = factory_name(el);
        if (fname == "queue" || fname == "queue2") {
            guint64 level = 0;
            g_object_get(el, "current-level-time", &level, nullptr);
            if (level && level != GST_CLOCK_TIME_NONE) total_ns += level;
        }
        GST_OBJECT_LOCK(el);
        if (el->sinkpads) pad = GST_PAD(gst_object_ref(el->sinkpads->data));
        GST_OBJECT_UNLOCK(el);
        gst_object_unref(el);
    }
    if (pad) gst_object_unref(pad);
    return (double)total_ns / 1e6;
}

double stall_now_ms() { return (double)g_get_monotonic_time() / 1000.0; }

JsonObject* payload_base(State& st, const char* outcome, double budget) {
    JsonObject* o = json_object_new();
    json_object_set_string_member(o, "element", st.element.c_str());
    json_object_set_string_member(o, "outcome", outcome);
    json_object_set_double_member(o, "budgetMs", round1(budget));
    return o;
}

void emit_shed_event(JsonObject* payload) {
    JsonNode* n = json_node_new(JSON_NODE_OBJECT);
    json_node_take_object(n, payload);
    runner().emit_plugin_event("backlog_shed", n);
}

// --- post-shed stall watch -----------------------------------------------------

void stall_disarm(State& st) {
    std::lock_guard<std::mutex> lock(st.stall_m);
    st.stall_gen++;
    st.stall.disarm();
    if (st.stall_probe_id && st.out_pad) {
        gst_pad_remove_probe(st.out_pad, st.stall_probe_id);
        st.stall_probe_id = 0;
    }
}

GstPadProbeReturn on_output_cb(GstPad*, GstPadProbeInfo*, gpointer user) {
    std::shared_ptr<State> st = *static_cast<std::shared_ptr<State>*>(user);
    std::lock_guard<std::mutex> lock(st->stall_m);
    st->stall_probe_id = 0;
    st->stall_gen++;
    st->stall.disarm();
    return GST_PAD_PROBE_REMOVE;
}

void delete_state_holder(gpointer p) { delete static_cast<std::shared_ptr<State>*>(p); }

struct StallTimer {
    std::shared_ptr<State> st;
    int gen;
};

gboolean stall_timeout_cb(gpointer user) {
    std::unique_ptr<StallTimer> t(static_cast<StallTimer*>(user));
    std::shared_ptr<State> st = t->st;
    if (g_state != st || t->gen != st->stall_gen.load()) return G_SOURCE_REMOVE;
    const char* action;
    double remaining;
    bool armed;
    {
        std::lock_guard<std::mutex> lock(st->stall_m);
        action = st->stall.tick(stall_now_ms());
        armed = st->stall.armed();
        remaining = st->stall.remaining_ms(stall_now_ms());
    }
    if (action && std::string(action) == "flush") {
        log_line(*st, fmt("post-shed stall: no decoder output for %gs — flushing %s", st->stall.grace_ms / 1000.0,
                          st->element.c_str()));
        // A flush pair is the cheapest thing that clears a stateless decoder
        // holding a request for references the shed dropped; reset_time=FALSE
        // because the contract pins running time to the house clock.
        gst_pad_send_event(st->pad, gst_event_new_flush_start());
        gst_pad_send_event(st->pad, gst_event_new_flush_stop(FALSE));
        if (st->segment) gst_pad_send_event(st->pad, gst_event_new_segment(st->segment));
        // A flushed decoder needs a self-contained frame again.
        gate_kf::reclose(st->element);
    } else if (action && std::string(action) == "error") {
        log_line(*st, "post-shed stall: decoder produced no output after shed + flush — escalating to pipeline restart");
        stall_disarm(*st);
        GError* err = g_error_new_literal(GST_STREAM_ERROR, GST_STREAM_ERROR_DECODE,
                                          "post-shed stall: decoder produced no output after shed + flush — "
                                          "escalating to pipeline restart");
        gst_element_post_message(st->pipe, gst_message_new_error(GST_OBJECT(st->pipe), err,
                                                                 ("backlogShed " + st->element).c_str()));
        g_error_free(err);
        return G_SOURCE_REMOVE;
    }
    if (armed) g_timeout_add((guint)std::max(1.0, remaining), stall_timeout_cb, new StallTimer{st, t->gen});
    return G_SOURCE_REMOVE;
}

void stall_arm(const std::shared_ptr<State>& st) {
    int gen;
    double grace;
    {
        std::lock_guard<std::mutex> lock(st->stall_m);
        if (!st->out_pad || !st->stall.arm(stall_now_ms())) return;
        gen = ++st->stall_gen;
        if (!st->stall_probe_id)
            st->stall_probe_id = gst_pad_add_probe(st->out_pad, GST_PAD_PROBE_TYPE_BUFFER, on_output_cb,
                                                   new std::shared_ptr<State>(st), delete_state_holder);
        grace = st->stall.grace_ms;
    }
    g_timeout_add((guint)grace, stall_timeout_cb, new StallTimer{st, gen});
}

// --- the probe ----------------------------------------------------------------------

void finish_episode(const std::shared_ptr<State>& sp, double late_ms, double now_ms, const char* outcome) {
    State& st = *sp;
    st.shedding = false;
    st.sheds++;
    st.policy.shed_finished(now_ms);
    double budget = st.budget_ms;
    JsonObject* o = payload_base(st, outcome, budget);
    json_object_set_double_member(o, "retainedBeforeMs", round1(st.before_ms + budget));
    json_object_set_double_member(o, "retainedAfterMs", round1(late_ms + budget));
    json_object_set_double_member(o, "excessBeforeMs", round1(st.before_ms));
    json_object_set_double_member(o, "excessAfterMs", round1(late_ms));
    json_object_set_int_member(o, "droppedBuffers", st.dropped);
    json_object_set_double_member(o, "durationMs", round1(now_ms - st.shed_at));
    json_object_set_int_member(o, "shedCount", st.sheds);
    log_line(st, fmt("shed #%d: retained %.0f → %.0f ms (budget %.0f ms), %lld buffers dropped in %.0f ms", st.sheds,
                     st.before_ms + budget, late_ms + budget, budget, (long long)st.dropped, now_ms - st.shed_at));
    st.dropped = 0;
    st.shed_at = 0;
    st.has_caught_up_at = false;
    st.keyframe_warned = false;
    emit_shed_event(o);
    // The resume is not proof the decoder took it — watch its output.
    stall_arm(sp);
}

GstPadProbeReturn probe_cb(GstPad* pad, GstPadProbeInfo* info, gpointer user) {
    std::shared_ptr<State> sp = *static_cast<std::shared_ptr<State>*>(user);
    State& st = *sp;
    if (GST_PAD_PROBE_INFO_TYPE(info) & GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM) {
        GstEvent* ev = GST_PAD_PROBE_INFO_EVENT(info);
        if (ev && GST_EVENT_TYPE(ev) == GST_EVENT_SEGMENT) {
            const GstSegment* seg = nullptr;
            gst_event_parse_segment(ev, &seg);
            if (st.segment) gst_segment_free(st.segment);
            st.segment = seg ? gst_segment_copy(seg) : nullptr;
            // Either side of a new segment the running times are not comparable.
            st.policy.reset();
        }
        return GST_PAD_PROBE_OK;
    }
    GstBuffer* buf = GST_PAD_PROBE_INFO_BUFFER(info);
    if (!buf || !st.segment || !GST_CLOCK_TIME_IS_VALID(GST_BUFFER_PTS(buf))) return GST_PAD_PROBE_OK;
    if (!GST_IS_PIPELINE(st.pipe)) return GST_PAD_PROBE_OK;
    GstClock* clock = gst_pipeline_get_pipeline_clock(GST_PIPELINE(st.pipe));
    if (!clock) return GST_PAD_PROBE_OK;
    guint64 rt = gst_segment_to_running_time(st.segment, GST_FORMAT_TIME, GST_BUFFER_PTS(buf));
    if (rt == GST_CLOCK_TIME_NONE) {
        gst_object_unref(clock);
        return GST_PAD_PROBE_OK;   // outside the segment
    }
    int64_t now_rt = (int64_t)gst_clock_get_time(clock) - (int64_t)gst_element_get_base_time(st.pipe);
    gst_object_unref(clock);
    double budget_ms = ts_offset_ms(st) + sink_latency_ms(st);
    st.budget_ms = budget_ms;
    double late_ms = (double)(now_rt - (int64_t)rt) / 1e6 - budget_ms;
    double now_ms = (double)now_rt / 1e6;
    st.last_ms.store(late_ms);
    st.last_at.store(now_ms);
    st.has_last.store(true);
    // The FLOOR over the window is the retained part (a spike relaxes).
    if (!st.has_win_min.load() || late_ms < st.win_min.load()) st.win_min.store(late_ms);
    st.has_win_min.store(true);

    if (st.shedding) {
        bool at_budget = late_ms <= 0.0;
        bool keyframe_ok = !st.keyframe_aligned || !GST_BUFFER_FLAG_IS_SET(buf, GST_BUFFER_FLAG_DELTA_UNIT);
        if (at_budget && keyframe_ok) {
            finish_episode(sp, late_ms, now_ms, "recovered");
            return GST_PAD_PROBE_OK;   // the IRAP itself PASSES
        }
        if (at_budget) {
            if (!st.has_caught_up_at) {
                st.has_caught_up_at = true;
                st.caught_up_at = now_ms;
            } else if (!st.keyframe_warned && now_ms - st.caught_up_at > KEYFRAME_WARN_MS) {
                st.keyframe_warned = true;
                log_line(st, fmt("at budget for %.0f ms, still waiting for a keyframe — resuming mid-GOP would "
                                 "hand the decoder missing references, so the wait stands",
                                 KEYFRAME_WARN_MS));
                JsonObject* o = payload_base(st, "awaiting_keyframe", budget_ms);
                json_object_set_double_member(o, "retainedBeforeMs", round1(st.before_ms + budget_ms));
                json_object_set_double_member(o, "excessBeforeMs", round1(st.before_ms));
                json_object_set_int_member(o, "droppedBuffers", st.dropped);
                json_object_set_double_member(o, "durationMs", round1(now_ms - st.shed_at));
                json_object_set_int_member(o, "shedCount", st.sheds + 1);
                emit_shed_event(o);
            }
        }
        st.dropped++;
        return GST_PAD_PROBE_DROP;
    }

    const char* verdict = st.policy.observe(late_ms, now_ms, [pad] { return upstream_queued_ms(pad); });
    if (!verdict) return GST_PAD_PROBE_OK;
    std::string v = verdict;
    if (v == "timeline") {
        log_line(st, fmt("retained %.0f ms against a %.0f ms budget for %.0f ms, but the queues upstream are empty "
                         "— the timeline is late, not backlogged; nothing to shed (the producer's stamper owns this)",
                         late_ms + budget_ms, budget_ms, st.policy.hold_ms));
        JsonObject* o = payload_base(st, "timeline", budget_ms);
        json_object_set_double_member(o, "excessBeforeMs", round1(late_ms));
        emit_shed_event(o);
        return GST_PAD_PROBE_OK;
    }
    if (v == "implausible") {
        log_line(st, fmt("lateness %.0f ms is past the sanity ceiling — treating it as a timeline mismatch, NOT a "
                         "backlog (nothing shed)",
                         late_ms));
        JsonObject* o = payload_base(st, "implausible", budget_ms);
        json_object_set_double_member(o, "excessBeforeMs", round1(late_ms));
        emit_shed_event(o);
        return GST_PAD_PROBE_OK;
    }
    if (v != "shed") return GST_PAD_PROBE_OK;
    st.shedding = true;
    st.shed_at = now_ms;
    st.before_ms = late_ms;
    st.dropped = 1;
    log_line(st, fmt("retained %.0f ms against a %.0f ms budget for %.0f ms — dropping the oldest data%s",
                     late_ms + budget_ms, budget_ms, st.policy.hold_ms,
                     st.keyframe_aligned ? " up to the next keyframe" : ""));
    return GST_PAD_PROBE_DROP;
}

}  // namespace

bool start(GstElement* pipe, JsonObject* cfg) {
    stop();   // never inherit a previous pipeline's shedder
    if (!cfg) return true;
    std::string name = json_get_string(cfg, "element");
    GstElement* el = GST_IS_BIN(pipe) ? gst_bin_get_by_name(GST_BIN(pipe), name.c_str()) : nullptr;
    if (!el) {
        JsonObject* ev = ipc::event("error");
        json_object_set_string_member(ev, "message", ("backlogShed: element not found: '" + name + "'").c_str());
        ipc::emit(ev);
        return false;
    }
    GstPad* pad = gst_element_get_static_pad(el, "sink");
    if (!pad) {
        JsonObject* ev = ipc::event("error");
        json_object_set_string_member(ev, "message", ("backlogShed: no sink pad on: '" + name + "'").c_str());
        ipc::emit(ev);
        gst_object_unref(el);
        return false;
    }
    std::string sink_name = json_get_string(cfg, "sink");
    GstElement* sink = gst_bin_get_by_name(GST_BIN(pipe), sink_name.c_str());
    if (!sink) {
        JsonObject* ev = ipc::event("error");
        json_object_set_string_member(ev, "message", ("backlogShed: sink not found: '" + sink_name + "'").c_str());
        ipc::emit(ev);
        gst_object_unref(pad);
        gst_object_unref(el);
        return false;
    }
    auto st = std::make_shared<State>();
    st->pipe = pipe;
    st->pad = pad;
    st->element = name;
    st->sink = sink;
    st->policy = Policy{(double)json_get_int(cfg, "toleranceMs", 250), (double)json_get_int(cfg, "holdMs", 5000),
                        (double)json_get_int(cfg, "cooldownMs", 60000), (double)json_get_int(cfg, "sanityMs", 10000)};
    st->keyframe_aligned = json_get_bool(cfg, "keyframeAligned", true);
    st->stall.enabled = st->keyframe_aligned;   // audio legs are not watched
    st->out_pad = gst_element_get_static_pad(el, "src");
    gst_object_unref(el);
    g_state = st;
    st->probe_id = gst_pad_add_probe(pad, (GstPadProbeType)(GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM),
                                     probe_cb, new std::shared_ptr<State>(st), delete_state_holder);
    return true;
}

void window_into(double now_ms, JsonObject* into) {
    std::shared_ptr<State> st = g_state;
    if (!st || !st->has_last.load() || !st->has_win_min.load()) return;
    if (now_ms - st->last_at.load() > STALE_MS) return;
    double floor = st->win_min.load();
    st->has_win_min.store(false);
    json_object_set_double_member(into, "latenessMs", round1(floor));
    json_object_set_double_member(into, "retainedMs", round1(floor + st->budget_ms));
    json_object_set_double_member(into, "budgetMs", round1(st->budget_ms));
    json_object_set_boolean_member(into, "shedding", st->shedding);
    json_object_set_int_member(into, "shedCount", st->sheds);
}

void stop() {
    std::shared_ptr<State> st = g_state;
    g_state.reset();
    if (!st) return;
    // Any armed stall watch dies with the shedder.
    stall_disarm(*st);
    if (st->probe_id) gst_pad_remove_probe(st->pad, st->probe_id);
    st->probe_id = 0;
    if (st->segment) gst_segment_free(st->segment);
    st->segment = nullptr;
    if (st->out_pad) gst_object_unref(st->out_pad);
    st->out_pad = nullptr;
    gst_object_unref(st->pad);
    st->pad = nullptr;
    gst_object_unref(st->sink);
    st->sink = nullptr;
}

}  // namespace mr::shed
