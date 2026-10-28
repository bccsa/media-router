#!/usr/bin/env python3
"""The decode ASRC on the consumers' real strings (house-clock ch. 7 WI-P3-9 + WI-P3-15, WI-P3-10).

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
    planar) reaches `asrc` interleaved through `audioconvert`, and `asrc` follows the sink.

Not shipped.
"""
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
            errors.append(f"{m.src.get_name()}: {m.parse_error()[0].message}")
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

if _failures:
    print(f"\n{len(_failures)} FAILURE(S) in gst_decode_asrc_chain_test.py")
    for _f in _failures:
        print(f"  - {_f}")
    sys.exit(1)
print("\nALL gst_decode_asrc_chain_test.py TESTS PASSED")
