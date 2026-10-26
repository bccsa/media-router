#!/usr/bin/env python3
"""An audio sink's provided clock against CLOCK_MONOTONIC (house-clock plan chapter 8 WI-P4-1;
register B-160): the device term's input data (p4-4a).

    sink_clock_trace.py '<sink-desc>' <seconds> <out.jsonl> [--hole AT:MS ...] [--restart AT ...]
                        [--prefill-ms N] [--rate HZ] [--channels N]
    sink_clock_trace.py --summarize <trace.jsonl>

Plays `audiotestsrc is-live=true` (on the monotonic system clock, natural base time, so content
arrives at the house rate) through a prefill queue (`min-threshold-time`, the outputs' 40 ms
by default; 0 leaves it out) into the sink, and writes one line per 100 ms: `mono_ns`
(CLOCK_MONOTONIC), `clock_ns` (the sink's provided clock), `delay_ns` (the ring's
`gst_audio_ring_buffer_delay`, -1 while no ring is acquired; always 0 for pulsesink, which has no
delay method) and `next_sample` (the base sink's write position in samples, -1 before the first
write: written less played is the fill). `--hole AT:MS` drops the source's
buffers for MS ms from AT s (nothing reaches the sink: a hole, or an underrun when longer than the
ring); `--restart AT` takes the pipeline READY -> PLAYING at AT s. Event lines mark both. At the
end a summary line goes to the file and to stdout: per stretch between events, the clock's rate
against monotonic (ppm), backward steps, the longest stall and the steps over 20 ms.

The clock is the sink's `provided_clock` field (GstAudioBaseSink's instance struct, read through
GstAudio's GIR): pulsesink's GstPulseSinkClock or alsasink's GstAudioSinkClock exists from the
sink's init whatever `provide-clock` says, so the sink runs with `provide-clock=false` as the
outputs run it. `gst_element_provide_clock()` would return NULL there. The tool stops with a line
when the field does not give a GstAudio.AudioClock on this box's PyGObject.
"""
import argparse
import json
import sys
import threading
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    gi.require_version("GstAudio", "1.0")
    from gi.repository import Gst, GstAudio
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"sink_clock_trace: GStreamer unavailable ({exc})", file=sys.stderr)
    sys.exit(2)

MS = 1_000_000
S = 1_000_000_000
STEP_NS = 20 * MS          # a sample-to-sample clock move this far off monotonic is a step
STALL_NS = 200 * MS        # monotonic time with the clock flat this long is a stall
SETTLE_NS = 2 * S          # left out of a stretch's rate after each event


def mono():
    return time.clock_gettime_ns(time.CLOCK_MONOTONIC)


def audio_sink(pipe):
    """The pipeline's GstAudioBaseSink."""
    it = pipe.iterate_sinks()
    while True:
        res, el = it.next()
        if res != Gst.IteratorResult.OK:
            return None
        if isinstance(el, GstAudio.AudioBaseSink):
            return el


def ring_delay_ns(sink):
    rb = sink.ringbuffer
    if rb is None or not rb.is_acquired():
        return -1
    rate = rb.spec.info.rate
    return rb.delay() * S // rate if rate else -1


def next_sample(sink):
    """The base sink's write position in the ring (samples), -1 before the first write."""
    n = sink.next_sample
    return -1 if n >= 2 ** 63 else n


def summarize(lines):
    """Per stretch between events: rate (ppm), backward steps, the longest stall, steps."""
    stretches, cur, events = [], [], []
    for ln in lines:
        if "event" in ln:
            events.append(ln)
            if cur:
                stretches.append(cur)
            cur = []
        elif "clock_ns" in ln:
            cur.append(ln)
    if cur:
        stretches.append(cur)
    out = []
    for st in stretches:
        backward, steps, stall, flat_from = 0, [], 0, None
        for a, b in zip(st, st[1:]):
            dm, dc = b["mono_ns"] - a["mono_ns"], b["clock_ns"] - a["clock_ns"]
            if dc < 0:
                backward += 1
            if abs(dc - dm) > STEP_NS:
                steps.append({"at_ns": b["mono_ns"] - st[0]["mono_ns"], "jump_ms": round((dc - dm) / MS, 1)})
            if dc <= dm // 10:
                flat_from = a["mono_ns"] if flat_from is None else flat_from
                stall = max(stall, b["mono_ns"] - flat_from)
            else:
                flat_from = None
        settled = [x for x in st if x["mono_ns"] - st[0]["mono_ns"] >= SETTLE_NS]
        ppm = None
        if len(settled) >= 2 and settled[-1]["mono_ns"] > settled[0]["mono_ns"]:
            dm = settled[-1]["mono_ns"] - settled[0]["mono_ns"]
            dc = settled[-1]["clock_ns"] - settled[0]["clock_ns"]
            ppm = round((dc - dm) * 1e6 / dm, 2)
        out.append({"from_ns": st[0]["mono_ns"], "seconds": round((st[-1]["mono_ns"] - st[0]["mono_ns"]) / S, 1),
                    "samples": len(st), "rate_ppm": ppm, "backward": backward,
                    "stall_ms": round(stall / MS, 1), "steps": steps[:20], "steps_total": len(steps)})
    return {"stretches": out, "events": [e["event"] for e in events]}


