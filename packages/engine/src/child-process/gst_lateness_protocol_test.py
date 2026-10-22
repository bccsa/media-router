#!/usr/bin/env python3
"""Protocol test for the bus lateness taps (WI-P0-8) against the python runner; the native
runner reuses `lateness_case` via native_runner_protocol_test.py. The egress tap's window leaves
a runner only while a consumer has the stamper armed (B-26). Skips (exit 0) without GStreamer,
unixfdsink or the built plugin.  Run: python3 gst_lateness_protocol_test.py"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst

    Gst.init(sys.argv)
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_lateness_protocol_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

MS = 1000000
_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGINS = os.path.normpath(os.path.join(_HERE, "..", "..", "..", "..", "plugins"))
_SO = os.path.join(_PLUGINS, "mpegts-core", "native", "mrlateness", "libgstmrlateness.so")
PY_RUNNER = [sys.executable, os.path.join(_HERE, "gst-pipeline-runner.py")]
TS_CAPS = "video/mpegts, systemstream=(boolean)true, packetsize=(int)188"
# buildBusSrc({ name, port, socketPath }) verbatim; busRunnerContract.test.ts pins it TS-side.
BUS_SRC = ("unixfdsrc name={name} socket-path={socket}"
           " ! mrlateness name=lat_{name} reference=house"
           " ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=40000000")
# buildBusSink(41000) verbatim; busRunnerContract.test.ts pins it TS-side.
BUS_SINK = (f"capssetter caps=\"{TS_CAPS}\" replace=true ! capsfilter caps=\"{TS_CAPS}\""
            " ! mrlateness name=lat_busout_41000 reference=running-time"
            " ! tee name=busout_41000 allow-not-linked=true")
EGRESS = "mrlateness:lat_busout_41000"


def mono_ns():
    return time.clock_gettime_ns(time.CLOCK_MONOTONIC)


class Producer:
    """A bus producer on the house clock (base_time 0, monotonic) whose buffers
    carry PTS = now - lag, like a stamped egress `lag` late."""

    def __init__(self, sock, lag_ns):
        self.lag_ns = lag_ns
        self.pipe = Gst.parse_launch(
            f"appsrc name=src is-live=true format=time caps=\"{TS_CAPS}\""
            f" ! unixfdsink socket-path={sock} sync=false async=false wait-for-connection=false")
        clock = Gst.SystemClock.obtain()
        clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
        self.pipe.use_clock(clock)
        self.pipe.set_start_time(Gst.CLOCK_TIME_NONE)
        self.pipe.set_base_time(0)
        self.src = self.pipe.get_by_name("src")
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._feed, daemon=True)

    def start(self):
        self.pipe.set_state(Gst.State.PLAYING)
        self._thread.start()

    def _feed(self):
        while not self._stop.is_set():
            buf = Gst.Buffer.new_wrapped(bytes([0x47]) + bytes(187) * 7)
            buf.pts = mono_ns() - self.lag_ns
            self.src.emit("push-buffer", buf)
            time.sleep(0.02)

    def stop(self):
        self._stop.set()
        self._thread.join(timeout=2)
        self.pipe.set_state(Gst.State.NULL)


class Runner:
    """One runner process over the stdin/stderr JSON protocol."""

    def __init__(self, argv, env_extra=None):
        env = dict(os.environ, MR_PLUGINS_DIR=_PLUGINS)
        env.update(env_extra or {})
        # By path or not at all: the tap's own dir never on the scan path.
        scan = [d for d in env.get("GST_PLUGIN_PATH", "").split(":") if d and "mrlateness" not in d]
        env["GST_PLUGIN_PATH"] = ":".join(scan)
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stderr=subprocess.PIPE,
                                     stdout=subprocess.DEVNULL, env=env, text=True, bufsize=1)
        os.set_blocking(self.proc.stderr.fileno(), False)
        # `seq` keeps events and log lines in stderr order, so a check can start at a log line.
        self.events, self.logs, self.seq, self._buf = [], [], [], ""

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
                    self.seq.append(("event", self.events[-1]))
                elif line.strip():
                    self.logs.append(line)
                    self.seq.append(("log", line))

    def wait_event(self, pred, timeout=5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump()
            for ev in self.events:
                if pred(ev):
                    return ev
            if self.proc.poll() is not None:
                return None
            time.sleep(0.02)
        return None

    def wait_log(self, needle, timeout=5.0):
        """The stream position of the first log line holding `needle`, or None."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump()
            for i, (kind, item) in enumerate(self.seq):
                if kind == "log" and needle in item:
                    return i
            if self.proc.poll() is not None:
                return None
            time.sleep(0.02)
        return None

    def close(self):
        try:
            self.send({"cmd": "stop"})
            self.proc.wait(timeout=10)
        except (BrokenPipeError, OSError, subprocess.TimeoutExpired):
            self.proc.kill()
            self.proc.wait()
        self.pump()


