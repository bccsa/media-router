#!/usr/bin/env python3
"""Deterministic synthetic MPTS generator for the native-core parity test.

Emits a stream that exercises every splitter code path the C++ port must
reproduce byte-for-byte: sparse PSI, PCR with jitter on the video PID,
descriptor-identified audio (Opus on stream_type 0x06), KLV, CC gaps,
mid-stream desync garbage, real H.264 SPS PES payloads (video-info probe),
and a mid-stream codec change (AVC -> HEVC) far enough from the tail that
the 500-feed PMT re-parse cadence observes it.

Pure stdlib + ts_psi; NO randomness (an LCG provides deterministic jitter).

Run:  python3 native_parity_fixture.py <output-file>
"""
import sys

import ts_psi

VIDEO_PID = 0x65
AUDIO_PID = 0xC9
OPUS_PID = 0xCA
KLV_PID = 0x1F0
PMT_PID = 0x30

OPUS_DESC = bytes.fromhex("05044f707573" "7f028002")   # registration 'Opus' + DVB ext

# Real 1080i50 H.264 SPS (ffprobe-verified capture, same fixture as the tests).
H264_SPS = bytes.fromhex(
    "67640028ad843fff9087fff210ffffffffffffffff087fffffffffffffff"
    "2cc501e0113f780a10101014000003000400000300ca50")


class Lcg:
    """Tiny deterministic PRNG — identical sequence on every run/platform."""

    def __init__(self, seed=0x5EED):
        self.s = seed

    def next(self, mod):
        self.s = (self.s * 1103515245 + 12345) & 0x7FFFFFFF
        return self.s % mod


def es_packet(pid, cc, pusi=False, fill=0xAA):
    pkt = bytearray([ts_psi.SYNC,
                     (0x40 if pusi else 0x00) | ((pid >> 8) & 0x1F),
                     pid & 0xFF, 0x10 | (cc & 0x0F)])
    pkt += bytes([fill]) * (ts_psi.PKT - 4)
    return bytes(pkt)


def video_pes_packets(pid, cc0, sps):
    """Annex-B [SPS + filler IDR] in one PES, split into TS packets."""
    es = b"\x00\x00\x00\x01" + sps + b"\x00\x00\x01\x65" + b"\xaa" * 400
    pes = bytes([0, 0, 1, 0xE0, 0, 0, 0x80, 0x00, 0x00]) + es
    pkts = []
    cc = cc0
    first = True
    for off in range(0, len(pes), 184):
        chunk = pes[off:off + 184]
        pkt = bytes([ts_psi.SYNC, (0x40 if first else 0x00) | ((pid >> 8) & 0x1F),
                     pid & 0xFF, 0x10 | (cc & 0x0F)]) + chunk
        first = False
        cc = (cc + 1) & 0x0F
        pkts.append(pkt + b"\xff" * (ts_psi.PKT - len(pkt)))
    return pkts, cc


def build(video_stream_type, n_cycles, lcg, cc, pcr_state):
    """One segment: PSI + jittered PCR + video PES + audio/opus/klv ES."""
    out = []
    streams = [(VIDEO_PID, video_stream_type),
               (AUDIO_PID, ts_psi.STREAM_TYPE_AAC),
               (OPUS_PID, ts_psi.STREAM_TYPE_PRIVATE_PES, OPUS_DESC),
               (KLV_PID, ts_psi.STREAM_TYPE_KLV)]
    for i in range(n_cycles):
        if i % 25 == 0:
            out.append(ts_psi.build_pat(7, {1: PMT_PID}, cc['pat']))
            cc['pat'] = (cc['pat'] + 1) & 0xF
            out.append(ts_psi.build_pmt(PMT_PID, 1, VIDEO_PID, streams, cc['pmt']))
            cc['pmt'] = (cc['pmt'] + 1) & 0xF
        if i % 10 == 0:
            pcr_state[0] += 27000000 // 50 + lcg.next(27000)   # 20 ms + jitter
            out.append(ts_psi.build_pcr_packet(VIDEO_PID, pcr_state[0], cc['v']))
        if i % 40 == 0:
            pkts, cc['v'] = video_pes_packets(VIDEO_PID, cc['v'], H264_SPS)
            out += pkts
        else:
            for _ in range(4):
                out.append(es_packet(VIDEO_PID, cc['v'], pusi=False))
                cc['v'] = (cc['v'] + 1) & 0xF
        out.append(es_packet(AUDIO_PID, cc['a'], pusi=(i % 5 == 0), fill=0xBB))
        cc['a'] = (cc['a'] + 1) & 0xF
        if i % 7 == 3:                    # deliberate CC gap on the opus pid
            cc['o'] = (cc['o'] + 2) & 0xF
        out.append(es_packet(OPUS_PID, cc['o'], pusi=(i % 5 == 1), fill=0xCC))
        cc['o'] = (cc['o'] + 1) & 0xF
        if i % 11 == 0:
            out.append(es_packet(KLV_PID, cc['k'], pusi=True, fill=0xDD))
            cc['k'] = (cc['k'] + 1) & 0xF
        if i % 97 == 43:                  # deterministic desync garbage
            out.append(bytes([lcg.next(0x40)] * (13 + lcg.next(160))))
    return b"".join(out)


def main():
    if len(sys.argv) != 2:
        print("usage: native_parity_fixture.py <output-file>", file=sys.stderr)
        return 2
    lcg = Lcg()
    cc = {'pat': 0, 'pmt': 0, 'v': 0, 'a': 0, 'o': 0, 'k': 0}
    pcr = [27000000]
    data = build(ts_psi.STREAM_TYPE_AVC, 900, lcg, cc, pcr)
    # Codec change mid-stream. Discovery latches the OLDEST retained PSI
    # section (128-packet buffer) and re-parses every 500 feeds, so the HEVC
    # segment must be long enough to (a) fully evict the AVC-era PMTs —
    # 128 more PMTs at one per 25 cycles — and (b) still cross a 500-feed
    # re-parse boundary afterwards: 4800 cycles ≈ 192 PMTs, eviction done at
    # ~3200 cycles, ≥1600 feeds to spare.
    data += build(ts_psi.STREAM_TYPE_HEVC, 4800, lcg, cc, pcr)
    with open(sys.argv[1], "wb") as f:
        f.write(data)
    print(len(data))
    return 0


if __name__ == "__main__":
    sys.exit(main())
