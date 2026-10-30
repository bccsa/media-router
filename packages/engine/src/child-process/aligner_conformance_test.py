#!/usr/bin/env python3
"""Aligner conformance scenarios (plan ch. 6 part 7.4, WI-P2-14), in both runners.

Each scenario starts the real modules' runner commands (fixtures/aligner/pipelines.json, made by
testing/alignerConformance.test.ts), feeds synthetic producers over unixfd edges at real time on
the house clock (aligner_rig.py) and judges the module's output and its aligners' reports against
`<scenario>.expect.json` beside the commands. The field captures of part 7.4 are taken on the
rigs (WI-P2-16); everything here is built inside the harness.

Skips (exit 0) without GStreamer, numpy, the native plugins or the commands file.
Run:  python3 aligner_conformance_test.py [--only scn-a,scn-b] [--runner native|py]
"""
import argparse
import gc
import json
import math
import os
import re
import shutil
import subprocess
import sys
import threading
import time

try:
    import numpy  # noqa: F401  (the rig needs it)
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP aligner_conformance_test.py — GStreamer or numpy unavailable ({exc})")
    sys.exit(0)

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import aligner_rig as rig  # noqa: E402
import transform_input_fixture as fx  # noqa: E402
import numpy as np  # noqa: E402

_HOUSE_SO = os.path.join(rig.PLUGINS, "mpegts-core", "native", "mrtshouse", "libgstmrtshouse.so")
_DUCKER_SO = os.path.join(rig.PLUGINS, "audio-processing", "native", "mrducker", "libgstmrducker.so")
_HOOK_SO = os.path.join(rig.PLUGINS, "mpegts-muxer", "native", "mux-routing", "libmrhook_mux_routing.so")
_TSSPLIT = os.path.join(rig.PLUGINS, "ts-splitter", "native", "mr-tssplit", "mr-tssplit")
_OCC = os.path.join(rig.PLUGINS, "mpegts-core", "tests", "fixtures", "cap-occ-1080i-h264-21aac-ttx.ts")
S = 1_000_000_000
MS = rig.MS

_failures = []
# A run whose producers fell this far behind their schedule tests the harness, not the module:
# it is run again (W is 100 ms for a 10 ms rhythm).
HARNESS_LATE_MS = 30
# A time-namespace run's exit code for that: the outer run starts it again in a fresh namespace.
RETRY_RC = 75


class Retry(Exception):
    pass


def on_time(label, tag, *sessions):
    prods = [p for s in sessions for p in s.producers.values()]
    worst = max((p.late_ns for p in prods), default=0) / 1e6
    if worst > HARNESS_LATE_MS:
        t0 = sessions[0].t0 or 0
        when = sorted((round(sec(t, t0), 2), round(v / 1e6)) for p in prods for t, v in p.late
                      if v > HARNESS_LATE_MS * MS)[:4]
        raise Retry(f"{label} {tag}: the harness fed {worst:.0f} ms behind its schedule "
                    f"(at {when}; load {os.getloadavg()[0]:.1f})")


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name, flush=True)
    if not cond:
        _failures.append(name)


def tee_of(start):
    return re.search(r"tee name=(busout_\d+)", start["pipeline"]).group(1)


def sec(t_ns, t0):
    return (t_ns - t0) / S


class Session:
    """One module on one runner, its producers and one consumer on its bus tee."""

    def __init__(self, argv, entry, sock_dir=None):
        self.argv = argv
        self.dir = sock_dir or rig.SocketDir()
        self.own_dir = sock_dir is None
        self.entry = rig.on_socket_dir(rig.pipelines()[entry], self.dir.path)
        self.producers, self.consumers, self.runner, self.t0 = {}, [], None, None
        self.playing = None

    def producer(self, name, sockets=None, **kw):
        p = rig.Producer(name, [self.dir.sock(s) for s in (sockets or [name])], **kw)
        self.producers[name] = p
        return p

    def start(self, lead_ms=3000, margin_ms=700):
        """Build the producers' feeds for a t0 `lead_ms` ahead, then start the module
        `margin_ms` before t0, so it starts as on a box: its producers there, their data soon (a
        module idle past its inputs' W, 2 s at start, would start on gaps)."""
        if self.t0 is None and self.producers:
            self.prepare(lead_ms)
        for p in self.producers.values():
            p.listen()
        if self.t0 is not None:
            wait = (self.t0 - margin_ms * MS - rig.now_ns()) / 1e9
            if wait > 0:
                time.sleep(wait)
        self.runner = rig.Runner(self.argv, env=self.entry.get("env"))   # the builder's spawn env
        self.playing = self.runner.start(self.entry["start"])
        return self.playing is not None

    def prepare(self, lead_ms=3000):
        gc.collect()
        self.t0 = rig.prepare(self.producers.values(), lead_ms)
        return self.t0

    def consume(self, name="out", tee=None):
        sock = self.dir.sock(name)
        ok = self.runner.attach(tee or tee_of(self.entry["start"]), sock)
        c = rig.Consumer(sock)
        c.start()
        self.consumers.append(c)
        return c if ok else None

    def begin(self):
        """Feed what `start` built: from t0 on."""
        gc.disable()                    # no collector pause while the producers feed
        rig.go(self.producers.values())
        return self.t0

    def run(self, until_s, actions=()):
        """Until `until_s` after t0, running each (at_s, fn) on time."""
        todo = sorted(actions, key=lambda a: a[0])
        while True:
            now = rig.now_ns()
            while todo and now >= self.t0 + int(todo[0][0] * S):
                todo.pop(0)[1]()
            if now >= self.t0 + int(until_s * S):
                return
            time.sleep(0.005)

    def close(self):
        gc.enable()
        rc = self.runner.stop() if self.runner else None
        for c in self.consumers:
            c.stop()
        for p in self.producers.values():
            p.stop()
        if self.own_dir:
            self.dir.close()
        return rc


def aligner_name(start, connection):
    """`mralignwatch` element of a 302M fan-in input (the builder names it by the connection)."""
    m = re.search(r"mralignwatch name=(\S+) aligner=\S+ input=\"?" + re.escape(connection) + r"\"?[ )]",
                  start["pipeline"] + " ")
    return m.group(1) if m else None


def states(reports, t0=None):
    return [(round(sec(t, t0), 3) if t0 else t, p.get("state")) for t, p in reports
            if p.get("reason") == "state"]


def last_report(reports, before=None):
    rows = [(t, p) for t, p in reports if before is None or t < before]
    return rows[-1][1] if rows else {}


def pace_at(reports, lo, hi):
    vals = [p.get("pace") for t, p in reports if lo <= t < hi and isinstance(p.get("pace"), int)]
    return rig.median(vals) / 1e6 if vals else None


def no_restart(tag, label, runner, rc):
    started = runner.count("started")
    playing = runner.count("state_change", state="playing")
    check(f"{label} {tag}: one start, no error, no restart, exit 0 (started {started}, PLAYING "
          f"{playing}, errors {[e.get('message') for e in runner.errors()][:2]}, rc {rc})",
          started == 1 and playing == 1 and not runner.errors() and rc == 0)


def presence_gaps(pcm, content, lo, hi, lag=0, floor=0.5, block=960):
    """Blocks of [lo, hi) where `content` is missing from the output (gain under `floor` of its
    own level) though it was on: [(seconds after the content's t0, gain)]."""
    out = []
    for b0, g, energy in pcm.presence(content, lo, hi, block=block, lag=lag):
        if energy <= 0:
            continue
        full = block * 2 * (content.amp ** 2) / 3
        if energy < 0.5 * full:
            continue                    # the content is off in most of this block
        if g is None or g < floor:
            out.append((round((b0 - content.origin) / rig.RATE, 3), None if g is None else round(g, 2)))
    return out


