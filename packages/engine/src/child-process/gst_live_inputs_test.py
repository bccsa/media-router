#!/usr/bin/env python3
"""Self-checking tests for the python runner's live input branches:
`bus_input_add` / `bus_input_remove` (idempotent), the containment helpers
(`_live_branch_ancestor`, `_drop_live_branch`) and the source gate's view of
branch bins (`sources_by_factory` enters declared bins only,
`forget_sources_in` releases a leaving branch's heads).

Also the python twins of protocol cases L (live input branches), aligner-absent (plan ch. 6
part 7.3), the B-74 join chain (B-80), the fall (B-82) and the kept last pad (B-208):
`live_aligned_case`, `aligner_absent_case`, `aligner_join_chain_case`, `aligner_fall_case` and
`last_pad_case`, which native_runner_protocol_test.py runs on the native runner. B-208's
deterministic cases (the race, a kept pad's stale data, a pad never taken) run here in process;
tests/bus_inputs_kept_pad_test.cpp runs them on the native runner's code.

Skips (exit 0) where GStreamer / PyGObject is unavailable.
Run:  python3 gst_live_inputs_test.py
"""
import importlib.util
import os
import re
import sys
import threading
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_live_inputs_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(_HERE, "..", "..", "..", "..", "plugins", "mpegts-core", "py")))
sys.path.insert(0, _HERE)
_RUNNER = os.path.join(_HERE, "gst-pipeline-runner.py")
_PY_RUNNER = [sys.executable, _RUNNER]
_spec = importlib.util.spec_from_file_location("gst_pipeline_runner", _RUNNER)
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)
import gst_source_gate as source_gate  # noqa: E402

Gst.init([])
_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


CAPS = "audio/x-raw,rate=48000,channels=2"
MIXER = ("audiomixer name=mixin force-live=true latency=100000000"
         f" start-time-selection=first ! {CAPS} ! identity name=mixin_out sync=true ! fakesink sync=false"
         f"  ( name=mixin_in_a audiotestsrc is-live=true ! audioconvert ! {CAPS} ! queue ) ! mixin.sink_0")


class Capture:
    def __init__(self):
        self.events = []
        self.errors = []

    def event(self, ev):
        self.events.append(ev)

    def error(self, req_id, message):
        self.errors.append((req_id, message))

    def last(self, name):
        for ev in reversed(self.events):
            if ev.get("event") == name:
                return ev
        return None


def with_pipeline():
    cap = Capture()
    runner.emit_event = cap.event
    runner.emit_command_error = cap.error
    runner.pipeline = Gst.parse_launch(MIXER)
    runner._live_input_branches.clear()
    runner._live_input_branches.add("mixin_in_a")
    runner._kept_agg_pads.clear()
    source_gate.live_branches = runner._live_input_branches
    runner.pipeline.set_state(Gst.State.PLAYING)
    runner.pipeline.get_state(2 * Gst.SECOND)
    return cap


def teardown():
    if runner.pipeline is not None:
        runner.pipeline.set_state(Gst.State.NULL)
        runner.pipeline = None


def test_add_remove():
    cap = with_pipeline()
    try:
        branch = f"audiotestsrc is-live=true freq=880 ! audioconvert ! {CAPS} ! queue"
        runner.handle_bus_input_add({"id": "a1", "element": "mixin", "name": "mixin_in_b", "description": branch})
        done = cap.last("bus_input_add_done")
        check("add -> bus_input_add_done", done is not None and done.get("id") == "a1")
        check("added bin is in the pipeline", runner.pipeline.get_by_name("mixin_in_b") is not None)
        check("added bin is tracked", "mixin_in_b" in runner._live_input_branches)
        mixer = runner.pipeline.get_by_name("mixin")
        check("mixer gained a request pad", mixer.get_static_pad("sink_1") is not None)

        runner.handle_bus_input_add({"id": "a2", "element": "mixin", "name": "mixin_in_b", "description": branch})
        check("duplicate add is a no-op done", cap.last("bus_input_add_done").get("id") == "a2" and not cap.errors)

        runner.handle_bus_input_add({"id": "a3", "element": "nope", "name": "mixin_in_c", "description": branch})
        check("unknown aggregator -> command_error", cap.errors and cap.errors[-1][0] == "a3")

        # A start-time bin's src pad is the parser's ghost<N>, not "src": a non-live mixer
        # would wait forever on a request pad left behind beside another input.
        runner.handle_bus_input_remove({"id": "r1", "element": "mixin", "name": "mixin_in_a"})
        check("removing the start-time bin -> done",
              cap.last("bus_input_remove_done").get("id") == "r1")
        check("removed bin is gone and untracked", runner.pipeline.get_by_name("mixin_in_a") is None
              and "mixin_in_a" not in runner._live_input_branches)
        check("mixer released the start-time bin's request pad beside another input (2 -> 1)",
              mixer.get_static_pad("sink_0") is None and mixer.numsinkpads == 1
              and not runner._kept_agg_pads)

        runner.handle_bus_input_remove({"id": "r2", "element": "mixin", "name": "mixin_in_a"})
        check("removing a gone branch is a no-op done", cap.last("bus_input_remove_done").get("id") == "r2")

        # B-208: the last input's pad stays for the next add; an aggregator left with no sink
        # pad can restart its output at running time 0.
        sink1 = mixer.get_static_pad("sink_1")
        runner.handle_bus_input_remove({"id": "r3", "element": "mixin", "name": "mixin_in_b"})
        check("removing the last branch -> done, the bin gone and untracked",
              cap.last("bus_input_remove_done").get("id") == "r3"
              and runner.pipeline.get_by_name("mixin_in_b") is None
              and "mixin_in_b" not in runner._live_input_branches)
        check("the mixer keeps its last request pad, unlinked, for the next add (B-208)",
              sink1 is not None and mixer.numsinkpads == 1 and sink1.get_peer() is None
              and runner._kept_agg_pads.get("mixin") is sink1)
        runner.handle_bus_input_add({"id": "a5", "element": "mixin", "name": "mixin_in_v",
                                     "description": "capsfilter caps=video/x-raw"})
        check("an add whose branch cannot link -> command_error, its bin gone, the pad still kept",
              cap.errors and cap.errors[-1][0] == "a5" and runner.pipeline.get_by_name("mixin_in_v") is None
              and runner._kept_agg_pads.get("mixin") is sink1 and mixer.numsinkpads == 1)
        runner.handle_bus_input_add({"id": "a4", "element": "mixin", "name": "mixin_in_c", "description": branch})
        check("the next add takes the kept pad: still one sink pad, sink_1 linked, none kept",
              cap.last("bus_input_add_done").get("id") == "a4" and mixer.numsinkpads == 1
              and sink1.get_peer() is not None and not runner._kept_agg_pads)

        _ret, state, _pending = runner.pipeline.get_state(0)
        check("pipeline still PLAYING after add/remove", state == Gst.State.PLAYING)
    finally:
        teardown()


def test_containment_helpers():
    cap = with_pipeline()
    try:
        bin_ = runner.pipeline.get_by_name("mixin_in_a")
        src = None
        it = bin_.iterate_sources()
        ok, src = it.next()
        check("live branch ancestor of an element inside the bin", runner._live_branch_ancestor(src) == "mixin_in_a")
        check("no ancestor for a top-level element", runner._live_branch_ancestor(runner.pipeline.get_by_name("mixin")) is None)
        check("drop_branch takes the bin out", runner._drop_live_branch("mixin_in_a") is True)
        sink0 = runner.pipeline.get_by_name("mixin").get_static_pad("sink_0")
        check("drop_branch keeps the mixer's last request pad (the start-time bin's), unlinked (B-208)",
              sink0 is not None and sink0.get_peer() is None and runner._kept_agg_pads.get("mixin") is sink0)
        check("dropped bin gone + untracked",
              runner.pipeline.get_by_name("mixin_in_a") is None and "mixin_in_a" not in runner._live_input_branches)
        check("drop of an unknown branch is False", runner._drop_live_branch("mixin_in_a") is False)
        _ret, state, _pending = runner.pipeline.get_state(0)
        check("pipeline still PLAYING with its only branch dropped (force-live silence)", state == Gst.State.PLAYING)
        check("no error event emitted by the drop", cap.last("error") is None)
    finally:
        teardown()


