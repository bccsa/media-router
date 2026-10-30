#!/usr/bin/env python3
"""Tests for mrasrc (plan ch. 5 WI-P1-8, part 4.5), the capture ASRC: mrts::AsrcServo driving
GstAudioResampler, in the Python runner's interpreter over its own pads and appsrc/appsink (a
harness, not a twin; chapter 3 part 4.5 rule 1). A synthetic device runs at a known rate with
known PTS jitter, so the capture time of every input frame is known:

  - the acceptance: a 1 kHz sine at a 1.0002 ratio has THD+N below -90 dBFS (S16LE, S32LE,
    F32LE), and every output PTS is T0 + floor(m * 1e9 / out_rate) to the nanosecond;
  - the labels are capture time: the output tone's phase against its labels within one frame;
  - the lock: acquiring through the 30-bucket first fit, locked by 37 s at +-50 ppm with 1 ms
    jitter; the ratio follows the device;
  - relocks: an xrun (DISCONT + 20 ms) jumps the PTS forward by 20 ms; a DISCONT stepping back
    and a -60 ms capture-latency fall without one drop the overlap, the PTS never going back;
    a device past the +-1000 ppm clamp raises ratio-out-of-bounds;
  - cycle-input (B-180): a lost cycle is one gap of its length and no relock, a cycle-size change
    moves the stamps only; without the property the same input is the lock's, as before; the time
    a restarted driver lost (no whole cycle, B-181) is one gap too, where the lock relocked a minute in;
  - mrasrc-stats and mrasrc-event as part 10 names them; offsets; the `stats` snapshot;
  - caps: out-rate=0 keeps the input's rate or takes downstream's (44.1 kHz into the capture
    branches' rate=48000 capsfilter), out-rate converts, format and channels pass through,
    anything else is refused;
  - the latency query, the drained tail at EOS, a flush, gst-inspect-1.0;
  - decode mode (WI-P3-5, part 4.4): a source 10 ppm fast through formula PTS engages and then
    counts 48,000 frames per house second; real decoders (avdec_aac, opusdec) pass their input PTS
    through and a house-rate stream passes mrasrc unchanged, the same memory (zero copy), while a
    foreign one engages; device mode into tests/libgstmrtest.so's mrtestaudiosink 40 ppm fast on a
    2x clock: no skew, no resync, the ring's fill held; decode and device in one ratio; a
    device-sink that cannot be followed is an error naming it.

Skips (exit 0) without GStreamer, numpy or the built plugin."""
import os
import subprocess
import sys

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import GObject, Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_mrasrc_element_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)
try:
    import numpy as np
except ImportError as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_mrasrc_element_test.py — numpy unavailable ({exc})")
    sys.exit(0)

Gst.init(sys.argv)

_HERE = os.path.dirname(os.path.abspath(__file__))
# The plugin from MR_PLUGINS_DIR when set (a mutant, an install), else this repository's.
_SO = os.path.join(os.environ.get("MR_PLUGINS_DIR") or os.path.normpath(
    os.path.join(_HERE, "..", "..", "..", "..", "plugins")),
    "mpegts-core", "native", "mrtshouse", "libgstmrtshouse.so")
if not os.path.exists(_SO):
    print(f"SKIP gst_mrasrc_element_test.py — mrtshouse plugin not built ({_SO}); "
          "run `make native`")
    sys.exit(0)
plugin = Gst.Plugin.load_file(_SO)   # a file that is there but does not load is a failure

S, MS, US = 1_000_000_000, 1_000_000, 1_000
FS = 48000
FRAME_NS = S // FS               # one 48 kHz frame, 20833 ns
H0 = 1000 * S                    # house time of the first captured frame
BUF = 1024                       # frames per input buffer, as pipewiresrc's quantum
DELAY = 32                       # quality 4: 64 taps, the filter's lookahead
FULL = {"S16LE": ("<i2", 32768.0), "S32LE": ("<i4", 2147483648.0), "F32LE": ("<f4", 1.0)}

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def sdict(st):
    return {st.nth_field_name(i): st.get_value(st.nth_field_name(i)) for i in range(st.n_fields())}


# --- the device and the harness ------------------------------------------------------------

