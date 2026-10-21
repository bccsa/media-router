#!/usr/bin/env python3
"""avskew.py - content-based A/V skew of a captured MPEG-TS against its source.

USAGE
  avskew.py measure REF CAP [--json OUT] [--audio CAP:REF,...] [--video CAP:REF]
                            [--win S] [--hop S] [--threads N] [--cache-dir DIR]
  avskew.py extract TS [-o FEAT] [--audio-pids P,...] [--fine] [--threads N]

  REF  the source recording (.ts), or its features file from `extract`
       (*.feat.json.gz). A .ts REF is decoded once and cached in --cache-dir
       (default /tmp/avskew-cache), keyed by path, size, mtime and settings.
  CAP  the captured stream to judge (.ts, or a features file made with --fine).
  PIDs are hex or decimal (0xc8 or 200). Default pairing: the first video PID
  of each file; every CAP audio PID with the REF audio PID whose content
  matches it best (identical-content REF tracks tie; pass --audio to pin).

  Example on a box, a source recording replayed into an ingest and a muxer's
  output captured from its bus edge (capture_mux.sh; see README.md):
    sh /tmp/avskew/capture_mux.sh <edge> /tmp/avskew/mux.ts 28000000
    nice -n 19 python3 /tmp/avskew/avskew.py measure \\
        /data/captures/<source>.ts /tmp/avskew/mux.ts \\
        --audio 0xc8:0xc9,0xc9:0xcc,0xca:0xcd --json /tmp/avskew/mux.json
  The first run decodes the reference (~1.5 min for 600 s; cached afterwards).

WHAT IT REPORTS
  da   = PTS_cap - PTS_ref of the same AUDIO content
  dv   = PTS_cap - PTS_ref of the same PICTURE content
  skew = dv - da. Positive: at equal PTS the video content is later than the
         audio content = video BEHIND audio (sound leads the lips).
  PTS are each file's raw 90 kHz MPEG-TS PTS (unwrapped), so da and dv carry
  whatever restamp / loop offset the chain applied; only their difference is
  a sync figure. Also printed: every window's match, dv per second, the
  matched reference offset, and confidence (NCC peak, runner-up peak and
  width per window; per-frame thumbnail correlation r and margin; how many
  windows/frames agree and their spread). Exit status 0 = skew computed,
  2 = no confident match.

METHOD
  Decode with GStreamer (gi): filesrc ! tsdemux; audio: aacparse ! avdec_aac
  ! audioconvert ! mono S16 at the native rate; video: h26xparse ! avdec_h26x
  ! deinterlace fields=all (the transcoder's own 25i -> 50p element) !
  videoscale ! 32x18 GRAY8. Every decoded buffer keeps its own PTS, so the
  features sit on the true timeline (no resampler, nothing assumes
  continuity). The first 0.6 s of video / 0.1 s of audio of every decoded
  segment is dropped (decoder start-up pictures are garbage).
  Audio: 100 Hz log-energy envelope binned by per-sample PTS. The capture is
  cut into windows (default 8 s, hop 2 s); each is located in the WHOLE
  reference by normalised cross-correlation, then refined to 1 ms by
  re-binning the capture's 1 ms energy bins onto the reference grid.
  Video: the same windowed NCC on per-frame mean luma and mean |frame
  difference| gives the coarse position; then every capture frame is matched
  to the reference frame with the highest 32x18 thumbnail correlation within
  +-0.6 s (exact frame pairing). Thumbnail rows that disagree far more than
  the rest (burned-in subtitles, logos) are masked automatically. Frames of
  static scenes (best r not clearly above frames >= 3 away) are not used.
  skew = per-frame dv minus da interpolated at that frame's capture time;
  the median is reported with p10/p90, min/max and the dv trend.
  tsdemux re-bases time per file; the raw PTS offset is recovered by aligning
  the demuxer's first/last buffers with the file's PES headers on (PTS step,
  payload size), which is unique for video PES. Skew does not depend on it.
  A PTS jump (gap or backstep > 100 ms) splits a stream into segments and no
  window straddles one. A replay-loop seam with continuous PTS shows up as a
  content jump instead: windows across it match poorly and are dropped, the
  others form one cluster of deltas per loop iteration; every video cluster
  is paired with the audio cluster of nearest delta and reported separately.

VALIDATION (on a gate box, 2026-10-08)
  identity (clip vs sub-clip of the reference): skew -0.1 ms; video PTS
  shifted +1000 ms: +1000.0 ms; audio PTS shifted +300 ms: -300.0 ms; live
  ingest edge (pre-transcode): skew +0.0 ms with da = dv = the replayer's
  logged loop offset to 0.1 ms; a capture across a replay seam: two clusters
  428.48 s apart, both paired and reported.
"""

import argparse
import base64
import bisect
import collections
import gzip
import hashlib
import json
import math
import operator
import os
import sys
import time
import zlib
from array import array

try:
    from math import sumprod
except ImportError:                       # Python < 3.12
    def sumprod(a, b):
        return sum(map(operator.mul, a, b))

VERSION = 2
BIN_NS = 10_000_000                       # 100 Hz feature grid
FINE_NS = 1_000_000                       # capture audio fine bins (refinement)
GAP_NS = 100_000_000                      # PTS jump that splits a segment
SKIP_V_NS = 600_000_000                   # decoder start-up video dropped per segment
SKIP_A_NS = 100_000_000                   # decoder start-up audio dropped per segment
TW, TH = 32, 18                           # thumbnail size
WRAP = 1 << 33
NS = 1_000_000_000
MIN_SEG_S = 3.0                           # shorter segments are ignored
EXCL_S = 2.0                              # runner-up peak exclusion radius
TRACK_SPAN_NS = 600_000_000              # per-frame search radius around the coarse delta
FINE_SPAN_MS = 15                         # audio refinement range around the NCC peak
STALL_S = 60                              # abort a decode with no output this long
PROBE_N = 48                              # demuxed buffers kept for the PTS mapping
VERBOSE = bool(os.environ.get("AVSKEW_VERBOSE"))


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def pid_arg(s):
    return int(s, 0)


# --------------------------------------------------------------- TS scan
def dec_pts(b, o):
    return (((b[o] >> 1) & 7) << 30) | (b[o + 1] << 22) | (((b[o + 2] >> 1) & 0x7F) << 15) | \
        (b[o + 3] << 7) | (b[o + 4] >> 1)


def scan_pes(path, pids, tail=False, chunk=64 << 20):
    """(PTS 90 kHz, payload bytes) of the complete PES of `pids` in the
    first (or last) `chunk` bytes of the file, in file order."""
    with open(path, "rb") as f:
        if tail:
            f.seek(max(0, os.fstat(f.fileno()).st_size - chunk))
        data = f.read(chunk)
    p = 0
    while p + 376 < len(data) and not (data[p] == 0x47 and data[p + 188] == 0x47):
        p += 1
    cur, out = {}, {}
    while p + 188 <= len(data):
        if data[p] != 0x47:
            p += 1
            continue
        pid = ((data[p + 1] & 0x1F) << 8) | data[p + 2]
        if pid in pids:
            afc = (data[p + 3] >> 4) & 3
            body = p + 4
            if afc & 2:
                body += 1 + data[body]
            if afc & 1 and body < p + 188:
                if data[p + 1] & 0x40:
                    if pid in cur and cur[pid][0] is not None:
                        out.setdefault(pid, []).append(tuple(cur[pid]))
                    cur.pop(pid, None)
                    if data[body:body + 3] == b"\x00\x00\x01" and body + 14 <= p + 188:
                        hl = 9 + data[body + 8]
                        pts = dec_pts(data, body + 9) if data[body + 7] & 0x80 else None
                        cur[pid] = [pts, p + 188 - body - hl]
                elif pid in cur:
                    cur[pid][1] += p + 188 - body
        p += 188
    return out


