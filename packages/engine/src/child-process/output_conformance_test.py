#!/usr/bin/env python3
"""Output conformance scenarios (plan ch. 8 WI-P4-14): the outputs' real strings on test sinks, in both
runners, judged against fixtures/output/<scenario>.expect.json; skips (exit 0) without what it needs.
Run:  python3 output_conformance_test.py [--only scn-a,scn-b] [--runner native|py] [--mutant leaky-esq]
"""
import argparse
import gc
import os
import pickle
import re
import shutil
import subprocess
import sys
import time

try:
    import numpy  # noqa: F401  (the rig needs it)
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP output_conformance_test.py — GStreamer or numpy unavailable ({exc})")
    sys.exit(0)

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import aligner_rig as rig  # noqa: E402
import output_rig as orig  # noqa: E402

S = orig.S
MS = orig.MS
_HOUSE_SO = os.path.join(orig.HOUSE_DIR, "libgstmrtshouse.so")
_failures = []
HARNESS_LATE_MS = 30          # a feed this far behind its schedule tests the harness: run again
RETRY_RC = 75                 # a time-namespace run's exit code for that
MUTANT = None                 # --mutant: the planted fault the run carries


class Retry(Exception):
    pass


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name, flush=True)
    if not cond:
        _failures.append(name)


def sec(t_ns, t0):
    return round((t_ns - t0) / S, 2)


# --------------------------------------------------------------------------- one run
class Run:
    """Producers and outputs for one scenario arm on one runner: everything built, then the outputs
    launched before t0, the feed from t0, each action at its time, then the reads and the stops."""

    def __init__(self, argv):
        self.argv, self.dir = argv, rig.SocketDir()
        self.producers, self.outputs, self.t0, self.reads = [], {}, None, {}

    def producer(self, name, sockets, **kw):
        p = (MarkerProducer if kw.pop("markers", False) else rig.Producer)(
            name, [self.dir.sock(s) for s in sockets], **kw)
        self.producers.append(p)
        return p

    def output(self, key, entry, **kw):
        self.outputs[key] = orig.Output(entry, self.argv, self.dir.path, **kw)
        return self.outputs[key]

    def go(self, seconds, actions=(), reads=(), lead_ms=3000, before=None):
        """Feed for `seconds` from t0 (actions: [(at_s, fn)]); then each (key, element, property) of
        `reads` into self.reads; then every output stopped (its stop timed) and the feeds closed.
        `before`: outputs that run ahead of the rest (a muxer the others attach to)."""
        gc.collect()
        self.t0 = rig.prepare(self.producers, lead_ms)
        for p in self.producers:
            p.listen()
        ok = True
        try:
            order = list(before or []) + [k for k in self.outputs if k not in (before or [])]
            for k in order:
                ok &= self.outputs[k].launch()
                if before and k in before:
                    ok &= self.outputs[k].wait_playing()
                    self._attach_ahead(k)
            gc.disable()
            rig.go(self.producers)
            for k in order:
                ok &= self.outputs[k].wait_playing()
            todo = sorted(actions, key=lambda a: a[0])
            while True:
                now = rig.now_ns()
                while todo and now >= self.t0 + int(todo[0][0] * S):
                    todo.pop(0)[1]()
                if now >= self.t0 + int(seconds * S):
                    break
                time.sleep(0.005)
            for key, element, prop in reads:
                self.reads[(key, element, prop)] = self.outputs[key].prop(element, prop)
        finally:
            gc.enable()
            for o in reversed(list(self.outputs.values())):
                o.stop()
            for p in self.producers:
                p.stop()
            self.dir.close()
        return ok

    def _attach_ahead(self, key):
        """A muxer ahead: its bus tee feeds the outputs on their sockets."""
        o = self.outputs[key]
        tee = re.search(r"tee name=(busout_\d+)", o.start_cmd["pipeline"]).group(1)
        for k, other in self.outputs.items():
            if k == key:
                continue
            sock = re.search(r"unixfdsrc [^!]*?socket-path=(\S+)", other.start_cmd["pipeline"]).group(1)
            o.runner.attach(tee, sock)

    def on_time(self, label):
        worst = max((p.late_ns for p in self.producers), default=0) / 1e6
        if worst > HARNESS_LATE_MS:
            raise Retry(f"{label}: the harness fed {worst:.0f} ms behind its schedule "
                        f"(load {os.getloadavg()[0]:.1f})")

    def clean(self, label, keys=None, replays=()):
        """Every output reached PLAYING once (those in `replays`: at least once, a stalled sink's
        state comes back through PAUSED), no error, exits 0."""
        for k in keys or self.outputs:
            o = self.outputs[k]
            n = o.runner.count("state_change", state="playing")
            check(f"{label} {k}: PLAYING, no error, exits 0 (PLAYING {n}, errors {o.errors()[:2]}, rc {o.rc})",
                  o.playing is not None and (n >= 1 if k in replays else n == 1) and not o.errors() and o.rc == 0)


class MarkerProducer(rig.Producer):
    """A producer whose `Marker` buffers go out as OQ-12 gap markers: GAP|DISCONT, PTS the gap's end."""

    def _run(self):
        src = self.out.get_by_name("src")
        for at, _i, data in self.schedule:
            while not self._stop.is_set():
                wait = at - rig.now_ns()
                if wait <= 0:
                    break
                time.sleep(min(wait / 1e9, 0.05))
            if self._stop.is_set():
                return
            sent = rig.now_ns()
            self._lag(sent, sent - at)
            b = Gst.Buffer.new_wrapped(bytes(data))
            if isinstance(data, Marker):
                b.pts = data.end_ns
                b.set_flags(Gst.BufferFlags.GAP | Gst.BufferFlags.DISCONT)
            else:
                b.pts = b.dts = self.stamper.stamp(data, sent)
            src.emit("push-buffer", b)
            self.delivered.append((sent, b.pts, bytes(data)))


class Marker(bytes):
    """An OQ-12 marker buffer's bytes, with the gap's end on house time."""
    end_ns = 0


def gap_marker(pid, length_ns):
    """OQ-12's marker packet: adaptation-only, the gap length in transport_private_data."""
    af = bytes([0x02, 8]) + length_ns.to_bytes(8, "big")
    return (bytes([0x47, (pid >> 8) & 0x1F, pid & 0xFF, 0x20, 183]) + af + b"\xff" * (183 - len(af)))


# --------------------------------------------------------------------------- reads
def paces(o, t0, lo, hi):
    """The pace's present lateness (ms) in the messages that came in [lo, hi) s."""
    return orig.window(o.paces(), t0, lo, hi, "present-lateness-ns")


def renders(o, t0, lo, hi):
    """The ASRC's render lateness (ms) in [lo, hi) s, its 0 (unknown) left out."""
    return [v for v in orig.window(o.asrc_stats(), t0, lo, hi, "render-lateness-ns") if v]


def last(series):
    return series[-1][1] if series else {}


