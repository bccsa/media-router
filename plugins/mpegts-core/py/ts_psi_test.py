#!/usr/bin/env python3
"""Logic tests for ts_psi.py (no TSDuck needed). Run: python3 ts_psi_test.py"""
import ts_psi as p


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    assert cond, name


# CRC-32/MPEG-2 canonical check value + self-consistency.
check("crc32/mpeg check value", p.crc32_mpeg(b"123456789") == 0x0376E6E7)
pat = p.build_pat(0x0001, {1: 0x0100, 2: 0x0200})
off = p.payload_offset(pat)
sec = pat[off + 1:]
seclen = 3 + (((sec[1] & 0x0F) << 8) | sec[2])
check("crc self-consistency", p.crc32_mpeg(sec[:seclen]) == 0)

# PAT / PMT build -> parse round-trips (multi-ES program).
check("PAT round-trip", p.parse_pat([pat]) == {1: 0x0100, 2: 0x0200})
pmt = p.build_pmt(0x0100, 1, 0x0100, [(0x0100, p.STREAM_TYPE_AVC),
                                      (0x0141, p.STREAM_TYPE_AAC)])
info = p.parse_pmt([pmt], 0x0100)
check("PMT pcr/streams", info["pcr_pid"] == 0x0100 and
      info["streams"] == [(0x0100, 0x1b), (0x0141, 0x0f)])

# ES descriptors round-trip: Opus is identified ONLY by its descriptor loop
# (stream_type 0x06 + registration 'Opus' + DVB extension), so build_pmt must
# write what parse_pmt captured, byte-identical.
OPUS_DESC = bytes.fromhex("05044f707573") + bytes.fromhex("7f028002")  # reg 'Opus' + DVB ext
pmt_d = p.build_pmt(0x0100, 1, 0x0141,
                    [(0x0141, p.STREAM_TYPE_PRIVATE_PES, OPUS_DESC)])
info_d = p.parse_pmt([pmt_d], 0x0100)
check("descriptor round-trip: stream list",
      info_d["streams"] == [(0x0141, p.STREAM_TYPE_PRIVATE_PES)])
check("descriptor round-trip: es_info verbatim",
      info_d["es_info"] == {0x0141: OPUS_DESC})
check("bare 2-tuple streams still build (es_info empty)",
      p.parse_pmt([p.build_pmt(0x0100, 1, 0x0141, [(0x0141, p.STREAM_TYPE_AAC)])],
                  0x0100)["es_info"] == {0x0141: b""})

# PID header get/set preserves the other header bits.
q = p.ts_set_pid(pat, 0x0abc)
check("ts_set_pid", p.ts_pid(q) == 0x0abc and p.ts_pusi(q) == p.ts_pusi(pat))

# PsiDiscovery: PAT and PMT arriving far apart (real broadcast PSI is sparse).
disc = p.PsiDiscovery(max_psi_pkts=64)
patD = p.build_pat(2, {100: 0x0064})
pmtD = p.build_pmt(0x0064, 100, 0x0065,
                   [(0x0065, p.STREAM_TYPE_AVC), (0x00c9, p.STREAM_TYPE_AAC)])
null = p.null_packet()
disc.feed([patD])
check("discovery learns pmt_pid from PAT alone", disc.pmt_pid == 0x0064)
for _ in range(300):                       # long gap of non-PSI traffic
    disc.feed([null])
check("no PMT yet during the gap", disc.pmt is None)
changed = disc.feed([pmtD])                # PMT finally arrives
check("discovery fires when PMT arrives", changed is True)
check("discovered streams correct",
      disc.pmt["streams"] == [(0x0065, 0x1b), (0x00c9, 0x0f)] and disc.pmt["pcr_pid"] == 0x0065)

# section_signature: the cheap change signal (see the C++ mirror in
# native/mrts/tests/ts_psi_test.cpp).
sigpmt = p.build_pmt(0x0030, 0x0101, 0x0065, [(0x0065, p.STREAM_TYPE_HEVC)], version=3)
s0 = p.section_signature(sigpmt)
check("signature: table_id / program / version / crc",
      s0 is not None and s0[:3] == (p.TABLE_PMT, 0x0101, 3) and s0[3] is not None)


