// The `mrlateness` tap (house-clock plan WI-P0-8): loaded by path at runner
// start, because bus fragments and later `bus_input_add` branches may name it.
#pragma once

namespace mr::lateness {

/** Load `libgstmrlateness.so` once per process (never GST_PLUGIN_PATH); one
 *  log line when it is missing. True when `mrlateness` is registered. */
bool load_plugin();

/** The plugin-event channel prefix and the element message name. */
constexpr const char* MESSAGE = "mrlateness";

}  // namespace mr::lateness
