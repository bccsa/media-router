#!/usr/bin/env python3
"""The REAL `mrpeshouse` element against its python spec: the engine test's
synthetic program (`subtitle_ts_engine_test`: real `ts_timeline` stamper, OCC
and audio-leading offsets, both timing-PID modes, +427 s / +7 s / −600 s jumps,
attached mid-stream) pushed as stamped chunks through `appsrc ! mrpeshouse !
appsink`. Every `pes-house` must equal `PesStamper` + `StampModel` PES by PES
(pid, payload sha1, house within 1 ms, the same misses); buffers leave
untouched; lists are walked member by member. Skips without GStreamer or the
built plugin (`make native`). Run: python3 subtitle_peshouse_gst_test.py
"""
import hashlib
import os
import random
import sys

try:
    import gi
    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
except (ImportError, ValueError) as exc:
    print(f"SKIP subtitle_peshouse_gst_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

import subtitle_native
import subtitle_stamp_dump as dumpmod
import subtitle_ts as ts
from subtitle_testlib import check

eng = dumpmod.eng
Gst.init([])
SO = next((p for p in subtitle_native.so_paths() if os.path.exists(p)), None)
if SO is None or Gst.Plugin.load_file(SO) is None:
    print(f"SKIP subtitle_peshouse_gst_test.py — {subtitle_native.SO} not built (make native)")
    sys.exit(0)


def stamped_chunks(v_off, a_off, known, attach):
    """[(bytes, stamp ns)] the bridge would see, as in the engine test."""
    stream, _ttx = eng.program(v_off, a_off)
    stamper = eng.ts_timeline.TimelineStamper()
    if known:
        stamper._timing_pid = eng.VID
    out = []
    for n, part in enumerate(eng.chunks(stream, random.Random(7))):
        data = b"".join(p for _t, _ev, p in part)
        stamp = stamper.stamp(data, 5_000_000_000_000 + part[-1][0] * 1_000_000)
        if attach is None or n >= attach:
            out.append((data, stamp))
    return out


def native(chunks, pids, as_lists):
    """→ (signals, output buffers, element counters)."""
    pipe = Gst.parse_launch("appsrc name=src format=time caps=video/mpegts ! mrpeshouse name=ph "
                            "! appsink name=out sync=false emit-signals=false max-buffers=0")
    el, src, out = pipe.get_by_name("ph"), pipe.get_by_name("src"), pipe.get_by_name("out")
    if pids is not None:
        el.set_property("pids", ",".join(hex(p) for p in pids))
    got, passed = [], []
    el.connect("pes-house", lambda _e, pid, pts, sha, house: got.append((pid, pts, sha, house)))
    pipe.set_state(Gst.State.PLAYING)
    bufs = []
    for data, stamp in chunks:
        buf = Gst.Buffer.new_wrapped(data)
        buf.pts = stamp
        bufs.append(buf)
    for i in range(0, len(bufs), 3 if as_lists else 1):
        if as_lists:
            lst = Gst.BufferList.new()
            for b in bufs[i:i + 3]:
                lst.insert(-1, b)
            src.emit("push-buffer-list", lst)
        else:
            src.emit("push-buffer", bufs[i])
    src.emit("end-of-stream")
    while True:
        smp = out.emit("try-pull-sample", 5 * Gst.SECOND)
        if smp is None:
            break
        b = smp.get_buffer()
        passed.append((b.extract_dup(0, b.get_size()), b.pts))
    counters = {k: el.get_property(k) for k in ("hits", "misses", "resyncs")}
    pipe.set_state(Gst.State.NULL)
    return got, passed, counters


def python(chunks, pids):
    st = ts.PesStamper(pids=pids)
    out = []
    for data, stamp in chunks:
        out += [(pid, hashlib.sha1(payload).hexdigest(), house) for pid, payload, house in st.feed(data, stamp / 1e6)]
    return out


total = 0
for n, (label, known, v_off, a_off, attach) in enumerate(dumpmod.RUNS):
    chunks = stamped_chunks(v_off, a_off, known, attach)
    pids = {eng.TTX} if n % 2 == 0 else None                 # filtered and every-0xBD runs
    as_lists = n == 1
    got, passed, counters = native(chunks, pids, as_lists)
    want = python(chunks, pids)
    same = len(got) == len(want) and all(
        g[0] == w[0] and g[2] == w[1] and (g[3] == -1) == (w[2] is None)
        and (w[2] is None or abs(g[3] / 1e6 - w[2]) < 1.0) for g, w in zip(got, want))
    worst = max((abs(g[3] / 1e6 - w[2]) for g, w in zip(got, want) if w[2] is not None), default=0.0)
    misses = sum(1 for w in want if w[2] is None)
    total += len(want)
    tag = f"{label}{', pids=0x120' if pids else ''}{', buffer lists' if as_lists else ''}"
    print(f"     [{tag}] {len(want)} PES, {misses} misses, worst |Δhouse| {worst * 1e6:.0f} ns, {counters}")
    check(f"{tag}: pes-house equals PesStamper+StampModel PES by PES", same)
    check(f"{tag}: counters: hits/misses as python, resyncs on the jumps",
          counters["hits"] == len(want) - misses and counters["misses"] == misses and counters["resyncs"] >= 2)
    check(f"{tag}: every buffer passed untouched (bytes and PTS)", passed == chunks)
check("the runs carried hundreds of private PES", total > 1000)
got, _p, _c = native(stamped_chunks(1100, 60, False, None), {0x121}, False)
check("pids=0x121 (not on the wire): no pes-house at all", got == [])


def klv_chunks():
    """The consumer's shape: KLV-only cue chunks, PCR on the KLV PID, house mode."""
    import subtitle_klv
    import subtitle_pack
    packer, stamper, out = subtitle_pack.KlvTsPacker(0x180), eng.ts_timeline.TimelineStamper(house_timeline=True), []
    for n in range(16):
        start = 5_000_001_000.0 + n * 1300
        for arrival in (start + 300, start + 800):
            data = packer.cue_chunk(subtitle_pack.pes_ticks(start), subtitle_klv.encode_cue(0, 3000, f"cue {n}"))
            out.append((data, stamper.stamp(data, int(arrival * 1e6))))
    return out


chunks = klv_chunks()
got, _p, _c = native(chunks, None, False)
want = python(chunks, None)
check(f"KLV-only house mode (PCR on the private PID): {len(want)} cue PES equal python, all placed",
      len(want) == 32 and all(w[2] is not None for w in want)
      and [(g[0], g[2]) for g in got] == [(w[0], w[1]) for w in want]
      and all(abs(g[3] / 1e6 - w[2]) < 1.0 for g, w in zip(got, want)))
print("all subtitle_peshouse_gst tests passed")
