#!/usr/bin/env python3
"""mralignwatch (plan ch. 6 part 4.3, WI-P2-6), the input of a non-live aggregator, in front of
audiomixer and mpegtsmux. Live appsrc inputs are fed at real time on the house clock (monotonic,
base_time 0), as WI-P2-1's rig, each buffer k at content time k x 10 ms arriving `lag` late.

Cases: (1) a 1.5 s late but delivering input: nothing dropped, no absence; (2) a silent input,
and one that never delivers: absent within W + 2 ms, the aggregator goes on, gapped as its data
would come toward audiomixer (no fence, the mix no later) and to now - pace toward mpegtsmux;
(3) rejoin: absent at W with nothing queued, whatever the tick (B-79), stale buffers discarded
and counted, present again, the pace untouched by the backlog's drain,
(3b) a stale replay at real time counts as its lateness (B-81), (3c) back later than before:
gapped until the pace reaches it, the mixer never waits (B-80), (3d) also when it went absent
with data still queued; (4) an input whose lateness falls is still released at the pace;
(5) releasing a pad lowers the pace, by 1 s at once and the rest 2 s later (B-82);
(6) hold-on-eos; (7) a full queue blocks upstream, full-count 1, nothing dropped; (8) sparse: a
late cue is forwarded at its own PTS with a message and the pace's target raised. Plus the
defaults and the LATENCY answer, and
the caps a dark input's gaps go out under: (2c) a 302M-shaped branch, (2d) 8 channels, (2e) every
input dark, (2f) a branch dark at start that comes up, (2g) a hole the input reports, on in
block-long pieces (past a second whole, fenced), (2h) one longer than the time bound, the input
absent over it: no full queue (B-187), (2i) the same on a 302M fan-in branch from its demux on, its
link dark past the 5 s bound, (2j) content 6 s ahead after a forward jump with no GAP over it, its
queue counted from that content, (8b) a sparse stream whose caps come with its
first cue; (11)-(11e) an input added while playing (late, dark, on time, seeded, into gaps alone)
is gapped until it catches up, the pace slewing to a late one, so the mixer never stops on it,
(11f) the same into mpegtsmux, (11g) a rejoin's 2 s backlog moves no pace, (11h) a joiner within
50 ms of the pace is waited for; and (13) a backlog as an input's first data, waited for, the
pace from what follows it (an upstream aligner's start, WI-P2-8 B2), (14) inputs held by a paced
output still report each second; (15) at most one task pass per arrival while data flows,
whatever the tick, an input held behind the pace too, and (16) an absent input's gap pieces the
mixer's block at least (B-79); (17) the pace falls by itself once every input is steady under it
for fall-after, in one skip, content continuous (B-82), (17b) into mpegtsmux; (18) a fall wakes
an input held behind the pace at its next arrival, not at its old release (the armed check reads
the pace as of the arrival). And the PCM edges toward audiomixer (B-83), to the sample: (F1) an
absence fades out, (F2) a rejoin fades in from the horizon, (F3) a forwarded GAP's two edges,
(F4) a joiner's entry, (F5) the fade before a forwarded EOS, (F7) a hole in the data, (F8) the
formats and channel counts, (F9) a fade-in over short buffers, (F10) a tail under 1 ms, (F11) no
fade after a discard with sound before; (F6) nothing fades toward mpegtsmux.
Skips (exit 0) without GStreamer, the elements or the built plugin."""
import array
import math
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
# The PCM edges' fades (B-83): 5 ms of frames at 48 kHz, a half-Hann window.
FADE, FADE_FRAMES = 5 * MS, 240


def win(k, n=FADE_FRAMES):
    return 0.5 * (1.0 + math.cos(math.pi * k / n))


def scaled(v, g, code="h"):
    """A sample times a gain as the element writes it: rounded to even for integers, else as a
    float of the sample's width."""
    if code in ("h", "i"):
        return round(v * g)
    return array.array(code, [v * g])[0]

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


def in_ms(v):
    return None if v is None else round(v / MS, 1)


def out_lateness(r, a_ms, b_ms):
    """Median of when each mix output of content a..b ms left the mixer, after its start (ns)."""
    with r.lock:
        out = list(r.out)
    return median([t - pts for t, pts, nf, _d, _c in out if nf and r.at(a_ms) <= pts < r.at(b_ms)])


def out_gap(r, a_ms, b_ms):
    """The longest wait between two aggregator outputs (ns): of the mix's content a..b ms, or of
    the muxer's buffers arriving between content times a and b."""
    with r.lock:
        out = list(r.out)
    if r.mux:
        ts = [t for t, _p, _n, _d, _c in out if r.at(a_ms) <= t < r.at(b_ms)]
    else:
        ts = [t for t, pts, nf, _d, _c in out if nf and r.at(a_ms) <= pts < r.at(b_ms)]
    return max((b - a for a, b in zip(ts, ts[1:])), default=None)


class Poller:
    """Reads an element's pace every 50 ms on a thread of its own: (clock, ns)."""

    def __init__(self, r, i):
        self.r, self.i, self.reads, self.done = r, i, [], threading.Event()
        self.thread = threading.Thread(target=self._run)
        self.thread.start()

    def _run(self):
        while not self.done.is_set():
            self.reads.append((self.r.now(), self.r.prop(self.i, "pace")))
            time.sleep(0.05)

    def stop(self):
        self.done.set()
        self.thread.join()
        return self.reads


class Rig:
    """Live appsrc inputs, each through an mralignwatch of one pace group, into one
    aggregator on the house clock. `channels` and `fmt`: of the audio buffers pushed, input i's
    samples all `vals[i]`; `record`: keep what each mralignwatch pushes, samples too."""

    def __init__(self, kind, inputs, channels=2, tail="fakesink sync=false async=false",
                 fmt="S16LE", vals=VAL, record=False):
        self.kind, self.mux, self.channels = kind, kind == "mpegtsmux", channels
        self.code, self.vals, self.record = SAMPLE[fmt], vals, record
        self.srcs, self.aws, self.pads = [], [], []
        self.out, self.msgs, self.errors, self.eos_at = [], [], [], None
        self.rel = []                  # per input: what its mralignwatch pushed
        self.data = []                 # per input: (pts, duration, flags, samples) of its buffers
        self.lock = threading.Lock()
        self.pipe = Gst.parse_launch(f"{AGG[kind]} name=agg ! {tail}")
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
        # The elements start counting silence between these two (their PLAYING).
        self.starting_at = self.now()
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
                if self.record and not self.mux:
                    with self.lock:
                        self.data[i].append((b.pts, b.duration, int(b.get_flags()),
                                             array.array(self.code, b.extract_dup(0, b.get_size()))))
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
        self.data.append([])
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

    def push(self, i, k, data=None, pts=None, frames=BLOCK):
        """Input i's buffer k (content k x 10 ms), `frames` long."""
        if data is None:
            data = payload(i, k) if self.mux else array.array(
                self.code, [self.vals[i]] * self.channels * frames).tobytes()
        b = Gst.Buffer.new_wrapped(data)
        b.pts = self.at(k * 10) if pts is None else pts
        b.dts = NONE
        b.duration = frames * S // RATE
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

    def levels(self, upto_ms=None):
        """spans() to the ms with each fade (B-83) folded into the level after it: a ramp's runs,
        each under 1 ms, go, and the level after it starts where the ramp began. Trailing ramps go."""
        out, ramp = [], None
        for a, b, v in self.spans(upto_ms):
            if b - a < 1:
                ramp = a if ramp is None else ramp
                continue
            if ramp is not None:
                a, ramp = ramp, None
            if out and out[-1][2] == v:
                out[-1] = (out[-1][0], b, v)
            else:
                out.append((a, b, v))
        return [(round(a), round(b), v) for a, b, v in out]

    def frames_at(self, ms, n):
        """The mix's first-channel samples from content `ms`, `n` of them (None: not all out)."""
        want, got = round(ms * RATE / 1000), {}
        with self.lock:
            out = list(self.out)
        for _t, pts, nf, data, code in out:
            if not nf:
                continue
            off = round((pts - self.t0) * RATE / S)
            if off + nf <= want or off >= want + n:
                continue
            v = array.array(code, data)
            ch = len(v) // nf
            for j in range(max(want - off, 0), min(nf, want + n - off)):
                got[off + j] = v[ch * j]
        return [got.get(want + j) for j in range(n)] if len(got) == n else None

    def buf_at(self, i, ms):
        """(duration, flags, samples) of the first buffer input i's mralignwatch pushed at content
        `ms` (None: none)."""
        with self.lock:
            return next(((d, f, v) for p, d, f, v in self.data[i] if p == self.at(ms)), None)

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


def kept_from(h, base_ms, stale):
    """A joiner mixed from content `h` ms (to the ms: its fade-in's first frames read as silence)
    lost the `stale` 10 ms buffers from `base_ms` before the one that straddles it."""
    return base_ms + 10 * stale - 1 <= h <= base_ms + 10 * stale + 11


