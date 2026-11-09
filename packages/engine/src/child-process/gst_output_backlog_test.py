#!/usr/bin/env python3
"""A stall's backlog at the video output plays at content rate and is never shed (house-clock plan
ch. 8 WI-P4-14, §15; in place of the latency-ratchet test p4-11 deleted with the shedder).

The player's video leg as it stands after Phase 4: a live 50p feed into `queue name=vp_esq leaky=0`
(5 s), `mrvideopace`, and a sink, on the clock both runners give every pipeline (the monotonic
system clock, base time 0). The feed stalls 2 s and then delivers its backlog at once (a hold):

  A  an unpaced sink (fakesink sync=false): the backlog still leaves on the content's cadence,
     its lateness up by the stall and flat after;
  B  a media-rate display (mrtestvideosink at 50 Hz, 0008's model): the same;
  C  B, then a 2 s content gap (DISCONT): the cadence collapses at the gap and the lateness comes
     back to the input's.

No arm sheds: every frame pushed is released and reaches the sink, none dropped by the pace.
Lateness is the sink pad's own reading (now - PTS on the pipeline clock), not the element's.

The mutant it fails on is mrvideopace without its hold (`release = arrival`; arm A drains the
backlog at once): build it in a mirror tree and point MR_PLUGINS_DIR at it.
Skips (exit 0) without GStreamer or the built plugin; arms B and C without the test display.
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
    print(f"SKIP gst_output_backlog_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

Gst.init([])

S = Gst.SECOND
MS = Gst.MSECOND
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", "..", "..", ".."))
PLUGINS = os.environ.get("MR_PLUGINS_DIR") or os.path.join(REPO, "plugins")
HOUSE = os.path.join(PLUGINS, "mpegts-core", "native", "mrtshouse")
SO = os.path.join(HOUSE, "libgstmrtshouse.so")
TESTVIDEO = os.path.join(HOUSE, "tests", "mrtestvideo", "libgstmrtestvideo.so")
CAPS = "video/x-raw,format=I420,width=16,height=16,framerate=50/1"
FRAME = 20 * MS
LATENCY = 60 * MS            # each frame ready this long after its PTS (a decoder's)
SECONDS, STALL, GAP = 16, (4.0, 2.0), (10.0, 2.0)

if not os.path.exists(SO):
    print(f"SKIP gst_output_backlog_test.py — {SO} not built (make native)")
    sys.exit(0)
Gst.Plugin.load_file(SO)
HAVE_DISPLAY = os.path.exists(TESTVIDEO)
if HAVE_DISPLAY:
    Gst.Plugin.load_file(TESTVIDEO)

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name, flush=True)
    if not cond:
        _failures.append(name)


def sdict(st):
    return {st.nth_field_name(i): st.get_value(st.nth_field_name(i)) for i in range(st.n_fields())}


def run_arm(sink, gap):
    """One arm: [(arrival at the sink, PTS)] of every frame rendered, the frames pushed, the pace's
    stats and the vp_esq overruns; the feed's t0 is its first PTS."""
    pipe = Gst.parse_launch(
        f'appsrc name=src is-live=true format=time do-timestamp=false caps="{CAPS}" '
        "! queue name=vp_esq leaky=0 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=40000000 "
        f"! mrvideopace name=vp_pace ! {sink}")
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
    pipe.use_clock(clock)
    pipe.set_start_time(Gst.CLOCK_TIME_NONE)
    pipe.set_base_time(0)
    seen, overruns = [], []
    pipe.get_by_name("out").get_static_pad("sink").add_probe(
        Gst.PadProbeType.BUFFER, lambda _p, info: seen.append((clock.get_time(), info.get_buffer().pts))
        or Gst.PadProbeReturn.OK)
    pipe.get_by_name("vp_esq").connect("overrun", lambda _q: overruns.append(clock.get_time()))
    src = pipe.get_by_name("src")
    pipe.set_state(Gst.State.PLAYING)
    t0 = (clock.get_time() + 500 * MS) // FRAME * FRAME
    frames = []
    for k in range(SECONDS * 50):
        pts = t0 + k * FRAME
        rel = (pts - t0) / S
        if gap and gap[0] <= rel < gap[0] + gap[1]:
            continue                                   # content that never comes
        ready = pts + LATENCY
        if STALL[0] <= rel < STALL[0] + STALL[1]:
            ready = t0 + int((STALL[0] + STALL[1]) * S) + LATENCY    # held, sent at the stall's end
        frames.append((ready, pts))
    pushed = 0
    prev = None
    for ready, pts in frames:
        wait = ready - clock.get_time()
        if wait > 0:
            time.sleep(wait / 1e9)
        b = Gst.Buffer.new_wrapped(bytes(16 * 16 * 3 // 2))
        b.pts, b.duration = pts, FRAME
        if prev is not None and pts - prev > FRAME:
            b.set_flags(Gst.BufferFlags.DISCONT)
        prev = pts
        src.emit("push-buffer", b)
        pushed += 1
    time.sleep((STALL[1] * S + 500 * MS) / 1e9)     # the backlog's tail leaves before the stop
    stats = sdict(pipe.get_by_name("vp_pace").get_property("stats"))
    pipe.set_state(Gst.State.NULL)
    return t0, seen, pushed, stats, overruns


def lateness(seen, t0, lo, hi):
    return [(at - pts) / 1e6 for at, pts in seen if t0 + int(lo * S) <= pts < t0 + int(hi * S)]


def arm(label, sink, gap=None):
    t0, seen, pushed, stats, overruns = run_arm(sink, gap)
    before = lateness(seen, t0, 1, STALL[0])
    backlog = lateness(seen, t0, STALL[0], STALL[0] + STALL[1])
    after = lateness(seen, t0, STALL[0] + STALL[1], gap[0] if gap else SECONDS - 1)
    b, a = (sum(v) / len(v) if v else None for v in (before, after))
    step = a - b if a is not None and b is not None else None
    # The backlog's releases: the frames held by the stall leave on the content's 20 ms cadence.
    at = sorted(t for t, pts in seen if t0 + int(STALL[0] * S) <= pts < t0 + int((STALL[0] + STALL[1]) * S))
    deltas = sorted((y - x) / 1e6 for x, y in zip(at, at[1:]))
    median = deltas[len(deltas) // 2] if deltas else None
    check(f"{label}: nothing shed: every frame pushed reached the sink ({len(seen)} of {pushed}), the pace "
          f"dropped none ({stats.get('rate-drops')}), vp_esq never full ({len(overruns)} overruns)",
          len(seen) == pushed and stats.get("rate-drops") == 0 and not overruns)
    check(f"{label}: the stall's backlog plays at content rate (its releases {median and round(median, 1)} ms "
          f"apart, median), its lateness up by the stall ({b and round(b, 1)} -> {a and round(a, 1)} ms, "
          f"+{step and round(step)}; want +{STALL[1] * 1000:.0f} ± 25) and flat after "
          f"({round(max(after) - min(after), 1) if after else None} ms)",
          median is not None and abs(median - 20) <= 1 and step is not None
          and abs(step - STALL[1] * 1000) <= 25 and after and max(after) - min(after) <= 21 and len(backlog) > 90)
    if gap:
        back = lateness(seen, t0, gap[0] + gap[1] + 0.5, SECONDS - 1)
        c = sum(back) / len(back) if back else None
        check(f"{label}: after the gap the cadence collapses ({stats.get('gaps-collapsed')}) and the lateness is "
              f"back at the input's ({b and round(b, 1)} -> {c and round(c, 1)} ms, within a frame)",
              stats.get("gaps-collapsed") == 1 and c is not None and abs(c - b) <= 21)


def main():
    print("\n--- A: an unpaced sink (fakesink sync=false)")
    arm("A unpaced", "fakesink name=out sync=false async=false")
    if not HAVE_DISPLAY:
        print("SKIP B, C — mrtshouse/tests/mrtestvideo not built (make native-test)")
    else:
        print("\n--- B: a media-rate display (mrtestvideosink at 50 Hz)")
        arm("B media-rate", "mrtestvideosink name=out period-ns=20000000")
        print("\n--- C: B, then a 2 s content gap")
        arm("C then a gap", "mrtestvideosink name=out period-ns=20000000", gap=GAP)
    if _failures:
        print(f"\n{len(_failures)} FAILED: {_failures}")
        return 1
    print("\ngst_output_backlog_test.py: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
