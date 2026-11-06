#!/usr/bin/env python3
"""mrvideopace (house-clock plan chapter 8 part 4.2, WI-P4-3; register B-162, B-175):
mrts::VideoPace as an element. The dataflow cases run in the Python runner's interpreter on the
clock both runners give every pipeline (the monotonic system clock, base time 0), fed from a test
pad by a thread of their own; the runner cases read `stats` over get_property inside both
runners:

  pacing      a live 50p feed with a 1 s arrival stall and a 1 s content gap into fakesink
              sync=false: every frame leaves within 2 ms of what video_pace.py decides for the
              arrivals mrvideopace saw; the backlog on the content cadence, lateness +1 s until
              the gap; the stats count as the reference; a `mrvideopace` message every 2 s;
  base-time   the same on a pipeline whose base time is 1 s;
  flush       a flush during a 5 s wait returns at once, and the next frame leaves on arrival;
  ready       PAUSED -> READY during that wait too;
  gap         a GAP passes downstream in its place and collapses the next delta;
  dmabuf      video/x-raw(memory:DMABuf) DMA_DRM caps, the caps query and the allocation query
              reach the sink and its answer comes back;
  nominal     refresh-mhz=50000 into fakesink: 60p drops exactly the reference's 1 in 6;
  measured    60p into mrtestvideosink at 50 Hz (0008's model): 1 in 6 on the measured refresh,
              release lateness flat;
  drift       50p into mrtestvideosink period-ns=20000000 drift-ppm=-4000 for 2 min: rate-drops
              within 1 of the deficit the measured refresh gives, lateness flat within a frame;
  kms         60p into mrtestkmssink (kmssink's model): the refresh from mrvideopace's own
              returns, 1 in 6; 25p reads the refresh with refresh-mhz as the base and twice it
              without (B-161 D6); skip-vsync=true measures nothing;
  outage      an output switched off 3 s (stall-ms, 0008's timeout rule): frames pass unpaced,
              then a new cadence, and the display's lateness comes back to what it was;
  capped      60p into mrtestvideosink presenting at most 56.6 fps of 60.038 Hz (present-max-mhz,
              Weston on the Pi 5 box's DSI) with refresh-mhz=60038: the achieved period measured
              and paced to, rate-drops the presentation deficit, release lateness flat (B-175);
  keeps-up    50p into mrtestvideosink at 60.038 Hz, 36 s: a display that presents every frame
              keeps its refresh, nothing measured, no drop;
  kms-wait    60p (refresh-mhz=60038) and 50p (none) into mrtestkmssink vblanks=2, one frame per
              two refreshes as kmssink on that DSI: 30 and 20 drops a second, lateness flat;
  properties  defaults and the stats fields;
  clock-rule  the runners' clock rule (base time 0, start time none; B-169): a flushing seek's
              flush and the PLAYING after it hold no frame, where a default pipeline re-bases its
              running time and holds the frames after it by the time played before the seek;
  runners     inside mr-gst-runner and gst-pipeline-runner.py: refresh-mhz's nominal 1 in 6 into
              fakesink, the measured one into mrtestvideosink, and both shapes above with their
              rate-drops (the test library on the child's GST_PLUGIN_PATH with a private copy of
              the registry).

`python3 gst_mrvideopace_element_test.py [case ...]` runs those cases only. Skips (exit 0)
without GStreamer or the built plugin; the test-sink cases skip with a line without
mrtshouse/tests/mrtestvideo/libgstmrtestvideo.so (make native-test)."""
import os
import shutil
import sys
import tempfile
import threading
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import GObject, Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_mrvideopace_element_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

Gst.init([])

S = Gst.SECOND
MS = Gst.MSECOND
US = Gst.USECOND
NONE = Gst.CLOCK_TIME_NONE
P50 = 20 * MS
P60 = 16666667
LATENCY = 100 * MS
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", "..", "..", ".."))
# A mutant tree when set, as the runners resolve it; the reference is always this repo's.
PLUGINS = os.environ.get("MR_PLUGINS_DIR") or os.path.join(REPO, "plugins")
HOUSE = os.path.join(PLUGINS, "mpegts-core", "native", "mrtshouse")
SO = os.path.join(HOUSE, "libgstmrtshouse.so")
TESTVIDEO_DIR = os.path.join(HOUSE, "tests", "mrtestvideo")
TESTVIDEO = os.path.join(TESTVIDEO_DIR, "libgstmrtestvideo.so")
sys.path.insert(0, os.path.join(REPO, "plugins", "mpegts-core", "py"))
import video_pace as vp  # noqa: E402  (the Python reference, p4-3a)

DSI = 16656184                    # the Pi 5 box's DSI panel, 60.038 Hz (DEV-P4b)
CAPPED_MHZ = 56600                # Weston's HEVC 1080p60 on it: about 56.6 fps
CAPS50 = "video/x-raw,format=I420,width=16,height=16,framerate=50/1"
CAPS60 = "video/x-raw,format=I420,width=16,height=16,framerate=60/1"
CAPS25 = "video/x-raw,format=I420,width=16,height=16,framerate=25/1"
DMABUF = ("video/x-raw(memory:DMABuf),format=DMA_DRM,drm-format=NV12:0x0700000000000006,"
          "width=1920,height=1080,framerate=50/1")
FAKE = "fakesink name=out sync=false async=false"

if not os.path.exists(SO):
    print(f"SKIP gst_mrvideopace_element_test.py — {SO} not built (make native)")
    sys.exit(0)
Gst.Plugin.load_file(SO)   # a file that is there but does not load is a failure
HAVE_SINKS = os.path.exists(TESTVIDEO)
if HAVE_SINKS:
    Gst.Plugin.load_file(TESTVIDEO)

_failures = []


def check(name, cond, info=""):
    print(("PASS " if cond else "FAIL ") + name + (f" ({info})" if info else ""))
    if not cond:
        _failures.append(name)


def skip(name, why):
    print(f"SKIP {name} — {why}")


def mono():
    return time.monotonic_ns()


def house(pipe, base=0):
    """The clock both runners give every pipeline: monotonic system clock, base time 0 (or
    `base`)."""
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
    pipe.use_clock(clock)
    pipe.set_start_time(NONE)
    pipe.set_base_time(base)


def sdict(st):
    return {st.nth_field_name(i): st.get_value(st.nth_field_name(i)) for i in range(st.n_fields())}