def align(gst, raw):
    """Shifts s with raw[i+s] matching gst[i] in payload size and with a
    constant PTS offset. Returns [(C_ns, pairs)] - one entry when unique."""
    if not gst or not raw:
        return []
    base = raw[0][0]
    rns = [((((p - base) % WRAP) + base) * 100000 // 9, sz) for p, sz in raw]
    sols = []
    for s in range(-len(gst) + 8, len(rns) - 8 + 1):
        pairs = [(rns[i + s], g) for i, g in enumerate(gst) if 0 <= i + s < len(rns)]
        if len(pairs) < 8 or any(r[1] != g[1] for r, g in pairs):
            continue
        diffs = sorted(r[0] - g[0] for r, g in pairs)
        if diffs[-1] - diffs[0] <= 2000:
            sols.append((diffs[len(diffs) // 2], len(pairs)))
    return sols


def raw_mapping(path, probes):
    """C (ns) with raw PTS = demux time + C, at the file's head and tail.
    Only PIDs whose alignment is unique vote; they must agree to 2 us."""
    res = {}
    pids = set(probes)
    for where in ("head", "tail"):
        raw = scan_pes(path, pids, tail=(where == "tail"))
        votes, ambiguous = {}, []
        for pid, pr in probes.items():
            g = list(pr[where])
            if where == "tail":
                g = g[:-1]                     # the demuxer flushes a partial last PES
                r = raw.get(pid, [])[-PROBE_N:]
            else:
                r = raw.get(pid, [])[:PROBE_N + 16]
            sols = align(g, r)
            if len(sols) == 1:
                votes[f"0x{pid:x}"] = sols[0][0]
            elif sols:
                ambiguous.append(f"0x{pid:x}")
        vals = sorted(votes.values())
        ok = bool(vals) and vals[-1] - vals[0] <= 2000
        res[where] = {"c_ns": vals[len(vals) // 2] if ok else None, "votes": votes,
                      "ambiguous": ambiguous, "agree": ok}
    h, t = res["head"]["c_ns"], res["tail"]["c_ns"]
    res["c_ns"] = h if h is not None else t
    res["head_tail_ns"] = (t - h) if h is not None and t is not None else None
    return res


# ----------------------------------------------------------- accumulators
class AudioAcc:
    """Mono S16 buffers -> BIN_NS (and optionally FINE_NS) mean-square bins,
    binned by sample PTS; split into segments at PTS jumps."""

    def __init__(self, fine=False):
        self.fine = fine
        self.segs, self.cur = [], None
        self.rate = self.next = None
        self.buffers = 0
        self.jumps = []

    @staticmethod
    def _bin(a, num0, rb, acc, cnt):
        n, j = len(a), 0
        while j < n:
            b = (num0 + j * NS) // rb
            e = -((num0 - (b + 1) * rb) // NS)
            if e > n:
                e = n
            if e <= j:
                e = j + 1
            sl = a[j:e]
            acc[b] = acc.get(b, 0) + sumprod(sl, sl)
            cnt[b] = cnt.get(b, 0) + e - j
            j = e

    def add(self, pts, data, rate):
        if pts is None:
            if self.next is None:
                return
            pts = self.next
        a = array("h")
        a.frombytes(data)
        if sys.byteorder == "big":
            a.byteswap()
        if not len(a):
            return
        if self.cur is None or rate != self.rate or abs(pts - self.next) > GAP_NS:
            if self.cur is not None:
                self.jumps.append((self.next, pts))
            self.cur = ({}, {}, {}, {}, rate)
            self.segs.append(self.cur)
            self.rate = rate
        acc, cnt, facc, fcnt, _ = self.cur
        self._bin(a, pts * rate, rate * BIN_NS, acc, cnt)
        if self.fine:
            self._bin(a, pts * rate, rate * FINE_NS, facc, fcnt)
        self.next = pts + len(a) * NS // rate
        self.buffers += 1

    def finish(self):
        out = []
        for acc, cnt, facc, fcnt, rate in self.segs:
            full = rate * BIN_NS / NS
            keys = sorted(acc)
            b0 = keys[0] + SKIP_A_NS // BIN_NS
            vals = []
            for b in range(b0, keys[-1] + 1):
                c = cnt.get(b, 0)
                vals.append(10 * math.log10(acc[b] / c + 1.0) if c >= 0.5 * full else None)
            b0, vals, filled = trim_fill(b0, vals)
            if len(vals) * BIN_NS < MIN_SEG_S * NS:
                continue
            seg = {"b0": b0, "v": [round(x, 3) for x in vals], "filled": filled}
            if self.fine:
                f0 = b0 * (BIN_NS // FINE_NS)
                f1 = (b0 + len(vals)) * (BIN_NS // FINE_NS)
                seg["fine"] = {"b0": f0, "acc": [facc.get(f, 0) for f in range(f0, f1)],
                               "cnt": [fcnt.get(f, 0) for f in range(f0, f1)]}
            out.append(seg)
        return {"rate": self.rate, "buffers": self.buffers, "segments": out,
                "jumps": self.jumps}


def trim_fill(b0, vals):
    """Drop None at both ends, linearly fill interior None runs."""
    while vals and vals[0] is None:
        vals.pop(0)
        b0 += 1
    while vals and vals[-1] is None:
        vals.pop()
    filled = 0
    i = 0
    while i < len(vals):
        if vals[i] is None:
            k = i
            while vals[k] is None:
                k += 1
            a, z = vals[i - 1], vals[k]
            for m in range(i, k):
                vals[m] = a + (z - a) * (m - i + 1) / (k - i + 1)
            filled += k - i
            i = k
        i += 1
    return b0, vals, filled


class VideoAcc:
    """32x18 GRAY8 frames with PTS, split into segments at PTS jumps."""

    def __init__(self):
        self.segs, self.cur, self.last = [], None, None
        self.dups = 0
        self.jumps = []

    def add(self, pts, data, stride):
        if pts is None:
            return
        if stride != TW:
            data = b"".join(data[r * stride:r * stride + TW] for r in range(TH))
        if len(data) < TW * TH:
            return
        if self.last is not None and self.last - 1_000_000 <= pts <= self.last:
            self.dups += 1
            return
        if self.cur is None or pts < self.last or pts - self.last > GAP_NS:
            if self.cur is not None:
                self.jumps.append((self.last, pts))
            self.cur = {"pts": [], "th": bytearray()}
            self.segs.append(self.cur)
        self.cur["pts"].append(pts)
        self.cur["th"] += data[:TW * TH]
        self.last = pts

    def finish(self):
        out = []
        N = TW * TH
        for s in self.segs:
            k = bisect.bisect_left(s["pts"], s["pts"][0] + SKIP_V_NS)
            pts, th = s["pts"][k:], s["th"][k * N:]
            if len(pts) > 2 and pts[-1] - pts[0] >= MIN_SEG_S * NS:
                out.append({"pts": pts, "th": th})
        return {"segments": out, "dups": self.dups, "jumps": self.jumps}


# ------------------------------------------------------------- decoding
AUDIO_CHAIN = ("queue max-size-time=3000000000 max-size-bytes=0 max-size-buffers=0 ! "
               "aacparse ! avdec_aac ! audioconvert ! "
               "audio/x-raw,format=S16LE,channels=1,layout=interleaved ! "
               "appsink name=sink sync=false async=false emit-signals=true max-buffers=0")
VIDEO_CHAIN = ("queue ! {parse} ! {dec} max-threads={threads} ! queue ! "
               "deinterlace mode=auto fields=all method={deint} ! videoscale ! videoconvert ! "
               "video/x-raw,format=GRAY8,width={w},height={h} ! "
               "appsink name=sink sync=false async=false emit-signals=true max-buffers=0")
# async=false: an offline pipeline must not preroll. With prerolling sinks one
# branch's sink blocks, its queue fills, tsdemux stalls and the other branch
# never prerolls (seen as a silent hang in PAUSED).


def decode(path, threads=4, deint="linear", audio_pids=None, fine=False):
    """Demux + decode `path` -> audio/video accumulator results, codecs and
    the first/last demuxed (PTS, size) per decoded PID."""
    import gi
    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
    # An empty argv, not None: PyGObject 3.42 (the dev box) rejects None here.
    Gst.init([])
    none = Gst.CLOCK_TIME_NONE

    pipe = Gst.Pipeline.new("avskew")
    src = Gst.ElementFactory.make("filesrc")
    src.set_property("location", path)
    demux = Gst.ElementFactory.make("tsdemux")
    pipe.add(src)
    pipe.add(demux)
    src.link(demux)
    audio, video, probes, codecs = {}, {}, {}, {}

    def probe(_pad, info, pr):
        buf = info.get_buffer()
        if buf is not None and buf.pts != none:
            item = (buf.pts, buf.get_size())
            if len(pr["head"]) < PROBE_N:
                pr["head"].append(item)
            pr["tail"].append(item)
        return Gst.PadProbeReturn.OK

    def on_audio(sink, acc):
        s = sink.emit("pull-sample")
        if s is None:
            return Gst.FlowReturn.EOS
        b = s.get_buffer()
        rate = s.get_caps().get_structure(0).get_value("rate")
        acc.add(None if b.pts == none else b.pts, b.extract_dup(0, b.get_size()), rate)
        return Gst.FlowReturn.OK

    def on_video(sink, acc):
        s = sink.emit("pull-sample")
        if s is None:
            return Gst.FlowReturn.EOS
        b = s.get_buffer()
        size = b.get_size()
        acc.add(None if b.pts == none else b.pts, b.extract_dup(0, size), size // TH)
        return Gst.FlowReturn.OK

    def attach(desc, pad, handler=None, acc=None):
        bin_ = Gst.parse_bin_from_description(desc, True)
        if handler is not None:
            bin_.get_by_name("sink").connect("new-sample", handler, acc)
        pipe.add(bin_)
        bin_.sync_state_with_parent()
        if pad.link(bin_.get_static_pad("sink")) != Gst.PadLinkReturn.OK:
            raise RuntimeError(f"cannot link {pad.get_name()}")

    def on_pad(_d, pad):
        try:
            pid = int(pad.get_name().rsplit("_", 1)[1], 16)
        except (IndexError, ValueError):
            pid = None
        caps = pad.get_current_caps() or pad.query_caps(None)
        st = caps.get_structure(0)
        mime = st.get_name()
        if mime == "audio/mpeg" and st.get_value("mpegversion") in (2, 4) and \
                (audio_pids is None or pid in audio_pids):
            acc, handler, desc = AudioAcc(fine), on_audio, AUDIO_CHAIN
            audio[pid] = acc
            codecs[pid] = "aac"
        elif mime in ("video/x-h264", "video/x-h265") and not video:
            c = "h264" if mime.endswith("264") else "h265"
            acc, handler = VideoAcc(), on_video
            desc = VIDEO_CHAIN.format(parse=c + "parse", dec="avdec_" + c, threads=threads,
                                      deint=deint, w=TW, h=TH)
            video[pid] = acc
            codecs[pid] = c
        else:
            attach("fakesink sync=false async=false", pad)
            return
        pr = probes[pid] = {"head": [], "tail": collections.deque(maxlen=PROBE_N)}
        pad.add_probe(Gst.PadProbeType.BUFFER, probe, pr)
        attach(desc, pad, handler, acc)

    def progress():
        return (sum(a.buffers for a in audio.values()),
                sum(len(s["pts"]) for v in video.values() for s in v.segs))

    demux.connect("pad-added", on_pad)
    t0 = time.monotonic()
    pipe.set_state(Gst.State.PLAYING)
    bus = pipe.get_bus()
    last, t_last, msg = None, time.monotonic(), None
    while msg is None:
        msg = bus.timed_pop_filtered(5 * NS, Gst.MessageType.EOS | Gst.MessageType.ERROR)
        now = time.monotonic()
        prog = progress()
        if VERBOSE:
            log(f"  [{now - t0:6.1f}s] audio buffers {prog[0]}, video frames {prog[1]}")
        if prog != last:
            last, t_last = prog, now
        elif now - t_last > STALL_S:
            import faulthandler
            faulthandler.dump_traceback(all_threads=True)
            pipe.set_state(Gst.State.NULL)
            raise RuntimeError(f"decode of {path} stalled: no output for {STALL_S}s "
                               f"(audio buffers {prog[0]}, video frames {prog[1]})")
    pipe.set_state(Gst.State.NULL)
    if msg.type == Gst.MessageType.ERROR:
        err, dbg = msg.parse_error()
        raise RuntimeError(f"GStreamer error on {path}: {err.message} ({dbg})")
    log(f"  decoded {os.path.basename(path)} in {time.monotonic() - t0:.1f}s "
        f"(audio PIDs {len(audio)}, video PIDs {len(video)})")
    return {"audio": {p: a.finish() for p, a in audio.items()},
            "video": {p: v.finish() for p, v in video.items()},
            "probes": probes, "codecs": codecs}


# ---------------------------------------------------------- features I/O
def extract(path, threads, deint, audio_pids=None, fine=False):
    st = os.stat(path)
    log(f"extracting features: {path} ({st.st_size / 1e6:.0f} MB)")
    dec = decode(path, threads, deint, audio_pids, fine)
    mapping = raw_mapping(path, dec["probes"])
    feat = {
        "version": VERSION, "path": os.path.abspath(path), "size": st.st_size,
        "mtime_ns": st.st_mtime_ns, "deint": deint, "bin_ns": BIN_NS, "thumb": [TW, TH],
        "raw_offset_ns": mapping["c_ns"], "raw_mapping": mapping,
        "codecs": {f"0x{p:x}": v for p, v in dec["codecs"].items()},
        "audio": {f"0x{p:x}": a for p, a in dec["audio"].items()},
        "video": {},
    }
    for pid, v in dec["video"].items():
        feat["video"][f"0x{pid:x}"] = {
            "dups": v["dups"], "jumps": v["jumps"],
            "segments": [{"pts": s["pts"],
                          "th": base64.b64encode(zlib.compress(bytes(s["th"]), 6)).decode()}
                         for s in v["segments"]]}
    return feat


def save(feat, path):
    tmp = path + ".tmp"
    with gzip.open(tmp, "wt") as f:
        json.dump(feat, f, separators=(",", ":"))
    os.replace(tmp, path)


def load(path):
    with gzip.open(path, "rt") as f:
        feat = json.load(f)
    if feat.get("version") != VERSION:
        raise SystemExit(f"{path}: features version {feat.get('version')} != {VERSION}")
    return feat


def get_features(path, args, cache=False, fine=False):
    if path.endswith(".json.gz"):
        return load(path)
    if not os.path.isfile(path):
        raise SystemExit(f"no such file: {path}")
    if not cache:
        return extract(path, args.threads, args.deint, fine=fine)
    st = os.stat(path)
    key = hashlib.sha1(json.dumps([os.path.abspath(path), st.st_size, st.st_mtime_ns,
                                   args.deint, VERSION]).encode()).hexdigest()[:10]
    os.makedirs(args.cache_dir, exist_ok=True)
    cpath = os.path.join(args.cache_dir, f"{os.path.basename(path)}.{key}.feat.json.gz")
    if os.path.isfile(cpath):
        log(f"reference features from cache {cpath}")
        return load(cpath)
    feat = extract(path, args.threads, args.deint)
    save(feat, cpath)
    log(f"cached reference features in {cpath}")
    return feat


# --------------------------------------------------------- feature series
def to_grid(ts, vs):
    """Samples (ts ns ascending, vs) -> (b0, values on the BIN_NS grid)."""
    b0 = -(-ts[0] // BIN_NS)
    b1 = ts[-1] // BIN_NS
    out = []
    i = 0
    for b in range(b0, b1 + 1):
        t = b * BIN_NS
        while ts[i + 1] < t:
            i += 1
        t0, t1 = ts[i], ts[i + 1]
        out.append(vs[i] + (vs[i + 1] - vs[i]) * (t - t0) / (t1 - t0) if t1 > t0 else vs[i])
    return b0, out


def pearson(x, y):
    n = len(x)
    mx, my = math.fsum(x) / n, math.fsum(y) / n
    xz = [a - mx for a in x]
    yz = [b - my for b in y]
    d = math.sqrt(sumprod(xz, xz) * sumprod(yz, yz))
    return sumprod(xz, yz) / d if d > 0 else 0.0


class VSeg:
    """One video segment: frames, per-frame stats, 100 Hz feature grids."""

    def __init__(self, seg):
        self.pts = seg["pts"]
        th = zlib.decompress(base64.b64decode(seg["th"]))
        n, N = len(self.pts), TW * TH
        self.frames = [th[k * N:(k + 1) * N] for k in range(n)]
        self.s = [sum(f) for f in self.frames]
        self.ss = [sumprod(f, f) for f in self.frames]
        means = [x / N for x in self.s]
        diffs = [sum(map(abs, map(operator.sub, self.frames[k], self.frames[k - 1]))) / N
                 for k in range(1, n)]
        mids = [(self.pts[k] + self.pts[k - 1]) // 2 for k in range(1, n)]
        self.mean = to_grid(self.pts, means)
        self.diff = to_grid(mids, diffs)
        self.set_mask(range(TH))

    def set_mask(self, rows):
        """Thumbnail rows used by r() (overlay rows excluded)."""
        self.rows = list(rows)
        if len(self.rows) == TH:
            self.mf, self.ms, self.mss = self.frames, self.s, self.ss
        else:
            self.mf = [b"".join(f[y * TW:(y + 1) * TW] for y in self.rows) for f in self.frames]
            self.ms = [sum(f) for f in self.mf]
            self.mss = [sumprod(f, f) for f in self.mf]

    def r(self, k, other, j):
        """Pearson correlation of (masked) frame k with frame j of `other`."""
        N = len(self.mf[k])
        cov = sumprod(self.mf[k], other.mf[j]) - self.ms[k] * other.ms[j] / N
        va = self.mss[k] - self.ms[k] ** 2 / N
        vb = other.mss[j] - other.ms[j] ** 2 / N
        return cov / math.sqrt(va * vb) if va > 1e-6 and vb > 1e-6 else 0.0


class Series:
    """A 100 Hz grid series with prefix sums for fast sliding NCC."""

    def __init__(self, b0, vals):
        self.b0 = b0
        self.raw = vals
        m = math.fsum(vals) / len(vals)
        self.v = [x - m for x in vals]
        ps, ps2 = [0.0], [0.0]
        a = b = 0.0
        for x in self.v:
            a += x
            b += x * x
            ps.append(a)
            ps2.append(b)
        self.ps, self.ps2 = ps, ps2

    def ncc(self, win):
        """NCC of `win` against every lag; list indexed by lag (ref index)."""
        n = len(win)
        if n > len(self.v):
            return None
        m = math.fsum(win) / n
        wz = [x - m for x in win]
        wss = sumprod(wz, wz)
        if wss <= 1e-9 * n:
            return None
        v, ps, ps2, sq = self.v, self.ps, self.ps2, math.sqrt
        out = [0.0] * (len(v) - n + 1)
        for lag in range(len(out)):
            s = ps[lag + n] - ps[lag]
            var = (ps2[lag + n] - ps2[lag]) - s * s / n
            if var > 1e-9 * n:
                out[lag] = sumprod(v[lag:lag + n], wz) / sq(var * wss)
        return out


def parabolic(ym, y0, yp):
    den = ym - 2 * y0 + yp
    if den < 0:
        off = 0.5 * (ym - yp) / den
        if -1 < off < 1:
            return off
    return 0.0


def peak_info(curve, excl):
    """(fractional index, peak, runner-up outside +-excl, width in bins)."""
    i = max(range(len(curve)), key=curve.__getitem__)
    p = curve[i]
    frac = i + (parabolic(curve[i - 1], p, curve[i + 1]) if 0 < i < len(curve) - 1 else 0.0)
    lo, hi = max(0, i - excl), min(len(curve), i + excl + 1)
    second = max(curve[:lo] + curve[hi:], default=0.0)
    w = 1
    k = i - 1
    while k >= 0 and curve[k] >= p - 0.05:
        w += 1
        k -= 1
    k = i + 1
    while k < len(curve) and curve[k] >= p - 0.05:
        w += 1
        k += 1
    return frac, p, second, w


# --------------------------------------------------------------- matching
def windows(b0, length, win, hop):
    """Window start bins inside [b0, b0+length)."""
    out = []
    s = b0
    while s + win <= b0 + length:
        out.append(s)
        s += hop
    return out


def refine_audio(m, fine, rs, win):
    """1 ms refinement: re-bin the capture's 1 ms energy bins onto the
    reference's 10 ms grid for each candidate delta (whole ms) around the
    coarse match and keep the best Pearson correlation (parabolic peak)."""
    k10 = BIN_NS // FINE_NS
    d0 = round(m["delta_ns"] / FINE_NS)
    B0 = -(-(m["cap_ns"] - m["delta_ns"]) // BIN_NS) + 3
    nb = win - 6
    if B0 < rs.b0 or B0 + nb > rs.b0 + len(rs.raw):
        return
    y = rs.raw[B0 - rs.b0:B0 - rs.b0 + nb]
    facc, fcnt, f0 = fine["acc"], fine["cnt"], fine["b0"]
    need = 0.5 * max(fcnt) * k10
    scores = {}
    for k in range(-FINE_SPAN_MS, FINE_SPAN_MS + 1):
        d = d0 + k
        x = []
        for b in range(B0, B0 + nb):
            i = b * k10 + d - f0
            if i < 0 or i + k10 > len(facc):
                break
            c = sum(fcnt[i:i + k10])
            if c < need:
                break
            x.append(10 * math.log10(sum(facc[i:i + k10]) / c + 1.0))
        if len(x) == nb:
            scores[k] = pearson(x, y)
    if len(scores) < 3:
        return
    kb = max(scores, key=scores.get)
    off = parabolic(scores[kb - 1], scores[kb], scores[kb + 1]) \
        if kb - 1 in scores and kb + 1 in scores else 0.0
    m["delta_coarse_ns"] = m["delta_ns"]
    m["delta_ns"] = round((d0 + kb + off) * FINE_NS)
    m["ref_ns"] = m["cap_ns"] - m["delta_ns"]
    m["fine_r"] = scores[kb]


def match_audio(cap_seg, ref_series, win, hop):
    """Locate every window of a capture audio segment in the reference."""
    res = []
    excl = int(EXCL_S * NS / BIN_NS)
    for ws in windows(cap_seg["b0"], len(cap_seg["v"]), win, hop):
        w = cap_seg["v"][ws - cap_seg["b0"]:ws - cap_seg["b0"] + win]
        best = None
        for ri, rs in enumerate(ref_series):
            c = rs.ncc(w)
            if c is None:
                continue
            frac, p, sec, wid = peak_info(c, excl)
            if best is None or p > best["peak"]:
                best = {"cap_ns": ws * BIN_NS, "ref_ns": round((rs.b0 + frac) * BIN_NS),
                        "peak": p, "second": sec, "width_ms": wid * BIN_NS / 1e6, "rseg": ri}
        if best is None:
            continue
        best["delta_ns"] = best["cap_ns"] - best["ref_ns"]
        if "fine" in cap_seg:
            refine_audio(best, cap_seg["fine"], ref_series[best["rseg"]], win)
        res.append(best)
    return res


def match_video(cap, refs, win, hop):
    """Locate every window of a capture video segment in the reference:
    combined mean-luma + frame-difference NCC, then exact frame pairing."""
    res = []
    excl = int(EXCL_S * NS / BIN_NS)
    cm0, cmv = cap.mean
    cd0, cdv = cap.diff
    lo = max(cm0, cd0)
    hi = min(cm0 + len(cmv), cd0 + len(cdv))
    for ws in windows(lo, hi - lo, win, hop):
        wm = cmv[ws - cm0:ws - cm0 + win]
        wd = cdv[ws - cd0:ws - cd0 + win]
        best = None
        for ri, (rv, rm, rd) in enumerate(refs):
            cm = rm.ncc(wm)
            cd = rd.ncc(wd)
            if cm is None and cd is None:
                continue
            if cm is None or cd is None:     # one feature flat: use the other
                c, base = (cm, rm.b0) if cd is None else (cd, rd.b0)
                comb = list(c)
            else:                            # combine on the absolute reference bin
                base = max(rm.b0, rd.b0)
                end = min(rm.b0 + len(cm), rd.b0 + len(cd))
                comb = [(cm[R - rm.b0] + cd[R - rd.b0]) * 0.5 for R in range(base, end)]
            frac, p, sec, wid = peak_info(comb, excl)
            if best is None or p > best["peak"]:
                im = max(range(len(cm)), key=cm.__getitem__) if cm else None
                idd = max(range(len(cd)), key=cd.__getitem__) if cd else None
                best = {"cap_ns": ws * BIN_NS, "ref_ns": round((base + frac) * BIN_NS),
                        "peak": p, "second": sec, "width_ms": wid * BIN_NS / 1e6, "rseg": ri,
                        "peak_mean": cm[im] if cm else None,
                        "delta_mean_ns": (ws - rm.b0 - im) * BIN_NS if cm else None,
                        "peak_diff": cd[idd] if cd else None,
                        "delta_diff_ns": (ws - rd.b0 - idd) * BIN_NS if cd else None}
        if best is None:
            continue
        best["delta_1d_ns"] = best["cap_ns"] - best["ref_ns"]
        best["delta_ns"] = best["delta_1d_ns"]
        res.append(best)
    return res


def track_video(cap, cands, span_ns):
    """Best reference frame for every capture frame within +-span of
    (pts - d0), over the coarse candidates [(ref VSeg, d0)]. Exact frame
    pairing, no sub-frame interpolation: the transcoder's 50p frames are the
    source's own fields, so the true match is always a whole reference frame
    (interpolating only adds noise)."""
    out = []
    for k, t in enumerate(cap.pts):
        best = None
        for ci, (ref, d0) in enumerate(cands):
            tt = t - d0
            j0 = bisect.bisect_left(ref.pts, tt - span_ns)
            j1 = bisect.bisect_right(ref.pts, tt + span_ns)
            if j1 - j0 < 7:
                continue
            rs = [cap.r(k, ref, j) for j in range(j0, j1)]
            i = max(range(len(rs)), key=rs.__getitem__)
            if 0 < i < len(rs) - 1 and (best is None or rs[i] > best[0]):
                best = (rs[i], ci, j0, i, rs)
        if best is None:
            continue
        r, ci, j0, i, rs = best
        j = j0 + i
        far = [rs[x] for x in range(len(rs)) if abs(x - i) >= 3]
        out.append({"cap_ns": t, "delta_ns": t - cands[ci][0].pts[j], "peak": r,
                    "margin": (r - max(far)) if far else 0.0, "k": k, "j": j, "c": ci})
    return out


def auto_mask(pairs, factor=2.5):
    """Thumbnail rows to keep: drop rows whose mean-removed |cap - ref| at the
    tracked pairing exceeds factor x the median row (burned-in subtitles,
    logos and other overlays the reference does not have)."""
    acc = [0.0] * TH
    n = 0
    for cap, ref, m in pairs:
        a, b = cap.frames[m["k"]], ref.frames[m["j"]]
        dm = (sum(a) - sum(b)) / len(a)
        for y in range(TH):
            o = y * TW
            acc[y] += sum(abs(a[o + x] - b[o + x] - dm) for x in range(TW)) / TW
        n += 1
    if not n:
        return list(range(TH)), None
    rowd = [v / n for v in acc]
    medr = sorted(rowd)[TH // 2]
    keep = [y for y in range(TH) if rowd[y] <= factor * medr]
    if len(keep) < TH // 2:
        keep = list(range(TH))
    return keep, rowd


def clusters(matches, tol_ns=500_000_000):
    """Group matches whose deltas agree within tol; largest group first."""
    ms = sorted(matches, key=lambda m: m["delta_ns"])
    groups = []
    for m in ms:
        if groups and m["delta_ns"] - groups[-1][-1]["delta_ns"] <= tol_ns:
            groups[-1].append(m)
        else:
            groups.append([m])
    groups.sort(key=lambda g: (-len(g), -sum(x["peak"] for x in g)))
    return groups


def med(xs):
    xs = sorted(xs)
    n = len(xs)
    return (xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2) if n else None


def summarize(groups):
    out = []
    for g in groups:
        ds = [m["delta_ns"] for m in g]
        out.append({"delta_ns": med(ds), "n": len(g), "min_ns": min(ds), "max_ns": max(ds),
                    "mean_peak": sum(m["peak"] for m in g) / len(g),
                    "cap_span_ns": [min(m["cap_ns"] for m in g), max(m["cap_ns"] for m in g)]})
    return out


# ----------------------------------------------------------------- report
def fmt_s(ns):
    return f"{ns / NS:.3f}"


def fmt_ms(ns):
    return f"{ns / 1e6:+.1f}"


def choose_audio_pairs(cap, ref, spec, win):
    """[(cap_pid, ref_pid, note)] from --audio or by best content match."""
    if spec:
        out = []
        for item in spec.split(","):
            c, r = item.split(":")
            out.append((f"0x{pid_arg(c):x}", f"0x{pid_arg(r):x}", "given"))
        return out
    rser = {rpid: [Series(s["b0"], s["v"]) for s in ra["segments"]]
            for rpid, ra in ref["audio"].items()}
    out = []
    for cpid, ca in sorted(cap["audio"].items(), key=lambda kv: int(kv[0], 16)):
        segs = [s for s in ca["segments"] if len(s["v"]) >= win]
        if not segs:
            continue
        s = max(segs, key=lambda x: len(x["v"]))
        mid = s["b0"] + (len(s["v"]) - win) // 2
        w = s["v"][mid - s["b0"]:mid - s["b0"] + win]
        scores = []
        for rpid, sers in rser.items():
            best = -1.0
            for rs in sers:
                c = rs.ncc(w)
                if c:
                    best = max(best, max(c))
            scores.append((round(best, 3), -int(rpid, 16), rpid))
        scores.sort(reverse=True)
        if scores and scores[0][0] > 0:
            ties = [x[2] for x in scores if x[0] >= scores[0][0] - 0.002]
            note = f"auto: peak {scores[0][0]:.3f}"
            if len(ties) > 1:
                note += f", ties {','.join(ties)}"
            out.append((cpid, scores[0][2], note))
    return out


def run_measure(args):
    ref = get_features(args.ref, args, cache=True)
    cap = get_features(args.cap, args, fine=True)
    win = int(args.win * NS / BIN_NS)
    hop = int(args.hop * NS / BIN_NS)
    c_ref, c_cap = ref.get("raw_offset_ns"), cap.get("raw_offset_ns")
    raw_ok = c_ref is not None and c_cap is not None
    shift = (c_cap - c_ref) if raw_ok else 0       # demux-time delta -> raw-PTS delta
    out = {"tool": f"avskew v{VERSION}", "ref": ref["path"], "cap": cap["path"],
           "win_s": args.win, "hop_s": args.hop, "raw_pts_domain": raw_ok,
           "raw_offset_ref_ns": c_ref, "raw_offset_cap_ns": c_cap,
           "raw_mapping_ref": ref.get("raw_mapping"), "raw_mapping_cap": cap.get("raw_mapping"),
           "audio": [], "video": None, "skew": []}
    L = ["avskew - content-based A/V skew (all deltas: PTS_cap - PTS_ref of the same content)"]
    L.append(f"REF {ref['path']}  codecs {ref['codecs']}")
    L.append(f"CAP {cap['path']}  codecs {cap['codecs']}")
    for name, f in (("REF", ref), ("CAP", cap)):
        mp = f.get("raw_mapping") or {}
        h, t = mp.get("head", {}), mp.get("tail", {})
        L.append(f"{name} raw PTS = demux time + {fmt_s(f['raw_offset_ns']) if f['raw_offset_ns'] is not None else '?'} s"
                 f" (head votes {sorted(h.get('votes', {}))}, tail votes {sorted(t.get('votes', {}))},"
                 f" head-tail {mp.get('head_tail_ns')} ns)")
    if not raw_ok:
        L.append("WARNING: raw PTS mapping unavailable; deltas are in tsdemux time (skew unaffected)")

    # -------- audio
    pairs = choose_audio_pairs(cap, ref, args.audio, win)
    if not pairs:
        raise SystemExit("no audio pair could be matched (no usable audio in CAP/REF?)")
    for cpid, rpid, note in pairs:
        ca, ra = cap["audio"].get(cpid), ref["audio"].get(rpid)
        if ca is None or ra is None:
            raise SystemExit(f"audio PID missing: CAP {cpid} or REF {rpid} "
                             f"(CAP has {sorted(cap['audio'])}, REF has {sorted(ref['audio'])})")
        rser = [Series(s["b0"], s["v"]) for s in ra["segments"]]
        ms = []
        for seg in ca["segments"]:
            ms += match_audio(seg, rser, win, hop)
        good = [m for m in ms if m["peak"] >= args.min_peak and m["peak"] - m["second"] >= args.min_margin]
        groups = clusters(good)
        summ = summarize(groups)
        for m in ms:
            m["delta_raw_ns"] = m["delta_ns"] + shift
            m["used"] = bool(groups) and any(m is x for x in groups[0])
        out["audio"].append({"cap_pid": cpid, "ref_pid": rpid, "pairing": note,
                             "segments": len(ca["segments"]), "jumps": ca["jumps"],
                             "windows": ms, "clusters": summ})
        L.append("")
        L.append(f"AUDIO cap {cpid} <-> ref {rpid} ({note}); capture segments "
                 f"{len(ca['segments'])}, PTS jumps {len(ca['jumps'])}")
        L.append("   cap_t[s]    ref_t[s]       da_raw[ms]   peak   2nd  width  fine_r  used")
        for m in ms:
            L.append(f"  {fmt_s(m['cap_ns']):>9} {fmt_s(m['ref_ns']):>11} {fmt_ms(m['delta_raw_ns']):>16}"
                     f"  {m['peak']:.3f} {m['second']:.3f} {m['width_ms']:4.0f}ms"
                     f"  {m.get('fine_r', float('nan')):.4f}   {'*' if m['used'] else '-'}")
        for k, c in enumerate(summ):
            L.append(f"  cluster {k}: da = {fmt_ms(c['delta_ns'] + shift)} ms over {c['n']} windows "
                     f"(spread {fmt_ms(c['min_ns'] - c['delta_ns'])}..{fmt_ms(c['max_ns'] - c['delta_ns'])}"
                     f" ms, mean peak {c['mean_peak']:.3f})")

    # -------- video: coarse location per window, then per-frame tracking
    if not cap["video"] or not ref["video"]:
        raise SystemExit("no decodable video in CAP or REF")
    if args.video:
        c, r = args.video.split(":")
        cvp, rvp = f"0x{pid_arg(c):x}", f"0x{pid_arg(r):x}"
    else:
        cvp, rvp = sorted(cap["video"])[0], sorted(ref["video"])[0]
    t0 = time.monotonic()
    rsegs = [VSeg(s) for s in ref["video"][rvp]["segments"]]
    refs = [(v, Series(*v.mean), Series(*v.diff)) for v in rsegs]
    csegs = [VSeg(s) for s in cap["video"][cvp]["segments"]]
    vms = []
    for cs in csegs:
        vms += match_video(cs, refs, win, hop)
    cgroups = clusters([m for m in vms if m["peak"] >= args.min_peak])
    coarse = [g for g in cgroups if len(g) >= 2] or cgroups[:1]   # one per loop iteration
    cands = []
    for g in coarse:
        rseg = collections.Counter(m["rseg"] for m in g).most_common(1)[0][0]
        cands.append((rsegs[rseg], med([m["delta_ns"] for m in g])))
    for m in vms:
        m["delta_raw_ns"] = m["delta_ns"] + shift
        m["used"] = any(m is x for g in coarse for x in g)
    tracks = [(cs, m) for cs in csegs for m in track_video(cs, cands, TRACK_SPAN_NS)]
    keep, rowd = auto_mask([(cs, cands[m["c"]][0], m) for cs, m in tracks if m["peak"] >= 0.5])
    if len(keep) < TH:
        for v in rsegs + csegs:
            v.set_mask(keep)
        tracks = [(cs, m) for cs in csegs for m in track_video(cs, cands, TRACK_SPAN_NS)]
    frames = [m for _, m in tracks]
    log(f"  video matching + tracking {time.monotonic() - t0:.1f}s")
    fgood = [m for m in frames if m["peak"] >= args.min_frame_r and m["margin"] >= args.min_frame_margin]
    margin_note = f"frames with r >= {args.min_frame_r} and margin >= {args.min_frame_margin}"
    if len(fgood) < 50:                      # nearly static picture: take every confident frame
        fgood = [m for m in frames if m["peak"] >= args.min_frame_r]
        margin_note = (f"WARNING only {len(fgood)} frames pass the margin test (static picture?); "
                       f"using all frames with r >= {args.min_frame_r}")
    fgroups = clusters(fgood)
    vsumm = summarize(fgroups)
    big = [i for i, g in enumerate(fgroups) if len(g) >= max(25, 0.05 * len(fgood))]
    label = {id(m): i for i in big for m in fgroups[i]}
    for m in frames:
        m["delta_raw_ns"] = m["delta_ns"] + shift
        m["cluster"] = label.get(id(m))
        m["used"] = m["cluster"] is not None
    n_frames = sum(len(cs.pts) for cs in csegs)
    out["video"] = {"cap_pid": cvp, "ref_pid": rvp, "segments": len(csegs),
                    "jumps": cap["video"][cvp]["jumps"], "windows": vms, "clusters": vsumm,
                    "rows_kept": keep, "row_disagreement": rowd, "frames_total": n_frames,
                    "frames": [{k: v for k, v in m.items() if k not in ("k", "j", "c")} for m in frames]}
    L.append("")
    L.append(f"VIDEO cap {cvp} <-> ref {rvp}; capture segments {len(csegs)}, PTS jumps "
             f"{len(cap['video'][cvp]['jumps'])}, frames {n_frames}")
    L.append("  coarse location (mean-luma + frame-difference NCC per window):")
    L.append("   cap_t[s]    ref_t[s]     dv_raw[ms]   peak   2nd  width  used")
    for m in vms:
        L.append(f"  {fmt_s(m['cap_ns']):>9} {fmt_s(m['ref_ns']):>11} {fmt_ms(m['delta_raw_ns']):>14}"
                 f"  {m['peak']:.3f} {m['second']:.3f} {m['width_ms']:4.0f}ms  {'*' if m['used'] else '-'}")
    if rowd is not None:
        L.append(f"  overlay mask: kept thumbnail rows {keep[0]}..{keep[-1]} minus "
                 f"{sorted(set(range(TH)) - set(keep)) or 'none'} (row |cap-ref|: "
                 f"{' '.join(f'{x:.0f}' for x in rowd)})")
    L.append(f"  per-frame tracking (best reference frame per capture frame), per second; {margin_note}:")
    L.append("   cap_t[s]  frames used  cluster  dv_raw median[ms]   r median  margin median")
    by_s = collections.OrderedDict()
    for m in frames:
        by_s.setdefault(m["cap_ns"] // NS, []).append(m)
    for sec, ms in by_s.items():
        us = [m for m in ms if m["used"]]
        cl = collections.Counter(m["cluster"] for m in us).most_common(1)[0][0] if us else None
        us = [m for m in us if m["cluster"] == cl]
        L.append(f"  {sec:>8d}   {len(us):3d}/{len(ms):3d}   {cl if cl is not None else '-':>5}  "
                 f"{fmt_ms(med([m['delta_raw_ns'] for m in us])) if us else '        -':>16}"
                 f"   {med([m['peak'] for m in ms]):.3f}     {med([m['margin'] for m in ms]):.4f}")
    for k, c in enumerate(vsumm):
        L.append(f"  cluster {k}: dv = {fmt_ms(c['delta_ns'] + shift)} ms over {c['n']} frames "
                 f"(range {fmt_ms(c['min_ns'] - c['delta_ns'])}..{fmt_ms(c['max_ns'] - c['delta_ns'])}"
                 f" ms, capture t {c['cap_span_ns'][0] / NS:.1f}..{c['cap_span_ns'][1] / NS:.1f} s,"
                 f" mean r {c['mean_peak']:.3f}){'' if k in big else ' - too small, ignored'}")

    # -------- skew
    L.append("")
    L.append("RESULT  (skew = dv - da; positive = video content later than audio at equal PTS"
             " = video BEHIND audio)")
    if not vsumm:
        L.append("  no confident video match - cannot compute skew")
    for a in out["audio"]:
        if not a["clusters"] or not big:
            L.append(f"  audio {a['cap_pid']}: no confident audio match - cannot compute skew")
            continue
        for vi in big:                       # one cluster per loop iteration: pair nearest
            vc = vsumm[vi]
            ac = min(a["clusters"], key=lambda c: (abs(vc["delta_ns"] - c["delta_ns"]), -c["n"]))
            aw = sorted((m for m in a["windows"] if ac["min_ns"] <= m["delta_ns"] <= ac["max_ns"]
                         and m["peak"] >= args.min_peak and m["peak"] - m["second"] >= args.min_margin),
                        key=lambda m: m["cap_ns"])
            ctr = [(m["cap_ns"] + win * BIN_NS // 2, m["delta_ns"]) for m in aw]

            def da_at(t):                    # audio delta at capture time t (linear, clamped)
                if t <= ctr[0][0]:
                    return ctr[0][1]
                if t >= ctr[-1][0]:
                    return ctr[-1][1]
                i = bisect.bisect_right([c[0] for c in ctr], t)
                (ta, da), (tb, db) = ctr[i - 1], ctr[i]
                return da + (db - da) * (t - ta) / (tb - ta)

            fv = fgroups[vi]
            per = sorted(m["delta_ns"] - da_at(m["cap_ns"]) for m in fv)
            sk = med(per)
            pct = lambda q: per[min(len(per) - 1, int(q * len(per)))]
            ts = [m["cap_ns"] / NS for m in fv]
            ds = [m["delta_ns"] / 1e6 for m in fv]
            tm, dm = sum(ts) / len(ts), sum(ds) / len(ds)
            vt = sum((x - tm) ** 2 for x in ts)
            slope = sum((x - tm) * (y - dm) for x, y in zip(ts, ds)) / vt if vt > 0 else 0.0
            a0 = aw[0]
            v0 = min(fv, key=lambda m: m["cap_ns"])
            rec = {"audio_cap_pid": a["cap_pid"], "audio_ref_pid": a["ref_pid"], "video_cluster": vi,
                   "cap_span_s": [vc["cap_span_ns"][0] / NS, vc["cap_span_ns"][1] / NS],
                   "skew_ns": sk, "skew_p10_ns": pct(0.1), "skew_p90_ns": pct(0.9),
                   "skew_min_ns": per[0], "skew_max_ns": per[-1], "skew_frames": len(per),
                   "skew_of_medians_ns": vc["delta_ns"] - ac["delta_ns"],
                   "da_raw_ns": ac["delta_ns"] + shift, "dv_raw_ns": vc["delta_ns"] + shift,
                   "audio_windows_used": len(aw), "audio_windows_total": len(a["windows"]),
                   "video_frames_used": vc["n"], "video_frames_total": n_frames,
                   "da_spread_ns": [ac["min_ns"] - ac["delta_ns"], ac["max_ns"] - ac["delta_ns"]],
                   "dv_range_ns": [vc["min_ns"] - vc["delta_ns"], vc["max_ns"] - vc["delta_ns"]],
                   "dv_trend_ms_per_s": slope,
                   "ref_offset_audio": {"cap_t_s": a0["cap_ns"] / NS, "ref_t_s": a0["ref_ns"] / NS,
                                        "ref_raw_pts_s": (a0["ref_ns"] + c_ref) / NS if c_ref is not None else None},
                   "ref_offset_video": {"cap_t_s": v0["cap_ns"] / NS,
                                        "ref_t_s": (v0["cap_ns"] - v0["delta_ns"]) / NS,
                                        "ref_raw_pts_s": (v0["cap_ns"] - v0["delta_ns"] + c_ref) / NS
                                        if c_ref is not None else None}}
            out["skew"].append(rec)
            verdict = "video BEHIND audio" if sk > 0 else "video AHEAD of audio"
            L.append(f"  audio {a['cap_pid']}<-{a['ref_pid']}, video cluster {vi} (capture t "
                     f"{rec['cap_span_s'][0]:.1f}..{rec['cap_span_s'][1]:.1f} s): SKEW {sk / 1e6:+.1f} ms ({verdict})")
            L.append(f"      per-frame p10..p90 {pct(0.1) / 1e6:+.1f}..{pct(0.9) / 1e6:+.1f},"
                     f" min..max {per[0] / 1e6:+.1f}..{per[-1] / 1e6:+.1f} ms over {len(per)} frames;"
                     f" dv-da of medians {rec['skew_of_medians_ns'] / 1e6:+.1f} ms")
            L.append(f"      da {fmt_ms(ac['delta_ns'] + shift)} ms [{len(aw)}/{len(a['windows'])} windows,"
                     f" spread {fmt_ms(rec['da_spread_ns'][0])}..{fmt_ms(rec['da_spread_ns'][1])}]"
                     f"  dv {fmt_ms(vc['delta_ns'] + shift)} ms [{vc['n']}/{n_frames} frames,"
                     f" range {fmt_ms(rec['dv_range_ns'][0])}..{fmt_ms(rec['dv_range_ns'][1])},"
                     f" trend {slope:+.2f} ms/s]")
    if out["skew"]:
        r0 = out["skew"][0]
        ra_, rv_ = r0["ref_offset_audio"], r0["ref_offset_video"]
        L.append(f"  matched reference offset: capture audio t={ra_['cap_t_s']:.3f} s <-> ref "
                 f"t={ra_['ref_t_s']:.3f} s (raw PTS {ra_['ref_raw_pts_s']}); capture video "
                 f"t={rv_['cap_t_s']:.3f} s <-> ref t={rv_['ref_t_s']:.3f} s (raw PTS {rv_['ref_raw_pts_s']})"
                 f"  [t = demux time, ~s into each file]")
    print("\n".join(L))
    if args.json:
        with open(args.json, "w") as f:
            json.dump(out, f, indent=1, default=str)
        log(f"wrote {args.json}")
    return 0 if out["skew"] else 2


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("measure", "extract"):
        p = sub.add_parser(name)
        p.add_argument("--threads", type=int, default=4, help="video decoder threads (default 4)")
        p.add_argument("--deint", default="linear", help="deinterlace method (default linear)")
        p.add_argument("--cache-dir", default="/tmp/avskew-cache")
        if name == "measure":
            p.add_argument("ref")
            p.add_argument("cap")
            p.add_argument("--json")
            p.add_argument("--audio", help="CAP:REF audio PID pairs, comma separated")
            p.add_argument("--video", help="CAP:REF video PIDs")
            p.add_argument("--win", type=float, default=8.0, help="window length s (default 8)")
            p.add_argument("--hop", type=float, default=2.0, help="window hop s (default 2)")
            p.add_argument("--min-peak", type=float, default=0.6, help="min NCC peak (default 0.6)")
            p.add_argument("--min-margin", type=float, default=0.1,
                           help="min audio peak minus runner-up (default 0.1)")
            p.add_argument("--min-frame-r", type=float, default=0.9,
                           help="min per-frame thumbnail correlation (default 0.9)")
            p.add_argument("--min-frame-margin", type=float, default=0.002,
                           help="min per-frame best r minus best r >= 3 frames away; drops "
                                "frames of static scenes that cannot be timed (default 0.002)")
        else:
            p.add_argument("ts")
            p.add_argument("-o", "--out")
            p.add_argument("--audio-pids", help="only these audio PIDs (comma separated)")
            p.add_argument("--fine", action="store_true", help="keep 1 ms audio bins (for CAP use)")
    args = ap.parse_args()
    if args.cmd == "extract":
        pids = {pid_arg(x) for x in args.audio_pids.split(",")} if args.audio_pids else None
        feat = extract(args.ts, args.threads, args.deint, pids, args.fine)
        outp = args.out or os.path.splitext(args.ts)[0] + ".feat.json.gz"
        save(feat, outp)
        log(f"wrote {outp}")
        return 0
    return run_measure(args)


if __name__ == "__main__":
    sys.exit(main())