def lateness_event(tap):
    def pred(ev):
        return (ev.get("event") == "plugin_event" and ev.get("channel") == f"mrlateness:{tap}"
                and (ev.get("payload") or {}).get("count", 0) > 0)
    return pred


def near(ev, want_ns, tol_ns):
    p = (ev or {}).get("payload") or {}
    return abs(p.get("mean-ns", 0) - want_ns) <= tol_ns and p.get("reference") == "house"


def lateness_case(argv, tag, check):
    """Static and dynamic bus inputs report their lateness through `argv`'s runner."""
    for el in ("unixfdsink", "unixfdsrc", "funnel"):
        if Gst.ElementFactory.find(el) is None:
            print(f"SKIP {tag} lateness — {el} unavailable")
            return
    if not os.path.exists(_SO):
        print(f"SKIP {tag} lateness — {_SO} not built (make native)")
        return
    tmp = tempfile.mkdtemp(prefix="mrlat-")
    socks = [os.path.join(tmp, "a.sock"), os.path.join(tmp, "b.sock")]
    producers = [Producer(socks[0], 200 * MS), Producer(socks[1], 350 * MS)]
    for p in producers:
        p.start()
    time.sleep(0.3)
    r = Runner(argv)
    try:
        check(f"{tag} ready", r.wait_event(lambda e: e.get("event") == "ready") is not None)
        static = BUS_SRC.format(name="busin", socket=socks[0])
        r.send({"cmd": "start", "pipeline": f"{static} ! funnel name=fin ! fakesink sync=false async=false"})
        check(f"{tag} the buildBusSrc fragment parses and plays",
              r.wait_event(lambda e: e.get("event") == "state_change" and e.get("state") == "playing")
              is not None)
        check(f"{tag} mrlateness loaded by path from MR_PLUGINS_DIR, not GST_PLUGIN_PATH "
              "(no missing-plugin line)",
              not any("no libgstmrlateness.so found" in l for l in r.logs))
        ev = r.wait_event(lateness_event("lat_busin"), timeout=6)
        check(f"{tag} static input, PTS = mono - 200 ms: plugin_event mrlateness:lat_busin "
              f"mean 200 ms +- 10 ms with no busReports subscription "
              f"(got {((ev or {}).get('payload') or {}).get('mean-ns')})", near(ev, 200 * MS, 10 * MS))

        dyn = BUS_SRC.format(name="busin_dyn", socket=socks[1])
        r.send({"cmd": "bus_input_add", "id": "d1", "element": "fin", "name": "fin_in_dyn",
                "description": dyn})
        check(f"{tag} bus_input_add done",
              r.wait_event(lambda e: e.get("event") == "bus_input_add_done" and e.get("id") == "d1")
              is not None)
        ev = r.wait_event(lateness_event("lat_busin_dyn"), timeout=6)
        check(f"{tag} bus_input_add branch reports from its own tap: mrlateness:lat_busin_dyn "
              f"mean 350 ms +- 10 ms (got {((ev or {}).get('payload') or {}).get('mean-ns')})",
              near(ev, 350 * MS, 10 * MS))
        check(f"{tag} no pipeline error",
              not any(e.get("event") == "error" for e in r.events))
    finally:
        r.close()
        for p in producers:
            p.stop()
        for f in os.listdir(tmp):
            os.unlink(os.path.join(tmp, f))
        os.rmdir(tmp)
    egress_case(argv, tag, check)


def egress_windows(r, start=0):
    """The `lat_busout_41000` windows `r` forwarded, from stream position `start` on."""
    r.pump()
    return [ev.get("payload") or {} for kind, ev in r.seq[start:]
            if kind == "event" and ev.get("event") == "plugin_event"
            and ev.get("channel") == EGRESS]


def on_house(w):
    """A window of stamped samples: every one within 1 s either way, read on running time."""
    lo, hi = w.get("min-ns", -1 << 62), w.get("max-ns", 1 << 62)
    return (w.get("count", 0) > 0 and -1000 * MS < lo <= hi < 1000 * MS
            and w.get("reference") == "running-time")


# A 302M producer into the exact buildBusSink fragment.
PRODUCER = ("audiotestsrc is-live=true ! audioconvert"
            " ! audio/x-raw,format=S16LE,rate=48000,channels=2"
            f" ! avenc_s302m strict=experimental ! mpegtsmux ! {BUS_SINK}")
ARMED = "identity egress armed on busout_41000"
DISARMED = "busout_41000: last consumer edge detached — stamper disarmed"


