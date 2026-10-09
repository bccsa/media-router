#!/usr/bin/env python3
"""Parity vectors for the native floor model (mpegts-core/native/mrpeshouse):
the engine test's synthetic program (`subtitle_ts_engine_test`) stamped by the
REAL `ts_timeline.TimelineStamper`, walked by `PesStamper`, every
`StampModel.observe` call and its outcome written as text. The C++ test
replays the inputs and must reproduce K and each private PES's house time
bit for bit (floats as python `repr`).

  R <label>                         a new run: fresh model
  C <stamp_ns|-> <ref|-> <sure 0/1> <K|->   one chunk, K after observe
  H <pts> <house|->                 a private PES that started in that chunk

Run: python3 subtitle_stamp_dump.py > ../../mpegts-core/native/mrpeshouse/tests/stamp_model_vectors.txt
"""
import random
import sys

import subtitle_stamp_model as sm
import subtitle_ts as ts
import subtitle_ts_engine_test as eng

ts_timeline = eng.ts_timeline
# (label, timing PID known, video offset, audio offset, attach chunk)
RUNS = (("occ unknown", False, 1100, 60, None), ("occ known", True, 1100, 60, None),
        ("audio-leading unknown", False, 100, 600, None), ("vmix known", True, 100, 1800, None),
        ("occ unknown attached", False, 1100, 60, 120))


class Recording(sm.StampModel):
    def observe(self, chunk_ms, ref_pts, sure=True):
        self.seen = (chunk_ms, ref_pts, sure)
        super().observe(chunk_ms, ref_pts, sure)


def fmt(v):
    return "-" if v is None else repr(v)


def dump(out):
    for label, known, v_off, a_off, attach in RUNS:
        stream, _ttx = eng.program(v_off, a_off)
        stamper = ts_timeline.TimelineStamper()
        if known:
            stamper._timing_pid = eng.VID
        bridge = ts.PesStamper(pids={eng.TTX})
        bridge.model = Recording()
        out.write(f"R {label}\n")
        for n, part in enumerate(eng.chunks(stream, random.Random(7))):
            data = b"".join(p for _t, _ev, p in part)
            stamp = stamper.stamp(data, 5_000_000_000_000 + part[-1][0] * 1_000_000)
            if attach is not None and n < attach:
                continue
            bridge.feed(data, stamp / 1e6)
            _ms, ref, sure = bridge.model.seen
            out.write(f"C {stamp} {fmt(ref)} {int(bool(sure))} {fmt(bridge.model.k)}\n")
            for pkt in ts.iter_packets(data):
                hdr = ts.parse_pes_header(pkt[ts.payload_offset(pkt):]) if pkt[1] & 0x40 else None
                if hdr and hdr[0] == ts.STREAM_ID_PRIVATE_1 and ts.packet_pid(pkt) == eng.TTX:
                    out.write(f"H {hdr[1]} {fmt(bridge.model.house(hdr[1]))}\n")


if __name__ == "__main__":
    dump(sys.stdout)
