#!/usr/bin/env python3
"""tsinfo.py <file.ts> [max_bytes] - PIDs, PMT stream types, PTS/PCR spans.

Quick structural probe for avskew: what PIDs a TS carries, their stream
types, packet counts and first/last PTS (s) and PCR (s). Pure stdlib.
"""
import sys

path = sys.argv[1]
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 0
data = open(path, "rb").read(limit or -1)


def dec_ts(b):
    return (((b[0] >> 1) & 7) << 30) | (b[1] << 22) | (((b[2] >> 1) & 0x7F) << 15) | \
        (b[3] << 7) | (b[4] >> 1)


pmt_pids, streams, pcr_pid = set(), {}, None
count, first_pts, last_pts, npes = {}, {}, {}, {}
first_pcr = last_pcr = None
start = data.find(b"\x47")
p = start
while p + 188 <= len(data):
    if data[p] != 0x47:
        p += 1
        continue
    pid = ((data[p + 1] & 0x1F) << 8) | data[p + 2]
    pusi = data[p + 1] & 0x40
    afc = (data[p + 3] >> 4) & 3
    count[pid] = count.get(pid, 0) + 1
    body = p + 4
    if afc & 2:
        al = data[body]
        if al >= 7 and data[body + 1] & 0x10:
            b = data[body + 2:body + 7]
            pcr = (b[0] << 25) | (b[1] << 17) | (b[2] << 9) | (b[3] << 1) | (b[4] >> 7)
            if first_pcr is None:
                first_pcr = (pid, pcr)
            last_pcr = (pid, pcr)
        body += 1 + al
    if afc & 1 and body < p + 188 and pusi:
        if pid == 0:
            sec = body + 1 + data[body]
            n = ((data[sec + 1] & 0x0F) << 8) | data[sec + 2]
            q = sec + 8
            while q < sec + 3 + n - 4:
                prog = (data[q] << 8) | data[q + 1]
                if prog:
                    pmt_pids.add(((data[q + 2] & 0x1F) << 8) | data[q + 3])
                q += 4
        elif pid in pmt_pids:
            sec = body + 1 + data[body]
            n = ((data[sec + 1] & 0x0F) << 8) | data[sec + 2]
            pcr_pid = ((data[sec + 8] & 0x1F) << 8) | data[sec + 9]
            pil = ((data[sec + 10] & 0x0F) << 8) | data[sec + 11]
            q = sec + 12 + pil
            while q < sec + 3 + n - 4:
                st, epid = data[q], ((data[q + 1] & 0x1F) << 8) | data[q + 2]
                esl = ((data[q + 3] & 0x0F) << 8) | data[q + 4]
                streams[epid] = st
                q += 5 + esl
        elif data[body:body + 3] == b"\x00\x00\x01" and data[body + 7] & 0x80:
            pts = dec_ts(data[body + 9:body + 14])
            first_pts.setdefault(pid, pts)
            last_pts[pid] = pts
            npes[pid] = npes.get(pid, 0) + 1
    p += 188

print(f"file {path}: {len(data)} bytes, sync at {start}, PCR PID {pcr_pid}")
if first_pcr:
    print(f"PCR first {first_pcr[1] / 90000:.3f}s last {last_pcr[1] / 90000:.3f}s "
          f"span {(last_pcr[1] - first_pcr[1]) / 90000:.3f}s")
for pid in sorted(count):
    st = streams.get(pid)
    line = f"pid 0x{pid:04x} pkts {count[pid]:8d} type {('0x%02x' % st) if st is not None else '-':>4}"
    if pid in first_pts:
        line += (f" pes {npes[pid]:6d} pts {first_pts[pid] / 90000:.3f}..{last_pts[pid] / 90000:.3f}"
                 f" ({(last_pts[pid] - first_pts[pid]) / 90000:.3f}s)")
    print(line)
