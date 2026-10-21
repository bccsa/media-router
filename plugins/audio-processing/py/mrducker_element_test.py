#!/usr/bin/env python3
"""mrducker and mrptskeep (plan ch. 6 WI-P2-10) and audio-processing's PTS-aligned interleave.

Element cases (appsrc, not live). mrducker: its settings are the manifest's; 4 channels in, 2
out, PTS in = PTS out; the duck from the end of the key's 15 ms window; a gap is silence out; a
live depth write; the last partial window at EOS. mrptskeep: each buffer out of its target gets
the timing of the buffer that went in, on the LSP sc-gate-stereo (whose LADSPA wrapper writes no
timestamps) and on a stand-in that drops them, past a buffer the target dropped; misplaced, it
fails the stream.

Dataflow cases on the strings audioProcessingPipeline.ts builds (py/pipelines.json, which vitest
holds equal to the builder): the bus inputs become live stereo appsrcs on the house clock
(monotonic, base_time 0, as both runners run it), the bus sink a fakesink after the 302M encode.
(1) A key burst at content time T ducks the programme from T, within one 15 ms window, the same
frame and the same samples with the key pushed on time or 300 ms late; (2) the `mrducker`
message every 100 ms of content, so 10 Hz; (3) the keyed gate opens on the key's content time
with the key 300 ms late, and its output is on content time: a PTS on every buffer and on every
PES at the egress. A control arm (a force-live interleave, no watchdogs) misses the late key, so
the checks can fail.

Skips (exit 0) without GStreamer, the elements or the built plugins.
Run: python3 mrducker_element_test.py   (from plugins/audio-processing/py)
"""
import array
import json
import math
import os
import re
import sys
import threading
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import GObject, Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP mrducker_element_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

Gst.init(sys.argv)
_HERE = os.path.dirname(os.path.abspath(__file__))
_PLUGINS = os.environ.get("MR_PLUGINS_DIR") or os.path.normpath(os.path.join(_HERE, "..", ".."))
_DUCKER = os.path.join(_PLUGINS, "audio-processing", "native", "mrducker", "libgstmrducker.so")
_HOUSE = os.path.join(_PLUGINS, "mpegts-core", "native", "mrtshouse", "libgstmrtshouse.so")
for _so in (_DUCKER, _HOUSE):
    if not os.path.exists(_so):
        print(f"SKIP mrducker_element_test.py — {_so} not built (make native)")
        sys.exit(0)
    Gst.Plugin.load_file(_so)
for _f in ("mrducker", "mrptskeep", "mralignwatch", "audiointerleave", "deinterleave", "appsrc",
           "appsink", "identity"):
    if Gst.ElementFactory.find(_f) is None:
        print(f"SKIP mrducker_element_test.py — {_f} unavailable")
        sys.exit(0)

MS, S = Gst.MSECOND, Gst.SECOND
NONE = Gst.CLOCK_TIME_NONE
RATE, BLOCK = 48000, 480           # 10 ms buffers
WINDOW_MS = 15
PROG = (0.5, -0.25)                # the programme's DC per channel: out / in is the gain
FLOOR = 10 ** (-12 / 20)           # the default depth, linear
QUAD = "audio/x-raw,format=F32LE,rate=48000,channels=4,layout=interleaved,channel-mask=(bitmask)0x0"
STEREO = ("audio/x-raw,format=F32LE,channels=2,rate=48000,channel-mask=(bitmask)0x3,"
          "layout=interleaved")
# A setting of the manifest → its mrducker property (duckerStage.ts DUCKER_PROP_MAP).
SETTINGS = {"threshold": "threshold", "duckDepth": "depth", "attack": "attack",
            "release": "release", "hold": "hold"}

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def quad(frames, key, prog=PROG):
    """Interleaved 4-channel F32: the programme's DC on 0/1, key(i) on 2/3."""
    v = array.array("f", [0.0] * (4 * frames))
    for i in range(frames):
        v[4 * i], v[4 * i + 1] = prog
        v[4 * i + 2] = v[4 * i + 3] = key(i)
    return v.tobytes()


def find_ladspa(suffix):
    for f in Gst.Registry.get().get_feature_list(Gst.ElementFactory):
        name = f.get_name()
        if name.startswith("ladspa-") and name.endswith(f"-{suffix}"):
            return name
    return None


