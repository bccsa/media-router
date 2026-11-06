#!/usr/bin/env python3
"""Test fixture: the identity egress of a TRANSFORM PRODUCER (transcoder,
audio-transcoder), PES = content time + 1 h and stamp = PES − 1 h, its video
alone (`house_egress`) or with KLV, teletext and DVB cues (`cue_egress`,
`go_dark`): the input an mpegts-muxer or an aligner sees from such a producer.

Shared by native_runner_protocol_test.py and aligner_conformance_test.py; not
shipped (the engine build copies only the runner's own modules). The anchored
input of the OCC gate's transcoder (2026-10-08) and its runners went with branch
alignment (B-142, the rest in p3-21).

Stream: H.264-typed video PID, IBBP in decode order (PTS+DTS on I/P, PTS only
on B); PCR on the video PID every 20 ms; PAT/PMT every 100 ms. Every PES
payload opens with `MRAU` + pid + serial, so an access unit is identified
wherever it comes out — a demuxer pad or another mux's PES.
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(
    os.path.join(_HERE, "..", "..", "..", "..", "plugins", "mpegts-core", "py")))
import ts_psi  # noqa: E402
import ts_timeline  # noqa: E402

VIDEO_PID, PMT_PID, PROGRAM = 0x100, 0x1000, 1
FRAME = 3600            # 40 ms @ 90 kHz (25 fps)
GOP = 12
DTS0 = 500 * 90000      # the video's first DTS: 500 s
TS_CAPS = "video/mpegts,systemstream=(boolean)true,packetsize=(int)188"


def ns(t90):
    return t90 * 100000 // 9


def _ts_field(marker, v):
    v &= (1 << 33) - 1
    return bytes([marker | (((v >> 30) & 0x07) << 1), (v >> 22) & 0xFF,
                  0x01 | (((v >> 15) & 0x7F) << 1), (v >> 7) & 0xFF, 0x01 | ((v & 0x7F) << 1)])


def _pes(pid, sid, pts, dts, serial, npk, cc, bounded):
    opt = (b"\x80\xc0\x0a" + _ts_field(0x31, pts) + _ts_field(0x11, dts) if dts is not None
           else b"\x80\x80\x05" + _ts_field(0x21, pts))
    head = b"MRAU" + bytes([pid >> 8, pid & 0xFF]) + serial.to_bytes(4, "big")
    payload = head + bytes([0x5A]) * (npk * 184 - 6 - len(opt) - len(head))
    plen = len(opt) + len(payload) if bounded else 0
    body = b"\x00\x00\x01" + bytes([sid]) + plen.to_bytes(2, "big") + opt + payload
    out = []
    for i in range(npk):
        out.append(bytes([0x47, (0x40 if i == 0 else 0) | (pid >> 8), pid & 0xFF,
                          0x10 | cc[pid]]) + body[i * 184:(i + 1) * 184])
        cc[pid] = (cc[pid] + 1) & 0x0F
    return out


def au_key(data):
    """(pid, serial) from the head of an access unit's payload, or None. A leading
    teletext data_identifier (0x10–0x1F, which mpegtsmux adds) is skipped."""
    if data[:1] and 0x10 <= data[0] <= 0x1F:
        data = data[1:]
    if len(data) < 10 or data[:4] != b"MRAU":
        return None
    return (data[4] << 8) | data[5], int.from_bytes(data[6:10], "big")


def video_aus(seconds):
    """The video PID's access units in decode order: [(serial, PTS, DTS, has DTS,
    packets)] — I0 P3 B1 B2 P6 B4 B5 …, B-frames without a DTS."""
    order, k = [0], 0
    while len(order) < seconds * 25 + 50:
        order += [k + 3, k + 1, k + 2]
        k += 3
    out = []
    for d, disp in enumerate(order):
        kind = "I" if disp % GOP == 0 else ("P" if disp % 3 == 0 else "B")
        out.append((d, DTS0 + (disp + 1) * FRAME, DTS0 + d * FRAME, kind != "B",
                    {"I": 8, "P": 3, "B": 2}[kind]))
    return out


MUX_BASE = 3600 * 90000     # mpegtsmux writes running time + 1 h (ts_timeline.MUX_CLOCK_BASE_90K)


def house_egress(seconds, target, start_s=0.0, transit_ms=170.0, per_buf=7):
    """The video PID as a transform producer's identity egress carries it: its
    mux wrote every PES at content time + 1 h (`target(pts90k)` = the content ns
    of a source PTS, continuous, as a producer on house time writes it) and
    the PCR at the DTS; stamp = the buffer's first PES − 1 h under the monotone
    floor, so K = −3600 s. Returns bus buffers from `start_s` on as [(bytes,
    stamp_ns, arrival_ns)], arrival = wire + `transit_ms`, and every AU's target
    {(pid, serial): content ns}."""
    wrap = 1 << 33

    def mux90(t_ns):
        return (t_ns * 9 // 100000 + MUX_BASE) % wrap

    ev, targets = [], {}
    for d, pts, dts, has_dts, npk in video_aus(seconds):
        pts_t, dts_t = target(pts), target(dts)
        targets[(VIDEO_PID, d)] = pts_t
        ev.append((dts_t, 2, (d, mux90(pts_t), mux90(dts_t) if has_dts else None, npk)))
    w0, w_end = min(e[0] for e in ev), max(e[0] for e in ev)
    ev += [(w, 1, None) for w in range(w0, w_end + 1, 20_000_000)]      # PCR, 20 ms
    ev += [(w, 0, None) for w in range(w0, w_end + 1, 100_000_000)]     # PSI, 100 ms
    ev.sort(key=lambda e: (e[0], e[1]))
    cc = {VIDEO_PID: 0, 0: 0, PMT_PID: 0}
    pkts = []                               # (wire ns, packet, PES PTS or None)
    for wire, kind, info in ev:
        if kind == 0:
            pkts.append((wire, ts_psi.build_pat(1, {PROGRAM: PMT_PID}, cc=cc[0]), None))
            pkts.append((wire, ts_psi.build_pmt(PMT_PID, PROGRAM, VIDEO_PID, [(VIDEO_PID, 0x1B)],
                                                cc=cc[PMT_PID]), None))
            cc[0], cc[PMT_PID] = (cc[0] + 1) & 0x0F, (cc[PMT_PID] + 1) & 0x0F
        elif kind == 1:
            pkts.append((wire, ts_psi.build_pcr_packet(VIDEO_PID, mux90(wire) * 300,
                                                       cc=(cc[VIDEO_PID] - 1) & 0x0F), None))
        else:
            d, pes_pts, pes_dts, npk = info
            pk = _pes(VIDEO_PID, 0xE0, pes_pts, pes_dts, d, npk, cc, False)
            pkts += [(wire, p, pes_pts if i == 0 else None) for i, p in enumerate(pk)]
    floor, bufs = None, []
    for i in range(0, len(pkts), per_buf):
        group = pkts[i:i + per_buf]
        arrival = group[-1][0] + int(transit_ms * 1e6)
        first = next((p for _, _, p in group if p is not None), None)
        st = (ts_timeline.house_from_mux_pts(first, arrival) if first is not None
              else floor if floor is not None else arrival)
        floor = st if floor is None else max(floor, st)
        if (group[-1][0] - w0) / 1e9 >= start_s:
            bufs.append((b"".join(p for _, p, _ in group), floor, arrival))
    return bufs, targets


KLV_PID, TTX_PID, DVB_PID = 0x102, 0x103, 0x104
CUE_PIDS = (KLV_PID, TTX_PID, DVB_PID)
# stream_type 0x06 named by its descriptor: tsdemux puts KLV and teletext on
# private_ pads, DVB subtitles on a subpicture_ pad.
_CUE_ES_INFO = {KLV_PID: b"\x05\x04KLVA", TTX_PID: b"\x56\x05eng\x11\x88",
                DVB_PID: b"\x59\x08eng\x10\x00\x01\x00\x01"}


def cue_egress(seconds, target, cue_lead_ms=700.0, start_s=0.0, transit_ms=170.0, per_buf=7,
               schedule=None):
    """`house_egress`'s video plus KLV, teletext and DVB cues 0.25 s apart, one a second or at
    `schedule`'s content seconds, each on the wire `cue_lead_ms` early; stamped as identity egress
    (first video PES − 1 h, else cues' arrival, monotone). [(bytes, stamp, arrival)], targets."""
    wrap = 1 << 33

    def mux90(t_ns):
        return (t_ns * 9 // 100000 + MUX_BASE) % wrap

    ev, targets = [], {}
    for d, pts, dts, has_dts, npk in video_aus(seconds):
        pts_t, dts_t = target(pts), target(dts)
        targets[(VIDEO_PID, d)] = pts_t
        ev.append((dts_t, 2, (VIDEO_PID, 0xE0, d, mux90(pts_t), mux90(dts_t) if has_dts else None, npk)))
    times = schedule if schedule is not None else [n + 1 for n in range(int(seconds) - 1)]
    for k, pid in enumerate(CUE_PIDS):
        for n, s in enumerate(times):
            t = target(DTS0) + (s + k * 0.25) * 10**9
            targets[(pid, n)] = int(t)
            ev.append((int(t - cue_lead_ms * 1e6), 3, (pid, 0xBD, n, mux90(int(t)), None, 1)))
    w0, w_end = min(e[0] for e in ev), max(e[0] for e in ev)
    ev += [(w, 1, None) for w in range(w0, w_end + 1, 20_000_000)]      # PCR, 20 ms
    ev += [(w, 0, None) for w in range(w0, w_end + 1, 100_000_000)]     # PSI, 100 ms
    ev.sort(key=lambda e: (e[0], e[1]))
    cc = {VIDEO_PID: 0, 0: 0, PMT_PID: 0, **{p: 0 for p in CUE_PIDS}}
    streams = [(VIDEO_PID, 0x1B)] + [(p, 0x06, _CUE_ES_INFO[p]) for p in CUE_PIDS]
    pkts = []                               # (wire ns, packet, (pid, PES PTS) or None)
    for wire, kind, info in ev:
        if kind == 0:
            pkts.append((wire, ts_psi.build_pat(1, {PROGRAM: PMT_PID}, cc=cc[0]), None))
            pkts.append((wire, ts_psi.build_pmt(PMT_PID, PROGRAM, VIDEO_PID, streams, cc=cc[PMT_PID]), None))
            cc[0], cc[PMT_PID] = (cc[0] + 1) & 0x0F, (cc[PMT_PID] + 1) & 0x0F
        elif kind == 1:
            pkts.append((wire, ts_psi.build_pcr_packet(VIDEO_PID, mux90(wire) * 300,
                                                       cc=(cc[VIDEO_PID] - 1) & 0x0F), None))
        else:
            pid, sid, serial, pes_pts, pes_dts, npk = info
            pk = _pes(pid, sid, pes_pts, pes_dts, serial, npk, cc, kind == 3)
            pkts += [(wire, p, (pid, pes_pts) if i == 0 else None) for i, p in enumerate(pk)]
    floor, bufs = None, []
    for i in range(0, len(pkts), per_buf):
        group = pkts[i:i + per_buf]
        arrival = group[-1][0] + int(transit_ms * 1e6)
        heads = [h for _, _, h in group if h is not None]
        video = next((pts for pid, pts in heads if pid == VIDEO_PID), None)
        st = (ts_timeline.house_from_mux_pts(video, arrival) if video is not None
              else arrival if heads or floor is None else floor)
        floor = st if floor is None else max(floor, st)
        if (group[-1][0] - w0) / 1e9 >= start_s:
            bufs.append((b"".join(p for _, p, _ in group), floor, arrival))
    return bufs, targets


def go_dark(bufs, t_from, t_back, pids=CUE_PIDS):
    """`cue_egress` buffers with the producer silent from arrival `t_from` to its first buffer from
    `t_back` on that opens with a cue on `pids`, split after it (cue-only, the rest at once),
    restamped as `cue_egress` does, each PID's continuity counter carried on; and that arrival."""
    def heads(data):
        return [j for j in range(0, len(data), 188) if ts_psi.read_pes_pts(data[j:j + 188]) is not None]

    back = next(i for i, (data, _st, arr) in enumerate(bufs) if arr >= t_back and heads(data)
                and ts_psi.ts_pid(data[heads(data)[0]:]) in pids)
    data, _st, arrival = bufs[back]
    cut = heads(data)[0] + 188
    kept = ([(d, a) for d, _s, a in bufs if a < t_from] + [(data[:cut], arrival)]
            + ([(data[cut:], arrival)] if data[cut:] else [])
            + [(d, a) for d, _s, a in bufs[back + 1:]])
    cc, floor, out = {}, None, []
    for data, arr in kept:
        b = bytearray(data)
        for j in range(0, len(b), 188):
            pid = ((b[j + 1] & 0x1F) << 8) | b[j + 2]
            # A payload packet steps the counter, an adaptation-only one (PCR) repeats it.
            cc[pid] = b[j + 3] & 0x0F if pid not in cc else (cc[pid] + (1 if b[j + 3] & 0x10 else 0)) & 0x0F
            b[j + 3] = (b[j + 3] & 0xF0) | cc[pid]
        video = next((ts_psi.read_pes_pts(data[j:j + 188]) for j in heads(data)
                      if ts_psi.ts_pid(data[j:]) == VIDEO_PID), None)
        st = (ts_timeline.house_from_mux_pts(video, arr) if video is not None
              else arr if heads(data) or floor is None else floor)
        floor = st if floor is None else max(floor, st)
        out.append((bytes(b), floor, arr))
    return out, arrival
