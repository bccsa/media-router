#!/usr/bin/env python3
"""Real-GStreamer probe for the muxer's aggregation timing (engine/muxTiming.ts),
driven by muxTimingGst.test.ts with the `mpegtsmux …` element the builder emits.

The muxer under the time-sync contract, reduced to its aggregation point: the
runner's contract clock (monotonic system clock, base_time 0, start_time NONE),
two live branches shaped like the hook's (`queue ! mux.sink_<pid>`), each input
buffer stamped PTS = DTS = its house time (what branchAlign establishes on the
real tsdemux pads). The video input (25 fps) arrives `--lag-ms` behind its
stamps, as an encoder's output does; the audio input (AAC-framed, 1024 samples
at 48 kHz) arrives on time. Payloads are synthetic — mpegtsmux never decodes —
so no encoder or parser is needed and only the mux is measured.

Reports, per audio PES, how long after its input buffer was pushed the PES's
last byte left the mux (`holdMs`), plus the stream checks a receiver relies on,
including the largest step between consecutive PCRs in PCR time.

    mux_timing_probe.py elements
    mux_timing_probe.py run '<mpegtsmux element>' --vpid 250 --apid 251 [--lag-ms 200] [--secs 3]

Prints one JSON object on stdout.
"""
import argparse
import json
import sys
import threading

import gi

gi.require_version("Gst", "1.0")
gi.require_version("GstBase", "1.0")
from gi.repository import Gst, GstBase  # noqa: E402

CLOCK_BASE = 90000 * 3600          # mpegtsmux adds one hour to every PTS/DTS/PCR
WRAP = 1 << 33
VIDEO_NS = 40_000_000
AUDIO_NS = 1024 * 1_000_000_000 // 48000
ELEMENTS = ("mpegtsmux", "appsrc", "fakesink", "queue")


