#!/usr/bin/env python3
"""Black-box protocol conformance test for the native runner (mr-gst-runner,
ADR-0019): drives the binary over its stdin/stderr JSON protocol exactly as
`PythonProcess` does and pins the events the engine relies on.

Skips (exit 0) when the binary is not built or GStreamer is unavailable.

Run:  python3 native_runner_protocol_test.py
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
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
                "decoderThreadType": "auto"})
        check("A started event", r.wait_event(ev_is("started")) is not None)
        # No flag in the payload: every pipeline runs on the house clock.
        check("A logs the contract clock with no flag in the payload",
              r.wait_log("contract clock: monotonic, base_time=0"))
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


# --------------------------------------------------------------------------- B2: identity egress (B folded in)
# The python twin, with mpegts-core's py dir on its path as PythonProcess gives it one.
_PY_ENV_RUNNER = ["env", "PYTHONPATH=" + os.path.join(_PLUGINS, "mpegts-core", "py"), sys.executable,
                  os.path.join(_HERE, "gst-pipeline-runner.py")]
_IDENTITY_LINE = re.compile(r"^\[(?:mr-gst-runner|gst-runner\.py)\] (busStamp busout_40000: identity egress: "
                            r"first PES pid=0x([0-9a-f]+) stamp=(\d+) pts=(\d+))$")
_S302M_PRODUCER = ("audiotestsrc is-live=true ! audio/x-raw,format=S32LE,rate=48000,channels=2"
                   " ! avenc_s302m strict=experimental ! mpegtsmux latency=0 alignment=7"
                   " ! capssetter caps=\"{caps}\" replace=true ! capsfilter caps=\"{caps}\""
                   " ! tee name=busout_40000 allow-not-linked=true")


def test_identity_egress():
    """Identity is the only egress (plan ch. 6 WI-P2-3), in both runners: the producer-edge
    lifecycle (splice, arm on the first edge, throughput off the element's counter, disarm on
    the last) and the wire, which carries the mux's PES − 1 h, checked on a consumer pinned to
    the same house clock. Both runners log the identity line in the same words."""
    if Gst.ElementFactory.find("unixfdsink") is None or Gst.ElementFactory.find("avenc_s302m") is None:
        print("SKIP B2 — unixfdsink / avenc_s302m unavailable")
        return
    sys.path.insert(0, os.path.join(_PLUGINS, "mpegts-core", "py"))
    import ts_psi  # noqa: E402
    import ts_timeline  # noqa: E402
    caps = "video/mpegts, systemstream=(boolean)true, packetsize=(int)188"
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
    lines = {}
    for tag, argv in (("native", None), ("py", _PY_ENV_RUNNER)):
        label = f"B2 {tag}"
        tmp = tempfile.mkdtemp(prefix="mrtest-")
        edge = os.path.join(tmp, "edge.sock")
        r = RunnerProc(argv)
        consumer = None
        try:
            r.wait_event(ev_is("ready"), timeout=10)
            r.send({"cmd": "start", "pipeline": _S302M_PRODUCER.format(caps=caps)})
            started = r.wait_event(ev_is("started"), timeout=10)
            check(f"{label}: started, reporting the timing plugin it loaded",
                  started is not None and started.get("timingPlugin") is not None)
            check(f"{label}: reaches PLAYING", r.wait_event(ev_is("state_change", state="playing")) is not None)
            stamped = r.wait_log("native stamper inserted on busout_40000", timeout=2)
            check(f"{label}: mrtsstamp spliced in front of the busout tee", stamped)

            r.send({"cmd": "bus_attach", "tee": "busout_40000", "socket": edge})
            att = r.wait_event(ev_is("bus_attached", socket=edge))
            check(f"{label}: bus_attach -> bus_attached", att is not None and att.get("tee") == "busout_40000")
            check(f"{label}: the first edge arms an identity egress",
                  r.wait_log("busStamp: identity egress armed on busout_40000 (PES - 1 h, native mrtsstamp)",
                             timeout=2))

            consumer = Gst.parse_launch(f"unixfdsrc socket-path={edge} ! fakesink name=csink sync=false")
            # Pinned exactly as the runner pins a contract pipeline, so the wire's
            # absolute house time comes out as the buffer timestamp unchanged.
            consumer.use_clock(clock)
            consumer.set_start_time(Gst.CLOCK_TIME_NONE)
            consumer.set_base_time(0)
            got = []

            def on_buf(_pad, info, got=got):
                buf = info.get_buffer()
                pkts = list(ts_psi.iter_packets(buf.extract_dup(0, buf.get_size())))
                pcr = any(ts_psi.read_pcr(p) is not None for p in pkts)
                for pkt in pkts:
                    pts = ts_psi.read_pes_pts(pkt) if pkt[1] & 0x40 else None
                    if pts is not None:
                        got.append((ts_psi.ts_pid(pkt), pts, buf.pts, pcr))
                        break
                return Gst.PadProbeReturn.OK

            consumer.get_by_name("csink").get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, on_buf)
            consumer.set_state(Gst.State.PLAYING)
            deadline = time.monotonic() + 6
            while time.monotonic() < deadline and len(got) < 12:
                time.sleep(0.05)
            check(f"{label}: the consumer receives stamped PES buffers over the edge", len(got) >= 12)
            # From the first PCR on: the 302M PES are private (0xBD), so a buffer the arm met
            # before the PCR PID is known is stamped at arrival (mrts::IdentityStamp's rule).
            first_pcr = next((i for i, g in enumerate(got) if g[3]), len(got))
            off = [buf_pts - ts_timeline.house_from_mux_pts(pts, buf_pts)
                   for _pid, pts, buf_pts, _pcr in got[first_pcr:]]
            check(f"{label}: every wire timestamp is the mux's PES PTS − 1 h, to the tick "
                  f"(worst {max((abs(o) for o in off), default=0) / 1e3:.1f} µs)",
                  len(off) >= 10 and all(abs(o) <= 11112 for o in off))
            ident = None
            if r.wait_log("identity egress: first PES", timeout=3):
                ident = next((m for m in map(_IDENTITY_LINE.match, r.logs) if m), None)
            check(f"{label}: one identity line, its stamp the PES − 1 h of its pts on the mux's PID",
                  ident is not None
                  and sum(1 for line in r.logs if "identity egress: first PES" in line) == 1
                  and got and int(ident.group(2), 16) == got[0][0]
                  and int(ident.group(3)) == ts_timeline.house_from_mux_pts(int(ident.group(4)),
                                                                            int(ident.group(3))))
            lines[tag] = ident

            r.send({"cmd": "track_throughput", "id": "tt", "element": "busout_40000", "pad": "sink"})
            r.wait_event(ev_is("tracking", id="tt"))
            time.sleep(0.5)
            r.send({"cmd": "get_throughput", "id": "gt"})
            tp = r.wait_event(ev_is("throughput", id="gt"))
            check(f"{label}: tee throughput via the element's counter",
                  tp is not None and tp["data"]["busout_40000"]["total_bytes"] > 0)

            # A second attach for the same edge is idempotent.
            r.send({"cmd": "bus_attach", "tee": "busout_40000", "socket": edge})
            time.sleep(0.3)
            check(f"{label}: duplicate attach is a no-op",
                  len([e for e in r.events if e.get("event") == "bus_attached"]) == 1)

            consumer.set_state(Gst.State.NULL)
            r.send({"cmd": "bus_detach", "socket": edge})
            check(f"{label}: bus_detach -> bus_detached", r.wait_event(ev_is("bus_detached", socket=edge)) is not None)
            check(f"{label}: stamper disarmed on the last edge", r.wait_log("stamper disarmed", timeout=2))
            check(f"{label}: socket file removed after detach", not os.path.exists(edge))

            # Attach on a tee that does not exist stays pending, never errors.
            r.send({"cmd": "bus_attach", "tee": "busout_99999", "socket": os.path.join(tmp, "ghost.sock")})
            time.sleep(0.6)
            check(f"{label}: attach on a missing tee is pending, not an error", not r.has_event(ev_is("error")))
            check(f"{label}: no warning on a healthy egress", not r.has_event(ev_is("warning")))
            check(f"{label}: exits 0 after stop", r.stop_and_wait() == 0)
        finally:
            if consumer is not None:
                consumer.set_state(Gst.State.NULL)
            r.kill()
            for f in os.listdir(tmp):
                os.unlink(os.path.join(tmp, f))
            os.rmdir(tmp)
    check("B2: both runners log the identity line in the same words",
          all(lines.get(t) for t in ("native", "py"))
          and lines["native"].group(1).split(" stamp=")[0] == lines["py"].group(1).split(" stamp=")[0])


# --------------------------------------------------------------------------- stamper-missing (WI-P2-3)
def test_stamper_missing():
    """libgstmrtsstamp.so absent, libgstmrtshouse.so present, in both runners: a producer
    raises rule 6's alarm with the tried paths (the same detail in both), runs unstamped
    with no fallback, and its `started` carries no timingPlugin so the alarm stands; a
    pipeline without a bus egress neither tries nor misses the plugin."""
    house_so = os.path.join(_PLUGINS, "mpegts-core", "native", "mrtshouse", "libgstmrtshouse.so")
    if not os.path.exists(house_so) or Gst.ElementFactory.find("avenc_s302m") is None:
        print("SKIP stamper-missing — libgstmrtshouse.so not built / avenc_s302m unavailable")
        return
    caps = "video/mpegts, systemstream=(boolean)true, packetsize=(int)188"
    root = tempfile.mkdtemp(prefix="mrtest-plugins-")
    os.makedirs(os.path.join(root, "mpegts-core", "native", "mrtshouse"))
    os.symlink(house_so, os.path.join(root, "mpegts-core", "native", "mrtshouse", "libgstmrtshouse.so"))
    env = ["env", f"MR_PLUGINS_DIR={root}", "MR_LIBEXEC_DIR=/nonexistent"]
    detail = ("libgstmrtsstamp.so not loaded, tried "
              f"{root}/mpegts-core/native/mrtsstamp/libgstmrtsstamp.so, "
              "/nonexistent/mpegts-core/libgstmrtsstamp.so")
    try:
        for tag, argv in (("native", [_BIN]), ("py", _PY_ENV_RUNNER)):
            label = f"stamper-missing {tag}"
            r = RunnerProc(env + argv)
            try:
                r.wait_event(ev_is("ready"), timeout=10)
                r.send({"cmd": "start", "pipeline": _S302M_PRODUCER.format(caps=caps)})
                started = r.wait_event(ev_is("started"), timeout=10)
                alarm = next((e for e in r.events if e.get("event") == "warning"
                              and e.get("kind") == "timing_plugin"), None)
                check(f"{label}: one timing_plugin warning, the rule-6 sentence with the tried paths",
                      alarm is not None and alarm.get("detail") == detail
                      and alarm.get("message", "").startswith("Native TS module not loaded: ")
                      and alarm["message"].endswith(f" ({detail})")
                      and sum(1 for e in r.events if e.get("kind") == "timing_plugin") == 1)
                check(f"{label}: the start reports no timing plugin, so the alarm stands",
                      started is not None and "timingPlugin" in started and started["timingPlugin"] is None)
                check(f"{label}: and still plays, unstamped (nothing spliced, no error)",
                      r.wait_event(ev_is("state_change", state="playing")) is not None
                      and not r.wait_log("native stamper inserted", timeout=0.5)
                      and not r.has_event(ev_is("error")))
                check(f"{label}: exits 0 after stop", r.stop_and_wait() == 0)
            finally:
                r.kill()
            r = RunnerProc(env + argv)
            try:
                r.wait_event(ev_is("ready"), timeout=10)
                r.send({"cmd": "start", "pipeline": "audiotestsrc is-live=true ! fakesink sync=false"})
                started = r.wait_event(ev_is("started"), timeout=10)
                check(f"{label}: a pipeline without a bus egress neither tries nor misses it",
                      started is not None and started.get("timingPlugin") is not None
                      and not r.has_event(ev_is("warning")))
                r.stop_and_wait()
            finally:
                r.kill()
    finally:
        shutil.rmtree(root, ignore_errors=True)


# --------------------------------------------------------------------------- identity-base-time (WI-P1-7)
def test_identity_base_time():
    """An identity egress on a natural base time (`liveCaptureClock`, as
    video-encoder runs) whose PES carry house time + 1 h: the wire is PES − 1 h
    exactly, on both runners. The base is this box's uptime, so unwrapping against
    running time would miss by the base and by whole 2^33 periods."""
    for el in ("unixfdsink", "unixfdsrc", "udpsrc", "capssetter"):
        if Gst.ElementFactory.find(el) is None:
            print(f"SKIP identity-base-time — {el} unavailable")
            return
    sys.path.insert(0, os.path.join(_PLUGINS, "mpegts-core", "py"))
    import ts_psi  # noqa: E402
    import ts_timeline  # noqa: E402
    caps = "video/mpegts, systemstream=(boolean)true, packetsize=(int)188"
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
    py = ["env", "PYTHONPATH=" + os.path.join(_PLUGINS, "mpegts-core", "py"), sys.executable,
          os.path.join(_HERE, "gst-pipeline-runner.py")]

    def pes_packet(pid, pts90k, cc):
        p = pts90k & ((1 << 33) - 1)
        pts = bytes([0x21 | (((p >> 30) & 0x07) << 1), (p >> 22) & 0xFF,
                     0x01 | (((p >> 15) & 0x7F) << 1), (p >> 7) & 0xFF, 0x01 | ((p & 0x7F) << 1)])
        pkt = (bytes([ts_psi.SYNC, 0x40 | (pid >> 8), pid & 0xFF, 0x10 | (cc & 0x0F)])
               + b"\x00\x00\x01\xe0\x00\x00\x80\x80\x05" + pts)
        return pkt + b"\xff" * (ts_psi.PKT - len(pkt))

    anchors = {}
    for tag, argv in (("native", None), ("py", py)):
        label = f"identity-base-time {tag}"
        tmp = tempfile.mkdtemp(prefix="mrtest-")
        edge = os.path.join(tmp, "edge.sock")
        free = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        free.bind(("127.0.0.1", 0))
        port = free.getsockname()[1]
        free.close()
        tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        r = RunnerProc(argv)
        consumer = None
        try:
            r.wait_event(ev_is("ready"), timeout=10)
            r.send({"cmd": "start",
                    "pipeline": f"udpsrc address=127.0.0.1 port={port} caps=\"{caps}\""
                                f" ! capssetter caps=\"{caps}\" replace=true ! capsfilter caps=\"{caps}\""
                                " ! tee name=busout_40000 allow-not-linked=true",
                    "liveCaptureClock": True})
            check(f"{label}: reaches PLAYING",
                  r.wait_event(ev_is("state_change", state="playing"), timeout=10) is not None)
            check(f"{label}: the pipeline keeps its natural base time",
                  r.wait_log("contract clock: monotonic, base_time=natural"))
            r.send({"cmd": "bus_attach", "tee": "busout_40000", "socket": edge})
            check(f"{label}: bus_attach -> bus_attached",
                  r.wait_event(ev_is("bus_attached", socket=edge)) is not None)
            check(f"{label}: the native element is armed as an identity egress",
                  r.wait_log("identity egress armed on busout_40000 (PES - 1 h, native mrtsstamp)",
                             timeout=2))

            consumer = Gst.parse_launch(f"unixfdsrc socket-path={edge} ! fakesink name=csink sync=false")
            # Base 0 on the house clock, as the runner pins a contract pipeline:
            # the buffer timestamp is then the wire's absolute house time.
            consumer.use_clock(clock)
            consumer.set_start_time(Gst.CLOCK_TIME_NONE)
            consumer.set_base_time(0)
            got = []

            def on_buf(_pad, info):
                buf = info.get_buffer()
                pts = ts_psi.read_pes_pts(buf.extract_dup(0, ts_psi.PKT))
                if pts is not None:
                    got.append((pts, buf.pts))
                return Gst.PadProbeReturn.OK

            consumer.get_by_name("csink").get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, on_buf)
            consumer.set_state(Gst.State.PLAYING)
            consumer.get_state(3 * Gst.SECOND)
            # Content = house now + 1 s on a 40 ms cadence, one PES per datagram.
            c0 = clock.get_time() * 9 // 100000 + 90000
            want = {}
            for i in range(40):
                pes = ts_timeline.MUX_CLOCK_BASE_90K + c0 + i * 3600
                want[pes % (1 << 33)] = ts_timeline.pts90k_to_ns(c0 + i * 3600)
                tx.sendto(pes_packet(0x41, pes, i), ("127.0.0.1", port))
                time.sleep(0.04)
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and len(got) < 30:
                time.sleep(0.05)
            check(f"{label}: the consumer receives the stamped PES over the edge", len(got) >= 30)
            off = [wire - want.get(pts, 0) for pts, wire in got]
            worst = max(off, key=abs) if off else None
            check(f"{label}: every wire timestamp is PES − 1 h exactly, under a "
                  f"~{clock.get_time() / 3.6e12:.0f} h base (worst {worst} ns)",
                  bool(got) and all(o == 0 for o in off))
            ident = None
            if r.wait_log("identity egress: first PES", timeout=3):
                ident = next((m for m in map(_IDENTITY_LINE.match, r.logs) if m), None)
            anchors[tag] = ident
            check(f"{label}: the identity line names the first PES's house time, not running time",
                  ident is not None and int(ident.group(2), 16) == 0x41
                  and int(ident.group(3)) == ts_timeline.pts90k_to_ns(c0)
                  and int(ident.group(4)) == (ts_timeline.MUX_CLOCK_BASE_90K + c0) % (1 << 33))
            check(f"{label}: no engine event for it, and no warning",
                  not r.has_event(ev_is("warning"))
                  and not any(str(e.get("event", "")).startswith("timeline_") for e in r.events))
            consumer.set_state(Gst.State.NULL)
            r.send({"cmd": "bus_detach", "socket": edge})
            r.wait_event(ev_is("bus_detached", socket=edge))
            check(f"{label}: exits 0 after stop", r.stop_and_wait() == 0)
        finally:
            if consumer is not None:
                consumer.set_state(Gst.State.NULL)
            tx.close()
            r.kill()
            for f in os.listdir(tmp):
                os.unlink(os.path.join(tmp, f))
            os.rmdir(tmp)
    check("identity-base-time: both runners log the identity line in the same words",
          all(anchors.get(t) for t in ("native", "py"))
          and anchors["native"].group(1).split(" stamp=")[0] == anchors["py"].group(1).split(" stamp=")[0])


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
                "playingTimeoutMs": 500})
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
                "rist": {"role": "sender"}})
        ev = r.wait_event(ev_is("error", kind="unsupported"))
        check("D a python-only field (the legacy rist drain) refused with kind=unsupported",
              ev is not None and "`rist`" in ev["message"])
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
                               " ! tee name=busout_40100 allow-not-linked=true"})
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
        cmd = {"cmd": "start",
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


def test_reanchor_gap_and_undo_parity():
    """Field 2026-10-09 on BOTH runners. N 9: a past-stamped run shorter than the
    rebase hold, an input gap (the valve closed), then the same lateness again —
    the gap must restart the hold, so nothing is rebased. N 10: a rebase that
    moved the leg later, then the producer's own timeline back inside the
    cooldown — the overshoot is undone at once and the paced sink never parks.
    Lateness is set live with the sink's `ts-offset` (case N's idiom)."""
    shed = {"element": "sink", "sink": "sink", "keyframeAligned": False, "toleranceMs": 100,
            "holdMs": 600, "cooldownMs": 60000, "sanityMs": 10000, "onLateness": "reanchor",
            "reanchorToleranceMs": 40, "reanchorHoldMs": 600, "reanchorRetryMs": 1500,
            "rebaseHoldMs": 1500, "rebaseCooldownMs": 30000}
    pipeline = ("audiotestsrc is-live=true samplesperbuffer=480"
                " ! audio/x-raw,format=S16LE,rate=48000,channels=2 ! valve name=v drop=false ! level"
                " ! fakesink name=sink sync=true ts-offset=0")
    runs = {}

    def each(cmd):
        for r in runs.values():
            r.send(cmd)

    def rebases(r):
        r.pump()
        return [e["payload"] for e in r.events if e.get("event") == "plugin_event"
                and e.get("channel") == "playout_reanchor" and e["payload"].get("kind") == "rebase"]

    def ts_offset(ms):
        each({"cmd": "set_property", "id": "o", "element": "sink", "property": "ts-offset",
              "value": int(ms * 1e6)})

    try:
        runs = {"py": RunnerProc(_PY_RUNNER), "native": RunnerProc()}
        for r in runs.values():
            r.wait_event(ev_is("ready"))
        each({"cmd": "start", "pipeline": pipeline, "backlogShed": shed})
        time.sleep(1.5)
        # 9. 0.5 s of 25 s-late buffers, a 2 s gap, the same lateness again, then in range.
        ts_offset(-25000)
        time.sleep(0.5)
        each({"cmd": "set_property", "id": "v", "element": "v", "property": "drop", "value": True})
        time.sleep(2.0)
        each({"cmd": "set_property", "id": "v", "element": "v", "property": "drop", "value": False})
        time.sleep(0.6)
        ts_offset(0)
        time.sleep(1.0)
        gap = {k: rebases(r) for k, r in runs.items()}
        check(f"N 9 an input gap restarts the rebase hold on both — no rebase ({ {k: len(v) for k, v in gap.items()} })",
              all(v == [] for v in gap.values()))
        # 10. A held past-stamped run is rebased; then the producer's timeline is back.
        ts_offset(-25000)
        past = {k: r.wait_event(lambda e: e.get("event") == "plugin_event"
                                and e.get("channel") == "playout_reanchor"
                                and e["payload"].get("kind") == "rebase", timeout=5.0)
                for k, r in runs.items()}
        check("N 10 a held past-stamped run is rebased on both", all(past.values()))
        ts_offset(0)
        time.sleep(0.5)
        for r in runs.values():
            r.pump()
        vu0 = {k: sum(1 for e in r.events if e.get("event") == "vu_data") for k, r in runs.items()}
        time.sleep(3.0)
        for r in runs.values():
            r.pump()
        vu1 = {k: sum(1 for e in r.events if e.get("event") == "vu_data") for k, r in runs.items()}
        undo = {k: rebases(r) for k, r in runs.items()}
        check("N 10 the overshoot is undone at once on both, inside the 30 s cooldown",
              all(len(v) == 2 and v[1].get("latenessMs", 0) < -10000 and v[1].get("count") == 2
                  for v in undo.values()))
        # A sink parked on a 25 s-future buffer blocks `level`: no vu_data at all.
        check(f"N 10 and the paced sink never parks (vu_data {vu0} -> {vu1})",
              all(vu1[k] - vu0[k] >= 3 for k in runs))
        check("N 9-10 no lifecycle error on either runner", not any(r.has_event(ev_is("error")) for r in runs.values()))
    finally:
        for r in runs.values():
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


def _klv_pts(path, pid):
    """PES PTS of every cue on `pid` in a TS file."""
    sys.path.insert(0, os.path.join(_PLUGINS, "mpegts-core", "py"))
    import ts_psi  # noqa: E402
    with open(path, "rb") as f:
        data = f.read()
    return [t for pkt in ts_psi.iter_packets(data) if ts_psi.ts_pid(pkt) == pid
            for t in [ts_psi.read_pes_pts(pkt)] if t is not None]


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
    out = os.path.join(tmp, "out.ts")
    size = make_klv_ts(ts)
    check("G fixture TS generated", size > 188 * 10 and size % 188 == 0)
    r = RunnerProc()
    try:
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start",
                "pipeline": f"filesrc location={ts} ! tsdemux name=demux_0 latency=0 "
                            'mpegtsmux name=mux alignment=7 prog-map="program_map,sink_384=(int)1,PCR_1=sink_384" '
                            f"! filesink name=out location={out} sync=false",
                "runnerHooks": [{"module": "mux_routing", "config": {"inputs": [{
                    "demux": "demux_0", "linkTo": "mux",
                    "routes": {"klv": {"padName": "sink_384", "branch": "queue"},
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
        src_pts, out_pts = _klv_pts(ts, 0x180), _klv_pts(out, 0x180)
        check(f"G no restamp: all {len(out_pts)} cues keep their own PTS, one offset for all",
              len(out_pts) == len(src_pts) == 40 and len({o - i for o, i in zip(out_pts, src_pts)}) == 1)
    finally:
        r.kill()
        for f in os.listdir(tmp):
            os.unlink(os.path.join(tmp, f))
        os.rmdir(tmp)

    # G2: a GENERIC input (one `pid`, no per-class padName) — the hook reads the
    # source PMT and lands the klv-only stream on exactly the input's PID.
    tmp = tempfile.mkdtemp(prefix="mrtest-")
    ts = os.path.join(tmp, "klv.ts")
    out = os.path.join(tmp, "out.ts")
    make_klv_ts(ts)
    r = RunnerProc()
    try:
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start",
                "pipeline": f"filesrc location={ts} ! tsdemux name=demux_0 latency=0 "
                            'mpegtsmux name=mux alignment=7 prog-map="program_map,sink_300=(int)1,PCR_1=sink_300" '
                            f"! filesink name=out location={out} sync=false",
                "runnerHooks": [{"module": "mux_routing", "config": {"inputs": [{
                    "demux": "demux_0", "linkTo": "mux", "pid": 300,
                    "routes": {"video": {"branch": "queue"}, "audio": {"branch": "queue"},
                               "klv": {"branch": "queue"}, "subtitle": {"branch": "queue"}},
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
        src_pts, out_pts = _klv_pts(ts, 0x180), _klv_pts(out, 300)
        check(f"G2 no restamp: all {len(out_pts)} cues on the input PID keep their own PTS",
              len(out_pts) == len(src_pts) == 40 and len({o - i for o, i in zip(out_pts, src_pts)}) == 1)
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


# --------------------------------------------------------------------------- G3: the hook, pads added at once (WI-P2-12)
def test_runner_hooks_concurrent():
    """G3: eight file inputs add their pads at once, through the native hook, 100 starts: the prog-map
    edits go one input at a time (unlocked, one start in ten double-freed it). The branches drop every
    buffer, so mpegtsmux's own unlocked read stays out (R1); mux_routing_test.py pins the python twin."""
    for el in ("tsdemux", "mpegtsmux"):
        if Gst.ElementFactory.find(el) is None:
            print(f"SKIP G3 — {el} unavailable")
            return
    so = os.path.join(_PLUGINS, "mpegts-muxer", "native", "mux-routing", "libmrhook_mux_routing.so")
    if not os.path.exists(so):
        print(f"SKIP G3 — {so} not built")
        return
    tmp = tempfile.mkdtemp(prefix="mrtest-")
    ts = os.path.join(tmp, "klv.ts")
    make_klv_ts(ts)
    pids = [300 + 10 * i for i in range(8)]
    # Each file reaches its demuxer first and a fakesink second (the tee pushes in that order on
    # the file's thread), so the pipeline ends only after every demuxer saw its whole file.
    pipe = (" ".join(f"filesrc location={ts} ! tee name=file_{i} ! tsdemux name=demux_{i} latency=0"
                     f" file_{i}. ! queue ! fakesink sync=false" for i in range(len(pids)))
            + ' mpegtsmux name=mux alignment=7 prog-map="program_map,PCR_1=sink_300" ! fakesink sync=false')
    cfg = {"inputs": [{"demux": f"demux_{i}", "linkTo": "mux", "pid": p,
                       "routes": {c: {"branch": "identity drop-probability=1.0"}
                                  for c in ("video", "audio", "klv", "subtitle")},
                       "ignorePids": [0x1F0], "pcr": {"program": 1}} for i, p in enumerate(pids)]}
    runs = []
    try:
        for _ in range(100):
            r = RunnerProc()
            try:
                r.wait_event(ev_is("ready"))
                r.send({"cmd": "start", "pipeline": pipe,
                        "runnerHooks": [{"module": "mux_routing", "config": cfg}]})
                eos = r.wait_event(ev_is("eos"), timeout=15) is not None
                rc = r.proc.wait(timeout=10) if eos else r.proc.poll()
                runs.append((eos, rc, sorted(e.get("outPid") for e in r.events if e.get("event") == "pad_linked"),
                             [e.get("message") for e in r.events if e.get("event") == "error"]))
                if not (eos and rc == 0 and runs[-1][2] == pids and not runs[-1][3]):
                    print(f"    G3 start {len(runs)}: eos={eos} exit={rc} linked={runs[-1][2]} errors={runs[-1][3]} "
                          f"warnings={[e.get('message') for e in r.events if e.get('event') == 'warning'][:4]} "
                          f"log tail={r.logs[-6:]}")
            finally:
                r.kill()
    finally:
        for f in os.listdir(tmp):
            os.unlink(os.path.join(tmp, f))
        os.rmdir(tmp)
    aborted = [rc for _e, rc, _l, _x in runs if rc is not None and rc < 0]
    check(f"G3 {len(runs)} starts, 8 inputs adding pads at once: none aborted ({len(aborted)} did, "
          f"signals {sorted(set(-s for s in aborted))})", not aborted)
    check("G3 every start ran to EOS with each input's klv on its own PID, no error, exit 0",
          len(runs) == 100 and all(e and rc == 0 and linked == pids and not err for e, rc, linked, err in runs))


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
                "keyframeGate": {"decoder": "dec"}})
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
                "tsProbe": {"appsink": "tap"}})
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
                "renderWatch": {"sink": "vsink"}})
        check("K PLAYING", r.wait_event(ev_is("state_change", state="playing"), timeout=5) is not None)
        lag = r.wait_event(lambda e: e.get("event") == "plugin_event" and e.get("channel") == "renderwatch:lag", timeout=12)
        check("K render watch reports lag after three slow windows",
              lag is not None and lag["payload"].get("expectedFps") == 50 and 0 < lag["payload"].get("achievedFps", 0) < 42.5)
        check("K no error events", not r.has_event(ev_is("error")))
        code = r.stop_and_wait()
        check("K exits 0", code == 0)
    finally:
        r.kill()


