#!/usr/bin/env python3
"""Test fixture: a network ingest's input and what mrts::RestampCore makes of it, for the
mrtsrestamp tests (plan ch. 5 WI-P1-4, part 7.3). Shared by gst_mrtsrestamp_element_test.py,
gst_ingest_restamp_test.py and native_runner_protocol_test.py; not shipped (the engine build
copies only the runner's own modules).

Stream: an SPTS in 7-packet (1316-byte) datagrams, the shape of chapter 3's
cap-srt-ingest-1316.ts (PES headers and PSI anywhere, at most one PCR per datagram): H.264-like
video carrying the PCR (DTS one frame behind PTS), MPEG audio and PSI every 100 ms, on a source
clock at 2 h, each datagram arriving 20 ms after it was sent. Options: an outage, a flagged
source clock jump, extra PMT entries, PSI-only lead-in datagrams, a path delay that moves.

Reference: `reference()` runs mrtshouse/tests/restamp_ref (the core, no GStreamer) over records
("B", arrival, bytes), ("O", ns), ("T", {pid: ns}), ("C", ns), ("R", path), ("F",), ("E",).
`expected_items` is what the element pushes for them: each buffer's bytes split around its
markers, a marker's PTS the gap's end on the bus convention. `identity_stamps` is what an
identity egress then stamps on each data buffer (ts_timeline.cpp `stamp_house`)."""
import json
import os
import struct
import subprocess
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(_HERE, "..", "..", "..", ".."))
HOUSE_DIR = os.path.join(ROOT, "plugins", "mpegts-core", "native", "mrtshouse")
REF = os.path.join(HOUSE_DIR, "tests", "restamp_ref")
sys.path.insert(0, os.path.join(ROOT, "plugins", "mpegts-core", "py"))
import ts_timeline  # noqa: E402  (the Python reference of the identity rule)

MS = 1_000_000
S = 1_000_000_000
PKT = 188
PTS_WRAP = 1 << 33
TICK = 11_112  # one 90 kHz tick, rounded up
PID_PMT, PID_V, PID_A, PID_SILENT = 0x1000, 0x100, 0x101, 0x102
TS_CAPS = "video/mpegts, systemstream=(boolean)true, packetsize=(int)188"


def crc32_mpeg(data):
    crc = 0xFFFFFFFF
    for b in data:
        crc ^= b << 24
        for _ in range(8):
            crc = ((crc << 1) ^ 0x04C11DB7) if crc & 0x80000000 else crc << 1
            crc &= 0xFFFFFFFF
    return crc


def section(table_id, ext, payload):
    length = 5 + len(payload) + 4
    s = bytes([table_id, 0xB0 | (length >> 8), length & 0xFF, ext >> 8, ext & 0xFF, 0xC1, 0, 0])
    s += payload
    return s + crc32_mpeg(s).to_bytes(4, "big")


PAT = section(0x00, 1, bytes([0x00, 0x01, 0xE0 | (PID_PMT >> 8), PID_PMT & 0xFF]))


def pmt(extra=()):
    """Video (the PCR PID) and audio, then `extra` (stream type, PID) entries no PES comes on."""
    es = [(0x1B, PID_V), (0x03, PID_A)] + list(extra)
    return section(0x02, 1, bytes([0xE0 | (PID_V >> 8), PID_V & 0xFF, 0xF0, 0x00]) + b"".join(
        bytes([t, 0xE0 | (pid >> 8), pid & 0xFF, 0xF0, 0x00]) for t, pid in es))


PMT = pmt()


def psi_packet(pid, sec):
    body = b"\x00" + sec
    return bytes([0x47, 0x40 | (pid >> 8), pid & 0xFF, 0x10]) + body + b"\xff" * (184 - len(body))