def reshape_psi(src, af_len, ptr):
    """Re-wrap a single-packet PSI packet behind an adaptation field and
    pointer_field filler — both shift where the section starts."""
    off = p.payload_offset(src)
    sec = src[off + 1 + src[off]:]
    seclen = 3 + (((sec[1] & 0x0F) << 8) | sec[2])
    pkt = bytearray(src[:4])
    if af_len >= 0:
        pkt[3] |= 0x20
        pkt += bytes([af_len]) + bytes([0x00]) + b"\xff" * (af_len - 1)
    pkt += bytes([ptr]) + b"\xff" * ptr + sec[:seclen]
    return bytes(pkt[:p.PKT]) + b"\xff" * (p.PKT - len(pkt))


check("signature behind an adaptation field + pointer_field filler",
      p.section_signature(reshape_psi(sigpmt, 10, 7)) == s0)
soff = p.payload_offset(sigpmt) + 1                # pointer_field is 0 here
span = bytearray(sigpmt)
span[soff + 1] = 0xB0 | ((300 >> 8) & 0x0F)        # section longer than the packet
span[soff + 2] = 300 & 0xFF
s2 = p.section_signature(bytes(span))
check("signature: spanning section falls back to version only",
      s2 is not None and s2[2] == 3 and s2[3] is None and s2 != s0)
nxt = bytearray(sigpmt)
nxt[soff + 5] &= 0xFE                              # current_next_indicator = 0
check("signature ignores a next-table section", p.section_signature(bytes(nxt)) is None)
sec1 = bytearray(sigpmt)
sec1[soff + 6] = 1                                 # section_number = 1
check("signature ignores sections past the first",
      p.section_signature(bytes(sec1)) is None)

# Upstream codec change is seen at once, not at the 500-feed backstop: the
# carousel has filled the PMT buffer with superseded sections by then, and
# reassembly returns the OLDEST retained one.
sw = p.PsiDiscovery()
patS = p.build_pat(3, {1: 0x0030})
pmt265 = p.build_pmt(0x0030, 1, 0x0065, [(0x0065, p.STREAM_TYPE_HEVC)], version=0)
pmt264 = p.build_pmt(0x0030, 1, 0x0065, [(0x0065, p.STREAM_TYPE_AVC)], version=1)
sw.feed([patS])
check("switch: h265 first discovered",
      sw.feed([pmt265]) and sw.pmt["streams"] == [(0x0065, p.STREAM_TYPE_HEVC)])
check("switch: identical carousel repeats report no change",
      not any(sw.feed([pmt265]) for _ in range(300)))
check("switch: h265 -> h264 detected on the very next feed", sw.feed([pmt264]) is True)
check("switch: new codec latched", sw.pmt["streams"] == [(0x0065, p.STREAM_TYPE_AVC)])

# Same version_number, different content (a mux that forgets to bump it): the
# section CRC still separates them.
cr = p.PsiDiscovery()
pmt_a = p.build_pmt(0x0030, 1, 0x0065, [(0x0065, p.STREAM_TYPE_HEVC)], version=7)
pmt_b = p.build_pmt(0x0030, 1, 0x0065, [(0x0065, p.STREAM_TYPE_HEVC),
                                        (0x00c9, p.STREAM_TYPE_AAC)], version=7)
cr.feed([patS])
for _ in range(200):
    cr.feed([pmt_a])
check("crc-only: version unchanged but content differs",
      cr.feed([pmt_b]) and len(cr.pmt["streams"]) == 2)

# A new PAT can also move the program to a different PMT PID.
mv = p.PsiDiscovery()
mv.feed([p.build_pat(3, {1: 0x0030})])
for _ in range(50):
    mv.feed([p.build_pat(3, {1: 0x0030}), pmt265])
check("pmt pid move: starts on the old pid",
      mv.pmt_pid == 0x0030 and mv.pmt["streams"] == [(0x0065, p.STREAM_TYPE_HEVC)])
mv.feed([p.build_pat(3, {1: 0x0040}, version=1)])
check("pmt pid move: new PAT re-learns the pid", mv.pmt_pid == 0x0040)
check("pmt pid move: PMT on the new pid is discovered at once",
      mv.feed([p.build_pmt(0x0040, 1, 0x0065, [(0x0065, p.STREAM_TYPE_AVC)])]) and
      mv.pmt["streams"] == [(0x0065, p.STREAM_TYPE_AVC)])

