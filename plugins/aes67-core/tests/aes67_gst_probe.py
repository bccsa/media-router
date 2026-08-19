#!/usr/bin/env python3
"""GStreamer probes behind the AES67 suite — run by `aes67Gst.test.ts`, never in production.

Three questions the suite must answer with real elements rather than by
assertion, each printing one JSON object on stdout:

  elements   which AES67 elements this host actually has
  rtpts      how rtpL24pay maps running time onto the RTP timestamp — the
             claim the whole PTP-epoch design rests on
  caps       whether the RFC 7273 caps string the engine helper builds
             survives gst_parse_launch and reads back intact
  loopback   a real L24 RTP hop over 127.0.0.1, PCM in vs PCM out

Kept in python (not gst-launch shell lines) because two of the four need pad
probes and buffer inspection, which gst-launch cannot do.
"""

import argparse
import json
import sys

import gi
gi.require_version("Gst", "1.0")
gi.require_version("GstApp", "1.0")
from gi.repository import Gst, GstApp  # noqa: E402,F401

Gst.init([])

ELEMENTS = ["rtpL24pay", "rtpL24depay", "rtpL16pay", "rtpL16depay",
            "rtpjitterbuffer", "udpsrc", "udpsink", "avenc_s302m", "avdec_s302m"]


def cmd_elements(_args):
    return {e: bool(Gst.ElementFactory.find(e)) for e in ELEMENTS}


def cmd_rtpts(args):
    """RTP timestamps for a run whose buffer PTS are shifted by --shift-ns.

    The shift moves RUNNING TIME (identity segment, PTS == running time), so
    comparing two runs answers "absolute running time, or relative to the first
    buffer?" — and only the absolute answer makes `timestamp-offset` an epoch.
    """
    pipeline = Gst.parse_launch(
        "audiotestsrc name=src num-buffers=%d samplesperbuffer=48 "
        "! audio/x-raw,format=S24BE,rate=48000,channels=2,layout=interleaved "
        "! identity name=id "
        "! rtpL24pay name=pay timestamp-offset=%d mtu=1452 min-ptime=1000000 max-ptime=1000000 "
        "! appsink name=out sync=false max-buffers=200" % (args.buffers, args.ts_offset)
    )

    shift = args.shift_ns

    def probe(_pad, info):
        buf = info.get_buffer()
        if buf.pts != Gst.CLOCK_TIME_NONE:
            buf.pts = buf.pts + shift
        if buf.dts != Gst.CLOCK_TIME_NONE:
            buf.dts = buf.dts + shift
        return Gst.PadProbeReturn.OK

    if shift:
        pipeline.get_by_name("id").get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, probe)

    sink = pipeline.get_by_name("out")
    pipeline.set_state(Gst.State.PLAYING)
    packets = []
    while len(packets) < args.buffers:
        # Generous: this runs inside a full `pnpm test`, where 20 other suites
        # are competing for the same cores. A short deadline here is a flaky
        # test, not a fast one.
        sample = sink.try_pull_sample(10 * Gst.SECOND)
        if sample is None:
            break
        buf = sample.get_buffer()
        ok, mi = buf.map(Gst.MapFlags.READ)
        if not ok:
            break
        header = bytes(mi.data[:12])
        buf.unmap(mi)
        packets.append({
            "pts": None if buf.pts == Gst.CLOCK_TIME_NONE else buf.pts,
            "rtpts": int.from_bytes(header[4:8], "big"),
        })
    pipeline.set_state(Gst.State.NULL)
    return {"tsOffset": args.ts_offset, "shiftNs": shift, "packets": packets}


def cmd_caps(args):
    """Parse a launch line carrying --caps and read the structure back."""
    pipeline = Gst.parse_launch('udpsrc name=s caps="%s" ! fakesink' % args.caps)
    struct = pipeline.get_by_name("s").get_property("caps").get_structure(0)
    out = {"name": struct.get_name()}
    for field in ("media", "encoding-name", "a-ts-refclk", "a-mediaclk"):
        out[field] = struct.get_string(field)
    ok, clock_rate = struct.get_int("clock-rate")
    out["clock-rate"] = clock_rate if ok else None
    ok, channels = struct.get_int("channels")
    out["channels"] = channels if ok else None
    ok, payload = struct.get_int("payload")
    out["payload"] = payload if ok else None
    return out


