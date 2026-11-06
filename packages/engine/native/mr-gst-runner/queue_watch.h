// The queue watch (B-170, B-182's shed count grown): every leaky queue and the outputs' named ones
// count each buffer that meets them full (`overrun`); each episode is one `queue_overrun` event.
// Twin: gst-pipeline-runner.py `_start_queue_watch`.
#pragma once

#include <gst/gst.h>

namespace mr::queue_watch {

/** queueOverrun.ts QUEUE_OVERRUN_EVENT. */
constexpr const char* EVENT = "queue_overrun";
/** queueOverrun.ts WATCHED_QUEUE_NAMES: watched though not leaky. */
constexpr const char* NAMES[] = {"vp_esq", "ad_esq", "prefill"};
/** An episode ends after this long without an overrun. */
constexpr int QUIET_MS = 1000;
/** An episode still open this long is reported once as it stands, then again when it ends. */
constexpr int LONG_MS = 10000;
constexpr int TICK_MS = 250;

/** Before PLAYING: watch every such queue of `pipe`, and each one added to it later. */
void install(GstElement* pipe);
/** Once `pipe` is in NULL (no streaming thread left): report each open episode, then forget. */
void clear();

}  // namespace mr::queue_watch
