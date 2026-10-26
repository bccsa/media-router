#!/usr/bin/env python3
"""The GStreamer behaviours Phase 4 builds on, pinned before anything depends on them (house-clock
plan chapter 8 WI-P4-1, R10; register B-160). The CI cases run in the Python runner's interpreter
on the clock both runners give every pipeline (the monotonic system clock, base_time 0); case 1
also runs inside both runners:

  1. a sync=false sink renders every buffer stamped 5 s late and sends no QoS upstream; with
     qos=true it still sends QoS (jitter 0); max-lateness does nothing without sync; inside
     mr-gst-runner and gst-pipeline-runner.py a sync=false sink drops nothing (get_stats);
  2. avdec_h264 qos=false (the player's Pi 5 rung) outputs every frame of a P-frame stream through
     a far-ahead QoS event, but still skips a B-frame stream's non-reference frames: gst-libav's
     hurry-up reads the base class's earliest time, which every QoS event sets whatever `qos`
     says; with no QoS event every frame comes out. After a 2 s step back with DISCONT and no new
     segment the decoder sends the next second at the last PTS it sent (GstVideoDecoder's
     decreasing-timestamp clamp): nothing lost at a qos=false sink, the non-reference frames at a
     qos=true one; a new segment clears it;
  3. videoconvert qos=false converts every frame through that event (qos=true, its default,
     skips them);
  4. a GAP at a sync=false sink renders nothing and the next buffer goes at once (the audio half
     on p3-5's mrtestaudiosink); a GAP before caps at an audio base sink is an element error, and
     the outputs' GstAudioDecoders (avdec_aac, opusdec, avdec_s302m) negotiate default caps
     before they forward one;
  5. queue, leaky=0 and leaky=2, emits `overrun` once for each buffer that meets it full, none
     when silent; queue2 has no `overrun` signal and no `leaky` property (S14).

Gate cases (MR_GATE=1, on a box as the engine user, XDG_RUNTIME_DIR=/run/user/1001), each
recorded as JSON under MR_GATE_OUT:

  6. pulsesink sync=false in the audio-decoder's form across a 300 ms hole: the clock runs on,
     the sink's monitor hears every sample pushed, no `dropping` line from audiobasesink (a
     pulsesink older than its base library, the dev Pi's, is recorded, not judged);
  7. the sink's provided clock against CLOCK_MONOTONIC across a hole, a 1 s underrun behind a
     40 ms prefill and a restart (tools/output-check/sink_clock_trace.py), recorded, not judged;
  8. the device stops taking data, suspended and its node removed: does render block, discard or
     run on a timer, and how long until the clock moves again, recorded (Q2);
  9. waylandsink sync=false, 10 frames inside one refresh: 0007's compositor replaces them
     where the sink's count cannot see it, so the fault is judged from 0008's feedback with
     present-every-frame=false, and with it true every frame shows (DEV-P4b; 0007 alone: recorded);
 10. kmssink sync=false with Weston stopped: show_frame blocks one refresh; with the connector
     off (DPMS) what it does, recorded.

MR_GATE_CASES=6,7 runs only those (any case number). Gate settings: MR_GATE_PULSE_SINK (default:
a null sink the case loads and unloads), MR_GATE_SUSPEND_SINK, MR_GATE_CARD with
MR_GATE_CARD_PROFILE (case 8's node removal by card profile), MR_GATE_KMS_CONNECTOR,
MR_GATE_REFRESH_HZ. Skips (exit 0) without GStreamer; a case whose element is absent skips with a
line."""
import array
import glob
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
import threading
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    gi.require_version("GstAudio", "1.0")
    from gi.repository import GObject, Gst, GstAudio
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_no_late_drop_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

Gst.init([])

S = Gst.SECOND
MS = Gst.MSECOND
NONE = Gst.CLOCK_TIME_NONE
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", "..", "..", ".."))
TEST_SINKS = os.path.join(REPO, "plugins", "mpegts-core", "native", "mrtshouse", "tests")
PCM_CAPS = "audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved"
PCM_10MS = 480 * 4                         # one 10 ms buffer of PCM_CAPS
PCM_TONE = array.array("h", [0x2000] * 960).tobytes()   # 10 ms that sound, for the monitor

# Case 1's sink: sync=false, as Phase 4 runs every output.
LATE_SINK = "fakesink name=fs sync=false"
# Case 2's decoder: the player's software H.264 rung (decoderSelection.ts), qos off.
H264_DEC = "avdec_h264 name=dec thread-type=frame max-threads=3 qos=false"
# Case 3's converter, qos off.
CONVERT = "videoconvert name=vc qos=false"
# Case 5: the element p4-5's queue watch connects `overrun` on (S14).
WATCHED = "queue"

_failures = []


def check(name, cond, info=""):
    print(("PASS " if cond else "FAIL ") + name + (f" ({info})" if info else ""))
    if not cond:
        _failures.append(name)


def skip(name, why):
    print(f"SKIP {name} — {why}")


def missing(*factories):
    return [f for f in factories if Gst.ElementFactory.find(f) is None]


def mono():
    return time.clock_gettime_ns(time.CLOCK_MONOTONIC)


def house(pipe):
    """The clock both runners give every pipeline: monotonic system clock, base_time 0."""
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
    pipe.use_clock(clock)
    pipe.set_start_time(NONE)
    pipe.set_base_time(0)


def wanted(case):
    only = os.environ.get("MR_GATE_CASES")
    return not only or str(case) in [c.strip() for c in only.split(",")]


class Harness:
    """`desc` in a pipeline on the house clock, fed from a test src pad into the element named
    `first`; bus errors and the downstream events at `last`'s sink pad recorded."""

    def __init__(self, desc, first, last=None):
        self.pipe = Gst.Pipeline.new(None)
        self.pipe.add(Gst.parse_bin_from_description(desc, False))
        house(self.pipe)
        self.src = Gst.Pad.new("h_src", Gst.PadDirection.SRC)
        self.src.link(self.pipe.get_by_name(first).get_static_pad("sink"))
        self.src.set_active(True)
        self.errors, self.events = [], []
        self.pipe.get_bus().set_sync_handler(self._on_message)
        if last:
            self.pipe.get_by_name(last).get_static_pad("sink").add_probe(
                Gst.PadProbeType.EVENT_DOWNSTREAM, self._on_event)

    def _on_message(self, _bus, msg):
        if msg.type == Gst.MessageType.ERROR:
            err, dbg = msg.parse_error()
            self.errors.append(f"{msg.src.get_name()}: {err.message} {dbg or ''}")
        return Gst.BusSyncReply.DROP

    def _on_event(self, _pad, info):
        ev = info.get_event()
        self.events.append((ev.type, ev.parse_caps().to_string() if ev.type == Gst.EventType.CAPS else ""))
        return Gst.PadProbeReturn.OK

    def start(self, caps=None):
        ret = self.pipe.set_state(Gst.State.PLAYING)
        self.src.push_event(Gst.Event.new_stream_start("p4-1"))
        if caps:
            self.src.push_event(Gst.Event.new_caps(Gst.Caps.from_string(caps)))
        seg = Gst.Segment()
        seg.init(Gst.Format.TIME)
        self.src.push_event(Gst.Event.new_segment(seg))
        return ret

    def push(self, pts, size=188, dur=20 * MS):
        b = Gst.Buffer.new_wrapped(b"\0" * size)
        b.pts, b.duration = pts, dur
        return self.src.push(b)

    def stop(self):
        self.pipe.set_state(Gst.State.NULL)


