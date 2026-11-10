#!/usr/bin/env python3
"""The output conformance rig (WI-P4-14): the real modules' runner commands (fixtures/output/pipelines.json)
on either runner, display and card swapped for mrtestvideosink/mrtestaudiosink (kept with MR_GATE=1),
fed by aligner_rig's producers on the house clock. Shared by output_conformance_test.py; not shipped."""
import atexit
import json
import os
import re
import shutil
import tempfile
import time

import aligner_rig as rig

MS = rig.MS
S = 1_000_000_000
FIXTURES = os.path.join(rig.PLUGINS, "mpegts-core", "tests", "fixtures", "output")
FIXTURE_DIR = os.path.join(rig.PLUGINS, "mpegts-core", "tests", "fixtures")
HOUSE_DIR = os.path.join(rig.RUNNER_PLUGINS, "mpegts-core", "native", "mrtshouse")
TEST_DIR = os.path.join(HOUSE_DIR, "tests")
TEST_VIDEO_DIR = os.path.join(TEST_DIR, "mrtestvideo")
MRTS_CLI = os.path.join(rig.PLUGINS, "mpegts-core", "native", "mrts", "mrts_cli")
# MR_GATE=1: the box's own display and card (DEV-P4c2), named by these, else the strings' own.
GATE = os.environ.get("MR_GATE") == "1"
GATE_CONNECTOR = os.environ.get("MR_GATE_KMS_CONNECTOR")
GATE_PULSE_SINK = os.environ.get("MR_GATE_PULSE_SINK")

_DISPLAY = re.compile(r"kmssink name=sink [^!]*?qos=false")
_CARD = re.compile(r"pulsesink name=sink [^!]*$")


def pipelines():
    with open(os.path.join(FIXTURES, "pipelines.json"), encoding="utf-8") as fh:
        return json.load(fh)


def expectation(scenario):
    with open(os.path.join(FIXTURES, f"{scenario}.expect.json"), encoding="utf-8") as fh:
        return json.load(fh)


def have_test_sinks():
    return (os.path.exists(os.path.join(TEST_VIDEO_DIR, "libgstmrtestvideo.so"))
            and os.path.exists(os.path.join(TEST_DIR, "libgstmrtest.so")))


_REGISTRY = tempfile.mkdtemp(prefix="mrout-reg-")
atexit.register(shutil.rmtree, _REGISTRY, True)


def test_env():
    """The test sinks on the child's plugin path, with a registry of its own for the run."""
    path = [p for p in (os.environ.get("GST_PLUGIN_PATH", ""), TEST_VIDEO_DIR, TEST_DIR) if p]
    return {"GST_PLUGIN_PATH": ":".join(path), "GST_REGISTRY": os.path.join(_REGISTRY, "registry.bin")}


def display(period_ns=20_000_000, drift_ppm=0, extra=""):
    return f"mrtestvideosink name=sink period-ns={period_ns} drift-ppm={drift_ppm}{(' ' + extra) if extra else ''}"


def card(ppm=0.0, extra=""):
    return (f"mrtestaudiosink name=sink sync=false buffer-time=100000 latency-time=10000 ppm={ppm}"
            f"{(' ' + extra) if extra else ''}")


def on_sinks(pipeline, video=None, audio=None):
    """`pipeline` with its KMS sink and its PulseAudio sink swapped for `video` and `audio`; under
    MR_GATE=1 the real sinks stay, on MR_GATE_KMS_CONNECTOR and MR_GATE_PULSE_SINK when set."""
    if GATE:
        if GATE_CONNECTOR:
            pipeline = re.sub(r"(kmssink name=sink connector-id=)\d+", rf"\g<1>{GATE_CONNECTOR}", pipeline)
        if GATE_PULSE_SINK:
            pipeline = re.sub(r"(pulsesink name=sink device=)\S+", rf"\g<1>{GATE_PULSE_SINK}", pipeline)
        return pipeline
    if video is not None:
        pipeline = _DISPLAY.sub(video, pipeline)
    if audio is not None:
        pipeline = _CARD.sub(audio, pipeline)
    return pipeline


