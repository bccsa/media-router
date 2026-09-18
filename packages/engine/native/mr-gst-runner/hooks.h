// Plugin runner hooks in their native form (mr_hook.h, ADR-0020): resolve
// `libmrhook_<module>.so` the way every native asset is resolved (the plugins
// tree, then the libexec install), dlopen it, install before PLAYING, clear
// on stop.
#pragma once

#include <gst/gst.h>
#include <json-glib/json-glib.h>

#include <string>

namespace mr::hooks {

/** Path of the native form of hook `module`, or "" when none exists or
 *  more than one plugin ships it; `problem` (optional) then says which. */
std::string resolve(const std::string& module, std::string* problem = nullptr);

/** Install every entry of `hooks` (the start payload's `runnerHooks`, may be
 *  nullptr). Returns false — after emitting an `error` — when a module has
 *  no native form: the engine's eligibility check should have kept this
 *  pipeline on python, so that is a loud misconfiguration, not a fallback.
 *  A hook that loads but fails to install is a warning (python semantics). */
bool install(GstElement* pipe, JsonArray* hooks);

/** `mr_hook_clear` on every installed hook, then unload. */
void clear();

}  // namespace mr::hooks
