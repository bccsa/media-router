#include "stamper.h"

#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <map>
#include <vector>

#include "ipc.h"
#include "json_util.h"
#include "paths.h"
#include "runner.h"

namespace mr::stamper {

namespace {

constexpr int DRIFT_REPORT_MS = 30000;

bool g_enabled = false;
GstElement* g_pipeline = nullptr;
int g_native_loaded = -1;          // -1 not tried, 0 failed, 1 loaded
bool g_repair_latch = true;
gint64 g_condition_step_ms = 0;
guint g_drift_timer_id = 0;
std::map<std::string, GstElement*> g_elements;   // tee name -> spliced mrtsstamp (owned ref)
std::vector<std::string> g_armed;                 // tee names armed

void log_line(const std::string& tee, const std::string& line) {
    ipc::log("busStamp " + tee + ": " + line);
}

std::string fmt(const char* f, ...) __attribute__((format(printf, 1, 2)));
std::string fmt(const char* f, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, f);
    std::vsnprintf(buf, sizeof buf, f, ap);
    va_end(ap);
    return buf;
}

/** Candidate paths for the native stamper plugin, in resolution order — the
 *  deployed plugins tree first, then the packaged install root (paths.h).
 *  Mirrors `gst_stamp_native.so_paths` / `nativeBinaries.ts`; never GST_PLUGIN_PATH. */
std::vector<std::string> so_paths() {
    return paths::asset_candidates("mpegts-core", "mrtsstamp", "libgstmrtsstamp.so");
}

bool load_native() {
    if (g_native_loaded >= 0) return g_native_loaded == 1;
    g_native_loaded = 0;
    std::string tried;
    for (const std::string& path : so_paths()) {
        if (!tried.empty()) tried += ", ";
        tried += path;
        if (!g_file_test(path.c_str(), G_FILE_TEST_EXISTS)) continue;
        GError* err = nullptr;
        GstPlugin* plugin = gst_plugin_load_file(path.c_str(), &err);
        if (!plugin) {
            ipc::log(fmt("busStamp: mrtsstamp plugin at %s failed to load (%s) — egress will NOT be stamped",
                         path.c_str(), err && err->message ? err->message : "?"));
            g_clear_error(&err);
            continue;
        }
        ipc::log(fmt("busStamp: native stamper loaded (mrtsstamp %s from %s)", gst_plugin_get_version(plugin),
                     path.c_str()));
        gst_object_unref(plugin);
        g_native_loaded = 1;
        return true;
    }
    ipc::log("busStamp: no mrtsstamp plugin found (" + tried + ") — egress will NOT be stamped");
    ipc::warning("time-sync contract: mrtsstamp plugin missing — this producer's egress is not stamped");
    return false;
}

/** The link at the head of `tee`'s egress chain (upstream src pad, downstream
 *  sink pad), walking up through capssetter/capsfilter. Both returned refs are
 *  owned by the caller; (nullptr, nullptr) when the tee has no upstream. */
std::pair<GstPad*, GstPad*> egress_head(GstElement* tee) {
    GstPad* sink = gst_element_get_static_pad(tee, "sink");
    while (sink) {
        GstPad* peer = gst_pad_get_peer(sink);
        if (!peer) {
            gst_object_unref(sink);
            return {nullptr, nullptr};
        }
        GstElement* el = gst_pad_get_parent_element(peer);
        std::string fname = factory_name(el);
        if (fname != "capssetter" && fname != "capsfilter") {
            if (el) gst_object_unref(el);
            return {peer, sink};
        }
        GstPad* next = gst_element_get_static_pad(el, "sink");
        gst_object_unref(el);
        gst_object_unref(peer);
        gst_object_unref(sink);
        sink = next;
    }
    return {nullptr, nullptr};
}

void insert_elements(GstElement* pipe) {
    if (!GST_IS_BIN(pipe)) return;
    // Collect first, splice second: adding elements invalidates a live iterator.
    std::vector<GstElement*> tees;
    GstIterator* it = gst_bin_iterate_elements(GST_BIN(pipe));
    GValue item = G_VALUE_INIT;
    bool done = false;
    while (!done) {
        switch (gst_iterator_next(it, &item)) {
            case GST_ITERATOR_OK: {
                GstElement* el = GST_ELEMENT(g_value_get_object(&item));
                const gchar* n = GST_OBJECT_NAME(el);
                if (n && g_str_has_prefix(n, "busout_")) tees.push_back(GST_ELEMENT(gst_object_ref(el)));
                g_value_reset(&item);
                break;
            }
            case GST_ITERATOR_RESYNC:
                for (GstElement* t : tees) gst_object_unref(t);
                tees.clear();
                gst_iterator_resync(it);
                break;
            default: done = true; break;
        }
    }
    g_value_unset(&item);
    gst_iterator_free(it);

    std::string inserted;
    for (GstElement* tee : tees) {
        std::string name = GST_OBJECT_NAME(tee);
        auto [peer, sink] = egress_head(tee);
        if (!peer) {
            ipc::log(fmt("busStamp: %s has no upstream peer — not inserting mrtsstamp", name.c_str()));
            gst_object_unref(tee);
            continue;
        }
        GstElement* stamp = gst_element_factory_make("mrtsstamp", (std::string(ELEMENT_PREFIX) + name).c_str());
        if (!stamp) {
            ipc::log("busStamp: mrtsstamp factory missing — egress will NOT be stamped");
            gst_object_unref(peer);
            gst_object_unref(sink);
            gst_object_unref(tee);
            break;
        }
        GstObject* parent_obj = gst_object_get_parent(GST_OBJECT(tee));
        GstBin* parent = parent_obj && GST_IS_BIN(parent_obj) ? GST_BIN(parent_obj) : GST_BIN(pipe);
        gst_object_ref_sink(stamp);
        gst_bin_add(parent, stamp);
        GstPad* stamp_sink = gst_element_get_static_pad(stamp, "sink");
        GstPad* stamp_src = gst_element_get_static_pad(stamp, "src");
        bool ok = gst_pad_unlink(peer, sink) && gst_pad_link(peer, stamp_sink) == GST_PAD_LINK_OK &&
                  gst_pad_link(stamp_src, sink) == GST_PAD_LINK_OK;
        gst_object_unref(stamp_sink);
        gst_object_unref(stamp_src);
        if (!ok) {
            ipc::log(fmt("busStamp: could not splice mrtsstamp into %s — egress will NOT be stamped", name.c_str()));
            gst_bin_remove(parent, stamp);
            gst_object_unref(stamp);
            gst_pad_link(peer, sink);
        } else {
            gst_element_sync_state_with_parent(stamp);
            g_elements[name] = stamp;   // keep our ref
            if (!inserted.empty()) inserted += ", ";
            inserted += name;
        }
        if (parent_obj) gst_object_unref(parent_obj);
        gst_object_unref(peer);
        gst_object_unref(sink);
        gst_object_unref(tee);
    }
    if (!inserted.empty()) ipc::log("busStamp: native stamper inserted on " + inserted);
}

bool is_armed(const std::string& tee) {
    for (const std::string& t : g_armed)
        if (t == tee) return true;
    return false;
}

// --- drift report -----------------------------------------------------------

struct Drift {
    gint64 ppm = 0, ppb = 0, slew_ns = 0, margin_ns = 0, engage_ns = 0, samples = 0, window = 0;
};

bool drift_stats(GstElement* el, Drift* d) {
    GstStructure* s = nullptr;
    g_object_get(el, "drift", &s, nullptr);
    if (!s) return false;
    gint ppm = 0, samples = 0, window = 0;
    gst_structure_get_int(s, "ppm", &ppm);
    gst_structure_get_int(s, "samples", &samples);
    gst_structure_get_int(s, "window", &window);
    gst_structure_get_int64(s, "slewNs", &d->slew_ns);
    gst_structure_get_int64(s, "marginNs", &d->margin_ns);
    gst_structure_get_int64(s, "engageNs", &d->engage_ns);
    d->ppm = ppm;
    d->samples = samples;
    d->window = window;
    // `ppb` arrived with the dead-band removal (#751); an older native reports
    // only the truncated ppm, which is the best it knows.
    if (!gst_structure_has_field(s, "ppb") || !gst_structure_get_int64(s, "ppb", &d->ppb)) d->ppb = d->ppm * 1000;
    gst_structure_free(s);
    return d->samples >= d->window;
}

gboolean report_drift(gpointer) {
    for (const std::string& tee : g_armed) {
        auto it = g_elements.find(tee);
        if (it == g_elements.end()) continue;
        Drift d;
        bool ready = drift_stats(it->second, &d);
        if (g_getenv("MR_RUNNER_DEBUG"))
            ipc::log(fmt("busStamp %s: drift tick samples=%lld window=%lld ppm=%lld ready=%d", tee.c_str(),
                         (long long)d.samples, (long long)d.window, (long long)d.ppm, (int)ready));
        if (!ready) continue;
        JsonObject* ev = ipc::event("timeline_drift");
        json_object_set_string_member(ev, "tee", tee.c_str());
        json_object_set_int_member(ev, "ppm", d.ppm);
        json_object_set_int_member(ev, "slewNs", d.slew_ns);
        json_object_set_int_member(ev, "marginNs", d.margin_ns);
        json_object_set_int_member(ev, "engageNs", d.engage_ns);
        json_object_set_int_member(ev, "samples", d.samples);
        json_object_set_int_member(ev, "window", d.window);
        json_object_set_int_member(ev, "ppb", d.ppb);
        json_object_set_string_member(
            ev, "message",
            fmt("egress %s drift %+lld ppm, margin %+.2f ms (engaged at %+.2f ms), anchor slewed %+.3f ms so far",
                tee.c_str(), (long long)d.ppm, d.margin_ns / 1e6, d.engage_ns / 1e6, d.slew_ns / 1e6).c_str());
        ipc::emit(ev);
        log_line(tee, fmt("drift %+.1f ppm, margin %+.2f ms (engaged at %+.2f ms), anchor slewed %+.3f ms",
                          d.ppb / 1000.0, d.margin_ns / 1e6, d.engage_ns / 1e6, d.slew_ns / 1e6));
    }
    return G_SOURCE_CONTINUE;
}

void start_drift_timer() {
    if (!g_drift_timer_id) g_drift_timer_id = g_timeout_add(DRIFT_REPORT_MS, report_drift, nullptr);
}

void stop_drift_timer() {
    if (g_drift_timer_id) {
        g_source_remove(g_drift_timer_id);
        g_drift_timer_id = 0;
    }
}

}  // namespace

