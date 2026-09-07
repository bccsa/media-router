#!/usr/bin/env python3
"""Self-checking tests for the pad-link rule `parser: "none"` option
(`_parser_prefix_for_pad` in gst-pipeline-runner.py).

  1. Default mode still injects the codec parser (h264parse config-interval=-1,
     aacparse) exactly as before.
  2. `parser_mode="none"` on an H.264 / H.265 pad replaces the parser with an
     `alignment=au` capssetter (mpegtsmux / avdec refuse byte-stream caps
     without an alignment field).
  3. `parser_mode="none"` leaves AUDIO and unknown codecs on their normal path —
     the bypass is a video-only latency knob, never a framing change for audio.
  4. The tee fan-out path honours the mode too (regression for the review
     finding that duplicate-PID rules silently kept their parser).

Run: python3 packages/engine/src/child-process/gst_parser_bypass_test.py
"""
import importlib.util
import inspect
import os
import sys

import gi
gi.require_version("Gst", "1.0")
from gi.repository import Gst  # noqa: E402

Gst.init([])

_HERE = os.path.dirname(os.path.abspath(__file__))
_RUNNER = os.path.join(_HERE, "gst-pipeline-runner.py")
_spec = importlib.util.spec_from_file_location("gst_pipeline_runner", _RUNNER)
runner = importlib.util.module_from_spec(_spec)
sys.argv = [sys.argv[0]]
_spec.loader.exec_module(runner)

events = []
runner.emit_event = lambda ev: events.append(ev)


class FakePad:
    """Just enough GstPad for `_parser_prefix_for_pad`: caps + a name."""

    def __init__(self, caps, name="video_0_0041"):
        self._caps = Gst.Caps.from_string(caps)
        self._name = name

    def get_current_caps(self):
        return self._caps

    def query_caps(self, _filter):
        return self._caps

    def get_name(self):
        return self._name


H264 = "video/x-h264, stream-format=(string)byte-stream"
H265 = "video/x-h265, stream-format=(string)byte-stream"
AAC = "audio/mpeg, mpegversion=(int)4, stream-format=(string)adts"
OPUS = "audio/x-opus"
UNKNOWN = "video/x-unknown-codec"

failures = 0


def check(label, got, want):
    global failures
    ok = got == want
    failures += 0 if ok else 1
    print(f"  {'PASS' if ok else 'FAIL'}: {label}" + ("" if ok else f"\n        got  {got!r}\n        want {want!r}"))


print("1. default mode injects the parser")
check("h264 auto", runner._parser_prefix_for_pad(FakePad(H264), "r"), "h264parse config-interval=-1 ! ")
check("h264 explicit auto", runner._parser_prefix_for_pad(FakePad(H264), "r", "auto"), "h264parse config-interval=-1 ! ")
check("aac auto", runner._parser_prefix_for_pad(FakePad(AAC, "audio_0_0042"), "r"), "aacparse ! ")

print("2. parser_mode=none declares alignment=au on video")
check("h264 none", runner._parser_prefix_for_pad(FakePad(H264), "r", "none"),
      'capssetter caps="video/x-h264,stream-format=byte-stream,alignment=au" ! ')
check("h265 none", runner._parser_prefix_for_pad(FakePad(H265), "r", "none"),
      'capssetter caps="video/x-h265,stream-format=byte-stream,alignment=au" ! ')
check("bypass is announced", any("parser bypass" in e.get("message", "") for e in events), True)

print("3. parser_mode=none leaves audio / unknown codecs alone")
check("aac none", runner._parser_prefix_for_pad(FakePad(AAC, "audio_0_0042"), "r", "none"), "aacparse ! ")
check("opus none", runner._parser_prefix_for_pad(FakePad(OPUS, "audio_0_0043"), "r", "none"), "")
check("unknown none", runner._parser_prefix_for_pad(FakePad(UNKNOWN), "r", "none"), "")

print("4. tee fan-out path threads the mode through")
src = inspect.getsource(runner._link_pad_to_branches_via_tee)
check("tee helper accepts parser_mode", "parser_mode" in inspect.signature(runner._link_pad_to_branches_via_tee).parameters, True)
check("tee helper passes it to the prefix", "_parser_prefix_for_pad(pad, rule_id, parser_mode)" in src, True)
install_src = inspect.getsource(runner._install_pad_link_rule)
check("rule installer reads rule['parser']", 'rule.get("parser")' in install_src, True)
check("rule installer forwards mode to tee path", "link_to_name, parser_mode)" in install_src, True)

print()
if failures:
    print(f"{failures} check(s) FAILED")
    sys.exit(1)
print("all checks passed")