def duck_misses(pcm, prog, key, lo, hi, x):
    """10 ms blocks of [lo, hi) where the programme is not in `pcm` at lag 0 at the gain the key
    sets: the duck depth inside a key run once settled, unity clear of one, between them on the
    ramps: [(seconds after the content's t0, gain)]."""
    depth = 10 ** (x["depth_db"] / 20)
    tol, dur = x["gain_tolerance"], rig.BLOCK / rig.RATE
    out = []
    for b0, g, _e in pcm.presence(prog, lo, hi, block=rig.BLOCK):
        t = (b0 - prog.origin) / rig.RATE
        if any(a + x["duck_settle_s"] <= t and t + dur <= b for a, b in key.gate):
            want = (depth, depth)
        elif all(t + dur <= a or t >= b + x["release_settle_s"] for a, b in key.gate):
            want = (1.0, 1.0)
        else:
            want = (depth, 1.0)
        if g is None or not want[0] - tol <= g <= want[1] + tol:
            out.append((round(t, 3), None if g is None else round(g, 3)))
    return out


def silent_runs(pcm, origin, lo, hi, x):
    """Runs of filled silence in [lo, hi): [(seconds after the content's t0, ms)]."""
    return [(round((a - origin) / rig.RATE, 3), round(n * 1000 / rig.RATE, 1))
            for a, n in pcm.quiet_runs(lo, hi, x["silent_run_samples"], x["silent_floor_lsb"])]


def last_complete_pes(delivered, before, ref):
    """(arrival of the buffer that completed the last PES delivered before `before`, that PES's
    content end in house ns): what a watchdog last took in."""
    pes = rig.pes_of([(a, st, 0, d) for a, st, d in delivered if a < before])
    best = (None, None)
    for lst in pes.values():
        for p in lst:
            if p["pts"] is None or p["cut"]:
                continue
            dec = rig.decode_302m(p["data"])
            n = 0 if dec is None else len(dec)
            end = rig.house_of(rig.sample_of_pts(p["pts"], ref) + n)
            if best[1] is None or end > best[1]:
                best = (p["end_arrival"], end)
    return best


