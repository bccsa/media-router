#include "gates.h"

#include <unistd.h>

#include <atomic>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <memory>
#include <mutex>
#include <optional>
#include <vector>

#include "backlog_shed.h"
#include "ipc.h"
#include "json_util.h"
#include "mrts/ts_psi.h"
#include "mrts/ts_video_info.h"
#include "paths.h"
#include "runner.h"

namespace mr {

namespace {

std::string fmt(const char* f, ...) __attribute__((format(printf, 1, 2)));
std::string fmt(const char* f, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, f);
    std::vsnprintf(buf, sizeof buf, f, ap);
    va_end(ap);
    return buf;
}

void emit_error(const std::string& message) {
    JsonObject* ev = ipc::event("error");
    json_object_set_string_member(ev, "message", message.c_str());
    ipc::emit(ev);
}

}  // namespace

// ===========================================================================
// keyframe gate
// ===========================================================================

namespace gate_kf {

namespace {

constexpr const char* FAULT_DROP_DELTAS_ENV = "VP_FAULT_DROP_DELTAS";

struct State {
    GstPad* pad = nullptr;    // owned
    std::string decoder;
    gulong probe_id = 0;
    std::atomic<bool> opened{false};
    long long dropped = 0, since_close = 0, rearms = 0;
    long long fault_budget = 0, fault_dropped = 0;
};

std::shared_ptr<State> g_state;

void log_line(const State& st, const std::string& line) { ipc::log("keyframe gate: " + st.decoder + " " + line); }

/** How many post-keyframe delta AUs the fault injector must swallow (0 = inert). */
long long fault_drop_budget() {
    const char* s = g_getenv(FAULT_DROP_DELTAS_ENV);
    if (!s || !*s) return 0;
    char* end = nullptr;
    long long n = std::strtoll(s, &end, 10);
    return (end && end != s && n > 0) ? n : 0;
}

GstPadProbeReturn on_buffer(GstPad*, GstPadProbeInfo* info, gpointer user) {
    auto* holder = static_cast<std::shared_ptr<State>*>(user);
    State& st = **holder;
    GstBuffer* buf = GST_PAD_PROBE_INFO_BUFFER(info);
    if (!buf) return GST_PAD_PROBE_OK;
    bool delta = GST_BUFFER_FLAG_IS_SET(buf, GST_BUFFER_FLAG_DELTA_UNIT);
    if (st.opened.load()) {
        // Open: only upstream LOSS shuts the gate again (a DISCONT keyframe passes).
        if (!(delta && GST_BUFFER_FLAG_IS_SET(buf, GST_BUFFER_FLAG_DISCONT))) {
            if (delta && st.fault_budget > 0) {
                st.fault_budget--;
                st.fault_dropped++;
                if (st.fault_budget == 0) log_line(st, fmt("FAULT INJECTOR: burst complete (%lld dropped)", st.fault_dropped));
                return GST_PAD_PROBE_DROP;
            }
            return GST_PAD_PROBE_OK;
        }
        st.opened.store(false);
        st.since_close = 0;
        st.rearms++;
        log_line(st, fmt("re-armed on a DISCONT delta unit — data lost upstream, dropping until the next keyframe "
                         "(re-arm #%lld)",
                         st.rearms));
    }
    if (delta) {
        st.dropped++;
        st.since_close++;
        return GST_PAD_PROBE_DROP;
    }
    st.opened.store(true);
    log_line(st, fmt("opened on %s keyframe (%lld delta unit(s) dropped%s)", st.rearms ? "a" : "first", st.since_close,
                     st.rearms ? fmt(", re-arm #%lld", st.rearms).c_str() : ""));
    return GST_PAD_PROBE_OK;
}

}  // namespace

bool start(GstElement* pipe, JsonObject* cfg) {
    stop();   // never inherit a previous pipeline's gate
    if (!cfg) return true;
    std::string name = json_get_string(cfg, "decoder");
    GstElement* dec = GST_IS_BIN(pipe) && !name.empty() ? gst_bin_get_by_name(GST_BIN(pipe), name.c_str()) : nullptr;
    if (!dec) {
        emit_error("keyframeGate: decoder not found: '" + name + "'");
        return false;
    }
    GstPad* pad = gst_element_get_static_pad(dec, "sink");
    gst_object_unref(dec);
    if (!pad) {
        emit_error("keyframeGate: no sink pad on: '" + name + "'");
        return false;
    }
    auto st = std::make_shared<State>();
    st->pad = pad;
    st->decoder = name;
    st->fault_budget = fault_drop_budget();
    if (st->fault_budget)
        log_line(*st, fmt("FAULT INJECTOR: dropping next %lld delta AUs after keyframe (%s)", st->fault_budget,
                          FAULT_DROP_DELTAS_ENV));
    g_state = st;
    st->probe_id = gst_pad_add_probe(pad, GST_PAD_PROBE_TYPE_BUFFER, on_buffer, new std::shared_ptr<State>(st),
                                     [](gpointer p) { delete static_cast<std::shared_ptr<State>*>(p); });
    return true;
}

void reclose(const std::string& decoder) {
    std::shared_ptr<State> st = g_state;
    if (!st || st->decoder != decoder || !st->opened.load()) return;
    st->opened.store(false);
    st->since_close = 0;
    st->rearms++;
    ipc::log(fmt("keyframe gate: %s re-armed after a post-shed decoder flush (re-arm #%lld)", decoder.c_str(), st->rearms));
}

GstPad* decoder_pad(std::string* name) {
    std::shared_ptr<State> st = g_state;
    if (!st) return nullptr;
    if (name) *name = st->decoder;
    return st->pad;
}

void stop() {
    std::shared_ptr<State> st = g_state;
    g_state.reset();
    if (!st) return;
    if (st->probe_id) gst_pad_remove_probe(st->pad, st->probe_id);
    gst_object_unref(st->pad);
    st->pad = nullptr;
}

}  // namespace gate_kf

