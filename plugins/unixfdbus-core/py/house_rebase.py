#!/usr/bin/env python3
"""The Python reference of mrfanout::HouseRebase (../native/mr-bus-fanout/house_rebase.{h,cpp};
plan ch. 6 WI-P2-5, ch. 15.4 B-55): hls-player's TS onto house time, rule for rule as the C++ is
built (D3, D5, D12 and the fix round). The first timing PES lands at house now and every PES
and PCR moves by its PID's mapping; a jump on the reference PID re-anchors, a PID that did not
jump keeps its place.

A reference only: nothing loads it at runtime (ADR-0029 choice 1). The mrts pieces the C++
rests on are ported here as built, so the two agree byte for byte: the packet walk and its
resync (ts_packet), the PES header parse, field writer and split-header span (ts_pes), the PCR
fields (ts_pcr), the unwrap (ts_house) and PSI discovery (ts_psi, what a rebase reads of it).
house_rebase_test.py mirrors tests/house_rebase_test.cpp case by case, and
house_rebase_parity_test.py holds this module's output to the C++'s.

Run as a script it is tests/house_rebase_ref's twin and prints the same lines:
    house_rebase.py in.bin
in.bin, little-endian records: 'C' u32 rebase, i64 house ns, u32 len, bytes (a chunk for that
numbered rebase, a new one at its first). One JSON line per chunk, the bytes out in hex, then
each rebase's stats in number order.
"""
import struct
import sys
from collections import deque, namedtuple

PKT = 188
SYNC_BYTE = 0x47
PID_PAT = 0x0000
PID_NULL = 0x1FFF
TABLE_PAT = 0x00
TABLE_PMT = 0x02
PTS_WRAP = 1 << 33
PCR_MODULO = 300 << 33
MUX_CLOCK_BASE_90K = 3600 * 90000          # mpegtsmux's 1 h


# --- ts_house: the timescales and the unwrap --------------------------------------------------

def ns_to_pts90k(ns):
    return ns * 9 // 100000


def pts90k_to_ns(ticks):
    return ticks * 100000 // 9


def fold33(d):
    """A signed, wrap-folded delta in (-2^32, 2^32]."""
    r = d % PTS_WRAP
    return r - PTS_WRAP if r > PTS_WRAP // 2 else r


def unwrap_near(pts33, ref):
    return ref - fold33(ref - pts33)


class Unwrapper:
    """The first value nearest `seed`, every later one nearest the previous; a DTS nearest its own
    PES's PTS, None when it is absent or more than 5 s from it (damage, not decode order)."""
    DTS_MAX_GAP_90K = 5 * 90000

    def __init__(self):
        self.last = 0
        self.primed = False
        self.dts_discarded = 0

    def feed(self, pts33, seed):
        self.last = unwrap_near(pts33, self.last if self.primed else seed)
        self.primed = True
        return self.last

    def feed_dts(self, dts33, pts_unwrapped):
        if dts33 < 0:
            return None
        dts = unwrap_near(dts33, pts_unwrapped)
        if dts < pts_unwrapped - self.DTS_MAX_GAP_90K or dts > pts_unwrapped + self.DTS_MAX_GAP_90K:
            self.dts_discarded += 1
            return None
        return dts


# --- ts_packet: the header view and the walker ------------------------------------------------

def payload_offset(p):
    return 5 + p[4] if p[3] & 0x20 else 4


class PacketView:
    """mrts::PacketView of one packet; `p` is the bytearray the rewriters write in place."""
    __slots__ = ("p", "pid", "cc", "tei", "pusi", "scrambled", "has_af", "has_payload", "af_len",
                 "payload_off", "af_discontinuity", "af_rai", "af_pcr")


