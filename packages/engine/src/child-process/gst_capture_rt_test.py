#!/usr/bin/env python3
"""B-111: a PipeWire capture's streaming tasks at real-time priority, in both runners.

Drives mr-gst-runner and gst-pipeline-runner.py over their protocol, each against a fake
rtkit on a private dbus-daemon (DBUS_SYSTEM_BUS_ADDRESS), capturing the dummy sink's
monitor of the dev Pi's PipeWire session as B-88's probe did. The fake answers as rtkit
does and, on a grant, sets the thread SCHED_RR itself: the runner keeps the session's
RLIMIT_RTPRIO, which lets a process of the same user do that.

Skips (exit 0) without the native binary, GStreamer, dbus-daemon or a PipeWire session
with its dummy sink.

Run:  python3 gst_capture_rt_test.py
"""
import json
import os
import re
import resource
import shutil
import subprocess
import sys
import tempfile
import threading
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.normpath(os.path.join(_HERE, "..", ".."))
_BIN = os.path.join(_ROOT, "native", "mr-gst-runner", "mr-gst-runner")
_PLUGINS = os.path.normpath(os.path.join(_ROOT, "..", "..", "plugins"))
_PY_RUNNER = [sys.executable, os.path.join(_HERE, "gst-pipeline-runner.py")]
_RUNNERS = (("native", None), ("py", _PY_RUNNER))


def _skip(why):
    print(f"SKIP gst_capture_rt_test.py — {why}")
    sys.exit(0)


if not os.path.exists(_BIN):
    _skip(f"{_BIN} not built (make -C packages/engine/native/mr-gst-runner)")
try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gio, GLib, Gst

    Gst.init([])
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    _skip(f"GStreamer unavailable ({exc})")
if not shutil.which("dbus-daemon"):
    _skip("no dbus-daemon")
if Gst.ElementFactory.find("pipewiresrc") is None:
    _skip("no pipewiresrc")
try:
    _nodes = subprocess.run(["pw-cli", "ls", "Node"], capture_output=True, text=True, timeout=5).stdout
except (OSError, subprocess.TimeoutExpired) as exc:
    _skip(f"no PipeWire session ({exc})")
if 'node.name = "auto_null"' not in _nodes:
    _skip("the PipeWire session has no dummy sink (auto_null)")
if resource.getrlimit(resource.RLIMIT_RTPRIO)[0] < 19:
    _skip("RLIMIT_RTPRIO below 19: the fake rtkit could not set a runner's thread")

PRIORITY = 19            # the runners' CAPTURE_RT_PRIORITY / capture_rt::PRIORITY
RTTIME_US = 200000       # rtkit's RTTimeUSecMax
SCHED_RR = 2

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


# --------------------------------------------------------------------------- the fake rtkit
_RTKIT_XML = """<node><interface name="org.freedesktop.RealtimeKit1">
<method name="MakeThreadRealtimeWithPID"><arg type="t" direction="in"/><arg type="t" direction="in"/>
<arg type="u" direction="in"/></method>
<method name="MakeThreadRealtime"><arg type="t" direction="in"/><arg type="u" direction="in"/></method>
</interface></node>"""


def rttime_hard(pid):
    """The process's RLIMIT_RTTIME hard limit in µs, None for unlimited or unreadable."""
    try:
        for line in open(f"/proc/{pid}/limits"):
            if line.startswith("Max realtime timeout"):
                hard = line.split()[4]
                return None if hard == "unlimited" else int(hard)
    except OSError:
        pass
    return None


