#!/usr/bin/env python3
"""The GStreamer and player behaviours Phase 5 builds on, pinned before anything depends on them
(house-clock plan chapter 9, the Phase 5 plan's p5-0; register B-218). The egress writer bumps its
PMT version and an `MRHT` registration descriptor at every D_e change and writes a raise as a
flagged backward PCR step; Trust reads L from the transport. Streams are encoded here (x264enc,
avenc_mp2, mpegtsmux) and rewritten in Python, nothing committed:

  1. stock tsdemux on a stream whose PMT changes only its version and a program_info `MRHT`
     registration descriptor every 2 s: two pads added at the start, none added or removed after,
     both fed to the end; one section message per PMT version (mpegtsbase.c
     mpegts_base_is_same_program);
  4. the runners' TS probe (gates.cpp on_pmt, the Python runner's _on_pmt) in both runners: one
     `tsprobe:pmt` over such bumps, two when the last version adds a stream; the Python runner's
     ts_psi.PsiDiscovery reports the bumped stream once (cases 2, 3 and the splitter's half of 4
     are C++: demux_core_test, ts_psi_test, ts_restamp_test, ts_split_test);
  5. srtsrc stats carry `negotiated-latency-ms` = max(sender, receiver) on a loopback
     caller/listener pair at 500/800 ms, both ways round (gstsrtobject.c);
  6. a bare rtpjitterbuffer reports `latency` 200 (the default L for RTP, OQ-38);
  7. tsparse alignment=7 set-timestamps=false leaves every packet it outputs byte-identical, the
     flagged PCR and the bumped PMT included; at EOS it drops an incomplete last group of 7;
  8. a 17th memory inserted into a buffer (GST_BUFFER_MEM_MAX 16) merges the 16 before it into one
     new memory, a copy of all their bytes, and appends the 17th: two memories;
  9. ffprobe -show_packets and an ffmpeg decode of a stream with a PMT version bump, then one
     flagged backward PCR step of 1.5 s, report no error; VLC (cvlc) plays a 1.0 s step clean and
     its log for the 1.5 s step is printed as RECORD lines, not judged (register B-218).

No gate case: loopback SRT runs on the dev Pi. srtsrc and rtpjitterbuffer are Debian's 1.22 there,
so DEV-P5a re-runs this file on a box (1.28.2 throughout). Skips (exit 0) without GStreamer; a case
whose element or tool is absent skips with a line."""
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    gi.require_version("GstMpegts", "1.0")
    from gi.repository import Gst, GstMpegts
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_egress_pins_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", "..", "..", ".."))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(REPO, "plugins", "mpegts-core", "py"))
import ts_psi  # noqa: E402

Gst.init([])
GstMpegts.initialize()

S = Gst.SECOND
PKT = 188
PCR_HZ = 27000000
PMT_PID_PSI = 0x30          # case 4's hand-built PSI-only stream
VIDEO_PID_PSI = 0x65

_failures = []


def check(name, cond, info=""):
    print(("PASS " if cond else "FAIL ") + name + (f" ({info})" if info else ""))
    if not cond:
        _failures.append(name)


def skip(name, why):
    print(f"SKIP {name} — {why}")


def missing(*factories):
    return [f for f in factories if Gst.ElementFactory.find(f) is None]


def version_of(factory):
    f = Gst.ElementFactory.find(factory)
    p = f and f.get_plugin()
    return p.get_version() if p else "?"


# --- the streams ---------------------------------------------------------------------------------

def mrht(n):
    """A registration descriptor, format_identifier `MRHT`, its 4 extra bytes n (the writer's
    descriptor stands in: only its bytes change)."""
    return bytes([0x05, 8]) + b"MRHT" + n.to_bytes(4, "big")


def pmt_section(program, pcr_pid, streams, es_info, version, program_info):
    """A PMT section with a program_info loop, CRC included (ts_psi.build_pmt writes none)."""
    body = bytearray([0x02, 0, 0, program >> 8, program & 0xFF, 0xC1 | ((version & 0x1F) << 1), 0, 0,
                      0xE0 | (pcr_pid >> 8), pcr_pid & 0xFF,
                      0xF0 | (len(program_info) >> 8), len(program_info) & 0xFF])
    body += program_info
    for pid, stype in streams:
        info = es_info.get(pid, b"")
        body += bytes([stype, 0xE0 | (pid >> 8), pid & 0xFF, 0xF0 | (len(info) >> 8), len(info) & 0xFF]) + info
    n = len(body) - 3 + 4
    body[1], body[2] = 0xB0 | (n >> 8), n & 0xFF
    return bytes(body) + ts_psi.crc32_mpeg(bytes(body)).to_bytes(4, "big")


