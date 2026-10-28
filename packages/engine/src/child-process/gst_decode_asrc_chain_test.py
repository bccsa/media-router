#!/usr/bin/env python3
"""The decode ASRC on the consumers' real strings (house-clock ch. 7 WI-P3-9 + WI-P3-15, WI-P3-10,
WI-P3-12).

fixtures/decode-asrc/pipelines.json holds each string as its module builds it (vitest rewrites it,
testing/decodeAsrcChains.test.ts). Here each runs with its bus sources reading a recording (the
302M ones `cap-mixer-302m-house.ts`) and its network or device sink a test sink:

  - aes67-output: a house-rate 302M programme passes the decode `mrasrc` untouched (mode bypass,
    the same buffers), and nothing engages;
  - audio-output-302m, both arms, on the house clock into tests/libgstmrtest.so's
    `mrtestaudiosink` (40 ppm fast) in place of `pulsesink`: `outasrc` follows the sink by name
    through the chain (mode device, its custom-slaving callback fed), the sink is never asked to
    skew, and in the mixer arm each branch's decode `mrasrc` passes its house-rate input;
  - audio-decoder (WI-P3-10), each decoder branch on a recording of its codec, the same way: the
    first audio stream plays (an input listing its video first too), the decoder's PCM (avdec_aac's
    planar) reaches `asrc` interleaved through `audioconvert`, and `asrc` follows the sink;
  - audio-transcoder (WI-P3-12), each decoder branch on a recording of its codec, its renditions
    into files: `asrc` passes a house-rate decode untouched, and each rendition's PES PTS meet S40
    (the first AU exact, Opus 0 ticks, AAC a tick under its ladder at most, 302M at its PCM's
    stamps); AAC encodes at house rate (AAC out AU for AU), at +40 ppm (`asrc` engages, V5's
    1 ms) and at 44.1 kHz (`asrc` converts to the 48 kHz Opus takes).

Not shipped.
"""
import collections
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    gi.require_version("GstAudio", "1.0")
    from gi.repository import GLib, Gst, GstAudio
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_decode_asrc_chain_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

Gst.init(sys.argv)

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_PLUGINS = os.path.normpath(os.path.join(_HERE, "..", "..", "..", "..", "plugins"))
# The natives from MR_PLUGINS_DIR when set (a mutant, an install), else this repository's.
_PLUGINS = os.environ.get("MR_PLUGINS_DIR") or _REPO_PLUGINS
_NATIVE = os.path.join(_PLUGINS, "mpegts-core", "native")
_HOUSE_SO = os.path.join(_NATIVE, "mrtshouse", "libgstmrtshouse.so")
_LATENESS_SO = os.path.join(_NATIVE, "mrlateness", "libgstmrlateness.so")
_TEST_SO = os.path.join(_NATIVE, "mrtshouse", "tests", "libgstmrtest.so")
_CLI = os.path.join(_REPO_PLUGINS, "mpegts-core", "native", "mrts", "mrts_cli")
_FIX = os.path.join(_REPO_PLUGINS, "mpegts-core", "tests", "fixtures")
# 302M 16-bit stereo on house PES, one PES per 10 ms: an audio-mixer's egress, 7.49 s.
_FIXTURE = os.path.join(_FIX, "cap-mixer-302m-house.ts")

for _path, _what in ((_HOUSE_SO, "the mrtshouse plugin"), (_LATENESS_SO, "the mrlateness plugin"),
                     (_CLI, "mrts_cli")):
    if not os.path.exists(_path):
        print(f"SKIP gst_decode_asrc_chain_test.py — {_what} not built ({_path}); run `make native`")
        sys.exit(0)
if not all(Gst.ElementFactory.find(e) for e in ("avdec_s302m", "rtpL24pay", "audiomixer")):
    print("SKIP gst_decode_asrc_chain_test.py — avdec_s302m, rtpL24pay or audiomixer unavailable")
    sys.exit(0)
for _so in (_HOUSE_SO, _LATENESS_SO):
    Gst.Plugin.load_file(_so)   # a file that is there but does not load is a failure

S, MS = 1_000_000_000, 1_000_000
with open(os.path.join(_FIX, "decode-asrc", "pipelines.json"), encoding="utf-8") as _fh:
    PIPELINES = json.load(_fh)

_failures = []


def check(name, cond):
    if cond:
        print(f"PASS {name}")
    else:
        print(f"FAIL {name}")
        _failures.append(name)


def sdict(st):
    return {st.nth_field_name(i): st.get_value(st.nth_field_name(i)) for i in range(st.n_fields())}


