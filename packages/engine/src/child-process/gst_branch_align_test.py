#!/usr/bin/env python3
"""Self-checking tests for `alignBranchesToStamps` (gst-pipeline-runner.py,
`_install_branch_stamp_align`) — the multi-input mux A/V skew fix.

THE DEFECT, in one sentence: each mux input branch works out its own zero point
(its `tsdemux` slaves the PES timeline to the ONE bus buffer it locked on), so
two branches carrying source-simultaneous media leave the mux tens or hundreds
of milliseconds apart, re-drawn on every restart. Measured on the .202 X-Chain
rig 2026-08-14: inputs 0.001 ms apart, output 100–121 ms apart, a fresh value
per mux incarnation.

What the suite pins, in the order the fix has to earn it:

  1. THE MEASUREMENT — the two numbers the offset is built from, taken off the
     branch's own sink pad: the producer's mapping `K`, which must survive the
     monotone floor CLAMPING the stamps of a reordered stream (that clamp is the
     field mechanism), and the identity of the access unit the demuxer actually
     emitted, joined back by the TAIL of its payload (the head is boilerplate
     every frame repeats — joining on it landed whole frames out on the rig).
  2. END TO END through the real chain (`tsdemux ! aacparse ! queue !
     mpegtsmux`), two stamped single-PID legs given DIFFERENT branch zero
     points: without the feature the output PES carry the injected skew, with it
     they are aligned. Both arms in one run, so the second is a live mutation
     check on the first rather than a claim about it.
  3. ACROSS A RESTART — the same rig with a different draw. The pre-fix skew
     changes with the draw (that is the re-roll); the fixed one does not.

Skips (exit 0) where GStreamer / PyGObject is unavailable.

Run:  python3 gst_branch_align_test.py
"""
import importlib.util
import os
import sys
import threading
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import GLib, Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_branch_align_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

_HERE = os.path.dirname(os.path.abspath(__file__))
# What PythonProcess does at spawn time: plugin-owned python on the path.
sys.path.insert(0, os.path.normpath(
    os.path.join(_HERE, "..", "..", "..", "..", "plugins", "mpegts-core", "py")))
sys.path.insert(0, _HERE)
# `MR_STAMPER_RUNNER` points the contract suites at a mutated copy of the runner
# — one knob for the mutation drills.
_RUNNER = os.environ.get("MR_STAMPER_RUNNER") or os.path.join(
    _HERE, "gst-pipeline-runner.py")
sys.path.insert(0, os.path.dirname(os.path.abspath(_RUNNER)))
_spec = importlib.util.spec_from_file_location("gst_pipeline_runner", _RUNNER)
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)
rt = runner.branch_retime          # the transformProducer retime (branch_retime.py)

import ts_psi  # noqa: E402
import ts_timeline  # noqa: E402

Gst.init([])

_failures = []

AAC_TICKS = 1920            # one AAC frame @ 48 kHz, in 90 kHz ticks
# A whole ADTS frame has to fit in ONE TS packet (184 − a 14-byte PES
# header), so the analysis can read its tail serial straight off the PUSI
# packet without reassembling.
FRAME_BYTES = 160
PES0 = 900_000              # source epoch of both legs
LEAD_NS = 1_200_000_000     # bus buffers arrive this far ahead of their stamp
RUN_SECONDS = float(os.environ.get("BRANCH_ALIGN_SECONDS", "9"))
# The runner leaves a branch alone for 3 s before it reads its error (a tsdemux
# re-slaves for the first seconds of a stream, so an earlier reading is a
# transient — the lesson the rig taught, twice). Compressed here so the suite
# stays a suite; what is under test is the settled correction, not the wait.
runner._BRANCH_ALIGN_SETTLE_MS = 1500.0
TS_CAPS = "video/mpegts,systemstream=(boolean)true,packetsize=(int)188"


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def ns(pts90k):
    return ts_timeline.pts90k_to_ns(pts90k)


# ---------------------------------------------------------------------------
# Fixture: a stamped single-PID SPTS leg, the shape mr-tssplit puts on a bus edge
# ---------------------------------------------------------------------------
def adts_frame(serial):
    """One ADTS AAC frame carrying `serial` — but ONLY in its tail.

    The head is deliberately identical for every access unit, which is what a
    real H.264 frame looks like (AUD + SEI boilerplate, repeated verbatim), and
    is why a join on the payload head silently landed whole frames out on the
    live rig. Identity lives at the END of the last slice, so both the runner's
    join and the analysis tooling's key it. A fixture that made every byte
    unique would have passed a broken join.
    """
    hdr = bytes([0xFF, 0xF1, 0x50, 0x80 | ((FRAME_BYTES >> 11) & 0x03),
                 (FRAME_BYTES >> 3) & 0xFF, ((FRAME_BYTES & 0x07) << 5) | 0x1F, 0xFC])
    body = bytes(FRAME_BYTES - len(hdr) - 8) + serial.to_bytes(8, "big")
    return hdr + body


def pes_packets(pid, pts90k, payload, cc):
    """PES-ise `payload` onto `pid` (PUSI on the first packet)."""
    p = pts90k & ((1 << 33) - 1)
    pts_bytes = bytes([
        0x21 | (((p >> 30) & 0x07) << 1), (p >> 22) & 0xFF,
        0x01 | (((p >> 15) & 0x7F) << 1), (p >> 7) & 0xFF, 0x01 | ((p & 0x7F) << 1)])
    body = (b"\x00\x00\x01\xc0" + (len(payload) + 8).to_bytes(2, "big")
            + b"\x80\x80\x05" + pts_bytes + payload)
    out, first = [], True
    while body:
        chunk, body = body[:184], body[184:]
        flags = 0x40 if first else 0x00
        if len(chunk) < 184:                        # pad the tail out with an AF
            stuff = 184 - len(chunk)
            af = (bytes([stuff - 1]) + (b"\x00" if stuff >= 2 else b"")
                  + b"\xff" * max(0, stuff - 2))
            out.append(bytes([ts_psi.SYNC, flags | ((pid >> 8) & 0x1F), pid & 0xFF,
                              0x30 | (cc[0] & 0x0F)]) + af + chunk)
        else:
            out.append(bytes([ts_psi.SYNC, flags | ((pid >> 8) & 0x1F), pid & 0xFF,
                              0x10 | (cc[0] & 0x0F)]) + chunk)
        cc[0] = (cc[0] + 1) & 0x0F
        first = False
    return b"".join(out)