print("\n--- defaults and the LATENCY answer ---")
aw = Gst.ElementFactory.make("mralignwatch")
for prop, want in (("silence-factor", 3.0), ("silence-floor", 100 * MS), ("silence-ceiling", 2 * S),
                   ("max-size-time", 5 * S), ("max-size-bytes", 0), ("tick", 20 * MS),
                   ("seed-lateness", -1), ("sparse", False), ("hold-on-eos", False),
                   ("fall-after", 180 * S), ("state", "waiting"), ("pace", 0), ("pace-target", 0),
                   ("full-count", 0), ("abi", 1)):
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
        check(f"{kind}: all 2.5 s mixed from both inputs, nothing dropped, unfaded (got "
              f"{r.spans(2500)[:4]})", r.spans(2500) == [(0, 2500, VAL[0] + VAL[1])])
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
              f"(got {r.spans(3000)})",
              r.spans(3000) == [(0, 1400, VAL[1]), (1400, 3000, VAL[0] + VAL[1])])
        check(f"{kind}: EOS, no error", eos and not r.errors)
        r.stop()

    print(f"\n--- {kind}: (2) a silent input ---")
    # Input 0 runs 300 ms late, so the pace the silent input's GAPs keep is not 0.
    r = Rig(kind, [{}, {}], record=True)
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
    check(f"{kind}: absent within W + 2 ms of its last arrival (got "
          f"{since / MS if since is not None else None} ms)",
          since is not None and w <= since <= w + 2 * MS + SLACK)
    gaps = r.released(1, "gap")
    pace = r.prop(1, "pace")
    later = [g for g in gaps if absent and g[1] > absent[0] + 100 * MS]
    if mux:
        off = [(g[1] - pace) - (g[2] + g[3]) for g in later]
        check(f"{kind}: every tick a GAP reaching now - pace ({pace / MS:.0f} ms; worst "
              f"{max(off, default=-1) / MS:.1f} ms behind, {len(off)} gaps)",
              abs(pace - 300 * MS) <= SLACK and len(off) >= 30 and max(off) <= 20 * MS + SLACK
              and min(off) >= -2 * MS)
        fences = [g for g in gaps if g[3] == 0]
        check(f"{kind}: each GAP is followed by a zero-length one at its end (WI-P2-1 F2)",
              len(fences) >= len(gaps) // 2 and all(
                  gaps[j + 1][2] == gaps[j][2] + gaps[j][3] and gaps[j + 1][3] == 0
                  for j in range(len(gaps) - 1) if gaps[j][3]))
    else:
        # As the data would have come (WI-P2-14 F1): a buffer's length at its start + pace, the
        # first one's first 5 ms the fade-out (B-83), sent with the GAP of its other half.
        fade = r.buf_at(1, 1000)
        first = [g for g in gaps if g[2] == r.at(1005)]
        later = [g for g in later if g[2] >= r.at(1010)]
        off = [g[1] - pace - g[2] for g in later]
        check(f"{kind}: a GAP per 10 ms buffer, each sent at its start + pace ({pace / MS:.0f} ms; "
              f"{min(off, default=0) / MS:.1f} to {max(off, default=0) / MS:.1f} ms after it, "
              f"{len(off)} gaps)",
              abs(pace - 300 * MS) <= SLACK and len(off) >= 100 and min(off) >= -2 * MS
              and max(off) <= SLACK and all(g[3] == 10 * MS for g in later)
              and all(b[2] == a[2] + a[3] for a, b in zip(later, later[1:])))
        check(f"{kind}: the first 10 ms: the 5 ms fade-out, then a 5 ms GAP sent with it "
              f"(fade {fade and (fade[0], len(fade[2]))}, GAP {first[:1]})",
              fade is not None and fade[0] == FADE and len(fade[2]) == 2 * FADE_FRAMES
              and len(first) == 1 and first[0][3] == 5 * MS and abs(first[0][1] - r.at(1000) - pace)
              <= SLACK and r.prop(1, "fades") == 1)
        check(f"{kind}: no zero-length GAP: an audio aggregator takes each whole at its start, and "
              f"a fence would cost it a block", not [g for g in gaps if g[3] == 0])
        before, during = out_lateness(r, 400, 950), out_lateness(r, 1300, 2400)
        check(f"{kind}: the mix as late while input 1 is absent as before ({in_ms(before)} -> "
              f"{in_ms(during)} ms)",
              before is not None and during is not None and abs(during - before) <= 5 * MS)
    if mux:
        check(f"{kind}: the aggregator goes on: input 0's 250 buffers all written, input 1's 100, "
              f"nothing faded (B-83 F6)", r.pes_ok(0, range(250)) and r.pes_ok(1, range(100))
              and r.prop(1, "fades") == 0)
    else:
        check(f"{kind}: the aggregator goes on: input 1 silent from 1 s (got {r.levels(2500)})",
              r.levels(2500) == [(0, 1000, VAL[0] + VAL[1]), (1000, 2500, VAL[0])])
    check(f"{kind}: no error", not r.errors)
    r.stop()

    print(f"\n--- {kind}: (2b) an input that never delivers ---")
    r = Rig(kind, [{}, {}])
    r.run({0: [("rt", 0, 300, 0)]})
    r.wait(lambda: (r.reach() or 0) >= (2990 if mux else 3000))
    absent = [t for t, s in r.states(1) if s == "absent"]
    since = absent[0] - r.playing_at if absent else None
    check(f"{kind}: absent at the 2 s ceiling after PLAYING, never on a first buffer "
          f"(got {since / MS if since is not None else None} ms)",
          since is not None and absent[0] - r.starting_at >= 2000 * MS
          and since <= 2002 * MS + 2 * SLACK)
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
    # Both on time: input 1 has nothing queued when it stops. Toward audiomixer the tick shapes
    # nothing, so a 1 s one there shows absence comes at W, not at a tick (B-79).
    r = Rig(kind, [{}, {} if mux else {"props": {"tick": S}}])
    r.run({0: [("rt", 0, 300, 0), ("eos",)],
           1: [("rt", 0, 100, 0), ("at", 2000), ("now", 100, 200), ("rt", 200, 300, 0), ("eos",)]})
    eos = r.wait(lambda: r.eos_at is not None)
    stale, stale_t = r.prop(1, "stale-buffers"), r.prop(1, "stale-time")
    # Toward audiomixer the first fresh buffer can go too: it comes as the gap for it is due.
    check(f"{kind}: the second's backlog is stale: discarded and counted ({stale} buffers, "
          f"{stale_t / MS:.0f} ms)", 80 <= stale <= (100 if mux else 101)
          and stale_t == stale * 10 * MS)
    st = [s for _t, s in r.states(1)]
    check(f"{kind}: absent once, then present again (states {st})",
          st[-2:] == ["absent", "present"] and r.prop(1, "absences") == 1
          and r.prop(1, "state") == "present")
    if not mux:
        with r.lock:
            gone = next(((t, f["silence-limit"]) for t, src, f in r.msgs if src == "aw1"
                         and f["reason"] == "state" and f["state"] == "absent"), None)
        since = gone[0] - r.at(990) if gone else None
        check(f"{kind}: with nothing queued, absent at W after its last arrival, not at its 1 s "
              f"tick (got {in_ms(since)} ms, W {gone and in_ms(gone[1])} ms)",
              gone is not None and gone[1] <= since <= gone[1] + 2 * MS + SLACK)
    first = [b for b in r.released(1) if b[2] > r.at(1000)]
    check(f"{kind}: the first buffer out after the rejoin carries DISCONT (WI-P2-1 F3)",
          bool(first) and first[0][3] & int(Gst.BufferFlags.DISCONT))
    check(f"{kind}: the stale backlog says nothing of the input's lateness: the pace stays "
          f"(got {r.prop(1, 'pace') / MS:.1f} ms)", r.prop(1, "pace") <= SLACK)
    if mux:
        kept = [k for k in range(100, 300) if (r.at(k * 10) - r.t0) // (10 * MS) >= 100 + stale]
        check(f"{kind}: input 1's PES: its first second, then what was not stale, at their PTS",
              r.pes_ok(1, list(range(100)) + kept) and r.pes_ok(0, range(300)))
        check(f"{kind}: no fades toward mpegtsmux (B-83 F6: fades {r.prop(0, 'fades')}, "
              f"{r.prop(1, 'fades')})", r.prop(0, "fades") == 0 and r.prop(1, "fades") == 0)
    else:
        sp = r.levels(3000)
        h = sp[1][1] if len(sp) == 3 else None
        check(f"{kind}: input 1 rejoins at the horizon, placed by PTS (got {sp})",
              len(sp) == 3 and sp[0] == (0, 1000, VAL[0] + VAL[1]) and sp[1][2] == VAL[0]
              and sp[2] == (h, 3000, VAL[0] + VAL[1]) and abs(h - (1000 + 10 * stale)) <= 10)
    check(f"{kind}: EOS, no error", eos and not r.errors)
    r.stop()

    if not mux:
        print(f"\n--- {kind}: (3b) a rejoin that replays its stale backlog at real time ---")
        # Back after an absence with 0.7 s it missed, at real time and 0.8 s late, then live: all
        # of the replay ends behind the horizon, discarded, and says how late the input came: its
        # 0.8 s for 0.7 s counts (B-81), the target takes it and the pace slews to it.
        r = Rig(kind, [{}, {}])
        r.run({0: [("rt", 0, 400, 0), ("eos",)],
               1: [("rt", 0, 100, 0), ("at", 2000), ("rt", 120, 190, 800), ("rt", 270, 400, 0),
                   ("eos",)]})
        eos = r.wait(lambda: r.eos_at is not None)
        check(f"{kind}: the replay's 70 buffers are stale (got {r.prop(1, 'stale-buffers')})",
              r.prop(1, "stale-buffers") == 70)
        target, pace = r.prop(1, "pace-target"), r.prop(1, "pace")
        check(f"{kind}: its 0.8 s replay counted: the target {in_ms(target)} ms, the pace slewing "
              f"to it ({in_ms(pace)} ms)", abs(target - 800 * MS) <= SLACK and 0 < pace <= target)
        check(f"{kind}: EOS, no error", eos and not r.errors)
        r.stop()

        print(f"\n--- {kind}: (3c) back later than before: read from its own arrivals ---")
        # On time, silent, then back 300 ms late: no stretch reaches back across the absence. It
        # stays gapped while it catches up (B-80): its arrivals behind the gaps give its 300 ms,
        # the pace slews to it, and the mixer slows but never waits for it.
        reading = []
        r = Rig(kind, [{}, {}])
        r.run({0: [("rt", 0, 330, 0), ("call", lambda: reading.append(r.prop(1, "lateness"))),
                   ("rt", 330, 450, 0), ("eos",)],
               1: [("rt", 0, 100, 0), ("at", 2000), ("rt", 200, 450, 300), ("eos",)]})
        eos = r.wait(lambda: r.eos_at is not None)
        check(f"{kind}: 0.7 s after it is back it reads its 300 ms (got "
              f"{reading[0] / MS if reading else None} ms)",
              bool(reading) and abs(reading[0] - 300 * MS) <= SLACK)
        check(f"{kind}: absent once; EOS, no error",
              r.prop(1, "absences") == 1 and eos and not r.errors)
        gap = out_gap(r, 1900, 4300)
        check(f"{kind}: the mixer never waits for its return (largest gap between outputs "
              f"{in_ms(gap)} ms)", gap is not None and gap <= 20 * MS + SLACK)
        sp, stale = r.levels(4400), r.prop(1, "stale-buffers")
        h = sp[2][0] if len(sp) == 3 else None
        # 0.5 s to count, then 2 x 300 ms of slew: mixed again from about content 3.1 s.
        check(f"{kind}: mixed again once caught up, at about content 3.1 s, before that stale "
              f"({stale}; got {sp})",
              len(sp) == 3 and sp[1][2] == VAL[0] and sp[2] == (h, 4400, VAL[0] + VAL[1])
              and 3050 <= h <= 3150 + SLACK / MS and stale == int(h - 2000) // 10)
        check(f"{kind}: the pace is its 300 ms (got {in_ms(r.prop(0, 'pace'))} ms)",
              abs(r.prop(0, "pace") - 300 * MS) <= SLACK)
        r.stop()

        print(f"\n--- {kind}: (3d) absent with data still queued, back later than the pace ---")
        # Input 0 300 ms late holds input 1's queue 300 ms deep when it goes silent: what was still
        # queued leaves during its absence and is no catch-up. Back 500 ms late it is gapped until
        # the pace reaches it (B-80), so the mixer never waits for it.
        r = Rig(kind, [{}, {}])
        r.run({0: [("rt", 0, 500, 300), ("eos",)],
               1: [("rt", 0, 150, 0), ("at", 2500), ("rt", 250, 500, 500), ("eos",)]})
        eos = r.wait(lambda: r.eos_at is not None)
        gap = out_gap(r, 2400, 4800)
        check(f"{kind}: queued at its absence, the mixer never waits for its later return (longest "
              f"wait between outputs {in_ms(gap)} ms)", gap is not None and gap <= 20 * MS + SLACK)
        sp = r.levels(5000)
        h = sp[2][0] if len(sp) == 3 else None
        check(f"{kind}: mixed to 1.5 s, then from where it caught up, about content 3.4 s "
              f"(got {sp})",
              len(sp) == 3 and sp[0] == (0, 1500, VAL[0] + VAL[1]) and sp[1][2] == VAL[0]
              and sp[2] == (h, 5000, VAL[0] + VAL[1]) and 3330 <= h <= 3450 + SLACK / MS)
        check(f"{kind}: the pace its 500 ms, absent once, EOS, no error "
              f"(pace {in_ms(r.prop(0, 'pace'))})",
              abs(r.prop(0, "pace") - 500 * MS) <= SLACK and r.prop(1, "absences") == 1
              and eos and not r.errors)
        r.stop()

    print(f"\n--- {kind}: (4) an input whose lateness falls ---")
    r = Rig(kind, [{}, {}])
    # After the catch-up, more than a second at 200 ms, so its lateness leaves the burst behind.
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
        check(f"{kind}: nothing dropped (got {r.spans(4000)[:3]})",
              r.spans(4000) == [(0, 4000, VAL[0] + VAL[1])])
    check(f"{kind}: input 1's queue held the difference (level-time up to {held / MS:.0f} ms)",
          held >= 1000 * MS)
    check(f"{kind}: EOS, no error", eos and not r.errors)
    r.stop()

    print(f"\n--- {kind}: (5) releasing a pad lowers the pace ---")
    # The fall is a skip of at most 1 s, the rest 2 s later (B-82): 1.5 s -> 0.5 s at the release,
    # then input 0's own need.
    r = Rig(kind, [{}, {}])
    r.run({0: [("rt", 0, 300, 0), ("call", lambda: r.remove(1)), ("rt", 300, 600, 0), ("eos",)],
           1: [("rt", 0, 141, 1500)]})
    eos = r.wait(lambda: r.eos_at is not None)
    pace = r.prop(0, "pace")
    mid = [t - p for _k, t, p, _f in r.released(0) if r.at(3200) <= p < r.at(4400)]
    rel = [t - p for _k, t, p, _f in r.released(0) if p >= r.at(5200)]
    check(f"{kind}: input 1 released: the pace falls to input 0's need (got {pace / MS:.1f} ms)",
          pace <= SLACK)
    check(f"{kind}: ... 1 s at once (input 0 then 0.5 s behind, median "
          f"{in_ms(median(mid))} ms), the rest 2 s later: it leaves on arrival (median "
          f"{in_ms(median(rel))} ms)", len(mid) > 50 and abs(median(mid) - 500 * MS) <= SLACK
          and len(rel) > 50 and median(rel) <= SLACK)
    if mux:
        check(f"{kind}: nothing dropped", r.pes_ok(0, range(600)) and r.pes_ok(1, range(141)))
    else:
        check(f"{kind}: both mixed to 1.41 s, then input 0 alone (got {r.levels(6000)})",
              r.levels(6000) == [(0, 1410, VAL[0] + VAL[1]), (1410, 6000, VAL[0])])
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
        check(f"{kind}: nothing dropped (got {r.spans(2500)[:3]})",
              r.spans(2500) == [(0, 2500, VAL[0] + VAL[1])])
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
      bool(absent) and absent[0] - r.starting_at >= 2000 * MS
      and absent[0] - r.playing_at <= 2002 * MS + 2 * SLACK)
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
          bool(absent) and absent[0] - r.starting_at >= 2000 * MS
          and absent[0] - r.playing_at <= 2002 * MS + 2 * SLACK)
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
sp = r.levels(3500)
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

