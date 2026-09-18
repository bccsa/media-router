// subtitle_bridge — the runner-side half of the subtitle-core cue carrier, the
// native form of `py/subtitle_bridge.py` (that file's docstring is the
// specification; its GStreamer-free suite pins the pure logic mirrored in
// `clean_text` / `make_cue` / `relative_cue` / `absolute_cue` / `frame_time` /
// `decide` below). Loaded by mr-gst-runner through mr_hook.h (ADR-0020).
#include <gst/gst.h>
#include <json-glib/json-glib.h>

#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "mr_hook.h"
#include "subtitle_klv.h"

namespace {

constexpr int RESEND_MS = 2000;
constexpr double FRAME_TIME_TOLERANCE_MS = 10000.0;
constexpr const char* CUE_EVENT_CHANNEL = "subtitle:cue";

struct Cue {
    bool present = false;
    double start = 0, end = 0;
    std::string text;
};

struct PayEntry {
    GstElement* pipe = nullptr;
    GstElement* src = nullptr;     // owned ref (appsrc)
    GstElement* sink = nullptr;    // owned ref (appsink)
    gulong handler = 0;
    long long hold_ms = 8000;
    std::string label;
    Cue current;
    long long count = 0;
};

struct Overlay {
    GstElement* pipe = nullptr;
    GstElement* ov = nullptr;      // owned ref (textoverlay)
    GstElement* demux = nullptr;   // owned ref
    gulong pad_added = 0;
    GstPad* vpad = nullptr;        // owned ref
    gulong probe = 0;
    std::vector<std::pair<GstElement*, gulong>> cue_sinks;   // appsinks + their handlers (owned refs)
    std::mutex m;
    Cue cue;
    bool shown = false;
    std::string shown_text;
    long long count = 0;
};

struct State {
    const MrHookCtx* ctx = nullptr;
    std::vector<std::shared_ptr<PayEntry>> pay;
    std::shared_ptr<Overlay> overlay;
    guint timer = 0;
};

std::unique_ptr<State> g_state;

std::string fmt(const char* f, ...) __attribute__((format(printf, 1, 2)));
std::string fmt(const char* f, ...) {
    char buf[1024];
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
    if (g_state && g_state->ctx && g_state->ctx->log) g_state->ctx->log(g_state->ctx->user, ("[subtitle_bridge] " + msg).c_str());
}

void warn(const std::string& message) {
    if (g_state && g_state->ctx && g_state->ctx->emit_event)
        g_state->ctx->emit_event(g_state->ctx->user,
                                 ("{\"event\":\"warning\",\"message\":\"subtitle bridge: " + json_escape(message) + "\"}").c_str());
}

// --- pure logic (twins of the python helpers) ---------------------------------------

/** Cue text bytes → text: drop NULs and CRs, trailing/leading blank lines. */
std::string clean_text(const std::string& data) {
    std::string raw;
    for (char c : data)
        if (c != '\0' && c != '\r') raw += c;
    gchar* valid = g_utf8_make_valid(raw.c_str(), (gssize)raw.size());
    std::string text = valid ? valid : "";
    g_free(valid);
    std::vector<std::string> lines;
    size_t start = 0;
    while (true) {
        size_t nl = text.find('\n', start);
        std::string ln = text.substr(start, nl == std::string::npos ? std::string::npos : nl - start);
        while (!ln.empty() && (ln.back() == ' ' || ln.back() == '\t')) ln.pop_back();
        lines.push_back(ln);
        if (nl == std::string::npos) break;
        start = nl + 1;
    }
    while (!lines.empty() && lines.back().empty()) lines.pop_back();
    size_t skip = 0;
    while (skip < lines.size() && lines[skip].empty()) skip++;
    std::string out;
    for (size_t i = skip; i < lines.size(); i++) out += (i > skip ? "\n" : "") + lines[i];
    return out;
}

Cue make_cue(double now_ms, const std::string& text, long long hold_ms) {
    Cue c;
    c.present = true;
    c.start = (double)std::llround(now_ms);
    c.end = text.empty() ? c.start : c.start + (double)std::max(0LL, hold_ms);
    c.text = text;
    return c;
}

/** Wire form: both times relative to the carrying PES, never negative. */
void relative_cue(const Cue& cue, double now_ms, double* rs, double* re) {
    *rs = std::max(0.0, cue.start - now_ms);
    *re = std::max(*rs, cue.end - now_ms);
}

Cue absolute_cue(const subtitle_klv::Cue& rel, double t0_ms) {
    Cue c;
    c.present = true;
    c.start = t0_ms + (double)rel.start_ms;
    c.end = t0_ms + (double)rel.end_ms;
    c.text = rel.text;
    return c;
}

/** House time to judge a frame by: its PTS when stamp-aligned, else now. */
double frame_time(bool has_pts, double pts_ms, double now_ms) {
    if (!has_pts) return now_ms;
    return std::fabs(pts_ms - now_ms) <= FRAME_TIME_TOLERANCE_MS ? pts_ms : now_ms;
}

enum Action { NONE, SHOW, CLEAR };

Action decide(const Cue& cue, bool shown, const std::string& shown_text, double t_ms, std::string* text) {
    if (!cue.present) return shown ? CLEAR : NONE;
    if (t_ms < cue.start) return NONE;
    if (t_ms >= cue.end || cue.text.empty()) return shown ? CLEAR : NONE;
    if (!shown || shown_text != cue.text) {
        *text = cue.text;
        return SHOW;
    }
    return NONE;
}

bool house_now_ms(GstElement* pipe, double* out) {
    GstClock* clock = gst_element_get_clock(pipe);
    if (!clock) return false;
    *out = ((double)gst_clock_get_time(clock) - (double)gst_element_get_base_time(pipe)) / 1e6;
    gst_object_unref(clock);
    return true;
}

// --- pay side ---------------------------------------------------------------------------

void push_cue(PayEntry& e, const Cue& cue, double now_ms) {
    double rs, re;
    relative_cue(cue, now_ms, &rs, &re);
    std::string payload = subtitle_klv::encode_cue(rs, re, cue.text);
    if (payload.empty()) {
        warn(fmt("cue dropped (subtitle cue too large: %zu bytes)", subtitle_klv::format_cue_block(rs, re, cue.text).size()));
        return;
    }
    GstBuffer* buf = gst_buffer_new_wrapped(g_memdup2(payload.data(), payload.size()), payload.size());
    GST_BUFFER_PTS(buf) = (GstClockTime)(now_ms * 1e6);
    GST_BUFFER_DTS(buf) = GST_BUFFER_PTS(buf);
    GST_BUFFER_DURATION(buf) = GST_CLOCK_TIME_NONE;
    GstFlowReturn ret = GST_FLOW_OK;
    g_signal_emit_by_name(e.src, "push-buffer", buf, &ret);
    gst_buffer_unref(buf);
    if (ret != GST_FLOW_OK) warn(fmt("cue push refused by %s (%s)", GST_ELEMENT_NAME(e.src), gst_flow_get_name(ret)));
    else if (g_getenv("MR_RUNNER_DEBUG")) trace(fmt("pushed cue (%zu bytes, pts %.0f ms)", payload.size(), now_ms));
}

GstFlowReturn on_text_sample(GstElement* sink, gpointer user) {
    auto* holder = static_cast<std::shared_ptr<PayEntry>*>(user);
    PayEntry& e = **holder;
    GstSample* smp = nullptr;
    g_signal_emit_by_name(sink, "pull-sample", &smp);
    if (!smp) return GST_FLOW_OK;
    GstBuffer* buf = gst_sample_get_buffer(smp);
    GstMapInfo mi;
    if (buf && gst_buffer_map(buf, &mi, GST_MAP_READ)) {
        std::string text = clean_text(std::string((const char*)mi.data, mi.size));
        gst_buffer_unmap(buf, &mi);
        double now;
        if (house_now_ms(e.pipe, &now)) {
            Cue cue = make_cue(now, text, e.hold_ms);
            push_cue(e, cue, now);
            if (text.empty()) e.current = Cue{};
            else e.current = cue;
            e.count++;
            if (g_state && g_state->ctx && g_state->ctx->emit_plugin_event)
                g_state->ctx->emit_plugin_event(
                    g_state->ctx->user, CUE_EVENT_CHANNEL,
                    fmt("{\"label\":\"%s\",\"text\":\"%s\",\"startMs\":%lld,\"count\":%lld}", json_escape(e.label).c_str(),
                        json_escape(text).c_str(), (long long)cue.start, e.count)
                        .c_str());
        }
    }
    gst_sample_unref(smp);
    return GST_FLOW_OK;
}

gboolean resend_tick(gpointer) {
    if (!g_state) return G_SOURCE_REMOVE;
    for (auto& e : g_state->pay) {
        if (!e->current.present) continue;
        double now;
        if (!house_now_ms(e->pipe, &now)) continue;
        if (now >= e->current.end) {
            e->current = Cue{};
            continue;
        }
        push_cue(*e, e->current, now);
    }
    return G_SOURCE_CONTINUE;
}

void install_pay(GstElement* pipe, JsonObject* spec) {
    auto str = [&](const char* k) -> std::string {
        if (!json_object_has_member(spec, k) || JSON_NODE_HOLDS_NULL(json_object_get_member(spec, k))) return "";
        const gchar* s = json_object_get_string_member(spec, k);
        return s ? s : "";
    };
    std::string sink_name = str("appsink"), src_name = str("appsrc");
    GstElement* sink = sink_name.empty() ? nullptr : gst_bin_get_by_name(GST_BIN(pipe), sink_name.c_str());
    GstElement* src = src_name.empty() ? nullptr : gst_bin_get_by_name(GST_BIN(pipe), src_name.c_str());
    if (!sink || !src) {
        warn(fmt("pay elements missing (%s/%s)", sink_name.c_str(), src_name.c_str()));
        if (sink) gst_object_unref(sink);
        if (src) gst_object_unref(src);
        return;
    }
    auto e = std::make_shared<PayEntry>();
    e->pipe = pipe;
    e->src = src;
    e->sink = sink;
    e->hold_ms = json_object_has_member(spec, "holdMs") && !JSON_NODE_HOLDS_NULL(json_object_get_member(spec, "holdMs"))
                     ? json_object_get_int_member(spec, "holdMs")
                     : 8000;
    std::string label = str("label");
    e->label = label.empty() ? src_name : label;
    g_object_set(sink, "emit-signals", TRUE, "sync", FALSE, "max-buffers", 8u, "drop", TRUE, nullptr);
    e->handler = g_signal_connect_data(sink, "new-sample", G_CALLBACK(on_text_sample), new std::shared_ptr<PayEntry>(e),
                                       [](gpointer p, GClosure*) { delete static_cast<std::shared_ptr<PayEntry>*>(p); },
                                       (GConnectFlags)0);
    g_state->pay.push_back(e);
}

// --- overlay side ---------------------------------------------------------------------

GstFlowReturn on_cue_sample(GstElement* sink, gpointer user) {
    auto* holder = static_cast<std::shared_ptr<Overlay>*>(user);
    Overlay& st = **holder;
    GstSample* smp = nullptr;
    g_signal_emit_by_name(sink, "pull-sample", &smp);
    if (!smp) return GST_FLOW_OK;
    GstBuffer* buf = gst_sample_get_buffer(smp);
    GstMapInfo mi;
    if (buf && gst_buffer_map(buf, &mi, GST_MAP_READ)) {
        subtitle_klv::Cue rel;
        bool ok = subtitle_klv::decode_cue(std::string((const char*)mi.data, mi.size), &rel);
        gst_buffer_unmap(buf, &mi);
        double now;
        if (ok && house_now_ms(st.pipe, &now)) {
            // Anchor the relative span on the cue PES's own frame time.
            bool has_pts = GST_CLOCK_TIME_IS_VALID(GST_BUFFER_PTS(buf));
            double t0 = frame_time(has_pts, has_pts ? (double)GST_BUFFER_PTS(buf) / 1e6 : 0.0, now);
            std::lock_guard<std::mutex> lock(st.m);
            st.cue = absolute_cue(rel, t0);
            st.count++;
        }
    }
    gst_sample_unref(smp);
    return GST_FLOW_OK;
}

void on_demux_pad(GstElement*, GstPad* pad, gpointer user) {
    auto* holder = static_cast<std::shared_ptr<Overlay>*>(user);
    std::shared_ptr<Overlay> st = *holder;
    if (!g_state) return;
    GstElement* pipe = st->pipe;
    GstCaps* caps = gst_pad_get_current_caps(pad);
    if (!caps) caps = gst_pad_query_caps(pad, nullptr);
    std::string name;
    if (caps && gst_caps_get_size(caps) > 0) {
        const gchar* n = gst_structure_get_name(gst_caps_get_structure(caps, 0));
        name = n ? n : "";
    }
    if (caps) gst_caps_unref(caps);
    if (name == "meta/x-klv") {
        GstElement* q = gst_element_factory_make("queue", nullptr);
        GstElement* sink = gst_element_factory_make("appsink", nullptr);
        if (!q || !sink) {
            warn("could not link subtitle pad (queue/appsink factory missing)");
            return;
        }
        g_object_set(sink, "emit-signals", TRUE, "sync", FALSE, "max-buffers", 8u, "drop", TRUE, nullptr);
        gulong id = g_signal_connect_data(sink, "new-sample", G_CALLBACK(on_cue_sample), new std::shared_ptr<Overlay>(st),
                                          [](gpointer p, GClosure*) { delete static_cast<std::shared_ptr<Overlay>*>(p); },
                                          (GConnectFlags)0);
        gst_bin_add_many(GST_BIN(pipe), q, sink, nullptr);
        gst_element_sync_state_with_parent(q);
        gst_element_sync_state_with_parent(sink);
        gst_element_link(q, sink);
        GstPad* qsink = gst_element_get_static_pad(q, "sink");
        if (gst_pad_link(pad, qsink) != GST_PAD_LINK_OK) warn("could not link subtitle pad (link failed)");
        gst_object_unref(qsink);
        st->cue_sinks.push_back({GST_ELEMENT(gst_object_ref(sink)), id});
    } else {
        // Not ours: keep the demux flowing rather than letting an unlinked pad kill it.
        GstElement* fs = gst_element_factory_make("fakesink", nullptr);
        if (!fs) return;
        g_object_set(fs, "sync", FALSE, "async", FALSE, nullptr);
        gst_bin_add(GST_BIN(pipe), fs);
        gst_element_sync_state_with_parent(fs);
        GstPad* fsink = gst_element_get_static_pad(fs, "sink");
        gst_pad_link(pad, fsink);
        gst_object_unref(fsink);
        warn(fmt("ignoring non-subtitle stream %s on the subtitle input", name.empty() ? "?" : name.c_str()));
    }
}

GstPadProbeReturn on_video_frame(GstPad*, GstPadProbeInfo* info, gpointer user) {
    auto* holder = static_cast<std::shared_ptr<Overlay>*>(user);
    Overlay& st = **holder;
    GstBuffer* buf = GST_PAD_PROBE_INFO_BUFFER(info);
    if (!buf) return GST_PAD_PROBE_OK;
    double now;
    if (!house_now_ms(st.pipe, &now)) return GST_PAD_PROBE_OK;
    bool has_pts = GST_CLOCK_TIME_IS_VALID(GST_BUFFER_PTS(buf));
    double t = frame_time(has_pts, has_pts ? (double)GST_BUFFER_PTS(buf) / 1e6 : 0.0, now);
    std::string text;
    std::lock_guard<std::mutex> lock(st.m);
    Action a = decide(st.cue, st.shown, st.shown_text, t, &text);
    if (a == NONE) return GST_PAD_PROBE_OK;
    if (a == SHOW) {
        g_object_set(st.ov, "text", text.c_str(), nullptr);
        st.shown = true;
        st.shown_text = text;
        std::string one = text;
        for (char& c : one) if (c == '\n') c = '/';
        trace("show '" + one.substr(0, 60) + "'");
    } else {
        g_object_set(st.ov, "text", "", nullptr);
        st.shown = false;
        st.shown_text.clear();
        trace("clear");
        if (st.cue.present && (st.cue.text.empty() || t >= st.cue.end)) st.cue = Cue{};
    }
    return GST_PAD_PROBE_OK;
}

void install_overlay(GstElement* pipe, JsonObject* cfg) {
    auto str = [&](const char* k) -> std::string {
        if (!json_object_has_member(cfg, k) || JSON_NODE_HOLDS_NULL(json_object_get_member(cfg, k))) return "";
        const gchar* s = json_object_get_string_member(cfg, k);
        return s ? s : "";
    };
    std::string demux_name = str("demux"), ov_name = str("overlay");
    GstElement* demux = demux_name.empty() ? nullptr : gst_bin_get_by_name(GST_BIN(pipe), demux_name.c_str());
    GstElement* ov = ov_name.empty() ? nullptr : gst_bin_get_by_name(GST_BIN(pipe), ov_name.c_str());
    if (!demux || !ov) {
        warn(fmt("overlay elements missing (%s/%s)", demux_name.c_str(), ov_name.c_str()));
        if (demux) gst_object_unref(demux);
        if (ov) gst_object_unref(ov);
        return;
    }
    auto st = std::make_shared<Overlay>();
    st->pipe = pipe;
    st->ov = ov;
    st->demux = demux;
    g_state->overlay = st;
    st->pad_added = g_signal_connect_data(demux, "pad-added", G_CALLBACK(on_demux_pad), new std::shared_ptr<Overlay>(st),
                                          [](gpointer p, GClosure*) { delete static_cast<std::shared_ptr<Overlay>*>(p); },
                                          (GConnectFlags)0);
    st->vpad = gst_element_get_static_pad(ov, "video_sink");
    if (st->vpad)
        st->probe = gst_pad_add_probe(st->vpad, GST_PAD_PROBE_TYPE_BUFFER, on_video_frame, new std::shared_ptr<Overlay>(st),
                                      [](gpointer p) { delete static_cast<std::shared_ptr<Overlay>*>(p); });
}

}  // namespace

