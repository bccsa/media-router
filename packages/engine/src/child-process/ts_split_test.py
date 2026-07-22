#!/usr/bin/env python3
"""Self-checking tests for ts_split.py (no GStreamer, no engine).

Run:  python3 ts_split_test.py
"""
import sys

import ts_psi
import ts_split

PKT = ts_psi.PKT
VIDEO_PID = 0x65
AUDIO_PID = 0xC9
PMT_PID = 0x30

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def es_packet(pid: int, cc: int, pusi=False, fill=0xAA) -> bytes:
    pkt = bytearray([ts_psi.SYNC,
                     (0x40 if pusi else 0x00) | ((pid >> 8) & 0x1F),
                     pid & 0xFF,
                     0x10 | (cc & 0x0F)])
    pkt += bytes([fill]) * (PKT - 4)
    return bytes(pkt)


def build_source(n_video=200, n_audio=40, psi_every=50, pcr_every=20):
    """Synthetic MPTS: PAT + PMT (program 1: video 0x65 = PCR pid, audio 0xC9),
    interleaved ES with correct CCs, PCR-bearing packets on the video pid."""
    out = []
    cc_pat = cc_pmt = cc_v = cc_a = 0
    pcr = 27_000_000  # 1 s
    vi = ai = 0
    i = 0
    while vi < n_video or ai < n_audio:
        if i % psi_every == 0:
            out.append(ts_psi.build_pat(7, {1: PMT_PID}, cc_pat)); cc_pat = (cc_pat + 1) & 0xF
            out.append(ts_psi.build_pmt(PMT_PID, 1, VIDEO_PID,
                                        [(VIDEO_PID, ts_psi.STREAM_TYPE_AVC),
                                         (AUDIO_PID, ts_psi.STREAM_TYPE_AAC)], cc_pmt))
            cc_pmt = (cc_pmt + 1) & 0xF
        if i % pcr_every == 0 and vi < n_video:
            # PCR rides the video pid as adaptation-only packets (cc = last video cc)
            pcr += 27_000_000 // 50          # +20 ms
            out.append(ts_psi.build_pcr_packet(VIDEO_PID, pcr, cc_v))
        for _ in range(4):
            if vi < n_video:
                out.append(es_packet(VIDEO_PID, cc_v, pusi=(vi % 10 == 0))); cc_v = (cc_v + 1) & 0xF; vi += 1
        if ai < n_audio:
            out.append(es_packet(AUDIO_PID, cc_a, pusi=(ai % 5 == 0), fill=0xBB)); cc_a = (cc_a + 1) & 0xF; ai += 1
        i += 1
    return b"".join(out)


def run_core(source: bytes, chunk: int, outputs=((VIDEO_PID, None), (AUDIO_PID, None))):
    events = []
    core = ts_split.SplitterCore(1, outputs,
                                 on_discovered=lambda s, p, e: events.append((tuple(s), p, dict(e))))
    per_pid = {pid: [] for pid, _ in outputs}
    for off in range(0, len(source), chunk):
        for pid, payload in core.feed(source[off:off + chunk]).items():
            per_pid[pid].append(payload)
    return core, events, {pid: b"".join(parts) for pid, parts in per_pid.items()}


def pids_in(ts: bytes):
    return {ts_psi.ts_pid(p) for p in ts_psi.iter_packets(ts)}


source = build_source()

# --- chunking invariance: 400-byte slices vs one blob -------------------------
# PSI injection is batch-quantized (cadence differs with chunking BY DESIGN);
# the invariants are the ES pass-through bytes and the injected PCR values.
_, ev_a, out_a = run_core(source, 400)
_, ev_b, out_b = run_core(source, len(source))


def pcr_values(ts: bytes, pid: int):
    return [ts_psi.read_pcr(p) for p in ts_psi.iter_packets(ts)
            if ts_psi.ts_pid(p) == pid and not ts_psi.ts_has_payload(p)]


def es_only(ts: bytes, pid: int):
    """The pid's packets with a payload (excludes injected PCR-only packets)."""
    return [p for p in ts_psi.iter_packets(ts)
            if ts_psi.ts_pid(p) == pid and ts_psi.ts_has_payload(p)]


check("chunking invariance (video ES)",
      es_only(out_a[VIDEO_PID], VIDEO_PID) == es_only(out_b[VIDEO_PID], VIDEO_PID))
check("chunking invariance (audio ES)",
      es_only(out_a[AUDIO_PID], AUDIO_PID) == es_only(out_b[AUDIO_PID], AUDIO_PID))
check("chunking invariance (audio PCR values subset)",
      set(pcr_values(out_b[AUDIO_PID], AUDIO_PID)) <= set(pcr_values(out_a[AUDIO_PID], AUDIO_PID))
      or set(pcr_values(out_a[AUDIO_PID], AUDIO_PID)) <= set(pcr_values(out_b[AUDIO_PID], AUDIO_PID)))

