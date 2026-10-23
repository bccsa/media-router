#!/usr/bin/env python3
"""The reference's own suite (plan ch. 15.4 B-55): ../native/mr-bus-fanout/tests/house_rebase_test.cpp
case by case, check by check, on house_rebase.py, with the C++ suite's stream builder and the same
names in the same order. With HOUSE_REBASE_TRACE=<file> each rebase's chunks are recorded there as
the C++ suite records them, and house_rebase_parity_test.py requires the two files to be equal:
the two suites feed the same TS.

Run:  python3 house_rebase_test.py
"""
import os
import struct
import sys

import house_rebase as hr

# The PSI and PCR packet builders, mrts's own in Python (the C++ suite uses mrts's).
sys.path.append(os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "mpegts-core", "py")))
import ts_psi  # noqa: E402

PKT = hr.PKT
VID, AUD, SUB, PMT_PID = 0x100, 0x101, 0x110, 0x1000
STEP = 3600                                      # 40 ms
AFRAME = 1920                                    # one 48 kHz AAC frame
SEC = 1000000000
T0 = 5000 * SEC                                  # house now at the start
P0 = 8100000                                     # the source's first video PTS

_failures = 0
_trace = None


def check(name, cond):
    global _failures
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures += 1


class HouseRebase(hr.HouseRebase):
    """The rebase under test: with HOUSE_REBASE_TRACE set, each chunk it is given is recorded with
    its house time, the rebases numbered in construction order (the C++ suite's records)."""
    _next = 0

    def __init__(self):
        super().__init__()
        self.id = HouseRebase._next
        HouseRebase._next += 1

    def process(self, data, now_ns):
        global _trace
        path = os.environ.get("HOUSE_REBASE_TRACE")
        if path:
            if _trace is None:
                _trace = open(path, "wb")
            _trace.write(b"C" + struct.pack("<IqI", self.id, now_ns, len(data)) + bytes(data))
        return super().process(data, now_ns)


def mod33(v):
    return v % hr.PTS_WRAP


def mod_pcr(v):
    return v % hr.PCR_MODULO


def house_from_mux_pts(pts33, house_now_ns):
    """mrts::house_from_mux_pts: the house ns a mux-written PTS encodes, `pts - 1 h`."""
    raw = (pts33 - hr.MUX_CLOCK_BASE_90K) % hr.PTS_WRAP
    return hr.pts90k_to_ns(hr.unwrap_near(raw, hr.ns_to_pts90k(house_now_ns)))


def house_of(ns):
    """What a bus PTS written at house `ns` reads back as (90 kHz floor)."""
    return hr.pts90k_to_ns(hr.ns_to_pts90k(ns))


def equal(a, a0, a1, b, b0):
    """std::equal(a + a0, a + a1, b + b0)."""
    return a[a0:a1] == b[b0:b0 + (a1 - a0)]


class Ts:
    """A stream builder: one CC counter per PID, packets appended in order."""

    def __init__(self):
        self.pkts = []
        self.cc = [0] * 8192
        self.spill = b""

    def add(self, pid, pusi, afc):
        p = bytearray(b"\xaa" * PKT)
        p[0] = 0x47
        p[1] = (0x40 if pusi else 0) | ((pid >> 8) & 0x1F)
        p[2] = pid & 0xFF
        if afc & 1:
            c = self.cc[pid] & 0x0F
            self.cc[pid] = (self.cc[pid] + 1) & 0xFF
        else:
            c = (self.cc[pid] - 1) & 0x0F
        p[3] = (afc << 4) | c
        self.pkts.append(p)
        return p

    def pes(self, pid, sid, pts, dts=-1, pcr=-1, af=-1):
        """A PES start; `af` adaptation bytes (flags included) before it, with a PCR when pcr >= 0."""
        if af < 0:
            af = 7 if pcr >= 0 else 0
        p = self.add(pid, True, 3 if af > 0 else 1)
        off = 4
        if af > 0:
            p[4] = af
            p[5] = 0x10 if pcr >= 0 else 0x00
            p[6:6 + af - 1] = b"\xff" * (af - 1)
            if pcr >= 0:
                hr.write_pcr(p, pcr)
            off = 5 + af
        e = bytearray(19)
        e[0:10] = bytes([0, 0, 1, sid, 0, 0, 0x80, 0xC0 if dts >= 0 else 0x80,
                         10 if dts >= 0 else 5, 0x30 if dts >= 0 else 0x20])
        hr.write_pes_ts_field(e, 9, pts)
        if dts >= 0:
            e[14] = 0x10
            hr.write_pes_ts_field(e, 14, dts)
        full = 19 if dts >= 0 else 14
        n = min(full, PKT - off)
        p[off:off + n] = e[:n]
        if n < full:
            self.spill = bytes(e[n:full])

    def cont(self, pid):
        """The next payload packet of `pid`; it starts with what a split header left over."""
        p = self.add(pid, False, 1)
        p[4:4 + len(self.spill)] = self.spill
        self.spill = b""

    def pcr(self, pid, pcr27):
        p = self.add(pid, False, 2)
        p[:] = ts_psi.build_pcr_packet(pid, pcr27, p[3] & 0x0F)

    def af_only(self, pid):                      # adaptation only, no PCR
        p = self.add(pid, False, 2)
        p[4] = 183
        p[5] = 0x00
        p[6:] = b"\xff" * (PKT - 6)

    def null(self):
        self.add(hr.PID_NULL, False, 1)

    def psi(self, pcr_pid):
        self.pkts.append(bytearray(ts_psi.build_pat(1, {1: PMT_PID}, self.cc[0] & 0x0F, 0)))
        self.cc[0] = (self.cc[0] + 1) & 0xFF
        self.pkts.append(bytearray(ts_psi.build_pmt(
            PMT_PID, 1, pcr_pid, [(VID, ts_psi.STREAM_TYPE_AVC), (AUD, ts_psi.STREAM_TYPE_AAC),
                                  (SUB, ts_psi.STREAM_TYPE_PRIVATE_PES)],
            self.cc[PMT_PID] & 0x0F, 0)))
        self.cc[PMT_PID] = (self.cc[PMT_PID] + 1) & 0xFF

    def take(self):
        out = b"".join(self.pkts)
        self.pkts = []
        return out


class Seen:
    __slots__ = ("pid", "pusi", "di", "pts", "dts", "pcr")

    def __init__(self):
        self.pid = -1
        self.pusi = self.di = False
        self.pts = self.dts = self.pcr = -1


def scan(out):
    s = []
    for off in range(0, len(out) - PKT + 1, PKT):
        copy = bytearray(out[off:off + PKT])
        e = Seen()
        v = hr.parse_packet(copy)
        if v is None:
            s.append(e)
            continue
        e.pid, e.pusi, e.di = v.pid, v.pusi, v.af_discontinuity
        if v.af_pcr:
            e.pcr = hr.read_pcr(copy)
        if v.pusi and v.payload_off < PKT:
            h = hr.parse_pes_header(copy, v.payload_off, PKT - v.payload_off)
            if h is not None and h.complete:
                e.pts, e.dts = h.pts, h.dts
        s.append(e)
    return s


