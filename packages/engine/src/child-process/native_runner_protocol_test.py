#!/usr/bin/env python3
"""Black-box protocol conformance test for the native runner (mr-gst-runner,
ADR-0019): drives the binary over its stdin/stderr JSON protocol exactly as
`PythonProcess` does and pins the events the engine relies on.

Skips (exit 0) when the binary is not built or GStreamer is unavailable.

Run:  python3 native_runner_protocol_test.py
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.normpath(os.path.join(_HERE, "..", ".."))
_BIN = os.path.join(_ROOT, "native", "mr-gst-runner", "mr-gst-runner")
_PLUGINS = os.path.normpath(os.path.join(_ROOT, "..", "..", "plugins"))

if not os.path.exists(_BIN):
    print(f"SKIP native_runner_protocol_test.py — {_BIN} not built (make -C packages/engine/native/mr-gst-runner)")
    sys.exit(0)

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst

    Gst.init([])
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP native_runner_protocol_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


class RunnerProc:
    """One runner process: commands in, parsed events + log lines out."""

    def __init__(self, argv=None):
        env = dict(os.environ, MR_PLUGINS_DIR=_PLUGINS, MALLOC_ARENA_MAX="2")
        # `argv` runs another binary on the same protocol (case N: the python twin).
        self.proc = subprocess.Popen(argv or [_BIN], stdin=subprocess.PIPE, stderr=subprocess.PIPE,
                                     stdout=subprocess.DEVNULL, env=env, text=True, bufsize=1)
        self.events = []
        self.logs = []
        os.set_blocking(self.proc.stderr.fileno(), False)
        self._buf = ""

    def send(self, cmd):
        self.proc.stdin.write(json.dumps(cmd) + "\n")
        self.proc.stdin.flush()

    def pump(self):
        try:
            chunk = self.proc.stderr.read()
        except (TypeError, BlockingIOError):
            chunk = None
        if chunk:
            self._buf += chunk
            while "\n" in self._buf:
                line, self._buf = self._buf.split("\n", 1)
                if line.startswith("GST_JSON:"):
                    self.events.append(json.loads(line[9:]))
                elif line.strip():
                    self.logs.append(line)

    def wait_event(self, pred, timeout=5.0):
        deadline = time.monotonic() + timeout
        seen = 0
        while time.monotonic() < deadline:
            self.pump()
            for ev in self.events[seen:]:
                if pred(ev):
                    return ev
            seen = len(self.events)
            if self.proc.poll() is not None:
                self.pump()
                for ev in self.events[seen:]:
                    if pred(ev):
                        return ev
                return None
            time.sleep(0.02)
        return None

    def wait_log(self, needle, timeout=5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump()
            if any(needle in line for line in self.logs):
                return True
            time.sleep(0.02)
        return False

    def has_event(self, pred):
        self.pump()
        return any(pred(ev) for ev in self.events)

    def stop_and_wait(self, timeout=10.0):
        try:
            self.send({"cmd": "stop"})
        except (BrokenPipeError, OSError):
            pass
        try:
            self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        self.pump()
        return self.proc.returncode

    def kill(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()


def ev_is(name, **fields):
    def pred(ev):
        if ev.get("event") != name:
            return False
        return all(ev.get(k) == v for k, v in fields.items())
    return pred


# --------------------------------------------------------------------------- A: plain pipeline
def test_plain_pipeline():
    r = RunnerProc()
    try:
        check("A ready event on boot", r.wait_event(ev_is("ready")) is not None)
        r.send({"cmd": "start",
                "pipeline": "audiotestsrc is-live=true wave=sine ! volume name=vol volume=0.5"
                            " ! level post-messages=true interval=100000000 ! fakesink name=sink sync=false",
                "useStdioForData": False, "linkOnPadAdded": [], "busReports": [],
                "timeSyncContract": True, "decoderThreadType": "auto"})
        check("A started event", r.wait_event(ev_is("started")) is not None)
        check("A reaches PLAYING", r.wait_event(ev_is("state_change", state="playing")) is not None)
        vu = r.wait_event(ev_is("vu_data"), timeout=3)
        check("A vu_data from level", vu is not None and isinstance(vu.get("peak"), list) and len(vu["peak"]) >= 1)
        check("A vu blocks in 0..15", vu is not None and all(isinstance(b, int) and 0 <= b <= 15 for b in vu["peak"]))

        r.send({"cmd": "set_property", "id": "sp1", "element": "vol", "property": "volume", "value": 0.25})
        ps = r.wait_event(ev_is("property_set", id="sp1"))
        check("A set_property acks with id", ps is not None and ps.get("element") == "vol")
        r.send({"cmd": "get_property", "id": "gp1", "element": "vol", "property": "volume"})
        gp = r.wait_event(ev_is("property", id="gp1"))
        check("A get_property round-trips the value", gp is not None and abs(float(gp["value"]) - 0.25) < 1e-6)
        r.send({"cmd": "get_property", "id": "gp2", "element": "vol", "property": "mute"})
        gp2 = r.wait_event(ev_is("property", id="gp2"))
        check("A get_property boolean", gp2 is not None and gp2["value"] is False)
        r.send({"cmd": "set_property", "id": "sp2", "element": "vol", "property": "mute", "value": True})
        check("A set_property boolean", r.wait_event(ev_is("property_set", id="sp2")) is not None)

        r.send({"cmd": "get_stats", "id": "st1", "element": "sink"})
        st = r.wait_event(ev_is("stats", id="st1"))
        check("A get_stats returns a dict", st is not None and isinstance(st.get("data"), dict))

        r.send({"cmd": "track_throughput", "id": "tt1", "element": "vol", "pad": "src"})
        check("A track_throughput acks", r.wait_event(ev_is("tracking", id="tt1")) is not None)
        time.sleep(0.6)
        r.send({"cmd": "get_throughput", "id": "gt1"})
        tp = r.wait_event(ev_is("throughput", id="gt1"))
        check("A get_throughput counts bytes",
              tp is not None and tp["data"].get("vol", {}).get("total_bytes", 0) > 0)

        r.send({"cmd": "get_property", "id": "gp3", "element": "nope", "property": "x"})
        ce = r.wait_event(ev_is("command_error", id="gp3"))
        check("A unknown element -> command_error with id", ce is not None and "nope" in ce["message"])
        r.send({"cmd": "bogus", "id": "b1"})
        check("A unknown command -> command_error", r.wait_event(ev_is("command_error", id="b1")) is not None)
        check("A no lifecycle error so far", not r.has_event(ev_is("error")))

        code = r.stop_and_wait()
        check("A stop -> state_change null", r.has_event(ev_is("state_change", state="null")))
        check("A exits 0 after stop", code == 0)
    finally:
        r.kill()


# --------------------------------------------------------------------------- B: producer + fan-out edge
def test_producer_edge():
    if Gst.ElementFactory.find("unixfdsink") is None or Gst.ElementFactory.find("avenc_s302m") is None:
        print("SKIP B — unixfdsink / avenc_s302m unavailable")
        return
    tmp = tempfile.mkdtemp(prefix="mrtest-")
    edge = os.path.join(tmp, "edge.sock")
    caps = "video/mpegts, systemstream=(boolean)true, packetsize=(int)188"
    r = RunnerProc()
    consumer = None
    try:
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start",
                "pipeline": "audiotestsrc is-live=true ! audio/x-raw,format=S32LE,rate=48000,channels=2"
                            " ! avenc_s302m strict=experimental ! mpegtsmux latency=0 alignment=7"
                            f" ! capssetter caps=\"{caps}\" replace=true ! capsfilter caps=\"{caps}\""
                            " ! tee name=busout_40000 allow-not-linked=true",
                "timeSyncContract": True, "latchRepair": True, "conditionStepMs": 100})
        check("B reaches PLAYING", r.wait_event(ev_is("state_change", state="playing")) is not None)
        stamped = r.wait_log("native stamper inserted on busout_40000", timeout=2)
        check("B mrtsstamp spliced in front of the busout tee", stamped)

        r.send({"cmd": "bus_attach", "tee": "busout_40000", "socket": edge})
        att = r.wait_event(ev_is("bus_attached", socket=edge))
        check("B bus_attach -> bus_attached", att is not None and att.get("tee") == "busout_40000")
        if stamped:
            check("B stamper armed on first edge", r.wait_log("armed on busout_40000", timeout=2))

        consumer = Gst.parse_launch(f"unixfdsrc socket-path={edge} ! fakesink name=csink sync=false")
        got = {"n": 0}

        def on_buf(_pad, _info):
            got["n"] += 1
            return Gst.PadProbeReturn.OK

        consumer.get_by_name("csink").get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, on_buf)
        consumer.set_state(Gst.State.PLAYING)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and got["n"] < 5:
            time.sleep(0.05)
        check("B consumer receives buffers over the edge", got["n"] >= 5)
        if stamped:
            check("B anchor reported through the stamper", r.wait_event(ev_is("timeline_restamped"), timeout=3) is not None)

        r.send({"cmd": "track_throughput", "id": "tt", "element": "busout_40000", "pad": "sink"})
        r.wait_event(ev_is("tracking", id="tt"))
        time.sleep(0.5)
        r.send({"cmd": "get_throughput", "id": "gt"})
        tp = r.wait_event(ev_is("throughput", id="gt"))
        check("B tee throughput via native counter", tp is not None and tp["data"]["busout_40000"]["total_bytes"] > 0)

        # A second attach for the same edge is idempotent.
        r.send({"cmd": "bus_attach", "tee": "busout_40000", "socket": edge})
        time.sleep(0.3)
        check("B duplicate attach is a no-op", len([e for e in r.events if e.get("event") == "bus_attached"]) == 1)

        consumer.set_state(Gst.State.NULL)
        r.send({"cmd": "bus_detach", "socket": edge})
        det = r.wait_event(ev_is("bus_detached", socket=edge))
        check("B bus_detach -> bus_detached", det is not None)
        if stamped:
            check("B stamper disarmed on last edge", r.wait_log("stamper disarmed", timeout=2))
        check("B socket file removed after detach", not os.path.exists(edge))

        # Attach on a tee that does not exist stays pending, never errors.
        r.send({"cmd": "bus_attach", "tee": "busout_99999", "socket": os.path.join(tmp, "ghost.sock")})
        time.sleep(0.6)
        check("B attach on a missing tee is pending, not an error", not r.has_event(ev_is("error")))

        code = r.stop_and_wait()
        check("B exits 0 after stop", code == 0)
    finally:
        if consumer is not None:
            consumer.set_state(Gst.State.NULL)
        r.kill()
        for f in os.listdir(tmp):
            os.unlink(os.path.join(tmp, f))
        os.rmdir(tmp)


# --------------------------------------------------------------------------- B2: house-timeline egress
def test_house_timeline_egress():
    """A transform producer (`houseTimelineEgress`): the egress is stamped by
    identity, PES − 1 h, so the wire carries the mux's own house time. Checked
    end to end on a consumer pinned to the same house clock: every stamped
    buffer's timestamp equals the PES PTS the mux wrote minus one hour."""
    if Gst.ElementFactory.find("unixfdsink") is None or Gst.ElementFactory.find("avenc_s302m") is None:
        print("SKIP B2 — unixfdsink / avenc_s302m unavailable")
        return
    sys.path.insert(0, os.path.normpath(os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "plugins", "mpegts-core", "py")))
    import ts_psi  # noqa: E402
    import ts_timeline  # noqa: E402
    tmp = tempfile.mkdtemp(prefix="mrtest-")
    edge = os.path.join(tmp, "edge.sock")
    caps = "video/mpegts, systemstream=(boolean)true, packetsize=(int)188"
    r = RunnerProc()
    consumer = None
    try:
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start",
                "pipeline": "audiotestsrc is-live=true ! audio/x-raw,format=S32LE,rate=48000,channels=2"
                            " ! avenc_s302m strict=experimental ! mpegtsmux latency=0 alignment=7"
                            f" ! capssetter caps=\"{caps}\" replace=true ! capsfilter caps=\"{caps}\""
                            " ! tee name=busout_40000 allow-not-linked=true",
                "timeSyncContract": True, "latchRepair": False, "houseTimelineEgress": True})
        check("B2 reaches PLAYING", r.wait_event(ev_is("state_change", state="playing")) is not None)
        stamped = r.wait_log("native stamper inserted on busout_40000", timeout=2)
        check("B2 mrtsstamp spliced in front of the busout tee", stamped)
        r.send({"cmd": "bus_attach", "tee": "busout_40000", "socket": edge})
        check("B2 bus_attach -> bus_attached", r.wait_event(ev_is("bus_attached", socket=edge)) is not None)
        if stamped:
            check("B2 armed as a house-timeline egress", r.wait_log("house-timeline egress", timeout=2))

        consumer = Gst.parse_launch(f"unixfdsrc socket-path={edge} ! fakesink name=csink sync=false")
        # Pinned exactly as the runner pins a contract pipeline, so the wire's
        # absolute house time comes out as the buffer timestamp unchanged.
        clock = Gst.SystemClock.obtain()
        clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
        consumer.use_clock(clock)
        consumer.set_start_time(Gst.CLOCK_TIME_NONE)
        consumer.set_base_time(0)
        got = []

        def on_buf(_pad, info):
            buf = info.get_buffer()
            ok, mi = buf.map(Gst.MapFlags.READ)
            if ok:
                data = bytes(mi.data)
                buf.unmap(mi)
                for pkt in ts_psi.iter_packets(data):
                    if not (pkt[1] & 0x40):
                        continue
                    pts = ts_psi.read_pes_pts(pkt)
                    if pts is None:
                        continue
                    got.append((pts, buf.pts))
                    break
            return Gst.PadProbeReturn.OK

        consumer.get_by_name("csink").get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, on_buf)
        consumer.set_state(Gst.State.PLAYING)
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline and len(got) < 12:
            time.sleep(0.05)
        check("B2 consumer receives stamped PES buffers over the edge", len(got) >= 12)
        if stamped and got:
            off = [buf_pts - ts_timeline.house_from_mux_pts(pts, buf_pts) for pts, buf_pts in got]
            check(f"B2 every wire timestamp is the mux's PES PTS − 1 h, to the tick "
                  f"(worst {max(abs(o) for o in off) / 1e3:.1f} µs)",
                  all(abs(o) <= 11112 for o in off))
            check("B2 one anchor event (the identity), no re-anchor",
                  r.wait_event(ev_is("timeline_restamped"), timeout=3) is not None
                  and not r.has_event(ev_is("timeline_reanchor")))
        consumer.set_state(Gst.State.NULL)
        r.send({"cmd": "bus_detach", "socket": edge})
        r.wait_event(ev_is("bus_detached", socket=edge))
        code = r.stop_and_wait()
        check("B2 exits 0 after stop", code == 0)
    finally:
        if consumer is not None:
            consumer.set_state(Gst.State.NULL)
        r.kill()
        for f in os.listdir(tmp):
            os.unlink(os.path.join(tmp, f))
        os.rmdir(tmp)