class Leg:
    """One producer egress leg: PSI + `aus_per_buffer` access units per bus
    buffer, stamped `K + ns(first PES)` the way the contract's egress stamper
    does. `psi_after_aus` is the branch zero-point lever: PSI landing that many
    access units into the buffer is media the branch's demuxer must discard,
    while the buffer's STAMP still refers to the first of them."""

    def __init__(self, name, pid, pmt_pid, out_pid, mux_pad, aus_per_buffer,
                 psi_after_aus):
        self.name, self.pid, self.pmt_pid = name, pid, pmt_pid
        self.out_pid, self.mux_pad = out_pid, mux_pad
        self.aus_per_buffer, self.psi_after_aus = aus_per_buffer, psi_after_aus
        self.cc, self.psi_cc, self.n = [0], 0, 0
        self.src = None
        self.demux_pad = None

    def buffer(self, k_ns):
        pkts, first_pts = [], None
        for i in range(self.aus_per_buffer):
            if i == self.psi_after_aus:
                pkts.append(ts_psi.build_pat(1, {1: self.pmt_pid}, cc=self.psi_cc))
                pkts.append(ts_psi.build_pmt(self.pmt_pid, 1, self.pid,
                                             [(self.pid, 0x0F)], cc=self.psi_cc))
                self.psi_cc = (self.psi_cc + 1) & 0x0F
            pts = PES0 + self.n * AAC_TICKS
            if first_pts is None:
                first_pts = pts
            pkts.append(pes_packets(self.pid, pts, adts_frame(self.n), self.cc))
            self.n += 1
        buf = Gst.Buffer.new_wrapped(b"".join(pkts))
        buf.pts = buf.dts = k_ns + ns(first_pts)
        return buf, first_pts


def output_aus(data, pid):
    """(PES PTS, AU serial) for every access unit of `pid` in a muxed TS."""
    out = []
    for pkt in ts_psi.iter_packets(data):
        if not ts_psi.ts_pusi(pkt) or ts_psi.ts_pid(pkt) != pid:
            continue
        pts = ts_psi.read_pes_pts(pkt)
        pes = pkt[ts_psi.payload_offset(pkt):]
        if pts is None or len(pes) < 20 or pes[0:3] != b"\x00\x00\x01":
            continue
        es = pes[9 + pes[8]:]
        # The serial lives in the AU's TAIL (see adts_frame); a whole ADTS frame
        # fits in one TS packet here, so the tail is present in this packet.
        if len(es) >= FRAME_BYTES and es[0] == 0xFF:
            out.append((pts, int.from_bytes(es[FRAME_BYTES - 8:FRAME_BYTES], "big") & 0xFF))
    return out


def timeline_const_ms(aus):
    """(output PES − source PES) for this leg, in ms — the branch's zero point.
    Two legs on ONE source timeline differ by exactly the skew the mux
    introduced.

    Read over the SETTLED part of the run only: the correction lands a few
    seconds in (the branch has to settle before it can be measured), so the
    leading access units are the pre-correction timeline by design.
    """
    if len(aus) < 20:
        return None
    n0 = aus[0][1]
    vals = []
    for k, (pts, serial) in enumerate(aus):
        if ((n0 + k) & 0xFF) != serial:      # a drop would break the ladder
            break
        vals.append(ns(pts) - ns(PES0 + (n0 + k) * AAC_TICKS))
    settled = vals[int(len(vals) * 0.6):]
    if len(settled) < 20:
        return None
    return sorted(settled)[len(settled) // 2] / 1e6


def run_rig(legs, align):
    """Push both legs through the real branch chain into one mpegtsmux.

    Returns (skew_ms, {leg: applied pad offset ns}, {leg: matched AU count}).
    """
    desc = " ".join(
        [f'appsrc name=src{l.name} is-live=true format=time do-timestamp=false '
         f'caps="{TS_CAPS}" ! tsdemux latency=0 name=demux_{l.name}' for l in legs]
        + ["mpegtsmux name=mux latency=1200000000 min-upstream-latency=1200000000 "
           "alignment=7 ! appsink name=out emit-signals=true sync=false "
           "max-buffers=8000 drop=false"])
    pipe = Gst.parse_launch(desc)

    # The contract's clock, exactly as `_apply_contract_clock` applies it.
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
    pipe.use_clock(clock)
    pipe.set_start_time(Gst.CLOCK_TIME_NONE)
    pipe.set_base_time(0)
    mux = pipe.get_by_name("mux")

    if align:
        runner._install_branch_stamp_align(
            pipe, {"demuxes": [f"demux_{l.name}" for l in legs]})

    def on_pad(_demux, pad, leg):
        leg.demux_pad = pad
        par = Gst.ElementFactory.make("aacparse", None)
        q = Gst.ElementFactory.make("queue", None)
        q.set_property("max-size-time", 500 * Gst.MSECOND)
        q.set_property("max-size-bytes", 0)
        q.set_property("max-size-buffers", 0)
        for el in (par, q):
            pipe.add(el)
            el.sync_state_with_parent()
        pad.link(par.get_static_pad("sink"))
        par.get_static_pad("src").link(q.get_static_pad("sink"))
        q.get_static_pad("src").link(mux.request_pad_simple(leg.mux_pad))

    for leg in legs:
        leg.src = pipe.get_by_name(f"src{leg.name}")
        leg.n, leg.cc, leg.psi_cc = 0, [0], 0
        pipe.get_by_name(f"demux_{leg.name}").connect(
            "pad-added", lambda _d, p, l=leg: on_pad(_d, p, l))

    chunks = []

    def on_sample(sink):
        smp = sink.emit("pull-sample")
        if smp:
            buf = smp.get_buffer()
            ok, mi = buf.map(Gst.MapFlags.READ)
            if ok:
                try:
                    chunks.append(bytes(mi.data))
                finally:
                    buf.unmap(mi)
        return Gst.FlowReturn.OK

    pipe.get_by_name("out").connect("new-sample", on_sample)
    pipe.set_state(Gst.State.PLAYING)
    pipe.get_state(3 * Gst.SECOND)

    k_ns = clock.get_time() + LEAD_NS - ns(PES0)
    stop = threading.Event()

    def pump(leg):
        while not stop.is_set():
            buf, first_pts = leg.buffer(k_ns)
            wait = (k_ns + ns(first_pts) - LEAD_NS - clock.get_time()) / 1e9
            if wait > 0:
                time.sleep(wait)
            leg.src.emit("push-buffer", buf)

    for leg in legs:
        threading.Thread(target=pump, args=(leg,), daemon=True).start()

    loop = GLib.MainLoop()
    GLib.timeout_add(int(RUN_SECONDS * 1000), lambda: (loop.quit(), False)[1])
    loop.run()
    stop.set()
    time.sleep(0.3)
    offsets = {l.name: (l.demux_pad.get_offset() if l.demux_pad else None)
               for l in legs}
    pipe.set_state(Gst.State.NULL)
    runner._clear_branch_align()

    data = b"".join(chunks)
    consts, counts = {}, {}
    for leg in legs:
        aus = output_aus(data, leg.out_pid)
        counts[leg.name] = len(aus)
        consts[leg.name] = timeline_const_ms(aus)
    skew = None
    if all(v is not None for v in consts.values()):
        a, b = [consts[l.name] for l in legs]
        skew = a - b
    return skew, offsets, counts


def make_legs(psi_after_a, psi_after_b=0):
    return [Leg("A", 0x100, 0x1000, 0x100, "sink_256", 6, psi_after_a),
            Leg("B", 0x101, 0x1001, 0x140, "sink_320", 6, psi_after_b)]


# ---------------------------------------------------------------------------
print("\n--- 1. the measurement: K survives a clamped stamp, and the join is "
      "by CONTENT ---")
# The field mechanism, in the small: a reordered stream's per-buffer FIRST PES
# walks backwards, the producer's monotone floor clamps those buffers' stamps
# UP, and a branch that takes one of them at face value runs that far late for
# its whole incarnation. K has to come out unclamped anyway, and the access unit
# the branch actually emitted has to be identified from its PAYLOAD — the rig
# refuted both attempts to predict it from stream structure.
pipe = Gst.parse_launch(
    f'appsrc name=src is-live=true format=time do-timestamp=false caps="{TS_CAPS}" '
    "! identity name=demux_0 ! fakesink name=fs sync=false async=false")
runner._install_branch_stamp_align(pipe, {"demuxes": ["demux_0"]})
src = pipe.get_by_name("src")
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)

