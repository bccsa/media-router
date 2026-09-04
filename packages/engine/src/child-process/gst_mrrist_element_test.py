#!/usr/bin/env python3
"""Self-checking loopback test for the NATIVE RIST elements (`mrristsink` /
`mrristsrc`, plugins/rist-core/native/mrrist).

A paced fakesrc feeds `mrristsink` (caller) over 127.0.0.1 to `mrristsrc`
(listener) in a second pipeline, main profile with AES-128, and the test pins:

  --  The runner's own resolver (`gst_rist_native`) finds and loads the
      plugin (no GST_PLUGIN_PATH).
  --  Bytes out == bytes in (every payload arrives, nothing duplicated), and
      the sink/src `packets` counters agree with the wire.
  --  Received buffers are 188-aligned and at least one carries several
      packets: the src folds what librist already released into one buffer.
  --  Both elements post `mrrist-stats` bus messages carrying librist's JSON
      (sender-stats / receiver-stats) — the module's stats channel.
  --  Tearing both pipelines down does not hang (src `unlock` works).

Skips (exit 0) where GStreamer / PyGObject is unavailable or the plugin has
not been built (`make native`).

Run:  python3 gst_mrrist_element_test.py
"""
import os
import sys
import time

try:
    import gi
    gi.require_version("Gst", "1.0")
    from gi.repository import Gst, GLib  # noqa: F401
except Exception as e:  # noqa: BLE001
    print(f"SKIP gst_mrrist_element_test.py: GStreamer/PyGObject unavailable ({e})")
    sys.exit(0)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
Gst.init(sys.argv[:1])
import gst_rist_native  # noqa: E402

if not gst_rist_native.load_plugin():
    print("SKIP gst_mrrist_element_test.py: libgstmrrist.so not built (make native)")
    sys.exit(0)

PORT = 15977
SECRET = "loopback-test-secret"
PKT = 1316
PPS = 1000
SECONDS = 3.0


def fail(msg):
    print(f"FAIL gst_mrrist_element_test.py: {msg}")
    sys.exit(1)


received = {"bytes": 0, "buffers": 0, "multi": 0, "unaligned": 0}
stats = {"sender": 0, "receiver": 0}


def on_rx(pad, info):
    buf = info.get_buffer()
    n = buf.get_size()
    received["bytes"] += n
    received["buffers"] += 1
    if n % 188:
        received["unaligned"] += 1
    if n > PKT:
        received["multi"] += 1
    return Gst.PadProbeReturn.OK


def watch_stats(bus, who):
    def on_msg(_bus, msg):
        if msg.type == Gst.MessageType.ELEMENT:
            s = msg.get_structure()
            if s and s.get_name() == "mrrist-stats":
                js = s.get_string("json") or ""
                if "sender-stats" in js:
                    stats["sender"] += 1
                if "receiver-stats" in js:
                    stats["receiver"] += 1
        elif msg.type == Gst.MessageType.ERROR:
            err, dbg = msg.parse_error()
            fail(f"{who} pipeline error: {err.message} ({dbg})")
    bus.add_signal_watch()
    bus.connect("message", on_msg)


rx = Gst.parse_launch(
    f'mrristsrc name=src urls="rist://@127.0.0.1:{PORT}?cname=loop" profile=1 buffer=300 '
    f'secret="{SECRET}" aes-type=128 stats-interval=500 ! fakesink sync=false')
src = rx.get_by_name("src")
src.get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, on_rx)
watch_stats(rx.get_bus(), "receiver")

# A `valve` gates the paced source: RIST drops payloads written before the
# peer handshake authenticates (protocol behaviour, not a bug), so the stream
# is opened only once the link is up and closed before the drain wait. The
# sink's `packets` counter (post-valve) is the ground truth for what was sent.
tx = Gst.parse_launch(
    f'fakesrc is-live=true sync=true sizetype=fixed sizemax={PKT} datarate={PKT * PPS} ! '
    f'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! '
    f'valve name=gate drop=true ! '
    f'mrristsink name=snk urls="rist://127.0.0.1:{PORT}?cname=loop&weight=5" profile=1 buffer=300 '
    f'secret="{SECRET}" aes-type=128 stats-interval=500')
snk = tx.get_by_name("snk")
gate = tx.get_by_name("gate")
watch_stats(tx.get_bus(), "sender")

loop = GLib.MainLoop()
ctx = loop.get_context()


def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        ctx.iteration(False)
        time.sleep(0.005)


if rx.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
    fail("receiver pipeline refused to go PLAYING")
pump(0.5)
if tx.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
    fail("sender pipeline refused to go PLAYING")

pump(1.5)                       # handshake / authentication
gate.set_property("drop", False)
pump(SECONDS)                   # stream
gate.set_property("drop", True)
pump(1.5)                       # a recovery buffer's worth of drain

sent_pkts = snk.get_property("packets")
recv_pkts = src.get_property("packets")
expected_bytes = sent_pkts * PKT

t0 = time.time()
tx.set_state(Gst.State.NULL)
rx.set_state(Gst.State.NULL)
teardown = time.time() - t0

print(f"sent {sent_pkts} pkts, received {recv_pkts} pkts / {received['bytes']} B in "
      f"{received['buffers']} buffers ({received['multi']} multi-packet), stats msgs "
      f"sender={stats['sender']} receiver={stats['receiver']}, teardown {teardown * 1000:.0f} ms")

if sent_pkts < int(PPS * SECONDS * 0.8):
    fail(f"sink wrote only {sent_pkts} payloads in {SECONDS}s at {PPS} pps")
# librist's receiver holds the LAST packet of a flow until a successor arrives
# (release is driven by the following packet), so a closed stream is allowed
# to be short by exactly one payload — the same with the python drain.
if not (expected_bytes - PKT <= received["bytes"] <= expected_bytes):
    fail(f"received {received['bytes']} B, expected {expected_bytes} (±1 packet)")
if not (sent_pkts - 1 <= recv_pkts <= sent_pkts):
    fail(f"src counted {recv_pkts} payloads, sink {sent_pkts}")
if received["unaligned"]:
    fail(f"{received['unaligned']} received buffers not 188-aligned")
if received["multi"] == 0:
    fail("no multi-packet buffers: src is not batching already-released packets")
if stats["sender"] == 0 or stats["receiver"] == 0:
    fail(f"missing mrrist-stats messages (sender={stats['sender']} receiver={stats['receiver']})")
if teardown > 3.0:
    fail(f"teardown took {teardown:.1f} s — src unlock not honoured")
print("OK gst_mrrist_element_test.py")