# Realistic combined PMT at max fan-in (24 ES, bare) fits one TS packet and round-trips.
# (The runner only builds small PMTs; big descriptor-laden PMTs are only *parsed*,
# which first_section reassembles across packets — exercised on the live feed.)
maxes = [(0x0100 + i, p.STREAM_TYPE_AVC) for i in range(8)] + \
        [(0x0140 + i, p.STREAM_TYPE_AAC) for i in range(16)]
bigpmt = p.build_pmt(0x1100, 1, 0x0100, maxes)
check("24-ES combined PMT fits one packet", len(bigpmt) == p.PKT)
check("24-ES PMT round-trips", p.parse_pmt([bigpmt], 0x1100)["streams"] == maxes)

# PCR read/build round-trip (audio-only outputs re-inject the source clock).
pcr = 1234567890123
pk = p.build_pcr_packet(0x00cc, pcr, cc=7)
check("PCR packet is adaptation-only (no payload)", (pk[3] & 0x30) == 0x20)
check("PCR packet keeps the PID's cc", (pk[3] & 0x0F) == 7)
check("read_pcr round-trips build_pcr_packet", p.read_pcr(pk) == pcr)
check("read_pcr is None on a payload-only packet", p.read_pcr(p.null_packet()) is None)


# PES PTS extraction (timeline latch relies on this).
def pes_ts_packet(pid, pts=None, dts=None, stream_id=0xE0, pusi=True, af_len=None):
    """Hand-build one TS packet whose payload starts a PES header."""
    hdr = bytearray([p.SYNC,
                     (0x40 if pusi else 0x00) | ((pid >> 8) & 0x1F),
                     pid & 0xFF,
                     0x10])                       # payload only, cc=0
    body = bytearray()
    if af_len is not None:
        hdr[3] |= 0x20                            # adaptation field present
        body += bytes([af_len]) + b"\x00" * af_len
    pes = bytearray(b"\x00\x00\x01") + bytes([stream_id]) + b"\x00\x00"
    flags = (0x80 if pts is not None else 0) | (0x40 if dts is not None else 0)
    fields = bytearray()

    def stamp(prefix, v):
        return bytes([(prefix << 4) | (((v >> 30) & 0x07) << 1) | 1,
                      (v >> 22) & 0xFF, (((v >> 15) & 0x7F) << 1) | 1,
                      (v >> 7) & 0xFF, ((v & 0x7F) << 1) | 1])

    if pts is not None and dts is not None:
        fields += stamp(0x3, pts) + stamp(0x1, dts)
    elif pts is not None:
        fields += stamp(0x2, pts)
    pes += bytes([0x80, flags, len(fields)]) + fields
    body += pes
    pkt = bytes(hdr) + bytes(body)
    return pkt + b"\xff" * (p.PKT - len(pkt))


BIG_PTS = 0x1_2345_6789 & 0x1_FFFF_FFFF          # exercises PTS[32]
check("PES PTS round-trip", p.read_pes_pts(pes_ts_packet(0x65, pts=BIG_PTS)) == BIG_PTS)
check("PES PTS+DTS round-trip",
      p.read_pes_pts(pes_ts_packet(0x65, pts=90000, dts=87000)) == 90000)
check("PES without PTS -> None", p.read_pes_pts(pes_ts_packet(0x65)) is None)
check("non-PUSI packet -> None",
      p.read_pes_pts(pes_ts_packet(0x65, pts=90000, pusi=False)) is None)
check("PSI packet -> None", p.read_pes_pts(pat) is None)
check("adaptation-only packet -> None", p.read_pes_pts(p.build_pcr_packet(0x65, 300)) is None)
check("padding stream -> None",
      p.read_pes_pts(pes_ts_packet(0x65, pts=90000, stream_id=0xBE)) is None)
check("PES behind adaptation field",
      p.read_pes_pts(pes_ts_packet(0x65, pts=4500, af_len=10)) == 4500)

print("\nALL ts_psi TESTS PASSED")