# --------------------------------------------------------------------------- C: gated consumer (data wait)
def test_consumer_data_wait():
    if Gst.ElementFactory.find("unixfdsink") is None:
        print("SKIP C — unixfdsink unavailable")
        return
    tmp = tempfile.mkdtemp(prefix="mrtest-")
    sock = os.path.join(tmp, "prod.sock")
    caps = "video/mpegts, systemstream=(boolean)true, packetsize=(int)188"
    producer = Gst.parse_launch(
        f"appsrc name=src is-live=true format=time caps=\"{caps}\""
        f" ! unixfdsink socket-path={sock} sync=false async=false wait-for-connection=false")
    producer.set_state(Gst.State.PLAYING)
    time.sleep(0.3)
    r = RunnerProc()
    try:
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start", "pipeline": f"unixfdsrc socket-path={sock} ! queue ! fakesink sync=false",
                "timeSyncContract": True, "playingTimeoutMs": 500})
        check("C started", r.wait_event(ev_is("started")) is not None)
        wfd = r.wait_event(ev_is("waiting_for_data"), timeout=2)
        check("C dark bus -> waiting_for_data after the watchdog period", wfd is not None and wfd.get("sockets") == [sock])
        time.sleep(0.8)
        check("C dark bus never errors out (no playing_timeout)", not r.has_event(ev_is("error")))

        src = producer.get_by_name("src")
        for i in range(5):
            buf = Gst.Buffer.new_wrapped(bytes([0x47]) + bytes(187))
            buf.pts = i * 20 * Gst.MSECOND
            src.emit("push-buffer", buf)
            time.sleep(0.02)
        check("C data_arrived once the producer delivers", r.wait_event(ev_is("data_arrived"), timeout=3) is not None)
        check("C reaches PLAYING after data", r.wait_event(ev_is("state_change", state="playing"), timeout=3) is not None)

        # The producer restarting under a waiting consumer: re-create the socket.
        code = r.stop_and_wait()
        check("C exits 0 after stop", code == 0)
    finally:
        r.kill()
        producer.set_state(Gst.State.NULL)
        for f in os.listdir(tmp):
            os.unlink(os.path.join(tmp, f))
        os.rmdir(tmp)


# --------------------------------------------------------------------------- D: refusals and lifecycle errors
def test_refusals():
    r = RunnerProc()
    try:
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start", "pipeline": "audiotestsrc ! fakesink",
                "preserveSourceTimeline": {"demux": "d"}})
        ev = r.wait_event(ev_is("error", kind="unsupported"))
        check("D preserveSourceTimeline refused with kind=unsupported",
              ev is not None and "preserveSourceTimeline" in ev["message"])
        r.kill()

        r = RunnerProc()
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start", "pipeline": "audiotestsrc ! nosuchelement ! fakesink"})
        ev = r.wait_event(ev_is("error"))
        check("D parse failure -> error event", ev is not None and "parse" in ev["message"].lower())
        r.kill()

        r = RunnerProc()
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start", "pipeline": "audiotestsrc num-buffers=20 ! fakesink sync=false"})
        check("D EOS reported", r.wait_event(ev_is("eos"), timeout=5) is not None)
        r.proc.wait(timeout=5)
        check("D exits after EOS", r.proc.returncode == 0)
    finally:
        r.kill()


# --------------------------------------------------------------------------- E: presentation leg (Stage 2)
def test_presentation_leg():
    """A stamped 302M producer feeding a consumer with `alignBranchesToStamps`
    on its tsdemux and `backlogShed` on a sync=true sink — the audio-output-302m
    shape. Pins that the aligner joins access units and settles a verdict, and
    that the shedder measures the leg and reports through `backlog_shed`."""
    for el in ("unixfdsink", "avenc_s302m", "avdec_s302m", "tsdemux"):
        if Gst.ElementFactory.find(el) is None:
            print(f"SKIP E — {el} unavailable")
            return
    tmp = tempfile.mkdtemp(prefix="mrtest-")
    edge = os.path.join(tmp, "edge.sock")
    caps = "video/mpegts, systemstream=(boolean)true, packetsize=(int)188"
    prod = RunnerProc()
    cons = None
    try:
        prod.wait_event(ev_is("ready"))
        prod.send({"cmd": "start",
                   "pipeline": "audiotestsrc is-live=true ! audio/x-raw,format=S32LE,rate=48000,channels=2"
                               " ! avenc_s302m strict=experimental ! mpegtsmux latency=0 alignment=7"
                               f" ! capssetter caps=\"{caps}\" replace=true ! capsfilter caps=\"{caps}\""
                               " ! tee name=busout_40100 allow-not-linked=true",
                   "timeSyncContract": True, "latchRepair": True})
        check("E producer PLAYING", prod.wait_event(ev_is("state_change", state="playing")) is not None)
        prod.send({"cmd": "bus_attach", "tee": "busout_40100", "socket": edge})
        check("E edge attached", prod.wait_event(ev_is("bus_attached", socket=edge)) is not None)

        cons = RunnerProc()
        cons.wait_event(ev_is("ready"))
        # ts-offset −400 ms makes every buffer read 400 ms late at the sink pad
        # with nothing queued upstream: the policy must say "timeline", never shed.
        cons.send({"cmd": "start",
                   "pipeline": f"unixfdsrc socket-path={edge} ! queue leaky=2 max-size-time=5000000000"
                               " ! tsdemux name=mixin_demux0 latency=0 ! audio/x-smpte-302m ! avdec_s302m"
                               " ! audioconvert ! audioresample ! queue ! fakesink name=sink sync=true"
                               " ts-offset=-400000000 max-lateness=-1",
                   "timeSyncContract": True,
                   "alignBranchesToStamps": {"demuxes": ["mixin_demux0"]},
                   "backlogShed": {"element": "sink", "sink": "sink", "keyframeAligned": False,
                                   "toleranceMs": 100, "holdMs": 1000, "cooldownMs": 60000,
                                   "sanityMs": 10000}})
        check("E consumer PLAYING", cons.wait_event(ev_is("state_change", state="playing"), timeout=8) is not None)
        aligned = cons.wait_log("branchAlign: mixin_demux0 ", timeout=25)
        check("E branch aligner settles a verdict on the demux branch", aligned)
        if aligned:
            line = next(l for l in cons.logs if "branchAlign: mixin_demux0 " in l)
            # A 302M PES carries a length: the index must close it the moment
            # it is complete (tsdemux emits it inside the same buffer), so the
            # branch joins and reaches a real verdict — never the give-up.
            ok = "offsetNs=" in line and "joined AUs" in line and "un-anchored" not in line
            check("E a one-AU-per-buffer 302M branch joins and reaches an offset verdict", ok)
            if not ok:
                print("    branchAlign line:", line[:300])
        tl = cons.wait_event(lambda e: e.get("event") == "plugin_event" and e.get("channel") == "backlog_shed",
                             timeout=10)
        check("E shedder reports through backlog_shed", tl is not None)
        check("E a late timeline with empty queues is reported, not shed",
              tl is not None and tl["payload"].get("outcome") == "timeline"
              and tl["payload"].get("excessBeforeMs", 0) > 100)
        check("E no lifecycle error", not cons.has_event(ev_is("error")))
        code = cons.stop_and_wait()
        check("E consumer exits 0", code == 0)
        prod.stop_and_wait()
    finally:
        if cons is not None:
            cons.kill()
        prod.kill()
        for f in os.listdir(tmp):
            os.unlink(os.path.join(tmp, f))
        os.rmdir(tmp)