// ===========================================================================
// render watch
// ===========================================================================

namespace render {

namespace {

constexpr int WINDOW_MS = 2000;

/** Render keep-up detector with hysteresis (render_lag.py). */
struct LagMonitor {
    double lag_ratio = 0.85, recover_ratio = 0.95, drop_ratio = 0.05;
    int trip_windows = 3;
    bool lagging = false;
    int below = 0, above = 0;
    bool has_last_expected = false;
    double last_expected = 0;
    bool started = false;

    /** "lag" / "recovered" with achieved fps, or nullptr. */
    const char* tick(long long frames, double window_s, bool has_expected, double expected, double dropped_fps,
                     double* achieved_out) {
        if (window_s <= 0) return nullptr;
        if (!has_expected || expected <= 0) {
            below = above = 0;
            has_last_expected = false;
            return nullptr;
        }
        if (frames <= 0 && !started) {
            below = above = 0;
            has_last_expected = true;
            last_expected = expected;
            return nullptr;
        }
        if (frames > 0) started = true;
        if (has_last_expected && expected != last_expected) below = above = 0;
        has_last_expected = true;
        last_expected = expected;
        double achieved = (double)frames / window_s;
        *achieved_out = achieved;
        bool dropping = dropped_fps > drop_ratio * expected;
        if (achieved < lag_ratio * expected || dropping) {
            below++;
            above = 0;
            if (!lagging && below >= trip_windows) {
                lagging = true;
                return "lag";
            }
        } else if (achieved >= recover_ratio * expected && dropped_fps <= 0.5 * drop_ratio * expected) {
            above++;
            below = 0;
            if (lagging && above >= trip_windows) {
                lagging = false;
                return "recovered";
            }
        } else {
            below = above = 0;
        }
        return nullptr;
    }
};

struct State {
    GstPad* pad = nullptr;      // owned
    GstElement* sink = nullptr; // owned
    std::atomic<long long> frames{0};
    LagMonitor mon;
    gulong probe_id = 0;
    guint timer_id = 0;
    bool has_prev = false;
    guint64 prev_rendered = 0, prev_dropped = 0;
};

std::shared_ptr<State> g_state;

GstPadProbeReturn on_buffer(GstPad*, GstPadProbeInfo*, gpointer user) {
    (*static_cast<std::shared_ptr<State>*>(user))->frames.fetch_add(1, std::memory_order_relaxed);
    return GST_PAD_PROBE_OK;
}

bool expected_fps(State& st, double* out) {
    GstCaps* caps = gst_pad_get_current_caps(st.pad);
    if (!caps || gst_caps_get_size(caps) == 0) {
        if (caps) gst_caps_unref(caps);
        return false;
    }
    gint num = 0, den = 0;
    bool ok = gst_structure_get_fraction(gst_caps_get_structure(caps, 0), "framerate", &num, &den) && num > 0 && den > 0;
    gst_caps_unref(caps);
    if (ok) *out = (double)num / den;
    return ok;
}

bool sink_stats(State& st, guint64* rendered, guint64* dropped) {
    if (!g_object_class_find_property(G_OBJECT_GET_CLASS(st.sink), "stats")) return false;
    GstStructure* s = nullptr;
    g_object_get(st.sink, "stats", &s, nullptr);
    if (!s) return false;
    bool ok = gst_structure_get_uint64(s, "rendered", rendered) && gst_structure_get_uint64(s, "dropped", dropped);
    gst_structure_free(s);
    return ok;
}

gboolean tick(gpointer) {
    std::shared_ptr<State> st = g_state;
    if (!st) return G_SOURCE_REMOVE;
    long long arrivals = st->frames.exchange(0);
    long long achieved = arrivals;
    long long dropped = 0;
    guint64 rendered_now = 0, dropped_now = 0;
    if (sink_stats(*st, &rendered_now, &dropped_now)) {
        bool had = st->has_prev;
        guint64 pr = st->prev_rendered, pd = st->prev_dropped;
        st->has_prev = true;
        st->prev_rendered = rendered_now;
        st->prev_dropped = dropped_now;
        if (had && arrivals > 0 && rendered_now >= pr && dropped_now >= pd) {
            achieved = (long long)(rendered_now - pr);
            dropped = (long long)(dropped_now - pd);
        }
    }
    double window_s = WINDOW_MS / 1000.0;
    double expected = 0;
    bool has_expected = expected_fps(*st, &expected);
    double achieved_fps = 0;
    const char* kind = st->mon.tick(achieved, window_s, has_expected, expected, dropped / window_s, &achieved_fps);
    if (kind) {
        JsonObject* o = json_object_new();
        json_object_set_double_member(o, "achievedFps", std::round(achieved_fps * 10) / 10);
        json_object_set_double_member(o, "expectedFps", std::round(expected * 100) / 100);
        json_object_set_double_member(o, "droppedFps", std::round(dropped / window_s * 10) / 10);
        json_object_set_double_member(o, "arrivalsFps", std::round(arrivals / window_s * 10) / 10);
        // Retained latency, when a shedder is armed to measure it.
        shed::window_into(runner().now_running_ms(), o);
        JsonNode* n = json_node_new(JSON_NODE_OBJECT);
        json_node_take_object(n, o);
        runner().emit_plugin_event(std::string("renderwatch:") + kind, n);
    }
    return G_SOURCE_CONTINUE;
}

}  // namespace

bool start(GstElement* pipe, JsonObject* cfg) {
    stop();
    if (!cfg) return true;
    std::string name = json_get_string(cfg, "sink");
    GstElement* sink = GST_IS_BIN(pipe) && !name.empty() ? gst_bin_get_by_name(GST_BIN(pipe), name.c_str()) : nullptr;
    if (!sink) {
        emit_error("renderWatch: sink not found: '" + name + "'");
        return false;
    }
    GstPad* pad = gst_element_get_static_pad(sink, "sink");
    if (!pad) {
        emit_error("renderWatch: no sink pad on: '" + name + "'");
        gst_object_unref(sink);
        return false;
    }
    auto st = std::make_shared<State>();
    st->pad = pad;
    st->sink = sink;
    g_state = st;
    st->probe_id = gst_pad_add_probe(pad, GST_PAD_PROBE_TYPE_BUFFER, on_buffer, new std::shared_ptr<State>(st),
                                     [](gpointer p) { delete static_cast<std::shared_ptr<State>*>(p); });
    st->timer_id = g_timeout_add(WINDOW_MS, tick, nullptr);
    return true;
}

void stop() {
    std::shared_ptr<State> st = g_state;
    g_state.reset();
    if (!st) return;
    if (st->timer_id) g_source_remove(st->timer_id);
    if (st->probe_id) gst_pad_remove_probe(st->pad, st->probe_id);
    gst_object_unref(st->pad);
    gst_object_unref(st->sink);
}

}  // namespace render

