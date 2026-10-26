#!/usr/bin/env python3
"""pcm_align.py <a> <b> [--pid PID] [--channel N] [--window S] [--max-lag MS]
                        [--want-offset N] [--max-fill PCT]

Two captures of one programme on the house timeline (V6, V7; Phase 2's V1 and V7): each a .ts
carrying SMPTE 302M, decoded here PES by PES and placed by its PTS (house = PES - 1 h, at
48 kHz), or a .wav, placed from its first sample. Prints one JSON line:

  offsetSamples  where b's content sits against a's on that timeline (positive: b later): the
                 peak of their cross-correlation over --window S (10) from the overlap's start,
                 searched +- --max-lag MS (500), on --channel N (0);
  fillPct        silence fill: of the overlap's samples where a carries sound (a channel not 0),
                 the share where b, moved by the offset, is digital silence (every channel 0)
                 or missing (a hole between its PES);
  and the overlap, the peak's normalised height and each capture's holes.

--want-offset and --max-fill make it a check: exit 1 when the offset differs or the fill is
higher. Exit 2 on unusable input. --pid picks the 302M PID (default: the PMT's first stream of
type 0x06 with registration BSSD). Needs numpy."""
import argparse
import json
import sys
import wave

import numpy as np

PKT = 188
WRAP = 1 << 33
MUX_BASE = 3600 * 90000
RATE = 48000
# ff_reverse: each byte's bits in the other order (302M sends the LSB first).
REV = np.array([int(f"{i:08b}"[::-1], 2) for i in range(256)], dtype=np.uint32)


def fail(why):
    print(f"pcm_align: {why}", file=sys.stderr)
    sys.exit(2)


def section(pk, pids, pusi, pid):
    """The first section starting on `pid` (from its pointer_field), or b''."""
    for i in np.nonzero((pids == pid) & pusi)[0]:
        p = pk[i]
        off = 4 + (1 + int(p[4]) if p[3] & 0x20 else 0)
        if off < PKT:
            s = p[off + 1 + int(p[off]):].tobytes()
            if len(s) >= 12:
                return s
    return b""


def pmt_302m_pid(pk, pids, pusi):
    pat = section(pk, pids, pusi, 0)
    if not pat:
        fail("no PAT")
    pmt = section(pk, pids, pusi, ((pat[10] & 0x1F) << 8) | pat[11])
    if not pmt:
        fail("no PMT")
    end = min(len(pmt), 3 + (((pmt[1] & 0x0F) << 8) | pmt[2]) - 4)
    i = 12 + (((pmt[10] & 0x0F) << 8) | pmt[11])
    while i + 5 <= end:
        st, pid, n = pmt[i], ((pmt[i + 1] & 0x1F) << 8) | pmt[i + 2], ((pmt[i + 3] & 0x0F) << 8) | pmt[i + 4]
        if st == 0x06 and b"\x05\x04BSSD" in pmt[i + 5:i + 5 + n]:
            return pid
        i += 5 + n
    fail("no SMPTE 302M stream (type 0x06, registration BSSD) in the PMT")