def spread(values):
    return max(values) - min(values) if values else 0


class Rig:
    """mrvideopace and `sink` (named out) in a pipeline on the house clock, fed from a test pad;
    what mrvideopace took in (clock - base at entry), what left it and when, and what reached the
    sink, recorded in order."""

    def __init__(self, sink=FAKE, props="", base=0, caps=CAPS50):
        self.pipe = Gst.Pipeline.new(None)
        self.pipe.add(Gst.parse_bin_from_description(f"mrvideopace name=vp {props} ! {sink}", False))
        house(self.pipe, base)
        self.base, self.caps = base, caps
        self.frame_dur = self.caps_period(caps)
        self.vp = self.pipe.get_by_name("vp")
        self.out = self.pipe.get_by_name("out")
        self.feed = Gst.Pad.new("feed", Gst.PadDirection.SRC)
        self.feed.link(self.vp.get_static_pad("sink"))
        self.seen, self.left, self.down = [], [], []
        self.messages, self.errors = [], []
        self.results = []
        self.vp.get_static_pad("sink").add_probe(
            Gst.PadProbeType.BUFFER | Gst.PadProbeType.EVENT_DOWNSTREAM, self._in)
        self.vp.get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, self._out)
        self.out.get_static_pad("sink").add_probe(
            Gst.PadProbeType.BUFFER | Gst.PadProbeType.EVENT_DOWNSTREAM, self._down)
        self.pipe.get_bus().set_sync_handler(self._on_message)

    @staticmethod
    def caps_period(caps):
        s = Gst.Caps.from_string(caps).get_structure(0)
        ok, num, den = s.get_fraction("framerate")
        return (den * S * 2 + num) // (2 * num) if ok and num > 0 else 0

    def now(self):
        return mono() - self.base

    def _in(self, _pad, info):
        if info.type & Gst.PadProbeType.BUFFER:
            b = info.get_buffer()
            dur = b.duration if b.duration != NONE else self.frame_dur
            self.seen.append(("frame", b.pts, self.now(), dur,
                              bool(b.get_flags() & Gst.BufferFlags.DISCONT)))
        elif info.get_event().type == Gst.EventType.GAP:
            self.seen.append(("gap",))
        return Gst.PadProbeReturn.OK

    def _out(self, _pad, info):
        self.left.append((info.get_buffer().pts, self.now()))
        return Gst.PadProbeReturn.OK

    def _down(self, _pad, info):
        if info.type & Gst.PadProbeType.BUFFER:
            self.down.append(("buffer", info.get_buffer().pts))
        elif info.get_event().type == Gst.EventType.GAP:
            self.down.append(("gap", info.get_event().parse_gap()[0]))
        return Gst.PadProbeReturn.OK

    def _on_message(self, _bus, msg):
        if msg.type == Gst.MessageType.ERROR:
            err, dbg = msg.parse_error()
            self.errors.append(f"{msg.src.get_name()}: {err.message} {dbg or ''}")
        elif msg.type == Gst.MessageType.ELEMENT and msg.src == self.vp:
            st = msg.get_structure()
            if st.get_name() == "mrvideopace":
                self.messages.append((self.now(), sdict(st)))
        return Gst.BusSyncReply.DROP

    def start(self):
        self.feed.set_active(True)
        self.pipe.set_state(Gst.State.PLAYING)
        self.pipe.get_state(5 * S)
        self.feed.push_event(Gst.Event.new_stream_start("p4-3b"))
        self.feed.push_event(Gst.Event.new_caps(Gst.Caps.from_string(self.caps)))
        self.segment()
        return self

    def segment(self):
        seg = Gst.Segment()
        seg.init(Gst.Format.TIME)
        self.feed.push_event(Gst.Event.new_segment(seg))

    def push(self, pts, dur, discont=False):
        b = Gst.Buffer.new_wrapped(bytes(64))
        b.pts, b.duration = pts, dur
        if discont:
            b.set_flags(Gst.BufferFlags.DISCONT)
        return self.feed.push(b)

    def play(self, plan):
        """Pushes [(ready, pts, dur, discont, gap)] in a thread of its own: each at `ready`
        (clock - base) or once the previous push returned; a GAP event first where `gap`."""
        def run():
            for ready, pts, dur, discont, gap in plan:
                wait = ready - self.now()
                if wait > 0:
                    time.sleep(wait / S)
                if gap:
                    self.feed.push_event(Gst.Event.new_gap(pts, 0))
                ret = self.push(pts, dur, discont)
                self.results.append(ret)
                if ret != Gst.FlowReturn.OK:
                    return

        t = threading.Thread(target=run, daemon=True)
        t.start()
        return t

    def stats(self):
        return sdict(self.vp.get_property("stats"))

    def stop(self):
        self.pipe.set_state(Gst.State.NULL)
        self.feed.set_active(False)


