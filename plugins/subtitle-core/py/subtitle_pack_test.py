#!/usr/bin/env python3
"""`subtitle_pack`: the bridge's own TS for one cue, pinned against bytes gst
1.28 mpegtsmux wrote (the oracle), round-tripped through `subtitle_ts`, and
read back by the engine's house-timeline stamper.
Run: python3 subtitle_pack_test.py
"""
import subtitle_klv as klv
import subtitle_pack as sp
import subtitle_ts as ts
from subtitle_egress_trace import klv_pes_ticks
from subtitle_testlib import check, use_mpegts_core

use_mpegts_core()
import ts_timeline  # noqa: E402 — plugins/mpegts-core/py

# Golden bytes written by gst 1.28 mpegtsmux for PID 0x180 (scratch mux_ref.py).
MUX_PAT = "0000b00d0001c100000001e020a2c32941"
MUX_PMT_180 = "0002b0180001c10000e180f00006e180f00605044b4c5641b78fe6da"
MUX_PMT_181 = "0002b0180001c10000e181f00006e181f00605044b4c56410278827d"
check("pack: PAT section = mpegtsmux's", ("00" + sp.pat_section().hex()) == MUX_PAT)
check("pack: PMT sections = mpegtsmux's (KLVA, PCR on the KLV PID)",
      ("00" + sp.pmt_section(0x180).hex()) == MUX_PMT_180 and ("00" + sp.pmt_section(0x181).hex()) == MUX_PMT_181)
MUX_PES_HELLO = ("47418031741009a8864f7e00" + "ff" * 109 +
                 "000001bd003d858005214d457121" + klv.encode_cue(0, 3000, "Hello").hex())
k = sp.KlvTsPacker(0x180)
c1 = k.cue_chunk(sp.pes_ticks(1000), klv.encode_cue(0, 3000, "Hello"))
pk1 = [c1[i:i + 188] for i in range(0, len(c1), 188)]
mask_cc = lambda h: h[:7] + "0" + h[8:]  # noqa: E731
check("pack: one cue = PAT + PMT + one PES packet + null padding to 7 x 188",
      len(c1) == 7 * 188 and all(p[0] == 0x47 for p in pk1)
      and all(ts.packet_pid(p) == 0x1FFF for p in pk1[3:]))
check("pack: PAT/PMT packets end in mpegtsmux's sections",
      pk1[0].hex().endswith(MUX_PAT) and pk1[1].hex().endswith(MUX_PMT_180))
check("pack: PES packet = mpegtsmux's (PCR = PTS - 125 ms, 0x85 0x80 header)",
      mask_cc(pk1[2].hex()) == mask_cc(MUX_PES_HELLO))
st = ts.PesStamper()
got = st.feed(c1, 1000.0)
check("pack: round-trips through subtitle_ts (payload, PCR PID, PTS)",
      len(got) == 1 and got[0][1] == klv.encode_cue(0, 3000, "Hello") and st.pcr_pid == 0x180
      and klv_pes_ticks(c1) == [sp.pes_ticks(1000)])
c2 = k.cue_chunk(sp.pes_ticks(1000), klv.encode_cue(0, 3000, "Hello"))
pes1, pes2 = c1[376:564], c2[376:564]
check("pack: re-send = same PES PTS + KLV, no PCR (it did not advance), CC advanced",
      ts.has_pcr(pes1) and not ts.has_pcr(pes2)
      and klv_pes_ticks(c2) == klv_pes_ticks(c1)
      and ts.PesStamper().feed(c2, 1.0)[0][1] == klv.encode_cue(0, 3000, "Hello")
      and (pes2[3] & 0x0F) == ((pes1[3] & 0x0F) + 1) % 16 and (c2[3] & 0x0F) == ((c1[3] & 0x0F) + 1) % 16)
big_k = klv.encode_cue(0, 3000, "line " * 80)
c3 = sp.KlvTsPacker(0x181).cue_chunk(sp.pes_ticks(2000), big_k)
got = ts.PesStamper().feed(c3, 2000.0)
check("pack: multi-packet cue round-trips, CC continuous, last packet stuffed",
      len(c3) % 188 == 0 and len(got) == 1 and got[0][1] == big_k
      and [p[3] & 0x0F for p in ts.iter_packets(c3) if ts.packet_pid(p) == 0x181] == [0, 1, 2]
      and ts.parse_pes_header(c3[376 + ts.payload_offset(c3[376:564]):])[3] == len(big_k))
check("pack: wraps the 33-bit PTS", sp.pes_ticks(100_000_000) == (100_000_000 + 3_600_000) * 90 % (1 << 33))
house_stamper, house_now = ts_timeline.TimelineStamper(house_timeline=True), 1_768_000_000_000_000
packer = sp.KlvTsPacker(0x180)
stamps = [house_stamper.stamp(packer.cue_chunk(sp.pes_ticks(ms), klv.encode_cue(0, 3000, "x")), house_now) // 1_000_000
          for ms in (1_767_999_000, 1_767_999_000, 1_768_001_600)]
check("pack: the engine's house-timeline stamper reads back each cue's start (PES - 1 h, wrapped)",
      stamps == [1_767_999_000, 1_767_999_000, 1_768_001_600])
print("all subtitle_pack tests passed")
