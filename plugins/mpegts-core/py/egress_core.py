#!/usr/bin/env python3
"""The Python reference of mrts::EgressCore and mrts::EgressDelay (plan ch. 9 parts 4.2, 4.4 and
4.5, WI-P5-2; Phase 5 plan p5-2a, register B-221): the egress writer's data path without
GStreamer, prototyped first and kept as the reference the C++ (p5-2b) ports byte for byte (OQ-1).
Nothing loads it at runtime.

Per bus buffer the writer returns an edit list over the buffer's whole packets, the input never
written: (index, INSERT, bytes) before packet `index` (== the packet count: at the end),
(index, REPLACE, bytes), (index, DROP, None). What it does, per program of the PAT:
- every PES PTS/DTS to the network, bus_to_net (+E - 1 h mod 2^33); a header split across two
  packets of its PID held and both rewritten (PesHeaderSpan, the PID's adaptation-only packets
  held behind it), other PIDs not delayed;
- every PCR to H(emission) - D_e, H = the clock read for that PCR + E; on the PCR PID a PCR-only
  packet inserted once `pcr_interval` (35 ms) passed without one (the clock read once per buffer
  and per PCR written), adaptation-only, its CC the PID's last payload CC sent before it (the
  first payload packet's CC - 1 when none was sent; none inserted before that packet is in hand,
  a flag then carried to the next PCR);
- PCR_PID 0x1FFF: the first video ES, else audio, else the first ES, once `pcr-pid-assigned`;
- every PMT section replaced by the writer's own, on its own CC: the input program_info without
  any MRHT, ours appended (hcdesc), the version bumped (mod 32) whenever its bytes change;
- lateness = t - house_from_mux_pts(DTS else PTS, t), t the buffer's latest clock reading, of each
  timing PES (B-51's rule: video,
  audio, or any PES on the PCR PID) drives D_e (EgressDelay, part 4.4): negative counts as 0,
  beyond 60 s is `lateness-off-house` and ignored (S22);
- a D_e change: the new PMT at once, then a PCR-only packet with discontinuity_indicator, before
  the PES that caused it; a re-epoch (E or seq changed, applied at the next buffer): the same at
  the buffer's head (the version bumped even when the section's bytes did not change) and the
  new E from each PID's next PUSI; any other declared field (the
  published error class after its 10 s hold, timeline_id, ...): the new PMT at once, no flag;
- a GAP buffer (bus gap marker, OQ-12) consumed (read_gap_length, its PTS the gap's end) and
  dropped (S8); a bus silence of gap_lower_min (500 ms) between buffers is a gap too; D_e may
  come down by the gap time no earlier gap covered (one hole's markers on several PIDs once);
- packets of PIDs no PMT names are dropped until every program of the PAT has a PMT (they would
  leave on bus time), passed after; PSI below 0x20 and null packets always pass.

Run as a script (the parity verb `mrts_cli egress` prints the same lines):
    python3 -m egress_core in.ts --clock case.clock.json [--bus in.bus.jsonl] [--chunk N]
                           [--out out.ts] [--expect case.expect.jsonl]
The clock file (tests/fixtures/egress/README rows): "clock" the declaration at start ("eNs"
decimal string or number, "seq", "known", "traceable", "disciplined", "source" 0-3,
"taiOffsetS", "ptpDomain" (-1 none), "gm" (pmc or RFC 7273 text, null none), "errorUs" (null
unknown), "timelineId" (16 hex digits)), "lateness" [[content ms, lateness ms], ...], "changes"
[{"atMs", "clock": {fields}}], "config" {pcrIntervalMs, marginMs, headroomMs, floorMs, maxMs,
gapLowerMinMs}, "chunk" (1316). Time: the content clock at a byte offset is the house time of the
first PCR PID's PCRs (unwrapped, - 1 h), linear between them by offset, held outside them (no
PCR: the first timing PID's DTS, else PTS); a buffer at offset o has now = content(o) +
lateness(content(o) - content(first)), its packet i read at offset o + 188 i. Integer floor
division throughout, as python's `//` (the C++ floors likewise on negative values).
"""
import argparse
import bisect
import hashlib
import json
import os
import sys
import zlib
from collections import deque
from dataclasses import dataclass, field, replace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import demux_core as dc  # noqa: E402
import hcdesc  # noqa: E402

hr = dc.hr
PKT = hr.PKT
PID_PAT = hr.PID_PAT
PID_NULL = hr.PID_NULL
TABLE_PAT = hr.TABLE_PAT
TABLE_PMT = hr.TABLE_PMT
PTS_WRAP = hr.PTS_WRAP
PCR_MODULO = hr.PCR_MODULO
MUX_CLOCK_BASE_90K = hr.MUX_CLOCK_BASE_90K
MS = 1000000
SEC = 1000000000
INSERT, REPLACE, DROP = "insert", "replace", "drop"
GST_FLAG_GAP = 2048


# --- ts_house: the timescales (ts_house.cpp, floor arithmetic) --------------------------------

def ns_to_pts90k(ns):
    return ns * 9 // 100000


def pts90k_to_ns(t):
    return t * 100000 // 9