class Direct:
    """appsrc ! <stage> ! appsink, not live: buffers in as fast as the element takes them."""

    def __init__(self, props="", stage="mrducker name=ducker", caps=QUAD):
        self.pipe = Gst.parse_launch(
            f"appsrc name=src format=time caps={caps} ! {stage} {props}"
            " ! appsink name=sink sync=false emit-signals=false")
        self.src, self.ducker = self.pipe.get_by_name("src"), self.pipe.get_by_name("ducker")
        self.sink = self.pipe.get_by_name("sink")
        self.ins, self.msgs, self.errors, self.outs = [], [], [], 0
        self.eos = threading.Event()
        self.src.get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, self._on_in)
        self.sink.get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, self._on_out)
        self.pipe.get_bus().set_sync_handler(self._on_msg)
        self.pipe.set_state(Gst.State.PLAYING)

    def _on_in(self, _pad, info):
        b = info.get_buffer()
        self.ins.append((b.pts, b.duration, b.get_size(), b.offset, b.offset_end, b.dts))
        return Gst.PadProbeReturn.OK

    def _on_out(self, _pad, _info):
        self.outs += 1
        return Gst.PadProbeReturn.OK

    def wait_out(self, n):
        end = time.monotonic() + 5
        while self.outs < n and time.monotonic() < end:
            time.sleep(0.005)

    def _on_msg(self, _bus, m):
        s = m.get_structure()
        if m.type == Gst.MessageType.ELEMENT and s is not None and s.get_name() == "mrducker":
            self.msgs.append({s.nth_field_name(j): s.get_value(s.nth_field_name(j))
                              for j in range(s.n_fields())})
        elif m.type == Gst.MessageType.ERROR:
            self.errors.append(m.parse_error()[0].message)
        elif m.type == Gst.MessageType.EOS:
            self.eos.set()
        return Gst.BusSyncReply.DROP

    def push(self, k, data, frames=BLOCK, flags=0, dts=NONE):
        b = Gst.Buffer.new_wrapped(data)
        b.pts, b.dts, b.duration = k * 10 * MS, dts, frames * S // RATE
        b.offset, b.offset_end = k * BLOCK, k * BLOCK + frames
        if flags:
            b.set_flags(flags)
        self.src.emit("push-buffer", b)

    def finish(self):
        """EOS, then every output buffer: (pts, duration, flags, floats, offset, offset_end,
        dts)."""
        self.src.emit("end-of-stream")
        out = []
        while True:
            sample = self.sink.emit("try-pull-sample", 5 * S)
            if sample is None:
                break
            b = sample.get_buffer()
            out.append((b.pts, b.duration, int(b.get_flags()),
                        array.array("f", b.extract_dup(0, b.get_size())), b.offset,
                        b.offset_end, b.dts))
        self.eos.wait(2)
        self.pipe.set_state(Gst.State.NULL)
        return out