def on_file(desc, path):
    """`desc` with every bus source a filesrc of `path`, its name kept."""
    return re.sub(r"unixfdsrc( name=\S+)? socket-path=\S+",
                  lambda m: f"filesrc{m.group(1) or ''} location={path}", desc)


class Probe:
    """Buffers through a pad: (pts, memory) each."""

    def __init__(self, pad):
        self.bufs = []
        pad.add_probe(Gst.PadProbeType.BUFFER, self._on)

    def _on(self, _pad, info):
        b = info.get_buffer()
        self.bufs.append((b.pts, hash(b.peek_memory(0)) if b.n_memory() else 0))
        return Gst.PadProbeReturn.OK


def run(pipe, secs=None):
    """`pipe` to EOS (or for `secs` of wall time): the mrasrc events, the errors, whether it
    reached EOS."""
    events, errors, eos = [], [], False
    pipe.set_state(Gst.State.PLAYING)
    bus = pipe.get_bus()
    end = time.monotonic() + (secs if secs is not None else 60)
    while time.monotonic() < end:
        m = bus.timed_pop_filtered(100 * Gst.MSECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR
                                   | Gst.MessageType.ELEMENT)
        if m is None:
            continue
        if m.type == Gst.MessageType.EOS:
            eos = True
            break
        if m.type == Gst.MessageType.ERROR:
            err, dbg = m.parse_error()
            # The debug text's last line says why streaming stopped (not-negotiated, ...).
            why = f" ({dbg.splitlines()[-1].strip()})" if dbg else ""
            errors.append(f"{m.src.get_name()}: {err.message}{why}")
            break
        st = m.get_structure()
        if st and st.get_name() == "mrasrc-event":
            events.append((m.src.get_name(), sdict(st)))
    return events, errors, eos


# The running time the device cases start at. A file source prerolls, so the demux meets its first
# PES with no clock and unwraps it in its own 33-bit epoch (B-14's seed): at house 1000 s that epoch
# is the clock's whatever the box's uptime (a bus's unixfdsrc is live: there the clock comes first).
_RT0 = 1000 * S


def rebased(path, out_dir, name=None):
    """`path` moved onto the house clock half a second after `_RT0` (bus formula: PES - 1 h)."""
    moved = os.path.join(out_dir, name or os.path.basename(path))
    subprocess.run([_CLI, "rebase", path, moved, "--to-ns", str(_RT0 + 500 * MS)], check=True,
                   capture_output=True)
    return moved


def on_device(desc):
    """`desc` with tests/libgstmrtest.so's `mrtestaudiosink` 40 ppm fast for its `pulsesink`."""
    desc = re.sub(r"pulsesink name=sink device=\S+", "mrtestaudiosink name=sink ppm=40", desc)
    return re.sub(r' stream-properties="[^"]*"', "", desc)


def house_clock(pipe):
    """`pipe` on the house clock (monotonic), at running time `_RT0` now."""
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
    pipe.use_clock(clock)
    pipe.set_start_time(Gst.CLOCK_TIME_NONE)
    pipe.set_base_time(clock.get_time() - _RT0)


# --- aes67-output ---------------------------------------------------------------------------------
print("--- aes67-output: a house-rate 302M programme through its real string, to a fakesink ---")
_desc = re.sub(r"udpsink name=netsink .*$", "fakesink name=netsink sync=false",
               on_file(PIPELINES["aes67"], _FIXTURE))
check("aes67-output's string decodes on mrtsdemux into its decode mrasrc (no tsdemux, no audioresample)",
      " ! mrtsdemux name=demux select=audio/x-smpte-302m ! avdec_s302m ! mrasrc name=asrc " in _desc
      and not re.search(r"\btsdemux\b", _desc) and "audioresample" not in _desc)
_p = Gst.parse_launch(_desc)
_asrc = _p.get_by_name("asrc")
_probes = [Probe(_asrc.get_static_pad("sink")), Probe(_asrc.get_static_pad("src")),
           Probe(_p.get_by_name("netsink").get_static_pad("sink"))]
_events, _errors, _eos = run(_p)
_st = sdict(_asrc.get_property("stats"))
_p.set_state(Gst.State.NULL)
_ain, _aout, _net = (p.bufs for p in _probes)
check(f"it runs to EOS without an error ({_errors[:1]})", _eos and not _errors)
check(f"mode {_st.get('mode')}: every decoded buffer passed unchanged, the same memory and PTS "
      f"({len(_aout)} of {len(_ain)}), none engaged ({[e['kind'] for _, e in _events]})",
      _st.get("mode") == "bypass" and len(_ain) > 700 and _aout == _ain
      and not [e for _, e in _events if e["kind"] == "engaged"])
