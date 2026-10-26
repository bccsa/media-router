#!/usr/bin/env python3
"""Tests for mrtsdemux (plan ch. 6 WI-P2-7, ch. 7 WI-P3-2), the formula demux, in the Python
runner's interpreter, driving the element over its pads (a harness, not a twin; chapter 3 part
4.5 rule 1). Select mode (`select`, Phase 2):

  - a 302M stream GStreamer makes (audiotestsrc ! avenc_s302m ! mpegtsmux, alignment 7 and 0,
    16 and 24 bits): one buffer per PES, PTS = DTS = PES - 1 h on the ceil (S12: mpegtsmux's floor
    gives every tick back), the PES payload, one TIME segment from 0; any chunking, a buffer list;
    through avdec_s302m too;
  - hand-built 302M programs (PMT stream type 0x06 with registration BSSD): a 500 ms hole gives
    one GAP of 500 ms; a CC loss DISCONT; a ladder across 2^33 no step; 30 h of house time
    (B-14) no 2^33 period lost; the bus stamps and upstream's segment are ignored;
  - no 302M in the PMT: one `mrtsdemux` message, reason no-stream, 2 s after the PMT; a pad
    with no caps and no data;
  - OQ-12 gap markers: a GAP of their length, trimmed at the last PES's end (B-21), dropped when
    nothing remains; markers on other PIDs, the PCR PID's included, ignored;
  - program-number, the interval message, EOS (an unbounded PES drained), flush, select refused.

Demux mode (the default, WI-P3-2; register B-123), each case numbered as p3-2's brief:

  1. every fixture's pads, templates, caps, units and gaps = its `.demux.jsonl` (DemuxCore's);
  2. the PMT section message before the program's first pad-added, on the streaming thread;
  3. gst_parse_launch links by delayed link (`! capsfilter caps=video/x-h264`), the AAC pads
     unlinked, no stall (GstFlowCombiner);
  4. a PMT change: version-only keeps the pads; a type change adds `*_1_*`, then EOS and
     pad-removed on `*_0_*`; a PCR PID change re-adds;
  5. Opus caps equal tsdemux's, decoded sample counts equal through opusdec (clipping meta);
  6. `media=video`: one pad, `pes` counts video only;  7. bus gap markers from the sidecar;
  8. a 2 h-off fixture: not-house-time once per PID;  9. the stream collection and the event
     order per pad equal tsdemux's (the section messages' place excepted, S14);
  10. MPEG-2 ADTS: caps mpegversion=2 before the first buffer;  11. KLV caps and SPARSE;
  12. `media=audio` on a video-only stream: no-stream after 2 s;  13. the select cases above;
  14. the TAG's language as tsdemux tags it, and mpegtsmux's ISO 639 back;
  and the KLV metadata cells, ID3, AV1 caps, a PMT without streams, the flow, the queries,
  flush, EOS, the messages.

Skips (exit 0) without GStreamer, the built plugin, or gst-libav's s302m codec."""
import json
import os
import subprocess
import sys
import threading
import time
import zlib

try:
    import gi

    gi.require_version("Gst", "1.0")
    gi.require_version("GstAudio", "1.0")
    gi.require_version("GstMpegts", "1.0")
    gi.require_version("GstTag", "1.0")
    from gi.repository import GObject, Gst, GstAudio, GstMpegts, GstTag
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_mrtsdemux_element_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

Gst.init(sys.argv)

NONE = Gst.CLOCK_TIME_NONE
MS = 1_000_000
S = 1_000_000_000
PKT = 188
PTS_WRAP = 1 << 33
MUX_90K = 3600 * 90000          # mpegtsmux's 1 h (MUX_CLOCK_BASE_90K)
TICKS = 1800                    # 960 frames at 48 kHz: 20 ms, exact in ticks and in ns
PID_PMT, PID_A, PID_V, PID_B = 0x1000, 0x41, 0x100, 0x42
BSSD = bytes([0x05, 0x04]) + b"BSSD"
TS_CAPS = "video/mpegts, systemstream=(boolean)true, packetsize=(int)188"
SELECT = "audio/x-smpte-302m"

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import ingest_restamp_fixture as fx  # noqa: E402  (the TS builders: pes, packetize, gap_packet)

sys.path.insert(0, os.path.join(fx.ROOT, "plugins", "mpegts-core", "py"))
import ts_psi  # noqa: E402  (the Python reference's PAT/PMT builders)

_SO = os.path.join(os.environ.get("MR_PLUGINS_DIR") or os.path.join(fx.ROOT, "plugins"),
                   "mpegts-core", "native", "mrtshouse", "libgstmrtshouse.so")
if not os.path.exists(_SO):
    print(f"SKIP gst_mrtsdemux_element_test.py — mrtshouse plugin not built ({_SO}); "
          "run `make native`")
    sys.exit(0)
