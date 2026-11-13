#!/usr/bin/env python3
"""The QVBR encoder strings on real GStreamer.

Each string in `plugins/transcoder/tests/qvbr-encoders.json` (written by
`engine/qvbrPlan.test.ts`; `vitest -u` rewrites it) whose element is installed
encodes 30 small frames, then every `key=value` the builder put on the encoder
must read back from the element. Out of range, GStreamer only logs CRITICAL
and keeps the default; VA-API rewrites a cpb-size under max/2 to 2 s of max,
and a rate-control its driver lacks fails the parse. Elements not installed
are skipped (a Pi has no VA-API, a gateway no x265enc).

Run: python3 qvbr_encoders_test.py   (from plugins/transcoder/py)
"""
import json
import os
import shlex
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PLAN = os.path.join(_HERE, "..", "tests", "qvbr-encoders.json")
failures = 0


def check(name, ok, detail=""):
    global failures
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail and not ok else ""))
    if not ok:
        failures += 1


def finish():
    print()
    if failures:
        print(f"{failures} check(s) FAILED")
        sys.exit(1)
    print("all checks passed")
    sys.exit(0)


try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP — GStreamer unavailable ({exc})")
    finish()
Gst.init([])


def readback(value):
    """A property value as gst-launch spells it: enum nick, flags nicks, else str."""
    if hasattr(value, "value_nick"):
        return value.value_nick
    if hasattr(value, "value_nicks"):
        return "+".join(value.value_nicks)
    return str(value)


def run(case, fragment):
    head = fragment.split(" ! ")[0]
    tokens = shlex.split(head)
    factory = tokens[0]
    if Gst.ElementFactory.find(factory) is None:
        print(f"SKIP {case} — {factory} not installed")
        return
    fmt = "NV12" if factory.startswith("va") else "I420"
    desc = (
        f"videotestsrc num-buffers=30 pattern=ball ! "
        f"video/x-raw,format={fmt},width=320,height=240,framerate=25/1 ! {fragment} ! fakesink name=out"
    )
    try:
        pipe = Gst.parse_launch(desc)
    except Exception as exc:  # a rate-control the driver lacks fails here
        check(f"{case}: parses", False, str(exc))
        return
    pipe.set_state(Gst.State.PLAYING)
    msg = pipe.get_bus().timed_pop_filtered(30 * Gst.SECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR)
    ok = msg is not None and msg.type == Gst.MessageType.EOS
    err = msg.parse_error()[0].message if msg is not None and msg.type == Gst.MessageType.ERROR else "timeout"
    check(f"{case}: encodes to EOS", ok, "" if ok else err)
    out = pipe.get_by_name("out").get_property("last-sample")
    check(f"{case}: output reached the sink", out is not None)
    enc = pipe.get_by_name("enc")
    for tok in tokens[1:]:
        key, _, want = tok.partition("=")
        if key == "name":
            continue
        got = readback(enc.get_property(key))
        check(f"{case}: {key}={want} took", got == want, f"reads {got}")
    pipe.set_state(Gst.State.NULL)


with open(_PLAN) as f:
    plan = json.load(f)
for case, fragment in plan.items():
    run(case, fragment)
finish()