check(f"the payloader sent the programme in 1 ms packets ({len(_net)} for {len(_ain)} 10 ms PES)",
      len(_net) >= 10 * len(_ain) - 10)

# --- audio-output-302m --------------------------------------------------------------------------
if not os.path.exists(_TEST_SO):
    print(f"SKIP audio-output-302m — {_TEST_SO} not built (make -C plugins/mpegts-core/native/mrtshouse test)")
else:
    Gst.Plugin.load_file(_TEST_SO)
    _tmp = tempfile.mkdtemp(prefix="decode-asrc-")
    for _arm, _branches in (("aout1", ()), ("aout2", ("mixin_asrc0", "mixin_asrc1"))):
        print(f"\n--- audio-output-302m, {_arm}: on the house clock into mrtestaudiosink 40 ppm fast ---")
        _p = Gst.parse_launch(on_device(on_file(PIPELINES[_arm], rebased(_FIXTURE, _tmp, f"{_arm}.ts"))))
        house_clock(_p)
        _events, _errors, _eos = run(_p, secs=5.0)
        _out = sdict(_p.get_by_name("outasrc").get_property("stats"))
        _br = {n: sdict(_p.get_by_name(n).get_property("stats")) for n in _branches}
        _sink = {k: _p.get_by_name("sink").get_property(k) for k in ("renders", "calibrations", "resyncs")}
        _p.set_state(Gst.State.NULL)
        check(f"{_arm}: the real string plays into the device sink without an error ({_errors[:1]}; "
              f"{_sink['renders']} renders)", not _errors and _sink["renders"] > 100)
        check(f"{_arm}: outasrc follows the sink it names through the chain: mode {_out.get('mode')}, "
              f"{_out.get('device-pairs')} pairs from its custom-slaving callback",
              _out.get("mode") == "device" and (_out.get("device-pairs") or 0) > 20)
        check(f"{_arm}: the sink is never asked to skew ({_sink['calibrations']} calibration changes, "
              f"{_sink['resyncs']} resyncs)", _sink["calibrations"] == 0 and _sink["resyncs"] == 0)
        check(f"{_arm}: nothing engaged ({[(n, e['kind']) for n, e in _events]})",
              not [e for _, e in _events if e["kind"] == "engaged"])
        if _br:
            check(f"{_arm}: each branch's decode mrasrc passes its house-rate input "
                  f"({ {n: (s.get('mode'), s.get('in-frames')) for n, s in _br.items()} })",
                  all(s.get("mode") == "bypass" and (s.get("in-frames") or 0) > 48000
                      for s in _br.values()))
    shutil.rmtree(_tmp, ignore_errors=True)

# --- audio-decoder --------------------------------------------------------------------------------
# Each decoder branch on a recording of its codec: (key, fixture, the first audio PID, its decoder,
# whether that decoder's output is planar). `adec_unknown` (decodebin) twice: the 302M the probe
# names s302m, and an input listing its video first, of which the probe sees no audio (OQ-28).
_ADEC_CASES = (
    ("adec_opus", "tp-opus-51.ts", 0x101, "opusdec", False),
    ("adec_aac", "cap-mux-align7-aac-opus.ts", 0x100, "avdec_aac", True),
    ("adec_mp2", "tp-mpeg2video-mp2.ts", 0x101, "mpg123audiodec", False),
    ("adec_ac3", "tp-h264-ac3-eac3.ts", 0x101, "a52dec", False),
    ("adec_unknown", "cap-mixer-302m-house.ts", 0x41, "avdec_s302m", False),
    ("adec_unknown", "tp-hevc-aac.ts", 0x101, "avdec_aac", True),
)


def _elements(bin_):
    """Every element under `bin_`, decodebin's children included."""
    out, it = [], bin_.iterate_recurse()
    while True:
        ok, el = it.next()
        if ok != Gst.IteratorResult.OK:
            return out
        out.append(el)


def _caps_of(pad):
    caps = pad.get_current_caps() if pad else None
    return caps.get_structure(0) if caps and caps.get_size() else None


