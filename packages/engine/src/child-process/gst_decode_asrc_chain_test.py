#!/usr/bin/env python3
"""The decode ASRC on the consumers' real strings (house-clock ch. 7 WI-P3-9 + WI-P3-15).

fixtures/decode-asrc/pipelines.json holds each string as its module builds it (vitest rewrites it,
testing/decodeAsrcChains.test.ts). Here each runs with its bus sources reading a recorded 302M
fixture and its network or device sink a test sink:

  - aes67-output: a house-rate 302M programme passes the decode `mrasrc` untouched (mode bypass,
    the same buffers), and nothing engages;
  - audio-output-302m, both arms, on the house clock into tests/libgstmrtest.so's
    `mrtestaudiosink` (40 ppm fast) in place of `pulsesink`: `outasrc` follows the sink by name
    through the chain (mode device, its custom-slaving callback fed), the sink is never asked to
    skew, and in the mixer arm each branch's decode `mrasrc` passes its house-rate input.

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
    from gi.repository import Gst
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
        # The fixture on the house clock half a second from now (bus formula: PES - 1 h).
        _at = time.monotonic_ns() + 500 * MS
        _moved = os.path.join(_tmp, f"{_arm}.ts")
        subprocess.run([_CLI, "rebase", _FIXTURE, _moved, "--to-ns", str(_at)], check=True,
                       capture_output=True)
        _desc = on_file(PIPELINES[_arm], _moved)
        _desc = re.sub(r"pulsesink name=sink device=\S+", "mrtestaudiosink name=sink ppm=40", _desc)
        _desc = re.sub(r' stream-properties="[^"]*"', "", _desc)
        _p = Gst.parse_launch(_desc)
        _clock = Gst.SystemClock.obtain()
        _clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
        _p.use_clock(_clock)
        _p.set_start_time(Gst.CLOCK_TIME_NONE)
        _p.set_base_time(0)
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

if _failures:
    print(f"\n{len(_failures)} FAILURE(S) in gst_decode_asrc_chain_test.py")
    for _f in _failures:
        print(f"  - {_f}")
    sys.exit(1)
print("\nALL gst_decode_asrc_chain_test.py TESTS PASSED")