def overruns(o, skip_tap=True):
    """Its queue_overrun episodes: (element, leaky, levelTimeMs, overruns), the ts-probe tap's apart."""
    tap = probe_tap(o)
    return [(p.get("element"), p.get("leaky"), p.get("levelTimeMs"), p.get("overruns"))
            for _t, p in o.overruns() if not (skip_tap and p.get("element") == tap)]


def episodes(o, t0):
    """Its queue_overrun episodes at their first overrun (a report comes a second after its last, `ms`
    after its first): (s, element, leaky, levelTimeMs, overruns), the ts-probe tap's apart."""
    tap = probe_tap(o)
    return [(round((t - t0) / S - 1 - (p.get("ms") or 0) / 1000, 1), p.get("element"), p.get("leaky"),
             p.get("levelTimeMs"), p.get("overruns")) for t, p in o.overruns() if p.get("element") != tap]


def probe_tap(o):
    """The player's ts-probe tap queue's name: unnamed queues are numbered in the string's order."""
    s = o.start_cmd["pipeline"]
    at = s.find("! appsink name=tsprobe")
    n = len(re.findall(r"! queue (?!name=)", s[:at])) if at >= 0 else 0
    return f"queue{n - 1}" if n else None


def demux_last(o):
    rows = [p for _t, p in o.demux() if p.get("reason") == "interval"]
    return rows[-1] if rows else {}


def video_ok(label, o, x, frames_lo=None):
    """No frame lost by the player: no rate drop, the display presented each release, no replace,
    the demux took every PES in, no content queue overran."""
    ps, ds, dm = o.reads.get("pace") or {}, o.reads.get("display") or {}, demux_last(o)
    check(f"{label}: no frame lost (rate-drops {ps.get('rate-drops')}, released {ps.get('released')}, "
          f"presented {ds.get('presented')}, replaced {ds.get('replaced')}; demux cc-lost {dm.get('cc-lost')}, "
          f"pes-dropped-cc {dm.get('pes-dropped-cc')}; overruns {overruns(o)})",
          ps.get("rate-drops") == 0 and ds.get("replaced") == 0
          and abs((ps.get("released") or 0) - (ds.get("presented") or 0)) <= 2
          and (frames_lo is None or (ps.get("released") or 0) >= frames_lo)
          and dm.get("cc-lost", 0) == x.get("cc_lost", 0) and not overruns(o))


# --------------------------------------------------------------------------- scenarios
def av_run(argv, exp, knobs=None, ts=None, markers=False, keys=None):
    """The player and the audio decoder on one generated H.264 + AAC feed."""
    keys = keys or ("player", "decoder")
    run = Run(argv)
    rel = rig.generated(exp["kind"], exp["seconds"] + 2)
    run.rel, run.pids = rel, orig.stream_pids(rel)
    run.producer("feed", (["vp"] if "player" in keys else []) + (["ad"] if "decoder" in keys else []),
                 ts=ts or (lambda t0: orig.at_house(rel, t0)), stop_s=exp["seconds"], knobs=knobs,
                 markers=markers)
    if "player" in keys:
        run.output("player", exp.get("player", "player50"), video=orig.display(**exp.get("display", {})))
    if "decoder" in keys:
        run.output("decoder", "decoder", audio=orig.card())
    reads = []
    if "player" in keys:
        reads += [("player", "vp_pace", "stats"), ("player", "sink", "display-stats"), ("player", "vpdemux", "pes")]
    if "decoder" in keys:
        reads += [("decoder", "sink", "resyncs")]
    run.ok = run.go(exp["seconds"] + 1.0, (), reads)
    for k, o in run.outputs.items():
        o.reads = {"pace": run.reads.get((k, "vp_pace", "stats")),
                   "display": run.reads.get((k, "sink", "display-stats")),
                   "resyncs": run.reads.get((k, "sink", "resyncs")), "pes": run.reads.get((k, "vpdemux", "pes"))}
    return run


def scn_out_stall(tag, argv, exp):
    """A 2 s stall of the input, its backlog sent at the end: each output plays the backlog at the
    content's rate, nothing lost, its lateness up by the stall and flat after (no catch-up: §15)."""
    label, x = f"{exp['scenario']} {tag}", exp["expect"]
    at, length = exp["stall"]
    run = av_run(argv, exp, knobs=rig.Knobs(silence=[(at, length, "hold")]))
    run.on_time(label)
    run.clean(label)
    pl, dec, t0 = run.outputs["player"], run.outputs["decoder"], run.t0
    video_ok(f"{label} player", pl, x)
    b, a = paces(pl, t0, 2, at), paces(pl, t0, at + length + 2, exp["seconds"] + 1)
    # Base to base, but a window can sit on the pace's hold throughout: up to two frames over before,
    # one under after (1940 seen with medians): +2000 less three frames to plus two.
    step = round(min(a) - min(b), 1) if a and b else None
    check(f"{label} player: lateness up by the stall and flat after (base {b and round(min(b), 1)} -> "
          f"{a and round(min(a), 1)} ms, +{step}, median {orig.mid(b)} -> {orig.mid(a)}; spread after "
          f"{orig.spread(a)} ms, within {x['video_flat_ms']}; want +{x['video_step_ms'][0]} to +{x['video_step_ms'][1]})",
          step is not None and x["video_step_ms"][0] <= step <= x["video_step_ms"][1]
          and orig.spread(a) <= x["video_flat_ms"])
    rb, ra = renders(dec, t0, 2, at), renders(dec, t0, at + length + 2, exp["seconds"] + 1)
    st = last(dec.asrc_stats())
    astep = orig.mid(ra) - orig.mid(rb) if ra and rb else None
    check(f"{label} decoder: render lateness up by the stall and flat after ({orig.mid(rb)} -> {orig.mid(ra)} ms, "
          f"+{astep}; spread {orig.spread(ra)}; want {x['audio_step_ms']}: the ring's start fill moves it), nothing "
          f"dropped "
          f"(dropped {st.get('dropped-frames')}, lost {st.get('lost-frames')}, relocks {st.get('relocks')})",
          astep is not None and x["audio_step_ms"][0] <= astep <= x["audio_step_ms"][1]
          and orig.spread(ra) <= x["flat_ms"] and st.get("dropped-frames") == 0 and st.get("lost-frames") == 0
          and st.get("relocks") == 0)
    ov = overruns(dec)
    check(f"{label} decoder: the backlog waits in the prefill, never in a leaky queue (episodes {ov[:3]})",
          all(e[0] in x["decoder_full"] and not e[1] for e in ov))
    dm = demux_last(dec)
    check(f"{label} decoder: the demux lost nothing (gaps {dm.get('gaps')}, cc-lost {dm.get('cc-lost')})",
          dm.get("gaps") == 0 and dm.get("cc-lost") == 0)


