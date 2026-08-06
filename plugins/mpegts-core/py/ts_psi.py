#!/usr/bin/env python3
"""MPEG-TS PSI parse/build + PID remap — the transport-agnostic core of the
TSDuck combiner/splitter runner (tsduck-runner.py).

The TSDuck Python binding is thin (no ts::PAT/ts::PMT/ts::TSPacket classes), so
the combiner owns all PSI itself: it parses each source's PAT/PMT to *discover*
structure, header-remaps ES PIDs to a pinned scheme, and *builds* a fresh
combined PAT + per-program PMTs from scratch. TSDuck (embedded TSProcessor) is
then used only for what it is good at on the merged stream: `regulate` pacing.
The splitter uses TSDuck's `zap` plugin, which regenerates valid SPTS PSI, so it
needs only the parse side here (for stream discovery / KLV).

Pure stdlib — unit-tested by ts_psi_test.py without TSDuck. Single-section
PAT/PMT only (encoder programs are tiny: a combined PAT and 1-2-ES PMTs each fit
one 188-byte TS packet), which is the realistic case for our encoder outputs.
"""
from __future__ import annotations

PKT = 188
SYNC = 0x47

PID_PAT = 0x0000
PID_NULL = 0x1FFF
TABLE_PAT = 0x00
TABLE_PMT = 0x02

STREAM_TYPE_MPEG2_VIDEO = 0x02
STREAM_TYPE_PRIVATE_PES = 0x06  # DVB subtitles / teletext ride here
STREAM_TYPE_AAC = 0x0F
STREAM_TYPE_AVC = 0x1B
STREAM_TYPE_HEVC = 0x24
STREAM_TYPE_KLV = 0x15  # metadata in PES (KLV carousel lives on its own PID)

PCR_HZ = 27_000_000            # PCR is a 27 MHz clock (90 kHz base * 300 + 9-bit ext)
PCR_MODULO = 300 << 33         # full PCR wrap = 2^33 * 300


# --------------------------------------------------------------------------- #
# CRC32 (MPEG-2 systems: poly 0x04C11DB7, init 0xFFFFFFFF, no reflection/xorout)
# --------------------------------------------------------------------------- #
def _crc32_table() -> list:
    table = []
    for i in range(256):
        crc = i << 24
        for _ in range(8):
            crc = ((crc << 1) ^ 0x04C11DB7) & 0xFFFFFFFF if crc & 0x80000000 else (crc << 1) & 0xFFFFFFFF
        table.append(crc)
    return table


_CRC_TABLE = _crc32_table()


def crc32_mpeg(data: bytes) -> int:
    crc = 0xFFFFFFFF
    for b in data:
        crc = ((crc << 8) & 0xFFFFFFFF) ^ _CRC_TABLE[((crc >> 24) ^ b) & 0xFF]
    return crc


# --------------------------------------------------------------------------- #
# TS packet header helpers
# --------------------------------------------------------------------------- #
def ts_pid(pkt: bytes) -> int:
    return ((pkt[1] & 0x1F) << 8) | pkt[2]


def ts_pusi(pkt: bytes) -> bool:
    return bool(pkt[1] & 0x40)


def ts_has_payload(pkt: bytes) -> bool:
    return bool(pkt[3] & 0x10)


def ts_set_pid(pkt: bytes, new_pid: int) -> bytes:
    b = bytearray(pkt)
    b[1] = (b[1] & 0xE0) | ((new_pid >> 8) & 0x1F)
    b[2] = new_pid & 0xFF
    return bytes(b)


def iter_packets(data: bytes):
    for off in range(0, len(data) - PKT + 1, PKT):
        if data[off] == SYNC:
            yield data[off:off + PKT]


def payload_offset(pkt: bytes) -> int:
    """Byte offset of the payload within the packet (after any adaptation field)."""
    off = 4
    if pkt[3] & 0x20:  # adaptation field present
        off += 1 + pkt[4]
    return off


