"""TS for one KLV subtitle stream, packed by the bridge (no mpegtsmux in the
pay tail): per cue one chunk laid out as mpegtsmux wrote it — PAT, PMT (PCR on
the KLV PID, KLVA registration), PES 0xBD at cue start + 1 h with the PCR when
it advances — null-padded to 7 packets so a restarting tsdemux sees the first
cue at once. ADR-0016 amendment 2026-10-09. Pure stdlib.
"""
import struct

PKT = 188
PMT_PID = 0x20
PROGRAM = 1
CLOCK_BASE_MS = 3_600_000
PTS_WRAP = 1 << 33
PCR_LAG_TICKS = 11_250          # 125 ms: mpegtsmux's PCR behind the PES PTS
MIN_PACKETS = 7
NULL_PACKET = b"\x47\x1f\xff\x10" + b"\xff" * 184


def pes_ticks(start_ms):
    """PES PTS (90 kHz) for a cue starting at house `start_ms`: +1 h, wrapped."""
    return round((start_ms + CLOCK_BASE_MS) * 90) % PTS_WRAP


def crc32_mpeg(data):
    crc = 0xFFFFFFFF
    for byte in data:
        crc ^= byte << 24
        for _ in range(8):
            crc = ((crc << 1) ^ 0x04C11DB7) & 0xFFFFFFFF if crc & 0x80000000 else (crc << 1) & 0xFFFFFFFF
    return crc


def _section(table_id, ext, body):
    head = bytes([table_id]) + struct.pack(">H", 0xB000 | (len(body) + 9)) + \
        struct.pack(">H", ext) + b"\xc1\x00\x00"
    sec = head + body
    return sec + struct.pack(">I", crc32_mpeg(sec))


def pat_section(pmt_pid=PMT_PID):
    return _section(0x00, 0x0001, struct.pack(">HH", PROGRAM, 0xE000 | pmt_pid))


def pmt_section(pid):
    es = bytes([0x06]) + struct.pack(">HH", 0xE000 | pid, 0xF006) + b"\x05\x04KLVA"
    return _section(0x02, PROGRAM, struct.pack(">HH", 0xE000 | pid, 0xF000) + es)


def _pts_bytes(pts):
    return bytes([0x21 | ((pts >> 29) & 0x0E), (pts >> 22) & 0xFF, ((pts >> 14) & 0xFE) | 1,
                  (pts >> 7) & 0xFF, ((pts << 1) & 0xFE) | 1])


def _pcr_bytes(base):
    return ((base << 15) | (0x3F << 9)).to_bytes(6, "big")


def _packet(pid, cc, pusi, af, payload):
    """One packet; `af` = adaptation fields after the length byte (None = no
    field unless stuffing needs one). Returns (packet, payload bytes used)."""
    room = 184 - (1 + len(af) if af is not None else 0)
    if len(payload) < room:
        total = 184 - len(payload)              # adaptation field incl. its length byte
        if af is None:
            af = b"" if total == 1 else b"\x00"
        af += b"\xff" * (total - 1 - len(af))
        used = len(payload)
    else:
        used = room
    hdr = bytes([0x47, (0x40 if pusi else 0) | (pid >> 8), pid & 0xFF,
                 (0x30 if af is not None else 0x10) | (cc & 0x0F)])
    pkt = hdr + (bytes([len(af)]) + af if af is not None else b"") + payload[:used]
    return pkt, used


class KlvTsPacker:
    """Continuity counters and the PCR for one KLV subtitle PID."""

    def __init__(self, pid, pmt_pid=PMT_PID):
        self.pid, self.pmt_pid = pid, pmt_pid
        self.cc = {0: 0, pmt_pid: 0, pid: 0}
        self.last_pcr = None
        self._pat, self._pmt = pat_section(pmt_pid), pmt_section(pid)

    def _psi(self, pid, section):
        pkt, _ = _packet(pid, self.cc[pid], True, None, b"\x00" + section)
        self.cc[pid] = (self.cc[pid] + 1) & 0x0F
        return pkt

    def cue_chunk(self, pts, klv):
        """PAT + PMT + the PES carrying `klv` at PES PTS `pts` (90 kHz)."""
        body = b"\x85\x80\x05" + _pts_bytes(pts) + klv
        pes = b"\x00\x00\x01\xbd" + struct.pack(">H", len(body)) + body
        pcr = (pts - PCR_LAG_TICKS) % PTS_WRAP
        af = None
        if self.last_pcr is None or 0 < (pcr - self.last_pcr) % PTS_WRAP < PTS_WRAP // 2:
            af = b"\x10" + _pcr_bytes(pcr)
            self.last_pcr = pcr
        out = [self._psi(0, self._pat), self._psi(self.pmt_pid, self._pmt)]
        first = True
        while pes:
            pkt, used = _packet(self.pid, self.cc[self.pid], first, af if first else None, pes)
            self.cc[self.pid] = (self.cc[self.pid] + 1) & 0x0F
            out.append(pkt)
            pes, first = pes[used:], False
        out += [NULL_PACKET] * max(0, MIN_PACKETS - len(out))
        return b"".join(out)
