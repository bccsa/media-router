// Per-access-unit retime of a transform producer's input demux
// (`alignBranchesToStamps.transformProducer`, ADR-0005 2026-10-08) — the native
// port of the python runner's `branch_retime.py`, rule for rule.
//
// tsdemux's own timestamps (PCR lead, skew walk) are replaced: PTS = K + ns(PES
// PTS), DTS = K + ns(PES DTS), K the producer's stamp mapping of that PES's epoch.
#pragma once

#include <gst/gst.h>

namespace mr::align::rt {

/** Arm the retime on one transform producer's input demux; owns `demux` and `sink`. */
void install(const gchar* name, GstElement* demux, GstPad* sink);

/** Drop the registry and every ref a state holds (pipeline stop / restart). */
void clear();

}  // namespace mr::align::rt
