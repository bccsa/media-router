#include "stamper.h"

#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <map>
#include <set>
#include <vector>

#include "ipc.h"
#include "native_plugins.h"
#include "paths.h"
#include "runner.h"

namespace mr::stamper {

namespace {

bool g_enabled = false;
GstElement* g_pipeline = nullptr;
int g_native_loaded = -1;          // -1 not tried, 0 failed, 1 loaded
std::map<std::string, GstElement*> g_elements;   // tee name -> spliced mrtsstamp (owned ref)
std::vector<std::string> g_armed;                 // tee names armed
std::set<std::string> g_skip;                     // armed tees whose next egress window is dropped

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

/** Candidate paths for the stamper plugin: the deployed plugins tree, then the install root
 *  (paths.h). Mirrors `gst_stamp_native.so_paths`; never GST_PLUGIN_PATH. */
std::vector<std::string> so_paths() {
    return paths::asset_candidates("mpegts-core", "mrtsstamp", "libgstmrtsstamp.so");
}

/** Once per process. A miss is rule 6: the alarm, no fallback, the egress runs unstamped. */
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
            tried += std::string(" (") + (err && err->message ? err->message : "failed") + ")";
            g_clear_error(&err);
            continue;
        }
        ipc::log(fmt("busStamp: native stamper loaded (mrtsstamp %s from %s)", gst_plugin_get_version(plugin),
                     path.c_str()));
        gst_object_unref(plugin);
        g_native_loaded = 1;
        return true;
    }
    native_plugins::alarm("warning", "libgstmrtsstamp.so not loaded, tried " + tried);
    return false;
}

/** The link at the head of `tee`'s egress chain (upstream src pad, downstream
 *  sink pad), walking up through capssetter/capsfilter/mrlateness. Both returned refs are
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
        // The lateness tap sits behind the stamp too: it must read stamped PTS.
        if (fname != "capssetter" && fname != "capsfilter" && fname != "mrlateness") {
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

/** Every `busout_*` tee of `pipe`, as owned refs. */
std::vector<GstElement*> busout_tees(GstElement* pipe) {
    std::vector<GstElement*> tees;
    if (!GST_IS_BIN(pipe)) return tees;
    // Collect first, splice second: adding elements invalidates a live iterator.
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
    return tees;
}

void insert_elements(GstElement* pipe, const std::vector<GstElement*>& tees) {
    std::string inserted;
    for (GstElement* tee : tees) {
        std::string name = GST_OBJECT_NAME(tee);
        auto [peer, sink] = egress_head(tee);
        if (!peer) {
            ipc::log(fmt("busStamp: %s has no upstream peer — not inserting mrtsstamp", name.c_str()));
            continue;
        }
        GstElement* stamp = gst_element_factory_make("mrtsstamp", (std::string(ELEMENT_PREFIX) + name).c_str());
        if (!stamp) {
            ipc::log("busStamp: mrtsstamp factory missing — egress will NOT be stamped");
            gst_object_unref(peer);
            gst_object_unref(sink);
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
    }
    if (!inserted.empty()) ipc::log("busStamp: native stamper inserted on " + inserted);
}

bool is_armed(const std::string& tee) {
    for (const std::string& t : g_armed)
        if (t == tee) return true;
    return false;
}

}  // namespace

// ---------------------------------------------------------------------------

void enable(GstElement* pipe) {
    clear();
    g_enabled = true;
    g_pipeline = pipe;
    std::vector<GstElement*> tees = busout_tees(pipe);
    // No bus egress, nothing to stamp: the plugin is neither loaded nor missed.
    if (!tees.empty() && load_native()) insert_elements(pipe, tees);
    for (GstElement* t : tees) gst_object_unref(t);
}

bool missing() { return g_native_loaded == 0; }

void arm(GstElement* tee, const std::string& name) {
    if (!g_enabled || !tee || is_armed(name)) return;
    auto it = g_elements.find(name);
    if (it == g_elements.end()) return;   // no spliced element (plugin missing / splice failed)
    g_object_set(it->second, "active", TRUE, nullptr);
    ipc::log(fmt("busStamp: identity egress armed on %s (PES - 1 h, native mrtsstamp)", name.c_str()));
    g_armed.push_back(name);
    g_skip.insert(name);
}

void release(const std::string& name) {
    if (!is_armed(name)) return;
    auto it = g_elements.find(name);
    if (it != g_elements.end()) g_object_set(it->second, "active", FALSE, nullptr);
    g_armed.erase(std::remove(g_armed.begin(), g_armed.end(), name), g_armed.end());
    g_skip.erase(name);
    std::string extra;
    if (it != g_elements.end()) {
        guint64 copies = 0;
        g_object_get(it->second, "copy-count", &copies, nullptr);
        extra = fmt(" (native, %llu non-writable buffers)", (unsigned long long)copies);
    }
    log_line(name, "last consumer edge detached — stamper disarmed" + extra);
}

void clear() {
    for (const std::string& name : g_armed) {
        auto it = g_elements.find(name);
        if (it != g_elements.end()) g_object_set(it->second, "active", FALSE, nullptr);
    }
    g_armed.clear();
    g_skip.clear();
    g_enabled = false;
    g_pipeline = nullptr;
    // The elements belong to the pipeline being torn down; the loaded plugin
    // is process-global and stays loaded.
    for (auto& [name, el] : g_elements) gst_object_unref(el);
    g_elements.clear();
}

bool take_egress_window(const std::string& tap) {
    // `lat_busout_<port>` taps `busout_<port>`; the first window after its arm is dropped.
    const std::string tee = tap.size() > 4 ? tap.substr(4) : std::string();
    if (!is_armed(tee)) return false;
    return g_skip.erase(tee) == 0;
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

// --- messages (gst_stamp_events.handle_message) ------------------------------

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

    if (std::strcmp(kind, "mrtsstamp-identity") == 0) {
        log_line(tee, fmt("identity egress: first PES pid=0x%llx stamp=%lld pts=%lld",
                          (unsigned long long)s_int(s, "pid"), (long long)s_int(s, "stamp"),
                          (long long)s_int(s, "pts")));
        return;
    }
    if (std::strcmp(kind, "mrtsstamp-segment-warning") == 0 || std::strcmp(kind, "mrtsstamp-map-failed") == 0) {
        std::string why = s_str(s, "why");
        ipc::warning(fmt("egress %s: %s — the house-clock stamp cannot be mapped onto running time, so consumers "
                         "may see shifted timing (time-sync contract, ADR-0005)",
                         tee.c_str(), why.c_str()));
        log_line(tee, why + (std::strcmp(kind, "mrtsstamp-map-failed") == 0
                                 ? " — buffer passed through with source timing"
                                 : " — stamp written unmapped"));
    }
}

}  // namespace mr::stamper