def read_pcr(pkt: bytes):
    """Return the 27 MHz PCR carried in a packet's adaptation field, or None."""
    if not (pkt[3] & 0x20):           # no adaptation field
        return None
    af_len = pkt[4]
    if af_len < 7 or not (pkt[5] & 0x10):   # need flags byte + 6 PCR bytes, PCR_flag set
        return None
    base = (pkt[6] << 25) | (pkt[7] << 17) | (pkt[8] << 9) | (pkt[9] << 1) | (pkt[10] >> 7)
    ext = ((pkt[10] & 0x01) << 8) | pkt[11]
    return base * 300 + ext



# Stream ids whose PES packets carry no optional header, hence never a PTS
# (ISO 13818-1 §2.4.3.7): program_stream_map, padding, private_stream_2,
# ECM, EMM, DSM-CC, H.222.1 type E, program_stream_directory.
_PES_NO_HEADER_IDS = frozenset({0xBC, 0xBE, 0xBF, 0xF0, 0xF1, 0xF2, 0xF8, 0xFF})


def read_pes_pts(pkt: bytes):
    """Return the 33-bit 90 kHz PTS of the PES header starting in this packet,
    or None. A PES header can only start on a payload-unit boundary, so PUSI is
    required; PSI sections fail the 00 00 01 start-code check naturally (their
    payload begins with a pointer_field). The 33-bit value wraps every ~26.5 h —
    callers latching it as a timeline anchor inherit that hazard.
    """
    if not ts_pusi(pkt) or not ts_has_payload(pkt):
        return None
    off = payload_offset(pkt)
    p = pkt[off:]
    if len(p) < 14 or p[0] != 0x00 or p[1] != 0x00 or p[2] != 0x01:
        return None
    if p[3] in _PES_NO_HEADER_IDS:
        return None
    if (p[6] & 0xC0) != 0x80:   # '10' marker bits of the optional PES header
        return None
    if not (p[7] & 0x80):       # PTS_DTS_flags — PTS absent
        return None
    return (((p[9] >> 1) & 0x07) << 30) | (p[10] << 22) | ((p[11] >> 1) << 15) \
        | (p[12] << 7) | (p[13] >> 1)