class FakeRtkit:
    """org.freedesktop.RealtimeKit1 on a private bus. `mode`: grant, refuse or hang (no answer).
    A grant is checked as rtkit checks it: a bounded RLIMIT_RTTIME, a priority up to 20."""

    def __init__(self, tmp):
        self.addr = f"unix:path={tmp}/bus"
        self.daemon = subprocess.Popen(["dbus-daemon", "--session", "--nofork", "--nopidfile",
                                        f"--address={self.addr}", "--print-address"],
                                       stdout=subprocess.PIPE, text=True)
        self.daemon.stdout.readline()   # printed once it listens
        self.mode = "grant"
        self._calls = []
        self._held = []
        self._lock = threading.Lock()
        ready = threading.Event()
        threading.Thread(target=self._serve, args=(ready,), daemon=True).start()
        if not ready.wait(10):
            raise RuntimeError("fake rtkit did not come up")

    def _serve(self, ready):
        ctx = GLib.MainContext.new()
        ctx.push_thread_default()
        conn = Gio.DBusConnection.new_for_address_sync(
            self.addr, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT
            | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
        conn.register_object("/org/freedesktop/RealtimeKit1",
                             Gio.DBusNodeInfo.new_for_xml(_RTKIT_XML).interfaces[0], self._on_call, None, None)
        conn.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
                       GLib.Variant("(su)", ("org.freedesktop.RealtimeKit1", 4)), None,
                       Gio.DBusCallFlags.NONE, 5000, None)
        ready.set()
        GLib.MainLoop(ctx).run()

    def _on_call(self, _conn, _sender, _path, _iface, method, params, inv):
        args = params.unpack()
        pid, tid, prio = args if method == "MakeThreadRealtimeWithPID" else (None,) + args
        hard = rttime_hard(pid) if pid else None
        with self._lock:
            self._calls.append({"method": method, "pid": pid, "tid": tid, "prio": prio, "rttime": hard})
            mode = self.mode
        if mode == "hang":
            self._held.append(inv)
        elif mode == "refuse" or hard is None or hard > RTTIME_US or prio > 20:
            inv.return_dbus_error("org.freedesktop.DBus.Error.AccessDenied", "Operation not permitted")
        else:
            try:
                os.sched_setscheduler(tid, os.SCHED_RR | os.SCHED_RESET_ON_FORK, os.sched_param(prio))
            except OSError as e:
                inv.return_dbus_error("org.freedesktop.DBus.Error.Failed", str(e))
                return
            inv.return_value(None)

    def calls(self, pid):
        with self._lock:
            return [c for c in self._calls if c["pid"] == pid]

    def close(self):
        if self.daemon.poll() is None:
            self.daemon.terminate()
            self.daemon.wait()


# --------------------------------------------------------------------------- one runner
class RunnerProc:
    """One runner process: commands in, parsed events + log lines out."""

    def __init__(self, argv, bus_addr, rttime=None):
        env = dict(os.environ, MR_PLUGINS_DIR=_PLUGINS, MALLOC_ARENA_MAX="2",
                   PYTHONPATH=os.path.join(_PLUGINS, "mpegts-core", "py"), DBUS_SYSTEM_BUS_ADDRESS=bus_addr)
        limit = (lambda: resource.setrlimit(resource.RLIMIT_RTTIME, rttime)) if rttime else None
        self.proc = subprocess.Popen(argv or [_BIN], stdin=subprocess.PIPE, stderr=subprocess.PIPE,
                                     stdout=subprocess.DEVNULL, env=env, text=True, bufsize=1,
                                     preexec_fn=limit)
        self.pid = self.proc.pid
        self.events = []    # (monotonic time, event)
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
            now = time.monotonic()
            while "\n" in self._buf:
                line, self._buf = self._buf.split("\n", 1)
                if line.startswith("GST_JSON:"):
                    self.events.append((now, json.loads(line[9:])))
                elif line.strip():
                    self.logs.append(line)

    def run_for(self, seconds, until=None):
        """Pump for `seconds`, or until `until()` holds; True when it held."""
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump()
            if until is not None and until():
                return True
            if self.proc.poll() is not None:
                break
            time.sleep(0.05)
        self.pump()
        return until is not None and until()

    def named(self, name):
        return [(t, e) for t, e in self.events if e.get("event") == name]

    def warnings(self):
        return [e.get("message", "") for _, e in self.named("warning")]

    def thread(self, tid):
        """(comm, policy, rt priority) of one of the runner's threads, None once it is gone."""
        try:
            comm = open(f"/proc/{self.pid}/task/{tid}/comm").read().strip()
            stat = open(f"/proc/{self.pid}/task/{tid}/stat").read()
        except OSError:
            return None
        fields = stat[stat.rindex(")") + 2:].split()
        return comm, int(fields[38]), int(fields[37])

    def threads(self):
        try:
            return {int(t): self.thread(t) for t in os.listdir(f"/proc/{self.pid}/task")}
        except OSError:
            return {}

    def stop(self):
        try:
            self.send({"cmd": "stop"})
        except (BrokenPipeError, OSError):
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        self.pump()
        return self.proc.returncode