def parse_packet(p):
    """The view of the 188 bytes `p`, or None when they do not start with 0x47."""
    if p[0] != SYNC_BYTE:
        return None
    v = PacketView()
    v.p = p
    v.pid = ((p[1] & 0x1F) << 8) | p[2]
    v.cc = p[3] & 0x0F
    v.tei = bool(p[1] & 0x80)
    v.pusi = bool(p[1] & 0x40)
    v.scrambled = bool(p[3] & 0xC0)
    v.has_af = bool(p[3] & 0x20)
    v.has_payload = bool(p[3] & 0x10)
    v.af_len = p[4] if v.has_af else 0
    # The flags byte exists only in an AF of one byte or more; a PCR needs six more.
    flags = p[5] if v.af_len >= 1 else 0
    v.af_discontinuity = bool(flags & 0x80)
    v.af_rai = bool(flags & 0x40)
    v.af_pcr = v.af_len >= 7 and bool(flags & 0x10)
    off = payload_offset(p)
    v.payload_off = off if v.has_payload and off < PKT else PKT
    return v


class PacketWalker:
    """Whole packets in order, one split across feeds joined; a lost sync resyncs by ts_split's
    rule and the bytes skipped are counted."""

    def __init__(self):
        self.carry = b""
        self.desync_bytes = 0

    def feed(self, data):
        """Each whole packet as a fresh bytearray; the unaligned tail waits for the next feed."""
        buf = self.carry + bytes(data)
        n = len(buf)
        off = 0
        packets = []
        while off + PKT <= n:
            if buf[off] != SYNC_BYTE:
                off = self._resync(buf, off, n)
                continue
            packets.append(bytearray(buf[off:off + PKT]))
            off += PKT
        self.carry = buf[off:]
        return packets

    def _resync(self, buf, off, n):
        scan = off + 1
        while scan + PKT <= n and not (
                buf[scan] == SYNC_BYTE and (scan + 2 * PKT > n or buf[scan + PKT] == SYNC_BYTE)):
            scan += 1
        self.desync_bytes += scan - off
        return scan


# --- ts_pes: the header parse, the field writer, the split-header span ------------------------

# ISO 13818-1 2.4.3.7: the stream ids without an optional header.
_NO_OPTIONAL_HEADER = frozenset({0xBC, 0xBE, 0xBF, 0xF0, 0xF1, 0xF2, 0xF8, 0xFF})


class PesHeader:
    __slots__ = ("sid", "pts", "dts", "header_len", "payload_len", "data_alignment", "pts_off",
                 "dts_off", "complete")

    def __init__(self):
        self.sid = 0
        self.pts = self.dts = -1                  # raw 33-bit, -1 absent
        self.header_len = 0                       # 0: not yet known
        self.payload_len = -1                     # -1: unbounded
        self.data_alignment = False
        self.pts_off = self.dts_off = -1
        self.complete = False


def _read_ts_field(b, i):
    return ((((b[i] >> 1) & 0x07) << 30) | (b[i + 1] << 22) | ((b[i + 2] >> 1) << 15)
            | (b[i + 3] << 7) | (b[i + 4] >> 1))


def parse_pes_header(b, at, n):
    """The PES header starting at b[at], `n` bytes there, or None: not a PES start. Cut short by
    n, a header that is not `complete`, with what n covers (lenient as mrts's)."""
    for i in range(min(3, n)):
        if b[at + i] != (0, 0, 1)[i]:
            return None
    h = PesHeader()
    need = 9
    if n >= 4:
        h.sid = b[at + 3]
        if h.sid in _NO_OPTIONAL_HEADER:
            h.header_len = 6
            need = 6
        else:
            if n >= 7:
                if (b[at + 6] & 0xC0) != 0x80:   # the '10' marker
                    return None
                h.data_alignment = bool(b[at + 6] & 0x04)
            if n >= 9:
                h.header_len = 9 + b[at + 8]
                # Read at 9 and 14 whatever PES_header_data_length says; '01' reads as no PTS.
                flags = b[at + 7] >> 6
                if flags & 2:
                    need = 19 if flags == 3 else 14
                    if n >= 14:
                        h.pts_off = 9
                        h.pts = _read_ts_field(b, at + 9)
                    if flags == 3 and n >= 19:
                        h.dts_off = 14
                        h.dts = _read_ts_field(b, at + 14)
                need = max(need, h.header_len)
        if h.header_len > 0 and n >= 6:
            length = (b[at + 4] << 8) | b[at + 5]
            if length > 0 and 6 + length >= h.header_len:
                h.payload_len = 6 + length - h.header_len
    h.complete = h.header_len > 0 and n >= need
    return h


