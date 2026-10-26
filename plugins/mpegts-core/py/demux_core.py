#!/usr/bin/env python3
"""The Python reference of mrts::DemuxCore (plan ch. 7 parts 4.1 and 4.2, WI-P3-1; register
B-121): the formula demux of one program, prototyped first and kept as the reference the C++
ports rule for rule (OQ-1, ADR-0029 S0 choice 1, B-55). Nothing loads it at runtime.

Every PES leaves at PTS = ceil((unwrap(PES PTS) - 1 h) x 100000 / 9) ns, DTS likewise (S12): the
first PES of a pad unwrapped nearest house now + 1 h (B-14), every later one nearest the pad's
previous, a DTS nearest its own PTS; the bus stamps are never read. Pads are named and capped as
tsdemux 1.28.2 names and caps them (part 4.2); a program is new only when its PCR PID or its (PID,
stream type) list changes, tsdemux's rule (S13). Gaps: a hole in an audio pad of more than two
frames, in a video pad of 1 s or more (S5, B-89); a bus gap marker on a pad's PID (S4, B-60); a
sparse pad behind program time (B-86). With `select` set it is mrts::SelectDemux, on the ceil.

The mrts pieces house_rebase.py ports (B-55) are imported from it: the packet walk, the unwrap,
the PES header parse, the PCR read and the PSI section parse. What it does not carry is ported
here as built: CcTracker (ts_packet), PesAssembler (ts_pes), PsiDiscovery in full (ts_psi),
read_gap_length (ts_gap), s302m_frames (ts_select). demux_core_test.py holds the cases the C++
suite ports one for one.

Run as a script it prints a fixture's .demux.jsonl (tests/fixtures/README.md has the format):
    demux_core.py in.ts [--chunk N] [--media M] [--select CAPS] [--program P] [--house-ns T]
                        [--bus in.bus.jsonl]
"""
import argparse
import json
import os
import sys
import zlib
from collections import deque, namedtuple

sys.path.append(os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "unixfdbus-core", "py")))
import house_rebase as hr  # noqa: E402

PKT = hr.PKT
SYNC_BYTE = hr.SYNC_BYTE
PID_PAT = hr.PID_PAT
PID_NULL = hr.PID_NULL
TABLE_PAT = hr.TABLE_PAT
TABLE_PMT = hr.TABLE_PMT
PTS_WRAP = hr.PTS_WRAP
MUX_CLOCK_BASE_90K = hr.MUX_CLOCK_BASE_90K
SEC = 1000000000
INT64_MAX = (1 << 63) - 1

ns_to_pts90k = hr.ns_to_pts90k
pts90k_to_ns = hr.pts90k_to_ns
parse_packet = hr.parse_packet
parse_pes_header = hr.parse_pes_header
read_pcr = hr.read_pcr


