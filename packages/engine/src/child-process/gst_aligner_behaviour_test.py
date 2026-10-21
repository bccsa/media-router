#!/usr/bin/env python3
"""Aggregator behaviour the aligner model rests on, pinned on GStreamer 1.28.2 (WI-P2-1).

Plan chapter 6 part 4.3 runs audiomixer, audiointerleave and mpegtsmux non-live (latency 0, no
force-live) with every input answering LATENCY as non-live, as mralignwatch will (WI-P2-6).
Here each live appsrc input sits behind an identity whose src-pad probe gives that answer.
Pinned: (1) an input 3 s late is waited for, nothing dropped or silence-filled; (2) how far a
GAP moves each aggregator; (3) a pad added while PLAYING is waited for; (4) what becomes of a
buffer that ends before the output position; (5) start-time-selection=first at 600 h; (6) EOS
on every input ends the stream, no free-run. Control arms show the checks can fail.

Skips (exit 0) without GStreamer or the elements.
"""
import array
import sys
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_aligner_behaviour_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

Gst.init(sys.argv)
for _f in ("audiomixer", "audiointerleave", "mpegtsmux", "appsrc", "identity", "fakesink"):
    if Gst.ElementFactory.find(_f) is None:
        print(f"SKIP gst_aligner_behaviour_test.py — {_f} unavailable")
        sys.exit(0)

MS, S = Gst.MSECOND, Gst.SECOND
NONE = Gst.CLOCK_TIME_NONE
RATE, BLOCK = 48000, 480        # 10 ms buffers, the aggregators' default output block
HOUR = 3600 * S
MUX_BASE_90K, WRAP = 90000 * 3600, 1 << 33   # mpegtsmux writes running time + 1 h, 33-bit
PID0 = 101
DISCONT = Gst.BufferFlags.DISCONT
NONLIVE = "force-live=false latency=0 start-time-selection=first"
# mpegtsmux has no force-live in 1.28.2; non-live upstream alone makes it non-live.
AGG = {"audiomixer": f"audiomixer {NONLIVE}", "audiointerleave": f"audiointerleave {NONLIVE}",
       "mpegtsmux": "mpegtsmux latency=0"}
CAPS = {"audiomixer": "audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved",
        "audiointerleave": "audio/x-raw,format=F32LE,rate=48000,channels=1,layout=interleaved",
        "mpegtsmux": "audio/x-smpte-302m"}