# --------------------------------------------------------------------------- 1: late buffers
def late_feed(sink, n=50, late=5 * S):
    """n buffers stamped `late` behind the house clock, 20 ms apart, through appsrc ! identity
    into `sink` (named fs): (rendered, dropped, the QoS events seen upstream of the sink)."""
    pipe = Gst.parse_launch("appsrc name=src is-live=true format=time caps=application/x-test"
                            f" ! identity name=up ! {sink}")
    house(pipe)
    src, fs = pipe.get_by_name("src"), pipe.get_by_name("fs")
    qos = []

    def upstream(_pad, info):
        ev = info.get_event()
        if ev.type == Gst.EventType.QOS:
            qos.append(ev.parse_qos())
        return Gst.PadProbeReturn.OK

    pipe.get_by_name("up").get_static_pad("sink").add_probe(Gst.PadProbeType.EVENT_UPSTREAM, upstream)
    pipe.set_state(Gst.State.PLAYING)
    pipe.get_state(5 * S)
    for _ in range(n):
        b = Gst.Buffer.new_wrapped(b"\0" * 188)
        b.pts, b.duration = mono() - late, 20 * MS
        src.emit("push-buffer", b)
        time.sleep(0.02)
    time.sleep(0.2)
    st = fs.get_property("stats")
    pipe.set_state(Gst.State.NULL)
    return st.get_value("rendered"), st.get_value("dropped"), qos


def in_runners():
    """The sink inside both runners, whose base_time 0 makes a non-live source's stamps (from 0)
    late by the box's uptime: rendered and dropped from the runner's get_stats."""
    try:
        import aligner_rig as rig
    except ImportError as exc:
        skip("1: inside both runners", f"the runner rig does not import ({exc})")
        return
    kinds = rig.runner_kinds()
    if not any(k == "native" for k, _ in kinds):
        skip("1: inside mr-gst-runner", f"{rig.NATIVE_BIN} not built (make native)")
    desc = ("videotestsrc pattern=black ! video/x-raw,width=16,height=16,framerate=100/1"
            f" ! identity sleep-time=10000 ! {LATE_SINK}")
    for kind, argv in kinds:
        r = rig.Runner(argv)
        try:
            playing = r.start({"pipeline": desc, "useStdioForData": False, "linkOnPadAdded": [],
                               "busReports": [], "decoderThreadType": "auto"})
            time.sleep(1.0)
            got = r.request({"cmd": "get_stats", "element": "fs"}, "stats")
            data = (got[1].get("data") or {}) if got else {}
            clock = any("contract clock: monotonic, base_time=0" in line for line in r.logs)
            check(f"1: inside {kind}: a sync=false sink renders buffers late by the uptime, drops none",
                  playing is not None and clock and data.get("rendered", 0) > 50 and data.get("dropped") == 0,
                  f"rendered {data.get('rendered')}, dropped {data.get('dropped')}, base_time 0 {clock}")
        finally:
            r.stop()


def case1():
    rendered, dropped, qos = late_feed(LATE_SINK)
    check("1: a sync=false sink renders all 50 buffers stamped 5 s late",
          rendered == 50 and dropped == 0, f"rendered {rendered}, dropped {dropped}")
    check("1: ... and sends no QoS event upstream", not qos, f"{len(qos)} QoS events")
    rendered, dropped, qos = late_feed("fakesink name=fs sync=false qos=true")
    check("1: with qos=true a sync=false sink still sends QoS upstream, each with jitter 0",
          rendered == 50 and len(qos) > 0 and all(q.diff == 0 for q in qos),
          f"{len(qos)} QoS events, rendered {rendered}")
    rendered, dropped, _ = late_feed("fakesink name=fs sync=false max-lateness=20000000")
    check("1: max-lateness=20 ms does nothing at a sync=false sink", rendered == 50 and dropped == 0,
          f"rendered {rendered}, dropped {dropped}")
    in_runners()


# --------------------------------------------------------------------------- 2: decoder QoS
def h264(bframes, n=100):
    """n 320x240 50p frames from x264enc (one access unit a buffer) and, per frame, whether its
    slice is a non-reference one (nal_ref_idc 0)."""
    pipe = Gst.parse_launch(
        f"videotestsrc num-buffers={n} pattern=ball"
        " ! video/x-raw,format=I420,width=320,height=240,framerate=50/1"
        f" ! x264enc tune=zerolatency bframes={bframes} b-pyramid=false key-int-max=50"
        " ! h264parse ! video/x-h264,stream-format=byte-stream,alignment=au ! appsink name=out sync=false")
    out = pipe.get_by_name("out")
    pipe.set_state(Gst.State.PLAYING)
    bufs, caps = [], None
    while True:
        sample = out.emit("try-pull-sample", 10 * S)
        if sample is None:
            break
        caps = sample.get_caps()
        bufs.append(sample.get_buffer())
    pipe.set_state(Gst.State.NULL)
    return caps, bufs, [nonref(b) for b in bufs]


def nonref(au):
    data = au.extract_dup(0, au.get_size())
    i = data.find(b"\x00\x00\x01")
    while 0 <= i < len(data) - 3:
        hdr = data[i + 3]
        if (hdr & 0x1F) in (1, 5):               # a coded slice
            return ((hdr >> 5) & 3) == 0
        i = data.find(b"\x00\x00\x01", i + 3)
    return False


