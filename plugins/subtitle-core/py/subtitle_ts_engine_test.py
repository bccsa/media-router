"""`subtitle_ts` against the REAL engine stamper (`ts_timeline.TimelineStamper`,
plugins/mpegts-core/py — mrtsstamp is its C++ twin). Run from
`subtitle_ts_test.py`; the TS comes from `subtitle_testlib`.

A synthetic program: video every 20 ms on the PCR PID, audio every 150 ms,
teletext (0xBD) every 40 ms at t + 50, PAT every 100 ms — with the OCC feed's
offsets (video t + 1100, audio t + 60) and two audio-leading ones (audio +600 /
video +100; vMix audio +1800). Cut into pseudo-random chunks (random packet
counts and whole PES groups, so every shape occurs; audio-only, teletext-only
and PES-less are counted), stamped by the anchored stamper with its timing PID
unknown and known, through +427 s, +7 s and −600 s PTS jumps, and once with the
bridge attached mid-stream. A teletext PES the bridge places must land within
one video frame of the stamper's own mapping; misses are allowed where noted.
Plus the consumer's view: a KLV-only cue stream (PCR on the KLV PID, packed by
`subtitle_pack`) through the house-timeline stamper, attached mid-stream.
"""
import random

import subtitle_ts as ts
from subtitle_testlib import packets, pat, pes, use_mpegts_core

use_mpegts_core()
import ts_timeline  # noqa: E402 — plugins/mpegts-core/py

VID, AUD, TTX = 0x100, 0x101, 0x120
FRAME_MS = 20.0
JUMPS = ((4_000, 427_000), (6_000, 7_000), (8_000, -600_000))   # (t ms, PTS step ms)
RESYNC_MS = 500                                  # misses allowed this long after a jump


def program(v_off=1100, a_off=60, until_ms=12_000):
    """[(t ms, event, packet)] in wire order + {ttx tag: raw PTS}."""
    events = []
    for t in range(0, until_ms, 10):
        step = sum(d for at, d in JUMPS if t >= at)
        base = 900_000 + step * 90
        if t % 20 == 0:
            events.append((t, 1, VID, 0xE0, base + (t + v_off) * 90, 300, base + t * 90))
        if t % 150 == 0:
            events.append((t, 0, AUD, 0xC0, base + (t + a_off) * 90, 100, None))
        if t % 40 == 0:
            events.append((t, 2, TTX, 0xBD, base + (t + 50) * 90, 30, None))
        if t % 100 == 0:
            events.append((t, 3, 0, None, None, 0, None))
    out, ttx_pts = [], {}
    for ev, (t, _order, pid, sid, pts, size, pcr) in enumerate(sorted(events, key=lambda e: (e[0], e[1]))):
        if pid == 0:
            out.append((t, ev, pat()))
            continue
        body = (b"T%07d" % t) + b"\x00" * (size - 8) if pid == TTX else b"\x00" * size
        if pid == TTX:
            ttx_pts[body] = pts
        out += [(t, ev, p) for p in packets(pid, pes(sid, pts, body), pcr=None if pcr is None else pcr % (1 << 33))]
    return out, ttx_pts


def chunks(stream, rng):
    """Random packet counts and whole PES groups (1-2 events), in order."""
    i = 0
    while i < len(stream):
        if rng.random() < 0.5:
            j = min(len(stream), i + rng.randint(1, 9))
        else:
            k, evs, j = rng.randint(1, 2), [], i
            while j < len(stream):
                if stream[j][1] not in evs:
                    if len(evs) == k:
                        break
                    evs.append(stream[j][1])
                j += 1
        yield stream[i:j]
        i = j


def shape_of(data):
    kinds = {h[0] for h in (ts.parse_pes_header(pkt[ts.payload_offset(pkt):])
                            for pkt in ts.iter_packets(data) if pkt[1] & 0x40) if h}
    return {frozenset({0xC0}): "audio-only", frozenset({0xBD}): "teletext-only",
            frozenset(): "no-PES-head"}.get(frozenset(kinds))


