// A network ingest's queue sheds only when its output stops draining past its bound (B-182):
// each buffer that meets it full (`overrun`) is counted, and each episode is one `queue_shed`
// plugin event. Queues named `ingestq…` (tsHelpers.ts `buildIngestQueue`).
#pragma once

#include <gst/gst.h>

namespace mr::shed_watch {

/** tsHelpers.ts INGEST_QUEUE_NAME: every queue whose name starts with it is watched. */
constexpr const char* PREFIX = "ingestq";
/** tsHelpers.ts QUEUE_SHED_EVENT. */
constexpr const char* EVENT = "queue_shed";
/** An episode ends after this long without an overrun. */
constexpr int QUIET_MS = 1000;
/** An episode still open this long is reported once as it stands, then again when it ends. */
constexpr int LONG_MS = 10000;
constexpr int TICK_MS = 250;

/** Before PLAYING: connect every such queue of `pipe`. */
void install(GstElement* pipe);
/** Once `pipe` is in NULL (no streaming thread left): report an open episode, then forget. */
void clear();

}  // namespace mr::shed_watch
