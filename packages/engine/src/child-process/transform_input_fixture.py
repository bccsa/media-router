#!/usr/bin/env python3
"""Test fixture: the bus input of a TRANSFORM PRODUCER (transcoder,
audio-transcoder) as the OCC gate's transcoder saw it on 2026-10-08 — an SPTS
whose video PES PTS lead the PCR by ~1.1 s, stamped by the contract.

Shared by gst_tsdemux_slave_test.py, gst_branch_align_test.py and
native_runner_protocol_test.py; not shipped (the engine build copies only the
runner's own modules).

Stream: H.264-typed video PID, IBBP in decode order (PTS+DTS on I/P, PTS only
on B), DTS `dts_lead_ms` ahead of the PCR — swinging up by `lead_swing_ms` over
`swing_period_s`, a VBR encoder's buffer; AAC-typed audio PID `audio_lead_ms`
ahead; PCR on the first PID every 20 ms; PAT/PMT every 100 ms. Every PES
payload opens with `MRAU` + pid + serial, so an access unit is identified
wherever it comes out — a demuxer pad or another mux's PES.

`house_egress` builds the other input an mpegts-muxer sees: a transform
producer's identity egress (PES = content time + 1 h, stamp = PES − 1 h).

Stamps: the producer model — `content(pts) = A + ns(pts − ref)` (anchor A at
the first PES's arrival, ref that PES), a bus buffer stamped by its first
timing-PID PES (else its first PES), never below the last stamp. It is what
`ts_timeline.TimelineStamper` writes once its conditioner has learned the PCR
PID (pinned in gst_tsdemux_slave_test.py). `skew_ppm` runs the source clock
fast against house with the producer's drift slew assumed ideal; a jump steps
PES and PCR back `jump_s` with the producer re-anchored, so stamps and content
time stay continuous. An access unit's TARGET is its content time.
"""
import math
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(
    os.path.join(_HERE, "..", "..", "..", "..", "plugins", "mpegts-core", "py")))
import ts_psi  # noqa: E402
import ts_timeline  # noqa: E402

VIDEO_PID, AUDIO_PID, PMT_PID, PROGRAM = 0x100, 0x101, 0x1000, 1
FRAME = 3600            # 40 ms @ 90 kHz (25 fps)
AAC_TICKS = 1920        # 21.33 ms
GOP = 12
DTS0 = 500 * 90000      # source epoch, far enough from 0 for a 427 s rewind
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
    """(pid, serial) from the head of an access unit's payload, or None."""
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


def build_packets(seconds, dts_lead_ms=1000.0, audio_lead_ms=60.0, jump_at_s=None,
                  jump_s=427.0, pids=(VIDEO_PID, AUDIO_PID), lead_swing_ms=0.0,
                  swing_period_s=20.0, swing_audio=False):
    """Wire-ordered [(wire90k, packet, au)]: `au` = (pid, serial, content PTS,
    content DTS or None) on a PES's first packet, else None. Content ignores the
    jump. `swing_audio` swings the audio lead too (a passthrough AAC leg)."""
    def lead(dts):
        t = (dts - DTS0) / 90000.0
        return dts_lead_ms + lead_swing_ms * 0.5 * (1 - math.cos(2 * math.pi * t / swing_period_s))

    def audio_lead(pts):
        return audio_lead_ms + (lead(pts) - dts_lead_ms if swing_audio else 0.0)

    ev = []
    if VIDEO_PID in pids:
        for d, pts, dts, has_dts, npk in video_aus(seconds):
            ev.append((dts - int(lead(dts) * 90), 2, (VIDEO_PID, 0xE0, pts,
                       dts if has_dts else None, d, npk, False)))
    if AUDIO_PID in pids:
        for m in range(int(seconds * 48000 / 1024) + 50):
            pts = DTS0 + FRAME + m * AAC_TICKS
            ev.append((pts - int(audio_lead(pts) * 90), 3, (AUDIO_PID, 0xC0, pts, None, m, 1, True)))
    w0, w_end = min(e[0] for e in ev), max(e[0] for e in ev)
    ev += [(w, 1, None) for w in range(w0, w_end + 1, 1800)]          # PCR, 20 ms
    ev += [(w, 0, None) for w in range(w0, w_end + 1, 9000)]          # PSI, 100 ms
    ev.sort(key=lambda e: (e[0], e[1]))
    jump_at = None if jump_at_s is None else w0 + int(jump_at_s * 90000)
    pcr_pid = pids[0]
    cc = {VIDEO_PID: 0, AUDIO_PID: 0, 0: 0, PMT_PID: 0}
    out = []
    for wire, kind, info in ev:
        sh = int(jump_s * 90000) if jump_at is not None and wire >= jump_at else 0
        if kind == 0:
            out.append((wire, ts_psi.build_pat(1, {PROGRAM: PMT_PID}, cc=cc[0]), None))
            out.append((wire, ts_psi.build_pmt(PMT_PID, PROGRAM, pcr_pid, [
                (p, 0x1B if p == VIDEO_PID else 0x0F) for p in pids], cc=cc[PMT_PID]), None))
            cc[0], cc[PMT_PID] = (cc[0] + 1) & 0x0F, (cc[PMT_PID] + 1) & 0x0F
        elif kind == 1:
            out.append((wire, ts_psi.build_pcr_packet(pcr_pid, (wire - sh) * 300,
                                                      cc=(cc[pcr_pid] - 1) & 0x0F), None))
        else:
            pid, sid, pts, dts, serial, npk, bounded = info
            pk = _pes(pid, sid, pts - sh, None if dts is None else dts - sh, serial, npk, cc, bounded)
            out += [(wire, p, (pid, serial, pts, dts) if i == 0 else None) for i, p in enumerate(pk)]
    return out


