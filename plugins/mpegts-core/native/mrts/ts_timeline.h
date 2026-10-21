// What Phase 2 leaves of the anchored stamper's module (WI-P2-2): `timing_pes`,
// for IdentityStamp (ts_house.cpp) and the runner's branch retime until Phase 3
// deletes it. py/ts_timeline.py stays whole, as the reference (OQ-1).
#pragma once
#include <cstdint>

namespace mrts {

// A PES that may define an egress's timeline: video (0xE0-0xEF) or audio
// (0xC0-0xDF), or any PES on `timing_pid`, the PCR carrier (-1 = unknown).
// `pkt` holds a PES header with a PTS (`read_pes_pts` >= 0).
bool timing_pes(const uint8_t* pkt, int pid, int timing_pid);

}  // namespace mrts
