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

    def __init__(self):
        env = dict(os.environ, MR_PLUGINS_DIR=_PLUGINS, MALLOC_ARENA_MAX="2")
        self.proc = subprocess.Popen([_BIN], stdin=subprocess.PIPE, stderr=subprocess.PIPE,
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


test_plain_pipeline()
test_producer_edge()
test_consumer_data_wait()
test_refusals()
test_presentation_leg()
test_shed_refusals()
test_runner_hooks()
test_subtitle_bridge_hook()
test_video_gates()

if _failures:
    print(f"\n{len(_failures)} FAILED: {_failures}")
    sys.exit(1)
print("\nnative_runner_protocol_test.py: all checks passed")
