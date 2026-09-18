// Multi-branch stamp alignment (`alignBranchesToStamps`, ADR-0005 Stage 3c) —
// the native port of the runner's `_install_branch_stamp_align`.
//
// A tsdemux keeps the zero-point error of the one bus buffer it locked on for
// its whole life (−73…−85 ms measured on .103, re-rolled per restart), so two
// branches carrying source-simultaneous media leave a mux tens of ms apart.
// Per named demux: the sink pad is indexed (the producer's house mapping K =
// min(stamp − ns(first PES)), and a payload-TAIL → PTS index of the access
// units in flight); each demuxed src pad, once the branch has settled, joins
// its buffers back by tail, takes the median error over a window and applies
// it as a pad offset. Every constant, verdict and log line is the python's.
#pragma once

#include <gst/gst.h>
#include <json-glib/json-glib.h>

namespace mr::align {

/** `cfg` = {"demuxes": ["demux_0", …]} or nullptr. Armed before PLAYING. */
void install(GstElement* pipe, JsonObject* cfg);

/** Drop every probe and handler (pipeline stop / restart). */
void clear();

}  // namespace mr::align
