// Command dispatch and the element-level RPCs: set/get property, element
// stats, throughput tracking. Lifecycle commands live in runner.cpp, the bus
// fan-out commands in bus_edges.cpp.
#include <cmath>
#include <thread>

#include "bus_edges.h"
#include "ipc.h"
#include "json_util.h"
#include "runner.h"
#include "stamper.h"

namespace mr {

namespace {

/** `pipeline.get_by_name`, or a `command_error` naming the element. Owned ref. */
GstElement* element_or_error(Runner& r, JsonObject* data, const std::string& req_id, std::string* name_out) {
    std::string name = json_get_string(data, "element");
    if (name_out) *name_out = name;
    if (!r.pipeline) {
        ipc::command_error(req_id, "No pipeline running");
        return nullptr;
    }
    GstElement* el = GST_IS_BIN(r.pipeline) ? gst_bin_get_by_name(GST_BIN(r.pipeline), name.c_str()) : nullptr;
    if (!el) ipc::command_error(req_id, "Element not found: " + name);
    return el;
}

GstPadProbeReturn throughput_probe_cb(GstPad*, GstPadProbeInfo* info, gpointer user) {
    auto* tracker = static_cast<ThroughputTracker*>(user);
    // Branch on the probe TYPE: the INFO_BUFFER / INFO_BUFFER_LIST macros are
    // plain casts of the same pointer (a list read as a buffer is garbage —
    // mpegtsmux emits lists, and this counted 0 for them).
    gsize size = 0;
    if (GST_PAD_PROBE_INFO_TYPE(info) & GST_PAD_PROBE_TYPE_BUFFER_LIST) {
        GstBufferList* list = GST_PAD_PROBE_INFO_BUFFER_LIST(info);
        guint n = list ? gst_buffer_list_length(list) : 0;
        for (guint i = 0; i < n; i++) size += gst_buffer_get_size(gst_buffer_list_get(list, i));
    } else if (GstBuffer* buf = GST_PAD_PROBE_INFO_BUFFER(info)) {
        size = gst_buffer_get_size(buf);
    }
    if (size) tracker->bytes.fetch_add((gint64)size, std::memory_order_relaxed);
    return GST_PAD_PROBE_OK;
}

}  // namespace

void Runner::dispatch(JsonObject* data) {
    std::string cmd = json_get_string(data, "cmd");
    if (cmd == "start") handle_start(data);
    else if (cmd == "stop") handle_stop();
    else if (cmd == "set_property") handle_set_property(data);
    else if (cmd == "get_property") handle_get_property(data);
    else if (cmd == "get_stats") handle_get_stats(data);
    else if (cmd == "track_throughput") handle_track_throughput(data);
    else if (cmd == "get_throughput") handle_get_throughput(data);
    else if (cmd == "bus_attach") bus::handle_bus_attach(data);
    else if (cmd == "bus_detach") bus::handle_bus_detach(data);
    else if (cmd == "bus_reinput") bus::handle_bus_reinput(data);
    else if (cmd == "set_klv_payload")
        ipc::command_error(json_get_string(data, "id"), "set_klv_payload: not supported by the native runner");
    else ipc::command_error(json_get_string(data, "id"), "Unknown command: " + cmd);
}

void Runner::handle_set_property(JsonObject* data) {
    std::string req_id = json_get_string(data, "id");
    std::string name;
    GstElement* el = element_or_error(*this, data, req_id, &name);
    if (!el) return;
    std::string prop = json_get_string(data, "property");
    JsonNode* value = json_has(data, "value") ? json_object_get_member(data, "value") : nullptr;

    GParamSpec* ps = g_object_class_find_property(G_OBJECT_GET_CLASS(el), prop.c_str());
    if (!ps) {
        ipc::command_error(req_id, "set_property failed: " + name + " has no property '" + prop + "'");
        gst_object_unref(el);
        return;
    }
    GValue gv = G_VALUE_INIT;
    g_value_init(&gv, ps->value_type);
    bool ok = value && json_to_gvalue(value, &gv);
    if (!ok && value) {
        // Enums by nick, fractions, caps, … — whatever gst can read from text.
        std::string text = json_node_to_gst_arg(value);
        ok = gst_value_deserialize(&gv, text.c_str());
    }
    if (!ok) {
        ipc::command_error(req_id, "set_property failed: cannot convert value for " + name + "." + prop);
        g_value_unset(&gv);
        gst_object_unref(el);
        return;
    }
    g_object_set_property(G_OBJECT(el), prop.c_str(), &gv);
    g_value_unset(&gv);
    gst_object_unref(el);

    JsonObject* ev = ipc::event("property_set");
    json_object_set_string_member(ev, "element", name.c_str());
    json_object_set_string_member(ev, "property", prop.c_str());
    json_object_set_member(ev, "value", value ? json_node_copy(value) : json_node_new(JSON_NODE_NULL));
    if (!req_id.empty()) json_object_set_string_member(ev, "id", req_id.c_str());
    ipc::emit(ev);
}

void Runner::handle_get_property(JsonObject* data) {
    std::string req_id = json_get_string(data, "id");
    std::string name;
    GstElement* el = element_or_error(*this, data, req_id, &name);
    if (!el) return;
    std::string prop = json_get_string(data, "property");
    GParamSpec* ps = g_object_class_find_property(G_OBJECT_GET_CLASS(el), prop.c_str());
    if (!ps) {
        ipc::command_error(req_id, "get_property failed: " + name + " has no property '" + prop + "'");
        gst_object_unref(el);
        return;
    }
    GValue gv = G_VALUE_INIT;
    g_value_init(&gv, ps->value_type);
    g_object_get_property(G_OBJECT(el), prop.c_str(), &gv);
    JsonObject* ev = ipc::event("property");
    json_object_set_string_member(ev, "element", name.c_str());
    json_object_set_string_member(ev, "property", prop.c_str());
    json_object_set_member(ev, "value", gvalue_to_json(&gv));
    if (!req_id.empty()) json_object_set_string_member(ev, "id", req_id.c_str());
    g_value_unset(&gv);
    gst_object_unref(el);
    ipc::emit(ev);
}

void Runner::handle_get_stats(JsonObject* data) {
    std::string req_id = json_get_string(data, "id");
    std::string name;
    GstElement* el = element_or_error(*this, data, req_id, &name);
    if (!el) return;
    {
        std::lock_guard<std::mutex> lock(stats_lock);
        if (stats_in_flight.count(name)) {
            ipc::command_error(req_id, "stats read for " + name + " still in progress (element busy)");
            gst_object_unref(el);
            return;
        }
        stats_in_flight.insert(name);
    }
    // srtsrc blocks its 'stats' getter while (re)connecting; a blocked read on
    // the main context would freeze every other command — read on a worker.
    std::thread([this, el, name, req_id] {
        GParamSpec* ps = g_object_class_find_property(G_OBJECT_GET_CLASS(el), "stats");
        if (!ps) {
            ipc::command_error(req_id, "get_stats failed: " + name + " has no 'stats' property");
        } else {
            GValue gv = G_VALUE_INIT;
            g_value_init(&gv, ps->value_type);
            g_object_get_property(G_OBJECT(el), "stats", &gv);
            JsonObject* ev = ipc::event("stats");
            json_object_set_string_member(ev, "element", name.c_str());
            if (GST_VALUE_HOLDS_STRUCTURE(&gv)) {
                json_object_set_member(ev, "data", gst_structure_to_json(gst_value_get_structure(&gv)));
            } else {
                JsonNode* empty = json_node_new(JSON_NODE_OBJECT);
                json_node_take_object(empty, json_object_new());
                json_object_set_member(ev, "data", empty);
            }
            if (!req_id.empty()) json_object_set_string_member(ev, "id", req_id.c_str());
            g_value_unset(&gv);
            ipc::emit(ev);
        }
        gst_object_unref(el);
        std::lock_guard<std::mutex> lock(stats_lock);
        stats_in_flight.erase(name);
    }).detach();
}

void Runner::handle_track_throughput(JsonObject* data) {
    std::string req_id = json_get_string(data, "id");
    std::string name;
    GstElement* el = element_or_error(*this, data, req_id, &name);
    if (!el) return;
    std::string pad_name = json_get_string(data, "pad", "src");
    GstPad* pad = gst_element_get_static_pad(el, pad_name.c_str());
    if (!pad) {
        ipc::command_error(req_id, "Pad not found: " + name + "." + pad_name);
        gst_object_unref(el);
        return;
    }
    {
        std::lock_guard<std::mutex> lock(throughput_lock);
        if (!trackers.count(name)) {
            auto* t = new ThroughputTracker();
            t->last_time_us = g_get_monotonic_time();
            // A `busout_*` tee under the contract has a native `mrtsstamp`
            // spliced in front of it that counts every byte in C — read that
            // instead of running a per-buffer probe on the streaming thread.
            GstElement* native = pad_name == "sink" ? stamper::element_for(name) : nullptr;
            if (native) t->native = GST_ELEMENT(gst_object_ref(native));
            else gst_pad_add_probe(pad, (GstPadProbeType)(GST_PAD_PROBE_TYPE_BUFFER | GST_PAD_PROBE_TYPE_BUFFER_LIST),
                                   throughput_probe_cb, t, nullptr);
            trackers[name] = t;
        }
    }
    gst_object_unref(pad);
    gst_object_unref(el);
    // Always ack — a second call for a tracked element is a no-op but the
    // parent's pending RPC still needs to resolve.
    JsonObject* ev = ipc::event("tracking");
    json_object_set_string_member(ev, "element", name.c_str());
    json_object_set_string_member(ev, "pad", pad_name.c_str());
    if (!req_id.empty()) json_object_set_string_member(ev, "id", req_id.c_str());
    ipc::emit(ev);
}

void Runner::handle_get_throughput(JsonObject* data) {
    std::string req_id = json_get_string(data, "id");
    JsonObject* result = json_object_new();
    {
        std::lock_guard<std::mutex> lock(throughput_lock);
        gint64 now_us = g_get_monotonic_time();
        for (auto& [name, t] : trackers) {
            if (t->native) t->bytes.store(stamper::bytes_total(t->native), std::memory_order_relaxed);
            gint64 bytes = t->bytes.load(std::memory_order_relaxed);
            double elapsed = (double)(now_us - t->last_time_us) / 1e6;
            if (elapsed > 0) {
                t->bps = (double)(bytes - t->last_bytes) * 8.0 / elapsed;
                t->last_bytes = bytes;
                t->last_time_us = now_us;
            }
            JsonObject* entry = json_object_new();
            json_object_set_int_member(entry, "total_bytes", bytes);
            json_object_set_double_member(entry, "bitrate_kbps", std::round(t->bps / 1000.0 * 10.0) / 10.0);
            json_object_set_double_member(entry, "bitrate_mbps", std::round(t->bps / 1000.0) / 1000.0);
            json_object_set_object_member(result, name.c_str(), entry);
        }
    }
    JsonObject* ev = ipc::event("throughput");
    json_object_set_object_member(ev, "data", result);
    if (!req_id.empty()) json_object_set_string_member(ev, "id", req_id.c_str());
    ipc::emit(ev);
}

}  // namespace mr
