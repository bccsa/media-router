#!/usr/bin/env python3
"""`subtitle_ts` + `subtitle_stamp_model`: TS walk, PES assembly across chunks,
the house time a PES gets from the floored chunk stamps (hand-built cases and
the REAL engine stamper, `subtitle_ts_engine_test`), the join index.
Run: python3 subtitle_ts_test.py
"""
import subtitle_cues as sc
import subtitle_klv as klv
import subtitle_stamp_model as sm
import subtitle_ts as ts
import subtitle_ts_engine_test
from subtitle_overlay import klv_key
from subtitle_testlib import check, packets, pes

KLV_PID, VID_PID, AUD_PID, TTX_PID = 0x180, 0x100, 0x101, 0x120


def house_of(done):
    """The house time `PesStamper.feed` gave one completed PES."""
    return done[2]


def chunk(*parts):
    return b"".join(b"".join(packets(pid, pes(sid, pts, body), pcr=pcr)) for pid, sid, pts, body, pcr in parts)


cue_bytes = klv.encode_cue(0, 3000, "Hello")
one = b"".join(packets(KLV_PID, pes(0xBD, 90_000 * 3600 + 360_000, cue_bytes), pcr=90_000 * 3600))
check("ts walk: 188-byte packets", [len(p) for p in ts.iter_packets(one)] == [188])
st = ts.PesStamper()
got = st.feed(one, 4000.0)
check("PES completed in its chunk, payload = the KLV tsdemux hands out",
      len(got) == 1 and got[0][0] == KLV_PID and got[0][1] == cue_bytes)
check("its own stamp when it is the reference (PCR PID)", house_of(got[0]) == 4000.0 and st.pcr_pid == KLV_PID)

# A private PES riding a video reference: stamp + its PES delta.
vid = b"".join(packets(VID_PID, pes(0xE0, 900_000, b"\x00" * 100), pcr=880_000))
sub = b"".join(packets(KLV_PID, pes(0xBD, 900_000 + 9_000, cue_bytes)))
st = ts.PesStamper()
check("private PES = stamp + (PTS - reference PTS)", [house_of(g) for g in st.feed(vid + sub, 10_000.0)] == [10_100.0])
st = ts.PesStamper()
check("reference found after the private PES in the same chunk",
      [house_of(g) for g in st.feed(sub + vid, 10_000.0)] == [10_100.0])

# A PES straddling two chunks keeps the mapping as of the chunk it STARTED in.
big = klv.encode_cue(0, 3000, "x" * 400)
pk = packets(KLV_PID, pes(0xBD, 1_800_000, big), pcr=1_799_000)
check("test PES spans 3 packets", len(pk) == 3)
st = ts.PesStamper()
check("first chunk: started, not complete", st.feed(pk[0], 20_000.0) == [])
ref2 = b"".join(packets(VID_PID, pes(0xE0, 1_900_000, b"\x00" * 10)))
got = st.feed(pk[1] + ref2 + pk[2], 25_500.0)              # a rise on another mapping
check("straddling PES keeps its start chunk's mapping", len(got) == 1 and got[0][1] == big and house_of(got[0]) == 20_000.0)
check("chunk with no PES start and nothing open: nothing", st.feed(pk[1], 26_000.0) == [])
st = ts.PesStamper()
got = st.feed(b"".join(packets(KLV_PID, pes(0xBD, 1_800_000, cue_bytes))), 5_000.0)
check("no reference ever (no PCR, private only): no mapping", len(got) == 1 and house_of(got[0]) is None)
check("no chunk PTS: no mapping", ts.PesStamper().feed(one, None)[0][2] is None)

# The engine's FLOOR (ts_timeline `stamp`): K is learned only where the stamp rose.
ttx = lambda pts, tag: (TTX_PID, 0xBD, pts, tag, None)       # noqa: E731
st = ts.PesStamper()
st.feed(chunk((VID_PID, 0xE0, 990_000, b"v", 900_000)), 1_000.0)        # K = 1000 - 11000
k0 = 1_000.0 - 990_000 / 90
got = st.feed(chunk((AUD_PID, 0xC0, 901_800, b"a", None), ttx(902_700, b"t1")), 1_000.0)
check("floor repeat (audio ~1 s under the floor, stamp == previous): mapping kept",
      [house_of(g) for g in got] == [k0 + 902_700 / 90] and st.model.k == k0)
got = st.feed(chunk(ttx(904_500, b"t2")), 1_300.0)
check("arrival-stamped private-only chunk: the mapping still places it",
      [house_of(g) for g in got] == [k0 + 904_500 / 90] and st.model.k == k0)
got = st.feed(chunk((VID_PID, 0xE0, 1_026_000, b"v", None), ttx(936_000, b"t3")), 1_400.0 + 2.5)
check("a rise re-reads the mapping (drift slew)", [house_of(g) for g in got] == [k0 + 2.5 + 936_000 / 90])
k1 = st.model.k
got = st.feed(chunk((AUD_PID, 0xC0, 937_800 + 427 * 90_000, b"a", None),
                    ttx(938_700 + 427 * 90_000, b"t4")), 1_400.0 + 2.5)