K_TRUE = 7_000_000_000_000
PID = 0x100
# A B-frame stream in DECODE order (I P B B …: 0 3 1 2 6 4 5 …), two access
# units per bus buffer — the live video leg's shape, where the per-buffer first
# PES walks backwards (measured on .202: 310127573 then 310116773). Buffers 3
# and 6 open on a PTS the floor already stands above, so their stamps are
# CLAMPED. The ladder deliberately ENDS on a clamped one: a K taken as the
# latest reading rather than the minimum would then be wrong, and this must say
# so rather than being rescued by a clean last buffer.
LADDER = [
    [PES0 + 0 * 3600, PES0 + 3 * 3600],
    [PES0 + 1 * 3600, PES0 + 2 * 3600],
    [PES0 + 6 * 3600, PES0 + 4 * 3600],
    [PES0 + 5 * 3600, PES0 + 9 * 3600],      # first PES walks back: clamped
    [PES0 + 7 * 3600, PES0 + 8 * 3600],
    [PES0 + 12 * 3600, PES0 + 10 * 3600],
    [PES0 + 11 * 3600, PES0 + 15 * 3600],    # ... and again, on the last buffer
]
floor = 0
stamps = []
serial = 0
serial_of = {}                     # PES PTS -> the payload serial it carried
for i, group in enumerate(LADDER):
    cc = [0]
    pkts = []
    if i == 0:                     # PSI at the head of the first buffer only
        pkts.append(ts_psi.build_pat(1, {1: 0x1000}))
        pkts.append(ts_psi.build_pmt(0x1000, 1, PID, [(PID, 0x0F)]))
    for pts in group:
        pkts.append(pes_packets(PID, pts, adts_frame(serial), cc))
        serial_of[pts] = serial
        serial += 1
    stamp = max(K_TRUE + ns(group[0]), floor)     # the stamper's monotone floor
    floor = stamp
    stamps.append(stamp)
    buf = Gst.Buffer.new_wrapped(b"".join(pkts))
    buf.pts = buf.dts = stamp
    src.emit("push-buffer", buf)
# One repeat of an earlier access unit's payload (serial 1 — the SECOND, so
# the queue's first join is on a tail nothing else pending carries): two PES
# sharing a tail are told apart by EMISSION ORDER (the queue), never by
# content — silence and a test tone repeat their payload every few frames. A
# trailing PES follows it, as the shape the ladder always had.
cc = [0]
src.emit("push-buffer", Gst.Buffer.new_wrapped(
    pes_packets(PID, PES0 + 99 * 3600, adts_frame(1), cc)
    + pes_packets(PID, PES0 + 100 * 3600, adts_frame(255), cc)))
src.emit("end-of-stream")
pipe.get_bus().timed_pop_filtered(3 * Gst.SECOND,
                                  Gst.MessageType.EOS | Gst.MessageType.ERROR)
state = runner._branch_align.get("demux_0")
pipe.set_state(Gst.State.NULL)

clamped = [i for i, s in enumerate(stamps) if s != K_TRUE + ns(LADDER[i][0])]
print(f"    stamps clamped by the floor: buffers {clamped} "
      f"(raw K per buffer: "
      f"{[(s - ns(g[0]) - K_TRUE) // 1000000 for s, g in zip(stamps, LADDER)]} ms off)")
check("the fixture actually clamped a stamp (else this proves nothing)", clamped)
check("K is the UNCLAMPED mapping, not the latest reading",
      state is not None and state["k"] == K_TRUE)
check("every stamped buffer was measured",
      state is not None and state["ksamples"] == len(LADDER))

# What the branch would take (below) needs the index BEFORE the joins consume
# it: first pending entry per tail, exactly what a lookup in order would see.
by_tail = {}
for t, p_ in (state["aus"].get(PID, []) if state else []):
    by_tail.setdefault(t, p_)
# The join: in emission order, every access unit's payload tail maps back to
# ITS OWN PES PTS — serial 1 included, whose payload the trailing buffer
# repeats: once in step, the earliest pending match is the ladder's, and the
# repeat is what the next lookup on that tail gets.
joined = 0
wrong = []
for pts, ser in serial_of.items():
    got = runner._branch_align_join(state, PID, adts_frame(ser)[-64:]) if state else None
    if got == pts:
        joined += 1
    else:
        wrong.append((ser, pts, got))
print(f"    payload-tail join: {joined}/{len(serial_of)} access units joined "
      f"back to their own PES{'' if not wrong else f' (wrong: {wrong[:3]})'}")
check("every access unit is joinable by its payload tail, in order",
      joined == len(serial_of))