def egress_case(argv, tag, check):
    """A producer's `buildBusSink` egress (B-26): the stamp splice and the tap coexist, and the
    tap's windows leave the runner only while a consumer has the stamper armed. Unarmed, its
    PTS are the mux's own (about the uptime off), so: none before the first consumer, the first
    after the arm dropped (it holds samples from before it), none after the last detach, and
    none at all without the stamper plugin."""
    if Gst.ElementFactory.find("avenc_s302m") is None or Gst.ElementFactory.find("mpegtsmux") is None:
        print(f"SKIP {tag} egress lateness — avenc_s302m / mpegtsmux unavailable")
        return
    tmp = tempfile.mkdtemp(prefix="mrlat-")
    r = Runner(argv)
    try:
        r.wait_event(lambda e: e.get("event") == "ready")
        r.send({"cmd": "start", "pipeline": PRODUCER})
        check(f"{tag} the buildBusSink fragment parses and plays",
              r.wait_event(lambda e: e.get("event") == "state_change" and e.get("state") == "playing")
              is not None)
        check(f"{tag} the native stamper still splices in front of the egress tap",
              any("native stamper inserted on busout_41000" in l for l in r.logs))
        time.sleep(5)
        before = egress_windows(r)
        check(f"{tag} no consumer: no egress window in 5 s (got {len(before)}, max-ns "
              f"{[w.get('max-ns') for w in before]})", not before)

        # The first consumer edge arms the stamp; from the window after next the tap reads it.
        socket = os.path.join(tmp, "e.sock")
        r.send({"cmd": "bus_attach", "tee": "busout_41000", "socket": socket})
        armed = r.wait_log(ARMED)
        check(f"{tag} the attach arms the stamper", armed is not None)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and len(egress_windows(r, armed or 0)) < 2:
            time.sleep(0.1)
        after = egress_windows(r, armed or 0)
        check(f"{tag} a consumer: the windows come back (got {len(after)} in 10 s)",
              len(after) >= 2)
        check(f"{tag} every one of them on house time, within 1 s on running time, the one "
              f"spanning the arm dropped (max-ns {[w.get('max-ns') for w in after]})",
              after and all(on_house(w) for w in after))

        r.send({"cmd": "bus_detach", "socket": socket})
        disarmed = r.wait_log(DISARMED)
        check(f"{tag} the last detach disarms the stamper", disarmed is not None)
        time.sleep(5)
        late = egress_windows(r, disarmed) if disarmed is not None else []
        check(f"{tag} no consumer again: no egress window in 5 s (got {len(late)})", not late)
        check(f"{tag} no pipeline error", not any(e.get("event") == "error" for e in r.events))
    finally:
        r.close()
        shutil.rmtree(tmp, ignore_errors=True)
    stamper_missing_case(argv, tag, check)


def stamper_missing_case(argv, tag, check):
    """Without libgstmrtsstamp.so (rule 6) nothing is armed, so the egress forwards no window."""
    house = os.path.join(_PLUGINS, "mpegts-core", "native", "mrtshouse", "libgstmrtshouse.so")
    if not os.path.exists(house):
        print(f"SKIP {tag} egress lateness without the stamper — {house} not built")
        return
    root = tempfile.mkdtemp(prefix="mrlat-plugins-")
    for name, so in (("mrlateness", _SO), ("mrtshouse", house)):
        os.makedirs(os.path.join(root, "mpegts-core", "native", name))
        os.symlink(so, os.path.join(root, "mpegts-core", "native", name, os.path.basename(so)))
    r = Runner(argv, {"MR_PLUGINS_DIR": root, "MR_LIBEXEC_DIR": "/nonexistent"})
    try:
        r.wait_event(lambda e: e.get("event") == "ready")
        r.send({"cmd": "start", "pipeline": PRODUCER})
        check(f"{tag} no stamper: the producer plays, with rule 6's alarm",
              r.wait_event(lambda e: e.get("event") == "state_change" and e.get("state") == "playing")
              is not None and any(e.get("kind") == "timing_plugin" for e in r.events))
        r.send({"cmd": "bus_attach", "tee": "busout_41000", "socket": os.path.join(root, "e.sock")})
        time.sleep(5)
        got = egress_windows(r)
        check(f"{tag} no stamper: a consumer arms nothing and no egress window leaves in 5 s "
              f"(got {len(got)})", not got and not any(ARMED in l for l in r.logs))
    finally:
        r.close()
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    _failures = []

    def _check(name, cond):
        print(("PASS " if cond else "FAIL ") + name)
        if not cond:
            _failures.append(name)

    lateness_case(PY_RUNNER, "py", _check)
    if _failures:
        print(f"\n{len(_failures)} FAILED: {_failures}")
        sys.exit(1)
    print("\ngst_lateness_protocol_test.py: all checks passed")
