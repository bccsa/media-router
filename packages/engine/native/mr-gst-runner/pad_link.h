// Dynamic pad linking (`linkOnPadAdded` rules) and stream discovery — the
// native port of `_install_pad_link_rule`, `_link_pad_to_branches_via_tee`,
// `_parser_prefix_for_pad` and `_install_stream_discovery`. Same rule shape
// (PluginModule.ts `PadLinkRule`), same events (`pad_linked`, warnings,
// errors), same `stream:discovered` plugin event. The `meta/x-klv` name
// reader (`readKlvNames`) is not ported: no module sets it.
#pragma once

#include <gst/gst.h>
#include <json-glib/json-glib.h>

#include <string>

namespace mr::padlink {

/** Reset the per-run pad counters and install every rule of `rules`. Also
 *  installs stream discovery once per distinct `from` element. */
void install(GstElement* pipe, JsonArray* rules);

/** Drop handlers (pipeline stop). */
void clear();

/** Parser element string for a pad's caps ("" = parser-free), or false when
 *  the codec is not in the table. Exposed for the gates' shared use. */
bool parser_for_caps(GstCaps* caps, std::string* out);

}  // namespace mr::padlink