def write_pes_ts_field(f, i, v33):
    """The 5-byte field at f[i]: the 4-bit prefix kept, the marker bits '1', v33 mod 2^33."""
    v = v33 % PTS_WRAP
    f[i] = (f[i] & 0xF0) | (((v >> 30) & 0x07) << 1) | 0x01
    f[i + 1] = (v >> 22) & 0xFF
    f[i + 2] = (((v >> 15) & 0x7F) << 1) | 0x01
    f[i + 3] = (v >> 7) & 0xFF
    f[i + 4] = ((v & 0x7F) << 1) | 0x01


def rewrite_pes_timestamps(v, h, pts33, dts33):
    """PTS and, when present, DTS in place; False, nothing written, unless the header is whole here."""
    if not h.complete or v.payload_off >= PKT:
        return False
    if v.payload_off + max(h.header_len, h.pts_off + 5, h.dts_off + 5) > PKT:
        return False
    if h.pts_off >= 0:
        write_pes_ts_field(v.p, v.payload_off + h.pts_off, pts33)
    if h.dts_off >= 0:
        write_pes_ts_field(v.p, v.payload_off + h.dts_off, dts33)
    return True


class _Held:
    __slots__ = ("pid", "payload_off", "cc", "b")


class PesHeaderSpan:
    """A PUSI packet whose PES header spills into its PID's next payload packet is held until then,
    both rewritten and released in order; one per PID."""

    def __init__(self):
        self._held = []
        self._dup_pid = -1                        # a duplicate join() saw: hold() lets it pass
        self._dup_cc = 0
        self.spans = 0
        self.broken = 0

    def _find(self, pid):
        i = 0
        while i < len(self._held) and self._held[i].pid != pid:
            i += 1
        return i

    def held(self, pid):
        return self._find(pid) < len(self._held)

    def hold(self, v):
        """A PUSI packet whose header continues past it is copied and held: True, emit nothing."""
        if not v.pusi or v.payload_off >= PKT or self.held(v.pid):
            return False
        if v.pid == self._dup_pid and v.cc == self._dup_cc:
            self._dup_pid = -1
            return False
        h = parse_pes_header(v.p, v.payload_off, PKT - v.payload_off)
        if h is None or h.complete:
            return False
        s = _Held()
        s.pid, s.payload_off, s.cc, s.b = v.pid, v.payload_off, v.cc, bytearray(v.p)
        self._held.append(s)
        return True

    def complete(self, v, ts):
        """On the held PID's next payload packet, the held packet to emit before `v`; both are
        rewritten by ts(joined header, pts33, dts33) -> (pts33, dts33) unless a CC gap or a PUSI
        cut it. None for any other packet."""
        if not self._held or v.payload_off >= PKT:
            return None
        i = self._find(v.pid)
        if i == len(self._held):
            return None
        s = self._held[i]
        h = self._join(s, v)
        if h is not None:
            pts33, dts33 = ts(h, h.pts, h.dts)
            self._write(s, v, h, pts33, dts33)
            self.spans += 1
        else:
            self.broken += 1
        del self._held[i]
        return s.b

    def _join(self, s, v):
        # A duplicate (2.4.3.3): the decoder keeps the first copy, so every copy passes as is.
        if (v.pusi and v.cc == s.cc and v.payload_off == s.payload_off
                and v.p[v.payload_off:] == s.b[s.payload_off:]):
            self._dup_pid, self._dup_cc = v.pid, v.cc
            return None
        # After a CC gap or at a new PES start the next bytes are not this header's.
        if v.pusi or v.cc != ((s.cc + 1) & 0x0F):
            return None
        buf = s.b[s.payload_off:] + v.p[v.payload_off:]
        h = parse_pes_header(buf, 0, len(buf))
        return h if h is not None and h.complete else None

    @staticmethod
    def _write(s, v, h, pts33, dts33):
        k = PKT - s.payload_off

        def put(off, val):
            at = [(s.b, s.payload_off + off + j) if off + j < k else (v.p, v.payload_off + off + j - k)
                  for j in range(5)]
            f = bytearray(b[i] for b, i in at)
            write_pes_ts_field(f, 0, val)
            for j, (b, i) in enumerate(at):
                b[i] = f[j]

        if h.pts_off >= 0:
            put(h.pts_off, pts33)
        if h.dts_off >= 0:
            put(h.dts_off, dts33)