def test_gate_sees_declared_bins_only():
    pipe = Gst.parse_launch(
        "fakesink name=s1  ( name=live_in unixfdsrc socket-path=/tmp/mr-live-test-a.sock ! queue ! fakesink ) "
        " ( name=other_bin unixfdsrc socket-path=/tmp/mr-live-test-b.sock ! queue ! fakesink )"
    )
    source_gate.live_branches = {"live_in"}
    heads = source_gate.sources_by_factory(pipe, "unixfdsrc")
    names = sorted(h.get_property("socket-path") for h in heads)
    check("sources_by_factory enters the declared live bin only", names == ["/tmp/mr-live-test-a.sock"])

    # forget_sources_in releases a leaving branch's heads from the data wait.
    live_bin = pipe.get_by_name("live_in")
    head = heads[0]
    dw = {"pending": {id(head)}, "fired": False, "sockets": ["/tmp/mr-live-test-a.sock"],
          "identity": {"/tmp/mr-live-test-a.sock": None}, "probes": [], "warn_id": None, "poll_id": None,
          "warned": False, "timeout_ms": 10000}
    source_gate.data_wait = dw
    source_gate.forget_sources_in(live_bin)
    check("forget_sources_in clears the head from pending", not dw["pending"])
    check("forget_sources_in drops its socket from the poll", dw["sockets"] == [] and dw["identity"] == {})
    check("forget_sources_in fires data_arrived when the last head leaves", dw["fired"] is True)
    source_gate.data_wait = None
    source_gate.live_branches = set()


_PCM = Gst.Caps.from_string("audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved")
_BLOCK = 10 * Gst.MSECOND
_SAMPLE = Gst.SECOND // 48000 + 1