def _pull_all(sink, want_bytes, timeout_s):
    data = bytearray()
    deadline = timeout_s * Gst.SECOND
    while len(data) < want_bytes:
        sample = sink.try_pull_sample(deadline)
        if sample is None:
            break
        buf = sample.get_buffer()
        ok, mi = buf.map(Gst.MapFlags.READ)
        if not ok:
            break
        data += bytes(mi.data)
        buf.unmap(mi)
    return bytes(data)


def cmd_loopback(args):
    """A real AES67 hop on 127.0.0.1: PCM → L24 RTP → PCM, compared byte for byte.

    The receiver drops the packets sent before it reached PLAYING, so the test
    is a SUBSEQUENCE match (received window found inside the reference), not an
    equality — which is the honest assertion for a live UDP stream and still
    catches every byte-order, channel-order and sample-size error.
    """
    caps = ("application/x-rtp, media=(string)audio, clock-rate=(int)48000, "
            "encoding-name=(string)L24, channels=(int)2, payload=(int)96")
    rx = Gst.parse_launch(
        "udpsrc name=rxsrc address=127.0.0.1 port=%d caps=\"%s\" "
        "! rtpjitterbuffer latency=%d "
        "! rtpL24depay "
        "! appsink name=rxout sync=false max-buffers=4000" % (args.port, caps, args.latency)
    )
    # 997 Hz, not 1000: at 48 kHz a 1 kHz sine repeats every 48 samples, so ANY
    # window of it matches the reference at dozens of offsets and a match would
    # prove far less than it looks. 997 repeats only every 48000 samples — one
    # full second, longer than the whole capture — so the match is unique and
    # the test can assert that it is.
    tx = Gst.parse_launch(
        "audiotestsrc name=txsrc wave=sine freq=997 num-buffers=%d samplesperbuffer=48 "
        "! audio/x-raw,format=S24BE,rate=48000,channels=2,layout=interleaved "
        "! rtpL24pay mtu=1452 min-ptime=1000000 max-ptime=1000000 pt=96 "
        "! udpsink host=127.0.0.1 port=%d sync=false" % (args.buffers, args.port)
    )
    # Same source, same parameters, no network: what SHOULD come out the far end.
    ref = Gst.parse_launch(
        "audiotestsrc wave=sine freq=997 num-buffers=%d samplesperbuffer=48 "
        "! audio/x-raw,format=S24BE,rate=48000,channels=2,layout=interleaved "
        "! appsink name=refout sync=false max-buffers=4000" % args.buffers
    )

    ref.set_state(Gst.State.PLAYING)
    reference = _pull_all(ref.get_by_name("refout"), args.buffers * 48 * 2 * 3, 15)
    ref.set_state(Gst.State.NULL)

    rx.set_state(Gst.State.PLAYING)
    rx.get_state(10 * Gst.SECOND)         # RX bound before the first packet flies
    tx.set_state(Gst.State.PLAYING)
    # 15 s, not 5: under a loaded `pnpm test` the RX side is scheduled against
    # every other suite, and a short deadline reads a slow box as a lost stream.
    received = _pull_all(rx.get_by_name("rxout"), len(reference), 15)
    tx.set_state(Gst.State.NULL)
    rx.set_state(Gst.State.NULL)

    # Compare a window from the middle of what arrived, so neither end's
    # startup transient decides the result.
    window = received[len(received) // 4:][:args.window_bytes] if received else b""
    offset = reference.find(window) if window else -1
    matches = 0
    at = offset
    while at >= 0:
        matches += 1
        at = reference.find(window, at + 1)
    return {
        "referenceBytes": len(reference),
        "receivedBytes": len(received),
        "windowBytes": len(window),
        "matchOffset": offset,
        "matchCount": matches,
        "matched": offset >= 0,
        "receivedFraction": round(len(received) / len(reference), 3) if reference else 0,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("elements")
    p = sub.add_parser("rtpts")
    p.add_argument("--shift-ns", type=int, default=0)
    p.add_argument("--ts-offset", type=int, default=1000)
    p.add_argument("--buffers", type=int, default=5)
    p = sub.add_parser("caps")
    p.add_argument("--caps", required=True)
    p = sub.add_parser("loopback")
    p.add_argument("--port", type=int, default=15004)
    p.add_argument("--buffers", type=int, default=400)
    p.add_argument("--latency", type=int, default=20)
    p.add_argument("--window-bytes", type=int, default=4608)
    args = parser.parse_args()

    handler = {"elements": cmd_elements, "rtpts": cmd_rtpts,
               "caps": cmd_caps, "loopback": cmd_loopback}[args.cmd]
    json.dump(handler(args), sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
