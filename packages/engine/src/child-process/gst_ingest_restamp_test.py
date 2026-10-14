#!/usr/bin/env python3
"""Plan ch. 5 part 7.3's `ingest-restamp` for the Python runner; native_runner_protocol_test.py
runs the same case against mr-gst-runner. An SRT ingest's input, arrival in PTS, goes through
`mrtsrestamp arrival=buffer-pts` and buildBusSink in a runner, with one consumer edge attached
over unixfdsink -> unixfdsrc, and must arrive as mrts::RestampCore makes it:

  (a) every PES-bearing bus buffer's stamp is house_from_mux_pts of its first timing PES's PTS,
      exactly (the identity egress, ts_timeline.cpp `stamp_house`), with the core's bytes;
  (b) the gap markers of a live offset-ns edit, a live pid-trims edit and an outage reach the
      consumer with GAP|DISCONT, their PTS and their encoded length, also through srt-input's
      own queue (SrtInputModule.ts) between the restamp and the bus;
  (c) mrtsrestamp-stats, -pid and -event reach the engine as plugin events `<name>:restamp`,
      each equal to the core's.

The runner reads the input as GDP over TCP (`tcpclientsrc ! gdpdepay` keeps each buffer's PTS,
the arrival an appsrc would give it; filesrc on a FIFO would wait for whole 4 KB blocks), so the
test paces it: a buffer goes in once the consumer holds what the one before produced, which puts
the live edit between two known buffers and keeps every queue short. PSI-only lead-in datagrams
let the consumer join before anything that counts. cap-srt-ingest-1316.ts (chapter 3 part 7.2) is
not captured yet, so the input is ingest_restamp_fixture's stream of the same shape. Skips (exit
0) without GStreamer, the gdp, tcp or unixfd elements, or the built plugin."""
import os
import shutil
import socket
import sys
import tempfile
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst

    Gst.init(sys.argv)
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_ingest_restamp_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import ingest_restamp_fixture as fx  # noqa: E402
from gst_native_plugins_test import Runner, ev_is  # noqa: E402
from ingest_restamp_fixture import MS, S, PID_A, PID_V, TICK, TS_CAPS  # noqa: E402

PY_RUNNER = [sys.executable, os.path.join(_HERE, "gst-pipeline-runner.py")]
# A mutant tree when set, as the runners resolve it; the reference is always this repo's.
_PLUGINS = os.environ.get("MR_PLUGINS_DIR") or os.path.join(fx.ROOT, "plugins")
_SO = os.path.join(_PLUGINS, "mpegts-core", "native", "mrtshouse", "libgstmrtshouse.so")
_LATENESS = os.path.join(_PLUGINS, "mpegts-core", "native", "mrlateness", "libgstmrlateness.so")
NONE = Gst.CLOCK_TIME_NONE
GAP = int(Gst.BufferFlags.GAP)
GAP_FLAGS = int(Gst.BufferFlags.GAP | Gst.BufferFlags.DISCONT)
PORT = 40110
# srt-input's queue between the transport and the bus (SrtInputModule.ts buildPipeline).
SRT_QUEUE = "queue leaky=2 max-size-time=100000000 flush-on-eos=true"
STATS_MS = 1000
EDIT_NS = 500 * MS
TRIM_NS = 200 * MS   # on the audio PID, as the engine writes it (ingestTiming.ts)
GARBAGE = 37         # bytes the walker skips to regain sync: the core's copy path
LEAD_IN = 15   # PAT CCs 0..14 name the lead-in datagram a consumer's first buffer is
CHANNELS = ("mrtsrestamp-stats", "mrtsrestamp-pid", "mrtsrestamp-event")


def bus_sink(port):
    """busHelpers.ts buildBusSink: the pinned caps, the lateness tap where it is built, the tee."""
    tap = (f" ! mrlateness name=lat_busout_{port} reference=house"
           if os.path.exists(_LATENESS) else "")
    return (f'capssetter caps="{TS_CAPS}" replace=true ! capsfilter caps="{TS_CAPS}"{tap}'
            f" ! tee name=busout_{port} allow-not-linked=true")