def section_packet(pid, cc, section):
    p = bytes([0x47, 0x40 | (pid >> 8), pid & 0xFF, 0x10 | (cc & 0x0F), 0]) + section
    return p + b"\xff" * (PKT - len(p))


def set_pcr(pkt, pcr27, flag):
    p = bytearray(pkt)
    base, ext = pcr27 // 300, pcr27 % 300
    p[6:12] = bytes([(base >> 25) & 0xFF, (base >> 17) & 0xFF, (base >> 9) & 0xFF, (base >> 1) & 0xFF,
                     ((base & 1) << 7) | 0x7E | (ext >> 8), ext & 0xFF])
    if flag:
        p[5] |= 0x80                      # discontinuity_indicator
    return bytes(p)


def encode(path, secs=6):
    """H.264 (the PCR) and MPEG-1 Layer II through mpegtsmux: decodable content."""
    p = Gst.parse_launch(
        f"videotestsrc num-buffers={secs * 25} ! video/x-raw,width=320,height=240,framerate=25/1 "
        "! x264enc speed-preset=ultrafast key-int-max=25 bframes=0 ! h264parse ! mux. "
        f"audiotestsrc num-buffers={secs * 48000 // 1152} samplesperbuffer=1152 "
        "! audio/x-raw,rate=48000,channels=2 ! avenc_mp2 ! mux. "
        f"mpegtsmux name=mux ! filesink location={path}")
    p.set_state(Gst.State.PLAYING)
    m = p.get_bus().timed_pop_filtered(120 * S, Gst.MessageType.EOS | Gst.MessageType.ERROR)
    p.set_state(Gst.State.NULL)
    return m is not None and m.type == Gst.MessageType.EOS


def rewrite(data, bumps, step_at=None, step_s=1.5):
    """Every PMT rebuilt with an `MRHT` program_info whose bytes and version count the bump times
    passed (seconds of PCR); from step_at on every PCR is step_s earlier, the first one flagged."""
    pkts = [data[i:i + PKT] for i in range(0, len(data) - PKT + 1, PKT)]
    pat = ts_psi.parse_pat([p for p in pkts[:400] if ts_psi.ts_pid(p) == 0])
    program, pmt_pid = next(iter(pat.items()))
    pmt = ts_psi.parse_pmt([p for p in pkts[:800] if ts_psi.ts_pid(p) == pmt_pid], pmt_pid)
    first = last = None
    flagged = False
    out = []
    for p in pkts:
        r = ts_psi.read_pcr(p)
        if r is not None:
            first = r if first is None else first
            last = r
            if step_at is not None and r - first >= step_at * PCR_HZ:
                p = set_pcr(p, r - int(step_s * PCR_HZ), not flagged)
                flagged = True
        if ts_psi.ts_pid(p) == pmt_pid and ts_psi.ts_pusi(p):
            t = 0 if last is None else (last - first) / PCR_HZ
            v = sum(1 for b in bumps if t >= b)
            p = section_packet(pmt_pid, p[3], pmt_section(program, pmt["pcr_pid"], pmt["streams"],
                                                         pmt["es_info"], v, mrht(v)))
        out.append(p)
    return b"".join(out)


def psi_only(versions):
    """PAT and PMT only, as gst_tsprobe_test builds them: (version, streams) every 5 cycles."""
    out = []
    for i, (version, streams) in enumerate(v for v in versions for _ in range(5)):
        out.append(ts_psi.build_pat(1, {1: PMT_PID_PSI}, cc=i))
        out.append(section_packet(PMT_PID_PSI, i, pmt_section(1, VIDEO_PID_PSI, streams, {}, version,
                                                              mrht(version))))
        out += [ts_psi.null_packet(cc=(i * 4 + j) & 0xF) for j in range(4)]
    return b"".join(out)