def pes_units(path, pid):
    """(pts33, payload) of every whole PES on the 302M PID, in order; a capture on the 188-byte grid."""
    data = np.fromfile(path, dtype=np.uint8)
    pk = data[:len(data) // PKT * PKT].reshape(-1, PKT)
    pk = pk[pk[:, 0] == 0x47]
    pids = ((pk[:, 1].astype(np.int32) & 0x1F) << 8) | pk[:, 2]
    pusi = (pk[:, 1] & 0x40) != 0
    if pid is None:
        pid = pmt_302m_pid(pk, pids, pusi)
    units, cur = [], None
    for i in np.nonzero(pids == pid)[0]:
        p = pk[i]
        if not p[3] & 0x10:
            continue
        off = 4 + (1 + int(p[4]) if p[3] & 0x20 else 0)
        if off >= PKT:
            continue
        if pusi[i]:
            if cur:
                units.append(cur)
            q = p[off:].tobytes()
            cur = None
            if len(q) >= 14 and q[:3] == b"\x00\x00\x01" and q[7] & 0x80:
                pts = ((q[9] >> 1 & 7) << 30) | (q[10] << 22) | (q[11] >> 1 << 15) | (q[12] << 7) | (q[13] >> 1)
                n = (q[4] << 8) | q[5]
                cur = [pts, bytearray(q[9 + q[8]:]), n - 3 - q[8] if n else -1]
        elif cur:
            cur[1] += p[off:].tobytes()
    if cur:
        units.append(cur)
    # A bounded PES completes at its length; one cut short (the end of the file) is dropped.
    return [(pts, bytes(b if n < 0 else b[:n])) for pts, b, n in units if n < 0 or len(b) >= n], pid


def s302m(payload):
    """int32 samples (frames x channels, MSB-aligned) of one 302M payload, as ffmpeg's s302m.c."""
    h = int.from_bytes(payload[:4], "big")
    size, channels, bits = h >> 16, ((h >> 14 & 3) + 1) * 2, 16 + 4 * (h >> 4 & 3)
    group = {16: 5, 20: 6, 24: 7}.get(bits)
    if group is None:
        fail(f"302M with {bits} bits per sample")
    raw = np.frombuffer(payload[4:4 + size], dtype=np.uint8)
    r = REV[raw[:len(raw) // group * group].reshape(-1, group)]   # each byte bit-reversed
    lo = lambda i: r[:, i] & 0x0F            # ff_reverse[b & 0xf0]
    hi = lambda i: r[:, i] & 0xF0            # ff_reverse[b & 0x0f]
    if bits == 16:
        a = (r[:, 1] << 8) | r[:, 0]
        c = (lo(4) << 12) | (r[:, 3] << 4) | (r[:, 2] >> 4)
        s = (np.stack([a, c], 1).astype(np.uint16).view(np.int16).astype(np.int32)) << 16
    elif bits == 20:
        a = (lo(2) << 28) | (r[:, 1] << 20) | (r[:, 0] << 12)
        c = (lo(5) << 28) | (r[:, 4] << 20) | (r[:, 3] << 12)
        s = np.stack([a, c], 1).astype(np.uint32).view(np.int32)
    else:
        a = (r[:, 2] << 24) | (r[:, 1] << 16) | (r[:, 0] << 8)
        c = (lo(6) << 28) | (r[:, 5] << 20) | (r[:, 4] << 12) | (hi(3) << 4)
        s = np.stack([a, c], 1).astype(np.uint32).view(np.int32)
    return s.reshape(-1, channels)


def load(path, pid):
    """(start sample, samples frames x channels as int32 with holes zeroed, present mask, holes)."""
    if path.endswith(".wav"):
        with wave.open(path) as w:
            if w.getframerate() != RATE:
                fail(f"{path}: {w.getframerate()} Hz, not {RATE}")
            width, ch = w.getsampwidth(), w.getnchannels()
            raw = np.frombuffer(w.readframes(w.getnframes()), dtype=np.uint8)
        if width == 2:
            s = raw.view(np.int16).astype(np.int32) << 16
        elif width == 4:
            s = raw.view(np.int32)
        else:
            fail(f"{path}: {8 * width}-bit WAV")
        s = s.reshape(-1, ch)
        return 0, s, np.ones(len(s), dtype=bool), 0
    units, _ = pes_units(path, pid)
    if not units:
        fail(f"{path}: no 302M PES")
    # Each PES at its PTS: house = PES - 1 h, unwrapped from the first, at 48 kHz.
    first = units[0][0]
    starts, blocks = [], []
    for pts, payload in units:
        t = (pts - first + WRAP // 2) % WRAP - WRAP // 2 + first - MUX_BASE
        starts.append(round(t * RATE / 90000))
        blocks.append(s302m(payload))
    t0 = starts[0]
    end = max(st + len(b) for st, b in zip(starts, blocks))
    ch = blocks[0].shape[1]
    s = np.zeros((end - t0, ch), dtype=np.int32)
    present = np.zeros(end - t0, dtype=bool)
    for st, b in zip(starts, blocks):
        s[st - t0:st - t0 + len(b)] = b[:, :ch]
        present[st - t0:st - t0 + len(b)] = True
    holes = int(np.count_nonzero(np.diff(present.astype(np.int8)) == 1))
    return t0, s, present, holes


def main():
    ap = argparse.ArgumentParser(add_help=True, usage=__doc__.split("\n\n")[0])
    ap.add_argument("a")
    ap.add_argument("b")
    ap.add_argument("--pid", type=lambda v: int(v, 0))
    ap.add_argument("--channel", type=int, default=0)
    ap.add_argument("--window", type=float, default=10.0)
    ap.add_argument("--max-lag", type=float, default=500.0)
    ap.add_argument("--want-offset", type=int)
    ap.add_argument("--max-fill", type=float)
    o = ap.parse_args()
    ta, sa, pa, ha = load(o.a, o.pid)
    tb, sb, pb, hb = load(o.b, o.pid)
    if o.channel >= min(sa.shape[1], sb.shape[1]):
        fail(f"no channel {o.channel}")
    lag = int(o.max_lag * RATE / 1000)
    # The correlation window: a's first --window seconds where both carry data.
    lo = max(ta, tb) + lag
    win = int(o.window * RATE)
    if lo + win + lag > min(ta + len(sa), tb + len(sb)):
        fail("the captures overlap by less than --window plus twice --max-lag")
    x = sa[lo - ta:lo - ta + win, o.channel].astype(np.float64)
    y = sb[lo - tb - lag:lo - tb + win + lag, o.channel].astype(np.float64)
    n = 1 << int(np.ceil(np.log2(len(x) + len(y))))
    c = np.fft.irfft(np.fft.rfft(y, n) * np.conj(np.fft.rfft(x, n)), n)[:2 * lag + 1]
    k = int(np.argmax(c))
    offset = k - lag
    seg = y[k:k + win]
    norm = float(np.sqrt(np.dot(x, x) * np.dot(seg, seg)))
    peak = float(c[k] / norm) if norm else 0.0
    # The fill over the whole overlap, b moved back by the offset onto a.
    start, end = max(ta, tb - offset), min(ta + len(sa), tb - offset + len(sb))
    if end <= start:
        fail("no overlap")
    a_sound = pa[start - ta:end - ta] & np.any(sa[start - ta:end - ta] != 0, axis=1)
    bi = slice(start - tb + offset, end - tb + offset)
    b_quiet = ~pb[bi] | np.all(sb[bi] == 0, axis=1)
    sound = int(np.count_nonzero(a_sound))
    filled = int(np.count_nonzero(a_sound & b_quiet))
    fill = 100.0 * filled / sound if sound else 0.0
    out = {"msg": "pcm_align", "rate": RATE, "channels": int(min(sa.shape[1], sb.shape[1])),
           "overlapSamples": end - start, "offsetSamples": offset, "peak": round(peak, 4),
           "soundSamples": sound, "fillSamples": filled, "fillPct": round(fill, 4), "holesA": ha, "holesB": hb}
    ok = (o.want_offset is None or offset == o.want_offset) and (o.max_fill is None or fill <= o.max_fill)
    out["pass"] = ok
    print(json.dumps(out, separators=(",", ":")))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