def run(r, inp, now):
    """One chunk through the rebase."""
    return r.process(inp, now)


def same_but_time(a, b):
    """Every byte but the PTS/DTS fields and the PCR equal (the DI flag compared apart)."""
    if len(a) != len(b):
        return False
    for off in range(0, len(a) - PKT + 1, PKT):
        x, y = bytearray(a[off:off + PKT]), bytearray(b[off:off + PKT])
        for z in (x, y):
            v = hr.parse_packet(z)
            if v.af_len >= 1:
                z[5] &= 0x7F
            if v.af_pcr:
                z[6:12] = bytes(6)
            if v.pusi and v.payload_off < PKT:
                h = hr.parse_pes_header(z, v.payload_off, PKT - v.payload_off)
                if h is not None and h.complete:
                    if h.pts_off >= 0:
                        z[v.payload_off + h.pts_off:v.payload_off + h.pts_off + 5] = bytes(5)
                    if h.dts_off >= 0:
                        z[v.payload_off + h.dts_off:v.payload_off + h.dts_off + 5] = bytes(5)
        if x != y:
            return False
    return True


def av_rung(ts, vpts, apts, lead=2 * STEP):
    """An A/V rung: video (PCR in its AF, B-frame order: DTS 2 frames before PTS), one audio PES."""
    ts.pes(VID, 0xE0, vpts, mod33(vpts - lead), mod_pcr((vpts - lead - 9000) * 300))
    ts.pes(AUD, 0xC0, apts)
    ts.null()


