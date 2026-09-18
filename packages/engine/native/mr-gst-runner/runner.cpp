#include "runner.h"

#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <memory>
#include <thread>

#include "backlog_shed.h"
#include "branch_align.h"
#include "bus_edges.h"
#include "gates.h"
#include "hooks.h"
#include "pad_link.h"
#include "ipc.h"
#include "json_util.h"
#include "source_gate.h"
#include "stamper.h"

namespace mr {

Runner& runner() {
    static Runner r;
    return r;
}

std::string factory_name(GstElement* el) {
    if (!el) return "";
    GstElementFactory* f = gst_element_get_factory(el);
    if (!f) return "";
    const gchar* n = gst_plugin_feature_get_name(GST_PLUGIN_FEATURE(f));
    return n ? n : "";
}

namespace {

const char* state_nick(GstState s) {
    switch (s) {
        case GST_STATE_VOID_PENDING: return "void-pending";
        case GST_STATE_NULL: return "null";
        case GST_STATE_READY: return "ready";
        case GST_STATE_PAUSED: return "paused";
        case GST_STATE_PLAYING: return "playing";
    }
    return "unknown";
}

/** The start-payload fields this runner does not implement (see runner.h). */
const char* unsupported_field(JsonObject* data) {
    static const char* const fields[] = {"rist", "preserveSourceTimeline", nullptr};
    for (int i = 0; fields[i]; i++)
        if (json_has(data, fields[i]) && json_get_object(data, fields[i]) != nullptr) return fields[i];
    if (json_get_bool(data, "readKlvNames")) return "readKlvNames";
    if (json_get_bool(data, "useStdioForData")) return "useStdioForData";
    if (!json_get_bool(data, "timeSyncContract") && json_get_object(data, "clock")) return "clock";
    return nullptr;
}

int db_to_blocks(double db) {
    double clamped = std::max(-60.0, std::min(0.0, db));
    // python round() is banker's rounding; the values here are k/4 steps, so
    // ties happen — match it with rint (round-half-even).
    return (int)std::rint(0.25 * (60.0 + clamped));
}

gboolean on_bus_message_cb(GstBus*, GstMessage* msg, gpointer) {
    runner().on_bus_message(msg);
    return TRUE;
}

gboolean playing_timeout_cb(gpointer) {
    Runner& r = runner();
    r.playing_watchdog_id = 0;
    if (r.pipeline) {
        GstState state = GST_STATE_NULL, pending = GST_STATE_VOID_PENDING;
        gst_element_get_state(r.pipeline, &state, &pending, 0);
        if (state == GST_STATE_PLAYING) return G_SOURCE_REMOVE;
    }
    JsonObject* ev = ipc::event("error");
    json_object_set_string_member(ev, "kind", "playing_timeout");
    char buf[128];
    std::snprintf(buf, sizeof buf, "pipeline did not reach PLAYING within %d ms", PLAYING_WATCHDOG_MS);
    json_object_set_string_member(ev, "message", buf);
    r.fail_pipeline(ev);
    return G_SOURCE_REMOVE;
}

}  // namespace

// ---------------------------------------------------------------------------
// Watchdog / teardown
// ---------------------------------------------------------------------------

void Runner::cancel_playing_watchdog() {
    if (playing_watchdog_id) {
        g_source_remove(playing_watchdog_id);
        playing_watchdog_id = 0;
    }
}

void Runner::arm_playing_watchdog(int timeout_ms) {
    cancel_playing_watchdog();
    if (timeout_ms > 0) playing_watchdog_id = g_timeout_add(timeout_ms, playing_timeout_cb, nullptr);
}

double Runner::now_running_ms() {
    if (!pipeline || !GST_IS_PIPELINE(pipeline)) return 0.0;
    GstClock* clock = gst_pipeline_get_pipeline_clock(GST_PIPELINE(pipeline));
    if (!clock) return 0.0;
    double ms = (double)(gst_clock_get_time(clock) - gst_element_get_base_time(pipeline)) / 1e6;
    gst_object_unref(clock);
    return ms;
}

/** Push EOS straight into the gated decoder when the whole-pipeline drain
 *  can't (see `_drain_decoder_branch`): sent from a worker with a bounded
 *  wait, because a wedged decoder is the one case that would block the main
 *  loop past the parent's force-kill window. True when the decoder took it. */
bool Runner::drain_decoder_branch(gint64 deadline_us) {
    std::string name;
    GstPad* pad = gate_kf::decoder_pad(&name);
    if (!pad) return false;   // no gated decoder = nothing addressable to drain
    gst_object_ref(pad);
    auto done = std::make_shared<std::atomic<bool>>(false);
    std::thread([pad, done] {
        gst_pad_send_event(pad, gst_event_new_eos());
        done->store(true);
        gst_object_unref(pad);
    }).detach();
    while (!done->load() && g_get_monotonic_time() < deadline_us) g_usleep(5000);
    if (!done->load()) {
        char buf[200];
        std::snprintf(buf, sizeof buf, "EOS drain: %s did not accept EOS within %d ms — forcing NULL (decoder may be mid-frame)",
                      name.c_str(), EOS_DRAIN_TIMEOUT_MS);
        ipc::warning(buf);
        return false;
    }
    return true;
}

bool Runner::eos_drain(GstElement* pipe, bool errored) {
    GstState state = GST_STATE_NULL, pending = GST_STATE_VOID_PENDING;
    gst_element_get_state(pipe, &state, &pending, 0);
    if (state != GST_STATE_PLAYING && pending != GST_STATE_PLAYING) return true;

    gint64 deadline_us = g_get_monotonic_time() + (gint64)EOS_DRAIN_TIMEOUT_MS * 1000;
    // An errored pipeline cannot carry a pipeline-level EOS (its source task
    // is already stopped): push EOS straight into the gated decoder instead.
    if (errored || !gst_element_send_event(pipe, gst_event_new_eos())) return drain_decoder_branch(deadline_us);

    GstBus* bus = gst_element_get_bus(pipe);
    gint64 left_us = std::max<gint64>(0, deadline_us - g_get_monotonic_time());
    GstMessage* msg = gst_bus_timed_pop_filtered(
        bus, (GstClockTime)left_us * 1000,
        (GstMessageType)(GST_MESSAGE_EOS | GST_MESSAGE_ERROR));
    gst_object_unref(bus);
    if (!msg) {
        char buf[160];
        std::snprintf(buf, sizeof buf,
                      "EOS drain timed out after %d ms — forcing NULL (decoder may be mid-frame)",
                      EOS_DRAIN_TIMEOUT_MS);
        ipc::warning(buf);
        return false;
    }
    bool drained = GST_MESSAGE_TYPE(msg) == GST_MESSAGE_EOS;
    gst_message_unref(msg);
    // ERROR ends the wait too — that pipeline will never reach EOS.
    return drained ? true : drain_decoder_branch(deadline_us);
}

void Runner::teardown_pipeline(GstElement* pipe, bool drain, bool errored) {
    if (!pipe) return;
    gate::stop();
    if (drain) eos_drain(pipe, errored);
    gst_element_set_state(pipe, GST_STATE_NULL);
}

void Runner::fail_pipeline(JsonObject* event, bool drain, bool errored) {
    ipc::emit(event);
    teardown_pipeline(pipeline, drain, errored);
    if (loop && g_main_loop_is_running(loop)) g_main_loop_quit(loop);
}

void Runner::emit_plugin_event(const std::string& channel, JsonNode* payload) {
    JsonObject* o = ipc::event("plugin_event");
    json_object_set_string_member(o, "channel", channel.c_str());
    json_object_set_member(o, "payload", payload);
    ipc::emit(o);
}

// ---------------------------------------------------------------------------
// Clock (time-sync contract)
// ---------------------------------------------------------------------------

void Runner::apply_contract_clock(GstElement* pipe, bool live_capture_clock) {
    if (!GST_IS_PIPELINE(pipe)) return;
    GstClock* clock = gst_system_clock_obtain();
    g_object_set(clock, "clock-type", GST_CLOCK_TYPE_MONOTONIC, nullptr);
    gst_pipeline_use_clock(GST_PIPELINE(pipe), clock);
    gst_object_unref(clock);
    if (live_capture_clock) return;
    gst_element_set_start_time(pipe, GST_CLOCK_TIME_NONE);
    gst_element_set_base_time(pipe, 0);
}

// ---------------------------------------------------------------------------
// Decoder threading (avdec_* max-threads / thread-type)
// ---------------------------------------------------------------------------

void Runner::set_decoder_threads(GstElement* el) {
    std::string name = factory_name(el);
    if (name.rfind("avdec_", 0) != 0) return;
    GObjectClass* klass = G_OBJECT_GET_CLASS(el);
    if (!g_object_class_find_property(klass, "max-threads")) return;
    gint current = 0;
    g_object_get(el, "max-threads", &current, nullptr);
    if (current != 0) {
        ipc::logf("decoder threads: %s configured in pipeline — left as-is", name.c_str());
        return;
    }
    g_object_set(el, "max-threads", decoder_max_threads, nullptr);
    const char* applied = "auto";
    if (decoder_thread_type == "frame" && g_object_class_find_property(klass, "thread-type")) {
        g_object_set(el, "thread-type", 1 /* frame */, nullptr);
        applied = "frame";
    }
    ipc::logf("decoder threads: %s max-threads=%d thread-type=%s", name.c_str(), decoder_max_threads, applied);
}

namespace {
void visit_decoders(Runner& r, GstBin* bin) {
    GstIterator* it = gst_bin_iterate_elements(bin);
    GValue item = G_VALUE_INIT;
    bool done = false;
    while (!done) {
        switch (gst_iterator_next(it, &item)) {
            case GST_ITERATOR_OK: {
                GstElement* el = GST_ELEMENT(g_value_get_object(&item));
                r.set_decoder_threads(el);
                if (GST_IS_BIN(el)) visit_decoders(r, GST_BIN(el));
                g_value_reset(&item);
                break;
            }
            case GST_ITERATOR_RESYNC: gst_iterator_resync(it); break;
            default: done = true; break;
        }
    }
    g_value_unset(&item);
    gst_iterator_free(it);
}

void deep_element_added_cb(GstBin*, GstBin*, GstElement* el, gpointer) {
    runner().set_decoder_threads(el);
}
}  // namespace

void Runner::install_decoder_thread_hook(GstElement* pipe) {
    if (GST_IS_BIN(pipe)) visit_decoders(*this, GST_BIN(pipe));
    g_signal_connect(pipe, "deep-element-added", G_CALLBACK(deep_element_added_cb), nullptr);
    ipc::logf("decoder-threads hook installed (cpu=%d thread-type=%s)", decoder_max_threads,
              decoder_thread_type.c_str());
}

// ---------------------------------------------------------------------------
// start / stop
// ---------------------------------------------------------------------------

void Runner::handle_start(JsonObject* data) {
    std::string pipeline_str = json_get_string(data, "pipeline");
    decoder_thread_type = json_get_string(data, "decoderThreadType", "auto");

    if (pipeline_str.empty()) {
        JsonObject* ev = ipc::event("error");
        json_object_set_string_member(ev, "message", "No pipeline string provided");
        ipc::emit(ev);
        return;
    }
    if (const char* field = unsupported_field(data)) {
        JsonObject* ev = ipc::event("error");
        json_object_set_string_member(ev, "kind", "unsupported");
        std::string msg = std::string("native runner does not implement `") + field +
                          "` — the engine must host this pipeline on the python runner";
        json_object_set_string_member(ev, "message", msg.c_str());
        ipc::emit(ev);
        return;
    }
    // Native RIST elements live in a plugin loaded by path (never
    // GST_PLUGIN_PATH) — registered before the parse sees their names.
    if (pipeline_str.find("mrristsink") != std::string::npos || pipeline_str.find("mrristsrc") != std::string::npos)
        rist::load_plugin();

    GError* err = nullptr;
    GstElement* pipe = gst_parse_launch(pipeline_str.c_str(), &err);
    // PyGObject raises on ANY set error, recoverable or not (a partially built
    // pipeline with an unknown element is still a parse error to the engine).
    if (!pipe || err) {
        JsonObject* ev = ipc::event("error");
        std::string msg = std::string("Pipeline parse error: ") + (err && err->message ? err->message : "unknown");
        json_object_set_string_member(ev, "message", msg.c_str());
        ipc::emit(ev);
        g_clear_error(&err);
        if (pipe) gst_object_unref(pipe);
        return;
    }
    pipeline = pipe;

    bool contract = json_get_bool(data, "timeSyncContract");
    if (contract) apply_contract_clock(pipeline, json_get_bool(data, "liveCaptureClock"));

    // Dynamic-pad-link rules (+ stream discovery on their demuxers).
    padlink::install(pipeline, json_get_array(data, "linkOnPadAdded"));

    // Multi-branch stamp alignment (contract-only): armed before PLAYING so
    // the first TS bytes carry the mapping every branch is anchored to.
    align::install(pipeline, json_get_object(data, "alignBranchesToStamps"));
    stall::start(pipeline, json_get_array(data, "inputStallWatch"));

    // The producer half of the time-sync contract — recorded before PLAYING so
    // an attach landing the moment the pipeline starts owns its first buffer.
    JsonNode* repair = json_has(data, "latchRepair") ? json_object_get_member(data, "latchRepair") : nullptr;
    stamper::enable(pipeline, contract, repair, json_get_int(data, "conditionStepMs", 0));

    // Plugin-owned runner hooks in their native form (mr_hook.h, ADR-0020),
    // handed the pipeline before PLAYING like the python runner imports theirs.
    if (!hooks::install(pipeline, json_get_array(data, "runnerHooks"))) {
        teardown_pipeline(pipeline, /*drain=*/false);
        pipeline = nullptr;
        return;
    }

    install_decoder_thread_hook(pipeline);

    bus_reports.clear();
    if (JsonArray* reports = json_get_array(data, "busReports")) {
        guint n = json_array_get_length(reports);
        for (guint i = 0; i < n; i++) {
            JsonObject* r = json_array_get_object_element(reports, i);
            std::string el = json_get_string(r, "element"), st = json_get_string(r, "structure");
            if (!el.empty() && !st.empty()) bus_reports.insert({el, st});
        }
    }

    // Report-only TS video-info probe and render keep-up watch, then the
    // keyframe gate (NOT report-only — it drops, and must be armed before
    // PLAYING) and the backlog shedder AFTER the gate on purpose: both probes
    // sit on the decoder's sink pad and a shut gate must win.
    if (!tsprobe::start(pipeline, json_get_object(data, "tsProbe")) ||
        !render::start(pipeline, json_get_object(data, "renderWatch")) ||
        !gate_kf::start(pipeline, json_get_object(data, "keyframeGate")) ||
        !shed::start(pipeline, json_get_object(data, "backlogShed"))) {
        teardown_pipeline(pipeline);
        pipeline = nullptr;
        return;
    }

    GstBus* bus = gst_element_get_bus(pipeline);
    gst_bus_add_signal_watch(bus);
    g_signal_connect(bus, "message", G_CALLBACK(on_bus_message_cb), nullptr);
    gst_object_unref(bus);

    GstStateChangeReturn ret = gst_element_set_state(pipeline, GST_STATE_PLAYING);
    if (ret == GST_STATE_CHANGE_FAILURE) {
        JsonObject* ev = ipc::event("error");
        json_object_set_string_member(ev, "message", "Failed to set pipeline to PLAYING");
        ipc::emit(ev);
        teardown_pipeline(pipeline, /*drain=*/false);
        return;
    }

    cancel_playing_watchdog();
    playing_timeout_ms = json_has(data, "playingTimeoutMs") ? (int)json_get_int(data, "playingTimeoutMs")
                                                             : PLAYING_WATCHDOG_MS;
    bool deferred = gate::start(pipeline, ret == GST_STATE_CHANGE_ASYNC, playing_timeout_ms,
                                json_get_int(data, "udpSilenceRestartMs", 0));
    if (playing_timeout_ms > 0 && !deferred) arm_playing_watchdog(playing_timeout_ms);

    running = true;
    ipc::emit(ipc::event("started"));
}

void Runner::handle_stop() {
    if (stopping) return;
    stopping = true;
    cancel_playing_watchdog();
    gate::stop();
    bus::clear_pending();
    align::clear();
    stamper::clear();
    hooks::clear();
    padlink::clear();
    tsprobe::stop();
    render::stop();
    stall::stop();
    if (pipeline) {
        teardown_pipeline(pipeline);
        running = false;
        JsonObject* ev = ipc::event("state_change");
        json_object_set_string_member(ev, "state", "null");
        ipc::emit(ev);
    }
    // AFTER the teardown: the drain reaches the decoder through the gate's
    // pad when the pipeline-level EOS can't travel, and the gate is harmless
    // during a drain (it only ever touches buffers); the shedder's probe can
    // only ever drop a buffer the drain does not need.
    gate_kf::stop();
    shed::stop();
    if (loop && g_main_loop_is_running(loop)) g_main_loop_quit(loop);
}

// ---------------------------------------------------------------------------
// Bus messages
// ---------------------------------------------------------------------------

void Runner::handle_level_message(const GstStructure* s) {
    const GValue* v = gst_structure_get_value(s, "decay");
    if (!v) v = gst_structure_get_value(s, "peak");
    if (!v) return;
    std::vector<double> vals = gvalue_to_doubles(v);
    if (vals.empty()) return;
    std::vector<int> blocks;
    blocks.reserve(vals.size());
    for (double d : vals) blocks.push_back(db_to_blocks(d));

    gint64 now_ms = g_get_monotonic_time() / 1000;
    if (blocks == last_vu && (now_ms - last_vu_ms) < VU_HEARTBEAT_MS) return;
    last_vu = blocks;
    last_vu_ms = now_ms;

    JsonObject* ev = ipc::event("vu_data");
    JsonArray* arr = json_array_new();
    for (int b : blocks) json_array_add_int_element(arr, b);
    json_object_set_array_member(ev, "peak", arr);
    ipc::emit(ev);
}

void Runner::on_bus_message(GstMessage* msg) {
    GstObject* src = GST_MESSAGE_SRC(msg);
    switch (GST_MESSAGE_TYPE(msg)) {
        case GST_MESSAGE_ERROR: {
            GError* err = nullptr;
            gchar* debug = nullptr;
            gst_message_parse_error(msg, &err, &debug);
            std::string element = src && GST_OBJECT_NAME(src) ? GST_OBJECT_NAME(src) : "";
            std::string message = err && err->message ? err->message : "";
            // CONTAINMENT: an error inside a per-consumer fan-out branch must
            // never kill the producer — detach that edge and keep running.
            if (GstObject* edge = bus::busedge_ancestor(src)) {
                std::string edge_socket = bus::socket_for_busedge(edge);
                gst_object_unref(edge);
                if (!edge_socket.empty()) bus::teardown_branch(edge_socket);
                ipc::warning("bus edge failed (" + element + "): " + message +
                             " — branch detached, producer unaffected");
                g_clear_error(&err);
                g_free(debug);
                return;
            }
            JsonObject* ev = ipc::event("error");
            if (element.rfind("buswd", 0) == 0) json_object_set_string_member(ev, "kind", "bus_stall");
            json_object_set_string_member(ev, "message", message.c_str());
            json_object_set_string_member(ev, "debug", debug ? debug : "");
            json_object_set_string_member(ev, "element", element.c_str());
            g_clear_error(&err);
            g_free(debug);
            stall::stop();
            fail_pipeline(ev, /*drain=*/true, /*errored=*/true);
            break;
        }
        case GST_MESSAGE_EOS:
            stall::stop();
            // EOS reached the sinks — already drained; a second EOS would only
            // stall the teardown.
            fail_pipeline(ipc::event("eos"), /*drain=*/false);
            break;
        case GST_MESSAGE_STATE_CHANGED: {
            if (src != GST_OBJECT(pipeline)) break;
            GstState old_s, new_s, pending;
            gst_message_parse_state_changed(msg, &old_s, &new_s, &pending);
            if (new_s == GST_STATE_PLAYING) {
                cancel_playing_watchdog();
                gate::on_playing();
                stall::arm();
            }
            JsonObject* ev = ipc::event("state_change");
            json_object_set_string_member(ev, "state", state_nick(new_s));
            ipc::emit(ev);
            break;
        }
        case GST_MESSAGE_ELEMENT: {
            const GstStructure* s = gst_message_get_structure(msg);
            const gchar* name = s ? gst_structure_get_name(s) : nullptr;
            const gchar* src_name = src ? GST_OBJECT_NAME(src) : nullptr;
            if (!name) break;
            if (stamper::is_stamper_message(name)) {
                stamper::handle_message(src_name, name, s);
            } else if (src_name && bus_reports.count({src_name, name})) {
                emit_plugin_event(std::string(name) + ":" + src_name, gst_structure_to_json(s));
            } else if (std::strcmp(name, "level") == 0) {
                handle_level_message(s);
            } else if (std::strcmp(name, "GstUDPSrcTimeout") == 0) {
                gate::on_udp_timeout(src_name ? src_name : "udpsrc");
            }
            break;
        }
        default: break;
    }
}

}  // namespace mr
