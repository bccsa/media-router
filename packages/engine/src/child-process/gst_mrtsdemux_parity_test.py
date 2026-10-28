#!/usr/bin/env python3
"""Parity of mrtsdemux with stock tsdemux 1.28.2 (plan ch. 7 WI-P3-4, register B-124; R-P3-2):
consumers see the same pads, caps, event order and payloads from both, timestamps excepted.

Every recorded fixture (`cap-*`, `tp-*`, `bus-*` in plugins/mpegts-core/tests/fixtures) is replayed
into `appsrc ! tsdemux latency=0` and into `appsrc ! mrtsdemux`, in 188-, 1,000- (no packet
multiple, OQ-26), 1,316- and 24,576-byte feeds, a bus recording also as recorded (its sidecar's
buffers, PTS and flags); every pad goes to an appsink (sync=false async=false: an async sink added
at pad-added stalls the run). Each feed is stamped with its arrival on the recording's PCR, as the
bus stamps a buffer at its send time: tsdemux's PCR skew and its wait for a first PCR read it,
mrtsdemux only a gap marker's (B-60).

Recorded per pad: name, template, caps at pad-added; the events in order, each at its buffer
count (STREAM_START's stream id after upstream's, flags, group and stream; CAPS; SEGMENT; TAG;
STREAM_COLLECTION; GAP(0, 0); EOS); each buffer's size, crc32, flags, list place and metas; the
other GAPs. Per element: the section messages and the collection message (its streams' ids,
types, flags, caps and tags) in order around pad-added, no-more-pads and pad-removed; other
messages, warnings and errors. Each item notes the input buffer it came with, so a rule can tie
a difference to a bus recording's DISCONT or gap-marker input (B-132). Every difference must be
one of demux_parity_allow.json's entries, each with its reason and each used by the run (a
repeat, a warning or a DISCONT at most once per cause the recording shows); the brief's other
entries are measured equal there (`measuredEqual`), so equality is pinned. Synthetic fixtures
are out (`excluded`). Also pinned on tsdemux: the facts the comparison rests on (measured), each
reached by some recording; and the comparison fails on self-mutants (a renamed pad, a dropped
section message, a dropped buffer, a DISCONT with no cause; on bus-ingest-relock-gap as recorded
a marker's next unit without DISCONT, a marker's GAP on another PID's pad, a unit twice).

Skips (exit 0) without GStreamer, tsdemux, or the built plugin."""
import bisect
import copy
import difflib
import json
import os
import re
import sys
import threading
import zlib

try:
    import gi

    gi.require_version("Gst", "1.0")
    gi.require_version("GstAudio", "1.0")
    gi.require_version("GstMpegts", "1.0")
    from gi.repository import GObject, Gst, GstAudio, GstMpegts
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_mrtsdemux_parity_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

Gst.init(sys.argv)

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(_HERE, "..", "..", "..", ".."))
FIX = os.path.join(ROOT, "plugins", "mpegts-core", "tests", "fixtures")
ALLOW = os.path.join(FIX, "demux_parity_allow.json")
sys.path.insert(0, os.path.join(ROOT, "plugins", "mpegts-core", "py"))
import ts_psi  # noqa: E402  (the Python reference's packet helpers)

_SO = os.path.join(os.environ.get("MR_PLUGINS_DIR") or os.path.join(ROOT, "plugins"),
                   "mpegts-core", "native", "mrtshouse", "libgstmrtshouse.so")
if not os.path.exists(_SO):
    print(f"SKIP gst_mrtsdemux_parity_test.py — mrtshouse plugin not built ({_SO}); "
          "run `make native`")
    sys.exit(0)
Gst.Plugin.load_file(_SO)   # a file that is there but does not load is a failure
if Gst.ElementFactory.find("tsdemux") is None:
    print("SKIP gst_mrtsdemux_parity_test.py — gst-plugins-bad's tsdemux missing")
    sys.exit(0)

NONE = Gst.CLOCK_TIME_NONE
PKT = 188
MUX_90K = 3600 * 90000          # mpegtsmux's 1 h (MUX_CLOCK_BASE_90K)
CHUNKS = (188, 1000, 1316, 24576)
TS_CAPS = "video/mpegts, systemstream=(boolean)true, packetsize=(int)188"
DISCONT = int(Gst.BufferFlags.DISCONT)
GAP = int(Gst.BufferFlags.GAP)
TAG_MEMORY = int(Gst.BufferFlags.TAG_MEMORY)
SPARSE = int(Gst.StreamFlags.SPARSE)
CLIP = GstAudio.audio_clipping_meta_api_get_type()
PESMETA = GstMpegts.pes_metadata_meta_api_get_type()
ELEM = ("section", "collection", "pad-added", "no-more-pads", "pad-removed", "msg", "warning",
        "error")
# The comparison's rules, one per allowlist entry (demux_parity_allow.json says why each holds).
RULES = ("timestamps", "sections-place", "pmt-same-version", "psi-repeat-cc", "cc-warning",
         "cc-loss-discont", "cc-loss-next-pes", "jump-gap", "sparse-gaps", "truncated-last-pes",
         "tag-memory", "own-messages", "pmt-continuation", "cc-repeat", "marker-gaps",
         "discont-drain", "discont-pending", "discont-flag", "psi-repeat-discont")

