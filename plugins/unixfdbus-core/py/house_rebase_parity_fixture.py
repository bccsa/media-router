#!/usr/bin/env python3
"""hls-pipe's inline-AV output across EXT-X-DISCONTINUITY, as mr-bus-fanout's ingest hands it to
the rebase: house_rebase_parity_test.py's input of its own, since no hls-pipe recording exists in
the tree or the captures; and random programs for the edges no recording reaches (`Fuzz`).
Deterministic (an LCG, as native_parity_fixture.py; SplitMix64 for the random programs).

Modelled on packages/hls-pipe (src/mux/ts/*.ts, src/stream/extractor.ts) and the engine's
PacedTsSink:
- a live origin of 2 s segments, 25 fps H.264 with B-frames, AAC in two languages, WebVTT; an
  encoder restart starts a new timeline (back, then forward to just under the 33-bit wrap);
- one muxMulti call per video AU (partitionAvByDts' buckets): PAT and PMT, then the AU and the
  audio frames and cues whose PTS falls in it, by DTS; the PCR = DTS in each AU's first packet,
  random_access on keyframes; buildPes' headers; an AF stuffs each PES's last packet;
- the inline audio: a segment's first frame at the last one emitted plus a frame, so it goes on
  across EXT-X-DISCONTINUITY while the video jumps, and its frames all land in the segment's
  last bucket (a jump back) or its first (forward); CC restarts after the discontinuity's
  segment; an ABR switch flags the next AU and bumps the PSI version;
- the runner killed and respawned (the queue it held lost), the new one 2 segments behind the
  live edge with both on the origin's timeline; a fetch delayed past the sink's lead;
- the sink: 24,064-byte datagrams sent at their media time with a 2 s prefill, re-anchored only
  later when its queue ran dry; the ingest passes each on as one chunk.

Run:  python3 house_rebase_parity_fixture.py <out.bin> [--fuzz]   (house_rebase_ref's records)
"""
import os
import struct
import sys

sys.path.append(os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "mpegts-core", "py")))
import ts_psi  # noqa: E402

PKT = 188
WRAP = 1 << 33
FRAME = 3600                                    # 25 fps
SEG_AUS = 50                                    # 2 s segments
SEG_TICKS = SEG_AUS * FRAME
GOP = 25                                        # I, then (P B B) x 8, in decode order
AFRAME = 1920                                   # AAC at 48 kHz
VIDEO_PID, AUDIO_PIDS, SUB_PID, PMT_PID = 0x100, (0x101, 0x102), 0x110, 0x1000
AUDIO_LEAD = (-900, 300)                        # each language's first frame against the video's
SEC = 1000000000
W0 = 7000 * SEC                                 # house time of the origin's segment 0
PREFILL_NS = 2 * SEC
DATAGRAM = 128 * PKT                            # PacedUnixStreamTsSink, and the ingest's chunk
# The origin's timelines: (first segment, its first DTS). The second is an encoder restart
# back near zero, the third one forward to just under the 33-bit wrap.
EPOCHS = ((0, 8101234), (14, 45000), (21, WRAP - 2 * SEG_TICKS - 777))
ABR_SWITCH_SEG = 17
STALL = (19, 3500000000)                        # this segment's fetch delayed past the lead


class Lcg:
    """Tiny deterministic PRNG, native_parity_fixture.py's."""

    def __init__(self, seed=0x5EED):
        self.s = seed

    def next(self, mod):
        self.s = (self.s * 1103515245 + 12345) & 0x7FFFFFFF
        return self.s % mod


def ts_field(v, prefix):
    v %= WRAP
    return bytes([prefix | ((v >> 29) & 0x0E) | 0x01, (v >> 22) & 0xFF, ((v >> 14) & 0xFE) | 0x01,
                  (v >> 7) & 0xFF, ((v << 1) & 0xFE) | 0x01])


