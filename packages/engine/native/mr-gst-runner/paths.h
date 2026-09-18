// Where the runner finds plugin-shipped native assets (ADR-0003): the deployed
// plugins tree first (`MR_PLUGINS_DIR`, else derived from the binary's own
// location), then the packaged libexec install (`MR_LIBEXEC_DIR`, else
// /usr/libexec/media-router). Never GST_PLUGIN_PATH / LD_LIBRARY_PATH. One
// definition for the stamper, the mrrist loader and the hook loader.
#pragma once

#include <string>
#include <vector>

namespace mr::paths {

/** Directory of the running binary (`/proc/self/exe`), "." when unknown. */
std::string exe_dir();

/** `MR_PLUGINS_DIR`, else `<exe_dir>/../../../../plugins`
 *  (packages/engine/native/mr-gst-runner → repo root → plugins). */
std::string plugins_root();

/** `MR_LIBEXEC_DIR`, else `/usr/libexec/media-router`. */
std::string libexec_root();

/** The candidate paths of `<plugin>`'s native asset `<file>` built by tool
 *  `<tool>`, in resolution order: `plugins/<plugin>/native/<tool>/<file>`,
 *  then `libexec/<plugin>/<file>`. Existence is the caller's check. */
std::vector<std::string> asset_candidates(const std::string& plugin, const std::string& tool,
                                          const std::string& file);

}  // namespace mr::paths