def trace(args):
    rate, ch = args.rate, args.channels
    prefill = (f"queue name=prefill min-threshold-time={args.prefill_ms * MS} max-size-time={S}"
               " max-size-buffers=0 max-size-bytes=0 ! " if args.prefill_ms else "")
    pipe = Gst.parse_launch(
        f"audiotestsrc name=src is-live=true wave=sine volume=0.05 samplesperbuffer={rate // 100}"
        f" ! audio/x-raw,format=S16LE,rate={rate},channels={ch} ! {prefill}{args.sink}")
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
    pipe.use_clock(clock)
    sink = audio_sink(pipe)
    if sink is None:
        print(f"sink_clock_trace: no audio base sink in '{args.sink}'", file=sys.stderr)
        return 2
    dev = sink.provided_clock
    if not isinstance(dev, GstAudio.AudioClock):
        print(f"sink_clock_trace: {sink.get_factory().get_name()}'s provided_clock field gives "
              f"{type(dev).__name__}, not a GstAudio.AudioClock, on this PyGObject: no trace",
              file=sys.stderr)
        return 2

    hold_until = [0]
    # A hole: the source's buffers dropped before the prefill, so nothing reaches the sink.
    pipe.get_by_name("src").get_static_pad("src").add_probe(
        Gst.PadProbeType.BUFFER,
        lambda pad, info: Gst.PadProbeReturn.DROP if mono() < hold_until[0] else Gst.PadProbeReturn.OK)
    errors = []
    bus = pipe.get_bus()

    out = open(args.out, "w")
    lock = threading.Lock()

    def write(obj):
        with lock:
            out.write(json.dumps(obj) + "\n")
            out.flush()

    lines = []
    write({"event": "start", "mono_ns": mono(), "sink": sink.get_factory().get_name(),
           "clock": dev.get_name(), "desc": args.sink, "prefill_ms": args.prefill_ms})
    schedule = sorted([(float(a), "hole", int(m)) for a, m in (h.split(":") for h in args.hole)]
                      + [(float(a), "restart", 0) for a in args.restart])
    pipe.set_state(Gst.State.PLAYING)
    t0 = mono()
    nxt = 0
    try:
        while mono() - t0 < args.seconds * S:
            now = mono()
            while schedule and now - t0 >= schedule[0][0] * S:
                _, kind, ms = schedule.pop(0)
                ev = {"event": kind, "mono_ns": now}
                if kind == "hole":
                    hold_until[0] = now + ms * MS
                    ev["ms"] = ms
                else:
                    pipe.set_state(Gst.State.READY)
                    pipe.get_state(5 * S)
                    pipe.set_state(Gst.State.PLAYING)
                write(ev)
                lines.append(ev)
            ln = {"mono_ns": mono(), "clock_ns": dev.get_time(), "delay_ns": ring_delay_ns(sink),
                  "next_sample": next_sample(sink)}
            write(ln)
            lines.append(ln)
            msg = bus.pop_filtered(Gst.MessageType.ERROR)
            if msg is not None:
                err, dbg = msg.parse_error()
                errors.append(err.message)
                write({"event": "error", "mono_ns": mono(), "message": err.message, "debug": dbg})
            nxt += 1
            time.sleep(max(0.0, (t0 + nxt * 100 * MS - mono()) / S))
    finally:
        pipe.set_state(Gst.State.NULL)
    summary = summarize(lines)
    summary["errors"] = errors
    write({"summary": summary})
    out.close()
    print(json.dumps({"summary": summary}))
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("sink", nargs="?", help="sink launch fragment, e.g. 'pulsesink device=X sync=false'")
    ap.add_argument("seconds", nargs="?", type=float)
    ap.add_argument("out", nargs="?")
    ap.add_argument("--hole", action="append", default=[], metavar="AT:MS")
    ap.add_argument("--restart", action="append", default=[], metavar="AT")
    ap.add_argument("--prefill-ms", type=int, default=40)
    ap.add_argument("--rate", type=int, default=48000)
    ap.add_argument("--channels", type=int, default=2)
    ap.add_argument("--summarize", metavar="TRACE")
    args = ap.parse_args()
    Gst.init([])
    if args.summarize:
        with open(args.summarize) as f:
            lines = [json.loads(x) for x in f if x.strip()]
        print(json.dumps({"summary": summarize([x for x in lines if "summary" not in x])}))
        return 0
    if args.sink is None or args.seconds is None or args.out is None:
        ap.error("sink, seconds and out are required")
    return trace(args)


if __name__ == "__main__":
    sys.exit(main())
