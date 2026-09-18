#include "hooks.h"

#include <dlfcn.h>
#include <glib.h>
#include <glib/gstdio.h>
#include <map>
#include <vector>

#include "ipc.h"
#include "json_util.h"
#include "mr_hook.h"
#include "paths.h"
#include "runner.h"

namespace mr::hooks {

namespace {

struct Loaded {
    std::string module;
    void* handle = nullptr;
    void (*clear_fn)() = nullptr;
};

std::vector<Loaded> g_loaded;

/** Every plugin under `root` shipping `file`: plugin name → path. Under the
 *  plugins tree the asset sits in `<plugin>/native/<tool>/`, under libexec in
 *  `<plugin>/`. A plugin already in `into` (seen in an earlier root) is kept. */
void scan_plugins(const std::string& root, const std::string& file, bool native_subdirs,
                  std::map<std::string, std::string>* into) {
    GDir* dir = g_dir_open(root.c_str(), 0, nullptr);
    if (!dir) return;
    const gchar* plugin;
    while ((plugin = g_dir_read_name(dir))) {
        if (into->count(plugin)) continue;
        gchar* base = g_build_filename(root.c_str(), plugin, native_subdirs ? "native" : nullptr, nullptr);
        if (!native_subdirs) {
            gchar* p = g_build_filename(base, file.c_str(), nullptr);
            if (g_file_test(p, G_FILE_TEST_IS_REGULAR)) (*into)[plugin] = p;
            g_free(p);
        } else if (GDir* nd = g_dir_open(base, 0, nullptr)) {
            const gchar* tool;
            while (!into->count(plugin) && (tool = g_dir_read_name(nd))) {
                gchar* p = g_build_filename(base, tool, file.c_str(), nullptr);
                if (g_file_test(p, G_FILE_TEST_IS_REGULAR)) (*into)[plugin] = p;
                g_free(p);
            }
            g_dir_close(nd);
        }
        g_free(base);
    }
    g_dir_close(dir);
}

// --- ctx callbacks -------------------------------------------------------------

void cb_emit_event(void*, const char* json) {
    if (!json) return;
    std::string err;
    JsonObject* o = json_parse_object(json, &err);
    if (!o) {
        ipc::warning("runner hook emitted malformed event JSON: " + err);
        return;
    }
    ipc::emit(o);   // takes ownership
}

void cb_emit_plugin_event(void*, const char* channel, const char* payload_json) {
    if (!channel) return;
    JsonParser* parser = json_parser_new();
    JsonNode* payload = nullptr;
    if (payload_json && json_parser_load_from_data(parser, payload_json, -1, nullptr)) {
        JsonNode* root = json_parser_get_root(parser);
        if (root) payload = json_node_copy(root);
    }
    g_object_unref(parser);
    if (!payload) payload = json_node_new(JSON_NODE_NULL);
    runner().emit_plugin_event(channel, payload);
}

void cb_log(void*, const char* line) {
    if (line) ipc::log(line);
}

const MrHookCtx g_ctx = {nullptr, cb_emit_event, cb_emit_plugin_event, cb_log};

}  // namespace

std::string resolve(const std::string& module, std::string* problem) {
    std::string file = "libmrhook_" + module + ".so";
    if (module.empty() || module.find('/') != std::string::npos) {
        if (problem) *problem = "has no native form (" + file + ")";
        return "";
    }
    // Same rule as nativeBinaries.ts / resolveNativeHook: one match per
    // owning plugin (the deployed tree preferred over the libexec install),
    // and two plugins shipping the same hook name is a packaging fault that
    // fails loud — never first-in-directory-order wins.
    std::map<std::string, std::string> matches;
    scan_plugins(paths::plugins_root(), file, true, &matches);
    scan_plugins(paths::libexec_root(), file, false, &matches);
    if (matches.empty()) {
        if (problem) *problem = "has no native form (" + file + ")";
        return "";
    }
    if (matches.size() > 1) {
        std::string owners;
        for (const auto& [plugin, path] : matches) owners += (owners.empty() ? "" : ", ") + plugin;
        if (problem) *problem = "is ambiguous — " + owners + " all ship " + file;
        return "";
    }
    return matches.begin()->second;
}

bool install(GstElement* pipe, JsonArray* hooks) {
    clear();
    if (!hooks) return true;
    guint n = json_array_get_length(hooks);
    for (guint i = 0; i < n; i++) {
        JsonNode* node = json_array_get_element(hooks, i);
        if (!JSON_NODE_HOLDS_OBJECT(node)) continue;
        JsonObject* hook = json_node_get_object(node);
        std::string module = json_get_string(hook, "module");
        if (module.empty()) continue;
        std::string problem;
        std::string path = resolve(module, &problem);
        if (path.empty()) {
            JsonObject* ev = ipc::event("error");
            json_object_set_string_member(ev, "kind", "unsupported");
            json_object_set_string_member(
                ev, "message",
                ("runner hook '" + module + "' " + problem +
                 " — the engine must host this pipeline on the python runner")
                    .c_str());
            ipc::emit(ev);
            return false;
        }
        void* h = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
        if (!h) {
            ipc::warning("runner hook '" + module + "' failed to load: " + (dlerror() ? dlerror() : "?"));
            continue;
        }
        auto abi = reinterpret_cast<int (*)()>(dlsym(h, "mr_hook_abi"));
        auto inst = reinterpret_cast<int (*)(GstElement*, const char*, const MrHookCtx*)>(dlsym(h, "mr_hook_install"));
        auto clr = reinterpret_cast<void (*)()>(dlsym(h, "mr_hook_clear"));
        if (!abi || !inst || !clr || abi() != MR_HOOK_ABI) {
            ipc::warning("runner hook '" + module + "' at " + path + " is not a hook (ABI " +
                         std::to_string(abi ? abi() : -1) + ", runner " + std::to_string(MR_HOOK_ABI) + ")");
            dlclose(h);
            continue;
        }
        std::string config = "null";
        if (json_has(hook, "config")) {
            JsonGenerator* gen = json_generator_new();
            json_generator_set_root(gen, json_object_get_member(hook, "config"));
            gchar* s = json_generator_to_data(gen, nullptr);
            config = s ? s : "null";
            g_free(s);
            g_object_unref(gen);
        }
        int rc = inst(pipe, config.c_str(), &g_ctx);
        if (rc != 0) {
            ipc::warning("runner hook '" + module + "' failed: install returned " + std::to_string(rc));
            clr();
            dlclose(h);
            continue;
        }
        ipc::log("runner hook '" + module + "' installed (" + path + ")");
        g_loaded.push_back({module, h, clr});
    }
    return true;
}

void clear() {
    for (Loaded& l : g_loaded) {
        if (l.clear_fn) l.clear_fn();
        // Keep the .so mapped: GStreamer may still hold callbacks into it
        // until the pipeline is gone, and the process exits right after.
    }
    g_loaded.clear();
}

}  // namespace mr::hooks
