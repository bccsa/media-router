// deinterlace_guard — drops the stale frames GStreamer's `deinterlace` re-sends
// after a discontinuity (#817), the native form of `py/deinterlace_guard.py`.
// That file's docstring is the specification: same config, rule and log line.
// Loaded by mr-gst-runner through mr_hook.h (ADR-0020).
#include <gst/gst.h>
#include <json-glib/json-glib.h>

#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <memory>
#include <mutex>
#include <string>

#include "mr_hook.h"

namespace {

constexpr GstClockTime DEFAULT_DURATION_NS = 20 * GST_MSECOND;

struct Guard {
    GstPad* pad = nullptr;   // owned ref: the deinterlacer's src pad
    gulong buffer_probe = 0;
    gulong event_probe = 0;
    std::string name;
    std::mutex m;            // the streaming thread vs flush events and clear()
    GstClockTime last = GST_CLOCK_TIME_NONE;
    guint64 dropped = 0;
    GstClockTime back = 0;
};

const MrHookCtx* g_ctx = nullptr;
std::shared_ptr<Guard> g_guard;

std::string fmt(const char* f, ...) __attribute__((format(printf, 1, 2)));
std::string fmt(const char* f, ...) {
    char buf[512];
    va_list ap;
    va_start(ap, f);
    std::vsnprintf(buf, sizeof buf, f, ap);
    va_end(ap);
    return buf;
}

std::string json_escape(const std::string& s) {
    std::string out;
    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) out += fmt("\\u%04x", c);
                else out += (char)c;
        }
    }
    return out;
}

void trace(const std::string& msg) {
    if (g_ctx && g_ctx->log) g_ctx->log(g_ctx->user, ("[deinterlace_guard] " + msg).c_str());
}

void warn(const std::string& message) {
    if (g_ctx && g_ctx->emit_event)
        g_ctx->emit_event(g_ctx->user,
                          ("{\"event\":\"warning\",\"message\":\"deinterlace guard: " + json_escape(message) + "\"}").c_str());
}

/** True when the frame at `pts` is a stale re-send to drop (python `decide`;
 *  GST_CLOCK_TIME_NONE is python's None). */
bool decide(GstClockTime last, GstClockTime pts, GstClockTime duration) {
    if (!GST_CLOCK_TIME_IS_VALID(last) || !GST_CLOCK_TIME_IS_VALID(pts)) return false;
    GstClockTime window = GST_CLOCK_TIME_IS_VALID(duration) && duration > 0 ? duration : DEFAULT_DURATION_NS;
    return pts <= last && last - pts <= window;
}

/** The drop report since the last frame let through, reset (python `_report`);
 *  empty when nothing was dropped. Caller holds `g.m` and logs it unlocked. */
std::string take_report(Guard& g) {
    if (!g.dropped) return "";
    std::string line = fmt("dropped %" G_GUINT64_FORMAT " stale frame(s) re-sent by %s (up to %.0f ms back)", g.dropped,
                           g.name.c_str(), (double)g.back / 1e6);
    g.dropped = 0;
    g.back = 0;
    return line;
}

GstPadProbeReturn on_buffer(GstPad*, GstPadProbeInfo* info, gpointer user) {
    Guard& g = **static_cast<std::shared_ptr<Guard>*>(user);
    GstBuffer* buf = GST_PAD_PROBE_INFO_BUFFER(info);
    if (!buf) return GST_PAD_PROBE_OK;
    GstClockTime pts = GST_BUFFER_PTS(buf);
    std::string line;
    {
        std::lock_guard<std::mutex> lock(g.m);
        if (decide(g.last, pts, GST_BUFFER_DURATION(buf))) {
            g.dropped++;
            g.back = std::max(g.back, g.last - pts);
            return GST_PAD_PROBE_DROP;
        }
        line = take_report(g);
        if (GST_CLOCK_TIME_IS_VALID(pts)) g.last = pts;
    }
    if (!line.empty()) trace(line);
    return GST_PAD_PROBE_OK;
}