# --------------------------------------------------------------------------- L: live input branches (#787, WI-P2-14)
def test_live_input_branches():
    """Plan ch. 6 part 7.3 case L, native: audio-mixer's own start and its own live branch
    (mrtsdemux, then mralignwatch, into the aligned mixer) from fixtures/aligner/pipelines.json;
    a source added and removed on the running mixer, mixed at PES - 1 h from its first buffer with
    no runner retime. The case is gst_live_inputs_test.py's, which runs it on the python runner."""
    sys.path.insert(0, _HERE)
    from gst_live_inputs_test import live_aligned_case
    live_aligned_case([_BIN], "native", check)


def test_aligner_absent():
    """Plan ch. 6 part 7.3 case aligner-absent, native (gst_live_inputs_test.py runs it on the
    python runner): one of three mixer inputs stops 2 s; the mix goes on, its mralignwatch absent
    then present with its stale backlog counted, no error."""
    sys.path.insert(0, _HERE)
    from gst_live_inputs_test import aligner_absent_case
    aligner_absent_case([_BIN], "native", check)


def test_aligner_join_chain():
    """B-74's reproduction, native (gst_live_inputs_test.py runs it on the python runner): a source
    300 ms later joins audio-mixer live; the pace slews to it, the mix never stops, and a fan-in
    downstream keeps both other sources in every block (B-80)."""
    sys.path.insert(0, _HERE)
    from gst_live_inputs_test import aligner_join_chain_case
    aligner_join_chain_case([_BIN], "native", check)