# --------------------------------------------------------------------------- pipelines
_TS_CAPS = "video/mpegts, systemstream=(boolean)true, packetsize=(int)188"
_LEVEL = "level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000"


def _capture(tag):
    # audio-encoder's capture string (B-88's probe; 16 buffers, not live, B-180): the dummy sink's
    # monitor, which WirePlumber links.
    return ("pipewiresrc target-object=auto_null min-buffers=16 stream-properties=\"props,"
            "node.dont-fallback=(string)true,node.linger=(string)true,node.loop.class=(string)data.rt,"
            "stream.is-live=(string)false,stream.capture.sink=(string)true,"
            f"node.latency=(string)2048/48000,node.name=(string)MR_PW_b111-{tag}\""
            " ! audio/x-raw,format=F32LE,channels=2,channel-mask=(bitmask)0x3")


def _egress(port):
    return (" ! mpegtsmux latency=0 alignment=7 ! mrtsrestamp name=restamp clock-mode=fixed offset-ns=0"
            f" ! capssetter caps=\"{_TS_CAPS}\" replace=true ! capsfilter caps=\"{_TS_CAPS}\""
            f" ! tee name=busout_{port} allow-not-linked=true")


# A branch after the mux with a task of its own: the muxer ends the capture path, so it is not raised.
_POST_MUX = " busout_47001. ! queue name=postmux ! fakesink sync=false async=false"


def _s302m_tail(port):
    # audio-input-302m's: volume, level, the ASRC, the 302M encoder, the mux and the restamp.
    return (f" ! volume name=vol volume=1.00 ! {_LEVEL} ! audioconvert ! mrasrc name=asrc cycle-input=true"
            " ! audio/x-raw,format=S32LE,rate=48000,channels=2 ! avenc_s302m strict=experimental" + _egress(port))


def pipe_302m(tag):
    return _capture(tag) + _s302m_tail(47001) + _POST_MUX


def pipe_encoder(tag):
    # audio-encoder's: the ASRC, volume, level, the 50 ms leaky queue, opusenc, the mux.
    return (_capture(tag) + " ! audioconvert ! mrasrc name=asrc out-rate=48000 cycle-input=true"
            f" ! audio/x-raw,rate=48000,channels=2 ! volume name=vol volume=1.00 ! {_LEVEL}"
            " ! queue max-size-time=50000000 leaky=2 flush-on-eos=true ! opusenc bitrate=128000 frame-size=20"
            + _egress(47002))


def pipe_not_pipewire():
    return ("audiotestsrc is-live=true wave=silence ! audio/x-raw,format=F32LE,rate=48000,channels=2,"
            "channel-mask=(bitmask)0x3" + _s302m_tail(47003))


_302M_TASKS = {"pipewiresrc0:sr", "mpegtsmux0:src"}            # comm: 15 characters
_ENCODER_TASKS = {"pipewiresrc0:sr", "queue0:src", "mpegtsmux0:src"}


