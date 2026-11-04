#!/usr/bin/env python3
"""The GStreamer fault behind B-208 (the owner's MR-046), at the GStreamer level and
deterministic: GStreamer 1.28.2's GstAudioAggregator, left with no sink pad at the wrong moment,
restarts its output at running time 0 and mixes from there at CPU speed.

The mixer is an Audio Mixer's: audiomixer, latency 0, start-time-selection first, non-live, on the
house clock (monotonic, base_time 0: running time is house time). Scenarios:
  R  its first buffer at house time on its only pad; its src thread held in its first negotiation
     (a blocking probe on the CAPS event it pushes) while that pad is unlinked and released, as a
     runner drops a lost live input; then a new pad brings data at house time.
  E  an EOS on its only pad before any data, that pad released, then a new pad with data.
  EK E with the pad kept (unlinked, not released) and the new data on it.
On stock GStreamer these rewind: each is reported as a KNOWN FAULT and the test exits 0. With
MR_GST_PATCHED=1 (a GStreamer with the image's patch) each must keep every output within 1 s of
house time at 1.5x real time or less. Asserted always, with the same bounds:
  C  R's hold without the release (the harness's control);
  K  R's hold with the pad kept (unlinked, not released) and the new data on it: the runners'
     fix (B-208).

Skips (exit 0) where GStreamer / PyGObject or audiomixer is unavailable.
Run:  python3 gst_audioaggregator_last_pad_test.py
"""
import os
import sys
import threading
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_audioaggregator_last_pad_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

Gst.init([])
if Gst.ElementFactory.find("audiomixer") is None:
    print("SKIP gst_audioaggregator_last_pad_test.py — audiomixer unavailable")
    sys.exit(0)

PATCHED = os.environ.get("MR_GST_PATCHED") == "1"
CLOCK = Gst.SystemClock.obtain()
CLOCK.set_property("clock-type", Gst.ClockType.MONOTONIC)
MS = Gst.MSECOND
BLOCK = 10 * MS
FEED_S = 0.6
CAPS = Gst.Caps.from_string("audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved")
_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def now():
    return CLOCK.get_time()


def block(pts):
    b = Gst.Buffer.new_wrapped(bytes(480 * 4))
    b.pts, b.duration = pts, BLOCK
    return b


class Mixer:
    """The Audio Mixer's aggregator into a fakesink, its outputs counted from `watch()` on.
    `hold`: its src thread waits in its first negotiation until `release_hold()`."""

    def __init__(self, hold):
        self.pipe = Gst.parse_launch(
            "audiomixer name=mixin latency=0 start-time-selection=first"
            " ! capsfilter caps=audio/x-raw,rate=48000,channels=2 ! fakesink sync=false async=false")
        self.pipe.use_clock(CLOCK)
        self.pipe.set_start_time(Gst.CLOCK_TIME_NONE)
        self.pipe.set_base_time(0)
        self.mixin = self.pipe.get_by_name("mixin")
        self.held, self._go = threading.Event(), threading.Event()
        self._first_caps = hold
        # Written on the mixer's src thread only (a runaway makes thousands of outputs: no list).
        self.span = None
        self.n, self.worst, self.played, self.first = 0, 0, 0, None
        self.mixin.get_static_pad("src").add_probe(
            Gst.PadProbeType.BUFFER | Gst.PadProbeType.EVENT_DOWNSTREAM, self._on_src)
        self.pipe.set_state(Gst.State.PLAYING)
        self.pipe.get_state(Gst.CLOCK_TIME_NONE)
        self.seg = Gst.Segment()
        self.seg.init(Gst.Format.TIME)

    def _on_src(self, _pad, info):
        if info.type & Gst.PadProbeType.BUFFER:
            wall, b = now(), info.get_buffer()
            if self.span is not None and self.span[0] <= wall < self.span[1]:
                off = b.pts - wall
                self.n += 1
                self.worst = max(self.worst, abs(off))
                self.played += b.duration if 0 < b.duration < Gst.SECOND else 0
                self.first = off if self.first is None else self.first
        elif info.get_event().type == Gst.EventType.CAPS and self._first_caps:
            self._first_caps = False
            self.held.set()
            self._go.wait(5)
        return Gst.PadProbeReturn.OK

    def release_hold(self):
        self._go.set()

    def link(self, tag, sinkpad=None):
        """A new src pad on `sinkpad` (a new request pad when None), its stream started."""
        sp = sinkpad or self.mixin.request_pad_simple("sink_%u")
        src = Gst.Pad.new("src" + tag, Gst.PadDirection.SRC)
        src.set_active(True)
        assert src.link(sp) == Gst.PadLinkReturn.OK
        src.push_event(Gst.Event.new_stream_start(tag))
        src.push_event(Gst.Event.new_caps(CAPS))
        src.push_event(Gst.Event.new_segment(self.seg))
        return src, sp

    def feed(self, src, seconds=FEED_S):
        """10 ms blocks at house time on `src`, in real time, from a thread (a runaway mixer never
        takes them: the push blocks), the outputs counted meanwhile: their count, worst |PTS -
        house| and rate x real time."""
        stop = threading.Event()

        def run():
            t = now() // BLOCK * BLOCK
            while not stop.is_set():
                while now() < t and not stop.is_set():
                    time.sleep(0.001)
                if stop.is_set() or src.push(block(t)) != Gst.FlowReturn.OK:
                    break
                t += BLOCK
        t0 = now()
        self.span = (t0, t0 + int(seconds * 1e9))
        threading.Thread(target=run, daemon=True).start()
        time.sleep(seconds + 0.05)
        stop.set()
        return {"n": self.n, "worst_s": round(self.worst / 1e9, 3),
                "rate": round(self.played / (self.span[1] - t0), 2),
                "first_s": None if self.first is None else round(self.first / 1e9, 3)}

    def stop(self):
        self._go.set()
        self.pipe.set_state(Gst.State.NULL)