def run_to_eos(desc, timeout=60):
    p = Gst.parse_launch(desc)
    p.set_state(Gst.State.PLAYING)
    m = p.get_bus().timed_pop_filtered(timeout * S, Gst.MessageType.EOS | Gst.MessageType.ERROR)
    p.set_state(Gst.State.NULL)
    return m is not None and m.type == Gst.MessageType.EOS


# --- 1: stock tsdemux ----------------------------------------------------------------------------

def case1(bump_ts):
    if missing("tsdemux"):
        return skip("1", "tsdemux absent")
    p = Gst.parse_launch(f"filesrc location={bump_ts} ! tsdemux name=d latency=0")
    d = p.get_by_name("d")
    ev, last_pts = [], {}

    def added(_e, pad):
        ev.append(("added", pad.get_name()))
        sink = Gst.ElementFactory.make("fakesink")
        sink.set_property("sync", False)
        sink.set_property("async", False)
        p.add(sink)
        sink.sync_state_with_parent()
        pad.link(sink.get_static_pad("sink"))
        name = pad.get_name()

        def on_buf(_pad, info):
            last_pts[name] = info.get_buffer().pts
            return Gst.PadProbeReturn.OK
        pad.add_probe(Gst.PadProbeType.BUFFER, on_buf)

    d.connect("pad-added", added)
    d.connect("pad-removed", lambda _e, pad: ev.append(("removed", pad.get_name())))
    versions = []
    bus = p.get_bus()
    p.set_state(Gst.State.PLAYING)
    eos = False
    while True:
        m = bus.timed_pop(30 * S)
        if m is None or m.type == Gst.MessageType.ERROR:
            break
        if m.type == Gst.MessageType.EOS:
            eos = True
            break
        sec = GstMpegts.message_parse_mpegts_section(m) if m.type == Gst.MessageType.ELEMENT else None
        if sec and sec.section_type == GstMpegts.SectionType.PMT:
            versions.append(sec.version_number)
    at_eos = list(ev)                     # tsdemux removes its pads at the stop after
    p.set_state(Gst.State.NULL)
    adds = [n for k, n in at_eos if k == "added"]
    check("1: tsdemux over three PMT versions that differ only in version and an MRHT program_info: "
          "two pads added at the start, none added or removed after, to EOS",
          eos and len(adds) == 2 and at_eos == [("added", n) for n in adds], f"{at_eos}, tsdemux "
          f"{version_of('tsdemux')}")
    check("1: ... both pads fed to the end (the last buffer past 5.9 s)",
          len(last_pts) == 2 and all(v is not None and v > 59 * S // 10 for v in last_pts.values()),
          f"{ {k: v / S for k, v in last_pts.items()} }")
    check("1: ... one PMT section message per version", versions == [0, 1, 2], f"{versions}")


# --- 4: the runners' TS probe --------------------------------------------------------------------

def case4(bump_ts, tmp):
    disc = ts_psi.PsiDiscovery()
    data = open(bump_ts, "rb").read()
    fired = sum(1 for i in range(0, len(data), 7 * PKT)
                if disc.feed([data[j:j + PKT] for j in range(i, min(i + 7 * PKT, len(data)), PKT)
                              if ts_psi.ts_pid(data[j:j + PKT]) in (0, disc.pmt_pid)]))
    check("4: the Python runner's ts_psi.PsiDiscovery reports the bumped stream once", fired == 1, f"{fired}")
    try:
        import aligner_rig as rig
    except ImportError as exc:
        return skip("4: in the runners", f"the runner rig does not import ({exc})")
    avc = [(VIDEO_PID_PSI, ts_psi.STREAM_TYPE_AVC)]
    streams = {
        "bumps": (psi_only([(0, avc), (1, avc), (2, avc), (3, avc)]), 1),
        "a stream added": (psi_only([(0, avc), (1, avc), (2, avc + [(0x66, ts_psi.STREAM_TYPE_AAC)])]), 2),
    }
    kinds = rig.runner_kinds()
    if not any(k == "native" for k, _ in kinds):
        skip("4: in mr-gst-runner", f"{rig.NATIVE_BIN} not built (make native)")
    for label, (ts, want) in streams.items():
        path = os.path.join(tmp, "psi.ts")
        with open(path, "wb") as f:
            f.write(ts)
        for kind, argv in kinds:
            r = rig.Runner(argv)
            try:
                # blocksize=1316: whole packets per buffer (ADR-0011), as the runners' case J.
                playing = r.start({"pipeline": f"filesrc location={path} blocksize=1316 ! tee name=t "
                                               "! queue ! fakesink sync=false t. ! queue ! appsink name=tap",
                                   "tsProbe": {"appsink": "tap"}})
                eos = r.wait(lambda e: e.get("event") == "eos", 15)
                pmts = r.plugin("tsprobe:pmt")
                infos = r.plugin("tsprobe:videoinfo")
                check(f"4: {kind} runner's TS probe, {label}: {want} tsprobe:pmt, the video ES "
                      "probed once, no error",
                      playing is not None and eos is not None and len(pmts) == want and len(infos) == 1
                      and not r.errors(), f"{len(pmts)} pmt, {len(infos)} videoinfo")
            finally:
                r.stop()


# --- 5: srtsrc's negotiated-latency-ms -----------------------------------------------------------

def free_udp_port():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def srt_pair(listener_ms, caller_ms):
    """srtsrc listening at listener_ms, srtsink calling at caller_ms: srtsrc's callers' values."""
    port = free_udp_port()
    rx = Gst.parse_launch(f"srtsrc name=src uri=srt://127.0.0.1:{port}?mode=listener latency={listener_ms} "
                          "! fakesink sync=false")
    tx = Gst.parse_launch("videotestsrc is-live=true ! video/x-raw,width=64,height=48,framerate=25/1 "
                          "! x264enc tune=zerolatency speed-preset=ultrafast ! mpegtsmux "
                          f"! srtsink uri=srt://127.0.0.1:{port}?mode=caller latency={caller_ms}")
    rx.set_state(Gst.State.PLAYING)
    tx.set_state(Gst.State.PLAYING)
    got = []
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not got:
            time.sleep(0.5)
            st = rx.get_by_name("src").get_property("stats")
            callers = st.get_value("callers") if st and st.has_field("callers") else None
            for c in (list(callers) if callers is not None else []):
                if c.has_field("negotiated-latency-ms") and c.get_value("bytes-received") > 0:
                    got.append(c.get_value("negotiated-latency-ms"))
    finally:
        tx.set_state(Gst.State.NULL)
        rx.set_state(Gst.State.NULL)
    return got


def case5():
    gone = missing("srtsrc", "srtsink", "x264enc", "mpegtsmux")
    if gone:
        return skip("5", f"{', '.join(gone)} absent")
    for listener, caller in ((800, 500), (500, 800)):
        got = srt_pair(listener, caller)
        check(f"5: srtsrc listener at {listener} ms, a caller at {caller} ms: the caller's "
              "negotiated-latency-ms is the larger, 800",
              got == [800], f"{got}, srtsrc {version_of('srtsrc')}")


# --- 6, 7, 8 -------------------------------------------------------------------------------------

def case6():
    if missing("rtpjitterbuffer"):
        return skip("6", "rtpjitterbuffer absent")
    jb = Gst.ElementFactory.make("rtpjitterbuffer")
    check("6: a bare rtpjitterbuffer's latency is 200 ms", jb.get_property("latency") == 200,
          f"{jb.get_property('latency')}, rtpjitterbuffer {version_of('rtpjitterbuffer')}")


def case7(step_ts, tmp):
    if missing("tsparse"):
        return skip("7", "tsparse absent")
    out = os.path.join(tmp, "tsparse.ts")
    ok = run_to_eos(f"filesrc location={step_ts} ! tsparse alignment=7 set-timestamps=false "
                    f"! filesink location={out}")
    a, b = open(step_ts, "rb").read(), open(out, "rb").read()
    whole = len(a) // (7 * PKT) * 7 * PKT
    check("7: tsparse alignment=7 set-timestamps=false: every packet out byte-identical to the "
          "packet in (the flagged PCR step and the bumped PMT included)", ok and b == a[:len(b)],
          f"{len(b)} of {len(a)} bytes, tsparse {version_of('tsparse')}")
    check("7: ... and at EOS an incomplete last group of 7 is dropped", ok and len(b) == whole,
          f"{(len(a) - len(b)) // PKT} packets dropped")


def case8():
    b = Gst.Buffer.new()
    mems = []
    for i in range(17):
        m = Gst.Buffer.new_wrapped(bytes([i]) * 10).peek_memory(0)
        mems.append(m)
        b.insert_memory(-1, m)
        if i == 15:
            n16 = b.n_memory()
    first = b.peek_memory(0)
    ok, info = first.map(Gst.MapFlags.READ)
    merged = bytes(info.data) if ok else b""
    if ok:
        first.unmap(info)
    check("8: 16 memories stay 16; the 17th insert merges those 16 into one new memory (a copy of all "
          "their bytes) and appends the 17th: two",
          n16 == 16 and b.n_memory() == 2 and merged == b"".join(bytes([i]) * 10 for i in range(16))
          and all(first != m for m in mems) and b.peek_memory(1) == mems[16],
          f"{n16} then {b.n_memory()} memories")


# --- 9: third-party players ----------------------------------------------------------------------

VLC_ENV_NOISE = ("interface", "hotkeys", "v4l2m2m", "cannot start codec")


def vlc_errors(path):
    """cvlc's error lines, less the dev Pi's own (no interface module, no V4L2 decoder)."""
    r = subprocess.run(["cvlc", "-I", "dummy", "--play-and-exit", "--vout=dummy", "--aout=dummy", path],
                       capture_output=True, text=True, timeout=60)
    lines = [ln for ln in (r.stdout + r.stderr).splitlines()
             if " error" in ln and not any(k in ln for k in VLC_ENV_NOISE)]
    return r.returncode, lines


def case9(enc, tmp):
    step = os.path.join(tmp, "step-1.5.ts")
    with open(step, "wb") as f:
        f.write(rewrite(enc, [2.8], step_at=3.0, step_s=1.5))
    if shutil.which("ffprobe") and shutil.which("ffmpeg"):
        pr = subprocess.run(["ffprobe", "-v", "error", "-show_packets", step], capture_output=True, text=True,
                            timeout=120)
        dec = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", step, "-f", "null", "-"],
                             capture_output=True, text=True, timeout=120)
        check("9: ffprobe -show_packets and an ffmpeg decode over a PMT bump, then a flagged 1.5 s "
              "backward PCR step: no error",
              pr.returncode == 0 and not pr.stderr.strip() and pr.stdout.count("[PACKET]") > 300
              and dec.returncode == 0 and not dec.stderr.strip(), (pr.stderr + dec.stderr).strip()[:200])
    else:
        skip("9: ffmpeg", "ffprobe or ffmpeg absent")
    if not shutil.which("cvlc"):
        return skip("9: VLC", "cvlc absent")
    one = os.path.join(tmp, "step-1.0.ts")
    with open(one, "wb") as f:
        f.write(rewrite(enc, [2.8], step_at=3.0, step_s=1.0))
    rc, lines = vlc_errors(one)
    check("9: VLC plays a PMT bump, then a flagged 1.0 s backward PCR step, with no error", rc == 0 and not lines,
          "; ".join(lines)[:300])
    rc, lines = vlc_errors(step)
    print(f"RECORD 9: VLC over the 1.5 s step: rc {rc}, {len(lines)} error lines")
    for ln in lines:
        print(f"RECORD 9:   {ln.split('] ', 1)[-1]}")


def main():
    tmp = tempfile.mkdtemp(prefix="p50-")
    try:
        enc_ts = os.path.join(tmp, "enc.ts")
        if missing("videotestsrc", "x264enc", "h264parse", "audiotestsrc", "avenc_mp2", "mpegtsmux") \
                or not encode(enc_ts):
            skip("1, 4, 7, 9", "the encoders or mpegtsmux are absent or failed")
            enc = None
        else:
            enc = open(enc_ts, "rb").read()
        if enc:
            bump_ts = os.path.join(tmp, "bump.ts")
            with open(bump_ts, "wb") as f:
                f.write(rewrite(enc, [2.0, 4.0]))
            step_ts = os.path.join(tmp, "step.ts")
            with open(step_ts, "wb") as f:
                f.write(rewrite(enc, [2.8], step_at=3.0))
            case1(bump_ts)
            case4(bump_ts, tmp)
        case5()
        case6()
        if enc:
            case7(step_ts, tmp)
        case8()
        if enc:
            case9(enc, tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if _failures:
        print(f"\n{len(_failures)} FAILED: {_failures}")
        sys.exit(1)
    print("\ngst_egress_pins_test.py: all checks passed")


if __name__ == "__main__":
    main()
