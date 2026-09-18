// Backlog shedder (`backlogShed`) — the time-sync contract's latency ratchet
// guard, the native port of `_start_backlog_shedder` + `backlog_shed.py`.
//
// A `sync=true` sink drains at media rate, so backlog the leaky queues absorb
// during a hiccup is retained for ever. Per buffer at the shed point:
//     lateness = now_running_time − (buffer_running_time + ts_offset + latency)
// Sustained excess over `toleranceMs` for `holdMs`, with data actually queued
// upstream, opens an episode: buffers are DROPPED until one is back inside
// budget (and, on a keyframe-aligned leg, is an IRAP). Rate-limited by
// `cooldownMs`; a reading past `sanityMs` is a timeline mismatch and is
// reported, never acted on. Video sheds arm a post-shed stall watch on the
// decoder's output (flush, then bus ERROR). Events, log lines and every
// number are the python's.
#pragma once

#include <gst/gst.h>
#include <json-glib/json-glib.h>

namespace mr::shed {

/** `cfg` = the BacklogShedConfig object or nullptr. False on a hard error
 *  (element / sink not found) — the caller tears the pipeline down. */
bool start(GstElement* pipe, JsonObject* cfg);

void stop();

/** The window's retained-latency reading for the render watch: adds
 *  latenessMs / retainedMs / budgetMs / shedding / shedCount to `into` when
 *  a shedder is armed and its last sample is fresh (consumes the window
 *  floor); leaves `into` untouched otherwise. */
void window_into(double now_ms, JsonObject* into);

}  // namespace mr::shed