def adec_run(desc, path, secs=4.0):
    """An audio-decoder string on `path` (on the house clock half a second from its start) into
    mrtestaudiosink 40 ppm fast: what each element saw, or why it did not parse."""
    try:
        p = Gst.parse_launch(on_device(on_file(desc, rebased(path, _tmp))))
    except GLib.Error as exc:
        return {"parse": exc.message}
    house_clock(p)
    played = [0]

    def count(_pad, info):
        played[0] += info.get_buffer().get_size()
        return Gst.PadProbeReturn.OK

    sinkpad = p.get_by_name("sink").get_static_pad("sink")
    sinkpad.add_probe(Gst.PadProbeType.BUFFER, count)
    events, errors, _eos = run(p, secs=secs)
    caps = sinkpad.get_current_caps()
    info = GstAudio.AudioInfo.new_from_caps(caps) if caps else None
    asrc = p.get_by_name("asrc")
    r = {
        "events": events, "errors": errors,
        "pads": [(pad.get_name(), pad.is_linked()) for pad in p.get_by_name("addemux").srcpads],
        "asrc": sdict(asrc.get_property("stats")),
        "asrc_in": _caps_of(asrc.get_static_pad("sink")),
        "dec_out": {e.get_factory().get_name(): _caps_of(e.get_static_pad("src")) for e in _elements(p)
                    if e.get_factory() and "Decoder/Audio" in (e.get_factory().get_metadata("klass") or "")},
        "sink": {k: p.get_by_name("sink").get_property(k) for k in ("renders", "calibrations", "resyncs")},
        "played_s": played[0] / info.bpf / info.rate if info else 0.0,
    }
    p.set_state(Gst.State.NULL)
    return r


def _layout(st):
    return st.get_value("layout") if st else None


if not os.path.exists(_TEST_SO):
    print(f"SKIP audio-decoder — {_TEST_SO} not built (make -C plugins/mpegts-core/native/mrtshouse test)")
elif not all(Gst.ElementFactory.find(e) for e in ("opusdec", "avdec_aac", "mpg123audiodec", "a52dec")):
    print("SKIP audio-decoder — opusdec, avdec_aac, mpg123audiodec or a52dec unavailable")
else:
    Gst.Plugin.load_file(_TEST_SO)
    _tmp = tempfile.mkdtemp(prefix="decode-asrc-adec-")
    for _key, _fx, _pid, _dec, _planar in _ADEC_CASES:
        _desc = PIPELINES[_key]
        print(f"\n--- audio-decoder, {_key}: {_fx} through its real string into mrtestaudiosink ---")
        check(f"{_key}: the first audio stream from mrtsdemux, the decoder, audioconvert, the render tap, "
              f"then the one ASRC on the sink (no tsdemux, no audioresample, custom slaving)",
              " ! mrtsdemux name=addemux media=audio ! " in _desc
              and re.search(r" ! audioconvert ! mrlateness name=lat_render \S+ ! mrasrc name=asrc "
                            r"bypass-below-ppm=0\.5 device-sink=sink ! audioconvert ! ", _desc) is not None
              and not re.search(r"\btsdemux\b", _desc) and "audioresample" not in _desc
              and " slave-method=3 " in _desc)
        _r = adec_run(_desc, os.path.join(_FIX, _fx))
        if "parse" in _r:
            check(f"{_key}: the string parses ({_r['parse']})", False)
            continue
        _linked = [int(n.rsplit("_", 1)[1], 16) for n, linked in _r["pads"] if linked]
        check(f"{_key}: plays in real time without an error ({_r['errors'][:1]}; {_r['played_s']:.2f} s "
              f"into the sink in 4 s)", not _r["errors"] and 2.0 <= _r["played_s"] <= 4.6)
        check(f"{_key}: the demux offers audio only and the first audio PID plays ({_r['pads']})",
              all(n.startswith("audio_") for n, _ in _r["pads"]) and _linked == [_pid])
        _in, _out = _r["asrc_in"], _r["dec_out"].get(_dec)
        check(f"{_key}: {_dec} gives {_layout(_out)} PCM, the ASRC takes "
              f"{_in.get_value('format') if _in else None} {_layout(_in)}",
              _layout(_in) == "interleaved"
              and _layout(_out) == ("non-interleaved" if _planar else "interleaved"))
        check(f"{_key}: the ASRC follows the sink (mode {_r['asrc'].get('mode')}, "
              f"{_r['asrc'].get('device-pairs')} pairs from its custom-slaving callback), nothing engaged "
              f"({[(n, e['kind']) for n, e in _r['events']]})",
              _r["asrc"].get("mode") == "device" and (_r["asrc"].get("device-pairs") or 0) > 20
              and not [e for _, e in _r["events"] if e["kind"] == "engaged"])
        check(f"{_key}: the sink is never asked to skew ({_r['sink']['calibrations']} calibration changes, "
              f"{_r['sink']['resyncs']} resyncs)",
              _r["sink"]["calibrations"] == 0 and _r["sink"]["resyncs"] == 0)

    # Why `media=audio`: without it decodebin takes whatever comes first, here the video, and the
    # chain fails, as the decoder did on tsdemux (OQ-28).
    _bare = PIPELINES["adec_unknown"].replace(" media=audio ", " ")
    _r = adec_run(_bare, os.path.join(_FIX, "tp-hevc-aac.ts"), secs=2.0)
    check(f"without media=audio the video links first and the chain fails ({_r.get('pads')}; "
          f"{_r.get('errors', [])[:1]})",
          [n for n, linked in _r.get("pads", []) if linked][:1] == ["video_0_0100"] and bool(_r.get("errors")))
    shutil.rmtree(_tmp, ignore_errors=True)