def live(n, num, den, start, latency=LATENCY, dur=None):
    """n frames at num/den fps from PTS `start`, each ready `latency` after its PTS."""
    out = []
    for k in range(n):
        pts = start + k * den * S // num
        out.append([pts + latency, pts, den * S // num if dur is None else dur, False, False])
    return out


def reference(rig, display=None, gap_threshold_ns=vp.GAP_THRESHOLD_NS):
    """video_pace.py's decisions for what mrvideopace took in: [(pts, release, drop)], take(),
    and how many frames arrived within 200 us of their slot: the probe reads the clock just
    before mrvideopace does, so `late` may count those either way."""
    pace = vp.VideoPace(gap_threshold_ns)
    if display:
        pace.set_display(*display)
    out, close, prev = [], 0, None
    for item in list(rig.seen):
        if item[0] == "gap":
            pace.on_gap()
            continue
        _, pts, arrival, dur, discont = item
        release, drop = pace.on_frame(pts, dur, arrival, discont)
        if prev is not None and abs(arrival - (prev[1] + pts - prev[0])) <= 200 * US:
            close += 1
        out.append((pts, release, drop))
        prev = (pts, release)
    return out, pace.take(), close


def on_time(errs, tol=2 * MS):
    """Waits end at the release or after it: none early (50 us for the probe's own clock read),
    95 % within `tol`, none past a frame (a wake late on a shared host, not a wrong schedule)."""
    if not errs:
        return False
    late = sorted(errs)
    return late[0] >= -50 * US and late[(len(late) * 95) // 100] <= tol and late[-1] <= P50


def against_reference(rig, decisions, label):
    """The frames that left, as the reference keeps them, at its releases (on_time)."""
    kept = [(p, r) for p, r, d in decisions if not d]
    left = list(rig.left)
    same = len(kept) == len(left) and all(a[0] == b[0] for a, b in zip(kept, left))
    errs = [b[1] - a[1] for a, b in zip(kept, left)]
    ok = same and on_time(errs)
    errs.sort()
    check(f"{label}: frames leave within 2 ms of video_pace.py's release for the arrivals "
          f"mrvideopace saw ({len(left)} left, {len(kept)} kept by the reference)", ok,
          f"error {errs[0] / 1e3:.0f} to {errs[-1] / 1e3:.0f} us, p95 "
          f"{errs[(len(errs) * 95) // 100] / 1e3:.0f} us" if errs else "nothing left")
    return ok


def lateness(rig, frm=None, to=None):
    """Release lateness (left - PTS) of the frames that left with PTS in [frm, to)."""
    return [t - p for p, t in rig.left if (frm is None or p >= frm) and (to is None or p < to)]


# --------------------------------------------------------------------------- pacing, base-time
def pacing(base=0, label="pacing"):
    rig = Rig(base=base).start()
    t0 = rig.now() + 50 * MS
    plan = live(300, 50, 1, t0 - LATENCY)
    stall_end = plan[50][0] + S
    for k in range(50, 100):
        plan[k][0] = max(plan[k][0], stall_end)          # a 1 s arrival stall: the backlog at once
    for k in range(200, 300):
        plan[k][0] += S                                   # a 1 s content gap: the source pauses
        plan[k][1] += S
    rig.play([tuple(p) for p in plan]).join(15)
    time.sleep(0.1)
    st = rig.stats()
    rig.stop()
    decisions, ref, close = reference(rig)
    against_reference(rig, decisions, label)
    # What mrvideopace decided is the reference's (above); these read the reference's releases.
    late = [r - p for p, r, _d in decisions]
    cadenced = all(decisions[k][1] - decisions[k - 1][1] == decisions[k][0] - decisions[k - 1][0]
                   for k in range(51, 200))
    # Within a frame of the feed's lateness: the feeder's own wakes come late on a busy host.
    check(f"{label}: the stall's backlog leaves on the content cadence, lateness +1 s until the "
          f"content gap, then the input's", len(late) == 300 and cadenced
          and 0 <= late[100] - LATENCY - S <= P50
          and all(0 <= x - LATENCY <= P50 for x in late[200:]),
          f"held {late[100] / 1e6:.1f} ms, after {min(late[200:]) / 1e6:.1f}-"
          f"{max(late[200:]) / 1e6:.1f} ms" if len(late) == 300 else "")
    check(f"{label}: stats count what the reference counts (released {st['released']}, late "
          f"{st['late']}, gaps-collapsed {st['gaps-collapsed']}; reference {ref.released}, "
          f"{ref.late}, {ref.gaps_collapsed}; {close} arrived within 200 us of their slot), no "
          f"rate drop, refresh-source none",
          st["released"] == ref.released == 300 and abs(st["late"] - ref.late) <= close
          and st["gaps-collapsed"] == ref.gaps_collapsed == 1 and st["rate-drops"] == 0
          and st["refresh-source"] == "none" and st["unpaced"] == 0)
    times = [t for t, _ in rig.messages]
    gaps = [b - a for a, b in zip(times, times[1:])]
    check(f"{label}: a `mrvideopace` message at the first frame, then every 2 s of arrivals",
          len(times) >= 3 and all(1900 * MS <= g <= 2500 * MS for g in gaps),
          f"{len(times)} messages, gaps {[round(g / 1e6) for g in gaps]} ms")
    return rig


def case_pacing():
    rig = pacing()
    fields = set(rig.messages[-1][1]) if rig.messages else set()
    want = {"released", "late", "rate-drops", "gaps-collapsed", "unpaced", "content-fps-x100",
            "refresh-ns", "refresh-source", "achieved-ns", "display-behind", "mean-hold-ns",
            "present-lateness-ns", "display-presenting"}
    last = rig.messages[-1][1] if rig.messages else {}
    check("pacing: the message carries the plan's fields, display-presenting, unpaced, achieved-ns "
          "and display-behind",
          fields == want and last.get("content-fps-x100") == 5000
          and last.get("present-lateness-ns", 0) > 0, f"{sorted(fields)}")
    check("pacing: no error", not rig.errors, "; ".join(rig.errors))


def case_base_time():
    pacing(base=S, label="base-time 1 s")


# --------------------------------------------------------------------------- flush, ready
def long_wait(props="gap-threshold-ms=10000"):
    """Two frames of 2 s, the second 5 s on: mrvideopace waits 5 s for it."""
    rig = Rig(props=props).start()
    now = rig.now()
    feeder = rig.play([(now, now, 2 * S, False, False), (now, now + 5 * S, 2 * S, False, False)])
    deadline = mono() + 2 * S
    while len(rig.left) < 1 and mono() < deadline:
        time.sleep(0.01)
    time.sleep(0.3)
    return rig, feeder


def timed(fn, timeout):
    """fn() in a thread: (seconds it took, True) or (timeout, False)."""
    done = threading.Event()
    t0 = time.monotonic()

    def run():
        fn()
        done.set()

    threading.Thread(target=run, daemon=True).start()
    ok = done.wait(timeout)
    return (time.monotonic() - t0 if ok else timeout), ok


def case_flush():
    rig, feeder = long_wait()
    took, ok = timed(lambda: (rig.feed.push_event(Gst.Event.new_flush_start()),
                              rig.feed.push_event(Gst.Event.new_flush_stop(True))), 2.0)
    feeder.join(1)
    check("flush: FLUSH_START during a 5 s wait returns it at once, FLUSHING, and FLUSH_STOP goes "
          "through", ok and took < 0.1 and rig.results[-1:] == [Gst.FlowReturn.FLUSHING],
          f"{took * 1e3:.0f} ms, {rig.results}")
    rig.segment()
    now = rig.now()
    rig.play([(now, now, P50, True, False), (now, now + P50, P50, False, False)]).join(2)
    time.sleep(0.05)
    late = [t - p for p, t in rig.left[1:]]
    gap = rig.left[2][1] - rig.left[1][1] if len(rig.left) == 3 else 0
    check("flush: the next frames pace from scratch: the first leaves on arrival, the second a "
          "frame after it", len(late) == 2 and 0 <= late[0] < 2 * MS and abs(gap - P50) <= 2 * MS,
          f"lateness {late[0] / 1e6:.2f} ms, then {gap / 1e6:.2f} ms" if len(late) == 2 else "")
    rig.stop()


def case_ready():
    rig, feeder = long_wait()
    took, ok = timed(lambda: rig.pipe.set_state(Gst.State.READY), 2.0)
    feeder.join(1)
    check("ready: PAUSED -> READY during a 5 s wait completes at once, the push FLUSHING",
          ok and took < 0.2 and rig.results[-1:] == [Gst.FlowReturn.FLUSHING],
          f"{took * 1e3:.0f} ms, {rig.results}")
    rig.stop()


# --------------------------------------------------------------------------- gap, dmabuf
def case_gap():
    rig = Rig().start()
    t0 = rig.now() + 50 * MS
    plan = live(100, 50, 1, t0 - LATENCY)
    stall_end = plan[20][0] + 500 * MS
    for k in range(20, 50):
        plan[k][0] = max(plan[k][0], stall_end)          # a backlog, so a collapse shows
    for k in range(50, 100):
        plan[k][0] += 60 * MS                             # 60 ms more: inside 4 frames
        plan[k][1] += 60 * MS
    plan[50][4] = True                                    # a GAP before it
    rig.play([tuple(p) for p in plan]).join(10)
    time.sleep(0.05)
    st = rig.stats()
    rig.stop()
    decisions, ref, _close = reference(rig)
    against_reference(rig, decisions, "gap")
    order = [k for k, _ in rig.down]
    at = order.index("gap") if "gap" in order else -1
    check("gap: the GAP reaches the sink in its place, between the 50th and 51st frames",
          at == 50 and order.count("gap") == 1 and len(order) == 101 and rig.down[at][1] == plan[50][1])
    before, after = (decisions[k][1] - decisions[k][0] for k in (49, 50))
    check("gap: it collapses the next delta: one collapse, the 60 ms step not waited for",
          st["gaps-collapsed"] == ref.gaps_collapsed == 1 and after == before - 60 * MS,
          f"lateness {before / 1e6:.1f} -> {after / 1e6:.1f} ms")
    rig.seen = [x for x in rig.seen if x[0] == "frame"]
    check("gap: without the GAP the reference keeps that step as a clean delta",
          reference(rig)[1].gaps_collapsed == 0)


def case_dmabuf():
    if not HAVE_SINKS:
        skip("dmabuf", f"{TESTVIDEO} not built (make native-test)")
        return
    rig = Rig(sink="capsfilter caps=video/x-raw(memory:DMABuf) ! mrtestvideosink name=out async=false",
              caps=DMABUF)
    rig.start()
    caps = rig.feed.peer_query_caps(None)
    feature = caps.get_features(0).contains("memory:DMABuf") if caps.get_size() else False
    accepted = rig.feed.peer_query_accept_caps(Gst.Caps.from_string(DMABUF))
    q = Gst.Query.new_allocation(Gst.Caps.from_string(DMABUF), True)
    answered = rig.feed.peer_query(q)
    pool = q.parse_nth_allocation_pool(0) if q.get_n_allocation_pools() == 1 else None
    check("dmabuf: the caps query answers the sink's memory:DMABuf caps and DMA_DRM caps are "
          "accepted", feature and accepted, caps.to_string())
    check("dmabuf: the allocation query reaches the sink and the pool it proposes comes back",
          answered and pool is not None and pool[1:] == (4096, 2, 0), f"{pool}")
    now = rig.now()
    rig.play([(now, now, P50, False, False)]).join(2)
    time.sleep(0.05)
    check("dmabuf: a DMABuf frame passes", rig.results == [Gst.FlowReturn.OK] and len(rig.down) == 1)
    rig.stop()


# --------------------------------------------------------------------------- the display period
def case_nominal():
    rig = Rig(props="refresh-mhz=50000", caps=CAPS60).start()
    t0 = rig.now() + 50 * MS
    rig.play([tuple(p) for p in live(300, 60, 1, t0 - LATENCY)]).join(10)
    time.sleep(0.05)
    st = rig.stats()
    rig.stop()
    decisions, _ref, _close = reference(rig, (P50, "nominal"))
    against_reference(rig, decisions, "nominal")
    dropped = [i for i, (_p, _r, d) in enumerate(decisions) if d]
    check("nominal: refresh-mhz=50000 into fakesink: 60p drops 1 in 6, the reference's frames",
          abs(len(dropped) - 50) <= 2 and st["rate-drops"] == len(dropped)
          and st["refresh-source"] == "nominal" and st["refresh-ns"] == P50
          and all(b - a == 6 for a, b in zip(dropped, dropped[1:])),
          f"rate-drops {st['rate-drops']}, the first at frame {dropped[0] if dropped else None}, "
          f"{st['refresh-source']} {st['refresh-ns']}")


def poll(rig, seconds, every=0.1):
    """vp's stats and out's display-stats (None without) every `every` s: [(t, stats, display)]."""
    out = []
    end = time.monotonic() + seconds
    has = rig.out.find_property("display-stats") is not None
    while time.monotonic() < end:
        disp = sdict(rig.out.get_property("display-stats")) if has else None
        out.append((rig.now(), rig.stats(), disp))
        time.sleep(every)
    return out


def switch_at(samples):
    """The first sample whose refresh-source is measured, or None."""
    return next((s for s in samples if s[1]["refresh-source"] == "measured"), None)


def case_measured():
    if not HAVE_SINKS:
        skip("measured", f"{TESTVIDEO} not built (make native-test)")
        return
    rig = Rig(sink="mrtestvideosink name=out period-ns=20000000 async=false", props="refresh-mhz=50000",
              caps=CAPS60).start()
    t0 = rig.now() + 50 * MS
    feeder = rig.play([tuple(p) for p in live(720, 60, 1, t0 - LATENCY)])
    samples = poll(rig, 12.3)
    feeder.join(5)
    st = rig.stats()
    rig.stop()
    left = {p for p, _ in rig.left}
    frames = [x[1] for x in rig.seen if x[0] == "frame"]
    dropped = [i for i, p in enumerate(frames) if p not in left]
    late = lateness(rig, frames[120])
    check("measured: 60p into mrtestvideosink at 50 Hz: 1 in 6 dropped on the measured refresh, "
          "the refresh exact", len(frames) == 720 and abs(len(dropped) - 120) <= 2
          and all(b - a == 6 for a, b in zip(dropped, dropped[1:]))
          and st["refresh-source"] == "measured"
          and st["refresh-ns"] == P50 and switch_at(samples) is not None,
          f"{len(dropped)} of {len(frames)} dropped, {st['refresh-source']} {st['refresh-ns']}")
    check("measured: release lateness flat within a frame and a refresh after the first 2 s",
          late and spread(late) <= P60 + P50, f"spread {spread(late) / 1e6:.1f} ms")


def case_drift():
    if not HAVE_SINKS:
        skip("drift", f"{TESTVIDEO} not built (make native-test)")
        return
    rig = Rig(sink="mrtestvideosink name=out period-ns=20000000 drift-ppm=-4000 async=false").start()
    t0 = rig.now() + 50 * MS
    n = 6000
    feeder = rig.play([tuple(p) for p in live(n, 50, 1, t0 - LATENCY)])
    samples = poll(rig, 121.0, every=0.25)
    feeder.join(5)
    time.sleep(0.1)
    st, disp = rig.stats(), sdict(rig.out.get_property("display-stats"))
    rig.stop()
    sw = switch_at(samples)
    if sw is None:
        check("drift: mrvideopace measures the display", False, f"refresh-source {st['refresh-source']}")
        return
    period = st["refresh-ns"]
    at = sw[1]["released"] + sw[1]["rate-drops"]           # frames before the measurement
    after = n - at
    deficit = ((after - 1) * period - (after - 1) * P50) / period
    drops = st["rate-drops"] - sw[1]["rate-drops"]
    # Decimation that starts mid-stream starts a frame in credit (the reference's floor, B-162).
    check(f"drift: 2 min of 50p into a display 4,000 ppm slow: rate-drops within 1 of the measured "
          f"deficit less the frame decimation starts in credit ({drops} after the measurement at "
          f"frame {at}, deficit {deficit:.1f}; refresh {period} ns)",
          abs(drops - (deficit - 1)) <= 1 and abs(period - 20080000) <= 20 and drops > 20)
    frames = [x[1] for x in rig.seen if x[0] == "frame"]
    left = {p for p, _ in rig.left}
    first = next((i for i in range(at, len(frames)) if frames[i] not in left), len(frames) - 1)
    late = lateness(rig, frames[min(first + 50, len(frames) - 1)])
    t_first = next((t for p, t in rig.left if p > frames[first]), 0)
    shown = [s[2]["last-presented-ns"] - s[2]["last-running-time"] for s in samples
             if s[0] > t_first + S and s[2]["presented"] > 0]
    check(f"drift: from the first drop (frame {first}) release lateness flat within one frame, the "
          f"display's within a frame and a refresh", late and spread(late) <= P50 + 2 * MS
          and shown and spread(shown) <= 2 * P50 + 2 * MS,
          f"release {spread(late) / 1e6:.1f} ms, display {spread(shown) / 1e6:.1f} ms")
    check("drift: the display presented every frame kept, none replaced",
          disp["replaced"] == 0 and disp["present-timeouts"] == 0 and disp["not-presented"] == 0,
          f"{disp}")


KMS = "mrtestkmssink name=out period-ns=20000000 async=false"


def kms_60p(props, seconds, label, sink_props=""):
    """60p into mrtestkmssink at 50 Hz: the refresh from mrvideopace's own returns, 1 in 6."""
    rig = Rig(sink=KMS + sink_props, props=props, caps=CAPS60).start()
    t0 = rig.now() + 50 * MS
    feeder = rig.play([tuple(p) for p in live(seconds * 60, 60, 1, t0 - LATENCY)])
    samples = poll(rig, seconds + 0.3)
    feeder.join(5)
    st = rig.stats()
    rig.stop()
    sw = switch_at(samples)
    frames = [x[1] for x in rig.seen if x[0] == "frame"]
    at = (sw[1]["released"] + sw[1]["rate-drops"]) if sw else len(frames)
    drops = st["rate-drops"] - (sw[1]["rate-drops"] if sw else 0)
    want = (len(frames) - at) / 6
    # Within 2: decimation that starts mid-stream starts a frame in credit (B-162).
    check(f"kms: 60p into mrtestkmssink at 50 Hz {label}: the refresh measured from mrvideopace's "
          f"returns, 1 in 6 dropped after it", sw is not None
          and abs(st["refresh-ns"] - P50) * 200 <= P50 and abs(drops - want) <= 2,
          f"refresh {st['refresh-ns']} ns ({st['refresh-source']}), {drops} drops after frame "
          f"{at}, want {want:.1f}")
    return rig, frames, at


def case_kms():
    if not HAVE_SINKS:
        skip("kms", f"{TESTVIDEO} not built (make native-test)")
        return
    rig, frames, at = kms_60p("refresh-mhz=50000", 10, "with refresh-mhz=50000")
    late = lateness(rig, frames[min(at + 60, len(frames) - 1)])
    check("kms: release lateness flat within a frame and a refresh after the measurement",
          late and spread(late) <= P60 + P50 + 2 * MS, f"spread {spread(late) / 1e6:.1f} ms")
    # Every 25th return 5 ms late, as a busy host wakes: the reference's own base, the smallest
    # interval, would read the 15 ms after it (B-162).
    kms_60p("", 6, "without refresh-mhz, every 25th return 5 ms late (the returns' "
            "25th-percentile interval the base)", " late-every=25 late-us=5000")
    for prior in (50000, 0):
        rig = Rig(sink=KMS, props=f"refresh-mhz={prior}", caps=CAPS25).start()
        t0 = rig.now() + 50 * MS
        rig.play([tuple(p) for p in live(100, 25, 1, t0 - LATENCY)]).join(8)
        st = rig.stats()
        rig.stop()
        # Without the mode a 2-refresh interval can read as one refresh (B-161 D6).
        wants = (P50,) if prior else (P50, 2 * P50)
        check(f"kms: 25p on 50 Hz with refresh-mhz={prior}: the returns read "
              f"{' or '.join(f'{w / 1e6:.0f} ms' for w in wants)} (within 1 %), no drop",
              st["refresh-source"] == "measured" and st["rate-drops"] == 0
              and any(abs(st["refresh-ns"] - w) * 100 <= w for w in wants),
              f"{st['refresh-ns']} ns {st['refresh-source']}")
    rig = Rig(sink="mrtestkmssink name=out period-ns=20000000 skip-vsync=true async=false",
              caps=CAPS60).start()
    t0 = rig.now() + 50 * MS
    rig.play([tuple(p) for p in live(120, 60, 1, t0 - LATENCY)]).join(5)
    st = rig.stats()
    rig.stop()
    check("kms: skip-vsync=true: no returns timed, no decimation", st["refresh-source"] == "none"
          and st["rate-drops"] == 0, f"{st['refresh-source']}, {st['rate-drops']} drops")


def case_outage():
    if not HAVE_SINKS:
        skip("outage", f"{TESTVIDEO} not built (make native-test)")
        return
    rig = Rig(sink="mrtestvideosink name=out period-ns=20000000 async=false",
              props="refresh-mhz=50000").start()
    t0 = rig.now() + 50 * MS
    feeder = rig.play([tuple(p) for p in live(600, 50, 1, t0 - LATENCY)])
    before = poll(rig, 4.0)
    rig.out.set_property("stall-ms", 3000)
    during = poll(rig, 3.0)
    after = poll(rig, 5.0)
    feeder.join(5)
    st, disp = rig.stats(), sdict(rig.out.get_property("display-stats"))
    rig.stop()

    def shown(samples):
        return [s[2]["last-presented-ns"] - s[2]["last-running-time"] for s in samples
                if s[2]["presented"] > 0]

    pre, post = shown(before[10:]), shown(after[-20:])
    check("outage: the display's lateness after an output off 3 s is what it was before (resume "
          "live, Q2)", pre and post and abs(max(post) - max(pre)) <= P50 + 2 * MS,
          f"before {min(pre) / 1e6:.1f}-{max(pre) / 1e6:.1f} ms, after "
          f"{min(post) / 1e6:.1f}-{max(post) / 1e6:.1f} ms" if pre and post else "")
    check("outage: the sink timed out once and counted frames not presented; mrvideopace passed "
          "them unpaced, display-presenting false meanwhile, true after",
          disp["present-timeouts"] == 1 and disp["not-presented"] > 50 and st["unpaced"] > 50
          and any(not s[1]["display-presenting"] for s in during) and st["display-presenting"],
          f"timeouts {disp['present-timeouts']}, not-presented {disp['not-presented']}, unpaced "
          f"{st['unpaced']}")


# --------------------------------------------------------------------------- the rate achieved
def measured_at(samples):
    """The first sample with the achieved period measured, or None."""
    return next((s for s in samples if s[1]["achieved-ns"] > 0), None)


def drops_since(at, last):
    """(frames, rate drops) between two stats samples."""
    return (last["released"] + last["rate-drops"] - at["released"] - at["rate-drops"],
            last["rate-drops"] - at["rate-drops"])


def shape(rig, seconds, num):
    """`seconds` of num/1 fps into `rig` (started) with its stats polled: (samples, stats, the
    sink's display-stats or None)."""
    t0 = rig.now() + 50 * MS
    feeder = rig.play([tuple(p) for p in live(seconds * num, num, 1, t0 - LATENCY)])
    samples = poll(rig, seconds + 0.3, every=0.25)
    feeder.join(5)
    time.sleep(0.1)
    st = rig.stats()
    disp = sdict(rig.out.get_property("display-stats")) if rig.out.find_property("display-stats") else None
    rig.stop()
    return samples, st, disp


def flat_after(rig, t):
    """Release lateness of the frames that left from clock - base `t` on."""
    return [w - p for p, w in rig.left if w >= t]


def case_capped():
    if not HAVE_SINKS:
        skip("capped", f"{TESTVIDEO} not built (make native-test)")
        return
    rig = Rig(sink=f"mrtestvideosink name=out period-ns={DSI} present-max-mhz={CAPPED_MHZ} async=false",
              props="refresh-mhz=60038", caps=CAPS60).start()
    samples, st, disp = shape(rig, 52, 60)
    achieved = 10 ** 12 // CAPPED_MHZ
    at = measured_at(samples)
    if at is None:
        check("capped: the achieved period measured", False, f"{st}")
        return
    frames, drops = drops_since(at[1], st)
    want = frames * (achieved - P60) / achieved
    check(f"capped: 60p into a display presenting at most 56.6 of 60.038 Hz, refresh-mhz=60038: the "
          f"achieved period measured within 0.5 % ({st['achieved-ns']} ns {(at[0] - samples[0][0]) / 1e9:.1f} s in), the "
          f"refresh kept, and the drops after it the presentation deficit ({drops} of {frames}, want "
          f"{want:.1f} +- 5 %)", abs(st["achieved-ns"] - achieved) * 200 <= achieved
          and st["refresh-source"] == "measured" and abs(st["refresh-ns"] - DSI) * 1000 <= DSI
          and abs(drops - want) <= max(3, want / 20))
    late = flat_after(rig, at[0])
    check("capped: release lateness after the measurement flat within one of the display's frames",
          late and spread(late) <= achieved + 5 * MS, f"spread {spread(late) / 1e6:.1f} ms")
    behind = st["display-behind"] - at[1]["display-behind"]
    check(f"capped: the measured rate drops them, not the skip ({behind} of {drops} after it the "
          f"display's a period behind, {st['display-behind']} in all)", behind * 3 <= max(drops, 10))
    check("capped: the display presented every frame kept, none replaced or timed out",
          disp["replaced"] == 0 and disp["present-timeouts"] == 0 and disp["not-presented"] == 0
          and disp["presented"] >= st["released"] - 2, f"{disp}")


def case_keeps_up():
    if not HAVE_SINKS:
        skip("keeps-up", f"{TESTVIDEO} not built (make native-test)")
        return
    # Past three windows' time: a display that keeps up must not read the content's own period.
    rig = Rig(sink=f"mrtestvideosink name=out period-ns={DSI} async=false", props="refresh-mhz=60038",
              caps=CAPS50).start()
    samples, st, disp = shape(rig, 36, 50)
    late = lateness(rig)
    check(f"keeps-up: 50p into a 60.038 Hz display that presents every frame, 36 s: nothing measured, "
          f"no drop, the refresh kept ({st['refresh-ns']} ns {st['refresh-source']}, achieved-ns "
          f"{st['achieved-ns']}, {st['rate-drops']} drops)", st["achieved-ns"] == 0 and st["rate-drops"] == 0
          and st["refresh-source"] == "measured" and abs(st["refresh-ns"] - DSI) * 1000 <= DSI
          and disp["presented"] >= st["released"] - 2)
    check("keeps-up: release lateness flat within a frame", late and spread(late) <= P50,
          f"spread {spread(late) / 1e6:.1f} ms")


def case_kms_wait():
    if not HAVE_SINKS:
        skip("kms-wait", f"{TESTVIDEO} not built (make native-test)")
        return
    # 60p with the mode's refresh, which the achieved period must overrule; 50p without one,
    # which the returns read as two refreshes at once.
    for num, props, seconds, caps in ((60, "refresh-mhz=60038", 45, CAPS60), (50, "", 15, CAPS50)):
        rig = Rig(sink=f"mrtestkmssink name=out period-ns={DSI} vblanks=2 async=false", props=props,
                  caps=caps).start()
        samples, st, _disp = shape(rig, seconds, num)
        if props:
            at = measured_at(samples)
            ok = at is not None and abs(st["achieved-ns"] - 2 * DSI) * 200 <= 2 * DSI
            what = f"the achieved period {st['achieved-ns']} ns"
        else:
            at = next((s for s in samples if s[0] > 2 * S and s[1]["refresh-source"] == "measured"), None)
            ok = at is not None and abs(st["refresh-ns"] - 2 * DSI) * 200 <= 2 * DSI
            what = f"the returns' {st['refresh-ns']} ns"
        if at is None:
            check(f"kms-wait {num}p: measured", False, f"{st}")
            continue
        frames, drops = drops_since(at[1], st)
        want = frames * (1 - 1e9 / (2 * DSI) / num)
        late = flat_after(rig, at[0] + 500 * MS)
        check(f"kms-wait: {num}p into mrtestkmssink vblanks=2 at 60.038 Hz ({props or 'no refresh-mhz'}): "
              f"two refreshes a frame ({what}), {drops} of {frames} dropped after it (want {want:.1f} "
              f"+- 5 %, {drops / max(frames, 1) * num:.1f} a second)",
              ok and abs(drops - want) <= max(3, want / 20))
        check(f"kms-wait: {num}p release lateness after it flat within a frame",
              late and spread(late) <= S // num + 5 * MS, f"spread {spread(late) / 1e6:.1f} ms")
        behind = st["display-behind"] - at[1]["display-behind"]
        check(f"kms-wait: {num}p: the measured rate drops them, not the skip ({behind} of {drops} after "
              f"it the display's a period behind, {st['display-behind']} in all)", behind * 3 <= max(drops, 10))


def case_properties():
    el = Gst.ElementFactory.make("mrvideopace", None)
    specs = {p.name: p for p in el.list_properties()}
    st = sdict(el.get_property("stats"))
    check("properties: refresh-mhz 0 (unknown), gap-threshold-ms 250, a read-only stats",
          el.get_property("refresh-mhz") == 0 and el.get_property("gap-threshold-ms") == 250
          and specs["refresh-mhz"].maximum == 1000000
          and not specs["stats"].flags & GObject.ParamFlags.WRITABLE)
    check("properties: stats before a start: zeros, refresh-source none, presenting",
          st["released"] == st["rate-drops"] == st["unpaced"] == 0 and st["refresh-source"] == "none"
          and st["display-presenting"] is True, f"{st}")
    tmpls = {t.name_template: t for t in el.get_pad_template_list()}
    check("properties: always pads sink and src, any caps",
          sorted(tmpls) == ["sink", "src"]
          and all(t.presence == Gst.PadPresence.ALWAYS and t.get_caps().is_any()
                  for t in tmpls.values()))


# --------------------------------------------------------------------------- the runners' clock rule
def seek_holds(runners_clock):
    """What a flushing seek does to the pace: 1 s of 50p into an async sink, then the seek's
    flush (the sink loses its state, reset time) and 30 frames from a new segment on cadence. The
    hold of each but the first (it prerolls the sink), release - arrival. A default pipeline
    re-bases its running time when the preroll takes it back to PLAYING, while mrvideopace, never
    paused by a lost state, still paces on the old base; the runners' never re-bases."""
    pipe = Gst.Pipeline.new(None)
    pipe.add(Gst.parse_bin_from_description("mrvideopace name=vp ! fakesink name=out sync=false", False))
    if runners_clock:
        house(pipe)
    vp = pipe.get_by_name("vp")
    feed = Gst.Pad.new("feed", Gst.PadDirection.SRC)
    feed.link(vp.get_static_pad("sink"))
    entered, left, segment_no = {}, {}, [0]

    def stamp(into):
        def probe(_pad, info):
            into.setdefault((segment_no[0], info.get_buffer().pts), mono())
            return Gst.PadProbeReturn.OK
        return probe

    vp.get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, stamp(entered))
    vp.get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, stamp(left))
    feed.set_active(True)
    pipe.set_state(Gst.State.PLAYING)

    def segment():
        seg = Gst.Segment()
        seg.init(Gst.Format.TIME)
        feed.push_event(Gst.Event.new_segment(seg))

    def push(pts, at):
        wait = at - mono()
        if wait > 0:
            time.sleep(wait / S)
        b = Gst.Buffer.new_wrapped(bytes(64))
        b.pts, b.duration = pts, P50
        feed.push(b)

    def run():
        feed.push_event(Gst.Event.new_stream_start("clock-rule"))
        feed.push_event(Gst.Event.new_caps(Gst.Caps.from_string(CAPS50)))
        segment()
        t0 = mono() + 50 * MS
        for k in range(50):
            push(k * P50, t0 + k * P50)
        feed.push_event(Gst.Event.new_flush_start())
        segment_no[0] = 1
        feed.push_event(Gst.Event.new_flush_stop(True))
        segment()
        t1 = mono() + 20 * MS
        for k in range(30):
            push(k * P50, t1 + k * P50)

    feeder = threading.Thread(target=run, daemon=True)
    feeder.start()
    feeder.join(15)
    deadline = mono() + 6 * S
    after = [(1, k * P50) for k in range(1, 30)]
    while len([p for p in after if p in left]) < len(after) and mono() < deadline:
        time.sleep(0.05)
    pipe.set_state(Gst.State.NULL)
    feed.set_active(False)
    return [left[p] - entered[p] if p in left else 6 * S for p in after]


def case_clock_rule():
    house_holds = seek_holds(True)
    natural = seek_holds(False)
    worst = max(house_holds) / 1e6
    check(f"clock-rule: on the runners' clock a flushing seek and the PLAYING after it hold no frame "
          f"(worst {worst:.1f} ms of {len(house_holds)})", worst <= 20.0)
    check(f"clock-rule: a default pipeline re-bases there and holds the frame after it by the 1 s "
          f"played before the seek (up to {max(natural) / 1e6:.0f} ms)", max(natural) >= 900 * MS)


# --------------------------------------------------------------------------- inside the runners
def runner_registry(tmp):
    """A private copy of the registry this process reads, for a child that adds the test library
    to its GST_PLUGIN_PATH (the user's registry is never rewritten)."""
    src = os.environ.get("GST_REGISTRY") or os.path.join(
        os.path.expanduser("~"), ".cache", "gstreamer-1.0", f"registry.{os.uname().machine}.bin")
    dst = os.path.join(tmp, "registry.bin")
    if os.path.exists(src):
        shutil.copyfile(src, dst)
    return dst


def case_runners():
    try:
        import aligner_rig as rig
    except ImportError as exc:
        skip("runners", f"the runner rig does not import ({exc})")
        return
    kinds = rig.runner_kinds()
    if not any(k == "native" for k, _ in kinds):
        skip("runners: inside mr-gst-runner", f"{rig.NATIVE_BIN} not built (make native)")
    src = ("videotestsrc is-live=true pattern=black ! video/x-raw,width=16,height=16,framerate=60/1"
           " ! mrvideopace name=vp")
    runs = [("nominal", f"{src} refresh-mhz=50000 ! fakesink sync=false", None)]
    with tempfile.TemporaryDirectory(prefix="mrvideopace_") as tmp:
        if HAVE_SINKS:
            env = {"GST_REGISTRY": runner_registry(tmp), "GST_PLUGIN_PATH": ":".join(
                [p for p in [os.environ.get("GST_PLUGIN_PATH", ""), TESTVIDEO_DIR] if p])}
            runs.append(("measured", f"{src} ! mrtestvideosink period-ns=20000000", env))
        else:
            skip("runners: measured", f"{TESTVIDEO} not built (make native-test)")
        for kind, argv in kinds:
            for name, desc, env in runs:
                r = rig.Runner(argv, env)
                try:
                    playing = r.start({"pipeline": desc, "useStdioForData": False, "linkOnPadAdded": [],
                                       "busReports": [], "decoderThreadType": "auto"}, timeout=30)
                    reads = []
                    for _ in range(8):
                        time.sleep(1.0)
                        got = r.request({"cmd": "get_property", "element": "vp", "property": "stats"},
                                        "property")
                        if got and got[1].get("event") == "property":
                            reads.append(got[1]["value"])
                    first = next((x for x in reads if x.get("refresh-source") == ("nominal" if name ==
                                  "nominal" else "measured")), None)
                    last = reads[-1] if reads else {}
                    frames = (last.get("released", 0) + last.get("rate-drops", 0)
                              - (first or {}).get("released", 0) - (first or {}).get("rate-drops", 0))
                    drops = last.get("rate-drops", 0) - (first or {}).get("rate-drops", 0)
                    check(f"runners: inside {kind}, 60p into {desc.split(' ! ')[-1].split()[0]}: "
                          f"{name} {last.get('refresh-ns')} ns, 1 in 6 dropped ({drops} of {frames}) "
                          f"over get_property", playing is not None and first is not None
                          and abs(last.get("refresh-ns", 0) - P50) * 1000 <= P50 and frames > 200
                          and abs(drops - frames / 6) <= 2,
                          f"{len(reads)} reads, {r.errors()[:1]}")
                finally:
                    r.stop()
        if not HAVE_SINKS:
            return
        # B-175's two shapes, the sink setting the pace, with the mode's refresh given: the drops
        # from the fourth second on are what the display cannot take.
        shapes = (("a display presenting at most 56.6 fps", f"{src} refresh-mhz=60038 ! mrtestvideosink "
                   f"period-ns={DSI} present-max-mhz={CAPPED_MHZ}", 1 - CAPPED_MHZ / 60000),
                  ("kmssink's two refreshes a frame", f"{src} refresh-mhz=60038 ! mrtestkmssink "
                   f"period-ns={DSI} vblanks=2", 1 - 1e9 / (2 * DSI) / 60))
        for kind, argv in kinds:
            for name, desc, share in shapes:
                r = rig.Runner(argv, env)
                try:
                    playing = r.start({"pipeline": desc, "useStdioForData": False, "linkOnPadAdded": [],
                                       "busReports": [], "decoderThreadType": "auto"}, timeout=30)
                    reads = []
                    for _ in range(14):
                        time.sleep(1.0)
                        got = r.request({"cmd": "get_property", "element": "vp", "property": "stats"},
                                        "property")
                        if got and got[1].get("event") == "property":
                            reads.append(got[1]["value"])
                    frames, drops = drops_since(reads[3], reads[-1]) if len(reads) > 8 else (0, 0)
                    want = frames * share
                    check(f"runners: inside {kind}, 60p into {name}: rate-drops the deficit ({drops} of "
                          f"{frames}, want {want:.1f} +- 10 %) over get_property", playing is not None
                          and frames > 400 and abs(drops - want) <= max(3, want / 10),
                          f"{len(reads)} reads, {r.errors()[:1]}")
                finally:
                    r.stop()


CASES = {"pacing": case_pacing, "base-time": case_base_time, "flush": case_flush,
         "ready": case_ready, "gap": case_gap, "dmabuf": case_dmabuf, "nominal": case_nominal,
         "measured": case_measured, "drift": case_drift, "kms": case_kms, "outage": case_outage,
         "capped": case_capped, "keeps-up": case_keeps_up, "kms-wait": case_kms_wait,
         "properties": case_properties, "clock-rule": case_clock_rule,
         "runners": case_runners}


if __name__ == "__main__":
    names = sys.argv[1:] or list(CASES)
    for n in names:
        CASES[n]()
    if _failures:
        print(f"\n{len(_failures)} FAILURE(S) in gst_mrvideopace_element_test.py")
        sys.exit(1)
    print("\nALL gst_mrvideopace_element_test.py TESTS PASSED")
