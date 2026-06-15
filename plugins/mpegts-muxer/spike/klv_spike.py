#!/usr/bin/env python3
"""Phase 0 KLV spike for PLAN-MR-MPEGTS-DYN (docs/mpegts-dynamic-streams-plan.md).

The whole plan rests on one keystone: can GStreamer 1.22 carry a private KLV
metadata PID through mpegtsmux and expose it again at tsdemux, intact, on the
fleet's exact GStreamer? This script proves it end to end and runs the garbage
matrix from Phase 0 (a malformed/absent metadata PID must never crash a reader).

Run on a box with GStreamer 1.22 + Python GI + gst-plugins-bad/ugly (x264enc,
avenc_aac):

    python3 plugins/mpegts-muxer/spike/klv_spike.py

Exit 0 = PASS (Phase 0 may proceed to Phase 1). Exit 1 = FAIL (KLV path broken;
the plan's fallback is SDT and must be re-costed by a human).

Findings observed on this box are recorded in the plan doc's "Phase 0 findings"
section — keep that and this script in sync if you re-run on a different build.
"""
import functools
import os
import sys
import tempfile

import gi

gi.require_version("Gst", "1.0")
gi.require_version("GstMpegts", "1.0")
from gi.repository import GLib, Gst, GstMpegts  # noqa: E402

print = functools.partial(print, flush=True)  # noqa: A001 — segfault-safe logging
Gst.init(None)

# PID scheme from D3: video-0 -> 0x100, audio-0 -> 0x140 (+1 here = 0x141),
# metadata PID fixed. The KLV PID 0x12c (300) is arbitrary-but-fixed for the
# spike; the real module pins its own.
VIDEO_PID = 0x100
AUDIO_PID = 0x141
KLV_PID = 0x12C
KLV_PAYLOAD = b'{"v":1,"streams":[{"pid":256,"media":"video","name":"Cam 1"},{"pid":321,"media":"audio","name":"FOH Mix"}]}'


def make_ts(klv_payload, klv_copies=8, with_klv=True):
    """Mux a short H.264+AAC TS to a temp file; optionally carousel a KLV PID.

    PIDs are pinned with the mpegtsmux request-pad naming `m.sink_<pid>` — the
    same mechanism Phase 1 uses. Returns the temp file path (caller deletes).
    """
    fd, path = tempfile.mkstemp(suffix=".ts")
    os.close(fd)
    desc = (
        f"mpegtsmux name=m ! filesink location={path} "
        "videotestsrc num-buffers=150 is-live=false ! x264enc key-int-max=15 ! "
        f"h264parse ! m.sink_{VIDEO_PID} "
        "audiotestsrc num-buffers=150 is-live=false ! avenc_aac ! aacparse ! "
        f"m.sink_{AUDIO_PID}"
    )
    if with_klv:
        desc += (
            " appsrc name=klv caps=meta/x-klv,parsed=true format=time "
            f"is-live=false ! m.sink_{KLV_PID}"
        )
    pipe = Gst.parse_launch(desc)
    klv_src = pipe.get_by_name("klv")

    pushed = [0]

    def feed():
        # Carousel: one KLV buffer ~5/s with running-time stamps, then EOS.
        if not with_klv or pushed[0] >= klv_copies:
            if klv_src is not None:
                klv_src.emit("end-of-stream")
            return False
        buf = Gst.Buffer.new_wrapped(klv_payload)
        ts = pushed[0] * 200 * Gst.MSECOND
        buf.pts = ts
        buf.dts = ts
        buf.duration = 200 * Gst.MSECOND
        klv_src.emit("push-buffer", buf)
        pushed[0] += 1
        return True

    loop = GLib.MainLoop()
    bus = pipe.get_bus()
    bus.add_signal_watch()

    def on_msg(_b, m):
        if m.type == Gst.MessageType.ERROR:
            print("  mux ERROR:", m.parse_error())
            loop.quit()
        elif m.type == Gst.MessageType.EOS:
            loop.quit()
        return True

    bus.connect("message", on_msg)
    pipe.set_state(Gst.State.PLAYING)
    if with_klv:
        GLib.timeout_add(150, feed)
    GLib.timeout_add_seconds(15, lambda: (loop.quit(), False)[1])
    loop.run()
    pipe.set_state(Gst.State.NULL)
    return path