check("a tail two access units share is resolved by emission order, not guessed",
      state is not None
      and runner._branch_align_join(state, PID, adts_frame(1)[-64:]) == PES0 + 99 * 3600)
check("the trailing access unit follows the repeat",
      state is not None
      and runner._branch_align_join(state, PID, adts_frame(255)[-64:]) == PES0 + 100 * 3600)
check("a tail nothing pending carries joins nothing",
      state is not None and runner._branch_align_join(state, PID, b"\x00" * 64) is None)

# The FIRST join on a PID cannot lean on order: what is queued ahead of it are
# access units the demuxer discarded before its PSI, and on digital silence
# they carry the very tail it emitted. So that first match has to be unique
# among the pending entries, or it decides nothing; from the first unique join
# on, the queue is in step and the earliest match is the emitted AU.
import collections as _collections
_fresh = {"aus": {PID: _collections.deque([(b"x" * 64, 9), (b"s" * 64, 10), (b"s" * 64, 11),
                                            (b"u" * 64, 12), (b"s" * 64, 13), (b"s" * 64, 14)])},
          "synced": {}}
check("before the queue is in step, a repeated tail OFF THE HEAD decides nothing",
      runner._branch_align_join(_fresh, PID, b"s" * 64) is None
      and len(_fresh["aus"][PID]) == 6)
check("a unique first match puts the queue in step and drops what preceded it",
      runner._branch_align_join(_fresh, PID, b"u" * 64) == 12
      and _fresh["synced"].get(PID) is True and len(_fresh["aus"][PID]) == 2)
check("in step, a repeated tail resolves to the earliest pending entry",
      runner._branch_align_join(_fresh, PID, b"s" * 64) == 13
      and runner._branch_align_join(_fresh, PID, b"s" * 64) == 14)
# A silent leg: every tail identical. Pre-PSI discards are never queued (see
# below), so the head is the demuxer's first AU — a head match needs no
# uniqueness, and the leg aligns on silence too.
_silent = {"aus": {PID: _collections.deque([(b"s" * 64, 20), (b"s" * 64, 21), (b"s" * 64, 22)])},
           "synced": {}}
check("on silence the first join takes the head — position decides, not content",
      runner._branch_align_join(_silent, PID, b"s" * 64) == 20
      and runner._branch_align_join(_silent, PID, b"s" * 64) == 21)

# What the branch would take, from the two measured quantities only: it emits
# access unit X while the demuxer hands back a CLAMPED buffer's stamp, so
# `K + ns(byTail[X]) − stamp` has to come out at exactly minus that clamp. This
# is the live video leg's case, in the small.
for i in clamped:
    emitted = LADDER[i][0]
    head = adts_frame(serial_of[emitted])[-64:]
    computed = (state["k"] + ns(by_tail[head]) - stamps[i]) if state else None
    clamp = stamps[i] - (K_TRUE + ns(emitted))
    print(f"    buffer {i}: clamp={clamp / 1e6:+.3f} ms → correction "
          f"{computed / 1e6 if computed is not None else None:+.3f} ms")
    check(f"a clamped buffer (#{i}) yields exactly minus its clamp",
          clamp > 0 and computed == -clamp)
runner._clear_branch_align()

# A PES the demuxer will DISCARD (it sits ahead of the PSI) still counts toward
# K — K is the producer's mapping and every stamped buffer carries it, and
# skipping those PES is what made the first cut measure a K short by exactly
# the discarded media. But it is NOT queued for the join: tsdemux programs its
# pad at the PMT and starts on the next PUSI, so what the queue holds must be
# exactly what the demuxer will hand back — on a silent leg the head's
# position is the only thing that can identify the first emitted AU.
pipe = Gst.parse_launch(
    f'appsrc name=src is-live=true format=time do-timestamp=false caps="{TS_CAPS}" '
    "! identity name=demux_0 ! fakesink name=fs sync=false async=false")
runner._install_branch_stamp_align(pipe, {"demuxes": ["demux_0"]})
src = pipe.get_by_name("src")
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(3 * Gst.SECOND)
cc = [0]
pkts = [pes_packets(PID, PES0 + i * 3600, adts_frame(100 + i), cc) for i in range(2)]
pkts.append(ts_psi.build_pat(1, {1: 0x1000}))
pkts.append(ts_psi.build_pmt(0x1000, 1, PID, [(PID, 0x0F)]))
pkts += [pes_packets(PID, PES0 + i * 3600, adts_frame(100 + i), cc) for i in range(2, 5)]
buf = Gst.Buffer.new_wrapped(b"".join(pkts))
buf.pts = buf.dts = K_TRUE + ns(PES0)
src.emit("push-buffer", buf)
src.emit("end-of-stream")
pipe.get_bus().timed_pop_filtered(3 * Gst.SECOND,
                                  Gst.MessageType.EOS | Gst.MessageType.ERROR)
state = runner._branch_align.get("demux_0")
pipe.set_state(Gst.State.NULL)
check("K comes off the buffer's FIRST PES — including PES the demuxer discards",
      state is not None and state["k"] == K_TRUE)
# (Every PES here carries a length, so all five are closed the moment they
# are complete; the two ahead of the PSI are the demuxer's discards.)
_queued = [p_ for _t, p_ in (state["aus"].get(PID, []) if state else [])]
check("only the PES after PAT+PMT are queued for the join, in order",
      state is not None and _queued == [PES0 + i * 3600 for i in range(2, 5)])
check("the queue's head is the first access unit the demuxer will emit",
      state is not None
      and runner._branch_align_join(state, PID, adts_frame(102)[-64:]) == PES0 + 2 * 3600)
runner._clear_branch_align()


# ---------------------------------------------------------------------------
print("\n--- 2. end to end: two branches, different zero points, one mux ---")
INJECTED_MS = 5 * AAC_TICKS / 90.0        # 5 access units = 106.667 ms
base_skew, base_offsets, base_counts = run_rig(make_legs(5), align=False)
print(f"    without the fix: skew={base_skew} ms "
      f"(injected {INJECTED_MS:.3f} ms) matched AUs={base_counts}")
check("the fixture muxed both legs", min(base_counts.values()) > 100)
check("without the fix the branches carry the injected zero-point difference",
      base_skew is not None and abs(abs(base_skew) - INJECTED_MS) < 5)

fixed_skew, fixed_offsets, fixed_counts = run_rig(make_legs(5), align=True)
print(f"    with the fix:    skew={fixed_skew} ms  applied pad offsets(ns)="
      f"{fixed_offsets}")