def scn_out_gap_recovers(tag, argv, exp):
    """A 2 s content gap (the jump rule, then an OQ-12 marker) and a lone stale PES (T8): each output
    back at its input's lateness after it, nothing else dropped."""
    for arm in exp["arms"]:
        label, x = f"{exp['scenario']} {arm['name']} {tag}", exp["expect"]
        at, length = exp["gap"]
        knobs, markers, ts = None, False, None
        if arm["name"] in ("drop", "marker"):
            knobs = rig.Knobs(silence=[(at, length, "drop")])
        if arm["name"] == "marker":
            markers = True

            def ts(t0, length=length, at=at):
                bufs = orig.at_house(rig.generated(exp["kind"], exp["seconds"] + 2), t0)
                pids = orig.stream_pids(rig.generated(exp["kind"], exp["seconds"] + 2))
                k = next(i for i, (_d, r) in enumerate(bufs) if r - t0 >= int((at + length) * S))
                # One marker buffer a PID, before the feed resumes, its PTS that PID's next PES time.
                marks = []
                for pid in pids.values():
                    nxt = next(rig.ts_timeline.house_from_mux_pts(rig.ts_psi.read_pes_pts(p), t0)
                               for d, _r in bufs[k:] for p in rig.ts_psi.iter_packets(d)
                               if p[1] & 0x40 and rig.ts_psi.ts_pid(p) == pid
                               and rig.ts_psi.read_pes_pts(p) is not None)
                    m = Marker(gap_marker(pid, int(length * S)))
                    m.end_ns = nxt
                    marks.append((m, bufs[k][1]))
                return bufs[:k] + marks + bufs[k:]
        if arm["name"] == "stale":
            def ts(t0, at=at):
                rel = rig.generated(exp["kind"], exp["seconds"] + 2)
                bufs = orig.at_house(rel, t0)
                whole = orig.restamp_pes(b"".join(d for d, _r in bufs), orig.stream_pids(rel)["audio"],
                                         int(at * 48000 / 1024), -int(arm["stale_h"] * 3600 * 90000) % rig.WRAP)
                out, i = [], 0
                for d, r in bufs:
                    out.append((whole[i:i + len(d)], r))
                    i += len(d)
                return out
        run = av_run(argv, exp, knobs=knobs, ts=ts, markers=markers)
        run.on_time(label)
        run.clean(label)
        off = run.producers[0].stamper.off_clock
        check(f"{label}: the bus stamp's B-203 rule: {off} off-clock PES (want {arm.get('stale', 0)}), "
              "a stale one timing nothing, its buffer stamped at arrival", off == arm.get("stale", 0))
        pl, dec, t0 = run.outputs["player"], run.outputs["decoder"], run.t0
        b, a = paces(pl, t0, 2, at), paces(pl, t0, at + length + 2, exp["seconds"] + 1)
        ps, dm = pl.reads.get("pace") or {}, demux_last(pl)
        want_gaps = 0 if arm["name"] == "stale" else 1
        check(f"{label} player: back at its lateness after the gap ({orig.mid(b)} -> {orig.mid(a)} ms, within "
              f"{x['video_back_ms']}), the gap collapsed ({ps.get('gaps-collapsed')}), no rate drop "
              f"({ps.get('rate-drops')}), demux gaps {dm.get('gaps')} markers {dm.get('markers')}, "
              f"content queues {overruns(pl)}",
              a and b and abs(orig.mid(a) - orig.mid(b)) <= x["video_back_ms"]
              and ps.get("gaps-collapsed") == want_gaps and ps.get("rate-drops") == 0
              and dm.get("gaps") == want_gaps and dm.get("markers") == arm.get("markers", 0)
              and not overruns(pl))
        tap = [e for e in overruns(pl, skip_tap=False) if e[0] == probe_tap(pl)]
        if tap:
            print(f"    {label} player: its ts-probe tap ({probe_tap(pl)}, leaky) met full {tap} "
                  "(a diagnostic tap; B-174 Found)")
        rb, ra = renders(dec, t0, 2, at), renders(dec, t0, at + length + 2, exp["seconds"] + 1)
        st, dd = last(dec.asrc_stats()), demux_last(dec)
        evs = [p.get("kind") + ":" + str(p.get("reason")) for _t, p in dec.asrc_events()]
        nh = [p for _t, p in dec.demux() if p.get("reason") == "not-house-time"]
        # F9: at a gap the prefill's time level reads the PTS jump as fullness; one overrun there, judged
        # by its time (its level read 0 when the jumping AU had left, as on the python runner).
        ov, lo, hi = episodes(dec, t0), at + length + x["gap_episode_s"][0], at + length + x["gap_episode_s"][1]
        gap_full = [e for e in ov if want_gaps and e[1] == "prefill" and not e[2] and e[4] == 1 and lo <= e[0] <= hi]
        if gap_full:
            print(f"    {label} decoder: Found (B-174, F9): prefill met full at the gap {gap_full} "
                  "(its time level counts the PTS jump)")
        check(f"{label} decoder: back at its render lateness ({orig.mid(rb)} -> {orig.mid(ra)} ms, within "
              f"{x['audio_back_ms']}), events {evs} (want {arm['asrc_events']}), dropped {st.get('dropped-frames')}, "
              f"demux gaps {dd.get('gaps')} markers {dd.get('markers')}, stale {dd.get('pes-dropped-stale')}, "
              f"not-house-time "
              f"{[(p.get('stale'), p.get('offset-ms')) for p in nh]}, queues {ov} (at most one prefill episode "
              f"of one overrun at {lo:g}-{hi:g} s)",
              ra and rb and abs(orig.mid(ra) - orig.mid(rb)) <= x["audio_back_ms"]
              and evs == arm["asrc_events"] and st.get("dropped-frames") == 0
              and dd.get("gaps") == want_gaps and dd.get("markers") == arm.get("markers", 0)
              and dd.get("pes-dropped-stale") == arm.get("stale", 0)
              and [p.get("stale") for p in nh] == ([True] if arm["name"] == "stale" else [])
              and len(gap_full) <= 1 and all(e in gap_full for e in ov))


