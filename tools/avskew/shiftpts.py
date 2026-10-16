#!/usr/bin/env python3
"""shiftpts.py IN.ts OUT.ts PID[,PID...] MS - copy a TS with the PES PTS/DTS
of the given PIDs moved by MS milliseconds (avskew sign-convention test)."""
import sys

src, dst, pids, ms = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
pids = {int(p, 0) for p in pids.split(",")}
add = round(ms * 90)
WRAP = 1 << 33


def patch(buf, o):
    b0, b1, b2, b3, b4 = buf[o:o + 5]
    v = (((b0 >> 1) & 7) << 30) | (b1 << 22) | (((b2 >> 1) & 0x7F) << 15) | (b3 << 7) | (b4 >> 1)
    v = (v + add) % WRAP
    buf[o] = (b0 & 0xF0) | (((v >> 30) & 7) << 1) | 1
    buf[o + 1] = (v >> 22) & 0xFF
    buf[o + 2] = (((v >> 15) & 0x7F) << 1) | 1
    buf[o + 3] = (v >> 7) & 0xFF
    buf[o + 4] = ((v & 0x7F) << 1) | 1


buf = bytearray(open(src, "rb").read())
p0 = 0
while not (buf[p0] == 0x47 and buf[p0 + 188] == 0x47):
    p0 += 1
n = 0
for p in range(p0, len(buf) - 187, 188):
    if buf[p] != 0x47 or not buf[p + 1] & 0x40:
        continue
    pid = ((buf[p + 1] & 0x1F) << 8) | buf[p + 2]
    if pid not in pids:
        continue
    afc = (buf[p + 3] >> 4) & 3
    body = p + 4 + (1 + buf[p + 4] if afc & 2 else 0)
    if afc & 1 and buf[body:body + 3] == b"\x00\x00\x01" and body + 19 <= p + 188:
        flags = buf[body + 7]
        if flags & 0x80:
            patch(buf, body + 9)
            n += 1
        if flags & 0x40:
            patch(buf, body + 14)
open(dst, "wb").write(buf)
print(f"shifted {n} PES on {sorted(hex(x) for x in pids)} by {ms:+.1f} ms ({add} ticks)")
