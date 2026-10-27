#!/usr/bin/env python3
"""The aligner conformance rig (plan ch. 6 WI-P2-14): the runner commands of
`fixtures/aligner/pipelines.json` (the real modules' output, see
testing/alignerConformance.test.ts) on either runner, producers that feed bus edges at real time
on the house clock, consumers on a runner's bus tee, and the 302M analysis.

Shared by aligner_conformance_test.py and the protocol cases L and aligner-absent
(native_runner_protocol_test.py, gst_live_inputs_test.py). Not shipped.

House time is CLOCK_MONOTONIC: every runner pipeline runs on it at base_time 0, so a bus
stamp is content time and `arrival - stamp` is lateness. A producer's content is a pseudo-random
signal per input, a function of the absolute sample index (`n = house_ns * 48 kHz`), so the
analysis finds each input in a mix by correlation, to the sample.
"""
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import threading
import time

import numpy as np

import gi

gi.require_version("Gst", "1.0")
from gi.repository import Gst  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.normpath(os.path.join(HERE, "..", ".."))
REPO = os.path.normpath(os.path.join(ENGINE, "..", ".."))
PLUGINS = os.path.join(REPO, "plugins")
FIXTURES = os.path.join(PLUGINS, "mpegts-core", "tests", "fixtures", "aligner")
NATIVE_BIN = os.environ.get("MR_GST_RUNNER") or os.path.join(ENGINE, "native", "mr-gst-runner",
                                                             "mr-gst-runner")
PY_RUNNER = [sys.executable, os.path.join(HERE, "gst-pipeline-runner.py")]
# The plugins tree the runners load from (a mirror with a scratch build, for a mutant run).
RUNNER_PLUGINS = os.environ.get("MR_PLUGINS_DIR") or PLUGINS
sys.path.insert(0, os.path.join(PLUGINS, "mpegts-core", "py"))
import ts_psi  # noqa: E402
import ts_timeline  # noqa: E402

Gst.init([])

RATE = 48000
BLOCK = 480                                    # one producer buffer: 10 ms
MUX_BASE = ts_timeline.MUX_CLOCK_BASE_90K
WRAP = ts_timeline.PTS_WRAP
TS_CAPS = "video/mpegts,systemstream=(boolean)true,packetsize=(int)188"
PCM_CAPS = "audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved"
SOCK = "@SOCK@"
MS = 1_000_000


def now_ns():
    return time.monotonic_ns()