# --- ts_pcr -----------------------------------------------------------------------------------

def read_pcr(p):
    """The 27 MHz PCR in the packet's adaptation field, or -1."""
    if not (p[3] & 0x20) or p[4] < 7 or not (p[5] & 0x10):
        return -1
    base = (p[6] << 25) | (p[7] << 17) | (p[8] << 9) | (p[9] << 1) | (p[10] >> 7)
    return base * 300 + (((p[10] & 0x01) << 8) | p[11])


def write_pcr(p, pcr27):
    """The PCR rewritten in place (pcr27 >= 0), the reserved bits set; False without a PCR field."""
    if not (p[3] & 0x20) or p[4] < 7 or not (p[5] & 0x10):
        return False
    base = (pcr27 // 300) & 0x1FFFFFFFF
    ext = pcr27 % 300
    p[6] = (base >> 25) & 0xFF
    p[7] = (base >> 17) & 0xFF
    p[8] = (base >> 9) & 0xFF
    p[9] = (base >> 1) & 0xFF
    p[10] = ((base & 0x01) << 7) | 0x7E | ((ext >> 8) & 0x01)
    p[11] = ext & 0xFF
    return True


def set_discontinuity_indicator(v):
    """AF flags bit 7; False without an AF flags byte (an AF of length 0 is one stuffing byte)."""
    if not v.has_af or v.af_len < 1:
        return False
    v.p[5] |= 0x80
    v.af_discontinuity = True
    return True


# --- ts_psi: PAT -> PMT discovery, what a rebase reads of it ----------------------------------

Pmt = namedtuple("Pmt", "program_number pcr_pid streams version program_info")


def _section_head(p):
    """Where the section starting in packet p begins when its header is in p, else -1."""
    if not (p[1] & 0x40) or not (p[3] & 0x10):
        return -1
    off = payload_offset(p)
    if off >= PKT:
        return -1
    start = off + 1 + p[off]                      # pointer_field -> section start
    return start if start + 8 <= PKT else -1


def section_signature(p):
    """(table_id, table_id_ext, version, CRC or None while the tail is in a later packet) of the
    current section 0 that starts in p, or None."""
    s = _section_head(p)
    if s < 0 or not (p[s + 1] & 0x80) or not (p[s + 5] & 0x01) or p[s + 6] != 0:
        return None
    section_length = ((p[s + 1] & 0x0F) << 8) | p[s + 2]
    if section_length < 9:
        return None
    total = 3 + section_length
    crc = int.from_bytes(p[s + total - 4:s + total], "big") if s + total <= PKT else None
    return (p[s], (p[s + 3] << 8) | p[s + 4], (p[s + 5] >> 1) & 0x1F, crc)


def first_section(packets, pid):
    """The first complete section 0 on `pid` (a later section is skipped with its length), or None."""
    buf = bytearray()
    want = -1
    collecting = False
    for p in packets:
        if ((p[1] & 0x1F) << 8 | p[2]) != pid or not (p[3] & 0x10):
            continue
        off = payload_offset(p)
        if off >= PKT:
            continue
        if p[1] & 0x40:
            # `want` is not reset: a new start reuses a pending length (mrts, python parity).
            buf = bytearray(p[off + min(1 + p[off], PKT - off):])
            collecting = True
        elif collecting:
            buf += p[off:]
        if collecting and want < 0 and len(buf) >= 3:
            want = 3 + (((buf[1] & 0x0F) << 8) | buf[2])
        if collecting and len(buf) >= 7 and (buf[1] & 0x80) and buf[6] != 0:
            collecting = False
            want = -1
            continue
        if collecting and want > 0 and len(buf) >= want:
            return bytes(buf[:want])
    return None


def parse_pat(packets):
    """[(program_number, pmt_pid)] in section order, program 0 (the NIT) left out."""
    sec = first_section(packets, PID_PAT)
    out = []
    if sec is None or sec[0] != TABLE_PAT:
        return out
    end = 3 + (((sec[1] & 0x0F) << 8) | sec[2]) - 4
    i = 8
    while i + 4 <= end and i + 4 <= len(sec):
        prog = (sec[i] << 8) | sec[i + 1]
        if prog != 0:
            out.append((prog, ((sec[i + 2] & 0x1F) << 8) | sec[i + 3]))
        i += 4
    return out


def parse_pmt(packets, pmt_pid):
    sec = first_section(packets, pmt_pid)
    if sec is None or sec[0] != TABLE_PMT or len(sec) < 12:
        return None
    end = 3 + (((sec[1] & 0x0F) << 8) | sec[2]) - 4
    program_info_length = ((sec[10] & 0x0F) << 8) | sec[11]
    pi_end = min(12 + program_info_length, end)
    streams = []
    i = 12 + program_info_length
    while i + 5 <= end and i + 5 <= len(sec):
        es_info_len = ((sec[i + 3] & 0x0F) << 8) | sec[i + 4]
        streams.append((((sec[i + 1] & 0x1F) << 8) | sec[i + 2], sec[i],
                        bytes(sec[i + 5:min(i + 5 + es_info_len, len(sec))])))
        i += 5 + es_info_len
    return Pmt((sec[3] << 8) | sec[4], ((sec[8] & 0x1F) << 8) | sec[9], tuple(streams),
               (sec[5] >> 1) & 0x1F, bytes(sec[12:pi_end]) if pi_end > 12 else b"")


class PsiDiscovery:
    """mrts::PsiDiscovery following the PAT's first program: per-PID buffers of only the PSI
    packets, a changed section signature re-parsed at once, a PMT re-parse every 500 feeds."""

    def __init__(self, max_psi_pkts=128):
        self._max = max_psi_pkts
        self._pat_pkts = deque()
        self._pmt_pkts = deque()
        self._n = 0
        self.pmt_pid = -1
        self.program = -1                         # the PAT's program on pmt_pid
        self._pmt_shared = False                  # the PAT maps pmt_pid to other programs too
        self.pmt = None
        self._pat_sig = self._pat_new_sig = None
        self._pmt_sig = self._pmt_new_sig = None
        self._pat_resync = self._pmt_resync = False

    def feed(self, packets):
        for p in packets:
            pid = ((p[1] & 0x1F) << 8) | p[2]
            if pid == PID_PAT:
                sig = section_signature(p)
                if sig is not None and sig[0] == TABLE_PAT and sig != self._pat_sig:
                    self._pat_pkts.clear()        # the oldest retained section would be parsed
                    self._pat_new_sig = sig
                    self._pat_resync = True
                self._pat_pkts.append(p)
                if len(self._pat_pkts) > self._max:
                    self._pat_pkts.popleft()
            elif self.pmt_pid >= 0 and pid == self.pmt_pid:
                sig = section_signature(p)
                if (sig is not None and sig[0] == TABLE_PMT and sig != self._pmt_sig
                        and (self.program < 0 or sig[1] == self.program)):
                    self._pmt_pkts.clear()
                    self._pmt_new_sig = sig
                    self._pmt_resync = True
                self._pmt_pkts.append(p)
                if len(self._pmt_pkts) > self._max:
                    self._pmt_pkts.popleft()
        self._n += 1
        if self.pmt_pid < 0 or self._pat_resync:
            pat = parse_pat(self._pat_pkts)
            if pat:
                if self._pat_resync:
                    self._pat_sig = self._pat_new_sig
                    self._pat_resync = False
                program, pmt_pid = pat[0]
                if pmt_pid != self.pmt_pid:       # the buffered packets are the old PID's
                    self.pmt_pid = pmt_pid
                    self._pmt_pkts.clear()
                    self._pmt_sig = None
                    self._pmt_resync = False
                self.program = program
                self._pmt_shared = sum(1 for _, q in pat if q == self.pmt_pid) > 1
        if self.pmt_pid >= 0 and (self.pmt is None or self._pmt_resync or self._n % 500 == 0):
            pmt = parse_pmt(self._pmt_pkts, self.pmt_pid)
            if pmt is not None and self._pmt_shared and pmt.program_number != self.program:
                pmt = None                        # a shared PMT PID: only our program's counts
            if pmt is not None and self._pmt_resync:
                self._pmt_sig = self._pmt_new_sig
                self._pmt_resync = False
            if pmt is not None and pmt != self.pmt:
                self.pmt = pmt


# --- house_rebase -----------------------------------------------------------------------------

def _video_sid(sid):                              # ISO 13818-1 table 2-22: 1110 xxxx
    return (sid & 0xF0) == 0xE0


def _audio_sid(sid):                              # 110x xxxx
    return (sid & 0xE0) == 0xC0


Stats = namedtuple("Stats", "anchored shift_90k reanchors kept dropped desync_bytes")


class _Pid:
    __slots__ = ("unwrap", "cls", "have_key", "key", "key_out", "steps", "n_steps", "step_at",
                 "jumped", "delta", "join", "pending", "seen_ns", "pcr_sent", "pcr_map", "cc",
                 "drop", "held_af")

    def __init__(self):
        self.unwrap = Unwrapper()
        self.cls = 0                              # 2 video, 1 audio, 0 other (its last timing PES)
        self.have_key = False
        self.key = 0                              # last timing PES's DTS, else PTS: unwrapped source
        self.key_out = 0                          # the same on the bus, on its mapping
        self.steps = [0, 0, 0]                    # its last key steps of at most JUMP_90K
        self.n_steps = 0
        self.step_at = 0
        self.jumped = False                       # it left its timeline since the reference's last PES
        self.delta = 0                            # its mapping is shift + delta; `pending` until its
        self.join = 0                             # next timing PES shows whether it jumped too
        self.pending = False
        self.seen_ns = 0
        self.pcr_sent = False
        self.pcr_map = 0                          # the mapping its last PCR was written with
        self.cc = -1                              # its last payload packet's CC
        self.drop = False                         # drop its payload packets until its next PUSI
        self.held_af = []                         # adaptation-only packets behind a held header


class HouseRebase:
    JUMP_90K = 90000                              # a step past this on the reference: a new timeline
    REF_STALE_NS = 2000000000                     # a reference this silent gives way
    MAX_HELD_AF = 16                              # adaptation-only packets behind a held header (R9)

    def __init__(self):
        self._walker = PacketWalker()
        self._span = PesHeaderSpan()
        self._psi = PsiDiscovery()
        self._pids = {}
        self._out = None
        self._anchored = False
        self._shift = 0                           # bus 90 kHz - source 90 kHz
        self._first_pcr_pid = -1                  # the PCR PID until a PMT names one
        self._ref = -1                            # the PID whose jumps re-anchor
        self._now = self._now_bus = 0             # house ns; the same as a bus PTS, unwrapped
        self._reanchors = self._kept = self._dropped = 0

    def process(self, data, now_ns):
        """One ingest chunk at house time `now_ns`: the bytes to send, whole packets in order."""
        out = self._out = bytearray()
        self._now = now_ns
        self._now_bus = ns_to_pts90k(now_ns) + MUX_CLOCK_BASE_90K
        for pkt in self._walker.feed(data):
            self._on_packet(parse_packet(pkt))
        self._out = None
        return bytes(out)

    def stats(self):
        return Stats(self._anchored, fold33(self._shift), self._reanchors, self._kept,
                     self._dropped, self._walker.desync_bytes)

    def _pid(self, pid):
        p = self._pids.get(pid)
        if p is None:
            p = self._pids[pid] = _Pid()
        return p

    def _pcr_pid(self):
        pmt = self._psi.pmt
        return pmt.pcr_pid if pmt is not None else self._first_pcr_pid

    @staticmethod
    def _spacing(p):
        """The upper median of its last three steps (B-21's rule), so one hole is no spacing."""
        s = p.steps
        if p.n_steps == 0:
            return 0
        if p.n_steps == 1:
            return s[0]
        if p.n_steps == 2:
            return max(s[0], s[1])
        return max(min(s[0], s[1]), min(max(s[0], s[1]), s[2]))

    def _rank(self, pid):
        if pid >= 0 and pid == self._pcr_pid():
            return 3
        p = self._pids.get(pid)
        return 0 if p is None else p.cls

    def _on_packet(self, v):
        if v.af_pcr and self._first_pcr_pid < 0:
            self._first_pcr_pid = v.pid
        if v.pid == PID_PAT or v.pid == self._psi.pmt_pid:
            self._psi.feed([bytes(v.p)])
            self._put(v.p)
            return
        if v.pid < 0x20 or v.pid == PID_NULL:      # SI tables and stuffing: no time
            self._put(v.p)
            return
        p = self._pid(v.pid)
        payload = v.payload_off < PKT
        repeat = payload and v.cc == p.cc         # ISO 13818-1 2.4.3.3: a duplicate
        if payload:
            p.cc = v.cc
        if payload and self._span.held(v.pid):
            # A copy of the held header goes alone; the first waits for its continuation (B-9).
            if repeat and v.pusi:
                self._dropped += 1
                return
            if self._release(p, v):
                return
        if not payload:
            # Behind a held header it waits for it, so the PID's PCRs leave in order.
            if self._span.held(v.pid) and len(p.held_af) < self.MAX_HELD_AF:
                p.held_af.append(bytearray(v.p))
            else:
                self._send(v)
            return
        if not v.pusi:
            if p.drop:
                self._dropped += 1
            elif not self._send(v):
                p.drop = True
            return
        p.drop = False
        if not v.scrambled:
            if self._span.hold(v):                # the header continues in the PID's next packet
                return
            h = parse_pes_header(v.p, v.payload_off, PKT - v.payload_off)
            if h is not None:
                # An incomplete header cannot be rewritten, so it never goes out on source time.
                ok = h.complete
                if ok:
                    ok, pts33, dts33 = self._retime(p, v.pid, h, h.pts, h.dts)
                if not ok:
                    p.drop = True
                    self._dropped += 1
                    return
                if h.pts >= 0:
                    rewrite_pes_timestamps(v, h, pts33, dts33)
        if not self._send(v):
            p.drop = True

    def _release(self, p, v):
        state = {"joined": False, "keep": False}

        def ts(h, pts33, dts33):
            state["joined"] = True
            state["keep"], pts33, dts33 = self._retime(p, v.pid, h, pts33, dts33)
            return pts33, dts33

        first = self._span.complete(v, ts)
        if state["keep"]:
            self._send(parse_packet(first))
        else:
            self._dropped += 1
        for pkt in p.held_af:
            self._send(parse_packet(pkt))
        p.held_af = []
        if state["keep"]:
            self._send(v)
            return True
        # Its PES cannot be placed, or the header was not joinable (lost with a CC gap or cut by
        # a new PES): a continuation goes with it, a new PES start is handled anew.
        p.drop = True
        if state["joined"]:
            self._dropped += 1
            return True
        return False

    def _retime(self, p, pid, h, pts33, dts33):
        """(placed, pts33, dts33): False when it cannot be placed yet, the fields as given."""
        if h.pts < 0:                             # no time of its own
            return True, pts33, dts33
        timing = _video_sid(h.sid) or _audio_sid(h.sid) or pid == self._pcr_pid()
        if not self._anchored and not timing:
            return False, pts33, dts33
        # A PID's first PES unwraps near the source time of house now.
        pu = p.unwrap.feed(h.pts, self._now_bus - self._shift if self._anchored else h.pts)
        du = p.unwrap.feed_dts(h.dts, pu)
        if timing:
            if not self._anchored:                # playout start: its PTS lands at house now
                self._anchored = True
                self._shift = self._now_bus - pu
            self._track(p, pid, h.sid, du if du is not None else pu, pu)
        shift = self._shift + p.delta
        pts33 = (pu + shift) % PTS_WRAP
        # A damaged DTS (more than 5 s from its PTS) decodes at its PTS.
        if h.dts >= 0:
            dts33 = (du + shift) % PTS_WRAP if du is not None else pts33
        return True, pts33, dts33

    def _track(self, p, pid, sid, key, pts):
        p.cls = 2 if _video_sid(sid) else 1 if _audio_sid(sid) else 0
        sp = self._spacing(p)
        own = key - (p.key + sp)
        jumped = p.have_key and (own > self.JUMP_90K or own < -self.JUMP_90K)
        joined = False
        if p.pending:
            # Still on its own timeline, it stays (hls-pipe's inline audio); if it jumped too, it
            # takes the mapping of the reference that re-anchored.
            p.pending = False
            joined = jumped
            if joined:
                p.delta = p.join
            else:
                self._kept += 1
        elif jumped:
            p.jumped = True
        # The reference: the PCR PID, else video, else audio; a silent one gives way.
        if self._ref != pid:
            ref = self._pids.get(self._ref)
            if (ref is None or self._now - ref.seen_ns > self.REF_STALE_NS
                    or self._rank(pid) > self._rank(self._ref)):
                self._ref = pid
        # Jumps are judged on the bus: a PID that has just taken another's re-anchor is none.
        if self._ref == pid and p.have_key and not joined:
            d = key + self._shift + p.delta - (p.key_out + sp)
            if d > self.JUMP_90K or d < -self.JUMP_90K:
                # House time continues one spacing after the last PES, but never late: the content
                # skips, and after a stall the new timeline starts at house now.
                cont = p.key_out + max(sp, 1)
                shift = max(cont, self._now_bus + (key - pts)) - key - p.delta
                # Each PID's update reads only its own fields and p's, so the order is free.
                for q, s in self._pids.items():
                    if q == pid or not s.have_key:
                        continue
                    if s.jumped:                  # it jumped first: the same discontinuity
                        s.delta = p.delta
                        s.key_out = s.key + shift + s.delta
                    else:
                        s.delta -= shift - self._shift
                        s.join = p.delta
                        s.pending = True
                self._shift = shift
                self._reanchors += 1
        # Each reference PES starts a new stretch: a jump before it is no longer this one's.
        if self._ref == pid:
            for s in self._pids.values():
                s.jumped = False
        if p.have_key and key > p.key and key - p.key <= self.JUMP_90K:
            p.steps[p.step_at] = key - p.key
            p.step_at = (p.step_at + 1) % 3
            if p.n_steps < 3:
                p.n_steps += 1
        p.have_key = True
        p.key = key
        p.key_out = key + self._shift + p.delta
        p.seen_ns = self._now

    def _send(self, v):
        if v.af_pcr:
            if not self._anchored:                # no shift to move it by yet
                self._dropped += 1
                return False
            # A PCR moves with its own PID's PES; the PCR PID's first on a new mapping is flagged.
            p = self._pid(v.pid)
            mapping = self._shift + p.delta
            if p.pcr_sent and mapping != p.pcr_map and v.pid == self._pcr_pid():
                set_discontinuity_indicator(v)
            p.pcr_sent = True
            p.pcr_map = mapping
            write_pcr(v.p, (read_pcr(v.p) + (mapping % PTS_WRAP) * 300) % PCR_MODULO)
        self._put(v.p)
        return True

    def _put(self, pkt):
        self._out += pkt


# --- the replay, tests/house_rebase_ref's twin ------------------------------------------------

def stats_line(rebase, s):
    return ('{"rebase":%d,"stats":{"anchored":%s,"shift_90k":%d,"reanchors":%d,"kept":%d,'
            '"dropped":%d,"desync_bytes":%d}}' % (rebase, "true" if s.anchored else "false",
                                                   s.shift_90k, s.reanchors, s.kept, s.dropped,
                                                   s.desync_bytes))


def main(argv):
    if len(argv) != 2:
        print("usage: house_rebase.py in.bin", file=sys.stderr)
        return 2
    with open(argv[1], "rb") as f:
        data = f.read()
    rebases = {}
    write = sys.stdout.write
    off = 0
    while off < len(data):
        if data[off] != ord("C") or off + 17 > len(data):
            print(f"bad record at byte {off}", file=sys.stderr)
            return 1
        rebase, now, n = struct.unpack_from("<IqI", data, off + 1)
        chunk = data[off + 17:off + 17 + n]
        if len(chunk) != n:
            print(f"short chunk at byte {off}", file=sys.stderr)
            return 1
        off += 17 + n
        r = rebases.get(rebase)
        if r is None:
            r = rebases[rebase] = HouseRebase()
        write('{"rebase":%d,"out":"%s"}\n' % (rebase, r.process(chunk, now).hex()))
    for rebase in sorted(rebases):
        write(stats_line(rebase, rebases[rebase].stats()) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