def one_run(check, timing_known, v_off=1100, a_off=60, attach=None, all_placed=True):
    """`attach`: chunk index the bridge starts at. `all_placed`: misses outside
    the start/jump/attach windows fail (else only wrong placements do)."""
    stream, ttx_pts = program(v_off, a_off)
    stamper = ts_timeline.TimelineStamper()               # anchored, no repair, no conditioner
    if timing_known:
        stamper._timing_pid = VID                          # what `condition` learns on the fleet
    bridge = ts.PesStamper(pids={TTX})
    house0 = 5_000_000_000_000                             # house clock at t = 0 (ns)
    truth, placed, attach_t = {}, {}, None
    shapes = {"audio-only": 0, "teletext-only": 0, "no-PES-head": 0}
    for n, part in enumerate(chunks(stream, random.Random(7))):
        data = b"".join(p for _t, _ev, p in part)
        shape = shape_of(data)
        if shape:
            shapes[shape] += 1
        stamp = stamper.stamp(data, house0 + part[-1][0] * 1_000_000)
        if attach is not None and n < attach:
            continue                                       # the bridge has not attached yet
        if attach_t is None:
            attach_t = part[0][0]
        # The stamper's mapping for this chunk (anchor/ref after the stamp).
        for pkt in ts.iter_packets(data):
            if ts.packet_pid(pkt) == TTX and pkt[1] & 0x40:
                body = bytes(pkt[ts.payload_offset(pkt) + 14:ts.payload_offset(pkt) + 22])
                u = ts_timeline.unwrap_near(ttx_pts[body + b"\x00" * 22], stamper.ref)
                truth[body] = (stamper.anchor + ts_timeline.pts90k_to_ns(u - stamper.ref)) / 1e6
        for _pid, payload, house in bridge.feed(data, stamp / 1e6):
            placed[payload[:8]] = house
    label = (f"{'timing PID known' if timing_known else 'timing PID unknown'}, video +{v_off} audio +{a_off}"
             + (f", attached at chunk {attach}" if attach else ""))
    starts = (0, attach_t) + tuple(a for a, _d in JUMPS)
    window = lambda tag: any(at <= int(tag[1:]) < at + RESYNC_MS for at in starts)  # noqa: E731
    wrong = [tag for tag in truth if placed.get(tag) is not None and abs(placed[tag] - truth[tag]) > FRAME_MS]
    missed = [tag for tag in truth if placed.get(tag) is None and not window(tag)]
    errs = [abs(placed[t] - truth[t]) for t in truth if placed.get(t) is not None]
    print(f"     [{label}] {len(truth)} teletext PES, {len(errs)} placed, {stamper.reanchors} re-anchors, "
          f"worst {max(errs) if errs else float('nan'):.3f} ms, misses outside windows {len(missed)}")
    check(f"real stamper, {label}: no teletext PES placed more than one frame off", not wrong)
    check(f"real stamper, {label}: most teletext PES placed", len(errs) >= len(truth) // 2)
    if all_placed:
        check(f"real stamper, {label}: every PES placed outside start/attach/jump windows", not missed)
    check(f"real stamper, {label}: the stamper re-anchored on the jumps", stamper.reanchors >= 2)
    if attach is None:
        check(f"real stamper, {label}: audio-only, teletext-only and no-PES-head chunks occurred {shapes}",
              all(n > 0 for n in shapes.values()))
    return wrong, missed


def house_klv_run(check):
    """The consumer's input: KLV-only cue chunks (`subtitle_pack`, PCR on the
    KLV PID; cues, 2 s-style re-sends, clears; some chunks split in two) through
    the house-timeline stamper; the bridge attaches at the 5th push."""
    import subtitle_klv
    import subtitle_pack
    rng, packer = random.Random(3), subtitle_pack.KlvTsPacker(0x180)
    stamper = ts_timeline.TimelineStamper(house_timeline=True)
    bridge, house0_ms = ts.PesStamper(), 5_000_000_000.0
    pushes = []
    for n in range(16):
        start = house0_ms + 1000 + n * 1300
        text = "" if n % 3 == 2 else f"cue {n}"
        pushes += [(start + 300, start, text), (start + 800, start, text)]   # first send + re-send
    checked, wrong = 0, []
    for n, (arrival, start, text) in enumerate(pushes):
        data = packer.cue_chunk(subtitle_pack.pes_ticks(start), subtitle_klv.encode_cue(0, 0 if not text else 3000, text))
        cut = rng.choice((len(data), 188, 376))
        for part in (data[:cut], data[cut:]):
            if not part:
                continue
            stamp = stamper.stamp(part, int(arrival * 1e6))
            if n < 4:
                continue
            for _pid, _payload, house in bridge.feed(part, stamp / 1e6):
                checked += 1
                if house is None or abs(house - start) > 1e-3:
                    wrong.append((n, house, start))
    print(f"     [house-timeline KLV-only, attached at push 4] {checked} cue PES checked")
    check("real stamper, house mode KLV-only (as the consumer sees it): every cue at its start, from attach on",
          checked == len(pushes) - 4 and not wrong)


def run(check):
    for known in (False, True):
        one_run(check, known)                                  # the OCC shape
        one_run(check, known, v_off=100, a_off=600, all_placed=False)
        one_run(check, known, v_off=100, a_off=1800, all_placed=False)
    one_run(check, False, attach=random.Random(11).randint(60, 200))
    house_klv_run(check)