def ticks(ns):
    return (ns * 9 // 100000 + CLOCK_BASE) % WRAP


def adts_frame(payload_len=360):
    # MPEG-4 AAC LC, 48 kHz, 2 ch, no CRC, one raw block; length covers the header.
    n = payload_len + 7
    hdr = bytes([0xFF, 0xF1, (1 << 6) | (3 << 2), (2 << 6) | (n >> 11),
                 (n >> 3) & 0xFF, ((n & 7) << 5) | 0x1F, 0xFC])
    return hdr + bytes(payload_len)


def h264_au(size=6000):
    # access unit delimiter + one IDR-typed slice NAL of junk
    return b"\x00\x00\x00\x01\x09\xf0" + b"\x00\x00\x00\x01\x65" + bytes(size)


def read_ts(p):
    return (((p[0] >> 1) & 7) << 30) | (p[1] << 22) | ((p[2] >> 1) << 15) | (p[3] << 7) | (p[4] >> 1)


class Tap:
    """Parses the mux's output: PES completion time per (pid, PTS ticks) and checks."""

    def __init__(self, clock, pids):
        self.clock, self.pids = clock, pids
        self.lock = threading.Lock()
        self.done = {}            # (pid, key) -> house ns its last byte left
        self.open = {}            # pid -> [key, need, got]
        self.last_dts = {}
        self.cc = {}
        self.cc_errors = self.dts_back = self.pts_lt_dts = 0
        self.last_pcr = None
        self.pcr_max_delta_ms = 0.0     # largest step between PCRs, in PCR time

    def packet(self, p, now):
        pid = ((p[1] & 0x1F) << 8) | p[2]
        afc, cc = (p[3] >> 4) & 3, p[3] & 0xF
        off = 4 + (1 + p[4] if afc & 2 else 0)
        if afc & 2 and p[4] and p[5] & 0x10:
            pcr = (p[6] << 25) | (p[7] << 17) | (p[8] << 9) | (p[9] << 1) | (p[10] >> 7)
            if self.last_pcr is not None:
                step = ((pcr - self.last_pcr) % WRAP) / 90.0
                self.pcr_max_delta_ms = max(self.pcr_max_delta_ms, step)
            self.last_pcr = pcr
        if afc & 1:
            if pid in self.cc and (self.cc[pid] + 1) & 0xF != cc:
                self.cc_errors += 1
            self.cc[pid] = cc
        if pid not in self.pids or not afc & 1:
            return
        pl = p[off:]
        if p[1] & 0x40 and pl[:3] == b"\x00\x00\x01":
            flags = pl[7] >> 6
            pts = read_ts(pl[9:14])
            dts = read_ts(pl[14:19]) if flags == 3 else pts
            if (pts - dts) % WRAP > WRAP // 2:
                self.pts_lt_dts += 1
            last = self.last_dts.get(pid)
            if last is not None and (dts - last) % WRAP > WRAP // 2:
                self.dts_back += 1
            self.last_dts[pid] = dts
            prev = self.open.pop(pid, None)
            if prev and prev[0] not in self.done:
                self.done[(pid, prev[0])] = now        # unbounded PES: ends at the next one
            length = (pl[4] << 8) | pl[5]
            self.open[pid] = [dts, length + 6 if length else 0, 0]
        st = self.open.get(pid)
        if st is None:
            return
        st[2] += len(pl)
        if st[1] and st[2] >= st[1]:
            self.done[(pid, st[0])] = now
            del self.open[pid]

    def on_buffer(self, buf):
        now = self.clock.get_time()
        ok, info = buf.map(Gst.MapFlags.READ)
        if not ok:
            return
        data = bytes(info.data)
        buf.unmap(info)
        with self.lock:
            for o in range(0, len(data) - 187, 188):
                self.packet(data[o:o + 188], now)


def run(args):
    vpid, apid = args.vpid, args.apid
    desc = (
        f"{args.mux} ! fakesink name=out sync=false async=false "
        "appsrc name=v is-live=true format=time min-latency=0 "
        'caps="video/x-h264,stream-format=byte-stream,alignment=au" '
        f"! queue ! mux.sink_{vpid} "
        "appsrc name=a is-live=true format=time min-latency=0 "
        'caps="audio/mpeg,mpegversion=4,stream-format=adts,framed=true,rate=48000,channels=2" '
        f"! queue ! mux.sink_{apid}"
    )
    pipe = Gst.parse_launch(desc)
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
    pipe.use_clock(clock)
    pipe.set_start_time(Gst.CLOCK_TIME_NONE)
    pipe.set_base_time(0)
    tap = Tap(clock, {vpid, apid})

    def probe(_pad, info):
        if info.type & Gst.PadProbeType.BUFFER_LIST:
            lst = info.get_buffer_list()
            for i in range(lst.length()):
                tap.on_buffer(lst.get(i))
        else:
            tap.on_buffer(info.get_buffer())
        return Gst.PadProbeReturn.OK

    mux = pipe.get_by_name("mux")
    mux.get_static_pad("src").add_probe(
        Gst.PadProbeType.BUFFER | Gst.PadProbeType.BUFFER_LIST, probe)
    pipe.set_state(Gst.State.PLAYING)

    t0 = clock.get_time() + 300_000_000
    lag = args.lag_ms * 1_000_000
    plan = []                    # (push at, src, stamp, payload)
    for i in range(int(args.secs * 25)):
        stamp = t0 + i * VIDEO_NS
        plan.append((stamp + lag, "v", stamp, h264_au()))
    for i in range(int(args.secs * 48000 / 1024)):
        stamp = t0 + i * AUDIO_NS
        plan.append((stamp + 1_000_000, "a", stamp, adts_frame()))
    plan.sort(key=lambda e: e[0])
    srcs = {"v": pipe.get_by_name("v"), "a": pipe.get_by_name("a")}
    pushed = {}                  # (pid, key) -> actual push time
    for at, name, stamp, payload in plan:
        Gst.Clock.id_wait(clock.new_single_shot_id(at))
        buf = Gst.Buffer.new_wrapped(payload)
        buf.pts = buf.dts = stamp
        pushed[(vpid if name == "v" else apid, ticks(stamp))] = clock.get_time()
        srcs[name].emit("push-buffer", buf)
    Gst.Clock.id_wait(clock.new_single_shot_id(clock.get_time() + 400_000_000))
    latency = GstBase.Aggregator.get_latency(mux)
    pipe.set_state(Gst.State.NULL)

    def holds(pid):
        out = sorted((tap.done[k] - t) / 1e6 for k, t in pushed.items()
                     if k[0] == pid and k in tap.done)
        return out

    def summary(v):
        return {"n": len(v), "p50": v[len(v) // 2] if v else None,
                "p95": v[int(len(v) * 0.95)] if v else None, "max": v[-1] if v else None}

    a, v = holds(apid), holds(vpid)
    return {
        "latencyMs": latency / 1e6 if latency != Gst.CLOCK_TIME_NONE else None,
        "audioIn": sum(1 for k in pushed if k[0] == apid),
        "videoIn": sum(1 for k in pushed if k[0] == vpid),
        "audioHoldMs": summary(a),
        "videoHoldMs": summary(v),
        "ccErrors": tap.cc_errors,
        "dtsBackward": tap.dts_back,
        "ptsBeforeDts": tap.pts_lt_dts,
        "pcrMaxDeltaMs": tap.pcr_max_delta_ms,
    }


def main():
    Gst.init(None)
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["elements", "run"])
    ap.add_argument("mux", nargs="?")
    ap.add_argument("--vpid", type=int, default=250)
    ap.add_argument("--apid", type=int, default=251)
    ap.add_argument("--lag-ms", type=int, default=200)
    ap.add_argument("--secs", type=float, default=3)
    args = ap.parse_args()
    if args.cmd == "elements":
        print(json.dumps({e: Gst.ElementFactory.find(e) is not None for e in ELEMENTS}))
        return 0
    print(json.dumps(run(args)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
