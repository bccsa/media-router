// Per-consumer bus fan-out edges (`bus_attach` / `bus_detach` / `bus_reinput`)
// — the native port of the runner's `_try_bus_attach` family. Every property,
// ordering and probe in here is load-bearing; the rationale for each is in
// gst-pipeline-runner.py (gate01 wedges of 2026-07-16/17/21) and is kept as
// short pointers here rather than repeated.
#pragma once

#include <gst/gst.h>
#include <json-glib/json-glib.h>

#include <string>

namespace mr::bus {

/** gst-launch description of one per-consumer fan-out branch
 *  (`queue leaky=2 … ! unixfdsink socket-path=…`). */
std::string edge_branch_description(const std::string& socket);

void handle_bus_attach(JsonObject* data);
void handle_bus_detach(JsonObject* data);
void handle_bus_reinput(JsonObject* data);

/** Drop queued attaches and mid-teardown marks (pipeline stop). */
void clear_pending();

/** Tear down one branch by edge socket (probe-gated, asynchronous). True when
 *  it existed. */
bool teardown_branch(const std::string& socket);

/** Nearest `busedge_*` branch bin above a message source (owned ref), or nullptr. */
GstObject* busedge_ancestor(GstObject* obj);

/** The edge socket owning a branch bin, or "". */
std::string socket_for_busedge(GstObject* edge_bin);

}  // namespace mr::bus