def unlink(src, sp):
    src.unlink(sp)
    src.set_active(False)


def push_async(src, buf):
    threading.Thread(target=src.push, args=(buf,), daemon=True).start()


def on_time(r):
    return r["n"] > 0 and r["worst_s"] < 1.0 and r["rate"] <= 1.5


def run_hold(kind):
    """R ('release'), K ('keep') or C ('control'): the first negotiation held over the change."""
    m = Mixer(hold=True)
    try:
        src0, sp0 = m.link("a")
        push_async(src0, block(now() // BLOCK * BLOCK))
        if not m.held.wait(5):
            return {"n": 0, "worst_s": None, "rate": 0.0, "first_s": None, "pads": None}
        if kind == "release":
            unlink(src0, sp0)
            m.mixin.release_request_pad(sp0)
        elif kind == "keep":
            unlink(src0, sp0)
        m.release_hold()
        time.sleep(0.05)
        if kind == "control":
            src = src0
        else:
            src, _sp = m.link("b", sp0 if kind == "keep" else None)
        r = m.feed(src)
        r["pads"] = m.mixin.numsinkpads
        return r
    finally:
        m.stop()


def run_eos(keep):
    """E / EK: an EOS on the only pad before any data, the pad released (or kept), new data."""
    m = Mixer(hold=False)
    try:
        src0, sp0 = m.link("a")
        src0.push_event(Gst.Event.new_eos())
        time.sleep(0.03)
        unlink(src0, sp0)
        if not keep:
            m.mixin.release_request_pad(sp0)
        time.sleep(0.05)
        src, _sp = m.link("b", sp0 if keep else None)
        return m.feed(src)
    finally:
        m.stop()


def fault(label, r):
    """A stock-GStreamer scenario: asserted under MR_GST_PATCHED=1, reported otherwise."""
    text = (f"{label}: {r['n']} outputs, {r['rate']}x real time, worst {r['worst_s']} s off house"
            f" time (first {r['first_s']} s)")
    if PATCHED:
        check(f"{text}: within 1 s of house time, at 1.5x real time or less", on_time(r))
    elif on_time(r):
        print(f"NOTE {text}: the stock fault did not show (a GStreamer with the fix?)")
    else:
        print(f"KNOWN FAULT (stock {Gst.version_string()}) {text}")


if __name__ == "__main__":
    c = run_hold("control")
    check(f"C control, the first negotiation held, nothing released: {c['n']} outputs, {c['rate']}x"
          f" real time, worst {c['worst_s']} s off house time", on_time(c))
    k = run_hold("keep")
    check(f"K the only pad kept (unlinked) while the first negotiation is held, new data on it"
          f" (B-208): {k['n']} outputs, {k['rate']}x real time, worst {k['worst_s']} s off house time,"
          f" {k['pads']} sink pad", on_time(k) and k["pads"] == 1)
    fault("R the only pad released while the first negotiation is held, new data on a new pad",
          run_hold("release"))
    fault("E an EOS on the only pad before any data, the pad released, new data on a new pad",
          run_eos(keep=False))
    fault("EK E with the pad kept, new data on it (held EOS: the modules' branches never send one)",
          run_eos(keep=True))
    if _failures:
        print(f"\n{len(_failures)} FAILED: {_failures}")
        sys.exit(1)
    print("All GstAudioAggregator last-pad tests passed" + (" (patched)." if PATCHED else "."))