def stamp(packets, start_s, house0_ns, skew_ppm=0.0, per_buf=7, net_ms=5.0, dts_targets=None,
          arrivals=None):
    """Bus buffers from `start_s` on as [(bytes, stamp_ns)], and every access
    unit's target {(pid, serial): content ns}. `house0_ns` = house time of the
    first packet on the wire. `dts_targets` (a dict) gets each AU's content DTS
    (its PTS where the PES carries none); `arrivals` (a list) each returned
    buffer's house arrival time."""
    w0, rate = packets[0][0], 1.0 + skew_ppm / 1e6
    # The timing PID is the PCR carrier; the anchor is its first PES.
    timing_pid = next(ts_psi.ts_pid(p) for _, p, _ in packets if ts_psi.read_pcr(p) is not None)
    anchor = floor = None
    bufs, targets = [], {}
    for i in range(0, len(packets), per_buf):
        group = packets[i:i + per_buf]
        aus = [au for _, _, au in group if au]
        house = house0_ns + int(ns(group[-1][0] - w0) / rate) + int(net_ms * 1e6)
        st = floor if floor is not None else house
        timing = [au for au in aus if au[0] == timing_pid]
        if anchor is None and timing:
            anchor = (house, timing[0][2])
        if aus and anchor is not None:
            first = (timing or aus)[0]
            st = max(st, anchor[0] + int(ns(first[2] - anchor[1]) / rate))
        floor = st
        for pid, serial, pts, dts in aus:
            if anchor is not None:
                targets[(pid, serial)] = anchor[0] + int(ns(pts - anchor[1]) / rate)
                if dts_targets is not None:
                    dts_targets[(pid, serial)] = anchor[0] + int(ns((pts if dts is None else dts)
                                                                    - anchor[1]) / rate)
        if (group[-1][0] - w0) / 90000.0 >= start_s:
            bufs.append((b"".join(p for _, p, _ in group), st))
            if arrivals is not None:
                arrivals.append(house)
    return bufs, targets


MUX_BASE = 3600 * 90000     # mpegtsmux writes running time + 1 h (ts_timeline.MUX_CLOCK_BASE_90K)


def house_egress(seconds, target, start_s=0.0, transit_ms=170.0, per_buf=7):
    """The video PID as a transform producer's identity egress carries it: its
    mux wrote every PES at content time + 1 h (`target(pts90k)` = the content ns
    of a source PTS, continuous — the producer's own input retime took any
    rewind out) and the PCR at the DTS; stamp = the buffer's first PES − 1 h
    under the monotone floor, so K = −3600 s. Returns bus buffers from `start_s`
    on as [(bytes, stamp_ns, arrival_ns)], arrival = wire + `transit_ms`, and
    every AU's target {(pid, serial): content ns}."""
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


def mux_inputs(seconds=70, jump_at_s=40.0, house0_ns=50_000 * 10**9, skew_ppm=-40.0):
    """An mpegts-muxer's two inputs as at the OCC gate: input 0 a splitter's
    passthrough AAC leg (anchored stamps, PCR on the AAC PID, the lead swinging
    0.25–0.75 s, a 427 s rewind, the source `skew_ppm` off), input 1 a
    transcoder's identity egress of the same source's video (`house_egress`;
    house time + 1 h under 2^33 ticks, so K = −3600 s exactly). The splitter
    stamps every leg off ONE anchor and the transcoder carried that content time,
    so both share one content timeline. Returns the feed [(arrival ns, input,
    bytes, stamp ns)] in arrival order, every AU's target {(pid, serial): content
    ns} and the splitter's K at its anchor."""
    rate, arrivals = 1.0 + skew_ppm / 1e6, []
    bufs_a, targets = stamp(build_packets(seconds, pids=(AUDIO_PID,), audio_lead_ms=250.0,
                                          lead_swing_ms=500.0, swing_audio=True, jump_at_s=jump_at_s),
                            2.2, house0_ns, skew_ppm, arrivals=arrivals)
    a_house, a_pts = targets[(AUDIO_PID, 0)], DTS0 + FRAME
    bufs_b, targets_b = house_egress(seconds, lambda p: a_house + int(ns(p - a_pts) / rate), start_s=2.2)
    targets.update(targets_b)
    feed = sorted([(t, 0, d, s) for (d, s), t in zip(bufs_a, arrivals)]
                  + [(t, 1, d, s) for d, s, t in bufs_b], key=lambda e: (e[0], e[1]))
    return feed, targets, a_house - ns(a_pts)