def test_aligner_fall():
    """The pace falls by itself, native (gst_live_inputs_test.py runs it on the python runner): an
    input 300 ms late recovers, the pace falls once the window lets it, in one skip, the mix
    continuous (B-82)."""
    sys.path.insert(0, _HERE)
    from gst_live_inputs_test import aligner_fall_case
    aligner_fall_case([_BIN], "native", check)


# --------------------------------------------------------------------------- M: transform producer retime (2026-10-08)
_AV_BRANCHES = (' demux. ! video/x-h264 ! capssetter caps="video/x-h264,alignment=(string)au" ! queue ! mux.',
                ' demux. ! audio/mpeg ! capssetter caps="audio/mpeg,framed=(boolean)true" ! queue ! mux.')


def _retime_run(argv, bufs, tag, align, fx, ts_psi, branches=_AV_BRANCHES, rate=None):
    """One runner hosting a transform-producer-shaped pipeline (tsdemux → mpegtsmux
    → bus tee), fed `bufs` over a unixfd edge and read back by a consumer attached
    BEFORE any media: [(pid, serial, PES PTS, PES DTS or None)] in output order,
    and its `branchAlign:` log lines without the runner's prefix. `rate` paces the
    feed by its stamps at that many times real time (else bursts of 50 buffers)."""
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
                "pipeline": f"unixfdsrc socket-path={inp} ! {q} ! tsdemux name=demux latency=0" + "".join(branches)
                            + f' mpegtsmux name=mux latency=0 alignment=7 ! capssetter caps="{caps}" replace=true'
                            " ! tee name=busout_41200 allow-not-linked=true",
                "alignBranchesToStamps": align})
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
        t0 = time.monotonic()
        for i, (data, st, *_arrival) in enumerate(bufs):
            if rate:
                ahead = (st - bufs[0][1]) / 1e9 / rate - (time.monotonic() - t0)
                if ahead > 0:
                    time.sleep(ahead)
            b = Gst.Buffer.new_wrapped(data)
            b.pts = b.dts = st
            src.emit("push-buffer", b)
            if not rate and i % 50 == 49:
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


