#!/usr/bin/env python3
"""mralignwatch (plan ch. 6 part 4.3, WI-P2-6), the input of a non-live aggregator, in front of
audiomixer and mpegtsmux. Live appsrc inputs are fed at real time on the house clock (monotonic,
base_time 0), as WI-P2-1's rig, each buffer k at content time k x 10 ms arriving `lag` late.

Cases: (1) a 1.5 s late but delivering input: nothing dropped, no absence; (2) a silent input,
and one that never delivers: absent within W + tick, gaps at now - pace, the aggregator goes on;
(3) rejoin: stale buffers discarded and counted, present again; (4) an input whose lateness falls
is still released at the pace; (5) releasing a pad lowers the pace; (6) hold-on-eos; (7) a full
queue blocks upstream, full-count 1, nothing dropped; (8) sparse: a late cue is forwarded at its
own PTS with a message and the pace raised. Plus the defaults and the LATENCY answer, and the
caps a dark input's gaps go out under: (2c) a 302M-shaped branch, (2d) 8 channels, (2e) every
input dark, (2f) a branch dark at start that comes up, (8b) a sparse stream whose caps come with
its first cue.
Skips (exit 0) without GStreamer, the elements or the built plugin."""
import array
import os
import re
import sys
import tempfile
import threading
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_mralignwatch_element_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

Gst.init(sys.argv)
_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGINS = os.environ.get("MR_PLUGINS_DIR") or os.path.normpath(
    os.path.join(_HERE, "..", "..", "..", "..", "plugins"))
_SO = os.path.join(_PLUGINS, "mpegts-core", "native", "mrtshouse", "libgstmrtshouse.so")
if not os.path.exists(_SO):
    print(f"SKIP gst_mralignwatch_element_test.py — {_SO} not built (make native)")
    sys.exit(0)
Gst.Plugin.load_file(_SO)
for _f in ("mralignwatch", "audiomixer", "mpegtsmux", "appsrc", "fakesink"):
    if Gst.ElementFactory.find(_f) is None:
        print(f"SKIP gst_mralignwatch_element_test.py — {_f} unavailable")
        sys.exit(0)

MS, S = Gst.MSECOND, Gst.SECOND
NONE = Gst.CLOCK_TIME_NONE
RATE, BLOCK = 48000, 480          # 10 ms buffers
MUX_BASE_90K, WRAP = 90000 * 3600, 1 << 33
PID0 = 101
VAL = (1000, 100, 10)             # input i's sample value: a mixed frame names its inputs
AGG = {"audiomixer": "audiomixer force-live=false latency=0 start-time-selection=first",
       "mpegtsmux": "mpegtsmux latency=0"}
CAPS = {"audiomixer": "audio/x-raw,format=S16LE,rate=48000,channels=2,layout=interleaved",
        "mpegtsmux": "audio/x-smpte-302m"}
KLV = "meta/x-klv,parsed=(boolean)true"
KINDS = ("audiomixer", "mpegtsmux")
SAMPLE = {"S16LE": "h", "S32LE": "i", "F32LE": "f", "F64LE": "d"}   # array typecodes
MISORDER = "Sticky event misordering"   # GStreamer: a SEGMENT stored before the CAPS
# Scheduling slack on a loaded 4-core box, on top of what the element promises.
SLACK = 80 * MS

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def mask_of(caps):
    """The caps' channel-mask, None when they have none."""
    m = re.search(r"channel-mask=\(bitmask\)0x([0-9a-f]+)", caps.to_string()) if caps else None
    return int(m.group(1), 16) if m else None


def caps_str(caps):
    return caps.to_string() if caps else None


class StderrTap:
    """What C code (GLib's warnings) writes to stderr inside the block; echoed after it, but for
    the lines naming `expected`."""

    def __init__(self, expected=None):
        self.expected = expected

    def __enter__(self):
        sys.stderr.flush()
        self.file = tempfile.TemporaryFile()
        self.saved = os.dup(2)
        os.dup2(self.file.fileno(), 2)
        return self

    def __exit__(self, *_exc):
        sys.stderr.flush()
        os.dup2(self.saved, 2)
        os.close(self.saved)
        self.file.seek(0)
        self.text = self.file.read().decode(errors="replace")
        self.file.close()
        if self.expected:
            sys.stderr.write("".join(ln for ln in self.text.splitlines(True)
                                     if ln.strip() and self.expected not in ln))
        else:
            sys.stderr.write(self.text)