def grid(t_ns, step=10 * MS):
    """`t_ns` rounded up to the 10 ms grid: every PES, ns and sample conversion is then exact."""
    return -(-t_ns // step) * step


def sample_of(house_ns):
    return house_ns * RATE // 1_000_000_000


def house_of(sample):
    return sample * 1_000_000_000 // RATE


# --------------------------------------------------------------------------- runner commands
def pipelines():
    with open(os.path.join(FIXTURES, "pipelines.json"), encoding="utf-8") as fh:
        return json.load(fh)


def expectation(scenario):
    with open(os.path.join(FIXTURES, f"{scenario}.expect.json"), encoding="utf-8") as fh:
        return json.load(fh)


def on_socket_dir(value, sock_dir):
    """`value` (a runner command, deep) with `@SOCK@` put on `sock_dir`."""
    if isinstance(value, str):
        return value.replace(SOCK, sock_dir)
    if isinstance(value, list):
        return [on_socket_dir(v, sock_dir) for v in value]
    if isinstance(value, dict):
        return {k: on_socket_dir(v, sock_dir) for k, v in value.items()}
    return value


def runner_kinds(only=None):
    """[(tag, argv)] of the runners present: native mr-gst-runner and the python twin."""
    out = []
    if os.path.exists(NATIVE_BIN):
        out.append(("native", [NATIVE_BIN]))
    out.append(("py", list(PY_RUNNER)))
    return [k for k in out if only is None or k[0] in only]


def runner_env(extra=None):
    """The engine's spawn environment (PythonProcess): plugin roots, every plugin's py dir."""
    env = dict(os.environ, MR_PLUGINS_DIR=RUNNER_PLUGINS, MALLOC_ARENA_MAX="2")
    py = [os.path.join(PLUGINS, d, "py") for d in sorted(os.listdir(PLUGINS))
          if os.path.isdir(os.path.join(PLUGINS, d, "py"))]
    env["PYTHONPATH"] = ":".join(py + ([env["PYTHONPATH"]] if env.get("PYTHONPATH") else []))
    env.update(extra or {})
    return env


class Runner:
    """One runner on its stdin/stderr JSON protocol; every stderr line timed on arrival."""

    def __init__(self, argv, env=None):
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stderr=subprocess.PIPE,
                                     stdout=subprocess.DEVNULL, env=runner_env(env), text=True,
                                     bufsize=1)
        self.events, self.logs = [], []
        self._lock = threading.Lock()
        self._seq = 0
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()

    def _read(self):
        for line in self.proc.stderr:
            t = now_ns()
            line = line.rstrip("\n")
            with self._lock:
                if line.startswith("GST_JSON:"):
                    try:
                        self.events.append((t, json.loads(line[9:])))
                    except ValueError:
                        self.logs.append(line)
                elif line.strip():
                    self.logs.append(line)

    def send(self, cmd):
        self.proc.stdin.write(json.dumps(cmd) + "\n")
        self.proc.stdin.flush()

    def snapshot(self):
        with self._lock:
            return list(self.events)

    def wait(self, pred, timeout=10.0):
        """The first event matching `pred` (as (t, event)), or None."""
        deadline = time.monotonic() + timeout
        while True:
            for t, ev in self.snapshot():
                if pred(ev):
                    return t, ev
            if time.monotonic() >= deadline or self.proc.poll() is not None:
                return None
            time.sleep(0.01)

    def plugin(self, channel):
        """[(t, payload)] of the `plugin_event`s on `channel` (or on every channel it prefixes)."""
        return [(t, ev.get("payload") or {}) for t, ev in self.snapshot()
                if ev.get("event") == "plugin_event"
                and (ev.get("channel") == channel or str(ev.get("channel", "")).startswith(channel))]

    def request(self, cmd, done, timeout=10.0):
        """Send `cmd` with a fresh id; the event named `done` (or a command_error) for it."""
        self._seq += 1
        rid = f"r{self._seq}"
        self.send(dict(cmd, id=rid))
        return self.wait(lambda e: e.get("id") == rid and e.get("event") in (done, "command_error"),
                         timeout)

    def start(self, command, timeout=15.0):
        """`ready`, then `start`; the PLAYING edge as (t, event), or None."""
        if not self.wait(lambda e: e.get("event") == "ready", timeout):
            return None
        self.send(dict(command, cmd="start"))
        return self.wait(lambda e: e.get("event") == "state_change" and e.get("state") == "playing",
                         timeout)

    def attach(self, tee, socket, timeout=10.0):
        self.send({"cmd": "bus_attach", "tee": tee, "socket": socket})
        return self.wait(lambda e: e.get("event") == "bus_attached" and e.get("socket") == socket,
                         timeout) is not None

    def errors(self):
        return [ev for _t, ev in self.snapshot() if ev.get("event") == "error"]

    def count(self, name, **fields):
        return sum(1 for _t, ev in self.snapshot() if ev.get("event") == name
                   and all(ev.get(k) == v for k, v in fields.items()))

    def stop(self, timeout=15.0):
        try:
            self.send({"cmd": "stop"})
        except (BrokenPipeError, OSError):
            pass
        try:
            self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()
        self._reader.join(timeout=2)
        return self.proc.returncode

    def kill(self):
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()


def aligner_reports(runner, name):
    """[(t, payload)] of one `mralignwatch`'s messages (`mralignwatch:<element>`)."""
    return runner.plugin(f"mralignwatch:{name}")


def aligner_of(description):
    """The `mralignwatch` element a branch description names."""
    m = re.search(r"mralignwatch name=(\S+)", description)
    return m.group(1) if m else None


def first_state(reports, state, after=0):
    """(t, payload) of the first report in `state` at or after `after`, or None."""
    return next(((t, p) for t, p in reports if t >= after and p.get("state") == state), None)