def av2_rung(ts, vpts, apts, ahead=0):
    """The same with two audio PES half a frame apart, `ahead` of them muxed before the video."""
    for k in range(3):
        if k == ahead:
            ts.pes(VID, 0xE0, vpts, mod33(vpts - 2 * STEP), mod_pcr((vpts - 2 * STEP - 9000) * 300))
        if k < 2:
            ts.pes(AUD, 0xC0, mod33(apts + k * (STEP // 2)))


class Tracks:
    """What left, in order: the video and audio PES PTS, the video PID's PCRs and their flag."""

    def __init__(self):
        self.v, self.a, self.pcr, self.di = [], [], [], []

    def add(self, out):
        for e in scan(out):
            if e.pid == VID and e.pts >= 0:
                self.v.append(e.pts)
            if e.pid == AUD and e.pts >= 0:
                self.a.append(e.pts)
            if e.pid == VID and e.pcr >= 0:
                self.pcr.append(e.pcr)
                self.di.append(e.di)


def _pes_pts(pkt):
    if pkt[0] != 0x47 or not (pkt[1] & 0x40) or not (pkt[3] & 0x10):
        return -1
    off = hr.payload_offset(pkt)
    if off >= PKT:
        return -1
    h = hr.parse_pes_header(pkt, off, PKT - off)
    return h.pts if h is not None else -1


class IdentityStamp:
    """mrts::IdentityStamp of one stream: the house time of a buffer's first timing PES (a video
    or audio stream_id, or on the first PCR carrier), PES - 1 h; a buffer of other PES at house
    now, one without PES the last stamp; monotone."""

    def __init__(self):
        self.timing_pid = -1
        self.stamped = False
        self.floor = 0

    def stamp(self, data, house_now):
        off = 0
        while self.timing_pid < 0 and off + PKT <= len(data):
            pkt = data[off:off + PKT]
            if pkt[0] == 0x47 and hr.read_pcr(pkt) >= 0:
                self.timing_pid = ((pkt[1] & 0x1F) << 8) | pkt[2]
            off += PKT
        any_pes = timing = False
        s = 0
        for off in range(0, len(data) - PKT + 1, PKT):
            pkt = data[off:off + PKT]
            pts = _pes_pts(pkt)
            if pts < 0:
                continue
            any_pes = True
            sid = pkt[hr.payload_offset(pkt) + 3]
            pid = ((pkt[1] & 0x1F) << 8) | pkt[2]
            if not ((sid & 0xF0) == 0xE0 or (sid & 0xE0) == 0xC0 or pid == self.timing_pid):
                continue
            timing = True
            s = house_from_mux_pts(pts, house_now)
            break
        if not timing:
            s = house_now if any_pes or not self.stamped else self.floor
        s = max(s, self.floor)
        self.floor, self.stamped = s, True
        return s


def test_anchor():
    r = HouseRebase()
    ts = Ts()
    ts.psi(VID)
    av_rung(ts, P0, P0 + 100)
    inp = ts.take()
    out = run(r, inp, T0)
    s = scan(out)
    check("anchor: every packet out, in order", len(out) == len(inp) and len(s) == 5)
    check("anchor: the first timing PES's PTS lands at house now",
          s[2].pid == VID and house_from_mux_pts(s[2].pts, T0) == house_of(T0))
    check("anchor: DTS keeps its distance", mod33(s[2].pts - s[2].dts) == 2 * STEP)
    shift = mod33(s[2].pts - P0)
    check("anchor: PCR moved by the same shift, 27 MHz",
          s[2].pcr == mod_pcr((P0 - 2 * STEP - 9000) * 300 + shift * 300))
    check("anchor: audio moved by the same shift", s[3].pts == mod33(P0 + 100 + shift))
    check("anchor: no discontinuity flagged", not s[2].di)
    check("anchor: PSI and stuffing untouched",
          equal(inp, 0, 2 * PKT, out, 0) and equal(inp, len(inp) - PKT, len(inp), out, len(out) - PKT))
    st = r.stats()
    check("anchor: stats", st.anchored and st.reanchors == 0 and st.dropped == 0
          and mod33(st.shift_90k) == shift)
    ident = IdentityStamp()
    check("anchor: the identity stamp of the output is house now", ident.stamp(out, T0) == house_of(T0))


def test_one_shift():
    r = HouseRebase()
    ts = Ts()
    ins, outs = [], []
    now = T0
    for i in range(60):
        if i % 10 == 0:
            ts.psi(VID)
        av_rung(ts, P0 + i * STEP, P0 + 300 + i * AFRAME)
        ins.append(ts.take())
        outs.append(run(r, ins[-1], now))
        now += (i * 7919) % 50 * 1000000         # irregular arrival, ahead or behind
    shift = mod33(scan(outs[0])[2].pts - P0)
    same = pts_ok = dts_ok = pcr_ok = True
    di = False
    pes = pcrs = 0
    for k in range(len(ins)):
        a, b = scan(ins[k]), scan(outs[k])
        same = same and same_but_time(ins[k], outs[k])
        for j in range(min(len(a), len(b))):
            if a[j].pts >= 0:
                pes += 1
                pts_ok = pts_ok and b[j].pts == mod33(a[j].pts + shift)
            if a[j].dts >= 0:
                dts_ok = dts_ok and b[j].dts == mod33(a[j].dts + shift)
            if a[j].pcr >= 0:
                pcrs += 1
                pcr_ok = pcr_ok and b[j].pcr == mod_pcr(a[j].pcr + shift * 300)
            di = di or b[j].di
    check("one shift: 60 chunks, arrival jitter, bytes equal but the time fields", same)
    check("one shift: every PTS of both PIDs moved by one constant", pts_ok and pes == 120)
    check("one shift: every DTS by the same", dts_ok)
    check("one shift: every PCR by 300 times it", pcr_ok and pcrs == 60)
    check("one shift: no PCR flagged, no re-anchor", not di and r.stats().reanchors == 0)


def test_wrap():
    r = HouseRebase()
    ts = Ts()
    first = hr.PTS_WRAP - 3 * STEP
    pts = []
    for i in range(8):
        av_rung(ts, mod33(first + i * STEP), mod33(first + 100 + i * STEP))
        for e in scan(run(r, ts.take(), T0 + i * 40 * 1000000)):
            if e.pid == VID and e.pts >= 0:
                pts.append(e.pts)
    steps = len(pts) == 8
    for i in range(1, len(pts)):
        steps = steps and mod33(pts[i] - pts[i - 1]) == STEP
    check("wrap: a legal 2^33 wrap is one continuous timeline", steps and r.stats().reanchors == 0)


def test_loop_reanchor():
    """The source loops back to near zero, delivered ahead of house time."""
    r = HouseRebase()
    ts = Ts()
    seen, stamps = [], []
    ident = IdentityStamp()
    for i in range(16):
        src = P0 + i * STEP if i < 6 else 4500 + (i - 6) * STEP
        av_rung(ts, src, src + 100)
        now = T0 + i * 5 * 1000000                # arrives faster than 40 ms a rung
        out = run(r, ts.take(), now)
        stamps.append(ident.stamp(out, now))
        seen.extend(scan(out))
    steps = True
    for i in range(1, len(stamps)):
        steps = steps and stamps[i] - stamps[i - 1] == 40000000
    check("loop: stamps keep their 40 ms step across the loop", steps)
    vpts, apts, pcr, di = [], [], [], []
    for e in seen:
        if e.pid == VID and e.pts >= 0:
            vpts.append(e.pts)
        if e.pid == AUD and e.pts >= 0:
            apts.append(e.pts)
        if e.pcr >= 0:
            pcr.append(e.pcr)
            di.append(e.di)
    cont = len(vpts) == 16 and len(apts) == 16
    for i in range(1, len(vpts)):
        cont = cont and mod33(vpts[i] - vpts[i - 1]) == STEP and mod33(apts[i] - apts[i - 1]) == STEP
    check("loop: video and audio continue one spacing on", cont)
    pcr_steps = len(pcr) == 16
    for i in range(1, len(pcr)):
        pcr_steps = pcr_steps and mod_pcr(pcr[i] - pcr[i - 1]) == STEP * 300
    check("loop: the PCR continues too", pcr_steps)
    check("loop: the first PCR after the loop is flagged, no other", di.count(True) == 1 and di[6])
    check("loop: one re-anchor", r.stats().reanchors == 1)


def test_jump_after_pause_lands_at_now():
    """A jump after a pause: house time went on, so the new timeline starts at house now."""
    r = HouseRebase()
    ts = Ts()
    for i in range(4):
        av_rung(ts, P0 + i * STEP, P0 + 100 + i * STEP, 0)
        run(r, ts.take(), T0 + i * 1000000)
    later = T0 + 10 * SEC
    av_rung(ts, P0 + 90000 * 600, P0 + 100 + 90000 * 600, 0)
    s = scan(run(r, ts.take(), later))
    check("pause: the jump after a pause lands at house now, not late",
          house_from_mux_pts(s[0].pts, later) == house_of(later))
    check("pause: audio keeps its offset", s[1].pts == mod33(s[0].pts + 100))
    check("pause: one re-anchor, the next PCR flagged", r.stats().reanchors == 1 and s[0].di)


def test_stall_without_jump():
    """No source jump, only late delivery: no re-anchor, the content stays continuous (late)."""
    r = HouseRebase()
    ts = Ts()
    av_rung(ts, P0, P0 + 100)
    first = scan(run(r, ts.take(), T0))[0].pts
    av_rung(ts, P0 + STEP, P0 + 100 + STEP)
    nxt = scan(run(r, ts.take(), T0 + 5 * SEC))[0].pts
    check("stall: continuous PES after a 5 s stall are not re-anchored",
          mod33(nxt - first) == STEP and r.stats().reanchors == 0)


def test_gap_on_audio():
    """A gap on a non-reference PID is content: no re-anchor, the gap is kept."""
    r = HouseRebase()
    ts = Ts()
    ts.psi(VID)
    vfirst = a5 = a6 = -1
    for i in range(10):
        apts = P0 + 100 + i * STEP + (6 * 90000 if i >= 6 else 0)
        av_rung(ts, P0 + i * STEP, apts)
        for e in scan(run(r, ts.take(), T0 + i * 40 * 1000000)):
            if e.pid == VID and e.pts >= 0 and vfirst < 0:
                vfirst = e.pts
            if e.pid == AUD and i == 5:
                a5 = e.pts
            if e.pid == AUD and i == 6:
                a6 = e.pts
    check("audio gap: no re-anchor", r.stats().reanchors == 0)
    check("audio gap: the 6 s gap stays in the audio", mod33(a6 - a5) == STEP + 6 * 90000)


def test_reference_prefers_video():
    """Without PSI the reference is video over audio, so an audio-only jump is no new timeline."""
    r = HouseRebase()
    ts = Ts()
    ts.pes(AUD, 0xC0, P0)                        # audio anchors
    ts.pes(VID, 0xE0, P0 + 200)
    run(r, ts.take(), T0)
    ts.pes(AUD, 0xC0, P0 + AFRAME + 90000 * 600)
    ts.pes(VID, 0xE0, P0 + 200 + STEP)
    run(r, ts.take(), T0 + 40000000)
    check("reference: an audio-only jump does not re-anchor while video runs",
          r.stats().reanchors == 0)
    ts.pes(VID, 0xE0, 4500)
    s = scan(run(r, ts.take(), T0 + 80000000))
    check("reference: a video jump does", r.stats().reanchors == 1)
    ts.pes(AUD, 0xC0, 4500 - 200 + AFRAME)
    ts.pes(VID, 0xE0, 4500 + STEP)
    t = scan(run(r, ts.take(), T0 + 120000000))
    check("reference: both continue after it",
          mod33(t[1].pts - s[0].pts) == STEP and r.stats().reanchors == 1)


def test_reference_pcr_pid():
    """The PMT's PCR PID ranks above video."""
    r = HouseRebase()
    ts = Ts()
    ts.psi(AUD)                                  # audio carries the PCR
    ts.pes(VID, 0xE0, P0, -1, mod_pcr((P0 - 9000) * 300))   # a PCR off the PCR PID first
    ts.pes(AUD, 0xC0, P0 + 100, -1, mod_pcr((P0 - 9000) * 300))
    run(r, ts.take(), T0)
    ts.pes(VID, 0xE0, P0 + STEP + 90000 * 600)
    ts.pes(AUD, 0xC0, P0 + 100 + AFRAME, -1, mod_pcr((P0 + AFRAME - 9000) * 300))
    run(r, ts.take(), T0 + 40000000)
    check("reference: a video-only jump does not re-anchor when audio is the PCR PID",
          r.stats().reanchors == 0)


def test_stale_reference():
    """A reference silent for REF_STALE_NS gives way: the jump on the PID that remains re-anchors."""
    r = HouseRebase()
    ts = Ts()
    av_rung(ts, P0, P0 + 100)
    run(r, ts.take(), T0)
    now, last = T0, -1
    for i in range(1, 61):                       # video gone, audio on for 2.4 s
        now += 40000000
        ts.pes(AUD, 0xC0, P0 + 100 + i * STEP)
        last = scan(run(r, ts.take(), now))[0].pts
    ts.pes(AUD, 0xC0, 4500)
    s = scan(run(r, ts.take(), now + 40000000))
    check("stale reference: audio took over and its jump re-anchors", r.stats().reanchors == 1)
    check("stale reference: and lands one spacing on", mod33(s[0].pts - last) == STEP)


def test_before_anchor():
    r = HouseRebase()
    ts = Ts()
    ts.psi(VID)
    ts.pes(SUB, 0xBD, P0 + 90000)                # private, timed: cannot be placed yet
    ts.cont(SUB)
    ts.pcr(VID, mod_pcr((P0 - 9000) * 300))      # a PCR with no shift to move it by
    ts.af_only(VID)                              # no time: passes
    p = ts.add(0x111, True, 1)                   # a PES without PTS (padding): passes
    p[4:10] = bytes([0, 0, 1, 0xBE, 0, 20])
    q = ts.add(0x112, True, 1)                   # a section on an ES PID: passes
    q[4] = 0
    q[5] = 0xFC
    before = ts.take()
    ts.pes(VID, 0xE0, P0, P0 - STEP, mod_pcr((P0 - STEP - 9000) * 300))   # the anchor
    ts.cont(SUB)                                 # still the PES dropped before the anchor
    ts.pes(SUB, 0xBD, P0 + 2 * 90000)            # a new one: placed
    ts.cont(SUB)                                 # with its continuation
    after = ts.take()
    inp = before + after
    out = run(r, inp, T0)
    s = scan(out)
    pids = [e.pid for e in s]
    want = [0, PMT_PID, VID, 0x111, 0x112, VID, SUB, SUB]
    check("before the anchor: only what carries no time passes", pids == want)
    check("before the anchor: 4 packets dropped", r.stats().dropped == 4)
    shift = mod33(s[5].pts - P0)
    check("before the anchor: the private PES after it is placed",
          s[6].pts == mod33(P0 + 2 * 90000 + shift))
    check("before the anchor: the AF-only packet is byte-identical",
          equal(out, 2 * PKT, 3 * PKT, inp, 5 * PKT))


def test_split_header():
    """A PES header split over two packets (an AF leaving 13 bytes): held to its next payload
    packet, both rewritten, and the AF-only PCR packet behind it kept in order."""
    r = HouseRebase()
    ts = Ts()
    av_rung(ts, P0, P0 + 100)
    run(r, ts.take(), T0)
    t2 = Ts()
    av_rung(t2, P0 + STEP, P0 + 100 + STEP)
    shift = mod33(scan(run(r, t2.take(), T0 + 40000000))[0].pts - (P0 + STEP))
    ts.pes(VID, 0xE0, P0 + 2 * STEP, P0, -1, 170)   # 13 bytes of PES header here
    ts.pes(AUD, 0xC0, P0 + 100 + 2 * STEP)
    c1 = ts.take()
    ts.pcr(VID, mod_pcr((P0 + STEP - 9000) * 300))
    ts.cont(VID)
    c2 = ts.take()
    o1 = run(r, c1, T0 + 80000000)
    o2 = run(r, c2, T0 + 81000000)
    s1, s2 = scan(o1), scan(o2)
    check("split: the held header leaves with its next packet",
          len(s1) == 1 and s1[0].pid == AUD and len(s2) == 3 and s2[0].pid == VID and s2[0].pusi
          and s2[1].pcr >= 0 and s2[2].pid == VID and not s2[2].pusi)
    # Join the header back across the two packets and read it.
    hdr = bytearray(o2[5 + 170:PKT]) + o2[2 * PKT + 4:2 * PKT + 4 + 6]
    h = hr.parse_pes_header(hdr, 0, len(hdr))
    ok = h is not None and h.complete
    check("split: PTS and DTS rewritten across both packets",
          ok and h.pts == mod33(P0 + 2 * STEP + shift) and h.dts == mod33(P0 + shift))
    check("split: the PCR behind it rebased",
          s2[1].pcr == mod_pcr((P0 + STEP - 9000) * 300 + shift * 300))
    check("split: nothing dropped", r.stats().dropped == 0)


def test_broken_split_header():
    """A held header whose next packet comes after a CC gap cannot be joined: both go."""
    r = HouseRebase()
    ts = Ts()
    av_rung(ts, P0, P0 + 100)
    run(r, ts.take(), T0)
    ts.pes(VID, 0xE0, P0 + STEP, P0 - STEP, -1, 170)
    ts.cc[VID] = (ts.cc[VID] + 1) & 0xFF         # one packet lost
    ts.cont(VID)
    ts.pes(VID, 0xE0, P0 + 2 * STEP)
    ts.cont(VID)
    s = scan(run(r, ts.take(), T0 + 40000000))
    check("broken split: the held packet and its continuation dropped, the next PES passes",
          len(s) == 2 and s[0].pts >= 0 and not s[1].pusi and r.stats().dropped == 2)


def test_damaged_dts_and_untimed():
    r = HouseRebase()
    ts = Ts()
    av_rung(ts, P0, P0 + 100)
    shift = mod33(scan(run(r, ts.take(), T0))[0].pts - P0)
    ts.pes(VID, 0xE0, P0 + STEP, P0 + STEP - 10 * 90000)   # DTS 10 s off its PTS
    p = ts.add(0x111, True, 1)                   # PES without PTS after the anchor
    p[4:10] = bytes([0, 0, 1, 0xBE, 0, 20])
    q = ts.add(AUD, True, 3)                     # scrambled, with a PCR in its clear AF
    q[3] |= 0x80
    q[4] = 7
    q[5] = 0x10
    hr.write_pcr(q, 123456789)
    q[12:26] = bytes([0, 0, 1, 0xC0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1])   # reads as a PES
    inp = ts.take()
    out = run(r, inp, T0 + 40000000)
    s = scan(out)
    check("damaged DTS: written at its PTS",
          s[0].dts == s[0].pts and s[0].pts == mod33(P0 + STEP + shift))
    check("untimed PES: untouched", equal(inp, PKT, 2 * PKT, out, PKT))
    check("scrambled: payload untouched, PCR rebased",
          equal(inp, 2 * PKT + 12, len(inp), out, 2 * PKT + 12)
          and s[2].pcr == mod_pcr(123456789 + shift * 300))


def test_chunking():
    """The rebase does not depend on how the bytes are cut, and drops garbage."""
    ts = Ts()
    ts.psi(VID)
    for i in range(30):
        av_rung(ts, P0 + i * STEP, P0 + 100 + i * STEP)
        if i == 7:
            ts.pes(VID, 0xE0, P0 + i * STEP + STEP // 2, -1, -1, 170)
            ts.cont(VID)
    stream = ts.take()
    a = HouseRebase()
    whole = run(a, stream, T0)
    junk = stream[:40 * PKT] + bytes([1, 2, 3, 4, 5, 6, 7]) + stream[40 * PKT:]
    b = HouseRebase()
    cut = bytearray()
    off, n = 0, 1
    while off < len(junk):
        k = min(n, len(junk) - off)
        cut += b.process(junk[off:off + k], T0)
        off += k
        n = n * 7 % 1013 + 1
    check("chunking: any cut, garbage left out, the same bytes",
          cut == whole and len(cut) == len(stream))
    check("chunking: the garbage counted",
          b.stats().desync_bytes == 7 and a.stats().desync_bytes == 0)


def test_duplicate():
    """A duplicate packet (ISO 13818-1 2.4.3.3) is rewritten like its first copy."""
    r = HouseRebase()
    ts = Ts()
    av_rung(ts, P0, P0 + 100)
    inp = ts.take()
    inp = inp[:PKT] + inp[:PKT] + inp[PKT:]
    out = run(r, inp, T0)
    check("duplicate: both copies identical, no re-anchor",
          equal(out, 0, PKT, out, PKT) and r.stats().reanchors == 0)


def test_private_on_pcr_pid():
    """A private PES on the PCR PID (302M-style 0xBD) is a timing PES: it anchors."""
    r = HouseRebase()
    ts = Ts()
    ts.psi(SUB)
    ts.pes(SUB, 0xBD, P0, -1, mod_pcr((P0 - 9000) * 300))
    s = scan(run(r, ts.take(), T0))
    check("PCR PID: its private PES anchors at house now",
          len(s) == 3 and house_from_mux_pts(s[2].pts, T0) == house_of(T0) and r.stats().dropped == 0)


def test_pause_with_reorder():
    """After a pause the jumped PTS lands at house now, whatever its reorder delay."""
    r = HouseRebase()
    ts = Ts()
    av_rung(ts, P0, P0 + 100)
    run(r, ts.take(), T0)
    later = T0 + 10 * SEC
    av_rung(ts, P0 + 90000 * 600, P0 + 100 + 90000 * 600)   # DTS two frames before
    s = scan(run(r, ts.take(), later))
    check("pause: the PTS lands at house now, its DTS two frames before",
          house_from_mux_pts(s[0].pts, later) == house_of(later)
          and mod33(s[0].pts - s[0].dts) == 2 * STEP)


def test_jump_before_spacing():
    """A jump on the reference's second PES, before any spacing: one tick on, never back."""
    r = HouseRebase()
    ts = Ts()
    ts.pes(VID, 0xE0, P0)
    first = scan(run(r, ts.take(), T0))[0].pts
    ts.pes(VID, 0xE0, 4500)                      # at the same house time
    nxt = scan(run(r, ts.take(), T0))[0].pts
    check("no spacing yet: the jump lands one tick on",
          mod33(nxt - first) == 1 and r.stats().reanchors == 1)


def test_flag_on_pcr_pid_only():
    """The flag goes on the PCR PID's next PCR, not on a PCR elsewhere."""
    r = HouseRebase()
    ts = Ts()
    ts.psi(VID)
    av_rung(ts, P0, P0 + 100)
    ts.pcr(AUD, mod_pcr((P0 - 9000) * 300))      # the audio carries a PCR too
    run(r, ts.take(), T0)
    ts.pes(VID, 0xE0, 4500)                      # re-anchors; no PCR in its packet
    ts.pes(AUD, 0xC0, 4600, -1, mod_pcr(4600 * 300))
    ts.pcr(VID, mod_pcr((4500 - 9000) * 300))
    s = scan(run(r, ts.take(), T0 + 40000000))
    check("flag: the audio PID's moved PCR is not flagged, the PCR PID's next is",
          r.stats().reanchors == 1 and s[1].pcr >= 0 and not s[1].di and s[2].pcr >= 0 and s[2].di)


def test_takeover_after_reanchor():
    """Jumps are judged on the bus: a PID taking over after another re-anchored is continuous."""
    r = HouseRebase()
    ts = Ts()
    av_rung(ts, P0, P0 + 100)
    a0 = scan(run(r, ts.take(), T0))[1].pts
    J = 90000 * 600
    ts.pes(VID, 0xE0, P0 + STEP + J, P0 - STEP + J)   # re-anchors; the last video PES
    run(r, ts.take(), T0 + 40000000)
    ts.pes(AUD, 0xC0, P0 + 100 + STEP + J)       # audio, 3 s later: takes over the reference
    s = scan(run(r, ts.take(), T0 + 3 * SEC))
    check("takeover: continuous on the bus, so no second re-anchor",
          r.stats().reanchors == 1 and mod33(s[0].pts - a0) == STEP)


def test_bframes_reanchor_on_dts():
    """A B-frame stream re-anchors on its decode order: DTS continues one frame on."""
    r = HouseRebase()
    ts = Ts()
    # Decode order I P B B ...: DTS n frames, PTS of display frame order[n], 2 frames later.
    order = [0, 3, 1, 2, 6, 4, 5, 9, 7, 8]
    dts = []
    for i in range(20):
        base = P0 if i < 10 else 4500 - 10 * STEP
        n = i % 10 + (0 if i < 10 else 10)
        pts = base + (order[i % 10] + (n - i % 10) + 2) * STEP
        ts.pes(VID, 0xE0, mod33(pts), mod33(base + n * STEP))
        for e in scan(run(r, ts.take(), T0 + i * 5000000)):
            if e.dts >= 0:
                dts.append(e.dts)
    steps = len(dts) == 20
    for i in range(1, len(dts)):
        steps = steps and mod33(dts[i] - dts[i - 1]) == STEP
    check("B-frames: DTS continues one frame on across the loop", steps and r.stats().reanchors == 1)


def test_duplicate_of_held_header():
    """A duplicate of a held split header (ISO 13818-1 2.4.3.3) goes alone; the first joins."""
    r = HouseRebase()
    ts = Ts()
    av_rung(ts, P0, P0 + 100)
    shift = mod33(scan(run(r, ts.take(), T0))[0].pts - P0)
    ts.pes(VID, 0xE0, P0 + STEP, -1, -1, 170)
    ts.pkts.append(bytearray(ts.pkts[-1]))
    ts.cont(VID)
    out = run(r, ts.take(), T0 + 40000000)
    hdr = bytearray(out[5 + 170:PKT]) + out[PKT + 4:PKT + 5]
    h = hr.parse_pes_header(hdr, 0, len(hdr))
    check("held duplicate: dropped alone, the header joins its continuation",
          len(out) == 2 * PKT and r.stats().dropped == 1 and h is not None and h.complete
          and h.pts == mod33(P0 + STEP + shift))


def test_threshold():
    """The threshold: a step of more than 1 s past one spacing re-anchors, one below it is content."""
    r = HouseRebase()
    ts = Ts()
    for i in range(3):
        ts.pes(VID, 0xE0, P0 + i * STEP)
        run(r, ts.take(), T0 + i * 40000000)
    ts.pes(VID, 0xE0, P0 + 3 * STEP + 81000)     # a 0.9 s hole
    run(r, ts.take(), T0 + 120000000)
    check("threshold: 0.9 s past one spacing is a hole in the content", r.stats().reanchors == 0)
    ts.pes(VID, 0xE0, P0 + 4 * STEP + 81000 + 99000)   # 1.1 s
    run(r, ts.take(), T0 + 160000000)
    check("threshold: 1.1 s past it re-anchors", r.stats().reanchors == 1)


def test_si_untouched():
    """SI and stuffing carry no time, even when their bytes read as a PES."""
    r = HouseRebase()
    ts = Ts()
    for pid in (hr.PID_NULL, 0x11):
        p = ts.add(pid, True, 1)
        p[4:18] = bytes([0, 0, 1, 0xE0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1])
    inp = ts.take()
    out = run(r, inp, T0)
    check("SI and stuffing: untouched, no anchor", out == inp and not r.stats().anchored)


def test_repeated_jumps():
    """Jumps never become the spacing: three discontinuities in a row each land one frame on."""
    r = HouseRebase()
    ts = Ts()
    out = []
    src = [P0, P0 + STEP, P0 + 2 * STEP, P0 + 2 * STEP + 900000, P0 + 2 * STEP + 1800000,
           P0 + 2 * STEP + 2700000]
    for i in range(6):
        ts.pes(VID, 0xE0, src[i])
        out.append(scan(run(r, ts.take(), T0 + i * 1000000))[0].pts)
    steps = True
    for i in range(1, 6):
        steps = steps and mod33(out[i] - out[i - 1]) == STEP
    check("repeated jumps: each lands one frame on", steps and r.stats().reanchors == 3)


def test_held_af_bounded():
    """What waits behind a held header is bounded: past MAX_HELD_AF the PCR packets go on."""
    r = HouseRebase()
    ts = Ts()
    av_rung(ts, P0, P0 + 100)
    run(r, ts.take(), T0)
    ts.pes(VID, 0xE0, P0 + STEP, -1, -1, 170)
    for i in range(20):
        ts.pcr(VID, mod_pcr((P0 + i * 90) * 300))
    s = scan(run(r, ts.take(), T0 + 40000000))
    check("held: past 16 waiting packets the PCR packets go on", len(s) == 4)
    ts.cont(VID)
    t = scan(run(r, ts.take(), T0 + 41000000))
    check("held: the header, 16 PCR packets, its continuation", len(t) == 18 and t[0].pusi)


def test_inline_audio_stays():
    """hls-pipe's inline audio continues across a discontinuity while its video jumps: after the
    video re-anchors, the audio stays on its own timeline (backward jump, video first)."""
    r = HouseRebase()
    ts = Ts()
    ts.psi(VID)
    v, a = [], []
    for i in range(12):
        vsrc = P0 + i * STEP if i < 6 else 4500 + (i - 6) * STEP
        av_rung(ts, vsrc, P0 + 100 + i * STEP)   # the audio never jumps
        for e in scan(run(r, ts.take(), T0 + i * 5000000)):
            if e.pid == VID and e.pts >= 0:
                v.append(e.pts)
            if e.pid == AUD and e.pts >= 0:
                a.append(e.pts)
    steps = len(v) == 12 and len(a) == 12
    for i in range(1, min(len(v), len(a))):
        steps = steps and mod33(v[i] - v[i - 1]) == STEP and mod33(a[i] - a[i - 1]) == STEP
    check("inline audio: video re-anchors, the audio keeps its place, both continue",
          steps and mod33(a[11] - v[11]) == 100)
    check("inline audio: one re-anchor, one PID kept", r.stats().reanchors == 1 and r.stats().kept == 1)
    # The video stops; the kept audio runs on in real time and takes over, then jumps.
    last = a[11]
    on = True
    for i in range(12, 70):
        ts.pes(AUD, 0xC0, P0 + 100 + i * STEP)
        t = scan(run(r, ts.take(), T0 + 55000000 + (i - 11) * 40000000))[0].pts
        on = on and mod33(t - last) == STEP
        last = t
    ts.pes(AUD, 0xC0, P0 + 100 + 70 * STEP + 90000 * 600)
    t = scan(run(r, ts.take(), T0 + 55000000 + 59 * 40000000))[0].pts
    check("inline audio: taking over keeps it in place, its own jump lands one spacing on",
          on and mod33(t - last) == STEP and r.stats().reanchors == 2)


def test_inline_audio_stays_forward():
    """The same forward (a live skip): muxed by DTS, the continuous audio comes first."""
    r = HouseRebase()
    ts = Ts()
    ts.psi(VID)
    v, a = [], []
    J = 90000 * 600
    for i in range(12):
        asrc = P0 + 100 + i * STEP
        if i < 6:
            av_rung(ts, P0 + i * STEP, asrc)
        else:
            ts.pes(AUD, 0xC0, asrc)
            ts.pes(VID, 0xE0, P0 + i * STEP + J, P0 + (i - 2) * STEP + J,
                   mod_pcr((P0 + (i - 2) * STEP + J - 9000) * 300))
        for e in scan(run(r, ts.take(), T0 + i * 5000000)):
            if e.pid == VID and e.pts >= 0:
                v.append(e.pts)
            if e.pid == AUD and e.pts >= 0:
                a.append(e.pts)
    steps = len(v) == 12 and len(a) == 12
    for i in range(1, min(len(v), len(a))):
        steps = steps and mod33(v[i] - v[i - 1]) == STEP and mod33(a[i] - a[i - 1]) == STEP
    check("inline audio, forward: both continue",
          steps and r.stats().reanchors == 1 and r.stats().kept == 1)


def test_both_jump_audio_first():
    """A passthrough where both jump but the audio's new PES comes first: that one lands on the
    old shift (the edge), then the audio follows the program again; nothing is kept apart."""
    r = HouseRebase()
    ts = Ts()
    ts.psi(VID)
    a = []
    J = 90000 * 600
    for i in range(10):
        off = 0 if i < 5 else J
        if i < 5:
            av_rung(ts, P0 + i * STEP, P0 + 100 + i * STEP)
        else:
            ts.pes(AUD, 0xC0, P0 + 100 + i * STEP + off)
            ts.pes(VID, 0xE0, P0 + i * STEP + off, P0 + (i - 2) * STEP + off,
                   mod_pcr((P0 + (i - 2) * STEP + off - 9000) * 300))
        for e in scan(run(r, ts.take(), T0 + i * 5000000)):
            if e.pid == AUD and e.pts >= 0:
                a.append(e.pts)
    check("both jump, audio first: the first new audio PES is off by the jump",
          len(a) == 10 and mod33(a[5] - a[4]) == mod33(STEP + J))
    back = len(a) == 10 and mod33(a[6] - a[4]) == 2 * STEP
    for i in range(7, len(a)):
        back = back and mod33(a[i] - a[i - 1]) == STEP
    check("both jump, audio first: then the audio is back with the program",
          back and r.stats().reanchors == 1 and r.stats().kept == 0)


def test_both_jump_two_audio_first():
    """The same with two audio PES of each new rung ahead of the video (two AAC frames a video
    frame), forward and back: the two before the re-anchor are off, nothing after them."""
    for J in (90000 * 600, 4500 - P0 - 6 * STEP):
        r = HouseRebase()
        ts = Ts()
        ts.psi(VID)
        t = Tracks()
        for i in range(14):
            off = 0 if i < 6 else J
            av2_rung(ts, P0 + i * STEP + off, P0 + 100 + i * STEP + off, 0 if i < 6 else 2)
            t.add(run(r, ts.take(), T0 + i * 5000000))
        ok = len(t.v) == 14 and len(t.a) == 28
        i = 1
        while ok and i < 14:
            ok = mod33(t.v[i] - t.v[i - 1]) == STEP
            i += 1
        i = 7
        while ok and i < 14:
            ok = mod33(t.a[2 * i] - t.v[i]) == 100 and mod33(t.a[2 * i + 1] - t.a[2 * i]) == STEP // 2
            i += 1
        check("two audio first, forward: the source's A/V offset from the next rung on" if J > 0
              else "two audio first, back: the source's A/V offset from the next rung on", ok)
        check("two audio first, forward: only those two off by the jump" if J > 0
              else "two audio first, back: only those two off by the jump",
              len(t.a) == 28 and mod33(t.a[12] - t.a[11]) == mod33(STEP // 2 + J)
              and mod33(t.a[13] - t.a[12]) == STEP // 2)
        check("two audio first, forward: nothing kept apart" if J > 0
              else "two audio first, back: nothing kept apart",
              r.stats().reanchors == 1 and r.stats().kept == 0)


def test_jumped_first_takes_over():
    """A PID that jumped first is on the new mapping from the re-anchor on, also when it next
    speaks as the reference (after a stall): it continues, no second re-anchor."""
    r = HouseRebase()
    ts = Ts()
    ts.psi(VID)
    J = 90000 * 600
    for i in range(5):
        av_rung(ts, P0 + i * STEP, P0 + 100 + i * STEP)
        run(r, ts.take(), T0 + i * 5000000)
    ts.pes(AUD, 0xC0, P0 + 100 + 5 * STEP + J)   # the audio's new timeline first
    ts.pes(VID, 0xE0, P0 + 5 * STEP + J, P0 + 3 * STEP + J, mod_pcr((P0 + 3 * STEP + J - 9000) * 300))
    s = scan(run(r, ts.take(), T0 + 25000000))
    ts.pes(AUD, 0xC0, P0 + 100 + 6 * STEP + J)   # 3 s later: the audio takes over
    t = scan(run(r, ts.take(), T0 + 3 * SEC))
    check("jumped first, then the reference: it continues on the new mapping",
          len(s) == 2 and len(t) == 1 and mod33(t[0].pts - s[1].pts) == STEP + 100
          and r.stats().reanchors == 1)


def test_gap_then_inline_jump():
    """An audio gap is content, also when the video's inline jump follows: the audio stays (kept)."""
    r = HouseRebase()
    ts = Ts()
    ts.psi(VID)
    t = Tracks()
    for i in range(14):
        vsrc = P0 + i * STEP if i < 10 else 4500 + (i - 10) * STEP
        av_rung(ts, vsrc, P0 + 100 + i * STEP + (6 * 90000 if i >= 6 else 0))   # 6 s gap at rung 6
        t.add(run(r, ts.take(), T0 + i * 5000000))
    ok = len(t.v) == 14 and len(t.a) == 14 and mod33(t.a[6] - t.a[5]) == STEP + 6 * 90000
    i = 1
    while ok and i < 14:
        ok = mod33(t.v[i] - t.v[i - 1]) == STEP and (i == 6 or mod33(t.a[i] - t.a[i - 1]) == STEP)
        i += 1
    check("gap, then the video's inline jump: the gap stays, the audio is kept",
          ok and r.stats().reanchors == 1 and r.stats().kept == 1)


def test_untimed_follow():
    """What has no timeline of its own moves with the program at a re-anchor: a subtitle PES and a
    dedicated PCR PID, whose first PCR after it is flagged."""
    PCR_ONLY = 0x120
    r = HouseRebase()
    ts = Ts()
    ts.psi(PCR_ONLY)
    v, vd, sub, pcr, di = [], [], [], [], []
    for i in range(10):
        src = P0 + i * STEP if i < 5 else 4500 + (i - 5) * STEP
        av_rung(ts, src, src + 100)
        ts.pes(SUB, 0xBD, src + 500)
        ts.pcr(PCR_ONLY, mod_pcr((src - 2 * STEP - 9000) * 300))
        for e in scan(run(r, ts.take(), T0 + i * 5000000)):
            if e.pid == VID and e.pts >= 0:
                v.append(e.pts)
                vd.append(e.dts)
            if e.pid == SUB and e.pts >= 0:
                sub.append(e.pts)
            if e.pid == PCR_ONLY and e.pcr >= 0:
                pcr.append(e.pcr)
                di.append(e.di)
    ok = len(v) == 10 and len(sub) == 10 and len(pcr) == 10
    i = 0
    while ok and i < 10:
        ok = mod33(sub[i] - v[i]) == 500 and mod33(pcr[i] // 300 - vd[i]) == mod33(-9000)
        i += 1
    check("untimed: the subtitle PES and the PCR-only PID move with the program", ok)
    check("untimed: the PCR PID's first PCR after the re-anchor flagged, no other",
          r.stats().reanchors == 1 and di.count(True) == 1 and di[5])


def test_join_once():
    """A jump counts for one re-anchor: the audio that joined one does not follow the next."""
    r = HouseRebase()
    ts = Ts()
    ts.psi(VID)
    t = Tracks()
    vsrc = [P0, P0 + STEP, P0 + 2 * STEP, 4500, 4500 + 900000, 4500 + 900000 + STEP]
    for i in range(6):
        # Both loop at rung 3; at rung 4 only the video jumps.
        av_rung(ts, vsrc[i], P0 + 100 + i * STEP if i < 3 else 4600 + (i - 3) * STEP)
        t.add(run(r, ts.take(), T0 + i * 5000000))
    steps = len(t.v) == 6 and len(t.a) == 6
    i = 1
    while steps and i < 6:
        steps = mod33(t.v[i] - t.v[i - 1]) == STEP and mod33(t.a[i] - t.a[i - 1]) == STEP
        i += 1
    check("join once: both continue, the audio kept at the second re-anchor",
          steps and r.stats().reanchors == 2 and r.stats().kept == 1)


def test_join_target_recorded():
    """A pending PID takes the mapping of the reference that re-anchored, also when another PID
    took the reference over before it spoke (the video silent past REF_STALE_NS)."""
    AUD2 = 0x102
    r = HouseRebase()
    ts = Ts()
    ts.psi(VID)
    J = 90000 * 600
    a2 = []

    def take(now):
        for e in scan(run(r, ts.take(), now)):
            if e.pid == AUD2 and e.pts >= 0:
                a2.append(e.pts)

    for i in range(5):
        av_rung(ts, P0 + i * STEP, P0 + 100 + i * STEP)
        ts.pes(AUD2, 0xC1, P0 + 200 + i * STEP)
        take(T0 + i * 5000000)
    ts.pes(VID, 0xE0, P0 + 5 * STEP + J, P0 + 3 * STEP + J)   # jumps, then goes silent
    take(T0 + 25000000)
    ts.pes(AUD, 0xC0, P0 + 100 + 5 * STEP)       # 3 s on: continues (kept), takes over
    ts.pes(AUD2, 0xC1, P0 + 200 + 5 * STEP + J)  # jumped with the video
    take(T0 + 3 * SEC)
    check("join: the re-anchoring reference's mapping, though another took over since",
          len(a2) == 6 and mod33(a2[5] - a2[4]) == STEP and r.stats().reanchors == 1
          and r.stats().kept == 1)


def test_respawn_after_kept():
    """A runner respawn after the inline audio was kept apart: the new process has both PIDs on
    the origin's timeline, so the audio takes the reference's mapping again. Video first, two
    audio PES first, and audio first after a pause past REF_STALE_NS (the audio re-anchors)."""
    names = ["respawn, video first: A/V back to the source's",
             "respawn, two audio first: A/V back to the source's",
             "respawn, audio first after a pause: A/V back to the source's"]
    Q = 90000 * 3000                             # the origin's timeline at the respawn
    for variant in range(3):
        r = HouseRebase()
        ts = Ts()
        ts.psi(VID)
        t = Tracks()
        now = T0
        for i in range(12):
            # hls-pipe's inline discontinuity: the video jumps back, the audio continues.
            av2_rung(ts, P0 + i * STEP if i < 6 else 4500 + (i - 6) * STEP, P0 + 100 + i * STEP)
            t.add(run(r, ts.take(), now))
            now += 5000000
        kept = r.stats().kept == 1
        if variant == 2:
            now += 3 * SEC
        ts.psi(VID)
        for i in range(8):
            av2_rung(ts, Q + i * STEP, Q + 100 + i * STEP, 2 if variant else 0)
            t.add(run(r, ts.take(), now))
            now += 5000000
        ok = kept and len(t.v) == 20 and len(t.a) == 40
        i = 13
        while ok and i < 20:
            ok = mod33(t.a[2 * i] - t.v[i]) == 100 and mod33(t.a[2 * i + 1] - t.a[2 * i]) == STEP // 2
            i += 1
        check(names[variant], ok and r.stats().reanchors == 2 and r.stats().kept == 1)


def test_pcr_pid_after_takeover():
    """The PCR PID left behind: the video stops past REF_STALE_NS, the audio takes over and jumps.
    Back on its own timeline the video stays (kept), its PCR with its PES and not flagged; back
    with the audio it takes the program's mapping, and its next PCR is flagged."""
    J = 90000 * 600
    for with_audio in (False, True):
        r = HouseRebase()
        ts = Ts()
        ts.psi(VID)
        t = Tracks()
        now = T0
        i = 0
        while i < 6:
            av_rung(ts, P0 + i * STEP, P0 + 100 + i * STEP)
            t.add(run(r, ts.take(), now))
            i += 1
            now += 30000000
        while i < 86:                            # 2.4 s of audio alone
            ts.pes(AUD, 0xC0, P0 + 100 + i * STEP)
            t.add(run(r, ts.take(), now))
            i += 1
            now += 30000000
        for k in range(5):
            # The audio jumps; then the video comes back, on its own timeline or the audio's.
            vsrc = P0 + i * STEP + J if with_audio else P0 + (5 + k) * STEP
            if k == 0:
                ts.pes(AUD, 0xC0, P0 + 100 + i * STEP + J)
            else:
                av_rung(ts, vsrc, P0 + 100 + i * STEP + J)
            t.add(run(r, ts.take(), now))
            i += 1
            now += 30000000
        together = len(t.v) == 10 and len(t.pcr) == 10
        k = 0
        while together and k < len(t.v):
            together = mod33(t.pcr[k] // 300 - t.v[k]) == mod33(-(2 * STEP + 9000))
            k += 1
        flags = t.di.count(True)
        if not with_audio:
            check("PCR PID kept: its PES continue, its PCR moves with them",
                  together and mod33(t.v[6] - t.v[5]) == STEP)
            check("PCR PID kept: its PCR not flagged, one re-anchor",
                  flags == 0 and r.stats().reanchors == 1 and r.stats().kept == 1)
        else:
            av = together and len(t.a) == 91 and mod33(t.a[87] - t.a[86]) == STEP
            k = 6
            while av and k < 10:
                av = mod33(t.a[81 + k] - t.v[k]) == 100
                k += 1
            check("PCR PID joins: the program's mapping, the audio steps on, its PCR with it", av)
            check("PCR PID joins: its first PCR on it flagged, no second re-anchor",
                  flags == 1 and t.di[6] and r.stats().reanchors == 1 and r.stats().kept == 0)


def main():
    for test in (test_anchor, test_one_shift, test_wrap, test_loop_reanchor,
                 test_jump_after_pause_lands_at_now, test_stall_without_jump, test_gap_on_audio,
                 test_reference_prefers_video, test_reference_pcr_pid, test_stale_reference,
                 test_before_anchor, test_split_header, test_broken_split_header,
                 test_damaged_dts_and_untimed, test_chunking, test_duplicate,
                 test_private_on_pcr_pid, test_pause_with_reorder, test_jump_before_spacing,
                 test_flag_on_pcr_pid_only, test_takeover_after_reanchor,
                 test_bframes_reanchor_on_dts, test_duplicate_of_held_header, test_threshold,
                 test_si_untouched, test_repeated_jumps, test_held_af_bounded,
                 test_inline_audio_stays, test_inline_audio_stays_forward,
                 test_both_jump_audio_first, test_both_jump_two_audio_first,
                 test_jumped_first_takes_over, test_gap_then_inline_jump, test_untimed_follow,
                 test_join_once, test_join_target_recorded, test_respawn_after_kept,
                 test_pcr_pid_after_takeover):
        test()
    if _trace is not None:
        _trace.close()
    if _failures:
        print(f"\n{_failures} FAILURE(S) in house_rebase")
        return 1
    print("\nALL house_rebase TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