def test_shed_refusals():
    r = RunnerProc()
    try:
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start", "pipeline": "audiotestsrc ! fakesink name=sink",
                "backlogShed": {"element": "nosuch", "sink": "sink", "keyframeAligned": False}})
        ev = r.wait_event(ev_is("error"))
        check("E backlogShed names a missing element -> hard error", ev is not None and "nosuch" in ev["message"])
    finally:
        r.kill()


# --------------------------------------------------------------------------- N: re-anchor parity (2026-10-08)
_PY_RUNNER = [sys.executable, os.path.join(_HERE, "gst-pipeline-runner.py")]
_RAISE_FIELDS = ["budgetMs", "cause", "element", "excessMs", "holdMs", "kind", "latencyMs",
                 "queuedMs", "tsOffsetMs", "worstMs"]
_REBASE_FIELDS = ["appliedOffsetNs", "budgetMs", "count", "element", "flushed", "kind",
                  "latenessMs", "padOffsetNs", "sanityMs"]


def test_reanchor_parity():
    """`onLateness: "reanchor"` over the real protocol on BOTH runners, the python
    ladder's steps 2 (raise, backlog queued), 4 (raise, late timeline) and 6
    (future stamps rebased in-thread, the leg keeps flowing): every event's field
    set equal to the python run's. Live audio into a `sync=true` sink; lateness is set by the sink's `ts-offset` (case E's idiom
    — a live source re-paces any stamp offset away within its first buffers)."""
    shed = {"element": "sink", "sink": "sink", "keyframeAligned": False, "toleranceMs": 100,
            "holdMs": 600, "cooldownMs": 60000, "sanityMs": 10000, "onLateness": "reanchor",
            "reanchorToleranceMs": 40, "reanchorHoldMs": 600, "reanchorRetryMs": 1500,
            "rebaseHoldMs": 300, "rebaseCooldownMs": 500}

    def start(argv, ts_ms, queue=""):
        r = RunnerProc(argv)
        r.wait_event(ev_is("ready"))
        cmd = {"cmd": "start", "timeSyncContract": True,
               "pipeline": "audiotestsrc is-live=true samplesperbuffer=480"
                           f" ! audio/x-raw,format=S16LE,rate=48000,channels=2 ! level{queue}"
                           f" ! fakesink name=sink sync=true ts-offset={int(ts_ms * 1e6)}",
               "backlogShed": shed}
        r.send(cmd)
        return r

    def reanchor(r, kind, timeout=8.0, after=None):
        return (r.wait_event(lambda e: e.get("event") == "plugin_event" and e.get("channel") == "playout_reanchor"
                             and e["payload"].get("kind") == kind and e is not after, timeout=timeout) or {})
    both = {"py": _PY_RUNNER, "native": None}
    runs = []
    try:
        # 2. 200 ms parked in a queue past a 60 ms budget: a raise, cause backlog.
        # The queue reports its threshold as latency, so ts-offset takes it back
        # off — the budget stays 60 ms + the source's own latency.
        q = " ! queue min-threshold-time=200000000 max-size-time=2000000000 max-size-buffers=0 max-size-bytes=0"
        r2 = {k: start(v, 60 - 200, queue=q) for k, v in both.items()}
        runs += r2.values()
        raise2 = {k: reanchor(r, "raise").get("payload", {}) for k, r in r2.items()}
        check("N 2 both runners ask for a raise with the design's field set",
              sorted(raise2["py"]) == _RAISE_FIELDS and sorted(raise2["native"]) == _RAISE_FIELDS)
        check("N 2 a queued backlog is the cause on both, the level ~110 ms on both",
              all(p.get("cause") == "backlog" and 60 < p.get("excessMs", 0) < 190 and p.get("queuedMs", 0) >= 150
                  and p.get("tsOffsetMs") == -140 and p.get("holdMs") == 600
                  and abs(p.get("budgetMs", 0) - p.get("tsOffsetMs", 0) - p.get("latencyMs", 0)) <= 0.11
                  for p in raise2.values()))
        for r in r2.values():
            r.kill()
        # 4. A budget 250 ms short with nothing queued: a raise, cause timeline.
        r4 = {k: start(v, -250) for k, v in both.items()}
        runs += r4.values()
        raise4 = {k: reanchor(r, "raise").get("payload", {}) for k, r in r4.items()}
        check("N 4 a late timeline asks too, same fields, cause timeline, ~220 ms on both",
              sorted(raise4["py"]) == sorted(raise4["native"]) == _RAISE_FIELDS
              and all(p.get("cause") == "timeline" and 170 < p.get("excessMs", 0) < 290
                      and p.get("queuedMs") == 0 for p in raise4.values()))
        for r in r4.values():
            r.kill()
        # 6. Every buffer 20 s early on a paced sink: rebased at the first one, and
        # the streaming thread keeps going (level keeps posting) — nothing parked.
        r6 = {k: start(v, 20000) for k, v in both.items()}
        runs += r6.values()
        rebase6 = {k: reanchor(r, "rebase").get("payload", {}) for k, r in r6.items()}
        check("N 6 both rebase with the design's field set, unflushed, count 1",
              sorted(rebase6["py"]) == sorted(rebase6["native"]) == _REBASE_FIELDS
              and all(p.get("flushed") is False and p.get("count") == 1
                      and -20250 < p.get("latenessMs", 0) < -19900 and p.get("appliedOffsetNs") == p.get("padOffsetNs")
                      for p in rebase6.values()))
        time.sleep(3.0)
        for k, r in r6.items():
            r.pump()
        vu = {k: sum(1 for e in r.events if e.get("event") == "vu_data") for k, r in r6.items()}
        check(f"N 6 the rebased leg keeps flowing on both (vu_data {vu})", all(n >= 3 for n in vu.values()))
        check("N no lifecycle error on either runner", not any(r.has_event(ev_is("error")) for r in runs))
        for r in r6.values():
            r.kill()
    finally:
        for r in runs:
            r.kill()


# --------------------------------------------------------------------------- G: runner hooks (native form)
def make_klv_ts(path, n_buffers=40):
    """A TS with three KLV PES streams on PIDs 0x180, 0x181 and 0x1f0 — the
    mux_routing_test.py fixture, written to `path`."""
    from gi.repository import GLib
    pipe = Gst.parse_launch(
        "mpegtsmux name=mux alignment=7 "
        'prog-map="program_map,sink_384=(int)1,sink_385=(int)1,sink_496=(int)1,PCR_1=sink_384" '
        f"! filesink location={path} "
        'appsrc name=a format=time caps="meta/x-klv,parsed=true" ! mux.sink_384 '
        'appsrc name=b format=time caps="meta/x-klv,parsed=true" ! mux.sink_385 '
        'appsrc name=c format=time caps="meta/x-klv,parsed=true" ! mux.sink_496 ')
    srcs = [pipe.get_by_name(n) for n in ("a", "b", "c")]
    loop = GLib.MainLoop()
    bus = pipe.get_bus()
    bus.add_signal_watch()
    bus.connect("message", lambda _b, msg: loop.quit() if msg.type in (Gst.MessageType.EOS, Gst.MessageType.ERROR) else None)

    def push_all():
        for i in range(n_buffers):
            for k, src in enumerate(srcs):
                payload = bytes([0x06, 0x0E, 0x2B, 0x34] + [k] * 28) + f"cue {i}".encode()
                buf = Gst.Buffer.new_wrapped(payload)
                buf.pts = buf.dts = i * 40 * Gst.MSECOND
                buf.duration = 40 * Gst.MSECOND
                src.emit("push-buffer", buf)
        for src in srcs:
            src.emit("end-of-stream")
        return False

    GLib.idle_add(push_all)
    GLib.timeout_add_seconds(10, lambda: (loop.quit(), False)[1])
    pipe.set_state(Gst.State.PLAYING)
    loop.run()
    pipe.set_state(Gst.State.NULL)
    return os.path.getsize(path)