def build_pes(sid, payload, pts, dts=None, alignment=False):
    """hls-pipe's buildPes: video unbounded, PTS only when the DTS equals it."""
    use_dts = dts is not None and dts != pts
    pts_len = 10 if use_dts else 5
    declared = 0 if 0xE0 <= sid <= 0xEF else 3 + pts_len + len(payload)
    head = bytes([0, 0, 1, sid, (declared >> 8) & 0xFF, declared & 0xFF,
                  0x80 | (0x04 if alignment else 0), 0xC0 if use_dts else 0x80, pts_len])
    head += ts_field(pts, 0x30 if use_dts else 0x20)
    if use_dts:
        head += ts_field(dts, 0x10)
    return head + payload


def psi_sections(version):
    """hls-pipe's PAT and PMT sections, pointer_field first: languages, the WebVTT registration."""
    pat = bytearray([0x00, 0xB0, 0x0D, 0x00, 0x01, 0xC1 | ((version & 0x1F) << 1), 0, 0,
                     0x00, 0x01, 0xE0 | (PMT_PID >> 8), PMT_PID & 0xFF])
    pat += ts_psi.crc32_mpeg(bytes(pat)).to_bytes(4, "big")
    streams = [(0x1B, VIDEO_PID, b"")]
    streams += [(0x0F, pid, b"\x0a\x04" + lang + b"\x00") for pid, lang in zip(AUDIO_PIDS, (b"eng", b"fra"))]
    streams.append((0x06, SUB_PID, b"\x0a\x04eng\x00" + b"\x05\x04VTT "))
    body = bytearray([0x00, 0x01, 0xC1 | ((version & 0x1F) << 1), 0, 0,
                      0xE0 | (VIDEO_PID >> 8), VIDEO_PID & 0xFF, 0xF0, 0x00])
    for st, pid, info in streams:
        body += bytes([st, 0xE0 | (pid >> 8), pid & 0xFF, 0xF0 | (len(info) >> 8), len(info) & 0xFF]) + info
    length = len(body) + 4
    pmt = bytearray([0x02, 0xB0 | (length >> 8), length & 0xFF]) + body
    pmt += ts_psi.crc32_mpeg(bytes(pmt)).to_bytes(4, "big")
    return b"\x00" + bytes(pat), b"\x00" + bytes(pmt)


class Writer:
    """hls-pipe's TsPacketWriter: CC per PID; an AF (PCR, random_access, discontinuity) on a
    chunk's first packet; the last packet stuffed through its AF."""

    def __init__(self):
        self.cc = {}
        self.out = bytearray()

    def reset(self):
        self.cc.clear()

    def chunk(self, pid, data, pcr_base=None, rai=False, di=False):
        cursor, first, total = 0, True, len(data)
        while cursor < total:
            pkt = bytearray(PKT)
            pkt[0] = 0x47
            pkt[1] = (0x40 if first else 0) | (pid >> 8)
            pkt[2] = pid & 0xFF
            cc = self.cc[pid] = (self.cc.get(pid, -1) + 1) & 0x0F
            pkt[3] = 0x10 | cc
            off = 4
            with_af = first and (pcr_base is not None or rai or di)
            if with_af:
                pkt[5] = (0x80 if di else 0) | (0x40 if rai else 0) | (0x10 if pcr_base is not None else 0)
                off = 6
                if pcr_base is not None:
                    b = pcr_base % WRAP
                    pkt[6:12] = bytes([b >> 25 & 0xFF, b >> 17 & 0xFF, b >> 9 & 0xFF, b >> 1 & 0xFF,
                                       (b & 1) << 7 | 0x7E, 0])
                    off = 12
                pkt[4] = off - 5
                pkt[3] = 0x30 | cc
            room, remaining = PKT - off, total - cursor
            if remaining < room:
                need = room - remaining
                if with_af:
                    pkt[4] += need
                    pkt[off:off + need] = b"\xff" * need
                    off += need
                elif need == 1:
                    pkt[4] = 0
                    off = 5
                else:
                    pkt[4] = need - 1
                    pkt[5] = 0
                    pkt[6:4 + need] = b"\xff" * (need - 2)
                    off = 4 + need
                pkt[3] = 0x30 | cc
                room = remaining
            pkt[off:off + room] = data[cursor:cursor + room]
            cursor += room
            first = False
            self.out += pkt


