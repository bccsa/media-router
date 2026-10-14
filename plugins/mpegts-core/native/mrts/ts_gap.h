// The bus gap marker's packet (plan ch. 5 OQ-12): adaptation-only, one per PID the gap is
// on, the gap's length in its transport_private_data; a GAP|DISCONT buffer whose PTS is the
// gap's end carries it. No payload and no PCR, so it moves no demux and no CC.
#pragma once
#include <cstdint>

#include "ts_packet.h"

namespace mrts {

constexpr int GAP_PRIVATE_BYTES = 8;   // the length in ns, unsigned big-endian

// The packet on `pid`; `cc` is the PID's last payload CC, which an adaptation-only packet
// repeats (ISO 13818-1 2.4.3.3). A negative length is written as 0.
void build_gap_packet(int pid, uint8_t cc, int64_t length_ns, uint8_t out[PKT]);

// The length a gap packet carries, or -1 when `pkt` is none: a payload, no private data,
// or private data of another length.
int64_t read_gap_length(const uint8_t* pkt);

}  // namespace mrts