// ---------------------------------------------------------------------------

void enable(GstElement* pipe, bool on, JsonNode* repair, gint64 condition_step_ms) {
    clear();
    g_enabled = on;
    g_pipeline = on ? pipe : nullptr;
    if (repair && JSON_NODE_HOLDS_VALUE(repair)) {
        GType t = json_node_get_value_type(repair);
        g_repair_latch = t == G_TYPE_BOOLEAN ? json_node_get_boolean(repair) : json_node_get_int(repair) != 0;
    }
    g_condition_step_ms = condition_step_ms > 0 ? condition_step_ms : 0;
    if (g_enabled && load_native()) insert_elements(pipe);
}

void arm(GstElement* tee, const std::string& name) {
    if (!g_enabled || !tee || is_armed(name)) return;
    auto it = g_elements.find(name);
    if (it == g_elements.end()) return;   // no spliced element (plugin missing / splice failed)
    GstElement* el = it->second;
    g_object_set(el, "repair-latch", (gboolean)g_repair_latch, nullptr);
    if (g_condition_step_ms > 0 && g_object_class_find_property(G_OBJECT_GET_CLASS(el), "condition-step-ms"))
        g_object_set(el, "condition-step-ms", (gint)g_condition_step_ms, nullptr);
    g_object_set(el, "active", TRUE, nullptr);
    ipc::log(fmt("busStamp: producer-stamped timeline armed on %s (first consumer edge, native mrtsstamp)",
                 name.c_str()));
    g_armed.push_back(name);
    start_drift_timer();
}