# --- audio-transcoder -----------------------------------------------------------------------------
# Each decoder branch on a recording of its codec, its three renditions (Opus, AAC, 302M, the order
# decodeAsrcChains.test.ts builds them in) each into a file in place of its bus egress: (key,
# fixture, the first audio PID, its decoder, whether that decoder's output is planar).
_ATX_CASES = (
    ("atx_opus", "tp-opus-51.ts", 0x101, "opusdec", False),
    ("atx_aac", "cap-vmix-h264-aac.ts", 0x100, "avdec_aac", True),
    ("atx_mp2", "tp-mpeg2video-mp2.ts", 0x101, "mpg123audiodec", False),
    ("atx_ac3", "tp-h264-ac3-eac3.ts", 0x101, "a52dec", False),
    ("atx_s302m", "cap-mixer-302m-house.ts", 0x41, "avdec_s302m", False),
    ("atx_unknown", "tp-hevc-aac.ts", 0x101, "avdec_aac", True),
)
_RENDITIONS = ("opus", "aac", "pcm")
_AAC_AU, _OPUS_AU = 1920, 1800   # 1,024 samples and 20 ms at 48 kHz, in 90 kHz ticks
_OPUS_TRIM = 585                 # opusenc's 6.5 ms lookahead, off its first frame
_TICK_NS = 11112                 # a 90 kHz tick, rounded up
_GEN = os.path.join(_REPO_PLUGINS, "mpegts-core", "native", "mrts", "tests", "fixture_gen")


def _dump_pts(path, pid=None):
    """(pid, its PES PTS in stream order) from `mrts_cli dump`; `pid` None: the first with a PTS."""
    out = subprocess.run([_CLI, "dump", path], check=True, capture_output=True, text=True).stdout
    rows = [r for r in map(json.loads, out.splitlines()) if r.get("pts") is not None]
    pid = rows[0]["pid"] if pid is None and rows else pid
    return pid, [r["pts"] for r in rows if r["pid"] == pid]