def start(kind, argv, fake, pipeline, rttime=None, bus_addr=None):
    r = RunnerProc(argv, bus_addr or fake.addr, rttime)
    # eosDrain off, as for an audio-only bus producer: a tee without an edge never sees EOS.
    r.send({"cmd": "start", "pipeline": pipeline, "eosDrain": False})
    started = r.run_for(10, lambda: r.named("started") or r.named("error"))
    check(f"{kind}: started without an error", started and not r.named("error"))
    return r


def comm_of(r, call):
    t = r.thread(call["tid"])
    return t[0] if t else "?"


def vu_after(r, since):
    return sum(1 for t, e in r.events if e.get("event") == "vu_data" and t > since)


# --------------------------------------------------------------------------- G: the grant
def case_grant(fake, kind, argv, shape):
    """Each task of the capture path asks rtkit for SCHED_RR 19 once, with RLIMIT_RTTIME bounded
    first; the threads run RR 19 after the grant (chrt -p); nothing else in the runner does."""
    fake.mode = "grant"
    pipeline, want = (pipe_302m, _302M_TASKS) if shape == "302m" else (pipe_encoder, _ENCODER_TASKS)
    tag = f"G {shape} {kind}"
    r = start(tag, argv, fake, pipeline(f"g{shape}{kind}"))
    try:
        r.run_for(6, lambda: len(fake.calls(r.pid)) >= len(want) and len(r.named("vu_data")) >= 2)
        r.run_for(1.0)   # the task names settle after ENTER; no further request may come
        calls = fake.calls(r.pid)
        comms = sorted(comm_of(r, c) for c in calls)
        check(f"{tag}: one request per capture task, those only ({comms})", comms == sorted(want))
        check(f"{tag}: each MakeThreadRealtimeWithPID(runner pid, tid, {PRIORITY})",
              len(calls) == len(want) and all(c["method"] == "MakeThreadRealtimeWithPID"
                                              and c["prio"] == PRIORITY for c in calls))
        check(f"{tag}: RLIMIT_RTTIME bounded to {RTTIME_US} us before each request",
              all(c["rttime"] == RTTIME_US for c in calls))
        limits = [ln.split() for ln in open(f"/proc/{r.pid}/limits") if ln.startswith("Max realtime timeout")]
        check(f"{tag}: /proc limits read 200000 200000", limits and limits[0][3:5] == ["200000", "200000"])
        rt = {tid: t for tid, t in r.threads().items() if t and t[1] == SCHED_RR}
        check(f"{tag}: exactly those threads run SCHED_RR {PRIORITY} ({sorted(t[0] for t in rt.values())})",
              sorted(t[0] for t in rt.values()) == sorted(want) and all(t[2] == PRIORITY for t in rt.values()))
        for c in calls:
            out = subprocess.run(["chrt", "-p", str(c["tid"])], capture_output=True, text=True).stdout
            print(f"     chrt -p {c['tid']} ({comm_of(r, c)}): " + " / ".join(out.split("\n")[:2]))
            check(f"{tag}: chrt -p {comm_of(r, c)}: SCHED_RR|SCHED_RESET_ON_FORK, priority {PRIORITY}",
                  "SCHED_RR|SCHED_RESET_ON_FORK" in out and f"priority: {PRIORITY}" in out)
        granted = [m.group(1) for m in (re.search(r"real-time: (\S+) at SCHED_RR 19 \(rtkit\)$", ln)
                                        for ln in r.logs) if m]
        check(f"{tag}: one grant line per task ({sorted(granted)})",
              sorted(g[:15] for g in granted) == sorted(want))
        check(f"{tag}: no warning ({r.warnings()})", not r.warnings())
        check(f"{tag}: the capture flows (vu_data)", len(r.named("vu_data")) >= 2)
        if shape == "302m":
            post = [t for t in r.threads().values() if t and t[0] == "postmux:src"]
            check(f"{tag}: the queue after the mux runs and stays SCHED_OTHER", len(post) == 1 and post[0][1] == 0)
        if shape == "encoder":
            # A consumer edge (queue ! unixfdsink) after the mux is not the capture's: no request.
            edge = os.path.join(tempfile.gettempdir(), f"b111-edge-{os.getpid()}-{kind}.sock")
            r.send({"cmd": "bus_attach", "tee": "busout_47002", "socket": edge})
            queues = lambda: [t for t in r.threads().values()
                              if t and re.fullmatch(r"queue\d+:src", t[0]) and t[0] != "queue0:src"]
            r.run_for(4, lambda: queues())
            r.run_for(1.0)
            q = queues()
            check(f"{tag}: the edge's queue task runs ({[t[0] for t in q]})", len(q) == 1)
            check(f"{tag}: the edge's queue task stays SCHED_OTHER", q and q[0][1] == 0)
            check(f"{tag}: no request for the edge", len(fake.calls(r.pid)) == len(want))
            try:
                os.unlink(edge)
            except OSError:
                pass
    finally:
        check(f"{tag}: exits 0 after stop", r.stop() == 0)