def gains(out):
    """(frame index, gain on channel 0, gain on channel 1) of every output frame, in order."""
    res, n = [], 0
    for o in out:
        v = o[3]
        for j in range(len(v) // 2):
            res.append((n, v[2 * j] / PROG[0], v[2 * j + 1] / PROG[1]))
            n += 1
    return res


print(f"{Gst.version_string()}; mrducker "
      f"{Gst.ElementFactory.find('mrducker').get_plugin().get_version()}")

print("\n--- the element's settings are the manifest's duck settings ---")
with open(os.path.join(_HERE, "..", "package.json"), encoding="utf-8") as fh:
    _schema = json.load(fh)["mediaRouter"]["configSchema"]["properties"]
_el = Gst.ElementFactory.make("mrducker")
for key, prop in SETTINGS.items():
    ps = _el.find_property(prop)
    want = _schema[key]
    check(f"{key} -> {prop}: range {want['minimum']}..{want['maximum']}, default "
          f"{want['default']}, help text as the manifest's",
          ps is not None and ps.minimum == want["minimum"] and ps.maximum == want["maximum"]
          and ps.default_value == want["default"] and ps.blurb == want["description"]
          and bool(ps.flags & Gst.PARAM_MUTABLE_PLAYING))
check("abi 1, read-only", _el.get_property("abi") == 1
      and not _el.find_property("abi").flags & GObject.ParamFlags.WRITABLE)
_tmpl = {t.direction: t.get_caps().to_string() for t in
         Gst.ElementFactory.find("mrducker").get_static_pad_templates()}
check("4 channels in, 2 positioned out, F32LE", "channels=(int)4" in _tmpl[Gst.PadDirection.SINK]
      and "channels=(int)2" in _tmpl[Gst.PadDirection.SRC]
      and "channel-mask=(bitmask)0x0000000000000003" in _tmpl[Gst.PadDirection.SRC])
_keep = Gst.ElementFactory.make("mrptskeep")
_target = _keep.find_property("target")
check("mrptskeep: the same plugin and abi, read-only; `target` is set before it starts",
      _keep.get_property("abi") == 1
      and not _keep.find_property("abi").flags & GObject.ParamFlags.WRITABLE
      and Gst.ElementFactory.find("mrptskeep").get_plugin().get_name() == "mrducker"
      and _target is not None and bool(_target.flags & Gst.PARAM_MUTABLE_READY)
      and not _target.flags & Gst.PARAM_MUTABLE_PLAYING)

print("\n--- mrducker alone: the window, the ramp, PTS, gaps, live settings, EOS ---")
T = 48140                                   # a key from frame 48140 (1002.9 ms) on
r = Direct()
for k in range(200):
    r.push(k, quad(BLOCK, lambda i, k=k: 0.5 if k * BLOCK + i >= T else 0.0))
out = r.finish()
g = gains(out)
check(f"PTS, duration in = out, one buffer each, half the bytes ({len(out)} buffers)",
      [(i[0], i[1], i[2] // 2) for i in r.ins] == [(o[0], o[1], len(o[3]) * 4) for o in out])
onset = next((n for n, a, _b in g if a < 0.999), None)
check(f"the duck starts on the first frame after the key's 15 ms window (48240, got {onset})",
      onset == 48240 and g[48239][1] == 1.0)
check("straight in dB across that window, on the floor at its end, both channels alike",
      all(abs(20 * math.log10(g[48240 + k][1]) + 12 * (k + 1) / 720) < 1e-3 for k in range(720))
      and abs(g[48959][1] - FLOOR) < 1e-6 and abs(g[60000][2] - FLOOR) < 1e-6)
check("the message's running time is its window's end, every 100 ms of content",
      [m["running-time"] for m in r.msgs][:4] == [105 * MS, 210 * MS, 300 * MS, 405 * MS])
check("a message carries gain, key level and phase",
      r.msgs[-1]["gain-db"] == -12 and r.msgs[-1]["phase"] == "hold"
      and abs(r.msgs[-1]["key-db"] + 6.0206) < 1e-3 and r.msgs[0]["key-db"] == -120)

r = Direct()
for k in range(20):
    r.push(k, quad(BLOCK, lambda i: 0.5))
r.push(20, quad(BLOCK, lambda i: 0.5, prog=(0.9, 0.9)), flags=Gst.BufferFlags.GAP)
out = r.finish()
gap = [o for o in out if o[2] & int(Gst.BufferFlags.GAP)]
check("a gap is silence out, whatever its bytes, and stays a gap",
      len(gap) == 1 and gap[0][0] == 200 * MS and all(x == 0.0 for x in gap[0][3]))

r = Direct("depth=-6")
for k in range(10):
    r.push(k, quad(BLOCK, lambda i: 0.5))
r.wait_out(10)
r.ducker.set_property("depth", -24.0)
for k in range(10, 30):
    r.push(k, quad(BLOCK, lambda i: 0.5))
g = gains(r.finish())
check(f"a live depth write: the floor -6 dB, then -24 dB "
      f"(got {20 * math.log10(g[4700][1]):.2f}, {20 * math.log10(g[-1][1]):.2f})",
      abs(20 * math.log10(g[4700][1]) + 6) < 1e-3 and abs(20 * math.log10(g[-1][1]) + 24) < 1e-3)

r = Direct()
for k in range(10):
    r.push(k, quad(BLOCK, lambda i: 0.5))
r.wait_out(10)
# New caps at the same rate (another mask): a renegotiation, not a new stream.
r.src.set_property("caps", Gst.Caps.from_string(QUAD.replace("0x0", "0xf")))
for k in range(10, 20):
    r.push(k, quad(BLOCK, lambda i: 0.0))
g = gains(r.finish())
check(f"a renegotiation at the same rate keeps the envelope: still held on the floor after it "
      f"(got {20 * math.log10(g[4900][1]):.2f} dB)", abs(g[4900][1] - FLOOR) < 1e-6)

r = Direct()
for k in range(10):
    r.push(k, quad(BLOCK, lambda i: 0.5))
r.push(10, quad(100, lambda i: 0.5), frames=100)   # 4900 frames: 6 windows and 580 frames
r.finish()
check(f"EOS: the last partial window is read and reported, past the 100 ms mark it crossed "
      f"(got {[(m['running-time'], round(m['key-db'], 2)) for m in r.msgs]})",
      [m["running-time"] for m in r.msgs] == [4900 * S // RATE]
      and abs(r.msgs[0]["key-db"] + 6.0206) < 1e-3)


print("\n--- mrptskeep: the timing its target dropped, put back ---")
DROP, FLAGGED = 5, 10   # the buffer the stand-in drops, the one that comes with DISCONT and GAP


def strip_timing(_pad, info):
    """What the LADSPA wrapper's 4 -> 2 output looks like: no timestamps, offsets or flags."""
    b = info.get_buffer()
    b.pts = b.dts = b.duration = NONE
    b.offset = b.offset_end = Gst.BUFFER_OFFSET_NONE
    b.unset_flags(b.get_flags())
    return Gst.PadProbeReturn.OK


def stand_in(keep=True):
    """A target that drops its timing (and buffer DROP), with or without the keeper after it."""
    r = Direct(stage="identity name=t drop-buffer-flags=droppable"
               + (" ! mrptskeep name=keep target=t" if keep else ""), caps=STEREO)
    r.pipe.get_by_name("t").get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER,
                                                            strip_timing)
    data = array.array("f", [0.25] * (2 * BLOCK)).tobytes()
    marks = {0: Gst.BufferFlags.DISCONT, DROP: Gst.BufferFlags.DROPPABLE,
             FLAGGED: Gst.BufferFlags.DISCONT | Gst.BufferFlags.GAP}
    for k in range(20):
        r.push(k, data, flags=marks.get(k, 0), dts=k * 10 * MS + 1)
    return r, r.finish()


r, out = stand_in()
want = [(i[0], i[5], i[1], i[3], i[4]) for k, i in enumerate(r.ins) if k != DROP]
check(f"on a stand-in that strips them: each buffer out has the PTS, DTS, duration and offsets "
      f"of its buffer in, past the one the target dropped ({len(out)} of {len(r.ins)} out)",
      [(o[0], o[6], o[1], o[4], o[5]) for o in out] == want and not r.errors)
disc, gap = int(Gst.BufferFlags.DISCONT), int(Gst.BufferFlags.GAP)
check("its flags too, but GAP: the target is not gap-aware (as GstBaseTransform's copy)",
      out[0][2] & disc and out[FLAGGED - 1][2] & disc and not out[FLAGGED - 1][2] & gap
      and not any(o[2] & disc for i, o in enumerate(out) if i not in (0, FLAGGED - 1)))
_r, bare = stand_in(keep=False)
check("control: without the keeper the stand-in's output has no PTS",
      bare and all(o[0] == NONE for o in bare))

gate = find_ladspa("sc-gate-stereo")
if gate is None:
    print("SKIP mrptskeep on the gate — no LSP sc-gate-stereo (lsp-plugins-ladspa)")
else:
    gate_runs = {}
    for keep in (True, False):
        stage = f"{gate} name=t sidechain-input=1" + (" ! mrptskeep target=t" if keep else "")
        r = Direct(stage=stage)
        for k in range(20):
            r.push(k, quad(BLOCK, lambda i, k=k: 0.5 if k >= 10 else 0.0),
                   flags=Gst.BufferFlags.DISCONT if k == 0 else 0)
        gate_runs[keep] = (r.ins, r.finish(), list(r.errors))
    ins, out, errors = gate_runs[True]
    check(f"on the LSP gate: each buffer out has its buffer in's PTS, duration and offsets "
          f"({len(out)} buffers, errors {errors})",
          [(o[0], o[1], o[4], o[5]) for o in out] == [(i[0], i[1], i[3], i[4]) for i in ins]
          and out[0][2] & disc and not errors)
    check("control: without it the gate's output has no PTS, and the keeper changes no sample",
          all(o[0] == NONE for o in gate_runs[False][1])
          and [o[3] for o in gate_runs[False][1]] == [o[3] for o in out])


def misplaced(desc, buffers=5):
    """(whether `desc` started, its first error or None) with `buffers` pushed into its appsrc
    `src` (F32 stereo)."""
    p = Gst.parse_launch(desc)
    errors = []

    def on_msg(_bus, m):
        if m.type == Gst.MessageType.ERROR:
            errors.append(m.parse_error()[0].message)
        return Gst.BusSyncReply.DROP

    p.get_bus().set_sync_handler(on_msg)
    started = p.set_state(Gst.State.PLAYING) != Gst.StateChangeReturn.FAILURE
    if started:
        src = p.get_by_name("src")
        for k in range(buffers):
            b = Gst.Buffer.new_wrapped(array.array("f", [0.1] * (2 * BLOCK)).tobytes())
            b.pts, b.duration = k * 10 * MS, 10 * MS
            src.emit("push-buffer", b)
        end = time.monotonic() + 2
        while not errors and time.monotonic() < end:
            time.sleep(0.01)
    p.set_state(Gst.State.NULL)
    return started, errors[0] if errors else None


SRC = f"appsrc name=src format=time caps={STEREO}"
SINK = "appsink sync=false emit-signals=false"
started, err = misplaced(f"{SRC} ! identity name=t ! mrptskeep target=nope ! {SINK}")
check(f"no such target: it does not start ({err!r})",
      not started and err is not None and "No element 'nope'" in err)
# One buffer: its record is there when the queue's thread gets to it, from the other thread.
started, err = misplaced(f"{SRC} ! identity name=t ! queue ! mrptskeep target=t ! {SINK}", 1)
check(f"behind a queue (another streaming thread): its first buffer fails the stream ({err!r})",
      started and err == "No input of t:sink for this buffer")
started, err = misplaced(f"{SRC} ! audioresample name=t ! audio/x-raw,rate=24000"
                         f" ! mrptskeep target=t ! {SINK}")
check(f"a target that is not 1:1 in frames: the stream fails ({err!r})",
      started and err == "t:sink is not 1:1 in frames")


# --- the strings audioProcessingPipeline.ts builds (py/pipelines.json) ---------------------
with open(os.path.join(_HERE, "pipelines.json"), encoding="utf-8") as fh:
    BUILT = json.load(fh)
# The 302M egress: without one of these the string runs to the meter only.
EGRESS = ("audioresample", "avenc_s302m", "mpegtsmux", "capssetter")
HAS_EGRESS = all(Gst.ElementFactory.find(f) is not None for f in EGRESS)
OUT = "fakesink name=out sync=false async=false"


def built(case, aligned=True):
    """The builder's string for `case`, runnable here, or a reason it cannot run: LADSPA
    placeholders resolved, each bus input a live stereo appsrc (`prog`, `key`) and the bus sink
    the fakesink `out`. `aligned=False`: the control, an interleave by arrival."""
    desc = BUILT[case]["pipeline"]
    for suffix in sorted(set(re.findall(r"ladspa-@-([\w-]+)", desc))):
        name = find_ladspa(suffix)
        if name is None:
            return None, f"no LSP {suffix} (lsp-plugins-ladspa)"
        desc = desc.replace(f"ladspa-@-{suffix}", name)
    for mix, src in (("progmix", "prog"), ("scmix", "key")):
        desc, n = re.subn(r'unixfdsrc socket-path=\S+ ! .*? ! (capsfilter name=%s_out caps="[^"]*")'
                          % mix, f"appsrc name={src} is-live=true format=time caps={STEREO} ! \\1",
                          desc, count=1)
        assert n == 1, (case, mix)
    desc, n = re.subn(r"mrlateness name=lat_busout_\d+ reference=house ! tee name=busout_\d+ "
                      r"allow-not-linked=true", OUT, desc)
    assert n == 1, case
    if not HAS_EGRESS:
        level = desc.index(" ! ", desc.index("level name=outlevel"))
        desc = desc[:level] + " ! " + desc[desc.index(OUT, level):]
    if not aligned:
        desc, n = re.subn("audiointerleave name=il latency=0 ",
                          "audiointerleave name=il latency=50000000 force-live=true ", desc)
        assert n == 1, case
        desc, n = re.subn(r"mralignwatch name=il_aw_\w+ aligner=il input=\w+", "identity", desc)
        assert n == 4, case
    return desc, None


def pes_pts(ts):
    """(the 90 kHz PTS of each PES that has one, the count of PES without) in TS bytes."""
    with_pts, without = [], 0
    for off in range(0, len(ts) - 187, 188):
        pkt = ts[off:off + 188]
        afc = (pkt[3] >> 4) & 3
        if pkt[0] != 0x47 or not pkt[1] & 0x40 or not afc & 1:
            continue
        p = 4 + (1 + pkt[4] if afc & 2 else 0)
        if pkt[p:p + 3] != b"\x00\x00\x01" or not (pkt[p + 3] == 0xBD or pkt[p + 3] >= 0xC0):
            continue
        if not pkt[p + 7] & 0x80:
            without += 1
            continue
        q = pkt[p + 9:p + 14]
        with_pts.append(((q[0] >> 1) & 7) << 30 | q[1] << 22 | (q[2] >> 1) << 15 | q[3] << 7
                        | q[4] >> 1)
    return with_pts, without


class Rig:
    """A builder's string (`built`), live on the house clock: `prog` and `key` stereo appsrcs,
    buffer k at content k x 10 ms pushed `lag` ms late. PCM is taken after `outlevel`, TS at
    `out`."""

    def __init__(self, desc):
        self.clock = Gst.SystemClock.obtain()
        self.clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
        self.pipe = Gst.parse_launch(desc)
        self.pipe.use_clock(self.clock)
        self.pipe.set_start_time(NONE)
        self.pipe.set_base_time(0)
        self.out, self.msgs, self.errors, self.lock = [], [], [], threading.Lock()
        self.ts = bytearray()
        self.pipe.get_bus().set_sync_handler(self._on_msg)
        self.pipe.get_by_name("outlevel").get_static_pad("src").add_probe(
            Gst.PadProbeType.BUFFER, self._on_out)
        if HAS_EGRESS:
            self.pipe.get_by_name("out").get_static_pad("sink").add_probe(
                Gst.PadProbeType.BUFFER, self._on_ts)
        self.pipe.set_state(Gst.State.PLAYING)
        self.t0 = self.clock.get_time() // (10 * MS) * (10 * MS) + 200 * MS   # content 0

    def _on_msg(self, _bus, m):
        s = m.get_structure()
        with self.lock:
            if m.type == Gst.MessageType.ELEMENT and s is not None and s.get_name() == "mrducker":
                self.msgs.append((self.clock.get_time(), s.get_value("running-time"),
                                  s.get_value("gain-db"), s.get_value("phase")))
            elif m.type == Gst.MessageType.ERROR:
                self.errors.append(m.parse_error()[0].message)
        return Gst.BusSyncReply.DROP

    def _on_out(self, _pad, info):
        b = info.get_buffer()
        with self.lock:
            self.out.append((b.pts, b.duration, array.array("f", b.extract_dup(0, b.get_size()))))
        return Gst.PadProbeReturn.OK

    def _on_ts(self, _pad, info):
        b = info.get_buffer()
        with self.lock:
            self.ts += b.extract_dup(0, b.get_size())
        return Gst.PadProbeReturn.OK

    def feed(self, name, blocks, lag_ms, fill, prime=False):
        """`blocks` 10 ms buffers into `name`, buffer k at wall content k x 10 + lag ms;
        `prime`: the first one on time (its caps reach the interleave at the start)."""
        src = self.pipe.get_by_name(name)
        for k in range(blocks):
            due = self.t0 + (k * 10 + (0 if prime and k == 0 else lag_ms)) * MS
            while self.clock.get_time() < due:
                time.sleep(0.002)
            v = array.array("f", [0.0] * (2 * BLOCK))
            for i in range(BLOCK):
                v[2 * i], v[2 * i + 1] = fill(k * BLOCK + i)
            b = Gst.Buffer.new_wrapped(v.tobytes())
            b.pts, b.dts, b.duration = self.t0 + k * 10 * MS, NONE, 10 * MS
            src.emit("push-buffer", b)

    def run(self, blocks, prog_lag, key_lag, prog_fill, key_fill, prime=False):
        """Both feeds; `self.snapshot`: the watchdogs while both still flow (80 ms before the
        programme's last buffer: the end of a feed is an absence)."""
        threads = [threading.Thread(target=self.feed, args=a) for a in
                   (("prog", blocks, prog_lag, prog_fill),
                    ("key", blocks, key_lag, key_fill, prime))]
        for t in threads:
            t.start()
        snap_at = self.t0 + (blocks * 10 - 80) * MS
        while self.clock.get_time() < snap_at:
            time.sleep(0.005)
        self.snapshot = self.aligners()
        for t in threads:
            t.join()
        end = time.monotonic() + 3
        while time.monotonic() < end and self.reach() < blocks * 10 - 20:
            time.sleep(0.02)

    def reach(self):
        """Content ms the output covers."""
        with self.lock:
            if not self.out or self.out[-1][0] == NONE:
                return -1
            pts, _dur, v = self.out[-1]
        return (pts - self.t0) / MS + len(v) / (2 * RATE / 1000)

    def frames(self):
        """{content frame: (channel 0, channel 1)} of the output, by PTS."""
        res = {}
        with self.lock:
            out = list(self.out)
        for pts, _dur, v in out:
            if pts == NONE:
                continue
            f0 = round((pts - self.t0) * RATE / S)
            for j in range(len(v) // 2):
                res[f0 + j] = (v[2 * j], v[2 * j + 1])
        return res

    def timeline(self):
        """(buffers out, buffers without a PTS, breaks between one buffer's end and the next's
        PTS, the first PTS's content ms)."""
        with self.lock:
            out = [(p, d) for p, d, _v in self.out]
        untimed = sum(1 for p, _d in out if p == NONE)
        timed = [(p, d) for p, d in out if p != NONE]
        breaks = sum(1 for (p, d), (q, _e) in zip(timed, timed[1:])
                     if d == NONE or abs(p + d - q) > 1000)
        first = (timed[0][0] - self.t0) / MS if timed else None
        return len(out), untimed, breaks, first

    def egress(self):
        """(PES with a PTS, PES without, the first PTS less 1 h minus the first PCM PTS in ms)."""
        with self.lock:
            ts, first = bytes(self.ts), next((p for p, _d, _v in self.out if p != NONE), None)
        timed, untimed = pes_pts(ts)
        lead = None
        if timed and first is not None:
            want = (first * 9 // 100000 + 3600 * 90000) % (1 << 33)
            lead = ((timed[0] - want + (1 << 32)) % (1 << 33) - (1 << 32)) / 90
        return len(timed), untimed, lead

    def aligners(self):
        """{input: (pace ms, absences, stale buffers)} of the interleave's watchdogs."""
        res = {}
        for name in ("prog0", "prog1", "key0", "key1"):
            aw = self.pipe.get_by_name(f"il_aw_{name}")
            if aw is not None:
                res[name] = (aw.get_property("pace") / MS, aw.get_property("absences"),
                             aw.get_property("stale-buffers"))
        return res

    def stop(self):
        self.pipe.set_state(Gst.State.NULL)


KEY_AT, KEY_FOR = 48144, 24000      # frame 48144 = 1003 ms; a 500 ms burst
BLOCKS = 250                         # 2.5 s of content


def key_burst(n):
    return (0.5, 0.5) if KEY_AT <= n < KEY_AT + KEY_FOR else (0.0, 0.0)


def prog_dc(_n):
    return PROG


def first(frames, cond):
    """The first content frame from 0.5 s on whose programme gain meets `cond`."""
    return next((n for n in sorted(frames) if n >= RATE // 2 and cond(frames[n][0] / PROG[0])),
                None)


def duck_onset(frames):
    return first(frames, lambda g: g < 0.99)


def open_onset(frames):
    return first(frames, lambda g: g > 0.5)


def on_content_time(tag, rig):
    """The module's output is on content time: every buffer after the meter has a PTS, back to
    back from content 0, and every PES at the egress has one, at the first buffer's + 1 h."""
    n, untimed, breaks, first_ms = rig.timeline()
    check(f"{tag}: a PTS on every buffer out ({n}, {untimed} without), back to back from "
          f"content 0 ({breaks} breaks, first at {first_ms} ms)",
          n > BLOCKS - 30 and untimed == 0 and breaks == 0 and first_ms == 0)
    if not HAS_EGRESS:
        print(f"SKIP {tag}: the egress — one of {EGRESS} unavailable")
        return
    timed, untimed, lead = rig.egress()
    check(f"{tag}: every PES at the egress has a PTS ({timed} with, {untimed} without), the "
          f"first at the first buffer's PTS + 1 h ({lead} ms off)",
          timed > 50 and untimed == 0 and lead is not None and abs(lead) <= 1)


desc, why = built("ducker")
print("\n--- (1) the duck lands on the key's content time, however late the key arrives ---")
runs = {}
for lag in (0, 300):
    rig = Rig(desc)
    rig.run(BLOCKS, 0, lag, prog_dc, key_burst)
    runs[lag] = (rig.frames(), list(rig.msgs), list(rig.errors))
    aws = rig.snapshot
    if lag == 0:
        on_content_time("ducker", rig)
    rig.stop()
    paces = {round(a[0]) for a in aws.values()}
    check(f"key {lag} ms late: the four watchdogs share one pace, the key's lateness, and "
          f"nothing went absent or stale (got {aws})",
          len(aws) == 4 and len(paces) == 1 and abs(paces.pop() - lag) < 60
          and all(a[1] == 0 and a[2] == 0 for a in aws.values()))
for lag, (fr, _msgs, errors) in runs.items():
    n = duck_onset(fr)
    at = None if n is None else n * 1000 / RATE
    check(f"key {lag} ms late: the programme ducks from {at} ms, within one window after the "
          f"key at {KEY_AT * 1000 / RATE:.2f} ms", n is not None and 0 < n - KEY_AT <= 720 + 48)
    floor_at = KEY_AT + 2 * 720
    check(f"key {lag} ms late: on the floor 30 ms on, both channels, and the stream whole "
          f"({len(fr)} frames, errors {errors})",
          floor_at in fr and abs(fr[floor_at][0] / PROG[0] - FLOOR) < 1e-4
          and abs(fr[floor_at][1] / PROG[1] - FLOOR) < 1e-4 and not errors
          and all(i in fr for i in range(RATE // 2, (BLOCKS - 5) * BLOCK)))
same = [n for n in runs[0][0] if n in runs[300][0] and runs[0][0][n] != runs[300][0][n]]
common = len(set(runs[0][0]) & set(runs[300][0]))
check(f"the same duck, frame for frame, with the key 300 ms late ({common} frames compared, "
      f"{len(same)} differ)", common > (BLOCKS - 30) * BLOCK and not same
      and duck_onset(runs[0][0]) == duck_onset(runs[300][0]))

print("\n--- (2) the mrducker message: every 100 ms of content, 10 Hz ---")
for lag in (0, 300):
    msgs = runs[lag][1]
    rts = [(m[1] - msgs[0][1]) / MS for m in msgs]
    steps = {round(b - a) for a, b in zip(rts, rts[1:])}
    wall = sorted((b[0] - a[0]) / MS for a, b in zip(msgs, msgs[1:]))
    check(f"key {lag} ms late: {len(msgs)} messages for 2.5 s of content, 90 or 105 ms of "
          f"content apart (got {sorted(steps)})", 22 <= len(msgs) <= 25 and steps <= {90, 105})
    check(f"key {lag} ms late: they reach the bus at 10 Hz (median {wall[len(wall) // 2]:.0f} "
          f"ms apart)", 80 <= wall[len(wall) // 2] <= 120)
    phases = [m[3] for m in msgs]
    check(f"key {lag} ms late: idle, then the duck held at -12 dB, then released "
          f"({' '.join(dict.fromkeys(phases))})",
          phases[0] == "idle" and "hold" in phases and "release" in phases
          and min(m[2] for m in msgs) == -12)

print("\n--- control: an interleave by arrival (force-live, no watchdogs) misses the late key ---")
rig = Rig(built("ducker", aligned=False)[0])
rig.run(BLOCKS, 0, 300, prog_dc, key_burst, prime=True)
fr = rig.frames()
rig.stop()
n = duck_onset(fr)
before = [fr[i][0] / PROG[0] for i in range(RATE // 2, KEY_AT - RATE // 10) if i in fr]
check(f"control: the programme passes at unity ({len(before)} frames before the key), and the "
      f"duck is not where the key is in the content (onset {n})",
      len(before) > RATE // 4 and min(before) > 0.999
      and (n is None or not 0 < n - KEY_AT <= 768))


def key_tone(n):
    """The gate's key: a 1 kHz burst (LSP's sidechain does not open on DC)."""
    v = 0.5 * math.sin(2 * math.pi * 1000 * n / RATE) if KEY_AT <= n < KEY_AT + KEY_FOR else 0.0
    return (v, v)


print("\n--- (3) the keyed gate opens on the key's content time, its output on content time ---")
desc, why = built("keyedGate")
if desc is None:
    print(f"SKIP keyed gate — {why}")
else:
    # The module's launch values at the defaults, the limiter on (its 5 ms lookahead is in the
    # onset: reported, not corrected, OQ-22).
    opened = {}
    for lag in (0, 300):
        rig = Rig(desc)
        rig.run(BLOCKS, 0, lag, prog_dc, key_tone)
        fr = rig.frames()
        opened[lag] = (open_onset(fr), fr, list(rig.errors))
        on_content_time(f"keyed gate, key {lag} ms late", rig)
        rig.stop()
    for lag, (n, fr, errors) in opened.items():
        closed = fr.get(RATE // 2 + 100, (0, 0))[0] / PROG[0]
        check(f"key {lag} ms late: closed before the key (gain {closed:.4f}), open from "
              f"{None if n is None else round(n * 1000 / RATE, 2)} ms, within 15 ms of the key",
              closed < 0.01 and n is not None and abs(n - KEY_AT) <= 720 and not errors)
    check(f"the gate opens on the same frame with the key 300 ms late "
          f"({opened[0][0]}, {opened[300][0]})", opened[0][0] == opened[300][0] is not None)

if _failures:
    print(f"\n{len(_failures)} FAILED: {_failures}")
    sys.exit(1)
print("\nmrducker_element_test.py: all checks passed")
