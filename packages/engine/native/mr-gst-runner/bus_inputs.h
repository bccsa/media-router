// Live input branches on a running aggregator: `bus_input_add` /
// `bus_input_remove` (native form of the python runner's handlers). The set
// of live branch bins is also the error-containment boundary: a fault inside
// one drops that branch (`input_branch_lost`) instead of the pipeline.
#pragma once

#include <gst/gst.h>
#include <json-glib/json-glib.h>

#include <string>

namespace mr::inputs {

/** `{element, name, description}` → bin linked to a request pad. Idempotent. */
void handle_bus_input_add(JsonObject* data);

/** `{element, name}` → bin stopped, unlinked, dropped. Idempotent. */
void handle_bus_input_remove(JsonObject* data);

/** The start payload's `liveInputBranches` (replaces the set). */
void declare(JsonArray* names);

/** Pipeline stop: forget every branch name. */
void clear();

/** Whether `name` is a live input branch bin. */
bool is_live_branch(const std::string& name);

/** Nearest live branch bin above a message source, by name; "" if none. */
std::string live_branch_ancestor(GstObject* obj);

/** Drop a live branch by name. True when it existed. */
bool drop_branch(const std::string& name);

}  // namespace mr::inputs
