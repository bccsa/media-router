#!/usr/bin/env python3
"""C++ output parity of demux_core.py, the Python reference of mrts::DemuxCore (plan ch. 7
WI-P3-1, register B-121, B-122; B-55's pattern).

1. The two suites: ../native/mrts/tests/demux_core_test and demux_core_test.py pass with the
   same checks in the same order. The Python cases are the C++ cases.
2. The same input through both, `mrts_cli demux` and demux_lines(), every line equal: every
   fixture (each .demux.jsonl's program and sidecar) at 188, 1,000, 1,316 and 24,576-byte
   feeds; each fixture in the select configuration and with media video, audio and
   private,subpicture; and 120 random programs for the edges no recording reaches (random PSI
   timing, PMT changes of every kind, a moved PMT PID, 18 programs in a row, CC loss and
   duplicates, bus DISCONT, garbage, the 33-bit wrap, B-frames, unbounded, PTS-less, malformed
   and split-header PES, sparse streams, teletext beside a BSSD registration, gap markers, other
   house times and configurations), each through its bus sidecar. No-stream needs a moving
   clock, which a replay at one house time has not: the suites' cases 12 and 13 hold it.
3. The reference's mutants (p3-1a's, its review's and this item's): each applied to a copy of
   demux_core.py, run on the inputs of 2 (the recordings at 1,316 bytes and through their
   sidecar, the random programs) until one differs from the C++; every one must be caught.

The C++ side is built here as `make test` builds it. Run:  python3 demux_core_parity_test.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types

import demux_core as dc
import ts_psi

HERE = os.path.dirname(os.path.abspath(__file__))
MRTS = os.path.normpath(os.path.join(HERE, "..", "native", "mrts"))
CPP_TEST = os.path.join(MRTS, "tests", "demux_core_test")
CLI = os.path.join(MRTS, "mrts_cli")
FIXTURES = os.path.normpath(os.path.join(HERE, "..", "tests", "fixtures"))
PKT = dc.PKT
SEC = dc.SEC
MS = 1000000
BASE = dc.MUX_CLOCK_BASE_90K
WRAP = dc.PTS_WRAP
CHUNKS = (188, 1000, 1316, 24576)
PROGRAMS = 120
COUNTERS = ("ccLost", "desyncBytes", "pesNoPts", "markers", "markersDropped", "dtsDiscarded", "pesDroppedCc",
            "unknownStreams")

_failures = 0


def check(name, cond):
    global _failures
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures += 1


def build():
    """The C++ suite and CLI, as `make test` builds them; '' when done, else make's output."""
    made = subprocess.run(["make", "-s", "-C", MRTS, "mrts_cli", "tests/demux_core_test"],
                          capture_output=True, text=True,
                          env={k: v for k, v in os.environ.items() if k != "MR_PLUGINS_DIR"})
    if made.returncode != 0 or not (os.path.exists(CPP_TEST) and os.path.exists(CLI)):
        return made.stdout + made.stderr or "mrts_cli or tests/demux_core_test missing"
    return ""


def suite_checks(stdout):
    lines = [line for line in stdout.splitlines() if line.startswith(("PASS ", "FAIL "))]
    return [line[5:] for line in lines], all(line.startswith("PASS ") for line in lines)


# --- one input through both sides ---------------------------------------------------------------

class Case:
    """One replay: a recording, its sidecar (or a chunking) and the core's configuration."""

    def __init__(self, label, ts, bus=None, chunk=1316, program=-1, media=dc.MEDIA_ALL, select="",
                 house_ns=None):
        self.label, self.ts, self.bus, self.chunk = label, ts, bus, chunk
        self.program, self.media, self.select, self.house_ns = program, tuple(media), select, house_ns

    def argv(self):
        a = [CLI, "demux", self.ts, "--chunk", str(self.chunk), "--program", str(self.program),
             "--media", ",".join(self.media)]
        if self.select:
            a += ["--select", self.select]
        if self.house_ns is not None:
            a += ["--house-ns", str(self.house_ns)]
        if self.bus:
            a += ["--bus", self.bus]
        return a

    def cpp(self):
        done = subprocess.run(self.argv(), capture_output=True, text=True)
        return done.stdout.splitlines() if done.returncode == 0 else ["rc %d: %s" % (done.returncode,
                                                                                   done.stderr[:200])]

    def ref(self, mod=dc):
        with open(self.ts, "rb") as f:
            data = f.read()
        bus = None
        if self.bus:
            with open(self.bus) as f:
                bus = [json.loads(line) for line in f if line.strip()]
        cfg = mod.Config(program=self.program, media=self.media, select=self.select)
        return mod.demux_lines(data, cfg, self.chunk, self.house_ns, bus)