check("the fix muxed both legs (it did not cost the fixture its data)",
      min(fixed_counts.values()) > 100)
check("with the fix the branches are aligned at the mux OUTPUT",
      fixed_skew is not None and abs(fixed_skew) < 5)
check("the correction is the branch's own zero-point error, not a constant",
      fixed_offsets["A"] != fixed_offsets["B"])


# ---------------------------------------------------------------------------
print("\n--- 3. across a restart: the draw changes, the alignment does not ---")
# A fresh incarnation locks on a different access unit — which is exactly why
# the field skew was re-drawn (120.4 / 104.0 / 100.1 ms) instead of being a
# calibratable constant. Same rig, different draw.
redraw_ms = 2 * AAC_TICKS / 90.0
base2_skew, _o, _c = run_rig(make_legs(2), align=False)
print(f"    without the fix, second draw: skew={base2_skew} ms "
      f"(injected {redraw_ms:.3f} ms)")
check("the pre-fix skew really is RE-DRAWN per incarnation",
      base2_skew is not None and base_skew is not None
      and abs(abs(base2_skew) - redraw_ms) < 5
      and abs(abs(base2_skew) - abs(base_skew)) > 20)

fixed2_skew, fixed2_offsets, fixed2_counts = run_rig(make_legs(2), align=True)
print(f"    with the fix,    second draw: skew={fixed2_skew} ms  "
      f"applied pad offsets(ns)={fixed2_offsets}")
check("the fixed alignment survives the re-draw",
      fixed2_skew is not None and abs(fixed2_skew) < 5)
check("the offset itself was re-derived for the new draw",
      fixed2_offsets["A"] != fixed_offsets["A"])

print("\n--- 4. the verdict: what the mux can absorb, each way, and said loudly ---")
# Pure, so the sign convention is pinned here and not by a live rig: a POSITIVE
# error moves the branch LATER (its buffers wait in the aggregator — bounded by
# the 5 s input queue), a NEGATIVE one EARLIER (the aggregator reads them as
# late — bounded by its 1.2 s latency fill). The 2026-09-05 GATE01 epoch had
# +533 / +683 / +1024 ms corrections rejected as "implausible" under a flat
# 500 ms cap; every one was real and every rejected track shipped out of step.
V = runner._branch_align_verdict
check("a real correction inside both bounds is applied",
      V(533_000_000) == "apply" and V(1_024_000_000) == "apply"
      and V(3_900_000_000) == "apply" and V(-900_000_000) == "apply")
check("a branch too far BEHIND its stamps for the input queue is rejected",
      V(4_100_000_000) == "reject" and V(4_000_000_001) == "reject")
check("a branch too far AHEAD of its stamps for the mux latency is rejected",
      V(-1_100_000_000) == "reject" and V(-1_000_000_001) == "reject")
check("the bounds are asymmetric on purpose: +1.1 s applies, -1.1 s does not",
      V(1_100_000_000) == "apply" and V(-1_100_000_000) == "reject")
check("a sub-threshold error is left alone rather than stepped",
      V(1_000_000) == "skip" and V(-1_000_000) == "skip" and V(0) == "skip")
events = []
saved_emit = runner.emit_event
runner.emit_event = events.append
runner._branch_align_rejected("demux_1", 0x100, -95_656_057_391)
runner.emit_event = saved_emit
check("a rejection is an engine-visible `warning` naming the branch, pid and error",
      len(events) == 1 and events[0]["event"] == "warning"
      and "demux_1" in events[0]["message"] and "pid=0x100" in events[0]["message"]
      and "-95656 ms" in events[0]["message"]
      and "out of step" in events[0]["message"])

print("\n--- 5. one length-bearing PES per bus buffer: the 302M / audio shape ---")
# Every 302M egress is exactly this: `mpegtsmux alignment=7` plus the stamper's
# coalescing put ONE access unit in each bus buffer, and an audio PES carries a
# length, so tsdemux emits it inside the same buffer — before any next PUSI.
# An index that only closed an AU at the next PUSI had nothing to join against
# and every audio-output-302m branch ran un-anchored for its whole life
# ("joined only 0 access units", 10.9.16.50, 2026-09-17). The join has to be
# ready the moment the PES is complete.
import io as _io
_legs1 = [Leg("A", 0x100, 0x1000, 0x100, "sink_256", 1, 0),
          Leg("B", 0x101, 0x1001, 0x140, "sink_320", 1, 0)]
_cap, _old = _io.StringIO(), sys.stderr
sys.stderr = _cap
try:
    one_skew, one_offsets, one_counts = run_rig(_legs1, align=True)
finally:
    sys.stderr = _old
_log = _cap.getvalue()
print(f"    one AU per buffer: counts={one_counts} offsets(ns)={one_offsets} "
      f"verdicts={_log.count('median of')} giveups={_log.count('joined only')}")
check("the fixture muxed both single-AU legs", min(one_counts.values()) > 100)
check("a length-bearing PES is joined the moment it is complete (no give-up)",
      "joined only" not in _log)
check("both single-AU branches reached a verdict",
      _log.count("median of") == 2)

print("\n--- 6. a transform producer's input demux: every access unit retimed ---")
# Its tsdemux runs each access unit at stamp + (PTS − PCR): ~1.1 s late at the OCC
# gate, walking with the VBR lead (gst_tsdemux_slave_test.py). `transformProducer`
# rewrites every buffer to K + its PES, so the identity egress exports content time.
import re  # noqa: E402

import transform_input_fixture as fx  # noqa: E402
PRODUCER = {"demuxes": ["demux"], "transformProducer": True}
H0 = 200_000 * 10**9
SWING = {"dts_lead_ms": 900.0, "lead_swing_ms": 500.0, "swing_period_s": 20.0}


def tp_run(cfg, seconds=8, start_s=2.2, skew_ppm=0.0, drop=None, **kw):
    """Every AU that LEFT the demux, in sink order — (pid, serial, PTS error ms,
    running PTS, running DTS, DTS error ms) — and the runner log. `drop(bufs)`
    names bus buffers lost upstream (a leaky queue)."""
    dts_t = {}
    kw.setdefault("dts_lead_ms", 1100.0)
    bufs, targets = fx.stamp(fx.build_packets(seconds, **kw), start_s, H0, skew_ppm,
                             dts_targets=dts_t)
    if drop:
        lost = drop(bufs)
        check(f"    (the fixture has a buffer to lose: {sorted(lost)})", len(lost) == 1)
        bufs = [b for i, b in enumerate(bufs) if i not in lost]
    cap, old = _io.StringIO(), sys.stderr
    sys.stderr = cap
    try:
        rows = fx.run_demux(Gst, bufs, targets, detail=True, install=(
            (lambda p: runner._install_branch_stamp_align(p, cfg)) if cfg else None))
    finally:
        sys.stderr = old
        runner._clear_branch_align()
    return [(pid, s, e / 1e6, rp, rd, None if rd is None else (rd - dts_t[(pid, s)]) / 1e6)
            for pid, s, e, rp, rd in rows], cap.getvalue()


