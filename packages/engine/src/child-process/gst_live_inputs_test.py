#!/usr/bin/env python3
"""Self-checking tests for the python runner's live input branches:
`bus_input_add` / `bus_input_remove` (idempotent), the containment helpers
(`_live_branch_ancestor`, `_drop_live_branch`) and the source gate's view of
branch bins (`sources_by_factory` enters declared bins only,
`forget_sources_in` releases a leaving branch's heads).

Also the python twins of protocol cases L (live input branches), aligner-absent (plan ch. 6
part 7.3), the B-74 join chain (B-80) and the fall (B-82): `live_aligned_case`,
`aligner_absent_case`, `aligner_join_chain_case` and `aligner_fall_case`, which
native_runner_protocol_test.py runs on the native runner.

Skips (exit 0) where GStreamer / PyGObject is unavailable.
Run:  python3 gst_live_inputs_test.py
"""
import importlib.util
import os
import re
import sys
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

        runner.handle_bus_input_remove({"id": "r1", "element": "mixin", "name": "mixin_in_b"})
        check("remove -> bus_input_remove_done", cap.last("bus_input_remove_done").get("id") == "r1")
        check("removed bin is gone", runner.pipeline.get_by_name("mixin_in_b") is None)
        check("removed bin is untracked", "mixin_in_b" not in runner._live_input_branches)
        check("mixer released the request pad", mixer.get_static_pad("sink_1") is None)

        runner.handle_bus_input_remove({"id": "r2", "element": "mixin", "name": "mixin_in_b"})
        check("removing a gone branch is a no-op done", cap.last("bus_input_remove_done").get("id") == "r2")

        # A start-time bin's src pad is the parser's ghost<N>, not "src": a non-live mixer
        # would wait forever on a request pad left behind.
        runner.handle_bus_input_remove({"id": "r3", "element": "mixin", "name": "mixin_in_a"})
        check("removing the start-time bin -> done",
              cap.last("bus_input_remove_done").get("id") == "r3")
        check("mixer released the start-time bin's request pad",
              mixer.get_static_pad("sink_0") is None)

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
        check("drop_branch releases the start-time bin's request pad",
              runner.pipeline.get_by_name("mixin").get_static_pad("sink_0") is None)
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
    PES - 1 h from its first buffer, with no runner retime; the kept sources never break."""
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
    # The joiner's first buffer: the first PES its producer sent after the branch connected.
    first = next((pes["pts"] for a, _st, data in prods["in2"].delivered if a >= got.get("add_t", 0)
                  for lst in rig.pes_of([(a, 0, 0, data)]).values() for pes in lst
                  if pes["pts"] is not None), None)
    first_ns = rig.house_of(rig.sample_of_pts(first, t0)) if first is not None else None
    rm_ns = got.get("rm_t", hi_ns)
    lag, _g = pcm.best_lag(c["in2"], rig.sample_of(first_ns or lo_ns), rig.sample_of(rm_ns - 50 * rig.MS))
    miss = _missing(rig, pcm, c["in2"], (first_ns or lo_ns) + 20 * rig.MS, rm_ns - 50 * rig.MS)
    after = [g for _b, g, _e in pcm.presence(c["in2"], rig.sample_of(rm_ns + 100 * rig.MS), hi)
             if g is not None and g > 0.25]
    check(f"L {tag}: the joiner is mixed at its PES - 1 h from its first buffer "
          f"({first_ns and round((first_ns - t0) / 1e9, 3)} s; lag {lag}, missing {miss[:3]}), and gone "
          f"after the remove ({len(after)} blocks)", first_ns is not None and lag == 0 and not miss and not after)
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

if __name__ == "__main__":
    test_add_remove()
    test_containment_helpers()
    test_gate_sees_declared_bins_only()
    live_aligned_case(_PY_RUNNER, "py", check)
    aligner_absent_case(_PY_RUNNER, "py", check)
    aligner_join_chain_case(_PY_RUNNER, "py", check)
    aligner_fall_case(_PY_RUNNER, "py", check)

    if _failures:
        print(f"\n{len(_failures)} FAILED: {_failures}")
        sys.exit(1)
    print("All live input branch tests passed.")