class _Labels:
    """`asrc`'s output: (PTS, frames) per buffer."""

    def __init__(self, pad):
        self.bufs = []
        pad.add_probe(Gst.PadProbeType.BUFFER, self._on)

    def _on(self, pad, info):
        b = info.get_buffer()
        caps = pad.get_current_caps()
        bpf = GstAudio.AudioInfo.new_from_caps(caps).bpf if caps else 0
        self.bufs.append((b.pts, b.get_size() // bpf if bpf else 0))
        return Gst.PadProbeReturn.OK


def atx_run(desc, path):
    """An audio-transcoder string on `path`, each rendition's bus egress a file, to EOS: what the
    demux, the decoder and `asrc` saw, and each rendition's PES PTS."""
    files = []

    def to_file(m):
        files.append(os.path.join(_tmp, f"{m.group(1)}.ts"))
        return f"filesink name={m.group(1)} location={files[-1]}"

    try:
        p = Gst.parse_launch(re.sub(r"tee name=(busout_\d+) allow-not-linked=true", to_file, on_file(desc, path)))
    except GLib.Error as exc:
        return {"parse": exc.message, "events": [], "errors": [exc.message], "eos": False, "pads": [], "in": [],
                "out": [], "labels": [], "asrc": {}, "asrc_in": None, "asrc_out": None, "egress": {}}
    asrc = p.get_by_name("asrc")
    ain, aout = (Probe(asrc.get_static_pad("sink")), Probe(asrc.get_static_pad("src"))) if asrc else (None, None)
    labels = _Labels(asrc.get_static_pad("src")) if asrc else None
    events, errors, eos = run(p)
    r = {
        "events": events, "errors": errors, "eos": eos,
        "pads": [(pad.get_name(), pad.is_linked()) for pad in p.get_by_name("demux").srcpads],
        "dec_out": {e.get_factory().get_name(): _caps_of(e.get_static_pad("src")) for e in _elements(p)
                    if e.get_factory() and "Decoder/Audio" in (e.get_factory().get_metadata("klass") or "")},
    }
    r.update({"in": ain.bufs, "out": aout.bufs, "labels": labels.bufs, "asrc": sdict(asrc.get_property("stats")),
              "asrc_in": _caps_of(asrc.get_static_pad("sink")), "asrc_out": _caps_of(asrc.get_static_pad("src"))}
             if asrc else {"in": [], "out": [], "labels": [], "asrc": {}, "asrc_in": None, "asrc_out": None})
    p.set_state(Gst.State.NULL)
    r["egress"] = dict(zip(_RENDITIONS, (_dump_pts(f)[1] for f in files))) if eos else {}
    return r


def _engaged(r):
    return [e for _, e in r["events"] if e["kind"] == "engaged"]


def _ticks(ns):
    return ns * 9 // 100000


def _ladder(pts, step, start=0):
    """Each PES PTS from `start` on, less its place on a `step`-tick ladder from the one at `start`."""
    return collections.Counter(pts[k] - pts[start] - step * (k - start) for k in range(start, len(pts)))


def _off_count(r):
    """Each `asrc` output's label (the content's house time) less where the encoders' sample count
    from the first puts it (ns)."""
    rate = r["asrc_out"].get_value("rate")
    t0, n, out = r["labels"][0][0], 0, []
    for pts, frames in r["labels"]:
        out.append(pts - (t0 + n * S // rate))
        n += frames
    return out


def atx_egress_checks(key, r, first_pts):
    """S40's criterion on each rendition: the first AU at the input's first PES PTS; Opus on its
    sample count, 0 ticks; AAC within one tick under its ladder; 302M at its PCM's stamps."""
    eg = r["egress"]
    check(f"{key}: each rendition's first AU at the input's first PES PTS, 0 ticks "
          f"({ {k: (v[0] - first_pts) if v else None for k, v in eg.items()} })",
          len(eg) == 3 and all(v and v[0] == first_pts for v in eg.values()))
    o, a, pcm = eg.get("opus", []), eg.get("aac", []), eg.get("pcm", [])
    check(f"{key}: Opus at 0 ticks on its sample count, every 20 ms from its second AU "
          f"({dict(_ladder(o, _OPUS_AU, 1))}; the first {(o[1] - o[0]) if len(o) > 1 else None} ticks, "
          f"opusenc's 6.5 ms lookahead off its first frame)",
          len(o) > 50 and set(_ladder(o, _OPUS_AU, 1)) == {0} and o[1] - o[0] == _OPUS_AU - _OPUS_TRIM)
    check(f"{key}: AAC within one tick under its 1,920-tick sample ladder from the first AU "
          f"({dict(_ladder(a, _AAC_AU))})",
          len(a) > 50 and set(_ladder(a, _AAC_AU)) <= {0, -1})
    # avenc_s302m has no perfect-timestamp: it re-syncs to its input's stamps past half a sample.
    lab = r["labels"]
    d = collections.Counter(pcm[k] - pcm[0] - (_ticks(lab[k][0]) - _ticks(lab[0][0]))
                            for k in range(min(len(pcm), len(lab))))
    check(f"{key}: 302M, one AU per PCM buffer, each within one tick of that buffer's stamp ({dict(d)})",
          len(pcm) > 50 and len(pcm) >= len(lab) - 1 and set(d) <= {-1, 0, 1})


_ENCODERS = ("opusenc", "avenc_aac", "avenc_s302m", "mpegtsmux", "opusdec", "avdec_aac", "mpg123audiodec",
             "a52dec", "audiotestsrc")
if not all(Gst.ElementFactory.find(e) for e in _ENCODERS):
    print(f"SKIP audio-transcoder — one of {', '.join(_ENCODERS)} unavailable")
else:
    _tmp = tempfile.mkdtemp(prefix="decode-asrc-atx-")
    for _key, _fx, _pid, _dec, _planar in _ATX_CASES:
        _desc = PIPELINES[_key]
        _front = _desc.split(" t. ! ")[0]
        print(f"\n--- audio-transcoder, {_key}: {_fx} through its real string, each rendition into a file ---")
        check(f"{_key}: the first audio stream from mrtsdemux, the decoder, audioconvert, then the decode ASRC "
              f"before the trunk (no tsdemux, no resampler before the tee)",
              " ! mrtsdemux name=demux media=audio ! " in _front
              and re.search(r" ! audioconvert ! mrasrc name=asrc bypass-below-ppm=0\.5 ! audioconvert ! volume ",
                            _front) is not None
              and not re.search(r"\btsdemux\b", _desc) and "audioresample" not in _front)
        _src = rebased(os.path.join(_FIX, _fx), _tmp, f"{_key}.in.ts")
        _r = atx_run(_desc, _src)
        if "parse" in _r:
            check(f"{_key}: the string parses ({_r['parse']})", False)
            continue
        _linked = [int(n.rsplit("_", 1)[1], 16) for n, linked in _r["pads"] if linked]
        check(f"{_key}: runs to EOS without an error ({_r['errors'][:1]})", _r["eos"] and not _r["errors"])
        check(f"{_key}: the demux offers audio only and the first audio PID plays ({_r['pads']})",
              all(n.startswith("audio_") for n, _ in _r["pads"]) and _linked == [_pid])
        _in, _out = _r["asrc_in"], _r["dec_out"].get(_dec)
        check(f"{_key}: {_dec} gives {_layout(_out)} PCM, the ASRC takes "
              f"{_in.get_value('format') if _in else None} {_layout(_in)}",
              _layout(_in) == "interleaved"
              and _layout(_out) == ("non-interleaved" if _planar else "interleaved"))
        check(f"{_key}: mode {_r['asrc'].get('mode')}: asrc passes every decoded buffer unchanged, the same "
              f"memory and PTS ({len(_r['out'])} of {len(_r['in'])}), none engaged",
              _r["asrc"].get("mode") == "bypass" and len(_r["in"]) > 50 and _r["out"] == _r["in"]
              and not _engaged(_r))
        atx_egress_checks(_key, _r, _dump_pts(_src, _pid)[1][0])

    # AAC encodes, as gst_mrasrc_element_test.py makes them: 35 s at house rate, the same respaced
    # +40 ppm (a source on its own clock), and 8 s at 44.1 kHz, each through the AAC branch's string.
    def _encode(name, secs, rate):
        path = os.path.join(_tmp, name)
        p = Gst.parse_launch(f"audiotestsrc num-buffers={secs * rate // 1024} samplesperbuffer=1024 wave=sine "
                             f"freq=1000 ! audio/x-raw,format=S16LE,rate={rate},channels=2 ! audioconvert ! "
                             f"avenc_aac ! aacparse ! mpegtsmux ! filesink location={path}")
        p.set_state(Gst.State.PLAYING)
        p.get_bus().timed_pop_filtered(60 * Gst.SECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR)
        p.set_state(Gst.State.NULL)
        return path

    _raw = _encode("house-raw.ts", 35, 48000)
    _house = rebased(_raw, _tmp, "house.ts")
    print("\n--- audio-transcoder, atx_aac: a 35 s AAC encode at house rate ---")
    _r = atx_run(PIPELINES["atx_aac"], _house)
    _, _inp = _dump_pts(_house)
    _a = _r["egress"].get("aac", [])
    _off = _off_count(_r) if _r.get("labels") else [S]
    _au = collections.Counter(_a[k] - _inp[k] for k in range(min(len(_a), len(_inp))))
    check(f"house rate: runs to EOS ({_r['errors'][:1]}), mode {_r['asrc'].get('mode')} and "
          f"{_r['asrc'].get('state')} at the end, every buffer passed unchanged, none engaged",
          _r["eos"] and not _r["errors"] and _r["asrc"].get("mode") == "bypass"
          and _r["asrc"].get("state") == "locked" and _r["out"] == _r["in"] and not _engaged(_r))
    check(f"house rate: AAC in, AAC out AU for AU within one tick from the first ({dict(_au)}, "
          f"{len(_a)} of {len(_inp)} AUs)", len(_a) > 1500 and set(_au) <= {-1, 0, 1})
    check(f"house rate: the content's house time within a tick of the sample count the encoders stamp "
          f"(max {max(map(abs, _off)) / 1000:.1f} us)", max(map(abs, _off)) <= _TICK_NS)
    atx_egress_checks("house rate", _r, _inp[0])

    _foreign = os.path.join(_tmp, "foreign-raw.ts")
    _resp = subprocess.run([_GEN, "--respace", "40", "-i", _raw, "-o", _foreign], capture_output=True, text=True)
    print("\n--- audio-transcoder, atx_aac: the same respaced +40 ppm (a source on its own clock; V5) ---")
    if _resp.returncode != 0 or not os.path.exists(_foreign):
        check(f"fixture_gen --respace 40 ({_GEN}: rc {_resp.returncode} {_resp.stderr.strip()[:80]})", False)
    else:
        _src = rebased(_foreign, _tmp, "foreign.ts")
        _r = atx_run(PIPELINES["atx_aac"], _src)
        _, _inp = _dump_pts(_src)
        _eng = _engaged(_r)
        _at = (_eng[0]["house-ns"] - _r["labels"][0][0]) / S if _eng and _r.get("labels") else -1
        _off = _off_count(_r) if _r.get("labels") else [S]
        _k = next((i for i, (t, _) in enumerate(_r.get("labels", [])) if _eng and t >= _eng[0]["house-ns"]), 0)
        _after = _off[_k:] or [S]
        check(f"+40 ppm: engages within 30 s ({_at:.2f} s, {_eng[0]['reason'] if _eng else None}; the source "
              f"{_eng[0]['source-ppb'] / 1000 if _eng else 0:+.3f} ppm, its PTS 40 ppm long), mode "
              f"{_r['asrc'].get('mode')} at the end, no error ({_r['errors'][:1]})",
              _r["eos"] and not _r["errors"] and len(_eng) == 1 and 0 < _at <= 30
              and abs(_eng[0]["source-ppb"] + 40000) <= 2000 and _r["asrc"].get("mode") == "decode")
        # The phase bound, 1 ms, and what the buffer that crossed it drifts (40 ppm of 21 ms: 1 us).
        check(f"+40 ppm: the content's house time against the sample count the encoders stamp: the phase at "
              f"the engage at most, 1 ms (V5; max {max(map(abs, _off)) / 1000:.1f} us), held from the engage on "
              f"({min(_after) / 1000:.1f}..{max(_after) / 1000:.1f} us)",
              max(map(abs, _off)) <= MS + 2000 and max(_after) - min(_after) <= _TICK_NS)
        atx_egress_checks("+40 ppm", _r, _inp[0])

    print("\n--- audio-transcoder, atx_aac: an 8 s AAC encode at 44.1 kHz ---")
    _src = rebased(_encode("aac441-raw.ts", 8, 44100), _tmp, "aac441.ts")
    _r = atx_run(PIPELINES["atx_aac"], _src)
    _rates = (_r["asrc_in"].get_value("rate") if _r.get("asrc_in") else None,
              _r["asrc_out"].get_value("rate") if _r.get("asrc_out") else None)
    check(f"44.1 kHz: runs to EOS ({_r['errors'][:1]}); asrc converts {_rates[0]} -> {_rates[1]} Hz, the rate "
          f"the renditions take (no out-rate), mode {_r['asrc'].get('mode')}, none engaged",
          _r["eos"] and not _r["errors"] and _rates == (44100, 48000) and _r["asrc"].get("mode") == "bypass"
          and not _engaged(_r))
    atx_egress_checks("44.1 kHz", _r, _dump_pts(_src)[1][0])
    # Why the ASRC carries the rate: without it the trunk stays at 44.1 kHz, which opusenc refuses.
    _r = atx_run(PIPELINES["atx_aac"].replace(" ! mrasrc name=asrc bypass-below-ppm=0.5", ""), _src)
    check(f"44.1 kHz without the ASRC: the Opus rendition does not negotiate ({_r.get('errors', [])[:1]})",
          any("not-negotiated" in e for e in _r.get("errors", [])))

    # Why `media=audio` (OQ-28): without it decodebin takes the video this input lists first.
    _r = atx_run(PIPELINES["atx_unknown"].replace(" media=audio ", " "),
                 rebased(os.path.join(_FIX, "tp-hevc-aac.ts"), _tmp, "atx-bare.ts"))
    check(f"without media=audio the video links first and the transcoder fails ({_r.get('pads')}; "
          f"{_r.get('errors', [])[:1]})",
          [n for n, linked in _r.get("pads", []) if linked][:1] == ["video_0_0100"] and bool(_r.get("errors")))
    shutil.rmtree(_tmp, ignore_errors=True)

if _failures:
    print(f"\n{len(_failures)} FAILURE(S) in gst_decode_asrc_chain_test.py")
    for _f in _failures:
        print(f"  - {_f}")
    sys.exit(1)
print("\nALL gst_decode_asrc_chain_test.py TESTS PASSED")