check("clamped chunk mapping 427 s above its stamp: re-anchored, no mapping", [house_of(g) for g in got] == [None])
got = st.feed(chunk((VID_PID, 0xE0, 1_035_000 + 427 * 90_000, b"v", None),
                    ttx(946_000 + 427 * 90_000, b"t5")), 1_500.0)
check("next rise resyncs on the new anchor",
      len(got) == 1 and abs(house_of(got[0]) - (1_500.0 - (1_035_000 - 946_000) / 90)) < 1e-6)
st.feed(chunk((VID_PID, 0xE0, 1_036_800 + 427 * 90_000, b"v", None)), 1_520.0)
got = st.feed(chunk((AUD_PID, 0xC0, 100_000, b"a", None), ttx(100_900, b"t6")), 1_520.0)
check("clamped chunk mapping far below its stamp (backward jump): no mapping", [house_of(g) for g in got] == [None])
st.feed(chunk((VID_PID, 0xE0, 200_000, b"v", None)), 1_600.0)
got = st.feed(chunk(ttx(110_000, b"t7")), 1_590.0)
check("stamp went backwards (stream restart): no mapping", [house_of(g) for g in got] == [None])
st = ts.PesStamper()
st.feed(chunk((VID_PID, 0xE0, 990_000, b"v", 900_000)), 1_000.0)
got = st.feed(chunk((VID_PID, 0xE0, 991_800, b"v", None), ttx(902_700, b"j1")), 1_020.0 + 7_000)
check("a rise implying K 7 s off (mid-size forward re-anchor): dropped, no mapping",
      [house_of(g) for g in got] == [None] and st.model.k is None)
got = st.feed(chunk((VID_PID, 0xE0, 993_600, b"v", None), ttx(904_500, b"j2")), 1_040.0 + 7_000)
check("the next rise re-learns K",
      len(got) == 1 and abs(house_of(got[0]) - (8_040.0 - (993_600 - 904_500) / 90)) < 1e-6)

st = ts.PesStamper(pids=())
check("pid filter: unannounced PID not assembled", st.feed(one, 1.0) == [])
st.pids.add(KLV_PID)
check("pid filter: announced PID assembled", len(st.feed(one, 1.0)) == 1)
st = ts.PesStamper()
wrap = b"".join(packets(VID_PID, pes(0xE0, (1 << 33) - 900, b"\x00"), pcr=(1 << 33) - 1000)) + \
    b"".join(packets(KLV_PID, pes(0xBD, 8100, cue_bytes)))
check("33-bit wrap folds", [house_of(g) for g in st.feed(wrap, 0.0)] == [100.0])
check("fold", sm.fold_ticks(5) == 5 and sm.fold_ticks(-5) == -5 and sm.fold_ticks((1 << 33) - 5) == -5)

check("klv span ignores trailing bytes", ts.klv_span(cue_bytes + b"\x00\x00") == cue_bytes)
check("klv span of junk is the junk", ts.klv_span(b"abc") == b"abc")
idx = ts.StampIndex(size=2, max_age_ms=5000)
idx.record(b"a", 1.0, 0)
idx.record(b"b", 2.0, 0)
idx.record(b"a", 3.0, 10)
check("index: latest record wins", idx.lookup(b"a", 10) == 3.0)
idx.record(b"c", 4.0, 10)
check("index: LRU evicts the oldest key", idx.lookup(b"b", 10) is None and len(idx) == 2)
check("index: stale entry misses", idx.lookup(b"a", 6000) is None)
idx.record(b"d", None, 10)
check("index: unmapped record misses", idx.lookup(b"d", 10) is None)

# End to end: the consumer's join key over the demuxed KLV finds the mapped
# time of the PES, for the first send and its (floor-stamped) re-send alike.
idx, st = ts.StampIndex(), ts.PesStamper()
for chunk_ms, packet in [(4000.0, one), (4000.0, one)]:
    for _pid, payload, house in st.feed(packet, chunk_ms):
        idx.record(klv_key(payload), house, chunk_ms)
t0, src = sc.cue_t0(idx.lookup(klv_key(cue_bytes), 4100.0), 7000.0, 4100.0)
check("consumer: cue anchors on the chunk stamp, not tsdemux pts", (t0, src) == (4000.0, "chunk"))
check("consumer: shown on the cue's own frames",
      sc.decide(sc.absolute_cue(klv.decode_cue(cue_bytes), t0), None, 4000.0) == ("show", "Hello"))

check("reference: the PCR PID's first PES, sure when it is also the first video/audio",
      sm.chunk_reference([(0x101, 0xC0, 5), (0x100, 0xE0, 9)], 0x100) == sm.Reference(9, False)
      and sm.chunk_reference([(0x100, 0xE0, 9), (0x101, 0xC0, 5)], 0x100) == sm.Reference(9, True)
      and sm.chunk_reference([(0x101, 0xC0, 5)], 0x100) == sm.Reference(5, True)
      and sm.chunk_reference([(0x120, 0xBD, 7)], None) == sm.Reference(None, True))
subtitle_ts_engine_test.run(check)
print("all subtitle_ts tests passed")