def test_runner_hooks():
    for el in ("tsdemux", "mpegtsmux"):
        if Gst.ElementFactory.find(el) is None:
            print(f"SKIP G — {el} unavailable")
            return
    so = os.path.join(_PLUGINS, "mpegts-muxer", "native", "mux-routing", "libmrhook_mux_routing.so")
    if not os.path.exists(so):
        print(f"SKIP G — {so} not built")
        return
    tmp = tempfile.mkdtemp(prefix="mrtest-")
    ts = os.path.join(tmp, "klv.ts")
    size = make_klv_ts(ts)
    check("G fixture TS generated", size > 188 * 10 and size % 188 == 0)
    r = RunnerProc()
    try:
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start",
                "pipeline": f"filesrc location={ts} ! tsdemux name=demux_0 latency=0 "
                            'mpegtsmux name=mux alignment=7 prog-map="program_map,sink_384=(int)1,PCR_1=sink_384" '
                            "! fakesink name=out sync=false",
                "timeSyncContract": True,
                "runnerHooks": [{"module": "mux_routing", "config": {"inputs": [{
                    "demux": "demux_0", "linkTo": "mux",
                    "routes": {"klv": {"padName": "sink_384", "branch": "queue", "sparse": True},
                               "video": {"padName": "sink_256", "branch": "queue"}},
                    "ignorePids": [0x1F0], "pcr": {"program": 1}}]}}]})
        check("G native hook installed", r.wait_log("runner hook 'mux_routing' installed", timeout=5))
        linked = r.wait_event(ev_is("pad_linked"), timeout=8)
        check("G exactly one pad linked — the klv route",
              linked is not None and linked.get("media") == "klv" and linked.get("pid") == 0x180
              and linked.get("rule") == "demux_0::any" and linked.get("padName", "").startswith("private_"))
        eos = r.wait_event(ev_is("eos"), timeout=15)
        check("G pipeline ran to EOS", eos is not None)
        warnings = [e.get("message", "") for e in r.events if e.get("event") == "warning"]
        check("G carousel PID 0x1f0 was excluded", any("0x1f0 is excluded" in w for w in warnings))
        check("G second klv stream was sunk", any("second klv stream" in w for w in warnings))
        check("G no error events", not r.has_event(ev_is("error")))
        check("G only one pad_linked", len([e for e in r.events if e.get("event") == "pad_linked"]) == 1)
        r.proc.wait(timeout=5)
        check("G exits 0 after EOS", r.proc.returncode == 0)
    finally:
        r.kill()
        for f in os.listdir(tmp):
            os.unlink(os.path.join(tmp, f))
        os.rmdir(tmp)

    # G2: a GENERIC input (one `pid`, no per-class padName) — the hook reads the
    # source PMT and lands the klv-only stream on exactly the input's PID.
    tmp = tempfile.mkdtemp(prefix="mrtest-")
    ts = os.path.join(tmp, "klv.ts")
    make_klv_ts(ts)
    r = RunnerProc()
    try:
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start",
                "pipeline": f"filesrc location={ts} ! tsdemux name=demux_0 latency=0 "
                            'mpegtsmux name=mux alignment=7 prog-map="program_map,sink_300=(int)1,PCR_1=sink_300" '
                            "! fakesink name=out sync=false",
                "timeSyncContract": True,
                "runnerHooks": [{"module": "mux_routing", "config": {"inputs": [{
                    "demux": "demux_0", "linkTo": "mux", "pid": 300,
                    "routes": {"video": {"branch": "queue"}, "audio": {"branch": "queue"},
                               "klv": {"branch": "queue", "sparse": True},
                               "subtitle": {"branch": "queue", "sparse": True}},
                    "ignorePids": [0x1F0], "pcr": {"program": 1}}]}}]})
        check("G2 native hook installed", r.wait_log("runner hook 'mux_routing' installed", timeout=5))
        linked = r.wait_event(ev_is("pad_linked"), timeout=8)
        check("G2 klv linked onto the INPUT PID (outPid 300), source pid 0x180",
              linked is not None and linked.get("media") == "klv" and linked.get("pid") == 0x180
              and linked.get("outPid") == 300)
        check("G2 PMT classes were read before linking", r.wait_log("demux_0 PMT: [klv] (pid 300)", timeout=2))
        routed = r.wait_event(lambda e: e.get("event") == "plugin_event" and e.get("channel") == "mux:routed", timeout=5)
        check("G2 mux:routed plugin event names demux, class and output PID",
              routed is not None and routed.get("payload", {}).get("demux") == "demux_0"
              and routed["payload"].get("media") == "klv" and routed["payload"].get("outPid") == 300
              and routed["payload"].get("srcPid") == 0x180 and "meta/x-klv" in routed["payload"].get("caps", ""))
        eos = r.wait_event(ev_is("eos"), timeout=15)
        check("G2 pipeline ran to EOS", eos is not None)
        check("G2 no error events", not r.has_event(ev_is("error")))
        r.proc.wait(timeout=5)
        check("G2 exits 0 after EOS", r.proc.returncode == 0)
    finally:
        r.kill()
        for f in os.listdir(tmp):
            os.unlink(os.path.join(tmp, f))
        os.rmdir(tmp)

    r = RunnerProc()
    try:
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start", "pipeline": "audiotestsrc ! fakesink",
                "runnerHooks": [{"module": "no_such_hook"}]})
        ev = r.wait_event(ev_is("error", kind="unsupported"))
        check("G a hook with no native form is refused as unsupported",
              ev is not None and "no_such_hook" in ev["message"])
    finally:
        r.kill()


# --------------------------------------------------------------------------- H: subtitle bridge hook (native form)
def test_subtitle_bridge_hook():
    so = os.path.join(_PLUGINS, "subtitle-core", "native", "subtitle-bridge", "libmrhook_subtitle_bridge.so")
    if not os.path.exists(so):
        print(f"SKIP H — {so} not built")
        return
    for el in ("tsdemux", "mpegtsmux", "textoverlay", "appsink", "appsrc"):
        if Gst.ElementFactory.find(el) is None:
            print(f"SKIP H — {el} unavailable")
            return
    sys.path.insert(0, os.path.join(_PLUGINS, "subtitle-core", "py"))
    import subtitle_klv
    from gi.repository import GLib
    tmp = tempfile.mkdtemp(prefix="mrtest-")

    # --- pay: cue text in → KLV cue out on the mux, reported on subtitle:cue
    txt = os.path.join(tmp, "cue.txt")
    with open(txt, "wb") as f:
        f.write(b"Hello\r\nWorld  \n\n\x00")
    r = RunnerProc()
    try:
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start",
                # Every real pay pipeline is live; this file-fed rig is not, so
                # its sinks are `async=false` (else the mux waits to preroll on a
                # cue the appsink only delivers, as `new-sample`, once PLAYING).
                "pipeline": f"filesrc location={txt} ! text/x-raw,format=utf8 ! appsink name=txtsink async=false "
                            'appsrc name=klvsrc is-live=true format=time caps="meta/x-klv,parsed=true" ! mpegtsmux name=mux '
                            "! fakesink name=out sync=false async=false",
                "timeSyncContract": True,
                "runnerHooks": [{"module": "subtitle_bridge",
                                 "config": {"pay": [{"appsink": "txtsink", "appsrc": "klvsrc", "holdMs": 8000,
                                                     "label": "p1"}]}}]})
        check("H pay: hook installed", r.wait_log("runner hook 'subtitle_bridge' installed", timeout=5))
        cue = r.wait_event(lambda e: e.get("event") == "plugin_event" and e.get("channel") == "subtitle:cue", timeout=8)
        check("H pay: cue reported on subtitle:cue with cleaned text",
              cue is not None and cue["payload"].get("text") == "Hello\nWorld" and cue["payload"].get("label") == "p1"
              and cue["payload"].get("count") == 1)
        r.send({"cmd": "track_throughput", "id": "tt", "element": "mux", "pad": "src"})
        r.wait_event(ev_is("tracking", id="tt"))
        time.sleep(2.6)   # one re-send tick (2 s) later the mux has emitted KLV
        r.send({"cmd": "get_throughput", "id": "gt"})
        tp = r.wait_event(ev_is("throughput", id="gt"))
        check("H pay: KLV cue reached the mux (and was re-sent)",
              tp is not None and tp["data"].get("mux", {}).get("total_bytes", 0) > 0)
        check("H pay: no error", not r.has_event(ev_is("error")))
        code = r.stop_and_wait()
        check("H pay: exits 0", code == 0)
    finally:
        r.kill()

    # --- overlay: KLV cues from a TS drive the textoverlay text from the video path
    ts = os.path.join(tmp, "cues.ts")
    pipe = Gst.parse_launch(
        'mpegtsmux name=mux alignment=7 prog-map="program_map,sink_384=(int)1,PCR_1=sink_384" '
        f"! filesink location={ts} "
        'appsrc name=a format=time caps="meta/x-klv,parsed=true" ! mux.sink_384')
    src = pipe.get_by_name("a")
    loop = GLib.MainLoop()
    bus = pipe.get_bus()
    bus.add_signal_watch()
    bus.connect("message", lambda _b, msg: loop.quit() if msg.type in (Gst.MessageType.EOS, Gst.MessageType.ERROR) else None)

    def push():
        for i in range(3):
            buf = Gst.Buffer.new_wrapped(subtitle_klv.encode_cue(0, 3800, "Hi there"))
            buf.pts = buf.dts = i * 500 * Gst.MSECOND
            src.emit("push-buffer", buf)
        src.emit("end-of-stream")
        return False

    GLib.idle_add(push)
    GLib.timeout_add_seconds(10, lambda: (loop.quit(), False)[1])
    pipe.set_state(Gst.State.PLAYING)
    loop.run()
    pipe.set_state(Gst.State.NULL)
    check("H overlay: cue TS generated", os.path.getsize(ts) > 188 * 5)

    r = RunnerProc()
    try:
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start",
                "pipeline": "videotestsrc is-live=true ! video/x-raw,width=64,height=48,framerate=25/1 "
                            '! textoverlay name=ov wait-text=false text="" ! fakesink sync=false '
                            f"filesrc location={ts} ! tsdemux name=subdemux latency=0",
                "timeSyncContract": True,
                "runnerHooks": [{"module": "subtitle_bridge",
                                 "config": {"overlay": {"demux": "subdemux", "overlay": "ov"}}}]})
        check("H overlay: hook installed", r.wait_log("runner hook 'subtitle_bridge' installed", timeout=5))
        check("H overlay: cue shown from the video path", r.wait_log("[subtitle_bridge] show 'Hi there'", timeout=8))
        r.send({"cmd": "get_property", "id": "gp", "element": "ov", "property": "text"})
        gp = r.wait_event(ev_is("property", id="gp"))
        check("H overlay: textoverlay text is the cue", gp is not None and gp.get("value") == "Hi there")
        check("H overlay: cue cleared after its span", r.wait_log("[subtitle_bridge] clear", timeout=8))
        check("H overlay: no error", not r.has_event(ev_is("error")))
        code = r.stop_and_wait()
        check("H overlay: exits 0", code == 0)
    finally:
        r.kill()
        for f in os.listdir(tmp):
            os.unlink(os.path.join(tmp, f))
        os.rmdir(tmp)


# --------------------------------------------------------------------------- O: deinterlace guard hook (native form, #817)
def make_gdp_frames(path, n=40, discont_at=10, reanchor_at=25):
    """Raw 64x48 25 fps frames from 10 s as GDP (which keeps PTS, duration and
    flags), written to `path`: a DISCONT at `discont_at` and a real re-anchor,
    2 s earlier, from `reanchor_at` on — deinterlace_guard_test.py's fixture."""
    pipe = Gst.parse_launch(
        f"videotestsrc num-buffers={n} pattern=ball timestamp-offset={10 * Gst.SECOND} "
        "! video/x-raw,format=I420,width=64,height=48,framerate=25/1 ! identity name=mark "
        f"! gdppay ! filesink location={path}")
    seen = {"i": 0}

    def mark(_pad, info):
        buf = info.get_buffer()
        i = seen["i"]
        seen["i"] += 1
        if i in (discont_at, reanchor_at):
            buf.set_flags(Gst.BufferFlags.DISCONT)
        if i >= reanchor_at:
            buf.pts -= 2 * Gst.SECOND
        return Gst.PadProbeReturn.OK

    pipe.get_by_name("mark").get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, mark)
    pipe.set_state(Gst.State.PLAYING)
    pipe.get_bus().timed_pop_filtered(10 * Gst.SECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR)
    pipe.set_state(Gst.State.NULL)
    return os.path.getsize(path)


