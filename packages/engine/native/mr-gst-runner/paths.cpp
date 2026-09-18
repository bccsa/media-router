#include "paths.h"

#include <glib.h>
#include <unistd.h>

namespace mr::paths {

std::string exe_dir() {
    char buf[4096];
    ssize_t n = readlink("/proc/self/exe", buf, sizeof buf - 1);
    if (n <= 0) return ".";
    buf[n] = 0;
    gchar* dir = g_path_get_dirname(buf);
    std::string out = dir;
    g_free(dir);
    return out;
}

std::string plugins_root() {
    const char* env = g_getenv("MR_PLUGINS_DIR");
    if (env && *env) return env;
    gchar* p = g_build_filename(exe_dir().c_str(), "..", "..", "..", "..", "plugins", nullptr);
    gchar* canon = g_canonicalize_filename(p, nullptr);
    std::string out = canon;
    g_free(canon);
    g_free(p);
    return out;
}

std::string libexec_root() {
    const char* env = g_getenv("MR_LIBEXEC_DIR");
    return env && *env ? env : "/usr/libexec/media-router";
}

std::vector<std::string> asset_candidates(const std::string& plugin, const std::string& tool,
                                          const std::string& file) {
    return {plugins_root() + "/" + plugin + "/native/" + tool + "/" + file,
            libexec_root() + "/" + plugin + "/" + file};
}

}  // namespace mr::paths