def plan(now):
    """The records: lead-in, 10 s of stream, O +500 ms at 3 s, a +200 ms audio trim at 4.5 s,
    1.5 s of silence at 6 s, 37 bytes of garbage at 8.5 s, a lost packet at 9 s, EOS. Arrival
    runs a minute ahead of the egress's clock, so no stamp meets its first floor."""
    st = fx.Stream(10, h0=now + 60 * S, outage=(6 * S, 7500 * MS), lead_in=LEAD_IN)
    edits = [(3 * S, ("O", EDIT_NS)), (4500 * MS, ("T", {PID_A: TRIM_NS}))]
    records, garbage, lost = [], False, False
    for i, (arrival, data) in enumerate(st.datagrams):
        t = st.mux(arrival)
        while edits and i >= LEAD_IN and t >= edits[0][0]:
            records.append(edits.pop(0)[1])
        if not garbage and t >= 8500 * MS:
            data, garbage = data[:2 * fx.PKT] + bytes(range(GARBAGE)) + data[2 * fx.PKT:], True
        elif not lost and t >= 9 * S:
            data, lost = data[:fx.PKT] + data[2 * fx.PKT:], True
        records.append(("B", arrival, data))
    return records + [("E",)]


def gdp_chunks(buffers):
    """`buffers` (PTS, bytes) as gdppay writes them: the prelude (stream-start, caps, segment)
    and one chunk per buffer."""
    pipe = Gst.parse_launch(f'appsrc name=src format=time caps="{TS_CAPS}" ! gdppay '
                            "! appsink name=sink sync=false")
    src, sink = pipe.get_by_name("src"), pipe.get_by_name("sink")
    pipe.set_state(Gst.State.PLAYING)
    for pts, data in buffers:
        b = Gst.Buffer.new_wrapped(data)
        b.pts, b.dts, b.duration = pts, NONE, NONE
        src.emit("push-buffer", b)
    src.emit("end-of-stream")
    chunks = []
    while True:
        sample = sink.emit("try-pull-sample", 5 * Gst.SECOND)
        if sample is None:
            break
        b = sample.get_buffer()
        head = bool(b.get_flags() & Gst.BufferFlags.HEADER)
        chunks.append((head, b.extract_dup(0, b.get_size())))
    pipe.set_state(Gst.State.NULL)
    prelude = b"".join(c for head, c in chunks if head)
    body = [c for head, c in chunks if not head]
    return prelude, body if len(body) == len(buffers) else None


def accept_input(server, timeout=10.0):
    """The runner's tcpclientsrc connection, unbuffered, or None."""
    server.settimeout(timeout)
    try:
        conn, _ = server.accept()
    except OSError:
        return None
    conn.settimeout(10.0)
    conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    return conn


def wait_for(cond, timeout):
    deadline = time.monotonic() + timeout
    while not cond():
        if time.monotonic() > deadline:
            return False
        time.sleep(0.0005)
    return True


def plugin_events(r, channel):
    r.pump()
    return [ev.get("payload") for ev in r.events
            if ev.get("event") == "plugin_event" and ev.get("channel") == f"{channel}:restamp"]


