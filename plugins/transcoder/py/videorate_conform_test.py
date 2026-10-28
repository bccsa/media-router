#!/usr/bin/env python3
"""The frame-rate conform of the Video Transcoder's and the Video Encoder's strings at house time (B-186).

Each builder's `videorate … ! <caps>,framerate=N/1` is taken from the strings its vitest writes
(`plugins/transcoder/tests/videorate-plan.json`, `plugins/video-encoder/tests/videorate-strings.json`;
`vitest -u` rewrites them) and fed 50 fps frames from an appsrc, on a segment from 0 with PTS at house
time (from 1 h, and from 10^6 s, a box's uptime), as tsdemux gives the transcoder's decoder:

  1. transcoder: a 25 fps rendition passes 50 of 100 (±1), 40 ms apart; a 50 fps one 100 of 100.
  2. encoder: the raw tail at 25 passes 50 of 100 (±1), at 50 all 100; the MJPG pre-drop at 25 50 of 100.
  3. never a frame twice or one made up: through a 1 s forward jump, every frame out is an input frame,
     once, unflagged, and the 50 fps strings pass all of them.

Run: python3 videorate_conform_test.py   (from plugins/transcoder/py)
"""
import json
import os
import re
import struct
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_PLAN = os.path.join(_HERE, "..", "tests", "videorate-plan.json")
_ENC = os.path.join(_HERE, "..", "..", "video-encoder", "tests", "videorate-strings.json")
failures = 0


def check(name, ok):
    global failures
    print(("PASS " if ok else "FAIL ") + name)
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
if Gst.ElementFactory.find("videorate") is None:
    print("SKIP — videorate unavailable")
    finish()

S = Gst.SECOND
D = S // 50
RATE = re.compile(r"videorate [^!]*! (?:video/x-raw|image/jpeg),framerate=\d+/1")


def fragments(pipeline):
    return RATE.findall(pipeline)


def run(fragment, pts):
    """One 50 fps frame per PTS (its index in the payload) through `fragment`, on a segment from 0.
    Returns [(index, pts, flagged)] out, or None when the pipeline errs."""
    media = "image/jpeg,parsed=(boolean)true" if "image/jpeg" in fragment else "video/x-raw,format=GRAY8"
    pipe = Gst.parse_launch(f'appsrc name=src format=time caps="{media},width=64,height=48,framerate=50/1" '
                            f"! {fragment} ! fakesink name=out sync=false")
    out = []

    def on_buf(_pad, info):
        buf = info.get_buffer()
        flagged = buf.has_flags(Gst.BufferFlags.GAP)
        out.append((struct.unpack("<I", buf.extract_dup(0, 4))[0], buf.pts, flagged))
        return Gst.PadProbeReturn.OK

    pipe.get_by_name("out").get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, on_buf)
    pipe.set_state(Gst.State.PLAYING)
    src = pipe.get_by_name("src")
    for i, t in enumerate(pts):
        buf = Gst.Buffer.new_wrapped(struct.pack("<I", i) + bytes(64 * 48 - 4))
        buf.pts, buf.duration = t, D
        src.emit("push-buffer", buf)
    src.emit("end-of-stream")
    msg = pipe.get_bus().timed_pop_filtered(20 * S, Gst.MessageType.EOS | Gst.MessageType.ERROR)
    pipe.set_state(Gst.State.NULL)
    return out if msg is not None and msg.type == Gst.MessageType.EOS else None


def grid(n, start):
    return [start + i * D for i in range(n)]


for path in (_PLAN, _ENC):
    if not os.path.exists(path):
        print(f"FAIL {os.path.relpath(path, _HERE)} missing (run vitest for its plugin)")
        failures += 1
        finish()
with open(_PLAN, encoding="utf-8") as fh:
    plan = json.load(fh)
with open(_ENC, encoding="utf-8") as fh:
    enc = json.load(fh)

tc = {fps: fragments(plan[f"rendition{fps}"]["pipeline"]) for fps in (25, 50)}
raw = {fps: fragments(enc[f"raw{fps}"]) for fps in (25, 50)}
mjpeg = fragments(enc["mjpeg25"])
print("0. the strings")
check(f"the transcoder has one videorate per plan ({tc})", all(len(v) == 1 for v in tc.values()))
check(f"the encoder's raw tail has one ({raw})", all(len(v) == 1 for v in raw.values()))
check(f"the encoder's MJPG branch has the pre-drop and the raw tail ({mjpeg})",
      len(mjpeg) == 2 and "image/jpeg,framerate=25/1" in mjpeg[0] and "video/x-raw,framerate=25/1" in mjpeg[1])

cases = (("1. transcoder rendition", tc[25][0], tc[50][0]),
         ("2. encoder raw tail", raw[25][0], raw[50][0]),
         ("2. encoder MJPG pre-drop", mjpeg[0], None))
for label, at25, at50 in cases:
    print(f"{label}: {at25!r}")
    for house, where in ((3600 * S, "1 h"), (10**6 * S, "10^6 s")):
        inp = grid(100, house)
        out = run(at25, inp)
        n = len(out) if out is not None else -1
        steps = {b[1] - a[1] for a, b in zip(out, out[1:])} if out else set()
        ms = sorted(s // 10**6 for s in steps)
        check(f"{label} at 25 fps, 50 fps in from {where}: {n} of 100 out, steps {ms} ms",
              out is not None and abs(n - 50) <= 1 and steps == {2 * D})
        if at50:
            out = run(at50, inp)
            check(f"{label} at 50 fps, 50 fps in from {where}: "
                  f"{len(out) if out is not None else -1} of 100 out",
                  out is not None and [o[0] for o in out] == list(range(100)))

print("3. never a frame twice or one made up")
for label, fragment, keep_all in (("transcoder 50 fps", tc[50][0], True), ("encoder raw 50 fps", raw[50][0], True),
                                  ("encoder MJPG pre-drop 25 fps", mjpeg[0], False)):
    house = 3600 * S
    inp = grid(50, house) + [t + S for t in grid(50, house + 50 * D)]
    out = run(fragment, inp)
    ok = out is not None and all(inp[i] == t and not g for i, t, g in out)
    ids = [o[0] for o in out] if out else []
    check(f"{label} through a 1 s forward jump: {len(ids)} of 100 out, each an input frame on its own PTS, "
          f"unflagged, in order, once", ok and ids == sorted(set(ids)) and (ids == list(range(100)) or not keep_all))

finish()