// ===========================================================================
// TS video-info probe
// ===========================================================================

namespace tsprobe {

namespace {

constexpr int PROBE_SAMPLE_STRIDE = 64;

struct State {
    GstElement* appsink = nullptr;   // owned
    gulong handler = 0;
    mrts::PsiDiscovery disc;
    std::unique_ptr<mrts::VideoInfoProbe> probe;
    int probe_pid = -1;
    std::string probe_codec;
    bool stable = false;
    long long n = 0;
};

std::shared_ptr<State> g_state;

const char* codec_for_type(int stype) {
    switch (stype) {
        case mrts::STREAM_TYPE_MPEG2_VIDEO: return "mpeg2";
        case 0x01: return "mpeg1";
        case mrts::STREAM_TYPE_AVC: return "h264";
        case mrts::STREAM_TYPE_HEVC: return "h265";
        default: return nullptr;
    }
}

void emit_info(int pid, const std::string& codec, const mrts::VideoInfo* info) {
    JsonObject* o = json_object_new();
    json_object_set_int_member(o, "pid", pid);
    json_object_set_string_member(o, "codec", codec.c_str());
    auto set_opt_int = [&](const char* k, const std::optional<int>& v) {
        if (v) json_object_set_int_member(o, k, *v);
        else json_object_set_null_member(o, k);
    };
    if (info) {
        set_opt_int("width", info->width);
        set_opt_int("height", info->height);
        if (info->interlaced) json_object_set_boolean_member(o, "interlaced", *info->interlaced);
        else json_object_set_null_member(o, "interlaced");
        if (info->fps) json_object_set_double_member(o, "fps", *info->fps);
        else json_object_set_null_member(o, "fps");
        // python's info dict carries `scrambled` only when the probe saw it
        if (info->scrambled) json_object_set_boolean_member(o, "scrambled", TRUE);
        else json_object_set_null_member(o, "scrambled");
        std::string display = mrts::format_video_info(*info);
        if (display.empty()) json_object_set_null_member(o, "display");
        else json_object_set_string_member(o, "display", display.c_str());
    } else {
        for (const char* k : {"width", "height", "interlaced", "fps", "scrambled", "display"}) json_object_set_null_member(o, k);
    }
    JsonNode* n = json_node_new(JSON_NODE_OBJECT);
    json_node_take_object(n, o);
    runner().emit_plugin_event("tsprobe:videoinfo", n);
}

// `tsprobe:pmt` — the whole PMT with each ES's raw descriptor loop as hex, the
// same shape as the splitter's `tssplit:discovered`. Emitted on every PMT
// change so a plugin can read descriptor-only facts itself.
void emit_pmt(const mrts::Pmt& pmt) {
    JsonArray* streams = json_array_new();
    for (const mrts::PmtStream& s : pmt.streams) {
        JsonObject* e = json_object_new();
        json_object_set_int_member(e, "pid", s.pid);
        json_object_set_int_member(e, "streamType", s.stream_type);
        std::string hex;
        char b[3];
        for (uint8_t v : s.es_info) {
            std::snprintf(b, sizeof b, "%02x", v);
            hex += b;
        }
        json_object_set_string_member(e, "esInfo", hex.c_str());
        json_array_add_object_element(streams, e);
    }
    JsonObject* o = json_object_new();
    json_object_set_int_member(o, "programNumber", pmt.program_number);
    json_object_set_int_member(o, "pcrPid", pmt.pcr_pid);
    json_object_set_array_member(o, "streams", streams);
    JsonNode* n = json_node_new(JSON_NODE_OBJECT);
    json_node_take_object(n, o);
    runner().emit_plugin_event("tsprobe:pmt", n);
}

void on_pmt(State& st) {
    const auto& pmt = st.disc.pmt();
    if (!pmt) return;
    emit_pmt(*pmt);
    for (const mrts::PmtStream& s : pmt->streams) {
        const char* codec = codec_for_type(s.stream_type);
        if (!codec) continue;
        if (st.probe && st.probe_pid == s.pid && st.probe_codec == codec) return;   // unchanged video ES
        st.stable = false;
        st.probe_pid = s.pid;
        st.probe_codec = codec;
        if (st.probe_codec == "h264" || st.probe_codec == "h265")
            st.probe = std::make_unique<mrts::VideoInfoProbe>(s.pid, st.probe_codec == "h265");
        else
            st.probe.reset();   // mpeg1/2: codec-only report
        emit_info(s.pid, st.probe_codec, nullptr);
        return;   // first video ES of the first program
    }
}

GstFlowReturn on_sample(GstElement* sink, gpointer user) {
    std::shared_ptr<State> st = *static_cast<std::shared_ptr<State>*>(user);
    GstSample* smp = nullptr;
    g_signal_emit_by_name(sink, "pull-sample", &smp);
    if (!smp) return GST_FLOW_OK;
    st->n++;
    if (st->stable && (st->n % PROBE_SAMPLE_STRIDE)) {
        gst_sample_unref(smp);
        return GST_FLOW_OK;
    }
    GstBuffer* buf = gst_sample_get_buffer(smp);
    GstMapInfo mi;
    if (buf && gst_buffer_map(buf, &mi, GST_MAP_READ)) {
        std::vector<mrts::TsPacket> psi;
        for (size_t off = 0; off + mrts::PKT <= mi.size; off += mrts::PKT) {
            const uint8_t* pkt = mi.data + off;
            if (pkt[0] != mrts::SYNC_BYTE) continue;
            int pid = mrts::ts_pid(pkt);
            if (pid == 0 || pid == st->disc.pmt_pid()) {
                mrts::TsPacket p;
                memcpy(p.b, pkt, mrts::PKT);
                psi.push_back(p);
            }
            if (st->probe && pid == st->probe_pid) {
                if (auto info = st->probe->feed(pkt)) {
                    st->stable = true;
                    emit_info(pid, st->probe_codec, &*info);
                }
            }
        }
        gst_buffer_unmap(buf, &mi);
        bool changed = st->disc.feed(psi);
        if (g_getenv("MR_RUNNER_DEBUG"))
            ipc::log(fmt("tsProbe: sample #%lld %zu bytes, %zu psi pkts, pmt_pid=%d changed=%d probe_pid=%d", st->n, mi.size,
                         psi.size(), st->disc.pmt_pid(), (int)changed, st->probe_pid));
        if (changed) on_pmt(*st);
    }
    gst_sample_unref(smp);
    return GST_FLOW_OK;
}

}  // namespace

bool start(GstElement* pipe, JsonObject* cfg) {
    stop();
    if (!cfg) return true;
    std::string name = json_get_string(cfg, "appsink");
    GstElement* appsink = GST_IS_BIN(pipe) && !name.empty() ? gst_bin_get_by_name(GST_BIN(pipe), name.c_str()) : nullptr;
    if (!appsink) {
        emit_error("tsProbe: appsink not found: '" + name + "'");
        return false;
    }
    auto st = std::make_shared<State>();
    st->appsink = appsink;
    g_state = st;
    // async=false keeps the tap out of preroll; drop + small bound: a
    // report-only tap must shed, never back-pressure the tee it hangs off.
    g_object_set(appsink, "emit-signals", TRUE, "sync", FALSE, "async", FALSE, "max-buffers", 8u, "drop", TRUE, nullptr);
    st->handler = g_signal_connect_data(appsink, "new-sample", G_CALLBACK(on_sample), new std::shared_ptr<State>(st),
                                        [](gpointer p, GClosure*) { delete static_cast<std::shared_ptr<State>*>(p); },
                                        (GConnectFlags)0);
    return true;
}

void stop() {
    std::shared_ptr<State> st = g_state;
    g_state.reset();
    if (!st) return;
    if (st->handler) g_signal_handler_disconnect(st->appsink, st->handler);
    gst_object_unref(st->appsink);
}

}  // namespace tsprobe