def pts90(rt):
    return (rt * 90000 // S + MUX_BASE_90K) % WRAP


def payload(i, k):
    return (bytes([0x41 + i]) + k.to_bytes(2, "big")) * 32


def median(v):
    v = sorted(v)
    return v[len(v) // 2] if v else None


class Rig:
    """Live appsrc inputs, each through an mralignwatch of one pace group, into one
    aggregator on the house clock. `channels`: of the audio buffers pushed."""

    def __init__(self, kind, inputs, channels=2):
        self.kind, self.mux, self.channels = kind, kind == "mpegtsmux", channels
        self.srcs, self.aws, self.pads = [], [], []
        self.out, self.msgs, self.errors, self.eos_at = [], [], [], None
        self.rel = []                  # per input: what its mralignwatch pushed
        self.lock = threading.Lock()
        self.pipe = Gst.parse_launch(f"{AGG[kind]} name=agg ! fakesink sync=false async=false")
        self.agg = self.pipe.get_by_name("agg")
        self.clock = Gst.SystemClock.obtain()
        self.clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
        self.pipe.use_clock(self.clock)
        self.pipe.set_start_time(NONE)
        self.pipe.set_base_time(0)
        self.pipe.get_bus().set_sync_handler(self._on_msg)
        self.agg.get_static_pad("src").add_probe(
            Gst.PadProbeType.BUFFER | Gst.PadProbeType.BUFFER_LIST, self._on_out)
        for spec in inputs:
            self.add(spec)
        self.pipe.set_state(Gst.State.PLAYING)
        self.playing_at = self.now()
        self.t0 = self.now() // (10 * MS) * (10 * MS) + 200 * MS   # content time 0

    def now(self):
        return self.clock.get_time()

    def _on_msg(self, _bus, m):
        s = m.get_structure()
        with self.lock:
            if (m.type == Gst.MessageType.ELEMENT and s is not None
                    and s.get_name() == "mralignwatch"):
                self.msgs.append((self.now(), m.src.get_name(),
                                  {s.nth_field_name(j): s.get_value(s.nth_field_name(j))
                                   for j in range(s.n_fields())}))
            elif m.type == Gst.MessageType.ERROR:
                self.errors.append(m.parse_error()[0].message)
            elif m.type == Gst.MessageType.EOS and self.eos_at is None:
                self.eos_at = self.now()
        return Gst.BusSyncReply.DROP

    def _on_out(self, pad, info):
        if info.type & Gst.PadProbeType.BUFFER_LIST:   # mpegtsmux pushes lists
            lst = info.get_buffer_list()
            bufs = [lst.get(j) for j in range(lst.length())]
        else:
            bufs = [info.get_buffer()]
        caps, t = pad.get_current_caps(), self.now()
        bpf, code = 0, "h"
        if caps and not self.mux:
            st = caps.get_structure(0)
            code = SAMPLE.get(st.get_string("format"), "h")
            bpf = st.get_int("channels")[1] * array.array(code).itemsize
        with self.lock:
            for b in bufs:
                nf = b.get_size() // bpf if bpf else 0
                self.out.append((t, b.pts, nf, b.extract_dup(0, b.get_size()), code))
        return Gst.PadProbeReturn.OK

    def _on_release(self, i):
        def probe(_pad, info):
            t = self.now()
            if info.type & Gst.PadProbeType.BUFFER:
                b = info.get_buffer()
                rec = ("buf", t, b.pts, int(b.get_flags()))
            elif info.type & Gst.PadProbeType.QUERY_DOWNSTREAM:
                rec = ("query", t, info.get_query().type)
            elif info.type & Gst.PadProbeType.EVENT_DOWNSTREAM:
                ev = info.get_event()
                if ev.type == Gst.EventType.GAP:
                    ts, dur = ev.parse_gap()
                    rec = ("gap", t, ts, dur)
                elif ev.type == Gst.EventType.EOS:
                    rec = ("eos", t)
                elif ev.type in (Gst.EventType.STREAM_START, Gst.EventType.CAPS,
                                 Gst.EventType.SEGMENT):
                    rec = ("sticky", t, ev.type)
                else:
                    return Gst.PadProbeReturn.OK
            else:
                return Gst.PadProbeReturn.OK
            with self.lock:
                self.rel[i].append(rec)
            return Gst.PadProbeReturn.OK
        return probe

    def add(self, spec, live=False):
        """One input; `chain`: elements between its appsrc and the element; `live`: added while
        PLAYING, as bus_input_add does (link first, then run)."""
        i = len(self.srcs)
        src = Gst.ElementFactory.make("appsrc", f"src{i}")
        for prop, v in (("is-live", True), ("format", Gst.Format.TIME), ("max-bytes", 0)):
            src.set_property(prop, v)
        caps = spec.get("caps", CAPS[self.kind])
        if caps:
            src.set_property("caps", Gst.Caps.from_string(caps))
        aw = Gst.ElementFactory.make("mralignwatch", f"aw{i}")
        aw.set_property("aligner", "agg")
        aw.set_property("input", f"in{i}")
        for prop, v in spec.get("props", {}).items():
            aw.set_property(prop, v)
        self.rel.append([])
        aw.get_static_pad("src").add_probe(
            Gst.PadProbeType.BUFFER | Gst.PadProbeType.EVENT_DOWNSTREAM
            | Gst.PadProbeType.QUERY_DOWNSTREAM, self._on_release(i))
        self.pipe.add(src)
        self.pipe.add(aw)
        chain = Gst.parse_bin_from_description(spec["chain"], True) if "chain" in spec else None
        if chain is not None:
            self.pipe.add(chain)
            src.link(chain)
            chain.link(aw)
        else:
            src.link(aw)
        tmpl = self.agg.get_pad_template("sink_%d" if self.mux else "sink_%u")
        pad = self.agg.request_pad(tmpl, f"sink_{PID0 + i}" if self.mux else f"sink_{i}", None)
        aw.get_static_pad("src").link(pad)
        self.srcs.append(src)
        self.aws.append(aw)
        self.pads.append(pad)
        if live:
            for el in (aw, chain, src):
                if el is not None:
                    el.sync_state_with_parent()

    def remove(self, i):
        """As bus_input_remove: the branch to NULL, unlinked, the request pad released."""
        src, aw, pad = self.srcs[i], self.aws[i], self.pads[i]
        src.set_state(Gst.State.NULL)
        aw.set_state(Gst.State.NULL)
        aw.get_static_pad("src").unlink(pad)
        self.agg.release_request_pad(pad)
        self.pipe.remove(src)
        self.pipe.remove(aw)

    def at(self, ms):
        return self.t0 + int(ms * MS)

    def sleep_until(self, t):
        while True:
            d = t - self.now()
            if d <= 0:
                return
            time.sleep(min(d / S, 0.005))

    def push(self, i, k, data=None, pts=None):
        if data is None:
            data = payload(i, k) if self.mux else array.array(
                "h", [VAL[i]] * self.channels * BLOCK).tobytes()
        b = Gst.Buffer.new_wrapped(data)
        b.pts = self.at(k * 10) if pts is None else pts
        b.dts = NONE
        b.duration = 10 * MS
        self.srcs[i].emit("push-buffer", b)

    def run(self, plans):
        """{input: [step, ...]} on one thread per input. Steps: ("rt", k0, k1, lag_ms): buffer k
        at content k x 10 ms + lag; ("now", k0, k1): at once; ("at", ms): wait for content ms;
        ("eos",); ("call", fn)."""
        def go(i, steps):
            for st in steps:
                if st[0] == "rt":
                    for k in range(st[1], st[2]):
                        self.sleep_until(self.at(k * 10 + st[3]))
                        self.push(i, k)
                elif st[0] == "now":
                    for k in range(st[1], st[2]):
                        self.push(i, k)
                elif st[0] == "at":
                    self.sleep_until(self.at(st[1]))
                elif st[0] == "eos":
                    self.srcs[i].emit("end-of-stream")
                elif st[0] == "call":
                    st[1]()
        threads = [threading.Thread(target=go, args=(i, steps)) for i, steps in plans.items()]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

    def wait(self, pred, cap_s=4.0):
        end = time.monotonic() + cap_s
        while not pred() and time.monotonic() < end:
            time.sleep(0.02)
        return pred()

    def reach(self):
        """Content ms the output covers: the audio end, or the last PES of input 0."""
        with self.lock:
            out = list(self.out)
        if self.mux:
            lst = self.pes(out).get(PID0, [])
            return (lst[-1][0] - pts90(self.t0)) % WRAP / 90 if lst else None
        return (out[-1][1] + out[-1][2] * S // RATE - self.t0) / MS if out else None

    def spans(self, upto_ms=None):
        """Run-length [(start ms, end ms, frame)] of the audio output from content 0."""
        with self.lock:
            out = list(self.out)
        res = []
        for _t, pts, nf, data, code in out:
            if not nf:
                continue
            v = array.array(code, data)
            ch = len(v) // nf
            off = round((pts - self.t0) * RATE / S)
            for j in range(nf):
                fr = tuple(v[ch * j:ch * j + ch])
                if res and res[-1][2] == fr and res[-1][1] == off + j:
                    res[-1][1] += 1
                else:
                    res.append([off + j, off + j + 1, fr])
        sp = [(a / 48, b / 48, fr[0]) for a, b, fr in res]
        if upto_ms is not None:
            sp = [(a, min(b, upto_ms), v) for a, b, v in sp if a < upto_ms]
        return sp

    def pes(self, out=None):
        """{pid: [(pts90k, payload)]} of the mux output."""
        if out is None:
            with self.lock:
                out = list(self.out)
        data, cur, res = b"".join(o[3] for o in out), {}, {}
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
                pts = (((h[0] >> 1) & 7) << 30 | h[1] << 22 | (h[2] >> 1) << 15 | h[3] << 7
                       | h[4] >> 1 if body[7] & 0x80 else None)
                cur[pid] = (pts, bytearray(body[9 + body[8]:]))
            elif pid in cur:
                cur[pid][1].extend(body)
        for pid, v in cur.items():
            res.setdefault(pid, []).append(v)
        return {pid: [(t, bytes(d)) for t, d in v] for pid, v in res.items()}

    def pes_ok(self, i, ks):
        """Input i's PES are exactly its buffers ks: PTS = running time + 1 h, payload intact."""
        return self.pes().get(PID0 + i, []) == [(pts90(self.at(k * 10)), payload(i, k)) for k in ks]

    def prop(self, i, name):
        return self.aws[i].get_property(name)

    def states(self, i):
        """(clock, state) of every state message of input i."""
        with self.lock:
            return [(t, f["state"]) for t, src, f in self.msgs
                    if src == f"aw{i}" and f["reason"] == "state"]

    def released(self, i, kind="buf"):
        with self.lock:
            return [r for r in self.rel[i] if r[0] == kind]

    def sticky(self, i):
        """The stream-start, caps and segment events input i's mralignwatch pushed, in order."""
        return [Gst.EventType.get_name(r[2]) for r in self.released(i, "sticky")]

    def caps_then_segment(self, i):
        """Input i's src sent caps once, before its first segment (no misordering)."""
        st = self.sticky(i)
        return st.count("caps") == 1 and "segment" in st and st.index("caps") < st.index("segment")

    def agg_live(self):
        q = Gst.Query.new_latency()
        return bool(self.agg.get_static_pad("src").query(q) and q.parse_latency()[0])

    def stop(self):
        self.pipe.set_state(Gst.State.NULL)


def all_mixed(r, upto, both=VAL[0] + VAL[1]):
    return r.spans(upto) == [(0, upto, both)]


print("\n--- defaults and the LATENCY answer ---")
aw = Gst.ElementFactory.make("mralignwatch")
for prop, want in (("silence-factor", 3.0), ("silence-floor", 100 * MS), ("silence-ceiling", 2 * S),
                   ("max-size-time", 5 * S), ("max-size-bytes", 0), ("tick", 20 * MS),
                   ("seed-lateness", -1), ("sparse", False), ("hold-on-eos", False),
                   ("state", "waiting"), ("pace", 0), ("full-count", 0), ("abi", 1)):
    check(f"mralignwatch {prop} defaults to {want}", aw.get_property(prop) == want)
q = Gst.Query.new_latency()
check("LATENCY on the src pad: live=false, min 0, max none, not forwarded (no peer needed)",
      aw.get_static_pad("src").query(q) and tuple(q.parse_latency()) == (False, 0, NONE))

for kind in KINDS:
    mux = kind == "mpegtsmux"
    print(f"\n--- {kind}: (1) a 1.5 s late but delivering input ---")
    r = Rig(kind, [{}, {}])
    r.run({0: [("rt", 0, 250, 0), ("eos",)], 1: [("rt", 0, 250, 1500), ("eos",)]})
    eos = r.wait(lambda: r.eos_at is not None)
    check(f"{kind}: the aggregator answers non-live", r.agg_live() is False)
    check(f"{kind}: no absence on either input, nothing stale",
          [r.prop(i, "absences") for i in (0, 1)] == [0, 0]
          and [r.prop(i, "stale-buffers") for i in (0, 1)] == [0, 0])
    pace = r.prop(0, "pace")
    check(f"{kind}: the pace is the late input's lateness (1.5 s, got {pace / MS:.1f} ms)",
          abs(pace - 1500 * MS) <= SLACK and abs(r.prop(1, "pace") - pace) <= 2 * MS)
    late0 = median([t - p for _k, t, p, _f in r.released(0)[50:]])
    check(f"{kind}: the on-time input is released at the pace (median {late0 / MS:.1f} ms)",
          abs(late0 - 1500 * MS) <= SLACK)
    if mux:
        check(f"{kind}: every buffer of both inputs is one PES at running time + 1 h, intact",
              r.pes_ok(0, range(250)) and r.pes_ok(1, range(250)))
    else:
        check(f"{kind}: all 2.5 s mixed from both inputs, nothing dropped (got {r.spans()[:4]})",
              r.spans() == [(0, 2500, VAL[0] + VAL[1])])
    check(f"{kind}: EOS, no error", eos and not r.errors)
    r.stop()

    if not mux:
        # The on-time input's first buffer arrives 100 ms before the late one's, whose content
        # starts 1.4 s earlier: a non-live mixer still starts at the earliest first buffer.
        print(f"\n--- {kind}: (1b) a late input's earlier content is kept at the start ---")
        r = Rig(kind, [{}, {}])
        r.run({0: [("rt", 140, 300, 0), ("eos",)], 1: [("rt", 0, 300, 1500), ("eos",)]})
        eos = r.wait(lambda: r.eos_at is not None)
        check(f"{kind}: the mix starts at the late input's first content, all of it kept "
              f"(got {r.spans()})",
              r.spans() == [(0, 1400, VAL[1]), (1400, 3000, VAL[0] + VAL[1])])
        check(f"{kind}: EOS, no error", eos and not r.errors)
        r.stop()

    print(f"\n--- {kind}: (2) a silent input ---")
    # Input 0 runs 300 ms late, so the pace the silent input's GAPs keep is not 0.
    r = Rig(kind, [{}, {}])
    r.run({0: [("rt", 0, 250, 300)], 1: [("rt", 0, 100, 0)]})
    r.wait(lambda: (r.reach() or 0) >= (2490 if mux else 2500))
    last = r.released(1)[-1][1] if r.released(1) else 0
    with r.lock:
        last_in = max((t for t, src, f in r.msgs if src == "aw1"), default=0)
    absent = [t for t, s in r.states(1) if s == "absent"]
    w = r.prop(1, "silence-limit")
    # The last arrival is the push of content 990 ms, at content 990 ms (lag 0).
    since = absent[0] - r.at(990) if absent else None
    check(f"{kind}: W is the 100 ms floor for a 10 ms rhythm (got {w / MS:.0f} ms)", w == 100 * MS)
    check(f"{kind}: absent within W + tick after its last arrival (got "
          f"{since / MS if since is not None else None} ms)",
          since is not None and w <= since <= w + 20 * MS + SLACK)
    gaps = r.released(1, "gap")
    pace = r.prop(1, "pace")
    off = [(g[1] - pace) - (g[2] + g[3]) for g in gaps if absent and g[1] > absent[0] + 100 * MS]
    check(f"{kind}: every tick a GAP reaching now - pace ({pace / MS:.0f} ms; worst "
          f"{max(off, default=-1) / MS:.1f} ms behind, {len(off)} gaps)",
          abs(pace - 300 * MS) <= SLACK and len(off) >= 30 and max(off) <= 20 * MS + SLACK
          and min(off) >= -2 * MS)
    fences = [g for g in gaps if g[3] == 0]
    check(f"{kind}: each GAP is followed by a zero-length one at its end (WI-P2-1 F2)",
          len(fences) >= len(gaps) // 2 and all(
              gaps[j + 1][2] == gaps[j][2] + gaps[j][3] and gaps[j + 1][3] == 0
              for j in range(len(gaps) - 1) if gaps[j][3]))
    if mux:
        check(f"{kind}: the aggregator goes on: input 0's 250 buffers all written, input 1's 100",
              r.pes_ok(0, range(250)) and r.pes_ok(1, range(100)))
    else:
        check(f"{kind}: the aggregator goes on: input 1 silent from 1 s (got {r.spans(2500)})",
              r.spans(2500) == [(0, 1000, VAL[0] + VAL[1]), (1000, 2500, VAL[0])])
    check(f"{kind}: no error", not r.errors)
    r.stop()

    print(f"\n--- {kind}: (2b) an input that never delivers ---")
    r = Rig(kind, [{}, {}])
    r.run({0: [("rt", 0, 300, 0)]})
    r.wait(lambda: (r.reach() or 0) >= (2990 if mux else 3000))
    absent = [t for t, s in r.states(1) if s == "absent"]
    since = absent[0] - r.playing_at if absent else None
    check(f"{kind}: absent at the 2 s ceiling + tick after PLAYING, never on a first buffer "
          f"(got {since / MS if since is not None else None} ms)",
          since is not None and 2000 * MS <= since <= 2020 * MS + 2 * SLACK)
    if mux:
        check(f"{kind}: input 0's buffers all written, from its first",
              r.pes_ok(0, range(300)) and not r.pes().get(PID0 + 1))
    else:
        check(f"{kind}: input 0 mixed from its first buffer, nothing dropped (got {r.spans(3000)})",
              r.spans(3000) == [(0, 3000, VAL[0])])
    caps1 = r.aws[1].get_static_pad("src").get_current_caps()
    check(f"{kind}: the gaps went out under upstream's own fixed caps, sent before their segment "
          f"({caps_str(caps1)}, sticky {r.sticky(1)})",
          caps1 is not None and caps1.is_equal(Gst.Caps.from_string(CAPS[kind]))
          and r.caps_then_segment(1))
    check(f"{kind}: no error (the gaps came with a stream, caps and a segment)", not r.errors)
    r.stop()

    print(f"\n--- {kind}: (3) rejoin ---")
    r = Rig(kind, [{}, {}])
    r.run({0: [("rt", 0, 300, 0), ("eos",)],
           1: [("rt", 0, 100, 0), ("at", 2000), ("now", 100, 200), ("rt", 200, 300, 0), ("eos",)]})
    eos = r.wait(lambda: r.eos_at is not None)
    stale, stale_t = r.prop(1, "stale-buffers"), r.prop(1, "stale-time")
    check(f"{kind}: the second's backlog is stale: discarded and counted ({stale} buffers, "
          f"{stale_t / MS:.0f} ms)", 80 <= stale <= 100 and stale_t == stale * 10 * MS)
    st = [s for _t, s in r.states(1)]
    check(f"{kind}: absent once, then present again (states {st})",
          st[-2:] == ["absent", "present"] and r.prop(1, "absences") == 1
          and r.prop(1, "state") == "present")
    first = [b for b in r.released(1) if b[2] >= r.at(1000)]
    check(f"{kind}: the first buffer out after the rejoin carries DISCONT (WI-P2-1 F3)",
          bool(first) and first[0][3] & int(Gst.BufferFlags.DISCONT))
    if mux:
        kept = [k for k in range(100, 300) if (r.at(k * 10) - r.t0) // (10 * MS) >= 100 + stale]
        check(f"{kind}: input 1's PES: its first second, then what was not stale, at their PTS",
              r.pes_ok(1, list(range(100)) + kept) and r.pes_ok(0, range(300)))
    else:
        sp = r.spans(3000)
        h = sp[1][1] if len(sp) == 3 else None
        check(f"{kind}: input 1 rejoins at the horizon, placed by PTS (got {sp})",
              len(sp) == 3 and sp[0] == (0, 1000, VAL[0] + VAL[1]) and sp[1][2] == VAL[0]
              and sp[2] == (h, 3000, VAL[0] + VAL[1]) and abs(h - (1000 + 10 * stale)) <= 10)
    check(f"{kind}: EOS, no error", eos and not r.errors)
    r.stop()

    print(f"\n--- {kind}: (4) an input whose lateness falls ---")
    r = Rig(kind, [{}, {}])
    # After the catch-up, more than a second at 200 ms, so its mean leaves the burst behind.
    r.run({0: [("rt", 0, 400, 0), ("eos",)],
           1: [("rt", 0, 150, 1500), ("at", 2800), ("now", 150, 260), ("rt", 260, 400, 200),
               ("eos",)]})
    eos = r.wait(lambda: r.eos_at is not None, 5.0)
    pace = r.prop(1, "pace")
    lat1 = r.prop(1, "lateness")
    check(f"{kind}: input 1 now arrives 200 ms late (its lateness {lat1 / MS:.0f} ms), the pace "
          f"holds 1.5 s (got {pace / MS:.0f} ms)",
          abs(pace - 1500 * MS) <= SLACK and abs(lat1 - 200 * MS) <= SLACK)
    rel = [t - p for _k, t, p, _f in r.released(1) if p >= r.at(2700)]
    check(f"{kind}: ... and is still released at the pace (median {median(rel) / MS:.0f} ms)",
          len(rel) > 50 and abs(median(rel) - 1500 * MS) <= SLACK)
    with r.lock:
        held = max((f["level-time"] for _t, src, f in r.msgs if src == "aw1"), default=0)
    if mux:
        check(f"{kind}: nothing dropped", r.pes_ok(0, range(400)) and r.pes_ok(1, range(400)))
    else:
        check(f"{kind}: nothing dropped (got {r.spans()[:3]})",
              r.spans() == [(0, 4000, VAL[0] + VAL[1])])
    check(f"{kind}: input 1's queue held the difference (level-time up to {held / MS:.0f} ms)",
          held >= 1000 * MS)
    check(f"{kind}: EOS, no error", eos and not r.errors)
    r.stop()

    print(f"\n--- {kind}: (5) releasing a pad lowers the pace ---")
    r = Rig(kind, [{}, {}])
    r.run({0: [("rt", 0, 300, 0), ("call", lambda: r.remove(1)), ("rt", 300, 400, 0), ("eos",)],
           1: [("rt", 0, 141, 1500)]})
    eos = r.wait(lambda: r.eos_at is not None)
    pace = r.prop(0, "pace")
    rel = [t - p for _k, t, p, _f in r.released(0) if p >= r.at(3100)]
    check(f"{kind}: input 1 released: the pace falls to input 0's need (got {pace / MS:.1f} ms)",
          pace <= SLACK)
    check(f"{kind}: input 0 now leaves on arrival (median {median(rel) / MS:.1f} ms)",
          len(rel) > 50 and median(rel) <= SLACK)
    if mux:
        check(f"{kind}: nothing dropped", r.pes_ok(0, range(400)) and r.pes_ok(1, range(141)))
    else:
        check(f"{kind}: both mixed to 1.41 s, then input 0 alone (got {r.spans()})",
              r.spans() == [(0, 1410, VAL[0] + VAL[1]), (1410, 4000, VAL[0])])
    check(f"{kind}: EOS, no error", eos and not r.errors)
    r.stop()

    print(f"\n--- {kind}: (6) hold-on-eos ---")
    for hold in (True, False):
        r = Rig(kind, [{}, {"props": {"hold-on-eos": hold}}])
        r.run({0: [("rt", 0, 200, 0), ("eos",)], 1: [("rt", 0, 100, 0), ("eos",)]})
        eos = r.wait(lambda: r.eos_at is not None, 1.0)
        if hold:
            at0 = r.reach() or 0
            time.sleep(0.4)
            st = [s for _t, s in r.states(1)]
            check(f"{kind}: hold-on-eos: input 1's EOS becomes absence (states {st})",
                  st[-1:] == ["absent"] and r.prop(1, "absences") == 1)
            check(f"{kind}: hold-on-eos: no EOS out after both inputs ended", not eos)
            check(f"{kind}: hold-on-eos: input 1's GAPs keep coming at the pace, its EOS "
                  f"not forwarded", len(r.released(1, "gap")) > 10 and not r.released(1, "eos"))
            if not mux:
                check(f"{kind}: hold-on-eos: the mix runs on past input 0's end on input 1's "
                      f"gaps ({at0} -> {r.reach()} ms)", (r.reach() or 0) > at0 >= 2000)
        else:
            check(f"{kind}: control: EOS forwarded, the stream ends once both inputs did",
                  eos and r.prop(1, "absences") == 0 and len(r.released(1, "eos")) == 1)
        check(f"{kind}: hold-on-eos={hold}: no error", not r.errors)
        r.stop()

    print(f"\n--- {kind}: (7) a full queue blocks upstream, never drops ---")
    # The seed holds input 0 from its first buffer: its upstream waits on a full queue while
    # its task only waits for the release time, so that wait must not count as silence.
    r = Rig(kind, [{"props": {"max-size-time": 200 * MS}},
                   {"props": {"seed-lateness": 1000 * MS}}])
    r.run({0: [("rt", 0, 250, 0), ("eos",)], 1: [("rt", 0, 250, 1000), ("eos",)]})
    eos = r.wait(lambda: r.eos_at is not None)
    check(f"{kind}: input 0 held at 200 ms against a 1 s pace: full-count 1 "
          f"(got {r.prop(0, 'full-count')})", r.prop(0, "full-count") == 1)
    check(f"{kind}: held upstream is not silence: no absence, nothing stale",
          r.prop(0, "absences") == 0 and r.prop(0, "stale-buffers") == 0)
    with r.lock:
        full = [f for _t, src, f in r.msgs if src == "aw0" and f["reason"] == "full"]
    check(f"{kind}: one `full` message", len(full) == 1)
    if mux:
        check(f"{kind}: nothing dropped", r.pes_ok(0, range(250)) and r.pes_ok(1, range(250)))
    else:
        check(f"{kind}: nothing dropped (got {r.spans()[:3]})",
              r.spans() == [(0, 2500, VAL[0] + VAL[1])])
    check(f"{kind}: EOS, no error", eos and not r.errors)
    r.stop()

print("\n--- audiomixer: (2c) a 302M-shaped branch that never delivers ---")
# audioconvert ! audioresample ! caps, as build302mMixBranch ends; no caps ever come from the
# silent one, so its gaps go out under fixated upstream caps.
BRANCH = "audioconvert ! audioresample ! capsfilter caps=audio/x-raw,rate=48000,channels=2"
r = Rig("audiomixer", [{"chain": BRANCH}, {"chain": BRANCH, "caps": None}])
r.run({0: [("rt", 0, 300, 0)]})
r.wait(lambda: (r.reach() or 0) >= 3000)
absent = [t for t, s in r.states(1) if s == "absent"]
check(f"302M-shaped: the silent branch is absent at the 2 s ceiling (got "
      f"{(absent[0] - r.playing_at) / MS if absent else None} ms)",
      bool(absent) and 2000 * MS <= absent[0] - r.playing_at <= 2020 * MS + 2 * SLACK)
check(f"302M-shaped: the other mixed from its first buffer (got {r.spans(3000)})",
      r.spans(3000) == [(0, 3000, VAL[0])])
caps1 = r.aws[1].get_static_pad("src").get_current_caps()
check(f"302M-shaped: the silent branch's gaps went out under fixed raw caps ({caps_str(caps1)})",
      caps1 is not None and caps1.is_fixed()
      and caps1.get_structure(0).get_int("rate") == (True, 48000))
check("302M-shaped: no error", not r.errors)
r.stop()

print("\n--- audiomixer: (2d) 8 channels: a 302M-shaped branch that never delivers ---")
# n1-mixer-302m mixes up to 8 channels. Wide 302M decodes unpositioned (channel-mask 0); the
# mixer takes a pad with any mask beside it, but not one without a mask above 2 channels.
WIDE = ("audio/x-raw,format=S16LE,rate=48000,channels=8,layout=interleaved,"
        "channel-mask=(bitmask)0x0")
BRANCH8 = "audioconvert ! audioresample ! capsfilter caps=audio/x-raw,rate=48000,channels=8"
for label, dark, want in (("unpositioned", BRANCH8, 0),
                          ("the mask upstream fixes", BRANCH8 + ",channel-mask=(bitmask)0x63f",
                           0x63F)):
    r = Rig("audiomixer", [{"chain": BRANCH8, "caps": WIDE}, {"chain": dark, "caps": None}],
            channels=8)
    r.run({0: [("rt", 0, 300, 0)]})
    r.wait(lambda: (r.reach() or 0) >= 3000)
    absent = [t for t, s in r.states(1) if s == "absent"]
    check(f"8 channels, {label}: the silent branch is absent at the 2 s ceiling (got "
          f"{(absent[0] - r.playing_at) / MS if absent else None} ms)",
          bool(absent) and 2000 * MS <= absent[0] - r.playing_at <= 2020 * MS + 2 * SLACK)
    caps1 = r.aws[1].get_static_pad("src").get_current_caps()
    check(f"8 channels, {label}: its gaps went out under fixed caps, channel-mask {want:#x} "
          f"({caps_str(caps1)})", caps1 is not None and caps1.is_fixed() and mask_of(caps1) == want
          and caps1.get_structure(0).get_int("channels") == (True, 8))
    check(f"8 channels, {label}: the other mixed from its first buffer, nothing dropped "
          f"(got {r.spans(3000)})", r.spans(3000) == [(0, 3000, VAL[0])])
    out = r.agg.get_static_pad("src").get_current_caps()
    check(f"8 channels, {label}: the mix keeps the delivering input's 8 unpositioned channels "
          f"({caps_str(out)})", out is not None and mask_of(out) == 0
          and out.get_structure(0).get_int("channels") == (True, 8))
    check(f"8 channels, {label}: no error (got {r.errors})", not r.errors)
    r.stop()

print("\n--- audiomixer: (2e) 8 channels, every input dark: their gaps alone set the mix ---")
r = Rig("audiomixer", [{"chain": BRANCH8, "caps": None}, {"chain": BRANCH8, "caps": None}],
        channels=8)
r.wait(lambda: (r.reach() or 0) >= 3000, 6.0)
sp = r.spans()
out = r.agg.get_static_pad("src").get_current_caps()
check(f"every input dark: both absent at the ceiling (states {r.states(0)}, {r.states(1)})",
      [s for _t, s in r.states(0)] == ["absent"] and [s for _t, s in r.states(1)] == ["absent"])
check(f"every input dark: the mixer runs on their gaps, silent, under 8 unpositioned channels "
      f"({caps_str(out)}; got {sp[:2]})",
      out is not None and mask_of(out) == 0
      and out.get_structure(0).get_int("channels") == (True, 8)
      and bool(sp) and all(v == 0 for _a, _b, v in sp) and sp[-1][1] - sp[0][0] >= 800)
check(f"every input dark: no error (got {r.errors})", not r.errors)
r.stop()

print("\n--- audiomixer: (2f) 8 channels: a branch dark at start comes up ---")
# A translator not up at module start: gaps under the primed caps, then its own caps (they
# differ) replace them and its content is mixed from where the gaps reached.
r = Rig("audiomixer", [{"chain": BRANCH8, "caps": WIDE}, {"chain": BRANCH8, "caps": None}],
        channels=8)


def _translator_up():
    r.srcs[1].set_property("caps", Gst.Caps.from_string(WIDE))


r.run({0: [("rt", 0, 350, 0)],
       1: [("at", 2490), ("call", _translator_up), ("rt", 250, 350, 0)]})
r.wait(lambda: (r.reach() or 0) >= 3500)
sp = r.spans(3500)
h = sp[1][0] if len(sp) == 2 else None
check(f"dark at start: mixed alone, then with the translator from about its first buffer "
      f"(got {sp})", len(sp) == 2 and sp[0] == (0, h, VAL[0])
      and sp[1] == (h, 3500, VAL[0] + VAL[1]) and abs(h - 2500) <= 30)
caps1 = r.aws[1].get_static_pad("src").get_current_caps()
check(f"dark at start: its own caps replaced the gaps' ({caps_str(caps1)}, sticky {r.sticky(1)})",
      caps1 is not None and caps1.is_equal(Gst.Caps.from_string(WIDE))
      and r.sticky(1).count("caps") == 2)
check(f"dark at start: absent at the ceiling, then present (states {[s for _t, s in r.states(1)]})",
      [s for _t, s in r.states(1)][:2] == ["absent", "present"])
check(f"dark at start: no error (got {r.errors})", not r.errors)
r.stop()

print("\n--- audiomixer: (11) an input added while playing joins at its lateness ---")
r = Rig("audiomixer", [{}])
r.run({0: [("rt", 0, 300, 0), ("eos",)],
       1: [("at", 950), ("call", lambda: r.add({}, live=True)), ("rt", 100, 300, 300), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
rel = [t - p for _k, t, p, _f in r.released(0) if p >= r.at(1500)]
check(f"joined: the pace rose to the joiner's 300 ms (got {r.prop(0, 'pace') / MS:.0f} ms)",
      abs(r.prop(0, "pace") - 300 * MS) <= SLACK
      and abs(r.prop(1, "pace") - r.prop(0, "pace")) <= 2 * MS)
check(f"joined: the first input is held to it (median {median(rel) / MS:.0f} ms)",
      len(rel) > 50 and abs(median(rel) - 300 * MS) <= SLACK)
check(f"joined: the joiner is mixed from its first buffer, nothing dropped (got {r.spans()})",
      r.spans() == [(0, 1000, VAL[0]), (1000, 3000, VAL[0] + VAL[1])])
check("joined: no absence, EOS, no error",
      r.prop(1, "absences") == 0 and eos and not r.errors)
r.stop()

print("\n--- audiomixer: (12) a seed sets the pace from the start ---")
# Input 1 behind an identity, which sends an ALLOCATION query (appsrc's own) downstream.
r = Rig("audiomixer", [{"props": {"seed-lateness": 800 * MS}}, {"chain": "identity"}])
r.run({0: [("rt", 0, 150, 0), ("eos",)], 1: [("rt", 0, 150, 0), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
rel = [[t - p for _k, t, p, _f in r.released(i)] for i in (0, 1)]
check(f"seed: the pace is the 800 ms seed though both inputs are on time (got "
      f"{r.prop(1, 'pace') / MS:.0f} ms)", r.prop(1, "pace") == 800 * MS)
check(f"seed: both released at the seed from their first buffer (first {rel[0][:1]}, {rel[1][:1]})",
      all(len(v) == 150 and abs(v[0] - 800 * MS) <= SLACK and abs(median(v) - 800 * MS) <= SLACK
          for v in rel))
check("seed: nothing dropped, EOS, no error",
      r.spans() == [(0, 1500, VAL[0] + VAL[1])] and eos and not r.errors)
with r.lock:
    queries = [q[2] for q in r.rel[1] if q[0] == "query"]
check(f"queries: the ALLOCATION query taken in went on, in order through the queue "
      f"(out {queries[:3]})", Gst.QueryType.ALLOCATION in queries)
r.stop()

print("\n--- (9) a buffer list leaves as one list; its stale members go ---")
pipe = Gst.parse_launch(f"appsrc name=src is-live=true format=time caps=\"{CAPS['audiomixer']}\""
                        " ! mralignwatch name=aw ! fakesink sync=false async=false")
clock = Gst.SystemClock.obtain()
clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
pipe.use_clock(clock)
pipe.set_start_time(NONE)
pipe.set_base_time(0)
seen = []


def _on_list(_pad, info):
    if info.type & Gst.PadProbeType.BUFFER_LIST:
        lst = info.get_buffer_list()
        seen.append([(lst.get(j).pts, int(lst.get(j).get_flags())) for j in range(lst.length())])
    else:
        b = info.get_buffer()
        seen.append((b.pts, int(b.get_flags())))
    return Gst.PadProbeReturn.OK


aw, src = pipe.get_by_name("aw"), pipe.get_by_name("src")
aw.get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER | Gst.PadProbeType.BUFFER_LIST,
                                   _on_list)
pipe.set_state(Gst.State.PLAYING)
pipe.get_state(5 * S)
t0 = clock.get_time() // (10 * MS) * (10 * MS)


def _buf(ms):
    b = Gst.Buffer.new_wrapped(bytes(1920))
    b.pts, b.duration = t0 + ms * MS, 10 * MS
    return b


def _list(*ms):
    lst = Gst.BufferList.new()
    for m in ms:
        lst.insert(-1, _buf(m))
    return lst


def _wait_seen(n):
    deadline = time.monotonic() + 3
    while len(seen) < n and time.monotonic() < deadline:
        time.sleep(0.02)


src.emit("push-buffer-list", _list(0, 10, 20))
src.emit("push-buffer", _buf(100))
_wait_seen(2)   # released at its time: the horizon is now 110 ms
src.emit("push-buffer-list", _list(80, 90, 110))
_wait_seen(3)
check(f"lists: the first list leaves as one list of its 3 buffers (got {seen[:1]})",
      len(seen) >= 1 and [p for p, _f in seen[0]] == [t0, t0 + 10 * MS, t0 + 20 * MS])
check(f"lists: of a list behind the horizon only what is not stale goes, with DISCONT "
      f"(got {seen[2:3]}, stale {aw.get_property('stale-buffers')})",
      len(seen) == 3 and isinstance(seen[2], list) and [p for p, _f in seen[2]] == [t0 + 110 * MS]
      and seen[2][0][1] & int(Gst.BufferFlags.DISCONT) and aw.get_property("stale-buffers") == 2)
pipe.set_state(Gst.State.NULL)

print("\n--- mpegtsmux: (8) sparse: a late cue is forwarded at its own PTS ---")
cues = {50: b"\x06\x0e\x2b\x34cue-a", 150: b"\x06\x0e\x2b\x34cue-b", 250: b"\x06\x0e\x2b\x34cue-c"}


def _first_cue():
    """The cue source sends its caps with its first cue, long after the gaps began."""
    r.srcs[1].set_property("caps", Gst.Caps.from_string(KLV))
    r.push(1, 50, data=cues[50])


# Upstream's caps are fixed before any cue (a capsfilter here, tsdemux's pad in a mux route).
with StderrTap() as tap:
    r = Rig("mpegtsmux", [{}, {"caps": None, "chain": f"capsfilter caps={KLV}",
                               "props": {"sparse": True}}])
    r.run({0: [("rt", 0, 300, 0), ("eos",)],
           1: [("at", 500), ("call", _first_cue),
               ("at", 2300), ("call", lambda: r.push(1, 150, data=cues[150])),
               ("at", 2600), ("call", lambda: r.push(1, 250, data=cues[250])), ("eos",)]})
    eos = r.wait(lambda: r.eos_at is not None)
check(f"sparse: the gaps before the first cue went out under upstream's fixed caps, and the "
      f"cue's equal caps were not sent again (sticky {r.sticky(1)})", r.caps_then_segment(1))
check("sparse: no sticky event misordering on stderr", MISORDER not in tap.text)
with r.lock:
    late = [f for _t, src, f in r.msgs if src == "aw1" and f["reason"] == "late-cue"]
check(f"sparse: one late-cue message, the cue 800 ms late (got "
      f"{[round(f['cue-lateness'] / MS) for f in late]})",
      len(late) == 1 and abs(late[0]["cue-lateness"] - 800 * MS) <= SLACK
      and late[0]["cue-start"] == r.at(1500))
check(f"sparse: the pace is raised by it (got {r.prop(1, 'pace') / MS:.0f} ms)",
      r.prop(1, "pace") >= 800 * MS - SLACK
      and abs(r.prop(0, "pace") - r.prop(1, "pace")) <= 2 * MS)
klv = r.pes().get(PID0 + 1, [])
check(f"sparse: every cue written at its own PTS, intact, the late one included (got "
      f"{[(t, d) for t, d in klv]})",
      klv == [(pts90(r.at(k * 10)), cues[k]) for k in (50, 150, 250)])
check("sparse: the other input's buffers all written", r.pes_ok(0, range(300)))
check(f"sparse: never absent, gaps between cues (gaps {r.prop(1, 'gaps')})",
      r.prop(1, "absences") == 0 and r.prop(1, "gaps") > 20)
check("sparse: EOS, no error", eos and not r.errors)
r.stop()

print("\n--- mpegtsmux: (8b) sparse, its caps known only with its first cue ---")
# Nothing tells the gaps' caps before the first cue: they go out caps-less (mpegtsmux takes
# that, and creates the stream at the cue), never under caps made up from what the mux takes.
with StderrTap(expected=MISORDER) as tap:
    r = Rig("mpegtsmux", [{}, {"caps": None, "props": {"sparse": True}}])
    r.run({0: [("rt", 0, 300, 0), ("eos",)],
           1: [("at", 500), ("call", _first_cue),
               ("at", 2300), ("call", lambda: r.push(1, 150, data=cues[150])), ("eos",)]})
    eos = r.wait(lambda: r.eos_at is not None)
print(f"NOTE caps with the first cue: GStreamer warns of segment-before-caps on this path, as "
      f"expected ({tap.text.count(MISORDER)} warnings captured)")
st = r.sticky(1)
check(f"caps with the first cue: the gaps went out caps-less, the cue's caps came after their "
      f"segment (sticky {st})", st.count("caps") == 1 and "segment" in st
      and st.index("segment") < st.index("caps"))
klv = r.pes().get(PID0 + 1, [])
check(f"caps with the first cue: both cues written at their own PTS, intact (got {klv})",
      klv == [(pts90(r.at(k * 10)), cues[k]) for k in (50, 150)])
check("caps with the first cue: the other input's buffers all written, EOS, no error",
      r.pes_ok(0, range(300)) and eos and not r.errors)
r.stop()

print()
if _failures:
    print(f"{len(_failures)} FAILURE(S) in gst_mralignwatch_element_test.py")
    sys.exit(1)
print("ALL gst_mralignwatch_element_test.py TESTS PASSED")
