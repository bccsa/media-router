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
# One repeat of an earlier access unit's payload: two PES sharing a tail cannot
# decide between themselves, and the index has to say so instead of picking.
# A trailing PES follows it, because an access unit is only closed — and only
# indexed — when the NEXT one starts.
cc = [0]
src.emit("push-buffer", Gst.Buffer.new_wrapped(
    pes_packets(PID, PES0 + 99 * 3600, adts_frame(0), cc)
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

# The join: every access unit's payload head maps back to ITS OWN PES PTS —
# except serial 0, whose payload was deliberately repeated at the end (below).
joined = 0
wrong = []
for pts, ser in serial_of.items():
    if ser == 0:
        continue
    head = adts_frame(ser)[-64:]
    got = state["byTail"].get(head) if state else None
    if got == pts:
        joined += 1
    else:
        wrong.append((ser, pts, got))
print(f"    payload-tail index: {joined}/{len(serial_of) - 1} access units joined "
      f"back to their own PES{'' if not wrong else f' (wrong: {wrong[:3]})'}")
check("every access unit is joinable by its payload tail",
      joined == len(serial_of) - 1)
check("a tail two access units share decides NOTHING (None, not a guess)",
      state is not None and state["byTail"].get(adts_frame(0)[-64:]) is None)

# What the branch would take, from the two measured quantities only: it emits
# access unit X while the demuxer hands back a CLAMPED buffer's stamp, so
# `K + ns(byTail[X]) − stamp` has to come out at exactly minus that clamp. This
# is the live video leg's case, in the small.
for i in clamped:
    emitted = LADDER[i][0]
    head = adts_frame(serial_of[emitted])[-64:]
    computed = (state["k"] + ns(state["byTail"][head]) - stamps[i]) if state else None
    clamp = stamps[i] - (K_TRUE + ns(emitted))
    print(f"    buffer {i}: clamp={clamp / 1e6:+.3f} ms → correction "
          f"{computed / 1e6 if computed is not None else None:+.3f} ms")
    check(f"a clamped buffer (#{i}) yields exactly minus its clamp",
          clamp > 0 and computed == -clamp)
runner._clear_branch_align()

# A PES the demuxer will DISCARD (it sits ahead of the PSI) is still indexed and
# still counts toward K — the join decides what the branch emitted, so the index
# must carry everything and prejudge nothing. Skipping those PES is what made the
# first cut measure a K short by exactly the discarded media.
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
# (The 5th is still OPEN — an access unit is indexed when the next one starts —
# so the first four are what this buffer can prove.)
check("every PES in the buffer is indexed, discarded or not",
      state is not None
      and all(state["byTail"].get(adts_frame(100 + i)[-64:]) == PES0 + i * 3600
              for i in range(4)))
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

print()
if _failures:
    print(f"{len(_failures)} FAILED: {', '.join(_failures)}")
    sys.exit(1)
print("All gst branch align tests passed.")