def ingest_restamp_case(argv, tag, check, srt_queue=False, now=None):
    """Part 7.3's case through `argv`'s runner (srt_queue: srt-input's module string). `now`
    places the input (CLOCK_MONOTONIC ns; default the clock): one value gives runs the same
    input, so their events compare. Returns the plugin events per channel as the runner
    forwarded them, or None when it could not run."""
    label = f"ingest-restamp {tag}" + (" srt-input queue" if srt_queue else "")
    for el in ("gdppay", "gdpdepay", "tcpclientsrc", "unixfdsink", "unixfdsrc", "capssetter"):
        if Gst.ElementFactory.find(el) is None:
            print(f"SKIP {label} — {el} unavailable")
            return None
    if not os.path.exists(_SO):
        print(f"SKIP {label} — {_SO} not built (make native)")
        return None
    made = fx.build_reference()
    if made:
        check(f"{label}: the reference tests/restamp_ref builds ({made})", False)
        return None
    clock = Gst.SystemClock.obtain()
    clock.set_property("clock-type", Gst.ClockType.MONOTONIC)
    tmp = tempfile.mkdtemp(prefix="mrtest-")
    edge = os.path.join(tmp, "edge.sock")
    empty = os.path.join(tmp, "libexec")
    os.makedirs(empty)
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.bind(("127.0.0.1", 0))
    server.listen(1)
    records = plan(clock.get_time() if now is None else now)
    ref = fx.reference(records, tmp, stats_ms=STATS_MS)
    want = fx.expected_items(records, ref)
    counts = fx.items_per_buffer(records, ref)
    bufs = [r for r in records if r[0] == "B"]
    prelude, chunks = gdp_chunks([(r[1], r[2]) for r in bufs])
    if chunks is None:
        check(f"{label}: gdppay writes one chunk per buffer", False)
        return None
    chunk_of = {id(r): c for r, c in zip(bufs, chunks)}

    pipeline = (f"tcpclientsrc host=127.0.0.1 port={server.getsockname()[1]} ! gdpdepay "
                "! mrtsrestamp name=restamp "
                f"arrival=buffer-pts stats-interval-ms={STATS_MS}"
                + (f" ! {SRT_QUEUE}" if srt_queue else "") + " ! " + bus_sink(PORT))
    r = Runner(argv, _PLUGINS, empty)
    consumer, conn, got = None, None, []
    try:
        r.send({"cmd": "start", "pipeline": pipeline, "houseTimelineEgress": True,
                "restartOnError": False,
                "busReports": [{"element": "restamp", "structure": c} for c in CHANNELS]})
        conn = accept_input(server)   # the runner's start connects
        check(f"{label}: the runner connects to the input", conn is not None)
        started = r.wait_event(lambda e: e.get("event") in ("started", "error"))
        check(f"{label}: starts with the plugin loaded (got {started})",
              started is not None and started.get("event") == "started"
              and started.get("timingPlugin") is not None)
        check(f"{label}: reaches PLAYING",
              r.wait_event(ev_is("state_change", state="playing")) is not None)
        r.send({"cmd": "bus_attach", "tee": f"busout_{PORT}", "socket": edge})
        check(f"{label}: bus_attach -> bus_attached",
              r.wait_event(ev_is("bus_attached", socket=edge)) is not None)
        armed = f"timeline armed on busout_{PORT} (house-timeline egress"

        def is_armed():
            r.pump()
            return any(armed in line and "native mrtsstamp" in line for line in r.logs)
        check(f"{label}: the edge arms the native stamper as an identity egress",
              wait_for(is_armed, 3.0))
        if conn is None or started is None or started.get("event") != "started":
            return None

        consumer = Gst.parse_launch(f"unixfdsrc socket-path={edge} "
                                    "! fakesink name=csink sync=false")
        # Base 0 on the house clock, as a runner pins a contract pipeline: a buffer's PTS is
        # then the wire's house time.
        consumer.use_clock(clock)
        consumer.set_start_time(NONE)
        consumer.set_base_time(0)

        def on_buf(_pad, info):
            b = info.get_buffer()
            got.append((b.pts, b.dts, b.duration, int(b.get_flags()),
                        b.extract_dup(0, b.get_size())))
            return Gst.PadProbeReturn.OK

        consumer.get_by_name("csink").get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER,
                                                                        on_buf)
        consumer.set_state(Gst.State.PLAYING)
        consumer.get_state(3 * Gst.SECOND)

        # The lead-in until the consumer has one: whatever it missed before is lead-in only.
        conn.sendall(prelude)
        lost, at = None, 0
        while at < LEAD_IN:
            conn.sendall(chunk_of[id(records[at])])
            at += 1
            if wait_for(lambda: got, 0.3):
                lost = got[0][4][3] & 0x0F   # the PAT's CC: the first lead-in it holds
                break
        check(f"{label}: the consumer joins within the lead-in (missed {lost} of {LEAD_IN})",
              lost is not None and lost < at)
        if lost is None:
            return None
        acked = True
        for i in range(at, len(records)):
            rec = records[i]
            if rec[0] == "B":
                conn.sendall(chunk_of[id(rec)])
                if not wait_for(lambda n=counts[i] - lost: len(got) >= n, 5.0):
                    break
            elif rec[0] in "OT":
                # Live, between two buffers: the element takes it at the next one.
                prop, value = (("offset-ns", rec[1]) if rec[0] == "O" else
                               ("pid-trims", ";".join(f"{p}={ns}" for p, ns in rec[1].items())))
                r.send({"cmd": "set_property", "id": prop, "element": "restamp",
                        "property": prop, "value": value})
                acked &= r.wait_event(ev_is("property_set", id=prop)) is not None
            else:
                conn.close()   # EOS
                conn = None
        check(f"{label}: the live offset-ns and pid-trims edits are acknowledged", acked)
        check(f"{label}: the input runs to EOS", r.wait_event(ev_is("eos"), timeout=10) is not None)
        want_n = {c: n for c, n in zip(CHANNELS, (
            sum(len(p) for p, _ in fx.ref_stats(ref)), sum(len(q) for _, q in fx.ref_stats(ref)),
            len(fx.ref_events(ref))))}
        wait_for(lambda: all(len(plugin_events(r, c)) >= want_n[c] for c in CHANNELS), 5.0)
        wait_for(lambda: len(got) >= len(want) - lost, 2.0)
    finally:
        if conn is not None:
            conn.close()
        server.close()
        if consumer is not None:
            consumer.set_state(Gst.State.NULL)
        r.close()
        shutil.rmtree(tmp, ignore_errors=True)

    # (a) and (b): what the consumer holds is the core's output from its first buffer on, each
    # data buffer on its identity stamp, each marker as the element made it.
    expect = want[lost:]
    stamps = fx.identity_stamps(want, clock.get_time())[lost:]
    kinds = [("gap" if f & GAP else "data", data) for _, _, _, f, data in got]
    check(f"{label}: every buffer and marker reaches the consumer in order with the core's bytes "
          f"({len(got)} of {len(expect)})", kinds == [(k, d) for k, _, _, d in expect])
    data_ok = [(g[0], s) for g, (k, *_), s in zip(got, expect, stamps) if k == "data"]
    first = next((s for _, s in data_ok if s is not None), None)
    pes_bearing = sum(1 for (k, _, _, d) in expect if k == "data" and fx.first_timing_pts(d))
    check(f"{label}: (a) each data buffer's stamp is house_from_mux_pts of its first timing PES's "
          f"PTS, never below the last ({pes_bearing} PES-bearing of {len(data_ok)})",
          len(data_ok) == sum(1 for k, *_ in expect if k == "data") and pes_bearing > 300
          and all(p == s if s is not None else p <= first for p, s in data_ok))
    marks = [(g, e) for g, e in zip(got, expect) if e[0] == "gap"]
    check(f"{label}: (b) each marker: GAP|DISCONT, PTS the gap's end, no duration, its length "
          f"in the private data ({len(marks)} markers)",
          len(marks) == 5 and all(g[3] & GAP_FLAGS == GAP_FLAGS and g[0] == e[1] and g[2] == NONE
                                  and g[4] == e[3] for g, e in marks))
    pl = [(fx.pkt_pid(e[3]), fx.gap_length(e[3])) for _, e in marks]
    edit, trim, outage = sorted(pl[:2]), pl[2:3], sorted(pl[3:])
    check(f"{label}: (b) the O edit marks each PID by 500 ms ({edit}), the trim the audio PID by "
          f"200 ms ({trim}), the 1.5 s silence each PID by about its length ({outage})",
          [p for p, _ in edit] == [PID_V, PID_A] and all(abs(n - EDIT_NS) <= TICK for _, n in edit)
          and [p for p, _ in trim] == [PID_A] and abs(trim[0][1] - TRIM_NS) <= TICK
          and [p for p, _ in outage] == [PID_V, PID_A]
          and all(1400 * MS <= n <= 1600 * MS for _, n in outage))
    # (c) the element's messages, as the engine receives them.
    events = {c: plugin_events(r, c) for c in CHANNELS}
    last = events["mrtsrestamp-stats"][-1] if events["mrtsrestamp-stats"] else {}
    check(f"{label}: (c) mrtsrestamp-stats:restamp carries the core's stats per program per "
          f"interval ({len(events['mrtsrestamp-stats'])} events; desync-bytes "
          f"{last.get('desync-bytes')}, cc-lost {last.get('cc-lost')})",
          events["mrtsrestamp-stats"] == [p for ps, _ in fx.ref_stats(ref) for p in ps]
          and len(events["mrtsrestamp-stats"]) >= 10 and last.get("desync-bytes") == GARBAGE
          and last.get("cc-lost", 0) >= 1)
    check(f"{label}: (c) mrtsrestamp-pid:restamp carries the core's per-PID stats "
          f"({len(events['mrtsrestamp-pid'])} events)",
          events["mrtsrestamp-pid"] == [q for _, qs in fx.ref_stats(ref) for q in qs])
    kinds_seen = sorted({e["kind"] for e in events["mrtsrestamp-event"]})
    check(f"{label}: (c) mrtsrestamp-event:restamp carries the core's events ({kinds_seen})",
          events["mrtsrestamp-event"] == fx.ref_events(ref)
          and {"gap", "psi-change"} <= set(kinds_seen))
    errors = [e for e in r.events if e.get("event") == "error"]
    check(f"{label}: no error event ({errors[:1]})", not errors)
    return events


if __name__ == "__main__":
    _failures = []

    def _check(name, cond):
        print(("PASS " if cond else "FAIL ") + name)
        if not cond:
            _failures.append(name)

    ingest_restamp_case(PY_RUNNER, "py", _check)
    ingest_restamp_case(PY_RUNNER, "py", _check, srt_queue=True)
    if _failures:
        print(f"\n{len(_failures)} FAILED: {_failures}")
        sys.exit(1)
    print("\ngst_ingest_restamp_test.py: all checks passed")
