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
// `transformProducer` instead retimes every access unit to K + its PES
// (branch_retime.cpp).
#pragma once

#include <cstddef>

#include <gst/gst.h>
#include <json-glib/json-glib.h>

namespace mr::align {

/** `cfg` = {"demuxes": ["demux_0", …], "transformProducer"?: bool} or nullptr.
 *  Armed before PLAYING. A transform producer's demux is retimed per access unit
 *  (bus input held until the first exact stamp reading), not offset once. */
void install(GstElement* pipe, JsonObject* cfg);

/** Drop every probe and handler (pipeline stop / restart). */
void clear();

/** A live input add (`bus_input_add`) into a pipeline whose alignment is
 *  `transformProducer`: retime every tsdemux inside `bin` exactly as `install`
 *  retimes the start payload's demuxes — the branch's access units leave at
 *  their producer's content time like its siblings'. Call after linking, before
 *  the bin plays (the bus input is held at the demux until the first exact
 *  stamp reading). No-op for any other pipeline: a mux-mode branch is offset
 *  once off a settle window the live add never had. */
void install_live(GstBin* bin);

/** The live branch `bin` is going (already NULL): forget its demuxes' retimes. */
void forget_live(GstBin* bin);

// Shared with branch_retime.cpp.
constexpr size_t KEY_BYTES = 64;   // payload-tail join key, as the python's
constexpr size_t HISTORY = 4096;   // indexed access units kept per PID

/** tsdemux names pads `<media>_<programhex>_<pidhex>`; the PID is the last field. */
int pid_from_pad_name(const gchar* name);

}  // namespace mr::align