# --- output purity ------------------------------------------------------------
check("video output pids = {PAT, PMT, video}",
      pids_in(out_a[VIDEO_PID]) == {0x0000, ts_split.SPLIT_PMT_PID, VIDEO_PID})
check("audio output pids = {PAT, PMT, audio}",
      pids_in(out_a[AUDIO_PID]) == {0x0000, ts_split.SPLIT_PMT_PID, AUDIO_PID})

# --- ES pass-through: byte-identical, CC-continuous ---------------------------
src_video_es = [p for p in ts_psi.iter_packets(source)
                if ts_psi.ts_pid(p) == VIDEO_PID and ts_psi.ts_has_payload(p)]
check("video ES byte-identical", es_only(out_a[VIDEO_PID], VIDEO_PID) == src_video_es)
src_audio_es = [p for p in ts_psi.iter_packets(source)
                if ts_psi.ts_pid(p) == AUDIO_PID and ts_psi.ts_has_payload(p)]
check("audio ES byte-identical", es_only(out_a[AUDIO_PID], AUDIO_PID) == src_audio_es)

# --- PSI cadence + parse-back --------------------------------------------------
video_pkts = list(ts_psi.iter_packets(out_a[VIDEO_PID]))
first_es = next(i for i, p in enumerate(video_pkts)
                if ts_psi.ts_pid(p) == VIDEO_PID and ts_psi.ts_has_payload(p))
check("PSI precedes first ES",
      {ts_psi.ts_pid(p) for p in video_pkts[:first_es]} >= {0x0000, ts_split.SPLIT_PMT_PID})
gap = 0
max_gap = 0
for p in video_pkts:
    if ts_psi.ts_pid(p) == VIDEO_PID:
        gap += 1
        max_gap = max(max_gap, gap)
    elif ts_psi.ts_pid(p) == 0x0000:
        gap = 0
# feed() only injects PSI at batch boundaries, so the bound is interval + one batch
check("PSI at least every ~40 ES pkts (batch-quantized)", max_gap <= 60)
pat = ts_psi.parse_pat([p for p in video_pkts if ts_psi.ts_pid(p) == 0x0000])
check("output PAT -> program 1 on 0x1000", pat == {1: ts_split.SPLIT_PMT_PID})
pmt = ts_psi.parse_pmt([p for p in video_pkts if ts_psi.ts_pid(p) == ts_split.SPLIT_PMT_PID],
                       ts_split.SPLIT_PMT_PID)
check("output PMT: single ES, discovered stream_type",
      pmt is not None and pmt["streams"] == [(VIDEO_PID, ts_psi.STREAM_TYPE_AVC)]
      and pmt["pcr_pid"] == VIDEO_PID)

# --- PCR re-injection: audio only, CC-correct, monotonic -----------------------
audio_pkts = list(ts_psi.iter_packets(out_a[AUDIO_PID]))
audio_pcr = [p for p in audio_pkts
             if ts_psi.ts_pid(p) == AUDIO_PID and not ts_psi.ts_has_payload(p)]
check("audio output has injected PCR packets", len(audio_pcr) >= 2)
video_pcr_injected = [p for p in es_only(out_a[VIDEO_PID], VIDEO_PID) if False]
video_adaptation_only = [p for p in video_pkts
                         if ts_psi.ts_pid(p) == VIDEO_PID and not ts_psi.ts_has_payload(p)]
# source's own PCR packets pass through on the video pid; the SPLITTER must not add more
src_video_pcr = [p for p in ts_psi.iter_packets(source)
                 if ts_psi.ts_pid(p) == VIDEO_PID and not ts_psi.ts_has_payload(p)]
check("video output: no injected PCRs (source's own pass through)",
      video_adaptation_only == src_video_pcr)
vals = [ts_psi.read_pcr(p) for p in audio_pcr]
check("injected PCRs monotonic source-copied", all(v is not None for v in vals)
      and all(b > a for a, b in zip(vals, vals[1:])))
ok_cc = True
last_payload_cc = None
for p in audio_pkts:
    if ts_psi.ts_pid(p) != AUDIO_PID:
        continue
    if ts_psi.ts_has_payload(p):
        last_payload_cc = p[3] & 0x0F
    elif last_payload_cc is not None and (p[3] & 0x0F) != last_payload_cc:
        ok_cc = False
check("injected PCR packets carry the last payload CC", ok_cc)

# --- discovery ------------------------------------------------------------------
check("discovery fired exactly once", len(ev_a) == 1)
check("discovery content", ev_a and dict(ev_a[0][0]) ==
      {VIDEO_PID: ts_psi.STREAM_TYPE_AVC, AUDIO_PID: ts_psi.STREAM_TYPE_AAC}
      and ev_a[0][1] == VIDEO_PID)

# --- ES descriptors carried into the rebuilt PMT (Opus identity survival) ----------
OPUS_DESC = bytes.fromhex("05044f707573" "7f028002")   # registration 'Opus' + DVB ext