def scn_out_device_stall(tag, argv, exp):
    """The display and the card stop 3 s (stall-ms): both resume live (Q2) — the video no later than
    before within a frame (T31: its cadence hold restarts lower), the audio skips its backlog."""
    label, x = f"{exp['scenario']} {tag}", exp["expect"]
    at, length = exp["stall"]
    run = Run(argv)

    def stall():
        for k in ("player", "decoder"):
            run.outputs[k].set_prop("sink", "stall-ms", int(length * 1000))
    rel = rig.generated(exp["kind"], exp["seconds"] + 2)
    run.producer("feed", ["vp", "ad"], ts=lambda t0: orig.at_house(rel, t0), stop_s=exp["seconds"])
    run.output("player", "player50", video=orig.display())
    run.output("decoder", "decoder", audio=orig.card())
    run.go(exp["seconds"] + 1, [(at, stall)], [("player", "vp_pace", "stats"), ("player", "sink", "display-stats")])
    run.on_time(label)
    run.clean(label, replays=("decoder",))
    pl, dec, t0 = run.outputs["player"], run.outputs["decoder"], run.t0
    ds = run.reads.get(("player", "sink", "display-stats")) or {}
    b, a = paces(pl, t0, 2, at), paces(pl, t0, at + length + 2, exp["seconds"] + 1)
    check(f"{label} player: back live, its base not later than before within a frame (base "
          f"{b and round(min(b), 1)} -> {a and round(min(a), 1)} ms, median {orig.mid(b)} -> {orig.mid(a)}; "
          f"spread after {orig.spread(a)}, within {x['video_flat_ms']}), the outage counted (not-presented "
          f"{ds.get('not-presented')}, timeouts {ds.get('present-timeouts')}), vp_esq never full ({overruns(pl)})",
          a and b and min(a) <= min(b) + x["frame_ms"] + 1 and orig.spread(a) <= x["video_flat_ms"]
          and (ds.get("not-presented") or 0) > 0 and not overruns(pl))
    rb, ra = renders(dec, t0, 2, at), renders(dec, t0, at + length + 2, exp["seconds"] + 1)
    evs = [p for _t, p in dec.asrc_events()]
    kinds = [p.get("kind") for p in evs]
    skipped = sum(p.get("dropped-frames") or 0 for p in evs if p.get("kind") == "device-resumed")
    check(f"{label} decoder: device-stalled then device-resumed ({kinds}), its backlog skipped ({skipped} "
          f"frames), back live ({orig.mid(rb)} -> {orig.mid(ra)} ms, within "
          f"{x['audio_back_ms']}), no queue full past the prefill ({overruns(dec)})",
          kinds == ["device-stalled", "device-resumed"] and skipped > 0
          and ra and rb and abs(orig.mid(ra) - orig.mid(rb)) <= x["audio_back_ms"]
          and all(e[0] in x["decoder_full"] and not e[1] for e in overruns(dec)))


def scn_out_video_only(tag, argv, exp):
    """The player's demux on an H.264 + AAC feed: one pad, its video; no audio PES assembled (S1). Then
    its HEVC rung on ffmpeg's libx265: every frame shown."""
    for arm in exp["arms"]:
        label = f"{exp['scenario']} {arm['name']} {tag}"
        if arm["kind"].startswith("hevc") and not shutil.which("ffmpeg"):
            print(f"SKIP {label} — no ffmpeg for its libx265 stream")
            continue
        run = av_run(argv, dict(exp, kind=arm["kind"], player=arm["player"]), keys=("player",))
        run.on_time(label)
        run.clean(label)
        pl = run.outputs["player"]
        vpid = run.pids["video"]
        pads = [p.get("pads") for _t, p in pl.demux() if p.get("reason") == "program"]
        sent = sum(1 for _a, _s, d in run.producers[0].delivered for p in rig.ts_psi.iter_packets(d)
                   if p[1] & 0x40 and rig.ts_psi.ts_pid(p) == vpid)
        pes = pl.reads.get("pes")
        check(f"{label}: one pad, the video ({pads}); the demux assembled the video PES alone, the last one open "
              f"or closed ({pes} of {sent} video PES sent; streams {sorted(run.pids)})",
              pads == [f"video_0_{vpid:04x}"] and pes in (sent - 1, sent))
        video_ok(label, pl, exp["expect"], frames_lo=sent - arm["tail_frames"])


def scn_out_rate(tag, argv, exp):
    """A content rate into a display rate: the measured refresh, the drops the ratio gives (none when
    the display is faster), the release lateness flat."""
    for arm in exp["arms"]:
        label, x = f"{exp['scenario']} {arm['name']} {tag}", dict(exp["expect"], **arm.get("expect", {}))
        e = dict(exp, kind=arm.get("kind", exp["kind"]), player=arm.get("player", exp.get("player")),
                 display=arm["display"], seconds=arm.get("seconds", exp["seconds"]))
        run = player_run(argv, e, [(a, ("sink", "present-max-mhz", v)) for a, v in arm.get("present_max_mhz", [])])
        run.on_time(label)
        run.clean(label)
        pl, t0 = run.outputs["player"], run.t0
        ps, ds = pl.reads.get("pace") or {}, pl.reads.get("display") or {}
        released, drops = ps.get("released") or 0, ps.get("rate-drops") or 0
        refresh = ps.get("refresh-ns") or 0
        content = 1e9 / arm["fps"]
        if "phases" in arm:
            # B-175 as built: the cap set live; what the pace drops and holds in each phase.
            rows = [(t, p.get("rate-drops", 0), p.get("present-lateness-ns", 0) / 1e6) for t, p in pl.paces()]
            ph = []
            for lo, hi in arm["phases"]:
                inside = [r for r in rows if t0 + lo * S <= r[0] < t0 + hi * S]
                ph.append((round((inside[-1][1] - inside[0][1]) / max((inside[-1][0] - inside[0][0]) / S, 1), 1),
                           round(inside[0][2]), round(inside[-1][2])) if len(inside) > 1 else None)
            capped, after = ph[1], ph[2]
            check(f"{label}: [drops/s, lateness from, to ms] per phase {ph}: drops while capped, none once "
                  f"restored, the lateness flat after it (within {x['flat_ms']} ms)",
                  None not in ph and ph[0][0] == 0 and capped[0] > 0 and after[0] == 0
                  and abs(after[2] - after[1]) <= x["flat_ms"])
            if capped[2] - capped[1] > x["flat_ms"]:
                print(f"    {label}: Found (B-174): the achieved period never measured with the cap set live "
                      f"(achieved {ps.get('achieved-ns')} ns); lateness {capped[1]} -> {capped[2]} ms while capped, "
                      f"kept after the restore")
            continue
        series = [(t, p.get("released", 0) + p.get("rate-drops", 0), p.get("rate-drops", 0),
                   p.get("present-lateness-ns", 0) / 1e6) for t, p in pl.paces()]
        frm = next((r for r in series if r[2] > 0), None) if arm.get("from_first_drop") else \
            next((r for r in series if r[0] >= t0 + x["settle_s"] * S), None)
        tail = [r for r in series if frm and r[0] >= frm[0]]
        frames = tail[-1][1] - tail[0][1] if len(tail) > 1 else 0
        drops = tail[-1][2] - tail[0][2] if len(tail) > 1 else None
        want = frames * max(0.0, 1 - content / refresh) if refresh else None
        lat = [r[3] for r in tail]
        check(f"{label}: the refresh measured ({ps.get('refresh-source')} {refresh} ns, want "
              f"{arm['refresh_ns']} ± {x['refresh_tol_ns']}); from {frm and sec(frm[0], t0)} s: rate drops "
              f"{drops} = the deficit {want and round(want, 2)} ± 1 of {frames} frames (a faster display: none, "
              f"{ps.get('rate-drops')} in all), the release lateness flat "
              f"({orig.spread(lat)} ms, within {x['flat_ms']}); presented {ds.get('presented')} of {released}",
              ps.get("refresh-source") == "measured" and abs(refresh - arm["refresh_ns"]) <= x["refresh_tol_ns"]
              and want is not None and drops is not None and abs(drops - want) <= 1
              and (refresh >= content or (drops == 0 and ps.get("rate-drops") == 0))
              and abs(released - (ds.get("presented") or 0)) <= 2 and orig.spread(lat) is not None
              and orig.spread(lat) <= x["flat_ms"])
        if arm.get("from_first_drop") and frm:
            before = [r[3] for r in series if r[0] < frm[0] and r[0] >= t0 + 3 * S]
            print(f"    {label}: Found (B-174): the first rate drop at {sec(frm[0], t0)} s, the lateness "
                  f"{orig.mid(before[:1])} -> {orig.mid(before[-1:])} ms before it (S11 wants it flat from the "
                  "measure)")