KLV = "meta/x-klv,parsed=(boolean)true"
VAL = (1000, 100, 10)           # input i's constant sample value; a mix names its contributors
STALE = 7
KINDS = ("audiomixer", "audiointerleave", "mpegtsmux")

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def pts90(rt):
    return (rt * 90000 // S + MUX_BASE_90K) % WRAP


def payload(i, k):
    return (bytes([0x41 + i]) + k.to_bytes(2, "big")) * 32


def want(kind, *vals):
    """The output frame of a mix whose inputs carry vals (0 = silent)."""
    if kind == "audiomixer":
        return (sum(vals),) * 2
    return tuple(float(v) for v in vals)


class Rig:
    """Live appsrc inputs, each behind a harness identity, into one aggregator on the house
    clock (monotonic system clock, base_time 0, as both runners run it)."""

    def __init__(self, kind, n=2, harness=True, agg=None, caps=None, qos=False, keep=True):
        self.kind, self.qos, self.keep = kind, qos, keep
        self.srcs, self.answers, self.out, self.msgs = [], [], [], []
        self.pipe = Gst.parse_launch(f"{agg or AGG[kind]} name=agg ! fakesink sync=false async=false")
        self.agg = self.pipe.get_by_name("agg")
        self.pipe.use_clock(Gst.SystemClock.obtain())
        self.pipe.set_start_time(NONE)
        self.pipe.set_base_time(0)
        self.pipe.get_bus().set_sync_handler(self._on_msg)
        self.agg.get_static_pad("src").add_probe(
            Gst.PadProbeType.BUFFER | Gst.PadProbeType.BUFFER_LIST, self._on_out)
        for c in caps or [CAPS[kind]] * n:
            self.add(c, harness)
        self.pipe.set_state(Gst.State.PLAYING)
        self.pipe.get_state(5 * S)
        self.t0 = self.pipe.get_clock().get_time() // (10 * MS) * (10 * MS)

    def _answer(self, _pad, info):
        q = info.get_query()
        if q.type != Gst.QueryType.LATENCY:
            return Gst.PadProbeReturn.OK
        # PyGObject hands a probe a shared, read-only query; the per-pad query the aggregator
        # sends is fresh (gstpad.c query_latency_default_fold), so it already holds this answer.
        if q.is_writable():
            q.set_latency(False, 0, NONE)
        self.answers.append(tuple(q.parse_latency()))
        return Gst.PadProbeReturn.HANDLED

    def _on_msg(self, _bus, m):
        rec = (m.type, m.src.get_name() if m.src else None)
        if m.type == Gst.MessageType.QOS:
            rec += (m.parse_qos_stats()[2],)
        self.msgs.append(rec)
        return Gst.BusSyncReply.DROP

    def _on_out(self, pad, info):
        if info.type & Gst.PadProbeType.BUFFER_LIST:
            lst = info.get_buffer_list()
            bufs = [lst.get(i) for i in range(lst.length())]
        else:
            bufs = [info.get_buffer()]
        # Frames from size and caps: a live mixer's last buffer can carry a wrapped duration.
        caps, bpf = pad.get_current_caps(), 0
        if caps and self.kind != "mpegtsmux":
            bpf = caps.get_structure(0).get_int("channels")[1] * (2 if self.kind == "audiomixer" else 4)
        for b in bufs:
            data = b.extract_dup(0, b.get_size()) if self.keep else b""
            self.out.append((b.pts, b.get_size() // bpf if bpf else 0, int(b.get_flags()), data))
        return Gst.PadProbeReturn.OK

    def add(self, caps=None, harness=True):
        """One more input; requested while PLAYING when the rig already runs."""
        i, mux = len(self.srcs), self.kind == "mpegtsmux"
        src, ident = Gst.ElementFactory.make("appsrc"), Gst.ElementFactory.make("identity")
        for prop, v in (("is-live", True), ("format", Gst.Format.TIME), ("max-bytes", 0),
                        ("caps", Gst.Caps.from_string(caps or CAPS[self.kind]))):
            src.set_property(prop, v)
        if harness:
            ident.get_static_pad("src").add_probe(Gst.PadProbeType.QUERY_UPSTREAM, self._answer)
        self.pipe.add(src)
        self.pipe.add(ident)
        src.link(ident)
        pad = self.agg.request_pad(self.agg.get_pad_template("sink_%d" if mux else "sink_%u"),
                                   f"sink_{PID0 + i}" if mux else f"sink_{i}", None)
        if self.qos:
            pad.set_property("qos-messages", True)
        ident.get_static_pad("src").link(pad)
        ident.sync_state_with_parent()
        src.sync_state_with_parent()
        self.srcs.append(src)

    def push(self, i, pts, frames=BLOCK, value=None, data=None, flags=0):
        if data is None:
            v = VAL[i] if value is None else value
            data = (array.array("h", [v] * 2 * frames) if self.kind == "audiomixer"
                    else array.array("f", [float(v)] * frames)).tobytes()
        b = Gst.Buffer.new_wrapped(data)
        b.pts, b.dts, b.duration = pts, NONE, frames * S // RATE
        if flags:
            b.set_flags(flags)
        self.srcs[i].emit("push-buffer", b)

    def run(self, i, k0, k1, value=None, at_ms=0):
        """Input i's 10 ms buffers k0..k1-1 at t0 + at_ms + k * 10 ms."""
        for k in range(k0, k1):
            pts = self.t0 + (at_ms + k * 10) * MS
            if self.kind == "mpegtsmux":
                self.push(i, pts, data=payload(i, k))
            else:
                self.push(i, pts, value=value)

    def gap(self, i, start_ms, dur_ms):
        self.srcs[i].send_event(Gst.Event.new_gap(self.t0 + start_ms * MS, dur_ms * MS))

    def eos(self, *which):
        for i in which or range(len(self.srcs)):
            self.srcs[i].emit("end-of-stream")

    def wait(self, pred, cap_s=3.0):
        end = time.monotonic() + cap_s
        while not pred() and time.monotonic() < end:
            time.sleep(0.02)
        return pred()

    def wait_eos(self, cap_s=3.0):
        return self.wait(lambda: any(m[0] == Gst.MessageType.EOS for m in self.msgs), cap_s)

    def errors(self):
        return [m for m in self.msgs if m[0] == Gst.MessageType.ERROR]

    def dropped(self):
        """Samples the aggregator reported dropped (QoS), per sink pad."""
        res = {}
        for m in self.msgs:
            if m[0] == Gst.MessageType.QOS:
                res[m[1]] = res.get(m[1], 0) + m[2]
        return res

    def reach(self):
        """ms from t0 that the output covers: audio end, or the last PES of input 0."""
        if self.kind == "mpegtsmux":
            lst = self.pes().get(PID0, [])
            return (lst[-1][0] - pts90(self.t0)) % WRAP / 90 if lst else None
        out = list(self.out)
        return (out[-1][0] + out[-1][1] * S // RATE - self.t0) / MS if out else None

    def settle(self, at_ms):
        """Wait for the output to reach at_ms, then 300 ms more; where it really stopped."""
        self.wait(lambda: (self.reach() or 0) >= at_ms)
        time.sleep(0.3)
        return self.reach()

    def spans(self):
        """Run-length [(start ms, end ms, frame)] of the audio output, from t0."""
        fmt, res = ("h" if self.kind == "audiomixer" else "f"), []
        for pts, nf, _f, data in list(self.out):
            v = array.array(fmt, data)
            if not nf:
                continue
            nch, off = len(v) // nf, round((pts - self.t0) * RATE / S)
            for j in range(nf):
                fr = tuple(v[j * nch:(j + 1) * nch])
                if res and res[-1][2] == fr and res[-1][1] == off + j:
                    res[-1][1] += 1
                else:
                    res.append([off + j, off + j + 1, fr])
        return [(a / 48, b / 48, fr) for a, b, fr in res]

    def pes(self, out=None):
        """{pid: [(pts90k, payload)]} of the mux output."""
        data, cur, res = b"".join(o[3] for o in (self.out if out is None else out)), {}, {}
        for off in range(0, len(data) - 187, 188):
            p = data[off:off + 188]
            pid, afc = ((p[1] & 0x1F) << 8) | p[2], (p[3] >> 4) & 3
            if pid < PID0 or pid > PID0 + 8 or not afc & 1:
                continue
            body = p[5 + p[4]:] if afc == 3 else p[4:]
            if p[1] & 0x40:
                if pid in cur:
                    res.setdefault(pid, []).append(cur.pop(pid))
                h = body[9:14]
                pts = (((h[0] >> 1) & 7) << 30 | h[1] << 22 | (h[2] >> 1) << 15 | h[3] << 7 | h[4] >> 1
                       if body[7] & 0x80 else None)
                cur[pid] = (pts, bytearray(body[9 + body[8]:]))
            elif pid in cur:
                cur[pid][1].extend(body)
        for pid, v in cur.items():
            res.setdefault(pid, []).append(v)
        return {pid: [(t, bytes(d)) for t, d in v] for pid, v in res.items()}

    def pes_ok(self, i, ks, at_ms=0):
        """Input i's PES are exactly its buffers ks: PTS = running time + 1 h, payload intact."""
        want_pes = [(pts90(self.t0 + (at_ms + k * 10) * MS), payload(i, k)) for k in ks]
        return self.pes().get(PID0 + i, []) == want_pes

    def agg_live(self):
        q = Gst.Query.new_latency()
        return bool(self.agg.get_static_pad("src").query(q) and q.parse_latency()[0])

    def stop(self):
        self.pipe.set_state(Gst.State.NULL)


def plugin_version(name):
    p = Gst.ElementFactory.find(name).get_plugin()
    return f"{p.get_version()} ({p.get_filename()})"


print(f"{Gst.version_string()}; audiomixer plugin {plugin_version('audiomixer')}; "
      f"mpegtsmux plugin {plugin_version('mpegtsmux')}")

print("\n--- defaults the aligner model keeps or overrides (R-P2-7) ---")
for f in ("audiomixer", "audiointerleave"):
    e = Gst.ElementFactory.make(f)
    check(f"{f}: alignment-threshold default 40 ms", e.get_property("alignment-threshold") == 40 * MS)
    check(f"{f}: discont-wait default 1 s", e.get_property("discont-wait") == S)
    check(f"{f}: output block (output-buffer-duration) 10 ms",
          e.get_property("output-buffer-duration") == 10 * MS)
    check(f"{f}: force-live off and latency 0 by default",
          e.get_property("force-live") is False and e.get_property("latency") == 0)
    check(f"{f}: start-time-selection defaults to zero, so the aligners must set first",
          int(e.get_property("start-time-selection")) == 0)
mux = Gst.ElementFactory.make("mpegtsmux")
check("mpegtsmux: no force-live property; latency 0 by default",
      mux.find_property("force-live") is None and mux.get_property("latency") == 0)

print("\n--- (1) an input 3 s late is waited for, never timed out (R-P2-1) ---")
for kind in KINDS:
    r = Rig(kind)
    r.run(0, 0, 100)
    time.sleep(3.0)
    before = len(r.out)
    r.run(1, 0, 100)
    r.eos()
    eos = r.wait_eos()
    check(f"{kind}: harness answered LATENCY live=false, min 0, max none ({len(r.answers)} answers)",
          len(r.answers) >= 2 and set(r.answers) == {(False, 0, NONE)})
    check(f"{kind}: the aggregator itself answers non-live", r.agg_live() is False)
    check(f"{kind}: nothing out in 3 s without the late input (got {before} buffers)", before == 0)
    if kind == "mpegtsmux":
        check(f"{kind}: every buffer of both inputs is one PES at running time + 1 h, payload intact",
              r.pes_ok(0, range(100)) and r.pes_ok(1, range(100)))
    else:
        sp = r.spans()
        check(f"{kind}: 100 buffers out of 100 in, 48000 frames, all carry both inputs "
              f"(got {len(r.out)} buffers, {sp[:3]})",
              len(r.out) == 100 and sp == [(0, 1000, want(kind, VAL[0], VAL[1]))])
    check(f"{kind}: EOS, no error", eos and not r.errors())
    r.stop()

r = Rig("audiomixer", harness=False)
r.run(0, 0, 100)
time.sleep(1.0)
before = len(r.out)
r.run(1, 0, 100)
r.eos()
r.wait_eos()
both = sum(b - a for a, b, fr in r.spans() if fr == want("audiomixer", VAL[0], VAL[1]))
check(f"control, inputs answering live: the mixer times out ({before} buffers out before the "
      f"late input) and drops it ({both:.0f} of 1000 ms mixed)", before > 0 and both < 1000)
r.stop()

print("\n--- (2) a GAP moves the aggregator on: silence, or nothing written ---")
for kind in KINDS:
    mux = kind == "mpegtsmux"
    for fence in (False, True):
        r = Rig(kind)
        r.run(0, 0, 100)
        r.run(1, 0, 30)
        r.gap(1, 300, 400)
        if fence:
            r.gap(1, 700, 0)
        # A GAP is consumed at its start: the audio aggregators make one block of it, the
        # mux writes up to its PTS; a zero-length GAP at its end carries them to the end.
        to = 700 if fence else 300 if mux else 310
        at = r.settle(to)
        how = "GAP [300, 700) ms + zero-length GAP at 700" if fence else "one GAP [300, 700) ms"
        check(f"{kind}: {how} carries the output to {to} ms before more data (got {at})", at == to)
        r.run(1, 70, 100)
        r.eos()
        eos = r.wait_eos()
        if mux:
            check(f"{kind}: nothing written for the gap; every buffer of both inputs is one PES",
                  r.pes_ok(0, range(100)) and r.pes_ok(1, [*range(30), *range(70, 100)]))
        else:
            ab, a = want(kind, VAL[0], VAL[1]), want(kind, VAL[0], 0)
            check(f"{kind}: the gapped input is silent for the gap, sample-exact (got {r.spans()})",
                  r.spans() == [(0, 300, ab), (300, 700, a), (700, 1000, ab)])
            check(f"{kind}: no output buffer GAP-flagged while another input has data",
                  not any(o[2] & int(Gst.BufferFlags.GAP) for o in r.out))
        check(f"{kind}: EOS, no error", eos and not r.errors())
        r.stop()

print("\n--- (3) a request pad added while PLAYING is waited for ---")
for kind in KINDS:
    r = Rig(kind)
    r.run(0, 0, 50)
    r.run(1, 0, 50)
    r.settle(490 if kind == "mpegtsmux" else 500)
    r.add()
    r.run(0, 50, 100)
    r.run(1, 50, 100)
    time.sleep(1.0)
    at = r.reach()
    r.run(2, 50, 100)
    r.eos()
    eos = r.wait_eos()
    if kind == "mpegtsmux":
        check(f"{kind}: nothing past 490 ms written in 1 s while the new pad was empty (got {at})",
              at == 490)
        check(f"{kind}: all three inputs' buffers written, the new one from its first",
              r.pes_ok(0, range(100)) and r.pes_ok(1, range(100)) and r.pes_ok(2, range(50, 100)))
    else:
        check(f"{kind}: output held at 500 ms for 1 s while the new pad was empty (got {at})",
              at == 500)
        check(f"{kind}: then every frame carries every present input (got {r.spans()})",
              r.spans() == [(0, 500, want(kind, VAL[0], VAL[1])),
                            (500, 1000, want(kind, *VAL))])
    check(f"{kind}: EOS, no error", eos and not r.errors())
    r.stop()

r = Rig("audiomixer")
r.run(0, 0, 50)
r.run(1, 0, 50)
r.settle(500)
r.add(harness=False)
r.run(0, 50, 100)
r.run(1, 50, 100)
live = r.agg_live()     # a downstream LATENCY query, as the bin sends on any latency change
at = r.settle(510)
check(f"control, a pad added without the non-live answer: the mixer turns live (live={live}) "
      f"and stops waiting (output at {at} ms)", live and at > 500)
r.eos()
r.stop()

print("\n--- (4) a buffer that ends before the output position ---")
# Input 1 runs to `until`, then one odd buffer (start ms, frames, flags), then resumes at buffer
# `nxt`; input 0 runs to `end`. Expected: input 1's layout in the mix, samples dropped (QoS).
cases = [
    ("stale, DISCONT", 50, (200, 4800, DISCONT), 50, 150, [(0, 1500, "ab")], 4800),
    ("straddling, DISCONT", 50, (450, 4800, DISCONT), 55, 150,
     [(0, 500, "ab"), (500, 550, "as"), (550, 1500, "ab")], 2400),
    ("stale, no DISCONT, 0.3 s back", 50, (200, 4800, 0), 50, 150,
     [(0, 500, "ab"), (500, 600, "as"), (600, 1500, "ab"), (1500, 1600, "b")], 0),
    ("stale, no DISCONT, 1.2 s back (past discont-wait)", 150, (300, 4800, 0), 150, 200,
     [(0, 2000, "ab")], 4800),
    ("a 20 ms hole, no DISCONT (under alignment-threshold)", 50, None, 52, 150,
     [(0, 1480, "ab"), (1480, 1500, "a")], 0),
]
for kind in ("audiomixer", "audiointerleave"):
    for name, until, odd, nxt, end, layout, lost in cases[:3] if kind == "audiointerleave" else cases:
        r = Rig(kind, qos=True)
        r.run(0, 0, end)
        r.run(1, 0, until)
        r.settle(until * 10)
        if odd:
            r.push(1, r.t0 + odd[0] * MS, frames=odd[1], value=STALE, flags=odd[2])
        r.run(1, nxt, end)
        r.eos()
        eos = r.wait_eos()
        fr = {"ab": want(kind, VAL[0], VAL[1]), "a": want(kind, VAL[0], 0), "b": want(kind, 0, VAL[1]),
              "as": want(kind, VAL[0], STALE)}
        got = r.dropped().get("sink_1", 0)
        check(f"{kind}: {name}: input 1 lands at {layout} (got {r.spans()})",
              r.spans() == [(a, b, fr[k]) for a, b, k in layout])
        check(f"{kind}: {name}: {lost} samples dropped and counted (QoS: {got})", got == lost)
        check(f"{kind}: {name}: EOS, no error", eos and not r.errors())
        r.stop()

# A sparse cue gapped past and then delivered is written at its own PTS (C-3, part 4.6).
r = Rig("mpegtsmux", caps=[CAPS["mpegtsmux"], KLV])
r.run(0, 0, 100)
cue = (b"\x06\x0e\x2b\x34early", b"\x06\x0e\x2b\x34late")
r.push(1, r.t0 + 100 * MS, data=cue[0])
r.gap(1, 110, 490)
r.gap(1, 600, 0)
at = r.settle(600)
n = len(r.out)
r.push(1, r.t0 + 300 * MS, data=cue[1])
r.wait(lambda: len(r.pes().get(PID0 + 1, [])) == 2)
r.gap(1, 600, 400)
r.gap(1, 1000, 0)
r.eos()
eos = r.wait_eos()
klv = r.pes().get(PID0 + 1, [])
check(f"mpegtsmux: a cue 300 ms behind the mux (at {at} ms) is written at its own PTS, intact",
      klv == [(pts90(r.t0 + 100 * MS), cue[0]), (pts90(r.t0 + 300 * MS), cue[1])])
check("mpegtsmux: ... after the other input's data up to 600 ms, which was already written",
      at == 600 and [d for _t, d in r.pes(r.out[n:]).get(PID0 + 1, [])] == [cue[1]])
check("mpegtsmux: nothing dropped on the other input; EOS, no error",
      r.pes_ok(0, range(100)) and eos and not r.errors())
r.stop()

print("\n--- (5) start-time-selection=first on uptime-sized timestamps (600 h) ---")
for kind in KINDS:
    r = Rig(kind)
    r.t0 = 600 * HOUR
    r.run(0, 0, 10)
    r.run(1, 0, 10, at_ms=50)
    r.eos()
    eos = r.wait_eos()
    if kind == "mpegtsmux":
        a = r.pes().get(PID0, [])
        check(f"{kind}: every PES at running time + 1 h mod 2^33 from the first buffer "
              f"(first {a and a[0][0]}, want {pts90(r.t0)})",
              r.pes_ok(0, range(10)) and r.pes_ok(1, range(10), at_ms=50))
    else:
        off = r.out and r.out[0][0] - r.t0
        check(f"{kind}: output starts at the first buffer, 600 h (got {off} ns off)",
              bool(r.out) and off == 0)
        check(f"{kind}: the later input at its own running time, sample-exact (got {r.spans()})",
              r.spans() == [(0, 50, want(kind, VAL[0], 0)), (50, 100, want(kind, VAL[0], VAL[1])),
                            (100, 150, want(kind, 0, VAL[1]))])
    check(f"{kind}: EOS, no error", eos and not r.errors())
    r.stop()

r = Rig("audiomixer", agg="audiomixer force-live=false latency=0 start-time-selection=zero")
r.t0 = 2 * S
r.run(0, 0, 10)
r.run(1, 0, 10)
r.eos()
r.wait_eos()
check(f"control, start-time-selection=zero: output starts at 0 and silence-fills up to the first "
      f"buffer (first PTS {r.out and r.out[0][0]}, {len(r.out)} buffers)",
      bool(r.out) and r.out[0][0] == 0 and len(r.out) == 210)
r.stop()

print("\n--- (6) EOS on every input ends the stream: no free-run ---")
for kind in KINDS:
    r = Rig(kind)
    r.run(0, 0, 10)
    r.eos(0)
    r.run(1, 0, 30)
    time.sleep(0.2)
    early = r.wait_eos(0)
    r.eos(1)
    eos = r.wait_eos(2.0)
    if kind == "mpegtsmux":
        check(f"{kind}: an input at EOS is not waited for; all buffers written",
              r.pes_ok(0, range(10)) and r.pes_ok(1, range(30)))
    else:
        check(f"{kind}: an input at EOS is not waited for; output ends with the last input "
              f"(got {r.spans()})",
              r.spans() == [(0, 100, want(kind, VAL[0], VAL[1])), (100, 300, want(kind, 0, VAL[1]))])
    check(f"{kind}: no EOS while one input runs; EOS once both ended", not early and eos)
    check(f"{kind}: no error", not r.errors())
    r.stop()

r = Rig("audiomixer", agg="audiomixer force-live=true latency=0 start-time-selection=first", keep=False)
r.run(0, 0, 10)
r.run(1, 0, 10)
r.eos()
eos = r.wait_eos(0.5)
at = r.reach() or 0
check(f"control, force-live=true: no EOS, the mixer free-runs past its inputs (to {at:.0f} ms in 0.5 s)",
      not eos and at > 1100)
r.stop()

print()
if _failures:
    print(f"{len(_failures)} FAILURE(S) in gst_aligner_behaviour_test.py")
    sys.exit(1)
print("ALL gst_aligner_behaviour_test.py TESTS PASSED")