GstPadProbeReturn on_event(GstPad*, GstPadProbeInfo* info, gpointer user) {
    Guard& g = **static_cast<std::shared_ptr<Guard>*>(user);
    GstEvent* ev = GST_PAD_PROBE_INFO_EVENT(info);
    if (!ev) return GST_PAD_PROBE_OK;
    GstEventType t = GST_EVENT_TYPE(ev);
    if (t != GST_EVENT_FLUSH_STOP && t != GST_EVENT_STREAM_START && t != GST_EVENT_SEGMENT && t != GST_EVENT_EOS)
        return GST_PAD_PROBE_OK;
    std::string line;
    {
        std::lock_guard<std::mutex> lock(g.m);
        line = take_report(g);
        if (t != GST_EVENT_EOS) g.last = GST_CLOCK_TIME_NONE;
    }
    if (!line.empty()) trace(line);
    return GST_PAD_PROBE_OK;
}

void drop_holder(gpointer p) { delete static_cast<std::shared_ptr<Guard>*>(p); }

/** `config.element` as a string, "" when absent or not a string. */
std::string element_name(const char* config_json) {
    std::string name;
    JsonParser* parser = json_parser_new();
    if (config_json && json_parser_load_from_data(parser, config_json, -1, nullptr)) {
        JsonNode* root = json_parser_get_root(parser);
        JsonObject* cfg = root && JSON_NODE_HOLDS_OBJECT(root) ? json_node_get_object(root) : nullptr;
        JsonNode* n = cfg && json_object_has_member(cfg, "element") ? json_object_get_member(cfg, "element") : nullptr;
        if (n && JSON_NODE_HOLDS_VALUE(n) && json_node_get_value_type(n) == G_TYPE_STRING) {
            const gchar* s = json_node_get_string(n);
            name = s ? s : "";
        }
    }
    g_object_unref(parser);
    return name;
}

}  // namespace

extern "C" {

int mr_hook_abi(void) { return MR_HOOK_ABI; }

int mr_hook_install(GstElement* pipeline, const char* config_json, const MrHookCtx* ctx) {
    mr_hook_clear();
    g_ctx = ctx;
    if (!pipeline || !GST_IS_BIN(pipeline)) return 1;
    std::string name = element_name(config_json);
    GstElement* el = name.empty() ? nullptr : gst_bin_get_by_name(GST_BIN(pipeline), name.c_str());
    GstPad* pad = el ? gst_element_get_static_pad(el, "src") : nullptr;
    if (el) gst_object_unref(el);
    if (!pad) {
        warn("element '" + name + "' not found — not installed");
        return 0;
    }
    auto g = std::make_shared<Guard>();
    g->pad = pad;
    g->name = name;
    g->buffer_probe = gst_pad_add_probe(pad, GST_PAD_PROBE_TYPE_BUFFER, on_buffer, new std::shared_ptr<Guard>(g), drop_holder);
    // Flush events reach a probe only with EVENT_FLUSH in its mask.
    g->event_probe = gst_pad_add_probe(pad, (GstPadProbeType)(GST_PAD_PROBE_TYPE_EVENT_DOWNSTREAM | GST_PAD_PROBE_TYPE_EVENT_FLUSH),
                                       on_event, new std::shared_ptr<Guard>(g), drop_holder);
    g_guard = g;
    return 0;
}

void mr_hook_clear(void) {
    if (!g_guard) return;
    std::shared_ptr<Guard> g = std::move(g_guard);
    std::string line;
    {
        std::lock_guard<std::mutex> lock(g->m);
        line = take_report(*g);
    }
    if (!line.empty()) trace(line);
    if (g->buffer_probe) gst_pad_remove_probe(g->pad, g->buffer_probe);
    if (g->event_probe) gst_pad_remove_probe(g->pad, g->event_probe);
    gst_object_unref(g->pad);
    g->pad = nullptr;
}

}  // extern "C"