class HlsPipe:
    """One runner process: its muxer and the inline audio's anchors, segment by segment."""

    def __init__(self, lcg):
        self.lcg = lcg
        self.writer = Writer()
        self.psi_version = 0
        self.pending_di = False
        self.last_audio = [None, None]           # InlineAudioContext.lastEmittedPts

    def segment(self, seg, epoch_base, seg_off, discontinuity, first_cue_early):
        """The buckets of origin segment `seg`, `seg_off` ticks into a timeline starting at
        `epoch_base`: [(bytes, media ns)]."""
        lcg = self.lcg
        base = epoch_base + seg_off
        video = []
        for n in range(SEG_AUS):
            g = n % GOP
            disp = 0 if g == 0 else 3 * ((g - 1) // 3) + (3, 1, 2)[(g - 1) % 3]
            dts = base + n * FRAME
            size = (9000 + lcg.next(2000) if g == 0
                    else 1500 + lcg.next(500) if disp > g else 500 + lcg.next(300))
            video.append((dts, dts + (disp - g + 1) * FRAME, bytes([0xA5]) * size, g == 0))
        # The origin's audio frames of this media span; the first emitted at the source's PTS,
        # every later one a frame after the last emitted, whatever the source did.
        j0, j1 = -(-seg_off // AFRAME), -(-(seg_off + SEG_TICKS) // AFRAME)
        audio = []
        for k, lead in enumerate(AUDIO_LEAD):
            last = self.last_audio[k]
            first = epoch_base + lead + j0 * AFRAME if last is None else last + AFRAME
            pts = [first + i * AFRAME for i in range(j1 - j0)]
            self.last_audio[k] = pts[-1]
            audio.append([(p, bytes([0xC0 + k]) * (160 + lcg.next(20))) for p in pts])
        cues = [(base + (-1800 if first_cue_early else 22500), b"WEBVTT cue %d\n" % seg)]
        # partitionAvByDts: each AU starts a bucket; audio and cues by PTS, clamped to the ends.
        starts = [v[0] for v in video]
        buckets = [[(v[0], "v", v)] for v in video]

        def at(pts):
            i = 0
            while i + 1 < len(starts) and starts[i + 1] <= pts:
                i += 1
            return i

        for k, frames in enumerate(audio):
            for p, data in frames:
                buckets[at(p)].append((p, "a", (AUDIO_PIDS[k], 0xC0 + k, p, data)))
        for p, data in cues:
            buckets[at(p)].append((p, "s", (p, data)))
        out = []
        pat, pmt = psi_sections(self.psi_version)
        w = self.writer
        for tasks in buckets:
            w.out = bytearray()
            w.chunk(0, pat)
            w.chunk(PMT_PID, pmt)
            for _, kind, t in sorted(tasks, key=lambda x: x[0]):   # stable: video first at a tie
                if kind == "v":
                    dts, pts, data, key = t
                    di, self.pending_di = self.pending_di, False
                    w.chunk(VIDEO_PID, build_pes(0xE0, data, pts, dts, True), pcr_base=dts, rai=key, di=di)
                elif kind == "a":
                    pid, sid, pts, data = t
                    w.chunk(pid, build_pes(sid, data, pts, None, True))
                else:
                    pts, data = t
                    w.chunk(SUB_PID, build_pes(0xBD, data, pts))
            out.append((bytes(w.out), FRAME * SEC // 90000))
        if discontinuity:
            w.reset()                            # after the segment that carries the tag
        return out

    def abr_switch(self):
        """signalDiscontinuity: the next AU's first packet flagged, the PSI version bumped."""
        self.psi_version = (self.psi_version + 1) & 0x1F
        self.pending_di = True


def origin(seg):
    """(the first DTS of its timeline, its offset into it, EXT-X-DISCONTINUITY before it)."""
    first, base = [e for e in EPOCHS if e[0] <= seg][-1]
    return base, (seg - first) * SEG_TICKS, seg == first and first > 0


def sink(writes, lcg, end):
    """PacedTsSink: 24,064-byte datagrams, each at its media time from a 2 s prefill, the mapping
    re-anchored only later once the queue ran dry; at `end` the tail goes too, a short chunk the
    ingest passes on after 20 ms. writes: [(house ns, bytes, media ns)] -> [(house ns, bytes)]."""
    leftover, cursor = b"", 0
    queue = []
    for t, data, span in writes:
        buf = leftover + data
        n = len(buf) // DATAGRAM
        for i in range(n):
            queue.append((t, cursor + span * i // n, buf[i * DATAGRAM:(i + 1) * DATAGRAM]))
        leftover = buf[n * DATAGRAM:]
        cursor += span
    if end and leftover:
        queue.append((writes[-1][0], cursor, leftover))
    sent, start, last = [], None, None
    for avail, at, dgram in queue:
        if start is None or avail > last:
            fresh = avail - PREFILL_NS - at
            start = fresh if start is None else max(start, fresh)
        last = max(avail, start + at) + lcg.next(300000)
        sent.append((last + (20000000 if len(dgram) < DATAGRAM else 0), dgram))
    return sent


def session(lcg):
    """The ingest's chunks, in order: [(house ns, bytes)]."""
    chunks = []
    t = W0 + 25 * SEC                            # the first runner spawns
    for run, (segments, pause) in enumerate(((15, 1500000000), (4, 3000000000), (5, 0))):
        pipe = HlsPipe(lcg)
        live = (t - W0) // (2 * SEC) - 1         # the newest whole segment
        writes, avail = [], t
        for k, seg in enumerate(range(live - 2, live - 2 + segments)):
            # Fetched one after the other, each once it is published.
            avail = max(avail, W0 + (seg + 1) * 2 * SEC) + 20000000 + lcg.next(60000000)
            if run == 0 and seg == STALL[0]:
                avail += STALL[1]
            if run == 0 and seg == ABR_SWITCH_SEG:
                pipe.abr_switch()
            for i, (data, span) in enumerate(pipe.segment(seg, *origin(seg), run == 0 and k == 0)):
                writes.append((avail + i * 200000, data, span))
        sent = sink(writes, lcg, end=not pause)
        if pause:                                # killed: what its sink still held is lost
            dies = writes[-1][0] + SEC
            sent = [s for s in sent if s[0] <= dies]
            t = dies + pause
        chunks += sent
    return chunks


def records():
    """house_rebase_ref's records: rebase 0 the ingest's chunks, rebase 1 the same bytes cut at
    1 to 1,013 bytes (the walker's carry and resync) at the house time of their chunk."""
    lcg = Lcg()
    out = []
    chunks = session(lcg)
    for now, data in chunks:
        out.append((0, now, data))
    for now, data in chunks:
        off = 0
        while off < len(data):
            k = 1 + lcg.next(1013)
            out.append((1, now, data[off:off + k]))
            off += k
    return out


# --- random programs, for the edges no recording reaches ------------------------------------

# Jumps at and around the 1 s threshold (also off a spacing of 1800 or 3600), under it, past it.
JUMPS = (90000, 90001, -90000, -90001, 88200, 91800, -88200, -91800, 86400, 93600, 81000,
         99000, 900000, -900000, 54000000, -54000000)
PID_NULL = 0x1FFF


class SplitMix:
    """SplitMix64 for the fuzz: an LCG's low bits are periodic, so `next(4)` then `next(8)` is
    not every pair; every bit of this one counts, the same on every platform."""
    M64 = (1 << 64) - 1

    def __init__(self, seed):
        self.s = seed & self.M64

    def next(self, mod):
        self.s = (self.s + 0x9E3779B97F4A7C15) & self.M64
        z = ((self.s ^ (self.s >> 30)) * 0xBF58476D1CE4E5B9) & self.M64
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & self.M64
        return (z ^ (z >> 31)) % mod


def section(table_id, ext, version, number, last, body):
    """A current PSI section with its CRC."""
    sec = bytearray([table_id, 0, 0, ext >> 8, ext & 0xFF, 0xC1 | (version << 1), number, last]) + body
    length = len(sec) - 3 + 4
    sec[1], sec[2] = 0xB0 | (length >> 8), length & 0xFF
    return bytes(sec) + ts_psi.crc32_mpeg(bytes(sec)).to_bytes(4, "big")


def af_only(af):
    """An adaptation field that fills a packet with no payload."""
    return bytearray(af) + b"\xff" * (183 - len(af))


class Fuzz:
    """One random program: video, audio and private PIDs (some starting late), the PCR in a PES's
    first packet or on a PCR-only PID, PSI in one of several forms (none, two programs, a shared
    PMT PID, a section 1, a PMT over several packets, the PCR PID moving with or without a new
    version: the PSI-heavy ones long enough for the periodic re-parse), PES headers of every
    shape (stuffed, no PTS, a DTS 4.5 or 6 s off), split headers with what can come between, an
    opening whose first steps differ, jumps of some of the PIDs, a PID silent around
    REF_STALE_NS while another jumps, stalls, duplicates, CC gaps, scrambled packets, garbage."""

    def __init__(self, rng):
        self.rng = rng
        r = self.r
        self.cc = {}
        self.writes = []                          # (house ns, bytes)
        self.now = (1000 + r(9000)) * SEC
        self.jitter = r(2) == 0
        kinds = (("v", 0xE0), ("a", 0xC0), ("a", 0xC1), ("p", 0xBD))
        chosen = [kinds[i] for i in range(4) if r(3) > 0] or [kinds[r(4)]]
        base = WRAP - r(900000) if r(4) == 0 else r(1 << 31)
        self.pids = []
        for i, (kind, sid) in enumerate(chosen):
            step = ((3600 if r(2) else 1800) if kind == "v" else 3600 if kind == "p"
                    else 1920 if sid == 0xC0 else 2160)
            self.pids.append({"pid": 0x100 + 0x10 * i + r(16), "kind": kind, "sid": sid, "step": step,
                              "n": 0, "base": base + r(10000) - 5000, "off": 0, "reorder": r(3),
                              "dts": kind == "v" and r(3) > 0, "start": r(8) if r(3) == 0 else 0,
                              "silent": 0, "then": None, "pcr": False})
        self.pcr_only = 0x1F0 if r(4) == 0 else None
        if self.pcr_only is None:
            self.pids[r(len(self.pids))]["pcr"] = True
        self.pcr_pid = (self.pcr_only if self.pcr_only is not None
                        else [s for s in self.pids if s["pcr"]][0]["pid"])
        self.psi = ("none", "one", "one", "two", "shared", "section1", "big", "change", "silent",
                    "silent1")[r(10)]
        self.version = 0
        self.nit = r(4) == 0                      # a program 0 (the NIT) first in the PAT
        self.change_at = 40 + r(60)
        # PSI every step and long enough to cross the 500-feed re-parse a few times.
        self.long = self.psi in ("shared", "section1", "silent", "silent1")
        self.steps = 250 + r(100) if self.long else 40 + r(120)
        if r(3) == 0:                             # a hole at the 2nd PES, a jump at the 4th
            opening = {1: (81000, 45000, 27000)[r(3)], 3: JUMPS[r(len(JUMPS))]}
            for s in self.pids:
                s["script"] = dict(opening)
        self.pre = r(3) == 0                      # private PES before the anchor, split
        self.events = self.damage = True

    def r(self, n):
        return self.rng.next(n)

    def packet(self, pid, pusi, payload, af=None, scrambled=False):
        """One packet at house now (`af`: the adaptation field after its length byte), the payload
        cut to the room left; returns the payload bytes it took."""
        p = bytearray(b"\xff" * PKT)
        p[0], p[1], p[2] = 0x47, (0x40 if pusi else 0) | (pid >> 8), pid & 0xFF
        c = self.cc.get(pid, self.r(16))
        if payload is not None:
            c = self.cc[pid] = (c + 1) & 0x0F
        p[3] = ((0x80 if scrambled else 0) | (0x20 if af is not None else 0)
                | (0x10 if payload is not None else 0) | c)
        off = 4
        if af is not None:
            p[4] = len(af)
            p[5:5 + len(af)] = af
            off = 5 + len(af)
        n = 0
        if payload is not None:
            n = min(len(payload), PKT - off)
            p[off:off + n] = payload[:n]
        self.writes.append((self.now, bytes(p)))
        return n

    def pcr_bytes(self, ticks):
        pcr = ((ticks - 9000) * 300 + self.r(300)) % (300 << 33)
        b, e = pcr // 300 % WRAP, pcr % 300
        return bytes([b >> 25 & 0xFF, b >> 17 & 0xFF, b >> 9 & 0xFF, b >> 1 & 0xFF,
                      (b & 1) << 7 | 0x7E | (e >> 8), e & 0xFF])

    def psi_packets(self, k):
        if self.psi == "none":
            return
        if (self.psi in ("change", "silent", "silent1") and k >= self.change_at
                and self.pcr_pid != self.pids[-1]["pid"]):
            # The PCR PID moves. The silent ones keep the version: one packet's PMT shows it in its
            # CRC; over several packets only the periodic re-parse sees it.
            self.version = (self.version + (self.psi == "change")) & 0x1F
            self.pcr_pid = self.pids[-1]["pid"]
        info = b"\x0a\x04eng\x00" * (30 if self.psi in ("big", "silent") else 0)
        entries = [bytes([0x1B if s["kind"] == "v" else 0x0F if s["kind"] == "a" else 0x06,
                          0xE0 | (s["pid"] >> 8), s["pid"] & 0xFF])
                   + (len(info) + 6).to_bytes(2, "big") + b"\x05\x04BSSD" + info for s in self.pids]

        def pmt(program, pcr, number=0, last=0):
            # The other program lists its first stream only: its section is shorter.
            return section(0x02, program, self.version, number, last,
                           bytes([0xE0 | (pcr >> 8), pcr & 0xFF, 0xF0, 0])
                           + b"".join(entries if program == 1 else entries[:1]))

        other = self.pids[-1]["pid"]
        programs, sections = [(1, 0x1000)], [(0x1000, pmt(1, self.pcr_pid))]
        if self.psi == "two":
            programs.append((2, 0x1001))
            sections.append((0x1001, pmt(2, other)))
        elif self.psi == "shared":
            programs.append((2, 0x1000))
            sections.insert(self.r(2), (0x1000, pmt(2, other)))
        elif self.psi == "section1":
            sections.insert(0, (0x1000, pmt(1, other, 1, 1)))
        if self.nit:
            programs.insert(0, (0, 0x0010))
        pat = section(0x00, 1, self.version, 0, 0,
                      b"".join(bytes([p >> 8, p & 0xFF, 0xE0 | (q >> 8), q & 0xFF]) for p, q in programs))
        for pid, sec in [(0, pat)] + sections:
            data, first = b"\x00" + sec, True
            while data:
                taken = self.packet(pid, first, data)
                if not first and self.r(25) == 0:     # a section's packet lost
                    self.writes.pop()
                data = data[taken:]
                first = False

    def pes(self, s, pts, dts, pcr_ticks):
        r = self.r
        pad = r(8) if r(4) == 0 else 0
        no_pts = r(40) == 0
        fields = b""
        if not no_pts:
            fields = ts_field(pts, 0x30 if dts is not None else 0x20)
            if dts is not None:
                fields += ts_field(dts, 0x10)
        head = bytes([0, 0, 1, s["sid"], 0, 0, 0x84, 0 if no_pts else 0xC0 if dts is not None else 0x80,
                      len(fields) + pad]) + fields + b"\xff" * pad
        body = bytearray(head + bytes([s["sid"]]) * r(80 if s["kind"] == "p" else 300))
        if s["kind"] != "v" or r(2):
            body[4:6] = (len(body) - 6).to_bytes(2, "big")
        af = None
        if pcr_ticks is not None or r(6) == 0:
            af = bytearray([0x10]) + self.pcr_bytes(pcr_ticks) if pcr_ticks is not None else bytearray([0])
        split = r(4) == 0
        if split:                                 # 1 .. len(head) - 1 header bytes left here
            af = af if af is not None else bytearray([0])
            af += b"\xff" * (PKT - 5 - len(af) - (1 + r(len(head) - 1)))
        taken = self.packet(s["pid"], True, body, af)
        if split:
            between = r(6)
            if between == 0:                      # adaptation only, a PCR on the carrier
                self.packet(s["pid"], False, None,
                            af_only(bytearray([0x10]) + self.pcr_bytes(pts) if s["pcr"] else bytearray([0])))
            elif between == 1:
                self.writes.append(self.writes[-1])   # the held header's duplicate
            elif between == 2:
                self.cc[s["pid"]] = (self.cc[s["pid"]] + 1) & 0x0F   # a packet lost
            elif between == 3:
                self.packet(PID_NULL, False, b"\xaa" * 184)
        while taken < len(body):
            taken += self.packet(s["pid"], False, body[taken:])

    def unit(self, s, t):
        r = self.r
        s["units"] = s.get("units", 0) + 1
        jump = s.get("script", {}).pop(s["units"] - 1, 0)
        s["off"] += jump
        t += jump
        dts = None
        if s["dts"]:
            dts, t = t, t + s["reorder"] * s["step"]
            if r(60) == 0:
                dts = t - (405000 if r(2) else 540000)    # damaged: 4.5 or 6 s before its PTS
        self.pes(s, t % WRAP, None if dts is None else dts % WRAP,
                 (dts if dts is not None else t) if s["pcr"] and r(3) > 0 else None)

    def pre_anchor(self):
        """Two private PES before any timing one, each header split with an adaptation-only packet
        behind it: the rebase cannot place them, and sends the AF-only packets all the same."""
        for _ in range(2):
            body = bytes([0, 0, 1, 0xBD, 0, 0, 0x84, 0x80, 5]) + ts_field(self.r(1 << 31), 0x20) + b"\xbd" * 40
            taken = self.packet(0x1E0, True, body, bytearray([0]) + b"\xff" * (PKT - 13))   # 7 bytes here
            self.packet(0x1E0, False, None, af_only(bytearray([0])))
            while taken < len(body):
                taken += self.packet(0x1E0, False, body[taken:])

    def step(self, k):
        r = self.r
        if self.long or k % (1 + r(12)) == 0:
            self.psi_packets(k)
        if k == 0 and self.pre:
            self.pre_anchor()
        for s in self.pids:
            s["off"] += s.get("at", {}).pop(k, 0)
        event = r(14) if self.events else -1
        if event == 0:                            # a jump of some of the PIDs, each its own or not
            j = JUMPS[r(len(JUMPS))]
            for s in self.pids:
                if r(3) > 0:
                    s["off"] += j if r(3) else JUMPS[r(len(JUMPS))]
        elif event == 1:                          # silent about REF_STALE_NS, then another jumps
            s = self.pids[r(len(self.pids))]
            s["silent"] = 46 + r(8)
            s["then"] = (self.pids[r(len(self.pids))], JUMPS[r(len(JUMPS))])
        elif event == 2:                          # the whole stream stalls
            self.now += (500 + r(4000)) * 1000000
        order = list(self.pids)
        if r(3) == 0:
            order.reverse()
        for s in order:
            if k < s["start"]:
                continue
            if k == s["start"] and s["n"] == 0:
                s["n"] = k * 3600 // s["step"]
            if s["silent"]:
                s["silent"] -= 1
                if s["silent"] == 0 and s["then"] is not None:
                    other, j = s["then"]
                    other["off"] += j
                    s["then"] = None
                continue
            if s["kind"] == "p":                  # sparse: a PES every 9 steps
                if k % 9 == 0:
                    self.unit(s, s["base"] + k * 3600 + s["off"])
                continue
            while s["n"] * s["step"] < (k + 1) * 3600:
                self.unit(s, s["base"] + s["n"] * s["step"] + s["off"])
                s["n"] += 1
        if self.pcr_only is not None and r(2):
            v = self.pids[0]
            ticks = v["base"] + v["n"] * v["step"] + v["off"]
            self.packet(self.pcr_only, False, None, af_only(bytearray([0x10]) + self.pcr_bytes(ticks)))
        damage = r(40) if self.damage else -1
        if damage == 0:                           # garbage, now and then a 0x47 in it
            self.writes.append((self.now, bytes(r(256) if r(5) else 0x47 for _ in range(1 + r(300)))))
        elif damage == 1 and self.writes:
            self.writes.append(self.writes[-1])   # a packet sent twice
        elif damage == 2:                         # scrambled: a PES in its ciphertext, a clear PCR
            s = self.pids[r(len(self.pids))]
            fake = bytes([0, 0, 1, 0xC0, 0, 0, 0x80, 0x80, 5]) + ts_field(r(1 << 31), 0x20)
            self.packet(s["pid"], True, fake, bytearray([0x10]) + self.pcr_bytes(r(1 << 31)) if r(2) else None,
                        scrambled=True)
        self.now += 40000000 + ((r(30) - 15) * 1000000 if self.jitter else 0)


def wrapped_reference(rng):
    """A video PCR PID whose first PES comes after the source wrapped, then re-anchors with the
    content ahead of house time: its first PES must unwrap near the source time of house now, or
    the landing compares two 2^33 periods. The audio anchors 1 s before the wrap."""
    f = Fuzz(rng)
    f.jitter, f.events, f.damage, f.pre, f.psi, f.long, f.steps = False, False, False, False, "none", False, 100
    base = WRAP - 90000
    f.pids = [dict(f.pids[0], pid=0x101, kind="a", sid=0xC0, step=1920, n=0, base=base, off=0, dts=False,
                   start=0, silent=0, then=None, pcr=False, script={}),
              dict(f.pids[0], pid=0x100, kind="v", sid=0xE0, step=3600, n=0, base=base + 5000, off=0,
                   reorder=2, dts=True, start=40, silent=0, then=None, pcr=True, script={}, at={60: 900000})]
    f.pcr_only, f.pcr_pid = None, 0x100
    return f


def fuzz_records(seed=0xB55, programs=120):
    """house_rebase_ref's records of `programs` random programs and the scripted one, a rebase each,
    cut anywhere from 1 byte to 3,000, each piece at the house time of its last byte."""
    rng = SplitMix(seed)
    out = []
    for rebase in range(programs + 1):
        f = Fuzz(rng) if rebase < programs else wrapped_reference(rng)
        for k in range(f.steps):
            f.step(k)
        data = b"".join(w[1] for w in f.writes)
        ends, at = [], 0
        for now, w in f.writes:
            at += len(w)
            ends.append((at, now))
        off, e = 0, 0
        while off < len(data):
            end = min(off + 1 + rng.next(3000), len(data))
            while ends[e][0] < end:
                e += 1
            out.append((rebase, ends[e][1], data[off:end]))
            off = end
    return out


def write_trace(path, recs):
    with open(path, "wb") as f:
        for rebase, now, data in recs:
            f.write(b"C" + struct.pack("<IqI", rebase, now, len(data)) + data)


def main():
    if len(sys.argv) not in (2, 3) or sys.argv[2:] not in ([], ["--fuzz"]):
        print("usage: house_rebase_parity_fixture.py <out.bin> [--fuzz]", file=sys.stderr)
        return 2
    recs = fuzz_records() if sys.argv[2:] else records()
    write_trace(sys.argv[1], recs)
    print(f"{len(recs)} chunks, {sum(len(r[2]) for r in recs)} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