plugin = Gst.Plugin.load_file(_SO)   # a file that is there but does not load is a failure
if not (Gst.ElementFactory.find("avenc_s302m") and Gst.ElementFactory.find("avdec_s302m")):
    print("SKIP gst_mrtsdemux_element_test.py — gst-libav's avenc_s302m/avdec_s302m missing")
    sys.exit(0)

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def pts90k_to_ns(t):
    """The formula demux's ns of a 90 kHz tick count: the ceil (S12, B-122)."""
    return -(-t * 100_000 // 9)


def sdict(st):
    return {st.nth_field_name(i): st.get_value(st.nth_field_name(i)) for i in range(st.n_fields())}


# --- streams -------------------------------------------------------------------------------

def s302m(frames, fill=0):
    """A 302M payload: the AES3 header, then `frames` of stereo 16-bit pairs (5 bytes each)."""
    size = frames * 5
    return (size << 16).to_bytes(4, "big") + bytes((fill + i * 7) & 0xFF for i in range(size))


class Ts:
    """A transport stream under construction, CC kept per PID on every payload packet."""

    def __init__(self):
        self.cc = {}
        self.pkts = []

    def add(self, pkt):
        if pkt[3] & 0x10:
            pid = fx.pkt_pid(pkt)
            c = self.cc.get(pid, 0)
            self.cc[pid] = (c + 1) & 15
            pkt = pkt[:3] + bytes([(pkt[3] & 0xF0) | c]) + pkt[4:]
        self.pkts.append(pkt)
        return self

    def pat(self, programs=None, version=0):
        return self.add(ts_psi.build_pat(1, programs or {1: PID_PMT}, 0, version))

    def pmt(self, streams, pcr_pid, version=0, pmt_pid=PID_PMT, program=1):
        """`streams`: (pid, stream type, es_info)."""
        return self.add(ts_psi.build_pmt(pmt_pid, program, pcr_pid, streams, 0, version))

    def psi_302m(self, pid=PID_A):
        return self.pat().pmt([(pid, 0x06, BSSD)], pid)

    def pes(self, pid, pts33, payload, bounded=True):
        for p in fx.packetize(pid, fx.pes(0xBD, pts33, None, payload, bounded)):
            self.add(p)
        return self

    def frame(self, t, frames=960, pid=PID_A):
        """The 302M PES of house tick `t`: PES = t + 1 h, 33 bits."""
        return self.pes(pid, (t + MUX_90K) % PTS_WRAP, s302m(frames))

    def data(self):
        return b"".join(self.pkts)

    def last_cc(self, pid):
        return (self.cc[pid] - 1) & 15


def mux_302m(align, fmt="S16LE", n=60):
    """What audio-input-302m's encode tail makes: (mux buffers, [(PES PTS, payload)])."""
    p = Gst.parse_launch(
        f"audiotestsrc num-buffers={n} samplesperbuffer=1024 ! "
        f"audio/x-raw,format={fmt},rate=48000,channels=2 ! avenc_s302m strict=experimental ! "
        f"mpegtsmux latency=0 alignment={align} ! appsink name=s sync=false")
    sink = p.get_by_name("s")
    p.set_state(Gst.State.PLAYING)
    bufs = []
    while True:
        smp = sink.emit("try-pull-sample", 5 * S)
        if smp is None:
            break
        b = smp.get_buffer()
        bufs.append(b.extract_dup(0, b.get_size()))
    p.set_state(Gst.State.NULL)
    data = b"".join(bufs)
    pkts = [data[i:i + PKT] for i in range(0, len(data) - PKT + 1, PKT)]
    from collections import deque
    pat = ts_psi.parse_pat(deque(pkts))
    pmt = ts_psi.parse_pmt(deque(pkts), next(iter(pat.values())))
    pid = next(s[0] for s in pmt["streams"] if s[1] == 0x06 and pmt["es_info"][s[0]] == BSSD)
    pes, cur = [], None
    for pk in pkts:
        if ts_psi.ts_pid(pk) != pid or not ts_psi.ts_has_payload(pk):
            continue
        body = pk[ts_psi.payload_offset(pk):]
        if ts_psi.ts_pusi(pk):
            cur = bytearray(body)
            pes.append([ts_psi.read_pes_pts(pk), cur])
        elif cur is not None:
            cur += body
    out = []
    for pts, raw in pes:
        n_len = (raw[4] << 8) | raw[5]
        hdr = 9 + raw[8]
        out.append((pts, bytes(raw[hdr:6 + n_len])))
    return bufs, out, pid


# --- the harness ---------------------------------------------------------------------------

class Harness:
    """Own src pad -> mrtsdemux -> own sink pad, in a pipeline for its clock and bus. `running`
    puts the element's running time there at PLAYING (a realtime clock, a chosen base time);
    else the pipeline's own, from 0."""

    def __init__(self, select=SELECT, running=None, start=True, **props):
        self.pipe = Gst.Pipeline.new(None)
        self.el = Gst.ElementFactory.make("mrtsdemux", "demux")
        if select is not None:
            self.el.set_property("select", select)
        for k, v in props.items():
            self.el.set_property(k.replace("_", "-"), v)
        self.pipe.add(self.el)
        if running is not None:
            clk = GObject.new(Gst.SystemClock)
            clk.set_property("clock-type", Gst.ClockType.REALTIME)
            self.pipe.use_clock(clk)
            self.pipe.set_start_time(NONE)
            self.pipe.set_base_time(clk.get_time() - running)
        self.src = Gst.Pad.new("h_src", Gst.PadDirection.SRC)
        self.sink = Gst.Pad.new("h_sink", Gst.PadDirection.SINK)
        self.items, self.msgs, self.errors = [], [], []
        self.sink.set_chain_function_full(self._chain)
        self.sink.set_event_function_full(self._event)
        self.src.link(self.el.get_static_pad("sink"))
        self.el.get_static_pad("src").link(self.sink)
        self.pipe.get_bus().set_sync_handler(self._on_message)
        self.src.set_active(True)
        self.sink.set_active(True)
        self.state = None
        if start:
            self.start()

    def _chain(self, pad, parent, buf):
        self.items.append(("buf", buf.pts, buf.dts, buf.duration, int(buf.get_flags()),
                           buf.extract_dup(0, buf.get_size())))
        return Gst.FlowReturn.OK

    def _event(self, pad, parent, ev):
        t = ev.type
        if t == Gst.EventType.GAP:
            ts, dur = ev.parse_gap()
            self.items.append(("gap", ts, dur))
        elif t == Gst.EventType.SEGMENT:
            seg = ev.parse_segment()
            self.items.append(("segment", seg.format, seg.start, seg.base, seg.time))
        elif t == Gst.EventType.CAPS:
            self.items.append(("caps", ev.parse_caps().to_string()))
        elif t == Gst.EventType.STREAM_START:
            self.items.append(("stream-start", ev.parse_stream_start()))
        else:
            self.items.append((t.value_nick,))
        return True

    def _on_message(self, bus, msg):
        if msg.type == Gst.MessageType.ELEMENT and msg.src == self.el:
            st = msg.get_structure()
            self.msgs.append((st.get_name(), sdict(st)))
        elif msg.type == Gst.MessageType.ERROR:
            self.errors.append(msg.parse_error()[0].message)
        return Gst.BusSyncReply.DROP

    def start(self, segment=None):
        self.state = self.pipe.set_state(Gst.State.PLAYING)
        self.src.push_event(Gst.Event.new_stream_start("mrtsdemux-test"))
        self.src.push_event(Gst.Event.new_caps(Gst.Caps.from_string(TS_CAPS)))
        if segment is None:
            segment = Gst.Segment()
            segment.init(Gst.Format.TIME)
        self.src.push_event(Gst.Event.new_segment(segment))

    def stop(self):
        self.pipe.set_state(Gst.State.NULL)

    def push(self, data, pts=NONE, flags=0):
        b = Gst.Buffer.new_wrapped(bytes(data))
        b.pts, b.dts, b.duration = pts, NONE, NONE
        if flags:
            b.set_flags(flags)
        return self.src.push(b)

    def push_list(self, chunks):
        bl = Gst.BufferList.new()
        for c in chunks:
            b = Gst.Buffer.new_wrapped(bytes(c))
            b.pts = b.dts = NONE
            bl.insert(-1, b)
        return self.src.push_list(bl)

    def marker(self, pkts, end_ns):
        """An OQ-12 marker buffer: GAP|DISCONT, its PTS the gap's end, no DTS."""
        return self.push(b"".join(pkts), end_ns, Gst.BufferFlags.GAP | Gst.BufferFlags.DISCONT)

    def chunks(self, data, size):
        for i in range(0, len(data), size):
            self.push(data[i:i + size])

    def eos(self):
        self.src.push_event(Gst.Event.new_eos())

    def bufs(self):
        return [i for i in self.items if i[0] == "buf"]

    def of(self, kind):
        return [i for i in self.items if i[0] == kind]

    def messages(self, reason=None):
        return [d for n, d in self.msgs if n == "mrtsdemux"
                and (reason is None or d.get("reason") == reason)]


DISCONT = int(Gst.BufferFlags.DISCONT)


def is_discont(b):
    return bool(b[4] & DISCONT)


# --- the element's contract ----------------------------------------------------------------
print("\n--- the factory, its properties and gst-inspect-1.0 ---")
_f = Gst.ElementFactory.find("mrtsdemux")
check("mrtsdemux is in libgstmrtshouse.so at rank NONE",
      _f is not None and _f.get_rank() == Gst.Rank.NONE and _f.get_plugin_name() == "mrtshouse")
_el = Gst.ElementFactory.make("mrtsdemux", None)
_ro = ["pid", "pes", "gaps", "markers", "markers-dropped", "unknown-streams", "generation"]
_rw = ["select", "program-number", "media", "sparse-gap-lag", "max-pes-bytes"]
check("defaults: no select (demux mode), every media class, a 500 ms sparse lag, 32 MiB PES, "
      "program-number -1, pid and generation -1, counters 0",
      _el.get_property("select") is None and _el.get_property("program-number") == -1
      and _el.get_property("media") == "video,audio,private,subpicture"
      and _el.get_property("sparse-gap-lag") == 500 * MS
      and _el.get_property("max-pes-bytes") == 32 << 20
      and _el.get_property("pid") == -1 and _el.get_property("generation") == -1
      and all(_el.get_property(p) == 0 for p in _ro[1:6]))
check("the settings apply at a start (MUTABLE_READY); pid, generation and the counters are "
      "read-only",
      all(_el.find_property(p).flags & Gst.PARAM_MUTABLE_READY for p in _rw)
      and all(not _el.find_property(p).flags & GObject.ParamFlags.WRITABLE for p in _ro))
_tmpl = {t.name_template: (t.direction, t.presence, t.get_caps().to_string())
         for t in _f.get_static_pad_templates()}
_ts_tmpl = {t.name_template: (t.direction, t.presence, t.get_caps().to_string())
            for t in Gst.ElementFactory.find("tsdemux").get_static_pad_templates()
            if t.direction == Gst.PadDirection.SRC}
check(f"an ALWAYS sink of MPEG-TS, select's ALWAYS src, and tsdemux's four SOMETIMES src "
      f"templates, names and caps ({sorted(_tmpl)})",
      _tmpl.get("sink") == (Gst.PadDirection.SINK, Gst.PadPresence.ALWAYS,
                            "video/mpegts, systemstream=(boolean)true")
      and _tmpl.get("src", (None, None))[:2] == (Gst.PadDirection.SRC, Gst.PadPresence.ALWAYS)
      and len(_ts_tmpl) == 4 and all(_tmpl.get(n) == v for n, v in _ts_tmpl.items())
      and len(_tmpl) == 6)
_inspect = subprocess.run(["gst-inspect-1.0", f"--gst-plugin-load={_SO}", "mrtsdemux"],
                          capture_output=True, text=True)
check("gst-inspect-1.0 lists the settings and the counters",
      _inspect.returncode == 0 and all(f"\n  {p}" in _inspect.stdout for p in _rw + _ro))
_present = [_el.get_static_pad("src") is not None]
for _v in (SELECT, "", SELECT, None):
    _el.set_property("select", _v)
    _present.append(_el.get_static_pad("src") is not None)
check(f"the src pad is in the element only while select names a stream (else gst_parse would "
      f"link it at once and never the demux mode's pads) ({_present})",
      _present == [False, True, False, True, False])

print("\n--- select must name a stream select mode knows; without it, the demux mode ---")
for bad in ("audio/mpeg", "audio/x-smpte-302m; audio/mpeg", "not caps ((("):
    h = Harness(select=bad, start=False)
    ret = h.pipe.set_state(Gst.State.PAUSED)
    check(f"select {bad!r}: the start is refused with an error naming it ({h.errors})",
          ret == Gst.StateChangeReturn.FAILURE and len(h.errors) == 1
          and "names no stream mrtsdemux can select" in h.errors[0])
    h.stop()
h = Harness(select="audio/x-smpte-302m")
check("select audio/x-smpte-302m: the start succeeds",
      h.state == Gst.StateChangeReturn.SUCCESS and not h.errors)
_q = h.el.get_static_pad("src").query_caps(None)
check(f"the src pad's caps query answers the select caps ({_q.to_string()})",
      _q.to_string() == "audio/x-smpte-302m")
h.push(Ts().psi_302m().data())
check(f"the PMT that shows the stream sets the src caps and the segment, before any data "
      f"({[i[0] for i in h.items]})",
      [i[0] for i in h.items] == ["stream-start", "caps", "segment"]
      and h.items[1] == ("caps", "audio/x-smpte-302m") and h.el.get_property("pid") == PID_A)
h.stop()
for empty in ("", None):
    _p = Gst.Pipeline.new(None)
    _d = Gst.ElementFactory.make("mrtsdemux", None)
    _d.set_property("select", empty)
    _p.add(_d)
    _r = _p.set_state(Gst.State.PAUSED)
    check(f"select {empty!r}: the demux mode starts, with no src pad",
          _r == Gst.StateChangeReturn.SUCCESS and _d.get_static_pad("src") is None)
    _p.set_state(Gst.State.NULL)

# --- a 302M stream as GStreamer makes it ---------------------------------------------------
print("\n--- GStreamer's 302M (avenc_s302m ! mpegtsmux): one buffer per PES, PES - 1 h ---")
for align, fmt in (("7", "S16LE"), ("0", "S32LE")):
    MUXED, PES, PID = mux_302m(align, fmt)
    tag = f"alignment={align} {fmt}"
    data = b"".join(MUXED)
    want = [(pts90k_to_ns(pts - MUX_90K), payload) for pts, payload in PES]
    for how in ("as muxed", "1000-byte chunks", "one buffer list"):
        h = Harness()
        if how == "as muxed":
            for b in MUXED:
                h.push(b, pts=7 * S)          # a bus stamp, never read
        elif how == "1000-byte chunks":
            h.chunks(data, 1000)
        else:
            h.push_list([data[i:i + 1316] for i in range(0, len(data), 1316)])
        h.eos()
        got = [(b[1], b[5]) for b in h.bufs()]
        check(f"{tag}, {how}: {len(got)} buffers for {len(PES)} PES, each PTS = PES - 1 h "
              f"on the ceil and its payload", len(PES) >= 50 and got == want)
        if how == "as muxed":
            bufs = h.bufs()
            check(f"{tag}: DTS = PTS, the AES3 duration (1024 frames), DISCONT on the first only",
                  all(b[2] == b[1] for b in bufs)
                  and all(b[3] == 1024 * S // 48000 for b in bufs)
                  and [is_discont(b) for b in bufs] == [True] + [False] * (len(bufs) - 1))
            heads = [i for i in h.items if i[0] != "buf"]
            check(f"{tag}: stream-start, the 302M caps, one TIME segment {{0, 0, 0}}, the buffers, "
                  f"EOS; upstream's caps and segment not forwarded ({heads[:4]})",
                  heads[0][0] == "stream-start" and heads[0][1] == "mrtsdemux-test/select"
                  and heads[1] == ("caps", "audio/x-smpte-302m")
                  and heads[2] == ("segment", Gst.Format.TIME, 0, 0, 0)
                  and heads[3:] == [("eos",)])
            fin = h.messages("interval")
            check(f"{tag}: the EOS report: pid, stream found, the counters ({fin[-1:]})",
                  len(fin) >= 1 and fin[-1]["pid"] == PID and fin[-1]["stream"] == "found"
                  and fin[-1]["pes"] == len(PES) and fin[-1]["gaps"] == 0
                  and fin[-1]["cc-lost"] == 0 and fin[-1]["markers"] == 0
                  and fin[-1]["frame-ns"] in (21_322_222, 21_333_333, 21_344_444))
            check(f"{tag}: the counter properties: pid, pes", h.el.get_property("pid") == PID
                  and h.el.get_property("pes") == len(PES) and h.el.get_property("gaps") == 0)
        h.stop()

print("\n--- the production branch: mrtsdemux ! avdec_s302m, as WI-P2-8's string names it ---")
MUXED, PES, PID = mux_302m("7")
_p = Gst.parse_launch(f'appsrc name=src is-live=true format=time caps="{TS_CAPS}" ! '
                      f'mrtsdemux name=d select="{SELECT}" ! avdec_s302m ! '
                      f'appsink name=out sync=false')
_src, _out = _p.get_by_name("src"), _p.get_by_name("out")
_p.set_state(Gst.State.PLAYING)
for _b in MUXED:
    _src.emit("push-buffer", Gst.Buffer.new_wrapped(_b))
_src.emit("end-of-stream")
_dec = []
while True:
    _smp = _out.emit("try-pull-sample", 3 * S)
    if _smp is None:
        break
    _dec.append((_smp.get_buffer().pts, _smp.get_buffer().get_size() // 4))
_p.set_state(Gst.State.NULL)
check(f"decoded: {len(_dec)} buffers of 1024 frames, each at its PES - 1 h",
      _dec == [(pts90k_to_ns(pts - MUX_90K), 1024) for pts, _ in PES])

# --- hand-built 302M programs --------------------------------------------------------------
T0 = 9_000_000                      # house tick 100 s, a multiple of 9: every ns exact

print("\n--- a 500 ms hole: one GAP of that length, the next buffer DISCONT ---")
t = Ts().psi_302m()
for k in range(10):
    t.frame(T0 + k * TICKS)
HOLE = T0 + 10 * TICKS
t.frame(HOLE + 45_000).frame(HOLE + 45_000 + TICKS)
h = Harness()
h.chunks(t.data(), 1316)
gaps = h.of("gap")
check(f"one GAP: from the last frame's end, 500 ms exactly ({gaps})",
      gaps == [("gap", pts90k_to_ns(HOLE), 500 * MS)])
_i = h.items.index(gaps[0])
check("... right before the buffer after the hole, which is DISCONT; 12 buffers, `gaps` 1",
      h.items[_i + 1][0] == "buf" and h.items[_i + 1][1] == pts90k_to_ns(HOLE + 45_000)
      and is_discont(h.items[_i + 1]) and len(h.bufs()) == 12
      and not is_discont(h.bufs()[-1]) and h.el.get_property("gaps") == 1)
h.stop()

print("\n--- a CC loss: the PES it cut dropped, DISCONT on the next ---")
t = Ts().psi_302m()
for k in range(4):
    t.frame(T0 + k * TICKS)
_cut = len(t.pkts) + 3
for k in range(4, 8):
    t.frame(T0 + k * TICKS)
_lost = t.pkts[:_cut] + t.pkts[_cut + 1:]
h = Harness()
h.chunks(b"".join(_lost), 1316)
bufs = h.bufs()
check(f"7 of 8 buffers; the 5th PES gone, the 6th DISCONT ({len(bufs)} out)",
      len(bufs) == 7 and bufs[4][1] == pts90k_to_ns(T0 + 5 * TICKS) and is_discont(bufs[4])
      and not any(is_discont(b) for b in bufs[1:4] + bufs[5:]))
check("cc-lost 1, pes-dropped-cc 1, and no GAP for one missing frame",
      h.el.get_property("cc-lost") == 1 and h.el.get_property("pes-dropped-cc") == 1
      and not h.of("gap"))
h.stop()

print("\n--- a ladder across 2^33: no step ---")
WRAP_T = PTS_WRAP - MUX_90K         # the house tick where the PES field wraps (25.5 h)
t0 = WRAP_T - 50 * TICKS
t = Ts().psi_302m()
for k in range(100):
    t.frame(t0 + k * TICKS)
h = Harness(running=pts90k_to_ns(t0) - 500 * MS)
h.chunks(t.data(), 1316)
pts = [b[1] for b in h.bufs()]
check(f"100 buffers 20 ms apart through the wrap, continuous ({len(pts)}; "
      f"{pts[49:51] if len(pts) > 50 else pts})",
      len(pts) == 100 and all(b - a == 20 * MS for a, b in zip(pts, pts[1:]))
      and pts[50] == pts90k_to_ns(WRAP_T) and pts[0] == pts90k_to_ns(t0) and not h.of("gap"))
h.stop()

print("\n--- B-14: 30 h of house time, the 33-bit field folded once ---")
H30 = 30 * 3600 * S
t30 = H30 * 9 // 100_000
t = Ts().psi_302m()
for k in range(3):
    t.frame(t30 + k * TICKS)
h = Harness(running=H30 - 200 * MS)
h.push(t.data())
pts = [b[1] for b in h.bufs()]
check(f"the PES come out at 30 h, not one 2^33 period (26.5 h) behind ({pts[:1]})",
      (t30 + MUX_90K) > PTS_WRAP and pts == [H30, H30 + 20 * MS, H30 + 40 * MS])
h.stop()

print("\n--- the bus stamps and upstream's segment are never read ---")
t = Ts().psi_302m()
for k in range(5):
    t.frame(T0 + k * TICKS)
_seg = Gst.Segment()
_seg.init(Gst.Format.TIME)
_seg.base, _seg.start, _seg.time = 123 * S, 5 * S, 5 * S
h = Harness(start=False)
h.start(segment=_seg)
for i, p in enumerate(t.pkts):
    h.push(p, pts=(NONE if i % 3 == 0 else 5 * S + i * 999 * MS))
check("PTS by the formula whatever the buffers' PTS and the segment; the element's own segment",
      [b[1] for b in h.bufs()] == [pts90k_to_ns(T0 + k * TICKS) for k in range(5)]
      and h.of("segment") == [("segment", Gst.Format.TIME, 0, 0, 0)])
# A marker's PTS is a position in upstream's segment: running time = PTS - 5 s + 123 s, so
# PTS 82 s ends the gap at 200 s (read as running time itself, 82 s, it would be dropped).
h.marker([fx.gap_packet(PID_A, t.last_cc(PID_A), 100 * MS)], 82 * S)
check(f"a marker's PTS goes through upstream's segment to running time ({h.of('gap')})",
      h.of("gap") == [("gap", 200 * S - 100 * MS, 100 * MS)])
h.stop()

print("\n--- no 302M in the PMT: one no-stream message 2 s after it, a silent pad ---")
NO_302M = [(PID_V, 0x1B, b""), (PID_B, 0x0F, b""), (0x43, 0x06, b"")]
t = Ts()
h = Harness()
_t0 = time.monotonic()
_seen_at = None
while time.monotonic() - _t0 < 3.2:
    t.pkts = []
    h.push(t.pat().pmt(NO_302M, PID_V).data())   # the PSI carousel, CC running on
    if _seen_at is None and h.messages("no-stream"):
        _seen_at = time.monotonic() - _t0
    time.sleep(0.05)
_ns = h.messages("no-stream")
check(f"exactly one `mrtsdemux` message with reason no-stream, about 2 s after the first PMT "
      f"({len(_ns)}, at {_seen_at})",
      len(_ns) == 1 and _seen_at is not None and 1.95 <= _seen_at <= 2.6
      and _ns[0]["select"] == SELECT and _ns[0]["stream"] == "missing"
      and _ns[0]["pid"] == -1 and _ns[0]["program"] == 1)
check("the pad stays silent: a stream-start, no caps, no segment, no data",
      [i[0] for i in h.items] == ["stream-start"])
_iv = h.messages("interval")
check(f"the interval message comes every second meanwhile, stream missing ({len(_iv)})",
      2 <= len(_iv) <= 4 and all(m["stream"] == "missing" and m["pes"] == 0 for m in _iv))
# The stream appears in a later PMT version: found, caps, data.
t2 = Ts()
t2.cc = dict(t.cc)
t2.pmt([(PID_V, 0x1B, b""), (PID_A, 0x06, BSSD)], PID_V, version=1)
for k in range(3):
    t2.frame(T0 + k * TICKS)
h.push(t2.data())
check("a PMT version that adds 302M: caps, the segment, then its data",
      [i[0] for i in h.items] == ["stream-start", "caps", "segment", "buf", "buf", "buf"]
      and h.el.get_property("pid") == PID_A)
h.stop()

print("\n--- OQ-12 gap markers: a GAP of their length, trimmed at the last PES (B-21) ---")
t = Ts().psi_302m()
for k in range(5):
    t.frame(T0 + k * TICKS)
END = pts90k_to_ns(T0 + 5 * TICKS)    # the end of the 5th frame
CC = t.last_cc(PID_A)


def harness_with_ladder():
    hh = Harness()
    hh.push(t.data())
    hh.items.clear()
    return hh


h = harness_with_ladder()
h.marker([fx.gap_packet(PID_A, CC, 300 * MS)], END + 400 * MS)
check(f"past the last PES: GAP [end - length, end) ({h.items})",
      h.items == [("gap", END + 100 * MS, 300 * MS)] and h.el.get_property("markers") == 1)
t_next = Ts()
t_next.cc = dict(t.cc)
t_next.frame((END + 400 * MS) * 9 // 100_000)
h.push(t_next.data())
check("the buffer after it is DISCONT; no second GAP for the same hole",
      len(h.of("gap")) == 1 and len(h.bufs()) == 1 and is_discont(h.bufs()[0]))
h.stop()

h = harness_with_ladder()
h.marker([fx.gap_packet(PID_A, CC, 50 * MS)], END + 30 * MS)
check(f"overlapping the last PES: trimmed to start at its end ({h.items})",
      h.items == [("gap", END, 30 * MS)])
h.marker([fx.gap_packet(PID_A, CC, 20 * MS)], END + 25 * MS)
h.marker([fx.gap_packet(PID_A, CC, 60 * MS)], END + 80 * MS)
check("repeated markers from one start tile the timeline, never overlapping",
      h.of("gap") == [("gap", END, 30 * MS), ("gap", END + 30 * MS, 50 * MS)]
      and h.el.get_property("markers") == 3 and h.el.get_property("markers-dropped") == 1)
h.stop()

h = harness_with_ladder()
h.marker([fx.gap_packet(PID_A, CC, 15 * MS)], END - 2 * MS)
check("inside the last PES (a cadence rise's false marker): dropped, counted",
      h.items == [] and h.el.get_property("markers") == 1
      and h.el.get_property("markers-dropped") == 1)
h.stop()

# The restamp's shape (B-18): one list holding the data before the gap, the marker, the data
# that reveals it. Out in that order: the buffers, the GAP, the next buffer DISCONT.
t_after = Ts()
t_after.cc = dict(t.cc)
t_after.frame((END + 100 * MS) * 9 // 100_000)
_bl = Gst.BufferList.new()
for _data, _pts, _flags in ((t.data(), NONE, 0),
                            (fx.gap_packet(PID_A, CC, 100 * MS), END + 100 * MS,
                             Gst.BufferFlags.GAP | Gst.BufferFlags.DISCONT),
                            (t_after.data(), NONE, 0)):
    _b = Gst.Buffer.new_wrapped(_data)
    _b.pts, _b.dts = _pts, NONE
    if _flags:
        _b.set_flags(_flags)
    _bl.insert(-1, _b)
h = Harness()
h.src.push_list(_bl)
_kinds = [i[0] for i in h.items]
check(f"a list of data, a marker and data: the buffers, the GAP, a DISCONT buffer ({_kinds})",
      _kinds == ["stream-start", "caps", "segment"] + ["buf"] * 5 + ["gap", "buf"]
      and h.items[8] == ("gap", END, 100 * MS) and is_discont(h.items[9])
      and h.items[9][1] == END + 100 * MS)
h.stop()

tv = Ts().pat().pmt([(PID_V, 0x1B, b""), (PID_A, 0x06, BSSD)], PID_V)
for k in range(5):
    tv.frame(T0 + k * TICKS)
h = Harness()
h.push(tv.data())
h.items.clear()
h.marker([fx.gap_packet(PID_V, 3, 500 * MS), fx.gap_packet(0x1FF, 3, 500 * MS)], END + 600 * MS)
check("markers on other PIDs, the PCR PID's included, are ignored",
      h.items == [] and h.el.get_property("markers") == 0)
h.marker([fx.gap_packet(PID_V, 3, 500 * MS), fx.gap_packet(PID_A, CC, 100 * MS)],
         END + 600 * MS)
check("in a marker of several PIDs only the selected PID's packet counts",
      h.items == [("gap", END + 500 * MS, 100 * MS)] and h.el.get_property("markers") == 1)
h.marker([fx.gap_packet(PID_A, CC, 100 * MS)], NONE)
check("a marker with no PTS is counted and dropped",
      len(h.of("gap")) == 1 and h.el.get_property("markers-dropped") == 1)
h.eos()
_fin = h.messages("interval")[-1]
check(f"the EOS report counts the markers ({_fin['markers']}, {_fin['markers-dropped']})",
      _fin["markers"] == 2 and _fin["markers-dropped"] == 1 and _fin["gaps"] == 1)
h.stop()

print("\n--- program-number ---")
t = Ts().pat({1: 0x100, 2: 0x200})
t.pmt([(PID_B, 0x0F, b"")], PID_B, pmt_pid=0x100, program=1)
t.pmt([(PID_A, 0x06, BSSD)], PID_A, pmt_pid=0x200, program=2)
for k in range(3):
    t.frame(T0 + k * TICKS)
h1, h2 = Harness(), Harness(program_number=2)
h1.push(t.data())
h2.push(t.data())
check("-1 follows the PAT's first program (no 302M there); 2 follows the second",
      not h1.bufs() and h1.el.get_property("pid") == -1 and len(h2.bufs()) == 3
      and h2.el.get_property("pid") == PID_A)
h1.stop()
h2.stop()

print("\n--- EOS, flush, a bus DISCONT ---")
t = Ts().psi_302m()
t.pes(PID_A, (T0 + MUX_90K) % PTS_WRAP, s302m(960), bounded=False)
h = Harness()
h.push(t.data())
_held = not h.bufs()
h.eos()
check("an unbounded PES is held, then out at EOS, before EOS",
      _held and len(h.bufs()) == 1 and h.bufs()[0][1] == pts90k_to_ns(T0)
      and h.items[-1] == ("eos",) and h.items[-2][0] == "buf")
# A new stream after EOS: its stream-start, then caps and segment again before its data.
_mark = len(h.items)
h.src.push_event(Gst.Event.new_stream_start("second"))
_seg = Gst.Segment()
_seg.init(Gst.Format.TIME)
h.src.push_event(Gst.Event.new_segment(_seg))
t_next = Ts()
t_next.cc = dict(t.cc)
t_next.frame(T0 + TICKS)
h.push(t_next.data())
_after = [i[:2] for i in h.items[_mark:]]
check(f"a new upstream stream: stream-start, caps, segment, then data ({_after})",
      [i[0] for i in _after] == ["stream-start", "caps", "segment", "buf"]
      and _after[0][1] == "second/select" and h.items[-1][1] == pts90k_to_ns(T0 + TICKS))
h.stop()

t = Ts().psi_302m()
for k in range(3):
    t.frame(T0 + k * TICKS)
h = Harness()
h.push(t.data())
h.src.push_event(Gst.Event.new_flush_start())
h.src.push_event(Gst.Event.new_flush_stop(True))
_seg = Gst.Segment()
_seg.init(Gst.Format.TIME)
h.src.push_event(Gst.Event.new_segment(_seg))
_mark = len(h.items)
t_again = Ts()
t_again.cc = dict(t.cc)
t_again.frame(T0)
h.push(t_again.data())
_after = h.items[_mark:]
check(f"flush forwarded; after it our segment again, then a DISCONT buffer "
      f"({[i[:2] for i in _after]})",
      [i[0] for i in h.items[_mark - 2:_mark]] == ["flush-start", "flush-stop"]
      and [i[0] for i in _after] == ["segment", "buf"] and is_discont(_after[1])
      and _after[1][1] == pts90k_to_ns(T0))
h.stop()

t = Ts().psi_302m()
for k in range(4):
    if k == 2:
        _mid = len(t.pkts) + 5
    t.frame(T0 + k * TICKS)
_d = t.data()
h = Harness()
h.push(_d[:_mid * PKT])
h.push(_d[_mid * PKT:], flags=Gst.BufferFlags.DISCONT)
bufs = h.bufs()
check("a bus DISCONT mid-PES: that PES dropped, the next buffer DISCONT",
      len(bufs) == 3 and bufs[2][1] == pts90k_to_ns(T0 + 3 * TICKS) and is_discont(bufs[2]))
h.stop()

print("\n--- the interval message: every second of running time ---")
t = Ts().psi_302m()
for k in range(120):
    t.frame(T0 + k * TICKS)
h = Harness()
_pkts, _at = t.pkts, []
_t0 = time.monotonic()
for i in range(0, len(_pkts), 14):            # 120 frames over about 2.4 s, as they play
    while time.monotonic() - _t0 < i / len(_pkts) * 2.4:
        time.sleep(0.002)
    _n = len(h.messages("interval"))
    h.push(b"".join(_pkts[i:i + 14]))
    if len(h.messages("interval")) > _n:
        _at.append(time.monotonic() - _t0)
_iv = h.messages("interval")
check(f"one a second while data flows, none before the first second, the counts rising "
      f"({len(_iv)} at {[round(a, 2) for a in _at]} s)",
      2 <= len(_iv) <= 3 and len(_at) == len(_iv) and 0.95 <= _at[0] <= 1.3
      and all(0.95 <= b - a <= 1.3 for a, b in zip(_at, _at[1:]))
      and all(m["stream"] == "found" for m in _iv)
      and all(a["pes"] < b["pes"] for a, b in zip(_iv, _iv[1:])))
h.stop()

# === demux mode (WI-P3-2) =================================================================
FIX = os.path.join(fx.ROOT, "plugins", "mpegts-core", "tests", "fixtures")
HOUR = 3600 * S
_seen_threads = {}


def fixture(name):
    with open(os.path.join(FIX, name + ".ts"), "rb") as f:
        return f.read()


def demux_lines(name):
    with open(os.path.join(FIX, name + ".demux.jsonl")) as f:
        return [json.loads(line) for line in f]


def sidecar(name):
    path = os.path.join(FIX, name + ".bus.jsonl")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return [json.loads(line) for line in f]


def house_of(data):
    """A recording's own house time, mrts::first_pes_house_ns: its first PES - 1 h, ceil."""
    for pkt in ts_psi.iter_packets(data):
        pts = ts_psi.read_pes_pts(pkt)
        if pts is not None:
            return pts90k_to_ns((pts - MUX_90K) % PTS_WRAP)
    return None


def crc(b):
    return f"{zlib.crc32(b) & 0xFFFFFFFF:08x}"


def lang_tag(code):
    """What tsdemux tags for an ISO 639-2 code: its ISO 639-1 form where one exists."""
    return GstTag.tag_get_language_code_iso_639_1(code) or code


_CLIP = GstAudio.audio_clipping_meta_api_get_type()
_ANY_SINK = Gst.PadTemplate.new("sink", Gst.PadDirection.SINK, Gst.PadPresence.ALWAYS,
                                Gst.Caps.new_any())
_PESMETA = GstMpegts.pes_metadata_meta_api_get_type()


class DemuxHarness:
    """Own src pad -> a demuxer (mrtsdemux, or tsdemux to compare) -> an own sink pad per pad
    it adds, linked at pad-added on the streaming thread (`link` filters by pad name). `log`
    holds in order: pad-added (name, caps, template), pad-removed, no-more-pads, the demuxer's
    element and stream-collection messages, and per pad every event and push."""

    def __init__(self, factory="mrtsdemux", running=None, start=True, link=None, **props):
        self.pipe = Gst.Pipeline.new(None)
        self.el = Gst.ElementFactory.make(factory, "demux")
        for k, v in props.items():
            self.el.set_property(k.replace("_", "-"), v)
        self.pipe.add(self.el)
        if running is not None:
            clk = GObject.new(Gst.SystemClock)
            clk.set_property("clock-type", Gst.ClockType.REALTIME)
            self.pipe.use_clock(clk)
            self.pipe.set_start_time(NONE)
            self.pipe.set_base_time(clk.get_time() - running)
        self.link = link
        self.src = Gst.Pad.new("h_src", Gst.PadDirection.SRC)
        self.src.link(self.el.get_static_pad("sink"))
        self.log, self.sinks, self.errors, self.flows = [], {}, [], []
        self.el.connect("pad-added", self._added)
        self.el.connect("pad-removed", lambda _e, pad: self.log.append(("pad-removed",
                                                                        pad.get_name())))
        self.el.connect("no-more-pads", lambda _e: self.log.append(("no-more-pads",)))
        self.pipe.get_bus().set_sync_handler(self._on_message)
        self.src.set_active(True)
        self.state = None
        if start:
            self.start()

    def _added(self, _el, pad):
        name = pad.get_name()
        caps = pad.get_current_caps()
        _seen_threads.setdefault(id(self), set()).add(threading.get_ident())
        self.log.append(("pad-added", name, caps.to_string() if caps else None,
                         pad.get_pad_template().name_template))
        if self.link is not None and not self.link(name):
            return
        sink = Gst.Pad.new_from_template(_ANY_SINK, "h_" + name)   # takes any caps change
        sink.set_chain_function_full(lambda _p, _o, buf: self._push(name, [buf], False))
        sink.set_chain_list_function_full(
            lambda _p, _o, bl: self._push(name, [bl.get(i) for i in range(bl.length())], True))
        sink.set_event_function_full(lambda _p, _o, ev: self._event(name, ev))
        sink.set_active(True)
        self.sinks[name] = sink
        pad.link(sink)

    def _push(self, name, bufs, is_list):
        self.log.append(("push", name, is_list, [
            (b.pts, b.dts, int(b.get_flags()), b.extract_dup(0, b.get_size()),
             b.get_meta(_CLIP) is not None, b.get_meta(_PESMETA) is not None) for b in bufs]))
        return Gst.FlowReturn.OK

    def _event(self, name, ev):
        t = ev.type
        if t == Gst.EventType.STREAM_START:
            ok, gid = ev.parse_group_id()
            st = ev.parse_stream()
            d = (ev.parse_stream_start(), int(ev.parse_stream_flags()), gid if ok else None,
                 st.get_stream_type() if st else None)
        elif t == Gst.EventType.CAPS:
            d = ev.parse_caps().to_string()
        elif t == Gst.EventType.SEGMENT:
            seg = ev.parse_segment()
            d = (seg.format, seg.start, seg.base, seg.time)
        elif t == Gst.EventType.TAG:
            tl = ev.parse_tag()
            ok, lang = tl.get_string(Gst.TAG_LANGUAGE_CODE)
            d = (lang if ok else None, tl.to_string())
        elif t == Gst.EventType.GAP:
            d = ev.parse_gap()
        elif t == Gst.EventType.STREAM_COLLECTION:
            c = ev.parse_stream_collection()
            d = (c.get_size(), c.get_upstream_id())
        else:
            d = None
        self.log.append(("event", name, t.value_nick, d))
        return True

    def _on_message(self, bus, msg):
        if msg.src == self.el and msg.type == Gst.MessageType.ELEMENT:
            st = msg.get_structure()
            sec = GstMpegts.message_parse_mpegts_section(msg)
            if sec is not None:
                pmt = sec.get_pmt() if sec.section_type == GstMpegts.SectionType.PMT else None
                self.log.append(("section", st.get_name(), sec.section_type,
                                 len(pmt.streams) if pmt else None, threading.get_ident()))
            else:
                self.log.append(("msg", st.get_name(), sdict(st)))
        elif msg.src == self.el and msg.type == Gst.MessageType.STREAM_COLLECTION:
            c = msg.parse_stream_collection()
            self.log.append(("collection", c.get_size(), c.get_upstream_id()))
        elif msg.type == Gst.MessageType.ERROR:
            self.errors.append(msg.parse_error()[0].message)
        return Gst.BusSyncReply.DROP

    def start(self):
        self.state = self.pipe.set_state(Gst.State.PLAYING)
        self.src.push_event(Gst.Event.new_stream_start("mrtsdemux-test"))
        self.src.push_event(Gst.Event.new_caps(Gst.Caps.from_string(TS_CAPS)))
        seg = Gst.Segment()
        seg.init(Gst.Format.TIME)
        self.src.push_event(Gst.Event.new_segment(seg))

    def stop(self):
        self.pipe.set_state(Gst.State.NULL)

    def push(self, data, pts=NONE, flags=0):
        b = Gst.Buffer.new_wrapped(bytes(data))
        b.pts, b.dts, b.duration = pts, NONE, NONE
        if flags:
            b.set_flags(Gst.BufferFlags(flags))
        r = self.src.push(b)
        self.flows.append(r)
        return r

    def chunks(self, data, size):
        for i in range(0, len(data), size):
            self.push(data[i:i + size])

    def replay(self, data, side):
        """A bus recording as it was recorded: each sidecar line one buffer, its PTS and flags."""
        for ln in side:
            pts = ln["pts"] if ln["pts"] is not None else NONE
            self.push(data[ln["off"]:ln["off"] + ln["len"]], pts, ln["flags"])

    def eos(self):
        self.src.push_event(Gst.Event.new_eos())

    def pads(self):
        return [e[1] for e in self.log if e[0] == "pad-added"]

    def events(self, pad, kind=None):
        return [e for e in self.log if e[0] == "event" and e[1] == pad
                and (kind is None or e[2] == kind)]

    def pushes(self, pad):
        return [e for e in self.log if e[0] == "push" and e[1] == pad]

    def messages(self, reason=None):
        return [e[2] for e in self.log if e[0] == "msg" and e[1] == "mrtsdemux"
                and (reason is None or e[2].get("reason") == reason)]

    def first(self, pred):
        return next((i for i, e in enumerate(self.log) if pred(e)), None)


def replay_fixture(name, factory="mrtsdemux", chunk=1316, running=None, side=True, **props):
    data = fixture(name.removesuffix(".p2"))
    lines = sidecar(name) if side else None
    h = DemuxHarness(factory, running=house_of(data) if running is None else running, **props)
    if lines:
        h.replay(data, lines)
    else:
        h.chunks(data, chunk)
    h.eos()
    return h


def head_sequence(h, pad):
    """A pad's events up to its first push, as types (STREAM_START's flags, CAPS's string)."""
    seq = []
    for e in h.log:
        if e[1:2] != (pad,):
            continue
        if e[0] == "push":
            break
        if e[0] == "event":
            seq.append(e[2] + (f"[{e[3][1]}]" if e[2] == "stream-start" else
                               f"[{e[3]}]" if e[2] == "caps" else
                               f"[{e[3][0]},{e[3][1]}]" if e[2] == "gap" else ""))
    return seq


# --- 1. every fixture = its .demux.jsonl ---------------------------------------------------
print("\n--- 1. every fixture: pads, templates, caps, units and gaps = its .demux.jsonl ---")
_names = sorted(f[:-len(".demux.jsonl")] for f in os.listdir(FIX) if f.endswith(".demux.jsonl"))
check(f"{len(_names)} expectations", len(_names) >= 33)
for name in _names:
    lines = demux_lines(name)
    h = replay_fixture(name, program_number=2 if name.endswith(".p2") else -1)
    plans = [ln["plan"] for ln in lines if "plan" in ln]
    want = [p for plan in plans for p in plan["pads"]]
    added = [e for e in h.log if e[0] == "pad-added"]
    check(f"{name}: pads in order, each from its class's template with the plan's caps "
          f"({len(added)} of {len(want)})",
          [e[1] for e in added] == [p["pad"] for p in want]
          and all(e[3] == p["pad"].split("_")[0] + "_%01x_%05x" for e, p in zip(added, want))
          and all(e[2] is not None and Gst.Caps.from_string(e[2]).is_equal(
              Gst.Caps.from_string(p["caps"])) for e, p in zip(added, want)))
    heads = {p["pad"]: p for p in want}
    ok_flags = all(h.events(n, "stream-start")[0][3][1] == (1 if p["sparse"] else 0)
                   for n, p in heads.items() if h.events(n, "stream-start"))
    ok_lang = all((h.events(n, "tag")[0][3][0] if h.events(n, "tag") else None)
                  == (lang_tag(p["lang"]) if p["lang"] else None)
                  for n, p in heads.items() if h.events(n, "tag"))
    check(f"{name}: SPARSE on the sparse pads, the TAG's language as tsdemux's",
          ok_flags and ok_lang)
    bad = []
    for n, p in heads.items():
        units = [ln["unit"] for ln in lines if "unit" in ln and ln["unit"]["pad"] == n]
        got = h.pushes(n)
        if len(got) != len(units):
            bad.append((n, "count", len(got), len(units)))
            continue
        for u, g in zip(units, got):
            b0 = g[3][0]
            pts = u["pts"] if u["pts"] is not None else NONE
            dts = u["dts"] if u["dts"] is not None else NONE
            if (b0[0], b0[1], bool(b0[2] & DISCONT)) != (pts, dts, u["discont"]):
                bad.append((n, "time", b0[:3], u))
                break
            if p["post"] in ("none", "adts") and (len(b0[3]), crc(b0[3])) != (u["len"], u["crc32"]):
                bad.append((n, "payload", len(b0[3]), u))
                break
        gaps = [(ln["gap"]["pts"], ln["gap"]["dur"]) for ln in lines
                if "gap" in ln and ln["gap"]["pad"] == n]
        if [e[3] for e in h.events(n, "gap") if e[3] != (0, 0)] != gaps:
            bad.append((n, "gaps", len(h.events(n, "gap")), len(gaps)))
    check(f"{name}: every pad's buffers (PTS, DTS, DISCONT, payload) and GAPs as DemuxCore's "
          f"{bad[:2]}", not bad)
    unknown = [(ln["unknown"]["pid"], ln["unknown"]["type"], ln["unknown"]["reg"],
                ln["unknown"]["gen"]) for ln in lines if "unknown" in ln]
    got_u = [(m["pid"], m["stream-type"], m["registration"], m["generation"])
             for m in h.messages("unknown-stream")]
    counters = next(ln["counters"] for ln in lines if "counters" in ln)
    removed = [e for e in h.log if e[0] == "pad-removed"]
    gone_pads = sum(len(plans[i]["pads"]) for i in range(len(plans) - 1))
    check(f"{name}: unknown-stream once per PID per program, the old program's pads removed, "
          f"no warning or error ({got_u}, {len(removed)} removed)",
          got_u == unknown and len(removed) == gone_pads and not h.errors
          and not h.messages("not-house-time") and not h.messages("no-stream")
          and h.el.get_property("pes") == counters["pes"]
          and h.el.get_property("gaps") == counters["gaps"]
          and h.el.get_property("generation") == counters["generation"]
          and h.el.get_property("unknown-streams") == counters["unknownStreams"]
          and h.el.get_property("cc-lost") == counters["ccLost"])
    h.stop()

# --- 2. the PMT before the pads ------------------------------------------------------------
print("\n--- 2. the PMT section message before the program's first pad-added ---")
h = replay_fixture("cap-vmix-h264-aac")
_pmt = h.first(lambda e: e[0] == "section" and e[1] == "pmt")
_pat = h.first(lambda e: e[0] == "section" and e[1] == "pat")
_add = h.first(lambda e: e[0] == "pad-added")
check(f"the PAT, then the PMT, before the first pad-added ({_pat}, {_pmt}, {_add})",
      None not in (_pat, _pmt, _add) and _pat < _pmt < _add)
check("the PMT is a GstMpegts PMT that parses (CRC whole), with both streams, posted on the "
      "streaming thread that adds the pads",
      h.log[_pmt][2] == GstMpegts.SectionType.PMT and h.log[_pmt][3] == 2
      and _seen_threads.get(id(h)) == {h.log[_pmt][4]})
h.stop()

# --- 3. delayed linking, unlinked pads, no stall -------------------------------------------
print("\n--- 3. gst_parse_launch: a delayed link to a capsfilter, the AAC pads unlinked ---")
_occ = "cap-occ-1080i-h264-aac-ttx"
_video = sum(1 for ln in demux_lines(_occ)
             if "unit" in ln and ln["unit"]["pad"].startswith("video"))
_p = Gst.parse_launch(f'appsrc name=src format=time caps="{TS_CAPS}" ! mrtsdemux name=d ! '
                      f'capsfilter caps=video/x-h264 ! fakesink name=f sync=false')
_n = [0]


def _count(_pad, _info):
    _n[0] += 1
    return Gst.PadProbeReturn.OK


_p.get_by_name("f").get_static_pad("sink").add_probe(Gst.PadProbeType.BUFFER, _count)
_p.set_state(Gst.State.PLAYING)
_src = _p.get_by_name("src")
_data = fixture(_occ)
for _i in range(0, len(_data), 1316):
    _src.emit("push-buffer", Gst.Buffer.new_wrapped(_data[_i:_i + 1316]))
_src.emit("end-of-stream")
_m = _p.get_bus().timed_pop_filtered(20 * S, Gst.MessageType.EOS | Gst.MessageType.ERROR)
_linked = [pd.get_name() for pd in _p.get_by_name("d").srcpads if pd.is_linked()]
check(f"EOS, no error: the video pad linked by name of caps, its {_video} buffers out, the "
      f"other {len(_p.get_by_name('d').srcpads) - 1} pads unlinked ({_linked}, {_n[0]})",
      _m is not None and _m.type == Gst.MessageType.EOS and _linked == ["video_0_0065"]
      and _n[0] == _video)
_p.set_state(Gst.State.NULL)
h = DemuxHarness(link=lambda n: False)
h.chunks(fixture("cap-vmix-h264-aac"), 1316)
_all = set(h.flows)                        # OK where a buffer completed no PES
h.stop()
h = DemuxHarness(link=lambda n: n.startswith("audio"))
h.chunks(fixture("cap-vmix-h264-aac"), 1316)
_one = set(h.flows)
h.stop()
check(f"NOT_LINKED upstream only when every pad is unlinked ({_all}); one linked pad: OK "
      f"({_one})", _all == {Gst.FlowReturn.NOT_LINKED, Gst.FlowReturn.OK}
      and _one == {Gst.FlowReturn.OK})

# --- 4. PMT changes ------------------------------------------------------------------------
print("\n--- 4. a PMT change: version-only keeps the pads; a type or PCR PID change re-adds ---")
h = replay_fixture("syn-pmt-version-bump")
_seq = [e[:2] for e in h.log if e[0] in ("pad-added", "pad-removed", "no-more-pads", "collection")
        or (e[0] == "section" and e[1] == "pmt") or (e[0] == "event" and e[2] == "eos")]
_pmts = [i for i, e in enumerate(_seq) if e == ("section", "pmt")]
check(f"four PMT versions, pads added three times ({len(_pmts)}, {h.pads()})",
      len(_pmts) == 4 and h.pads() == ["video_0_0100", "audio_0_0101", "video_1_0100",
                                       "audio_1_0101", "video_2_0100", "audio_2_0101"])
check(f"the version-only bump: no pad event between it and the next PMT "
      f"({_seq[_pmts[1]:_pmts[2]]})", _seq[_pmts[1]:_pmts[2]] == [("section", "pmt")])
_want = []
for g in (1, 2):
    o = g - 1
    _want += [("section", "pmt"), ("collection", 2), ("pad-added", f"video_{g}_0100"),
              ("pad-added", f"audio_{g}_0101"), ("event", f"video_{o}_0100"),
              ("pad-removed", f"video_{o}_0100"), ("event", f"audio_{o}_0101"),
              ("pad-removed", f"audio_{o}_0101"), ("no-more-pads",)]
check(f"each change: the collection, the new pads, then EOS and pad-removed on the old, then "
      f"no-more-pads ({_seq[_pmts[2]:]})", _seq[_pmts[2]:_pmts[2] + len(_want)] == _want)
_last0 = max(i for i, e in enumerate(h.log) if e[0] == "push" and e[1] == "video_0_0100")
_add1 = h.first(lambda e: e[0] == "pad-added" and e[1] == "video_1_0100")
check("the old program's last buffer before the new pads (drained first, as tsdemux)",
      _last0 < _add1 and h.events("video_1_0100", "stream-collection")
      and h.el.get_property("generation") == 2)
_progs = h.messages("program")
check(f"a `program` message at each plan: generation, PCR PID, pads ({_progs})",
      [(m["generation"], m["pcr-pid"], m["pads"]) for m in _progs]
      == [(0, 256, "video_0_0100,audio_0_0101"), (1, 256, "video_1_0100,audio_1_0101"),
          (2, 257, "video_2_0100,audio_2_0101")])
h.stop()

# --- 5. Opus ---------------------------------------------------------------------------------
print("\n--- 5. Opus: caps as tsdemux's, the samples out of opusdec as tsdemux's (trims) ---")


def opus_through(data, demux):
    pl = Gst.parse_launch(f'appsrc name=src format=time caps="{TS_CAPS}" ! {demux} name=d ! '
                          f'opusdec ! audio/x-raw,format=S16LE ! appsink name=out sync=false')
    caps = []
    pl.get_by_name("d").connect("pad-added", lambda _e, pad: caps.append(
        pad.get_current_caps().to_string()))
    out = pl.get_by_name("out")
    pl.set_state(Gst.State.PLAYING)
    src = pl.get_by_name("src")
    for i in range(0, len(data), 1316):
        src.emit("push-buffer", Gst.Buffer.new_wrapped(data[i:i + 1316]))
    src.emit("end-of-stream")
    n = 0
    while True:
        smp = out.emit("try-pull-sample", 3 * S)
        if smp is None:
            break
        channels = smp.get_caps().get_structure(0).get_value("channels")
        n += smp.get_buffer().get_size() // (2 * channels)
    pl.set_state(Gst.State.NULL)
    return [c for c in caps if c.startswith("audio/x-opus")], n


def mux_opus(n=40):
    """opusenc ! mpegtsmux: the first and last access units carry trims (pre-skip, padding)."""
    pl = Gst.parse_launch(f"audiotestsrc num-buffers={n} samplesperbuffer=1000 ! "
                          f"audio/x-raw,rate=48000,channels=2 ! opusenc ! mpegtsmux ! "
                          f"appsink name=s sync=false")
    sk = pl.get_by_name("s")
    pl.set_state(Gst.State.PLAYING)
    bufs = []
    while True:
        smp = sk.emit("try-pull-sample", 3 * S)
        if smp is None:
            break
        bufs.append(smp.get_buffer().extract_dup(0, smp.get_buffer().get_size()))
    pl.set_state(Gst.State.NULL)
    return b"".join(bufs)


if Gst.ElementFactory.find("opusdec") and Gst.ElementFactory.find("opusenc"):
    _fresh = mux_opus()
    for name, data in (("cap-mux-align7-aac-opus", fixture("cap-mux-align7-aac-opus")),
                       ("tp-opus-51", fixture("tp-opus-51")), ("opusenc ! mpegtsmux", _fresh)):
        ref = opus_through(data, "tsdemux latency=0")
        got = opus_through(data, "mrtsdemux")
        check(f"{name}: the Opus pad's caps and the decoded samples equal tsdemux's "
              f"({got[1]} samples; {got[0]})", got == ref and len(got[0]) == 1 and got[1] > 0)
    h = DemuxHarness(running=house_of(_fresh))
    h.chunks(_fresh, 1316)
    h.eos()
    _pushes = h.pushes(h.pads()[0])
    _clipped = [i for i, e in enumerate(_pushes) if any(b[4] for b in e[3])]
    check(f"the trimmed access units carry GstAudioClippingMeta, the others none "
          f"({_clipped} of {len(_pushes)})",
          len(_clipped) >= 1 and 0 in _clipped and len(_clipped) <= 2)
    h.stop()
else:
    print("SKIP 5 — opusenc/opusdec missing")

# --- 6. media --------------------------------------------------------------------------------
print("\n--- 6. media=video: one pad; audio never reassembled ---")
_vmix = demux_lines("cap-vmix-h264-aac")
h = replay_fixture("cap-vmix-h264-aac", media="video")
_vu = [ln["unit"] for ln in _vmix if "unit" in ln and ln["unit"]["pad"].startswith("video")]
check(f"one pad, video_0_0101, and `pes` counts its {len(_vu)} units alone "
      f"({h.pads()}, {h.el.get_property('pes')})",
      h.pads() == ["video_0_0101"] and h.el.get_property("pes") == len(_vu)
      and len(h.pushes("video_0_0101")) == len(_vu))
_sc = h.events("video_0_0101", "stream-collection")
check("its collection holds the one stream", _sc and _sc[0][3][0] == 1)
h.stop()
h = DemuxHarness(start=False, media="video,teletext")
check("media naming no class: the start is refused with an error",
      h.pipe.set_state(Gst.State.PAUSED) == Gst.StateChangeReturn.FAILURE
      and len(h.errors) == 1 and "names no pad class" in h.errors[0])
h.stop()
h = DemuxHarness(media="audio")
h.el.set_property("media", "video")
check("media is kept while the element runs (it applies at a start)",
      h.el.get_property("media") == "audio")
h.stop()

# --- 7. markers from the sidecar --------------------------------------------------------------
print("\n--- 7. syn-gap-marker from its sidecar: a GAP per marked pad, DISCONT next ---")
h = replay_fixture("syn-gap-marker")
_mk = [ln["gap"] for ln in demux_lines("syn-gap-marker")
       if "gap" in ln and ln["gap"]["reason"] == "marker"]
_ok = len(_mk) == 2
for g in _mk:
    log = [e for e in h.log if e[1:2] == (g["pad"],) and (e[0] == "push" or e[2:3] == ("gap",))]
    i = next((k for k, e in enumerate(log)
              if e[0] == "event" and e[3] == (g["pts"], g["dur"])), None)
    _ok = _ok and i is not None and log[i + 1][0] == "push" and bool(log[i + 1][3][0][2] & DISCONT)
check(f"{len(_mk)} marker GAPs on video and audio, each followed by a DISCONT buffer; markers "
      f"counted ({h.el.get_property('markers')})", _ok and h.el.get_property("markers") >= 2)
h.stop()

# --- 8. not house time -------------------------------------------------------------------------
print("\n--- 8. a recording 2 h behind the clock: not-house-time once per PID ---")
for name in ("syn-adts-mpeg2", "cap-mux-align7-aac-opus"):
    data = fixture(name)
    h = replay_fixture(name, running=house_of(data) + 2 * HOUR)
    nh = h.messages("not-house-time")
    pids = sorted(p["pid"] for ln in demux_lines(name) if "plan" in ln for p in ln["plan"]["pads"])
    check(f"{name}: one not-house-time per PID, 2 h behind "
          f"({[(m['pid'], m['offset-ms']) for m in nh]})",
          sorted(m["pid"] for m in nh) == pids
          and all(abs(m["offset-ms"] + 2 * 3600_000) < 60_000 for m in nh)
          and len(h.pushes(h.pads()[0])) > 0)
    h.stop()

# --- 9. the stream collection and the event order, as tsdemux --------------------------------
print("\n--- 9. the collection message before the pads; each pad's events as tsdemux's ---")
def plan_order(hh):
    return [e[0] for e in hh.log if e[0] in ("collection", "pad-added", "no-more-pads")]


def sections_before_pads(hh):
    first = hh.first(lambda x: x[0] == "pad-added")
    return [(e[1], i < first) for i, e in enumerate(hh.log)
            if e[0] == "section" and e[1] in ("pat", "pmt")][:2]


def stream_starts(hh):
    """Per pad: the stream id's PID suffix and program, flags, a group id, the stream type."""
    out = []
    for n in hh.pads():
        for e in hh.events(n, "stream-start")[:1]:
            sid, flags, gid, stype = e[3]
            out.append((n, sid.rsplit("/", 1)[1], sid.rsplit(":", 1)[1].split("/")[0], flags,
                        gid is not None, stype))
    return out


def first_tags(hh):
    return [hh.events(n, "tag")[0][3][1] for n in hh.pads() if hh.events(n, "tag")]


for name in ("cap-klv-sparse", "syn-gap-500ms", "cap-mux-align7-aac-opus", "tp-h264-dvbsub",
             "cap-occ-1080i-h264-aac-ttx", "syn-adts-mpeg2"):
    ours = replay_fixture(name)
    ref = replay_fixture(name, factory="tsdemux", latency=0)
    check(f"{name}: the collection message, every pad-added, no-more-pads, as tsdemux's",
          plan_order(ours) == plan_order(ref) and plan_order(ours)[0] == "collection")
    check(f"{name}: our PAT and PMT before the pads; tsdemux's PMT after them "
          f"({sections_before_pads(ref)})",
          sections_before_pads(ours) == [("pat", True), ("pmt", True)]
          and sections_before_pads(ref) == [("pat", True), ("pmt", False)])
    bad = [(n, head_sequence(ours, n), head_sequence(ref, n)) for n in ours.pads()
           if head_sequence(ours, n) != head_sequence(ref, n)]
    check(f"{name}: each pad's events to its first buffer as tsdemux's: STREAM_START (flags), "
          f"CAPS, STREAM_COLLECTION, SEGMENT, TAG, a sparse pad's GAP(0, 0) {bad[:1]}",
          not bad and ours.pads() == ref.pads())
    check(f"{name}: stream ids `<upstream>:<program>/<pid>`, flags, group id and stream type "
          f"as tsdemux's", stream_starts(ours) == stream_starts(ref))
    check(f"{name}: the TAGs (language, codec) as tsdemux's", first_tags(ours) == first_tags(ref))
    ours.stop()
    ref.stop()

# --- 10. MPEG-2 ADTS -----------------------------------------------------------------------
print("\n--- 10. syn-adts-mpeg2: caps mpegversion=2 before the first buffer ---")
h = replay_fixture("syn-adts-mpeg2")
_caps = [e for e in h.log
         if e[1:2] == ("audio_0_0101",) and (e[0] == "push" or e[2:3] == ("caps",))]
_first = next(i for i, e in enumerate(_caps) if e[0] == "push")
check(f"CAPS mpegversion=4 at pad-added, then mpegversion=2, then the first buffer "
      f"({[c[3] for c in _caps[:_first]]})",
      [c[3] for c in _caps[:_first]] == [
          "audio/mpeg, mpegversion=(int)4, stream-format=(string)adts",
          "audio/mpeg, mpegversion=(int)2, stream-format=(string)adts"]
      and h.el.get_static_pad("audio_0_0101").get_current_caps().get_structure(0)
      .get_value("mpegversion") == 2)
h.stop()

# --- 11. KLV ---------------------------------------------------------------------------------
print("\n--- 11. cap-klv-sparse: meta/x-klv, parsed, SPARSE, a metadata stream ---")
h = replay_fixture("cap-klv-sparse")
_ss = h.events("private_0_0180", "stream-start")[0][3]
check(f"private_0_0180: meta/x-klv, parsed=(boolean)true; SPARSE; GST_STREAM_TYPE_METADATA ({_ss})",
      h.log[h.first(lambda e: e[0] == "pad-added")][2] == "meta/x-klv, parsed=(boolean)true"
      and _ss[1] == int(Gst.StreamFlags.SPARSE) and _ss[3] == Gst.StreamType.METADATA)
h.stop()

# --- 12. no stream of media -----------------------------------------------------------------
print("\n--- 12. media=audio on a video-only program: one no-stream message 2 s after the PMT ---")
t = Ts()
h = DemuxHarness(media="audio")
_t0 = time.monotonic()
_seen_at = None
while time.monotonic() - _t0 < 3.2:
    t.pkts = []
    h.push(t.pat().pmt([(PID_V, 0x1B, b"")], PID_V).data())
    if _seen_at is None and h.messages("no-stream"):
        _seen_at = time.monotonic() - _t0
    time.sleep(0.05)
_ns = h.messages("no-stream")
check(f"no pad, an empty plan's no-more-pads, and one no-stream message about 2 s after the PMT "
      f"({len(_ns)}, at {_seen_at})",
      not h.pads() and ("no-more-pads",) in h.log and len(_ns) == 1 and _seen_at is not None
      and 1.95 <= _seen_at <= 2.6 and _ns[0]["stream"] == "missing" and _ns[0]["select"] == "")
h.eos()
check("EOS with no pad ends there, as tsdemux's", not h.errors)
h.stop()

print("\n--- a PMT without streams: nothing planned, no no-stream (as tsdemux; select mode warns) ---")
t = Ts()
h = DemuxHarness()
_t0 = time.monotonic()
while time.monotonic() - _t0 < 2.6:
    t.pkts = []
    h.push(t.pat().pmt([], PID_V).data())
    time.sleep(0.05)
check("tsdemux rejects such a table: no pad, no plan, no no-stream message (B-122)",
      not h.pads() and not h.messages("no-stream") and not h.messages("program")
      and h.el.get_property("generation") == -1 and not h.errors)
h.stop()

# --- 14. language ---------------------------------------------------------------------------
print("\n--- 14. cap-mux-align7-aac-opus: the TAG's language, and mpegtsmux's ISO 639 back ---")
h = replay_fixture("cap-mux-align7-aac-opus")
_tags = {n: h.events(n, "tag")[0][3] for n in h.pads()}
check(f"each pad's TAG carries the PMT's nor as tsdemux tags it, ISO 639-1 no, with its codec "
      f"({_tags})", all(v[0] == "no" for v in _tags.values()) and len(_tags) == 2
      and all("audio-codec=" in v[1] for v in _tags.values()))
h.stop()
_p = Gst.parse_launch(f'appsrc name=src format=time caps="{TS_CAPS}" ! mrtsdemux name=d ! '
                      f'aacparse ! mpegtsmux name=m ! appsink name=out sync=false')
_p.set_state(Gst.State.PLAYING)
_data = fixture("cap-mux-align7-aac-opus")
for _i in range(0, len(_data), 1316):
    _p.get_by_name("src").emit("push-buffer", Gst.Buffer.new_wrapped(_data[_i:_i + 1316]))
_p.get_by_name("src").emit("end-of-stream")
_out = []
while True:
    _smp = _p.get_by_name("out").emit("try-pull-sample", 3 * S)
    if _smp is None:
        break
    _out.append(_smp.get_buffer().extract_dup(0, _smp.get_buffer().get_size()))
_p.set_state(Gst.State.NULL)
from collections import deque  # noqa: E402
_pk = deque(ts_psi.iter_packets(b"".join(_out)))
_pat = ts_psi.parse_pat(_pk)
_mpmt = ts_psi.parse_pmt(_pk, next(iter(_pat.values()))) if _pat else None
_iso = [ei[i + 2:i + 5] for ei in (_mpmt["es_info"].values() if _mpmt else [])
        for i in range(0, len(ei) - 4) if ei[i] == 0x0A]
check(f"mrtsdemux ! aacparse ! mpegtsmux writes the AAC's language as ISO 639 nor again ({_iso})",
      _iso == [b"nor"])

# --- the KLV metadata cells, ID3, AV1 ---------------------------------------------------------
print("\n--- a 0x15 KLV metadata PES: its cells as a buffer list, each with its meta ---")
KLVA_META = bytes([0x26, 9, 0x01, 0x00, 0xFF]) + b"KLVA" + bytes([0x0F, 0x00])
_k = Ts().pat().pmt([(PID_V, 0x1B, b""), (0x44, 0x15, KLVA_META)], PID_V)
_cells = [b"\x06\x0e\x2b\x34cell-one", b"\x06\x0e\x2b\x34the second cell"]
for k in range(40):             # video with a PCR each 40 ms: tsdemux times nothing before
    for pk in fx.packetize(PID_V, fx.pes(0xE0, (T0 + k * 3600 + MUX_90K) % PTS_WRAP, None,
                                         b"\x00\x00\x00\x01\x09\x10"),
                           pcr27=((T0 + k * 3600 + MUX_90K - 900) % PTS_WRAP) * 300):
        _k.add(pk)
    if k % 8 == 7:
        au = b"".join(bytes([k, 0, 0xC0]) + len(c).to_bytes(2, "big") + c for c in _cells)
        _k.pes(0x44, (T0 + k * 3600 + MUX_90K) % PTS_WRAP, au)
_kd = _k.data()
_ours, _ref = DemuxHarness(running=pts90k_to_ns(T0)), DemuxHarness("tsdemux", latency=0)
for hh in (_ours, _ref):
    hh.push(_kd)
    hh.eos()
_kp = [n for n in _ours.pads() if n.startswith("private")]


def klv_shape(hh, n):
    return [(e[2], [b[3] for b in e[3]], [b[5] for b in e[3]]) for e in hh.pushes(n)]


def klv_cells(hh, n):
    return [(b[3], b[5]) for e in hh.pushes(n) for b in e[3]]


_shape, _flat = klv_shape, klv_cells
check(f"pad {_kp}: each of the 5 PES one list of its two cells, each with a "
      f"GstMpegtsPESMetadataMeta; the cells and metas as tsdemux's (which holds its first PES's "
      f"cells one by one until it times them)",
      _kp == ["private_0_0044"] and _shape(_ours, _kp[0]) == [(True, _cells, [True, True])] * 5
      and _flat(_ours, _kp[0]) == _flat(_ref, _kp[0]))
_ours.stop()
_ref.stop()

print("\n--- tp-id3: ID3 metadata PES flagged as tsdemux flags them ---")
_ours = replay_fixture("tp-id3")
_ref = replay_fixture("tp-id3", factory="tsdemux", latency=0)


def id3_flags(hh):
    return [(b[3], b[2] & int(Gst.BufferFlags.DELTA_UNIT)) for e in hh.pushes("private_0_0042")
            for b in e[3]]


_fl = id3_flags
check(f"the ID3 tags, their bytes and DELTA_UNIT flags, as tsdemux's ({len(_fl(_ours))})",
      _fl(_ours) == _fl(_ref) and len(_fl(_ours)) == 8)
_ours.stop()
_ref.stop()

print("\n--- AV1: the caps from the av1C descriptor, as tsdemux's ---")
_av1c = bytes([0x81, 0x08, 0x0C, 0x00])           # marker/version, profile 0 level 8, 8-bit 4:2:0
_es = bytes([0x05, 0x04]) + b"AV1G" + bytes([0x80, len(_av1c)]) + _av1c
_a = Ts().pat().pmt([(PID_V, 0x06, _es)], PID_V)
for k in range(3):                         # tsdemux plans a program once data follows its PMT
    _a.pes(PID_V, (T0 + k * 3600 + MUX_90K) % PTS_WRAP, b"\x12\x00\x0a\x0b\x00\x00\x00")
_ours, _ref = DemuxHarness(), DemuxHarness("tsdemux", latency=0)
for hh in (_ours, _ref):
    hh.push(_a.data())
    hh.eos()


def added_caps(hh):
    return [e[2] for e in hh.log if e[0] == "pad-added"]


_ac = added_caps
check(f"video/x-av1 with its av1C fields and codec_data, as tsdemux's ({_ac(_ours)})",
      len(_ac(_ours)) == 1 and _ac(_ours) == _ac(_ref) and "codec_data" in _ac(_ours)[0])
_ours.stop()
_ref.stop()

# --- queries, flush, EOS, the interval message ------------------------------------------------
print("\n--- queries: LATENCY is upstream's, SEEKING not seekable ---")
h = DemuxHarness(start=False)


def _upstream_query(_pad, _parent, q):
    if q.type == Gst.QueryType.LATENCY:
        q.set_latency(True, 10 * MS, 50 * MS)
        return True
    return False


h.src.set_query_function_full(_upstream_query)
h.start()
h.chunks(fixture("cap-vmix-h264-aac"), 1316)
_pad = h.el.get_static_pad("video_0_0101")
_lq = Gst.Query.new_latency()
_sq = Gst.Query.new_seeking(Gst.Format.TIME)
check(f"a demux pad answers LATENCY as upstream plus 0 and SEEKING as not seekable",
      _pad.query(_lq) and _lq.parse_latency() == (True, 10 * MS, 50 * MS)
      and _pad.query(_sq) and _sq.parse_seeking()[1] is False)

print("\n--- flush: to every pad; the segment again, no second TAG; DISCONT next ---")
_mark = len(h.log)
h.src.push_event(Gst.Event.new_flush_start())
h.src.push_event(Gst.Event.new_flush_stop(True))
_seg = Gst.Segment()
_seg.init(Gst.Format.TIME)
h.src.push_event(Gst.Event.new_segment(_seg))
h.chunks(fixture("cap-vmix-h264-aac"), 1316)
_after = h.log[_mark:]
_per = {n: [e[2] if e[0] == "event" else "push" for e in _after if e[1:2] == (n,)][:5]
        for n in h.pads()}
check(f"each pad: flush-start, flush-stop, then the segment before its next buffer, no TAG "
      f"({_per})",
      len(_per) == 2 and all(v[:4] == ["flush-start", "flush-stop", "segment", "push"]
                             for v in _per.values()))
_firsts = {n: next(e for e in _after if e[0] == "push" and e[1] == n)[3][0][2] & DISCONT
           for n in h.pads()}
check(f"the first buffer after the flush is DISCONT on every pad ({_firsts})",
      all(v for v in _firsts.values()))

print("\n--- EOS: EOS on every pad, and the last report ---")
h.eos()
_eos = [n for n in h.pads() if h.events(n, "eos")]
check(f"EOS on every pad ({_eos}); the EOS interval message counts the units and names the "
      f"pads and the generation",
      _eos == h.pads() and h.messages("interval")[-1]["pes"] == h.el.get_property("pes")
      and h.messages("interval")[-1]["pads"] == "audio_0_0100,video_0_0101"
      and h.messages("interval")[-1]["generation"] == 0
      and h.messages("interval")[-1]["unknown-streams"] == 0)
h.stop()
check("a stop removes the pads", [e[0] for e in h.log[-2:]] == ["pad-removed", "pad-removed"])

print("\n--- unknown streams: one message per PID per program, no pad ---")
h = replay_fixture("tp-h264-dts")
_um = h.messages("unknown-stream")
check(f"tp-h264-dts: the DTS PID warned once, stream type 0x82, no pad for it "
      f"({[(m['pid'], m['stream-type'], m['registration']) for m in _um]})",
      [(m["pid"], m["stream-type"], m["generation"]) for m in _um] == [(257, 130, 0)]
      and h.pads() == ["video_0_0100"] and h.el.get_property("unknown-streams") == 1)
h.stop()

print("\n--- gst_parse links a demux pad with no GStreamer warning ---")
_w = subprocess.run([sys.executable, "-c", (
    "import sys, gi; gi.require_version('Gst', '1.0'); from gi.repository import Gst; "
    f"Gst.init(sys.argv); Gst.Plugin.load_file({_SO!r}); "
    "[Gst.parse_launch(f'appsrc ! mrtsdemux ! {d} ! fakesink') for d in "
    "('queue', 'opusdec', 'capsfilter caps=video/x-h264', 'avdec_s302m')]")],
    capture_output=True, text=True)
check(f"appsrc ! mrtsdemux ! <queue, opusdec, capsfilter, avdec_s302m>: no warning "
      f"({_w.stderr.strip()[:120]!r})", _w.returncode == 0 and "WARN" not in _w.stderr)

if _failures:
    print(f"\n{len(_failures)} FAILURE(S) in gst_mrtsdemux_element_test.py")
    sys.exit(1)
print("\nALL gst_mrtsdemux_element_test.py TESTS PASSED")