def player_run(argv, exp, sets=()):
    """The player alone on a generated feed; `sets`: [(at_s, (element, property, value))] set live."""
    run = Run(argv)
    rel = rig.generated(exp["kind"], exp["seconds"] + 2)
    run.rel, run.pids = rel, orig.stream_pids(rel)
    run.producer("feed", ["vp"], ts=lambda t0: orig.at_house(rel, t0), stop_s=exp["seconds"])
    pl = run.output("player", exp.get("player") or "player50", video=orig.display(**exp["display"]))
    run.go(exp["seconds"] + 1, [(a, (lambda v=v: pl.set_prop(*v))) for a, v in sets],
           [("player", "vp_pace", "stats"), ("player", "sink", "display-stats")])
    pl.reads = {"pace": run.reads.get(("player", "vp_pace", "stats")),
                "display": run.reads.get(("player", "sink", "display-stats"))}
    return run


def scn_out_capacity(tag, argv, exp):
    """A decoder slower than real time (one thread, an identity throttle after it): the lateness
    rising, nothing lost until vp_esq is full (its queue_overrun, held back, not leaky), then the bus
    ingress backstop's drop."""
    label, x = f"{exp['scenario']} {tag}", exp["expect"]
    seconds = exp["gate_seconds"] if orig.GATE else exp["seconds"]
    kind = exp["gate_kind"] if orig.GATE else exp["kind"]

    def edit(p):
        p = p.replace("max-threads=3", "max-threads=1")
        p = p.replace(" ! videoconvert ! videoscale ! mrvideopace", f" ! identity sleep-time={exp['sleep_us']}"
                      " ! videoconvert ! videoscale ! mrvideopace")
        if MUTANT == "leaky-esq":
            p = p.replace("queue name=vp_esq leaky=0", "queue name=vp_esq leaky=2")
        return p
    run = Run(argv)
    rel = rig.generated(kind, seconds + 2)
    run.producer("feed", ["vp"], ts=lambda t0: orig.at_house(rel, t0), stop_s=seconds)
    run.output("player", "player50", video=orig.display(), edit=edit)
    run.go(seconds + 1, (), [("player", "vp_pace", "stats"), ("player", "sink", "display-stats")])
    run.on_time(label)
    run.clean(label)
    pl, t0 = run.outputs["player"], run.t0
    ps = run.reads.get(("player", "vp_pace", "stats")) or {}
    rows = [(round((t - t0) / S, 1), p.get("present-lateness-ns", 0) / 1e6) for t, p in pl.paces()]
    ev = episodes(pl, t0)
    first = ev[0] if ev else None
    backstop = next((e for e in ev if e[2]), None)
    upto = [v for s_, v in rows if x["rising_from_s"] <= s_ <= (backstop[0] if backstop else seconds)]
    rising = all(b_ >= a_ for a_, b_ in zip(upto, upto[1:]))
    check(f"{label}: nothing lost until vp_esq is full: its episode first, held back, at its 5 s ({first}), "
          f"then the bus ingress backstop drops ({backstop}); the lateness rising all the way to it "
          f"({upto[:1]} -> {upto[-1:]} ms; episodes {ev[:4]})",
          first is not None and first[1] == "vp_esq" and not first[2] and first[3] >= x["full_level_ms"]
          and first[0] >= x["full_after_s"] and backstop is not None and backstop[0] > first[0]
          and rising and len(upto) >= 10)


def scn_out_av_after_mux(tag, argv, exp):
    """H.264 + AAC through the real muxer string, then the player and the audio decoder on its bus
    tee: video and audio reach the display and the card within V-P4-5's bound of each other."""
    label, x = f"{exp['scenario']} {tag}", exp["expect"]
    run = Run(argv)
    rel = rig.generated(exp["kind"], exp["seconds"] + 2)
    run.producer("feed", ["mx0"], ts=lambda t0: orig.at_house(rel, t0), stop_s=exp["seconds"])
    run.output("mux", "mux1")
    run.output("player", "player50", video=orig.display())
    run.output("decoder", "decoder", audio=orig.card())
    run.go(exp["seconds"] + 1, (), [("player", "vp_pace", "stats"), ("player", "sink", "display-stats")],
           lead_ms=5000, before=["mux"])
    run.on_time(label)
    run.clean(label)
    pl, dec, t0 = run.outputs["player"], run.outputs["decoder"], run.t0
    v = paces(pl, t0, x["settle_s"], exp["seconds"] + 1)
    a = renders(dec, t0, x["settle_s"], exp["seconds"] + 1)
    skew = orig.mid(v) - orig.mid(a) if v and a else None
    check(f"{label}: video {orig.mid(v)} ms and audio {orig.mid(a)} ms late at their devices after the muxer: "
          f"A/V {skew} ms (within ±{x['av_ms']}), each flat ({orig.spread(v)}, {orig.spread(a)} ms; within "
          f"{x['video_flat_ms']}, {x['flat_ms']})",
          skew is not None and abs(skew) <= x["av_ms"] and orig.spread(v) <= x["video_flat_ms"]
          and orig.spread(a) <= x["flat_ms"])
    pl.reads = {"pace": run.reads.get(("player", "vp_pace", "stats")),
                "display": run.reads.get(("player", "sink", "display-stats"))}
    video_ok(f"{label} player", pl, x)