def demux_and_read(ts_path):
    """Demux a TS file; return (pads, pmt_streams, klv_bytes).

    A `queue` sits between every tsdemux pad and its appsink — without it an
    appsink linked straight onto the demux pad back-pressures the streaming
    loop and the whole TS stalls (observed on 1.22; see Phase 0 findings).
    """
    pipe = Gst.parse_launch(f"filesrc location={ts_path} ! tsdemux name=d")
    demux = pipe.get_by_name("d")
    pads, pmt, klv = [], [], bytearray()

    def on_pad(_d, pad):
        caps = pad.get_current_caps() or pad.query_caps(None)
        cs = caps.to_string() if caps else "?"
        pads.append((pad.get_name(), cs))
        q = Gst.ElementFactory.make("queue", None)
        sink = Gst.ElementFactory.make("appsink", None)
        sink.set_property("emit-signals", True)
        sink.set_property("sync", False)
        is_klv = "klv" in cs

        def on_sample(s, isk=is_klv):
            smp = s.emit("pull-sample")
            if smp and isk:
                b = smp.get_buffer()
                ok, mi = b.map(Gst.MapFlags.READ)
                if ok:
                    klv.extend(mi.data)
                    b.unmap(mi)
            return Gst.FlowReturn.OK

        sink.connect("new-sample", on_sample)
        pipe.add(q)
        pipe.add(sink)
        q.sync_state_with_parent()
        sink.sync_state_with_parent()
        q.link(sink)
        pad.link(q.get_static_pad("sink"))

    demux.connect("pad-added", on_pad)
    loop = GLib.MainLoop()
    bus = pipe.get_bus()
    bus.add_signal_watch()

    def on_msg(_b, m):
        if m.type == Gst.MessageType.ERROR:
            print("  demux ERROR:", m.parse_error())
            loop.quit()
        elif m.type == Gst.MessageType.EOS:
            loop.quit()
        elif m.type == Gst.MessageType.ELEMENT:
            sec = GstMpegts.message_parse_mpegts_section(m)
            if sec and sec.section_type == GstMpegts.SectionType.PMT:
                pm = sec.get_pmt()
                if pm:
                    for st in pm.streams:
                        pmt.append((hex(st.pid), st.stream_type))
        return True

    bus.connect("message", on_msg)
    pipe.set_state(Gst.State.PLAYING)
    GLib.timeout_add_seconds(10, lambda: (loop.quit(), False)[1])
    loop.run()
    pipe.set_state(Gst.State.NULL)
    return pads, pmt, bytes(klv)


def report(title, ok, all_ok):
    print(f"  [{'PASS' if ok else 'FAIL'}] {title}")
    return all_ok and ok


def main():
    all_ok = True

    print("== Happy path: KLV round-trips mpegtsmux -> tsdemux ==")
    ts = make_ts(KLV_PAYLOAD)
    pads, pmt, klv = demux_and_read(ts)
    os.unlink(ts)
    for n, c in pads:
        print(f"    pad {n}  caps={c}")
    print(f"    PMT streams: {pmt}")
    all_ok = report("metadata pad exposed (meta/x-klv)",
                    any("klv" in c for _, c in pads), all_ok)
    all_ok = report("KLV PID present in PMT",
                    any(p == hex(KLV_PID) for p, _ in pmt), all_ok)
    all_ok = report("KLV payload round-trips intact",
                    KLV_PAYLOAD in klv, all_ok)

    print("== No KLV PID (external encoder): absence is a non-event ==")
    ts = make_ts(b"", with_klv=False)
    pads2, _, klv2 = demux_and_read(ts)
    os.unlink(ts)
    all_ok = report("demuxes cleanly with no metadata pad",
                    not any("klv" in c for _, c in pads2) and len(klv2) == 0,
                    all_ok)

    print("== Garbage matrix: a reader must never crash on bad metadata ==")
    cases = {
        "truncated payload": KLV_PAYLOAD[:10],
        "junk bytes": bytes([0xDE, 0xAD, 0xBE, 0xEF] * 8),
        "oversized buffer (200 KB)": b"x" * 200_000,
        "single byte": b"\x00",
    }
    for name, payload in cases.items():
        try:
            ts = make_ts(payload, klv_copies=4)
            demux_and_read(ts)
            os.unlink(ts)
            all_ok = report(f"{name}: survived", True, all_ok)
        except Exception as e:  # noqa: BLE001 — the whole point is to not crash
            all_ok = report(f"{name}: EXCEPTION {e}", False, all_ok)

    print()
    print("OVERALL:", "PASS" if all_ok else "FAIL")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