def test_live_remove_start_time_branch():
    """A start-time branch taken off a non-live aligned mixer releases its request pad, both
    runners: its src pad is the parser's ghost<N>, not "src", and a pad left behind holds the
    mixer for ever (the other branch's watchdog then fills up)."""
    caps = "audio/x-raw,rate=48000,channels=2"

    def branch(name, freq):
        return (f"( name=mixin_in_{name} audiotestsrc is-live=true freq={freq} ! audioconvert"
                f" ! {caps} ! mralignwatch name=aw_{name} aligner=mixin input={name}"
                " hold-on-eos=true )")
    pipe = ("audiomixer name=mixin latency=0 start-time-selection=first"
            f" ! capsfilter caps=\"{caps}\" ! fakesink sync=false"
            f"  {branch('a', 440)} ! mixin.sink_0  {branch('b', 880)} ! mixin.sink_1")

    def level(r, rid):
        r.send({"cmd": "get_property", "id": rid, "element": "aw_b", "property": "level-time"})
        ev = r.wait_event(lambda e: e.get("id") == rid
                          and e.get("event") in ("property", "command_error"))
        return ev.get("value") if ev and ev.get("event") == "property" else None

    for kind, argv in (("native", None), ("py", _PY_RUNNER)):
        r = RunnerProc(argv)
        try:
            r.wait_event(ev_is("ready"))
            r.send({"cmd": "start", "pipeline": pipe, "eosDrain": False})
            check(f"L2 {kind}: an aligned mixer with two start-time bins reaches PLAYING",
                  r.wait_event(ev_is("state_change", state="playing"), timeout=10) is not None)
            time.sleep(1.0)
            r.send({"cmd": "bus_input_remove", "id": "r1", "element": "mixin",
                    "name": "mixin_in_a"})
            check(f"L2 {kind}: start-time bin removed live",
                  r.wait_event(ev_is("bus_input_remove_done", id="r1")) is not None)
            time.sleep(2.0)
            lv = level(r, "p1")
            check(f"L2 {kind}: the mixer goes on with the other branch (its watchdog holds "
                  f"{lv / 1e6 if isinstance(lv, int) else lv} ms)",
                  isinstance(lv, int) and lv < 500_000_000)
            check(f"L2 {kind}: no error", not r.has_event(ev_is("error")))
        finally:
            r.kill()


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
    # Paced by the stamps at 4x real time: in bursts a loaded box falls 5 s behind and the
    # runner's leaky edge sheds access units (668 of 675 at load 2.4, 2026-10-17).
    for tag, argv in (("native", None), ("python", py)):
        rows1, logs1 = _retime_run(argv, bufs1, f"{tag} cut", producer, fx, ts_psi, rate=4)
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
        rows2, logs2 = _retime_run(argv, bufs2, f"{tag} 70 s", producer, fx, ts_psi, rate=4)
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
    rows0, _ = _retime_run(None, bufs1, "native mux-mode control", {"demuxes": ["demux"]}, fx, ts_psi, rate=4)
    e0 = [err_ms(p, targets1[(pid, s)]) for pid, s, p, _d in rows0]
    check(f"M control: the same cut WITHOUT transformProducer leaves the input's lead in "
          f"(best {min(map(abs, e0), default=0):.0f} ms off), so the checks above can fail",
          len(e0) > 500 and min(map(abs, e0)) > 1000)


# --------------------------------------------------------------------------- M2: cue pads retimed (WI-P2-12)
# Cues a second apart, then two pauses over 5 s: a subtitle carrier sends only while a cue is live.
_M2_CUES = [1, 2, 3, 4, 5, 6, 12, 13, 14, 15, 22, 23]


