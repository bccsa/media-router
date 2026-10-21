// The house-clock plugin loader (plan ch. 3 WI-S0-8), twin of gst_native_plugins.py: one load
// by path with an ABI check before the parse; on a miss or a stale ABI the plugin's elements get
// stand-ins, or the start is refused where none exists (part 4.5 rule 6).
#pragma once

#include <json-glib/json-glib.h>

#include <string>
#include <vector>

namespace mr::native_plugins {

/** The element protocol this runner speaks; a plugin below it is refused (part 4.5 rule 4).
 *  Bumped with mrtshouse_abi.h; equal to gst_native_plugins.py's. */
constexpr int MRTSHOUSE_MIN_ABI = 1;

/** Part 4.5 rule 6's alarm; the engine shows the same sentence (timingPluginAlarm.ts). */
constexpr const char* ALARM =
    "Native TS module not loaded: this stream carries no house time on the bus; consumers "
    "will mis-time it until the deploy is fixed.";

/** Load the table's plugins once per process: a log line each, or for a required row that
 *  misses or is below its ABI a `warning` event of kind `timing_plugin`. */
void load();

/** The rule-6 event (`warning` or `error`) of kind `timing_plugin`: `ALARM (detail)` and
 *  `detail`; the engine keys on `kind`. The stamper raises it too (stamper.cpp). */
void alarm(const char* event, const std::string& detail);

/** The `started` event's `timingPlugin`: `{version, abi, path}` or null. The engine clears the
 *  alarm on a start that carries one. A new node, owned by the caller. */
JsonNode* timing_plugin_json();

/** Give `*desc` stand-ins for the plugins `load` could not use. False when it names an element
 *  that has none: the `error` event is out and the start stops there. */
bool stand_in(std::string* desc);

/** A name a stand-in took over: its `set_property` is answered with a warning. */
bool is_stand_in(const std::string& element);

/** `bus_input_add`'s parse failure as a `command_error`: when `desc` names an element of a
 *  plugin `load` could not use, `message` gains the rule-6 alarm and the load detail, with
 *  `kind` and `detail`. Live adds are never stood in (B-17); the module keeps running. */
void refuse_live_add(const std::string& req_id, const std::string& desc,
                     const std::string& message);

/** An element a plugin provides; `stand_in` nullptr: none, the module cannot start. */
struct Factory {
    const char* name;
    const char* stand_in;
};

/** The rewrite alone, on gst-launch tokens, so a factory name inside a quoted value, caps or a
 *  `name=` never matches. `refused` is the first element without a stand-in (`desc` empty). */
struct Rewrite {
    std::string desc;
    std::vector<std::string> names;
    std::string refused;
};
Rewrite rewrite(const std::string& desc, const std::vector<Factory>& table);

}  // namespace mr::native_plugins