def pts90k_to_ns_ceil(ticks):
    """ceil(ticks x 100000 / 9): the ns mpegtsmux's floor turns back into `ticks` (S12, B-69)."""
    return -((-ticks * 100000) // 9)


def pcr27_to_ns(pcr27):
    return pcr27 * 1000 // 27


def ts_pid(p):
    return ((p[1] & 0x1F) << 8) | p[2]


def crc32_hex(b):
    return "%08x" % zlib.crc32(b)


class PacketWalker(hr.PacketWalker):
    def reset(self):
        """The carry is dropped (mrts::PacketWalker::reset); desync_bytes is lifetime."""
        self.carry = b""


class Unwrapper(hr.Unwrapper):
    def reset(self):
        """The next feed re-seeds; the dts_discarded count is kept (mrts::Unwrapper::reset)."""
        self.last = 0
        self.primed = False


# --- ts_packet: the continuity check -----------------------------------------------------------

class CcTracker:
    """mrts::CcTracker: per-PID CC, one duplicate legal and reported, the discontinuity_indicator
    resetting expectation, adaptation-only packets never advancing it, null packets untracked."""
    OK, DUPLICATE, LOST, RESET = range(4)
    _KNOWN, _DUP = 0x10, 0x20

    def __init__(self):
        self._state = bytearray(8192)
        self.lost = 0

    def feed(self, v):
        if v.pid == PID_NULL:
            return self.OK
        s = self._state[v.pid]
        if v.af_discontinuity:
            self._state[v.pid] = (self._KNOWN | v.cc) if v.has_payload else 0
            return self.RESET
        if not v.has_payload:
            return self.OK
        last = s & 0x0F
        if not (s & self._KNOWN) or v.cc == ((last + 1) & 0x0F):
            self._state[v.pid] = self._KNOWN | v.cc
            return self.OK
        if v.cc == last and not (s & self._DUP):
            self._state[v.pid] = s | self._DUP
            return self.DUPLICATE
        # A third copy keeps the duplicate mark, so a run of repeats stays an error.
        self._state[v.pid] = self._KNOWN | (self._DUP if v.cc == last else 0) | v.cc
        self.lost += 1
        return self.LOST


# --- ts_pes: PES reassembly ---------------------------------------------------------------------

class PesUnit:
    __slots__ = ("pid", "hdr", "payload", "size", "discont", "seq")

    def __init__(self):
        self.pid = -1
        self.hdr = hr.PesHeader()
        self.payload = bytearray()
        self.size = 0
        self.discont = False                      # the PID lost or skipped data just before it
        self.seq = 0


class _PesPid:
    __slots__ = ("unit", "head", "bytes", "next_seq", "open", "have_hdr", "lost", "started")

    def __init__(self, next_seq=0):
        self.unit = PesUnit()
        self.head = bytearray()                   # the open unit's header while incomplete
        self.bytes = 0
        self.next_seq = next_seq
        self.open = self.have_hdr = False
        self.lost = False                         # the next unit is discont
        self.started = False                      # until a PUSI, payload is a mid-PES join


class PesAssembler:
    """mrts::PesAssembler with keep_payload: the PES of every selected PID, bounded ones at their
    length, unbounded ones at the next PUSI or flush(); a CC loss drops the open unit."""

    def __init__(self, max_bytes=32 << 20):
        self._max = max_bytes
        self._pids = {}
        self.oversize = self.dropped_cc = self.malformed = 0

    def select(self, pid, on):
        if on:
            self._pids.setdefault(pid, _PesPid())
        else:
            self._pids.pop(pid, None)

    def selected(self):
        return sorted(self._pids)

    def feed(self, v, cc, out):
        s = self._pids.get(v.pid)
        if s is None or cc == CcTracker.DUPLICATE:
            return
        if cc in (CcTracker.LOST, CcTracker.RESET):
            if s.open:
                self._drop(s)
                self.dropped_cc += 1
            s.lost = True
        if v.payload_off >= PKT:
            return
        p = v.p[v.payload_off:]
        if v.pusi:
            if s.open:
                self._close(s, out)
            self._begin(s, v.pid, p, out)
        elif s.open:
            self._add(s, p, out)
        elif not s.started:
            s.lost = True                         # joined mid-PES: its head never came

    def flush(self, out):
        """EOS or a new program: the open units out in PID order (std::map's)."""
        for pid in sorted(self._pids):
            s = self._pids[pid]
            if s.open:
                self._close(s, out)
            s.started = False

    def close(self, pid, out):
        """The PID's open unit closed as at its next PUSI: unbounded out, bounded cut short dropped."""
        s = self._pids.get(pid)
        if s is not None and s.open:
            self._close(s, out)

    def reset(self):
        for pid, s in self._pids.items():
            self._pids[pid] = _PesPid(s.next_seq)

    def _begin(self, s, pid, p, out):
        s.started = True
        h = parse_pes_header(p, 0, len(p))
        if h is None:
            self.malformed += 1
            s.lost = True
            return
        s.open = True
        s.have_hdr = False
        s.bytes = 0
        s.unit.pid = pid
        s.unit.hdr = hr.PesHeader()
        s.unit.discont = s.lost
        s.unit.seq = s.next_seq
        s.next_seq += 1
        s.lost = False
        if h.complete:
            self._open_body(s, h)
            self._body(s, p[h.header_len:], out)
        else:
            s.head = bytearray(p)

    def _add(self, s, p, out):
        if s.have_hdr:
            self._body(s, p, out)
            return
        # A header cut by the packet boundary: re-parsed until it is whole.
        s.head += p
        h = parse_pes_header(s.head, 0, len(s.head))
        if h is None:
            self._drop(s)
            self.malformed += 1
            s.lost = True
            return
        if not h.complete:
            return
        self._open_body(s, h)
        head, s.head = s.head, bytearray()
        self._body(s, head[h.header_len:], out)

    @staticmethod
    def _open_body(s, h):
        s.unit.hdr = h
        s.have_hdr = True

    def _body(self, s, p, out):
        want = s.unit.hdr.payload_len
        n = len(p)
        if want >= 0:
            n = min(n, want - s.bytes)            # past the end: stuffing
        if n > self._max - s.bytes:
            self._drop(s)
            self.oversize += 1
            s.lost = True
            return
        s.unit.payload += p[:n]
        s.bytes += n
        if want >= 0 and s.bytes == want:
            self._emit(s, out)

    def _close(self, s, out):
        if s.have_hdr and s.unit.hdr.payload_len < 0:
            self._emit(s, out)
            return
        self._drop(s)
        self.malformed += 1
        s.lost = True

    @staticmethod
    def _emit(s, out):
        s.unit.size = s.bytes
        out.append(s.unit)
        s.unit = PesUnit()
        s.open = s.have_hdr = False

    @staticmethod
    def _drop(s):
        s.open = s.have_hdr = False
        s.unit.payload = bytearray()
        s.head = bytearray()


# --- ts_psi: PAT -> PMT discovery in full -------------------------------------------------------

def section_head(p):
    """Where the section starting in packet p begins when its header is in p, else -1."""
    if not (p[1] & 0x40) or not (p[3] & 0x10):
        return -1
    off = hr.payload_offset(p)
    if off >= PKT:
        return -1
    start = off + 1 + p[off]
    return start if start + 8 <= PKT else -1


def later_section(p, table_id, ext):
    """A current `table_id` section past the first (of program `ext` when ext >= 0)."""
    s = section_head(p)
    return (s >= 0 and p[s] == table_id and bool(p[s + 1] & 0x80) and bool(p[s + 5] & 0x01)
            and p[s + 6] != 0 and (ext < 0 or ((p[s + 3] << 8) | p[s + 4]) == ext))


class PsiDiscovery:
    """mrts::PsiDiscovery (house_rebase.py ports what a rebase reads of it): the PAT's chosen
    program, per-PID buffers of the PSI packets, a changed section signature re-parsed at once, a
    PMT re-parse every 500 feeds, `generation` bumped on every PMT change. `pat_generation` (a new
    PAT parsed) is what DemuxCore's section events add; the C++ gains it with the port."""

    def __init__(self, max_psi_pkts=128):
        self._max = max_psi_pkts
        self._pat_pkts = deque()
        self._pmt_pkts = deque()
        self._n = 0
        self.pmt_pid = -1
        self.program = -1                         # the PAT's program on pmt_pid
        self._pmt_shared = False                  # the PAT maps pmt_pid to other programs too
        self._select = -1
        self.pmt = None
        self._pat_sig = self._pat_new_sig = None
        self._pmt_sig = self._pmt_new_sig = None
        self._pat_resync = self._pmt_resync = False
        self.generation = 0
        self.pat_generation = 0
        self.unsupported = 0

    def select_program(self, program_number):
        if program_number < 0:
            program_number = -1
        if program_number == self._select:
            return
        self._select = program_number
        self.pmt_pid = self.program = -1
        self._pmt_shared = False
        self._pmt_pkts.clear()
        self._pmt_sig = self._pmt_new_sig = None
        self._pmt_resync = False
        self.pmt = None

    def pat_section(self):
        return hr.first_section(self._pat_pkts, PID_PAT)

    def pmt_section(self):
        return hr.first_section(self._pmt_pkts, self.pmt_pid) if self.pmt_pid >= 0 else None

    def feed(self, packets):
        """True when the PMT first parses or its program, PCR PID or ES list changes."""
        for p in packets:
            pid = ts_pid(p)
            if pid == PID_PAT:
                sig = hr.section_signature(p)
                if sig is not None and sig[0] == TABLE_PAT and sig != self._pat_sig:
                    self._pat_pkts.clear()        # the oldest retained section would be parsed
                    self._pat_new_sig = sig
                    self._pat_resync = True
                if later_section(p, TABLE_PAT, -1):
                    self.unsupported += 1
                self._pat_pkts.append(bytes(p))
                if len(self._pat_pkts) > self._max:
                    self._pat_pkts.popleft()
            elif self.pmt_pid >= 0 and pid == self.pmt_pid:
                sig = hr.section_signature(p)
                if (sig is not None and sig[0] == TABLE_PMT and sig != self._pmt_sig
                        and (self.program < 0 or sig[1] == self.program)):
                    self._pmt_pkts.clear()
                    self._pmt_new_sig = sig
                    self._pmt_resync = True
                if later_section(p, TABLE_PMT, self.program):
                    self.unsupported += 1
                self._pmt_pkts.append(bytes(p))
                if len(self._pmt_pkts) > self._max:
                    self._pmt_pkts.popleft()
        self._n += 1
        if self.pmt_pid < 0 or self._pat_resync:
            pat = hr.parse_pat(self._pat_pkts)
            entry = (pat[0] if pat else None) if self._select < 0 else next(
                (e for e in pat if e[0] == self._select), None)
            if entry is not None:
                if self._pat_resync:
                    self._pat_sig = self._pat_new_sig
                    self._pat_resync = False
                    self.pat_generation += 1
                if entry[1] != self.pmt_pid:      # the buffered packets are the old PID's
                    self.pmt_pid = entry[1]
                    self._pmt_pkts.clear()
                    self._pmt_sig = None
                    self._pmt_resync = False
                self.program = entry[0]
                self._pmt_shared = sum(1 for _, q in pat if q == self.pmt_pid) > 1
        changed = False
        if self.pmt_pid >= 0 and (self.pmt is None or self._pmt_resync or self._n % 500 == 0):
            pmt = hr.parse_pmt(self._pmt_pkts, self.pmt_pid)
            if pmt is not None and self._pmt_shared and pmt.program_number != self.program:
                pmt = None                        # a shared PMT PID: only our program's counts
            if pmt is not None and self._pmt_resync:
                self._pmt_sig = self._pmt_new_sig
                self._pmt_resync = False
            if pmt is not None and pmt != self.pmt:
                changed = self.pmt is None or (pmt.program_number, pmt.pcr_pid, pmt.streams) != (
                    self.pmt.program_number, self.pmt.pcr_pid, self.pmt.streams)
                self.pmt = pmt
                self.generation += 1
        return changed


# --- ts_gap and ts_select's AES3 header ---------------------------------------------------------

def read_gap_length(p):
    """mrts::read_gap_length: the length an OQ-12 gap packet carries, or -1 when p is none."""
    if p[0] != SYNC_BYTE or (p[3] & 0x30) != 0x20:
        return -1
    af = p[4]
    if af < 1 or af > PKT - 5:
        return -1
    flags = p[5]
    if not (flags & 0x02):
        return -1
    # The optional fields that precede the private data (2.4.3.4): PCR, OPCR, splice_countdown.
    off = 6 + (6 if flags & 0x10 else 0) + (6 if flags & 0x08 else 0) + (1 if flags & 0x04 else 0)
    if off + 9 > 5 + af or p[off] != 8:
        return -1
    v = int.from_bytes(p[off + 1:off + 9], "big")
    return -1 if v > INT64_MAX else v


def s302m_frames(payload):
    """48 kHz frames in one 302M PES payload from its AES3 header (SMPTE 302M 7), or -1."""
    n = len(payload)
    if n <= 4:
        return -1
    h = int.from_bytes(payload[:4], "big")
    size = h >> 16
    channels = ((h >> 14) & 3) * 2 + 2
    bits = ((h >> 4) & 3) * 4 + 16
    if 4 + size != n or bits > 24:
        return -1
    return 2 * (size // ((bits + 4) // 4)) // channels


# --- the caps table (part 4.2) ------------------------------------------------------------------

def fourcc(s):
    return int.from_bytes(s.encode("latin-1"), "big")


REG_BSSD, REG_AV1G, REG_OPUS, REG_HEVC = fourcc("BSSD"), fourcc("AV1G"), fourcc("Opus"), fourcc("HEVC")
REG_KLVA, REG_ID3, REG_AC4, REG_VP09 = fourcc("KLVA"), fourcc("ID3 "), fourcc("AC-4"), fourcc("VP09")
REG_DTS = (fourcc("DTS1"), fourcc("DTS2"), fourcc("DTS3"))

CAPS_H264 = "video/x-h264, stream-format=(string)byte-stream"
CAPS_H265 = "video/x-h265, stream-format=(string)byte-stream"
CAPS_AV1 = "video/x-av1, stream-format=(string)obu-stream, alignment=(string)frame"
CAPS_MPA = "audio/mpeg, mpegversion=(int)1"
CAPS_ADTS = "audio/mpeg, mpegversion=(int)4, stream-format=(string)adts"
CAPS_LOAS = "audio/mpeg, mpegversion=(int)4, stream-format=(string)loas"
CAPS_AC3, CAPS_EAC3, CAPS_302M = "audio/x-ac3", "audio/x-eac3", "audio/x-smpte-302m"
CAPS_TTX, CAPS_DVBSUB = "application/x-teletext", "subpicture/x-dvb"
CAPS_KLV = "meta/x-klv, parsed=(boolean)true"
CAPS_ID3 = "meta/x-id3, parsed=(boolean)false"

MEDIA_ALL = ("video", "audio", "private", "subpicture")
# Section-only stream types: tsdemux's PSI list (mpegtsbase.c _stream_is_private_section).
SECTION_TYPES = frozenset({0x05, 0x0A, 0x0B, 0x0C, 0x0D, 0x13, 0x16, 0x86})

EsPlan = namedtuple("EsPlan", "cls caps sparse post lang reg opus_ext av1_desc")


def descriptors(loop):
    """(tag, body) per descriptor of a loop, stopping at one that overruns it
    (mrts::for_each_descriptor)."""
    i, n = 0, len(loop)
    while i + 2 <= n:
        ln = loop[i + 1]
        if i + 2 + ln > n:
            return
        yield loop[i], bytes(loop[i + 2:i + 2 + ln])
        i += 2 + ln


def find_descriptor(loop, tag, ext=-1):
    """The first descriptor `tag` (whose first body byte is `ext` when ext >= 0), or None."""
    for t, body in descriptors(loop):
        if t == tag and (ext < 0 or (body and body[0] == ext)):
            return body
    return None


def registration_format(loop):
    """The first registration descriptor's format_identifier; 0 without one or when it is shorter
    than 4 bytes (tsdemux's rule, mrts::registration_format)."""
    body = find_descriptor(loop, 0x05)
    return int.from_bytes(body[:4], "big") if body is not None and len(body) >= 4 else 0


def _lang_codes(body, size):
    for i in range(0, len(body) - size + 1, size):
        code = body[i:i + 3].split(b"\0", 1)[0]
        if len(code) >= 2:                        # tsdemux tags none shorter (a C string)
            yield code.decode("latin-1")


def language(loop):
    """The ISO 639-2 code tsdemux tags: the last entry of the first 0x0A descriptor (its
    GST_TAG_MERGE_REPLACE), else of the first DVB subtitling descriptor; "" without one."""
    body = find_descriptor(loop, 0x0A)
    if body is None:
        body, size = find_descriptor(loop, 0x59), 8
    else:
        size = 4
    codes = list(_lang_codes(body, size)) if body is not None else []
    return codes[-1] if codes else ""


def metadata_format(loop):
    """metadata_format_identifier of the first metadata descriptor (0x26) whose format is 0xFF
    (gst_mpegts_descriptor_parse_metadata), else 0."""
    body = find_descriptor(loop, 0x26)
    if body is None or len(body) < 5:
        return 0
    at = 6 if body[0] == 0xFF and body[1] == 0xFF else 2
    if len(body) < at + 5 or body[at] != 0xFF:
        return 0
    return int.from_bytes(body[at + 1:at + 5], "big")


_OPUS_COUPLED = (1, 0, 1, 1, 2, 2, 2, 3, 3)
_OPUS_MAP_A = ((0,), (0, 1), (0, 2, 1), (0, 1, 2, 3), (0, 4, 1, 2, 3), (0, 4, 1, 2, 3, 5),
               (0, 4, 1, 2, 3, 5, 6), (0, 6, 1, 2, 3, 4, 5, 7))


def _bits(data):
    """MSB-first reader: read(n) -> value, None past the end or for n > 8 (gst_bit_reader's uint8)."""
    pos = [0]

    def read(n):
        if n > 8 or pos[0] + n > len(data) * 8:
            return None
        v = 0
        for _ in range(n):
            v = (v << 1) | ((data[pos[0] >> 3] >> (7 - (pos[0] & 7))) & 1)
            pos[0] += 1
        return v
    return read


def _bit_storage(n):                              # g_bit_storage
    return max(1, n.bit_length())


def opus_caps(ext):
    """tsdemux's Opus caps from the first DVB extension descriptor's body (tag_extension 0x80,
    channel_config_code next; tsdemux.c's Opus case), through gst_codec_utils_opus_create_caps;
    None where tsdemux makes no pad."""
    if ext is None or len(ext) < 2 or ext[0] != 0x80:
        return None
    code, rest = ext[1], ext[2:]
    if code >= 0x89:
        return None
    channels = (code & 0x0F) if code else 2
    mapping = ()
    if code in (0, 0x80):                         # dual mono
        channels, family = 2, 255
        streams, coupled = (1, 1) if code == 0 else (2, 0)
        mapping = (0, 1)
    elif code <= 8:
        family = 1 if channels > 2 else 0
        streams, coupled = code - _OPUS_COUPLED[code], _OPUS_COUPLED[code]
        if family:
            mapping = _OPUS_MAP_A[channels - 1]
    elif code >= 0x82:
        family, streams, coupled = 1, channels, 0
        mapping = tuple(range(channels))
    else:                                         # 0x81: the extended configuration
        if len(rest) < 2 or rest[0] == 0:
            return None
        channels, family = rest[0], rest[1]
        if family == 0 and channels <= 2:
            streams, coupled = channels - _OPUS_COUPLED[channels], _OPUS_COUPLED[channels]
        else:
            read = _bits(rest[2:])
            m1 = read(_bit_storage(channels))
            if m1 is None:
                return None
            streams = m1 + 1
            coupled = read(_bit_storage(streams + 1))
            if coupled is None:
                return None
            mapping = tuple(read(_bit_storage(streams + coupled + 1)) for _ in range(channels))
            if None in mapping:
                return None
    head = "audio/x-opus, rate=(int)48000, channels=(int)%d, channel-mapping-family=(int)%d"
    if family == 0:                               # gst_codec_utils_opus_create_caps' checks
        if channels > 2 or streams > 1 or coupled > 1:
            return None
        channels = channels or 2
        streams = streams or 1
        coupled = coupled or (1 if channels == 2 else 0)
        return (head + ", stream-count=(int)%d, coupled-count=(int)%d") % (
            channels, family, streams, coupled)
    if channels == 0 or streams == 0 or coupled > streams:
        return None
    return (head + ", stream-count=(int)%d, coupled-count=(int)%d, channel-mapping=(int)< %s >") % (
        channels, family, streams, coupled, ", ".join(str(m) for m in mapping))


def classify(stream_type, es_info):
    """Part 4.2's row for a PMT entry: its pad class, tsdemux's caps string, sparse flag and AU
    post-processing; None for no pad. Where two rows match one 0x06 loop, tsdemux's order decides
    (AC-4's extension, 0x6A, 0x7A, 0x56, 0x59, then the registration)."""
    es_info = bytes(es_info)
    reg = registration_format(es_info)
    lang = language(es_info)

    def es(cls, caps, sparse=False, post="none", opus_ext=b"", av1_desc=b""):
        return EsPlan(cls, caps, sparse, post, lang, reg, opus_ext, av1_desc)

    t = stream_type
    if t in (0x01, 0x02):
        return es("video", "video/mpeg, mpegversion=(int)%d, systemstream=(boolean)false" % t)
    if t == 0x1B:
        return es("video", CAPS_H264)
    if t == 0x24:
        return es("video", CAPS_H265)
    if t in (0x03, 0x04):
        return es("audio", CAPS_MPA)
    if t == 0x0F:
        return es("audio", CAPS_ADTS, post="adts")
    if t == 0x11:
        return es("audio", CAPS_LOAS)
    if t == 0x81:                                 # tsdemux: E-AC-3 when 0x7A says so
        return es("audio", CAPS_EAC3 if find_descriptor(es_info, 0x7A) is not None else CAPS_AC3)
    if t == 0x87:
        return es("audio", CAPS_EAC3)
    if t == 0x15:
        fmt = metadata_format(es_info)
        if fmt == REG_KLVA:
            return es("private", CAPS_KLV, True, "klv")
        if fmt == REG_ID3:
            return es("private", CAPS_ID3, True)
        return None
    if t != 0x06:
        return None
    if find_descriptor(es_info, 0x7F, 0x15) is not None:
        return None                               # AC-4: tsdemux's audio/x-ac4, no row here
    if find_descriptor(es_info, 0x6A) is not None:
        return es("audio", CAPS_AC3)
    if find_descriptor(es_info, 0x7A) is not None:
        return es("audio", CAPS_EAC3)
    if find_descriptor(es_info, 0x56) is not None:
        return es("private", CAPS_TTX, True)
    if find_descriptor(es_info, 0x59) is not None:
        return es("subpicture", CAPS_DVBSUB, True)
    if reg == REG_BSSD:
        return es("audio", CAPS_302M)
    if reg == REG_AV1G:
        # The av1C fields of tsdemux's caps come from the descriptor, through pbutils: the element's.
        return es("video", CAPS_AV1, av1_desc=find_descriptor(es_info, 0x80) or b"")
    if reg == REG_OPUS:
        ext = find_descriptor(es_info, 0x7F)
        caps = opus_caps(ext)
        return es("audio", caps, post="opus", opus_ext=ext) if caps else None
    if reg == REG_HEVC:
        return es("video", CAPS_H265)
    if reg == REG_KLVA:
        return es("private", CAPS_KLV, True)
    if reg == REG_ID3:
        return es("private", CAPS_ID3, True)
    return None


# The classes tsdemux (or the BluRay mapping) gives the types part 4.2 has no row for.
_UNKNOWN_VIDEO = frozenset({0x10, 0x21, 0x32, 0x33, 0x42, 0x80, 0xD1, 0xEA})
_UNKNOWN_AUDIO = frozenset({0x82, 0x83, 0x84, 0x85, 0x8A, 0x8B, 0xA1, 0xA2})
_UNKNOWN_SUBPICTURE = frozenset({0x90, 0x92, 0xFF})


def unknown_class(stream_type, es_info):
    """The class of an ES with no row, so its warning comes only where `media` holds it (part
    4.1's guard): tsdemux's for what it exposes (DTS in any form audio), else private."""
    if stream_type == 0x06:
        reg = registration_format(es_info)
        if find_descriptor(es_info, 0x7F, 0x15) is not None or reg in REG_DTS + (REG_AC4, REG_OPUS):
            return "audio"
        return "video" if reg == REG_VP09 else "private"
    if stream_type in _UNKNOWN_VIDEO:
        return "video"
    if stream_type in _UNKNOWN_AUDIO:
        return "audio"
    return "subpicture" if stream_type in _UNKNOWN_SUBPICTURE else "private"


def pad_name(cls, gen, pid):
    """tsdemux's "%s_%01x_%04x": the program generation in 4 bits, the first 0 (S13)."""
    return "%s_%01x_%04x" % (cls, gen & 0xF, pid)


def same_program(old, new):
    """tsdemux's mpegts_base_is_same_program on two PMTs: the PCR PID, the stream count and each
    stream's (PID, stream type) as before. A version-, language- or descriptor-only change keeps the
    pads; a moved PMT PID is no change of its own (the PAT handler moves the program first)."""
    if old.program_number != new.program_number or old.pcr_pid != new.pcr_pid:
        return False
    if len(old.streams) != len(new.streams):
        return False
    types = {pid: stype for pid, stype, _ in old.streams}
    return all(types.get(pid) == stype for pid, stype, _ in new.streams)


# --- AU post-processing, applied by the element (pure functions) --------------------------------

def adts_mpegversion(payload):
    """tsdemux's parse_aac_adts_frame: 2 when the first ADTS header has the ID bit (MPEG-2 AAC),
    else 4, which is also its answer without a valid header."""
    n = len(payload)
    if n < 6:
        return 4
    loc = next((i for i in range(n - 2) if payload[i] == 0xFF and (payload[i + 1] & 0xF6) == 0xF0),
               -1)
    if loc < 0 or n - loc < 6:
        return 4
    frame_len = (((payload[loc + 3] & 0x03) << 11) | (payload[loc + 4] << 3)
                 | ((payload[loc + 5] & 0xE0) >> 5))
    if frame_len < 7 + (0 if payload[loc + 1] & 0x01 else 2):
        return 4
    return 2 if payload[loc + 1] & 0x08 else 4


def opus_access_units(payload):
    """tsdemux's parse_opus_access_unit: [(packet, trim_start, trim_end)], the control headers
    stripped (a payload without one is one raw packet); None where tsdemux fails the PES."""
    n = len(payload)
    if n < 2:
        return None
    if (int.from_bytes(payload[:2], "big") >> 5) != 0x3FF:
        return [(bytes(payload), 0, 0)]
    out, i = [], 0
    while True:
        if i + 2 > n:
            return None
        cid = int.from_bytes(payload[i:i + 2], "big")
        i += 2
        if (cid >> 5) != 0x3FF:
            return None
        size = 0
        while True:
            if i >= n:
                return None
            b = payload[i]
            i += 1
            size += b
            if b != 0xFF:
                break
        start = end = 0
        if cid & 0x10:
            if i + 2 > n:
                return None
            start = int.from_bytes(payload[i:i + 2], "big")
            i += 2
        if cid & 0x08:
            if i + 2 > n:
                return None
            end = int.from_bytes(payload[i:i + 2], "big")
            i += 2
        if cid & 0x04:
            if i >= n or i + 1 + payload[i] > n:
                return None
            i += 1 + payload[i]
        # tsdemux's FIXME: au_size counts the packet alone (ffmpeg's and obe's streams).
        if n - i < size:
            return None
        out.append((bytes(payload[i:i + size]), start, end))
        i += size
        if i >= n:
            return out


def klv_metadata_cells(payload):
    """tsdemux's parse_pes_metadata_frame (0x15 KLV): [(service_id, sequence, flags, cell)], each
    cell cut to what remains; None where tsdemux fails the PES."""
    out, i, n = [], 0, len(payload)
    while True:
        if n - i < 5:
            return None
        service, seq, flags = payload[i], payload[i + 1], payload[i + 2]
        size = min(int.from_bytes(payload[i + 3:i + 5], "big"), n - i - 5)
        i += 5
        out.append((service, seq, flags, bytes(payload[i:i + size])))
        i += size
        if i >= n:
            return out


# --- DemuxCore ----------------------------------------------------------------------------------

class Event(dict):
    """One output: its .demux.jsonl fields in order, `kind` the line's key; a unit's or a
    section's `payload` and `pid`; a unit's PES fields `raw` (pts33, dts33, pts_u, dts_u), a
    plan's `pads` (EsPlan by pad) for the tests and the element."""

    def __init__(self, kind, fields, payload=b"", pid=-1, raw=None, pads=None):
        super().__init__(fields)
        self.kind, self.payload, self.pid, self.raw, self.pads = kind, payload, pid, raw, pads

    def line(self):
        return json.dumps({self.kind: self}, separators=(",", ":"))


class Config:
    def __init__(self, program=-1, media=MEDIA_ALL, select="", sparse_gap_lag_ns=500000000,
                 max_pes_bytes=32 << 20):
        self.program = program
        self.media = tuple(media)
        self.select = select or ""
        self.sparse_gap_lag_ns = sparse_gap_lag_ns
        self.max_pes_bytes = max_pes_bytes


class _Pad:
    """One output pad's stream state; select mode's one pad keeps its horizon across PIDs."""
    __slots__ = ("name", "pid", "stype", "es", "cls", "sparse", "s302m", "uw", "emitted", "discont",
                 "have_horizon", "horizon", "have_last", "clean", "last_pts", "spacings",
                 "next_spacing", "house_checked")

    def __init__(self, name, pid, stype, es):
        self.name, self.pid, self.stype, self.es = name, pid, stype, es
        self.cls, self.sparse, self.s302m = es.cls, es.sparse, es.caps == CAPS_302M
        self.uw = Unwrapper()
        self.emitted = self.discont = False       # the next unit is DISCONT
        self.have_horizon = False                 # the end of what it emitted, data or gap
        self.horizon = 0
        self.have_last = self.clean = False       # clean: nothing came between it and the next
        self.last_pts = 0
        self.spacings = []
        self.next_spacing = 0
        self.house_checked = False

    def frame(self):
        """The upper median of its last 8 clean spacings, -1 before two (SelectDemux::frame_ns)."""
        if len(self.spacings) < 2:
            return -1
        return sorted(self.spacings)[len(self.spacings) // 2]

    def learn(self, spacing):
        if len(self.spacings) < DemuxCore.SPACING_WINDOW:
            self.spacings.append(spacing)
        else:
            self.spacings[self.next_spacing] = spacing
        self.next_spacing = (self.next_spacing + 1) % DemuxCore.SPACING_WINDOW

    def forget_stream(self):
        self.uw.reset()
        self.have_last = self.clean = False
        self.spacings = []
        self.next_spacing = 0


Program = namedtuple("Program", "gen pmt pads")


class DemuxCore:
    """mrts::DemuxCore: feed bus buffers, take the events in order (Section, Plan, Gone, Unit, Gap,
    Unknown, NotHouseTime, NoStream). Demux mode by default; Config.select = SelectDemux."""
    NO_STREAM_NS = 2 * SEC                        # a PMT without a stream for us this long
    JUMP_FRAMES = 2                               # an audio hole past this many frames is a gap
    SPACING_WINDOW = 8
    SPACING_MAX_NS = SEC                          # a longer PES spacing is no frame
    VIDEO_HOLE_NS = SEC                           # B-89: a video hole is a gap from 1 s
    NOT_HOUSE_NS = 60 * SEC
    WAITING, FOUND, MISSING = "waiting", "found", "missing"

    def __init__(self, cfg=None):
        self.cfg = cfg or Config()
        self._select = self.cfg.select != ""
        if self._select and self.cfg.select != CAPS_302M:
            raise ValueError('select "%s" names no stream the demux can select' % self.cfg.select)
        self._walker = PacketWalker()
        self._cc = CcTracker()
        self._cc_lost_before = 0                  # losses of trackers a flush replaced
        self._psi = PsiDiscovery()
        self._psi.select_program(self.cfg.program)
        self._pes = PesAssembler(self.cfg.max_pes_bytes)
        self._now = -1
        self._gen = self._pat_gen = 0             # the PSI generations already acted on
        self._state = self.WAITING
        self._missing_since = -1
        self._warned = False
        self._program = None                      # demux mode: the planned program
        self._pads = {}                           # PID -> _Pad of the planned program
        self._pcr_uw = Unwrapper()
        self._have_pt = False                     # program time: newest PCR or non-sparse end
        self._pt = 0
        self._one = None                          # select mode's pad, the stream's PID on it
        if self._select:
            self._one = _Pad("src", -1, 0x06, EsPlan("audio", CAPS_302M, False, "none", "", REG_BSSD,
                                                     b"", b""))
        self._k = dict(pes=0, gaps=0, markers=0, markersDropped=0, pesNoPts=0, unknownStreams=0)
        self._dts_discarded_before = 0

    # --- the API ---

    def feed(self, data, bus_discont=False, house_now_ns=-1):
        """One bus buffer, any chunking; house_now_ns: clock - base time, < 0 without a clock (a
        first PES then seeds on itself). bus_discont: bytes may be missing before it."""
        out = []
        self._now = house_now_ns
        if bus_discont:
            # No packet joins across, the open PES are dropped, every pad's next unit is DISCONT.
            self._walker.reset()
            self._pes.reset()
            for pad in self._live_pads():
                pad.discont = True
                pad.clean = False
        for pkt in self._walker.feed(data):
            self._on_packet(parse_packet(pkt), out)
        if self._state == self.MISSING and not self._warned and self._now >= 0:
            if self._missing_since < 0:
                self._missing_since = self._now
            elif self._now - self._missing_since >= self.NO_STREAM_NS:
                self._warned = True
                out.append(Event("nostream", {}))
        return out

    def marker(self, data, end_ns):
        """A gap-marker buffer (OQ-12): whole packets, end_ns its PTS as running time (< 0:
        unplaced). Each marker packet on a pad's PID is a GAP [max(horizon, end - length), end),
        dropped when empty; never walked (B-60)."""
        out = []
        for i in range(0, len(data) - PKT + 1, PKT):
            p = data[i:i + PKT]
            if p[0] != SYNC_BYTE:
                continue
            pad = self._pad_of(ts_pid(p))
            if pad is None:
                continue
            length = read_gap_length(p)
            if length < 0:
                continue
            # The producer marks a PID right before its first PES after the hole, so the PES
            # still open (unbounded, ended only by that PUSI) is whole: out before the gap.
            units = []
            self._pes.close(pad.pid, units)
            for u in units:
                self._on_unit(pad, u, out)
            self._k["markers"] += 1
            if end_ns < 0:
                self._k["markersDropped"] += 1
                continue
            # B-21: never before what the pad emitted, and dropped when nothing remains.
            start = 0 if length >= end_ns else end_ns - length
            if pad.have_horizon and start < pad.horizon:
                start = pad.horizon
            if start >= end_ns:
                self._k["markersDropped"] += 1
                continue
            self._gap(pad, start, end_ns, "marker", out)
            pad.clean = False                     # an outage's or an edit's spacing is no frame
        return out

    def drain(self):
        """EOS: the open unbounded PES out."""
        out, units = [], []
        self._pes.flush(units)
        for u in units:
            self._on_unit(self._pad_of(u.pid), u, out)
        return out

    def flush(self):
        """FLUSH_STOP: the carry, open PES, CC and unwrap state, horizons, program time; PSI and
        the plan stay."""
        self._walker.reset()
        self._cc_lost_before += self._cc.lost
        self._cc = CcTracker()
        self._pes.reset()
        for pad in self._all_pads():
            pad.forget_stream()
            pad.have_horizon = pad.emitted = pad.discont = False
            pad.horizon = 0
        self._pcr_uw.reset()
        self._have_pt = False
        self._pt = 0

    def counters(self):
        dts = self._dts_discarded_before + sum(p.uw.dts_discarded for p in self._all_pads())
        return dict(pes=self._k["pes"], gaps=self._k["gaps"], markers=self._k["markers"],
                    markersDropped=self._k["markersDropped"], pesNoPts=self._k["pesNoPts"],
                    desyncBytes=self._walker.desync_bytes, ccLost=self._cc_lost_before + self._cc.lost,
                    pesOversize=self._pes.oversize, pesDroppedCc=self._pes.dropped_cc,
                    psiUnsupported=self._psi.unsupported, dtsDiscarded=dts,
                    unknownStreams=self._k["unknownStreams"],
                    generation=self._program.gen if self._program else -1)

    # Accessors for the tests and the element.
    def state(self):
        return self._state

    def pid(self):
        return self._one.pid if self._select else -1

    def program(self):
        return self._psi.program

    def frame_ns(self):
        return self._one.frame() if self._select else -1

    def program_time_ns(self):
        return self._pt if self._have_pt else -1

    def pads(self):
        return [p.name for p in self._live_pads()]

    def selected_pids(self):
        return self._pes.selected()

    # --- the walk ---

    def _live_pads(self):
        if self._select:
            return [self._one] if self._one.pid >= 0 else []
        return list(self._pads.values())

    def _all_pads(self):
        """With select mode's pad while no PID is on it (SelectDemux's state is not per PID)."""
        return [self._one] if self._select else list(self._pads.values())

    def _pad_of(self, pid):
        if self._select:
            return self._one if self._one.pid >= 0 and pid == self._one.pid else None
        return self._pads.get(pid)

    def _on_packet(self, v, out):
        cc = self._cc.feed(v)
        if v.pid == PID_PAT or (self._psi.pmt_pid >= 0 and v.pid == self._psi.pmt_pid):
            self._on_psi(v, out)
            return
        # A PCR first: the adaptation field precedes the payload.
        if v.af_pcr and self._program is not None and v.pid == self._program.pmt.pcr_pid:
            self._on_pcr(v, out)
        pad = self._pad_of(v.pid)
        if pad is None:
            return
        units = []
        self._pes.feed(v, cc, units)
        for u in units:
            self._on_unit(pad, u, out)

    def _on_psi(self, v, out):
        self._psi.feed([v.p])
        if self._select:
            self._on_psi_select()
            return
        if self._psi.pat_generation != self._pat_gen:
            self._pat_gen = self._psi.pat_generation
            self._section("pat", PID_PAT, self._psi.pat_section(), out)
        if self._psi.generation == self._gen or self._psi.pmt is None:
            return
        self._gen = self._psi.generation
        # The PMT section before the pads, unlike tsdemux: the muxer hooks read it there (S14).
        self._section("pmt", self._psi.pmt_pid, self._psi.pmt_section(), out)
        self._on_pmt(self._psi.pmt, out)

    @staticmethod
    def _section(table, pid, sec, out):
        if sec is None:
            return
        version = (sec[5] >> 1) & 0x1F if len(sec) > 5 else -1
        out.append(Event("section", {"table": table, "pid": pid, "version": version,
                                     "len": len(sec), "crc32": crc32_hex(sec)}, payload=sec, pid=pid))

    def _on_psi_select(self):
        """SelectDemux::on_psi: at each PMT change the first stream select names, else missing."""
        if self._psi.generation == self._gen or self._psi.pmt is None:
            return
        self._gen = self._psi.generation
        pad = self._one
        match = next((pid for pid, stype, es_info in self._psi.pmt.streams
                      if PID_PAT < pid < PID_NULL and pid != self._psi.pmt_pid and stype == 0x06
                      and registration_format(es_info) == REG_BSSD), -1)
        if match >= 0:
            if match != pad.pid:
                if pad.pid >= 0:
                    self._pes.select(pad.pid, False)
                pad.pid = match
                self._pes.select(match, True)
                pad.forget_stream()
                pad.discont = True                # another stream on the same pad
            self._state = self.FOUND
            return
        if pad.pid >= 0:
            self._pes.select(pad.pid, False)
            pad.pid = -1
            pad.forget_stream()
        self._missing()

    def _missing(self):
        if self._state != self.MISSING:           # a new episode: the 2 s run from this PMT
            self._state = self.MISSING
            self._missing_since = self._now
            self._warned = False

    def _on_pmt(self, pmt, out):
        """A new program by tsdemux's rule: the old pads' open PES drained, the plan (generation
        + 1), its unknown streams, then the old program gone (tsdemux's drain, add, remove)."""
        if not pmt.streams:
            return                                # tsdemux skips a PMT without entries
        old = self._program
        if old is not None and same_program(old.pmt, pmt):
            return
        if old is not None:
            units = []
            self._pes.flush(units)
            for u in units:
                self._on_unit(self._pads[u.pid], u, out)
            for pid, pad in self._pads.items():
                self._pes.select(pid, False)
                self._dts_discarded_before += pad.uw.dts_discarded
        gen = 0 if old is None else old.gen + 1
        pads, unknown, seen = [], [], set()
        for pid, stype, es_info in pmt.streams:
            if not PID_PAT < pid < PID_NULL or pid == self._psi.pmt_pid or pid in seen:
                continue
            seen.add(pid)
            es = classify(stype, es_info)
            if es is None:
                if stype not in SECTION_TYPES and unknown_class(stype, es_info) in self.cfg.media:
                    unknown.append((pid, stype, registration_format(es_info)))
                continue
            if es.cls in self.cfg.media:
                pads.append(_Pad(pad_name(es.cls, gen, pid), pid, stype, es))
        self._pads = {}
        for pad in pads:
            self._pads[pad.pid] = pad
            self._pes.select(pad.pid, True)
            if pad.sparse and self._have_pt:
                pad.have_horizon, pad.horizon = True, self._pt
        self._pcr_uw = Unwrapper()
        self._program = Program(gen, pmt, pads)
        out.append(Event("plan", {"gen": gen, "program": pmt.program_number, "pcrPid": pmt.pcr_pid,
                                  "pads": [{"pad": p.name, "pid": p.pid, "type": p.stype,
                                            "caps": p.es.caps, "sparse": p.es.sparse,
                                            "lang": p.es.lang, "post": p.es.post} for p in pads]},
                         pads={p.name: p.es for p in pads}))
        for pid, stype, reg in unknown:
            self._k["unknownStreams"] += 1
            out.append(Event("unknown", {"pid": pid, "type": stype, "reg": reg_text(reg), "gen": gen},
                             pid=pid))
        if old is not None:
            out.append(Event("gone", {"gen": old.gen}))
        if pads:
            self._state = self.FOUND
        else:
            self._missing()

    def _on_pcr(self, v, out):
        pcr = read_pcr(v.p)
        if pcr < 0:
            return
        base = pcr // 300
        seed = ns_to_pts90k(self._now) + MUX_CLOCK_BASE_90K if self._now >= 0 else base
        base_u = self._pcr_uw.feed(base, seed)
        self._advance(pcr27_to_ns((base_u - MUX_CLOCK_BASE_90K) * 300 + pcr % 300), out)

    def _advance(self, t, out):
        """Program time on to t (B-86: a sparse PCR is valid, so units move it too); each sparse pad
        a GAP [horizon, t - lag) once that span is past the lag."""
        if t < 0 or (self._have_pt and t <= self._pt):
            return
        self._have_pt, self._pt = True, t
        lag = self.cfg.sparse_gap_lag_ns
        for pad in self._program.pads:
            if not pad.sparse or lag <= 0:
                continue
            if not pad.have_horizon:
                pad.have_horizon, pad.horizon = True, t
            elif t - lag - pad.horizon > lag:
                # No data lost: no DISCONT and not counted with the holes.
                out.append(Event("gap", {"pad": pad.name, "pts": pad.horizon,
                                         "dur": t - lag - pad.horizon, "reason": "sparse"}, pid=pad.pid))
                pad.horizon = t - lag

    def _gap(self, pad, start, end, reason, out):
        out.append(Event("gap", {"pad": pad.name, "pts": start, "dur": end - start, "reason": reason},
                         pid=pad.pid))
        self._k["gaps"] += 1
        pad.have_horizon, pad.horizon = True, end
        pad.discont = True

    def _on_unit(self, pad, u, out):
        dur = -1
        if pad.s302m:
            frames = s302m_frames(u.payload)
            if frames >= 0:
                dur = frames * SEC // 48000
        pts = dts = -1
        raw = None
        if u.hdr.pts >= 0:
            # B-14: the seed is the unwrapped house time + 1 h, never folded to 33 bits.
            seed = ns_to_pts90k(self._now) + MUX_CLOCK_BASE_90K if self._now >= 0 else u.hdr.pts
            pts_u = pad.uw.feed(u.hdr.pts, seed)
            dts_u = pad.uw.feed_dts(u.hdr.dts, pts_u)
            pts = pts90k_to_ns_ceil(pts_u - MUX_CLOCK_BASE_90K)
            dts = pts if dts_u is None else pts90k_to_ns_ceil(dts_u - MUX_CLOCK_BASE_90K)
            raw = (u.hdr.pts, u.hdr.dts, pts_u, dts_u)
        else:
            self._k["pesNoPts"] += 1
        if pts < 0 or dts < 0:
            # No place on the timeline (no PTS, or before house time 0): out untimed, nothing learned.
            out.append(self._unit(pad, u, None, None, None, not pad.emitted or pad.discont or u.discont,
                                  raw))
            pad.emitted = True
            pad.discont = pad.clean = False
            return
        if not self._select and not pad.house_checked:
            pad.house_checked = True
            if self._now >= 0 and abs(pts - self._now) > self.NOT_HOUSE_NS:
                d = pts - self._now
                out.append(Event("nothouse", {"pid": pad.pid, "offsetMs": d // 1000000 if d >= 0
                                              else -(-d // 1000000)}, pid=pad.pid))
        frame = pad.frame()
        clean = pad.have_last and pad.clean and not u.discont
        if not pad.sparse and pad.have_last and pad.have_horizon and frame > 0:
            # The jump rule (S5): audio past two frames, video a hole of 1 s or more (B-89).
            hole = pts - pad.horizon
            if pad.cls == "video":
                jump = hole >= self.VIDEO_HOLE_NS
            else:
                jump = hole > self.JUMP_FRAMES * frame
            if jump:
                self._gap(pad, pad.horizon, pts, "jump", out)
        # A jump's own spacing joins (a cadence rise is learned, B-21); a gap's or a loss's does not.
        if not pad.sparse and clean and 0 < pts - pad.last_pts <= self.SPACING_MAX_NS:
            pad.learn(pts - pad.last_pts)
        discont = not pad.emitted or pad.discont or u.discont
        out.append(self._unit(pad, u, pts, dts, dur if dur >= 0 else None, discont, raw))
        pad.emitted = True
        pad.discont = False
        pad.have_last = pad.clean = True
        pad.last_pts = pts
        # Its end: the 302M duration, else one learned frame (none on a sparse pad), else its start.
        end = pts + (dur if dur >= 0 else 0 if pad.sparse else max(frame, 0))
        if not pad.have_horizon or end > pad.horizon:
            pad.have_horizon, pad.horizon = True, end
        if not self._select and not pad.sparse:
            self._advance(end, out)

    def _unit(self, pad, u, pts, dts, dur, discont, raw):
        self._k["pes"] += 1
        return Event("unit", {"pad": pad.name, "pts": pts, "dts": dts, "dur": dur, "len": u.size,
                              "crc32": crc32_hex(u.payload), "discont": discont},
                     payload=bytes(u.payload), pid=u.pid, raw=raw)


def reg_text(reg):
    """A registration as the unknown line shows it: its four characters when printable."""
    if reg == 0:
        return ""
    b = reg.to_bytes(4, "big")
    return b.decode("latin-1") if all(0x20 <= c < 0x7F for c in b) else "0x%08x" % reg


# --- the replay, `mrts_cli demux`'s twin --------------------------------------------------------

def first_pes_house_ns(data):
    """A recording's own house time: its first PES PTS - 1 h (the formula), -1 without one."""
    for off in range(0, len(data) - PKT + 1, PKT):
        p = data[off:off + PKT]
        if p[0] != SYNC_BYTE or not (p[1] & 0x40) or not (p[3] & 0x10):
            continue
        at = hr.payload_offset(p)
        if at >= PKT:
            continue
        h = parse_pes_header(p, at, PKT - at)
        if h is not None and h.pts >= 0:
            return pts90k_to_ns_ceil((h.pts - MUX_CLOCK_BASE_90K) % PTS_WRAP)
    return -1


def replay(data, cfg=None, chunk=1316, house_ns=None, bus=None):
    """Every event of `data` through one DemuxCore, then the drain: fed in `chunk`-byte pieces,
    or per bus buffer of a sidecar (`bus`: its lines; GAP buffers to marker(), DISCONT kept), at
    one house time (default: the recording's first PES - 1 h). Returns (events, core)."""
    core = DemuxCore(cfg)
    now = first_pes_house_ns(data) if house_ns is None else house_ns
    out = []
    if bus is None:
        for at in range(0, len(data), chunk):
            out += core.feed(data[at:at + chunk], False, now)
    else:
        for b in bus:
            buf = data[b["off"]:b["off"] + b["len"]]
            if b["flags"] & 2048:                 # GST_BUFFER_FLAG_GAP: a marker, its PTS the end
                out += core.marker(buf, b["pts"] if b["pts"] is not None else -1)
            else:
                out += core.feed(buf, bool(b["flags"] & 64), now)
    out += core.drain()
    return out, core


def demux_lines(data, cfg=None, chunk=1316, house_ns=None, bus=None):
    """A recording's .demux.jsonl: replay()'s events, then the counters."""
    events, core = replay(data, cfg, chunk, house_ns, bus)
    counters = json.dumps({"counters": core.counters()}, separators=(",", ":"))
    return [e.line() for e in events] + [counters]


def main(argv):
    ap = argparse.ArgumentParser(description="DemuxCore's reference: a recording's .demux.jsonl")
    ap.add_argument("input")
    ap.add_argument("--chunk", type=int, default=1316)
    ap.add_argument("--media", default=",".join(MEDIA_ALL))
    ap.add_argument("--select", default="")
    ap.add_argument("--program", type=int, default=-1)
    ap.add_argument("--house-ns", type=int, default=None)
    ap.add_argument("--bus", default=None)
    args = ap.parse_args(argv[1:])
    with open(args.input, "rb") as f:
        data = f.read()
    bus = None
    if args.bus:
        with open(args.bus) as f:
            bus = [json.loads(line) for line in f if line.strip()]
    media = tuple(m for m in args.media.split(",") if m)
    if any(m not in MEDIA_ALL for m in media) or args.chunk < 1:
        ap.error("--media takes video,audio,private,subpicture; --chunk at least 1")
    try:
        lines = demux_lines(data, Config(program=args.program, media=media, select=args.select),
                            args.chunk, args.house_ns, bus)
    except ValueError as e:
        print(e, file=sys.stderr)
        return 2
    sys.stdout.write("".join(line + "\n" for line in lines))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