def worst(rows):
    return max(abs(r[2]) for r in rows) if rows else float("inf")


def firsts_ok(rows):
    """The FIRST access unit out on each of the two PIDs is on its content time."""
    first = {}
    for r in rows:
        first.setdefault(r[0], r[2])
    return len(first) == 2 and all(abs(e) <= 20 for e in first.values())


def back_step(rows):
    """Largest backward step (ms) of a PID's running DTS (PTS where none), sink order."""
    last, back = {}, 0.0
    for pid, _s, _e, rp, rd, _de in rows:
        t = rp if rd is None else rd
        if pid in last:
            back = max(back, (last[pid] - t) / 1e6)
        last[pid] = t
    return back


def trend_ms_per_s(rows):
    """Least-squares slope of the PTS error against media time."""
    t = [(r[3] - rows[0][3]) / 1e9 for r in rows]
    e = [r[2] for r in rows]
    mt, me = sum(t) / len(t), sum(e) / len(e)
    return sum((a - mt) * (b - me) for a, b in zip(t, e)) / sum((a - mt) ** 2 for a in t)


def lost_floor_raiser(bufs):
    """A buffer whose stamp moved on an I/P video PES, followed by one clamped to
    it: lose it and the follower's stamp reads as moved — K + its clamp."""
    def heads(data):
        return [(ts_psi.ts_pid(p), p[ts_psi.payload_offset(p) + 7] & 0xC0 == 0xC0)
                for p in ts_psi.iter_packets(data) if ts_psi.read_pes_pts(p) is not None]
    for i in range(100, len(bufs) - 1):
        video = [dts for pid, dts in heads(bufs[i][0]) if pid == fx.VIDEO_PID]
        if (bufs[i][1] != bufs[i - 1][1] and video and video[0]
                and bufs[i + 1][1] == bufs[i][1] and heads(bufs[i + 1][0])):
            return {i}
    return set()


# (a) From the FIRST access unit, wherever the feed is cut: the bus input is held
# until a stamp moves (≤ 250 ms here) and re-chained, so nothing is lost.
STARTS = (2.2, 2.013, 2.697, 3.91, 2.597, 1.3, 4.267, 5.015)
cuts = {}
for s in STARTS:
    rows, log = tp_run(PRODUCER, start_s=s)
    alone, _ = tp_run(None, start_s=s)
    m = re.search(r"\((\d+) bus buffers held\)", log)
    cuts[s] = (rows, alone, log, int(m.group(1)) if m else None)
print("    bus buffers held per cut: " + ", ".join(f"{s} s→{v[3]}" for s, v in cuts.items()))
check("(a) the FIRST access unit out is on its content time on both PIDs (±20 ms), every cut",
      all(firsts_ok(v[0]) for v in cuts.values()))
check(f"(a) every access unit leaves on its content time (worst "
      f"{max(worst(v[0]) for v in cuts.values()):.3f} ms)",
      all(worst(v[0]) <= 20 for v in cuts.values()))
check("(a) no media dropped: exactly the access units tsdemux emits alone, in its order",
      all(len(v[0]) > 300 and [r[:2] for r in v[0]] == [r[:2] for r in v[1]]
          for v in cuts.values()))
check("(a) every hold ended on an exact stamp reading, never on its bound",
      all("released on the first exact stamp reading" in v[2] for v in cuts.values()))

# (b) 64 s, the video lead swinging 0.9–1.4 s, the source clock 40 ppm SLOW: K
# rises 2.6 ms over the run, which only exact readings can follow (a bound cannot).
vbr, vbr_log = tp_run(PRODUCER, seconds=64, skew_ppm=-40.0, **SWING)
vbr_alone, _ = tp_run(None, seconds=64, skew_ppm=-40.0, **SWING)
print(f"    tsdemux alone under the swing: {min(r[2] for r in vbr_alone):+.0f} … "
      f"{max(r[2] for r in vbr_alone):+.0f} ms off content time")
check("(b) the fixture's swing reaches tsdemux (its own error walks > 100 ms)",
      max(r[2] for r in vbr_alone) - min(r[2] for r in vbr_alone) > 100)
_t0 = vbr[0][3]
_early = [r[2] for r in vbr if r[3] - _t0 < 10e9]
_late = [r[2] for r in vbr if r[3] - _t0 > 54e9]
_slope = trend_ms_per_s(vbr)
check(f"(b) 64 s under the swing: worst {worst(vbr):.3f} ms, trend {_slope * 1e3:+.4f} ms per "
      f"1000 s, first vs last 10 s {sum(_late) / len(_late) - sum(_early) / len(_early):+.4f} ms",
      worst(vbr) <= 20 and abs(_slope) < 0.001
      and abs(sum(_late) / len(_late) - sum(_early) / len(_early)) < 1)
check("(b) nothing dropped over the run",
      len(vbr) > 4000 and [r[:2] for r in vbr] == [r[:2] for r in vbr_alone])

# (c) A 427 s source rewind mid-feed (the gate's replay loops every 427 s).
rew, rew_log = tp_run(PRODUCER, seconds=40, jump_at_s=20.0, skew_ppm=40.0, **SWING)
check(f"(c) across the rewind the timeline is continuous (largest backward step "
      f"{back_step(rew):.3f} ms) and on content time (worst {worst(rew):.3f} ms)",
      len(rew) > 2500 and back_step(rew) <= 20 and worst(rew) <= 20)
check("(c) the rewind opened a fresh stamp epoch, predicted, then put on its own stamps",
      "PTS discontinuity -42" in rew_log and "epoch #1 on its stamps" in rew_log)

# (d) B-frames: decode order and every PTS−DTS distance survive the rewrite.
vid = [r for r in vbr if r[0] == fx.VIDEO_PID]
_reordered = sum(1 for r in vid if r[3] - r[4] >= 40_000_000)
_kept = max(abs(r[2] - r[5]) for r in vid)
check(f"(d) B-frames: DTS strictly increasing, on content time, PTS−DTS kept "
      f"(worst change {_kept * 1e3:.1f} µs over {_reordered} reordered AUs)",
      all(b[4] > a[4] for a, b in zip(vid, vid[1:])) and _reordered > 300 and _kept < 0.1
      and max(abs(r[5]) for r in vid) <= 20)