extern "C" {

int mr_hook_abi(void) { return MR_HOOK_ABI; }

int mr_hook_install(GstElement* pipeline, const char* config_json, const MrHookCtx* ctx) {
    mr_hook_clear();
    if (!pipeline || !GST_IS_BIN(pipeline)) return 1;
    JsonParser* parser = json_parser_new();
    JsonObject* cfg = nullptr;
    if (config_json && json_parser_load_from_data(parser, config_json, -1, nullptr)) {
        JsonNode* root = json_parser_get_root(parser);
        if (root && JSON_NODE_HOLDS_OBJECT(root)) cfg = json_node_get_object(root);
    }
    JsonArray* pay = cfg && json_object_has_member(cfg, "pay") && JSON_NODE_HOLDS_ARRAY(json_object_get_member(cfg, "pay"))
                         ? json_object_get_array_member(cfg, "pay")
                         : nullptr;
    JsonObject* overlay = cfg && json_object_has_member(cfg, "overlay") && JSON_NODE_HOLDS_OBJECT(json_object_get_member(cfg, "overlay"))
                              ? json_object_get_object_member(cfg, "overlay")
                              : nullptr;
    if ((pay && json_array_get_length(pay) > 0) || overlay) {
        g_state = std::make_unique<State>();
        g_state->ctx = ctx;
        if (pay)
            for (guint i = 0; i < json_array_get_length(pay); i++) {
                JsonNode* n = json_array_get_element(pay, i);
                if (JSON_NODE_HOLDS_OBJECT(n)) install_pay(pipeline, json_node_get_object(n));
            }
        if (overlay) install_overlay(pipeline, overlay);
        if (!g_state->pay.empty()) g_state->timer = g_timeout_add(RESEND_MS, resend_tick, nullptr);
    }
    g_object_unref(parser);
    return 0;
}

void mr_hook_clear(void) {
    if (!g_state) return;
    if (g_state->timer) g_source_remove(g_state->timer);
    for (auto& e : g_state->pay) {
        if (e->handler) g_signal_handler_disconnect(e->sink, e->handler);
        gst_object_unref(e->sink);
        gst_object_unref(e->src);
    }
    if (auto st = g_state->overlay) {
        if (st->pad_added) g_signal_handler_disconnect(st->demux, st->pad_added);
        if (st->probe && st->vpad) gst_pad_remove_probe(st->vpad, st->probe);
        if (st->vpad) gst_object_unref(st->vpad);
        for (auto& [sink, id] : st->cue_sinks) {
            g_signal_handler_disconnect(sink, id);
            gst_object_unref(sink);
        }
        gst_object_unref(st->ov);
        gst_object_unref(st->demux);
    }
    g_state.reset();
}

}  // extern "C"