# --------------------------------------------------------------------------- content
def prn(seed, n):
    """A pseudo-random signal of the absolute sample index `n`, in [-1, 1) (splitmix64)."""
    with np.errstate(over="ignore"):
        z = (np.asarray(n, dtype=np.int64).astype(np.uint64)
             + np.uint64((seed * 0x9E3779B97F4A7C15) & 0xFFFFFFFFFFFFFFFF))
        z = (z ^ (z >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
        z = (z ^ (z >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
        z = z ^ (z >> np.uint64(31))
    return ((z >> np.uint64(40)).astype(np.float64) / float(1 << 23)) - 1.0


class Content:
    """One input's audio: channel c is `amp * prn(2 * seed + c, n)`, zero outside `gate`
    ([(from, to)] seconds after the scenario's t0, half-open; None = always on)."""

    def __init__(self, seed, amp=0.15, gate=None):
        self.seed, self.amp, self.gate = seed, amp, gate
        self.origin = 0                 # the sample of t0, set when its producer begins

    def expected(self, n):
        """[channels][len(n)] float, the content at absolute samples `n`."""
        n = np.asarray(n, dtype=np.int64)
        on = self.on(n)
        return [self.amp * prn(2 * self.seed + c, n) * on for c in (0, 1)]

    def on(self, n):
        if self.gate is None:
            return np.ones(len(n))
        t = (np.asarray(n, dtype=np.int64) - self.origin) / RATE
        mask = np.zeros(len(n))
        for a, b in self.gate:
            mask[(t >= a) & (t < b)] = 1.0
        return mask

    def pcm(self, n0, count=BLOCK):
        """S16LE stereo interleaved bytes of samples [n0, n0 + count)."""
        left, right = self.expected(np.arange(n0, n0 + count, dtype=np.int64))
        out = np.empty(2 * count, dtype=np.int16)
        out[0::2] = np.round(left * 32767)
        out[1::2] = np.round(right * 32767)
        return out.tobytes()


# --------------------------------------------------------------------------- producers
class IdentityStamper:
    """mrts::IdentityStamp for one producer: a buffer's first timing PES (a video or audio stream
    id, or on the first PCR PID) - 1 h, else its arrival (a PES none timing, or the first
    buffer), else the last stamp; never below the last."""

    def __init__(self):
        self.last, self.timing_pid = None, None

    def stamp(self, data, arrival):
        pkts = list(ts_psi.iter_packets(data))
        if self.timing_pid is None:
            self.timing_pid = next((ts_psi.ts_pid(p) for p in pkts if ts_psi.read_pcr(p) is not None),
                                   None)
        st, any_pes = None, False
        for pkt in pkts:
            pts = ts_psi.read_pes_pts(pkt)
            if pts is None:
                continue
            any_pes = True
            sid = pkt[ts_psi.payload_offset(pkt) + 3]
            if (sid & 0xF0) == 0xE0 or (sid & 0xE0) == 0xC0 or ts_psi.ts_pid(pkt) == self.timing_pid:
                st = ts_timeline.house_from_mux_pts(pts, arrival)
                break
        if st is None:
            st = arrival if any_pes or self.last is None else self.last
        self.last = st if self.last is None else max(self.last, st)
        return self.last


def generate_ts(desc, timeout=60.0):
    """[(PTS, bytes)] of a non-live pipeline ending in `appsink name=ts`, run to EOS."""
    pipe = Gst.parse_launch(desc)
    sink = pipe.get_by_name("ts")
    out = []
    pipe.set_state(Gst.State.PLAYING)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        sample = sink.emit("try-pull-sample", Gst.SECOND)
        if sample is None:
            if sink.get_property("eos"):
                break
            continue
        buf = sample.get_buffer()
        out.append((buf.pts, buf.extract_dup(0, buf.get_size())))
    pipe.set_state(Gst.State.NULL)
    return out


def _shift_ts_field(b, at, shift):
    v = ((((b[at] >> 1) & 7) << 30) | (b[at + 1] << 22) | ((b[at + 2] >> 1) << 15)
         | (b[at + 3] << 7) | (b[at + 4] >> 1))
    v = (v + shift) % WRAP
    b[at] = (b[at] & 0xF1) | (((v >> 30) & 7) << 1)
    b[at + 1] = (v >> 22) & 0xFF
    b[at + 2] = (((v >> 15) & 0x7F) << 1) | 1
    b[at + 3] = (v >> 7) & 0xFF
    b[at + 4] = ((v & 0x7F) << 1) | 1


def rebase_ts(data, shift):
    """`data` with every PES PTS/DTS and PCR moved by `shift` ticks (mod 2^33)."""
    b = bytearray(data)
    for off in range(0, len(b) - 187, 188):
        if b[off] != 0x47:
            continue
        if b[off + 3] & 0x20 and b[off + 4] >= 7 and b[off + 5] & 0x10:
            at = off + 6
            base = ((b[at] << 25) | (b[at + 1] << 17) | (b[at + 2] << 9) | (b[at + 3] << 1)
                    | (b[at + 4] >> 7))
            base = (base + shift) % WRAP
            b[at], b[at + 1] = base >> 25, (base >> 17) & 0xFF
            b[at + 2], b[at + 3] = (base >> 9) & 0xFF, (base >> 1) & 0xFF
            b[at + 4] = (b[at + 4] & 0x7F) | ((base & 1) << 7)
        if not (b[off + 1] & 0x40) or not (b[off + 3] & 0x10):
            continue
        p = off + 4 + ((1 + b[off + 4]) if b[off + 3] & 0x20 else 0)
        if b[p:p + 3] != b"\x00\x00\x01" or b[p + 3] in (0xBC, 0xBE, 0xBF, 0xF0, 0xF1, 0xF2, 0xF8, 0xFF):
            continue
        flags = b[p + 7]
        if flags & 0x80:
            _shift_ts_field(b, p + 9, shift)
        if (flags & 0xC0) == 0xC0:
            _shift_ts_field(b, p + 14, shift)
    return bytes(b)


def ready_by_pcr(buffers, t0, lead_ns=40 * MS):
    """`buffers` [(bytes)] of one mux, each with its natural ready time: the house time of the
    last PCR up to its end (PCR - 1 h, near `t0`; the first PCR's before it) plus `lead_ns`."""
    out, last, head = [], None, []
    for data in buffers:
        for pkt in ts_psi.iter_packets(data):
            pcr = ts_psi.read_pcr(pkt)
            if pcr is not None:
                last = ts_timeline.house_from_mux_pts(pcr // 300, t0)
        if last is None:
            head.append(data)
            continue
        out += [(d, last + lead_ns) for d in head] + [(data, last + lead_ns)]
        head = []
    return out


def _monotonic_pipeline(desc):
    pipe = Gst.parse_launch(desc)
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
    pipe.use_clock(clock)
    pipe.set_start_time(Gst.CLOCK_TIME_NONE)
    pipe.set_base_time(0)
    return pipe


class Knobs:
    """How a producer delivers (seconds relative to the scenario's t0): `delay_ms` behind its
    content, in `burst_ms` bursts, silent over `silence` [(from, len, 'hold' | 'drop')] (hold:
    the backlog comes at the end; drop: the producer stops, its content is gone)."""

    def __init__(self, delay_ms=0.0, burst_ms=0.0, silence=None, transit_ms=2.0):
        self.delay_ns = int(delay_ms * MS)
        self.burst_ns = int(burst_ms * MS)
        self.silence = [(int(a * 1e9), int((a + b) * 1e9), mode) for a, b, mode in (silence or [])]
        self.transit_ns = int(transit_ms * MS)

    def dropped(self, rel_ns):
        return any(a <= rel_ns < b for a, b, mode in self.silence if mode == "drop")

    def delivery(self, rel_ready_ns):
        t = rel_ready_ns + self.transit_ns + self.delay_ns
        if self.burst_ns:
            t = -(-t // self.burst_ns) * self.burst_ns
        for a, b, mode in self.silence:
            if mode == "hold" and a <= t < b:
                t = b
        return t


class Producer:
    """One bus producer: 302M content (`Content`, through avenc_s302m ! mpegtsmux as every 302M
    module encodes) or prebuilt TS buffers, stamped by identity and delivered at real time on
    every socket in `sockets` (a unixfdsink each, as the engine's per-consumer edges). Everything
    it sends is built before the feed starts, so the feed only keeps time."""

    def __init__(self, name, sockets, content=None, ts=None, start_s=0.0, stop_s=None,
                 knobs=None, mistime_ns=0):
        self.name, self.sockets, self.t0 = name, list(sockets), None
        self.mistime_ns = mistime_ns    # a control: PES PTS this far from the content they carry
        self.content, self.ts = content, ts
        self.start_ns = int(start_s * 1e9)
        self.stop_ns = None if stop_s is None else int(stop_s * 1e9)
        self.knobs = knobs or Knobs()
        self.delivered = []             # (arrival, stamp, bytes)
        self.pcm_pushed = []            # first sample of every 10 ms block encoded
        self.late_ns = 0                # the worst delivery behind its schedule (the harness's own)
        self.late = []                  # (when, how late) of every push over 5 ms behind
        self.schedule = []              # (deliver at, seq, bytes)
        self._stop = threading.Event()
        self._thread = None
        tee = " ".join(f"t. ! queue max-size-buffers=0 max-size-bytes=0 max-size-time=0"
                       f" ! unixfdsink socket-path={s} sync=false async=false" for s in self.sockets)
        self.out = _monotonic_pipeline(f'appsrc name=src format=time caps="{TS_CAPS}" '
                                       f"! tee name=t allow-not-linked=true {tee}")
        self.stamper = IdentityStamper()

    def listen(self):
        """Serve the sockets (a consumer may connect from now on)."""
        self.out.set_state(Gst.State.PLAYING)

    def prepare(self, t0):
        """Build every buffer this producer sends from house time `t0` on (the scenario's zero, on
        the 10 ms grid), and when it is due."""
        self.t0 = t0
        if self.content is not None:
            self.content.origin = sample_of(t0)
            bufs = self._encode()
        else:
            bufs = []
            for data, ready in self.ts(t0):
                rel = ready - t0
                if rel < self.start_ns or (self.stop_ns is not None and rel >= self.stop_ns):
                    continue
                if not self.knobs.dropped(rel):
                    bufs.append((data, ready))
        self.schedule = sorted((t0 + self.knobs.delivery(ready - t0), i, data)
                               for i, (data, ready) in enumerate(bufs))

    def _encode(self):
        """The content's 10 ms blocks through avenc_s302m ! mpegtsmux, as fast as it goes:
        [(bytes, ready)], ready = when a live encoder had the buffer's last packet (its PES's block
        captured whole)."""
        first = sample_of(self.t0 + self.start_ns)
        last = sample_of(self.t0 + self.stop_ns)
        blocks = [n for n in range(first, last, BLOCK) if not self.knobs.dropped(house_of(n) - self.t0)]
        gen = Gst.parse_launch(
            f'appsrc name=pcm format=time caps="{PCM_CAPS}" ! avenc_s302m strict=experimental'
            " ! mpegtsmux latency=0 alignment=7 ! appsink name=ts sync=false max-buffers=0 drop=false")
        src, sink = gen.get_by_name("pcm"), gen.get_by_name("ts")
        gen.set_state(Gst.State.PLAYING)
        for n in blocks:
            b = Gst.Buffer.new_wrapped(self.content.pcm(n))
            b.pts = house_of(n) + self.mistime_ns
            b.duration = house_of(n + BLOCK) - house_of(n)
            src.emit("push-buffer", b)
        src.emit("end-of-stream")
        out, k, ready = [], -1, house_of(blocks[0] + BLOCK) if blocks else 0
        while True:
            sample = sink.emit("try-pull-sample", 5 * Gst.SECOND)
            if sample is None:
                break
            buf = sample.get_buffer()
            data = buf.extract_dup(0, buf.get_size())
            for pkt in ts_psi.iter_packets(data):
                if ts_psi.read_pes_pts(pkt) is not None and k + 1 < len(blocks):
                    k += 1
                    ready = house_of(blocks[k] + BLOCK)
            out.append((data, ready))
        gen.set_state(Gst.State.NULL)
        self.pcm_pushed = blocks
        return out

    def begin(self, t0=None):
        """Feed what `prepare` built (prepared now for `t0` when not yet)."""
        if t0 is not None and self.t0 != t0:
            self.prepare(t0)
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def join(self, timeout=None):
        if self._thread:
            self._thread.join(timeout)

    def stop(self):
        self._stop.set()
        self.join(5)
        self.out.set_state(Gst.State.NULL)

    def _lag(self, t, late):
        self.late_ns = max(self.late_ns, late)
        if late > 5 * MS:
            self.late.append((t, late))

    def _run(self):
        src = self.out.get_by_name("src")
        for at, _i, data in self.schedule:
            while not self._stop.is_set():
                wait = at - now_ns()
                if wait <= 0:
                    break
                time.sleep(min(wait / 1e9, 0.05))
            if self._stop.is_set():
                return
            sent = now_ns()
            self._lag(sent, sent - at)
            st = self.stamper.stamp(data, sent)
            b = Gst.Buffer.new_wrapped(data)
            b.pts = b.dts = st
            src.emit("push-buffer", b)
            self.delivered.append((sent, st, data))


def prepare(producers, lead_ms=3000):
    """Build every producer's feed for a t0 `lead_ms` ahead: t0. A module starts after its
    producers, as on a box: start it after this, then `go` before t0 comes."""
    t0 = grid(now_ns() + lead_ms * MS)
    for p in producers:
        p.prepare(t0)
    return t0


def go(producers):
    for p in producers:
        p.begin()


def until(t_ns):
    """Sleep until house time `t_ns`."""
    wait = (t_ns - now_ns()) / 1e9
    if wait > 0:
        time.sleep(wait)


class Consumer:
    """A consumer of one edge: every buffer as (arrival, wire PTS, flags, bytes)."""

    def __init__(self, socket):
        self.records = []
        self.pipe = _monotonic_pipeline(
            f"unixfdsrc socket-path={socket} ! queue max-size-buffers=0 max-size-bytes=0"
            " max-size-time=0 ! fakesink name=c sync=false async=false")
        self.pipe.get_by_name("c").get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER,
                                                                    self._on_buf)

    def _on_buf(self, _pad, info):
        buf = info.get_buffer()
        self.records.append((now_ns(), buf.pts, int(buf.get_flags()),
                             buf.extract_dup(0, buf.get_size())))
        return Gst.PadProbeReturn.OK

    def start(self):
        self.pipe.set_state(Gst.State.PLAYING)

    def stop(self):
        self.pipe.set_state(Gst.State.NULL)


class SocketDir:
    """A short-lived directory for one run's sockets (AF_UNIX paths stay short)."""

    def __init__(self):
        self.path = tempfile.mkdtemp(prefix="mrconf-")

    def sock(self, name):
        return os.path.join(self.path, f"{name}.sock")

    def close(self):
        for f in os.listdir(self.path):
            try:
                os.unlink(os.path.join(self.path, f))
            except OSError:
                pass
        os.rmdir(self.path)


# --------------------------------------------------------------------------- analysis
def pes_of(records, pid=None):
    """{pid: [PES]} of a consumer's records, each PES a dict: pts, dts (33-bit or None), sid,
    data (payload), arrival and stamp (of the bus buffer its header came in), end_arrival (of the
    buffer its last packet came in), packets, cut."""
    out, open_pes = {}, {}
    for arrival, stamp, _flags, data in records:
        for pkt in ts_psi.iter_packets(data):
            p = ts_psi.ts_pid(pkt)
            if pid is not None and p != pid:
                continue
            if not (pkt[3] & 0x10):
                continue
            payload = pkt[ts_psi.payload_offset(pkt):]
            if pkt[1] & 0x40:
                if p in open_pes:
                    out.setdefault(p, []).append(_finish(open_pes.pop(p)))
                if payload[:3] != b"\x00\x00\x01" or len(payload) < 9:
                    continue
                flags, hlen = payload[7], payload[8]
                pts = ts_psi.read_pes_pts(pkt)
                dts = None
                if (flags & 0xC0) == 0xC0:
                    q = payload[14:19]
                    dts = ((((q[0] >> 1) & 7) << 30) | (q[1] << 22) | ((q[2] >> 1) << 15)
                           | (q[3] << 7) | (q[4] >> 1))
                open_pes[p] = {"pts": pts, "dts": dts, "sid": payload[3], "arrival": arrival,
                               "stamp": stamp, "chunks": [payload[9 + hlen:]], "packets": 1,
                               "length": (payload[4] << 8) | payload[5], "hlen": hlen}
            elif p in open_pes:
                open_pes[p]["chunks"].append(payload)
                open_pes[p]["packets"] += 1
            if p in open_pes:
                open_pes[p]["end_arrival"] = arrival
    for p, pes in open_pes.items():
        out.setdefault(p, []).append(_finish(pes, cut=True))
    return out


def _finish(pes, cut=False):
    """A PES done: its payload, and `cut` when it is short of its length or the records end."""
    data = b"".join(pes.pop("chunks"))
    if pes["length"]:
        want = pes["length"] - 3 - pes["hlen"]          # PES_packet_length counts from flags
        cut = cut or len(data) < want
        data = data[:want]
    pes["data"], pes["cut"] = data, cut
    return pes


_REV = np.array([int(f"{i:08b}"[::-1], 2) for i in range(256)], dtype=np.uint8)


def decode_302m(payload):
    """SMPTE 302M payload -> int16 samples [n, channels] (ffmpeg's s302m, 16-bit words), or
    None when the header is not 16-bit."""
    if len(payload) < 4:
        return None
    h = int.from_bytes(payload[:4], "big")
    size, channels, bits = (h >> 16) & 0xFFFF, ((h >> 14) & 3) * 2 + 2, ((h >> 4) & 3) * 4 + 16
    if bits != 16:
        return None
    body = np.frombuffer(payload[4:4 + size], dtype=np.uint8)
    body = body[:len(body) // 5 * 5].reshape(-1, 5)
    r = _REV[body].astype(np.uint32)
    a = (r[:, 1] << 8) | r[:, 0]
    b = (_REV[body[:, 4] & 0xF0].astype(np.uint32) << 12) | (r[:, 3] << 4) | (r[:, 2] >> 4)
    pairs = np.stack([a, b], axis=1).astype(np.uint16).view(np.int16)
    return pairs.reshape(-1, channels)


def unwrap(pts, ref_house_ns):
    """House ns of a mux PES PTS (`PES - 1 h`, the period nearest `ref_house_ns`)."""
    return ts_timeline.house_from_mux_pts(pts, ref_house_ns)


def sample_of_pts(pts, ref_house_ns):
    """The sample a mux PES PTS starts at: mpegtsmux floors ns to 90 kHz (0.53 samples a tick),
    so the ceiling of `ticks * 48000 / 90000` is the sample whose time it floored."""
    ticks = ts_timeline.unwrap_near((pts - MUX_BASE) % WRAP, ref_house_ns * 9 // 100000)
    return -(-ticks * RATE // 90000)


class Pcm:
    """A 302M stream's samples on the absolute sample axis: `y[n - lo]`, `have` where a PES put
    one; `pes` the PES starts (sample, PTS ticks, arrival, stamp)."""

    def __init__(self, pes_list, ref_house_ns):
        pieces, self.pes, self.overlap = [], [], 0
        for pes in pes_list:
            if pes["pts"] is None:
                continue
            s = decode_302m(pes["data"])
            if s is None or not len(s):
                continue
            n0 = sample_of_pts(pes["pts"], ref_house_ns)
            pieces.append((n0, s))
            self.pes.append((n0, pes["pts"], pes["arrival"], pes["stamp"], len(s)))
        if not pieces:
            self.lo = self.hi = 0
            self.y = np.zeros((0, 2))
            self.have = np.zeros(0, dtype=bool)
            return
        self.lo = min(n for n, _ in pieces)
        self.hi = max(n + len(s) for n, s in pieces)
        self.y = np.zeros((self.hi - self.lo, 2))
        self.have = np.zeros(self.hi - self.lo, dtype=bool)
        for n0, s in pieces:
            i = n0 - self.lo
            self.overlap += int(self.have[i:i + len(s)].sum())
            self.y[i:i + len(s)] = s[:, :2] / 32767.0
            self.have[i:i + len(s)] = True

    @classmethod
    def of(cls, y, lo):
        """Samples `y` ([n, 2] floats) from absolute sample `lo`, all present."""
        p = cls([], 0)
        p.lo, p.hi, p.y = lo, lo + len(y), np.asarray(y, dtype=np.float64)
        p.have = np.ones(len(y), dtype=bool)
        return p

    def quiet_runs(self, lo, hi, min_len, floor_lsb=0):
        """[(from sample, length)] of runs of at least `min_len` samples within [lo, hi) where
        every channel is within `floor_lsb` of 0 (a dither's): silence filled in, as no content
        of these inputs is that quiet that long."""
        lo, hi = max(lo, self.lo), min(hi, self.hi)
        z = np.all(np.abs(self.y[lo - self.lo:hi - self.lo]) <= floor_lsb / 32767.0, axis=1)
        edges = np.flatnonzero(np.diff(np.concatenate(([0], z.astype(np.int8), [0]))))
        return [(lo + int(a), int(b - a)) for a, b in zip(edges[0::2], edges[1::2]) if b - a >= min_len]

    def found(self, content, c_lo, c_hi, o_lo, o_hi):
        """Where `content`'s samples [c_lo, c_hi) lie whole in the output's [o_lo, o_hi), at any
        shift: (the best normalized gain, its shift in samples, output - content)."""
        o_lo, o_hi = max(o_lo, self.lo), min(o_hi, self.hi)
        n_x, n_y = c_hi - c_lo, o_hi - o_lo
        if n_x <= 0 or n_y < n_x:
            return 0.0, None
        want = content.expected(np.arange(c_lo, c_hi, dtype=np.int64))
        energy = sum(float(np.dot(w, w)) for w in want)
        size = 1 << int(np.ceil(np.log2(n_x + n_y)))
        acc = np.zeros(size)
        for c in (0, 1):
            y = self.y[o_lo - self.lo:o_hi - self.lo, c]
            acc += np.fft.irfft(np.fft.rfft(y, size) * np.conj(np.fft.rfft(want[c], size)), size)
        # acc[k] = sum_i want[i] y[i + k]: content sample c_lo + i at output sample o_lo + i + k.
        window = acc[:n_y - n_x + 1]
        k = int(np.argmax(window))
        return (float(window[k]) / energy if energy > 0 else 0.0), o_lo + k - c_lo

    def holes(self, lo=None, hi=None):
        """[(from sample, length)] of the axis no PES covered within [lo, hi)."""
        lo = self.lo if lo is None else max(lo, self.lo)
        hi = self.hi if hi is None else min(hi, self.hi)
        have = self.have[lo - self.lo:hi - self.lo]
        out, i = [], 0
        while i < len(have):
            if not have[i]:
                j = i
                while j < len(have) and not have[j]:
                    j += 1
                out.append((lo + i, j - i))
                i = j
            else:
                i += 1
        return out

    def presence(self, content, lo, hi, block=960, lag=0):
        """Per block of [lo, hi): (first sample, the content's gain in the output at `lag`, the
        content's own level there), the gain a least-squares projection on both channels."""
        out = []
        for b0 in range(lo, hi - block + 1, block):
            n = np.arange(b0, b0 + block, dtype=np.int64)
            want = content.expected(n - lag)
            energy = sum(float(np.dot(w, w)) for w in want)
            i = b0 - self.lo
            if i < 0 or i + block > len(self.y):
                out.append((b0, None, energy))
                continue
            got = sum(float(np.dot(self.y[i:i + block, c], want[c])) for c in (0, 1))
            out.append((b0, got / energy if energy > 0 else None, energy))
        return out

    def best_lag(self, content, lo, hi, max_lag=4800):
        """The lag (samples) at which `content` correlates best with the output over [lo, hi),
        and that peak's normalized gain; FFT cross-correlation, both channels summed."""
        lo, hi = max(lo, self.lo), min(hi, self.hi)
        if hi - lo < 1024:
            return None, 0.0
        n = np.arange(lo - max_lag, hi + max_lag, dtype=np.int64)
        want = content.expected(n)
        size = 1 << int(np.ceil(np.log2(len(n) + (hi - lo))))
        acc = np.zeros(size)
        for c in (0, 1):
            y = self.y[lo - self.lo:hi - self.lo, c]
            acc += np.fft.irfft(np.fft.rfft(want[c], size) * np.conj(np.fft.rfft(y, size)), size)
        # acc[k] = sum_i want[i + k] y[i]: want index i + k is sample lo - max_lag + i + k, so the
        # output at sample m carries the content of sample m - lag when k = max_lag - lag.
        window = acc[:2 * max_lag + 1]
        k = int(np.argmax(window))
        lag = max_lag - k
        seg = content.expected(np.arange(lo - lag, hi - lag, dtype=np.int64))
        energy = sum(float(np.dot(s, s)) for s in seg)
        return lag, (float(window[k]) / energy if energy > 0 else 0.0)


def fade_window(n):
    """The half-Hann window of an aligner's fades (B-83), w(k) for k in [0, n), as libm gives it."""
    return np.array([0.5 * (1.0 + math.cos(math.pi * k / n)) for k in range(n)])


def edge_model(pcm, kept, gone, lo, hi, fade=240):
    """`gone`'s part of the mix over samples [lo, hi) (the mix less the `kept` inputs' content, in
    LSB) against its own content faded at its one dropout (B-83): out over `fade` samples where it
    first is no longer its content (the last `fade` before, reversed under the window), 0, then in
    under the window's complement where it is back. -> {"out", "back": samples or None, "dev": the
    largest deviation from that model, "steady": the mix against every input's content before}."""
    n = np.arange(lo, hi, dtype=np.int64)
    if pcm.lo > lo or pcm.hi < hi:
        return {"out": None, "back": None, "dev": None, "steady": None}
    y = np.rint(pcm.y[lo - pcm.lo:hi - pcm.lo] * 32767.0)
    lsb = lambda c: np.stack([np.rint(v * 32767.0) for v in c.expected(n)], axis=1)
    part = y - sum(lsb(c) for c in kept)
    g = lsb(gone)
    off = np.flatnonzero(np.any(np.abs(part - g) > 1, axis=1))
    res = {"out": None, "back": None, "dev": None,
           "steady": float(np.max(np.abs(part - g)[:off[0]])) if len(off) and off[0] else None}
    if not len(off) or off[0] < fade:
        return res
    i = int(off[0])
    on = np.flatnonzero(np.any(np.abs(part[i + fade:]) > 1, axis=1))
    if not len(on) or i + fade + int(on[0]) + fade > len(g):
        return res
    w = fade_window(fade)[:, None]
    # The fade-in's first samples round to 0: its start is the best fit within a ms before the
    # first sample seen back.
    seen = i + fade + int(on[0])
    j = min(range(max(i + fade, seen - 48), seen + 1),
            key=lambda c: float(np.max(np.abs(part[c:c + fade] - np.rint(g[c:c + fade] * (1.0 - w))))))
    model = g.copy()
    model[i:i + fade] = np.rint(g[i - 1::-1][:fade] * w)
    model[i + fade:j] = 0
    model[j:j + fade] = np.rint(g[j:j + fade] * (1.0 - w))
    res.update(out=lo + i, back=lo + j, dev=float(np.max(np.abs(part - model))))
    return res


def lateness_ms(records, lo_ns=None, hi_ns=None):
    """Consumer arrival - wire stamp (ms) of every buffer whose stamp lies in [lo_ns, hi_ns)."""
    return [(a - s) / 1e6 for a, s, _f, _d in records
            if s is not None and s >= 0 and (lo_ns is None or s >= lo_ns)
            and (hi_ns is None or s < hi_ns)]


def median(values):
    v = sorted(values)
    return v[len(v) // 2] if v else None


def arrival_gaps_ms(records, lo_ns=None, hi_ns=None):
    """[(arrival, gap ms before it)] between consecutive buffers arriving in [lo_ns, hi_ns)."""
    arr = [a for a, _s, _f, _d in records if (lo_ns is None or a >= lo_ns)
           and (hi_ns is None or a < hi_ns)]
    return [(b, (b - a) / 1e6) for a, b in zip(arr, arr[1:])]
