"""`subtitle_ts` against the stamp the engine puts on every bus chunk: the identity stamp,
PES − 1 h under a monotone floor (`subtitle_testlib.IdentityStamp`, the model of
mrts::IdentityStamp, plan ch. 6 WI-P2-3). Run from `subtitle_ts_test.py`; the TS comes from
`subtitle_testlib`.

A synthetic program on the house timeline (PES = content + 1 h): video every 20 ms on the PCR
PID, audio every 150 ms, teletext (0xBD) every 40 ms at t + 50, PAT every 100 ms — with the
OCC feed's offsets (video t + 1100, audio t + 60) and two audio-leading ones (audio +600 /
video +100; vMix audio +1800). Cut into pseudo-random chunks (random packet counts and whole
PES groups, so every shape occurs; audio-only, teletext-only and PES-less are counted),
stamped with the timing PID unknown and known, through +427 s and +7 s content jumps (a bus
carries a source's jump as a gap: content only moves forward), and once with the bridge
attached mid-stream. A teletext PES the bridge places must land within one video frame of
its own identity, PES − 1 h; misses are allowed only where noted.
Plus the consumer's view: a KLV-only cue stream (PCR on the KLV PID, packed by
`subtitle_pack`) through the identity stamp, attached mid-stream.
"""
import random

import subtitle_ts as ts
from subtitle_testlib import IdentityStamp, packets, pat, pes, use_mpegts_core

use_mpegts_core()
import ts_timeline  # noqa: E402 — plugins/mpegts-core/py (its kept helpers)

VID, AUD, TTX = 0x100, 0x101, 0x120
FRAME_MS = 20.0
JUMPS = ((4_000, 427_000), (6_000, 7_000))     # (t ms, content step ms)
RESYNC_MS = 500                                  # misses allowed this long after a start
HOUSE0 = 5_000_000_000_000                       # house clock at t = 0 (ns)


def program(v_off=1100, a_off=60, until_ms=12_000):
    """[(t ms, event, packet)] in wire order + {ttx tag: raw PTS}; PES = house + 1 h."""
    events = []
    for t in range(0, until_ms, 10):
        step = sum(d for at, d in JUMPS if t >= at)
        base = HOUSE0 * 9 // 100_000 + ts_timeline.MUX_CLOCK_BASE_90K + step * 90
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


def stamped_chunks(v_off, a_off, timing_known, attach=None):
    """[(chunk bytes, stamp ns, house now ns)] the bridge would see from `attach` on."""
    stream, _ttx = program(v_off, a_off)
    stamper = IdentityStamp(VID if timing_known else None)
    out = []
    for n, part in enumerate(chunks(stream, random.Random(7))):
        data = b"".join(p for _t, _ev, p in part)
        house_now = HOUSE0 + part[-1][0] * 1_000_000
        stamp = stamper.stamp(data, house_now)
        if attach is None or n >= attach:
            out.append((data, stamp, house_now))
    return out


def one_run(check, timing_known, v_off=1100, a_off=60, attach=None):
    """`attach`: chunk index the bridge starts at. Misses are allowed only in the start /
    attach window, which a leading audio PID stretches by its lead: its stamps hold the floor
    until the video content passes it, and the mapping is learned on a rise. Never wrong."""
    _stream, ttx_pts = program(v_off, a_off)
    bridge = ts.PesStamper(pids={TTX})
    truth, placed, ks, drops, attach_t = {}, {}, [], 0, None
    shapes = {"audio-only": 0, "teletext-only": 0, "no-PES-head": 0}
    for data, stamp, house_now in stamped_chunks(v_off, a_off, timing_known, attach):
        shape = shape_of(data)
        if shape:
            shapes[shape] += 1
        for pkt in ts.iter_packets(data):
            if ts.packet_pid(pkt) == TTX and pkt[1] & 0x40:
                body = bytes(pkt[ts.payload_offset(pkt) + 14:ts.payload_offset(pkt) + 22])
                if attach_t is None:
                    attach_t = int(body[1:])
                # Its own identity: the house time the consumer's formula reads off its PES.
                truth[body] = ts_timeline.house_from_mux_pts(ttx_pts[body + b"\x00" * 22], house_now) / 1e6
        k_before = bridge.model.k
        for _pid, payload, house in bridge.feed(data, stamp / 1e6):
            placed[payload[:8]] = house
        if bridge.model.k is not None:
            ks.append(bridge.model.k)
        elif k_before is not None:
            drops += 1
    label = (f"{'timing PID known' if timing_known else 'timing PID unknown'}, video +{v_off} audio +{a_off}"
             + (f", attached at chunk {attach}" if attach else ""))
    starts, span = (0, attach_t or 0), RESYNC_MS + max(0, a_off - v_off)
    window = lambda tag: any(at <= int(tag[1:]) < at + span for at in starts)  # noqa: E731
    wrong = [tag for tag in truth if placed.get(tag) is not None and abs(placed[tag] - truth[tag]) > FRAME_MS]
    missed = [tag for tag in truth if placed.get(tag) is None and not window(tag)]
    errs = [abs(placed[t] - truth[t]) for t in truth if placed.get(t) is not None]
    print(f"     [{label}] {len(truth)} teletext PES, {len(errs)} placed, {drops} K drops, "
          f"worst {max(errs) if errs else float('nan'):.6f} ms, misses outside windows {len(missed)}")
    check(f"identity stamp, {label}: no teletext PES placed more than one frame off", not wrong)
    check(f"identity stamp, {label}: every PES placed outside the start/attach window", not missed)
    check(f"identity stamp, {label}: the mapping K holds through the jumps, never dropped",
          drops == 0 and bool(ks) and max(ks) - min(ks) < 1e-3)
    if attach is None:
        check(f"identity stamp, {label}: audio-only, teletext-only and no-PES-head chunks occurred {shapes}",
              all(n > 0 for n in shapes.values()))
    return wrong, missed


def house_klv_run(check):
    """The consumer's input: KLV-only cue chunks (`subtitle_pack`, PCR on the KLV PID; cues,
    2 s-style re-sends, clears; some chunks split in two) through the identity stamp; the
    bridge attaches at the 5th push."""
    import subtitle_klv
    import subtitle_pack
    rng, packer = random.Random(3), subtitle_pack.KlvTsPacker(0x180)
    stamper = IdentityStamp()
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
    print(f"     [identity KLV-only, attached at push 4] {checked} cue PES checked")
    check("identity stamp, KLV-only (as the consumer sees it): every cue at its start, from attach on",
          checked == len(pushes) - 4 and not wrong)


def run(check):
    for known in (False, True):
        one_run(check, known)                                  # the OCC shape
        one_run(check, known, v_off=100, a_off=600)
        one_run(check, known, v_off=100, a_off=1800)
    one_run(check, False, attach=random.Random(11).randint(60, 200))
    house_klv_run(check)