def first_difference(a, b):
    i = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), min(len(a), len(b)))
    if i == len(a) == len(b):
        return None
    return "line %d: C++ %s, Python %s" % (i + 1, a[i][:160] if i < len(a) else "nothing",
                                          b[i][:160] if i < len(b) else "nothing")


def tally(lines):
    """Event counts by kind, for the check names."""
    n = {}
    for line in lines:
        k = line[2:line.index('"', 2)] if line.startswith('{"') else "?"
        n[k] = n.get(k, 0) + 1
    return n


# --- random programs ------------------------------------------------------------------------------

MASK = (1 << 64) - 1


class Rng:
    """SplitMix64, deterministic (as house_rebase_parity_fixture.py's random programs)."""

    def __init__(self, seed):
        self.s = seed & MASK

    def next(self):
        self.s = (self.s + 0x9E3779B97F4A7C15) & MASK
        z = self.s
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK
        return z ^ (z >> 31)

    def below(self, n):
        return self.next() % n

    def chance(self, permille):
        return self.below(1000) < permille

    def pick(self, seq):
        return seq[self.below(len(seq))]


def h(s):
    return bytes.fromhex(s)


BSSD = h("050442535344")
# kind: (stream type, ES loop, stream_id, frame in ticks (0: sparse), payload bytes)
KINDS = {
    "h264": (0x1B, b"", 0xE0, 3600, (300, 1600)),
    "hevc": (0x24, b"", 0xE0, 3600, (300, 1600)),
    "mpeg2": (0x02, b"", 0xE0, 1800, (200, 900)),
    "aac": (0x0F, h("0a04656e6700"), 0xC0, 1920, (120, 380)),
    "mpa": (0x03, b"", 0xC0, 2160, (100, 300)),
    "ac3": (0x81, b"", 0xBD, 2880, (200, 500)),
    "opus": (0x06, h("05044f7075737f028002"), 0xBD, 1800, (60, 200)),
    "s302m": (0x06, BSSD, 0xBD, 1800, (0, 0)),
    "ttx": (0x06, h("5605656e670988"), 0xBD, 0, (46, 300)),
    "ttx_bssd": (0x06, h("5605656e670988050442535344"), 0xBD, 0, (46, 300)),   # tsdemux: teletext
    "klv": (0x15, h("260dffff4b4c5641ff4b4c5641000f"), 0xFC, 0, (20, 120)),
    "dvbsub": (0x06, h("5908756e641000010152"), 0xBD, 0, (30, 200)),
    "bare06": (0x06, b"", 0xBD, 1800, (40, 100)),
    "dts": (0x82, b"", 0xBD, 1800, (40, 100)),
    "scte": (0x86, b"", 0xFC, 0, (10, 40)),
}
WEIGHTED = ["h264"] * 4 + ["hevc", "mpeg2"] + ["aac"] * 4 + ["mpa", "ac3", "opus", "opus"] + \
    ["s302m"] * 3 + ["ttx", "ttx", "ttx_bssd", "klv", "dvbsub", "bare06", "dts", "scte"]
LANGS = (b"eng", b"fra", b"deu", b"nor", b"\x01\xe9z")      # the last one escapes in JSON


def aac_loop(r):
    """An ISO 639 descriptor of one or two entries (tsdemux tags the last)."""
    if r.chance(300):
        return b"\x0a\x08" + r.pick(LANGS) + b"\x00" + r.pick(LANGS) + b"\x01"
    return b"\x0a\x04" + r.pick(LANGS) + b"\x00"


def put_ts(prefix, v):
    return bytes([(prefix << 4) | (((v >> 30) & 7) << 1) | 1, (v >> 22) & 0xFF,
                  (((v >> 15) & 0x7F) << 1) | 1, (v >> 7) & 0xFF, ((v & 0x7F) << 1) | 1])


def pes_bytes(sid, payload, pts33=None, dts33=None, bounded=True):
    if sid in (0xBE, 0xBF):                       # no optional header: never a PTS
        return bytes([0, 0, 1, sid, len(payload) >> 8, len(payload) & 0xFF]) + payload
    opt, flags = b"", 0
    if pts33 is not None:
        opt, flags = put_ts(3 if dts33 is not None else 2, pts33), 0x80
        if dts33 is not None:
            opt, flags = opt + put_ts(1, dts33), 0xC0
    body = bytes([0x84, flags, len(opt)]) + opt + payload
    n = len(body) if bounded and len(body) <= 0xFFFF else 0
    return bytes([0, 0, 1, sid, n >> 8, n & 0xFF]) + body