# (e) The mux path is untouched: same verdict, same bound, no retime.
mux, mux_log = tp_run({"demuxes": ["demux"]}, seconds=12)
check("(e) mux mode unchanged: a transform input's −1.1 s correction is still REJECTED "
      "(1 s mux bound) and the branch left as-is",
      "REJECTED" in mux_log and "retime" not in mux_log and all(r[2] > 1000 for r in mux))

# A bus buffer lost upstream: the next stamp may be the lost one's floor, read as
# moved (the two-reading minimum keeps K), and tsdemux discards the PES after the
# gap, which the join must skip although every tail here repeats (timed join).
lost, _ = tp_run(PRODUCER, seconds=12, drop=lost_floor_raiser)
check(f"a bus buffer lost upstream costs only its own access units — K holds, the join "
      f"stays in step (worst {worst(lost):.3f} ms over {len(lost)} AUs)",
      worst(lost) <= 20 and len(lost) > 800)


# (f) Mutations: each disables one mechanism and must FAIL the check that pins it.
def mutated(patch, fn):
    saved = {k: getattr(rt, k) for k in patch}
    for k, v in patch.items():
        setattr(rt, k, v)
    try:
        return fn()
    finally:
        for k, v in saved.items():
            setattr(rt, k, v)


_read, _sample, _join = rt.read, rt.sample, rt.join


def _read_latest(st, e, s):
    e.last_read = None                  # K = this reading alone
    _read(st, e, s)


def _join_by_order(st, ps, tail, ts):
    ps["off"] = None                    # no tsdemux timing: order alone
    return _join(st, ps, tail, ts)


def _sample_never_moved(st, stamp, a, b):
    st["prev_stamp"] = None             # no stamp ever reads as moved
    _sample(st, stamp, a, b)


m1 = mutated({"k_for": lambda au: None}, lambda: tp_run(PRODUCER)[0])
check(f"(f) mutant, retime off: (a) fails — access units on tsdemux's PCR lead "
      f"(worst {worst(m1):.0f} ms)", not worst(m1) <= 20)
m2 = mutated({"HOLD_MS": 0.0},
             lambda: [tp_run(PRODUCER, start_s=s)[0] for s in (2.697, 3.91, 2.597, 1.3)])
check("(f) mutant, no start-up hold: the first access units ride the upper bound, (a) fails",
      not all(firsts_ok(r) and worst(r) <= 20 for r in m2))
m3 = mutated({"BACK_TICKS": 1 << 40, "FWD_TICKS": 1 << 40},
             lambda: tp_run(PRODUCER, seconds=40, jump_at_s=20.0, skew_ppm=40.0, **SWING)[0])
check(f"(f) mutant, no stamp epochs: (c) fails across the rewind (worst {worst(m3):.0f} ms)",
      not (back_step(m3) <= 20 and worst(m3) <= 20))
m4 = mutated({"read": _read_latest},
             lambda: tp_run(PRODUCER, seconds=12, drop=lost_floor_raiser)[0])
check(f"(f) mutant, K = the latest reading: the lost-buffer check fails (worst {worst(m4):.0f} ms)",
      not worst(m4) <= 20)
m6 = mutated({"join": _join_by_order},
             lambda: tp_run(PRODUCER, seconds=12, drop=lost_floor_raiser)[0])
check(f"(f) mutant, join by order alone: after the loss every repeated tail locks one AU "
      f"off and the lost-buffer check fails (worst {worst(m6):.0f} ms)", not worst(m6) <= 20)
m5 = mutated({"sample": _sample_never_moved},
             lambda: tp_run(PRODUCER, seconds=64, skew_ppm=-40.0, **SWING)[0])
check(f"(f) mutant, no exact readings (K = the stamps' upper bound): (b) fails — the bound "
      f"cannot follow a slow source clock (trend {trend_ms_per_s(m5) * 1e3:+.2f} ms per 1000 s)",
      not abs(trend_ms_per_s(m5)) < 0.001)

print("\n--- 7. the retime estimator, pure: readings, rule, epochs, wrap ---")
NS = ts_timeline.pts90k_to_ns
K0, P, J, W = 7_000 * 10**9, 1_000 * 90000, 427 * 90000, 1 << 33
_cap7, _old7 = _io.StringIO(), sys.stderr
sys.stderr = _cap7
try:
    s7 = rt.new_state("pure")
    i0 = rt.on_pes(s7, 0x100, P, P - 3600)
    rt.sample(s7, K0 + NS(P), i0, i0)            # first buffer: no previous stamp
    first_bound = i0.e.k is None and i0.e.ub == K0
    p1 = rt.on_pes(s7, 0x100, P + 10800, P)
    rt.sample(s7, K0 + NS(P + 10800), p1, p1)    # moved: exact
    exact = p1.e.k == K0 and p1.e.reads == 1
    b1 = rt.on_pes(s7, 0x100, P + 3600, None)       # B, 80 ms back: same epoch
    rt.sample(s7, K0 + NS(P + 10800), b1, b1)    # clamped to the P's stamp
    clamped = b1.e is p1.e and b1.e.k == K0 and b1.e.reads == 1
    e = p1.e
    steps = []
    for r in (K0 + 300_000_000, K0, K0 + 200_000_000, K0 + 200_000_000, K0 + 150_000_000):
        rt.read(s7, e, r)
        steps.append(e.k - K0)
    s8 = rt.new_state("pure-rule")
    s8["pcr_pid"] = 0x100
    for n in range(3):                                      # audio PES first, stamped by the video
        au = rt.on_pes(s8, 0x101, P - 90000 + n * 1920, None)
        v = rt.on_pes(s8, 0x100, P + n * 3600, P + n * 3600 - 3600)
        rt.sample(s8, K0 + NS(P + n * 3600), au, v)
    rule = s8["rule"] == "pcr" and v.e.k == K0
    s9 = rt.new_state("pure-epoch")
    for n in range(10):
        a9 = rt.on_pes(s9, 0x101, P - 90000 + n * 1920, None)
        v9 = rt.on_pes(s9, 0x100, P + n * 3600 + 3600, P + n * 3600)
        rt.sample(s9, K0 + NS(P + n * 3600 + 3600), v9, v9)
    old = v9
    jv = rt.on_pes(s9, 0x100, P + 40 * 900 + 3600 - J, P + 40 * 900 - J)
    ja = rt.on_pes(s9, 0x101, P - 90000 + 10 * 1920 - J, None)
    fresh = jv.e is not old.e and jv.e.seq == 1 and jv.e.pred == K0 + NS(J) and ja.e is jv.e
    rt.sample(s9, K0 + NS(J) + NS(P + 40 * 900 + 3600 - J), jv, jv)
    epoch_k = jv.e.k == K0 + NS(J) and rt.k_for(old) == K0 and s9["seq"] == 2
    s10 = rt.new_state("pure-wrap")
    w1 = rt.on_pes(s10, 0x100, W - 3600, W - 7200)
    w2 = rt.on_pes(s10, 0x100, 0, W - 3600)
    wrap = w2.e is w1.e and w2.u == W and w2.du == W - 3600
    _pk = fx._pes(0x100, 0xE0, P + 7200, P, 1, 1, {0x100: 0}, False)[0]
    dts_parse = rt.pes_dts(_pk[4:]) == P