def read_gdp_pts(path):
    """PTS (ms) of every buffer in a GDP file."""
    pts = []
    pipe = Gst.parse_launch(f"filesrc location={path} ! gdpdepay ! fakesink name=s sync=false")
    pipe.get_by_name("s").get_static_pad("sink").add_probe(
        Gst.PadProbeType.BUFFER, lambda _p, info: (pts.append(info.get_buffer().pts // 1_000_000), Gst.PadProbeReturn.OK)[1])
    pipe.set_state(Gst.State.PLAYING)
    pipe.get_bus().timed_pop_filtered(10 * Gst.SECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR)
    pipe.set_state(Gst.State.NULL)
    return pts


def test_deinterlace_guard_hook():
    """The transcoder's `deinterlace_guard` on BOTH runners over the real
    protocol: a GDP fixture (a DISCONT, then a real 2 s re-anchor) through
    `deinterlace method=yadif` into a GDP file. Native and python write the
    same frames and log the same drop lines; the output steps back once, at
    the real re-anchor, where the unguarded run steps back at every re-send."""
    so = os.path.join(_PLUGINS, "transcoder", "native", "deinterlace-guard", "libmrhook_deinterlace_guard.so")
    if not os.path.exists(so):
        print(f"SKIP O — {so} not built")
        return
    for el in ("videotestsrc", "deinterlace", "gdppay", "gdpdepay"):
        if Gst.ElementFactory.find(el) is None:
            print(f"SKIP O — {el} unavailable")
            return
    tmp = tempfile.mkdtemp(prefix="mrtest-")
    fixture = os.path.join(tmp, "in.gdp")
    check("O fixture GDP generated", make_gdp_frames(fixture) > 40 * 64 * 48 * 3 // 2)
    # The engine puts every plugins/*/py dir on the python runner's PYTHONPATH.
    saved = os.environ.get("PYTHONPATH")
    os.environ["PYTHONPATH"] = os.pathsep.join(filter(None, [os.path.join(_PLUGINS, "transcoder", "py"), saved]))
    hook = [{"module": "deinterlace_guard", "config": {"element": "deint"}}]
    pts, drops, runs = {}, {}, []
    try:
        for kind, argv, hooks in (("native", None, hook), ("py", _PY_RUNNER, hook), ("unguarded", None, [])):
            out = os.path.join(tmp, f"{kind}.gdp")
            r = RunnerProc(argv)
            runs.append(r)
            r.wait_event(ev_is("ready"))
            r.send({"cmd": "start", "runnerHooks": hooks,
                    "pipeline": f"filesrc location={fixture} ! gdpdepay "
                                "! deinterlace name=deint mode=interlaced method=yadif "
                                f"! gdppay ! filesink location={out} sync=false"})
            check(f"O {kind}: ran to EOS", r.wait_event(ev_is("eos"), timeout=15) is not None)
            r.stop_and_wait()
            check(f"O {kind}: no error, no warning",
                  not r.has_event(ev_is("error")) and not r.has_event(ev_is("warning")))
            drops[kind] = [line[line.index("[deinterlace_guard]"):] for line in r.logs if "[deinterlace_guard]" in line]
            pts[kind] = read_gdp_pts(out)
        check("O native: hook installed", any("runner hook 'deinterlace_guard' installed" in l for l in runs[0].logs))
        steps = {k: [(a, b) for a, b in zip(v, v[1:]) if b <= a] for k, v in pts.items()}
        check(f"O unguarded steps back at every re-send ({len(steps['unguarded'])})", len(steps["unguarded"]) > 1)
        check("O native steps back once, at the real 2 s re-anchor",
              len(steps["native"]) == 1 and 1900 <= steps["native"][0][0] - steps["native"][0][1] <= 2100)
        dropped = sum(int(l.split("dropped ")[1].split()[0]) for l in drops["native"])
        check(f"O native: every missing frame is a logged drop ({dropped})",
              dropped > 0 and len(pts["unguarded"]) - len(pts["native"]) == dropped)
        check("O native and python write the same frames", pts["native"] == pts["py"] and len(pts["py"]) > 40)
        check("O native and python log the same drop lines", drops["native"] == drops["py"])
        if drops["native"]:
            print("    first drop line:", drops["native"][0])
        # A missing element: both runners warn the same and the pipeline runs on.
        warned = {}
        for kind, argv in (("native", None), ("py", _PY_RUNNER)):
            r = RunnerProc(argv)
            runs.append(r)
            r.wait_event(ev_is("ready"))
            r.send({"cmd": "start", "pipeline": "videotestsrc num-buffers=5 ! fakesink",
                    "runnerHooks": [{"module": "deinterlace_guard", "config": {"element": "nope"}}]})
            warned[kind] = (r.wait_event(ev_is("warning"), timeout=5) or {}).get("message")
            check(f"O {kind}: a missing element still runs to EOS", r.wait_event(ev_is("eos"), timeout=10) is not None)
        check("O both warn the same for a missing element",
              warned["native"] == warned["py"] == "deinterlace guard: element 'nope' not found — not installed")
    finally:
        if saved is None:
            os.environ.pop("PYTHONPATH", None)
        else:
            os.environ["PYTHONPATH"] = saved
        for r in runs:
            r.kill()
        for f in os.listdir(tmp):
            os.unlink(os.path.join(tmp, f))
        os.rmdir(tmp)


# --------------------------------------------------------------------------- I/J/K: video gates (Stage 3a)
def make_h264_ts(path):
    """A short H.264 SPTS (64x48 @ 25 fps, 10-frame GOPs) from x264enc."""
    from gi.repository import GLib
    pipe = Gst.parse_launch(
        "videotestsrc num-buffers=75 ! video/x-raw,width=64,height=48,framerate=25/1 "
        "! x264enc key-int-max=10 tune=zerolatency speed-preset=ultrafast ! h264parse "
        f"! mpegtsmux ! filesink location={path}")
    loop = GLib.MainLoop()
    bus = pipe.get_bus()
    bus.add_signal_watch()
    bus.connect("message", lambda _b, msg: loop.quit() if msg.type in (Gst.MessageType.EOS, Gst.MessageType.ERROR) else None)
    GLib.timeout_add_seconds(20, lambda: (loop.quit(), False)[1])
    pipe.set_state(Gst.State.PLAYING)
    loop.run()
    pipe.set_state(Gst.State.NULL)
    return os.path.getsize(path)


def test_video_gates():
    for el in ("x264enc", "h264parse", "tsdemux", "mpegtsmux", "identity", "appsink"):
        if Gst.ElementFactory.find(el) is None:
            print(f"SKIP I/J/K — {el} unavailable")
            return
    tmp = tempfile.mkdtemp(prefix="mrtest-")
    ts = os.path.join(tmp, "v.ts")
    check("I fixture H.264 TS generated", make_h264_ts(ts) > 188 * 20)

    # --- I: pad-link rule + stream discovery, then the keyframe gate on a
    # statically linked decoder (the gate is armed at start on a named element
    # of the parsed graph, as in python; video-player names its decoder there).
    r = RunnerProc()
    try:
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start",
                "pipeline": f"filesrc location={ts} ! tsdemux name=demux latency=0",
                "timeSyncContract": True,
                "linkOnPadAdded": [{"from": "demux", "media": "video",
                                    "branches": ["queue ! fakesink name=vs sync=false"]}]})
        disc = r.wait_event(lambda e: e.get("event") == "plugin_event" and e.get("channel") == "stream:discovered", timeout=8)
        check("I stream discovery reports the video pad",
              disc is not None and disc["payload"].get("media") == "video" and disc["payload"].get("pid", 0) > 0
              and "video/x-h264" in disc["payload"].get("caps", ""))
        linked = r.wait_event(ev_is("pad_linked"), timeout=8)
        check("I pad-link rule linked branch 0 on demux::video",
              linked is not None and linked.get("rule") == "demux::video" and linked.get("index") == 0)
        check("I ran to EOS", r.wait_event(ev_is("eos"), timeout=15) is not None)
        check("I no error events", not r.has_event(ev_is("error")))
        code = r.stop_and_wait()
        check("I exits 0", code == 0)
    finally:
        r.kill()

    r = RunnerProc()
    try:
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start",
                "pipeline": f"filesrc location={ts} ! tsdemux name=demux latency=0 ! h264parse "
                            "! identity name=dec ! fakesink name=vs sync=false",
                "timeSyncContract": True, "keyframeGate": {"decoder": "dec"}})
        check("I keyframe gate opened on the first keyframe",
              r.wait_log("keyframe gate: dec opened on first keyframe (0 delta unit(s) dropped)", timeout=8))
        check("I gated pipeline ran to EOS", r.wait_event(ev_is("eos"), timeout=15) is not None)
        check("I gated pipeline: no error events", not r.has_event(ev_is("error")))
        code = r.stop_and_wait()
        check("I gated pipeline exits 0", code == 0)
    finally:
        r.kill()

    # --- J: TS video-info probe on a tap appsink
    r = RunnerProc()
    try:
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start",
                # blocksize=1316: bus buffers are whole TS packets (ADR-0011); a
                # misaligned file block yields nothing, on either runner.
                "pipeline": f"filesrc location={ts} blocksize=1316 ! tee name=t ! queue ! fakesink sync=false "
                            "t. ! queue ! appsink name=tap",
                "timeSyncContract": True, "tsProbe": {"appsink": "tap"}})
        first = r.wait_event(lambda e: e.get("event") == "plugin_event" and e.get("channel") == "tsprobe:videoinfo", timeout=8)
        check("J probe reports the video ES codec from the PMT",
              first is not None and first["payload"].get("codec") == "h264" and first["payload"].get("pid", 0) > 0)
        full = r.wait_event(lambda e: e.get("event") == "plugin_event" and e.get("channel") == "tsprobe:videoinfo"
                            and e["payload"].get("width"), timeout=8)
        pmt = r.wait_event(lambda e: e.get("event") == "plugin_event" and e.get("channel") == "tsprobe:pmt", timeout=8)
        check("J probe reports the whole PMT with per-ES descriptor hex",
              pmt is not None and any(s.get("streamType") == 0x1b and isinstance(s.get("esInfo"), str)
                                      for s in pmt["payload"].get("streams", []))
              and pmt["payload"].get("pcrPid", 0) > 0)
        check("J probe parses the SPS into width/height/fps",
              full is not None and full["payload"].get("width") == 64 and full["payload"].get("height") == 48
              and abs((full["payload"].get("fps") or 0) - 25) < 0.01 and "64" in (full["payload"].get("display") or ""))
        check("J ran to EOS", r.wait_event(ev_is("eos"), timeout=15) is not None)
        check("J no error events", not r.has_event(ev_is("error")))
    finally:
        r.kill()
        for f in os.listdir(tmp):
            os.unlink(os.path.join(tmp, f))
        os.rmdir(tmp)

    # --- K: render keep-up watch on a sink that presents half the declared rate
    r = RunnerProc()
    try:
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start",
                "pipeline": "videotestsrc is-live=true ! video/x-raw,width=64,height=48,framerate=50/1 "
                            "! identity sleep-time=40000 ! fakesink name=vsink sync=false",
                "timeSyncContract": True, "renderWatch": {"sink": "vsink"}})
        check("K PLAYING", r.wait_event(ev_is("state_change", state="playing"), timeout=5) is not None)
        lag = r.wait_event(lambda e: e.get("event") == "plugin_event" and e.get("channel") == "renderwatch:lag", timeout=12)
        check("K render watch reports lag after three slow windows",
              lag is not None and lag["payload"].get("expectedFps") == 50 and 0 < lag["payload"].get("achievedFps", 0) < 42.5)
        check("K no error events", not r.has_event(ev_is("error")))
        code = r.stop_and_wait()
        check("K exits 0", code == 0)
    finally:
        r.kill()


