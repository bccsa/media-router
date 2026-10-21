// py/ts_timeline.py's `timing_pes`, rule for rule. Private data (KLV, teletext,
// DVB subtitles, also AC-3 and Opus) counts only on its carrier: a sparse cue's
// PTS sit seconds off the video's (the .108 route, 2026-09-16).
#include "ts_timeline.h"

#include "ts_packet.h"

namespace mrts {

bool timing_pes(const uint8_t* pkt, int pid, int timing_pid) {
    const int sid = pkt[payload_offset(pkt) + 3];
    if ((sid & 0xF0) == 0xE0 || (sid & 0xE0) == 0xC0) return true;
    return pid == timing_pid;
}

}  // namespace mrts