finally:
    sys.stderr = _old7
check("a buffer with no previous stamp only bounds K; a moved stamp reads it exactly",
      first_bound and exact)
check("a stamp clamped to the floor (B-frame, 80 ms back, same epoch) only bounds K",
      clamped)
check(f"K = the lower of the last two readings: a lone +300 ms reading never lands, a real "
      f"+200 ms step lands on its second reading, a drop at once (K−K0 per reading, ms: "
      f"{[x // 1_000_000 for x in steps]})", steps == [0, 0, 0, 200_000_000, 150_000_000])
check("an audio-first buffer stamped by its video PES: the PCR-PID rule is learned from the "
      "candidates that agree, and read exactly", rule)
check("a −427 s rewind opens epoch #1 predicted at K + 427 s; the other PID joins it",
      fresh)
check("the new epoch's first moved stamp replaces the prediction; old access units keep "
      "the old K", epoch_k)
check("a 33-bit PTS wrap stays in its epoch, unwrapped past 2^33 (DTS too)", wrap)
check("the PES DTS is read from the header", dts_parse)

print("\n--- 8. an mpegts-muxer's inputs: one retime per demux, different producers ---")
# The muxer's inputs are N demuxes in ONE pipeline, each on its own producer's
# stamps — a splitter's AAC leg (anchored, swinging, rewinding) beside a
# transcoder's identity egress (K = −3600 s). K, epochs, hold and join are per demux.
MUX = {"demuxes": ["demux_0", "demux_1"], "transformProducer": True}
_p8 = Gst.parse_launch("appsrc ! tsdemux name=demux_0  appsrc ! tsdemux name=demux_1")
runner._install_branch_stamp_align(_p8, MUX)
s0, s1 = runner._branch_align["demux_0"], runner._branch_align["demux_1"]
_shared = [k for k, v in s0.items() if not callable(v) and v is s1[k]
           and isinstance(v, (list, dict, set, bytearray, _collections.deque))]
for n in range(4):                      # demux_0's stamp never moves, demux_1's does
    a8 = rt.on_pes(s0, 0x101, P + n * 1920, None)
    rt.sample(s0, K0 + NS(P), a8, a8)
    v8 = rt.on_pes(s1, 0x100, P + n * 3600, None)
    rt.sample(s1, -3600 * 10**9 + NS(P + n * 3600), v8, v8)
runner._clear_branch_align()
check(f"(a) two demuxes, two retime states, nothing mutable shared ({_shared or 'none'}); "
      f"readings stay per demux: demux_1 exact at K = −3600 s, demux_0 still holding on a bound",
      s0 is not s1 and not _shared and s1["exact"] and v8.e.k == -3600 * 10**9
      and not s0["exact"] and a8.e.k is None and a8.e.ub is not None)

MUX_FEED, MUX_TARGETS, K_SPLITTER = fx.mux_inputs(70, jump_at_s=40.0)


def mux_run(cfg):
    """The two-input feed through two demuxes in one pipeline: per-PID errors (ms) and the log."""
    cap, old = _io.StringIO(), sys.stderr
    sys.stderr = cap
    try:
        rows = fx.run_demuxes(Gst, MUX_FEED, MUX_TARGETS,
                              install=lambda p: runner._install_branch_stamp_align(p, cfg))
    finally:
        sys.stderr = old
        runner._clear_branch_align()
    err = {}
    for pid, _s, e in rows:
        err.setdefault(pid, []).append(e / 1e6)
    return err, cap.getvalue()


def av_ok(err):
    every = [e for v in err.values() for e in v]
    return (len(err) == 2 and min(map(len, err.values())) > 1500
            and max(map(abs, every)) <= 5 and max(every) - min(every) <= 10)


def av_spread(err):
    every = [e for v in err.values() for e in v]
    return max(every) - min(every) if every else float("inf")


mux8, mux8_log = mux_run(MUX)
_k = {d: re.search(rf"{d} retime: released .*?K=(-?\d+)", mux8_log) for d in ("demux_0", "demux_1")}
check(f"(b) every access unit of both inputs on its content time, audio and video agree "
      f"(A/V spread {av_spread(mux8):.3f} ms over {sum(map(len, mux8.values()))} AUs, 70 s, a rewind)",
      av_ok(mux8))
check("(b) each demux read its own K — demux_0 the splitter's, demux_1 −3600 s exactly — and only "
      "demux_0 opened a stamp epoch",
      all(_k.values()) and abs(int(_k["demux_0"].group(1)) - K_SPLITTER) < 1_000_000
      and int(_k["demux_1"].group(1)) == -3600 * 10**9
      and "demux_0 retime: epoch #1 on its stamps" in mux8_log
      and not re.search(r"demux_1 retime: .*discontinuity", mux8_log))
ctl8, _ = mux_run({"demuxes": ["demux_0", "demux_1"]})
check(f"(c) mux mode on the same inputs: audio and video {av_spread(ctl8):.0f} ms apart, (b) fails",
      not av_ok(ctl8))
_rs, _one = rt.new_state, {}
m8, _ = mutated({"new_state": lambda name: _one or _one.update(_rs(name)) or _one}, lambda: mux_run(MUX))
check(f"(d) mutant, one retime state for both demuxes: (b) fails (A/V spread {av_spread(m8):.0f} ms)",
      not av_ok(m8))

print()
if _failures:
    print(f"{len(_failures)} FAILED: {', '.join(_failures)}")
    sys.exit(1)
print("All gst branch align tests passed.")