# --------------------------------------------------------------------------- L: live input branches (#787)
def _drain_timeout_warning(ev):
    return ev.get("event") == "warning" and "EOS drain timed out" in str(ev.get("message", ""))


def test_live_input_branches():
    """An aggregator sink gains and loses input branches on its running
    pipeline (`bus_input_add` / `bus_input_remove`), including a branch with a
    delayed demuxer link, without a rebuild; and `eosDrain: false` lets a
    force-live mixer stop without the 6 s drain stall."""
    if Gst.ElementFactory.find("avenc_s302m") is None or Gst.ElementFactory.find("tsdemux") is None:
        print("SKIP L — avenc_s302m / tsdemux unavailable")
        return
    caps = "audio/x-raw,rate=48000,channels=2"
    tone = f"audiotestsrc is-live=true ! audioconvert ! {caps} ! queue"
    mixer = ("audiomixer name=mixin force-live=true latency=100000000"
             " start-time-selection=first ! capsfilter name=mixin_caps caps=\"" + caps + "\""
             " ! identity name=mixin_out sync=true ! level name=lvl post-messages=true interval=100000000"
             " ! fakesink sync=false")
    r = RunnerProc()
    try:
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start", "pipeline": f"{mixer}  ( name=mixin_in_a {tone} ) ! mixin.sink_0",
                "eosDrain": False})
        check("L reaches PLAYING with one bin branch", r.wait_event(ev_is("state_change", state="playing")) is not None)
        check("L VU flows from the start branch", r.wait_event(ev_is("vu_data"), timeout=3) is not None)

        # Plain branch added live.
        r.send({"cmd": "bus_input_add", "id": "a1", "element": "mixin", "name": "mixin_in_b",
                "description": "audiotestsrc is-live=true freq=880 ! audioconvert ! " + caps + " ! queue"})
        check("L bus_input_add -> bus_input_add_done", r.wait_event(ev_is("bus_input_add_done", id="a1")) is not None)
        r.send({"cmd": "get_property", "id": "p1", "element": "mixin_in_b", "property": "name"})
        p = r.wait_event(lambda e: e.get("event") in ("property", "command_error") and e.get("id") == "p1")
        check("L the added bin is in the pipeline under its name", p is not None and p.get("event") == "property")

        # A branch whose demuxer link is delayed (302M over TS through tsdemux).
        demux_branch = ("audiotestsrc is-live=true ! audioconvert ! audio/x-raw,format=S16LE,rate=48000,channels=2"
                        " ! avenc_s302m strict=experimental ! mpegtsmux ! tsdemux name=mixin_demux_c latency=0"
                        " ! audio/x-smpte-302m ! avdec_s302m ! audioconvert ! audioresample ! " + caps + " ! queue")
        r.send({"cmd": "bus_input_add", "id": "a2", "element": "mixin", "name": "mixin_in_c", "description": demux_branch})
        check("L demuxer-headed branch added live", r.wait_event(ev_is("bus_input_add_done", id="a2")) is not None)
        time.sleep(1.0)
        check("L no error after the live adds", not r.has_event(ev_is("error")))

        # A duplicate add is idempotent (the branch IS the requested state —
        # the producer-PLAYING re-link and the connection re-apply can race for
        # one edge); an unknown aggregator is a command error, never a fault.
        r.send({"cmd": "bus_input_add", "id": "a3", "element": "mixin", "name": "mixin_in_b",
                "description": "audiotestsrc is-live=true ! queue"})
        check("L duplicate branch add is a no-op done", r.wait_event(ev_is("bus_input_add_done", id="a3")) is not None)
        r.send({"cmd": "bus_input_add", "id": "a4", "element": "nope", "name": "mixin_in_d",
                "description": "audiotestsrc is-live=true ! queue"})
        check("L unknown aggregator -> command_error", r.wait_event(ev_is("command_error", id="a4")) is not None)

        # Containment: a branch whose source dies (here: a unixfdsrc on a
        # socket nobody serves) is dropped and reported — never a pipeline
        # error. The mix keeps running on its other inputs.
        tmp = tempfile.mkdtemp(prefix="mrtest-")
        dead = os.path.join(tmp, "dead.sock")
        r.send({"cmd": "bus_input_add", "id": "a5", "element": "mixin", "name": "mixin_in_dead",
                "description": f"unixfdsrc socket-path={dead} ! queue"})
        lost = r.wait_event(lambda e: e.get("event") == "input_branch_lost" and e.get("name") == "mixin_in_dead",
                            timeout=5)
        check("L dead-producer branch is reported as input_branch_lost", lost is not None)
        check("L ...and is NOT a pipeline error", not r.has_event(ev_is("error")))
        r.send({"cmd": "get_property", "id": "p3", "element": "mixin_in_dead", "property": "name"})
        p3 = r.wait_event(lambda e: e.get("event") in ("property", "command_error") and e.get("id") == "p3")
        check("L dropped branch is gone from the pipeline", p3 is not None and p3.get("event") == "command_error")
        check("L mix still flowing after the drop (VU)", r.wait_event(ev_is("vu_data"), timeout=3) is not None)
        os.rmdir(tmp)

        # Live removes: the start-time bin, then a live-added one.
        r.send({"cmd": "bus_input_remove", "id": "r1", "element": "mixin", "name": "mixin_in_a"})
        check("L start-time bin removed live", r.wait_event(ev_is("bus_input_remove_done", id="r1")) is not None)
        r.send({"cmd": "bus_input_remove", "id": "r2", "element": "mixin", "name": "mixin_in_c"})
        check("L demuxer-headed bin removed live", r.wait_event(ev_is("bus_input_remove_done", id="r2")) is not None)
        r.send({"cmd": "get_property", "id": "p2", "element": "mixin_in_a", "property": "name"})
        p2 = r.wait_event(lambda e: e.get("event") in ("property", "command_error") and e.get("id") == "p2")
        check("L removed bin is gone from the pipeline", p2 is not None and p2.get("event") == "command_error")
        r.send({"cmd": "bus_input_remove", "id": "r3", "element": "mixin", "name": "mixin_in_a"})
        check("L removing a branch that is already gone is a no-op done",
              r.wait_event(ev_is("bus_input_remove_done", id="r3")) is not None)
        time.sleep(1.0)
        check("L pipeline still alive after removes (VU)", r.wait_event(ev_is("vu_data"), timeout=3) is not None)
        check("L no error after the live removes", not r.has_event(ev_is("error")))

        # eosDrain:false — a force-live mixer never completes an EOS drain;
        # without the opt-out this stop would stall EOS_DRAIN_TIMEOUT_MS.
        t0 = time.monotonic()
        code = r.stop_and_wait()
        took = time.monotonic() - t0
        check("L exits 0 after stop", code == 0)
        check(f"L eosDrain:false stops a force-live mixer promptly ({took:.1f}s)", took < 3.0)
        check("L no drain timeout warning with eosDrain:false", not r.has_event(_drain_timeout_warning))
    finally:
        r.kill()

    # Control: the default (drain) on the real producer shape — force-live mix
    # into the 302M encode and a bus tee with no edge, i.e. no sink element to
    # post EOS — stalls the full timeout (the .103 measurement behind #787).
    producer = ("audiomixer name=mixin force-live=true latency=200000000"
                " start-time-selection=first ! capsfilter name=mixin_caps caps=\"" + caps + "\""
                " ! identity name=mixin_out sync=true ! audioconvert ! audioresample"
                " ! audio/x-raw,format=S16LE,rate=48000,channels=2 ! avenc_s302m strict=experimental"
                " ! mpegtsmux latency=0 alignment=7"
                " ! capssetter caps=\"video/mpegts,systemstream=true,packetsize=188\" replace=true"
                " ! tee name=busout_41000 allow-not-linked=true"
                f"  ( name=mixin_in_a {tone} ) ! mixin.sink_0")
    r = RunnerProc()
    try:
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start", "pipeline": producer, "timeSyncContract": True})
        check("L control reaches PLAYING", r.wait_event(ev_is("state_change", state="playing")) is not None)
        time.sleep(1.0)
        t0 = time.monotonic()
        r.stop_and_wait(timeout=15)
        took = time.monotonic() - t0
        check(f"L default drain stalls a force-live mixer stop ({took:.1f}s)",
              took >= 5.0 and r.has_event(_drain_timeout_warning))
    finally:
        r.kill()