def ns_to_pcr27(ns):
    return (ns * 27 // 1000) % PCR_MODULO


def pcr27_to_ns(p):
    return p * 1000 // 27


def house_from_mux_pts(pts33, house_now_ns):
    raw = (pts33 - MUX_CLOCK_BASE_90K) % PTS_WRAP
    return pts90k_to_ns(hr.unwrap_near(raw, ns_to_pts90k(house_now_ns)))


def bus_to_net(pts33, e_ns):
    return (pts33 + ns_to_pts90k(e_ns) - MUX_CLOCK_BASE_90K) % PTS_WRAP


def net_pcr27(h_emission_ns, d_e_ns):
    return ns_to_pcr27(h_emission_ns - d_e_ns)


def timing_pes(sid, pid, timing_pid):
    """ts_house's timing_pes: a video or audio stream_id, or any PES on the PCR carrier."""
    return (sid & 0xF0) == 0xE0 or (sid & 0xE0) == 0xC0 or pid == timing_pid


# --- ts_psi / ts_pcr builders (ts_psi.cpp, ts_pcr.cpp, byte for byte) -------------------------

def build_pmt_section(program, pcr_pid, program_info, streams, version):
    """A PMT section of any size, CRC included; b"" past the 1024-byte section limit."""
    body = bytearray([TABLE_PMT, 0, 0, (program >> 8) & 0xFF, program & 0xFF,
                      0xC1 | ((version & 0x1F) << 1), 0, 0, 0xE0 | ((pcr_pid >> 8) & 0x1F),
                      pcr_pid & 0xFF, 0xF0 | ((len(program_info) >> 8) & 0x0F),
                      len(program_info) & 0xFF])
    body += program_info
    for pid, stype, es_info in streams:
        body += bytes([stype & 0xFF, 0xE0 | ((pid >> 8) & 0x1F), pid & 0xFF,
                       0xF0 | ((len(es_info) >> 8) & 0x0F), len(es_info) & 0xFF])
        body += es_info
    n = len(body) - 3 + 4
    body[1] = 0xB0 | ((n >> 8) & 0x0F)
    body[2] = n & 0xFF
    if len(body) + 4 > 1024:
        return b""
    return bytes(body) + crc32_mpeg(bytes(body)).to_bytes(4, "big")


def _crc_table():
    t = []
    for i in range(256):
        c = i << 24
        for _ in range(8):
            c = ((c << 1) ^ 0x04C11DB7) & 0xFFFFFFFF if c & 0x80000000 else (c << 1) & 0xFFFFFFFF
        t.append(c)
    return t


_CRC = _crc_table()


def crc32_mpeg(data):
    """CRC-32/MPEG-2 (ts_psi's crc32_mpeg)."""
    c = 0xFFFFFFFF
    for b in data:
        c = ((c << 8) & 0xFFFFFFFF) ^ _CRC[((c >> 24) ^ b) & 0xFF]
    return c


def packetise_section(pid, section, cc):
    """(packets, next cc): PUSI and pointer_field 0 in the first, 0xFF after the section."""
    out = []
    i = 0
    while i < len(section):
        p = bytearray(b"\xff" * PKT)
        p[0] = 0x47
        p[1] = (0x40 if i == 0 else 0x00) | ((pid >> 8) & 0x1F)
        p[2] = pid & 0xFF
        p[3] = 0x10 | (cc & 0x0F)
        k = 4
        if i == 0:
            p[4] = 0
            k = 5
        n = min(len(section) - i, PKT - k)
        p[k:k + n] = section[i:i + n]
        i += n
        cc = (cc + 1) & 0x0F
        out.append(bytes(p))
    return out, cc


def build_pcr_packet(pid, pcr27, cc, discontinuity):
    p = bytearray(b"\xff" * PKT)
    p[0] = 0x47
    p[1] = (pid >> 8) & 0x1F
    p[2] = pid & 0xFF
    p[3] = 0x20 | (cc & 0x0F)
    p[4] = 183
    p[5] = 0x90 if discontinuity else 0x10
    hr.write_pcr(p, pcr27)
    return bytes(p)


# --- the configuration, the clock declaration ------------------------------------------------

@dataclass
class EgressConfig:
    pcr_interval_ns: int = 35 * MS
    margin_ns: int = 150 * MS
    headroom_ns: int = 20 * MS
    floor_ns: int = 100 * MS
    max_ns: int = 0                               # 0: none (OQ-36, a hook)
    gap_lower_min_ns: int = 500 * MS


@dataclass(frozen=True)
class ClockDecl:
    """The element's `house-clock` value (p5-9) plus timeline_id (p5-20)."""
    e_ns: int = 0
    seq: int = 0
    known: bool = False
    traceable: bool = False
    disciplined: bool = False
    source: int = hcdesc.SYNC_NONE
    tai_offset_s: int = 0
    ptp_domain: int = -1
    gm: object = None                             # EUI-64 int, None unknown
    error_us: object = None                       # int, None unknown
    timeline_id: int = 0

    def but(self, **kw):
        return replace(self, **kw)


# --- ts_pcr's scheduler with an interval (S4) -------------------------------------------------

class PcrScheduler:
    def __init__(self, interval_ns):
        self.interval_ns = interval_ns
        self.last_ns = 0
        self.have = False
        self._cc = 0

    def saw_pcr(self, now_ns):
        self.last_ns = now_ns
        self.have = True

    def saw_payload(self, cc):
        self._cc = cc & 0x0F

    def due(self, now_ns):
        return not self.have or now_ns - self.last_ns >= self.interval_ns

    def cc(self):
        return self._cc


# --- EgressDelay (part 4.4) -------------------------------------------------------------------

class EgressDelay:
    """D_e of one program: started from its first timing PES, raised when the lateness comes within
    the headroom, lowered only at a gap and by at most the gap, held at max_ns when set."""
    LATE_MAX_NS = 60 * SEC                        # S22: beyond this a PES is off house time
    STEP_NS = 10 * MS
    EPS_CAP_NS = 50 * MS

    def __init__(self, cfg):
        self.cfg = cfg
        self.d_e = cfg.floor_ns + cfg.margin_ns   # until the first timing PES
        self.started = False
        self.gap_ns = 0                           # gap time since the last lowering chance
        self.gap_until = None                     # the end of the latest gap counted
        self.max_episode = False
        self.off_house = 0
        self.changes = 0

    @classmethod
    def eps_ns(cls, error_us):
        return cls.EPS_CAP_NS if error_us is None else min(error_us * 1000, cls.EPS_CAP_NS)

    def _ceil(self, v):
        return -(-v // self.STEP_NS) * self.STEP_NS

    def _need(self, lam, eps):
        return self._ceil(lam + self.cfg.margin_ns + eps)

    def on_gap(self, end_ns, g_ns):
        """A gap [end - g, end] in house ns: only what no earlier gap covered counts, so one hole's
        markers on several PIDs (or an outage's growing markers) count once."""
        if g_ns <= 0:
            return
        start = end_ns - g_ns if self.gap_until is None else max(end_ns - g_ns, self.gap_until)
        self.gap_ns += max(0, end_ns - start)
        self.gap_until = end_ns if self.gap_until is None else max(self.gap_until, end_ns)

    def on_pes(self, lateness_ns, eps_ns):
        """[(kind, from, to, lateness, gap)]; D_e changed when any has from != to."""
        if lateness_ns > self.LATE_MAX_NS:
            self.off_house += 1
            return []
        lam = max(0, lateness_ns)
        need = self._need(lam, eps_ns)
        old = self.d_e
        cfg = self.cfg
        if not self.started:
            self.started = True
            self.gap_ns = 0
            new = max(cfg.floor_ns, need)
            evs = []
            if cfg.max_ns > 0 and new > cfg.max_ns:
                new = cfg.max_ns
                self.max_episode = True
                evs.append(("d-e-max", new, new, lam, 0))
            self.d_e = new
            return self._count([("d-e-start", old, new, lam, 0)] + evs)
        if self.gap_ns > 0:
            g = self.gap_ns
            self.gap_ns = 0
            target = max(cfg.floor_ns, need)
            if target < self.d_e:
                self.d_e = max(target, self._ceil(self.d_e - g))
                self.max_episode = False
                return self._count([("d-e-lower", old, self.d_e, lam, g)])
        if lam > self.d_e - cfg.headroom_ns:
            new = need
            if cfg.max_ns > 0 and new > cfg.max_ns:
                new = cfg.max_ns
                first = not self.max_episode
                self.max_episode = True
                if new <= old:
                    return [("d-e-max", old, old, lam, 0)] if first else []
                self.d_e = new
                return self._count([("d-e-raise", old, new, lam, 0)]
                                   + ([("d-e-max", new, new, lam, 0)] if first else []))
            self.d_e = new
            return self._count([("d-e-raise", old, new, lam, 0)])
        return []

    def _count(self, evs):
        self.changes += sum(1 for e in evs if e[1] != e[2])
        return evs


# --- PMT sections in, packet by packet --------------------------------------------------------

class _SectionAssembler:
    """The sections completed on one PSI PID, and how many packets the last one spanned."""

    def __init__(self):
        self.buf = bytearray()
        self.collecting = False
        self.packets = 0

    def feed(self, v):
        done = []
        if v.payload_off >= PKT:
            return done
        body = v.p[v.payload_off:]
        if self.collecting:
            self.packets += 1
        if v.pusi:
            ptr = body[0]
            if self.collecting:
                self.buf += body[1:1 + ptr]
                self._take(done)
            self.buf = bytearray(body[1 + ptr:])
            self.collecting = True
            self.packets = 1
        elif self.collecting:
            self.buf += body
        self._take(done)
        return done

    def _take(self, done):
        while self.collecting:
            if len(self.buf) >= 1 and self.buf[0] == 0xFF:
                self.collecting = False           # stuffing after the last section
                break
            if len(self.buf) < 3:
                break
            want = 3 + (((self.buf[1] & 0x0F) << 8) | self.buf[2])
            if len(self.buf) < want:
                break
            done.append((bytes(self.buf[:want]), self.packets))
            self.buf = self.buf[want:]
            if not self.buf:
                self.collecting = False


# --- one program ------------------------------------------------------------------------------

class _Prog:
    def __init__(self, number, pmt_pid, cfg):
        self.number = number
        self.pmt_pid = pmt_pid
        self.psi = dc.PsiDiscovery()
        self.psi.select_program(number)
        self.pmt_in = None
        self.pcr_out = None
        self.assigned = -1
        self.sched = PcrScheduler(cfg.pcr_interval_ns)
        self.delay = EgressDelay(cfg)
        self.version_out = 0
        self.section = None
        self.key = None
        self.pmt_cc = 0
        self.cc_known = False                     # the PCR PID's last sent payload CC is in sched
        self.disc_pending = False                 # a flagged PCR skipped for it: the next one carries it
        self.grew_told = False
        self.pcr_last_t = None
        self.st = {"pesRewritten": 0, "pcrWritten": 0, "pcrInserted": 0, "pmtSent": 0,
                   "latenessNs": None, "latenessMaxNs": 0, "pcrIntervalMaxNs": 0}


@dataclass
class Result:
    packets: list                                 # the buffer's whole packets, read only
    edits: list = field(default_factory=list)


def apply_edits(packets, edits):
    """The output bytes of one Result."""
    ins = {}
    own = {}
    for i, op, b in edits:
        if op == INSERT:
            ins.setdefault(i, []).append(b)
        else:
            own[i] = (op, b)
    out = bytearray()
    for i in range(len(packets) + 1):
        for b in ins.get(i, ()):
            out += b
        if i < len(packets):
            op = own.get(i)
            if op is None:
                out += packets[i]
            elif op[0] == REPLACE:
                out += op[1]
    return bytes(out)


class EgressCore:
    ERROR_HOLD_NS = 10 * SEC                      # part 4.3: a class change published after this
    MAX_HELD_AF = 16

    def __init__(self, cfg=None):
        self.cfg = cfg or EgressConfig()
        self._walker = hr.PacketWalker()
        self._span = hr.PesHeaderSpan()
        self._cc_in = dc.CcTracker()
        self._progs = {}                          # program number -> _Prog, PAT order
        self._pmt_pids = set()
        self._pid_prog = {}
        self._asm = {}
        self._held_af = {}
        self._last_cc = {}
        self._pat_pkts = deque()
        self._pat_sig = self._pat_new_sig = None
        self._pat_resync = False
        self._pat_known = False
        self._clock = ClockDecl()
        self._pending = None
        self._e_ns = 0
        self._pub_class = hcdesc.ERROR_CLASS_UNKNOWN
        self._cand_class = None
        self._cand_since = 0
        self._started = False
        self._dirty = set()                       # programs whose declaration moved
        self._reepoch = False
        self._last_now = None
        self._events = []
        self._base = 0
        self._edits = None
        self._now = self._t = 0
        self._clk = None
        self.counters = {"droppedBeforePmt": 0, "gapMarkers": 0, "gaps": 0, "ccLostIn": 0,
                         "reEpochs": 0, "held": 0}

    # -- the API -------------------------------------------------------------------------------

    def set_clock(self, decl):
        """The next buffer applies it (the element's `house-clock` set)."""
        self._pending = decl

    def take_events(self):
        e, self._events = self._events, []
        return e

    def stats(self, program):
        p = self._progs.get(program)
        if p is None:
            return None
        s = dict(p.st)
        s.update({"program": program, "dENs": p.delay.d_e, "dEChanges": p.delay.changes,
                  "latenessOffHouse": p.delay.off_house, "pmtVersion": p.version_out,
                  "pcrPid": -1 if p.pcr_out is None else p.pcr_out})
        return s

    def programs(self):
        return list(self._progs)

    def process(self, data, now_ns, clk=None, gap_pts=None):
        """One bus buffer at CLOCK_MONOTONIC `now_ns`; clk(i) reads the clock for a PCR written
        at packet i (the element ignores i). `gap_pts`: a GAP|DISCONT buffer's PTS (the gap's
        end), the buffer consumed."""
        gap = gap_pts is not None
        self._now = self._t = now_ns
        self._clk = clk or (lambda i: now_ns)
        pkts = [bytes(p) for p in self._walker.feed(data)]
        edits = self._edits = []
        self._apply_clock(now_ns)
        self._started = True
        if gap:
            self._head()
            for i, p in enumerate(pkts):
                g = dc.read_gap_length(p)
                if g >= 0:
                    self.counters["gapMarkers"] += 1
                    self._gap(hr.parse_packet(bytearray(p)).pid, gap_pts, g)
                edits.append((i, DROP, None))
            self._last_now = now_ns
            self._base += len(pkts)
            return Result(pkts, edits)
        if self._last_now is not None and now_ns - self._last_now >= self.cfg.gap_lower_min_ns:
            self._gap(-1, now_ns, now_ns - self._last_now)
        self._last_now = now_ns
        self._head()
        for i, orig in enumerate(pkts):
            work = bytearray(orig)
            v = hr.parse_packet(work)
            if self._cc_in.feed(v) == dc.CcTracker.LOST:
                self.counters["ccLostIn"] += 1
                self._event(i, "cc-lost-in", pid=v.pid)
            self._prime(v)
            self._pcr_due(i, v)
            verdict = self._on_packet(i, v)
            if verdict == DROP:
                edits.append((i, DROP, None))
            elif verdict is None and bytes(work) != orig:
                edits.append((i, REPLACE, bytes(work)))
        self._base += len(pkts)
        return Result(pkts, edits)

    def flush(self):
        """What is held at the end of the stream (a split header never completed), in order."""
        out = []
        held = self._span._held
        for s in held:
            out.append(bytes(s.b))
            out += [bytes(b) for b in self._held_af.pop(s.pid, [])]
        self._span._held = []
        return out

    # -- the clock -----------------------------------------------------------------------------

    def _apply_clock(self, now):
        c = self._pending
        if c is not None:
            self._pending = None
            old, old_e = self._clock, self._e_ns
            self._clock = c
            self._e_ns = c.e_ns if c.known else 0
            cls = hcdesc.error_class(c.error_us)
            if not self._started:
                self._pub_class = cls
                self._cand_class = None
            else:
                if self._e_ns != old_e or c.seq != old.seq:
                    self._reepoch = True
                    self.counters["reEpochs"] += 1
                    self._event(0, "re-epoch", seq=c.seq, fromSeq=old.seq, deltaNs=self._e_ns - old_e)
                if cls == self._pub_class:
                    self._cand_class = None
                elif cls != self._cand_class:
                    self._cand_class = cls
                    self._cand_since = now
            self._dirty = set(self._progs)
        if self._cand_class is not None and now - self._cand_since >= self.ERROR_HOLD_NS:
            self._pub_class = self._cand_class
            self._cand_class = None
            self._dirty = set(self._progs)

    def _decl(self, prog):
        c = self._clock
        ptp = c.ptp_domain >= 0 and c.gm is not None
        return hcdesc.HouseTimeDecl(
            house_time_tai=c.known, disciplined=c.disciplined, traceable=c.known and c.traceable,
            ptp_valid=ptp, sync_source=c.source, tai_utc_offset_s=min(max(c.tai_offset_s, 0), 255),
            ptp_domain=c.ptp_domain if ptp else 0xFF, clock_error_class=self._pub_class,
            gm_identity=c.gm if ptp else hcdesc.ALL_ONES, epoch_seq=c.seq & 0xFFFF,
            d_e_90k=ns_to_pts90k(prog.delay.d_e), timeline_id=c.timeline_id)

    def _head(self):
        """A re-epoch or a declaration change: each program's new PMT at the buffer's head, and
        on a re-epoch its flagged PCR."""
        reepoch, dirty = self._reepoch, self._dirty
        self._reepoch, self._dirty = False, set()
        for n, prog in self._progs.items():
            if prog.section is None:
                continue
            if reepoch:
                self._rebuild(prog, force=True)
                self._discontinuity(0, prog, rebuilt=True)
            elif n in dirty and self._rebuild(prog):
                self._emit_pmt(0, prog)

    # -- packets -------------------------------------------------------------------------------

    def _event(self, i, kind, **kw):
        e = {"event": kind, "packet": self._base + i}
        e.update(kw)
        self._events.append(e)

    def _read(self, i):
        self._t = self._clk(i)
        return self._t

    def _all_known(self):
        return self._pat_known and all(p.pmt_in is not None for p in self._progs.values())

    def _on_packet(self, i, v):
        pid = v.pid
        if pid == PID_PAT:
            self._on_pat(v)
            return None
        if pid in self._pmt_pids:
            return self._on_pmt(i, v)
        prog = self._pid_prog.get(pid)
        if prog is None:
            if pid < 0x20 or pid == PID_NULL or self._all_known():
                return None
            self.counters["droppedBeforePmt"] += 1
            return DROP
        return self._on_es(i, v, prog)

    def _on_pat(self, v):
        p = bytes(v.p)
        sig = hr.section_signature(p)
        if sig is not None and sig[0] == TABLE_PAT and sig != self._pat_sig:
            self._pat_pkts.clear()
            self._pat_new_sig = sig
            self._pat_resync = True
        self._pat_pkts.append(p)
        if len(self._pat_pkts) > 128:
            self._pat_pkts.popleft()
        for prog in self._progs.values():
            prog.psi.feed([p])
        if not self._pat_resync:
            return
        pat = hr.parse_pat(self._pat_pkts)
        if not pat:
            return
        self._pat_sig = self._pat_new_sig
        self._pat_resync = False
        self._pat_known = True
        progs = {}
        for number, pmt_pid in pat:
            prog = self._progs.get(number)
            if prog is None:
                prog = _Prog(number, pmt_pid, self.cfg)
                prog.psi.feed(list(self._pat_pkts))
            prog.pmt_pid = pmt_pid
            progs[number] = prog
        self._progs = progs
        self._pmt_pids = {p.pmt_pid for p in progs.values()}
        self._map_pids()

    def _map_pids(self):
        m = {}
        for prog in self._progs.values():
            if prog.pmt_in is None:
                continue
            for pid, _t, _i in prog.pmt_in.streams:
                m.setdefault(pid, prog)
            if prog.pmt_in.pcr_pid != PID_NULL:
                m.setdefault(prog.pmt_in.pcr_pid, prog)
        self._pid_prog = m

    def _on_pmt(self, i, v):
        p = bytes(v.p)
        for prog in self._progs.values():
            if prog.pmt_pid == v.pid:
                prog.psi.feed([p])
        asm = self._asm.setdefault(v.pid, _SectionAssembler())
        out = []
        for sec, n_in in asm.feed(v):
            if len(sec) < 12 or sec[0] != TABLE_PMT:
                continue
            prog = self._progs.get((sec[3] << 8) | sec[4])
            if prog is None or prog.pmt_pid != v.pid or prog.psi.pmt is None:
                continue
            if prog.psi.pmt != prog.pmt_in:
                self._new_pmt(i, prog, prog.psi.pmt)
            pkts, prog.pmt_cc = packetise_section(prog.pmt_pid, prog.section, prog.pmt_cc)
            prog.st["pmtSent"] += 1
            if len(pkts) > n_in and not prog.grew_told:
                prog.grew_told = True
                self._event(i, "pmt-grew", program=prog.number, inPackets=n_in,
                            outPackets=len(pkts))
            out += pkts
        if not out:
            return DROP
        for b in out[:-1]:
            self._edits.append((i, INSERT, b))
        self._edits.append((i, REPLACE, out[-1]))
        return REPLACE

    def _choose_pcr(self, streams):
        def cls(t, info):
            plan = dc.classify(t, info)
            return plan.cls if plan is not None else dc.unknown_class(t, info)
        for want in ("video", "audio"):
            for pid, t, info in streams:
                if cls(t, info) == want:
                    return pid
        return streams[0][0] if streams else PID_NULL

    def _new_pmt(self, i, prog, pmt):
        if prog.pmt_in is None:
            prog.version_out = pmt.version
        prog.pmt_in = pmt
        pcr = pmt.pcr_pid
        if pcr == PID_NULL:
            pcr = self._choose_pcr(pmt.streams)
            if pcr != PID_NULL and pcr != prog.assigned:
                prog.assigned = pcr
                self._event(i, "pcr-pid-assigned", program=prog.number, pid=pcr)
        if pcr == PID_NULL:
            pcr = None
        if pcr != prog.pcr_out:
            prog.pcr_out = pcr
            prog.sched = PcrScheduler(self.cfg.pcr_interval_ns)
            last = self._last_cc.get(pcr)
            prog.cc_known = last is not None
            prog.sched.saw_payload(last or 0)
            prog.pcr_last_t = None
        self._map_pids()
        self._rebuild(prog)

    def _rebuild(self, prog, force=False):
        """The program's output section from its input PMT and declaration; True when its bytes
        (version and CRC aside) changed or `force` (a re-epoch), the version then bumped."""
        pmt = prog.pmt_in
        pi = hcdesc.strip_from(pmt.program_info) + hcdesc.encode(self._decl(prog))
        pcr = PID_NULL if prog.pcr_out is None else prog.pcr_out

        def build(version):
            s = build_pmt_section(prog.number, pcr, pi, pmt.streams, version)
            return s or build_pmt_section(prog.number, pcr, hcdesc.strip_from(pmt.program_info),
                                          pmt.streams, version)
        sec = build(prog.version_out)
        key = sec[:5] + bytes([sec[5] & 0xC1]) + sec[6:-4]
        if prog.key == key and not force:
            return False
        if prog.key is not None:
            prog.version_out = (prog.version_out + 1) % 32
            sec = build(prog.version_out)
        prog.key = key
        prog.section = sec
        return True

    def _emit_pmt(self, i, prog):
        pkts, prog.pmt_cc = packetise_section(prog.pmt_pid, prog.section, prog.pmt_cc)
        prog.st["pmtSent"] += 1
        for b in pkts:
            self._edits.append((i, INSERT, b))

    def _insert_pcr(self, i, prog, discontinuity):
        # AF-only, with the PID's last sent payload CC; none before that CC is known (_prime).
        if not prog.cc_known:
            prog.disc_pending = prog.disc_pending or discontinuity
            return
        discontinuity, prog.disc_pending = discontinuity or prog.disc_pending, False
        t = self._read(i)
        self._edits.append((i, INSERT, build_pcr_packet(
            prog.pcr_out, net_pcr27(t + self._e_ns, prog.delay.d_e), prog.sched.cc(),
            discontinuity)))
        prog.st["pcrInserted"] += 1
        self._saw_pcr(prog, t)

    def _saw_pcr(self, prog, t):
        if prog.pcr_last_t is not None:
            prog.st["pcrIntervalMaxNs"] = max(prog.st["pcrIntervalMaxNs"], t - prog.pcr_last_t)
        prog.pcr_last_t = t
        prog.sched.saw_pcr(t)

    def _discontinuity(self, i, prog, rebuilt=False):
        """Part 4.2 step 7: the new PMT, then a flagged PCR-only packet, before packet i."""
        if not rebuilt:
            self._rebuild(prog)
        self._emit_pmt(i, prog)
        if prog.pcr_out is not None:
            self._insert_pcr(i, prog, True)

    def _prime(self, v):
        """The PCR PID's first payload packet in hand: a PCR inserted before it takes its CC - 1."""
        if v.payload_off >= PKT:
            return
        for prog in self._progs.values():
            if prog.pcr_out == v.pid and not prog.cc_known:
                prog.sched.saw_payload((v.cc - 1) & 0x0F)
                prog.cc_known = True

    def _sent(self, pid, cc):
        """A payload packet of pid is emitted: what is inserted after it carries its CC."""
        self._last_cc[pid] = cc
        for prog in self._progs.values():
            if prog.pcr_out == pid:
                prog.sched.saw_payload(cc)
                prog.cc_known = True

    def _pcr_due(self, i, v):
        for prog in self._progs.values():
            pid = prog.pcr_out
            if pid is None or prog.section is None or self._span.held(pid):
                continue
            if v.pid == pid and v.af_pcr and not prog.disc_pending:
                continue
            if prog.sched.due(self._t) or prog.disc_pending:
                self._insert_pcr(i, prog, False)

    def _gap(self, pid, end, g):
        self.counters["gaps"] += 1
        prog = self._pid_prog.get(pid)
        for p in [prog] if prog is not None else self._progs.values():
            p.delay.on_gap(end, g)
            p.pcr_last_t = None

    def _write_pcr(self, i, buf, prog, pid):
        if hr.read_pcr(buf) < 0:
            return
        t = self._read(i)
        hr.write_pcr(buf, net_pcr27(t + self._e_ns, prog.delay.d_e))
        prog.st["pcrWritten"] += 1
        if pid == prog.pcr_out:
            self._saw_pcr(prog, t)

    def _times(self, i, prog, pid, h, pts33, dts33):
        """A PES header's network PTS/DTS; a timing PES's lateness drives D_e first."""
        if h.pts < 0:
            return pts33, dts33
        if timing_pes(h.sid, pid, prog.pcr_out):
            # Against the latest clock reading, so DTS - PCR >= headroom for the PCR in force.
            lam = self._t - house_from_mux_pts(dts33 if dts33 >= 0 else pts33, self._t)
            self._lateness(i, prog, lam)
        prog.st["pesRewritten"] += 1
        return (bus_to_net(pts33, self._e_ns),
                bus_to_net(dts33, self._e_ns) if dts33 >= 0 else dts33)

    def _lateness(self, i, prog, lam):
        if lam <= EgressDelay.LATE_MAX_NS:
            prog.st["latenessNs"] = lam
            prog.st["latenessMaxNs"] = max(prog.st["latenessMaxNs"], lam)
        evs = prog.delay.on_pes(lam, EgressDelay.eps_ns(self._clock.error_us))
        for kind, a, b, la, g in evs:
            kw = {"program": prog.number, "fromNs": a, "toNs": b, "latenessNs": la}
            if kind == "d-e-lower":
                kw["gapNs"] = g
            self._event(i, kind, **kw)
        if any(a != b for _k, a, b, _l, _g in evs):
            self._discontinuity(i, prog)

    def _on_es(self, i, v, prog):
        pid = v.pid
        payload = v.payload_off < PKT
        if payload and self._span.held(pid):
            joined = [False]

            def ts(h, pts33, dts33):
                joined[0] = True
                return self._times(i, prog, pid, h, pts33, dts33)
            held = bytearray(self._span.complete(v, ts))
            self._write_pcr(i, held, prog, pid)
            self._edits.append((i, INSERT, bytes(held)))
            self._sent(pid, held[3] & 0x0F)
            for af in self._held_af.pop(pid, []):
                self._write_pcr(i, af, prog, pid)
                self._edits.append((i, INSERT, bytes(af)))
            if joined[0]:
                self._write_pcr(i, v.p, prog, pid)
                self._sent(pid, v.cc)
                return None
        if not payload:
            if self._span.held(pid):
                q = self._held_af.setdefault(pid, [])
                if len(q) < self.MAX_HELD_AF:
                    q.append(bytearray(v.p))
                    self.counters["held"] += 1
                    return DROP
            self._write_pcr(i, v.p, prog, pid)
            return None
        if v.pusi and not v.scrambled:
            if self._span.hold(v):
                self.counters["held"] += 1
                return DROP
            h = hr.parse_pes_header(v.p, v.payload_off, PKT - v.payload_off)
            if h is not None and h.complete and h.pts >= 0:
                pts33, dts33 = self._times(i, prog, pid, h, h.pts, h.dts)
                hr.rewrite_pes_timestamps(v, h, pts33, dts33)
        self._write_pcr(i, v.p, prog, pid)
        self._sent(pid, v.cc)
        return None


# --- the CLI: the content clock, the replay ---------------------------------------------------

def _grid(data):
    """(offset, packet) on the 188 grid, a byte skipped where the sync is lost."""
    off, n = 0, len(data)
    while off + PKT <= n:
        if data[off] != 0x47:
            off += 1
            continue
        yield off, data[off:off + PKT]
        off += PKT


def content_anchors(data):
    """[(byte offset, house ns)] of the content clock (the module docstring)."""
    pkts = list(_grid(data))
    pcr_pid = next((hr.parse_packet(bytearray(p)).pid for _o, p in pkts if hr.read_pcr(p) >= 0),
                   None)
    out = []
    last = u = None
    if pcr_pid is not None:
        for off, p in pkts:
            if ((p[1] & 0x1F) << 8 | p[2]) != pcr_pid:
                continue
            v = hr.read_pcr(p)
            if v < 0:
                continue
            if last is None:
                u = v
            else:
                d = (v - last) % PCR_MODULO
                u += d - PCR_MODULO if d > PCR_MODULO // 2 else d
            last = v
            out.append((off, pcr27_to_ns(u) - 3600 * SEC))
        return out
    tpid = None
    for off, p in pkts:
        v = hr.parse_packet(bytearray(p))
        if not v.pusi or v.payload_off >= PKT:
            continue
        h = hr.parse_pes_header(p, v.payload_off, PKT - v.payload_off)
        if h is None or not h.complete or h.pts < 0 or not timing_pes(h.sid, v.pid, -1):
            continue
        if tpid is None:
            tpid = v.pid
        if v.pid != tpid:
            continue
        t = h.dts if h.dts >= 0 else h.pts
        u = t if last is None else u + hr.fold33(t - last)
        last = t
        out.append((off, pts90k_to_ns(u) - 3600 * SEC))
    return out


def _interp(points, x):
    """Linear between (x, y) points sorted by x, floor division, held outside them."""
    if not points:
        return 0
    xs = [p[0] for p in points]
    k = bisect.bisect_right(xs, x)
    if k == 0:
        return points[0][1]
    if k == len(points):
        return points[-1][1]
    (x0, y0), (x1, y1) = points[k - 1], points[k]
    if x1 == x0:
        return y1
    return y0 + (y1 - y0) * (x - x0) // (x1 - x0)


def clock_from_json(j, base=None):
    c = base or ClockDecl()
    kw = {}
    if "eNs" in j:
        kw["e_ns"] = int(j["eNs"])
    for k, a in (("seq", "seq"), ("known", "known"), ("traceable", "traceable"),
                 ("disciplined", "disciplined"), ("source", "source"),
                 ("taiOffsetS", "tai_offset_s"), ("ptpDomain", "ptp_domain"),
                 ("errorUs", "error_us")):
        if k in j:
            kw[a] = j[k]
    if "gm" in j:
        kw["gm"] = None if j["gm"] is None else hcdesc.parse_gm(j["gm"])
    if "timelineId" in j:
        kw["timeline_id"] = hcdesc.parse_timeline_text(j["timelineId"])
    return c.but(**kw)


def config_from_json(j):
    c = EgressConfig()
    for k, a in (("pcrIntervalMs", "pcr_interval_ns"), ("marginMs", "margin_ns"),
                 ("headroomMs", "headroom_ns"), ("floorMs", "floor_ns"), ("maxMs", "max_ns"),
                 ("gapLowerMinMs", "gap_lower_min_ns")):
        if k in j:
            setattr(c, a, int(j[k]) * MS)
    return c


def read_bus(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def replay(data, spec, bus=None, chunk=None, core_cls=EgressCore):
    """(output bytes, lines) of one replay; lines are the events, each program's stats and the
    output's summary, in that order."""
    core = core_cls(config_from_json(spec.get("config", {})))
    clock = clock_from_json(spec.get("clock", {}))
    core.set_clock(clock)
    anchors = content_anchors(data)
    lat = [(int(t) * MS, int(ms) * MS) for t, ms in spec.get("lateness", [[0, 0]])]
    c0 = anchors[0][1] if anchors else 0

    def content(off):
        return _interp(anchors, off)

    def now_at(off):
        c = content(off)
        return c + _interp(lat, c - c0)

    changes = sorted(spec.get("changes", []), key=lambda ch: ch["atMs"])
    if bus is not None:
        bufs = [(b["off"], b["len"], b["pts"] if b["flags"] & GST_FLAG_GAP else None) for b in bus]
    else:
        n = chunk or spec.get("chunk", 1316)
        bufs = [(o, min(n, len(data) - o), None) for o in range(0, len(data), n)]
    out = bytearray()
    lines = []
    for off, ln, gap in bufs:
        while changes and content(off) - c0 >= changes[0]["atMs"] * MS:
            clock = clock_from_json(changes.pop(0).get("clock", {}), clock)
            core.set_clock(clock)
        r = core.process(data[off:off + ln], now_at(off), lambda i, o=off: now_at(o + i * PKT),
                         gap)
        out += apply_edits(r.packets, r.edits)
        lines += core.take_events()
    for b in core.flush():
        out += b
    for n in core.programs():
        lines.append({"stats": core.stats(n)})
    lines.append({"counters": dict(core.counters)})
    lines.append({"output": {"bytes": len(out), "crc32": "%08x" % (zlib.crc32(bytes(out))
                                                                    & 0xFFFFFFFF),
                             "sha256": hashlib.sha256(bytes(out)).hexdigest()}})
    return bytes(out), lines


def dump_line(obj):
    return json.dumps(obj, separators=(",", ":"), sort_keys=True)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="egress_core")
    ap.add_argument("input")
    ap.add_argument("--clock", required=True)
    ap.add_argument("--bus")
    ap.add_argument("--chunk", type=int)
    ap.add_argument("--out")
    ap.add_argument("--expect")
    a = ap.parse_args(argv)
    with open(a.input, "rb") as f:
        data = f.read()
    with open(a.clock) as f:
        spec = json.load(f)
    out, lines = replay(data, spec, read_bus(a.bus) if a.bus else None, a.chunk)
    if a.out:
        with open(a.out, "wb") as f:
            f.write(out)
    text = [dump_line(x) for x in lines]
    if a.expect:
        with open(a.expect) as f:
            want = [line.rstrip("\n") for line in f if line.strip()]
        if want != text:
            for k, (x, y) in enumerate(zip(want + [""] * len(text), text + [""] * len(want))):
                if x != y:
                    sys.stderr.write("line %d:\n  want %s\n  got  %s\n" % (k + 1, x, y))
                    break
            return 1
        return 0
    sys.stdout.write("".join(t + "\n" for t in text))
    return 0


if __name__ == "__main__":
    sys.exit(main())