// ===========================================================================
// mrrist plugin loader
// ===========================================================================

namespace rist {

namespace {
int g_loaded = -1;
}  // namespace

bool load_plugin() {
    if (g_loaded >= 0) return g_loaded == 1;
    if (gst_element_factory_find("mrristsink") && gst_element_factory_find("mrristsrc")) {
        g_loaded = 1;
        return true;
    }
    const char* so = "libgstmrrist.so";
    std::vector<std::string> paths = paths::asset_candidates("rist-core", "mrrist", so);
    std::string tried;
    for (const std::string& path : paths) {
        if (!tried.empty()) tried += ", ";
        tried += path;
        if (!g_file_test(path.c_str(), G_FILE_TEST_EXISTS)) continue;
        GError* err = nullptr;
        GstPlugin* plugin = gst_plugin_load_file(path.c_str(), &err);
        if (!plugin) {
            ipc::log(fmt("mrrist: plugin at %s failed to load (%s)", path.c_str(), err && err->message ? err->message : "?"));
            g_clear_error(&err);
            continue;
        }
        ipc::log(fmt("mrrist: native RIST elements loaded (mrrist %s from %s)", gst_plugin_get_version(plugin), path.c_str()));
        gst_object_unref(plugin);
        g_loaded = 1;
        return true;
    }
    ipc::log("mrrist: no " + std::string(so) + " found (" + tried + ") — RIST pipelines naming mrristsink/mrristsrc will fail to parse");
    g_loaded = 0;
    return false;
}

}  // namespace rist

}  // namespace mr