def out_at(r, ms):
    """When the mix output covering content `ms` left the mixer (None: it never did)."""
    t0 = r.at(ms)
    with r.lock:
        return next((t for t, pts, nf, _d, _c in r.out if pts <= t0 < pts + nf * S // RATE), None)


def out_late(r, a_ms, b_ms):
    """How long after its content's end the latest mix output of content a..b ms left (ns): a
    mixer that waited holds everything after the wait that much later."""
    with r.lock:
        return max((t - pts - nf * S // RATE for t, pts, nf, _d, _c in r.out
                    if nf and r.at(a_ms) <= pts < r.at(b_ms)), default=None)


print("\n--- audiomixer: (2g) a hole the input reports goes on in pieces, no fence ---")
# An ingest's gap marker through mrtsdemux: GAP [1, 1.5) s, sent with the data after it, as a
# restamp does. W (2 s) outlasts the hole, so the GAP alone carries the mixer over it.
r = Rig("audiomixer", [{}, {"props": {"silence-floor": 2 * S}}], record=True)
r.run({0: [("rt", 0, 300, 300), ("eos",)],
       1: [("rt", 0, 100, 0), ("at", 1500),
           ("call", lambda: r.srcs[1].send_event(Gst.Event.new_gap(r.at(1000), 500 * MS))),
           ("rt", 150, 300, 0), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
gaps = r.released(1, "gap")
fade = r.buf_at(1, 1000)
# Its first 5 ms are the fade-out (B-83): the GAP goes on from there in pieces of the block.
check(f"hole: the GAP went on after the 5 ms fade-out as 50 pieces of at most the 10 ms block, none "
      f"zero-length (fade {fade and fade[0]}; got {len(gaps)}, {sorted({g[3] // MS for g in gaps})} ms)",
      fade is not None and fade[0] == FADE and len(gaps) == 50
      and all(0 < g[3] <= 10 * MS for g in gaps) and gaps[0][2] == r.at(1005)
      and gaps[-1][2] + gaps[-1][3] == r.at(1500)
      and all(b[2] == a[2] + a[3] for a, b in zip(gaps, gaps[1:])))
t1500, pace = out_at(r, 1500), r.prop(1, "pace")
check(f"hole: the block after it out at the pace, no block more for a fence ("
      f"{in_ms(t1500 - r.at(1500) - pace) if t1500 else None} ms after it)",
      t1500 is not None and t1500 - r.at(1500) - pace <= 5 * MS)
check(f"hole: input 0 alone over it, nothing dropped (got {r.levels(3000)})",
      r.levels(3000) == [(0, 1000, VAL[0] + VAL[1]), (1000, 1500, VAL[0]),
                         (1500, 3000, VAL[0] + VAL[1])])
check("hole: input 1 never absent, EOS, no error",
      r.prop(1, "absences") == 0 and eos and not r.errors)
r.stop()

# Past a second (a content jump) one GAP and its fence: a block more once, not a GAP a block.
r = Rig("audiomixer", [{}, {"props": {"silence-floor": 2 * S}}], record=True)
r.run({0: [("rt", 0, 300, 300), ("eos",)],
       1: [("rt", 0, 100, 0), ("at", 2500),
           ("call", lambda: r.srcs[1].send_event(Gst.Event.new_gap(r.at(1000), 1500 * MS))),
           ("rt", 250, 300, 0), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
gaps = [(g[2] - r.at(0), g[3]) for g in r.released(1, "gap")]
check(f"jump: the 5 ms fade-out, the rest of the 1.5 s GAP whole, then its fence (got "
      f"{[(a // MS, d // MS) for a, d in gaps]})",
      (r.buf_at(1, 1000) or (0,))[0] == FADE and gaps == [(1005 * MS, 1495 * MS), (2500 * MS, 0)])
check(f"jump: input 0 alone over it, nothing dropped (got {r.levels(3000)})",
      r.levels(3000) == [(0, 1000, VAL[0] + VAL[1]), (1000, 2500, VAL[0]),
                         (2500, 3000, VAL[0] + VAL[1])] and eos and not r.errors)
r.stop()

print("\n--- mpegtsmux: (2h) a hole longer than the time bound, absent over it: no full queue ---")
# A producer silent past max-size-time: the demux's GAP over the hole, sent with the data after it,
# reaches back past the horizon, where it goes out clipped: no queued time (B-187); counted from its
# start it read as a full queue. The 500 ms pace keeps the GAP's tail queued as that data comes in.
r = Rig("mpegtsmux", [{"props": {"seed-lateness": 500 * MS}}, {"props": {"max-size-time": 1500 * MS}}])
r.run({0: [("rt", 0, 500, 500), ("eos",)],
       1: [("rt", 0, 100, 0), ("at", 4000),
           ("call", lambda: r.srcs[1].send_event(Gst.Event.new_gap(r.at(1000), 3000 * MS))),
           ("rt", 400, 500, 0), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
with r.lock:
    full = [f for _t, src, f in r.msgs if src == "aw1" and f["reason"] == "full"]
    back = [f["level-time"] for t, src, f in r.msgs if src == "aw1" and f["reason"] == "state"
            and f["state"] == "present" and t >= r.at(3500)]
check(f"long hole: input 1 absent once over its 3 s silence; back, its queue counted from the "
      f"horizon, under its 1.5 s bound (level-time {back[0] // MS if back else None} ms, about the "
      f"pace), never full (full-count {r.prop(1, 'full-count')}, {len(full)} `full` messages)",
      r.prop(1, "absences") == 1 and back and back[0] < 1500 * MS
      and r.prop(1, "full-count") == 0 and not full)
after = [(t, d) for t, d in r.pes().get(PID0 + 1, []) if t is not None and t >= pts90(r.at(4000))]
check(f"long hole: its data after the hole all written at its PTS, EOS, no error ({len(after)} of 100)",
      after == [(pts90(r.at(k * 10)), payload(1, k)) for k in range(400, 500)] and eos and not r.errors)
r.stop()


def s302m_pes(r, ks, val):
    """{k: the TS of block k's PES}: 10 ms stereo blocks of `val` at content k x 10 ms through
    avenc_s302m ! mpegtsmux, as every 302M module encodes; PSI rides with the PES before it."""
    gen = Gst.parse_launch(
        f'appsrc name=pcm format=time caps="{CAPS["audiomixer"]}" ! avenc_s302m strict=experimental'
        " ! mpegtsmux latency=0 alignment=7 ! appsink name=ts sync=false max-buffers=0 drop=false")
    src, sink = gen.get_by_name("pcm"), gen.get_by_name("ts")
    gen.set_state(Gst.State.PLAYING)
    for k in ks:
        b = Gst.Buffer.new_wrapped(array.array("h", [val] * 2 * BLOCK).tobytes())
        b.pts, b.duration = r.at(k * 10), BLOCK * S // RATE
        src.emit("push-buffer", b)
    src.emit("end-of-stream")
    data = bytearray()
    while (smp := sink.emit("try-pull-sample", 5 * S)) is not None:
        buf = smp.get_buffer()
        data += buf.extract_dup(0, buf.get_size())
    gen.set_state(Gst.State.NULL)
    chunks, cur, pes = [], bytearray(), False
    for off in range(0, len(data) - 187, 188):
        p = data[off:off + 188]
        afc = (p[3] >> 4) & 3
        body = p[5 + p[4]:] if afc == 3 else p[4:]
        if p[1] & 0x40 and afc & 1 and body[:3] == b"\0\0\1":   # a PES starts here
            if pes:
                chunks.append(bytes(cur))
                cur = bytearray()
            pes = True
        cur += p
    chunks.append(bytes(cur))
    return dict(zip(ks, chunks)) if len(chunks) == len(ks) else {}


print("\n--- audiomixer: (2i) a 302M fan-in branch dark past the 5 s bound: no full queue ---")
# The release line's fan-in from its demux on (decode302m, build302mMixBranch's caps, alignWatch's
# hold-on-eos), fed a remote's 302M TS whose link drops 6 s: first back is the demux's GAP over the
# hole (B-187). Input 0's 300 ms pace keeps the data after it ahead of the horizon.
if Gst.ElementFactory.find("avenc_s302m") and Gst.ElementFactory.find("avdec_s302m"):
    FANIN = ("mrtsdemux name=dmx1 select=audio/x-smpte-302m ! avdec_s302m ! audioconvert"
             " ! audioresample ! capsfilter caps=audio/x-raw,rate=48000,channels=2")
    r = Rig("audiomixer", [{"props": {"seed-lateness": 300 * MS}},
                           {"chain": FANIN, "props": {"hold-on-eos": True},
                            "caps": "video/mpegts,systemstream=(boolean)true,packetsize=(int)188"}])
    ks = list(range(0, 100)) + list(range(700, 900))
    ts = s302m_pes(r, ks, VAL[1])

    def _remote():
        for k in ks if ts else ():   # each PES once its 10 ms block is whole
            r.sleep_until(r.at(k * 10 + 10))
            r.srcs[1].emit("push-buffer", Gst.Buffer.new_wrapped(ts[k]))

    r.run({0: [("rt", 0, 900, 300), ("eos",)], 1: [("call", _remote), ("eos",)]})
    r.wait(lambda: (r.reach() or 0) >= 9000, 6.0)
    with r.lock:
        full = [f for _t, src, f in r.msgs if src == "aw1" and f["reason"] == "full"]
        back = [f["level-time"] for t, src, f in r.msgs if src == "aw1" and f["reason"] == "state"
                and f["state"] == "present" and t >= r.at(6500)]
    gone = [t for t, s in r.states(1) if s == "absent" and r.at(1000) <= t < r.at(7000)]
    gaps = r.pipe.get_by_name("dmx1").get_property("gaps")
    check(f"302M fan-in: one PES a block ({len(ts)} of {len(ks)}), one demux GAP over the 6 s hole "
          f"({gaps}), input 1 absent once over it; back, its queue counted from the horizon, under "
          f"its 5 s bound (level-time {back[0] // MS if back else None} ms, about the pace), never "
          f"full (full-count {r.prop(1, 'full-count')}, {len(full)} `full` messages)",
          len(ts) == len(ks) and gaps == 1 and len(gone) == 1 and back and back[0] < 5000 * MS
          and r.prop(1, "full-count") == 0 and not full)
    check(f"302M fan-in: input 0 alone over the hole, input 1 mixed from its return, no error "
          f"(got {r.levels(9000)})",
          r.levels(9000) == [(0, 1000, VAL[0] + VAL[1]), (1000, 7000, VAL[0]),
                             (7000, 9000, VAL[0] + VAL[1])] and not r.errors)
    r.stop()
else:
    print("SKIP (2i) — gst-libav's avenc_s302m/avdec_s302m unavailable")

print("\n--- mpegtsmux: (2j) content 6 s ahead after a forward jump, no GAP over it: no full queue ---")
# Back from a short silence with its content 6 s on, past the 5 s bound, and no GAP over the jump (a
# tsdemux route makes none): the queue counts from that content's start, the later of it and the
# horizon (B-187); from the horizon alone it would read the jump, full, upstream held.
r = Rig("mpegtsmux", [{}, {}])
r.run({0: [("rt", 0, 900, 0), ("eos",)], 1: [("rt", 0, 100, 0), ("rt", 720, 770, -6000), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
with r.lock:
    full = [f for _t, src, f in r.msgs if src == "aw1" and f["reason"] == "full"]
    held = [f["level-time"] for t, src, f in r.msgs if src == "aw1" and r.at(1200) <= t < r.at(7200)]
check(f"forward jump: input 1's queue counted from its content after the jump, about that 0.5 s (at "
      f"most {max(held, default=0) // MS} ms in {len(held)} reports while it waited), never full "
      f"(full-count {r.prop(1, 'full-count')}, {len(full)} `full` messages)",
      len(held) >= 4 and max(held) <= 600 * MS and r.prop(1, "full-count") == 0 and not full)
check("forward jump: both inputs' data all written at its PTS, the content after the jump too, EOS, no error",
      r.pes_ok(0, range(900)) and r.pes_ok(1, list(range(100)) + list(range(720, 770))) and eos
      and not r.errors)
r.stop()

# A live add joins a running mixer: the joiner is gapped until its content catches up, so the
# others never stall on it; what it sends behind the gaps is stale (the rejoin rule) and gives its
# lateness, which the pace slews to at half speed (B-80): 0.5 s to count, 2 x 300 ms to slew.
print("\n--- audiomixer: (11) an input added while playing, 300 ms late ---")
r = Rig("audiomixer", [{}])
poll = Poller(r, 0)
r.run({0: [("rt", 0, 300, 0), ("eos",)],
       1: [("at", 950), ("call", lambda: r.add({}, live=True)), ("rt", 100, 300, 300), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
reads = poll.stop()
rel = [t - p for _k, t, p, _f in r.released(0) if p >= r.at(2500)]
check(f"joined: the pace rose to the joiner's 300 ms (got {r.prop(0, 'pace') / MS:.0f} ms, target "
      f"{r.prop(0, 'pace-target') / MS:.0f} ms)",
      abs(r.prop(0, "pace") - 300 * MS) <= SLACK
      and abs(r.prop(1, "pace") - r.prop(0, "pace")) <= 2 * MS
      and abs(r.prop(0, "pace-target") - 300 * MS) <= SLACK)
check(f"joined: the first input is held to it (median {median(rel) / MS:.0f} ms)",
      len(rel) > 30 and abs(median(rel) - 300 * MS) <= SLACK)
gap = out_gap(r, 900, 2900)
check(f"joined: the mixer never stops for the joiner, it slows: the longest wait between its "
      f"outputs {in_ms(gap)} ms", gap is not None and gap <= 20 * MS + SLACK)
lo = next((t for t, v in reversed(reads) if v <= 10 * MS), None)
hi = next((t for t, v in reads if v >= 290 * MS), None)
steps = [(b[1] - a[1]) - (b[0] - a[0]) // 2 for a, b in zip(reads, reads[1:])]
mono = all(b[1] >= a[1] for a, b in zip(reads, reads[1:]))
check(f"joined: the pace polled every 50 ms rises from 10 to 290 ms over 0.5-0.7 s, monotone, "
      f"never faster than the slew (rise {in_ms(hi - lo) if lo and hi else None} ms, largest "
      f"excess {in_ms(max(steps, default=0))} ms over half the time between reads)",
      lo is not None and hi is not None and 500 * MS <= hi - lo <= 700 * MS + SLACK and mono
      and max(steps, default=0) <= 10 * MS)
sp = r.levels()
h = sp[1][0] if len(sp) == 2 else None
stale = r.prop(1, "stale-buffers")
check(f"joined: mixed from where it caught up, about content 2.1 s, before that stale "
      f"({stale} buffers; got {sp})",
      len(sp) == 2 and sp[0] == (0, h, VAL[0]) and sp[1] == (h, 3000, VAL[0] + VAL[1])
      and 2050 <= h <= 2150 + SLACK / MS and kept_from(h, 1000, stale))
check("joined: no absence, EOS, no error",
      r.prop(1, "absences") == 0 and eos and not r.errors)
r.stop()

print("\n--- audiomixer: (11b) a dark 302M-shaped input added while playing ---")
joined = []


def _join_dark():
    joined.append(r.now())
    r.add({"chain": BRANCH, "caps": None}, live=True)


r = Rig("audiomixer", [{"chain": BRANCH}])
r.run({0: [("rt", 0, 350, 0)], 1: [("at", 950), ("call", _join_dark)]})
r.wait(lambda: (r.reach() or 0) >= 3500)
late = out_late(r, 900, 3400)
check(f"dark joiner: the mixer never waits for it (its output at most "
      f"{late / MS if late else None} ms late)", late is not None and late <= 20 * MS + SLACK)
check(f"dark joiner: the first input mixed throughout, nothing dropped (got {r.spans(3500)})",
      r.spans(3500) == [(0, 3500, VAL[0])])
gaps = r.released(1, "gap")
check(f"dark joiner: gapped from its join ({(gaps[0][1] - joined[0]) / MS if gaps else None} ms)",
      bool(gaps) and gaps[0][1] - joined[0] <= 20 * MS + SLACK)
absent = [t for t, s in r.states(1) if s == "absent"]
check(f"dark joiner: waiting, then absent at the 2 s ceiling (states {r.states(1)}, "
      f"{(absent[0] - joined[0]) / MS if absent else None} ms)",
      [s for _t, s in r.states(1)] == ["absent"]
      and 2000 * MS <= absent[0] - joined[0] <= 2002 * MS + 2 * SLACK)
check(f"dark joiner: the pace untouched (got {r.prop(0, 'pace') / MS:.1f} ms)",
      r.prop(0, "pace") <= 5 * MS)
check(f"dark joiner: no error (got {r.errors})", not r.errors)
r.stop()

print("\n--- audiomixer: (11c) an on-time input added while playing ---")
r = Rig("audiomixer", [{}])
r.run({0: [("rt", 0, 300, 0), ("eos",)],
       1: [("at", 950), ("call", lambda: r.add({}, live=True)), ("rt", 100, 300, 0), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
sp = r.levels()
h = sp[1][0] if len(sp) == 2 else None
check(f"on time: mixed from its first buffer (got {sp})",
      len(sp) == 2 and sp[0] == (0, h, VAL[0]) and sp[1] == (h, 3000, VAL[0] + VAL[1])
      and 1000 <= h <= 1020)
late = out_late(r, 900, 2900)
check(f"on time: no wait, at most one buffer stale (output at most "
      f"{late / MS if late is not None else None} ms late, stale {r.prop(1, 'stale-buffers')})",
      late is not None and late <= 20 * MS + SLACK and r.prop(1, "stale-buffers") <= 1)
check("on time: no absence, EOS, no error", r.prop(1, "absences") == 0 and eos and not r.errors)
r.stop()

print("\n--- audiomixer: (11d) a seeded input added while playing, 300 ms late ---")
# Its seed raises the target at the join (B-80): the pace slews from there, so it is 300 ms 0.6 s
# later and the joiner's content, which comes 0.35 s after its join, is kept from about 1.25 s.
r = Rig("audiomixer", [{}])
r.run({0: [("rt", 0, 300, 0), ("eos",)],
       1: [("at", 950), ("call", lambda: r.add({"props": {"seed-lateness": 300 * MS}}, live=True)),
           ("rt", 100, 300, 300), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
rel = [t - p for _k, t, p, _f in r.released(0) if p >= r.at(1700)]
check(f"seeded: the pace is the seed from the join + 0.6 s (got {r.prop(0, 'pace') / MS:.0f} ms), "
      f"the first input held to it (median {median(rel) / MS if rel else None} ms)",
      abs(r.prop(0, "pace") - 300 * MS) <= SLACK
      and bool(rel) and abs(median(rel) - 300 * MS) <= SLACK)
sp = r.levels()
h = sp[1][0] if len(sp) == 2 else None
stale = r.prop(1, "stale-buffers")
check(f"seeded: mixed from where it caught up, about content 1.25 s, before that stale (got {sp}, "
      f"stale {stale})",
      len(sp) == 2 and sp[0] == (0, h, VAL[0]) and sp[1] == (h, 3000, VAL[0] + VAL[1])
      and 1200 <= h <= 1300 + SLACK / MS and kept_from(h, 1000, stale))
gap = out_gap(r, 900, 2900)
check(f"seeded: the mixer never stops for it (longest wait between outputs {in_ms(gap)} ms)",
      gap is not None and gap <= 20 * MS + SLACK)
check("seeded: no absence, EOS, no error", r.prop(1, "absences") == 0 and eos and not r.errors)
r.stop()

print("\n--- audiomixer: (11e) a dark input added to a mixer running on gaps alone ---")
# Gaps out start the group as data does: the silent mix does not wait for the joiner either.
r = Rig("audiomixer", [{"chain": BRANCH, "caps": None}])
r.run({1: [("at", 2500), ("call", lambda: r.add({"chain": BRANCH, "caps": None}, live=True))]})
r.wait(lambda: (r.reach() or 0) >= 4600, 8.0)
late = out_late(r, 2400, 4500)
check(f"gaps alone: the silent mix never waits for the dark joiner (output at most "
      f"{late / MS if late else None} ms late)", late is not None and late <= 20 * MS + SLACK)
check(f"gaps alone: no error (got {r.errors})", not r.errors)
r.stop()

print("\n--- mpegtsmux: (11f) an input added while playing, 300 ms late ---")
# The same into the muxer (B-80, the round's F7): the TS slows, never stops, and the joiner's PES
# start where it caught up.
r = Rig("mpegtsmux", [{}])
r.run({0: [("rt", 0, 300, 0), ("eos",)],
       1: [("at", 950), ("call", lambda: r.add({}, live=True)), ("rt", 100, 300, 300), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
gap = out_gap(r, 900, 2900)
check(f"mux joiner: the TS never stops (longest wait between its buffers {in_ms(gap)} ms)",
      gap is not None and gap <= 20 * MS + SLACK)
k0 = 300 - len(r.pes().get(PID0 + 1, []))
stale = r.prop(1, "stale-buffers")
check(f"mux joiner: its PES from where it caught up, about content 2.1 s, each at its PTS, intact; "
      f"before that stale ({stale}; the first at {k0 * 10} ms)",
      r.pes_ok(1, range(k0, 300)) and 200 <= k0 <= 220 + SLACK // (10 * MS) and stale == k0 - 100)
check(f"mux joiner: the other input's buffers all written, the pace 300 ms (got "
      f"{in_ms(r.prop(0, 'pace'))} ms)",
      r.pes_ok(0, range(300)) and abs(r.prop(0, "pace") - 300 * MS) <= SLACK)
check("mux joiner: no absence, EOS, no error", r.prop(1, "absences") == 0 and eos and not r.errors)
r.stop()

print("\n--- audiomixer: (11g) a rejoin with a 2 s backlog: its drain moves no pace ---")
# Its stale arrivals are observed (B-81), but a backlog that comes at once falls over every
# stretch, so none counts (B-57): the target stays, and the input is kept from its first buffer
# past the gaps.
r = Rig("audiomixer", [{}, {}])
r.run({0: [("rt", 0, 450, 0), ("eos",)],
       1: [("rt", 0, 100, 0), ("at", 3000), ("now", 100, 300), ("rt", 300, 450, 0), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
target, stale = r.prop(1, "pace-target"), r.prop(1, "stale-buffers")
sp = r.levels(4500)
h = sp[2][0] if len(sp) == 3 else None
check(f"backlog rejoin: kept from its first buffer past the gaps, about content 3 s, the rest "
      f"stale ({stale}; got {sp})",
      len(sp) == 3 and sp[0] == (0, 1000, VAL[0] + VAL[1]) and sp[1][2] == VAL[0]
      and sp[2] == (h, 4500, VAL[0] + VAL[1]) and 2980 <= h <= 3020 + SLACK / MS
      and stale == int(h - 1000) // 10)
check(f"backlog rejoin: the drain moved the target by at most 5 ms (got {in_ms(target)} ms)",
      target <= 5 * MS)
check("backlog rejoin: absent once, EOS, no error",
      r.prop(1, "absences") == 1 and eos and not r.errors)
r.stop()

print("\n--- audiomixer: (11h) a joiner 40 ms later than the pace is waited for ---")
# Within 50 ms of the gaps' end and no rise under way, its catch-up ends at its first arrival
# (B-80): the mixer waits about 40 ms for it, under any downstream W, and keeps all but its first
# buffers, where a slew would have cost it half a second.
r = Rig("audiomixer", [{}])
r.run({0: [("rt", 0, 300, 0), ("eos",)],
       1: [("at", 950), ("call", lambda: r.add({}, live=True)), ("rt", 100, 300, 40), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
sp, stale, gap = r.levels(), r.prop(1, "stale-buffers"), out_gap(r, 900, 2900)
h = sp[1][0] if len(sp) == 2 else None
check(f"close joiner: mixed from about its first buffer, at most 6 stale ({stale}; got {sp})",
      len(sp) == 2 and sp[1] == (h, 3000, VAL[0] + VAL[1]) and 1000 <= h <= 1060 and stale <= 6
      and kept_from(h, 1000, stale))
check(f"close joiner: the mixer waits for it about 40 ms, once (longest wait {in_ms(gap)} ms)",
      gap is not None and gap <= 60 * MS + SLACK)
check(f"close joiner: the pace its 40 ms, stepped (got {in_ms(r.prop(0, 'pace'))} ms); no absence, "
      f"EOS, no error", abs(r.prop(0, "pace") - 40 * MS) <= SLACK and r.prop(1, "absences") == 0
      and eos and not r.errors)
r.stop()

print("\n--- audiomixer: (12) a seed sets the pace from the start ---")
# Input 1 behind an identity, which sends an ALLOCATION query (appsrc's own) downstream.
r = Rig("audiomixer", [{"props": {"seed-lateness": 800 * MS}}, {"chain": "identity"}])
r.run({0: [("rt", 0, 150, 0), ("eos",)], 1: [("rt", 0, 150, 0), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
rel = [[t - p for _k, t, p, _f in r.released(i) if p < r.at(1500)] for i in (0, 1)]
check(f"seed: the pace is the 800 ms seed though both inputs are on time (got "
      f"{r.prop(1, 'pace') / MS:.0f} ms)", r.prop(1, "pace") == 800 * MS)
check(f"seed: both released at the seed from their first buffer (first {rel[0][:1]}, {rel[1][:1]})",
      all(len(v) == 150 and abs(v[0] - 800 * MS) <= SLACK and abs(median(v) - 800 * MS) <= SLACK
          for v in rel))
check("seed: nothing dropped, EOS, no error",
      r.spans(1500) == [(0, 1500, VAL[0] + VAL[1])] and eos and not r.errors)
with r.lock:
    queries = [q[2] for q in r.rel[1] if q[0] == "query"]
check(f"queries: the ALLOCATION query taken in went on, in order through the queue "
      f"(out {queries[:3]})", Gst.QueryType.ALLOCATION in queries)
r.stop()

print("\n--- audiomixer: (13) a backlog as an input's first data leaves the pace alone ---")
# What an upstream aligner emits after waiting at its start (WI-P2-8 B2): 1.8 s of content at
# once, then 40 ms late. The pace is the 40 ms, not the backlog's (by arrivals about 700 ms).
# That first push comes 2.0 s after PLAYING (t0 is 0.2 s on): a 3 s start ceiling keeps it in.
r = Rig("audiomixer", [{}, {"props": {"silence-ceiling": 3 * S}}])
r.run({0: [("rt", 0, 300, 0), ("eos",)],
       1: [("at", 1800), ("now", 0, 180), ("rt", 180, 300, 40), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
pace = r.prop(1, "pace")
check(f"backlog first: the pace is the input's 40 ms after it (got {pace / MS:.1f} ms)",
      abs(pace - 40 * MS) <= 15 * MS and abs(r.prop(0, "pace") - pace) <= 2 * MS)
check(f"backlog first: it was waited for, nothing dropped (got {r.spans(3000)[:3]})",
      r.spans(3000) == [(0, 3000, VAL[0] + VAL[1])] and r.prop(1, "stale-buffers") == 0)
rel = [t - p for _k, t, p, _f in r.released(0) if p >= r.at(2500)]
check(f"backlog first: the other input is released at that pace once it is past (median "
      f"{median(rel) / MS if rel else None} ms)",
      len(rel) > 30 and abs(median(rel) - pace) <= SLACK)
check("backlog first: EOS, no error", eos and not r.errors)
r.stop()

print("\n--- audiomixer: (14) inputs held by a paced output still report each second ---")
# A tail that syncs late (audio-output-302m's identity sync=true and its sink's ts-offset) holds
# the mixer: each input's head is due whenever its push returns, so it releases on every pass.
r = Rig("audiomixer", [{}, {}],
        tail="identity sync=true ! fakesink sync=true ts-offset=200000000 async=false")
r.run({0: [("rt", 0, 300, 0), ("eos",)], 1: [("rt", 0, 300, 0), ("eos",)]})
r.wait(lambda: r.eos_at is not None)
with r.lock:
    reps = [[t for t, src, f in r.msgs if src == f"aw{i}" and f["reason"] == "interval"
             and t < r.at(2990)] for i in (0, 1)]
check(f"paced output: both inputs report each second while they release (got "
      f"{[len(x) for x in reps]} reports in the first 3 s)", all(len(x) >= 2 for x in reps))
check(f"paced output: all 3 s mixed, no error (got {r.spans(3000)[:2]})",
      r.spans(3000) == [(0, 3000, VAL[0] + VAL[1])] and not r.errors)
r.stop()

print("\n--- audiomixer: (15) at most one task pass per arrival while data flows ---")
# 10 ms inputs under a 2 ms tick, input 1 5 ms later than input 0: input 1's task runs for its
# arrival, not for a tick, its head due within the 1 ms slack; input 0, held 4 ms behind the
# pace, sleeps to its next buffer's release, which its arrival does not cut short (B-79).
r = Rig("audiomixer", [{"props": {"tick": 2 * MS}}, {"props": {"tick": 2 * MS}}])
r.run({0: [("rt", 0, 400, 0), ("eos",)], 1: [("rt", 0, 400, 5), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
per = []
with r.lock:
    reps = [[(t, f["passes"]) for t, src, f in r.msgs if src == f"aw{i}"
             and f["reason"] == "interval" and t < r.at(3990)] for i in (0, 1)]
for i, rep in enumerate(reps):
    if len(rep) >= 2:
        (ta, pa), (tb, pb) = rep[0], rep[-1]
        arrivals = sum(1 for k in range(400) if ta < r.at(k * 10 + 5 * i) <= tb)
        per.append(round((pb - pa) / max(arrivals, 1), 3))
held = median([t - p for _k, t, p, _f in r.released(0)[100:]])
check(f"one pass per arrival: each input's task ran once a buffer between its reports, a "
      f"report's own wake included, input 0 held {in_ms(held)} ms (got {per} passes per arrival)",
      len(per) == 2 and all(p <= 1.1 for p in per) and held is not None
      and 3 * MS <= held <= 5 * MS + SLACK)
check(f"one pass per arrival: all 4 s mixed, EOS, no error (got {r.spans(4000)[:2]})",
      r.spans(4000) == [(0, 4000, VAL[0] + VAL[1])] and eos and not r.errors)
r.stop()

print("\n--- audiomixer: (16) an absent input's pieces are the mixer's block at least ---")
# Its last buffers were 1 ms long: pieces of the 10 ms block, 100 a second, not 1,000 (B-79).
r = Rig("audiomixer", [{}, {}], record=True)


def _ms_buffers():
    """Input 1: content 0..1 s as 1 ms buffers at real time, then silence."""
    for k in range(1000):
        r.sleep_until(r.at(k))
        b = Gst.Buffer.new_wrapped(array.array("h", [VAL[1]] * 2 * (RATE // 1000)).tobytes())
        b.pts, b.dts, b.duration = r.at(k), NONE, MS
        r.srcs[1].emit("push-buffer", b)


r.run({0: [("rt", 0, 300, 0)], 1: [("call", _ms_buffers)]})
r.wait(lambda: (r.reach() or 0) >= 3000)
absent = [t for t, s in r.states(1) if s == "absent"]
gaps = r.released(1, "gap")
later = [g for g in gaps if absent and g[1] > absent[0] + 100 * MS]
span_s = (later[-1][1] - later[0][1]) / S if len(later) > 1 else 0
check(f"1 ms buffers: absent, then gapped from its last content (after the 5 ms fade-out of its "
      f"last five buffers) in pieces of the 10 ms block, about 100 a second (got "
      f"{sorted({g[3] // MS for g in later})} ms, {len(later)} in {span_s:.2f} s)",
      bool(absent) and bool(gaps) and gaps[0][2] == r.at(1005) and gaps[0][3] == 5 * MS
      and (r.buf_at(1, 1000) or (0,))[0] == FADE and len(later) >= 100
      and all(g[3] == 10 * MS for g in later) and len(later) <= 110 * span_s + 2
      and all(b[2] == a[2] + a[3] for a, b in zip(gaps, gaps[1:])))
check(f"1 ms buffers: mixed to 1 s, then input 0 alone (got {r.levels(3000)})",
      r.levels(3000) == [(0, 1000, VAL[0] + VAL[1]), (1000, 3000, VAL[0])])
check("1 ms buffers: no error", not r.errors)
r.stop()

# B-82: input 1 300 ms late for 2 s, then on time (its backlog at once). Its 300 ms holds the pace
# 2 to 3 buckets of fall-after / 2 after its last count, then falls in one skip; the FIFOs release
# what became due at once, nothing lost or repeated, and one input's message says by how much.
FA = {"props": {"fall-after": 3 * S}}
N17 = 850
for kind in KINDS:
    mux = kind == "mpegtsmux"
    print(f"\n--- {kind}: (17) the pace falls by itself (fall-after 3 s) ---")
    r = Rig(kind, [FA, FA])
    r.run({0: [("rt", 0, N17, 0), ("eos",)],
           1: [("rt", 0, 200, 300), ("rt", 200, N17, 0), ("eos",)]})
    eos = r.wait(lambda: r.eos_at is not None)
    steady = r.at(2290)   # input 1's last late buffer; its backlog, then on time
    with r.lock:
        fell = [(t, f) for t, _src, f in r.msgs if f["reason"] == "pace-fell"]
    at = fell[0][0] if fell else None
    with r.lock:
        before = [f["pace"] for t, src, f in r.msgs if src == "aw0" and f["reason"] == "interval"
                  and r.at(1600) <= t < (at or 0) - 200 * MS]
    check(f"{kind}: the pace holds input 1's 300 ms while its window holds it ({len(before)} "
          f"reports from 1.6 s, {in_ms(min(before, default=None))} to "
          f"{in_ms(max(before, default=None))} ms)",
          len(before) >= 3 and all(abs(p - 300 * MS) <= SLACK for p in before))
    got = [(in_ms(t - steady), in_ms(f["fell"])) for t, f in fell]
    check(f"{kind}: one fall, of about 300 ms, 3 to 5 s after input 1 went steady (half a second "
          f"to count, two to three buckets of 1.5 s; got {got})",
          len(fell) == 1 and 250 * MS <= fell[0][1]["fell"] <= 310 * MS
          and fell[0][1]["fall-after"] == 3 * S and 3 * S <= at - steady <= 5 * S + SLACK)
    check(f"{kind}: the pace after it at most 20 ms (got {in_ms(r.prop(0, 'pace'))} ms)",
          r.prop(0, "pace") <= 20 * MS and abs(r.prop(1, "pace") - r.prop(0, "pace")) <= 2 * MS)
    if mux:
        check(f"{kind}: every buffer of both inputs one PES at its PTS, intact, across the fall",
              r.pes_ok(0, range(N17)) and r.pes_ok(1, range(N17)))
    else:
        check(f"{kind}: the mix continuous, both inputs throughout, nothing lost or repeated, "
              f"no fade at the fall (B-83 F1; got {r.spans(N17 * 10)[:3]}, fades "
              f"{[r.prop(i, 'fades') for i in (0, 1)]}: the EOS's)",
              r.spans(N17 * 10) == [(0, N17 * 10, VAL[0] + VAL[1])]
              and [r.prop(i, "fades") for i in (0, 1)] == [1, 1])
        c = (at - r.t0) // MS - 30 if at else 0
        t_out = out_at(r, c)
        check(f"{kind}: what the fall made due left at once: content {c} ms out "
              f"{in_ms(t_out - at) if t_out else None} ms after the fall",
              t_out is not None and t_out - at <= 30 * MS + SLACK)
    check(f"{kind}: EOS, no error", eos and not r.errors)
    r.stop()

print("\n--- audiomixer: (18) a fall wakes an input held behind the pace at its next arrival ---")
# 400 ms buffers: input 0 5 ms late, held 200 ms behind input 1's 205 ms, so its task sleeps to
# its next buffer's release (B-79). Input 1 leaves while it sleeps: the pace falls to 5 ms at once
# (B-82), and the next arrival is released as it comes, not at the release the task armed.
BIG = 400
r = Rig("audiomixer", [{}, {}])


def _big(i, k0, k1, lag_ms, rise_ms=0):
    def go():
        for k in range(k0, k1):
            r.sleep_until(r.at(k * BIG + lag_ms + k * rise_ms))
            frames = RATE * BIG // 1000
            b = Gst.Buffer.new_wrapped(array.array("h", [VAL[i]] * 2 * frames).tobytes())
            b.pts, b.dts, b.duration = r.at(k * BIG), NONE, BIG * MS
            r.srcs[i].emit("push-buffer", b)
    return go


r.run({0: [("call", _big(0, 0, 9, 5)), ("eos",)],
       1: [("call", _big(1, 0, 5, 205, 1)), ("at", 4 * BIG + 300), ("call", lambda: r.remove(1))]})
eos = r.wait(lambda: r.eos_at is not None)
rel = {p: t for _k, t, p, _f in r.released(0)}
# Input 1's lateness counts at its third arrival (1.0 s): from content 1.2 s on input 0 is held.
# It rises 1 ms a buffer: a stretch over which it fell, push jitter alone, would not count (B-57).
held = [rel[r.at(k * BIG)] - r.at(k * BIG) for k in (3, 4) if r.at(k * BIG) in rel]
check(f"armed fall: input 0 held to input 1's 205-209 ms before it leaves "
      f"(got {[in_ms(h) for h in held]})",
      len(held) == 2 and all(abs(h - 205 * MS) <= SLACK for h in held))
nxt = rel.get(r.at(5 * BIG))
check(f"armed fall: after the leave its next buffer leaves on arrival (5 ms late, got "
      f"{in_ms(nxt - r.at(5 * BIG)) if nxt else None} ms), not at the 205 ms release armed",
      nxt is not None and nxt - r.at(5 * BIG) <= 5 * MS + SLACK)
check(f"armed fall: the pace 5 ms, both mixed to 2 s, then input 0 alone (got "
      f"{in_ms(r.prop(0, 'pace'))} ms, {r.spans()})",
      r.prop(0, "pace") <= 10 * MS
      and r.spans(9 * BIG) == [(0, 2000, VAL[0] + VAL[1]), (2000, 9 * BIG, VAL[0])])
check("armed fall: EOS, no error", eos and not r.errors)
r.stop()


# B-83: toward an audio aggregator under PCM caps every edge fades: the last 5 ms played back
# reversed under a half-Hann window at a dropout, a hole or an EOS, the window's complement over
# the first 5 ms back. Input 0 is silent (0) but present, so the mix is input 1's edge alone.
V = 10000
FV = (0, V)
DISCONT, GAPF = int(Gst.BufferFlags.DISCONT), int(Gst.BufferFlags.GAP)


def fade_out_of(v, n=FADE_FRAMES, code="h"):
    return [scaled(v, win(k, n), code) for k in range(n)]


def fade_in_of(v, n=FADE_FRAMES, code="h"):
    return [scaled(v, 1.0 - win(k, n), code) for k in range(n)]


def first_back(r, i, after_ms):
    """Input i's first buffer out after content `after_ms` that is not its fade-out:
    (content ms, duration, flags, samples)."""
    with r.lock:
        return next((((p - r.t0) / MS, d, f, v) for p, d, f, v in r.data[i]
                     if p > r.at(after_ms)), None)


def ramp_in_mix(r, ms, want, slop=2):
    """The offset (frames, within +-slop) at which the mix's first channel from content `ms`
    is `want` to the sample; None: nowhere."""
    got = r.frames_at(ms - slop / 48, len(want) + 2 * slop)
    if got is None:
        return None
    return next((o - slop for o in range(2 * slop + 1) if got[o:o + len(want)] == want), None)


print("\n--- audiomixer: (F1) an absence fades out ---")
r = Rig("audiomixer", [{}, {}], vals=FV, record=True)
r.run({0: [("rt", 0, 250, 0)], 1: [("rt", 0, 100, 0)]})
r.wait(lambda: (r.reach() or 0) >= 2000)
fade, want = r.buf_at(1, 1000), fade_out_of(V)
check(f"F1 absence: at the horizon 240 frames of V x w(k) on both channels, no GAP, no DISCONT "
      f"(got {fade and (fade[0], fade[1], list(fade[2][0:8:2]))})",
      fade is not None and fade[0] == FADE and not fade[1] & (GAPF | DISCONT)
      and list(fade[2][0::2]) == want and list(fade[2][1::2]) == want)
check(f"F1 absence: the mix follows the window from V to 0 to the sample, then 0 (first "
      f"{(r.frames_at(1000, 240) or [])[:4]})",
      r.frames_at(1000, 240) == want and r.frames_at(1005, 480) == [0] * 480)
check(f"F1 absence: one fade, absent once, no error (fades {r.prop(1, 'fades')})",
      r.prop(1, "fades") == 1 and r.prop(1, "absences") == 1 and not r.errors)
r.stop()

print("\n--- audiomixer: (F2) a rejoin fades in from the horizon ---")
r = Rig("audiomixer", [{}, {}], vals=FV, record=True)
r.run({0: [("rt", 0, 300, 0), ("eos",)],
       1: [("rt", 0, 100, 0), ("at", 2000), ("now", 100, 200), ("rt", 200, 300, 0), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
back = first_back(r, 1, 1000)
h = back and back[0]
check(f"F2 rejoin: its first buffer back carries DISCONT, its first 240 frames ramp 0 -> V on both "
      f"channels, then V (back at {h} ms, {back and list(back[3][0:8:2])})",
      back is not None and back[2] & DISCONT and list(back[3][0::2][:240]) == fade_in_of(V)
      and list(back[3][1::2][:240]) == fade_in_of(V) and set(back[3][480:]) == {V})
check("F2 rejoin: the mix ramps from the horizon to the sample, then V",
      h is not None and r.frames_at(h, 240) == fade_in_of(V) and r.frames_at(h + 5, 240) == [V] * 240)
check(f"F2 rejoin: fades out at the absence, in at the return, out at the EOS; absent once; EOS, "
      f"no error (fades {r.prop(1, 'fades')})",
      r.prop(1, "fades") == 3 and r.prop(1, "absences") == 1 and eos and not r.errors)
r.stop()

print("\n--- audiomixer: (F3) a hole the input reports: both edges fade ---")
r = Rig("audiomixer", [{}, {"props": {"silence-floor": 2 * S}}], vals=FV, record=True)
r.run({0: [("rt", 0, 300, 300), ("eos",)],
       1: [("rt", 0, 100, 0), ("at", 1500),
           ("call", lambda: r.srcs[1].send_event(Gst.Event.new_gap(r.at(1000), 500 * MS))),
           ("rt", 150, 300, 0), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
back = first_back(r, 1, 1000)
check(f"F3 GAP: the mix fades out at its start, is 0 over it, fades in at its end, to the sample "
      f"(back at {back and back[0]} ms, DISCONT {back and bool(back[2] & DISCONT)})",
      r.frames_at(1000, 240) == fade_out_of(V) and r.frames_at(1005, 4700) == [0] * 4700
      and back is not None and back[0] == 1500 and back[2] & DISCONT
      and r.frames_at(1500, 240) == fade_in_of(V) and r.frames_at(1505, 240) == [V] * 240)
check(f"F3 GAP: fades out, in, and out at the EOS; never absent; EOS, no error "
      f"(fades {r.prop(1, 'fades')})",
      r.prop(1, "fades") == 3 and r.prop(1, "absences") == 0 and eos and not r.errors)
r.stop()

print("\n--- audiomixer: (F4) a joiner's entry fades in from the horizon ---")
r = Rig("audiomixer", [{}], vals=FV, record=True)
r.run({0: [("rt", 0, 300, 0), ("eos",)],
       1: [("at", 950), ("call", lambda: r.add({}, live=True)), ("rt", 100, 300, 300), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
h, first, nxt = None, None, None
with r.lock:
    for rec in r.rel[1]:
        if rec[0] == "gap" and first is None:
            h = rec[2] + rec[3]          # where the joiner's gaps reached
        elif rec[0] == "buf" and first is None:
            first = rec[2]
    kept = [(p, f, v) for p, d, f, v in r.data[1] if first is not None and p >= first]
skip = (h - first) * RATE // S if h is not None and first is not None else None
ch0 = [x for _p, _f, v in kept[:2] for x in v[0::2]]
check(f"F4 joiner: its first buffer out carries DISCONT; what lies before the horizon is left "
      f"alone, from there it ramps 0 -> V over 240 frames, then V (skip {skip} frames)",
      skip is not None and 0 <= skip < BLOCK and kept and kept[0][1] & DISCONT
      and ch0[:skip] == [V] * skip and ch0[skip:skip + 240] == fade_in_of(V)
      and ch0[skip + 240:skip + 250] == [V] * 10)
off = ramp_in_mix(r, (h - r.t0) / MS, fade_in_of(V)) if h else None
check(f"F4 joiner: the mix ramps from where its gaps reached (offset {off} frames)", off is not None)
check(f"F4 joiner: fades in, then out at the EOS; EOS, no error (fades {r.prop(1, 'fades')})",
      r.prop(1, "fades") == 2 and eos and not r.errors)
r.stop()

print("\n--- audiomixer: (F5) an EOS forwarded: the fade-out goes before it ---")
r = Rig("audiomixer", [{}, {}], vals=FV, record=True)
r.run({0: [("rt", 0, 200, 0), ("eos",)], 1: [("rt", 0, 100, 0), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
with r.lock:
    last = [(rec[0], rec[2] if rec[0] == "buf" else None) for rec in r.rel[1]
            if rec[0] in ("buf", "eos")][-2:]
check(f"F5 EOS: input 1's last buffer is the fade-out at its end, then EOS (got {last})",
      last == [("buf", r.at(1000)), ("eos", None)] and (r.buf_at(1, 1000) or (0,))[0] == FADE)
check(f"F5 EOS: the mix fades it out to the sample, then 0; the stream ends once both ended",
      r.frames_at(1000, 240) == fade_out_of(V) and r.frames_at(1005, 480) == [0] * 480 and eos
      and r.prop(1, "fades") == 1 and r.prop(1, "absences") == 0 and not r.errors)
r.stop()

print("\n--- audiomixer: (F7) a 50 ms hole in the data, no GAP: placed by PTS, both edges fade ---")
r = Rig("audiomixer", [{}, {}], vals=FV, record=True)
r.run({0: [("rt", 0, 300, 0), ("eos",)], 1: [("rt", 0, 100, 0), ("rt", 105, 300, 0), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
back = first_back(r, 1, 1000)
check(f"F7 hole: the fade-out at the horizon, the data after the hole DISCONT at its own PTS, no GAP "
      f"(back at {back and back[0]} ms, gaps {len(r.released(1, 'gap'))})",
      (r.buf_at(1, 1000) or (0,))[0] == FADE and back is not None and back[0] == 1050
      and back[2] & DISCONT and not r.released(1, "gap"))
check(f"F7 hole: the mix fades out, 0 over the hole, fades in at 1050 ms, to the sample (got "
      f"{r.levels(3000)})",
      r.frames_at(1000, 240) == fade_out_of(V) and r.frames_at(1005, 45 * 48) == [0] * 45 * 48
      and r.frames_at(1050, 240) == fade_in_of(V)
      and r.levels(3000) == [(0, 1000, V), (1000, 1050, 0), (1050, 3000, V)])
check(f"F7 hole: never absent, fades out, in, and out at the EOS; EOS, no error "
      f"(fades {r.prop(1, 'fades')})",
      r.prop(1, "absences") == 0 and r.prop(1, "fades") == 3 and eos and not r.errors)
r.stop()

print("\n--- audiomixer: (F8) the formats and channel counts the mixer takes ---")
for fmt, ch, v in (("S16LE", 1, 10000), ("S16LE", 8, -12345), ("S32LE", 2, 1_500_000_000),
                   ("F32LE", 1, 0.5), ("F32LE", 2, -0.375), ("F64LE", 2, 0.25)):
    caps = (f"audio/x-raw,format={fmt},rate=48000,channels={ch},layout=interleaved"
            + (",channel-mask=(bitmask)0x0" if ch > 2 else ""))
    r = Rig("audiomixer", [{"caps": caps}, {"caps": caps}], channels=ch, fmt=fmt, vals=(0, v),
            record=True)
    r.run({0: [("rt", 0, 200, 0)], 1: [("rt", 0, 100, 0)]})
    r.wait(lambda: (r.reach() or 0) >= 1500)
    code, fade = SAMPLE[fmt], r.buf_at(1, 1000)
    want = fade_out_of(v, code=code)
    check(f"F8 {fmt} x {ch}: the fade-out V x w(k) on every channel, to the sample, and in the mix "
          f"(first {fade and list(fade[2][0:4 * ch:ch])})",
          fade is not None and fade[0] == FADE and len(fade[2]) == ch * 240
          and all(list(fade[2][c::ch]) == want for c in range(ch))
          and r.frames_at(1000, 240) == want and r.prop(1, "fades") == 1 and not r.errors)
    r.stop()

print("\n--- audiomixer: (F9) back in 2 ms buffers: the fade-in spans them ---")
r = Rig("audiomixer", [{}, {}], vals=FV, record=True)


def _short_back():
    """Input 1 back on time at 2.5 s in ten 2 ms buffers, then in 10 ms ones."""
    for j in range(10):
        r.sleep_until(r.at(2500 + 2 * j))
        r.push(1, 0, pts=r.at(2500 + 2 * j), frames=96)


r.run({0: [("rt", 0, 400, 300), ("eos",)],
       1: [("rt", 0, 100, 0), ("at", 2500), ("call", _short_back), ("rt", 252, 400, 0), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
with r.lock:
    back = [v for p, d, f, v in r.data[1] if r.at(2500) <= p < r.at(2520)]
ch0 = [x for v in back for x in v[0::2]]
check(f"F9 short buffers: the ramp continues across three 2 ms buffers to the sample, then V "
      f"({len(back)} buffers)",
      len(back) == 10 and ch0[:240] == fade_in_of(V) and ch0[240:] == [V] * (960 - 240)
      and r.frames_at(2500, 240) == fade_in_of(V))
check(f"F9 short buffers: fades out, in, and out at the EOS; EOS, no error "
      f"(fades {r.prop(1, 'fades')})", r.prop(1, "fades") == 3 and eos and not r.errors)
r.stop()

print("\n--- audiomixer: (F11) a discard with no silence before what follows: no fade ---")
# Input 1 repeats its last 50 ms (stale, discarded) and goes on: the DISCONT buffer after the discard
# follows sound, not an edge, so nothing fades (a dip from full scale would be a click of its own).
r = Rig("audiomixer", [{}, {}], vals=FV, record=True)
r.run({0: [("rt", 0, 300, 0), ("eos",)],
       1: [("rt", 0, 100, 0), ("now", 95, 100), ("rt", 100, 300, 0), ("eos",)]})
eos = r.wait(lambda: r.eos_at is not None)
back = first_back(r, 1, 990)
check(f"F11 no edge: 5 buffers stale, the next one DISCONT and unfaded, the mix V throughout "
      f"(stale {r.prop(1, 'stale-buffers')}, back at {back and back[0]} ms, {r.spans(3000)[:3]})",
      r.prop(1, "stale-buffers") == 5 and back is not None and back[0] == 1000
      and back[2] & DISCONT and set(back[3]) == {V} and r.spans(3000) == [(0, 3000, V)]
      and r.prop(1, "fades") == 1 and eos and not r.errors)
r.stop()

print("\n--- audiomixer: (F10) a stream younger than 1 ms fades nothing out ---")
r = Rig("audiomixer", [{}, {"props": {"silence-ceiling": 300 * MS}}], vals=FV, record=True)
r.run({0: [("rt", 0, 200, 0)], 1: [("call", lambda: r.push(1, 0, frames=24))]})
r.wait(lambda: (r.reach() or 0) >= 1500)
gaps = r.released(1, "gap")
with r.lock:
    bufs = [(p, d) for p, d, f, v in r.data[1]]
check(f"F10 young tail: no fade-out, its gaps from the end of its 0.5 ms as before (buffers {bufs}, "
      f"first gap {gaps[:1]})",
      bufs == [(r.at(0), MS // 2)] and bool(gaps) and gaps[0][2] == r.at(0) + MS // 2
      and r.prop(1, "fades") == 0 and not r.errors)
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
target, pace = r.prop(1, "pace-target"), r.prop(1, "pace")
check(f"sparse: the pace's target is raised by it (got {target / MS:.0f} ms), the pace slewing to "
      f"it ({pace / MS:.0f} ms, B-80)", target >= 800 * MS - SLACK and 0 < pace <= target
      and abs(r.prop(0, "pace") - pace) <= 2 * MS)
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