void release(const std::string& name) {
    if (!is_armed(name)) return;
    auto it = g_elements.find(name);
    if (it != g_elements.end()) g_object_set(it->second, "active", FALSE, nullptr);
    g_armed.erase(std::remove(g_armed.begin(), g_armed.end(), name), g_armed.end());
    if (g_armed.empty()) stop_drift_timer();
    std::string extra;
    if (it != g_elements.end()) {
        guint64 copies = 0;
        g_object_get(it->second, "copy-count", &copies, nullptr);
        extra = fmt(" (native, %llu non-writable buffers)", (unsigned long long)copies);
    }
    log_line(name, "last consumer edge detached — stamper disarmed" + extra);
}

void clear() {
    stop_drift_timer();
    for (const std::string& name : g_armed) {
        auto it = g_elements.find(name);
        if (it != g_elements.end()) g_object_set(it->second, "active", FALSE, nullptr);
    }
    g_armed.clear();
    g_enabled = false;
    g_pipeline = nullptr;
    // The elements belong to the pipeline being torn down; the loaded plugin
    // is process-global and stays loaded.
    for (auto& [name, el] : g_elements) gst_object_unref(el);
    g_elements.clear();
}

GstElement* element_for(const std::string& tee_name) {
    auto it = g_elements.find(tee_name);
    return it == g_elements.end() ? nullptr : it->second;
}

