// A PipeWire capture's streaming tasks at real-time priority (B-111): each task from a
// `pipewiresrc` down to its mux runs SCHED_RR, granted by rtkit as module-rt's data loop is.
#pragma once

#include <gst/gst.h>

namespace mr::capture_rt {

/** Below PipeWire's data loops (RR 20, rtkit's maximum): a cycle always preempts the capture. */
constexpr int PRIORITY = 19;
/** The RLIMIT_RTTIME bound, µs: rtkit's RTTimeUSecMax, the limit module-rt sets (B-88). */
constexpr long RTTIME_US = 200000;
/** How long a request waits for rtkit's answer before it counts as refused. */
constexpr int TIMEOUT_MS = 5000;

/** Mark every element from each `pipewiresrc` down to its first muxer, and ask rtkit for each
 *  of their tasks as it enters. Before PLAYING; a pipeline without a `pipewiresrc` asks nothing. */
void install(GstElement* pipe);
void clear();

}  // namespace mr::capture_rt
