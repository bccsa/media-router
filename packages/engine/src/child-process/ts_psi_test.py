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

print("\nALL ts_psi TESTS PASSED")