gint64 bytes_total(GstElement* el) {
    guint64 total = 0;
    g_object_get(el, "bytes-total", &total, nullptr);
    return (gint64)total;
}

bool is_stamper_message(const char* name) {
    return name && g_str_has_prefix(name, "mrtsstamp-");
}

// --- message translation (gst_stamp_events.handle_message) ------------------

namespace {
gint64 s_int(const GstStructure* s, const char* f) {
    gint64 v = 0;
    if (!gst_structure_get_int64(s, f, &v)) {
        gint i = 0;
        if (gst_structure_get_int(s, f, &i)) v = i;
    }
    return v;
}
std::string s_str(const GstStructure* s, const char* f) {
    const gchar* v = gst_structure_get_string(s, f);
    return v ? v : "";
}
}  // namespace

void handle_message(const char* src_name, const char* kind, const GstStructure* s) {
    if (!src_name || !g_str_has_prefix(src_name, ELEMENT_PREFIX) || !s) return;
    std::string tee = src_name + std::strlen(ELEMENT_PREFIX);

    if (std::strcmp(kind, "mrtsstamp-segment-warning") == 0 || std::strcmp(kind, "mrtsstamp-map-failed") == 0) {
        std::string why = s_str(s, "why");
        ipc::warning(fmt("egress %s: %s — the house-clock stamp cannot be mapped onto running time, so consumers "
                         "may see shifted timing (time-sync contract, ADR-0005)",
                         tee.c_str(), why.c_str()));
        log_line(tee, why + (std::strcmp(kind, "mrtsstamp-map-failed") == 0
                                 ? " — buffer passed through with source timing"
                                 : " — stamp written unmapped"));
        return;
    }
    if (std::strcmp(kind, "mrtsstamp-conditioned") == 0) {
        gint64 pid = s_int(s, "pid"), step = s_int(s, "stepTicks"), offset = s_int(s, "offsetTicks");
        std::string clock = s_str(s, "clock");
        JsonObject* ev = ipc::event("timeline_conditioned");
        json_object_set_string_member(ev, "tee", tee.c_str());
        json_object_set_int_member(ev, "pid", pid);
        json_object_set_string_member(ev, "clock", clock.c_str());
        json_object_set_int_member(ev, "stepTicks", step);
        json_object_set_int_member(ev, "offsetTicks", offset);
        json_object_set_int_member(ev, "houseNs", s_int(s, "houseNs"));
        ipc::emit(ev);
        std::string upper = clock;
        for (char& c : upper) c = (char)g_ascii_toupper(c);
        log_line(tee, fmt("absorbed a %+.2fs %s step on pid 0x%llx (timeline offset now %+.2fs) — the source reset "
                          "its clock, the wire stayed continuous",
                          step / 90000.0, upper.c_str(), (unsigned long long)pid, offset / 90000.0));
        return;
    }
    if (std::strcmp(kind, "mrtsstamp-settled") == 0) {
        gint64 anchor = s_int(s, "anchorNs"), repair = s_int(s, "repairNs"), window = s_int(s, "windowNs");
        JsonObject* ev = ipc::event("timeline_settled");
        json_object_set_string_member(ev, "tee", tee.c_str());
        json_object_set_int_member(ev, "anchorNs", anchor);
        json_object_set_int_member(ev, "repairNs", repair);
        json_object_set_int_member(ev, "windowNs", window);
        json_object_set_string_member(
            ev, "message",
            fmt("egress %s latch settled: anchor pulled back %.3f ms by early delivery in the first %.0f s",
                tee.c_str(), -repair / 1e6, window / 1e9).c_str());
        ipc::emit(ev);
        log_line(tee, fmt("latch settled: anchor pulled back %.3f ms by early delivery in the first %.0f s (anchor=%lld)",
                          -repair / 1e6, window / 1e9, (long long)anchor));
        return;
    }
    gint64 pid = s_int(s, "pid"), anchor = s_int(s, "anchorNs"), ref = s_int(s, "refPts90k");
    if (std::strcmp(kind, "mrtsstamp-anchor") == 0) {
        JsonObject* ev = ipc::event("timeline_restamped");
        json_object_set_string_member(ev, "tee", tee.c_str());
        json_object_set_int_member(ev, "pid", pid);
        json_object_set_int_member(ev, "anchorNs", anchor);
        json_object_set_int_member(ev, "refPts90k", ref);
        json_object_set_string_member(
            ev, "message",
            fmt("egress %s stamped onto the house timeline (anchor %lld ns, first PES %lld on pid 0x%llx)",
                tee.c_str(), (long long)anchor, (long long)ref, (unsigned long long)pid).c_str());
        ipc::emit(ev);
        log_line(tee, fmt("anchored: house=%lld ns, firstPes=%lld on pid 0x%llx", (long long)anchor, (long long)ref,
                          (unsigned long long)pid));
        return;
    }
    if (std::strcmp(kind, "mrtsstamp-reanchor") == 0) {
        gint64 last = s_int(s, "lastPts90k"), delta = s_int(s, "deltaTicks"), count = s_int(s, "count");
        JsonObject* ev = ipc::event("timeline_reanchor");
        json_object_set_string_member(ev, "tee", tee.c_str());
        json_object_set_int_member(ev, "pid", pid);
        json_object_set_int_member(ev, "anchorNs", anchor);
        json_object_set_int_member(ev, "refPts90k", ref);
        json_object_set_int_member(ev, "count", count);
        json_object_set_string_member(
            ev, "message",
            fmt("source timeline discontinuity on pid 0x%llx (%lld -> %lld, %+.2fs) — re-anchored egress %s in place",
                (unsigned long long)pid, (long long)last, (long long)ref, delta / 90000.0, tee.c_str()).c_str());
        ipc::emit(ev);
        log_line(tee, fmt("re-anchored on pid 0x%llx (%+.2fs jump), anchor=%lld ref=%lld (#%lld)",
                          (unsigned long long)pid, delta / 90000.0, (long long)anchor, (long long)ref,
                          (long long)count));
        return;
    }
    // `mrtsstamp-drift` is polled from the `drift` property on the report
    // timer (same cadence as the python runner); the message form is ignored.
}

}  // namespace mr::stamper
