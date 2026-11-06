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
/** The render point keeps what is this much later than its inputs were when they first kept. */
constexpr gint64 RENDER_SLACK_NS = 200 * GST_MSECOND;

/** `cfg` = {"prefix", "render"?} or nullptr. Each prefixed element's SINK pad (any added later too)
 *  drops what ends before the launch's first buffer there, until one does not or it streams; the
 *  render element's, once, before its own first less the inputs' most lag and RENDER_SLACK_NS. */
void install(GstElement* pipe, JsonObject* cfg);
/** Forget the launch (main loop; the pipeline is in NULL). */
void clear();

}  // namespace mr::catchup