_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def crc(b):
    return f"{zlib.crc32(b) & 0xFFFFFFFF:08x}"


def nt(t):
    return None if t == NONE else t


# --- the recording itself -------------------------------------------------------------------

def house_of(data):
    """A recording's own house time (mrts::first_pes_house_ns): its first PES - 1 h, ceil."""
    for pkt in ts_psi.iter_packets(data):
        pts = ts_psi.read_pes_pts(pkt)
        if pts is not None:
            return -(-((pts - MUX_90K) % (1 << 33)) * 100_000 // 9)
    return 0


def arrivals(data):
    """(byte offset, ns from the first PCR) of each PCR on the first PID that carries one."""
    out, pid, last = [], None, None
    for off in range(0, len(data) - PKT + 1, PKT):
        pkt = data[off:off + PKT]
        pcr = ts_psi.read_pcr(pkt) if pkt[0] == 0x47 else None
        if pcr is None:
            continue
        if pid is None:
            pid = ts_psi.ts_pid(pkt)
        if ts_psi.ts_pid(pkt) != pid:
            continue
        base = pcr // 300
        while last is not None and base < last - (1 << 32):
            base += 1 << 33
        last = base
        out.append((off, base * 100_000 // 9))
    return [(o, t - out[0][1]) for o, t in out]


def arrival(points, off):
    """A feed's arrival: the PCR clock at its first byte, by the bytes between two PCRs."""
    if not points:
        return 0
    k = bisect.bisect_left(points, (off, -1))
    if k == 0:
        return points[0][1]
    if k == len(points):
        return points[-1][1]
    (o0, t0), (o1, t1) = points[k - 1], points[k]
    return t0 + (t1 - t0) * (off - o0) // (o1 - o0)


class Facts:
    """What the recording shows, for the rules: CC losses per PID, the PES starts that repeat
    their PID's last CC with other bytes, each PMT PID's sections in order (version, CRC) and how
    many of them span two packets or more, and per PID the last PES when the recording's end cuts
    it short (the size and crc32 of the payload tsdemux pushes at EOS)."""

    def __init__(self, data):
        pkts = list(ts_psi.iter_packets(data))
        self.pmt_pids = set(ts_psi.parse_pat(iter(pkts)).values())
        self.losses, self.repeats, self.pmts, self.pmt_split, self.truncated = {}, {}, {}, {}, {}
        cc, last, pes, sec, parts = {}, {}, {}, {}, {}
        for pkt in pkts:
            pid = ts_psi.ts_pid(pkt)
            if pid == 0x1FFF:
                continue
            afc = (pkt[3] >> 4) & 3
            flagged = afc & 2 and pkt[4] > 0 and pkt[5] & 0x80   # discontinuity_indicator
            if afc & 1:
                c, prev = pkt[3] & 15, cc.get(pid)
                if prev is not None and not flagged and c not in ((prev + 1) & 15, prev):
                    self.losses[pid] = self.losses.get(pid, 0) + 1
                    pes[pid] = sec[pid] = None
                elif c == prev and not flagged and ts_psi.ts_pusi(pkt) and pkt != last.get(pid):
                    self.repeats[pid] = self.repeats.get(pid, 0) + 1
                cc[pid], last[pid] = c, pkt
            off = ts_psi.payload_offset(pkt)
            if not ts_psi.ts_has_payload(pkt) or off >= PKT:
                continue
            body = pkt[off:]
            if pid in self.pmt_pids:
                if ts_psi.ts_pusi(pkt):
                    sec[pid], parts[pid] = bytearray(body[1 + body[0]:]), 1
                elif sec.get(pid) is not None:
                    sec[pid] += body
                    parts[pid] += 1
                s = sec.get(pid)
                n = 3 + (((s[1] & 15) << 8) | s[2]) if s is not None and len(s) >= 3 else None
                if n is not None and len(s) >= n:               # whole: (version, CRC)
                    one = ((s[5] >> 1) & 31, bytes(s[n - 4:n]))
                    if self.pmts.setdefault(pid, [])[-1:] != [one]:
                        self.pmts[pid].append(one)
                    if parts[pid] > 1:
                        self.pmt_split[pid] = self.pmt_split.get(pid, 0) + 1
                    sec[pid] = None
            elif pid:
                if ts_psi.ts_pusi(pkt):
                    pes[pid] = bytearray(body)
                elif pes.get(pid) is not None:
                    pes[pid] += body
        for pid, b in pes.items():
            if b is not None and len(b) >= 9 and b[:3] == b"\x00\x00\x01":
                length = (b[4] << 8) | b[5]
                if length and 6 + length > len(b):
                    payload = bytes(b[9 + b[8]:])
                    self.truncated[pid] = (len(payload), crc(payload))

    def same_version_changes(self, pid):
        """How many times the PMT on `pid` changed while its version stayed."""
        s = self.pmts.get(pid, [])
        return sum(1 for a, b in zip(s, s[1:]) if a[0] == b[0] and a[1] != b[1])


# --- a replay ---------------------------------------------------------------------------------

class Log(list):
    """A record's items; `at[i]` is the input buffer the demuxer was handling when item i came
    (its index among the pushed buffers, -1 before the first)."""

    def __init__(self, items=(), at=()):
        super().__init__(items)
        self.at, self.now = list(at), -1

    def append(self, item):
        super().append(item)
        self.at.append(self.now)


class Record:
    """appsrc ! <factory>, an appsink per pad; `log` holds every item in the order it happened:
    the element's (section, collection, pad-added, no-more-pads, pad-removed, msg, warning,
    error) and each pad's (ev; buf: size, crc32, flags, PTS, DTS, duration, list place, metas);
    `inputs` each pushed buffer's flags, in order, `marks` the PIDs of each gap-marker input."""

    def __init__(self, factory, running):
        self.pipe = Gst.Pipeline.new(None)
        clk = GObject.new(Gst.SystemClock)
        clk.set_property("clock-type", Gst.ClockType.REALTIME)
        self.pipe.use_clock(clk)
        self.pipe.set_start_time(NONE)
        self.pipe.set_base_time(clk.get_time() - running)   # running time = the recording's
        self.src = Gst.ElementFactory.make("appsrc", "src")
        self.src.set_property("format", Gst.Format.TIME)
        self.src.set_property("caps", Gst.Caps.from_string(TS_CAPS))
        self.el = Gst.ElementFactory.make(factory, "demux")
        if factory == "tsdemux":
            self.el.set_property("latency", 0)
        self.pipe.add(self.src)
        self.pipe.add(self.el)
        self.src.link(self.el)
        self.log, self.up, self.done, self.eos = Log(), (None, None), threading.Event(), False
        self.inputs, self.marks = [], {}
        self.src.get_static_pad("src").add_probe(Gst.PadProbeType.EVENT_DOWNSTREAM, self._up)
        self.src.get_static_pad("src").add_probe(Gst.PadProbeType.BUFFER, self._in)
        self.el.connect("pad-added", self._added)
        self.el.connect("pad-removed", lambda _e, p: self.log.append(("pad-removed",
                                                                      p.get_name())))
        self.el.connect("no-more-pads", lambda _e: self.log.append(("no-more-pads",)))
        self.pipe.get_bus().set_sync_handler(self._msg)

    def _up(self, _pad, info):
        ev = info.get_event()
        if ev.type == Gst.EventType.STREAM_START:
            ok, gid = ev.parse_group_id()
            self.up = (ev.parse_stream_start(), gid if ok else None)
        return Gst.PadProbeReturn.OK

    def _in(self, _pad, info):
        """On the streaming thread, right before the demuxer's chain: what follows is its work."""
        self.log.now = len(self.inputs)
        self.inputs.append(int(info.get_buffer().get_flags()))
        return Gst.PadProbeReturn.OK

    def _added(self, _el, pad):
        caps = pad.get_current_caps()
        self.log.append(("pad-added", pad.get_name(), pad.get_pad_template().name_template,
                         caps.to_string() if caps else None))
        sink = Gst.ElementFactory.make("appsink", None)
        for k, v in (("sync", False), ("async", False), ("max-buffers", 1), ("drop", True),
                     ("wait-on-eos", False), ("enable-last-sample", False)):
            sink.set_property(k, v)
        self.pipe.add(sink)
        sink.sync_state_with_parent()
        sp = sink.get_static_pad("sink")
        sp.add_probe(Gst.PadProbeType.EVENT_DOWNSTREAM | Gst.PadProbeType.BUFFER
                     | Gst.PadProbeType.BUFFER_LIST, self._probe, pad.get_name())
        pad.link(sp)

    def _buf(self, name, b, idx, n):
        d = b.extract_dup(0, b.get_size())
        self.log.append(("buf", name, len(d), crc(d), int(b.get_flags()), nt(b.pts), nt(b.dts),
                         nt(b.duration), idx, n, b.get_meta(CLIP) is not None,
                         b.get_meta(PESMETA) is not None))

    def _probe(self, _pad, info, name):
        if info.type & Gst.PadProbeType.BUFFER:
            self._buf(name, info.get_buffer(), -1, 0)
        elif info.type & Gst.PadProbeType.BUFFER_LIST:
            bl = info.get_buffer_list()
            for i in range(bl.length()):
                self._buf(name, bl.get(i), i, bl.length())
        else:
            self.log.append(("ev", name) + self._event(info.get_event()))
        return Gst.PadProbeReturn.OK

    def _strip(self, sid):
        up = self.up[0]
        return sid[len(up):] if up and sid.startswith(up) else sid

    def _event(self, ev):
        t, d = ev.type, None
        if t == Gst.EventType.STREAM_START:
            ok, gid = ev.parse_group_id()
            st = ev.parse_stream()
            d = (self._strip(ev.parse_stream_start()), int(ev.parse_stream_flags()),
                 ok and gid == self.up[1]) + self._stream(st)
        elif t == Gst.EventType.CAPS:
            d = ev.parse_caps().to_string()
        elif t == Gst.EventType.SEGMENT:
            s = ev.parse_segment()
            d = (int(s.format), s.rate, s.applied_rate, int(s.flags), s.start, nt(s.stop), s.time,
                 s.base, s.position, nt(s.duration), s.offset)
        elif t == Gst.EventType.TAG:
            d = ev.parse_tag().to_string()
        elif t == Gst.EventType.GAP:
            d = tuple(ev.parse_gap())
        elif t == Gst.EventType.STREAM_COLLECTION:
            c = ev.parse_stream_collection()
            d = (c.get_size(), self._strip(c.get_upstream_id()))
        return (t.value_nick, d)

    def _stream(self, st):
        """A GstStream: its id after upstream's, type, flags, caps and tags."""
        if st is None:
            return (None,) * 5
        caps, tags = st.get_caps(), st.get_tags()
        return (self._strip(st.get_stream_id() or ""), int(st.get_stream_type()),
                int(st.get_stream_flags()), caps.to_string() if caps else None,
                tags.to_string() if tags else None)

    def _msg(self, _bus, msg):
        if msg.src == self.el and msg.type == Gst.MessageType.ELEMENT:
            sec = GstMpegts.message_parse_mpegts_section(msg)
            st = msg.get_structure()
            self.log.append(("section", sec.section_type.value_nick, sec.pid, sec.version_number)
                            if sec is not None else ("msg", st.get_name(), st.get_string("reason")))
        elif msg.src == self.el and msg.type == Gst.MessageType.STREAM_COLLECTION:
            c = msg.parse_stream_collection()
            self.log.append(("collection", c.get_size(), self._strip(c.get_upstream_id()),
                             tuple(self._stream(c.get_stream(i)) for i in range(c.get_size()))))
        elif msg.type in (Gst.MessageType.WARNING, Gst.MessageType.ERROR):
            err = (msg.parse_error() if msg.type == Gst.MessageType.ERROR
                   else msg.parse_warning())[0]
            self.log.append(("error" if msg.type == Gst.MessageType.ERROR else "warning",
                             err.message))
            if msg.type == Gst.MessageType.ERROR:
                self.done.set()
        elif msg.type == Gst.MessageType.EOS:
            self.eos = True
            self.done.set()
        return Gst.BusSyncReply.DROP

    def pads(self):
        return [e[1] for e in self.log if e[0] == "pad-added"]


def replay(factory, data, feeds):
    """`feeds`: (offset, size, pts, flags) per buffer pushed."""
    r = Record(factory, house_of(data))
    r.pipe.set_state(Gst.State.PLAYING)
    for k, (off, size, pts, flags) in enumerate(feeds):
        if flags & GAP:
            r.marks[k] = {ts_psi.ts_pid(p) for p in ts_psi.iter_packets(data[off:off + size])}
        b = Gst.Buffer.new_wrapped(data[off:off + size])
        b.pts = NONE if pts is None else pts
        if flags:
            b.set_flags(Gst.BufferFlags(flags))
        r.src.emit("push-buffer", b)
    r.src.emit("end-of-stream")
    r.done.wait(60)
    r.pipe.set_state(Gst.State.NULL)      # pad-removed for every pad, in both
    return r


def chunked(data, size):
    house, points = house_of(data), arrivals(data)
    return [(off, size, house + arrival(points, off), 0) for off in range(0, len(data), size)]


def recorded(side):
    return [(ln["off"], ln["len"], ln["pts"], ln["flags"]) for ln in side]


# --- the comparison ---------------------------------------------------------------------------

def caps_equal(a, b):
    return a == b or (a is not None and b is not None
                      and Gst.Caps.from_string(a).is_equal(Gst.Caps.from_string(b)))


class Compare:
    """Every difference between `ref` (tsdemux) and `ours` (mrtsdemux), each either a rule's
    (`allowed`, counted) or a failure (`fails`). Both were fed the same buffers: `dis` lists the
    ones flagged DISCONT after the first (a bus recording's; a source flags its first, when
    nothing is open), `marks` the PIDs of those flagged GAP (OQ-12 markers)."""

    def __init__(self, ref, ours, facts):
        self.ref, self.ours, self.facts = ref, ours, facts
        self.allowed, self.fails = {}, []
        self.dis = [k for k, f in enumerate(ref.inputs) if f & DISCONT and k > 0]
        self.marks = ref.marks
        self.elements()
        for pad in [p for p in ours.pads() if p in ref.pads()]:
            self.pad(pad)

    def allow(self, rule, n=1):
        self.allowed[rule] = self.allowed.get(rule, 0) + n

    def fail(self, what):
        self.fails.append(what)

    def discont_in(self, lo, hi):
        """Whether an input flagged DISCONT lies in (lo, hi]."""
        k = bisect.bisect_right(self.dis, lo)
        return k < len(self.dis) and self.dis[k] <= hi

    # The element: messages, sections, the plan's events.
    def elements(self):
        r = [e for e in self.ref.log if e[0] in ELEM]
        o = [e for e in self.ours.log if e[0] in ELEM]
        if not (self.ref.eos and self.ours.eos):
            self.fail(f"EOS: tsdemux {self.ref.eos}, mrtsdemux {self.ours.eos}")
        for e in r + o:
            if e[0] == "error":
                self.fail(f"error: {e[1]}")
        warned = {}
        for e in r:
            m = re.match(r"CONTINUITY: Mismatch packet \d+, stream \d+ \(pid (0x[0-9a-f]+)\)",
                         e[1]) if e[0] == "warning" else None
            pid = int(m.group(1), 16) if m else None
            if m and warned.get(pid, 0) < self.facts.losses.get(pid, 0):
                warned[pid] = warned.get(pid, 0) + 1          # one per loss on the PID
                self.allow("cc-warning")
            elif e[0] == "warning":
                self.fail(f"tsdemux warning {e[1]!r}")
            elif e[0] == "msg":
                self.fail(f"tsdemux message {e[1:]}")
        for e in o:
            if e[0] == "warning":
                self.fail(f"mrtsdemux warning {e[1]!r}")
            elif e[0] == "msg" and e[1] == "mrtsdemux" and e[2] in ("interval", "program",
                                                                    "unknown-stream"):
                self.allow("own-messages")      # not-house-time or no-stream: a wrong replay
            elif e[0] == "msg":
                self.fail(f"mrtsdemux message {e[1:]}")
        plan = ("collection", "pad-added", "no-more-pads", "pad-removed")
        pr, po = [e for e in r if e[0] in plan], [e for e in o if e[0] in plan]
        same = len(pr) == len(po) and all(
            (a[:3] == b[:3] and caps_equal(a[3], b[3])) if a[0] == "pad-added" else a == b
            for a, b in zip(pr, po))
        if not same:
            bad = next((i for i, (a, b) in enumerate(zip(pr, po)) if a != b), min(len(pr),
                                                                                 len(po)))
            self.fail(f"plan events differ at {bad}: tsdemux {pr[bad:bad + 2]}, "
                      f"mrtsdemux {po[bad:bad + 2]}")
            return
        sr, so = self.sections(self.ref.log, "ref"), self.sections(self.ours.log, "ours")
        if [s[:3] for s in sr] != [s[:3] for s in so]:
            self.fail(f"section messages: tsdemux {[s[:3] for s in sr]}, "
                      f"mrtsdemux {[s[:3] for s in so]}")
            return
        for a, b in zip(sr, so):
            if a[3] == b[3]:
                continue
            # Ours right before its plan's collection message, tsdemux's after its no-more-pads.
            n = next((i for i in range(b[3], len(pr)) if pr[i][0] == "no-more-pads"), None)
            if (a[0] == "pmt" and b[3] < len(pr) and pr[b[3]][0] == "collection" and n is not None
                    and a[3] == n + 1 and all(e[0] != "collection" for e in pr[b[3] + 1:n])):
                self.allow("sections-place")
            else:
                self.fail(f"{a[0]} section at plan event {b[3]} here, {a[3]} in tsdemux")

    def sections(self, log, side):
        """The PAT and PMT messages, each with the count of plan events before it; another
        table, and the repeats and misreads a rule explains, taken out."""
        out, seen, again, at, last, misread = [], {}, {}, 0, {}, {}
        for e, k in zip(log, log.at):
            if e[0] in ("collection", "pad-added", "no-more-pads", "pad-removed"):
                at += 1
            if e[0] != "section":
                continue
            kind, pid, ver = e[1:]
            if (side == "ref" and kind == "unknown" and pid in self.facts.pmt_pids
                    and misread.get(pid, 0) < self.facts.pmt_split.get(pid, 0) - 1):
                misread[pid] = misread.get(pid, 0) + 1    # a skipped PMT's next packet
                self.allow("pmt-continuation")
                continue
            if kind not in ("pat", "pmt"):
                self.fail(f"{side}: a {kind} section message")
                continue
            prev, last[pid] = last.get(pid, -1), k
            if seen.get(pid) == ver:
                if side == "ref" and self.discont_in(prev, k):
                    self.allow("psi-repeat-discont")    # its packetizer cleared at the input
                    continue
                n = again[pid] = again.get(pid, 0) + 1      # one per change or loss on the PID
                if side == "ours" and kind == "pmt" and n <= self.facts.same_version_changes(pid):
                    self.allow("pmt-same-version")
                elif side == "ref" and n <= self.facts.losses.get(pid, 0):
                    self.allow("psi-repeat-cc")
                else:
                    self.fail(f"{side}: {kind} {pid:#x} version {ver} again")
                continue
            seen[pid] = ver
            out.append((kind, pid, ver, at))
        return out

    # One pad: its events, buffers and gaps.
    def pad(self, pad):
        def items(rec):
            """The pad's items, their inputs, its buffers and theirs."""
            ks = [k for k, e in enumerate(rec.log) if e[0] in ("ev", "buf") and e[1] == pad]
            bufs = [k for k in ks if rec.log[k][0] == "buf"]
            return ([rec.log[k] for k in ks], [rec.log.at[k] for k in ks],
                    [rec.log[k] for k in bufs], [rec.log.at[k] for k in bufs])

        ri, ra, rb, rba = items(self.ref)
        oi, oa, ob, oba = items(self.ours)
        starts = [e for e in oi if e[0] == "ev" and e[2] == "stream-start"]
        sparse = bool(starts and starts[0][3][1] & SPARSE)
        pid = int(pad.rsplit("_", 1)[1], 16)
        budget = self.facts.losses.get(pid, 0)   # a CC loss explains one DISCONT
        repeats = self.facts.repeats.get(pid, 0)
        drained, moved, end = set(), set(), len(self.ref.inputs)
        common_r, common_o = set(), set()
        sm = difflib.SequenceMatcher(None, [b[2:4] for b in rb], [b[2:4] for b in ob],
                                     autojunk=False)
        for op, i1, i2, j1, j2 in sm.get_opcodes():
            if op == "equal":
                common_r.update(range(i1, i2))
                common_o.update(range(j1, j2))
                continue
            for i in range(i1, i2):                         # tsdemux's only
                if (i == len(rb) - 1 and j1 == len(ob)
                        and tuple(rb[i][2:4]) == self.facts.truncated.get(pid)):
                    self.allow("truncated-last-pes")
                elif rba[i] in self.dis and rba[i] not in drained:
                    drained.add(rba[i])                     # its drain at a DISCONT input
                    self.allow("discont-drain")
                elif repeats > 0:
                    repeats -= 1
                    moved.add(j1)                           # the pad's DISCONT moves to the next
                    self.allow("cc-repeat")
                else:
                    self.fail(f"{pad}: buffer {i} in tsdemux only ({rb[i][2:5]}, input "
                              f"{rba[i]})")
            for j in range(j1, j2):                         # mrtsdemux's only
                if self.discont_in(oba[j], rba[i2] if i2 < len(rb) else end):
                    self.allow("discont-pending")           # held by tsdemux, then flushed
                elif ob[j][4] & DISCONT and budget > 0:
                    budget -= 1
                    self.allow("cc-loss-next-pes")
                else:
                    self.fail(f"{pad}: buffer {j} in mrtsdemux only ({ob[j][2:5]}, input "
                              f"{oba[j]})")
        # Events, each at the count of common buffers before it; the GAPs apart.
        er, gr = self.events(ri, common_r, ra)
        eo, go = self.events(oi, common_o, oa)
        if er != eo:
            bad = next((i for i, (a, b) in enumerate(zip(er, eo)) if not self.same_event(a, b)),
                       None)
            if bad is not None or len(er) != len(eo):
                k = bad if bad is not None else min(len(er), len(eo))
                self.fail(f"{pad}: events differ at {k}: tsdemux {er[k:k + 2]}, "
                          f"mrtsdemux {eo[k:k + 2]}")
        jumps = set()
        if sparse and [g[0] for g in gr] != [g[0] for g in go]:
            self.allow("sparse-gaps", abs(len(go) - len(gr)) or 1)
        elif not sparse:
            if gr:
                self.fail(f"{pad}: tsdemux GAPs on a pad that is not sparse {gr[:2]}")
            for _at, nxt, last, came in go:
                disc = nxt is not None and bool(ob[nxt][4] & DISCONT)
                if came in self.marks:                      # made at a gap marker input
                    if pid not in self.marks[came]:
                        self.fail(f"{pad}: a GAP at a gap marker of other PIDs (input {came})")
                    elif nxt is None or disc:
                        jumps.update([nxt] if nxt is not None else [])
                        self.allow("marker-gaps")
                    else:
                        self.fail(f"{pad}: a marker's GAP with no DISCONT after it (buffer {nxt})")
                elif last and disc:
                    jumps.add(nxt)
                    self.allow("jump-gap")
                else:
                    self.fail(f"{pad}: a GAP with no DISCONT after it (buffer {nxt})")
        # Buffer by buffer, the common ones.
        for i, j in zip(sorted(common_r), sorted(common_o)):
            a, b = rb[i], ob[j]
            fa, fb = a[4] & ~(DISCONT | TAG_MEMORY), b[4] & ~(DISCONT | TAG_MEMORY)
            if fa != fb or a[8:] != b[8:]:
                self.fail(f"{pad}: buffer {j} flags, list place or metas {a[4:5] + a[8:]} / "
                          f"{b[4:5] + b[8:]}")
                continue
            if b[4] & TAG_MEMORY and not a[4] & TAG_MEMORY:
                self.allow("tag-memory")
            elif a[4] & TAG_MEMORY != b[4] & TAG_MEMORY:
                self.fail(f"{pad}: buffer {j} TAG_MEMORY in tsdemux only")
            if a[5:8] != b[5:8]:
                self.allow("timestamps")
            if a[4] & DISCONT == b[4] & DISCONT:
                continue
            if a[4] & DISCONT:
                if self.discont_in(rba[i - 1] if i else -1, rba[i]):
                    self.allow("discont-flag")              # its flush flags every pad
                else:
                    self.fail(f"{pad}: buffer {j} DISCONT in tsdemux only")
            elif j in jumps or j in moved:
                pass                                      # counted with its GAP or repeat
            elif budget > 0:
                budget -= 1
                self.allow("cc-loss-discont")
            else:
                self.fail(f"{pad}: buffer {j} DISCONT with no CC loss, jump or marker")

    @staticmethod
    def events(items, common, at):
        """(events at their common-buffer count, [GAP at, index of the next buffer, whether it
        is the last GAP before that buffer, the input it came with])."""
        out, gaps, n, k, open_ = [], [], 0, -1, 0
        for x, e in enumerate(items):
            if e[0] == "buf":
                k += 1
                n += k in common
                if open_ < len(gaps):
                    gaps[-1][2] = True
                    for g in gaps[open_:]:
                        g[1] = k
                    open_ = len(gaps)
            elif e[2] == "gap" and e[3] != (0, 0):
                gaps.append([n, None, False, at[x]])
            else:
                out.append((n, e[2], e[3]))
        return out, gaps

    @staticmethod
    def same_event(a, b):
        if a[:2] != b[:2]:
            return False
        if a[1] == "caps":
            return caps_equal(a[2], b[2])
        if a[1] == "stream-start":
            return a[2][:6] == b[2][:6] and caps_equal(a[2][6], b[2][6]) and a[2][7] == b[2][7]
        return a[2] == b[2]


def tsdemux_facts(ref, reached):
    """tsdemux 1.28.2's facts the allowlist rests on (measured; B-124's list), plan by plan;
    pad names "%01x_%04x" (tsdemux.c:2111-2133) where the templates say %05x. `reached` counts
    the plans and pads each fact was checked on, so a fact no recording reaches fails."""
    bad, plan, pads = [], -1, None
    for i, e in enumerate(ref.log):
        if e[0] == "collection":
            plan, pads = plan + 1, []
            reached["plans"] += 1
        elif e[0] == "pad-added":
            if pads is None:
                bad.append(f"{e[1]}: added with no collection message before it")
                pads = []
            if not re.match(rf"^(video|audio|private|subpicture)_{plan & 15:x}_[0-9a-f]{{4}}$",
                            e[1]):
                bad.append(f"{e[1]}: plan {plan}'s generation, the PID in four digits")
            c = Gst.Caps.from_string(e[3]).get_structure(0)
            if c.get_string("stream-format") == "adts":
                reached["ADTS pads"] += 1
                if c.get_int("mpegversion") != (True, 4):
                    bad.append(f"{e[1]}: ADTS caps at pad-added mpegversion=4")
            if c.get_name() == "audio/x-opus":
                reached["Opus pads"] += 1
                if not all(c.has_field(f) for f in ("rate", "channels", "channel-mapping-family",
                                                    "stream-count", "coupled-count")):
                    bad.append(f"{e[1]}: Opus caps fields")
            pads.append(e[1])
        elif e[0] == "no-more-pads" and pads is not None:
            for pad in pads:
                # A pad after a sparse one in plan order also has the SEGMENT and TAG that the
                # sparse pad's GAP(0, 0) pushed to every pad (calculate_and_push_newsegment).
                at = [k for k, x in enumerate(ref.log[:i]) if x[0] == "ev" and x[1] == pad]
                names = [ref.log[k][2] for k in at]
                sc = names.index("stream-collection") if "stream-collection" in names else -1
                sparse = names and ref.log[at[0]][3][1] & SPARSE
                reached["sparse pads"] += bool(sparse)
                if (sc < 0 or names[:2] != ["stream-start", "caps"]
                        or sparse and ref.log[at[sc - 1]][2:] != ("gap", (0, 0))):
                    bad.append(f"{pad}: STREAM_COLLECTION after STREAM_START, CAPS (a sparse "
                               f"pad's GAP(0, 0) right before it), before no-more-pads "
                               f"({names[:sc + 1]})")
            nxt = next((x for x in ref.log[i + 1:] if x[0] in ("section", "collection",
                                                               "pad-added", "pad-removed")), None)
            if nxt is None or nxt[:2] != ("section", "pmt"):
                bad.append(f"plan {plan}: the PMT message right after no-more-pads ({nxt})")
            pads = None
    if plan < 0:
        bad.append("a plan")
    return bad


def mutant(ref, ours, facts, edit):
    """The comparison's failures for `ours` with each log item edited (None drops it)."""
    m = copy.copy(ours)
    kept = [(x, a) for x, a in zip((edit(e) for e in ours.log), ours.log.at) if x is not None]
    m.log = Log([x for x, _ in kept], [a for _, a in kept])
    return Compare(ref, m, facts).fails


# === the run ==================================================================================
with open(ALLOW) as f:
    allow = json.load(f)
entries = {e["id"]: e for e in allow["entries"]}
print("\n--- the allowlist ---")
check(f"every entry has an id, what it allows and a reason ({len(entries)} entries)",
      all(e.get("id") and e.get("what") and len(e.get("reason", "")) > 40
          for e in allow["entries"]) and len(entries) == len(allow["entries"]))
check(f"one entry per rule of the comparison ({sorted(set(RULES) ^ set(entries))})",
      set(entries) == set(RULES))
check("the brief's entries measured equal, and the fixtures left out, each with its reason",
      all(x.get("item") and len(x.get("why", "")) > 40 for x in allow["measuredEqual"])
      and all(x.get("fixtures") and len(x.get("why", "")) > 40 for x in allow["excluded"]))

names = sorted(f[:-3] for f in os.listdir(FIX) if f.endswith(".ts")
               and f.split("-", 1)[0] in ("cap", "tp", "bus"))
print(f"\n--- {len(names)} recorded fixtures, each at {', '.join(map(str, CHUNKS))} bytes "
      f"(a bus recording also as recorded) ---")
check(f"{len(names)} recorded fixtures (cap-*, tp-*, bus-*)", len(names) >= 25)
used, mutant_pair, bus_pair = {}, None, None
reached = dict.fromkeys(("plans", "ADTS pads", "Opus pads", "sparse pads"), 0)
for name in names:
    with open(os.path.join(FIX, name + ".ts"), "rb") as f:
        data = f.read()
    facts = Facts(data)
    side_path = os.path.join(FIX, name + ".bus.jsonl")
    modes = [(str(c), chunked(data, c)) for c in CHUNKS]
    if os.path.exists(side_path):
        with open(side_path) as f:
            modes.append(("bus", recorded([json.loads(ln) for ln in f])))
    facts_bad = set()
    for label, feeds in modes:
        ref, ours = replay("tsdemux", data, feeds), replay("mrtsdemux", data, feeds)
        cmp = Compare(ref, ours, facts)
        facts_bad.update(tsdemux_facts(ref, reached))
        for k, v in cmp.allowed.items():
            used[k] = used.get(k, 0) + v
        nbuf = sum(1 for e in ours.log if e[0] == "buf")
        check(f"{name} @{label}: {len(ours.pads())} pads, {nbuf} buffers as tsdemux's; allowed "
              f"{', '.join(f'{k} {v}' for k, v in sorted(cmp.allowed.items()))} "
              f"{cmp.fails[:3]}", not cmp.fails and ours.pads())
        if name == "cap-mux-align7-aac-opus" and label == "1316":
            mutant_pair = (ref, ours, facts)
        if name == "bus-ingest-relock-gap" and label == "bus":
            bus_pair = (ref, ours, facts)
    check(f"{name}: tsdemux's facts the comparison rests on, at every feed {sorted(facts_bad)}",
          not facts_bad)

print("\n--- every entry earns its place, every tsdemux fact is checked ---")
check(f"each entry allows a difference this run makes "
      f"({', '.join(f'{k} {used.get(k, 0)}' for k in RULES)})",
      all(used.get(k, 0) > 0 for k in RULES))
check(f"each tsdemux fact checked on its output "
      f"({', '.join(f'{k} {v}' for k, v in reached.items())})", all(reached.values()))

print("\n--- self-mutants: the comparison fails each ---")
check("the mutants' fixture ran", mutant_pair is not None)
if mutant_pair:
    ref, ours, facts = mutant_pair
    check("the record as it is passes", not Compare(ref, ours, facts).fails)
    renamed = mutant(ref, ours, facts, lambda e: e[:1] + ("audio_0_0109",) + e[2:]
                     if e[0] in ("pad-added", "pad-removed", "ev", "buf")
                     and e[1] == "audio_0_0108" else e)
    check(f"a renamed pad (audio_0_0108 as audio_0_0109) fails ({renamed[:1]})", bool(renamed))
    no_pmt = mutant(ref, ours, facts, lambda e: None if e[:2] == ("section", "pmt") else e)
    check(f"a dropped section message (the PMT) fails ({no_pmt[:1]})", bool(no_pmt))
    k = [i for i, e in enumerate(ours.log) if e[:2] == ("buf", "audio_0_0100")][100]
    dropped = mutant(ref, ours, facts, lambda e: None if e is ours.log[k] else e)
    check(f"a dropped buffer mid-stream fails ({dropped[:1]})", bool(dropped))
    flagged = mutant(ref, ours, facts, lambda e: e[:4] + (e[4] | DISCONT,) + e[5:]
                     if e is ours.log[k] else e)
    check(f"a DISCONT with no CC loss, jump or marker fails ({flagged[:1]})", bool(flagged))

check("the bus mutants' recording ran (bus-ingest-relock-gap as recorded)", bus_pair is not None)
if bus_pair:
    ref, ours, facts = bus_pair
    check("its record as it is passes", not Compare(ref, ours, facts).fails)
    # The first audio unit after a marker's GAP, and 0xc9's GAP from its own (relock) marker.
    after, own, prev = None, None, {}
    for i, e in enumerate(ours.log):
        if e[0] not in ("ev", "buf") or not e[1].startswith("audio"):
            continue
        p, came = prev.get(e[1]), ours.log.at[i]
        if after is None and e[0] == "buf" and p and p[0][2] == "gap" and p[1] in ref.marks:
            after = i
        if own is None and e[:3] == ("ev", "audio_0_00c9", "gap") and ref.marks.get(came) == {0xc9}:
            own = i
        prev[e[1]] = (e, came)
    unflagged = mutant(ref, ours, facts, lambda e: e[:4] + (e[4] & ~DISCONT,) + e[5:]
                       if e is ours.log[after] else e) if after is not None else []
    check(f"the unit after a marker's GAP without DISCONT fails ({unflagged[:1]})",
          bool(unflagged))
    moved = mutant(ref, ours, facts, lambda e: e[:1] + ("audio_0_00ca",) + e[2:]
                   if e is ours.log[own] else e) if own is not None else []
    check(f"a marker's GAP on a pad whose PID it does not carry fails ({moved[:1]})", bool(moved))
    k = [i for i, e in enumerate(ours.log) if e[:2] == ("buf", "audio_0_00c9")][3]
    twice = copy.copy(ours)
    twice.log = Log(ours.log[:k + 1] + ours.log[k:], ours.log.at[:k + 1] + ours.log.at[k:])
    extra = Compare(ref, twice, facts).fails
    check(f"a unit twice, no DISCONT input before tsdemux's next, fails ({extra[:1]})",
          bool(extra))

if _failures:
    print(f"\n{len(_failures)} FAILURE(S) in gst_mrtsdemux_parity_test.py")
    sys.exit(1)
print("\nALL gst_mrtsdemux_parity_test.py TESTS PASSED")
