#!/usr/bin/env python3
"""The frame-rate conform of the Video Transcoder's and the Video Encoder's strings at house time (B-186, B-188).

Each builder's `videorate … ! <caps>` is taken from the strings its vitest writes
(`plugins/transcoder/tests/videorate-plan.json`, `plugins/video-encoder/tests/videorate-strings.json`;
`vitest -u` rewrites them) and fed frames from an appsrc, on a segment from 0 with PTS at house
time (from 1 h, and from 10^6 s, a box's uptime), as tsdemux gives the transcoder's decoder:

  1. transcoder: a 25 fps rendition passes 50 of 100 (±1), 40 ms apart; a 50 fps one 100 of 100.
  2. encoder: the raw tail at 25 passes 50 of 100 (±1), at 50 all 100; the MJPG pre-drop at 25 50 of 100.
  3. never a frame twice or one made up: through a 1 s forward jump, every frame out is an input frame,
     once, unflagged, and the 50 fps strings pass all of them.
  4. a source slower than the set rate runs at its own rate: 25p into the 50 and 30 fps strings.
  5. 29.97p into the 30 fps strings runs at 29.97.
  6. equal rates: a source on time or slow loses no frame; one whose clock runs fast loses one near the
     start, then one in every 1/ppm (B-186's limit), as with the fixed rate before B-188.
  7. the encoders behind the transcoder's caps (x264enc, x265enc) get a fixed rate, the lower one.
  8. a source without a rate (framerate 0/1) ends as it did with the fixed rate; on videorate 1.28 (the
     image's) at the set rate, where a range alone would fixate 1 fps.

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
RATE = re.compile(r"videorate [^!]*! (?:video/x-raw|image/jpeg),framerate=[^ ]+")
VR_VERSION = Gst.ElementFactory.find("videorate").get_plugin().get_version()
VR_128 = tuple(int(x) for x in VR_VERSION.split(".")[:2]) >= (1, 28)


def fragments(pipeline):
    return RATE.findall(pipeline)


def fixed(fragment):
    """The fragment with the set rate alone, as the builders wrote it before B-188."""
    head, _, caps = fragment.rpartition("! ")
    n = re.match(r"[^,]+,framerate=\[?(?:1/1,)?(\d+)/1", caps).group(1)
    return f"{head}! {caps.split(',')[0]},framerate={n}/1"


def run(fragment, pts, rate="50/1", tail="identity name=tap ! fakesink sync=false", fmt="GRAY8", size=(64, 48),
        count_at="tap", caps_at="tap"):
    """One frame per PTS (its index in the payload) through `fragment`, on a segment from 0. Returns
    ([(index, pts, flagged)] leaving `count_at`, the rate `caps_at` takes in), or (None, None) when the pipeline errs."""
    w, h = size
    media = "image/jpeg,parsed=(boolean)true" if "image/jpeg" in fragment else f"video/x-raw,format={fmt}"
    pipe = Gst.parse_launch(f'appsrc name=src format=time caps="{media},width={w},height={h},framerate={rate}" '
                            f"! {fragment} ! {tail}")
    out = []
    num, den = (int(x) for x in rate.split("/"))
    step = S * den // num if num else D
    nbytes = w * h * 3 // 2 if fmt == "I420" else w * h

    def on_buf(_pad, info):
        buf = info.get_buffer()
        flagged = buf.has_flags(Gst.BufferFlags.GAP)
        out.append((struct.unpack("<I", buf.extract_dup(0, 4))[0], buf.pts, flagged))
        return Gst.PadProbeReturn.OK

    pipe.get_by_name(count_at).get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, on_buf)
    pipe.set_state(Gst.State.PLAYING)
    src = pipe.get_by_name("src")
    for i, t in enumerate(pts):
        buf = Gst.Buffer.new_wrapped(struct.pack("<I", i) + bytes(nbytes - 4))
        buf.pts, buf.duration = t, step
        src.emit("push-buffer", buf)
    src.emit("end-of-stream")
    msg = pipe.get_bus().timed_pop_filtered(30 * S, Gst.MessageType.EOS | Gst.MessageType.ERROR)
    caps = pipe.get_by_name(caps_at).get_static_pad("sink").get_current_caps()
    got = None
    if caps is not None:
        ok, n, d = caps.get_structure(0).get_fraction("framerate")
        got = f"{n}/{d}" if ok else None
    pipe.set_state(Gst.State.NULL)
    if msg is None or msg.type != Gst.MessageType.EOS:
        return None, None
    return out, got


def grid(n, start, step=D):
    return [start + int(i * step) for i in range(n)]


for path in (_PLAN, _ENC):
    if not os.path.exists(path):
        print(f"FAIL {os.path.relpath(path, _HERE)} missing (run vitest for its plugin)")
        failures += 1
        finish()
with open(_PLAN, encoding="utf-8") as fh:
    plan = json.load(fh)
with open(_ENC, encoding="utf-8") as fh:
    enc = json.load(fh)

tc = {fps: fragments(plan[f"rendition{fps}"]["pipeline"]) for fps in (25, 30, 50)}
raw = {fps: fragments(enc[f"raw{fps}"]) for fps in (25, 30, 50)}
mjpeg = fragments(enc["mjpeg25"])
print(f"videorate {VR_VERSION}")
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
        out, _ = run(at25, inp)
        n = len(out) if out is not None else -1
        steps = {b[1] - a[1] for a, b in zip(out, out[1:])} if out else set()
        ms = sorted(s // 10**6 for s in steps)
        check(f"{label} at 25 fps, 50 fps in from {where}: {n} of 100 out, steps {ms} ms",
              out is not None and abs(n - 50) <= 1 and steps == {2 * D})
        if at50:
            out, _ = run(at50, inp)
            check(f"{label} at 50 fps, 50 fps in from {where}: "
                  f"{len(out) if out is not None else -1} of 100 out",
                  out is not None and [o[0] for o in out] == list(range(100)))

print("3. never a frame twice or one made up")
for label, fragment, keep_all in (("transcoder 50 fps", tc[50][0], True), ("encoder raw 50 fps", raw[50][0], True),
                                  ("encoder MJPG pre-drop 25 fps", mjpeg[0], False)):
    house = 3600 * S
    inp = grid(50, house) + [t + S for t in grid(50, house + 50 * D)]
    out, _ = run(fragment, inp)
    ok = out is not None and all(inp[i] == t and not g for i, t, g in out)
    ids = [o[0] for o in out] if out else []
    check(f"{label} through a 1 s forward jump: {len(ids)} of 100 out, each an input frame on its own PTS, "
          f"unflagged, in order, once", ok and ids == sorted(set(ids)) and (ids == list(range(100)) or not keep_all))

H = 3600 * S
print("4. a source slower than the set rate runs at its own rate (B-188)")
for label, fragment in (("transcoder 50 fps", tc[50][0]), ("transcoder 30 fps", tc[30][0]),
                        ("encoder raw 50 fps", raw[50][0])):
    out, got = run(fragment, grid(50, H, S // 25), rate="25/1")
    steps = {b[1] - a[1] for a, b in zip(out, out[1:])} if out else set()
    check(f"{label}, 25p in: {got} out, {len(out) if out is not None else -1} of 50 frames, "
          f"steps {sorted(s // 10**6 for s in steps)} ms",
          got == "25/1" and out is not None and [o[0] for o in out] == list(range(50)) and steps == {S // 25})

print("5. 29.97p into the 30 fps strings runs at 29.97 (B-188)")
F2997 = S * 1001 / 30000
for label, fragment in (("transcoder 30 fps", tc[30][0]), ("encoder raw 30 fps", raw[30][0])):
    inp = grid(60, H, F2997)
    out, got = run(fragment, inp, rate="30000/1001")
    check(f"{label}, 29.97p in: {got} out, {len(out) if out is not None else -1} of 60 frames, each on its own PTS",
          got == "30000/1001" and out is not None and [o[1] for o in out] == inp)

print("6. equal rates: an on-time or slow source loses nothing; a fast clock one frame, then one per 1/ppm")
for label, fragment in (("transcoder 50 fps", tc[50][0]), ("encoder raw 50 fps", raw[50][0])):
    for name, step, lost in (("on time", D, 0), ("40 ppm slow", D / (1 - 40e-6), 0),
                             ("40 ppm fast", D / (1 + 40e-6), 1), ("200 ppm fast", D / (1 + 200e-6), 3)):
        inp = grid(15000, H, step)
        out, _ = run(fragment, inp)
        before, _ = run(fixed(fragment), inp)
        n = 15000 - len(out) if out is not None else -1
        m = 15000 - len(before) if before is not None else -1
        check(f"{label}, 50p {name}: {n} of 15000 lost (want {lost}; the fixed rate: {m})", n == lost and m == lost)

print("7. the encoders get a fixed rate, the lower of the source's and the set one")
for element, tail in (("x264enc", "x264enc name=enc tune=zerolatency speed-preset=ultrafast bitrate=300 "
                                  "key-int-max=25 bframes=0 ! h264parse name=parse"),
                      ("x265enc", "x265enc name=enc tune=zerolatency speed-preset=ultrafast bitrate=300 "
                                  "key-int-max=25 ! h265parse name=parse")):
    if Gst.ElementFactory.find(element) is None:
        print(f"SKIP 7. {element} unavailable")
        continue
    for label, fragment, rate, n, step, want, frames in (
            ("25p into the 50 fps rendition", tc[50][0], "25/1", 50, S // 25, "25/1", 50),
            ("50p into the 25 fps rendition", tc[25][0], "50/1", 100, D, "25/1", 50),
            ("29.97p into the 30 fps rendition", tc[30][0], "30000/1001", 60, F2997, "30000/1001", 60)):
        out, got = run(fragment, grid(n, H, step), rate=rate, fmt="I420", size=(320, 192),
                       tail=f"videoconvert ! {tail} ! fakesink sync=false", count_at="parse", caps_at="enc")
        check(f"{element}, {label}: the encoder takes {got}, {len(out) if out is not None else -1} frames encoded "
              f"(want {want}, {frames})", got == want and out is not None and len(out) == frames)

print("8. a source without a rate (framerate 0/1)")
for label, fragment, want in (("transcoder 25 fps", tc[25][0], "25/1"), ("encoder raw 25 fps", raw[25][0], "25/1")):
    out, got = run(fragment, grid(100, H), rate="0/1")
    before, got_before = run(fixed(fragment), grid(100, H), rate="0/1")
    n = len(out) if out is not None else None
    m = len(before) if before is not None else None
    same = (got, n) == (got_before, m)
    if VR_128:
        check(f"{label}: {got}, {n} of 100 out (the fixed rate: {got_before}, {m}; want {want}, 50)",
              same and got == want and n is not None and abs(n - 50) <= 1)
    else:
        check(f"{label}: {got}, {n} of 100 out, as the fixed rate ({got_before}, {m}) on videorate {VR_VERSION}, "
              "which refuses a 0/1 source either way", same)

finish()
