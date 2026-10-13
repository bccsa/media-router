#include "lateness_tap.h"

#include <gst/gst.h>

#include <string>
#include <vector>

#include "ipc.h"
#include "paths.h"

namespace mr::lateness {

namespace {
int g_loaded = -1;   // -1 not tried, 0 missing, 1 loaded
}  // namespace

bool load_plugin() {
    if (g_loaded >= 0) return g_loaded == 1;
    g_loaded = 0;
    if (gst_element_factory_find(MESSAGE)) {
        g_loaded = 1;
        return true;
    }
    const std::string so = "libgstmrlateness.so";
    std::string tried;
    for (const std::string& path : paths::asset_candidates("mpegts-core", "mrlateness", so)) {
        if (!tried.empty()) tried += ", ";
        tried += path;
        if (!g_file_test(path.c_str(), G_FILE_TEST_EXISTS)) continue;
        GError* err = nullptr;
        GstPlugin* plugin = gst_plugin_load_file(path.c_str(), &err);
        if (!plugin) {
            ipc::log("mrlateness: plugin at " + path + " failed to load (" +
                     (err && err->message ? err->message : "?") + ")");
            g_clear_error(&err);
            continue;
        }
        gst_object_unref(plugin);
        g_loaded = 1;
        return true;
    }
    // The engine leaves the taps out of its strings in this case too.
    ipc::log("mrlateness: no " + so + " found (" + tried + ") — no lateness reported");
    return false;
}

}  // namespace mr::lateness