def decode(caps, bufs, element, qos_event):
    """appsrc ! element ! fakesink. Once a frame is out, an upstream QoS event at the element's
    src pad puts the earliest time 10 s past the last frame (sent earlier, the decoder's first
    segment would clear it). (frames out, frames pushed before the event)."""
    pipe = Gst.parse_launch(f"appsrc name=src format=time ! {element} ! fakesink name=fs sync=false async=false")
    src, el = pipe.get_by_name("src"), pipe.get_by_name("dec") or pipe.get_by_name("vc")
    src.set_property("caps", caps)
    out = []
    pipe.get_by_name("fs").get_static_pad("sink").add_probe(
        Gst.PadProbeType.BUFFER, lambda _pad, _info: out.append(1) or Gst.PadProbeReturn.OK)
    pipe.set_state(Gst.State.PLAYING)
    pipe.get_state(5 * S)
    i = 0
    while not out and i < len(bufs):
        src.emit("push-buffer", bufs[i])
        i += 1
        t = time.monotonic()
        while not out and time.monotonic() - t < 0.2:
            time.sleep(0.005)
    if qos_event:
        far = max(b.pts for b in bufs) + 10 * S
        el.get_static_pad("src").send_event(Gst.Event.new_qos(Gst.QOSType.UNDERFLOW, 1.0, 0, far))
    for b in bufs[i:]:
        src.emit("push-buffer", b)
    src.emit("end-of-stream")
    pipe.get_bus().timed_pop_filtered(30 * S, Gst.MessageType.EOS | Gst.MessageType.ERROR)
    pipe.set_state(Gst.State.NULL)
    return len(out), i


STEP_BACK = 2010 * MS                       # off the 20 ms grid: no stepped PTS meets an earlier one


def step_back(caps, bufs, sink_qos, new_segment):
    """bufs pushed from a pad into H264_DEC ! fakesink sync=false, the last 50 stamped STEP_BACK
    earlier, the first of them DISCONT (a new SEGMENT before it if asked): (frames out, frames out
    at the last PTS before the step, steps back in the output PTS)."""
    h = Harness(f"{H264_DEC} ! fakesink name=fs sync=false async=false qos={sink_qos}", "dec")
    out, eos = [], threading.Event()
    pad = h.pipe.get_by_name("fs").get_static_pad("sink")
    pad.add_probe(Gst.PadProbeType.BUFFER, lambda _p, i: out.append(i.get_buffer().pts) or Gst.PadProbeReturn.OK)
    pad.add_probe(Gst.PadProbeType.EVENT_DOWNSTREAM,
                  lambda _p, i: (i.get_event().type == Gst.EventType.EOS and eos.set()) or Gst.PadProbeReturn.OK)
    h.start(caps.to_string())
    k0 = len(bufs) - 50
    for k, b in enumerate(bufs):
        b2 = b.copy_deep()                  # copy() gives the same buffer again on PyGObject 3.42
        if k >= k0:
            b2.pts = b.pts - STEP_BACK
            b2.dts = b.dts - STEP_BACK if b.dts != NONE else NONE
        if k == k0:
            if new_segment:
                seg = Gst.Segment()
                seg.init(Gst.Format.TIME)
                h.src.push_event(Gst.Event.new_segment(seg))
            b2.set_flags(Gst.BufferFlags.DISCONT)
        h.src.push(b2)
    h.src.push_event(Gst.Event.new_eos())
    eos.wait(10)
    h.stop()
    last = max(b.pts for b in bufs[:k0])
    return len(out), sum(1 for p in out if p == last), sum(1 for a, b in zip(out, out[1:]) if b < a)