def ns90k(ns):
    return (ns * 9 // 100_000) % PTS_WRAP


def put_ts(prefix, v):
    return bytes([(prefix << 4) | (((v >> 30) & 7) << 1) | 1, (v >> 22) & 0xFF,
                  (((v >> 15) & 0x7F) << 1) | 1, (v >> 7) & 0xFF, ((v & 0x7F) << 1) | 1])


def pes(sid, pts, dts, payload, bounded=True):
    opt = put_ts(3 if dts is not None else 2, pts) + (put_ts(1, dts) if dts is not None else b"")
    body = bytes([0x84, 0xC0 if dts is not None else 0x80, len(opt)]) + opt + payload
    n = len(body) if bounded else 0
    return b"\x00\x00\x01" + bytes([sid, n >> 8, n & 0xFF]) + body


def pcr_field(pcr27):
    base, ext = (pcr27 // 300) % PTS_WRAP, pcr27 % 300
    return bytes([(base >> 25) & 0xFF, (base >> 17) & 0xFF, (base >> 9) & 0xFF, (base >> 1) & 0xFF,
                  ((base & 1) << 7) | 0x7E | (ext >> 8), ext & 0xFF])


def packetize(pid, data, pcr27=None, discontinuity=False):
    """One PES's packets, CC 0 (stamped later); the PCR in the first one's adaptation field."""
    out, at, first = [], 0, True
    while first or at < len(data):
        flags = 0x90 if discontinuity else 0x10
        af = bytes([flags]) + pcr_field(pcr27) if first and pcr27 is not None else None
        cap = 184 - (1 + len(af) if af is not None else 0)
        take = min(cap, len(data) - at)
        if take < cap:   # stuffing in the adaptation field
            if af is None:
                pad = 184 - take
                af = b"" if pad == 1 else b"\x00" + b"\xff" * (pad - 2)
            else:
                af += b"\xff" * (cap - take)
        head = bytes([0x47, (0x40 if first else 0) | (pid >> 8), pid & 0xFF,
                      0x30 if af is not None else 0x10])
        out.append(head + (bytes([len(af)]) + af if af is not None else b"") + data[at:at + take])
        at += take
        first = False
    return out


def jitter_of(k, jitter):
    """Frame k's capture jitter, uniform in ±jitter: ts_restamp_test's Lcg(k + 1), first draw."""
    s = ((k + 1) * 0x9E3779B97F4A7C15 + 1) % (1 << 64)
    s = (s * 6364136223846793005 + 1442695040888963407) % (1 << 64)
    return (s >> 32) % 2001 * jitter // 1000 - jitter if jitter > 0 else 0


class Stream:
    """H.264-like video carrying the PCR (DTS one frame behind PTS), MPEG audio and PSI every
    100 ms, on a source clock at 2 h; 7-packet datagrams arriving 20 ms after they were sent.
    `lead_in`: that many PAT+PMT datagrams first, 100 ms apart, each its own datagram (a
    consumer that joins late misses only those). A capture under load (B-89): `jitter_v` moves
    each frame's time by up to ±that, and the frames numbered in `drop_v` are never made. A path
    whose delay moves: `delay(t)` more ns for the datagram sent at mux time t, FIFO (what waited
    arrives at once when the delay falls)."""

    def __init__(self, secs, h0=100 * S, sigma0=7200 * S, outage=None, lead_v=600 * MS,
                 lead_a=400 * MS, jump=None, pmt_sec=PMT, lead_in=0, jitter_v=0, drop_v=(),
                 delay=None):
        # jump (t, delta): the source clock steps by delta from mux time t, flagged on the PCR.
        def sigma(t):
            return sigma0 + t + (jump[1] if jump and t >= jump[0] else 0)
        items = []
        for k in range(-lead_in, int(secs * 10)):
            t = 5 * MS + k * 100 * MS
            items += [(t, 0, psi_packet(0, PAT)), (t, 1, psi_packet(PID_PMT, pmt_sec))]
        for k in range(int(secs * 25)):
            if k in drop_v:
                continue
            t = k * 40 * MS
            dts = sigma(t) + lead_v + jitter_of(k, jitter_v)
            payload = bytes((k * 7 + i) & 0xFF for i in range(4000 if k % 25 == 0 else 1200))
            data = pes(0xE0, ns90k(dts + 40 * MS), ns90k(dts), payload, bounded=False)
            flag = bool(jump) and jump[0] <= t < jump[0] + 40 * MS
            for j, p in enumerate(packetize(PID_V, data, (sigma(t) * 27 // 1000) % (300 << 33),
                                            flag)):
                items.append((t + j * 50_000, 2, p))
        for k in range(int(secs * 1000 // 24)):
            t = 2 * MS + k * 24 * MS
            data = pes(0xC0, ns90k(sigma(t) + lead_a), None, bytes([k & 0xFF]) * 300)
            for j, p in enumerate(packetize(PID_A, data)):
                items.append((t + j * 50_000, 3, p))
        items.sort(key=lambda x: (x[0], x[1]))
        if outage:
            items = [x for x in items if not outage[0] <= x[0] < outage[1]]
        cc, pk = {}, []
        for t, _, p in items:
            pid = ((p[1] & 0x1F) << 8) | p[2]
            c = cc.get(pid, 0)
            cc[pid] = (c + 1) & 15
            pk.append((t, p[:3] + bytes([(p[3] & 0xF0) | c]) + p[4:]))
        self.h0 = h0
        # The lead-in in pairs, then 7 packets a datagram; none spans the outage, whose last one
        # leaves before it.
        cut = next((i for i, (t, _) in enumerate(pk) if outage and t >= outage[1]), len(pk))
        groups = [(i, i + 2) for i in range(0, 2 * lead_in, 2)]
        for lo, hi in ((2 * lead_in, cut), (cut, len(pk))):
            groups += [(i, min(i + 7, hi)) for i in range(lo, hi, 7)]
        self.datagrams, last = [], None
        for lo, hi in groups:
            sent = pk[hi - 1][0]
            at = h0 + 20 * MS + sent + (delay(sent) if delay else 0)
            last = at if last is None else max(last, at)
            self.datagrams.append((last, b"".join(p for _, p in pk[lo:hi])))

    def mux(self, arrival):
        return arrival - self.h0 - 20 * MS


def gap_packet(pid, cc, length):
    """OQ-12's marker packet, as mrts::build_gap_packet writes it."""
    af = bytes([0x02, 8]) + max(length, 0).to_bytes(8, "big")
    return (bytes([0x47, (pid >> 8) & 0x1F, pid & 0xFF, 0x20 | (cc & 0x0F), 183]) + af
            + b"\xff" * (183 - len(af)))


def gap_length(pkt):
    return int.from_bytes(pkt[7:15], "big") if pkt[3] & 0x30 == 0x20 and pkt[5] == 0x02 else -1


def pkt_pid(pkt):
    return ((pkt[1] & 0x1F) << 8) | pkt[2]


# --- the reference ------------------------------------------------------------------------

def build_reference():
    """Make tests/restamp_ref as the plugin is built; '' when done, else make's output.
    MR_PLUGINS_DIR names a plugins tree to the Makefile too: the reference is this repo's."""
    made = subprocess.run(["make", "-s", "-C", HOUSE_DIR, "tests/restamp_ref"],
                          capture_output=True, text=True,
                          env={k: v for k, v in os.environ.items() if k != "MR_PLUGINS_DIR"})
    if made.returncode != 0 or not os.path.exists(REF):
        return made.stdout + made.stderr or "tests/restamp_ref missing"
    return ""


def reference(records, tmp, fixed=False, stats_ms=2000, base=None):
    """RestampCore over `records`: one dict per 'B' and 'E' record (restamp_ref's JSON)."""
    path = os.path.join(tmp, "ref.bin")
    with open(path, "wb") as fh:
        for r in records:
            if r[0] == "B":
                fh.write(b"B" + struct.pack("<qI", r[1], len(r[2])) + r[2])
            elif r[0] in ("O", "C"):
                fh.write(r[0].encode() + struct.pack("<q", r[1]))
            elif r[0] == "T":
                fh.write(b"T" + struct.pack("<I", len(r[1]))
                         + b"".join(struct.pack("<iq", p, ns) for p, ns in sorted(r[1].items())))
            elif r[0] == "R":
                fh.write(b"R" + struct.pack("<I", len(r[1])) + r[1].encode())
            else:
                fh.write(r[0].encode())
    argv = [REF, path, "--stats-ms", str(stats_ms)] + (["--fixed"] if fixed else [])
    argv += ["--base-time", str(base)] if base is not None else []
    out = subprocess.run(argv, capture_output=True, text=True, check=True).stdout
    return [json.loads(line) for line in out.splitlines()]


def pieces_of(line):
    """The data pieces a buffer's output splits into around its markers (possibly empty)."""
    data, frm, out = bytes.fromhex(line["out"]), 0, []
    for g in line["gaps"]:
        at = min(g["at"], len(data))
        out.append(data[frm:at])
        frm = at
    out.append(data[frm:])
    return out


def expected_items(records, ref, base=0, none=None):
    """What the element must push, per RestampCore: the data split around each marker, whose
    PTS is the gap's end on the bus convention (house - base time). Items are (kind, PTS, DTS,
    bytes); a data piece has no DTS of its own (`none`), a marker the input buffer's."""
    items, lines = [], iter(ref)
    for r in records:
        if r[0] != "B":
            if r[0] == "E":
                next(lines)
            continue
        line, pts = next(lines), r[1]
        data, frm = bytes.fromhex(line["out"]), 0
        for g in line["gaps"]:
            at = min(g["at"], len(data))
            if at > frm:
                items.append(("data", pts, none, data[frm:at]))
                frm = at
            items.append(("gap", g["end"] - base, pts,
                          gap_packet(g["pid"], g["cc"], g["end"] - g["start"])))
        if len(data) > frm:
            items.append(("data", pts, none, data[frm:]))
    return items


def items_per_buffer(records, ref):
    """Per record: the number of items the element has pushed once it has taken that record."""
    out, n, lines = [], 0, iter(ref)
    for r in records:
        if r[0] == "B":
            line = next(lines)
            n += len(line["gaps"]) + sum(1 for x in pieces_of(line) if x)
        elif r[0] == "E":
            next(lines)
        out.append(n)
    return out


def ref_events(ref):
    return [e for line in ref for e in line["events"]]


def ref_stats(ref):
    return [(line["stats"]["programs"], line["stats"]["pids"]) for line in ref if "stats" in line]


def ref_counters(ref):
    return ref[-1]["stats"]["counters"]


# --- the identity egress ------------------------------------------------------------------

def first_timing_pts(data):
    """The PTS of the buffer's first PES header with a video or audio stream id: the PES an
    identity egress stamps by (ts_timeline.cpp `timing_pes`; the fixture has no private PES)."""
    for k in range(0, len(data) - PKT + 1, PKT):
        pkt = data[k:k + PKT]
        if pkt[0] != 0x47 or not pkt[1] & 0x40 or not pkt[3] & 0x10:
            continue
        off = 4 + (1 + pkt[4] if pkt[3] & 0x20 else 0)
        h = pkt[off:off + 14]
        if len(h) < 14 or h[:3] != b"\x00\x00\x01" or not (h[3] & 0xF0 == 0xE0 or
                                                         h[3] & 0xE0 == 0xC0):
            continue
        if not h[7] & 0x80:
            continue
        f = h[9:14]
        return ((f[0] >> 1) & 7) << 30 | f[1] << 22 | (f[2] >> 1) << 15 | f[3] << 7 | f[4] >> 1
    return None


def identity_stamps(items, house_now):
    """Per item, the PTS an identity egress (ts_timeline.cpp `stamp_house`) leaves on it: a data
    buffer with a timing PES gets `house_from_mux_pts` of its PTS, one without the last stamp,
    never below it; a marker keeps its own PTS (WI-P1-7). None where the stamp is the egress's
    clock (a PES-less buffer before the first stamp), which the caller cannot know."""
    out, floor = [], None
    for kind, pts, _dts, data in items:
        if kind == "gap":
            out.append(pts)
            continue
        p = first_timing_pts(data)
        s = ts_timeline.house_from_mux_pts(p, house_now) if p is not None else floor
        if s is not None and floor is not None and s < floor:
            s = floor
        if s is not None:
            floor = s
        out.append(s)
    return out