class _KeptPadMixer:
    """B-208 in process: the runner's own live-input code on an Audio Mixer's aggregator (latency
    0, start-time-selection first, non-live) on the house clock, base_time 0. Its branches are
    identity bins fed from pads of the test's own; its outputs kept as (wall, pts, duration).
    `hold` ('caps' or 'buffer'): its src thread waits at its first such push until `release()`."""

    def __init__(self, hold=None):
        self.cap = Capture()
        runner.emit_event = self.cap.event
        runner.emit_command_error = self.cap.error
        self.clock = Gst.SystemClock.obtain()
        self.clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
        pipe = Gst.parse_launch("audiomixer name=mixin latency=0 start-time-selection=first"
                                f" ! capsfilter caps={CAPS} ! fakesink sync=false async=false"
                                "  ( name=mixin_in_a identity name=a_id ) ! mixin.sink_0")
        pipe.use_clock(self.clock)
        pipe.set_start_time(Gst.CLOCK_TIME_NONE)
        pipe.set_base_time(0)
        runner.pipeline = pipe
        runner._live_input_branches.clear()
        runner._live_input_branches.add("mixin_in_a")
        runner._kept_agg_pads.clear()
        source_gate.live_branches = runner._live_input_branches
        self.mixin = pipe.get_by_name("mixin")
        self.outs = []
        self.hold = hold
        self.held, self._go = threading.Event(), threading.Event()
        self.mixin.get_static_pad("src").add_probe(
            Gst.PadProbeType.BUFFER | Gst.PadProbeType.EVENT_DOWNSTREAM, self._on_src)
        pipe.set_state(Gst.State.PLAYING)
        pipe.get_state(2 * Gst.SECOND)

    def now(self):
        return self.clock.get_time()

    def grid(self):
        return self.now() // _BLOCK * _BLOCK

    def _on_src(self, _pad, info):
        is_buf = bool(info.type & Gst.PadProbeType.BUFFER)
        if is_buf and len(self.outs) < 5000:    # a runaway makes thousands a second
            b = info.get_buffer()
            self.outs.append((self.now(), b.pts, b.duration))
        kind = "buffer" if is_buf else ("caps" if info.get_event().type == Gst.EventType.CAPS else None)
        if kind is not None and kind == self.hold:
            self.hold = None
            self.held.set()
            self._go.wait(5)
        return Gst.PadProbeReturn.OK

    def release(self):
        self._go.set()

    def head(self, element, tag):
        """A pad of the test's own on `element`'s sink pad, its stream started."""
        src = Gst.Pad.new(f"feed_{tag}", Gst.PadDirection.SRC)
        src.set_active(True)
        assert src.link(runner.pipeline.get_by_name(element).get_static_pad("sink")) == Gst.PadLinkReturn.OK
        seg = Gst.Segment()
        seg.init(Gst.Format.TIME)
        for ev in (Gst.Event.new_stream_start(tag), Gst.Event.new_caps(_PCM), Gst.Event.new_segment(seg)):
            src.push_event(ev)
        return src

    @staticmethod
    def block(pts, duration=_BLOCK):
        b = Gst.Buffer.new_wrapped(bytes(duration * 48000 // Gst.SECOND * 4))
        b.pts, b.duration = pts, duration
        return b

    def add(self, name):
        """bus_input_add of an identity branch `<name>_id` on the running mixer; its done event."""
        runner.handle_bus_input_add({"id": name, "element": "mixin", "name": f"mixin_in_{name}",
                                     "description": f"identity name={name}_id"})
        done = self.cap.last("bus_input_add_done")
        return done if done is not None and done.get("id") == name else None

    def feed(self, src, seconds=0.6):
        """10 ms blocks at house time on `src` in real time, from a thread (a mixer that runs away
        never takes one: the push blocks); that window's outputs: count, worst |PTS - house| in s
        and rate x real time."""
        stop = threading.Event()

        def run():
            t = self.grid()
            while not stop.is_set():
                while self.now() < t and not stop.is_set():
                    time.sleep(0.001)
                if stop.is_set() or src.push(self.block(t)) != Gst.FlowReturn.OK:
                    break
                t += _BLOCK
        t0 = self.now()
        threading.Thread(target=run, daemon=True).start()
        time.sleep(seconds)
        t1 = self.now()
        stop.set()
        outs = [o for o in list(self.outs) if t0 <= o[0] < t1]
        played = sum(d for _w, _p, d in outs if 0 < d < Gst.SECOND)
        worst = max((abs(p - w) for w, p, _d in outs), default=None)
        return {"n": len(outs), "worst_s": None if worst is None else round(worst / 1e9, 3),
                "rate": round(played / (t1 - t0), 2)}

    def breaks(self):
        """[(output index, ns)] where an output does not start where the one before it ended."""
        o = list(self.outs)
        return [(i + 1, b[1] - (a[1] + a[2])) for i, (a, b) in enumerate(zip(o, o[1:]))
                if abs(b[1] - (a[1] + a[2])) > _SAMPLE]

    def close(self):
        self._go.set()
        teardown()


def _on_house_time(r):
    return r["n"] > 0 and r["worst_s"] is not None and r["worst_s"] < 1.0 and r["rate"] <= 1.5


def test_kept_pad_race():
    """B-208, deterministic: the race MR-046 met. The mixer's first buffer, at house time, on its
    only pad; its src thread held in its first negotiation while the branch is dropped as a lost
    live input; then a branch added on the running mixer brings data at house time. The drop keeps
    the pad, the add takes it, the mix stays on house time. A release there (the old drop) restarts
    the mix at running time 0 (gst_audioaggregator_last_pad_test.py's R)."""
    m = _KeptPadMixer(hold="caps")
    try:
        a = m.head("a_id", "a")
        threading.Thread(target=a.push, args=(m.block(m.grid()),), daemon=True).start()
        check("kept-pad race: the mixer took its first buffer, its first negotiation held", m.held.wait(5))
        sink0 = m.mixin.get_static_pad("sink_0")
        check("kept-pad race: the branch dropped as a lost input", runner._drop_live_branch("mixin_in_a"))
        check("kept-pad race: its pad kept, unlinked, the mixer's only sink pad",
              runner._kept_agg_pads.get("mixin") is sink0 and sink0.get_peer() is None
              and m.mixin.numsinkpads == 1)
        m.release()
        time.sleep(0.05)
        done = m.add("b")
        check("kept-pad race: the next add takes the kept pad (sink_0 linked, one sink pad, none kept)",
              done is not None and sink0.get_peer() is not None and m.mixin.numsinkpads == 1
              and not runner._kept_agg_pads)
        r = m.feed(m.head("b_id", "b"))
        check(f"kept-pad race: the mix stays on house time, within 1 s at 1.5x real time or less ({r})",
              _on_house_time(r))
    finally:
        m.close()


def test_kept_pad_stale_data():
    """B-208 (d): the kept pad still holds what the old branch sent last, 5 ms of a 15 ms buffer
    being mixed and a 20 ms GAP behind it, when the next branch takes it 100 ms later: the mix goes
    on from where it was, each output starting where the one before it ended, on house time."""
    m = _KeptPadMixer(hold="buffer")
    try:
        a = m.head("a_id", "a")
        x = m.grid()
        threading.Thread(target=a.push, args=(m.block(x, 15 * Gst.MSECOND),), daemon=True).start()
        check("kept-pad stale data: the mixer held in its first 10 ms output of a 15 ms buffer",
              m.held.wait(5))
        a.push_event(Gst.Event.new_gap(x + 15 * Gst.MSECOND, 20 * Gst.MSECOND))
        runner._drop_live_branch("mixin_in_a")
        sink0 = m.mixin.get_static_pad("sink_0")
        check("kept-pad stale data: the pad kept with the partial buffer and the GAP on it",
              runner._kept_agg_pads.get("mixin") is sink0 and m.mixin.numsinkpads == 1)
        m.release()
        time.sleep(0.1)
        t_add = m.now()
        held_to = max((p + d for _w, p, d in m.outs), default=x) - x
        done = m.add("b")
        r = m.feed(m.head("b_id", "b"))
        after = next(((p - x) for w, p, _d in m.outs if w >= t_add), None)
        # The mixer sends whole 10 ms blocks: what the pad kept is out up to the last full one.
        check(f"kept-pad stale data: what the kept pad held was mixed before the add, from the first"
              f" buffer on ({held_to / 1e6} ms of the old 35 ms)",
              m.outs and m.outs[0][1] == x and 20 * Gst.MSECOND <= held_to <= 35 * Gst.MSECOND)
        check(f"kept-pad stale data: the add takes the kept pad and the mix goes on where it was, each"
              f" output where the one before it ended (first after the add at {after and after / 1e6}"
              f" ms; breaks {m.breaks()[:3]})",
              done is not None and after == held_to and not m.breaks())
        check(f"kept-pad stale data: on house time, within 1 s at 1.5x real time or less ({r})",
              _on_house_time(r))
    finally:
        m.close()


def test_kept_pad_never_taken():
    """B-208 (c): a branch never added back. The mixer waits on its kept pad: nothing mixed past
    what it had, no error, still PLAYING; the stop frees the pad."""
    m = _KeptPadMixer()
    try:
        a = m.head("a_id", "a")
        stop = threading.Event()

        def run():
            t = m.grid()
            while not stop.is_set() and a.push(m.block(t)) == Gst.FlowReturn.OK:
                t += _BLOCK
                while m.now() < t and not stop.is_set():
                    time.sleep(0.001)
        th = threading.Thread(target=run, daemon=True)
        th.start()
        time.sleep(0.3)
        stop.set()
        th.join(2)
        runner._drop_live_branch("mixin_in_a")
        n = len(m.outs)
        time.sleep(0.4)
        _ret, state, _pending = runner.pipeline.get_state(0)
        check(f"kept-pad never taken: the mixer waits on its kept pad, nothing mixed after the drop "
              f"({len(m.outs) - n} outputs), no error, still PLAYING",
              len(m.outs) - n <= 1 and m.cap.last("error") is None and state == Gst.State.PLAYING
              and m.mixin.numsinkpads == 1 and "mixin" in runner._kept_agg_pads)
        runner._drain_on_stop = False
        try:
            runner.handle_stop()
        finally:
            runner._drain_on_stop = True
        check("kept-pad never taken: the stop frees the kept pad and stops the pipeline",
              not runner._kept_agg_pads and m.cap.last("state_change") is not None
              and m.cap.last("state_change").get("state") == "null")
    finally:
        m.close()


def _rig():
    """aligner_rig, or None (numpy or the native plugins missing: the case skips)."""
    try:
        import aligner_rig
    except ImportError as exc:
        print(f"SKIP — aligner rig unavailable ({exc})")
        return None
    so = os.path.join(aligner_rig.PLUGINS, "mpegts-core", "native", "mrtshouse", "libgstmrtshouse.so")
    if not os.path.exists(so):
        print(f"SKIP — {so} not built (make native)")
        return None
    lack = [e for e in ("avenc_s302m", "avdec_s302m", "mpegtsmux", "audiomixer", "unixfdsrc")
            if Gst.ElementFactory.find(e) is None]
    if lack:
        print(f"SKIP — {', '.join(lack)} unavailable")
        return None
    return aligner_rig


def _mix_of(rig, records, t0):
    pes = rig.pes_of(records)
    pid = max(pes, key=lambda k: len(pes[k])) if pes else None
    return rig.Pcm(pes.get(pid, []), t0)


def _missing(rig, pcm, content, lo_ns, hi_ns, lag=0):
    """20 ms blocks of [lo_ns, hi_ns) where `content` is out of the mix (gain under 0.5)."""
    return [(b, g) for b, g, _e in pcm.presence(content, rig.sample_of(lo_ns), rig.sample_of(hi_ns), lag=lag)
            if g is None or g < 0.5]


def live_aligned_case(argv, tag, check):
    """Plan ch. 6 part 7.3 case L through `argv`'s runner: audio-mixer's own start (two start-time
    bins into the aligned mixer, fixtures/aligner/pipelines.json) takes a third 302M source live with
    the module's branch (mrtsdemux, then mralignwatch) and lets it go. The joiner is mixed at its
    PES - 1 h from the first table its demux receives, with no runner retime; the kept sources never
    break."""
    rig = _rig()
    if rig is None:
        return
    entry = rig.pipelines()["mixer2"]
    d = rig.SocketDir()
    cmd = rig.on_socket_dir(entry, d.path)
    seconds, add_at, rm_at = 12.0, 4.5, 8.5
    c = {n: rig.Content(seed) for n, seed in (("in0", 61), ("in1", 62), ("in2", 63))}
    prods = {n: rig.Producer(n, [d.sock(n)], content=c[n], stop_s=seconds,
                             start_s=add_at - 0.3 if n == "in2" else 0.0) for n in c}
    r = None
    got = {}
    try:
        t0 = rig.prepare(prods.values())
        for p in prods.values():
            p.listen()
        rig.until(t0 - 700 * rig.MS)        # start the module just before its producers' data
        r = rig.Runner(argv, env=cmd.get("env"))
        check(f"L {tag}: the aligned mixer with two start-time bins reaches PLAYING",
              r.start(cmd["start"]) is not None)
        r.attach("busout_41011", d.sock("out"))
        cons = rig.Consumer(d.sock("out"))
        cons.start()
        rig.go(prods.values())

        def at(t_s):
            while rig.now_ns() < t0 + int(t_s * 1e9):
                time.sleep(0.005)
        at(add_at)
        got["add"] = r.request(dict(cmd["add"], cmd="bus_input_add"), "bus_input_add_done")
        got["add_t"] = rig.now_ns()
        got["dup"] = r.request(dict(cmd["add"], cmd="bus_input_add"), "bus_input_add_done")
        got["nope"] = r.request(dict(cmd["add"], cmd="bus_input_add", element="nope", name="mixin_in_x"),
                                "bus_input_add_done")
        at(add_at + 1.5)
        # Containment: a branch whose producer is gone is dropped and reported, never an error.
        r.request({"cmd": "bus_input_add", "element": "mixin", "name": "mixin_in_dead",
                   "description": f"unixfdsrc socket-path={d.sock('dead')} ! queue"}, "bus_input_add_done")
        got["lost"] = r.wait(lambda e: e.get("event") == "input_branch_lost" and e.get("name") == "mixin_in_dead",
                             timeout=5)
        at(rm_at)
        got["rm"] = r.request(dict(cmd["remove"], cmd="bus_input_remove"), "bus_input_remove_done")
        got["rm_t"] = rig.now_ns()
        got["rm2"] = r.request(dict(cmd["remove"], cmd="bus_input_remove"), "bus_input_remove_done")
        for p in prods.values():
            p.join(30)
        time.sleep(0.5)
        errors = r.errors()
        t_stop = time.monotonic()
        rc = r.stop()
        took = time.monotonic() - t_stop
        cons.stop()
    finally:
        for p in prods.values():
            p.stop()
        if r is not None:
            r.kill()
        d.close()

    def done(k, ev="bus_input_add_done"):
        return (got.get(k) or (0, {}))[1].get("event") == ev
    check(f"L {tag}: bus_input_add of the module's own branch -> bus_input_add_done", done("add"))
    check(f"L {tag}: a duplicate add is a no-op done, an unknown aggregator a command_error",
          done("dup") and done("nope", "command_error"))
    check(f"L {tag}: a branch whose producer is gone is input_branch_lost, not a pipeline error",
          got.get("lost") is not None and not errors)
    check(f"L {tag}: bus_input_remove -> done, again a no-op done",
          done("rm", "bus_input_remove_done") and done("rm2", "bus_input_remove_done"))
    pcm = _mix_of(rig, cons.records, t0)
    lo_ns, hi_ns = t0 + 500 * rig.MS, t0 + int((seconds - 0.5) * 1e9)
    lo, hi = rig.sample_of(lo_ns), rig.sample_of(hi_ns)
    check(f"L {tag}: the mix is continuous across the add and the remove (holes {pcm.holes(lo, hi)[:3]})",
          pcm.hi > hi and not pcm.holes(lo, hi))
    for n in ("in0", "in1"):
        lag, _g = pcm.best_lag(c[n], lo, hi)
        miss = _missing(rig, pcm, c[n], lo_ns, hi_ns)
        check(f"L {tag}: kept source {n} in every block, at its content time (lag {lag}, missing {miss[:3]})",
              lag == 0 and not miss)
    # The branch's demux takes its stream at the first PMT it receives (select mode). The producer's
    # mux repeats its tables every 100 ms and its unixfdsink takes the branch on its own thread, so
    # the joiner starts within a table interval of the add, then is mixed in every block.
    add_t, rm_ns = got.get("add_t", lo_ns), got.get("rm_t", hi_ns)
    on = [b for b, g, _e in pcm.presence(c["in2"], rig.sample_of(add_t), rig.sample_of(rm_ns - 50 * rig.MS))
          if g is not None and g >= 0.5]
    on_ns = rig.house_of(on[0]) if on else None
    lag, _g = pcm.best_lag(c["in2"], rig.sample_of(on_ns or lo_ns), rig.sample_of(rm_ns - 50 * rig.MS))
    miss = _missing(rig, pcm, c["in2"], on_ns or lo_ns, rm_ns - 50 * rig.MS)
    after = [g for _b, g, _e in pcm.presence(c["in2"], rig.sample_of(rm_ns + 100 * rig.MS), hi)
             if g is not None and g > 0.25]
    check(f"L {tag}: the joiner is mixed at its PES - 1 h from its first table on, within 150 ms of the add "
          f"({on_ns and round((on_ns - add_t) / 1e6)} ms; lag {lag}, missing {miss[:3]}), and gone after the "
          f"remove ({len(after)} blocks)", on_ns is not None and on_ns - add_t <= 150 * rig.MS and lag == 0
          and not miss and not after)
    reps = rig.aligner_reports(r, rig.aligner_of(cmd["add"]["description"]))
    stale = max((p.get("stale-buffers") or 0 for _t, p in reps), default=None)
    # Its gaps lead now - pace by a buffer, as data does; its first buffer comes through a branch
    # that is still starting, so it may land behind them.
    check(f"L {tag}: the joiner was on time, so at most its first buffer was stale ({stale})",
          stale is not None and stale <= 1)
    check(f"L {tag}: no runner retime: the branch's demux is the formula demux (no branchAlign line)",
          not any("branchAlign" in line or "retime:" in line for line in r.logs))
    check(f"L {tag}: exits 0 promptly after stop (eosDrain false from the module; {took:.1f} s)",
          rc == 0 and took < 3.0)

    # Control: the same add with its PES 5 ms off the content they carry is not on content time,
    # so the check above can fail.
    d = rig.SocketDir()
    cmd = rig.on_socket_dir(entry, d.path)
    prods = {n: rig.Producer(n, [d.sock(n)], content=c[n], stop_s=6.0, start_s=1.7 if n == "in2" else 0.0,
                             mistime_ns=5 * rig.MS if n == "in2" else 0) for n in c}
    r = None
    try:
        t0 = rig.prepare(prods.values())
        for p in prods.values():
            p.listen()
        rig.until(t0 - 700 * rig.MS)        # start the module just before its producers' data
        r = rig.Runner(argv, env=cmd.get("env"))
        r.start(cmd["start"])
        r.attach("busout_41011", d.sock("out"))
        cons = rig.Consumer(d.sock("out"))
        cons.start()
        rig.go(prods.values())
        while rig.now_ns() < t0 + 2 * 10**9:
            time.sleep(0.005)
        r.request(dict(cmd["add"], cmd="bus_input_add"), "bus_input_add_done")
        for p in prods.values():
            p.join(30)
        time.sleep(0.3)
        r.stop()
        cons.stop()
    finally:
        for p in prods.values():
            p.stop()
        if r is not None:
            r.kill()
        d.close()
    pcm = _mix_of(rig, cons.records, t0)
    lag, _g = pcm.best_lag(c["in2"], rig.sample_of(t0 + 2500 * rig.MS), rig.sample_of(t0 + 5500 * rig.MS))
    check(f"L {tag} control: a joiner whose PES are 5 ms off its content lands {lag} samples off, so the "
          f"content-time check can fail", lag == 240)

    # The runner's own mechanics: a branch whose src pad comes late (a tsdemux sometimes pad) is
    # ghosted and linked as well; a plain force-live mixer, no module's shape.
    caps = "audio/x-raw,rate=48000,channels=2"
    mixer = ("audiomixer name=mixin force-live=true latency=100000000 start-time-selection=first"
             f' ! capsfilter caps="{caps}" ! level name=lvl post-messages=true interval=100000000'
             " ! fakesink sync=false")
    branch = ("audiotestsrc is-live=true ! audioconvert ! audio/x-raw,format=S16LE,rate=48000,channels=2"
              " ! avenc_s302m strict=experimental ! mpegtsmux ! tsdemux name=mixin_demux_c latency=0"
              f" ! audio/x-smpte-302m ! avdec_s302m ! audioconvert ! audioresample ! {caps} ! queue")
    r = rig.Runner(argv)
    try:
        r.start({"pipeline": f"{mixer}  ( name=mixin_in_a audiotestsrc is-live=true ! audioconvert"
                             f" ! {caps} ! queue ) ! mixin.sink_0", "eosDrain": False})
        added = r.request({"cmd": "bus_input_add", "element": "mixin", "name": "mixin_in_c",
                           "description": branch}, "bus_input_add_done")
        t_vu = rig.now_ns()                 # VU is sent on change or once a second
        deadline = time.monotonic() + 3.0
        vu = []
        while not vu and time.monotonic() < deadline:
            time.sleep(0.1)
            vu = [t for t, ev in r.snapshot() if ev.get("event") == "vu_data" and t > t_vu]
        gone = r.request({"cmd": "bus_input_remove", "element": "mixin", "name": "mixin_in_c"},
                         "bus_input_remove_done")
        check(f"L {tag}: a branch whose src pad comes late (tsdemux) is added and removed live, the "
              f"mix flowing (a VU report {vu and round((vu[0] - t_vu) / 1e9, 2)} s after), no error",
              (added or (0, {}))[1].get("event") == "bus_input_add_done"
              and (gone or (0, {}))[1].get("event") == "bus_input_remove_done"
              and vu and not r.errors())
        r.stop()
    finally:
        r.kill()


def aligner_absent_case(argv, tag, check):
    """Plan ch. 6 part 7.3 case aligner-absent through `argv`'s runner: one of audio-mixer's three
    inputs stops for 2 s (its link stalls, the backlog comes at the end). The mix goes on, the
    input's mralignwatch reports absent then present and its stale backlog, its edges fade (B-83),
    and nothing errs."""
    rig = _rig()
    if rig is None:
        return
    d = rig.SocketDir()
    cmd = rig.on_socket_dir(rig.pipelines()["mixer3"], d.path)
    seconds, frm, length = 10.0, 4.0, 2.0
    c = {n: rig.Content(seed) for n, seed in (("in0", 71), ("in1", 72), ("in2", 73))}
    prods = {n: rig.Producer(n, [d.sock(n)], content=c[n], stop_s=seconds,
                             knobs=rig.Knobs(silence=[(frm, length, "hold")] if n == "in2" else None))
             for n in c}
    r = None
    try:
        t0 = rig.prepare(prods.values())
        for p in prods.values():
            p.listen()
        rig.until(t0 - 700 * rig.MS)        # start the module just before its producers' data
        r = rig.Runner(argv, env=cmd.get("env"))
        check(f"aligner-absent {tag}: the mixer reaches PLAYING", r.start(cmd["start"]) is not None)
        r.attach("busout_41010", d.sock("out"))
        cons = rig.Consumer(d.sock("out"))
        cons.start()
        rig.go(prods.values())
        for p in prods.values():
            p.join(30)
        time.sleep(0.5)
        errors = r.errors()
        rc = r.stop()
        cons.stop()
    finally:
        for p in prods.values():
            p.stop()
        if r is not None:
            r.kill()
        d.close()
    end_ns = t0 + int((seconds - 0.5) * 1e9)
    pcm = _mix_of(rig, cons.records, t0)
    lo, hi = rig.sample_of(t0 + 500 * rig.MS), rig.sample_of(end_ns)
    miss = {n: _missing(rig, pcm, c[n], t0 + 500 * rig.MS, end_ns) for n in ("in0", "in1")}
    check(f"aligner-absent {tag}: the mix is continuous, the other two inputs in every block "
          f"(holes {pcm.holes(lo, hi)[:3]}, missing {miss})",
          pcm.hi > hi and not pcm.holes(lo, hi) and not any(miss.values()))
    name = re.search(r"mralignwatch name=(\S+) aligner=mixin input=\"conn-in2\"", cmd["start"]["pipeline"]).group(1)
    reps = rig.aligner_reports(r, name)
    seq = [p.get("state") for t, p in reps if p.get("reason") == "state" and t < end_ns]
    stale = max((p.get("stale-buffers") or 0 for t, p in reps if t < end_ns), default=0)
    check(f"aligner-absent {tag}: its mralignwatch went absent, then present ({seq}); stale {stale} > 0",
          seq[-2:] == ["absent", "present"] and stale > 0)
    # B-83: in2's part of the mix (the mix less in0's and in1's content) is its content faded out
    # where it stops and back in where it returns, to the LSB; in0 and in1 untouched throughout.
    em = rig.edge_model(pcm, [c["in0"], c["in1"]], c["in2"], lo, hi)
    at = {k: em[k] and round((em[k] - rig.sample_of(t0)) / rig.RATE, 3) for k in ("out", "back")}
    fades = max((p.get("fades") or 0 for t, p in reps if t < end_ns), default=0)
    check(f"aligner-absent {tag}: in2 fades out where its content stops and in where it is back, to the "
          f"LSB, the other two untouched (out at {at['out']} s, back at {at['back']} s, the largest "
          f"deviation {em['dev']} LSB, the mix against its inputs before {em['steady']} LSB; fades "
          f"{fades})",
          em["dev"] is not None and em["dev"] <= 1 and abs(at["out"] - frm) <= 0.05
          and frm + length - 0.05 <= at["back"] <= frm + length + 0.5 and fades >= 2)
    check(f"aligner-absent {tag}: no error, exit 0 ({[e.get('message') for e in errors][:2]}, rc {rc})",
          not errors and rc == 0)


class _ChainConsumer:
    """Another module's 302M fan-in on an output (B-74's downstream): mrtsdemux, its mralignwatch
    and an aligned mixer from the same plugin, on the house clock; the mix as (PTS, samples). Its
    appsink keeps what it gets until the run ends: no python in its streaming path."""

    def __init__(self, rig, socket):
        Gst.Plugin.load_file(os.path.join(rig.RUNNER_PLUGINS, "mpegts-core", "native", "mrtshouse",
                                          "libgstmrtshouse.so"))
        self.rig, self.bufs = rig, []
        self.pipe = rig._monotonic_pipeline(
            f"unixfdsrc socket-path={socket} ! mrtsdemux select=audio/x-smpte-302m ! avdec_s302m"
            " ! audioconvert ! audioresample ! audio/x-raw,rate=48000,channels=2"
            " ! mralignwatch name=daw aligner=dmix input=up hold-on-eos=true"
            " ! audiomixer name=dmix latency=0 start-time-selection=first ! audioconvert"
            f" ! {rig.PCM_CAPS} ! appsink name=sink sync=false max-buffers=0 drop=false")

    def start(self):
        self.pipe.set_state(Gst.State.PLAYING)

    def watch(self):
        aw = self.pipe.get_by_name("daw")
        return {k: aw.get_property(k) for k in ("absences", "stale-buffers", "state")}

    def stop(self):
        sink = self.pipe.get_by_name("sink")
        while True:
            sample = sink.emit("try-pull-sample", 0)
            if sample is None:
                break
            buf = sample.get_buffer()
            self.bufs.append((buf.pts, buf.extract_dup(0, buf.get_size())))
        self.pipe.set_state(Gst.State.NULL)

    def pcm(self):
        """The mix on the absolute sample axis, as the rig's Pcm (gaps left absent)."""
        import numpy as np
        pieces = [(self.rig.sample_of(pts), np.frombuffer(data, dtype=np.int16).reshape(-1, 2))
                  for pts, data in self.bufs if pts is not None and pts != Gst.CLOCK_TIME_NONE]
        p = self.rig.Pcm([], 0)
        if not pieces:
            return p
        p.lo = min(n for n, _ in pieces)
        p.hi = max(n + len(s) for n, s in pieces)
        p.y = np.zeros((p.hi - p.lo, 2))
        p.have = np.zeros(p.hi - p.lo, dtype=bool)
        for n0, s in pieces:
            p.y[n0 - p.lo:n0 - p.lo + len(s)] = s / 32767.0
            p.have[n0 - p.lo:n0 - p.lo + len(s)] = True
        return p


# A run whose producers fell this far behind their schedule tests the harness, not the module
# (aligner_conformance_test.py's rule): it is run again, three times at most.
HARNESS_LATE_MS = 30


def _attempts(rig, label, run, check):
    """`run()` -> (producers, results) until its producers kept their schedule; its results, or
    None after three late runs (a failed check)."""
    for _ in range(3):
        prods, res = run()
        late = max(p.late_ns for p in prods.values()) / 1e6
        if late <= HARNESS_LATE_MS:
            return res
        print(f"RETRY {label}: the harness fed {late:.0f} ms behind its schedule "
              f"(load {os.getloadavg()[0]:.1f})", flush=True)
    check(f"{label}: the harness kept its schedule in one of three runs", False)
    return None


def aligner_join_chain_case(argv, tag, check):
    """B-74's reproduction (B-80) through `argv`'s runner: audio-mixer's own start (two start-time
    sources, fixtures/aligner/pipelines.json) takes a third live at 4.5 s, 300 ms later than they
    are. The joiner stays gapped while its content is behind, its arrivals there give its lateness
    and the pace slews to it at half speed: the mix slows and never stops, so another module's
    fan-in downstream never goes absent and keeps both sources in every block; the joiner is mixed
    once it caught up."""
    rig = _rig()
    if rig is None:
        return
    seconds, add_at, late_ms = 10.0, 4.5, 300.0
    c = {n: rig.Content(seed) for n, seed in (("in0", 81), ("in1", 82), ("in2", 83))}
    cmd0 = rig.pipelines()["mixer2"]

    def run():
        d = rig.SocketDir()
        cmd = rig.on_socket_dir(cmd0, d.path)
        prods = {n: rig.Producer(n, [d.sock(n)], content=c[n], stop_s=seconds,
                                 start_s=add_at - 0.3 if n == "in2" else 0.0,
                                 knobs=rig.Knobs(delay_ms=late_ms if n == "in2" else 0.0))
                 for n in c}
        r = chain = cons = None
        got = {"cmd": cmd}
        try:
            got["t0"] = t0 = rig.prepare(prods.values())
            for p in prods.values():
                p.listen()
            rig.until(t0 - 700 * rig.MS)        # start the module just before its producers' data
            r = got["r"] = rig.Runner(argv, env=cmd.get("env"))
            got["playing"] = r.start(cmd["start"]) is not None
            r.attach("busout_41011", d.sock("out"))
            r.attach("busout_41011", d.sock("chain"))
            cons = got["cons"] = rig.Consumer(d.sock("out"))
            cons.start()
            chain = got["chain"] = _ChainConsumer(rig, d.sock("chain"))
            chain.start()
            rig.go(prods.values())
            rig.until(t0 + int(add_at * 1e9))
            got["add"] = r.request(dict(cmd["add"], cmd="bus_input_add"), "bus_input_add_done")
            for p in prods.values():
                p.join(30)
            time.sleep(0.5)
            got["errors"] = r.errors()
            got["down"] = chain.watch()
            got["rc"] = r.stop()
        finally:
            for p in prods.values():
                p.stop()
            if r is not None:
                r.kill()
            for x in (cons, chain):
                if x is not None:
                    x.stop()
            d.close()
        return prods, got
    got = _attempts(rig, f"join-chain {tag}", run, check)
    if got is None:
        return
    r, cons, chain, cmd, t0 = got["r"], got["cons"], got["chain"], got["cmd"], got["t0"]
    check(f"join-chain {tag}: audio-mixer with two start-time sources reaches PLAYING, the 300 ms "
          f"later source added live (bus_input_add_done)",
          got["playing"] and (got.get("add") or (0, {}))[1].get("event") == "bus_input_add_done")
    add_ns, end_ns = t0 + int(add_at * 1e9), t0 + int((seconds - 0.5) * 1e9)
    gaps = rig.arrival_gaps_ms(cons.records, add_ns - 10**9, add_ns + 3 * 10**9)
    worst = max((g for _a, g in gaps), default=None)
    # The slew halves the mix's rhythm (20 ms); a step stopped it for 290 ms (B-74).
    check(f"join-chain {tag}: the mix never stops over the add, it slows (largest arrival gap "
          f"{worst and round(worst, 1)} ms, under 60)", worst is not None and worst <= 60)
    pcm = chain.pcm()
    lo, hi, at = rig.sample_of(add_ns - 10**9), rig.sample_of(end_ns), rig.sample_of(add_ns)
    miss = {n: [round((b - at) / rig.RATE, 3) for b, _g in _missing(rig, pcm, c[n], add_ns - 10**9,
                                                                     end_ns)]
            for n in ("in0", "in1")}
    check(f"join-chain {tag}: downstream, both kept sources in every 20 ms block from 1 s before "
          f"the add to the end (holes {pcm.holes(lo, hi)[:3]}, blocks missing, s after the add: "
          f"{[(n, v[:3]) for n, v in miss.items() if v]})",
          pcm.hi > hi and not pcm.holes(lo, hi) and not any(miss.values()))
    by = add_ns + int((0.3 + 0.5 + 0.6 + 0.3) * 1e9)
    joined = _missing(rig, pcm, c["in2"], by, end_ns)
    check(f"join-chain {tag}: the joiner in the mix downstream from content add + 1.7 s at the "
          f"latest (missing {joined[:3]})", not joined)
    # The two start-time sources' own lateness (transport, framing, decode) is the pace before.
    starts = re.findall(r"mralignwatch name=(\S+)", cmd["start"]["pipeline"])
    was = rig.median([p.get("pace") for nm in starts for t, p in rig.aligner_reports(r, nm)
                      if add_ns - 2 * 10**9 <= t < add_ns and isinstance(p.get("pace"), int)])
    last = (rig.aligner_reports(r, rig.aligner_of(cmd["add"]["description"])) or [(0, {})])[-1][1]
    pace, target = (last.get("pace") or 0) / 1e6, (last.get("pace-target") or 0) / 1e6
    rise = pace - (was or 0) / 1e6
    check(f"join-chain {tag}: the module's pace ends the joiner's 300 ms over what it was, at its "
          f"target ({round((was or 0) / 1e6, 1)} -> {round(pace, 1)} ms, +{round(rise, 1)}; target "
          f"{round(target, 1)} ms)", was is not None and abs(rise - late_ms) <= 20
          and abs(target - pace) <= 1)
    down = got["down"]
    check(f"join-chain {tag}: downstream the fan-in never absent, nothing stale ({down})",
          down.get("absences") == 0 and down.get("stale-buffers") == 0)
    errors, rc = got["errors"], got["rc"]
    check(f"join-chain {tag}: no error, exit 0 ({[e.get('message') for e in errors][:2]}, rc {rc})",
          not errors and rc == 0)


def aligner_fall_case(argv, tag, check):
    """B-82 through `argv`'s runner: audio-mixer's three fan-in aligners (fixtures/aligner/
    pipelines.json's mixer3, with fall-after 4 s added to each) and in2 300 ms late for 5 s, then
    on time (what was due meanwhile at once). The pace holds in2's 300 ms while its window does,
    then falls by itself in one skip that one aligner reports; the mix stays continuous with every
    input in every block."""
    rig = _rig()
    if rig is None:
        return

    class Recovers(rig.Knobs):
        """`delay_ms` late until `until_s` of content, then on time: the backlog comes at once."""

        def __init__(self, until_s, delay_ms):
            super().__init__(delay_ms=delay_ms)
            self.until_ns = int(until_s * 1e9)

        def delivery(self, rel_ready_ns):
            if rel_ready_ns < self.until_ns:
                return super().delivery(rel_ready_ns)
            return max(rel_ready_ns, self.until_ns + self.delay_ns) + self.transit_ns

    seconds, swap, fall_after = 15.0, 5.0, 4.0
    c = {n: rig.Content(seed) for n, seed in (("in0", 91), ("in1", 92), ("in2", 93))}
    cmd0 = rig.pipelines()["mixer3"]

    def run():
        d = rig.SocketDir()
        cmd = rig.on_socket_dir(cmd0, d.path)
        cmd["start"]["pipeline"] = re.sub(r"(mralignwatch name=\S+)", r"\1 fall-after=4000000000",
                                          cmd["start"]["pipeline"])
        prods = {n: rig.Producer(n, [d.sock(n)], content=c[n], stop_s=seconds,
                                 knobs=Recovers(swap, 300.0) if n == "in2" else None) for n in c}
        r = cons = None
        got = {"cmd": cmd}
        try:
            got["t0"] = t0 = rig.prepare(prods.values())
            for p in prods.values():
                p.listen()
            rig.until(t0 - 700 * rig.MS)
            r = got["r"] = rig.Runner(argv, env=cmd.get("env"))
            got["playing"] = r.start(cmd["start"]) is not None
            r.attach("busout_41010", d.sock("out"))
            cons = got["cons"] = rig.Consumer(d.sock("out"))
            cons.start()
            rig.go(prods.values())
            for p in prods.values():
                p.join(40)
            time.sleep(0.5)
            got["errors"] = r.errors()
            got["rc"] = r.stop()
        finally:
            for p in prods.values():
                p.stop()
            if r is not None:
                r.kill()
            if cons is not None:
                cons.stop()
            d.close()
        return prods, got
    got = _attempts(rig, f"aligner-fall {tag}", run, check)
    if got is None:
        return
    r, cons, cmd, t0 = got["r"], got["cons"], got["cmd"], got["t0"]
    check(f"aligner-fall {tag}: the mixer with fall-after 4 s reaches PLAYING", got["playing"])
    names = re.findall(r"mralignwatch name=(\S+)", cmd["start"]["pipeline"])
    reps = [(t, p) for nm in names for t, p in rig.aligner_reports(r, nm)]
    swap_ns, end_ns = t0 + int(swap * 1e9), t0 + int((seconds - 0.5) * 1e9)
    before = [p.get("pace") for t, p in reps if t0 + 2 * 10**9 <= t < swap_ns]
    by = swap_ns + int((fall_after * 1.5 + 2) * 1e9)
    after = [p.get("pace") for t, p in reps if by <= t < end_ns]
    fell = [(t, p) for t, p in reps if p.get("reason") == "pace-fell"]
    check(f"aligner-fall {tag}: the pace holds in2's 300 ms before it recovers ({len(before)} reports, "
          f"least {min(before, default=0) / 1e6:.1f} ms)", before and min(before) >= 280 * rig.MS)
    check(f"aligner-fall {tag}: and has fallen to 30 ms or less within 1.5 x fall-after + 2 s of it "
          f"({len(after)} reports, most {max(after, default=0) / 1e6:.1f} ms)",
          after and max(after) <= 30 * rig.MS)
    check(f"aligner-fall {tag}: one pace-fell report, of about 300 ms "
          f"({[(round((t - swap_ns) / 1e9, 2), round(p.get('fell', 0) / 1e6)) for t, p in fell]})",
          len(fell) == 1 and 250 * rig.MS <= fell[0][1].get("fell", 0) <= 340 * rig.MS)
    pcm = _mix_of(rig, cons.records, t0)
    lo, hi = rig.sample_of(t0 + 500 * rig.MS), rig.sample_of(end_ns)
    miss = {n: _missing(rig, pcm, c[n], t0 + 500 * rig.MS, end_ns) for n in c}
    check(f"aligner-fall {tag}: the mix continuous across the fall, every input in every block "
          f"(holes {pcm.holes(lo, hi)[:3]}, missing {[(n, v[:2]) for n, v in miss.items() if v]})",
          pcm.hi > hi and not pcm.holes(lo, hi) and not any(miss.values()))
    errors, rc = got["errors"], got["rc"]
    check(f"aligner-fall {tag}: no error, exit 0 ({[e.get('message') for e in errors][:2]}, rc {rc})",
          not errors and rc == 0)

_FIXTURE_BRANCH = re.compile(r" \( name=(\S+) (.*?) \) ! mixin\.(sink_\d+)")


def _fixture_branches(pipeline):
    """[(bin name, description, mixer pad)] of a fixture mixer's start-time sources."""
    return _FIXTURE_BRANCH.findall(pipeline)


def _one_source(cmd):
    """audio-mixer's start `cmd` (mixer2's) less its second source: one source, still through the
    fan-in aggregator, which the module builds for one source too."""
    (n0, _d0, _p0), (n1, d1, p1) = _fixture_branches(cmd["start"]["pipeline"])
    start = dict(cmd["start"], liveInputBranches=[n0],
                 pipeline=cmd["start"]["pipeline"].replace(f" ( name={n1} {d1} ) ! mixin.{p1}", ""))
    return dict(cmd, start=start)


def _pad_there(r, pad):
    """Whether the running mixer has `pad`: track_throughput finds it or says 'Pad not found'."""
    got = r.request({"cmd": "track_throughput", "element": "mixin", "pad": pad}, "tracking")
    return None if got is None else got[1].get("event") == "tracking"


def last_pad_case(argv, tag, check):
    """B-208 through `argv`'s runner, on audio-mixer's own start (fixtures/aligner/pipelines.json's
    mixer2): (a) with one source, its producer dies and is back 300 ms later, re-added as the engine
    does it (bus_input_remove, then bus_input_add): the mixer keeps that pad, the add takes it, and
    the egress stays on house time; (b) with two, one dies: its pad is released and its re-add gets a
    new one, as before; (c) with one that never comes back: the mixer waits, no error, stops at once."""
    rig = _rig()
    if rig is None:
        return
    cmd0 = rig.pipelines()["mixer2"]
    seconds, lose, back = 7.0, 3.0, 3.3
    c = {n: rig.Content(seed) for n, seed in (("in0", 111), ("in1", 112))}

    def run(kind):
        d = rig.SocketDir()
        cmd = rig.on_socket_dir(cmd0, d.path)
        if kind != "two":
            cmd = _one_source(cmd)
        branches = _fixture_branches(cmd["start"]["pipeline"])
        gone = "in1" if kind == "two" else "in0"
        name, desc, _pad = branches[1] if kind == "two" else branches[0]
        prods = {n: rig.Producer(n, [d.sock(n)], content=c[n], stop_s=seconds)
                 for n in (("in0", "in1") if kind == "two" else ("in0",))}
        again = None if kind == "never" else rig.Producer(gone, [d.sock(gone)], content=c[gone],
                                                          start_s=back - 0.2, stop_s=seconds)
        feeds = dict(prods, **({"again": again} if again else {}))
        r = cons = None
        got = {"name": name}
        try:
            got["t0"] = t0 = rig.prepare(feeds.values())
            for p in prods.values():
                p.listen()
            rig.until(t0 - 700 * rig.MS)        # start the module just before its producers' data
            r = got["r"] = rig.Runner(argv, env=cmd.get("env"))
            got["playing"] = r.start(cmd["start"]) is not None
            r.attach("busout_41011", d.sock("out"))
            cons = got["cons"] = rig.Consumer(d.sock("out"))
            cons.start()
            rig.go(prods.values())
            rig.until(t0 + int(lose * 1e9))
            prods[gone].stop()
            lost = r.wait(lambda e: e.get("event") == "input_branch_lost" and e.get("name") == name,
                          timeout=3)
            got["lost_t"] = lost and lost[0]
            got["after_loss"] = {p: _pad_there(r, p) for p in ("sink_0", "sink_1")}
            if again is not None:
                rig.until(t0 + int((back - 0.25) * 1e9))
                if os.path.exists(d.sock(gone)):
                    os.unlink(d.sock(gone))
                again.listen()
                again.begin()
                rig.until(t0 + int(back * 1e9))
                r.request({"cmd": "bus_input_remove", "element": "mixin", "name": name},
                          "bus_input_remove_done")
                got["add"] = r.request({"cmd": "bus_input_add", "element": "mixin", "name": name,
                                        "description": desc}, "bus_input_add_done")
                got["add_t"] = rig.now_ns()
                got["after_add"] = {p: _pad_there(r, p) for p in ("sink_0", "sink_1", "sink_2")}
            for p in feeds.values():
                p.join(30)
            rig.until(t0 + int(seconds * 1e9))
            time.sleep(0.5)
            got["errors"] = r.errors()
            t_stop = time.monotonic()
            got["rc"] = r.stop()
            got["took"] = time.monotonic() - t_stop
        finally:
            for p in feeds.values():
                p.stop()
            if r is not None:
                r.kill()
            if cons is not None:
                cons.stop()
            d.close()
        return feeds, got

    def logged(got, text):
        return any(text in line for line in got["r"].logs)

    def egress(got):
        """The mix PID's PES as (arrival, house time of its PTS): `PES - 1 h`, near its arrival."""
        pes = rig.pes_of(got["cons"].records)
        pid = max(pes, key=lambda k: len(pes[k])) if pes else None
        return [(e["arrival"], rig.unwrap(e["pts"], e["arrival"])) for e in pes.get(pid, [])
                if e["pts"] is not None]

    kept = "live input: last pad of mixin kept for the next add (sink_0)"
    # (a) one source, back 300 ms later.
    got = _attempts(rig, f"last-pad {tag} (a)", lambda: run("one"), check)
    if got is not None:
        t0, add_t = got["t0"], got.get("add_t") or 0
        check(f"last-pad {tag} (a): one source's producer dies: input_branch_lost, the mixer keeps "
              f"that pad, sink_0, as its only one ({got['after_loss']})",
              got["playing"] and got["lost_t"] is not None and logged(got, kept)
              and got["after_loss"] == {"sink_0": True, "sink_1": False})
        check(f"last-pad {tag} (a): the re-add takes the kept pad: no new pad ({got.get('after_add')})",
              (got.get("add") or (0, {}))[1].get("event") == "bus_input_add_done"
              and logged(got, f"bus_input_add: {got['name']} -> mixin on its kept pad sink_0")
              and got.get("after_add") == {"sink_0": True, "sink_1": False, "sink_2": False})
        pes = egress(got)
        off = [(h - a) / 1e6 for a, h in pes if a >= add_t]
        back_steps = [i for i, (x, y) in enumerate(zip(pes, pes[1:])) if y[1] <= x[1]]
        check(f"last-pad {tag} (a): after the re-add every egress PES within 1 s of house time "
              f"({len(off)} PES, first {off and round(off[0], 1)} ms, worst "
              f"{off and round(max(off, key=abs), 1)} ms), and no PTS ever steps back ({back_steps[:3]})",
              off and max(abs(o) for o in off) < 1000 and not back_steps)
        pcm = _mix_of(rig, got["cons"].records, t0)
        end_ns = t0 + int((seconds - 0.5) * 1e9)
        miss = _missing(rig, pcm, c["in0"], t0 + 500 * rig.MS, t0 + int((lose - 0.2) * 1e9))
        lag, _g = pcm.best_lag(c["in0"], rig.sample_of(add_t + 300 * rig.MS), rig.sample_of(end_ns))
        miss += _missing(rig, pcm, c["in0"], add_t + 300 * rig.MS, end_ns, lag=lag)
        # A source re-added to a running mixer lands a sample early, new pad or kept (not B-208's).
        check(f"last-pad {tag} (a): the source in the mix at its content time before the loss and, "
              f"within a sample, from 300 ms after the re-add (lag {lag}, missing {miss[:3]})",
              abs(lag) <= 1 and not miss)
        check(f"last-pad {tag} (a): no error, exit 0 ({[e.get('message') for e in got['errors']][:2]}, "
              f"rc {got['rc']})", not got["errors"] and got["rc"] == 0)
    # (b) two sources, one dies and is back.
    got = _attempts(rig, f"last-pad {tag} (b)", lambda: run("two"), check)
    if got is not None:
        t0, add_t = got["t0"], got.get("add_t") or 0
        check(f"last-pad {tag} (b): of two sources one dies: its pad is released, nothing kept "
              f"({got['after_loss']})",
              got["playing"] and got["lost_t"] is not None and not logged(got, "kept for the next add")
              and got["after_loss"] == {"sink_0": True, "sink_1": False})
        check(f"last-pad {tag} (b): its re-add gets a new pad, sink_2 ({got.get('after_add')})",
              (got.get("add") or (0, {}))[1].get("event") == "bus_input_add_done"
              and logged(got, f"bus_input_add: {got['name']} -> mixin")
              and not logged(got, "on its kept pad")
              and got.get("after_add") == {"sink_0": True, "sink_1": False, "sink_2": True})
        pcm = _mix_of(rig, got["cons"].records, t0)
        lo_ns, end_ns = t0 + 500 * rig.MS, t0 + int((seconds - 0.5) * 1e9)
        miss0 = _missing(rig, pcm, c["in0"], lo_ns, end_ns)
        lag, _g = pcm.best_lag(c["in1"], rig.sample_of(add_t + 300 * rig.MS), rig.sample_of(end_ns))
        miss1 = _missing(rig, pcm, c["in1"], add_t + 300 * rig.MS, end_ns, lag=lag)
        check(f"last-pad {tag} (b): the other source in every block throughout, the returned one, within "
              f"a sample, from 300 ms after its re-add (holes "
              f"{pcm.holes(rig.sample_of(lo_ns), rig.sample_of(end_ns))[:3]}, lag {lag}, missing "
              f"{miss0[:3]} / {miss1[:3]})",
              not pcm.holes(rig.sample_of(lo_ns), rig.sample_of(end_ns)) and not miss0 and abs(lag) <= 1
              and not miss1)
        check(f"last-pad {tag} (b): no error, exit 0 ({[e.get('message') for e in got['errors']][:2]}, "
              f"rc {got['rc']})", not got["errors"] and got["rc"] == 0)
    # (c) one source that never comes back.
    got = _attempts(rig, f"last-pad {tag} (c)", lambda: run("never"), check)
    if got is not None:
        late = [a for a, _h in egress(got) if got["lost_t"] and a > got["lost_t"] + 10**9]
        check(f"last-pad {tag} (c): one source's producer dies for good: the mixer keeps its pad and "
              f"waits, nothing out of it a second after the loss ({len(late)} PES)",
              got["playing"] and got["lost_t"] is not None and logged(got, kept)
              and got["after_loss"] == {"sink_0": True, "sink_1": False} and not late)
        check(f"last-pad {tag} (c): no error, exits 0 at once ({[e.get('message') for e in got['errors']][:2]},"
              f" rc {got['rc']}, {got['took']:.1f} s)",
              not got["errors"] and got["rc"] == 0 and got["took"] < 3.0)


if __name__ == "__main__":
    test_add_remove()
    test_containment_helpers()
    test_gate_sees_declared_bins_only()
    test_kept_pad_race()
    test_kept_pad_stale_data()
    test_kept_pad_never_taken()
    live_aligned_case(_PY_RUNNER, "py", check)
    aligner_absent_case(_PY_RUNNER, "py", check)
    aligner_join_chain_case(_PY_RUNNER, "py", check)
    aligner_fall_case(_PY_RUNNER, "py", check)
    last_pad_case(_PY_RUNNER, "py", check)

    if _failures:
        print(f"\n{len(_failures)} FAILED: {_failures}")
        sys.exit(1)
    print("All live input branch tests passed.")