def case2():
    gone = missing("x264enc", "h264parse", "avdec_h264")
    if gone:
        skip("2: decoder QoS", f"no {', '.join(gone)}")
        return
    caps, bufs, _ = h264(0)
    n = len(bufs)
    out, _ = decode(caps, bufs, H264_DEC, True)
    check("2: P-frame stream: avdec_h264 qos=false outputs every frame through a far-ahead QoS event",
          out == n == 100, f"{out} of {n}")
    out, _ = decode(caps, bufs, H264_DEC.replace("qos=false", "qos=true"), True)
    check("2: control: qos=true drops them on the same event", out < n // 2, f"{out} of {n}")
    caps, bufs, refs = h264(2)
    n = len(bufs)
    out, _ = decode(caps, bufs, H264_DEC, False)
    check("2: B-frame stream, no QoS event: every frame", out == n == 100, f"{out} of {n}, "
          f"{sum(refs)} non-reference")
    out, before = decode(caps, bufs, H264_DEC, True)
    skippable = sum(refs[before:])
    check("2: B-frame stream, qos=false, the QoS event: gst-libav still skips non-reference frames",
          skippable > 0 and n - skippable <= out < n,
          f"{out} of {n}; {skippable} non-reference after the event; qos=false alone does not stop it")
    caps, bufs, refs = h264(2, n=150)
    nonref = sum(refs[100:])
    n, frozen, back = step_back(caps, bufs, "false", False)
    check("2: 2 s back with DISCONT, no new segment: avdec_h264 sends the 50 frames after the step at the last PTS "
          "it sent (GstVideoDecoder's decreasing-timestamp clamp), none lost at a sink with qos=false",
          n == 150 and frozen == 51 and back == 0, f"{n} of 150 out, {frozen} at that PTS, {back} steps back")
    n, frozen, back = step_back(caps, bufs, "true", False)
    check("2: ... at a sync=false sink with qos=true the stretch's non-reference frames are lost, the decoder's "
          "qos=false notwithstanding", 0 < 150 - n <= nonref, f"{150 - n} lost, {nonref} non-reference after the step")
    n, frozen, back = step_back(caps, bufs, "false", True)
    check("2: a new SEGMENT at the step clears it: the PTS step back, none held, none lost",
          n == 150 and frozen == 1 and back == 1, f"{n} of 150 out, {frozen} at the last PTS, {back} steps back")


# --------------------------------------------------------------------------- 3: convert QoS
def case3():
    if missing("videoconvert"):
        skip("3: videoconvert QoS", "no videoconvert")
        return
    caps = Gst.Caps.from_string("video/x-raw,format=I420,width=64,height=48,framerate=50/1")
    bufs = []
    for i in range(60):
        b = Gst.Buffer.new_wrapped(b"\x80" * (64 * 48 * 3 // 2))
        b.pts, b.duration = i * 20 * MS, 20 * MS
        bufs.append(b)
    to_bgrx = " ! video/x-raw,format=BGRx"
    out, _ = decode(caps, bufs, CONVERT + to_bgrx, True)
    check("3: videoconvert qos=false converts every frame through a far-ahead QoS event", out == 60,
          f"{out} of 60")
    out, _ = decode(caps, bufs, CONVERT.replace("qos=false", "qos=true") + to_bgrx, True)
    check("3: control: qos=true (videoconvert's default) skips them", out < 30, f"{out} of 60")


# --------------------------------------------------------------------------- 4: GAP
def load_test_sinks():
    """p3-5's mrtestaudiosink, from the test library it builds under mrtshouse/tests/."""
    for so in glob.glob(os.path.join(TEST_SINKS, "**", "*.so"), recursive=True):
        if Gst.ElementFactory.find("mrtestaudiosink"):
            break
        Gst.Plugin.load_file(so)
    return Gst.ElementFactory.find("mrtestaudiosink") is not None


def gap_video():
    h = Harness("fakesink name=fs sync=false async=false", "fs")
    fs = h.pipe.get_by_name("fs")
    h.start("application/x-test")
    now = mono()
    h.push(now)
    before = fs.get_property("stats").get_value("rendered")
    h.src.push_event(Gst.Event.new_gap(now + 20 * MS, S))
    at_gap = fs.get_property("stats").get_value("rendered")
    t0 = mono()
    flow = h.push(now + 20 * MS + S)
    took = mono() - t0
    after = fs.get_property("stats").get_value("rendered")
    h.stop()
    check("4: a GAP at a sync=false sink renders nothing", before == at_gap == 1, f"rendered {before} -> {at_gap}")
    check("4: the next buffer, 1 s ahead of the clock after the GAP, renders at once",
          flow == Gst.FlowReturn.OK and after == 2 and took < 50 * MS, f"{took / MS:.1f} ms")


def gap_audio(sink_desc, label):
    """A paced audio sink, sync=false: 100 ms of PCM, a 300 ms GAP, 400 ms later 10 ms more. The GAP
    commits nothing and the next samples go at the next playable position, past the device
    (gstaudiobasesink.c gst_audio_base_sink_get_offset), none dropped."""
    h = Harness(sink_desc, "as")
    sink = h.pipe.get_by_name("as")
    h.start(PCM_CAPS)
    now = mono()
    for k in range(10):
        h.push(now + k * 10 * MS, PCM_10MS, 10 * MS)
    n0 = sink.next_sample
    h.src.push_event(Gst.Event.new_gap(now + 100 * MS, 300 * MS))
    n1 = sink.next_sample
    time.sleep(0.4)
    flow = h.push(now + 400 * MS, PCM_10MS, 10 * MS)
    n2 = sink.next_sample
    h.stop()
    check(f"4: {label}: a GAP at a sync=false audio sink writes no silence", n1 == n0,
          f"next sample {n0} -> {n1}")
    check(f"4: {label}: the next samples go at the next playable position, none dropped",
          flow == Gst.FlowReturn.OK and n2 - 480 > n0 and not h.errors,
          f"written at {n2 - 480}, after {n0}; errors {h.errors}")


def gap_before_caps():
    """GAP before caps: the audio base sink errors (gstaudiobasesink.c gst_audio_base_sink_wait_event);
    a GstAudioDecoder negotiates default caps first (gstaudiodecoder.c gst_audio_decoder_handle_gap).
    ALSA's null PCM is an audio base sink with no device; no timing is read off it."""
    if missing("alsasink", "audioconvert"):
        skip("4: GAP before caps", "no alsasink or audioconvert")
        return
    sink = "alsasink name=as device=null sync=false"
    h = Harness(sink, "as")
    if h.start() == Gst.StateChangeReturn.FAILURE:
        h.stop()
        skip("4: GAP before caps", "alsasink cannot open ALSA's null PCM here")
        return
    ok = h.src.push_event(Gst.Event.new_gap(mono(), 100 * MS))
    h.stop()
    check("4: a GAP before caps at an audio base sink is an element error",
          not ok and any("not negotiated before gap" in e for e in h.errors), "; ".join(h.errors)[:160])
    decoders = (("aacparse name=first ! avdec_aac",
                 "audio/mpeg,mpegversion=(int)4,stream-format=(string)adts,rate=(int)48000,channels=(int)2"),
                ("opusdec name=first", "audio/x-opus,channel-mapping-family=(int)0,channels=(int)2,rate=(int)48000"),
                ("avdec_s302m name=first", "audio/x-smpte-302m"))
    for dec, caps in decoders:
        factories = [w for w in dec.split() if w != "!" and "=" not in w]
        name = factories[-1]
        if missing(*factories):
            skip(f"4: {name} given an early GAP", f"no {', '.join(missing(*factories))}")
            continue
        h = Harness(f"{dec} ! audioconvert ! {sink}", "first", "as")
        h.start(caps)
        ok = h.src.push_event(Gst.Event.new_gap(mono(), 100 * MS))
        h.stop()
        kinds = [t for t, _ in h.events]
        got = next((c for t, c in h.events if t == Gst.EventType.CAPS), "")
        check(f"4: {name} given a GAP before its first frame negotiates default caps first",
              ok and not h.errors and Gst.EventType.GAP in kinds
              and Gst.EventType.CAPS in kinds[:kinds.index(Gst.EventType.GAP)],
              f"the sink got {got[:72]}")


def case4():
    gap_video()
    if load_test_sinks():
        gap_audio("mrtestaudiosink name=as sync=false", "mrtestaudiosink")
    else:
        skip("4: the audio half", "mrtestaudiosink (p3-5's test sink) is not built; it runs once p3-5 is in the base")
    gap_before_caps()


# --------------------------------------------------------------------------- 5: queue overrun
def overruns(factory, leaky, n=12, silent=False):
    """A max-size-buffers=2 queue whose output is let through one buffer at a time: b0 held at
    the exit, b1 and b2 fill it, and each later buffer meets it full once. Overruns counted."""
    pipe = Gst.Pipeline.new(None)
    q = Gst.ElementFactory.make(factory, "q")
    fs = Gst.ElementFactory.make("fakesink", "fs")
    fs.set_property("sync", False)
    fs.set_property("async", False)
    pipe.add(q)
    pipe.add(fs)
    q.link(fs)
    for prop, value in (("max-size-buffers", 2), ("max-size-bytes", 0), ("max-size-time", 0)):
        q.set_property(prop, value)
    if q.find_property("leaky"):
        q.set_property("leaky", leaky)
    if q.find_property("silent"):
        q.set_property("silent", silent)
    count = []
    try:
        q.connect("overrun", lambda *_a: count.append(1))
    except TypeError:
        return 0
    tokens, held = threading.Semaphore(0), threading.Event()

    def gate(_pad, _info):
        held.set()
        tokens.acquire()
        return Gst.PadProbeReturn.OK

    q.get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, gate)
    h = Gst.Pad.new("h_src", Gst.PadDirection.SRC)
    h.link(q.get_static_pad("sink"))
    h.set_active(True)
    pipe.set_state(Gst.State.PLAYING)
    h.push_event(Gst.Event.new_stream_start("q"))
    h.push_event(Gst.Event.new_caps(Gst.Caps.from_string("application/x-test")))
    seg = Gst.Segment()
    seg.init(Gst.Format.TIME)
    h.push_event(Gst.Event.new_segment(seg))

    def buf(i):
        b = Gst.Buffer.new_wrapped(b"\0" * 188)
        b.pts = i * 10 * MS
        return b

    h.push(buf(0))
    held.wait(2)
    pusher = threading.Thread(target=lambda: [h.push(buf(i)) for i in range(1, n)])
    pusher.start()
    if leaky == 0:
        for k in range(1, n - 2):          # let one through after each overrun: the next push meets it full
            t = time.monotonic()
            while len(count) < k and time.monotonic() - t < 2:
                time.sleep(0.002)
            tokens.release()
    pusher.join(5)
    for _ in range(n + 2):
        tokens.release()
    time.sleep(0.05)
    pipe.set_state(Gst.State.NULL)
    return len(count)


def case5():
    for leaky in (0, 2):
        got = overruns(WATCHED, leaky)
        check(f"5: {WATCHED} leaky={leaky} emits overrun once for each buffer that meets it full",
              got == 9, f"{got} for the 9 of 12 that met it full")
    got = overruns(WATCHED, 2, silent=True)
    check(f"5: a silent {WATCHED} emits none", got == 0, f"{got}")
    q2 = Gst.ElementFactory.make("queue2", None)
    check("5: queue2 has no overrun signal and no leaky property",
          GObject.signal_lookup("overrun", q2.__gtype__) == 0 and q2.find_property("leaky") is None)


# --------------------------------------------------------------------------- gate: shared
OUT = None


def record(name, obj):
    path = os.path.join(OUT, name)
    with open(path, "w") as f:
        json.dump(obj, f, indent=1)
    print(f"RECORD {path}")


def pactl(*args):
    r = subprocess.run(["pactl", *args], capture_output=True, text=True, timeout=15)
    return r.returncode, r.stdout.strip(), r.stderr.strip()


class NullSink:
    """A pulse null sink the case owns, made as the engine makes its own (loadNullSink)."""

    def __init__(self, name="mr_p41_gate"):
        self.name, self.module = name, None
        self.load()

    def load(self):
        rc, out, _ = pactl("load-module", "module-null-sink", f"sink_name={self.name}", "rate=48000",
                           "channels=2", f"sink_properties=device.description='{self.name}'")
        self.module = int(out) if rc == 0 and out.isdigit() else None
        return self.module is not None

    def unload(self):
        if self.module is not None:
            pactl("unload-module", str(self.module))
            self.module = None


def decoder_sink(device):
    """The audio-decoder's pulsesink as Phase 4 runs it: sync=false, no slave-method, no ts-offset."""
    return (f"pulsesink name=sink device={device} sync=false provide-clock=false"
            " processing-deadline=100000000 buffer-time=100000"
            ' stream-properties="props,node.dont-fallback=(string)true,node.linger=(string)true"')


# Case 6's child logs these to its GST_DEBUG_FILE (gate() sets both), kept as its record. A Python
# log function is not used: PyGObject aborts on a message naming an object in its finalization.
CASE6_DEBUG = "audiobasesink:6,pulse:6"


def debug_lines(path):
    """[(elapsed ns, category, message)] of a GST_DEBUG_FILE written with GST_DEBUG_NO_COLOR."""
    out = []
    try:
        with open(path, errors="replace") as f:
            for line in f:
                parts = line.split(None, 6)
                m = re.fullmatch(r"(\d+):(\d+):(\d+)\.(\d+)", parts[0]) if len(parts) == 7 else None
                if m:
                    h, mi, sec, frac = m.groups()
                    t = ((int(h) * 60 + int(mi)) * 60 + int(sec)) * S + int(frac.ljust(9, "0")[:9])
                    out.append((t, parts[4], parts[6].rstrip("\n")))
    except OSError:
        pass
    return out


class PulseFeed:
    """appsrc (PCM_CAPS, 10 ms buffers stamped with the house clock) ! sink on the house clock; a
    sampler reads the sink's provided clock every 10 ms, a probe times each buffer at the sink."""

    def __init__(self, sink_desc):
        self.pipe = Gst.parse_launch(f"appsrc name=src is-live=true format=time caps={PCM_CAPS} ! {sink_desc}")
        house(self.pipe)
        self.src, self.sink = self.pipe.get_by_name("src"), self.pipe.get_by_name("sink")
        self.clock = self.sink.provided_clock
        self.samples, self.arrivals, self.levels, self.errors = [], [], [], []
        self.pushed = 0
        self.sink.get_static_pad("sink").add_probe(
            Gst.PadProbeType.BUFFER, lambda _p, _i: self.arrivals.append(mono()) or Gst.PadProbeReturn.OK)
        self._stop = threading.Event()
        self._sampler = threading.Thread(target=self._sample, daemon=True)

    def _sample(self):
        while not self._stop.is_set():
            self.samples.append((mono(), self.clock.get_time()))
            self.levels.append((mono(), self.src.get_property("current-level-bytes")))
            msg = self.pipe.get_bus().pop_filtered(Gst.MessageType.ERROR)
            if msg is not None:
                self.errors.append(msg.parse_error()[0].message)
            time.sleep(0.01)

    def start(self):
        self.pipe.set_state(Gst.State.PLAYING)
        self._sampler.start()

    def play(self, seconds):
        """Push 10 ms buffers at the house rate for `seconds`."""
        t0, k = mono(), 0
        while k < seconds * 100:
            b = Gst.Buffer.new_wrapped(PCM_TONE)
            b.pts, b.duration = mono(), 10 * MS
            self.src.emit("push-buffer", b)
            self.pushed += 1
            k += 1
            time.sleep(max(0.0, (t0 + k * 10 * MS - mono()) / S))

    def stop(self):
        self.src.emit("end-of-stream")
        self.pipe.get_bus().timed_pop_filtered(3 * S, Gst.MessageType.EOS)
        self._stop.set()
        self._sampler.join(2)
        self.pipe.set_state(Gst.State.NULL)

    def clock_at(self, t):
        """The provided clock's reading nearest after monotonic time t."""
        return next((c for m, c in self.samples if m >= t), self.samples[-1][1] if self.samples else 0)


def played_sink():
    """(device name, the NullSink the case owns or None)."""
    name = os.environ.get("MR_GATE_PULSE_SINK")
    if name:
        return name, None
    own = NullSink()
    return (own.name if own.module is not None else None), own


# --------------------------------------------------------------------------- 6: pulsesink hole
def versions():
    """pulsesink's and GStreamer's versions. A pulsesink before 1.26 under a 1.26+ base library (the
    dev Pi's) sets the ring's position where the base class no longer reads it: recorded, not judged."""
    f = Gst.ElementFactory.find("pulsesink")
    plugin = f.get_plugin().get_version() if f else ""
    core = "%d.%d.%d" % Gst.version()[:3]
    return {"pulsesink": plugin, "gstreamer": core, "matched": plugin.split(".")[:2] == core.split(".")[:2]}


class Monitor:
    """The played sink's monitor source recorded: per chunk, its arrival and how many of its frames
    sound (|left| > 1000; PCM_TONE is 0x2000)."""

    def __init__(self, device):
        self.pipe = Gst.parse_launch(f"pulsesrc device={device}.monitor ! audio/x-raw,format=S16LE,rate=48000,"
                                     "channels=2 ! appsink name=a sync=false emit-signals=true")
        self.chunks = []
        self.pipe.get_by_name("a").connect("new-sample", self._on_sample)

    def _on_sample(self, sink):
        b = sink.emit("pull-sample").get_buffer()
        a = array.array("h", b.extract_dup(0, b.get_size()))
        self.chunks.append((mono(), len(a) // 2, sum(1 for v in a[0::2] if abs(v) > 1000)))
        return Gst.FlowReturn.OK

    def start(self):
        ok = self.pipe.set_state(Gst.State.PLAYING) != Gst.StateChangeReturn.FAILURE
        time.sleep(0.5)
        return ok

    def stop(self):
        time.sleep(0.7)
        self.pipe.set_state(Gst.State.NULL)
        return sum(s for _t, _n, s in self.chunks) / 48


def case6():
    device, own = played_sink()
    if device is None:
        skip("6: pulsesink across a hole", "no pulse sink: pactl could not load a null sink")
        return
    try:
        ver = versions()
        mon = Monitor(device)
        heard = mon.start()
        feed = PulseFeed(decoder_sink(device))
        feed.start()
        feed.play(2)
        hole_from = mono()
        time.sleep(0.3)
        hole_to = mono()
        feed.play(2)
        feed.stop()
        sounding = mon.stop() if heard else None
        ran = (feed.clock_at(hole_to) - feed.clock_at(hole_from)) / MS
        lines = debug_lines(os.environ.get("GST_DEBUG_FILE", ""))
        logged = sum(1 for _t, c, _m in lines if c == "audiobasesink")
        dropping = [m for _t, c, m in lines if c == "audiobasesink" and "dropping" in m]
        underflows = sum(1 for _t, c, m in lines if c == "pulse" and "underflow" in m)
        record("case6.json", {"device": device, "versions": ver, "clockRanOverHoleMs": ran,
                              "monitorSoundingMs": sounding, "pushedMs": feed.pushed * 10,
                              "audiobasesinkLines": logged, "droppingLines": dropping[:20],
                              "underflowWarnings": underflows, "errors": feed.errors, "clock": feed.samples,
                              "monitor": mon.chunks})
        if not ver["matched"]:
            skip("6: pulsesink across a hole", f"pulsesink {ver['pulsesink']} under GStreamer {ver['gstreamer']}: "
                 f"a mixed install, recorded only (sounding {sounding} of {feed.pushed * 10} ms)")
            return
        check("6: the sink clock runs on across the 300 ms hole", ran >= 250, f"+{ran:.0f} ms over 300")
        if sounding is not None:
            check("6: every sample plays: the sink's monitor hears all 4000 ms pushed around the hole",
                  abs(sounding - feed.pushed * 10) <= 20, f"{sounding:.0f} ms of {feed.pushed * 10}")
        else:
            skip("6: every sample plays", f"no monitor source {device}.monitor")
        # A GStreamer built without its debug log writes no lines: then this one is not judged.
        if logged:
            check("6: no 'dropping' line from audiobasesink (audiobasesink:6)", not dropping, f"{len(dropping)}")
        else:
            skip("6: audiobasesink's 'dropping' lines",
                 "audiobasesink logged nothing (no GST_DEBUG_FILE, or no debug log)")
        check("6: no error", not feed.errors, "; ".join(feed.errors))
    finally:
        if own:
            own.unload()


# --------------------------------------------------------------------------- 7: clock trace
def trace_tool():
    for path in (os.path.join(HERE, "sink_clock_trace.py"),
                 os.path.join(REPO, "tools", "output-check", "sink_clock_trace.py")):
        if os.path.exists(path):
            return path
    return None


def case7():
    tool = trace_tool()
    device, own = played_sink()
    if tool is None or device is None:
        skip("7: the provided clock across a hole, an underrun, a restart",
             "no sink_clock_trace.py beside the test or in tools/output-check" if tool is None else "no pulse sink")
        if own:
            own.unload()
        return
    try:
        out = os.path.join(OUT, "case7-trace.jsonl")
        r = subprocess.run([sys.executable, tool, decoder_sink(device), "20", out, "--hole", "4:300",
                            "--hole", "9:1000", "--restart", "14", "--prefill-ms", "40"],
                           capture_output=True, text=True, timeout=90)
        summary = next((json.loads(x) for x in reversed(r.stdout.splitlines()) if x.startswith("{")), None)
        record("case7.json", {"device": device, "versions": versions(), "rc": r.returncode, "summary": summary,
                              "stderr": r.stderr[-2000:]})
        check("7: the clock trace ran across a 300 ms hole, a 1 s underrun and a restart (recorded, not judged)",
              r.returncode == 0 and summary is not None, f"trace {out}")
    finally:
        if own:
            own.unload()


# --------------------------------------------------------------------------- 8: device stops
def device_stop(label, device, stop, resume):
    """2 s of PCM, then `stop()` for 3 s while pushing on, `resume()`, 3 s more: what render and the
    clock did. Recorded for Q2's skip rule."""
    feed = PulseFeed(decoder_sink(device))
    feed.start()
    feed.play(2)
    t_stop = mono()
    stop_rc = stop()
    feed.play(3)
    t_resume = mono()
    resume_rc = resume()
    feed.play(3)
    feed.stop()

    def chain_gap(t0, t1):
        return max((b - a for a, b in zip(feed.arrivals, feed.arrivals[1:]) if t0 <= a <= t1), default=0) / MS

    def backlog(t0, t1):
        return max((lv for t, lv in feed.levels if t0 <= t <= t1), default=0) / PCM_10MS * 10

    stopped_gap, stopped_backlog = chain_gap(t_stop, t_resume), backlog(t_stop, t_resume)
    ran = (feed.clock_at(t_resume) - feed.clock_at(t_stop)) / MS
    base = feed.clock_at(t_resume)
    moved = next((t for t, c in feed.samples if t > t_resume and c > base + 5 * MS), None)
    verdict = ("blocks" if stopped_gap > 500 or stopped_backlog > 500 else
               "discards (the clock stalled, data taken)" if ran < 300 else "runs on a timer")
    rec = {"variant": label, "device": device, "versions": versions(), "stopRc": stop_rc, "resumeRc": resume_rc,
           "render": verdict, "maxChainGapStoppedMs": stopped_gap, "appsrcBacklogStoppedMs": stopped_backlog,
           "maxChainGapAfterResumeMs": chain_gap(t_resume, t_resume + S),
           "appsrcBacklogAfterResumeMs": backlog(t_resume, t_resume + S), "clockRanWhileStoppedMs": ran,
           "clockMovesAfterResumeMs": None if moved is None else (moved - t_resume) / MS,
           "errors": feed.errors, "clock": feed.samples}
    record(f"case8-{label}.json", rec)
    check(f"8: {label}: recorded (render {verdict}; the clock moves "
          f"{rec['clockMovesAfterResumeMs']} ms after the resume)", True)


def case8():
    device, own = played_sink()
    if device is None:
        skip("8: the device stops", "no pulse sink")
        return
    try:
        target = os.environ.get("MR_GATE_SUSPEND_SINK") or device
        device_stop("suspended", device, lambda: pactl("suspend-sink", target, "1")[0],
                    lambda: pactl("suspend-sink", target, "0")[0])
        card, profile = os.environ.get("MR_GATE_CARD"), os.environ.get("MR_GATE_CARD_PROFILE")
        if card and profile:
            device_stop("node-removed", device, lambda: pactl("set-card-profile", card, "off")[0],
                        lambda: pactl("set-card-profile", card, profile)[0])
        elif own:
            device_stop("node-removed", device, lambda: own.unload() or 0, lambda: 0 if own.load() else 1)
        else:
            skip("8: node removed", "MR_GATE_PULSE_SINK is not the case's own sink: set MR_GATE_CARD and "
                 "MR_GATE_CARD_PROFILE")
    finally:
        if own:
            own.unload()


# --------------------------------------------------------------------------- 9: waylandsink
def wayland_socket():
    """XDG_RUNTIME_DIR and WAYLAND_DISPLAY as the engine seeds them (waylandEnv.ts)."""
    run = os.environ.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    if not os.environ.get("WAYLAND_DISPLAY"):
        found = sorted(e for e in os.listdir(run) if re.fullmatch(r"wayland-\d+", e)) if os.path.isdir(run) else []
        if not found:
            return None
        os.environ["WAYLAND_DISPLAY"] = found[0]
    return os.environ["WAYLAND_DISPLAY"]


def burst(present):
    """One frame, then 10 inside one refresh, into the player's waylandsink (sync=false): the
    sink's dropped count (a replaced frame) and, with 0008, its display-stats before and after."""
    pe = "" if present is None else f" present-every-frame={'true' if present else 'false'}"
    pipe = Gst.parse_launch("appsrc name=src is-live=true format=time"
                            " caps=video/x-raw,format=BGRx,width=640,height=360,framerate=50/1"
                            f" ! waylandsink name=sink sync=false qos=false fullscreen=true{pe}")
    house(pipe)
    src, sink = pipe.get_by_name("src"), pipe.get_by_name("sink")
    frame = b"\x40" * (640 * 360 * 4)
    stats = (lambda: sink.get_property("display-stats")) if sink.find_property("display-stats") else (lambda: None)

    def push():
        b = Gst.Buffer.new_wrapped(frame)
        b.pts, b.duration = mono(), 20 * MS
        src.emit("push-buffer", b)

    pipe.set_state(Gst.State.PLAYING)
    push()
    time.sleep(0.5)
    d0, s0 = sink.get_property("stats").get_value("dropped"), stats()
    for _ in range(10):
        push()
    time.sleep(0.6)
    d1, s1 = sink.get_property("stats").get_value("dropped"), stats()
    err = pipe.get_bus().pop_filtered(Gst.MessageType.ERROR)
    pipe.set_state(Gst.State.NULL)
    delta = (lambda f: s1.get_value(f) - s0.get_value(f)) if s0 is not None and s1 is not None else None
    # 0008's average (1/16 per frame), kept only on a CLOCK_MONOTONIC presentation clock.
    c2p = s1.get_value("commit-to-present-ns") if s1 is not None else None
    return {"dropped": d1 - d0, "presented": delta("presented") if delta else None,
            "replaced": delta("replaced") if delta else None,
            "discarded": delta("discarded") if delta else None,
            "clockMonotonic": s1.get_value("clock-monotonic") if s1 is not None else None,
            "commitToPresentNs": None if c2p in (None, NONE) else c2p,
            "refreshNs": s1.get_value("refresh-ns") if s1 is not None else None,
            "error": err.parse_error()[0].message if err else None}


def case9():
    if missing("waylandsink"):
        skip("9: waylandsink burst", "no waylandsink")
        return
    if wayland_socket() is None:
        skip("9: waylandsink burst", "no Wayland compositor socket in XDG_RUNTIME_DIR (Weston must run)")
        return
    has_0008 = Gst.ElementFactory.make("waylandsink", None).find_property("present-every-frame") is not None
    r7 = burst(False if has_0008 else None)
    rec = {"socket": os.environ["WAYLAND_DISPLAY"], "0007": r7}
    if r7["presented"] is not None:
        check("9: 0007 behaviour: of 10 frames inside one refresh at least 8 are not shown",
              10 - r7["presented"] >= 8, f"presented {r7['presented']}, replaced {r7['replaced']} in the sink, "
              f"discarded {r7['discarded']} by the compositor")
    else:
        # Without 0008 no feedback says what was shown; the sink's own count is recorded.
        check("9: 0007 only: recorded (shown frames need 0008's feedback: DEV-P4b)", r7["error"] is None,
              f"the sink dropped {r7['dropped']} of 10")
    if has_0008:
        r8 = burst(True)
        rec["0008"] = r8
        refresh = r8["refreshNs"] or 20 * MS
        check("9: 0008 present-every-frame: all 10 shown, none replaced or discarded",
              r8["presented"] == 10 and r8["replaced"] == 0 and r8["discarded"] == 0 and r8["dropped"] == 0,
              json.dumps(r8))
        if r8["commitToPresentNs"] is not None:
            check("9: 0008: commit to presentation averages within 1.5 refreshes (the sink's running average)",
                  r8["commitToPresentNs"] <= 1.5 * refresh,
                  f"commit-to-present {r8['commitToPresentNs']} ns, refresh {refresh} ns")
        else:
            skip("9: 0008 commit to presentation", "no average: the presentation clock is not CLOCK_MONOTONIC")
    else:
        skip("9: the 0008 half", "no present-every-frame: this GStreamer has 0007 only; DEV-P4b runs it")
    record("case9.json", rec)


# --------------------------------------------------------------------------- 10: kmssink
def kms_run(extra, frames=60):
    """appsrc ! kmssink sync=false fed as fast as it takes: the intervals between buffers reaching
    the sink (each waits for the previous show_frame), and any error. Run in a child: with the
    connector off, show_frame's drmHandleEvent may never return."""
    conn = os.environ.get("MR_GATE_KMS_CONNECTOR")
    pipe = Gst.parse_launch("appsrc name=src is-live=true format=time block=true max-buffers=2"
                            " caps=video/x-raw,format=BGRx,width=640,height=360,framerate=60/1"
                            " ! kmssink name=sink sync=false qos=false"
                            + (f" connector-id={conn}" if conn else "") + (f" {extra}" if extra else ""))
    house(pipe)
    src, sink = pipe.get_by_name("src"), pipe.get_by_name("sink")
    arrivals = []
    sink.get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER,
                                          lambda _p, _i: arrivals.append(mono()) or Gst.PadProbeReturn.OK)
    frame = b"\x40" * (640 * 360 * 4)
    ret = pipe.set_state(Gst.State.PLAYING)
    error = None
    for _ in range(frames):
        b = Gst.Buffer.new_wrapped(frame)
        b.pts, b.duration = mono(), 16 * MS
        if src.emit("push-buffer", b) != Gst.FlowReturn.OK:
            break
        msg = pipe.get_bus().pop_filtered(Gst.MessageType.ERROR)
        if msg is not None:
            error = msg.parse_error()[0].message
            break
    time.sleep(0.3)
    msg = pipe.get_bus().pop_filtered(Gst.MessageType.ERROR)
    error = error or (msg.parse_error()[0].message if msg else None)
    pipe.set_state(Gst.State.NULL)
    gaps = [(b - a) / MS for a, b in zip(arrivals, arrivals[1:])]
    return {"stateChange": ret.value_nick, "frames": len(arrivals), "intervalsMs": gaps, "error": error,
            "medianMs": statistics.median(gaps[5:]) if len(gaps) > 10 else None}


def kms_child(extra, frames=60, limit=30):
    try:
        r = subprocess.run([sys.executable, os.path.abspath(__file__), "--kms-run", extra, str(frames)],
                           capture_output=True, text=True, timeout=limit)
        return json.loads(r.stdout.strip().splitlines()[-1]) if r.stdout.strip() else {"error": r.stderr[-300:]}
    except subprocess.TimeoutExpired:
        return {"hung": True, "killedAfterS": limit, "medianMs": None, "frames": None, "error": None}


def case10():
    if missing("kmssink"):
        skip("10: kmssink", "no kmssink")
        return
    if subprocess.run(["pgrep", "-x", "weston"], capture_output=True).returncode == 0:
        skip("10: kmssink", "Weston is running: stop the video-player and Weston first (DEV-P4a)")
        return
    on = kms_child("")
    if not on.get("frames") and on.get("stateChange") == "failure":
        skip("10: kmssink", f"kmssink did not start ({on.get('error')}): a box with its display on runs it")
        return
    med = on.get("medianMs")
    hz = float(os.environ.get("MR_GATE_REFRESH_HZ") or (min((50, 60), key=lambda h: abs(1000 / h - med)) if med else 0))
    check("10: kmssink sync=false blocks one refresh per frame", med is not None and hz > 0
          and abs(med - 1000 / hz) <= 0.1 * 1000 / hz, f"median {med} ms, refresh {hz} Hz, error {on.get('error')}")
    off = kms_child('connector-properties="props,DPMS=3"')
    restore = kms_child('connector-properties="props,DPMS=0"', frames=10)
    record("case10.json", {"on": on, "dpmsOff": off, "restored": restore, "refreshHz": hz})
    check("10: with the connector off (DPMS) what show_frame does: recorded", True,
          "hung, killed" if off.get("hung") else f"median {off.get('medianMs')} ms over {off.get('frames')} "
          f"frames, error {off.get('error')}")


GATE = {6: (case6, 60), 7: (case7, 120), 8: (case8, 90), 9: (case9, 30), 10: (case10, 150)}


def gate():
    """Each gate case in a child with a time limit: a sink that never returns fails its case only.
    A null sink a killed child left loaded is unloaded after."""
    out = os.environ.get("MR_GATE_OUT") or tempfile.mkdtemp(prefix="p4-1-gate-")
    os.makedirs(out, exist_ok=True)
    print(f"gate records: {out}")
    for n, (_case, limit) in GATE.items():
        if not wanted(n):
            continue
        env = dict(os.environ, MR_GATE_OUT=out)
        if n == 6:
            env.update(GST_DEBUG=CASE6_DEBUG, GST_DEBUG_NO_COLOR="1",
                       GST_DEBUG_FILE=os.path.join(out, "case6-gst-debug.log"))
        rc, failed = None, 0
        try:
            r = subprocess.run([sys.executable, os.path.abspath(__file__), "--gate-child", str(n)],
                               env=env, capture_output=True, text=True, timeout=limit)
            text, rc = r.stdout + r.stderr[-2000:], r.returncode
        except subprocess.TimeoutExpired as exc:
            text = exc.stdout.decode() if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        for line in text.splitlines():
            print(line)
            if line.startswith("FAIL "):
                _failures.append(line[5:])
                failed += 1
        if rc is None:
            check(f"{n}: the case finishes inside {limit} s", False, "killed: it hung")
        elif rc != 0 and not failed:
            check(f"{n}: the case runs to its end", False, f"exit {rc}")
    rc, mods, _ = pactl("list", "short", "modules")
    for line in mods.splitlines() if rc == 0 else []:
        if "sink_name=mr_p41_gate" in line:
            pactl("unload-module", line.split()[0])


def main():
    global OUT
    if sys.argv[1:2] == ["--kms-run"]:
        print(json.dumps(kms_run(sys.argv[2], int(sys.argv[3]))))
        return
    if sys.argv[1:2] == ["--gate-child"]:
        OUT = os.environ["MR_GATE_OUT"]
        GATE[int(sys.argv[2])][0]()
        sys.exit(1 if _failures else 0)
    for n, case in ((1, case1), (2, case2), (3, case3), (4, case4), (5, case5)):
        if wanted(n):
            case()
    if os.environ.get("MR_GATE") == "1":
        gate()
    else:
        skip("gate cases 6-10", "MR_GATE=1 runs them on a box (DEV-P4a)")
    if _failures:
        print(f"\n{len(_failures)} FAILED: {_failures}")
        sys.exit(1)
    print("\ngst_no_late_drop_test.py: all checks passed")


if __name__ == "__main__":
    main()
