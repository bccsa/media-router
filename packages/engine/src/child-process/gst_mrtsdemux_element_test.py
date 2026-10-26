#!/usr/bin/env python3
"""Tests for mrtsdemux (plan ch. 6 WI-P2-7), the formula demux in select mode, in the Python
runner's interpreter, driving the element over its pads (a harness, not a twin; chapter 3 part
4.5 rule 1):

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

Skips (exit 0) without GStreamer, the built plugin, or gst-libav's s302m codec."""
import os
import subprocess
import sys
import time

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import GObject, Gst
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
_ro = ["pid", "pes", "gaps", "markers", "markers-dropped"]
check("defaults: no select, program-number -1, pid -1, counters 0",
      _el.get_property("select") is None and _el.get_property("program-number") == -1
      and _el.get_property("pid") == -1 and all(_el.get_property(p) == 0 for p in _ro[1:]))
check("select and program-number apply at a start; pid and the counters are read-only",
      all(_el.find_property(p).flags & Gst.PARAM_MUTABLE_READY for p in ("select",
                                                                        "program-number"))
      and all(not _el.find_property(p).flags & GObject.ParamFlags.WRITABLE for p in _ro))
_tmpl = {t.name_template: (t.direction, t.presence, t.get_caps().to_string())
         for t in _f.get_static_pad_templates()}
check(f"one ALWAYS sink of MPEG-TS and one ALWAYS src ({_tmpl})",
      _tmpl.get("sink") == (Gst.PadDirection.SINK, Gst.PadPresence.ALWAYS,
                            "video/mpegts, systemstream=(boolean)true")
      and _tmpl.get("src", (None, None))[:2] == (Gst.PadDirection.SRC, Gst.PadPresence.ALWAYS)
      and len(_tmpl) == 2)
_inspect = subprocess.run(["gst-inspect-1.0", f"--gst-plugin-load={_SO}", "mrtsdemux"],
                          capture_output=True, text=True)
check("gst-inspect-1.0 lists select, program-number and the counters",
      _inspect.returncode == 0 and all(f"\n  {p}" in _inspect.stdout for p in
                                       ["select", "program-number"] + _ro))

print("\n--- select is required and must name a stream select mode knows ---")
for bad in ("", "audio/mpeg", "audio/x-smpte-302m; audio/mpeg", "not caps ((("):
    h = Harness(select=bad if bad else None, start=False)
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

if _failures:
    print(f"\n{len(_failures)} FAILURE(S) in gst_mrtsdemux_element_test.py")
    sys.exit(1)
print("\nALL gst_mrtsdemux_element_test.py TESTS PASSED")