# --------------------------------------------------------------------------- streams
def at_house(rel, t0, lead_ms=40):
    """Relative-time TS buffers `rel` moved onto house time from `t0` (first PCR = t0), each with
    its ready time by PCR (aligner_rig.ready_by_pcr)."""
    p0 = next(rig.ts_psi.read_pcr(p) // 300 for d in rel for p in rig.ts_psi.iter_packets(d)
              if rig.ts_psi.read_pcr(p) is not None)
    shift = (t0 * 9 // 100000 + rig.MUX_BASE - p0) % rig.WRAP
    return rig.ready_by_pcr([rig.rebase_ts(d, shift) for d in rel], t0, lead_ms * MS)


def looped(data, laps, lap_ticks):
    """`data` (a GOP-aligned TS of `lap_ticks` 90 kHz ticks) `laps` times on, each lap rebased by
    one more lap, its continuity counters running on across the joins."""
    out, cc = bytearray(), {}
    for k in range(laps):
        lap = bytearray(rig.rebase_ts(data, k * lap_ticks) if k else data)
        for off in range(0, len(lap) - 187, 188):
            pid = ((lap[off + 1] & 0x1F) << 8) | lap[off + 2]
            if not lap[off + 3] & 0x10:
                continue
            n = (cc.get(pid, (lap[off + 3] & 0x0F) - 1) + 1) & 0x0F
            lap[off + 3] = (lap[off + 3] & 0xF0) | n
            cc[pid] = n
        out += lap
    return bytes(out)


def chunked(data, size=1316):
    return [data[i:i + size] for i in range(0, len(data), size)]


def fixture(name):
    with open(os.path.join(FIXTURE_DIR, name), "rb") as fh:
        return fh.read()


def pes_starts(data, pid):
    """[(PES PTS, packet index)] of `pid`'s PES starts in `data`."""
    out = []
    for i, pkt in enumerate(rig.ts_psi.iter_packets(data)):
        if pkt[1] & 0x40 and rig.ts_psi.ts_pid(pkt) == pid:
            pts = rig.ts_psi.read_pes_pts(pkt)
            if pts is not None:
                out.append((pts, i))
    return out


def stream_pids(buffers):
    """{'video' | 'audio': PID} of a stream's PMT."""
    pkts = [p for d in buffers[:200] for p in rig.ts_psi.iter_packets(d)]
    pat = rig.ts_psi.parse_pat(pkts)
    pmt = rig.ts_psi.parse_pmt(pkts, next(iter(pat.values()))) if pat else None
    out = {}
    for pid, st in (pmt or {}).get("streams", []):
        media = ("video" if st in (0x02, 0x1B, 0x24) else "audio" if st in (0x03, 0x04, 0x0F, 0x11, 0x06)
                 else None)
        if media and media not in out:
            out[media] = pid
    return out


def frames_of(rel, pid):
    return sum(1 for d in rel for p in rig.ts_psi.iter_packets(d)
               if p[1] & 0x40 and rig.ts_psi.ts_pid(p) == pid and rig.ts_psi.read_pes_pts(p) is not None)


def restamp_pes(data, pid, index, shift):
    """`data` with the `index`th PES of `pid` alone moved by `shift` ticks: a lone stale PES."""
    b, k = bytearray(data), -1
    for off in range(0, len(b) - 187, 188):
        if ((b[off + 1] & 0x1F) << 8 | b[off + 2]) != pid or not b[off + 1] & 0x40:
            continue
        k += 1
        if k == index:
            p = off + 4 + ((1 + b[off + 4]) if b[off + 3] & 0x20 else 0)
            flags = b[p + 7]
            if flags & 0x80:
                rig._shift_ts_field(b, p + 9, shift)
            if (flags & 0xC0) == 0xC0:
                rig._shift_ts_field(b, p + 14, shift)
            break
    return bytes(b)


# --------------------------------------------------------------------------- one output on a runner
class Output:
    """One output module's start command on one runner: launched before its feed starts (a display
    prerolls on its first frame), its events kept by aligner_rig.Runner."""

    def __init__(self, entry, argv, sock_dir, video=None, audio=None, edit=None):
        e = rig.on_socket_dir(pipelines()[entry], sock_dir)
        self.entry, self.name, self.argv = e, entry, argv
        self.start_cmd = dict(e["start"])
        p = on_sinks(self.start_cmd["pipeline"], video, audio)
        self.start_cmd["pipeline"] = edit(p) if edit else p
        self.runner, self.playing, self.rc, self.stop_ms = None, None, None, None

    def launch(self):
        env = dict(self.entry.get("env") or {}, **test_env())
        self.runner = rig.Runner(self.argv, env=env)
        if not self.runner.wait(lambda e: e.get("event") == "ready", 15.0):
            return False
        self.runner.send(dict(self.start_cmd, cmd="start"))
        return True

    def wait_playing(self, timeout=15.0):
        self.playing = self.runner.wait(lambda e: e.get("event") == "state_change"
                                        and e.get("state") == "playing", timeout)
        return self.playing is not None

    def prop(self, element, name, timeout=5.0):
        got = self.runner.request({"cmd": "get_property", "element": element, "property": name}, "property",
                                  timeout)
        return got[1].get("value") if got and got[1].get("event") == "property" else None

    def set_prop(self, element, name, value):
        self.runner.send({"cmd": "set_property", "element": element, "property": name, "value": value})

    def stop(self, timeout=15.0):
        """Stop it; how long until the runner exited, in ms."""
        if self.runner is None:
            return None
        t = time.monotonic()
        self.rc = self.runner.stop(timeout)
        self.stop_ms = round((time.monotonic() - t) * 1000)
        return self.rc

    # Its forwarded messages, each as (arrival, payload).
    def paces(self):
        return self.runner.plugin("mrvideopace:vp_pace")

    def lateness(self, name="lat_render"):
        return self.runner.plugin(f"mrlateness:{name}")

    def asrc_stats(self):
        return self.runner.plugin("mrasrc-stats:")

    def asrc_events(self):
        return self.runner.plugin("mrasrc-event:")

    def overruns(self):
        return [(t, p) for t, p in self.runner.plugin("queue_overrun")]

    def demux(self):
        return self.runner.plugin("mrtsdemux:")

    def errors(self):
        return [ev.get("message") for ev in self.runner.errors()]

    def warnings(self):
        return [ev.get("message") for _t, ev in self.runner.snapshot() if ev.get("event") == "warning"]


def window(series, t0, lo_s, hi_s, key):
    """The `key` values (ms) of `series` [(t, payload)] that arrived in [t0 + lo_s, t0 + hi_s)."""
    return [p[key] / 1e6 for t, p in series if t0 + lo_s * S <= t < t0 + hi_s * S
            and isinstance(p.get(key), (int, float))]


def spread(values):
    return round(max(values) - min(values), 1) if values else None


def mid(values):
    return round(rig.median(values), 1) if values else None