# --------------------------------------------------------------------------- P: no PipeWire source
def case_not_pipewire(fake, kind, argv):
    """The same tail behind an audiotestsrc: no request, RLIMIT_RTTIME left as it was."""
    fake.mode = "grant"
    tag = f"P {kind}"
    r = start(tag, argv, fake, pipe_not_pipewire())
    try:
        r.run_for(6, lambda: len(r.named("vu_data")) >= 3)
        check(f"{tag}: the pipeline runs (vu_data)", len(r.named("vu_data")) >= 3)
        check(f"{tag}: no request", fake.calls(r.pid) == [])
        check(f"{tag}: no real-time line", not [ln for ln in r.logs if "real-time" in ln])
        check(f"{tag}: no warning", not r.warnings())
        check(f"{tag}: RLIMIT_RTTIME untouched (unlimited)", rttime_hard(r.pid) is None)
        check(f"{tag}: every thread SCHED_OTHER", all(t[1] == 0 for t in r.threads().values() if t))
    finally:
        check(f"{tag}: exits 0 after stop", r.stop() == 0)


# --------------------------------------------------------------------------- R: refused
def case_refused(fake, kind, argv, how):
    """rtkit says no (`refuse`), there is no bus (`nobus`) or rtkit never answers (`hang`):
    one warning for the runner, every task asked, and the capture runs on at normal priority."""
    fake.mode = "refuse" if how == "nobus" else how
    tag = f"R {how} {kind}"
    bus = f"unix:path={tempfile.gettempdir()}/b111-nobus-{os.getpid()}" if how == "nobus" else None
    t0 = time.monotonic()
    r = start(tag, argv, fake, pipe_302m(f"r{how}{kind}"), bus_addr=bus)
    try:
        if how == "hang":
            # rtkit holds every request: the capture flows meanwhile, then the timeout is a refusal.
            r.run_for(4.5, lambda: r.named("vu_data"))
            check(f"{tag}: the capture flows while rtkit holds the requests",
                  r.named("vu_data") and not r.warnings())
            check(f"{tag}: both tasks asked", len(fake.calls(r.pid)) == 2)
        r.run_for(9, lambda: r.warnings())
        warned = r.named("warning")
        after = warned[0][0] if warned else time.monotonic()
        r.run_for(3.5)
        w = r.warnings()
        print(f"     warning: {w[0] if w else None}")
        check(f"{tag}: one warning ({len(w)})", len(w) == 1)
        check(f"{tag}: it names the task and says the capture runs on",
              w and re.match(r"real-time priority refused for (pipewiresrc0|mpegtsmux0):src \(.+\): "
                             r"the capture runs at normal priority$", w[0]) is not None)
        if how == "hang":
            check(f"{tag}: it came on the 5 s timeout ({after - t0:.1f} s)", 5.0 <= after - t0 <= 9.0)
            check(f"{tag}: it says why", w and "Timeout" in w[0])
        elif how == "nobus":
            check(f"{tag}: no request reached the fake", fake.calls(r.pid) == [])
        else:
            check(f"{tag}: both tasks asked", len(fake.calls(r.pid)) == 2)
            check(f"{tag}: it carries rtkit's answer", w and "AccessDenied" in w[0])
        check(f"{tag}: the capture runs on after it ({vu_after(r, after)} vu_data in 3.5 s)",
              vu_after(r, after) >= 2)
        check(f"{tag}: no error event, still running", not r.named("error") and r.proc.poll() is None)
        check(f"{tag}: no grant line", not [ln for ln in r.logs if "at SCHED_RR" in ln])
        check(f"{tag}: every thread SCHED_OTHER", all(t[1] == 0 for t in r.threads().values() if t))
    finally:
        check(f"{tag}: exits 0 after stop", r.stop() == 0)