# --------------------------------------------------------------------------- M: transform producer retime (2026-10-08)
def _retime_run(argv, bufs, tag, align, fx, ts_psi):
    """One runner hosting a transform-producer-shaped pipeline (tsdemux → mpegtsmux
    → bus tee), fed `bufs` over a unixfd edge and read back by a consumer attached
    BEFORE any media: [(pid, serial, PES PTS, PES DTS or None)] in output order,
    and its `branchAlign:` log lines without the runner's prefix."""
    tmp = tempfile.mkdtemp(prefix="mrtest-")
    inp, edge = os.path.join(tmp, "in.sock"), os.path.join(tmp, "edge.sock")
    caps = "video/mpegts, systemstream=(boolean)true, packetsize=(int)188"
    feeder = Gst.parse_launch(f'appsrc name=src format=time block=true max-bytes=4000000 caps="{fx.TS_CAPS}"'
                              f" ! unixfdsink socket-path={inp} sync=false async=false")
    # A contract producer: base_time 0, so the wire carries the stamps verbatim.
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
    feeder.use_clock(clock)
    feeder.set_start_time(Gst.CLOCK_TIME_NONE)
    feeder.set_base_time(0)
    feeder.set_state(Gst.State.PLAYING)
    src = feeder.get_by_name("src")
    r = RunnerProc(argv)
    consumer = None
    rows = []
    # Unbounded queues after each unixfdsrc, as production's ingress has: pushed
    # unpaced, a reader that releases on its own thread deadlocks on the send.
    q = "queue max-size-buffers=0 max-size-bytes=0 max-size-time=0"
    try:
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start",
                "pipeline": f"unixfdsrc socket-path={inp} ! {q} ! tsdemux name=demux latency=0"
                            ' demux. ! video/x-h264 ! capssetter caps="video/x-h264,alignment=(string)au" ! queue ! mux.'
                            ' demux. ! audio/mpeg ! capssetter caps="audio/mpeg,framed=(boolean)true" ! queue ! mux.'
                            f' mpegtsmux name=mux latency=0 alignment=7 ! capssetter caps="{caps}" replace=true'
                            " ! tee name=busout_41200 allow-not-linked=true",
                "timeSyncContract": True, "alignBranchesToStamps": align})
        check(f"M {tag} runner reaches PLAYING",
              r.wait_event(ev_is("state_change", state="playing"), timeout=8) is not None)
        r.send({"cmd": "bus_attach", "tee": "busout_41200", "socket": edge})
        check(f"M {tag} edge attached", r.wait_event(ev_is("bus_attached", socket=edge)) is not None)
        consumer = Gst.parse_launch(f"unixfdsrc socket-path={edge} ! {q} ! fakesink name=csink sync=false")

        def on_buf(_pad, info):
            data = info.get_buffer().extract_dup(0, info.get_buffer().get_size())
            for pkt in ts_psi.iter_packets(data):
                pts = ts_psi.read_pes_pts(pkt) if pkt[1] & 0x40 else None
                if pts is None:
                    continue
                pes = pkt[ts_psi.payload_offset(pkt):]
                key = fx.au_key(pes[9 + pes[8]:])
                if key:
                    q = pes[14:19]
                    dts = ((((q[0] >> 1) & 7) << 30) | (q[1] << 22) | ((q[2] >> 1) << 15) | (q[3] << 7)
                           | (q[4] >> 1)) if (pes[7] & 0xC0) == 0xC0 else None
                    rows.append((key[0], key[1], pts, dts))
            return Gst.PadProbeReturn.OK

        consumer.get_by_name("csink").get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, on_buf)
        consumer.set_state(Gst.State.PLAYING)
        time.sleep(0.5)
        for i, (data, st) in enumerate(bufs):
            b = Gst.Buffer.new_wrapped(data)
            b.pts = b.dts = st
            src.emit("push-buffer", b)
            if i % 50 == 49:
                # ~6x real time: an unpaced burst fills both unixfd sockets and the
                # elements' release-under-lock deadlocks them (gst 1.28.2).
                time.sleep(0.01)
        seen, quiet = -1, 0
        while quiet < 10:                       # 1 s without a new access unit
            time.sleep(0.1)
            quiet = quiet + 1 if len(rows) == seen else 0
            seen = len(rows)
        check(f"M {tag} no lifecycle error", not r.has_event(ev_is("error")))
        check(f"M {tag} exits 0 after stop", r.stop_and_wait() == 0)
    finally:
        if consumer is not None:
            consumer.set_state(Gst.State.NULL)
        feeder.set_state(Gst.State.NULL)
        r.kill()
        for f in os.listdir(tmp):
            os.unlink(os.path.join(tmp, f))
        os.rmdir(tmp)
    return rows, [line.split("branchAlign: ", 1)[1] for line in r.logs if "branchAlign: " in line]


def test_transform_producer_align():
    """`alignBranchesToStamps.transformProducer` on BOTH runners over the real
    protocol: a stamped SPTS whose video PES lead the PCR by ~1.1 s
    (transform_input_fixture) into a transform-producer-shaped runner, whose
    egress PES carry its running time + 1 h. Every access unit must leave on its
    content time from the FIRST one out with nothing dropped (the bus input is
    held until a stamp moves, then re-chained), through 70 s of a swinging VBR
    lead and a 427 s source rewind, B-frame DTS intact — and both twins must log
    the same lines. Mux mode on the same cut is the control that fails."""
    for el in ("unixfdsink", "unixfdsrc", "tsdemux", "mpegtsmux", "capssetter"):
        if Gst.ElementFactory.find(el) is None:
            print(f"SKIP M — {el} unavailable")
            return
    sys.path.insert(0, _HERE)
    import transform_input_fixture as fx  # noqa: E402  (puts mpegts-core/py on the path)
    import ts_psi  # noqa: E402
    import ts_timeline  # noqa: E402
    py = ["env", "PYTHONPATH=" + os.path.join(_PLUGINS, "mpegts-core", "py"), sys.executable,
          os.path.join(_HERE, "gst-pipeline-runner.py")]
    producer = {"demuxes": ["demux"], "transformProducer": True}
    wrap = 1 << 33

    def fold(d):
        d %= wrap
        return d - wrap if d > wrap // 2 else d

    def err_ms(ticks, target_ns):
        """An output PES (− 1 h) against its content time, in ms."""
        return fold(ticks - ts_timeline.MUX_CLOCK_BASE_90K - target_ns * 9 // 100000) / 90.0

    # 1. A cut whose first moved stamp is 6 bus buffers in: the start-up hold's case.
    bufs1, targets1 = fx.stamp(fx.build_packets(10, dts_lead_ms=1100.0), 2.697, 200_000 * 10**9)
    first_alone = {}
    for pid, s, _e in fx.run_demux(Gst, bufs1, targets1):
        first_alone.setdefault(pid, s)
    # 2. 70 s: the video lead swinging 0.9–1.4 s, the source 40 ppm slow, a 427 s rewind at 40 s.
    dts2 = {}
    bufs2, targets2 = fx.stamp(fx.build_packets(70, dts_lead_ms=900.0, lead_swing_ms=500.0, jump_at_s=40.0),
                               2.2, 200_000 * 10**9, -40.0, dts_targets=dts2)
    logs = {}
    for tag, argv in (("native", None), ("python", py)):
        rows1, logs1 = _retime_run(argv, bufs1, f"{tag} cut", producer, fx, ts_psi)
        first, serials = {}, {}
        for pid, s, _p, _d in rows1:
            first.setdefault(pid, s)
            serials.setdefault(pid, []).append(s)
        e1 = [err_ms(p, targets1[(pid, s)]) for pid, s, p, _d in rows1]
        check(f"M {tag}: the FIRST access unit out on each PID is tsdemux's first, and none is "
              f"missing after it ({ {hex(k): v for k, v in first.items()} })",
              first == first_alone and all(v == list(range(v[0], v[0] + len(v))) for v in serials.values()))
        check(f"M {tag}: every access unit leaves on its content time from that first one "
              f"(worst {max(map(abs, e1), default=0):.3f} ms over {len(e1)})",
              len(e1) > 500 and max(map(abs, e1)) <= 20)
        rows2, logs2 = _retime_run(argv, bufs2, f"{tag} 70 s", producer, fx, ts_psi)
        e2 = [err_ms(p, targets2[(pid, s)]) for pid, s, p, _d in rows2]
        last, back = {}, 0.0
        for pid, _s, p, d in rows2:
            t = p if d is None else d
            if pid in last:
                back = max(back, fold(last[pid] - t) / 90.0)
            last[pid] = t
        check(f"M {tag}: 70 s of swing + slow clock + rewind, on content time (worst "
              f"{max(map(abs, e2), default=0):.3f} ms over {len(e2)}), never a step back "
              f"(largest {back:.3f} ms)",
              len(e2) > 4500 and max(map(abs, e2)) <= 20 and back <= 20)
        vid = [r for r in rows2 if r[0] == fx.VIDEO_PID]
        kept = max(abs((fold(p - (p if d is None else d)) / 90.0)
                       - (targets2[(pid, s)] - dts2[(pid, s)]) / 1e6) for pid, s, p, d in vid)
        check(f"M {tag}: B-frames — DTS strictly increasing, every PTS−DTS kept (worst change "
              f"{kept * 1e3:.1f} µs, {sum(1 for r in vid if r[3] is not None)} AUs with a DTS)",
              all(fold((b[3] or b[2]) - (a[3] or a[2])) > 0 for a, b in zip(vid, vid[1:])) and kept < 0.1
              and sum(1 for r in vid if r[3] is not None) > 500)
        check(f"M {tag}: the rewind opened stamp epoch #1, then put it on its own stamps",
              any("PTS discontinuity -42" in l for l in logs2) and any("epoch #1 on its stamps" in l for l in logs2))
        logs[tag] = (logs1, logs2)
    check("M both twins log the same retime lines, word for word", logs["native"] == logs["python"])
    if logs["native"] != logs["python"]:
        print("    native:", logs["native"], "\n    python:", logs["python"])
    rows0, _ = _retime_run(None, bufs1, "native mux-mode control", {"demuxes": ["demux"]}, fx, ts_psi)
    e0 = [err_ms(p, targets1[(pid, s)]) for pid, s, p, _d in rows0]
    check(f"M control: the same cut WITHOUT transformProducer leaves the input's lead in "
          f"(best {min(map(abs, e0), default=0):.0f} ms off), so the checks above can fail",
          len(e0) > 500 and min(map(abs, e0)) > 1000)


# --------------------------------------------------------------------------- P: mpegts-muxer inputs retimed (2026-10-08)
def _mux_run(argv, feed, tag, align, fx, ts_psi):
    """One runner hosting the mpegts-muxer's shape — N `unixfdsrc → tsdemux
    name=demux_<i>` inputs into one live `mpegtsmux` (the module's latency
    properties) → bus tee — fed `feed` = [(arrival, input, bytes, stamp)] in
    arrival order and read back by a consumer attached BEFORE any media.
    Returns [(pid, serial, PES PTS, PES DTS or None)] in output order, the
    `branchAlign:` lines without the runner's prefix, and how many times
    mpegtsmux ignored a DTS going backward."""
    tmp = tempfile.mkdtemp(prefix="mrtest-")
    n_in = 1 + max(i for _a, i, _d, _s in feed)
    socks, edge = [os.path.join(tmp, f"in{i}.sock") for i in range(n_in)], os.path.join(tmp, "edge.sock")
    caps = "video/mpegts, systemstream=(boolean)true, packetsize=(int)188"
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
    feeders = []
    for s in socks:
        f = Gst.parse_launch(f'appsrc name=src format=time block=true max-bytes=4000000 caps="{fx.TS_CAPS}"'
                             f" ! unixfdsink socket-path={s} sync=false async=false")
        f.use_clock(clock)
        f.set_start_time(Gst.CLOCK_TIME_NONE)
        f.set_base_time(0)                      # a contract producer: the wire carries the stamps
        f.set_state(Gst.State.PLAYING)
        feeders.append(f)
    r = RunnerProc(["env", "GST_DEBUG=basetsmux:2", "GST_DEBUG_NO_COLOR=1"] + (argv or [_BIN]))
    consumer = None
    rows = []
    q = "queue max-size-buffers=0 max-size-bytes=0 max-size-time=0"
    heads = " ".join(f"unixfdsrc socket-path={s} ! {q} ! tsdemux name=demux_{i} latency=0"
                     for i, s in enumerate(socks))
    try:
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start",
                "pipeline": f"{heads}"
                            ' demux_0. ! audio/mpeg ! capssetter caps="audio/mpeg,framed=(boolean)true" ! queue ! mux.'
                            ' demux_1. ! video/x-h264 ! capssetter caps="video/x-h264,alignment=(string)au" ! queue ! mux.'
                            " mpegtsmux name=mux latency=1200000000 min-upstream-latency=1200000000 alignment=7"
                            f' ! capssetter caps="{caps}" replace=true ! tee name=busout_41300 allow-not-linked=true',
                "timeSyncContract": True, "alignBranchesToStamps": align, "houseTimelineEgress": True})
        check(f"P {tag} runner reaches PLAYING",
              r.wait_event(ev_is("state_change", state="playing"), timeout=8) is not None)
        r.send({"cmd": "bus_attach", "tee": "busout_41300", "socket": edge})
        check(f"P {tag} edge attached", r.wait_event(ev_is("bus_attached", socket=edge)) is not None)
        consumer = Gst.parse_launch(f"unixfdsrc socket-path={edge} ! {q} ! fakesink name=csink sync=false")

        def on_buf(_pad, info):
            data = info.get_buffer().extract_dup(0, info.get_buffer().get_size())
            for pkt in ts_psi.iter_packets(data):
                pts = ts_psi.read_pes_pts(pkt) if pkt[1] & 0x40 else None
                if pts is None:
                    continue
                pes = pkt[ts_psi.payload_offset(pkt):]
                key = fx.au_key(pes[9 + pes[8]:])
                if key:
                    q5 = pes[14:19]
                    dts = ((((q5[0] >> 1) & 7) << 30) | (q5[1] << 22) | ((q5[2] >> 1) << 15) | (q5[3] << 7)
                           | (q5[4] >> 1)) if (pes[7] & 0xC0) == 0xC0 else None
                    rows.append((key[0], key[1], pts, dts))
            return Gst.PadProbeReturn.OK

        consumer.get_by_name("csink").get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, on_buf)
        consumer.set_state(Gst.State.PLAYING)
        time.sleep(0.5)
        srcs = [f.get_by_name("src") for f in feeders]
        for n, (_arr, i, data, st) in enumerate(feed):
            b = Gst.Buffer.new_wrapped(data)
            b.pts = b.dts = st
            srcs[i].emit("push-buffer", b)
            if n % 50 == 49:
                time.sleep(0.01)            # ~6x real time (see _retime_run)
        seen, quiet = -1, 0
        while quiet < 10:                   # 1 s without a new access unit
            time.sleep(0.1)
            quiet = quiet + 1 if len(rows) == seen else 0
            seen = len(rows)
        check(f"P {tag} no lifecycle error", not r.has_event(ev_is("error")))
        check(f"P {tag} exits 0 after stop", r.stop_and_wait() == 0)
    finally:
        if consumer is not None:
            consumer.set_state(Gst.State.NULL)
        for f in feeders:
            f.set_state(Gst.State.NULL)
        r.kill()
        for f in os.listdir(tmp):
            os.unlink(os.path.join(tmp, f))
        os.rmdir(tmp)
    return (rows, [line.split("branchAlign: ", 1)[1] for line in r.logs if "branchAlign: " in line],
            sum("ignoring DTS going backward" in line for line in r.logs))


