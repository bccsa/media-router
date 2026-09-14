#!/usr/bin/env python3
"""Tests for subtitle_klv.py. Run: python3 subtitle_klv_test.py

The VECTOR_HEX / CLEAR_HEX bytes are the same ones pinned in
engine/subtitleCue.test.ts — the two encoders must agree byte for byte.
"""
import subtitle_klv as k


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    assert cond, name


VECTOR = (3_723_004, 3_725_500, "Hello\nWorld")
VECTOR_HEX = ("060e2b34020501010e0e4d5253554231" + "2a"
              + "01:02:03.004 --> 01:02:05.500\nHello\nWorld\n".encode().hex())
CLEAR_HEX = ("060e2b34020501010e0e4d5253554231" + "1e"
             + "01:02:05.500 --> 01:02:05.500\n".encode().hex())

check("format time", k.format_vtt_time(3_723_004) == "01:02:03.004")
check("format time 4-digit hours", k.format_vtt_time(46 * 24 * 3_600_000 + 1) == "1104:00:00.001")
check("format negative clamps", k.format_vtt_time(-5) == "00:00:00.000")
for ms in (0, 999, 60_000, 3_723_004, 1104 * 3_600_000 + 1):
    check(f"time round-trip {ms}", k.parse_vtt_time(k.format_vtt_time(ms)) == ms)
check("parse rejects 1-digit hour", k.parse_vtt_time("1:02:03.004") is None)
check("parse rejects minute 62", k.parse_vtt_time("01:62:03.004") is None)
check("parse rejects comma", k.parse_vtt_time("01:02:03,004") is None)

check("cue block normalises", k.format_cue_block(1000, 2500, "a\r\nb\n\n") == "00:00:01.000 --> 00:00:02.500\na\nb\n")
check("cue block clear", k.format_cue_block(1000, 1000, "") == "00:00:01.000 --> 00:00:01.000\n")
check("cue block clamps end", k.format_cue_block(2000, 1000, "x") == "00:00:02.000 --> 00:00:02.000\nx\n")
check("parse cue block", k.parse_cue_block("00:00:01.000 --> 00:00:02.500\na\nb\n") == (1000, 2500, "a\nb"))
check("parse rejects end<start", k.parse_cue_block("00:00:02.000 --> 00:00:01.000\nx\n") is None)

check("encode vector", k.encode_cue(*VECTOR).hex() == VECTOR_HEX)
check("encode clear", k.encode_cue(3_725_500, 3_725_500, "").hex() == CLEAR_HEX)
check("decode vector", k.decode_cue(bytes.fromhex(VECTOR_HEX)) == VECTOR)
long = (5, 9000, "x" * 300)
enc = k.encode_cue(*long)
check("long-form BER", enc[16:19] == bytes([0x82, 0x01, 0x4B]))
check("decode long", k.decode_cue(enc) == long)
check("decode empty", k.decode_cue(b"") is None)
check("decode key only", k.decode_cue(k.KEY) is None)
check("decode truncated", k.decode_cue(k.encode_cue(*VECTOR)[:30]) is None)
check("json carousel ignored", k.decode_cue(b'{"v":1,"streams":[]}') is None)
check("bad utf8", k.decode_cue(k.KEY + bytes([2, 0xFF, 0xFE])) is None)
try:
    k.encode_cue(0, 1, "y" * 5000)
    check("oversize raises", False)
except ValueError:
    check("oversize raises", True)
check("pid scheme", k.stream_pid(0) == 0x180 and k.stream_pid(7) == 0x187)
print("all subtitle_klv tests passed")