def ts_packet(pid, cc, pusi, payload, pcr=None, disc=False):
    """One packet: `payload` (at most 184 bytes, 176 with a PCR) after an adaptation field that
    pads it and carries the PCR."""
    n = len(payload)
    p = bytearray(PKT)
    p[0], p[1], p[2] = 0x47, (0x40 if pusi else 0) | ((pid >> 8) & 0x1F), pid & 0xFF
    if n == 184 and pcr is None and not disc:
        p[3] = 0x10 | (cc & 0x0F)
        p[4:] = payload
        return bytes(p)
    af = 183 - n
    p[3] = (0x30 if n else 0x20) | (cc & 0x0F)
    p[4] = af
    if af > 0:
        p[5] = (0x10 if pcr is not None else 0) | (0x80 if disc else 0)
        i = 6
        if pcr is not None:
            base, ext = (pcr // 300) & 0x1FFFFFFFF, pcr % 300
            p[6:12] = bytes([(base >> 25) & 0xFF, (base >> 17) & 0xFF, (base >> 9) & 0xFF, (base >> 1) & 0xFF,
                             ((base & 1) << 7) | 0x7E | ((ext >> 8) & 1), ext & 0xFF])
            i = 12
        p[i:5 + af] = b"\xff" * (5 + af - i)
    p[5 + af:] = payload
    return bytes(p)


def s302m_payload(frames, good=True):
    size = frames * 5
    head = (size << 16) if good else ((size + 3) << 16)
    return head.to_bytes(4, "big") + bytes((i * 13) & 0xFF for i in range(size))


def gap_packet(pid, cc, length_ns):
    p = bytearray(b"\xff" * PKT)
    p[0:7] = bytes([0x47, (pid >> 8) & 0x1F, pid & 0xFF, 0x20 | (cc & 0x0F), 183, 0x02, 8])
    p[7:15] = max(length_ns, 0).to_bytes(8, "big")
    return bytes(p)


class Stream:
    def __init__(self, r, pid, kind):
        self.pid, self.kind = pid, kind
        self.stype, self.loop, self.sid, self.frame, self.size = KINDS[kind]
        if kind == "aac":
            self.loop = aac_loop(r)
        if kind in ("h264", "hevc") and r.chance(600):
            self.bframes = True
        else:
            self.bframes = False
        if self.frame and r.chance(150):
            self.frame = self.frame // 2 if self.frame >= 3600 else self.frame * 2
        self.live = True


class Program:
    """A random program as a transport stream and its bus sidecar, house times in ns."""

    def __init__(self, seed):
        self.r = r = Rng(seed * 7919 + 17)
        self.items = []                           # (time, order, kind, payload)
        self.order = 0
        self.cc = {}
        if r.chance(250):                         # crosses the PES field's 33-bit wrap
            self.t0 = dc.pts90k_to_ns(WRAP - BASE) - r.below(3000) * MS
        elif r.chance(50):                        # starts right at house time 0
            self.t0 = r.below(300) * MS
        else:
            self.t0 = (1000 + r.below(150000)) * SEC + r.below(SEC)
        self.dur = (2 + r.below(3)) * SEC + r.below(SEC)
        self.pmt_pid = r.pick((0x1000, 0x20, 0x1FFE, 0x3E8))
        self.number = r.pick((1, 1, 1, 7, 300))
        self.used = {0, self.pmt_pid, 0x1FFF}
        self.streams = [Stream(r, self.free_pid(), r.pick(WEIGHTED)) for _ in range(1 + r.below(4))]
        timed = [s for s in self.streams if s.frame] or self.streams
        self.pcr_pid = r.pick(timed).pid
        if r.chance(120):                         # PCR-only packets on a PID of their own
            self.pcr_pid = 0x1F00 + r.below(0xF0)
        self.pcr_every = r.pick((20, 40, 40, 100, 2000)) * MS
        self.pcr_lead = r.pick((-40, -40, -300, 300)) * MS
        self.no_pcr = r.chance(60)
        self.version = r.below(32)
        self.pat_version = 0
        self.second = r.chance(150)               # a second program in the PAT
        self.cfg = dict(program=-1, media=dc.MEDIA_ALL, select="", house_ns=None)
        self.build()

    # --- the content ---

    def free_pid(self):
        pid = 0x30 + self.r.below(0x1F00)
        while pid in self.used:
            pid = 0x30 + self.r.below(0x1F00)
        self.used.add(pid)
        return pid

    def cc_next(self, pid):
        c = self.cc.get(pid, 0)
        self.cc[pid] = (c + 1) & 0x0F
        return c

    def add(self, t, kind, payload):
        self.items.append((t, self.order, kind, payload))
        self.order += 1

    def pes(self, s, t, pts_ns, dts_ns=None):
        r = self.r
        n = r.below(s.size[1] - s.size[0] + 1) + s.size[0]
        payload = bytes(r.below(256) for _ in range(min(n, 64))) + bytes(n - min(n, 64))
        if s.kind == "s302m":
            payload = s302m_payload(960 if s.frame == 1800 else 1920, not r.chance(30))
        to33 = (lambda x: (dc.ns_to_pts90k(x) + BASE) % WRAP)
        pts33 = to33(pts_ns) if pts_ns is not None else None
        dts33 = to33(dts_ns) if dts_ns is not None and pts_ns is not None else None
        if pts33 is not None and r.chance(8):     # a DTS beyond 5 s of its PTS: damage
            dts33 = (pts33 + 6 * 90000) % WRAP
        sid = 0xBE if r.chance(5) else s.sid
        bounded = not (s.sid == 0xE0 and r.chance(500))
        d = pes_bytes(sid, payload, pts33, dts33, bounded)
        if r.chance(6):                           # a PUSI that is no PES start
            d = b"\x00\x00\x02" + d[3:]
        pcr = None
        if s.pid == self.pcr_pid and not self.no_pcr and t - self.last_pcr >= self.pcr_every:
            pcr = self.pcr_at(t)
            self.last_pcr = t
        disc = r.chance(5)
        first = 176 if pcr is not None else 182 if disc else 184
        if r.chance(40):
            first = 10                            # the PES header split over two packets
        pkts, at, k = [], 0, 0
        while k == 0 or at < len(d):
            take = min(first if k == 0 else 184, len(d) - at)
            pkts.append(ts_packet(s.pid, self.cc_next(s.pid), k == 0, d[at:at + take], pcr if k == 0 else None,
                                  disc=k == 0 and disc))
            at += take
            k += 1
        self.add(t, "pkts", pkts)

    def pcr_at(self, t):
        # On the PES field's clock, behind the content (a mux's delay) or, now and then, ahead.
        return ((dc.ns_to_pts90k(t + self.pcr_lead) + BASE) % WRAP) * 300 + self.r.below(300)

    def psi(self, t, streams):
        pkts = [ts_psi.build_pat(1, self.pat(), self.cc_next(0), self.pat_version)]
        loop = [(s.pid, s.stype, s.loop) for s in streams]
        pkts.append(ts_psi.build_pmt(self.pmt_pid, self.number, self.pmt_pcr, loop, self.cc_next(self.pmt_pid),
                                     self.version))
        if self.second:
            pkts.append(ts_psi.build_pmt(0x1FF0, 2, 0x1FF1, [(0x1FF1, 0x0F, b""), (0x1FF2, 0x06, BSSD)],
                                         self.cc_next(0x1FF0), 0))
        self.add(t, "pkts", pkts)

    def pat(self):
        progs = {self.number: self.pmt_pid}
        if self.second:
            progs[2 if self.number != 2 else 3] = 0x1FF0
        return progs

    def build(self):
        r = self.r
        t0, end = self.t0, self.t0 + self.dur
        self.pmt_pcr = self.pcr_pid
        self.last_pcr = -SEC
        streams = list(self.streams)
        # One to three PMT changes of a random kind at random times.
        changes = sorted((t0 + r.below(self.dur), r.pick(("version", "lang", "reorder", "type", "pcr", "remove",
                                                          "add", "empty", "same-version", "move", "pid")))
                         for _ in range(r.below(4)))
        if r.chance(60):                          # 18 programs: the generation in 4 bits
            if not any(s.stype in (0x1B, 0x24) for s in self.streams):
                self.streams.append(Stream(r, self.free_pid(), "h264"))
                streams = list(self.streams)
            changes = [(t0 + k * self.dur // 20, "type") for k in range(18)]
        psi_every = r.pick((100, 200, 400, 500)) * MS
        t = t0 + (300 * MS if r.chance(150) else 0)
        while t < end:                            # the PSI carousel, changes applied as they come
            while changes and changes[0][0] <= t:
                streams = self.change(changes.pop(0)[1], streams)
            self.psi(t, streams)
            t += psi_every
        self.live_streams = streams
        for s in self.streams:
            self.content(s, t0, end)
        if self.pcr_pid not in {s.pid for s in self.streams} and not self.no_pcr:
            t = t0
            while t < end:
                self.add(t, "pkts", [ts_packet(self.pcr_pid, self.cc.get(self.pcr_pid, 0), False, b"",
                                               self.pcr_at(t))])
                t += self.pcr_every
        if self.second:
            for k in range(int(self.dur // (20 * MS))):
                tk = t0 + k * 20 * MS
                d = pes_bytes(0xBD, s302m_payload(96), (dc.ns_to_pts90k(tk) + BASE) % WRAP)
                self.add(tk, "pkts", [ts_packet(0x1FF2, self.cc_next(0x1FF2), True, d[:184])] +
                         ([ts_packet(0x1FF2, self.cc_next(0x1FF2), False, d[184 + i:368 + i])
                           for i in range(0, len(d) - 184, 184)]))
        self.config()

    def change(self, kind, streams):
        r = self.r
        streams = list(streams)
        self.version = (self.version + 1) % 32
        if kind == "lang":
            for s in streams:
                if s.kind == "aac":
                    s.loop = aac_loop(r)
        elif kind == "reorder":
            streams.reverse()
        elif kind == "type":
            for s in streams:
                if s.stype in (0x1B, 0x24):
                    s.stype = 0x24 if s.stype == 0x1B else 0x1B
                    break
        elif kind == "pcr":
            self.pmt_pcr = r.pick(streams).pid if streams else self.pmt_pcr
        elif kind == "remove" and len(streams) > 1:
            streams.pop(r.below(len(streams)))
        elif kind == "add" and len(streams) < 6:  # the PMT stays one packet
            s = Stream(r, self.free_pid(), r.pick(WEIGHTED))
            self.streams.append(s)
            streams.append(s)
        elif kind == "empty":
            return []
        elif kind == "same-version":
            self.version = (self.version - 1) % 32
            for s in streams:
                s.stype = 0x87 if s.stype == 0x81 else 0x81 if s.stype == 0x87 else s.stype
            if streams:
                streams[0] = Stream(r, streams[0].pid, "mpa") if streams[0].frame else streams[0]
        elif kind == "move":
            self.pmt_pid = self.free_pid()
            self.pat_version = (self.pat_version + 1) % 32
        elif kind == "pid":
            for s in streams:
                if s.kind == "s302m" or r.chance(300):
                    s.pid = self.free_pid()
                    break
        if not streams and kind != "empty":
            streams = list(self.live_streams if hasattr(self, "live_streams") else self.streams)
        return streams

    def content(self, s, t0, end):
        r = self.r
        if not s.frame:                           # sparse: now and then, or idle
            if r.chance(250):
                return
            t = t0 + r.below(400) * MS
            while t < end:
                self.pes(s, t, t)
                t += (100 + r.below(1500)) * MS
            return
        f = dc.pts90k_to_ns(s.frame)
        hole = (t0 + r.below(self.dur), r.pick((3 * f, 5 * f, 400 * MS, 1200 * MS, 2 * SEC))) if r.chance(500) else None
        jump = (t0 + r.below(self.dur), r.pick((3 * SEC, -500 * MS, 7 * SEC))) if r.chance(150) else None
        # An outage marked frame by frame (every other one lost, most of the spacing window), then a
        # hole of 2.5 frames: a gap only while no spacing across a marker is learned.
        flicker = t0 + r.below(self.dur) if s.sid != 0xE0 and s.kind != "s302m" and r.chance(250) else None
        k, shift, t = 0, 0, t0 + r.below(50) * MS
        while t < end:
            if flicker is not None and flicker <= t:
                for _ in range(6):
                    self.marker(t, s, f, exact=True)
                    t += f
                    k += 1
                    self.pes(s, t, t + shift)
                    t += f
                    k += 1
                t += f * 5 // 2
                flicker = None
                continue
            if hole and hole[0] <= t < hole[0] + hole[1]:
                if r.chance(300) and not hole[2:]:
                    hole = hole + ("marked",)
                    self.marker(t, s, hole[0] + hole[1] - t)
                t += f
                k += 1
                continue
            if jump and t >= jump[0] and not shift:
                shift = jump[1]
            pts = t + shift
            if s.bframes:
                d_idx = 0 if k == 0 else (3 * ((k - 1) // 3) + 3 if (k - 1) % 3 == 0 else 3 * ((k - 1) // 3) + (k - 1) % 3)
                pts = t0 + d_idx * f + shift + (t - t0 - k * f)
                dts = t - f + shift
                self.pes(s, t, pts, None if pts == dts else dts)
            elif r.chance(10):
                self.pes(s, t, None)              # no PTS
            else:
                self.pes(s, t, pts + r.below(4) * MS * (1 if s.sid == 0xE0 else 0))
            t += f
            k += 1

    def marker(self, t, s, length, exact=False):
        r = self.r
        if exact:                                 # one PID, the hole's own length and end
            self.add(t, "marker", ([gap_packet(s.pid, self.cc.get(s.pid, 1) - 1, length)], t + length))
            return
        pids = [s.pid] + ([r.pick(self.streams).pid] if r.chance(300) else []) + ([0x1FF7] if r.chance(200) else [])
        pkts = [gap_packet(p, self.cc.get(p, 1) - 1, length + r.pick((0, 0, 50 * MS, -5 * MS))) for p in pids]
        end_ns = None if r.chance(80) else t + length
        self.add(t, "marker", (pkts, end_ns))

    def config(self):
        r = self.r
        if r.chance(150):
            self.cfg["house_ns"] = r.pick((-1, self.t0 + 75 * SEC, self.t0 - 90 * SEC, self.t0 + 3 * 3600 * SEC,
                                           self.t0 + 20 * MS))
        if r.chance(150):
            self.cfg["media"] = tuple(m for m in dc.MEDIA_ALL if r.chance(500))
        if r.chance(150):
            self.cfg["select"] = dc.CAPS_302M
        if self.second and r.chance(400):
            self.cfg["program"] = 2 if self.number != 2 else 3

    # --- the recording ---

    def write(self, ts_path, bus_path):
        """The .ts and its sidecar: buffers of 1-40 packets, some DISCONT after a dropped run,
        garbage now and then, markers as GAP|DISCONT buffers of their own."""
        r = self.r
        data = bytearray()
        bus = []
        buf, flags = [], 0

        def close():
            nonlocal buf, flags
            if buf:
                off = len(data)
                for b in buf:
                    data.extend(b)
                bus.append({"off": off, "len": len(data) - off, "pts": None, "dts": None, "dur": None,
                            "flags": flags})
            buf, flags = [], 0

        size = 1 + r.below(40)
        for t, _, kind, payload in sorted(self.items):
            if kind == "marker":
                close()
                pkts, end_ns = payload
                off = len(data)
                for p in pkts:
                    data.extend(p)
                bus.append({"off": off, "len": len(data) - off, "pts": end_ns, "dts": None, "dur": None,
                            "flags": 2048 | 64})
                continue
            for p in payload:
                if r.chance(4):                   # lost on the wire: a CC loss
                    continue
                if r.chance(2):                   # a run lost by the bus: the next buffer DISCONT
                    close()
                    flags = 64
                    continue
                buf.append(p)
                if r.chance(3):
                    buf.append(p)                 # a duplicate (one is legal)
                if r.chance(3):
                    buf.append(bytes(r.below(256) for _ in range(1 + r.below(200))))
                if len(buf) >= size:
                    close()
                    size = 1 + r.below(40)
        close()
        with open(ts_path, "wb") as f:
            f.write(bytes(data))
        with open(bus_path, "w") as f:
            for b in bus:
                f.write(json.dumps(b, separators=(",", ":")) + "\n")
        return len(data), len(bus)


# --- the reference's mutants ------------------------------------------------------------------------

MUTANTS = [
    ("floor, not the ceil",
     "            pts = pts90k_to_ns_ceil(pts_u - MUX_CLOCK_BASE_90K)",
     "            pts = pts90k_to_ns(pts_u - MUX_CLOCK_BASE_90K)"),
    ("a plan on a version-only bump",
     "        if old is not None and same_program(old.pmt, pmt):\n            return",
     "        if False:\n            return"),
    ("the DTS unwrapped alone (the a1 fault)",
     "            dts_u = pad.uw.feed_dts(u.hdr.dts, pts_u)",
     "            dts_u = None if u.hdr.dts < 0 else u.hdr.dts + (pts_u - u.hdr.pts)"),
    ("the video bound 2 frames",
     "                jump = hole >= self.VIDEO_HOLE_NS",
     "                jump = hole > self.JUMP_FRAMES * frame"),
    ("markers untrimmed",
     "            if pad.have_horizon and start < pad.horizon:\n                start = pad.horizon\n",
     ""),
    ("program time from the PCR only",
     "        if not self._select and not pad.sparse:\n            self._advance(end, out)",
     "        pass"),
    ("the first generation 1",
     "        gen = 0 if old is None else old.gen + 1",
     "        gen = 1 if old is None else old.gen + 1"),
    ("the generation unmasked in pad names",
     '    return "%s_%01x_%04x" % (cls, gen & 0xF, pid)',
     '    return "%s_%01x_%04x" % (cls, gen, pid)'),
    ("select no-stream at 0 s",
     "    NO_STREAM_NS = 2 * SEC",
     "    NO_STREAM_NS = 0"),
    ("a marker leaves the open PES behind its gap",
     "            units = []\n            self._pes.close(pad.pid, units)\n            for u in units:\n"
     "                self._on_unit(pad, u, out)\n            self._k[\"markers\"] += 1",
     "            self._k[\"markers\"] += 1"),
    ("a sparse gap is a loss: DISCONT next",
     "                pad.horizon = t - lag\n",
     "                pad.horizon = t - lag\n                pad.discont = True\n"),
    ("the first language, not tsdemux's last",
     '    return codes[-1] if codes else ""',
     '    return codes[0] if codes else ""'),
    ("same program ignores the PCR PID",
     "    if old.program_number != new.program_number or old.pcr_pid != new.pcr_pid:",
     "    if old.program_number != new.program_number:"),
    ("same program ignores the stream count (a removed stream keeps the pads)",
     "    if len(old.streams) != len(new.streams):\n        return False\n",
     ""),
    ("the unknown warning outside media too",
     "                if stype not in SECTION_TYPES and unknown_class(stype, es_info) in self.cfg.media:",
     "                if stype not in SECTION_TYPES:"),
    ("a jump measured from the last spacing time, not the horizon",
     "            hole = pts - pad.horizon",
     "            hole = pts - pad.last_t"),
    ("the PCR ignored: program time from units alone",
     "        if v.af_pcr and self._program is not None and v.pid == self._program.pmt.pcr_pid:\n"
     "            self._on_pcr(v, out)\n",
     ""),
    ("a marker gap leaves the spacing clean",
     "            self._gap(pad, start, end_ns, \"marker\", out)\n            pad.clean = False",
     "            self._gap(pad, start, end_ns, \"marker\", out)"),
    ("the sparse horizon jumps to program time",
     "                pad.horizon = t - lag\n",
     "                pad.horizon = t\n"),
    ("the DTS floored while the PTS is ceil'd",
     "            dts = pts if dts_u is None else pts90k_to_ns_ceil(dts_u - MUX_CLOCK_BASE_90K)",
     "            dts = pts if dts_u is None else pts90k_to_ns(dts_u - MUX_CLOCK_BASE_90K)"),
    ("not-house-time at 60 ms",
     "    NOT_HOUSE_NS = 60 * SEC",
     "    NOT_HOUSE_NS = 60 * SEC // 1000"),
    ("video spacing from the reordered PTS (p3-1a's rule)",
     '        t = dts if pad.cls == "video" else pts\n',
     "        t = pts\n"),
    ("a PMT without streams planned",
     "        if not pmt.streams:\n            return                                # tsdemux skips a PMT without entries\n",
     ""),
    ("unknown at every PMT change, not per plan",
     "        old = self._program\n        if old is not None and same_program(old.pmt, pmt):\n            return",
     "        old = self._program\n        if old is not None and same_program(old.pmt, pmt):\n"
     "            for pid, stype, es_info in pmt.streams:\n"
     "                if classify(stype, es_info) is None and stype not in SECTION_TYPES:\n"
     "                    out.append(Event(\"unknown\", {\"pid\": pid, \"type\": stype, \"reg\": \"\", \"gen\": old.gen}))\n"
     "            return"),
    ("unknown at every PMT packet",
     "        self._psi.feed([v.p])\n        if self._select:",
     "        self._psi.feed([v.p])\n"
     "        if self._program is not None and v.pid == self._psi.pmt_pid and v.pusi:\n"
     "            for pid, stype, es_info in self._program.pmt.streams:\n"
     "                if classify(stype, es_info) is None and stype not in SECTION_TYPES:\n"
     "                    out.append(Event(\"unknown\", {\"pid\": pid, \"type\": stype, \"reg\": \"\", \"gen\": 0}))\n"
     "        if self._select:"),
    ("the registration before the descriptors (BSSD before teletext)",
     "    if find_descriptor(es_info, 0x56) is not None:\n        return es(\"private\", CAPS_TTX, True)",
     "    if reg == REG_BSSD:\n        return es(\"audio\", CAPS_302M)\n"
     "    if find_descriptor(es_info, 0x56) is not None:\n        return es(\"private\", CAPS_TTX, True)"),
    ("no language from the DVB subtitling descriptor",
     "        body, size = find_descriptor(loop, 0x59), 8",
     "        body, size = None, 8"),
    ("the unknown warning for section-only types too",
     "                if stype not in SECTION_TYPES and unknown_class(stype, es_info) in self.cfg.media:",
     "                if unknown_class(stype, es_info) in self.cfg.media:"),
    ("a bus DISCONT keeps the open PES",
     "            self._walker.reset()\n            self._pes.reset()\n            for pad in self._live_pads():",
     "            self._walker.reset()\n            for pad in self._live_pads():"),
]


def mutant(src, old, new):
    """The reference with one exact replacement, as a module (its imports resolved as the real one's)."""
    m = types.ModuleType("demux_core_mutant")
    m.__file__ = dc.__file__
    exec(compile(src.replace(old, new), dc.__file__, "exec"), m.__dict__)
    return m


def main():
    if not sys.platform.startswith("linux"):
        print("SKIP demux_core_parity_test.py: mrts_cli builds on Linux only")
        return 0
    made = build()
    if made:
        print(f"FAIL the C++ suite and mrts_cli build:\n{made}")
        return 1
    tmp = tempfile.mkdtemp(prefix="demux-core-parity.")
    try:
        # 1. The suites.
        names = {}
        for side, argv in (("C++", [CPP_TEST]), ("Python", [sys.executable, "-B", os.path.join(HERE,
                                                                                              "demux_core_test.py")])):
            done = subprocess.run(argv, capture_output=True, text=True, cwd=HERE)
            n, passed = suite_checks(done.stdout)
            check(f"suites: the {side} suite passes ({len(n)} checks)", done.returncode == 0 and passed and n)
            names[side] = n
        check(f"suites: the same {len(names['C++'])} checks in the same order",
              names["C++"] == names["Python"] and names["C++"])

        # 2. Recordings, then 3. the mutants on them (each until a difference catches it).
        with open(dc.__file__) as f:
            src = f.read()
        mutants = [(name, mutant(src, old, new) if src.count(old) == 1 else None) for name, old, new in MUTANTS]
        caught = {}

        def try_mutants(c, want_cpp):
            for name, m in mutants:
                if m is None or name in caught:
                    continue
                try:
                    if c.ref(m) != want_cpp:
                        caught[name] = c.label
                except Exception as e:            # a crash is a difference too
                    caught[name] = f"{c.label} ({type(e).__name__})"

        cases = []
        expect = sorted(f for f in os.listdir(FIXTURES) if f.endswith(".demux.jsonl"))
        for f in expect:
            stem, program = f[:-len(".demux.jsonl")], -1
            if ".p" in stem and stem.rsplit(".p", 1)[1].isdigit():
                stem, program = stem.rsplit(".p", 1)[0], int(stem.rsplit(".p", 1)[1])
            ts = os.path.join(FIXTURES, stem + ".ts")
            for chunk in CHUNKS:
                cases.append(Case(f"{stem} p{program} {chunk}", ts, None, chunk, program))
            sidecar = os.path.join(FIXTURES, stem + ".bus.jsonl")
            if os.path.exists(sidecar):
                cases.append(Case(f"{stem} p{program} bus", ts, sidecar, 1316, program))
            if program < 0:
                cases.append(Case(f"{stem} select", ts, select=dc.CAPS_302M))
                for media in (("video",), ("audio",), ("private", "subpicture")):
                    cases.append(Case(f"{stem} media {','.join(media)}", ts, media=media))
        first, n = None, {}
        for c in cases:
            got, want = c.cpp(), c.ref()
            for k, v in tally(got).items():
                n[k] = n.get(k, 0) + v
            d = first_difference(got, want)
            if d and first is None:
                first = f"{c.label}: {d}"
            if c.chunk == 1316 or c.bus:
                try_mutants(c, got)
        check(f"recordings: {len(cases)} replays of {len(expect)} expectations (4 chunkings, sidecars, select, "
              f"3 media), {n.get('unit', 0)} units, {n.get('gap', 0)} gaps, {n.get('plan', 0)} plans, "
              f"{n.get('section', 0)} sections, every line the same"
              + (f" (first difference: {first})" if first else ""), first is None and n.get("unit", 0) > 50000)

        # 2b. Random programs, each written, replayed by both, tried on the mutants left, removed.
        first, n, sizes = None, {}, [0, 0]
        for seed in range(1, PROGRAMS + 1):
            p = Program(seed)
            ts, bus = os.path.join(tmp, f"p{seed}.ts"), os.path.join(tmp, f"p{seed}.bus.jsonl")
            nbytes, nbus = p.write(ts, bus)
            sizes[0] += nbytes
            sizes[1] += nbus
            c = Case(f"program {seed}", ts, bus, 1316, **p.cfg)
            got, want = c.cpp(), c.ref()
            for k, v in tally(got).items():
                n[k] = n.get(k, 0) + v
            k = json.loads(got[-1]).get("counters", {}) if got and got[-1].startswith('{"counters"') else {}
            for key in COUNTERS:
                n[key] = n.get(key, 0) + (k.get(key, 0) or 0)
            d = first_difference(got, want)
            if d and first is None:
                first = f"program {seed}: {d}"
            try_mutants(c, got)
            os.remove(ts)
            os.remove(bus)
        check(f"random programs: {PROGRAMS} programs, {sizes[0] // 1000} kB in {sizes[1]} bus buffers, every line "
              f"the same" + (f" (first difference: {first})" if first else ""), first is None)
        # No-stream needs a moving clock, which a replay at one house time has not: cases 12 and 13 hold it.
        kinds = ("unit", "gap", "plan", "gone", "section", "unknown", "nothouse")
        check("random programs reach: " + ", ".join(f"{n.get(k, 0)} {k}" for k in kinds) + "; " +
              ", ".join(f"{n.get(k, 0)} {k}" for k in COUNTERS), all(n.get(k, 0) > 0 for k in kinds + COUNTERS))

        for name, m in mutants:
            print(("CAUGHT " if name in caught else "MISSED " if m else "NOT APPLIED ") + name +
                  (f": {caught[name]}" if name in caught else ""))
        missed = [name for name, m in mutants if m and name not in caught]
        bad = [name for name, m in mutants if m is None]
        check(f"mutants: the parity catches {len(caught)} of {len(MUTANTS)} of the reference's mutants"
              + (f" (missed: {'; '.join(missed)})" if missed else "")
              + (f" (not applied: {'; '.join(bad)})" if bad else ""), not missed and not bad)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if _failures:
        print(f"\n{_failures} FAILURE(S) in demux_core_parity")
        return 1
    print("\nALL demux_core_parity TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