def scn_asrc_out_drift(tag, argv, exp):
    """The 302M mixer's egress recording, looped, into Audio Output (302M) on a card 100 ppm fast:
    the device term holds render lateness (drift under 2 ms over 30 min of stream time; CI: the same
    slope bound over its run), no underrun after the prefill."""
    label, x = f"{exp['scenario']} {tag}", exp["expect"]
    seconds = exp["gate_seconds"] if orig.GATE else exp["seconds"]
    whole = orig.chunked(orig.looped(*loop_of(orig.fixture(exp["fixture"]), exp["pid"], seconds)))
    run = Run(argv)
    run.producer("feed", ["ao"], ts=lambda t0: orig.at_house(whole, t0), stop_s=seconds)
    run.output("aout", "aout302m", audio=orig.card(ppm=exp["ppm"]))
    run.go(seconds + 1, (), [("aout", "sink", "resyncs"), ("aout", "sink", "renders")])
    run.on_time(label)
    run.clean(label)
    ao, t0 = run.outputs["aout"], run.t0
    stats = ao.asrc_stats()
    engaged = next((t for t, p in stats if p.get("device-ppb")), None)
    rows = [(t, p.get("render-lateness-ns") / 1e6) for t, p in stats
            if p.get("render-lateness-ns") and t >= t0 + x["settle_s"] * S]
    st = last(stats)
    diffs = [(b_[0], b_[1] - a_[1]) for a_, b_ in zip(rows, rows[1:])]
    steps = [(sec(t, t0), round(d, 1)) for t, d in diffs if abs(d) > x["step_ms"]]
    span = (rows[-1][0] - rows[0][0]) / S if len(rows) > 1 else 0
    trend = sum(d for _t, d in diffs if abs(d) <= x["step_ms"]) / span if span else None
    over = trend * 1800 if trend is not None else None
    ppm = (st.get("device-ppb") or 0) / 1000
    check(f"{label}: the device term on the card's {exp['ppm']} ppm ({ppm} ppm, engaged at "
          f"{engaged and sec(engaged, t0)} s, by {x['engaged_by_s']} s), render lateness "
          f"{orig.mid([v for _t, v in rows])} ms, "
          f"its trend {over and round(over, 2)} ms over 30 min (within {x['drift_ms_30min']}) from "
          f"{x['settle_s']} s, between steps", engaged is not None and engaged <= t0 + x["engaged_by_s"] * S
          and abs(ppm - exp["ppm"]) <= x["ppm_tol"] and over is not None and abs(over) <= x["drift_ms_30min"]
          and st.get("state") == "locked")
    resyncs = run.reads.get(("aout", "sink", "resyncs"))
    check(f"{label}: nothing dropped or lost by the ASRC (dropped {st.get('dropped-frames')}, gaps {st.get('gaps')}, "
          f"relocks {st.get('relocks')}), no queue full ({overruns(ao)})",
          st.get("dropped-frames") == 0 and st.get("gaps") == 0 and st.get("relocks") == 0 and not overruns(ao))
    if steps or (resyncs or 0) > x["resyncs"]:
        print(f"    {label}: Found (B-174): render lateness steps {steps} ms after the lock, the card's resyncs "
              f"{resyncs} (its start's {x['resyncs']}); the device term engaged at {engaged and sec(engaged, t0)} s")
    if orig.GATE:
        check(f"{label}: MR_GATE: no underrun after the prefill (resyncs {resyncs}), no step ({steps})",
              resyncs == x["resyncs"] and not steps)