def build_opus_source(n_audio=60, psi_every=20):
    """MPTS whose audio ES is descriptor-identified (stream_type 0x06 + Opus
    descriptors) — the shape the gate01 mux feed has on PIDs 0x141-0x143."""
    out = []
    cc_pat = cc_pmt = cc_a = 0
    for i in range(n_audio):
        if i % psi_every == 0:
            out.append(ts_psi.build_pat(7, {1: PMT_PID}, cc_pat)); cc_pat = (cc_pat + 1) & 0xF
            out.append(ts_psi.build_pmt(PMT_PID, 1, VIDEO_PID,
                                        [(VIDEO_PID, ts_psi.STREAM_TYPE_AVC),
                                         (AUDIO_PID, ts_psi.STREAM_TYPE_PRIVATE_PES, OPUS_DESC)],
                                        cc_pmt))
            cc_pmt = (cc_pmt + 1) & 0xF
        out.append(es_packet(AUDIO_PID, cc_a, pusi=(i % 5 == 0), fill=0xBB))
        cc_a = (cc_a + 1) & 0xF
    return b"".join(out)


_, ev_opus, out_opus = run_core(build_opus_source(), 1000, outputs=((AUDIO_PID, None),))
opus_pmt = ts_psi.parse_pmt(
    [p for p in ts_psi.iter_packets(out_opus[AUDIO_PID])
     if ts_psi.ts_pid(p) == ts_split.SPLIT_PMT_PID], ts_split.SPLIT_PMT_PID)
check("split PMT keeps discovered stream_type 0x06",
      opus_pmt is not None and
      opus_pmt["streams"] == [(AUDIO_PID, ts_psi.STREAM_TYPE_PRIVATE_PES)])
check("split PMT carries source ES descriptors verbatim",
      opus_pmt is not None and opus_pmt["es_info"] == {AUDIO_PID: OPUS_DESC})
check("discovery callback carries per-pid es_info (ISO-label read path)",
      len(ev_opus) == 1 and ev_opus[0][2].get(AUDIO_PID) == OPUS_DESC)

# es_info also flows for descriptor-less streams (empty bytes, never missing keys
# for pids that have no descriptor loop — parse_pmt stores b"" for them).
check("discovery es_info: plain source has empty descriptor loops",
      ev_a and all(ev_a[0][2].get(pid, b"") == b"" for pid in (VIDEO_PID, AUDIO_PID)))

# --- desync recovery --------------------------------------------------------------
dirty = b"\x00garbage\xffnoise" + source
core_d, _, out_d = run_core(dirty, 1000)
check("desync: garbage dropped, ES intact",
      es_only(out_d[VIDEO_PID], VIDEO_PID) == src_video_es and core_d.desync_bytes > 0)

# --- unknown pid ignored, empty feed fine ------------------------------------------
core_e = ts_split.SplitterCore(1, [(0x999, None)])
res = core_e.feed(source[:188 * 20])
check("no-match feed returns empty dict", res == {})
check("empty feed is a no-op", core_e.feed(b"") == {})

# --- wired-only gating (set_enabled) ------------------------------------------------
core_g = ts_split.SplitterCore(1, [(VIDEO_PID, None), (AUDIO_PID, None)])
core_g.set_enabled([AUDIO_PID])
mid = len(source) // 2 // 188 * 188
out_1 = {}
for off in range(0, mid, 1000):
    for pid, payload in core_g.feed(source[off:min(off + 1000, mid)]).items():
        out_1.setdefault(pid, []).append(payload)
check("disabled pid produces nothing", VIDEO_PID not in out_1 and AUDIO_PID in out_1)

core_g.set_enabled([AUDIO_PID, VIDEO_PID])   # re-enable video mid-stream
out_2 = {}
for off in range(mid, len(source), 1000):
    for pid, payload in core_g.feed(source[off:off + 1000]).items():
        out_2.setdefault(pid, []).append(payload)
check("re-enabled pid resumes", VIDEO_PID in out_2)
first_batch = list(ts_psi.iter_packets(out_2[VIDEO_PID][0]))
check("re-enable forces PSI before first ES",
      first_batch and ts_psi.ts_pid(first_batch[0]) == 0x0000
      and ts_psi.ts_pid(first_batch[1]) == ts_split.SPLIT_PMT_PID)
v_es_2 = es_only(b"".join(out_2[VIDEO_PID]), VIDEO_PID)
check("re-enabled ES is byte-identical to source segment",
      len(v_es_2) > 0 and all(p in src_video_es for p in v_es_2))

core_g.set_enabled([])
out_3 = core_g.feed(source[:188 * 40])
check("all-disabled feed returns empty dict", out_3 == {})

print()
if _failures:
    print("FAILURES:", ", ".join(_failures))
    sys.exit(1)
print("ALL ts_split TESTS PASSED")