class Capture:
    """A device clock at FS * num / den frames per house second: input frame i is captured at
    H0 + floor(i * den * S / (FS * num)). PTS = capture time + U[0, jitter) (+ `step` from
    capture time `step_at`). An xrun at `xrun_at` loses `xrun_ns` of input and flags the next
    buffer DISCONT. Content: a tone at `tone` Hz of the device's own time, `amp` of full scale."""

    def __init__(self, num=1, den=1, jitter=0, seed=1, tone=1000.0, amp=0.891, fmt="F32LE",
                 channels=1, rate=FS, formula=False):
        self.num, self.den, self.jitter, self.tone, self.amp = num, den, jitter, tone, amp
        self.formula = formula   # PTS: capture time through a producer's mux and the demux (S12)
        self.fmt, self.channels, self.rate = fmt, channels, rate
        self.rng = np.random.default_rng(seed)
        self.step_at, self.step, self.step_discont = None, 0, True
        self.xrun_at, self.xrun_ns = None, 0
        self.stepped = False
        self.pushed = 0          # input frames handed to the element
        self.nbuf = 0            # ... in this many buffers

    def capture_ns(self, i):
        return H0 + (i * self.den * S) // (self.rate * self.num)

    def house_hz(self):
        """The tone in house time: the device's frames at their real rate."""
        return self.tone * self.num / self.den

    def caps(self):
        mask = ",channel-mask=(bitmask)0x0" if self.channels > 2 else ""   # unpositioned
        return (f"audio/x-raw,format={self.fmt},rate={self.rate},channels={self.channels},"
                f"layout=interleaved{mask}")

    def render(self, i, n):
        x = self.amp * np.sin(2 * np.pi * self.tone * np.arange(i, i + n) / self.rate)
        dt, full = FULL[self.fmt]
        a = x.astype(dt) if self.fmt == "F32LE" else np.round(x * (full - 1)).astype(dt)
        return np.repeat(a[:, None], self.channels, axis=1).tobytes()

    def buffers(self, secs):
        """(pts, data, discont) for `secs` of capture time."""
        out, i, first = [], 0, True
        end = H0 + int(secs * S)
        while self.capture_ns(i) < end:
            c = self.capture_ns(i)
            disc = first
            if self.xrun_at is not None and c >= self.xrun_at:
                i += self.xrun_ns * self.rate // S       # those frames never arrive
                c = self.capture_ns(i)
                self.xrun_at, disc = None, True
            pts = c + (int(self.rng.integers(0, self.jitter)) if self.jitter else 0)
            if self.formula:
                pts = -((-(pts * 9 // 100000) * 100000) // 9)
            if self.step_at is not None and c >= self.step_at:
                pts += self.step
                disc = disc or (self.step_discont and not self.stepped)
                self.stepped = True
            n = min(BUF, max(1, (end - c) * self.rate // S))
            out.append((pts, self.render(i, n), disc))
            self.pushed += n
            self.nbuf += 1
            i += n
            first = False
        return out


class Harness:
    """Own src pad -> mrasrc -> own sink pad, in a pipeline for its bus: a push runs the element
    in this thread, outputs and messages arrive in order. The sink pad answers caps queries with
    `sink_caps`; the src pad answers latency queries with 10 ms .. 30 ms, live."""

    def __init__(self, caps, sink_caps=None, keep=None, **props):
        self.keep = keep   # keep(pts) -> whether to keep an output's samples (None: all)
        self.pipe = Gst.Pipeline.new(None)
        self.el = Gst.ElementFactory.make("mrasrc", "asrc")
        self.pipe.add(self.el)
        self.src = Gst.Pad.new("h_src", Gst.PadDirection.SRC)
        self.sink = Gst.Pad.new("h_sink", Gst.PadDirection.SINK)
        self.sink_caps = Gst.Caps.from_string(sink_caps) if sink_caps else Gst.Caps.new_any()
        self.out, self.msgs, self.events, self.out_caps, self.in_mem, self.in_pts = [], [], [], None, [], []
        self.sink.set_chain_function_full(self._chain)
        self.sink.set_event_function_full(self._event)
        self.sink.set_query_function_full(self._sink_query)
        self.src.set_query_function_full(self._src_query)
        # Linked before the properties: a link checks caps, and an out-rate the sink refuses
        # must fail at negotiation, where the capture branches would meet it.
        assert self.src.link(self.el.get_static_pad("sink")) == Gst.PadLinkReturn.OK
        assert self.el.get_static_pad("src").link(self.sink) == Gst.PadLinkReturn.OK
        for k, v in props.items():
            self.el.set_property(k.replace("_", "-"), v)
        self.pipe.get_bus().set_sync_handler(self._on_message)
        self.src.set_active(True)
        self.sink.set_active(True)
        self.pipe.set_state(Gst.State.PLAYING)
        self.src.push_event(Gst.Event.new_stream_start("mrasrc-test"))
        self.caps_ok = self.src.push_event(Gst.Event.new_caps(Gst.Caps.from_string(caps)))
        seg = Gst.Segment()
        seg.init(Gst.Format.TIME)
        self.src.push_event(Gst.Event.new_segment(seg))

    def _chain(self, pad, parent, buf):
        keep = self.keep is None or self.keep(buf.pts)
        self.out.append({"pts": buf.pts, "dur": buf.duration, "flags": int(buf.get_flags()),
                         "offset": buf.offset, "offset_end": buf.offset_end, "size": buf.get_size(),
                         "mem": hash(buf.peek_memory(0)) if buf.n_memory() else 0,
                         "data": buf.extract_dup(0, buf.get_size()) if keep else b""})
        return Gst.FlowReturn.OK

    def _event(self, pad, parent, event):
        self.events.append(event.type)
        if event.type == Gst.EventType.CAPS:
            self.out_caps = event.parse_caps().get_structure(0)
        return True

    def _sink_query(self, pad, parent, q):
        if q.type == Gst.QueryType.CAPS:
            f = q.parse_caps()
            q.set_caps_result(self.sink_caps if f is None else f.intersect(self.sink_caps))
            return True
        if q.type == Gst.QueryType.ACCEPT_CAPS:
            q.set_accept_caps_result(q.parse_accept_caps().can_intersect(self.sink_caps))
            return True
        return False

    def _src_query(self, pad, parent, q):
        if q.type == Gst.QueryType.LATENCY:
            q.set_latency(True, 10 * MS, 30 * MS)
            return True
        return False

    def _on_message(self, bus, msg):
        if msg.type == Gst.MessageType.ELEMENT and msg.src == self.el:
            st = msg.get_structure()
            self.msgs.append((st.get_name(), sdict(st)))
        return Gst.BusSyncReply.DROP

    def push(self, pts, data, discont=False, dur=None):
        b = Gst.Buffer.new_wrapped(data)
        b.pts, b.dts = pts, Gst.CLOCK_TIME_NONE
        b.duration = Gst.CLOCK_TIME_NONE if dur is None else dur
        if discont:
            b.set_flags(Gst.BufferFlags.DISCONT)
        self.in_mem.append(hash(b.peek_memory(0)))
        self.in_pts.append(pts)
        return self.src.push(b)

    def drive(self, bufs, eos=True):
        rets = [self.push(*b) for b in bufs]
        if eos:
            self.src.push_event(Gst.Event.new_eos())
        return rets

    def stop(self):
        self.pipe.set_state(Gst.State.NULL)

    def messages(self, name):
        return [d for n, d in self.msgs if n == name]


def run(cap, secs, eos=True, **props):
    h = Harness(cap.caps(), **props)
    h.drive(cap.buffers(secs), eos=eos)
    return h


def samples(h, cap):
    """The output's first channel as floats in [-1, 1], and each frame's label."""
    dt, full = FULL[cap.fmt]
    y = np.frombuffer(b"".join(o["data"] for o in h.out), dtype=dt)
    y = y.reshape(-1, cap.channels)[:, 0].astype(np.float64) / full
    t, epoch_pts, m = [], None, 0
    for o in h.out:
        n = len(o["data"]) // (cap.channels * np.dtype(dt).itemsize)
        if epoch_pts is None or o["flags"] & int(Gst.BufferFlags.DISCONT):
            epoch_pts, m = o["pts"], 0
        t.append(epoch_pts + (np.arange(m, m + n, dtype=np.int64) * S) // FS)
        m += n
    return y, (np.concatenate(t) if t else np.zeros(0, dtype=np.int64))


def label_errors(y, t, f_house, shift_ns=0, window=FS // 4, skip_near=()):
    """Per window: label - capture time of its content (us), from the tone's phase against
    the labels. `shift_ns`: the PTS domain's offset from capture time (a step); windows within
    2 filter lengths of a label in `skip_near` are left out."""
    out = []
    for k in range(0, len(y) - window, window):
        seg_t = t[k:k + window]
        if any(abs(int(seg_t[0]) - s) < 2 * window * FRAME_NS for s in skip_near):
            continue
        tau = (seg_t - H0 - shift_ns) / S
        a = np.stack([np.sin(2 * np.pi * f_house * tau), np.cos(2 * np.pi * f_house * tau)], 1)
        c, *_ = np.linalg.lstsq(a, y[k:k + window], rcond=None)
        out.append((int(seg_t[0]) - H0, -np.arctan2(c[1], c[0]) / (2 * np.pi * f_house) * 1e6))
    return out


def bh7(n):
    a = [0.27105140069342, 0.43329793923448, 0.21812299954311, 0.06592544638803,
         0.01081174209837, 0.00077658482522, 0.00001388721735]
    k = np.arange(n)
    return sum((-1) ** j * aj * np.cos(2 * np.pi * j * k / n) for j, aj in enumerate(a))


def thdn(y, notch_hz=50.0, n=65536):
    """THD+N as an analyzer reads it (AES17): the power from 20 Hz to 20 kHz with the
    fundamental notched out (+-notch_hz around the spectral peak), in dB re a full-scale sine;
    the worst of half-overlapped 7-term Blackman-Harris windows. Also the worst power between
    the window's main lobe (+-7 bins, 5.1 Hz) and the notch, in dB re the tone: the FM of the
    ratio steering."""
    w = bh7(n)
    f = np.arange(n // 2 + 1) * FS / n
    band = (f >= 20) & (f <= 20000)
    worst, near = -999.0, -999.0
    for k in range(0, len(y) - n + 1, n // 2):
        p = np.abs(np.fft.rfft(y[k:k + n] * w)) ** 2
        peak = f[np.argmax(np.where(band, p, 0))]
        off = np.abs(f - peak)
        ms = 2 * p[band & (off > notch_hz)].sum() / (n * (w ** 2).sum())   # mean square
        worst = max(worst, 10 * np.log10(ms / 0.5))
        near = max(near, 10 * np.log10(p[band & (off > 6) & (off <= notch_hz)].sum()
                                       / p[band & (off <= 6)].sum()))
    return worst, near


def contiguous(out):
    """Within each epoch PTS + duration = the next PTS; across a DISCONT the PTS only rises."""
    for a, b in zip(out, out[1:]):
        if b["flags"] & int(Gst.BufferFlags.DISCONT):
            if b["pts"] < a["pts"] + a["dur"]:
                return False
        elif a["pts"] + a["dur"] != b["pts"]:
            return False
    return True


def on_formula(out, rate=FS):
    """Every buffer's PTS and duration are T0 + floor(m * 1e9 / rate) of its epoch's counter."""
    t0, m = None, 0
    for o in out:
        n = (o["offset_end"] - o["offset"])
        if t0 is None or o["flags"] & int(Gst.BufferFlags.DISCONT):
            t0, m = o["pts"], 0
        if o["pts"] != t0 + (m * S) // rate or o["dur"] != t0 + ((m + n) * S) // rate - o["pts"]:
            return False
        m += n
    return True


def discont_at(out):
    return [i for i, o in enumerate(out) if o["flags"] & int(Gst.BufferFlags.DISCONT)]


# --- the property contract -------------------------------------------------------------------
print("--- gst-inspect-1.0 and the property contract ---")
PROPS = ["out-rate", "quality", "cycle-input", "stats", "bypass-below-ppm", "device-sink", "abi",
         "desync-bytes", "cc-lost", "pes-oversize", "pes-dropped-cc", "header-spans",
         "psi-unsupported-sections", "pes-no-pts", "dts-discarded"]
_inspect = subprocess.run(["gst-inspect-1.0", f"--gst-plugin-load={_SO}", "mrasrc"],
                          capture_output=True, text=True)
_listed = [p for p in PROPS if f"\n  {p} " in _inspect.stdout or f"\n  {p}:" in _inspect.stdout]
check(f"gst-inspect-1.0 lists every property ({len(_listed)}/{len(PROPS)}: missing "
      f"{sorted(set(PROPS) - set(_listed))})", _inspect.returncode == 0 and _listed == PROPS)
check("gst-inspect-1.0: a GstBaseTransform taking S16LE, S32LE, F32LE interleaved, 1-768 kHz",
      "GstBaseTransform" in _inspect.stdout and "S16LE" in _inspect.stdout
      and "S32LE" in _inspect.stdout and "F32LE" in _inspect.stdout
      and "[ 1000, 768000 ]" in _inspect.stdout and "interleaved" in _inspect.stdout)
_f = Gst.ElementFactory.find("mrasrc")
check("the factory table registers mrasrc at rank NONE in mrtshouse",
      _f is not None and _f.get_rank() == Gst.Rank.NONE and _f.get_plugin_name() == "mrtshouse")
_el = Gst.ElementFactory.make("mrasrc", None)
_or, _q = _el.find_property("out-rate"), _el.find_property("quality")
_ci = _el.find_property("cycle-input")
check("out-rate: 0 (the input's rate) by default, 0..768000; quality 4 by default, 0..10; "
      "cycle-input off by default (B-180); all apply at a start",
      _el.get_property("out-rate") == 0 and _or.minimum == 0 and _or.maximum == 768000
      and _el.get_property("quality") == 4 and _q.minimum == 0 and _q.maximum == 10
      and _el.get_property("cycle-input") is False
      and all(p.flags & Gst.PARAM_MUTABLE_READY for p in (_or, _q, _ci)))
_st = _el.find_property("stats")
_s0 = _el.get_property("stats")
STATS_FIELDS = ["state", "ratio-ppb", "phase-err-ns", "relocks", "in-frames", "out-frames",
                "discont-in", "dropped-frames", "gaps", "lost-frames", "mode", "source-ppb", "device-ppb"]
COUNT_FIELDS = [k for k in STATS_FIELDS[1:] if k != "mode"]
check("stats is read-only; a fresh element's: mrasrc-stats, acquiring, mode capture, every count 0",
      not _st.flags & GObject.ParamFlags.WRITABLE and _s0.get_name() == "mrasrc-stats"
      and [_s0.nth_field_name(i) for i in range(_s0.n_fields())] == STATS_FIELDS
      and _s0.get_value("state") == "acquiring" and _s0.get_value("mode") == "capture"
      and all(_s0.get_value(k) == 0 for k in COUNT_FIELDS))
_bp, _ds = _el.find_property("bypass-below-ppm"), _el.find_property("device-sink")
check("bypass-below-ppm: 0 (capture) by default, 0..1000; device-sink: \"\" by default; both apply at "
      "a start (WI-P3-5)",
      _el.get_property("bypass-below-ppm") == 0.0 and _bp.minimum == 0.0 and _bp.maximum == 1000.0
      and _el.get_property("device-sink") == "" and all(p.flags & Gst.PARAM_MUTABLE_READY for p in (_bp, _ds)))

# --- the acceptance: THD+N and the PTS formula at a 1.0002 ratio -----------------------------
print("\n--- a 1 kHz sine at a 1.0002 ratio (device 199.96 ppm slow, 1 ms jitter), 60 s ---")
for fmt in ("F32LE", "S32LE", "S16LE"):
    cap = Capture(num=10000, den=10002, jitter=MS, seed=7, fmt=fmt, channels=2)
    h = run(cap, 60)
    y, t = samples(h, cap)
    after = int((40 * S - (h.out[0]["pts"] - H0)) * FS // S)   # from 40 s: locked
    worst, near = thdn(y[after:])
    final = h.messages("mrasrc-stats")[-1]
    check(f"{fmt}: THD+N below -90 dBFS from the lock on ({worst:.1f} dBFS; AES17: 20 Hz-20 kHz, "
          "the tone notched +-50 Hz), locked", worst < -90.0 and final["state"] == "locked")
    check(f"{fmt}: the steering's FM next to the tone stays below -80 dB re it ({near:.1f} dB, "
          "6-50 Hz off: the servo's one-frame phase steps, ~10 Hz here)", near < -80.0)
    check(f"{fmt}: every output PTS is T0 + floor(m * 1e9 / 48000), duration to the next, no "
          f"DISCONT after the first ({len(h.out)} buffers)",
          on_formula(h.out) and contiguous(h.out) and discont_at(h.out) == [0])
    h.stop()

# --- labels are capture time -------------------------------------------------------------------
print("\n--- labels: the output tone's phase against its PTS ---")
cap = Capture(tone=100.0)
h = run(cap, 20)
y, t = samples(h, cap)
errs = label_errors(y, t, cap.house_hz())
_e = [e for _, e in errs]
check(f"device at nominal, clean PTS: every 250 ms window's label within 1 frame of its capture "
      f"time from the first ({min(_e):+.2f} .. {max(_e):+.2f} us; GStreamer centres 1/8 frame "
      "early, +2.6 us)", max(abs(e) for e in _e) < FRAME_NS / US and abs(np.mean(_e) - 2.6) < 1)
check(f"T0 is the first buffer's PTS ({h.out[0]['pts'] - H0} ns from it), the first output "
      "DISCONT", h.out[0]["pts"] == H0 and discont_at(h.out) == [0])
h.stop()

cap = Capture(num=999950, den=1000000, jitter=MS, seed=3, tone=100.0)
h = run(cap, 130)
y, t = samples(h, cap)
errs = label_errors(y, t, cap.house_hz())
_late = [e for at, e in errs if at >= 70 * S]
_bad = [at for at, e in errs if abs(e) * US > FRAME_NS]
final = h.messages("mrasrc-stats")[-1]
check(f"device -50 ppm, 1 ms jitter: labels within 1 frame from 70 s to 130 s "
      f"({min(_late):+.2f} .. {max(_late):+.2f} us; last out at "
      f"{max(_bad) / S if _bad else -1:.2f} s; the "
      "servo test's model: 65.9 s)", max(abs(e) for e in _late) * US < FRAME_NS)
check(f"... the ratio is the device's +50.0025 ppm +-3 ppm at 130 s "
      f"({final['ratio-ppb'] / 1000:+.3f} ppm): with the labels on the counter, 48,000 frames "
      "per house second", abs(final["ratio-ppb"] - 50003) <= 3000)
h.stop()

# --- the lock ------------------------------------------------------------------------------------
print("\n--- the lock: +-50 ppm, 1 ms jitter, EOS at 37 s ---")
for num, den, seed in ((1000050, 1000000, 11), (999950, 1000000, 12), (1000050, 1000000, 13)):
    cap = Capture(num=num, den=den, jitter=MS, seed=seed)
    h = run(cap, 37)
    states = [(d["state"], d["out-frames"] / FS) for d in h.messages("mrasrc-stats")]
    early = [s for s, at in states[:-1] if at <= 34]
    check(f"{(num - den) / 1:+.0f} ppm seed {seed}: acquiring through the first fit (posts to "
          f"34 s: {sorted(set(early))}), locked at the EOS post (37 s: {states[-1][0]})",
          set(early) == {"acquiring"} and len(early) >= 16 and states[-1][0] == "locked")
    h.stop()

# --- relocks -------------------------------------------------------------------------------------
print("\n--- an xrun: DISCONT + 20 ms lost at 50 s (clean PTS) ---")
cap = Capture(tone=100.0)
cap.xrun_at, cap.xrun_ns = H0 + 50 * S, 20 * MS
h = run(cap, 70)
ev = h.messages("mrasrc-event")
d = discont_at(h.out)
jump = h.out[d[1]]["pts"] - (h.out[d[1] - 1]["pts"] + h.out[d[1] - 1]["dur"]) if len(d) == 2 else 0
check(f"one relock, reason discont ({[(e['kind'], e['reason']) for e in ev]})",
      len(ev) == 1 and ev[0]["kind"] == "relock" and ev[0]["reason"] == "discont")
check(f"one forward PTS jump of 20 ms +-1 frame on a DISCONT buffer ({jump / MS:.6f} ms), the "
      "event's jump-ns and house-ns (the new T0) the same",
      len(d) == 2 and abs(jump - 20 * MS) <= FRAME_NS and ev[0]["jump-ns"] == jump
      and ev[0]["house-ns"] == h.out[d[1]]["pts"] and ev[0]["dropped-ns"] == 0)
y, t = samples(h, cap)
errs = label_errors(y, t, cap.house_hz(), skip_near=[h.out[d[1]]["pts"]] if len(d) == 2 else [])
check(f"labels within 1 frame of capture time before and after it "
      f"({max(abs(e) for _, e in errs):.2f} us)", max(abs(e) for _, e in errs) * US < FRAME_NS)
final = h.messages("mrasrc-stats")[-1]
check(f"stats: discont-in 1, relocks 1, nothing dropped ({final})",
      final["discont-in"] == 1 and final["relocks"] == 1 and final["dropped-frames"] == 0)
h.stop()

print("\n--- a DISCONT whose PTS steps back 60 ms at 40 s (clean PTS) ---")
cap = Capture(tone=100.0)
cap.step_at, cap.step = H0 + 40 * S, -60 * MS
h = run(cap, 60)
ev = h.messages("mrasrc-event")
d = discont_at(h.out)
final = h.messages("mrasrc-stats")[-1]
want = 60 * MS * FS // S
check(f"one relock (discont), no PTS jump, the overlap dropped: {final['dropped-frames']} frames, "
      f"{ev[0]['dropped-ns'] / MS if ev else 0:.3f} ms (60 ms +-1 frame)",
      len(ev) == 1 and ev[0]["reason"] == "discont" and ev[0]["jump-ns"] == 0
      and abs(final["dropped-frames"] - want) <= 1
      and abs(ev[0]["dropped-ns"] - 60 * MS) <= FRAME_NS)
check("the PTS never goes back: one counter, the relock's output DISCONT on its own end",
      len(d) == 2 and contiguous(h.out) and h.out[d[1]]["pts"] == h.out[d[1] - 1]["pts"]
      + h.out[d[1] - 1]["dur"] and all(len(o["data"]) > 0 for o in h.out))
y, t = samples(h, cap)
_t1 = h.out[d[1]]["pts"] if len(d) == 2 else 0
before = label_errors(y[t < _t1], t[t < _t1], cap.house_hz())
after = label_errors(y[t >= _t1], t[t >= _t1], cap.house_hz(), shift_ns=-60 * MS)
_soon = [e for at, e in after if at < _t1 - H0 + 5 * S]
_later = [e for at, e in after if at >= _t1 - H0 + 5 * S]
_before = [e for _, e in before] or [1e9]
_soon, _later = _soon or [1e9], _later or [1e9]
# The drop is whole frames rounded down (AsrcServo::frames_over) and GStreamer centres an output
# 1/8 frame early, so the first labels after it are late by up to 1 1/8 frames; the phase loop
# takes that out.
check(f"labels stay capture time on the PTS's new domain: before {max(map(abs, _before)):.2f} "
      f"us, the first 5 s after the drop {min(_soon):+.2f} .. {max(_soon):+.2f} us (late, by at "
      f"most 1 1/8 frames), then within 1 frame ({max(map(abs, _later)):.2f} us)",
      max(map(abs, _before)) * US < FRAME_NS and min(_soon) > 0
      and max(_soon) * US < FRAME_NS * 9 // 8 + 500 and max(map(abs, _later)) * US < FRAME_NS)
_k = int(np.searchsorted(t, _t1))
_ideal = cap.amp * np.sin(2 * np.pi * cap.house_hz() * (t[_k:_k + FS // 2] - H0 + 60 * MS) / S)
_dev = float(np.max(np.abs(y[_k:_k + FS // 2] - _ideal))) if _k < len(y) else 9.0
check(f"sample by sample the half second after the relock is the capture's tone at its labels "
      f"(within {_dev:.4f} of full scale; a frame of label error is 0.012): the head of the input "
      "was dropped, nothing captured before the drop's end leaks in", _dev < 0.02)
check("in-frames is every frame pushed, out-frames every frame out before the tail",
      final["in-frames"] == cap.pushed and final["out-frames"] ==
      sum(len(o["data"]) // 4 for o in h.out[:-1]))
h.stop()

print("\n--- a -60 ms capture-latency fall at 40 s, no DISCONT (1 ms jitter) ---")
cap = Capture(jitter=MS, seed=5, tone=100.0)
cap.step_at, cap.step, cap.step_discont = H0 + 40 * S, -60 * MS, False
h = run(cap, 70)
ev = h.messages("mrasrc-event")
d = discont_at(h.out)
_at = (ev[0]["house-ns"] - H0 - 40 * S) / S if ev else -1
check(f"one relock, reason envelope-step, 9-10 s after the fall ({_at:.2f} s), no PTS jump, "
      f"{ev[0]['dropped-ns'] / MS if ev else 0:.3f} ms dropped (the servo test's 59.935)",
      len(ev) == 1 and ev[0]["reason"] == "envelope-step" and 9 <= _at <= 10.5
      and ev[0]["jump-ns"] == 0 and 59 * MS <= ev[0]["dropped-ns"] <= 61 * MS)
check("the relock's first output is DISCONT though no input was (the element's own flag), and "
      "the counter runs on", len(d) == 2 and contiguous(h.out) and on_formula(h.out))
y, t = samples(h, cap)
_t1 = h.out[d[1]]["pts"] if len(d) == 2 else 0
_after = [e for _, e in label_errors(y[t >= _t1], t[t >= _t1], cap.house_hz(),
                                     shift_ns=-60 * MS)]
check(f"labels within 1 frame of capture time from the relock on, on the new floor "
      f"({min(_after):+.2f} .. {max(_after):+.2f} us)" if _after else "labels: no windows",
      bool(_after) and max(abs(e) for e in _after) * US < FRAME_NS)
h.stop()

# --- cycle input (B-180) ----------------------------------------------------------------------
def cycle_buffers(cap, secs, cycle=2048, lost_s=(), durations=True, restart=None):
    """pipewiresrc's shape: a buffer per cycle of `cycle` frames, stamped with the capture time of
    its first frame (+ jitter), its duration the cycle's; a cycle at a capture second in `lost_s`
    never arrives (its frames are gone, the next stamp shows it). `restart` (second, frames): the
    driver restarts after losing that many frames, its cycles starting afresh (no whole cycle)."""
    out, i, lost = [], 0, sorted(lost_s)
    end = H0 + int(secs * S)
    while cap.capture_ns(i) < end:
        if lost and cap.capture_ns(i) >= H0 + lost[0] * S:
            lost.pop(0)
            i += cycle
            continue
        if restart and cap.capture_ns(i) >= H0 + int(restart[0] * S):
            i += restart[1]
            restart = None
            continue
        pts = cap.capture_ns(i) + (int(cap.rng.integers(0, cap.jitter)) if cap.jitter else 0)
        out.append((pts, cap.render(i, cycle), not out, cycle * S // cap.rate if durations else None))
        cap.pushed += cycle
        cap.nbuf += 1
        i += cycle
    return out


print("\n--- cycle input: 2048-frame cycles, 0.5 ms jitter, cycles lost at 20 s (acquiring) and "
      "45 s (locked), 60 s ---")
cap = Capture(jitter=MS // 2, seed=11, tone=100.0)
h = Harness(cap.caps(), cycle_input=True)
h.drive(cycle_buffers(cap, 60, lost_s=(20, 45)))
ev = h.messages("mrasrc-event")
d = discont_at(h.out)
Q = 2048 * S // FS
jumps = [h.out[i]["pts"] - (h.out[i - 1]["pts"] + h.out[i - 1]["dur"]) for i in d[1:]]
check(f"two gap events (lost-cycle, 2048 frames each), no relock "
      f"({[(e['kind'], e['reason']) for e in ev]})",
      len(ev) == 2 and all(e["kind"] == "gap" and e["reason"] == "lost-cycle"
                           and e["lost-frames"] == 2048 and e["dropped-ns"] == 0
                           and sorted(e) == ["dropped-ns", "house-ns", "jump-ns", "kind",
                                             "lost-frames", "reason"] for e in ev))
check(f"the output jumps the cycle's length on one DISCONT buffer each ({[j / MS for j in jumps]} ms,"
      " the cycle 42.666667 +-1 frame), the events' jump-ns and house-ns those buffers'",
      len(d) == 3 and all(abs(j - Q) <= FRAME_NS for j in jumps) and len(ev) == 2
      and [e["jump-ns"] for e in ev] == jumps
      and [e["house-ns"] for e in ev] == [h.out[i]["pts"] for i in d[1:]] and contiguous(h.out))
y, t = samples(h, cap)
errs = label_errors(y, t, cap.house_hz(), skip_near=[h.out[i]["pts"] for i in d[1:]])
_late = [e for at, e in errs if at >= 40 * S] or [1e9]
check(f"labels within 1 frame of capture time from the lock on, before and after the lost cycle "
      f"({max(map(abs, _late)):.2f} us)", max(map(abs, _late)) * US < FRAME_NS)
final = h.messages("mrasrc-stats")[-1]
check(f"stats: locked, gaps 2, lost-frames 4096, relocks 0, every pushed frame in ({final})",
      final["state"] == "locked" and final["gaps"] == 2 and final["lost-frames"] == 4096
      and final["relocks"] == 0 and final["in-frames"] == cap.pushed and final["discont-in"] == 0)
h.stop()

print("\n--- the same capture without cycle-input: the lock's, as before (AES67's input) ---")
cap = Capture(jitter=MS // 2, seed=11, tone=100.0)
h = Harness(cap.caps())
h.drive(cycle_buffers(cap, 60, lost_s=(20, 45)))
ev = h.messages("mrasrc-event")
final = h.messages("mrasrc-stats")[-1]
check(f"no gap and no shift: the first output alone DISCONT, one counter "
      f"({[(e['kind'], e['reason']) for e in ev]})",
      not [e for e in ev if e["kind"] in ("gap", "shift")] and len(discont_at(h.out)) == 1
      and contiguous(h.out) and on_formula(h.out) and final["gaps"] == 0 and final["lost-frames"] == 0)
h.stop()

print("\n--- cycle input: the driver restarts 6.4 s in after losing 2.0547 s, no whole cycle (DEV4b's "
      "start on the Pi 4 test box, B-181), 70 s ---")
LOST = 98627                                      # 48.16 cycles
JIT = FS * (MS // 2) // S                         # the stamps' 0.5 ms jitter in frames: 24
cap = Capture(jitter=MS // 2, seed=13, tone=100.0)
h = Harness(cap.caps(), cycle_input=True)
h.drive(cycle_buffers(cap, 70, restart=(6.4, LOST)))
ev = h.messages("mrasrc-event")
d = discont_at(h.out)
lost_ns = LOST * S // FS
jumps = [h.out[i]["pts"] - (h.out[i - 1]["pts"] + h.out[i - 1]["dur"]) for i in d[1:]]
check(f"one gap event (lost-time, {LOST} frames to the stamps' jitter), no relock "
      f"({[(e['kind'], e['reason'], e.get('lost-frames')) for e in ev]})",
      len(ev) == 1 and ev[0]["kind"] == "gap" and ev[0]["reason"] == "lost-time"
      and abs(ev[0]["lost-frames"] - LOST) <= JIT and ev[0]["dropped-ns"] == 0)
check(f"the output jumps the lost time on one DISCONT buffer ({[j / MS for j in jumps]} ms, {lost_ns / MS} ms "
      "within the driver's 0.5 ms jitter), the event's jump-ns that buffer's",
      len(d) == 2 and len(jumps) == 1 and abs(jumps[0] - lost_ns) <= MS // 2 and len(ev) == 1
      and ev[0]["jump-ns"] == jumps[0] and contiguous(h.out))
y, t = samples(h, cap)
errs = label_errors(y, t, cap.house_hz(), skip_near=[h.out[i]["pts"] for i in d[1:]])
_all = [e for at, e in errs] or [1e9]
_late = [e for at, e in errs if at >= 60 * S] or [1e9]
check(f"labels on capture time from the first buffer, within 1 ms (the first stamp's and the restart's jitter, "
      f"0.5 ms each: {max(map(abs, _all)):.2f} us), within 1 frame from 60 s ({max(map(abs, _late)):.2f} us)",
      max(map(abs, _all)) * US <= MS and max(map(abs, _late)) * US < FRAME_NS)
final = h.messages("mrasrc-stats")[-1]
check(f"stats: gaps 1, lost-frames {LOST} to the jitter, relocks 0, every pushed frame in ({final})",
      final["gaps"] == 1 and abs(final["lost-frames"] - LOST) <= JIT and final["relocks"] == 0
      and final["in-frames"] == cap.pushed and final["discont-in"] == 0)
h.stop()

print("\n--- the same capture without cycle-input: the lock's, a relock about a minute in (as at f1cfad60 "
      "with it) ---")
cap = Capture(jitter=MS // 2, seed=13, tone=100.0)
h = Harness(cap.caps())
h.drive(cycle_buffers(cap, 70, restart=(6.4, LOST)))
ev = h.messages("mrasrc-event")
rl = [e for e in ev if e["kind"] == "relock"]
_at = (rl[0]["house-ns"] - H0) / S if rl else -1
check(f"one relock (envelope-step) {_at:.2f} s in, jumping {rl[0]['jump-ns'] / MS if rl else 0:.3f} ms; no gap "
      "(DEV4b: 62.0 s, 2,014.36 ms)",
      len(rl) == 1 and rl[0]["reason"] == "envelope-step" and 61 <= _at <= 63
      and abs(rl[0]["jump-ns"] - (lost_ns - 40 * MS)) <= 5 * MS and not [e for e in ev if e["kind"] == "gap"])
h.stop()

print("\n--- cycle input: at 40 s the cycle 1024 -> 2048 frames, stamps +21.333 ms twice, no frame "
      "lost ---")
cap = Capture(jitter=0, tone=100.0)
bufs, i, q1 = [], 0, 1024 * S // FS
while cap.capture_ns(i) < H0 + 40 * S:                       # 40 s of 1024-frame cycles: locked
    bufs.append((cap.capture_ns(i), cap.render(i, 1024), not bufs, q1))
    i += 1024
bufs.append((cap.capture_ns(i), cap.render(i, 1024), False, Q))  # the new duration first
i += 1024
bufs.append((cap.capture_ns(i) + q1, cap.render(i, 1024), False, Q))
i += 1024
while cap.capture_ns(i) < H0 + 55 * S:                       # then 2048-frame cycles, 42.667 ms later
    bufs.append((cap.capture_ns(i) + 2 * q1, cap.render(i, 2048), False, Q))
    i += 2048
h = Harness(cap.caps(), cycle_input=True)
h.drive(bufs)
ev = h.messages("mrasrc-event")
check(f"two shift events of +21.333 ms (cycle-size), nothing else "
      f"({[(e['kind'], e['reason'], e.get('shift-ns')) for e in ev]})",
      len(ev) == 2 and all(e["kind"] == "shift" and e["reason"] == "cycle-size"
                           and abs(e["shift-ns"] - q1) <= 1000
                           and sorted(e) == ["house-ns", "kind", "reason", "shift-ns"] for e in ev))
y, t = samples(h, cap)
errs = [e for at, e in label_errors(y, t, cap.house_hz()) if at >= 5 * S] or [1e9]
check(f"one counter, no DISCONT after the first, labels within 1 frame of capture time through the "
      f"change: the stamps moved, the samples did not ({max(map(abs, errs)):.2f} us)",
      len(discont_at(h.out)) == 1 and contiguous(h.out) and on_formula(h.out)
      and max(map(abs, errs)) * US < FRAME_NS)
h.stop()

print("\n--- a device past the ratio clamp: +1500 ppm, 1 ms jitter, 40 s ---")
cap = Capture(num=1001500, den=1000000, jitter=MS, seed=9)
h = run(cap, 40)
ev = [e for e in h.messages("mrasrc-event") if e["kind"] == "ratio-out-of-bounds"]
final = h.messages("mrasrc-stats")[-1]
check(f"one ratio-out-of-bounds event carrying the device fit (~-1497.8 ppm: "
      f"{ev[0]['fit-ppb'] / 1000 if ev else 0:+.3f} ppm), the ratio held at the -1000 ppm clamp "
      f"({final['ratio-ppb'] / 1000:+.3f})",
      len(ev) == 1 and -1510000 < ev[0]["fit-ppb"] < -1485000 and final["ratio-ppb"] == -1000000
      and sorted(ev[0]) == ["fit-ppb", "house-ns", "kind", "reason"])
h.stop()

# --- messages, offsets and the snapshot --------------------------------------------------------
print("\n--- mrasrc-stats, mrasrc-event, offsets, the stats snapshot ---")
cap = Capture(tone=100.0)
cap.xrun_at, cap.xrun_ns = H0 + 7 * S, 20 * MS
h = run(cap, 11)
posts = h.messages("mrasrc-stats")
_gaps = [b["out-frames"] - a["out-frames"] for a, b in zip(posts, posts[1:-1])]
check(f"mrasrc-stats every 2 s of output ({len(posts)} posts, {sorted(set(_gaps))} frames "
      "apart) and once more at EOS", len(posts) == 6 and all(abs(g - 2 * FS) <= BUF for g in _gaps))
check("each carries part 10's fields and WI-P3-5's mode and clocks, in order and typed (capture: "
      "mode capture, no device)",
      all(list(p) == STATS_FIELDS and isinstance(p["state"], str) and p["mode"] == "capture"
          and all(isinstance(p[k], int) for k in COUNT_FIELDS) and p["device-ppb"] == 0 for p in posts))
_ev = h.messages("mrasrc-event")
check(f"mrasrc-event relock: kind, reason, house-ns, jump-ns, dropped-ns "
      f"({sorted(_ev[0]) if _ev else []})",
      len(_ev) == 1 and sorted(_ev[0]) == ["dropped-ns", "house-ns", "jump-ns", "kind", "reason"])
_offs = all(a["offset_end"] == b["offset"] for a, b in zip(h.out, h.out[1:])) and all(
    o["offset_end"] - o["offset"] == len(o["data"]) // 4 for o in h.out) and h.out[0]["offset"] == 0
check("OFFSET / OFFSET_END count output frames from 0, across the relock", _offs)
snap = h.el.get_property("stats")
_sd = sdict(snap)
check(f"the stats snapshot is the last post plus the run's setup ({_sd})",
      {k: _sd[k] for k in STATS_FIELDS} == posts[-1] and _sd["format"] == "F32LE"
      and _sd["channels"] == 1 and _sd["in-rate"] == FS and _sd["out-rate"] == FS
      and _sd["delay-frames"] == DELAY and _sd["buffers"] == cap.nbuf
      and 0 < _sd["resampler-updates"] <= cap.nbuf and _sd["device-pairs"] == 0)
h.stop()

print("\n--- buffers that make no output (single frames, +900 ppm device) ---")
cap = Capture(num=1000900, den=1000000)
h = Harness(cap.caps())
_i = 0


def push_frames(n):
    global _i
    h.push(cap.capture_ns(_i), cap.render(_i, n), _i == 0)
    _i += n


for _ in range(20):
    push_frames(1)
_filled = len(h.out)
while cap.capture_ns(_i) < H0 + 10 * S:
    push_frames(BUF)
_zero = 0
for _ in range(6000):
    _n = len(h.out)
    push_frames(1)
    _zero += len(h.out) == _n
check(f"20 single frames fill the filter without output ({_filled} buffers out); the first "
      "output is DISCONT at T0 = the first PTS",
      _filled == 0 and h.out[0]["pts"] == H0 and h.out[0]["flags"] & int(Gst.BufferFlags.DISCONT))
check(f"single-frame buffers that make no output ({_zero} of 6000) push nothing and flag nothing: "
      "no empty buffer, no DISCONT after the first, the counter unbroken",
      _zero >= 2 and all(o["data"] for o in h.out) and discont_at(h.out) == [0]
      and on_formula(h.out) and contiguous(h.out))
h.stop()

print("\n--- quality, and buffers without a PTS ---")
cap = Capture()
h = Harness(cap.caps(), quality=2)
h.drive(cap.buffers(0.5), eos=False)
q = Gst.Query.new_latency()
_ok = h.sink.peer_query(q)
_lat = q.parse_latency()
h.src.push_event(Gst.Event.new_eos())
_sd = sdict(h.el.get_property("stats"))
check(f"quality=2 builds the 32-tap filter: 16 frames of lookahead in the stats and the latency "
      f"({_sd['delay-frames']} frames, +{_lat[1] - 10 * MS} ns)",
      _ok and _sd["delay-frames"] == 16 and _lat[1] == 10 * MS + 16 * S // FS)
h.stop()

cap = Capture(tone=100.0)
_bufs = cap.buffers(12)
_gap = [k for k, (pts, _, _) in enumerate(_bufs) if 5 * S <= pts - H0 < 6 * S]
h = Harness(cap.caps())
for k, (pts, data, disc) in enumerate(_bufs):
    h.push(Gst.CLOCK_TIME_NONE if k in _gap else pts, data, disc)
h.src.push_event(Gst.Event.new_eos())
y, t = samples(h, cap)
_e = [e for _, e in label_errors(y, t, cap.house_hz())]
_fin = h.messages("mrasrc-stats")[-1]
check(f"a second of buffers without a PTS continues the previous ones at the nominal rate: no "
      f"relock, one counter, labels within 1 frame ({max(map(abs, _e)):.2f} us), the ratio near "
      f"1 ({_fin['ratio-ppb'] / 1000:+.3f} ppm)",
      len(_gap) > 40 and not h.messages("mrasrc-event") and discont_at(h.out) == [0]
      and on_formula(h.out) and max(map(abs, _e)) * US < FRAME_NS and abs(_fin["ratio-ppb"]) < 5000)
h.stop()

# --- caps ----------------------------------------------------------------------------------------
print("\n--- caps ---")
for fmt, ch in (("S16LE", 8), ("S32LE", 2), ("F32LE", 1)):
    cap = Capture(fmt=fmt, channels=ch)
    h = run(cap, 1)
    oc = h.out_caps
    check(f"{fmt} {ch} ch, out-rate=0: the output keeps the format, the channels and the rate",
          oc is not None and oc.get_value("format") == fmt and oc.get_value("channels") == ch
          and oc.get_value("rate") == FS and oc.get_value("layout") == "interleaved")
    h.stop()

cap = Capture(fmt="S32LE", channels=2, rate=44100)
h = Harness(cap.caps(), sink_caps="audio/x-raw,format=S32LE,rate=48000,channels=2")
h.drive(cap.buffers(10))
_n = sum(len(o["data"]) for o in h.out) // 8
check(f"44.1 kHz in, out-rate=0, downstream rate=48000 (the capture branches' capsfilter): the "
      f"output counts at 48 kHz ({h.out_caps.get_value('rate') if h.out_caps else None} Hz, "
      f"{_n} frames for 10 s)", h.out_caps is not None and h.out_caps.get_value("rate") == 48000
      and abs(_n - 10 * 48000) <= 2 and on_formula(h.out, 48000))
h.stop()
cap = Capture(fmt="F32LE", channels=2, rate=44100)
h = Harness(cap.caps(), out_rate=48000)
h.drive(cap.buffers(2))
check("out-rate=48000 converts a 44.1 kHz input with no downstream constraint",
      h.out_caps is not None and h.out_caps.get_value("rate") == 48000)
h.stop()
# A sticky caps event is stored either way: the refusal is the first push's NOT_NEGOTIATED.
cap = Capture(fmt="F32LE", channels=2)
h = Harness(cap.caps(), sink_caps="audio/x-raw,rate=44100", out_rate=48000)
_rets = h.drive(cap.buffers(0.1), eos=False)
check(f"out-rate=48000 against a downstream that takes only 44.1 kHz: refused ({_rets[0]})",
      _rets[0] == Gst.FlowReturn.NOT_NEGOTIATED and not h.out and h.out_caps is None)
h.stop()
_in441 = Gst.Caps.from_string(Capture(rate=44100).caps())
for down, want in (("audio/x-raw,rate=48000", True), ("audio/x-raw,rate=44100", False)):
    h = Harness(Capture().caps(), sink_caps=down, out_rate=48000)
    _c = h.el.get_static_pad("sink").query_caps(None)
    check(f"out-rate=48000, downstream {down.split(',')[1]}: the sink pad "
          f"{'takes any rate (a 44.1 kHz input)' if want else 'offers nothing'}",
          _c.can_intersect(_in441) if want else _c.is_empty())
    h.stop()
cap = Capture(fmt="F32LE", channels=2, rate=44100)
h = Harness(cap.caps(), sink_caps="audio/x-raw,rate={ 96000, 32000 }")
h.drive(cap.buffers(0.5))
check("out-rate=0 and a downstream that cannot take the input's 44.1 kHz: the nearest rate it "
      f"can, 32 kHz before 96 kHz ({h.out_caps.get_value('rate') if h.out_caps else None})",
      h.out_caps is not None and h.out_caps.get_value("rate") == 32000)
h.stop()
cap = Capture(tone=100.0)
h = Harness(cap.caps())
_bufs = cap.buffers(6)
for k, b in enumerate(_bufs):
    if k == len(_bufs) // 4:
        h.src.push_event(Gst.Event.new_caps(Gst.Caps.from_string(cap.caps())))
    if k == len(_bufs) // 2:   # new caps, the same audio: the base class calls set_caps again
        h.src.push_event(Gst.Event.new_caps(Gst.Caps.from_string(cap.caps() + ",note=x")))
    if k == 3 * len(_bufs) // 4:
        h.sink.push_event(Gst.Event.new_reconfigure())
    h.push(*b)
h.src.push_event(Gst.Event.new_eos())
_fin = h.messages("mrasrc-stats")[-1]
check("the same caps again, caps that differ only outside the audio format, and a renegotiation "
      "from downstream keep the run: one counter, no DISCONT after the first, the counts never "
      "restart",
      discont_at(h.out) == [0] and on_formula(h.out) and contiguous(h.out)
      and _fin["in-frames"] == cap.pushed and not h.messages("mrasrc-event"))
h.stop()
for caps in ("audio/x-raw,format=S24LE,rate=48000,channels=2,layout=interleaved",
             "audio/x-raw,format=F32LE,rate=48000,channels=2,layout=non-interleaved",
             "audio/x-raw,format=F64LE,rate=48000,channels=2,layout=interleaved",
             "audio/x-raw,format=F32LE,rate=800,channels=2,layout=interleaved"):
    h = Harness(caps)
    ret = h.push(H0, bytes(4096), True)
    check(f"refused: {caps.split(',')[1]} {caps.split(',')[2]} {caps.split(',')[-1]} ({ret})",
          ret == Gst.FlowReturn.NOT_NEGOTIATED and not h.out)
    h.stop()

pipe = Gst.parse_launch(
    "appsrc name=src format=time caps=audio/x-raw,format=S16LE,rate=44100,channels=2,"
    "layout=interleaved ! audioconvert ! mrasrc name=asrc ! "
    "audio/x-raw,format=S32LE,rate=48000,channels=2 ! appsink name=sink sync=false")
pipe.set_state(Gst.State.PLAYING)
_src, _sink = pipe.get_by_name("src"), pipe.get_by_name("sink")
cap = Capture(fmt="S16LE", channels=2, rate=44100)
for pts, data, disc in cap.buffers(2):
    b = Gst.Buffer.new_wrapped(data)
    b.pts = pts
    _src.emit("push-buffer", b)
_src.emit("end-of-stream")
_got = []
while True:
    smp = _sink.emit("try-pull-sample", 5 * S)
    if smp is None:
        break
    _got.append(smp)
_c = _got[0].get_caps().get_structure(0) if _got else None
check("the capture branch's own string: audioconvert ! mrasrc ! audio/x-raw,format=S32LE,"
      "rate=48000 negotiates a 44.1 kHz S16 device to S32LE 48 kHz",
      _c is not None and _c.get_value("format") == "S32LE" and _c.get_value("rate") == 48000)
pipe.set_state(Gst.State.NULL)

# --- latency, EOS, flush ----------------------------------------------------------------------
print("\n--- latency, the tail at EOS, a flush ---")
cap = Capture()
h = Harness(cap.caps())
h.drive(cap.buffers(0.5), eos=False)
q = Gst.Query.new_latency()
_ok = h.sink.peer_query(q)
live, lo, hi = q.parse_latency()
_d = DELAY * S // FS
check(f"the latency query adds the filter's lookahead, 32 frames ({lo - 10 * MS} ns, "
      f"{hi - 30 * MS} ns)", _ok and live and lo == 10 * MS + _d and hi == 30 * MS + _d)
_before = sum(len(o["data"]) for o in h.out) // 4
h.src.push_event(Gst.Event.new_eos())
_tail = h.out[-1]
_total = sum(len(o["data"]) for o in h.out) // 4
check(f"EOS drains the filter: {_total - _before} more frames on the same counter, every input "
      f"frame out ({_total} out, {cap.pushed} in)",
      _total - _before == DELAY and abs(_total - cap.pushed) <= 1 and contiguous(h.out)
      and on_formula(h.out) and Gst.EventType.EOS in h.events)
check("... after the EOS stats post, which saw the frames before the tail",
      h.messages("mrasrc-stats")[-1]["out-frames"] == _before)
h.stop()

cap = Capture(tone=100.0)
h = Harness(cap.caps())
h.drive(cap.buffers(3), eos=False)
_n_before = len(h.out)
h.src.push_event(Gst.Event.new_flush_start())
h.src.push_event(Gst.Event.new_flush_stop(True))
seg = Gst.Segment()
seg.init(Gst.Format.TIME)
h.src.push_event(Gst.Event.new_segment(seg))
cap2 = Capture(tone=100.0)
_bufs = [(pts + 500 * S, data, False) for pts, data, _ in cap2.buffers(3)]   # none flagged
h.drive(_bufs)
_first = h.out[_n_before]
_fin = h.messages("mrasrc-stats")[-1]
check(f"after a flush a fresh run: the first output DISCONT (no input was) at the new first PTS "
      f"({_first['pts'] - H0 - 500 * S} ns off), the counts from 0 ({_fin['in-frames']} in)",
      _first["flags"] & int(Gst.BufferFlags.DISCONT) and _first["pts"] == H0 + 500 * S
      and _fin["in-frames"] == cap2.pushed and _fin["relocks"] == 0)
h.stop()

# --- WI-P3-5: decode mode ----------------------------------------------------------------------
print("\n--- decode mode: a source 10 ppm fast (48,000.48 Hz) through formula PTS, 12 min ---")
DEC_PPB = 10000
cap = Capture(num=1000000 + DEC_PPB // 1000, den=1000000, tone=1000.0, formula=True)


def keep_window(pts):
    """20-30 s (the engage), then half a second each minute: the label checks' windows."""
    return 20 * S <= pts - H0 < 30 * S or (pts - H0 >= 30 * S and (pts - H0) % (60 * S) < S // 2)


h = Harness(cap.caps(), keep=keep_window, bypass_below_ppm=0.5)
h.drive(cap.buffers(730))
ev = [e for e in h.messages("mrasrc-event") if e["kind"] == "engaged"]
n_passed = next((i for i, o in enumerate(h.out) if o["mem"] != h.in_mem[i]), len(h.out))
_at = (ev[0]["house-ns"] - H0) / S if ev else -1
check(f"one engage on the ratio rule within 30 s ({_at:.2f} s, {[e['reason'] for e in ev]}), the source "
      f"measured at {ev[0]['source-ppb'] / 1000 if ev else 0:+.3f} ppm (+10)",
      len(ev) == 1 and ev[0]["reason"] == "ratio" and 0 < _at <= 30
      and abs(ev[0]["source-ppb"] - DEC_PPB) <= 500)
check(f"bypassed until then: each of the {n_passed} outputs before it the input buffer itself, its memory and PTS "
      "(zero copy); the first after it at the engaging buffer's PTS",
      n_passed > 1000 and all(h.out[i]["pts"] == h.in_pts[i] for i in range(n_passed))
      and n_passed < len(h.out) and h.out[n_passed]["pts"] == (ev[0]["house-ns"] if ev else -1)
      and h.out[n_passed]["pts"] == h.in_pts[n_passed])
_eng = h.out[n_passed:]
check("from the engaging buffer's PTS one counter (T0 + floor(m x 1e9 / 48000)), contiguous, no DISCONT on the "
      "engage", bool(_eng) and on_formula(_eng) and contiguous(_eng)
      and not any(o["flags"] & int(Gst.BufferFlags.DISCONT) for o in _eng))
# Across the engage, sample for sample: the passed buffers are the input itself, and the primed
# resampler's first outputs go on with its next frame (an unprimed filter's read 0.01 to 0.11 off,
# with the tone's phase; 64 frames, before the 10 ppm correction moves them).
_k = n_passed
_before = np.frombuffer(b"".join(o["data"] for o in h.out[_k - 12:_k]), dtype="<f4").astype(np.float64)
_after = np.frombuffer(b"".join(o["data"] for o in h.out[_k:_k + 1]), dtype="<f4").astype(np.float64)[:64]
_e = sum(o["size"] // 4 for o in h.out[:_k])   # the engaging buffer's first input frame
_ideal_b = cap.amp * np.sin(2 * np.pi * cap.tone * np.arange(_e - len(_before), _e) / FS)
_ideal_a = cap.amp * np.sin(2 * np.pi * cap.tone * (np.arange(_e, _e + len(_after)) - 0.125) / FS)
_dev_b = float(np.max(np.abs(_before - _ideal_b))) if len(_before) else 9.0
_dev_a = float(np.max(np.abs(_after - _ideal_a))) if len(_after) == 64 else 9.0
check(f"the engage is seamless: the 12 buffers before it the source's samples exactly ({_dev_b:.2e}), the first 64 "
      f"frames after it the source's next ({_dev_a:.4f} of full scale; GStreamer centres 1/8 frame early; an unprimed "
      "filter reads 0.01 or more off)", _dev_b < 1e-6 and _dev_a < 0.002)
# Label errors in each kept window from 60 s after the engage: label minus content time.
_wins, cur = [], []
for o in _eng:
    if o["data"]:
        cur.append(o)
    elif cur:
        _wins.append(cur)
        cur = []
if cur:
    _wins.append(cur)
_rows = []
for w in _wins:
    if w[0]["pts"] - H0 < (_at + 60) * S:
        continue
    y = np.frombuffer(b"".join(o["data"] for o in w), dtype="<f4").astype(np.float64)
    t = np.concatenate([o["pts"] + (np.arange(len(o["data"]) // 4, dtype=np.int64) * S) // FS for o in w])
    errs = [e for _, e in label_errors(y, t, cap.house_hz())]
    _rows.append((w[0]["offset"], w[0]["pts"], float(np.mean(errs)), max(abs(e) for e in errs)))
_worst = max((r[3] for r in _rows), default=1e9)
check(f"labels within 1 frame of content time in every window from 60 s after the engage ({len(_rows)} windows, "
      f"worst {_worst:.2f} us)", len(_rows) >= 9 and _worst * US < FRAME_NS)
if len(_rows) >= 2:
    (o_a, p_a, e_a, _), (o_b, p_b, e_b, _) = _rows[0], _rows[-1]
    _span = (p_b - e_b * US) - (p_a - e_a * US)   # content (house) time between the two windows
    _err = (o_b - o_a) - _span * FS / S
else:
    _span, _err = 0, 9e9
check(f"48,000 frames per house second +-1 over {_span / S / 60:.1f} min of content time after the engage "
      f"({_err:+.3f} frames)", _span >= 599 * S and abs(_err) <= 1)
_fin = h.messages("mrasrc-stats")[-1]
check(f"mrasrc-stats: mode decode, the source at {_fin['source-ppb'] / 1000:+.3f} ppm, the ratio its correction "
      f"({_fin['ratio-ppb'] / 1000:+.3f} ppm), no device term",
      _fin["mode"] == "decode" and abs(_fin["source-ppb"] - DEC_PPB) <= 200
      and abs(_fin["ratio-ppb"] + DEC_PPB) <= 3000 and _fin["device-ppb"] == 0)
h.stop()

print("\n--- decode mode: a house-rate source, formula PTS, 40 s: bypassed, zero copy ---")
for name, kw in (("48 kHz", {}), ("44.1 kHz, PTS quantised to ticks", {"rate": 44100})):
    cap = Capture(formula=True, **kw)
    h = run(cap, 40, bypass_below_ppm=0.5)
    _fin = h.messages("mrasrc-stats")[-1]
    same = len(h.out) == len(h.in_mem) and all(o["mem"] == m for o, m in zip(h.out, h.in_mem))
    check(f"{name}: never engages, mode bypass and locked at 40 s, every output the input buffer itself "
          f"({len(h.out)} buffers, the same memory)",
          not [e for e in h.messages("mrasrc-event") if e["kind"] == "engaged"] and _fin["mode"] == "bypass"
          and _fin["state"] == "locked" and same and abs(_fin["source-ppb"]) < 100)
    h.stop()

print("\n--- decode mode with a rate conversion: 44.1 kHz house rate into a 48 kHz downstream ---")
cap = Capture(rate=44100, formula=True, tone=100.0)
h = Harness(cap.caps(), sink_caps="audio/x-raw,rate=48000", bypass_below_ppm=0.5)
h.drive(cap.buffers(40))
_fin = h.messages("mrasrc-stats")[-1]
_n = sum(len(o["data"]) for o in h.out) // 4
y, t = samples(h, cap)
_e = [e for _, e in label_errors(y, t, cap.house_hz())]
check(f"bypassed (no clock correction, mode {_fin['mode']}) yet resampled at the nominal ratio: 48 kHz out "
      f"({h.out_caps.get_value('rate') if h.out_caps else None}), {_n} frames for 40 s, one counter, labels within a "
      f"frame of content time ({max(map(abs, _e)):.2f} us), no engage",
      _fin["mode"] == "bypass" and h.out_caps is not None and h.out_caps.get_value("rate") == 48000
      and abs(_n - 40 * 48000) <= 64 and on_formula(h.out, 48000) and contiguous(h.out)
      and max(map(abs, _e)) * US < FRAME_NS and not [e for e in h.messages("mrasrc-event") if e["kind"] == "engaged"]
      and _fin["ratio-ppb"] == 0)
h.stop()

# --- WI-P3-5: real decoders --------------------------------------------------------------------
_FX = os.path.normpath(os.path.join(_HERE, "..", "..", "..", "..", "plugins", "mpegts-core", "tests", "fixtures"))
_GEN = os.path.normpath(os.path.join(_HERE, "..", "..", "..", "..", "plugins", "mpegts-core", "native", "mrts",
                                     "tests", "fixture_gen"))


class Probe:
    """Buffers through a pad: (pts, memory) each."""

    def __init__(self, pad):
        self.bufs = []
        pad.add_probe(Gst.PadProbeType.BUFFER, self._on)

    def _on(self, _pad, info):
        b = info.get_buffer()
        self.bufs.append((b.pts, hash(b.peek_memory(0)) if b.n_memory() else 0))
        return Gst.PadProbeReturn.OK


def decode_chain(path, caps, dec, asrc="bypass-below-ppm=0.5"):
    """path through mrtsdemux, the decoder, audioconvert and mrasrc to EOS: the probes, the
    mrasrc-event messages and the last stats."""
    p = Gst.parse_launch(f"filesrc location={path} ! mrtsdemux name=d media=audio d. ! capsfilter name=pes "
                         f"caps={caps} ! {dec} ! audioconvert name=conv ! audio/x-raw,format=F32LE,"
                         f"layout=interleaved ! mrasrc name=asrc {asrc} ! fakesink sync=false")
    pes = Probe(p.get_by_name("pes").get_static_pad("src"))
    dec_el = p.get_by_name("conv").get_static_pad("sink").get_peer().get_parent_element()
    din = Probe(dec_el.get_static_pad("sink"))
    dout = Probe(p.get_by_name("conv").get_static_pad("sink"))
    ain = Probe(p.get_by_name("asrc").get_static_pad("sink"))
    aout = Probe(p.get_by_name("asrc").get_static_pad("src"))
    events = []
    p.set_state(Gst.State.PLAYING)
    bus = p.get_bus()
    err = None
    while True:
        m = bus.timed_pop_filtered(30 * Gst.SECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR
                                   | Gst.MessageType.ELEMENT)
        if m is None or m.type == Gst.MessageType.EOS:
            break
        if m.type == Gst.MessageType.ERROR:
            err = m.parse_error()[0].message
            break
        st = m.get_structure()
        if st and st.get_name() == "mrasrc-event":
            events.append(sdict(st))
    stats = sdict(p.get_by_name("asrc").get_property("stats"))
    p.set_state(Gst.State.NULL)
    return pes.bufs, din.bufs, dout.bufs, ain.bufs, aout.bufs, events, stats, err


print("\n--- real decoders pass their input PTS through; a house-rate decode passes mrasrc unchanged ---")
_have = all(Gst.ElementFactory.find(e) for e in ("aacparse", "avdec_aac", "opusdec"))
if not _have:
    print("SKIP real decoders — aacparse, avdec_aac or opusdec unavailable")
for fx, caps, dec in (("tp-hevc-aac.ts", "audio/mpeg", "aacparse ! avdec_aac"),
                      ("cap-mux-align7-aac-opus.ts", "audio/x-opus", "opusdec")) if _have else ():
    pes, din, dout, ain, aout, events, stats, err = decode_chain(os.path.join(_FX, fx), caps, dec)
    name = dec.split()[-1]
    _out = {t for t, _ in dout}
    check(f"{name} ({fx}): its output PTS are its input frames', frame for frame ({len(dout)} of {len(din)}; "
          f"GstAudioDecoder's tolerance 0), and every PES PTS reaches mrasrc ({len(pes)} PES)",
          err is None and len(din) > 100 and [t for t, _ in dout] == [t for t, _ in din]
          and all(t in _out for t, _ in pes))
    check(f"{name}: mrasrc passes every decoded buffer unchanged, the same memory and PTS (zero copy), mode "
          f"{stats.get('mode')}, no engage",
          len(aout) == len(ain) > 100 and aout == ain and stats.get("mode") == "bypass"
          and not [e for e in events if e["kind"] == "engaged"])
if _have:
    # Found (B-125): this recording's AAC timeline steps back 14-18 ms inside its segments (B-121's
    # 100 ms steps are its two gaps); within 7.6 s no rule engages, and each gap measures afresh.
    pes, din, dout, ain, aout, events, stats, err = decode_chain(os.path.join(_FX, "cap-mux-align7-aac-opus.ts"),
                                                                 "audio/mpeg", "aacparse ! avdec_aac")
    rel = [e for e in events if e["kind"] == "relock"]
    check(f"avdec_aac on cap-mux-align7's AAC: each of its two gaps measures afresh, a relock on the DISCONT after "
          f"it ({[(e['reason'], round(e['jump-ns'] / MS, 1)) for e in rel]} ms), passed unchanged throughout",
          err is None and len(rel) == 2 and all(e["reason"] == "discont" and e["jump-ns"] > 0 for e in rel)
          and stats.get("mode") == "bypass" and aout == ain)

print("\n--- a 35 s AAC encode at house rate stays bypassed; the same respaced 40 ppm engages ---")
_enc = all(Gst.ElementFactory.find(e) for e in ("avenc_aac", "mpegtsmux", "aacparse", "avdec_aac"))
if not _enc or not os.path.exists(_GEN):
    print(f"SKIP the encode — avenc_aac, mpegtsmux or {_GEN} unavailable")
else:
    import tempfile

    _tmp = tempfile.mkdtemp(prefix="mrasrc-")
    _house, _foreign = os.path.join(_tmp, "house.ts"), os.path.join(_tmp, "foreign.ts")
    _p = Gst.parse_launch(f"audiotestsrc num-buffers={35 * FS // 1024} samplesperbuffer=1024 wave=sine freq=1000 ! "
                          "audio/x-raw,format=S16LE,rate=48000,channels=2 ! audioconvert ! avenc_aac ! aacparse ! "
                          "mpegtsmux ! "
                          f"filesink location={_house}")
    _p.set_state(Gst.State.PLAYING)
    _p.get_bus().timed_pop_filtered(60 * Gst.SECOND, Gst.MessageType.EOS | Gst.MessageType.ERROR)
    _p.set_state(Gst.State.NULL)
    _resp = subprocess.run([_GEN, "--respace", "40", "-i", _house, "-o", _foreign], capture_output=True, text=True)
    for label, path in (("house rate", _house), ("respaced +40 ppm", _foreign)):
        pes, din, dout, ain, aout, events, stats, err = decode_chain(path, "audio/mpeg", "aacparse ! avdec_aac")
        eng = [e for e in events if e["kind"] == "engaged"]
        _t0 = pes[0][0] if pes else 0
        if label == "house rate":
            check(f"{label}: 35 s through avdec_aac never engage, mode bypass and locked at the end, every buffer passed "
                  f"unchanged ({len(aout)}), the source at {stats.get('source-ppb', 0) / 1000:+.3f} ppm",
                  err is None and not eng and stats.get("mode") == "bypass" and stats.get("state") == "locked"
                  and aout == ain and len(ain) > 1500 and abs(stats.get("source-ppb", 9e9)) < 100)
        else:
            _at = (eng[0]["house-ns"] - _t0) / S if eng else -1
            check(f"{label} (respace rc {_resp.returncode}): engages within 30 s ({_at:.2f} s, "
                  f"{eng[0]['reason'] if eng else None}), the source at {eng[0]['source-ppb'] / 1000 if eng else 0:+.3f} "
                  f"ppm (-40: its PTS 40 ppm long), mode {stats.get('mode')} at the end",
                  err is None and _resp.returncode == 0 and len(eng) == 1 and 0 < _at <= 30
                  and abs(eng[0]["source-ppb"] + 40000) <= 2000 and stats.get("mode") == "decode")
    import shutil

    shutil.rmtree(_tmp, ignore_errors=True)

# --- WI-P3-5: device mode ----------------------------------------------------------------------
_TEST_SO = os.path.join(os.path.dirname(_SO), "tests", "libgstmrtest.so")
# 10 min of house time in 5 min: a faster clock magnifies the scheduling noise the fill shows.
_SPEED, _DEV_S = 2, 610
print(f"\n--- device mode: mrtestaudiosink 40 ppm fast, a {_SPEED}x clock, {_DEV_S - 10} s past the settle ---")
if not os.path.exists(_TEST_SO):
    print(f"SKIP device mode — {_TEST_SO} not built (make -C plugins/mpegts-core/native/mrtshouse test)")
else:
    Gst.Plugin.load_file(_TEST_SO)
    _clk = GObject.new(GObject.type_from_name("MrTestClock"))
    _clk.set_property("speed", _SPEED)
    _p = Gst.parse_launch(
        "audiotestsrc is-live=true samplesperbuffer=1024 wave=sine freq=1000 ! "
        "audio/x-raw,format=F32LE,rate=48000,channels=2 ! mrasrc name=asrc device-sink=sink ! "
        "mrtestaudiosink name=sink ppm=40 device-ns=1000000000 slave-method=custom sync=true buffer-time=2000000 "
        "latency-time=20000")
    _p.use_clock(_clk)
    _bus = _p.get_bus()
    _p.set_state(Gst.State.PLAYING)
    _sink, _asrc = _p.get_by_name("sink"), _p.get_by_name("asrc")
    _start = _clk.get_time()
    _dev_events, _errors = [], []
    while _clk.get_time() - _start < _DEV_S * S:
        m = _bus.timed_pop(200 * Gst.MSECOND)
        if m is None:
            continue
        if m.type == Gst.MessageType.ERROR:
            _errors.append(m.parse_error()[0].message)
            break
        if m.type == Gst.MessageType.ELEMENT and m.get_structure().get_name() == "mrasrc-event":
            _dev_events.append(sdict(m.get_structure()))
    _st = sdict(_asrc.get_property("stats"))
    _f = {k: _sink.get_property(k) for k in ("fill-first-ns", "fill-min-ns", "fill-max-ns", "fill-p05-ns",
                                              "fill-p95-ns", "fill-last-ns", "resyncs", "calibrations",
                                              "underruns", "renders")}
    _p.set_state(Gst.State.NULL)
    check(f"the sink never asked to skew: its clock's calibration unchanged after the first render "
          f"({_f['calibrations']} changes in {_f['renders']} renders); no resync, no underrun "
          f"({_f['resyncs']}, {_f['underruns']})",
          not _errors and _f["renders"] > 25000 and _f["calibrations"] == 0 and _f["resyncs"] == 0
          and _f["underruns"] == 0)
    _rel = {k: (_f[f"fill-{k}-ns"] - _f["fill-first-ns"]) / MS for k in ("p05", "p95", "last", "min", "max")}
    # Each 5 s window keeps its top fill, its most punctual render's: a producer held late reads low,
    # never high. The 5th to 95th percentile and the last window show the fill; the extremes, windows
    # starved throughout.
    check(f"the ring's fill held within +-2 ms of its first settled value over {_DEV_S - 10} s of house time: "
          f"5 s windows' tops p05 {_rel['p05']:+.3f}, p95 {_rel['p95']:+.3f}, the last {_rel['last']:+.3f} ms around "
          f"{_f['fill-first-ns'] / MS:.1f} ms (extremes {_rel['min']:+.3f} .. {_rel['max']:+.3f}; 40 ppm uncorrected "
          f"drains 24 ms; load {os.getloadavg()[0]:.1f}: a starved producer dips the fill)",
          all(abs(_rel[k]) <= 2 for k in ("p05", "p95", "last")))
    check(f"mrasrc-stats: mode device, the device lock locked at {_st.get('device-ppb', 0) / 1000:+.3f} ppm (+40), "
          f"the ratio its term ({_st.get('ratio-ppb', 0) / 1000:+.3f} ppm), {_st.get('device-pairs', 0)} pairs, no source "
          "lock", _st.get("mode") == "device" and _st.get("state") == "locked"
          and abs(_st.get("device-ppb", 0) - 40000) <= 100 and abs(_st.get("ratio-ppb", 0) - 40000) <= 200
          and _st.get("device-pairs", 0) > 20000 and _st.get("source-ppb") == 0)
    _reasons = [e["reason"] for e in _dev_events if e["kind"] == "device-relock"]
    check(f"device relocks only at the start, from the sink's own calibration ({_reasons})",
          set(_reasons) <= {"new-caps", "sync-latency"} and "sync-latency" in _reasons
          and not [e for e in _dev_events if e["kind"] != "device-relock"])

print("\n--- decode and device together: a source 40 ppm fast into a device 20 ppm slow (2x clock, 90 s) ---")
if os.path.exists(_TEST_SO):
    import threading

    _clk = GObject.new(GObject.type_from_name("MrTestClock"))
    _clk.set_property("speed", 2)
    _p = Gst.parse_launch(
        "appsrc name=src format=time block=true max-bytes=65536 ! mrasrc name=asrc bypass-below-ppm=0.5 "
        "device-sink=sink ! mrtestaudiosink name=sink ppm=-20 device-ns=1000000000 slave-method=custom "
        "sync=true buffer-time=2000000 latency-time=20000")
    _p.use_clock(_clk)
    _src = _p.get_by_name("src")
    cap = Capture(num=1000040, den=1000000, formula=True, channels=2)
    _src.set_property("caps", Gst.Caps.from_string(cap.caps()))
    _stop = threading.Event()

    def _feed():
        i = 0
        while not _stop.is_set():   # the sink's ring paces the pushes
            c = cap.capture_ns(i)
            b = Gst.Buffer.new_wrapped(cap.render(i, BUF))
            b.pts = -((-(c * 9 // 100000) * 100000) // 9) - H0
            if i == 0:
                b.set_flags(Gst.BufferFlags.DISCONT)
            if _src.emit("push-buffer", b) != Gst.FlowReturn.OK:
                break
            i += BUF

    _p.set_state(Gst.State.PLAYING)
    _th = threading.Thread(target=_feed, daemon=True)
    _th.start()
    _bus = _p.get_bus()
    _start, _ev = _clk.get_time(), []
    while _clk.get_time() - _start < 90 * S:   # the engage's 1 ms phase steered out (tau 10 s)
        m = _bus.timed_pop(200 * Gst.MSECOND)
        if m is not None and m.type == Gst.MessageType.ELEMENT and m.get_structure().get_name() == "mrasrc-event":
            _ev.append(sdict(m.get_structure()))
    _st = sdict(_p.get_by_name("asrc").get_property("stats"))
    _sk = {k: _p.get_by_name("sink").get_property(k) for k in ("calibrations", "resyncs")}
    _stop.set()
    _p.set_state(Gst.State.NULL)
    _eng = [e for e in _ev if e["kind"] == "engaged"]
    check(f"engaged ({[e['reason'] for e in _eng]}, source {_eng[0]['source-ppb'] / 1000 if _eng else 0:+.2f} ppm), then "
          f"mode {_st.get('mode')}: the source term and the device term ({_st.get('device-ppb', 0) / 1000:+.3f} ppm) "
          f"in one ratio ({_st.get('ratio-ppb', 0) / 1000:+.3f} ppm: -40 + -20 within 1 ppm, 65 s after the engage), "
          f"no skew, no resync ({_sk})",
          len(_eng) == 1 and abs(_eng[0]["source-ppb"] - 40000) <= 2000 and _st.get("mode") == "decode+device"
          and abs(_st.get("device-ppb", 0) + 20000) <= 500 and abs(_st.get("ratio-ppb", 0) + 60000) <= 1000
          and _sk == {"calibrations": 0, "resyncs": 0})

print("\n--- a device-sink that cannot be followed is an error naming it ---")
_rows = [("mrtestaudiosink name=sink slave-method=skew", "its slave-method is not custom (3)"),
         ("fakesink name=sink", "not a GstAudioBaseSink"),
         ("fakesink name=other", "no element of that name downstream")]
for desc, what in _rows if os.path.exists(_TEST_SO) else _rows[1:]:
    _p = Gst.parse_launch(f"audiotestsrc num-buffers=4 ! mrasrc name=asrc device-sink=sink ! {desc}")
    ret = _p.set_state(Gst.State.PAUSED)
    m = _p.get_bus().timed_pop_filtered(2 * Gst.SECOND, Gst.MessageType.ERROR)
    msg = m.parse_error()[0].message if m else ""
    check(f"{desc.split()[0]} {desc.split()[-1]}: the state change fails, an error from asrc naming it "
          f"({msg!r})", ret == Gst.StateChangeReturn.FAILURE and m is not None and m.src.get_name() == "asrc"
          and 'device-sink "sink"' in msg and what in msg)
    _p.set_state(Gst.State.NULL)

if _failures:
    print(f"\n{len(_failures)} FAILURE(S) in gst_mrasrc_element_test.py")
    for f in _failures:
        print(f"  - {f}")
    sys.exit(1)
print("\nALL gst_mrasrc_element_test.py TESTS PASSED")