def scn_out_stop_backpressure(tag, argv, exp):
    """T26 (MR-041): each output stopped with its queues full (a throttled stage or an input stall's
    backlog fills them; a stalled card skips, Q2): the runner exits on its own inside the engine's
    kill window. Each stop's time is printed at the end."""
    x = exp["expect"]
    for arm in exp["arms"]:
        if arm.get("python_only") and tag != "py":
            continue
        label = f"{exp['scenario']} {arm['name']} {tag}"
        run = Run(argv)
        hold = rig.Knobs(silence=[(arm["hold"][0], arm["hold"][1], "hold")]) if arm.get("hold") else None
        if arm.get("fixture"):
            data = orig.fixture(arm["fixture"])
            whole = orig.chunked(orig.looped(*loop_of(data, arm["pid"], exp["seconds"])))
            run.producer("feed", [arm["socket"]], ts=lambda t0, w=whole: orig.at_house(w, t0), stop_s=exp["seconds"],
                         knobs=hold)
        else:
            rel = rig.generated(arm["kind"], exp["seconds"] + 2)
            run.producer("feed", [arm["socket"]], ts=lambda t0, rel=rel: orig.at_house(rel, t0), stop_s=exp["seconds"],
                         knobs=hold)
        if arm.get("cues"):
            klv = orig.chunked(orig.fixture("cap-klv-sparse.ts"))
            run.producer("cues", ["subs"], ts=lambda t0, k=klv: orig.at_house(k, t0), stop_s=exp["seconds"])
        edit = None
        if arm.get("throttle"):
            at, us = arm["throttle"]
            edit = (lambda p, at=at, us=us: p.replace(at, f"{at}identity sleep-time={us} ! ", 1))
        o = run.output("out", arm["entry"], video=orig.display(), audio=orig.card(), edit=edit)
        run.go(exp["seconds"], (), [("out", q, "current-level-time") for q, _ms in arm["full"]])
        levels = {q: (lambda v: v // MS if isinstance(v, int) else v)(run.reads.get(("out", q, "current-level-time")))
                  for q, _ms in arm["full"]}
        check(f"{label}: PLAYING, then stopped with its queues full ({levels} ms; want {arm['full']}): the runner "
              f"exits on its own in {o.stop_ms} ms, rc {o.rc} (the engine kills at {x['kill_ms']} ms; errors "
              f"{o.errors()[:1]})", o.playing is not None and not o.errors() and o.rc == 0
              and o.stop_ms is not None and o.stop_ms < x["kill_ms"]
              and all(isinstance(levels[q], int) and levels[q] >= ms for q, ms in arm["full"]))
        _stop_times.append((label, o.stop_ms))


def loop_of(data, pid, seconds):
    """`data` cut before its last PES of `pid` (a trim may cut it short), and the laps of it that
    cover `seconds`: (data, laps, lap ticks)."""
    starts = orig.pes_starts(data, pid)
    lap = starts[-1][0] - starts[0][0]
    data = data[:starts[-1][1] * 188]
    return data, int(seconds * 90000 // lap) + 2, lap


_stop_times = []


def scn_burnin_late_cues(tag, argv, exp):
    """WI-P4-9's check (S29): the Video Transcoder's burn-in with every cue 1.4 s late (cap-klv-sparse
    moved by rebase, its chunks sent 1.4 s after their PES): the pace group rises to the cues'
    lateness, no cue is dropped, the rendition plays on at its input PES times."""
    label, x = f"{exp['scenario']} {tag}", exp["expect"]
    sys.path.insert(0, os.path.join(rig.PLUGINS, "subtitle-core", "py"))
    import subtitle_klv  # noqa: E402
    run = Run(argv)
    rel = rig.generated(exp["kind"], exp["seconds"] + 2)
    cue_at, late = exp["cue_at_s"], exp["cue_late_ms"]
    tmp = run.dir.path

    def cues(t0):
        out = os.path.join(tmp, "klv.ts")
        subprocess.run([orig.MRTS_CLI, "rebase", os.path.join(orig.FIXTURE_DIR, "cap-klv-sparse.ts"), out,
                        "--to-ns", str(t0 + int(cue_at * S))], check=True, capture_output=True)
        with open(out, "rb") as fh:
            data = fh.read()
        return pes_ready(data, t0, exp["seconds"])
    run.producer("video", ["video"], ts=lambda t0: orig.at_house(rel, t0), stop_s=exp["seconds"])
    run.producer("cues", ["subs"], ts=cues, stop_s=exp["seconds"] + late / 1000,
                 knobs=rig.Knobs(delay_ms=late))
    o = run.output("tc", "burnin")
    tee = re.search(r"tee name=(busout_\d+)", o.start_cmd["pipeline"]).group(1)
    cons = {}

    def attach():
        sock = run.dir.sock("egress")
        o.runner.attach(tee, sock)
        cons["c"] = rig.Consumer(sock)
        cons["c"].start()
    try:
        run.go(exp["seconds"] + late / 1000 + 2, [(0.5, attach)])
    finally:
        if "c" in cons:
            cons["c"].stop()
    run.on_time(label)
    run.clean(label, replays=("tc",))
    t0 = run.t0
    watches = {}
    for t, p in o.runner.plugin("mralignwatch:"):
        watches.setdefault(p.get("input"), []).append((t, p))
    cue_w = watches.get("cues", [])
    pace = [p.get("pace", 0) / 1e6 for _t, p in cue_w[-5:]]
    behind = max((p.late_ns for p in run.producers), default=0) / 1e6
    check(f"{label}: the pace rises to the cues' {late} ms (last paces {[round(v) for v in pace]} ms, the feed "
          f"{behind:.0f} ms behind at worst), never absent "
          f"({[p.get('state') for _t, p in cue_w if p.get('state') == 'absent'][:1]})",
          len(pace) == 5 and all(late - 50 <= v <= late + behind + x["pace_over_ms"] for v in pace)
          and all(p.get("state") != "absent" for _t, p in cue_w))
    sent = b"".join(d for _a, _s, d in run.producers[1].delivered)
    owed = overlay_owed(klv_pes(sent, t0), subtitle_klv)
    lines = [m for line in o.runner.logs for m in [_BURNIN_LINE.search(line)] if m]
    got = [(m.group(1), m.group(2) or "") for m in lines]
    want = [(k, repr(t.replace("\n", " / ")[:60]) if t else "") for _t, k, t in owed]
    check(f"{label}: every cue and clear owed is drawn, in order, none dropped ({len(got)} drawn of "
          f"{len(want)} owed)", len(want) >= x["owed_min"] and got == want)
    egress = cons.get("c")
    vpes = [p for lst in rig.pes_of(egress.records).values() for p in lst
            if p["pts"] is not None and (p["sid"] & 0xF0) == 0xE0] if egress else []
    after = [p["pts"] for p in vpes if p["arrival"] >= t0 + int(x["settled_s"] * S)]
    steps = sorted({(b - a) % rig.WRAP for a, b in zip(after, after[1:])})
    check(f"{label}: the rendition plays on once settled, one frame a step ({len(after)} frames; steps "
          f"{steps[:4]} ticks)", len(after) >= x["frames_min"] and steps == [3600])


_BURNIN_LINE = re.compile(r"\[subtitle_bridge\] (show|clear) (?:('.*'|\".*\") )?cueLate=(-?\d+)\b"
                          r"(?:.* margin=(-?\d+))?.* t0src=(\S+)$")


def pes_ready(data, t0, seconds, pid=None):
    """`data` in 1316-byte chunks, each due when its newest PES is (PES - 1 h, near `t0`): a cue
    track's content time; the chunks past `seconds` left out."""
    out, newest = [], t0
    for i in range(0, len(data), 1316):
        chunk = data[i:i + 1316]
        for pkt in rig.ts_psi.iter_packets(chunk):
            pts = rig.ts_psi.read_pes_pts(pkt)
            if pts is not None:
                newest = max(newest, rig.ts_timeline.house_from_mux_pts(pts, t0))
        if newest - t0 >= seconds * S:
            break
        out.append((chunk, newest))
    return out


def klv_pes(data, ref_ns, pid=0x180):
    """[(house ns, KLV payload)] per PES of `pid`, as mrtsdemux reads it."""
    out, cur = [], None
    for pkt in rig.ts_psi.iter_packets(data):
        if rig.ts_psi.ts_pid(pkt) != pid:
            continue
        payload = pkt[rig.ts_psi.payload_offset(pkt):]
        if pkt[1] & 0x40:
            if cur:
                out.append(cur)
            cur = [rig.ts_timeline.house_from_mux_pts(rig.ts_psi.read_pes_pts(pkt), ref_ns),
                   bytearray(payload[9 + payload[8]:])]
        elif cur:
            cur[1] += payload
    return [(t, bytes(p)) for t, p in out + ([cur] if cur else [])]


def overlay_owed(pes, subtitle_klv):
    """The show and clear lines the overlay owes `pes` by its rules (burnin-formula's): a copy within
    2.5 s of its payload's last is a re-send; a cue shows from its PES time plus its start until its
    end or the next cue; a clear clears. [(house ns, 'show' | 'clear', text)]."""
    seen, out, shown = {}, [], None
    for t, payload in pes:
        rel, prev = subtitle_klv.decode_cue(payload), seen.get(payload)
        seen[payload] = t
        if rel is None or (prev is not None and t - prev <= 2_500_000_000):
            continue
        start, end, text = t + rel[0] * MS, t + rel[1] * MS, rel[2]
        if shown and shown[1] <= start:
            out.append((shown[1], "clear", ""))
            shown = None
        if text:
            if not shown or shown[0] != text:
                out.append((start, "show", text))
            shown = (text, end)
        elif shown:
            out.append((start, "clear", ""))
            shown = None
    return out


# --------------------------------------------------------------------------- scn-out-wrap
def wrap_house_ns(after_ns):
    """The first house time after `after_ns` where a mux PES PTS (house + 1 h) wraps 2^33."""
    k = (after_ns * 9 // 100000 + rig.MUX_BASE) // rig.WRAP + 1
    return -(-(k * rig.WRAP - rig.MUX_BASE) * 100000 // 9)


def scn_out_wrap(tag, argv, exp):
    """The house clock crosses the PES field's 2^33 wrap mid-run (a time namespace): the player and
    the decoder play through it, no demux gap, their lateness flat, no frame or sample lost."""
    label, x = f"{exp['scenario']} {tag}", exp["expect"]
    run = av_run(argv, exp)
    run.on_time(label)
    tw = wrap_house_ns(run.t0)
    check(f"{label}: the 33-bit wrap falls inside the run ({sec(tw, run.t0)} s)",
          x["wrap_after_s"][0] <= sec(tw, run.t0) <= x["wrap_after_s"][1])
    run.clean(label)
    pl, dec, t0 = run.outputs["player"], run.outputs["decoder"], run.t0
    gaps = (demux_last(pl).get("gaps"), demux_last(dec).get("gaps"))
    st = last(dec.asrc_stats())
    moves = {}
    for name_, series, key in (("video", pl.paces(), "present-lateness-ns"),
                               ("audio", dec.asrc_stats(), "render-lateness-ns")):
        rows = [(t, p.get(key, 0) / 1e6) for t, p in series if t >= t0 + x["from_s"] * S and p.get(key)]
        # A move belongs to the wrap when the wrap falls in the interval its report closes.
        moves[name_] = [(sec(b_[0], t0), round(b_[1] - a_[1], 1), a_[0] < tw + x["near_wrap_s"] * S <= b_[0]
                         or a_[0] <= tw < b_[0]) for a_, b_ in zip(rows, rows[1:]) if abs(b_[1] - a_[1]) > 1]
    at_wrap = [m[:2] for v in moves.values() for m in v if m[2]]
    # The shared host's one-unit steps (the pace's hold, up to two frames; an AU and a card segment)
    # fall anywhere, the wrap's report too; a wrap fault is a gap, a relock or a move past a unit.
    big = [(n, m[:2]) for n, v in moves.items() for m in v if abs(m[1]) > x["unit_ms"][n]]
    steps = sum(len(v) for v in moves.values())
    listed = {n: [m[:2] for m in v] for n, v in moves.items()}
    check(f"{label}: through the wrap ({sec(tw, t0)} s): no demux gap {gaps}, at most {x['late_steps']} "
          f"one-unit steps (video {x['unit_ms']['video']}, audio {x['unit_ms']['audio']} ms) in all "
          f"({listed}; across the wrap {at_wrap}), none past a unit "
          f"({big}); the ASRC never relocked ({st.get('relocks')}) or dropped ({st.get('dropped-frames')})",
          gaps == (0, 0) and not big and steps <= x["late_steps"]
          and st.get("relocks") == 0 and st.get("dropped-frames") == 0)
    video_ok(f"{label} player", pl, x)


def in_time_namespace(name, tag):
    """`name` on runner `tag` in a time namespace whose CLOCK_MONOTONIC puts the 33-bit PES wrap
    about 12 s after it starts (aligner_conformance_test.py's method); a fresh one per attempt."""
    if not shutil.which("unshare"):
        print(f"SKIP {name} {tag} — no unshare for a time namespace")
        return
    # The streams made here, so the namespace's clock reaches the wrap while the run plays.
    exp = orig.expectation(name)
    cache = os.path.join(orig._REGISTRY, "streams.pickle")
    with open(cache, "wb") as fh:
        pickle.dump({(exp["kind"], exp["seconds"] + 2): rig.generated(exp["kind"], exp["seconds"] + 2)}, fh)
    for attempt in range(3):
        while os.getloadavg()[0] >= 3.0:
            time.sleep(5)
        m = time.monotonic_ns()
        offset = (wrap_house_ns(m + 60 * S) - m) // S - 14
        ns = ["unshare", "-U", "-r", "-T", f"--monotonic={offset}"]
        probe = subprocess.run(ns + ["true"], capture_output=True, text=True, timeout=30)
        if probe.returncode != 0:
            print(f"SKIP {name} {tag} — no time namespace here ({(probe.stderr.strip() or '?').splitlines()[-1]})")
            return
        cmd = ns + [sys.executable, os.path.abspath(__file__), "--only", name, "--runner", tag, "--in-time-ns",
                    "--streams", cache]
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        lines = done.stdout.splitlines()
        for line in lines:
            if line.startswith(("PASS ", "FAIL ", "RETRY ", "SKIP ", "    ")):
                print(line, flush=True)
            if line.startswith("FAIL "):
                _failures.append(line[5:])
        if done.returncode == RETRY_RC:
            if attempt == 2:
                check(f"{name} {tag}: the harness fell behind, three runs in a row", False)
            continue
        if done.returncode != 0 and not any(l.startswith("FAIL ") for l in lines):
            check(f"{name} {tag}: the time-namespace run exits 0 (rc {done.returncode}: "
                  f"{done.stderr.strip()[-300:]})", False)
        return


SCENARIOS = {
    "scn-out-stall": scn_out_stall,
    "scn-out-gap-recovers": scn_out_gap_recovers,
    "scn-out-av-after-mux": scn_out_av_after_mux,
    "scn-out-video-only": scn_out_video_only,
    "scn-out-rate-50p-60hz": scn_out_rate,
    "scn-out-rate-60p-50hz": scn_out_rate,
    "scn-out-rate-drift": scn_out_rate,
    "scn-out-wrap": scn_out_wrap,
    "scn-asrc-out-drift": scn_asrc_out_drift,
    "scn-out-capacity": scn_out_capacity,
    "scn-out-device-stall": scn_out_device_stall,
    "scn-out-stop-backpressure": scn_out_stop_backpressure,
    "scn-burnin-late-cues": scn_burnin_late_cues,
}
_NEEDS = ("unixfdsrc", "unixfdsink", "mpegtsmux", "x264enc", "avdec_h264", "h264parse", "avenc_aac", "avdec_aac",
          "aacparse", "avdec_s302m", "textoverlay")


def main():
    global MUTANT
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--runner", default="")
    ap.add_argument("--mutant", default="")
    ap.add_argument("--in-time-ns", action="store_true")
    ap.add_argument("--streams", default="")
    args = ap.parse_args()
    if args.streams:
        with open(args.streams, "rb") as fh:
            rig._GENERATED.update(pickle.load(fh))
    MUTANT = args.mutant or None
    if not os.path.exists(_HOUSE_SO):
        print(f"SKIP output_conformance_test.py — {_HOUSE_SO} not built (make native)")
        return 0
    if not orig.have_test_sinks():
        print("SKIP output_conformance_test.py — the test sinks are not built (make native-test)")
        return 0
    lack = [e for e in _NEEDS if Gst.ElementFactory.find(e) is None]
    if lack:
        print(f"SKIP output_conformance_test.py — {', '.join(lack)} unavailable")
        return 0
    names = [n for n in (args.only.split(",") if args.only else SCENARIOS) if n]
    runners = [r for r in args.runner.split(",") if r] or None
    kinds = rig.runner_kinds(runners)
    if not os.path.exists(rig.NATIVE_BIN):
        print(f"SKIP native runner — {rig.NATIVE_BIN} not built (make native); python runner only")
    for name in names:
        exp = orig.expectation(name)
        if not args.in_time_ns:
            print(f"\n--- {name}: {exp['graph']}", flush=True)
        if name == "scn-out-wrap" and not args.in_time_ns:
            for tag, _argv in kinds:
                in_time_namespace(name, tag)
            continue
        for tag, argv in kinds:
            if exp.get("python_only") and tag != "py":
                print(f"SKIP {name} {tag} — the module runs on the python runner (its bridge)")
                continue
            for attempt in range(3):
                while not args.in_time_ns and os.getloadavg()[0] >= 3.0:
                    time.sleep(5)
                try:
                    SCENARIOS[name](tag, argv, exp)
                    break
                except Retry as late:
                    print(f"RETRY {late}", flush=True)
                    if args.in_time_ns:
                        return RETRY_RC
                    if attempt == 2:
                        check(f"{late}, three runs in a row", False)
    if _stop_times:
        print(f"    stop times under backpressure (ms): {_stop_times}")
    if _failures:
        print(f"\n{len(_failures)} FAILED: {_failures}")
        return 1
    print("\noutput_conformance_test.py: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
