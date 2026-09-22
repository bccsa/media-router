#!/usr/bin/env python3
"""Self-checking test for the python runner's report-only TS probe (`tsProbe`).

Pinned here: the probe emits `tsprobe:pmt` — the whole PMT with each ES's raw
descriptor loop as hex, `pcrPid` and `programNumber` — for a TS that carries
NO video ES (a teletext-only service), exactly the shape the native runner's
protocol suite pins for mr-gst-runner (ADR-0019 parity; python is the
reference, ADR-0020).

Skips (exit 0) where GStreamer / PyGObject is unavailable.
"""
import importlib.util
import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
sys.path.insert(0, os.path.abspath(
    os.path.join(_HERE, "..", "..", "..", "..", "plugins", "mpegts-core", "py")))
try:
    import gi
    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
except Exception:  # pragma: no cover - env gate
    print("SKIP gst_tsprobe_test.py — GStreamer/PyGObject unavailable")
    sys.exit(0)

import ts_psi  # noqa: E402

_RUNNER = os.path.join(_HERE, "gst-pipeline-runner.py")
_spec = importlib.util.spec_from_file_location("gst_pipeline_runner", _RUNNER)
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)
Gst.init(sys.argv)

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


# Teletext descriptor: eng 888 subtitles (magazine 8 codes as 0), nor 692 subtitles.
TTX_ES_INFO = bytes.fromhex("560a" + "656e671088" + "6e6f721692")
TTX_PID, PMT_PID, PROGRAM = 0x20, 0x64, 100


def write_ts(path):
    pkts = []
    for i in range(20):
        pkts.append(ts_psi.build_pat(1, {PROGRAM: PMT_PID}, cc=i & 0xF))
        pkts.append(ts_psi.build_pmt(PMT_PID, PROGRAM, TTX_PID,
                                     [(TTX_PID, ts_psi.STREAM_TYPE_PRIVATE_PES, TTX_ES_INFO)],
                                     cc=i & 0xF))
        for j in range(5):
            pkts.append(ts_psi.null_packet(cc=(i * 5 + j) & 0xF))
    with open(path, "wb") as f:
        f.write(b"".join(pkts))


def main():
    tmp = tempfile.mkdtemp()
    ts = os.path.join(tmp, "ttx.ts")
    write_ts(ts)
    events = []
    runner.emit_plugin_event = lambda channel, payload: events.append((channel, payload))
    runner.emit_event = lambda obj: events.append(("event", obj))
    pipe = Gst.parse_launch(
        f"filesrc location={ts} blocksize=1316 ! tee name=t ! queue ! fakesink sync=false "
        "t. ! queue ! appsink name=tap")
    runner.pipeline = pipe
    check("tsProbe wires onto the tap appsink", runner._start_ts_probe(pipe, {"appsink": "tap"}))
    pipe.set_state(Gst.State.PLAYING)
    bus = pipe.get_bus()
    msg = bus.timed_pop_filtered(5 * Gst.SECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR)
    check("pipeline ran to EOS", msg is not None and msg.type == Gst.MessageType.EOS)
    pipe.set_state(Gst.State.NULL)
    runner._stop_ts_probe()

    pmts = [p for c, p in events if c == "tsprobe:pmt"]
    check("one tsprobe:pmt per PMT change (the PMT never changed)", len(pmts) == 1)
    p = pmts[0] if pmts else {}
    check("programNumber + pcrPid carried", p.get("programNumber") == PROGRAM and p.get("pcrPid") == TTX_PID)
    streams = p.get("streams") or []
    check("the teletext ES is listed with its raw descriptor hex",
          streams == [{"pid": TTX_PID, "streamType": ts_psi.STREAM_TYPE_PRIVATE_PES,
                       "esInfo": TTX_ES_INFO.hex()}])
    check("no videoinfo for a stream without video",
          not any(c == "tsprobe:videoinfo" for c, _ in events))
    check("no error events", not any(c == "event" and o.get("event") == "error" for c, o in events))

    os.unlink(ts)
    os.rmdir(tmp)
    if _failures:
        print(f"\n{len(_failures)} FAILED")
        sys.exit(1)
    print("\nall passed")


if __name__ == "__main__":
    main()
