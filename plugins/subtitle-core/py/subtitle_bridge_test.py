#!/usr/bin/env python3
"""Tests for the pure logic of `subtitle_bridge.py` (no GStreamer needed).

Pins:
  1. Cue text cleaning — teletextdec's trailing NUL, CRs and blank lines go;
     an all-blank page is a clear.
  2. Cue construction — live cue = [now, now+hold), clear = zero-length at now.
  3. Frame time — a stamp-aligned PTS is trusted, a far-off one (source
     timeline) falls back to house-now.
  4. The show/clear decision against the frame's house time: nothing before
     start, show on the first frame in range (once), clear on the first frame
     past end or on a clear cue, and never a redundant set.

Run: python3 subtitle_bridge_test.py
"""
import subtitle_bridge as b


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    assert cond, name


check("clean strips NUL/CR/trailing", b.clean_text(b"Hello\r\nWorld  \n\n\x00") == "Hello\nWorld")
check("clean blank page is clear", b.clean_text(b"\n\x00") == "")
check("clean keeps inner blank line", b.clean_text(b"a\n\nb\n") == "a\n\nb")
check("clean tolerates bad utf8", b.clean_text(b"ok\xff\n") == "ok�")

check("live cue", b.make_cue(1000.4, "x", 8000) == (1000, 9000, "x"))
check("clear cue", b.make_cue(1000, "", 8000) == (1000, 1000, ""))
check("negative hold clamps", b.make_cue(1000, "x", -5) == (1000, 1000, "x"))

# Wire times are relative to the carrying PES (sent at `now`).
check("relative: running cue shows from +0 with its remaining span",
      b.relative_cue((1000, 4800, "Hi"), 2000) == (0, 2800, "Hi"))
check("relative: future cue keeps its lead", b.relative_cue((3000, 4000, "Hi"), 2000) == (1000, 2000, "Hi"))
check("relative: past end never goes negative", b.relative_cue((1000, 1500, "Hi"), 2000) == (0, 0, "Hi"))
check("relative: clear cue stays (0, 0, '')", b.relative_cue((2000, 2000, ""), 2000) == (0, 0, ""))
check("absolute: anchors on the receiver's own time", b.absolute_cue((0, 2800, "Hi"), 90_000) == (90_000, 92_800, "Hi"))
check("round trip on another clock lands the same span",
      b.absolute_cue(b.relative_cue((1000, 4800, "Hi"), 2000), 500_000) == (500_000, 502_800, "Hi"))
check("frame time trusts aligned pts", b.frame_time(5000, 5300) == 5000)
check("frame time falls back to now", b.frame_time(5000, 90_000) == 90_000)
check("frame time no pts", b.frame_time(None, 42) == 42)

cue = (1000, 4000, "Hi")
check("before start: nothing", b.decide(cue, None, 999) is None)
check("at start: show", b.decide(cue, None, 1000) == ("show", "Hi"))
check("in range, already shown: nothing", b.decide(cue, "Hi", 2500) is None)
check("in range, other text shown: show new", b.decide(cue, "old", 2500) == ("show", "Hi"))
check("at end: clear", b.decide(cue, "Hi", 4000) == ("clear", None))
check("past end, blank: nothing", b.decide(cue, None, 5000) is None)
check("clear cue clears", b.decide((3000, 3000, ""), "Hi", 3000) == ("clear", None))
check("clear cue before start waits", b.decide((3000, 3000, ""), "Hi", 2999) is None)
check("no cue, blank: nothing", b.decide(None, None, 10) is None)
check("no cue, shown: clear", b.decide(None, "Hi", 10) == ("clear", None))
check("no time: clear if shown", b.decide(cue, "Hi", None) == ("clear", None))
print("all subtitle_bridge tests passed")