def test_mux_inputs_retime():
    """`alignBranchesToStamps.transformProducer` on an mpegts-muxer's input demuxes,
    BOTH runners: a passthrough AAC leg (a splitter's: anchored stamps, the VBR lead
    swinging 0.25–0.75 s, a 427 s rewind, the source 40 ppm slow) and a transcoded
    video leg (a transform producer's identity egress: K = −3600 s, B-frames) into one
    production-shaped live mux. Every access unit must leave on its content time, so
    audio and video agree; per PID the output stays continuous and monotonic and
    mpegtsmux never ignores a DTS going backward; each demux keeps its own K, hold
    and epochs. Mux mode on the same feed is the control that fails."""
    for el in ("unixfdsink", "unixfdsrc", "tsdemux", "mpegtsmux", "capssetter"):
        if Gst.ElementFactory.find(el) is None:
            print(f"SKIP P — {el} unavailable")
            return
    sys.path.insert(0, _HERE)
    import transform_input_fixture as fx  # noqa: E402  (puts mpegts-core/py on the path)
    import ts_psi  # noqa: E402
    py = ["env", "PYTHONPATH=" + os.path.join(_PLUGINS, "mpegts-core", "py"), sys.executable,
          os.path.join(_HERE, "gst-pipeline-runner.py")]
    producer = {"demuxes": ["demux_0", "demux_1"], "transformProducer": True}
    wrap = 1 << 33

    def fold(d):
        d %= wrap
        return d - wrap if d > wrap // 2 else d

    # Input 0 the splitter's AAC leg, input 1 the transcoder's video (K = −3600 s).
    feed, targets, k_splitter = fx.mux_inputs(70, jump_at_s=40.0)

    def judge(rows):
        """Per AU: output PES (− 1 h) against its content time, ms; and the content span, s."""
        err = {fx.AUDIO_PID: [], fx.VIDEO_PID: []}
        for pid, s, p, _d in rows:
            err[pid].append(fold(p - fx.MUX_BASE - targets[(pid, s)] * 9 // 100000) / 90.0)
        span = (max(targets[(fx.AUDIO_PID, s)] for pid, s, _p, _d in rows if pid == fx.AUDIO_PID)
                - min(targets[(fx.AUDIO_PID, s)] for pid, s, _p, _d in rows if pid == fx.AUDIO_PID)) / 1e9
        return err, span

    def k_of(logs, demux):
        line = next((l for l in logs if l.startswith(f"{demux} retime: released")), "")
        return int(line.split("K=", 1)[1].split()[0]) if "K=" in line else None

    logs = {}
    for tag, argv in (("native", None), ("python", py)):
        rows, lines, back = _mux_run(argv, feed, tag, producer, fx, ts_psi)
        err, span = judge(rows)
        every = err[fx.AUDIO_PID] + err[fx.VIDEO_PID]
        check(f"P {tag}: every access unit leaves the mux on its content time, audio and video "
              f"agree (worst audio {max(map(abs, err[fx.AUDIO_PID]), default=0):.3f} ms over "
              f"{len(err[fx.AUDIO_PID])}, video {max(map(abs, err[fx.VIDEO_PID]), default=0):.3f} ms over "
              f"{len(err[fx.VIDEO_PID])}, A/V spread {max(every, default=0) - min(every, default=0):.3f} ms, "
              f"{span:.0f} s of content)",
              len(err[fx.AUDIO_PID]) > 3000 and len(err[fx.VIDEO_PID]) > 1500 and span >= 60
              and max(map(abs, every)) <= 5 and max(every) - min(every) <= 10)
        last, serials, back_ms = {}, {}, 0.0
        for pid, s, p, d in rows:
            t = p if d is None else d
            if pid in last:
                back_ms = max(back_ms, fold(last[pid] - t) / 90.0)
            last[pid] = t
            serials.setdefault(pid, []).append(s)
        check(f"P {tag}: per PID the output is continuous across the rewind — no access unit "
              f"missing, never a step back (largest {back_ms:.3f} ms), mpegtsmux never ignored a "
              f"DTS going backward ({back} warnings)",
              back_ms <= 0 and back == 0 and len(serials) == 2
              and all(v == list(range(v[0], v[0] + len(v))) for v in serials.values()))
        k0, k1 = k_of(lines, "demux_0"), k_of(lines, "demux_1")
        check(f"P {tag}: each demux holds its own mapping — demux_0 K={k0} (the splitter's), "
              f"demux_1 K={k1} (identity, −3600 s); only demux_0 opened a stamp epoch at the rewind",
              k0 is not None and abs(k0 - k_splitter) < 1_000_000 and k1 == -3_600_000_000_000
              and any(l.startswith("demux_0 retime: pid=0x101 PTS discontinuity -42") for l in lines)
              and any(l.startswith("demux_0 retime: epoch #1 on its stamps") for l in lines)
              and not any(l.startswith("demux_1") and "discontinuity" in l for l in lines))
        # Two streaming threads log: compare each demux's own sequence, not the interleave.
        logs[tag] = {d: [l for l in lines if l.startswith(d + " ")] for d in ("demux_0", "demux_1")}
    check("P both twins log the same retime lines per demux, word for word", logs["native"] == logs["python"])
    if logs["native"] != logs["python"]:
        print("    native:", logs["native"], "\n    python:", logs["python"])
    rows0, _l0, back0 = _mux_run(None, feed, "native mux-mode control", {"demuxes": ["demux_0", "demux_1"]},
                                 fx, ts_psi)
    err0, _span0 = judge(rows0)
    every0 = err0[fx.AUDIO_PID] + err0[fx.VIDEO_PID]
    check(f"P control: the same feed in mux mode leaves audio and video "
          f"{max(every0, default=0) - min(every0, default=0):.0f} ms apart and steps a pad back "
          f"({back0} DTS-backward warnings), so the checks above can fail",
          len(every0) > 3000 and max(every0) - min(every0) > 10 and back0 > 0)


test_plain_pipeline()
test_producer_edge()
test_house_timeline_egress()
test_consumer_data_wait()
test_refusals()
test_presentation_leg()
test_shed_refusals()
test_reanchor_parity()
test_runner_hooks()
test_subtitle_bridge_hook()
test_deinterlace_guard_hook()
test_video_gates()
test_live_input_branches()
test_transform_producer_align()
test_mux_inputs_retime()

if _failures:
    print(f"\n{len(_failures)} FAILED: {_failures}")
    sys.exit(1)
print("\nnative_runner_protocol_test.py: all checks passed")