# --------------------------------------------------------------------------- B: the bus goes away
def case_bus_gone(kind, argv, tmp):
    """The system bus closing after the grants leaves the runner capturing: a shared GDBus
    connection would SIGTERM its process when the bus goes."""
    fake = FakeRtkit(tmp)
    tag = f"B {kind}"
    r = start(tag, argv, fake, pipe_302m(f"b{kind}"))
    try:
        r.run_for(6, lambda: len(fake.calls(r.pid)) >= 2 and r.named("vu_data"))
        r.run_for(1.0)
        check(f"{tag}: granted first", len([ln for ln in r.logs if "at SCHED_RR 19" in ln]) == 2)
        fake.close()
        closed = time.monotonic()
        r.run_for(3.5)
        check(f"{tag}: still running 3.5 s after the bus closed", r.proc.poll() is None
              and not r.named("error") and not [e for _, e in r.events if e.get("state") == "null"])
        check(f"{tag}: the capture runs on ({vu_after(r, closed)} vu_data)", vu_after(r, closed) >= 2)
    finally:
        fake.close()
        check(f"{tag}: exits 0 after stop", r.stop() == 0)


# --------------------------------------------------------------------------- L: a stricter limit
def case_strict_limit(fake, kind, argv):
    """A runner already under a tighter RLIMIT_RTTIME keeps it, and is granted."""
    fake.mode = "grant"
    tag = f"L {kind}"
    r = start(tag, argv, fake, pipe_302m(f"l{kind}"), rttime=(100000, 100000))
    try:
        r.run_for(6, lambda: len(fake.calls(r.pid)) >= 2)
        r.run_for(1.0)
        calls = fake.calls(r.pid)
        check(f"{tag}: both tasks asked at 100000 us", len(calls) == 2 and all(c["rttime"] == 100000 for c in calls))
        limits = [ln.split() for ln in open(f"/proc/{r.pid}/limits") if ln.startswith("Max realtime timeout")]
        check(f"{tag}: /proc limits still read 100000 100000", limits and limits[0][3:5] == ["100000", "100000"])
        check(f"{tag}: granted, no warning", not r.warnings()
              and len([ln for ln in r.logs if "at SCHED_RR 19" in ln]) == 2)
    finally:
        check(f"{tag}: exits 0 after stop", r.stop() == 0)


def main():
    tmp = tempfile.mkdtemp(prefix="b111-")
    fake = FakeRtkit(tmp)
    try:
        for kind, argv in _RUNNERS:
            case_grant(fake, kind, argv, "302m")
            case_grant(fake, kind, argv, "encoder")
            case_not_pipewire(fake, kind, argv)
            for how in ("refuse", "nobus", "hang"):
                case_refused(fake, kind, argv, how)
            case_strict_limit(fake, kind, argv)
            bus_tmp = os.path.join(tmp, f"gone-{kind}")
            os.makedirs(bus_tmp)
            case_bus_gone(kind, argv, bus_tmp)
    finally:
        fake.close()
        shutil.rmtree(tmp, ignore_errors=True)
    if _failures:
        print(f"\n{len(_failures)} FAILED")
        sys.exit(1)
    print("\nALL PASSED")


if __name__ == "__main__":
    main()