def build_pcr_packet(pid: int, pcr27: int, cc: int = 0) -> bytes:
    """A PCR-only TS packet (adaptation field, no payload) on `pid`.

    Used to give an extracted audio-only output a PCR on the source's timebase.
    Adaptation-only packets do not carry a payload, so per ISO 13818-1 the
    continuity_counter is not advanced — we stamp it with the PID's last payload
    CC so a strict decoder's continuity check is undisturbed.
    """
    base = (pcr27 // 300) & 0x1FFFFFFFF   # 33-bit 90 kHz base
    ext = pcr27 % 300                       # 9-bit 27 MHz remainder
    pkt = bytearray(b"\xff" * PKT)
    pkt[0] = SYNC
    pkt[1] = (pid >> 8) & 0x1F              # no PUSI
    pkt[2] = pid & 0xFF
    pkt[3] = 0x20 | (cc & 0x0F)             # adaptation field only, no payload
    pkt[4] = 183                            # adaptation_field_length (fills the packet)
    pkt[5] = 0x10                           # PCR_flag
    pkt[6] = (base >> 25) & 0xFF
    pkt[7] = (base >> 17) & 0xFF
    pkt[8] = (base >> 9) & 0xFF
    pkt[9] = (base >> 1) & 0xFF
    pkt[10] = ((base & 0x01) << 7) | 0x7E | ((ext >> 8) & 0x01)
    pkt[11] = ext & 0xFF
    return bytes(pkt)


def null_packet(cc: int = 0) -> bytes:
    """A stuffing (null-PID) packet — used as a keepalive when a combiner input
    starves, so the embedded TSProcessor never sees 0 packets (which reads as EOF)."""
    b = bytearray(PKT)
    b[0] = SYNC
    b[1] = (PID_NULL >> 8) & 0x1F
    b[2] = PID_NULL & 0xFF
    b[3] = 0x10 | (cc & 0x0F)
    for i in range(4, PKT):
        b[i] = 0xFF
    return bytes(b)


# --------------------------------------------------------------------------- #
# Section reassembly (single table_id on a PID; handles multi-packet sections)
# --------------------------------------------------------------------------- #
def first_section(packets, pid: int):
    """Reassemble the first complete PSI section carried on `pid` (or None)."""
    buf = bytearray()
    want = -1
    collecting = False
    for pkt in packets:
        if ts_pid(pkt) != pid or not ts_has_payload(pkt):
            continue
        off = payload_offset(pkt)
        if off >= PKT:
            continue
        body = pkt[off:]
        if ts_pusi(pkt):
            ptr = body[0]
            body = body[1 + ptr:]           # skip pointer_field to section start
            buf = bytearray(body)
            collecting = True
        elif collecting:
            buf += body
        if collecting and want < 0 and len(buf) >= 3:
            want = 3 + (((buf[1] & 0x0F) << 8) | buf[2])   # 3-byte header + section_length
        if collecting and 0 < want <= len(buf):
            return bytes(buf[:want])
    return None


def section_signature(pkt: bytes):
    """A section's own change signals, read from the packet that starts it — the
    cheap "did this table change?" test that avoids a full reassembly + parse.

    Returns (table_id, table_id_ext, version_number, crc), crc None when the
    section spans further packets (its CRC tail is not in this one, so the
    signature rests on version_number alone). None = nothing usable here: no
    PUSI/payload, pointer_field past the packet, a short or non-syntax section,
    current_next_indicator=0 (that section describes the *next* table, not the
    one in force), or section_number != 0 (first_section, hence every parser
    here, only ever sees section 0).
    """
    if not ts_pusi(pkt) or not ts_has_payload(pkt):
        return None
    off = payload_offset(pkt)
    if off >= PKT:
        return None
    start = off + 1 + pkt[off]               # pointer_field -> section start
    if start + 8 > PKT:                      # need table_id .. last_section_number
        return None
    s = pkt[start:]
    if not s[1] & 0x80:                      # no section_syntax: no version/CRC
        return None
    if not s[5] & 0x01:                      # current_next_indicator = 0
        return None
    if s[6] != 0:                            # only section 0 is ever parsed
        return None
    section_length = ((s[1] & 0x0F) << 8) | s[2]
    if section_length < 9:                   # 5 header bytes + 4 CRC minimum
        return None
    total = 3 + section_length               # whole section, CRC included
    crc = (int.from_bytes(s[total - 4:total], "big")
           if start + total <= PKT else None)
    return (s[0], (s[3] << 8) | s[4], (s[5] >> 1) & 0x1F, crc)


def parse_pat(packets) -> dict:
    """Return {program_number: pmt_pid} (program 0 = NIT, excluded)."""
    sec = first_section(packets, PID_PAT)
    out: dict = {}
    if not sec or sec[0] != TABLE_PAT:
        return out
    section_length = ((sec[1] & 0x0F) << 8) | sec[2]
    end = 3 + section_length - 4            # exclude CRC
    i = 8                                    # skip to first program entry
    while i + 4 <= end:
        prog = (sec[i] << 8) | sec[i + 1]
        pid = ((sec[i + 2] & 0x1F) << 8) | sec[i + 3]
        if prog != 0:
            out[prog] = pid
        i += 4
    return out


def parse_pmt(packets, pmt_pid: int):
    """Return dict(program_number, pcr_pid, streams=[(pid, stream_type)],
    es_info={pid: raw descriptor bytes}) or None.

    es_info keeps each ES's descriptor loop verbatim: for codecs that have no
    stream_type of their own (Opus rides stream_type 0x06 + registration
    'Opus' + DVB extension descriptor), the descriptors ARE the codec identity
    and must survive any PMT rebuild.
    """
    sec = first_section(packets, pmt_pid)
    if not sec or sec[0] != TABLE_PMT:
        return None
    section_length = ((sec[1] & 0x0F) << 8) | sec[2]
    end = 3 + section_length - 4
    program_number = (sec[3] << 8) | sec[4]
    pcr_pid = ((sec[8] & 0x1F) << 8) | sec[9]
    program_info_length = ((sec[10] & 0x0F) << 8) | sec[11]
    i = 12 + program_info_length
    streams = []
    es_info = {}
    while i + 5 <= end:
        stream_type = sec[i]
        es_pid = ((sec[i + 1] & 0x1F) << 8) | sec[i + 2]
        es_info_len = ((sec[i + 3] & 0x0F) << 8) | sec[i + 4]
        streams.append((es_pid, stream_type))
        es_info[es_pid] = bytes(sec[i + 5:i + 5 + es_info_len])
        i += 5 + es_info_len
    return {"program_number": program_number, "pcr_pid": pcr_pid,
            "streams": streams, "es_info": es_info}


# --------------------------------------------------------------------------- #
# Section -> single-packet TS builders
# --------------------------------------------------------------------------- #
def _wrap_section(pid: int, section_body: bytes, cc: int) -> bytes:
    """section_body = table bytes WITHOUT CRC; append CRC and wrap in one TS packet."""
    section = section_body + crc32_mpeg(section_body).to_bytes(4, "big")
    payload = bytes([0x00]) + section           # pointer_field = 0
    if len(payload) > PKT - 4:
        raise ValueError("section too large for a single TS packet")
    pkt = bytearray(PKT)
    pkt[0] = SYNC
    pkt[1] = 0x40 | ((pid >> 8) & 0x1F)          # PUSI = 1
    pkt[2] = pid & 0xFF
    pkt[3] = 0x10 | (cc & 0x0F)                   # payload only
    pkt[4:4 + len(payload)] = payload
    for i in range(4 + len(payload), PKT):
        pkt[i] = 0xFF                             # stuffing
    return bytes(pkt)


def _section_length_field(total_after_length: int):
    # section_syntax_indicator=1, reserved '0', reserved '11', 12-bit length
    val = 0xB000 | (total_after_length & 0x0FFF)
    return (val >> 8) & 0xFF, val & 0xFF


def build_pat(ts_id: int, programs: dict, cc: int = 0, version: int = 0) -> bytes:
    body = bytearray([TABLE_PAT, 0x00, 0x00])    # table_id, length placeholder
    body += bytes([(ts_id >> 8) & 0xFF, ts_id & 0xFF])
    body += bytes([0xC1 | ((version & 0x1F) << 1)])  # reserved '11', version, current_next=1
    body += bytes([0x00, 0x00])                  # section_number, last_section_number
    for prog, pmt_pid in programs.items():
        body += bytes([(prog >> 8) & 0xFF, prog & 0xFF,
                       0xE0 | ((pmt_pid >> 8) & 0x1F), pmt_pid & 0xFF])
    section_length = (len(body) - 3) + 4         # remaining header/payload + CRC
    body[1], body[2] = _section_length_field(section_length)
    return _wrap_section(PID_PAT, bytes(body), cc)


class PsiDiscovery:
    """Incrementally discover PAT -> PMT from a possibly-sparse PSI stream.

    A flat sliding window over all packets fails on real broadcast feeds: PATs
    can be thousands of TS packets apart (observed ~3800 on a 30 Mbps MPTS), so a
    small window rarely holds a PAT and its PMT at the same time. Instead we keep
    small persistent buffers of *only* the PSI packets (PID 0, then the PMT PID),
    which span a long time even when sparse, and parse PAT then PMT independently.

    A table that changes is acted on as soon as its section signature changes
    (see section_signature); the periodic re-parse is only the backstop. Waiting
    for it cost ~11 s to notice an upstream codec change at 1080p50 bus cadence.
    """

    def __init__(self, max_psi_pkts: int = 128):
        self._max = max_psi_pkts
        self._pat_pkts = []
        self._pmt_pkts = []
        self._n = 0
        self.pmt_pid = None
        self.program = None     # program the PAT mapped to pmt_pid
        self.programs = {}      # {program_number: pmt_pid}
        self.pmt = None         # parsed PMT dict (parse_pmt result) once found
        # Signature of the last section handed to the parser; a differing one
        # re-parses at once. `_*_new_sig` is the pending candidate, promoted
        # only once the parse of that section actually completed (a section
        # spanning packets stays pending until its tail arrives).
        self._pat_sig = self._pat_new_sig = None
        self._pmt_sig = self._pmt_new_sig = None
        self._pat_resync = False
        self._pmt_resync = False

    def feed(self, packets) -> bool:
        """Absorb a batch of TS packets. Returns True when the PMT (its stream
        set) first becomes known or subsequently changes."""
        for p in packets:
            pid = ts_pid(p)
            if pid == PID_PAT:
                sig = section_signature(p)
                if sig and sig[0] == TABLE_PAT and sig != self._pat_sig:
                    # Reassembly returns the OLDEST retained section, so a
                    # superseded table stays visible until the buffer evicts
                    # it; drop it and let this section be the one parsed.
                    self._pat_pkts.clear()
                    self._pat_new_sig = sig
                    self._pat_resync = True
                self._pat_pkts.append(p)
                if len(self._pat_pkts) > self._max:
                    self._pat_pkts.pop(0)
            elif self.pmt_pid is not None and pid == self.pmt_pid:
                # Only our own program's sections count: a PMT PID shared by two
                # programs would otherwise flap the discovered table on every
                # carousel repeat.
                sig = section_signature(p)
                if (sig and sig[0] == TABLE_PMT and sig != self._pmt_sig
                        and (self.program is None or sig[1] == self.program)):
                    self._pmt_pkts.clear()
                    self._pmt_new_sig = sig
                    self._pmt_resync = True
                self._pmt_pkts.append(p)
                if len(self._pmt_pkts) > self._max:
                    self._pmt_pkts.pop(0)
        self._n += 1
        if self.pmt_pid is None or self._pat_resync:
            pat = parse_pat(self._pat_pkts)
            if pat:
                if self._pat_resync:
                    self._pat_sig = self._pat_new_sig
                    self._pat_resync = False
                self.programs = pat
                program, pmt_pid = next(iter(pat.items()))
                if pmt_pid != self.pmt_pid:
                    # A new PAT may also move the program to a different PMT
                    # PID; the buffered packets belong to the old one.
                    self.pmt_pid = pmt_pid
                    self._pmt_pkts.clear()
                    self._pmt_sig = None
                    self._pmt_resync = False
                self.program = program
        changed = False
        if self.pmt_pid is not None and (self.pmt is None or self._pmt_resync
                                         or self._n % 500 == 0):
            pmt = parse_pmt(self._pmt_pkts, self.pmt_pid)
            if pmt and self._pmt_resync:
                self._pmt_sig = self._pmt_new_sig   # decided on it; no re-trigger
                self._pmt_resync = False
            if pmt and pmt != self.pmt:
                self.pmt = pmt
                changed = True
        return changed


def build_pmt(pmt_pid: int, program_number: int, pcr_pid: int,
              streams, cc: int = 0, version: int = 0) -> bytes:
    """`streams` entries are (pid, stream_type) or (pid, stream_type, es_info)
    where es_info is the ES's raw descriptor loop bytes (see parse_pmt)."""
    body = bytearray([TABLE_PMT, 0x00, 0x00])
    body += bytes([(program_number >> 8) & 0xFF, program_number & 0xFF])
    body += bytes([0xC1 | ((version & 0x1F) << 1)])
    body += bytes([0x00, 0x00])                  # section/last_section_number
    body += bytes([0xE0 | ((pcr_pid >> 8) & 0x1F), pcr_pid & 0xFF])
    body += bytes([0xF0, 0x00])                  # program_info_length = 0
    for es_pid, stream_type, *rest in streams:
        es_info = rest[0] if rest else b""
        body += bytes([stream_type & 0xFF,
                       0xE0 | ((es_pid >> 8) & 0x1F), es_pid & 0xFF,
                       0xF0 | ((len(es_info) >> 8) & 0x0F), len(es_info) & 0xFF])
        body += es_info
    section_length = (len(body) - 3) + 4
    body[1], body[2] = _section_length_field(section_length)
    return _wrap_section(pmt_pid, bytes(body), cc)