def run_demuxes(Gst, feed, targets, install=None):
    """`run_demux` for a muxer's inputs: `feed` = [(arrival, input, bytes, stamp)]
    pushed in order into `appsrc ! tsdemux name=demux_<input>`, all in ONE
    pipeline. Returns [(pid, serial, running − target ns)] in sink order."""
    n = 1 + max(e[1] for e in feed)
    pipe = Gst.parse_launch(" ".join(
        f'appsrc name=src{i} is-live=true format=time block=true max-bytes=4000000 caps="{TS_CAPS}"'
        f" ! tsdemux name=demux_{i} latency=0" for i in range(n)))
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
    pipe.use_clock(clock)
    pipe.set_start_time(Gst.CLOCK_TIME_NONE)
    pipe.set_base_time(0)
    rows = []

    def on_buf(pad, info):
        buf = info.get_buffer()
        key = au_key(buf.extract_dup(0, min(10, buf.get_size())))
        if key in targets and buf.pts != Gst.CLOCK_TIME_NONE:
            seg = pad.get_sticky_event(Gst.EventType.SEGMENT, 0).parse_segment()
            rows.append((key[0], key[1], seg.to_running_time(Gst.Format.TIME, buf.pts) - targets[key]))
        return Gst.PadProbeReturn.OK

    def on_pad(_demux, pad):
        sink = Gst.ElementFactory.make("fakesink")
        sink.set_property("sync", False)
        sink.set_property("async", False)
        pipe.add(sink)
        sink.sync_state_with_parent()
        sink.get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, on_buf)
        pad.link(sink.get_static_pad("sink"))

    for i in range(n):
        pipe.get_by_name(f"demux_{i}").connect("pad-added", on_pad)
    if install:
        install(pipe)
    pipe.set_state(Gst.State.PLAYING)
    srcs = [pipe.get_by_name(f"src{i}") for i in range(n)]
    for _t, i, data, st in feed:
        b = Gst.Buffer.new_wrapped(data)
        b.pts = b.dts = st
        srcs[i].emit("push-buffer", b)
    for src in srcs:
        src.emit("end-of-stream")
    pipe.get_bus().timed_pop_filtered(30 * Gst.SECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR)
    pipe.set_state(Gst.State.NULL)
    return rows


def run_demux(Gst, bufs, targets, ignore_pcr=False, install=None, detail=False):
    """Push `bufs` (fast, not paced) through `appsrc ! tsdemux name=demux`,
    every pad into its own fakesink, on the contract's clock. `install(pipe)`
    runs before PLAYING. Returns [(pid, serial, running − target ns)] in the
    order each pad's SINK saw them — after anything a src-pad probe dropped
    or shifted. `detail` appends the running PTS and DTS (or None)."""
    pipe = Gst.parse_launch(
        f'appsrc name=src is-live=true format=time block=true max-bytes=4000000 caps="{TS_CAPS}" ! '
        f"tsdemux name=demux latency=0" + (" ignore-pcr=true" if ignore_pcr else ""))
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
    pipe.use_clock(clock)
    pipe.set_start_time(Gst.CLOCK_TIME_NONE)
    pipe.set_base_time(0)
    rows = []

    def on_buf(pad, info):
        buf = info.get_buffer()
        key = au_key(buf.extract_dup(0, min(10, buf.get_size())))
        if key in targets and buf.pts != Gst.CLOCK_TIME_NONE:
            seg = pad.get_sticky_event(Gst.EventType.SEGMENT, 0).parse_segment()
            rt = seg.to_running_time(Gst.Format.TIME, buf.pts)
            row = (key[0], key[1], rt - targets[key])
            if detail:
                row += (rt, None if buf.dts == Gst.CLOCK_TIME_NONE
                        else seg.to_running_time(Gst.Format.TIME, buf.dts))
            rows.append(row)
        return Gst.PadProbeReturn.OK

    def on_pad(_demux, pad):
        sink = Gst.ElementFactory.make("fakesink")
        sink.set_property("sync", False)
        sink.set_property("async", False)
        pipe.add(sink)
        sink.sync_state_with_parent()
        sink.get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, on_buf)
        pad.link(sink.get_static_pad("sink"))

    pipe.get_by_name("demux").connect("pad-added", on_pad)
    if install:
        install(pipe)
    pipe.set_state(Gst.State.PLAYING)
    src = pipe.get_by_name("src")
    for data, st in bufs:
        b = Gst.Buffer.new_wrapped(data)
        b.pts = b.dts = st
        src.emit("push-buffer", b)
    src.emit("end-of-stream")
    pipe.get_bus().timed_pop_filtered(30 * Gst.SECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR)
    pipe.set_state(Gst.State.NULL)
    return rows