# --------------------------------------------------------------------------- scn-align-absent-rejoin
def scn_align_absent_rejoin(tag, argv, exp):
    label = exp["scenario"]
    x, inp = exp["expect"], exp["inputs"]
    s = Session(argv, exp["pipelines"])
    contents = {n: rig.Content(v["seed"]) for n, v in inp.items()}
    for n, v in inp.items():
        s.producer(n, content=contents[n], stop_s=exp["seconds"],
                   knobs=rig.Knobs(silence=[tuple(v["silence"])] if "silence" in v else None))
    try:
        check(f"{label} {tag}: PLAYING", s.start())
        cons = s.consume()
        t0 = s.begin()
        s.run(exp["seconds"] + 1.0)
    finally:
        rc = s.close()
    on_time(label, tag, s)
    gone = x["absent_input"]
    frm, length, _mode = inp[gone]["silence"]
    t_from, t_back = t0 + int(frm * S), t0 + int((frm + length) * S)
    reps = {n: rig.aligner_reports(s.runner, aligner_name(s.entry["start"], f"conn-{n}")) for n in inp}
    end_ns = t0 + int((exp["seconds"] - 0.5) * S)

    # Absent at W of going silent (B-79; `tick_ms` is the runners' slack now): once its last data has
    # left its watchdog, at its end + pace (a push blocked in the mixer is held, not silent: WI-P2-6).
    absent = rig.first_state(reps[gone], "absent", after=t_from)
    w = (absent[1].get("silence-limit") or 0) / 1e6 if absent else None
    pace = (absent[1].get("pace") or 0) if absent else 0
    last_in, last_end = last_complete_pes(s.producers[gone].delivered, t_from, t0)
    delay = (absent[0] - max(last_in, last_end + pace)) / 1e6 if absent and last_in else None
    raw = (absent[0] - last_in) / 1e6 if absent and last_in else None
    limit = (w or 0) + x["tick_ms"]
    check(f"{label} {tag}: {gone} absent {delay and round(delay, 1)} ms after its last data left its "
          f"watchdog ({raw and round(raw, 1)} ms after its last PES came), within W {w} + "
          f"{x['tick_ms']} ms", absent is not None and delay is not None and delay <= limit
          and absent[0] < t_back)
    back = rig.first_state(reps[gone], "present", after=absent[0] if absent else t_back)
    after = last_report(reps[gone], before=end_ns)
    stale_ms = (after.get("stale-time") or 0) / 1e6
    check(f"{label} {tag}: {gone} present again at its return ({back and round(sec(back[0], t0), 3)} s) "
          f"with its backlog's stale part counted ({after.get('stale-buffers')} buffers, {stale_ms} ms)",
          back is not None and back[0] >= t_back - 50 * MS
          and (after.get("stale-buffers") or 0) >= x["stale_buffers_min"] and stale_ms >= x["stale_ms_min"])
    for n in inp:
        ab = [st for t, st in states(reps[n]) if st == "absent" and t0 < t < end_ns]
        want = x["absences"][n]
        check(f"{label} {tag}: {n} absent {len(ab)} time(s) during the run (want {want})", len(ab) == want)

    # The mix: continuous, every kept input in every block, the absent one out only while gone.
    pes = rig.pes_of(cons.records)
    pid = max(pes, key=lambda k: len(pes[k])) if pes else None
    pcm = rig.Pcm(pes.get(pid, []), t0)
    lo, hi = rig.sample_of(t0 + S // 2), rig.sample_of(end_ns)
    check(f"{label} {tag}: the output is continuous over the run (holes {pcm.holes(lo, hi)[:3]})",
          pcm.hi > hi and not pcm.holes(lo, hi))
    for n, c in contents.items():
        lag, gain = pcm.best_lag(c, lo, rig.sample_of(t_from))
        if n == gone:
            miss_before = presence_gaps(pcm, c, lo, rig.sample_of(t_from - 20 * MS))
            miss_after = presence_gaps(pcm, c, rig.sample_of(t_back + 200 * MS), hi)
            out = pcm.presence(c, rig.sample_of(t_from + 50 * MS), rig.sample_of(t_back - 50 * MS))
            held = [g for _b, g, _e in out if g is not None and g > 0.25]
            check(f"{label} {tag}: {gone} mixed at its content time before and after (lag {lag}, gain "
                  f"{gain:.3f}; missing blocks {len(miss_before)} + {len(miss_after)}), and out of the "
                  f"mix while its link is stalled ({len(held)} blocks)",
                  lag == x["lag_samples"] and not miss_before and not miss_after and not held)
            # Mixed, the backlog would come from where its gaps reached at the return, about the
            # stall late: look for it at any such shift, and for its fresh content (the search's
            # control) at shift 0.
            o_lo, o_hi = rig.sample_of(t_back - 200 * MS), rig.sample_of(t_back + 3 * S)
            leak, at = pcm.found(c, rig.sample_of(t_from), rig.sample_of(t_back - 100 * MS), o_lo, o_hi)
            ctrl, ctrl_at = pcm.found(c, rig.sample_of(t_back + S // 2), rig.sample_of(t_back + 3 * S // 2),
                                      o_lo, o_hi)
            check(f"{label} {tag}: none of {gone}'s stale backlog in the mix after its return (best gain "
                  f"{leak:.3f} at {at and round(at * 1000 / rig.RATE)} ms; its fresh content found at "
                  f"{ctrl_at} samples, gain {ctrl:.3f})",
                  leak < x["backlog_gain_max"] and ctrl_at == 0 and ctrl > 0.9)
            # B-83: its part of the mix is its content faded out and back in, to the LSB.
            em = rig.edge_model(pcm, [contents[k] for k in inp if k != gone], c, lo, hi,
                                fade=x["fade_samples"])
            edge = {k: em[k] and round(sec(rig.house_of(em[k]), t0), 3) for k in ("out", "back")}
            check(f"{label} {tag}: {gone} fades out where its content stops, in where it is back, the "
                  f"others untouched (out at {edge['out']} s, back at {edge['back']} s, the largest "
                  f"deviation {em['dev']} LSB, within {x['fade_lsb']})",
                  em["dev"] is not None and em["dev"] <= x["fade_lsb"]
                  and abs(edge["out"] - frm) <= 0.05 and frm + length - 0.05 <= edge["back"]
                  <= frm + length + 0.5)
        else:
            miss = presence_gaps(pcm, c, lo, hi)
            check(f"{label} {tag}: {n} in every block of the mix at its content time (lag {lag}, gain "
                  f"{gain:.3f}, missing {miss[:3]})", lag == x["lag_samples"] and not miss)

    # Output lateness while absent, against before.
    before = rig.median(rig.lateness_ms(cons.records, t_from - 3 * S, t_from))
    during = rig.median(rig.lateness_ms(cons.records, absent[0] + 200 * MS, t_back)) if absent else None
    check(f"{label} {tag}: output lateness while {gone} is absent {during and round(during, 1)} ms, before "
          f"{before and round(before, 1)} ms (within ±{x['lateness_delta_ms']} ms)",
          before is not None and during is not None and abs(during - before) <= x["lateness_delta_ms"])
    no_restart(tag, label, s.runner, rc)


# --------------------------------------------------------------------------- scn-align-slow-joiner
def scn_align_slow_joiner(tag, argv, exp):
    label = exp["scenario"]
    x, inp = exp["expect"], exp["inputs"]
    s = Session(argv, exp["pipelines"])
    contents = {n: rig.Content(v["seed"]) for n, v in inp.items()}
    for n, v in inp.items():
        s.producer(n, content=contents[n], start_s=v.get("start_s", 0.0), stop_s=exp["seconds"],
                   knobs=rig.Knobs(delay_ms=v.get("delay_ms", 0.0)))
    add_at, remove_at = exp["add_s"], exp["remove_s"]
    done = {}

    def add():
        done["add"] = s.runner.request(dict(s.entry["add"], cmd="bus_input_add"), "bus_input_add_done")
        done["add_t"] = rig.now_ns()

    def remove():
        done["remove"] = s.runner.request(dict(s.entry["remove"], cmd="bus_input_remove"),
                                          "bus_input_remove_done")
        done["remove_t"] = rig.now_ns()
    try:
        check(f"{label} {tag}: PLAYING", s.start())
        cons = s.consume()
        t0 = s.begin()
        s.run(exp["seconds"] + 1.0, [(add_at, add), (remove_at, remove)])
    finally:
        rc = s.close()
    on_time(label, tag, s)
    check(f"{label} {tag}: the late source added and removed live (bus_input_add_done, "
          f"bus_input_remove_done)",
          (done.get("add") or (0, {}))[1].get("event") == "bus_input_add_done"
          and (done.get("remove") or (0, {}))[1].get("event") == "bus_input_remove_done")
    joiner = exp["joiner"]
    names = {n: aligner_name(s.entry["start"], f"conn-{n}") for n in inp if n != joiner}
    names[joiner] = rig.aligner_of(s.entry["add"]["description"])
    reps = {n: rig.aligner_reports(s.runner, nm) for n, nm in names.items()}
    t_add, t_rm = t0 + int(add_at * S), t0 + int(remove_at * S)

    # B-80: the joiner stays gapped while it catches up and the pace slews to it, so the output
    # slows and never stops; then the pace is that much higher.
    gaps = [(a, g) for a, g in rig.arrival_gaps_ms(cons.records, t0 + S, t0 + int((exp["seconds"] - 0.3) * S))]
    worst = max(gaps, key=lambda ag: ag[1], default=None)
    want, tol = x["rise_ms"], x["rise_tolerance_ms"]
    check(f"{label} {tag}: no output gap over {x['max_gap_ms']} ms across the join and the remove "
          f"(the largest {worst and round(worst[1], 1)} ms at {worst and round(sec(worst[0], t0), 3)} s)",
          worst is not None and worst[1] <= x["max_gap_ms"])
    group = [p for n in reps for p in reps[n]]
    p_before = pace_at(group, t_add - S, t_add)
    p_after = pace_at(group, t_add + 2 * S, t_rm)
    rise = p_after - p_before if p_before is not None and p_after is not None else None
    check(f"{label} {tag}: the pace rises by the joiner's lateness ({p_before and round(p_before, 1)} -> "
          f"{p_after and round(p_after, 1)} ms, +{rise and round(rise, 1)}; want +{want} ± {tol})",
          rise is not None and abs(rise - want) <= tol)
    p_end = pace_at(group, t_rm + S, t0 + int((exp["seconds"] - 0.5) * S))
    check(f"{label} {tag}: removing the slow input lowers the pace again ({p_end and round(p_end, 1)} ms)",
          p_end is not None and p_after is not None and p_end < p_after - want / 2)

    pes = rig.pes_of(cons.records)
    pid = max(pes, key=lambda k: len(pes[k])) if pes else None
    pcm = rig.Pcm(pes.get(pid, []), t0)
    lo, hi = rig.sample_of(t0 + S // 2), rig.sample_of(t0 + int((exp["seconds"] - 0.5) * S))
    check(f"{label} {tag}: the output is continuous across the join and the remove (holes "
          f"{pcm.holes(lo, hi)[:3]})", pcm.hi > hi and not pcm.holes(lo, hi))
    # The joiner is mixed once caught up: 0.5 s to count its lateness, 2 x that to slew, by
    # joiner_by_s after its add; none after the remove less its lateness.
    late_ns = int(inp[joiner].get("delay_ms", 0) * MS)
    a_lo, a_hi = rig.sample_of(t_add + int(x["joiner_by_s"] * S)), rig.sample_of(t_rm - late_ns - 200 * MS)
    for n, c in contents.items():
        if n == joiner:
            lag, gain = pcm.best_lag(c, a_lo, a_hi)
            miss = presence_gaps(pcm, c, a_lo, a_hi)
        else:
            lag, gain = pcm.best_lag(c, lo, hi)
            miss = presence_gaps(pcm, c, lo, hi)
        check(f"{label} {tag}: {n} at its content time {'once joined' if n == joiner else 'throughout'} "
              f"(lag {lag}, gain {gain:.3f}, missing {miss[:3]})", lag == 0 and not miss)
    stale = (last_report(reps[joiner]).get("stale-time") or 0) / 1e6
    end_ns = t0 + int((exp["seconds"] - 0.5) * S)
    kept = {n: ((last_report(reps[n], before=end_ns).get("stale-buffers") or 0),
                [round(sec(t, t0), 2) for t, st in states(reps[n]) if st == "absent" and t0 < t < end_ns])
            for n in reps if n != joiner}
    check(f"{label} {tag}: the joiner loses what came before it caught up, at most 2 x its lateness"
          f" + 0.5 s ({stale} ms stale, at most {x['stale_max_ms']}), the kept inputs nothing (stale"
          f" buffers, absences: {kept})", stale <= x["stale_max_ms"]
          and all(v == (0, []) for v in kept.values()))
    lat_b = rig.median(rig.lateness_ms(cons.records, t_add - 2 * S, t_add))
    lat_a = rig.median(rig.lateness_ms(cons.records, t_add + 2 * S, t_rm))
    check(f"{label} {tag}: output lateness {lat_b and round(lat_b, 1)} -> {lat_a and round(lat_a, 1)} ms "
          f"(+{want} ± {tol})", lat_b is not None and lat_a is not None
          and abs((lat_a - lat_b) - want) <= tol)
    no_restart(tag, label, s.runner, rc)


# --------------------------------------------------------------------------- scn-align-late-delivering
def scn_align_late_delivering(tag, argv, exp):
    label = exp["scenario"]
    x, inp = exp["expect"], exp["inputs"]
    s = Session(argv, exp["pipelines"])
    contents = {n: rig.Content(v["seed"]) for n, v in inp.items()}
    for n, v in inp.items():
        # A producer that has run late for a while: its data comes from t0, its content behind.
        s.producer(n, content=contents[n], start_s=-v.get("delay_ms", 0.0) / 1e3, stop_s=exp["seconds"],
                   knobs=rig.Knobs(delay_ms=v.get("delay_ms", 0.0)))
    late = exp["late_input"]
    delay = inp[late]["delay_ms"]
    try:
        check(f"{label} {tag}: PLAYING", s.start())
        cons = s.consume()
        t0 = s.begin()
        s.run(exp["seconds"] + delay / 1e3 + 1.0)
    finally:
        rc = s.close()
    on_time(label, tag, s)
    reps = {n: rig.aligner_reports(s.runner, aligner_name(s.entry["start"], f"conn-{n}")) for n in inp}
    end_ns = t0 + int((exp["seconds"] - 0.3) * S)
    for n in inp:
        own_end = end_ns + int(inp[n].get("delay_ms", 0) * MS)     # its feed's end, delivered
        ab = [round(sec(t, t0), 2) for t, st in states(reps[n]) if st == "absent" and t0 < t < own_end]
        check(f"{label} {tag}: {n} never absent while it delivers ({ab})", not ab)
    pace = pace_at([p for n in reps for p in reps[n]], t0 + 3 * S, end_ns)
    check(f"{label} {tag}: the pace takes the late input ({pace and round(pace, 1)} ms for {delay} ms; "
          f"within +{x['pace_over_ms']} ms)", pace is not None and delay <= pace <= delay + x["pace_over_ms"])
    pes = rig.pes_of(cons.records)
    pid = max(pes, key=lambda k: len(pes[k])) if pes else None
    pcm = rig.Pcm(pes.get(pid, []), t0)
    lo, hi = rig.sample_of(t0 + S // 2), rig.sample_of(end_ns)
    check(f"{label} {tag}: the output is continuous (holes {pcm.holes(lo, hi)[:3]})",
          pcm.hi > hi and not pcm.holes(lo, hi))
    for n, c in contents.items():
        pushed = [b for b in s.producers[n].pcm_pushed if lo <= b and b + rig.BLOCK <= hi]
        lag, gain = pcm.best_lag(c, lo, hi)
        miss = presence_gaps(pcm, c, lo, hi, block=rig.BLOCK)
        check(f"{label} {tag}: {n}: every sample in is out (blocks in {len(pushed)}, missing {len(miss)}; "
              f"lag {lag}, gain {gain:.3f})", lag == 0 and not miss
              and len(pushed) >= (hi - lo) // rig.BLOCK - 1)
    no_restart(tag, label, s.runner, rc)


# --------------------------------------------------------------------------- scn-align-wrap
def wrap_house_ns(after_ns):
    """The first house time after `after_ns` where a mux PES PTS (house + 1 h) wraps 2^33."""
    k = (after_ns * 9 // 100000 + rig.MUX_BASE) // rig.WRAP + 1
    return -(-(k * rig.WRAP - rig.MUX_BASE) * 100000 // 9)


def scn_align_wrap(tag, argv, exp):
    label = exp["scenario"]
    x, inp = exp["expect"], exp["inputs"]
    s = Session(argv, exp["pipelines"])
    contents = {n: rig.Content(v["seed"]) for n, v in inp.items()}
    for n in inp:
        s.producer(n, content=contents[n], stop_s=exp["seconds"])
    try:
        check(f"{label} {tag}: PLAYING", s.start())
        cons = s.consume()
        t0 = s.begin()
        tw = wrap_house_ns(t0)
        print(f"    {label} {tag}: house {t0 / 3.6e12:.2f} h, the PES field wraps "
              f"{sec(tw, t0):.2f} s into the run")
        s.run(exp["seconds"] + 1.0)
    finally:
        rc = s.close()
    on_time(label, tag, s)
    check(f"{label} {tag}: the 33-bit wrap falls inside the run ({sec(tw, t0):.2f} s; the harness "
          f"runs in a time namespace)", x["wrap_after_s"][0] <= sec(tw, t0) <= x["wrap_after_s"][1])
    end_ns = t0 + int((exp["seconds"] - 0.3) * S)
    reps = {n: rig.aligner_reports(s.runner, aligner_name(s.entry["start"], f"conn-{n}")) for n in inp}
    for n in inp:
        ab = [st for t, st in states(reps[n]) if st == "absent" and t0 < t < end_ns]
        check(f"{label} {tag}: {n} never absent across the wrap ({len(ab)})", not ab)
    demux = s.runner.plugin("mrtsdemux:")
    gaps = max((p.get("gaps", 0) or 0 for _t, p in demux), default=None)
    check(f"{label} {tag}: no demux gap at the wrap (mrtsdemux gaps {gaps}, {len(demux)} reports)",
          gaps == 0 and demux)
    pes = rig.pes_of(cons.records)
    pid = max(pes, key=lambda k: len(pes[k])) if pes else None
    plist = pes.get(pid, [])
    wrapped = [p["pts"] for p in plist if p["pts"] is not None]
    straddle = any(a > b for a, b in zip(wrapped, wrapped[1:]))
    check(f"{label} {tag}: the output's PES PTS field wrapped in the run ({len(wrapped)} PES)", straddle)
    pcm = rig.Pcm(plist, tw)
    lo, hi = rig.sample_of(t0 + S // 2), rig.sample_of(end_ns)
    check(f"{label} {tag}: the output is continuous across the wrap (holes {pcm.holes(lo, hi)[:3]}, "
          f"overlap {pcm.overlap})", pcm.hi > hi and not pcm.holes(lo, hi) and pcm.overlap == 0)
    w_lo, w_hi = rig.sample_of(tw - 3 * S), rig.sample_of(tw + 3 * S)
    for n, c in contents.items():
        lag, gain = pcm.best_lag(c, w_lo, w_hi)
        miss = presence_gaps(pcm, c, lo, hi)
        check(f"{label} {tag}: {n} at its content time through the wrap (lag {lag}, gain {gain:.3f}, "
              f"missing {miss[:3]})", lag == 0 and not miss)
    stamps = [st for _a, st, _f, _d in cons.records if st is not None and st >= 0]
    steps = [b - a for a, b in zip(stamps, stamps[1:])]
    check(f"{label} {tag}: the wire stamps never step (largest step "
          f"{max(steps, default=0) / 1e6:.1f} ms, back {min(steps, default=0) / 1e6:.1f} ms)",
          steps and max(steps) < 200 * MS and min(steps) >= 0)
    no_restart(tag, label, s.runner, rc)


# --------------------------------------------------------------------------- scn-837-ducker-mixer
def scn_837_ducker_mixer(tag, argv, exp):
    label = exp["scenario"]
    x, inp = exp["expect"], exp["inputs"]
    prog = rig.Content(inp["prog"]["seed"])
    key = rig.Content(inp["key"]["seed"], gate=[tuple(g) for g in inp["key"]["on_s"]])
    d = rig.SocketDir()
    ap = Session(argv, exp["pipelines"][0], sock_dir=d)
    mx = Session(argv, exp["pipelines"][1], sock_dir=d)
    ap.producer("prog", content=prog, stop_s=exp["seconds"])
    ap.producer("key", sockets=["key-ap", "key-mx"], content=key, stop_s=exp["seconds"])
    try:
        check(f"{label} {tag}: audio-processing PLAYING", ap.start(lead_ms=4000, margin_ms=1500))
        ap.runner.attach(tee_of(ap.entry["start"]), d.sock("duck"))
        ap_out = ap.consume("ap-out")
        check(f"{label} {tag}: audio-mixer PLAYING beside it", mx.start())
        mx_out = mx.consume("mx-out")
        t0 = ap.begin()
        mx.t0 = t0
        ap.run(exp["seconds"] + 1.5)
    finally:
        rc_mx = mx.close()
        rc_ap = ap.close()
        d.close()
    on_time(label, tag, ap, mx)
    end_ns = t0 + int((exp["seconds"] - 0.5) * S)
    lo, hi = rig.sample_of(t0 + S), rig.sample_of(end_ns)

    # The ducker's egress: its input's PES timeline, to the tick, the programme at its content time.
    p_in = rig.pes_of([(a, st, 0, data) for a, st, data in ap.producers["prog"].delivered])
    p_out = rig.pes_of(ap_out.records)
    pin = {p["pts"] for v in p_in.values() for p in v if p["pts"] is not None}
    dpid = max(p_out, key=lambda k: len(p_out[k])) if p_out else None
    dlist = [p for p in p_out.get(dpid, []) if p["pts"] is not None]
    inside = [p for p in dlist if lo <= rig.sample_of_pts(p["pts"], t0) < hi]
    off = [p["pts"] for p in inside if p["pts"] not in pin]
    check(f"{label} {tag}: the ducker's egress PES PTS are its input's, 0 ticks ({len(inside) - len(off)} "
          f"of {len(inside)} on an input PES PTS)", inside and not off)
    dpcm = rig.Pcm(dlist, t0)
    lag, _g = dpcm.best_lag(prog, lo, hi)
    check(f"{label} {tag}: the programme leaves the ducker at its content time (lag {lag})", lag == 0)
    gains = dpcm.presence(prog, lo, hi, block=240)
    on_g, off_g = [], []
    for b0, g, _e in gains:
        t = (b0 - key.origin) / rig.RATE
        if g is None:
            continue
        if any(a + x["duck_settle_s"] <= t < b for a, b in key.gate):
            on_g.append(g)
        elif all(not (a <= t < b + x["release_settle_s"]) for a, b in key.gate):
            off_g.append(g)
    on_db = 20 * math.log10(max(rig.median(on_g) or 1e-9, 1e-9))
    off_db = 20 * math.log10(max(rig.median(off_g) or 1e-9, 1e-9))
    check(f"{label} {tag}: the ducker ducks on the key ({on_db:.1f} dB while it speaks, "
          f"{off_db:.1f} dB between; depth {x['depth_db']} dB)",
          abs(on_db - x["depth_db"]) <= 1.0 and abs(off_db) <= 0.5)
    # Block by block: a fill or a slip the medians above cannot see.
    d_miss = duck_misses(dpcm, prog, key, lo, hi, x)
    d_zero = silent_runs(dpcm, prog.origin, lo, hi, x)
    check(f"{label} {tag}: the programme leaves the ducker in every 10 ms block, at its content time "
          f"and at the gain the key sets, no silence filled ({len(d_miss)} blocks off {d_miss[:4]}, "
          f"silent runs {d_zero[:3]})", dpcm.hi > hi and not d_miss and not d_zero)
    absent = {}
    for sess in (ap, mx):
        for nm in re.findall(r"mralignwatch name=(\S+)", sess.entry["start"]["pipeline"]):
            reps = rig.aligner_reports(sess.runner, nm)
            absent[nm] = None if not reps else [
                round(sec(t, t0), 2) for t, p in reps
                if p.get("reason") == "state" and p.get("state") == "absent" and t0 < t < end_ns]
    check(f"{label} {tag}: no aligner of either module absent during the run ({absent})",
          bool(absent) and all(v == [] for v in absent.values()))

    # The mix beside the key: no silence-fill not in the inputs, both at their content time. The
    # mix is the ducker's output plus the key, sample for sample, so a residual is what is wrong.
    m_out = rig.pes_of(mx_out.records)
    mpid = max(m_out, key=lambda k: len(m_out[k])) if m_out else None
    mpcm = rig.Pcm(m_out.get(mpid, []), t0)
    check(f"{label} {tag}: the mix is continuous (holes {mpcm.holes(lo, hi)[:3]})",
          mpcm.hi > hi and not mpcm.holes(lo, hi))
    plag, _pg = mpcm.best_lag(prog, lo, hi)
    klag, kgain = mpcm.best_lag(key, lo, hi)
    check(f"{label} {tag}: the programme in the mix at its content time (lag {plag}), the key within "
          f"{x['key_lag_samples']} sample of its own (lag {klag}, gain {kgain:.3f})",
          plag == 0 and klag is not None and abs(klag) <= x["key_lag_samples"])
    worst, bad = 0.0, []
    if mpcm.hi > hi and dpcm.hi > hi:
        n = np.arange(lo, hi, dtype=np.int64)
        kk = key.expected(n - (klag or 0))
        for c in (0, 1):
            r = (mpcm.y[lo - mpcm.lo:hi - mpcm.lo, c] - dpcm.y[lo - dpcm.lo:hi - dpcm.lo, c]
                 - np.round(kk[c] * 32767) / 32767) * 32767
            blocks = np.abs(r[:len(r) // 960 * 960]).reshape(-1, 960).max(axis=1)
            worst = max(worst, float(blocks.max()))
            bad += [round((lo + i * 960 - rig.sample_of(t0)) / rig.RATE, 3)
                    for i in np.nonzero(blocks > x["residual_lsb"])[0]]
    check(f"{label} {tag}: the mix is the ducker's output plus the key in every sample, no silence "
          f"filled (worst residual {worst:.1f} LSB, blocks over {x['residual_lsb']}: {sorted(set(bad))[:4]})",
          mpcm.hi > hi and dpcm.hi > hi and not bad)
    # And the programme in it, the key taken out, block by block as it left the ducker.
    m_miss, m_zero = None, None
    if mpcm.hi > hi:
        n = np.arange(lo, hi, dtype=np.int64)
        kk = key.expected(n - (klag or 0))
        part = mpcm.y[lo - mpcm.lo:hi - mpcm.lo] - np.stack(
            [np.round(kk[c] * 32767) / 32767 for c in (0, 1)], axis=1)
        mprog = rig.Pcm.of(part, lo)
        m_miss = duck_misses(mprog, prog, key, lo, hi, x)
        m_zero = silent_runs(mprog, prog.origin, lo, hi, x)
    check(f"{label} {tag}: the programme in the mix in every 10 ms block, at its content time and at "
          f"the ducker's gain, no silence filled ({None if m_miss is None else len(m_miss)} blocks off "
          f"{(m_miss or [])[:4]}, silent runs {(m_zero or [])[:3]})",
          m_miss == [] and m_zero == [])
    for tag2, sess, rc in (("audio-processing", ap, rc_ap), ("audio-mixer", mx, rc_mx)):
        no_restart(tag, f"{label} {tag2}", sess.runner, rc)


# --------------------------------------------------------------------------- scn-mux-klv
def scn_mux_klv(tag, argv, exp):
    label = exp["scenario"]
    x = exp["expect"]
    if not os.path.exists(_HOOK_SO):
        print(f"SKIP {label} {tag} — {_HOOK_SO} not built")
        return
    seconds, cues = exp["seconds"], exp["cues_s"]
    repeat = exp["repeat_klv_cue"]
    s = Session(argv, exp["pipelines"])

    def egress0(t0):
        target = lambda p: t0 + fx.ns(p - fx.DTS0)  # noqa: E731
        bufs, _targets = fx.cue_egress(seconds, target, schedule=cues)
        return [(data, arr) for data, _st, arr in repeat_cue(bufs, fx.KLV_PID, repeat)]

    def egress1(t0):
        target = lambda p: t0 + fx.ns(p - fx.DTS0)  # noqa: E731
        bufs, _t = fx.house_egress(seconds, target)
        return [(d.replace(b"MRAU\x01\x00", b"MRAU\x01\x05"), arr) for d, _st, arr in bufs]
    s.producer("klv0", ts=egress0)
    s.producer("klv1", ts=egress1)
    try:
        check(f"{label} {tag}: PLAYING", s.start())
        cons = s.consume()
        t0 = s.begin()
        s.run(seconds + 2.0)
    finally:
        rc = s.close()
    on_time(label, tag, s)

    def keyed(*pes_maps):
        out = {}
        for pes_map in pes_maps:
            for lst in pes_map.values():
                for p in lst:
                    k = fx.au_key(p["data"])
                    if k:
                        out.setdefault(k, []).append(p)
        return out
    # Each producer on its own: both carry video on PID 0x100.
    kin = keyed(*(rig.pes_of([(a, st, 0, d) for a, st, d in p.delivered]) for p in s.producers.values()))
    kout = keyed(rig.pes_of(cons.records))
    wrap = rig.WRAP

    def ticks(a, b):
        return ((a - b + wrap // 2) % wrap) - wrap // 2
    for pid_, name in ((fx.KLV_PID, "KLV"), (fx.TTX_PID, "teletext")):
        keys = sorted(k for k in kin if k[0] == pid_)
        off, missing = [], []
        for k in keys:
            ins, outs = kin[k], kout.get(k, [])
            if len(outs) < len(ins):
                missing.append(k)
            for a, b in zip(ins, outs):        # repeated payloads: first in, first out
                off.append(ticks(b["pts"], a["pts"]))
        check(f"{label} {tag}: every {name} cue written at its input PES PTS, a repeated payload "
              f"included ({len(keys)} cues, missing {missing}, worst {max(map(abs, off), default=None)} ticks)",
              keys and not missing and all(abs(t) <= x["cue_ticks"] for t in off))
    # The feed ends without an EOS: what the demuxes and the aligners still hold is not counted.
    tail_ns = t0 + int((seconds - 0.5) * S)

    def before_tail(k):
        p = kin[k][0]                   # by decode time: a cut by PTS leaves holes among B-frames
        return rig.unwrap(p["dts"] if p["dts"] is not None else p["pts"], t0) < tail_ns
    # The pace before the pause and after the cues that end it: a mistimed cue raises it for good.
    reps = rig.aligner_reports(s.runner, "aw_demux_0_video")
    resume = next(c for a, c in zip(cues, cues[1:]) if c - a > 5)
    p0 = pace_at(reps, t0 + 4 * S, t0 + int((resume - 0.5) * S))
    p1 = pace_at(reps, t0 + int((cues[-1] + 0.5) * S), t0 + int((seconds - 1) * S))
    # A route the mux links after the group's first push (its demux's pad comes later under load)
    # joins late: it catches up and never stalls the mux, losing at most its first 2D + 0.5 s and the
    # buffer that ends the catch-up, D its lateness (B-80, F7). A start is all it may lose.
    cost_s = 2 * max(p0 or 0, p1 or 0) / 1000 + 0.5 + x["buffer_s"]
    for pid_ in (fx.VIDEO_PID, 0x105):
        keys = sorted(k for k in kin if k[0] == pid_ and k in kout and before_tail(k))
        sent_n = sum(1 for k in kin if k[0] == pid_ and before_tail(k))
        lost = sorted(k[1] for k in kin if k[0] == pid_ and k not in kout and before_tail(k))
        later = [n for n in lost if not keys or n > keys[0][1]]
        start_s = (len(lost) - len(later)) * fx.FRAME / 90000
        off = [ticks(kout[k][0]["pts"], kin[k][0]["pts"]) for k in keys]
        dts = []
        for k in keys:
            q = kout[k][0]
            dts.append((q["arrival"], q["dts"] if q["dts"] is not None else q["pts"]))
        dts.sort()
        steps = {(b - a) % wrap for (_x, a), (_y, b) in zip(dts, dts[1:])}
        check(f"{label} {tag}: video 0x{pid_:x}: every AU from its first out at its input PES PTS ({len(keys)} "
              f"of {sent_n}, not out after it {later[:4]}, worst {max(map(abs, off), default=None)} ticks; "
              f"its start lost {start_s:.2f} s, at most {cost_s:.2f} s), its decode cadence one frame "
              f"between cues (steps {sorted(steps)[:4]})",
              keys and not later and start_s <= cost_s and all(t == 0 for t in off)
              and steps == {fx.FRAME})
    vid = sorted(q["arrival"] for k, v in kout.items() if k[0] == fx.VIDEO_PID for q in v[:1])
    lo_ns = t0 + int((cues[0] - 0.5) * S)
    gaps = [(b - a) / 1e6 for a, b in zip(vid, vid[1:]) if a >= lo_ns]
    check(f"{label} {tag}: the video never stalls between cues (largest arrival gap "
          f"{max(gaps, default=0):.1f} ms)", gaps and max(gaps) <= x["video_gap_ms"])
    check(f"{label} {tag}: the cues after the pause do not raise the mux pace ({p0 and round(p0, 1)} -> "
          f"{p1 and round(p1, 1)} ms)", p0 is not None and p1 is not None
          and p1 - p0 <= x["pace_rise_ms"])
    no_restart(tag, label, s.runner, rc)


def repeat_cue(bufs, pid, n):
    """`bufs` with cue `n + 1` on `pid` given cue `n`'s payload (R-P2-8, two equal cues in a row)."""
    tag_from = b"MRAU" + bytes([pid >> 8, pid & 0xFF]) + (n + 1).to_bytes(4, "big")
    tag_to = b"MRAU" + bytes([pid >> 8, pid & 0xFF]) + n.to_bytes(4, "big")
    return [(d.replace(tag_from, tag_to), st, arr) for d, st, arr in bufs]


# --------------------------------------------------------------------------- scn-align-bursty
def scn_align_bursty(tag, argv, exp):
    label = exp["scenario"]
    x, inp = exp["expect"], exp["inputs"]
    if not os.path.exists(_HOOK_SO):
        print(f"SKIP {label} {tag} — {_HOOK_SO} not built")
        return
    seconds = exp["seconds"]
    s = Session(argv, exp["pipelines"])
    for name, v in inp.items():
        rel = generated(v["generator"], seconds + 2)
        p0 = next((rig.ts_psi.read_pcr(pkt) // 300 for d in rel for pkt in rig.ts_psi.iter_packets(d)
                   if rig.ts_psi.read_pcr(pkt) is not None), 0)

        def build(t0, rel=rel, p0=p0):
            shift = (t0 * 9 // 100000 + rig.MUX_BASE - p0) % rig.WRAP
            return rig.ready_by_pcr([rig.rebase_ts(d, shift) for d in rel], t0)
        s.producer(name, ts=build, stop_s=seconds,
                   knobs=rig.Knobs(burst_ms=v.get("burst_ms", 0.0)))
    try:
        check(f"{label} {tag}: PLAYING", s.start(lead_ms=6000))
        s.consume()
        t0 = s.begin()
        s.run(seconds + 1.0)
    finally:
        rc = s.close()
    on_time(label, tag, s)
    end_ns = t0 + int((seconds - 0.5) * S)
    for name, v in inp.items():
        delivered = s.producers[name].delivered
        classes = stream_classes(generated(v["generator"], seconds + 2))
        for route, media in v["routes"].items():
            pid_ = classes.get(media)
            reps = rig.aligner_reports(s.runner, f"aw_{route}")
            ab = [st for t, st in states(reps) if st == "absent" and t0 < t < end_ns]
            arr = [a for a, _st, d in delivered if t0 + S < a < end_ns and any(
                (pkt[1] & 0x40) and rig.ts_psi.ts_pid(pkt) == pid_ for pkt in rig.ts_psi.iter_packets(d))]
            g = sorted((b - a) / 1e6 for a, b in zip(arr, arr[1:]))
            p95 = g[int(0.95 * (len(g) - 1))] if g else None
            w = (last_report(reps, before=end_ns).get("silence-limit") or 0) / 1e6
            want = min(x["ceiling_ms"], max(x["floor_ms"], 3 * (p95 or 0)))
            # Taken as pushed, not as the element takes them in: a runner spreads a burst over a
            # few ms, so W runs about 1 % under (the python runner's).
            dev = (w - want) / want * 100 if want else None
            check(f"{label} {tag}: {route} never absent in {seconds} s ({len(ab)}); W {w:.0f} ms, 3 x the "
                  f"p95 gap {p95 and round(3 * p95, 1)} ms ({len(g)} arrivals; {dev and round(dev, 1)} %, "
                  f"within {x['w_tolerance'] * 100:.0f} %)", reps and not ab and p95 is not None
                  and abs(w - want) <= want * x["w_tolerance"])
    no_restart(tag, label, s.runner, rc)


_GENERATED = {}


def stream_classes(buffers):
    """{'video' | 'audio': PID} from the PMT of a generated stream."""
    pkts = [p for d in buffers[:200] for p in rig.ts_psi.iter_packets(d)]
    pat = rig.ts_psi.parse_pat(pkts)
    pmt = rig.ts_psi.parse_pmt(pkts, next(iter(pat.values()))) if pat else None
    out = {}
    for pid_, st in (pmt or {}).get("streams", []):
        media = "video" if st in (0x02, 0x1B, 0x24) else "audio" if st in (0x03, 0x04, 0x0F, 0x11, 0x06) else None
        if media and media not in out:
            out[media] = pid_
    return out


def generated(kind, seconds):
    """Relative-time TS from GStreamer, cached for both runners: [bytes] of 7-packet buffers."""
    key = (kind, seconds)
    if key not in _GENERATED:
        if kind == "h264-aac":
            desc = (f"videotestsrc num-buffers={int(seconds * 25)} ! video/x-raw,width=320,height=180,"
                    "framerate=25/1 ! x264enc tune=zerolatency speed-preset=ultrafast bitrate=600"
                    " key-int-max=50 ! h264parse ! mux. "
                    f"audiotestsrc num-buffers={int(seconds * 48000 / 1024)} samplesperbuffer=1024 ! "
                    "audio/x-raw,rate=48000,channels=2 ! avenc_aac bitrate=128000 ! aacparse ! mux. "
                    "mpegtsmux name=mux alignment=7 ! appsink name=ts sync=false")
        elif kind == "opus-32k":
            desc = (f"audiotestsrc num-buffers={int(seconds * 50)} samplesperbuffer=960 ! "
                    "audio/x-raw,rate=48000,channels=2 ! opusenc bitrate=32000 ! opusparse ! "
                    "mpegtsmux alignment=7 ! appsink name=ts sync=false")
        else:
            raise ValueError(kind)
        _GENERATED[key] = [d for _pts, d in rig.generate_ts(desc)]
    return _GENERATED[key]


# --------------------------------------------------------------------------- scn-split-passthrough
def scn_split_passthrough(tag, _argv, exp):
    """mr-tssplit is a sidecar, not a runner pipeline: one run, the builder's argv."""
    label = exp["scenario"]
    x = exp["expect"]
    for need in (_TSSPLIT, _OCC):
        if not os.path.exists(need):
            print(f"SKIP {label} — {need} missing")
            return
    d = rig.SocketDir()
    argv = rig.on_socket_dir(rig.pipelines()["splitter"]["argv"], d.path)
    outs = {int(spec.split(":")[0], 16): spec.split(":")[1] for spec in argv[argv.index("--out") + 1::2]
            if ":" in spec}
    src = open(_OCC, "rb").read()
    t0 = rig.grid(rig.now_ns() + 3000 * MS)
    pcr0 = next(rig.ts_psi.read_pcr(p) // 300 for p in rig.ts_psi.iter_packets(src)
                if rig.ts_psi.read_pcr(p) is not None)
    shift = (t0 * 9 // 100000 + rig.MUX_BASE - pcr0) % rig.WRAP
    data = rig.rebase_ts(src, shift)
    chunks = [data[i:i + 1316] for i in range(0, len(data), 1316)]
    prod = rig.Producer("split-in", [d.sock("split-in")], ts=lambda _t0: rig.ready_by_pcr(chunks, _t0, 0))
    prod.listen()
    proc = subprocess.Popen([_TSSPLIT] + argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, errors="replace", bufsize=1)
    lines = []
    reader = threading.Thread(target=lambda: lines.extend(proc.stdout), daemon=True)
    reader.start()
    cons = {}
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not any('"ready"' in l for l in lines):
            time.sleep(0.02)
        for pid_, tee in outs.items():
            sock = d.sock(f"edge-{pid_:x}")
            proc.stdin.write(json.dumps({"cmd": "bus_attach", "tee": tee, "socket": sock}) + "\n")
            proc.stdin.flush()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and not any('"attached"' in l and sock in l for l in lines):
                time.sleep(0.02)
            cons[pid_] = rig.Consumer(sock)
            cons[pid_].start()
        prod.prepare(t0)
        prod.begin()
        prod.join(30)
        time.sleep(1.0)
    finally:
        proc.stdin.close()
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
        for c in cons.values():
            c.stop()
        prod.stop()
        d.close()
    inp = rig.pes_of([(a, st, 0, b) for a, st, b in prod.delivered])
    pcrs_in = [rig.ts_psi.read_pcr(p) for _a, _s, b in prod.delivered for p in rig.ts_psi.iter_packets(b)
               if rig.ts_psi.ts_pid(p) == x["pcr_pid"] and rig.ts_psi.read_pcr(p) is not None]
    pcr_set = set(pcrs_in)
    for pid_, c in cons.items():
        got = rig.pes_of(c.records, pid_)
        want = inp.get(pid_, [])
        a = [(p["pts"], p["dts"], p["data"]) for p in want if not p["cut"]]
        b = [(p["pts"], p["dts"], p["data"]) for p in got.get(pid_, []) if not p["cut"]]
        # The output starts at a PES of the input (its first PSI and a PUSI): compare from there.
        start = a.index(b[0]) if b and b[0] in a else -1
        check(f"{label}: 0x{pid_:x}: each output PES is the input PID's, byte for byte ({len(b)} PES, "
              f"from input PES {start} of {len(a)})", b and start >= 0 and a[start:start + len(b)] == b)
        pkts = [p for _a, _s, _f, d_ in c.records for p in rig.ts_psi.iter_packets(d_)]
        injected = [rig.ts_psi.read_pcr(p) for p in pkts if rig.ts_psi.read_pcr(p) is not None]
        if pid_ != x["pcr_pid"]:
            spaced = all((b2 - a2) >= 27_000_000 // 100 for a2, b2 in zip(injected, injected[1:]))
            check(f"{label}: 0x{pid_:x}: every injected PCR is an input program PCR, >= 10 ms apart "
                  f"({len(injected)} PCR)", injected and set(injected) <= pcr_set and spaced)
        n, bad = identity_check(c.records, t0)
        check(f"{label}: 0x{pid_:x}: each buffer's wire stamp is IdentityStamp's ({len(c.records)} "
              f"buffers: {n}; off {bad[:2]})", c.records and not bad and n["exact"] > 0)
    stats = [l for l in lines if '"stats"' in l]
    timeline = [l for l in lines if "timeline" in l]
    check(f"{label}: no timeline event and no timeline key in the stats ({len(stats)} stats lines)",
          not timeline)


def identity_check(records, t_lo):
    """mrts::IdentityStamp's rule on one output, buffer by buffer: the first timing PES (video or
    audio, or on the first PCR carrier) gives PES - 1 h under the floor; a PES none timing, the
    sidecar's arrival (between `t_lo` and ours); no PES, the last stamp."""
    n, bad, prev, timing_pid = {"exact": 0, "held": 0, "arrival": 0, "repeat": 0}, [], None, None
    for arrival, wire, _f, data in records:
        pkts = list(rig.ts_psi.iter_packets(data))
        if timing_pid is None:
            timing_pid = next((rig.ts_psi.ts_pid(p) for p in pkts if rig.ts_psi.read_pcr(p) is not None),
                              None)
        first, any_pes = None, False
        for pkt in pkts:
            v = rig.ts_psi.read_pes_pts(pkt)
            if v is None:
                continue
            any_pes = True
            sid = pkt[rig.ts_psi.payload_offset(pkt) + 3]
            if (sid & 0xF0) == 0xE0 or (sid & 0xE0) == 0xC0 or rig.ts_psi.ts_pid(pkt) == timing_pid:
                first = v
                break
        if first is not None:
            want = rig.ts_timeline.house_from_mux_pts(first, arrival)
            held = prev is not None and prev > want
            if wire != (prev if held else want):
                bad.append(("timing", wire, want))
            n["held" if held else "exact"] += 1
        elif any_pes or prev is None:
            if not (t_lo <= wire <= arrival) or (prev is not None and wire < prev):
                bad.append(("arrival", wire, arrival))
            n["arrival"] += 1
        else:
            if wire != prev:
                bad.append(("repeat", wire, prev))
            n["repeat"] += 1
        prev = wire
    return n, bad


_302M = ("avenc_s302m", "avdec_s302m", "mpegtsmux", "audiomixer", "unixfdsrc", "unixfdsink")
NEEDS = {
    "scn-align-bursty": ("x264enc", "avenc_aac", "opusenc", "h264parse", "aacparse", "opusparse",
                         "videotestsrc", "mpegtsmux", "unixfdsrc", "unixfdsink"),
    "scn-mux-klv": ("mpegtsmux", "unixfdsrc", "unixfdsink"),
    "scn-split-passthrough": ("unixfdsrc", "unixfdsink"),
    "scn-837-ducker-mixer": _302M + ("audiointerleave", "deinterleave"),
}


def missing_elements(name):
    return [e for e in NEEDS.get(name, _302M) if Gst.ElementFactory.find(e) is None]


SCENARIOS = {
    "scn-align-absent-rejoin": scn_align_absent_rejoin,
    "scn-align-slow-joiner": scn_align_slow_joiner,
    "scn-align-late-delivering": scn_align_late_delivering,
    "scn-align-bursty": scn_align_bursty,
    "scn-align-wrap": scn_align_wrap,
    "scn-mux-klv": scn_mux_klv,
    "scn-837-ducker-mixer": scn_837_ducker_mixer,
    "scn-split-passthrough": scn_split_passthrough,
}


def in_time_namespace(name, tag):
    """Run `name` on runner `tag` in a time namespace whose CLOCK_MONOTONIC puts the 33-bit PES
    wrap about 12 s after it starts, so the house clock really crosses it mid-run; the inner run
    prints its own checks. Each attempt gets a fresh namespace: a retry in the same one would
    start after the wrap."""
    if not shutil.which("unshare"):
        print(f"SKIP {name} {tag} — no unshare for a time namespace")
        return
    for attempt in range(3):
        while os.getloadavg()[0] >= 3.0:
            time.sleep(5)
        m = time.monotonic_ns()
        offset = (wrap_house_ns(m + 60 * S) - m) // S - 12
        ns = ["unshare", "-U", "-r", "-T", f"--monotonic={offset}"]
        # Whether this box gives one at all; past this, a run that fails is a failure.
        probe = subprocess.run(ns + ["true"], capture_output=True, text=True, timeout=30)
        if probe.returncode != 0:
            print(f"SKIP {name} {tag} — no time namespace here ({(probe.stderr.strip() or '?').splitlines()[-1]})")
            return
        cmd = ns + [sys.executable, os.path.abspath(__file__), "--only", name, "--runner", tag, "--in-time-ns"]
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        lines = done.stdout.splitlines()
        # A retried attempt's lines count too, as a retry outside a namespace does.
        for line in lines:
            if line.startswith(("PASS ", "FAIL ", "RETRY ", "SKIP ", "    ")):
                print(line, flush=True)
            if line.startswith("FAIL "):
                _failures.append(line[5:])
        if done.returncode == RETRY_RC:
            if attempt == 2:
                late = next((l[6:] for l in lines if l.startswith("RETRY ")), "the harness fell behind")
                check(f"{late}, three runs in a row", False)
            continue
        if done.returncode != 0 and not any(l.startswith("FAIL ") for l in lines):
            check(f"{name} {tag}: the time-namespace run exits 0 (rc {done.returncode}: "
                  f"{done.stderr.strip()[-300:]})", False)
        return


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--runner", default="")
    ap.add_argument("--in-time-ns", action="store_true")
    args = ap.parse_args()
    if not os.path.exists(_HOUSE_SO):
        print(f"SKIP aligner_conformance_test.py — {_HOUSE_SO} not built (make native)")
        return 0
    if not os.path.exists(os.path.join(rig.FIXTURES, "pipelines.json")):
        print("SKIP aligner_conformance_test.py — fixtures/aligner/pipelines.json missing")
        return 0
    names = [n for n in (args.only.split(",") if args.only else SCENARIOS) if n]
    runners = [r for r in args.runner.split(",") if r] or None
    kinds = rig.runner_kinds(runners)
    if not os.path.exists(rig.NATIVE_BIN):
        print(f"SKIP native runner — {rig.NATIVE_BIN} not built (make native); python runner only")
    for name in names:
        exp = rig.expectation(name)
        lack = missing_elements(name)
        if lack:
            print(f"SKIP {name} — {', '.join(lack)} unavailable")
            continue
        if name == "scn-align-wrap" and not args.in_time_ns:
            print(f"\n--- {name}: {exp['graph']}", flush=True)
            for tag, _argv in kinds:
                in_time_namespace(name, tag)
            continue
        if name == "scn-837-ducker-mixer" and not os.path.exists(_DUCKER_SO):
            print(f"SKIP {name} — {_DUCKER_SO} not built")
            continue
        if not args.in_time_ns:
            print(f"\n--- {name}: {exp['graph']}", flush=True)
        if name == "scn-split-passthrough":
            SCENARIOS[name]("sidecar", None, exp)
            continue
        for tag, argv in kinds:
            for attempt in range(3):
                # Inside a time namespace its clock runs to the wrap: the outer run waited.
                while not args.in_time_ns and os.getloadavg()[0] >= 3.0:
                    time.sleep(5)
                try:
                    SCENARIOS[name](tag, argv, exp)
                    break
                except Retry as late:
                    print(f"RETRY {late}", flush=True)
                    if args.in_time_ns:
                        return RETRY_RC         # the outer run retries in a fresh namespace
                    if attempt == 2:
                        check(f"{late}, three runs in a row", False)
    if _failures:
        print(f"\n{len(_failures)} FAILED: {_failures}")
        return 1
    print("\naligner_conformance_test.py: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
