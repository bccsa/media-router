#!/usr/bin/env python3
"""`subtitle_pack`: the bridge's own TS for one cue, pinned against bytes gst
1.28 mpegtsmux wrote (the oracle), read back PES by PES by `mrts_cli dump` (pid,
stream_id, PTS, length, payload CRC-32), and by the bus egress's identity stamp.
Run: python3 subtitle_pack_test.py
"""
import json
import os
import subprocess
import tempfile
import zlib

import subtitle_klv as klv
import subtitle_pack as sp
from subtitle_egress_trace import klv_pes_ticks
from subtitle_testlib import IdentityStamp, check, use_mpegts_core

use_mpegts_core()
import ts_psi  # noqa: E402 — plugins/mpegts-core/py: the packet-header reference

MRTS = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                     "..", "..", "mpegts-core", "native", "mrts"))


def mrts_cli():
    """`mrts_cli` as `make` builds it (a no-op when current); None when it cannot be built."""
    made = subprocess.run(["make", "-s", "-C", MRTS, "mrts_cli"], capture_output=True, text=True)
    path = os.path.join(MRTS, "mrts_cli")
    return path if made.returncode == 0 and os.path.exists(path) else None


def dump(data):
    """`mrts_cli dump` of a chunk: (its PES rows, its PMT rows, its counters)."""
    with tempfile.NamedTemporaryFile(suffix=".ts") as f:
        f.write(data)
        f.flush()
        out = subprocess.run([CLI, "dump", f.name], check=True, capture_output=True, text=True).stdout
    rows = [json.loads(line) for line in out.splitlines()]
    return ([r for r in rows if "pid" in r], [r for r in rows if r.get("psi") == "pmt"],
            next(r["counters"] for r in rows if "counters" in r))


def pes_of(rows):
    return [(r["pid"], r["sid"], r["pts"], r["len"], r["crc32"]) for r in rows]


def unit(pid, pts, payload):
    """The dump row of one whole PES: stream_id 0xBD, the payload's length and zlib CRC-32."""
    return (pid, 0xBD, pts, len(payload), "%08x" % zlib.crc32(payload))


CLI = mrts_cli()
check("mrts_cli builds (make -C mpegts-core/native/mrts mrts_cli)", CLI is not None)
clean = lambda c: not any(c.values())  # noqa: E731 — every dump counter 0 (desync, CC, PES drops)

# Golden bytes written by gst 1.28 mpegtsmux for PID 0x180 (scratch mux_ref.py).
MUX_PAT = "0000b00d0001c100000001e020a2c32941"
MUX_PMT_180 = "0002b0180001c10000e180f00006e180f00605044b4c5641b78fe6da"
MUX_PMT_181 = "0002b0180001c10000e181f00006e181f00605044b4c56410278827d"
check("pack: PAT section = mpegtsmux's", ("00" + sp.pat_section().hex()) == MUX_PAT)
check("pack: PMT sections = mpegtsmux's (KLVA, PCR on the KLV PID)",
      ("00" + sp.pmt_section(0x180).hex()) == MUX_PMT_180 and ("00" + sp.pmt_section(0x181).hex()) == MUX_PMT_181)
MUX_PES_HELLO = ("47418031741009a8864f7e00" + "ff" * 109 +
                 "000001bd003d858005214d457121" + klv.encode_cue(0, 3000, "Hello").hex())
hello = klv.encode_cue(0, 3000, "Hello")
k = sp.KlvTsPacker(0x180)
c1 = k.cue_chunk(sp.pes_ticks(1000), hello)
pk1 = [c1[i:i + 188] for i in range(0, len(c1), 188)]
mask_cc = lambda h: h[:7] + "0" + h[8:]  # noqa: E731
check("pack: one cue = PAT + PMT + one PES packet + null padding to 7 x 188",
      len(c1) == 7 * 188 and all(p[0] == 0x47 for p in pk1)
      and all(ts_psi.ts_pid(p) == 0x1FFF for p in pk1[3:]))
check("pack: PAT/PMT packets end in mpegtsmux's sections",
      pk1[0].hex().endswith(MUX_PAT) and pk1[1].hex().endswith(MUX_PMT_180))
check("pack: PES packet = mpegtsmux's (PCR = PTS - 125 ms, 0x85 0x80 header)",
      mask_cc(pk1[2].hex()) == mask_cc(MUX_PES_HELLO))
pes1, pmt1, cnt1 = dump(c1)
check("pack: mrts_cli dump reads the cue back (PID 0x180, sid 0xBD, its PTS, the KLV's length and "
      "CRC-32), the PCR on the KLV PID",
      pes_of(pes1) == [unit(0x180, sp.pes_ticks(1000), hello)] and [m["pcrPid"] for m in pmt1] == [0x180]
      and [ts_psi.ts_pid(p) for p in pk1 if ts_psi.read_pcr(p) is not None] == [0x180] and clean(cnt1)
      and klv_pes_ticks(c1) == [sp.pes_ticks(1000)])
c2 = k.cue_chunk(sp.pes_ticks(1000), hello)
pes2, _pmt2, cnt2 = dump(c2)
p1, p2 = c1[376:564], c2[376:564]
check("pack: re-send = same PES PTS + KLV, no PCR (it did not advance), CC advanced",
      ts_psi.read_pcr(p1) is not None and ts_psi.read_pcr(p2) is None
      and klv_pes_ticks(c2) == klv_pes_ticks(c1) and pes_of(pes2) == pes_of(pes1) and clean(cnt2)
      and (p2[3] & 0x0F) == ((p1[3] & 0x0F) + 1) % 16 and (c2[3] & 0x0F) == ((c1[3] & 0x0F) + 1) % 16)
big_k = klv.encode_cue(0, 3000, "line " * 80)
c3 = sp.KlvTsPacker(0x181).cue_chunk(sp.pes_ticks(2000), big_k)
pes3, pmt3, cnt3 = dump(c3)
check("pack: multi-packet cue round-trips, CC continuous, last packet stuffed",
      len(c3) % 188 == 0 and pes_of(pes3) == [unit(0x181, sp.pes_ticks(2000), big_k)]
      and [m["pcrPid"] for m in pmt3] == [0x181] and clean(cnt3)
      and [p[3] & 0x0F for p in ts_psi.iter_packets(c3) if ts_psi.ts_pid(p) == 0x181] == [0, 1, 2])
check("pack: wraps the 33-bit PTS", sp.pes_ticks(100_000_000) == (100_000_000 + 3_600_000) * 90 % (1 << 33))
house_stamper, house_now = IdentityStamp(), 1_768_000_000_000_000
packer = sp.KlvTsPacker(0x180)
stamps = [house_stamper.stamp(packer.cue_chunk(sp.pes_ticks(ms), klv.encode_cue(0, 3000, "x")), house_now) // 1_000_000
          for ms in (1_767_999_000, 1_767_999_000, 1_768_001_600)]
check("pack: the egress's identity stamp reads back each cue's start (PES - 1 h, wrapped)",
      stamps == [1_767_999_000, 1_767_999_000, 1_768_001_600])
print("all subtitle_pack tests passed")