def test_cue_pads_retime():
    """M2, `privatePads` on both runners: identity egress with KLV, teletext and DVB cues and two
    pauses over 5 s, into mpegtsmux. Every cue at its own PES PTS, a quiet PID back on the video's
    epoch (its newest after a step); without the flag tsdemux's time. The twins agree."""
    for el in ("unixfdsink", "unixfdsrc", "tsdemux", "mpegtsmux", "capssetter"):
        if Gst.ElementFactory.find(el) is None:
            print(f"SKIP M2 — {el} unavailable")
            return
    sys.path.insert(0, _HERE)
    import transform_input_fixture as fx  # noqa: E402  (puts mpegts-core/py on the path)
    import ts_psi  # noqa: E402
    py = ["env", "PYTHONPATH=" + os.path.join(_PLUGINS, "mpegts-core", "py"), sys.executable,
          os.path.join(_HERE, "gst-pipeline-runner.py")]
    bufs, _targets = fx.cue_egress(25, lambda p: 200_000 * 10**9 + fx.ns(p - fx.DTS0), start_s=2.2,
                                   schedule=_M2_CUES)
    pes_in = {}
    for data, _st, _arr in bufs:
        for pkt in ts_psi.iter_packets(data):
            pts = ts_psi.read_pes_pts(pkt)
            if pts is not None and ts_psi.ts_pid(pkt) in fx.CUE_PIDS:
                key = fx.au_key(pkt[ts_psi.payload_offset(pkt):][14:])
                pes_in[key] = pts
    branches = (_AV_BRANCHES[0], " demux. ! meta/x-klv ! queue ! mux.",
                " demux. ! application/x-teletext ! queue ! mux.", " demux. ! subpicture/x-dvb ! queue ! mux.")
    wrap = 1 << 33

    def ticks_off(rows):
        """Per cue written: output PES PTS − its input PES PTS, in 90 kHz ticks."""
        return {(pid, s): ((p - pes_in[(pid, s)] + wrap // 2) % wrap) - wrap // 2
                for pid, s, p, _d in rows if pid in fx.CUE_PIDS and (pid, s) in pes_in}

    on, logs = {}, {}
    # 4x real time: this sparse feed in bursts of 50 runs far ahead and the 5 s leaky edge sheds.
    for tag, argv in (("native", None), ("python", py)):
        rows, lines = _retime_run(argv, bufs, f"{tag} cues", {"demuxes": ["demux"], "transformProducer": True,
                                                              "privatePads": True}, fx, ts_psi, branches, rate=4)
        off = ticks_off(rows)
        check(f"M2 {tag}: every cue of KLV, teletext and DVB subtitles written at its own PES PTS, "
              f"across both pauses ({len(off)} of {len(pes_in)}, worst "
              f"{max(map(abs, off.values()), default=None)} ticks)",
              len(off) == len(pes_in) >= 30 and all(abs(t) <= 1 for t in off.values()))
        check(f"M2 {tag}: a cue PID's pause is no PTS discontinuity (no stamp epoch of its own)",
              lines and not any("discontinuity" in l for l in lines))
        rows0, _ = _retime_run(argv, bufs, f"{tag} cues, no flag", {"demuxes": ["demux"], "transformProducer": True},
                               fx, ts_psi, branches, rate=4)
        off0 = ticks_off(rows0)
        check(f"M2 {tag}: without privatePads the cues keep tsdemux's time (worst "
              f"{max(map(abs, off0.values()), default=0) / 90:.1f} ms off), so the check above can fail",
              len(off0) >= 30 and max(map(abs, off0.values())) > 90)
        on[tag], logs[tag] = sorted(rows), lines
    check("M2 both twins write the same PES, cues included", on["native"] == on["python"])
    check("M2 both twins log the same retime lines, word for word", logs["native"] == logs["python"])
    if logs["native"] != logs["python"]:
        print("    native:", logs["native"], "\n    python:", logs["python"])
    # The source stepped back 2 s during a 9 s cue pause, its producer re-anchored (stamps kept).
    # The cue back is near both of the video's epochs: it takes the newest, so stays on content time.
    sbufs, _ = fx.cue_egress(20, lambda p: 200_000 * 10**9 + fx.ns(p - fx.DTS0), start_s=2.2,
                             schedule=[1, 2, 3, 4, 13, 14, 15, 16])
    content_pes = {}
    for data, _st, _arr in sbufs:
        for pkt in ts_psi.iter_packets(data):
            if ts_psi.read_pes_pts(pkt) is not None and ts_psi.ts_pid(pkt) in fx.CUE_PIDS:
                content_pes[fx.au_key(pkt[ts_psi.payload_offset(pkt):][14:])] = ts_psi.read_pes_pts(pkt)
    sbufs = fx.step_back(sbufs, 200_000 * 10**9 + 7 * 10**9, 2 * 90000)
    stepped = {}
    for tag, argv in (("native", None), ("python", py)):
        rows, lines = _retime_run(argv, sbufs, f"{tag} cues, step", {"demuxes": ["demux"], "transformProducer": True,
                                                                    "privatePads": True}, fx, ts_psi, branches, rate=4)
        off = {(pid, s): ((p - content_pes[(pid, s)] + wrap // 2) % wrap) - wrap // 2
               for pid, s, p, _d in rows if (pid, s) in content_pes}
        check(f"M2 {tag}: the video stepped back 2 s in a cue pause; every cue on content time, those back "
              f"on the video's new epoch ({len(off)} of {len(content_pes)}, worst "
              f"{max(map(abs, off.values()), default=None)} ticks)",
              len(off) == len(content_pes) >= 15 and all(abs(t) <= 1 for t in off.values())
              and any("PTS discontinuity" in line for line in lines))
        stepped[tag] = sorted(rows)
    check("M2 both twins write the same PES across the step", stepped["native"] == stepped["python"])


# --------------------------------------------------------------------------- M3: the muxer's aligners over a cue pause (WI-P2-12)
_M3_CUES = [1.0, 2.0, 9.0, 10.0]        # a 7 s pause between cues
_M3_SECONDS = 13


def _aligned_mux_run(argv, tag, fx, ts_psi, case="M3", seconds=_M3_SECONDS, cues=_M3_CUES, dark=None):
    """The muxer's description for two generic inputs (hook, `mralignwatch aligner=mux` per route,
    retime with privatePads) at real time: input 0 video and `cues`, silent over `dark` (content s,
    `fx.go_dark`), input 1 video as 0x105. Returns PES in, targets, output, pace, aligner stats, log."""
    tmp = tempfile.mkdtemp(prefix="mrtest-")
    socks, edge = [os.path.join(tmp, f"in{i}.sock") for i in range(2)], os.path.join(tmp, "edge.sock")
    caps = "video/mpegts, systemstream=(boolean)true, packetsize=(int)188"
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
    feeders = []
    for s in socks:
        f = Gst.parse_launch(f'appsrc name=src format=time block=true max-bytes=8000000 caps="{fx.TS_CAPS}"'
                             f" ! unixfdsink socket-path={s} sync=false async=false")
        f.use_clock(clock)
        f.set_start_time(Gst.CLOCK_TIME_NONE)
        f.set_base_time(0)                      # a contract producer: the wire carries the stamps
        f.set_state(Gst.State.PLAYING)
        feeders.append(f)
    ingress = "queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=40000000"
    pipeline = ('mpegtsmux name=mux latency=0 alignment=7 prog-map="program_map,sink_256=(int)1,sink_264=(int)1,'
                f'PCR_1=sink_256" ! capssetter caps="{caps}" replace=true ! tee name=busout_41400 allow-not-linked=true'
                + "".join(f" unixfdsrc name=busin_{i} socket-path={s} ! {ingress} ! tsdemux latency=0 name=demux_{i}"
                          for i, s in enumerate(socks)))

    def route(i, media, sparse=False):
        return {"branch": f"mralignwatch name=aw_demux_{i}_{media} aligner=mux input=demux_{i}_{media} "
                          "max-size-bytes=40000000" + (" sparse=true" if sparse else "")}
    hook = {"module": "mux_routing", "config": {"inputs": [
        {"demux": f"demux_{i}", "linkTo": "mux", "pid": pid, "ignorePids": [496], "pcr": {"program": 1},
         "routes": {"video": {**route(i, "video"), "parser": "none"}, "audio": route(i, "audio"),
                    "klv": route(i, "klv", True), "subtitle": route(i, "subtitle", True)}}
        for i, pid in enumerate((256, 264))]}}
    r = RunnerProc(argv)
    consumer = None
    rows, paces, full, absences, back = [], [], {}, {}, None
    q = "queue max-size-buffers=0 max-size-bytes=0 max-size-time=0"

    def prop(element, name):
        rid = f"p{len(paces)}{element}{name}{time.monotonic_ns()}"
        r.send({"cmd": "get_property", "id": rid, "element": element, "property": name})
        ev = r.wait_event(lambda e: e.get("id") == rid and e.get("event") in ("property", "command_error"))
        return ev.get("value") if ev and ev.get("event") == "property" else None

    try:
        r.wait_event(ev_is("ready"))
        r.send({"cmd": "start", "pipeline": pipeline, "runnerHooks": [hook],
                "alignBranchesToStamps": {"demuxes": ["demux_0", "demux_1"], "transformProducer": True,
                                          "privatePads": True}})
        check(f"{case} {tag} runner reaches PLAYING",
              r.wait_event(ev_is("state_change", state="playing"), timeout=10) is not None)
        r.send({"cmd": "bus_attach", "tee": "busout_41400", "socket": edge})
        check(f"{case} {tag} edge attached", r.wait_event(ev_is("bus_attached", socket=edge)) is not None)
        consumer = Gst.parse_launch(f"unixfdsrc socket-path={edge} ! {q} ! fakesink name=csink sync=false")

        def on_buf(_pad, info):
            now = time.monotonic_ns()
            for pkt in ts_psi.iter_packets(info.get_buffer().extract_dup(0, info.get_buffer().get_size())):
                pts = ts_psi.read_pes_pts(pkt) if pkt[1] & 0x40 else None
                if pts is not None:
                    pes = pkt[ts_psi.payload_offset(pkt):]
                    key = fx.au_key(pes[9 + pes[8]:])
                    if key:
                        rows.append((key[0], key[1], pts, now))
            return Gst.PadProbeReturn.OK

        consumer.get_by_name("csink").get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, on_buf)
        consumer.set_state(Gst.State.PLAYING)
        now0 = time.monotonic_ns() + 1_000_000_000          # content time 0, a second from now
        target = lambda p: now0 + fx.ns(p - fx.DTS0)        # noqa: E731
        bufs0, targets = fx.cue_egress(seconds, target, schedule=cues)
        if dark:
            bufs0, back = fx.go_dark(bufs0, now0 + int(dark[0] * 1e9), now0 + int(dark[1] * 1e9), (fx.KLV_PID,))
            back = (back - now0) / 1e9
        bufs1, t1 = fx.house_egress(seconds, target)
        bufs1 = [(d.replace(b"MRAU\x01\x00", b"MRAU\x01\x05"), st, arr) for d, st, arr in bufs1]
        targets.update({(0x105, s): v for (_p, s), v in t1.items()})
        pes_in = {}
        for data, _st, _arr in bufs0 + bufs1:
            for pkt in ts_psi.iter_packets(data):
                pts = ts_psi.read_pes_pts(pkt)
                if pts is not None:
                    pes = pkt[ts_psi.payload_offset(pkt):]
                    key = fx.au_key(pes[9 + pes[8]:])
                    if key:
                        pes_in[key] = pts

        def feed(i, bufs):
            src = feeders[i].get_by_name("src")
            for data, st, arr in bufs:
                ahead = arr - time.monotonic_ns()
                if ahead > 0:
                    time.sleep(ahead / 1e9)
                b = Gst.Buffer.new_wrapped(data)
                b.pts = b.dts = st
                src.emit("push-buffer", b)

        threads = [threading.Thread(target=feed, args=(i, b)) for i, b in enumerate((bufs0, bufs1))]
        for t in threads:
            t.start()
        while any(t.is_alive() for t in threads):
            time.sleep(0.5)
            v = prop("aw_demux_0_video", "pace")
            paces.append(((time.monotonic_ns() - now0) / 1e9, v / 1e6 if isinstance(v, int) else None))
        for t in threads:
            t.join()
        time.sleep(1.5)
        full = {n: prop(f"aw_demux_{n}", "full-count") for n in ("0_video", "1_video")}
        absences = {n: prop(f"aw_demux_{n}", "absences") for n in ("0_video", "1_video")}
        check(f"{case} {tag} no lifecycle error", not r.has_event(ev_is("error")))
        check(f"{case} {tag} exits 0 after stop", r.stop_and_wait() == 0)
    finally:
        if consumer is not None:
            consumer.set_state(Gst.State.NULL)
        for f in feeders:
            f.set_state(Gst.State.NULL)
        r.kill()
        for f in os.listdir(tmp):
            os.unlink(os.path.join(tmp, f))
        os.rmdir(tmp)
    return (pes_in, targets, rows, paces, {"full": full, "absences": absences, "back": back},
            [line.split("branchAlign: ", 1)[1] for line in r.logs if "branchAlign: " in line])


def test_mux_aligners_sparse():
    """M3, both runners: a 7 s pause between cues. Every KLV and teletext cue at its own PES PTS,
    the pace flat, the video not slowed; a cue mistimed after the pause would raise the group's
    pace by its lateness for good (measured before the fix: 240 → 7490 ms)."""
    for el in ("unixfdsink", "unixfdsrc", "tsdemux", "mpegtsmux", "capssetter"):
        if Gst.ElementFactory.find(el) is None:
            print(f"SKIP M3 — {el} unavailable")
            return
    so = os.path.join(_PLUGINS, "mpegts-muxer", "native", "mux-routing", "libmrhook_mux_routing.so")
    if not os.path.exists(so):
        print(f"SKIP M3 — {so} not built")
        return
    sys.path.insert(0, _HERE)
    import transform_input_fixture as fx  # noqa: E402  (puts mpegts-core/py on the path)
    import ts_psi  # noqa: E402
    py = ["env", "PYTHONPATH=" + ":".join(os.path.join(_PLUGINS, p, "py") for p in ("mpegts-core", "mpegts-muxer")),
          sys.executable, os.path.join(_HERE, "gst-pipeline-runner.py")]
    wrap = 1 << 33
    pause = _M3_CUES[2] - 1.0                   # the first cue after the pause is on the wire ~0.7 s early
    for tag, argv in (("native", None), ("python", py)):
        pes_in, targets, rows, paces, stats, lines = _aligned_mux_run(argv, tag, fx, ts_psi)
        full = stats["full"]
        written = {}
        for pid, s, pts, arr in rows:
            written.setdefault((pid, s), (pts, arr))
        cues = {k: ((written[k][0] - v + wrap // 2) % wrap) - wrap // 2
                for k, v in pes_in.items() if k[0] in (fx.KLV_PID, fx.TTX_PID) and k in written}
        want = [k for k in pes_in if k[0] in (fx.KLV_PID, fx.TTX_PID)]
        check(f"M3 {tag}: every KLV and teletext cue written at its own PES PTS across the pause "
              f"({len(cues)} of {len(want)}, worst {max(map(abs, cues.values()), default=None)} ticks)",
              len(want) == 8 and len(cues) == len(want) and all(abs(t) <= 1 for t in cues.values()))
        before = [p for t, p in paces if p is not None and t < pause]
        after = [p for t, p in paces if p is not None and t >= pause]
        rise = max(after) - max(before) if before and after else None
        check(f"M3 {tag}: the mux pace does not rise after the pause (before ≤ "
              f"{max(before, default=0):.0f} ms, after ≤ {max(after, default=0):.0f} ms)",
              rise is not None and rise <= 500)
        delays = {}
        for pid in (fx.VIDEO_PID, 0x105):
            for k, (_pts, arr) in written.items():
                if k[0] == pid and k in targets:
                    content = (targets[k] - targets[(fx.VIDEO_PID, 0)]) / 1e9
                    half = "before" if 3 <= content < pause else "after" if content >= _M3_CUES[3] else None
                    if half:
                        delays.setdefault((pid, half), []).append((arr - targets[k]) / 1e6)
        med = {k: sorted(v)[len(v) // 2] for k, v in delays.items()}
        check(f"M3 {tag}: the video does not slow after the pause (output delay, median ms: "
              f"{ {f'0x{p:x} {h}': round(v) for (p, h), v in sorted(med.items())} })",
              len(med) == 4 and all(med[(p, "after")] - med[(p, "before")] <= 500 for p in (fx.VIDEO_PID, 0x105)))
        check(f"M3 {tag}: no video aligner filled ({full}) and no cue pause logged as a discontinuity",
              full == {"0_video": 0, "1_video": 0} and not any("discontinuity" in l for l in lines))


# --------------------------------------------------------------------------- M4: the muxer's aligners over a dark input (WI-P2-12)
_M4_SECONDS, _M4_DARK = 16, (4.0, 10.0)     # back at 10.49 s; five clamped stamps follow the cue


def test_mux_aligners_dark():
    """M4, both runners: input 0 silent over 6 s, back with a KLV cue alone in its bus buffer and
    the rest of its buffer at once. That cue and input 0's video at their own PES PTS, the pace
    flat, input 1 not slowed; the cue's own cadence put it 6 s early and raised the pace for good
    (before the fix: 240 → 5490 ms). A stock queue can leak that cue (B-68)."""
    for el in ("unixfdsink", "unixfdsrc", "tsdemux", "mpegtsmux", "capssetter"):
        if Gst.ElementFactory.find(el) is None:
            print(f"SKIP M4 — {el} unavailable")
            return
    so = os.path.join(_PLUGINS, "mpegts-muxer", "native", "mux-routing", "libmrhook_mux_routing.so")
    if not os.path.exists(so):
        print(f"SKIP M4 — {so} not built")
        return
    if not queue_patched("M4"):
        return
    sys.path.insert(0, _HERE)
    import transform_input_fixture as fx  # noqa: E402  (puts mpegts-core/py on the path)
    import ts_psi  # noqa: E402
    py = ["env", "PYTHONPATH=" + ":".join(os.path.join(_PLUGINS, p, "py") for p in ("mpegts-core", "mpegts-muxer")),
          sys.executable, os.path.join(_HERE, "gst-pipeline-runner.py")]
    wrap, (dark_from, _) = 1 << 33, _M4_DARK
    retimed = {}
    for tag, argv in (("native", None), ("python", py)):
        pes_in, targets, rows, paces, stats, lines = _aligned_mux_run(
            argv, tag, fx, ts_psi, "M4", _M4_SECONDS, [float(c) for c in range(1, _M4_SECONDS - 1)], _M4_DARK)
        now0, back = targets[(fx.VIDEO_PID, 0)] - fx.ns(fx.FRAME), stats["back"]
        written = {}
        for pid, s, pts, arr in rows:
            written.setdefault((pid, s), (pts, arr))

        def content(k):
            return (targets[k] - now0) / 1e9

        def off(k):
            return ((written[k][0] - pes_in[k] + wrap // 2) % wrap) - wrap // 2
        cues = [k for k in pes_in if k[0] in (fx.KLV_PID, fx.TTX_PID)]
        first = min((k for k in cues if k[0] == fx.KLV_PID and content(k) > back), key=content)
        check(f"M4 {tag}: input 0 silent {back - dark_from:.2f} s, back with KLV cue #{first[1]} alone in its "
              f"bus buffer", back - dark_from >= 6.0)
        check(f"M4 {tag}: that cue and every KLV and teletext cue written at its own PES PTS (cue #{first[1]} "
              f"{off(first) if first in written else None} ticks; {sum(k in written for k in cues)} of {len(cues)}, "
              f"worst {max((abs(off(k)) for k in cues if k in written), default=None)} ticks)",
              all(k in written and abs(off(k)) <= 1 for k in cues))
        video = [k for k in pes_in if k[0] == fx.VIDEO_PID and content(k) > dark_from + 1]
        out0 = [k for k in video if k in written]
        # All but the last, which tsdemux holds for a next PES (no EOS here).
        check(f"M4 {tag}: input 0's video after the return written at its own PES PTS ({len(out0)} of "
              f"{len(video)}, worst {max((abs(off(k)) for k in out0), default=None)} ticks)",
              len(out0) >= len(video) - 1 > 100 and all(abs(off(k)) <= 1 for k in out0))
        before = [p for t, p in paces if p is not None and t < dark_from]
        after = [p for t, p in paces if p is not None and t >= back]
        check(f"M4 {tag}: the mux pace does not rise after the return (before ≤ {max(before, default=0):.0f} "
              f"ms, after ≤ {max(after, default=0):.0f} ms)",
              before and after and max(after) - max(before) <= 250)
        delay = {}
        for k, (_pts, arr) in written.items():
            if k[0] == 0x105 and k in targets:
                half = "before" if 2 <= content(k) < dark_from else "after" if content(k) >= back + 2 else None
                if half:
                    delay.setdefault(half, []).append((arr - targets[k]) / 1e6)
        med = {h: sorted(v)[len(v) // 2] for h, v in delay.items()}
        check(f"M4 {tag}: input 1's video delay holds (median ms: { {h: round(v) for h, v in med.items()} })",
              len(med) == 2 and abs(med["after"] - med["before"]) <= 250)
        # Both go absent once the feed ends; input 0 once more, over its silence.
        check(f"M4 {tag}: input 0 absent once more than input 1, no video aligner filled ({stats})",
              stats["full"] == {"0_video": 0, "1_video": 0}
              and stats["absences"]["0_video"] == stats["absences"]["1_video"] + 1)
        retimed[tag] = [re.sub(r"K=-?\d+", "K=<K>", line) for line in lines if line.startswith("demux_0 retime:")]
        check(f"M4 {tag}: the cue logs its quiet spell on the last K, the video's reading confirms it, no "
              f"discontinuity", any("pid=0x102 back after" in line and line.endswith("on the last K")
                                    for line in retimed[tag])
              and any(line.endswith("on its stamps, +0.000 ms off the prediction") for line in retimed[tag])
              and not any("discontinuity" in line for line in lines))
    check("M4 both twins log the same retime lines for the dark input, word for word",
          retimed["native"] == retimed["python"])
    if retimed["native"] != retimed["python"]:
        print("    native:", retimed["native"], "\n    python:", retimed["python"])


# --------------------------------------------------------------------------- P: mpegts-muxer inputs retimed (2026-10-08)
# Input 2 of case P (WI-P2-14): a transcoder's identity egress with KLV cues. Its KLV goes into the
# mux; its video, teletext and DVB pads are sunk.
_P_KLV_BRANCHES = (" demux_2. ! meta/x-klv ! queue ! mux."
                   " demux_2. ! video/x-h264 ! fakesink sync=false async=false"
                   " demux_2. ! application/x-teletext ! fakesink sync=false async=false"
                   " demux_2. ! subpicture/x-dvb ! fakesink sync=false async=false")


def _mux_run(argv, feed, tag, align, fx, ts_psi, extra=_P_KLV_BRANCHES):
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
                            + (extra if n_in > 2 else "") +
                            " mpegtsmux name=mux latency=1200000000 min-upstream-latency=1200000000 alignment=7"
                            f' ! capssetter caps="{caps}" replace=true ! tee name=busout_41300 allow-not-linked=true',
                "alignBranchesToStamps": align})
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
    production-shaped live mux, and since WI-P2-14 that producer's egress with KLV cues as a
    third input, its private pads retimed (`privatePads`). Every access unit must leave on its
    content time, so audio and video agree, and every cue at its own PES PTS; per PID the
    output stays continuous and monotonic and mpegtsmux never ignores a DTS going backward;
    each demux keeps its own K, hold and epochs. Mux mode on the same feed is the control
    that fails."""
    for el in ("unixfdsink", "unixfdsrc", "tsdemux", "mpegtsmux", "capssetter"):
        if Gst.ElementFactory.find(el) is None:
            print(f"SKIP P — {el} unavailable")
            return
    sys.path.insert(0, _HERE)
    import transform_input_fixture as fx  # noqa: E402  (puts mpegts-core/py on the path)
    import ts_psi  # noqa: E402
    py = ["env", "PYTHONPATH=" + os.path.join(_PLUGINS, "mpegts-core", "py"), sys.executable,
          os.path.join(_HERE, "gst-pipeline-runner.py")]
    producer = {"demuxes": ["demux_0", "demux_1", "demux_2"], "transformProducer": True,
                "privatePads": True}
    wrap = 1 << 33

    def fold(d):
        d %= wrap
        return d - wrap if d > wrap // 2 else d

    # Input 0 the splitter's AAC leg, input 1 the transcoder's video (K = −3600 s), input 2 that
    # transcoder's egress with KLV cues (WI-P2-14) on the same content timeline.
    feed, targets, k_splitter = fx.mux_inputs(70, jump_at_s=40.0)
    a_house, a_pts, rate = targets[(fx.AUDIO_PID, 0)], fx.DTS0 + fx.FRAME, 1.0 - 40 / 1e6
    cues, _cue_targets = fx.cue_egress(70, lambda p: a_house + int(fx.ns(p - a_pts) / rate), start_s=2.2)
    feed = sorted(feed + [(t, 2, d, st) for d, st, t in cues], key=lambda e: (e[0], e[1]))
    klv_in = {}
    for data, _st, _t in cues:
        for pkt in ts_psi.iter_packets(data):
            pts = ts_psi.read_pes_pts(pkt)
            if pts is not None and ts_psi.ts_pid(pkt) == fx.KLV_PID:
                klv_in[fx.au_key(pkt[ts_psi.payload_offset(pkt):][14:])] = pts

    def klv_off(rows):
        """Per KLV cue written: output PES PTS - its input PES PTS, in 90 kHz ticks."""
        return {(pid, s): fold(p - klv_in[(pid, s)]) for pid, s, p, _d in rows
                if pid == fx.KLV_PID and (pid, s) in klv_in}

    def judge(rows):
        """Per AU: output PES (− 1 h) against its content time, ms; and the content span, s."""
        err = {fx.AUDIO_PID: [], fx.VIDEO_PID: []}
        for pid, s, p, _d in rows:
            if pid not in err:
                continue
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
            if pid not in (fx.AUDIO_PID, fx.VIDEO_PID):
                continue
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
        off = klv_off(rows)
        check(f"P {tag}: the KLV input's cues leave the mux at their own PES PTS, unchanged ({len(off)} "
              f"of {len(klv_in)}, worst {max(map(abs, off.values()), default=None)} ticks)",
              len(klv_in) > 60 and len(off) == len(klv_in) and all(t == 0 for t in off.values()))
        k0, k1, k2 = k_of(lines, "demux_0"), k_of(lines, "demux_1"), k_of(lines, "demux_2")
        check(f"P {tag}: each demux holds its own mapping — demux_0 K={k0} (the splitter's), "
              f"demux_1 K={k1} and demux_2 K={k2} (identity, −3600 s); only demux_0 opened a stamp "
              f"epoch at the rewind",
              k0 is not None and abs(k0 - k_splitter) < 1_000_000 and k1 == -3_600_000_000_000
              and k2 == -3_600_000_000_000
              and any(l.startswith("demux_0 retime: pid=0x101 PTS discontinuity -42") for l in lines)
              and any(l.startswith("demux_0 retime: epoch #1 on its stamps") for l in lines)
              and not any(l.startswith(("demux_1", "demux_2")) and "discontinuity" in l for l in lines))
        # Two streaming threads log: compare each demux's own sequence, not the interleave.
        logs[tag] = {d: [l for l in lines if l.startswith(d + " ")] for d in ("demux_0", "demux_1", "demux_2")}
    check("P both twins log the same retime lines per demux, word for word", logs["native"] == logs["python"])
    if logs["native"] != logs["python"]:
        print("    native:", logs["native"], "\n    python:", logs["python"])
    rows0, _l0, back0 = _mux_run(None, feed, "native mux-mode control",
                                 {"demuxes": ["demux_0", "demux_1", "demux_2"]}, fx, ts_psi)
    err0, _span0 = judge(rows0)
    every0 = err0[fx.AUDIO_PID] + err0[fx.VIDEO_PID]
    check(f"P control: the same feed in mux mode leaves audio and video "
          f"{max(every0, default=0) - min(every0, default=0):.0f} ms apart and steps a pad back "
          f"({back0} DTS-backward warnings), so the checks above can fail",
          len(every0) > 3000 and max(every0) - min(every0) > 10 and back0 > 0)


# --------------------------------------------------------------------------- Q: lateness taps (WI-P0-8)
def test_lateness_taps():
    """Static and `bus_input_add` bus inputs report `mrlateness:<tap>`
    unsubscribed; the scenario is shared with the python runner's test."""
    sys.path.insert(0, _HERE)
    from gst_lateness_protocol_test import lateness_case
    lateness_case([_BIN], "Q native", check)


# --------------------------------------------------------------------------- mrtshouse-load (WI-S0-8)
def test_mrtshouse_load():
    """libgstmrtshouse.so present, missing, without a stand-in and below the ABI; the scenario is
    shared with the python runner's test, plus every rewrite vector through this binary."""
    sys.path.insert(0, _HERE)
    from gst_native_plugins_test import mrtshouse_load_case
    mrtshouse_load_case([_BIN], "mrtshouse-load native", check, vectors=True)


# --------------------------------------------------------------------------- native-plugins (WI-P2-14)
def test_native_plugins():
    """Plan ch. 6 part 7.3: mralignwatch and mrtsdemux of libgstmrtshouse.so, mrducker and
    mrptskeep of libgstmrducker.so, loaded and used in one module by this binary; the scenario is
    gst_native_plugins_test.py's, which runs it on the python runner."""
    sys.path.insert(0, _HERE)
    from gst_native_plugins_test import native_plugins_case
    native_plugins_case([_BIN], "native", check)


# --------------------------------------------------------------------------- ingest-restamp (WI-P1-4)
def test_ingest_restamp():
    """Plan ch. 5 part 7.3: an SRT ingest's input through `mrtsrestamp arrival=buffer-pts` and
    buildBusSink, one consumer edge: identity stamps, gap markers and the mrtsrestamp-* plugin
    events as RestampCore makes them, plain and behind srt-input's queue. The scenario is
    gst_ingest_restamp_test.py's; one input for both runners, which must forward the same events
    (they host the one element)."""
    sys.path.insert(0, _HERE)
    from gst_ingest_restamp_test import ingest_restamp_case
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
    now = clock.get_time()
    native = ingest_restamp_case([_BIN], "native", check, now=now)
    ingest_restamp_case([_BIN], "native", check, srt_queue=True, now=now)
    py = ingest_restamp_case(_PY_RUNNER, "py", check, now=now)
    if native is not None and py is not None:
        check("ingest-restamp: both runners forward the same mrtsrestamp-stats, -pid and -event "
              f"plugin events ({', '.join(f'{len(v)} {k}' for k, v in native.items())})",
              native == py)


# --------------------------------------------------------------------------- the queue patch (B-68)
# A stock `queue` measures its time level from the last buffer out even once drained, so the
# first buffer back after a silence reads as the silence, and a second one arriving before the
# queue's thread takes it leaks it. The image's GStreamer carries the fix.
_QUEUE_PATCH = ("meta-custom's gstreamer1.0 patch 0001 "
                "(0001-queue-start-the-time-level-afresh-once-the-queue-has-drained.patch)")
_SILENCE_NS = 6500 * Gst.MSECOND
_queue_level = []


def _drained_level_ms():
    """The bus ingress queue's time level with only the first buffer back after a 6.5 s silence
    in it, read without a race: its src task is held in the push of the last buffer before the
    silence, so nothing takes the first one back. 0 ms with the patch, 6,500 ms without; None if
    the read failed. Read once per process."""
    if _queue_level:
        return _queue_level[0]
    sys.path.insert(0, _HERE)
    from gst_lateness_protocol_test import BUS_SRC, TS_CAPS
    t0 = 3600 * Gst.SECOND
    last = t0 + 9 * 40 * Gst.MSECOND
    p = Gst.parse_launch(f'appsrc name=src format=time caps="{TS_CAPS}" ! {BUS_SRC.split(" ! ")[-1]} name=q'
                         " ! fakesink name=sink sync=false async=false")
    hold, held = threading.Event(), threading.Event()

    def on_buf(_pad, info):
        if info.get_buffer().pts == last:
            held.set()
            hold.wait(10)
        return Gst.PadProbeReturn.OK

    p.get_by_name("sink").get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, on_buf)
    src, q, level = p.get_by_name("src"), p.get_by_name("q"), None

    def push(pts):
        b = Gst.Buffer.new_wrapped(bytes(1316))
        b.pts = b.dts = pts
        src.emit("push-buffer", b)

    p.set_state(Gst.State.PLAYING)
    try:
        for k in range(10):
            push(t0 + k * 40 * Gst.MSECOND)
        if held.wait(5):
            push(last + _SILENCE_NS)
            deadline = time.monotonic() + 5
            while q.get_property("current-level-buffers") < 1 and time.monotonic() < deadline:
                time.sleep(0.005)
            if q.get_property("current-level-buffers") == 1:
                level = q.get_property("current-level-time") / 1e6
    finally:
        hold.set()
        p.set_state(Gst.State.NULL)
    _queue_level.append(level)
    return level


def queue_patched(case):
    """Whether this GStreamer's queue starts its level afresh once drained; when it does not, the
    case that needs it says so in its SKIP line."""
    level = _drained_level_ms()
    check(f"{case}: the bus ingress queue's level read with the first buffer back after a 6.5 s "
          f"silence alone in it ({level} ms)", level is not None)
    if level is not None and level >= _SILENCE_NS / 2e6:
        print(f"SKIP {case} — this GStreamer's queue reads a silence as its level ({level:.0f} ms with the "
              f"first buffer back alone in it): it lacks {_QUEUE_PATCH}, so a bus input loses the first "
              "buffer back after a silence of more than 5 s about half the time (B-68)")
        return False
    return level is not None


# --------------------------------------------------------------------------- bus-return (B-68)
_RETURNS, _PACED, _BACK = 30, 10, 8


def test_bus_return():
    """bus-return (B-68), both runners: a relay, its bus ingress (buildBusSrc) into its egress tee
    (buildBusSink), one consumer edge. 30 returns of ten paced buffers, a silence the stamps show
    as 6.5 s (0.5 s of real time) and eight back to back. Each leaves the edge on its own stamp,
    so the ingress and the edge queue both see the silence, and the first buffer back arrives
    every time; stock queues lost it in 8 and 15 of 30 here (with the queue read bypassed)."""
    for el in ("unixfdsink", "unixfdsrc", "capssetter"):
        if Gst.ElementFactory.find(el) is None:
            print(f"SKIP bus-return — {el} unavailable")
            return
    sys.path.insert(0, _HERE)
    from gst_lateness_protocol_test import _SO as lateness_so, BUS_SINK, BUS_SRC, TS_CAPS
    if not os.path.exists(lateness_so):
        print(f"SKIP bus-return — {lateness_so} not built (make native)")
        return
    if not queue_patched("bus-return"):
        return
    import transform_input_fixture as fx  # noqa: E402  (puts mpegts-core/py on the path)
    import ts_psi  # noqa: E402
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)

    def buf(seq, ticks, cc):
        # A video PES head carrying `seq`, so the egress stamps it on its own PTS; six null packets.
        pes = fx._pes(fx.VIDEO_PID, 0xE0, (ticks + fx.MUX_BASE) % (1 << 33), None, seq, 1, cc, False)
        return b"".join(pes) + ts_psi.null_packet() * 6

    for tag, argv in (("native", None), ("py", _PY_ENV_RUNNER)):
        tmp = tempfile.mkdtemp(prefix="mrtest-")
        sock, edge = os.path.join(tmp, "in.sock"), os.path.join(tmp, "edge.sock")
        pipes = []
        for desc in (f'appsrc name=src format=time caps="{TS_CAPS}" ! unixfdsink socket-path={sock}'
                     " sync=false async=false", f"unixfdsrc socket-path={edge} ! fakesink name=csink sync=false"):
            p = Gst.parse_launch(desc)
            p.use_clock(clock)
            p.set_start_time(Gst.CLOCK_TIME_NONE)
            p.set_base_time(0)                  # the wire carries the stamps, as between two runners
            pipes.append(p)
        feed, consumer = pipes
        feed.set_state(Gst.State.PLAYING)
        src, got, sent, cc = feed.get_by_name("src"), [], {}, {fx.VIDEO_PID: 0}
        ticks = (time.monotonic_ns() + 10**9) * 9 // 100000

        def on_buf(_pad, info):
            b = info.get_buffer()
            pkt = b.extract_dup(0, 188)
            pes = pkt[ts_psi.payload_offset(pkt):]
            key = fx.au_key(pes[9 + pes[8]:]) if ts_psi.ts_pid(pkt) == fx.VIDEO_PID and pkt[1] & 0x40 else None
            if key:
                got.append((key[1], b.pts, bool(b.get_flags() & Gst.BufferFlags.DISCONT)))
            return Gst.PadProbeReturn.OK

        def push(n, step, gap=None):
            nonlocal ticks
            for _ in range(n):
                seq = len(sent)
                sent[seq] = fx.ns(ticks)
                b = Gst.Buffer.new_wrapped(buf(seq, ticks, cc))
                b.pts = b.dts = sent[seq]
                src.emit("push-buffer", b)
                ticks += step
                if gap:
                    time.sleep(gap)

        consumer.get_by_name("csink").get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, on_buf)
        time.sleep(0.3)
        r = RunnerProc(argv)
        returns = []
        try:
            r.wait_event(ev_is("ready"), timeout=10)
            r.send({"cmd": "start", "pipeline": f"{BUS_SRC.format(name='busin', socket=sock)} ! {BUS_SINK}"})
            push(5, fx.FRAME, 0.04)
            check(f"bus-return {tag}: the relay reaches PLAYING",
                  r.wait_event(ev_is("state_change", state="playing"), timeout=10) is not None)
            r.send({"cmd": "bus_attach", "tee": "busout_41000", "socket": edge})
            check(f"bus-return {tag}: edge attached, the egress armed",
                  r.wait_event(ev_is("bus_attached", socket=edge)) is not None
                  and r.wait_log("identity egress armed on busout_41000", timeout=3))
            consumer.set_state(Gst.State.PLAYING)
            warm = len(sent)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and not any(s >= warm for s, _p, _d in got):
                push(1, fx.FRAME, 0.04)
            for _ in range(_RETURNS):
                first = len(sent) + _PACED
                push(_PACED, fx.FRAME, 0.04)
                ticks += _SILENCE_NS * 9 // 100000 - fx.FRAME
                time.sleep(0.5)
                push(_BACK, 90)                         # 1 ms of stamps apart, back to back
                returns.append(range(first - _PACED, first + _BACK))
                time.sleep(0.3)
                r.pump()
            time.sleep(1.0)
            check(f"bus-return {tag}: no lifecycle error", not r.has_event(ev_is("error")))
            check(f"bus-return {tag}: exits 0 after stop", r.stop_and_wait() == 0)
        finally:
            consumer.set_state(Gst.State.NULL)
            feed.set_state(Gst.State.NULL)
            r.kill()
            shutil.rmtree(tmp, ignore_errors=True)
        seen = {s: (pts, d) for s, pts, d in got}
        lost_first = sum(rng[_PACED] not in seen for rng in returns)
        lost = sum(any(s not in seen for s in rng) for rng in returns)
        discont = sum(any(seen.get(s, (0, False))[1] for s in rng) for rng in returns)
        off = [abs(seen[s][0] - sent[s]) for rng in returns for s in rng if s in seen]
        check(f"bus-return {tag}: the first buffer back after a 6.5 s silence arrives in "
              f"{len(returns) - lost_first} of {_RETURNS} returns, nothing after it lost, no DISCONT "
              f"({lost} returns with a loss, {discont} with a DISCONT)",
              len(returns) == _RETURNS and lost_first == 0 and lost == 0 and discont == 0)
        check(f"bus-return {tag}: every buffer leaves the edge on its own stamp, so the edge queue sees each "
              f"silence too (worst {max(off, default=0) / 1e3:.1f} µs over {len(off)})",
              len(off) == _RETURNS * (_PACED + _BACK) and max(off) <= 11112)


# --------------------------------------------------------------------------- edge-stall-fds (B-68, B-91)
def _fd_count(pid="self"):
    return len(os.listdir(f"/proc/{pid}/fd"))


def test_edge_stall_fds():
    """edge-stall-fds (B-68, B-91), both runners: a bus input whose module stalls behind its
    ingress (`identity sleep-time=1000000`, a buffer a second), fed 1,316-byte buffers at the
    fleet's fastest edge rate (2,850 a second, a 30 Mbit/s relay), stamped at a rate. Each queued
    buffer is one fd in the runner and one in the feeder, and the ingress holds 5 s of the edge's
    own stream however much is fed: 14,250 buffers stamped 2,850 a second (34,000 fed, past the
    40 MB cap), 976 stamped 195 a second (16,000 fed). Bounded by bytes only it would hold up to
    30,395 at any rate; by a count of 14,250, that count at 195 a second too."""
    import resource
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    if hard != resource.RLIM_INFINITY and hard < 32768:
        print(f"SKIP edge-stall-fds — the hard fd limit is {hard}, below 32,768: a regression to a "
              "bytes-only bound (about 30,400 fds) would fail on EMFILE, not on the count")
        return
    if soft != hard:
        resource.setrlimit(resource.RLIMIT_NOFILE, (hard, hard))     # the runners inherit it
    if Gst.ElementFactory.find("unixfdsink") is None:
        print("SKIP edge-stall-fds — unixfdsink unavailable")
        return
    sys.path.insert(0, _HERE)
    from gst_lateness_protocol_test import _SO as lateness_so, BUS_SRC, TS_CAPS
    if not os.path.exists(lateness_so):
        print(f"SKIP edge-stall-fds — {lateness_so} not built (make native)")
        return
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
    data = bytes([0x47, 0x1F, 0xFF, 0x10] + [0xFF] * 184) * 7
    for tag, argv in (("native", None), ("py", _PY_ENV_RUNNER)):
        for rate, n, held in ((2850, 34000, 14250), (195, 16000, 976)):
            label = f"edge-stall-fds {tag} {rate}/s"
            tmp = tempfile.mkdtemp(prefix="mrtest-")
            sock = os.path.join(tmp, "in.sock")
            feed = Gst.parse_launch(f'appsrc name=src format=time max-bytes=0 caps="{TS_CAPS}"'
                                    f" ! unixfdsink socket-path={sock} sync=false async=false")
            feed.use_clock(clock)
            feed.set_start_time(Gst.CLOCK_TIME_NONE)
            feed.set_base_time(0)
            feed.set_state(Gst.State.PLAYING)
            src, step, t = feed.get_by_name("src"), Gst.SECOND // rate, time.monotonic_ns()

            def push(k):
                # At 2,850 a second whatever the stamps: faster than its consumer, a stock unixfdsink
                # blocks in a send under its lock, and the consumer's releases then block too.
                nonlocal t
                t0, done = time.monotonic(), 0
                while done < k:
                    due = min(k, 1 + int((time.monotonic() - t0) * 2850))
                    for _ in range(due - done):
                        b = Gst.Buffer.new_wrapped(data)
                        b.pts = b.dts = t
                        src.emit("push-buffer", b)
                        t += step
                    done = due
                    time.sleep(0.005)

            time.sleep(0.3)
            r = RunnerProc(argv)
            peak, stop = {}, threading.Event()
            try:
                r.wait_event(ev_is("ready"), timeout=10)
                # No EOS drain at the stop: behind the stalled module it would take hours.
                r.send({"cmd": "start", "pipeline": f"{BUS_SRC.format(name='busin', socket=sock)}"
                                                    " ! identity sleep-time=1000000 ! fakesink sync=false async=false",
                        "eosDrain": False})
                push(1)
                check(f"{label}: the stalled input reaches PLAYING",
                      r.wait_event(ev_is("state_change", state="playing"), timeout=10) is not None)
                base = {"runner": _fd_count(r.proc.pid), "feeder": _fd_count()}

                def sample():
                    while not stop.is_set():
                        for k, pid in (("runner", r.proc.pid), ("feeder", "self")):
                            peak[k] = max(peak.get(k, 0), _fd_count(pid) - base[k])
                        time.sleep(0.2)

                sampler = threading.Thread(target=sample)
                sampler.start()
                push(n)
                deadline = time.monotonic() + 60
                while src.get_property("current-level-bytes") > 0 and time.monotonic() < deadline:
                    time.sleep(0.2)
                time.sleep(2.0)
                stop.set()
                sampler.join()
                left_bytes = src.get_property("current-level-bytes")
                check(f"{label}: the feeder sent all it was fed ({left_bytes} bytes left)", left_bytes == 0)
                check(f"{label}: {n} fed, the runner holds at most {held} + 64 more fds "
                      f"(+{peak.get('runner')}) and the feeder {held} + 300 (+{peak.get('feeder')})",
                      0 < peak.get("runner", 0) <= held + 64 and 0 < peak.get("feeder", 0) <= held + 300)
                check(f"{label}: no lifecycle error", not r.has_event(ev_is("error")))
                check(f"{label}: exits 0 after stop", r.stop_and_wait() == 0)
            finally:
                stop.set()
                r.kill()
                feed.set_state(Gst.State.NULL)
                shutil.rmtree(tmp, ignore_errors=True)
            left = _fd_count() - base["feeder"]
            check(f"{label}: the feeder's unixfdsink lets its copies go when it stops ({left:+d} fds)", left <= 64)



# --------------------------------------------------------------------------- IQ: ingest queue sheds
def test_ingest_queue_sheds():
    """IQ (B-182): the shed watch on queues named ingestq (tsHelpers.ts buildIngestQueue). A paced
    feed into one and into a queue of another name, both stalled behind an identity: one
    `queue_shed` per episode for ingestq alone, its overruns counted, a report once while one stays
    open 10 s, and an episode open at the stop reported before the runner exits."""
    leaky = "leaky=2 max-size-time=0 max-size-buffers=0 max-size-bytes=19200"
    pipe = ("audiotestsrc is-live=true samplesperbuffer=480 ! audio/x-raw,rate=48000,channels=2"
            " ! tee name=t"
            f" t. ! queue name=ingestq {leaky} ! identity name=stall ! fakesink sync=false async=false"
            f" t. ! queue name=other {leaky} ! identity name=stall2 ! fakesink sync=false async=false")
    r = RunnerProc()
    sheds = lambda: [e["payload"] for e in r.events  # noqa: E731
                     if e.get("event") == "plugin_event" and e.get("channel") == "queue_shed"]

    def stall(us):
        for el in ("stall", "stall2"):
            r.send({"cmd": "set_property", "id": f"s{el}{us}", "element": el,
                    "property": "sleep-time", "value": us})

    try:
        r.send({"cmd": "start", "pipeline": pipe, "eosDrain": False})
        check("IQ reaches PLAYING", r.wait_event(ev_is("state_change", state="playing")) is not None)
        time.sleep(1.5)
        r.pump()
        check("IQ a queue that keeps up reports nothing", sheds() == [])
        # Episode 1: 500 ms a buffer for 1.5 s (each queue holds 10 buffers of 10 ms).
        stall(500000)
        time.sleep(1.5)
        stall(0)
        first = r.wait_event(lambda e: e.get("channel") == "queue_shed", timeout=4.0)
        p = first["payload"] if first else {}
        check(f"IQ one episode, one event, for ingestq alone ({p})",
              p.get("element") == "ingestq" and p.get("ongoing") is False
              and p.get("overruns", 0) > 50 and p.get("totalOverruns") == p.get("overruns")
              and p.get("maxSizeBytes") == 19200 and 1000 <= p.get("durationMs", 0) <= 2600)
        time.sleep(1.5)
        r.pump()
        check(f"IQ nothing more once it drained ({len(sheds())} events)", len(sheds()) == 1)
        # Episode 2, open past 10 s: reported once as it stands, then at its end.
        stall(500000)
        long_ev = r.wait_event(lambda e: e.get("channel") == "queue_shed" and e["payload"].get("ongoing"),
                               timeout=13.0)
        lp = long_ev["payload"] if long_ev else {}
        check(f"IQ an episode open 10 s is reported as it stands ({lp})",
              lp.get("element") == "ingestq" and lp.get("durationMs", 0) >= 9000
              and lp.get("overruns", 0) > 500)
        stall(0)
        end = r.wait_event(lambda e: e.get("channel") == "queue_shed" and e["payload"].get("ongoing") is False
                           and e["payload"].get("totalOverruns", 0) > p.get("totalOverruns", 0), timeout=4.0)
        ep = end["payload"] if end else {}
        check(f"IQ ...and once more when it ends, the episode whole ({ep})",
              ep.get("overruns", 0) >= lp.get("overruns", 1)
              and ep.get("totalOverruns") == p.get("totalOverruns", 0) + ep.get("overruns", 0))
        # An episode still open at the stop: its count goes out before the runner exits.
        stall(500000)
        time.sleep(1.0)
        n_before = len(sheds())
        code = r.stop_and_wait()
        last = sheds()[n_before:] if len(sheds()) > n_before else []
        check(f"IQ the stop reports the open episode ({last})",
              code == 0 and len(last) == 1 and last[0].get("overruns", 0) > 0
              and last[0].get("ongoing") is False)
        check("IQ no error event", not r.has_event(ev_is("error")))
    finally:
        r.kill()


test_plain_pipeline()
test_identity_egress()
test_stamper_missing()
test_identity_base_time()
test_consumer_data_wait()
test_refusals()
test_presentation_leg()
test_shed_refusals()
test_reanchor_parity()
test_reanchor_gap_and_undo_parity()
test_runner_hooks()
test_runner_hooks_concurrent()
test_deinterlace_guard_hook()
test_video_gates()
test_live_input_branches()
test_aligner_absent()
test_aligner_join_chain()
test_aligner_fall()
test_live_remove_start_time_branch()
test_transform_producer_align()
test_cue_pads_retime()
test_mux_aligners_sparse()
test_mux_aligners_dark()
test_mux_inputs_retime()
test_lateness_taps()
test_mrtshouse_load()
test_native_plugins()
test_ingest_restamp()
test_bus_return()
test_edge_stall_fds()
test_ingest_queue_sheds()

if _failures:
    print(f"\n{len(_failures)} FAILED: {_failures}")
    sys.exit(1)
print("\nnative_runner_protocol_test.py: all checks passed")
