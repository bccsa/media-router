// A launch's catch-up (B-206): what an input delivers stamped before the pipeline first plays is
// the outage it was down for (its edge's backlog, a stalled mix's burst). It is skipped at the
// elements the module names (an output: each input's ingress tap), never played late, reported once.
#pragma once

#include <gst/gst.h>
#include <json-glib/json-glib.h>

namespace mr::catchup {

/** Plugin-event channel (engine `catchUp.ts` CATCH_UP_EVENT). */
constexpr const char* EVENT = "catch_up";
/** The launch's inputs report together once all of them delivered, or this long after its first
 *  buffer with those that did; one that delivers later reports alone. */
constexpr int REPORT_MS = 3000;

/** `cfg` = {"prefix": name prefix} or nullptr. The SINK pad of every element whose name starts
 *  with the prefix, the launch's and any added later, drops the buffers and GAPs that end before
 *  the launch's first buffer there, until one does not or they come as a live stream. */
void install(GstElement* pipe, JsonObject* cfg);
/** Forget the launch (main loop; the pipeline is in NULL). */
void clear();

}  // namespace mr::catchup
