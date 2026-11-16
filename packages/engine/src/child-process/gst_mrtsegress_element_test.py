#!/usr/bin/env python3
"""mrtsegress (plan ch. 9 WI-P5-3, B-250) over its own pads on a fixed clock against
py/egress_core.py (the C++ core's byte-exact twin): bytes, events, memories, lists, GAP buffers,
stats, the PCR timer, gst-inspect, both runners and the stand-in. Skips without the plugin."""
import atexit
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import warnings

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_mrtsegress_element_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

Gst.init(sys.argv)
warnings.filterwarnings("ignore", category=DeprecationWarning)

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.normpath(os.path.join(_HERE, "..", "..", "..", ".."))
_PY = os.path.join(_ROOT, "plugins", "mpegts-core", "py")
_FIX = os.path.join(_ROOT, "plugins", "mpegts-core", "tests", "fixtures")
sys.path.insert(0, _HERE)
sys.path.insert(0, _PY)
import egress_core as ec  # noqa: E402
import egress_ref_test as rt  # noqa: E402
import hcdesc  # noqa: E402

_SO = os.path.join(os.environ.get("MR_PLUGINS_DIR") or os.path.join(_ROOT, "plugins"),
                   "mpegts-core", "native", "mrtshouse", "libgstmrtshouse.so")
if not os.path.exists(_SO):
    print(f"SKIP gst_mrtsegress_element_test.py — mrtshouse plugin not built ({_SO}); "
          "run `make native`")
    sys.exit(0)
Gst.Plugin.load_file(_SO)   # a file that is there but does not load is a failure

PKT = ec.PKT
MS = ec.MS
SEC = ec.SEC
NONE = Gst.CLOCK_TIME_NONE
E1 = 1760283215123456789
_failures = []


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def sdict(st):
    return {st.nth_field_name(i): st.get_value(st.nth_field_name(i)) for i in range(st.n_fields())}


def ptr(boxed):
    """The C address in a boxed object's repr: identity across Python wrappers."""
    m = re.search(r"\((?:\w+) at (0x[0-9a-f]+)\)", repr(boxed))
    return m.group(1) if m else None


# --- the house-clock value and its declaration -------------------------------------------------

def hc(e_ns=E1, seq=3, error_us=1200, source="ntp", traceable=True, disciplined=True, tai=37):
    """A house-clock value as houseClockFieldsString writes it."""
    parts = ["house-clock", f"e-ns=(gint64){e_ns}", f"seq=(uint){seq}",
             f"traceable=(boolean){'true' if traceable else 'false'}",
             f"disciplined=(boolean){'true' if disciplined else 'false'}", f"source=(string){source}"]
    if error_us is not None:
        parts.append(f"error-us=(uint){error_us}")
    parts += [f"tai-offset-s=(int){tai}", "ptp-domain=(int)-1", 'gm=(string)""']
    return ", ".join(parts)


def decl(e_ns=E1, seq=3, error_us=1200, source="ntp", traceable=True, disciplined=True, tai=37,
         timeline=0):
    src = {"ntp": hcdesc.SYNC_NTP, "ptp": hcdesc.SYNC_PTP}.get(source, hcdesc.SYNC_NONE)
    return ec.ClockDecl(e_ns=e_ns, seq=seq, known=e_ns != 0, traceable=traceable,
                        disciplined=disciplined, source=src, tai_offset_s=tai, error_us=error_us,
                        timeline_id=timeline)


# --- the harness -------------------------------------------------------------------------------

class FixedClock(Gst.Clock):
    """A clock that reads what the test set: the element's house time, per buffer."""

    def __init__(self):
        super().__init__()
        self.t = 0

    def do_get_internal_time(self):
        return self.t


class Harness:
    """Own src pad -> mrtsegress -> own sink pad, in a pipeline for its bus. PAUSED on a fixed
    clock: a push runs the chain in this thread, and no timer runs. live: PLAYING on the
    system clock, the PCR timer on."""

    def __init__(self, live=False, **props):
        self.pipe = Gst.Pipeline.new(None)
        self.el = Gst.ElementFactory.make("mrtsegress", "egress")
        for k, v in props.items():
            self.el.set_property(k.replace("_", "-"), v)
        self.pipe.add(self.el)
        self.src = Gst.Pad.new("h_src", Gst.PadDirection.SRC)
        self.sink = Gst.Pad.new("h_sink", Gst.PadDirection.SINK)
        self.out, self.msgs, self.warnings = [], [], []
        self.sink.set_chain_function_full(self._chain)
        self.sink.set_chain_list_function_full(self._chain_list)
        self.sink.set_event_function_full(lambda pad, parent, ev: True)
        self.src.link(self.el.get_static_pad("sink"))
        self.el.get_static_pad("src").link(self.sink)
        self.pipe.get_bus().set_sync_handler(self._on_message)
        self.src.set_active(True)
        self.sink.set_active(True)
        self.clock = None
        if live:
            self.pipe.use_clock(Gst.SystemClock.obtain())
            self.pipe.set_state(Gst.State.PLAYING)
        else:
            self.clock = FixedClock()
            self.pipe.set_state(Gst.State.PAUSED)
            self.el.set_clock(self.clock)
        self.src.push_event(Gst.Event.new_stream_start("egress-test"))
        self.src.push_event(Gst.Event.new_caps(Gst.Caps.from_string("video/mpegts,systemstream=true")))
        seg = Gst.Segment()
        seg.init(Gst.Format.TIME)
        self.src.push_event(Gst.Event.new_segment(seg))

    def _chain(self, pad, parent, buf):
        self.out.append(("buf", [buf]))
        return Gst.FlowReturn.OK

    def _chain_list(self, pad, parent, blist):
        self.out.append(("list", [blist.get(i) for i in range(blist.length())]))
        return Gst.FlowReturn.OK

    def _on_message(self, bus, msg):
        if msg.type == Gst.MessageType.ELEMENT:
            st = msg.get_structure()
            self.msgs.append((st.get_name(), sdict(st)))
        elif msg.type == Gst.MessageType.WARNING:
            self.warnings.append(msg.parse_warning()[0].message)
        return Gst.BusSyncReply.DROP

    @staticmethod
    def buffer(data, pts=NONE, gap=False):
        b = Gst.Buffer.new_wrapped(bytes(data))
        b.pts = pts
        if gap:
            b.set_flags(Gst.BufferFlags.GAP | Gst.BufferFlags.DISCONT)
        # Read only, as the bus hands it over: a write map of it would fail.
        b.peek_memory(0).mini_object.flags |= Gst.MemoryFlags.READONLY
        return b

    def push(self, buf, now=None):
        if now is not None:
            self.clock.t = now
        return self.src.push(buf)

    def push_list(self, bufs, now):
        self.clock.t = now
        bl = Gst.BufferList.new()
        for b in bufs:
            bl.insert(-1, b)
        return self.src.push_list(bl)

    def events(self):
        return [m for n, m in self.msgs if n == "mrtsegress-event"]

    def stats(self):
        return [m for n, m in self.msgs if n == "mrtsegress-stats"]

    def eos(self):
        self.src.push_event(Gst.Event.new_eos())

    def close(self):
        self.pipe.set_state(Gst.State.NULL)


def data_of(b):
    return b.extract_dup(0, b.get_size())


def out_bytes(items):
    return b"".join(data_of(b) for _k, bs in items for b in bs)


# --- the scenarios: element and reference over the same steps ---------------------------------

def steps_from(data, nows, chunk=1316):
    return [("buf", data[o:o + chunk], nows[k], None) for k, o in enumerate(range(0, len(data), chunk))]


def content_nows(data, lateness, chunk=1316):
    """Each chunk's house now: its content time plus lateness(content - c0), never backwards
    (a GstClock never reads backwards)."""
    anchors = ec.content_anchors(data)
    c0 = anchors[0][1]
    out, last = [], 0
    for o in range(0, len(data), chunk):
        c = ec._interp(anchors, o)
        last = max(last, c + lateness(c - c0))
        out.append(last)
    return out


def run_both(steps, props=None, cfg=None):
    """Element and reference over steps ("buf", bytes, now, gap_pts|None), ("clock", value, decl),
    ("timeline", text, decl), ("list", [bytes], now): per data step (kind, out, want, inputs)."""
    h = Harness(**(props or {}))
    ref = ec.EgressCore(cfg or ec.EgressConfig())
    per, ref_events = [], []
    for st in steps:
        kind = st[0]
        if kind == "clock":
            h.el.set_property("house-clock", st[1])
            ref.set_clock(st[2])
            continue
        if kind == "timeline":
            h.el.set_property("timeline-id", st[1])
            ref.set_clock(st[2])
            continue
        if kind == "list":
            ins = [Harness.buffer(d) for d in st[1]]
            n0 = len(h.out)
            h.push_list(ins, st[2])
            want = []
            for d in st[1]:
                r = ref.process(d, st[2])
                want.append(ec.apply_edits(r.packets, r.edits))
                ref_events += ref.take_events()
            per.append(("list", h.out[n0:], want, ins))
            continue
        _k, d, now, gap = st
        b = Harness.buffer(d, pts=gap if gap is not None else NONE, gap=gap is not None)
        n0 = len(h.out)
        h.push(b, now)
        r = ref.process(d, now, gap_pts=gap)
        per.append(("buf", h.out[n0:], [ec.apply_edits(r.packets, r.edits)], [b]))
        ref_events += ref.take_events()
    n_items = len(h.out)
    h.eos()
    # EOS: what the core held leaves; both sides' tails are compared as bytes.
    return h, ref, per, ref_events, (h.out[n_items:], b"".join(ref.flush()))


def same_events(got, want):
    """The element's mrtsegress-event messages against the reference's events, field by field."""
    names = {"program": "program", "pid": "pid", "fromNs": "from-ns", "toNs": "to-ns",
             "latenessNs": "lateness-ns", "gapNs": "gap-ns", "seq": "seq", "fromSeq": "from-seq",
             "deltaNs": "delta-ns", "inPackets": "in-packets", "outPackets": "out-packets"}
    if len(got) != len(want):
        return False
    return all(g["kind"] == w["event"] and all(g[names[k]] == v for k, v in w.items() if k in names)
               for g, w in zip(got, want))


def stream_bytes_equal(per, tail):
    got = b"".join(out_bytes(items) for _k, items, _w, _i in per) + out_bytes(tail[0])
    want = b"".join(b"".join(w) for _k, _items, w, _i in per) + tail[1]
    return got == want, got


# --- cases -------------------------------------------------------------------------------------

def case_bytes():
    print("\n--- bytes, events, a live re-epoch and timeline-id ---")
    data = rt.gen("--duration", "6")
    nows = content_nows(data, lambda c: 100 * MS if c < 2 * SEC else 900 * MS)
    steps = steps_from(data, nows)
    k_re, k_tl, k_err, k_same = len(steps) * 2 // 5, len(steps) * 3 // 5, len(steps) * 7 // 10, \
        len(steps) * 4 // 5
    d0, d1 = decl(), decl(seq=4, e_ns=E1 + 2 * SEC)
    d2 = decl(seq=4, e_ns=E1 + 2 * SEC, timeline=0x0123456789ABCDEF)
    d3 = decl(seq=4, e_ns=E1 + 2 * SEC, timeline=0x0123456789ABCDEF, error_us=1900)
    steps = ([("clock", hc(), d0)] + steps[:k_re] + [("clock", hc(seq=4, e_ns=E1 + 2 * SEC), d1)]
             + steps[k_re:k_tl] + [("timeline", "0123456789abcdef", d2)] + steps[k_tl:k_err]
             + [("clock", hc(seq=4, e_ns=E1 + 2 * SEC, error_us=1900), d3)] + steps[k_err:k_same]
             + [("clock", hc(seq=4, e_ns=E1 + 2 * SEC, error_us=1900), d3)] + steps[k_same:])
    h, ref, per, ref_events, tail = run_both(steps)
    ok, got = stream_bytes_equal(per, tail)
    check(f"bytes: the whole output equals EgressCore's for the same input and clock ({len(got)} "
          "bytes)", ok and len(got) > len(data))
    each = all(b"".join(data_of(b) for _k, bs in items for b in bs) == b"".join(w)
               for _k, items, w, _i in per)
    check("bytes: buffer by buffer, the element pushes what the core makes of that buffer", each)
    ev = h.events()
    check(f"events: every mrtsegress-event as the core's ({len(ev)}: "
          f"{sorted({e['kind'] for e in ev})})", same_events(ev, ref_events)
          and {"d-e-start", "d-e-raise", "re-epoch"} <= {e["kind"] for e in ev})
    walk = rt.Walk(got)
    pmts = walk.of("pmt")
    # The first output after the re-epoch: a new PMT (seq 4), then a flagged PCR, before any PES.
    at = sum(len(out_bytes(items)) for _k, items, _w, _i in per[:k_re]) // PKT
    after = [r for r in walk.recs if r[1] >= at]
    first_pes = next(i for i, r in enumerate(after) if r[0] == "pes")
    head = after[:first_pes]
    pmt_i = next((i for i, r in enumerate(head) if r[0] == "pmt"), None)
    pcr_i = next((i for i, r in enumerate(head) if r[0] == "pcr" and r[2]["disc"]), None)
    check("re-epoch: seq + 1 gives a new PMT (epoch_seq 4, version bumped) and then a flagged PCR "
          "before the next PES", pmt_i is not None and pcr_i is not None and pmt_i < pcr_i
          and head[pmt_i][2]["decl"].epoch_seq == 4
          and head[pmt_i][2]["version"] != [r for r in pmts if r[1] < at][-1][2]["version"])
    versions = [(r[1], r[2]["version"]) for r in pmts]
    at_err = sum(len(out_bytes(items)) for _k, items, _w, _i in per[:k_err]) // PKT
    at_same = sum(len(out_bytes(items)) for _k, items, _w, _i in per[:k_same]) // PKT
    v_err = {v for i, v in versions if at_err <= i < at_same}
    v_same = {v for i, v in versions if i >= at_same}
    check("house-clock: an error inside its class held 10 s, the same value set again: no PMT "
          "version bump", len(v_err) == 1 and v_same == v_err)
    tl = [r[2]["decl"].timeline_id for r in pmts if r[2]["decl"] is not None]
    check("timeline-id: set live, the descriptor carries it from the next buffer",
          tl[0] == 0 and tl[-1] == 0x0123456789ABCDEF)
    check("d-e-ns and epoch-seq read the core's", h.el.get_property("d-e-ns") == ref.stats(1)["dENs"]
          and h.el.get_property("epoch-seq") == 4)
    tag = Gst.BufferFlags.TAG_MEMORY   # GStreamer's own mark of a buffer given new memory
    check("PTS/DTS/flags of every output buffer are its input's",
          all(b.pts == i.pts and b.dts == i.dts and (b.get_flags() & ~tag) == i.get_flags()
              for _k, items, _w, ins in per for (_x, bs), i in zip(items, ins) for b in bs))
    # Memories: untouched runs are the input's memory, shared; changed and inserted packets new.
    shared_ok = fresh_ok = True
    n_shared = n_fresh = spans = 0
    for _k, items, _w, ins in per:
        for (_x, bs), i in zip(items, ins):
            b, src = bs[0], i.peek_memory(0)
            mems = [b.peek_memory(m) for m in range(b.n_memory())]
            for m in mems:
                if m.parent is not None and ptr(m.parent) == ptr(src):
                    n_shared += 1
                    # A sub-memory of the input at its offset: it spans with the input's rest.
                    end = m.offset + m.size
                    if end < src.size:
                        spans += 1
                        shared_ok = shared_ok and m.is_span(src.share(end, src.size - end))[0]
                elif ptr(m) == ptr(src):
                    n_shared += 1          # the input itself: nothing changed
                else:
                    n_fresh += 1
                    fresh_ok = fresh_ok and m.parent is None and m.size % PKT == 0
            for a, c in zip(mems, mems[1:]):
                if a.parent is not None and c.parent is not None:
                    shared_ok = False      # two shared runs always have new packets between
    check(f"memories: untouched runs share the input's memory ({n_shared}; gst_memory_is_span with "
          f"the input's rest: {spans}), changed and inserted packets are new memories ({n_fresh})",
          shared_ok and fresh_ok and n_shared > 50 and n_fresh > 50 and spans > 50)
    check("read only: every input buffer's bytes as pushed, no warning",
          all(data_of(i) == bytes(st[1]) for (_k, _it, _w, ins), st in
              zip(per, [s for s in steps if s[0] == "buf"]) for i in ins) and not h.warnings)
    stats = h.stats()
    want = {"program", "pcr-pid", "d-e-ns", "lateness-min-ns", "lateness-mean-ns", "lateness-max-ns",
            "pcr-written", "pcr-inserted", "pcr-interval-max-ns", "pmt-rewritten", "packets",
            "bytes-in", "bytes-out", "epoch-seq", "traceable", "merged-buffers",
            "proc-ns-per-packet", "lateness-off-house", "timeline-id"}
    last = stats[-1] if stats else {}
    check(f"stats: mrtsegress-stats every 2 s of house time with chapter 9's fields "
          f"({len(stats)}; missing {sorted(want - set(last))})",
          len(stats) >= 2 and want <= set(last) and last["timeline-id"] == "0123456789abcdef"
          and last["epoch-seq"] == 4 and last["traceable"] is True and last["program"] == 1)
    rs = ref.stats(1)
    check("stats: the EOS post carries the core's totals",
          last.get("d-e-ns") == rs["dENs"] and last.get("pcr-written") == rs["pcrWritten"]
          and last.get("pcr-inserted") == rs["pcrInserted"] and last.get("pmt-rewritten") == rs["pmtSent"]
          and last.get("lateness-min-ns", 1) <= last.get("lateness-mean-ns", 0) <= last.get("lateness-max-ns", -1)
          and last.get("bytes-out") == len(got) and 0 < last.get("pcr-interval-max-ns", 0) < SEC)
    snap = h.el.get_property("stats")
    check("stats: the snapshot holds each program's post and the counters",
          snap.get_name() == "mrtsegress-stats" and snap.get_value("buffers") == len(per)
          and snap.get_value("re-epochs") == 1)
    h.close()


def case_gap():
    print("\n--- a GAP buffer: consumed, not sent, D_e lowered ---")
    data = rt.fixture("syn-gap-marker.ts")
    bus = ec.read_bus(os.path.join(_FIX, "syn-gap-marker.bus.jsonl"))
    gap_at = next(b["pts"] for b in bus if b["flags"] & ec.GST_FLAG_GAP)
    steps, last = [("clock", hc(), decl())], 0
    for b in bus:
        d = data[b["off"]:b["off"] + b["len"]]
        if b["flags"] & ec.GST_FLAG_GAP:
            steps.append(("buf", d, last, b["pts"]))
            continue
        last = max(last, b["pts"] + (1100 * MS if b["pts"] < gap_at else 200 * MS))
        steps.append(("buf", d, last, None))
    h, ref, per, ref_events, tail = run_both(steps)
    gaps = [p for p, st in zip(per, [s for s in steps if s[0] == "buf"]) if st[3] is not None]
    check(f"gap: each GAP buffer is consumed and nothing is pushed for it ({len(gaps)})",
          len(gaps) == 2 and all(not items for _k, items, _w, _i in gaps))
    low = [e for e in h.events() if e["kind"] == "d-e-lower"]
    check(f"gap: D_e lowered at the next PES, by at most the gap ({low})",
          len(low) == 1 and 0 < low[0]["from-ns"] - low[0]["to-ns"] <= low[0]["gap-ns"])
    ok, got = stream_bytes_equal(per, tail)
    check("gap: the output equals the core's, no marker in it",
          ok and not any(ec.dc.read_gap_length(got[i:i + PKT]) >= 0 for i in range(0, len(got), PKT))
          and same_events(h.events(), ref_events))
    check("gap: the snapshot counts both markers", h.el.get_property("stats").get_value("gap-markers") == 2)
    h.close()


def case_list():
    print("\n--- a list ---")
    data = rt.gen("--duration", "2")
    nows = content_nows(data, lambda c: 100 * MS)
    chunks = [data[o:o + 1316] for o in range(0, len(data), 1316)]
    steps = [("clock", hc(), decl())] + [("buf", chunks[k], nows[k], None) for k in range(40)]
    steps.append(("list", chunks[40:47], nows[46]))
    steps += [("buf", chunks[k], nows[k], None) for k in range(47, 60)]
    h, _ref, per, ref_events, _tail = run_both(steps)
    lists = [x for x in per if x[0] == "list"]
    _k, items, want, _ins = lists[0]
    check(f"list: a list of 7 leaves as one list of 7 ({[(k, len(b)) for k, b in items]})",
          len(items) == 1 and items[0][0] == "list" and len(items[0][1]) == 7)
    check("list: each member as the core makes it", [data_of(b) for b in items[0][1]] == want)
    check("list: events as the core's", same_events(h.events(), ref_events))
    h.close()


def case_merged():
    print("\n--- past 16 memories: one copy ---")
    data = rt.fixture("cap-302m-bssd.ts")
    chunk = PKT * 1000            # about 12 PES headers: some 25 pieces
    nows = content_nows(data, lambda c: 100 * MS, chunk)
    steps = [("clock", hc(), decl())] + steps_from(data, nows, chunk)
    h, _ref, per, _rev, tail = run_both(steps)
    bufs = [bs[0] for _k, items, _w, _i in per for _x, bs in items]
    merged = h.el.get_property("stats").get_value("merged-buffers")
    ok, _got = stream_bytes_equal(per, tail)
    check(f"merged: no output buffer passes 16 memories; {merged} merged into one copy",
          all(b.n_memory() <= 16 for b in bufs) and merged > 0
          and sum(1 for b in bufs if b.n_memory() == 1 and b.peek_memory(0).parent is None) >= merged)
    check("merged: the bytes still the core's", ok)
    h.close()


def case_unknown_clock():
    print("\n--- no house-clock: E unknown ---")
    data = rt.gen("--duration", "1")
    h = Harness()
    nows = content_nows(data, lambda c: 100 * MS)
    for k, o in enumerate(range(0, len(data), 1316)):
        h.push(Harness.buffer(data[o:o + 1316]), nows[k])
    got = out_bytes(h.out)
    d = [r[2]["decl"] for r in rt.Walk(got).of("pmt") if r[2]["decl"] is not None]
    check("unknown: without house-clock the descriptor says not TAI, not traceable, class unknown",
          d and not d[0].house_time_tai and not d[0].traceable
          and d[0].clock_error_class == hcdesc.ERROR_CLASS_UNKNOWN)
    h.el.set_property("house-clock", "not a structure")
    h.el.set_property("timeline-id", "xyz")
    check("bad values: house-clock and timeline-id refused with a warning each, the last kept",
          len(h.warnings) == 2 and h.el.get_property("house-clock") == ""
          and h.el.get_property("timeline-id") == "")
    h.el.set_property("house-clock", hc(error_us=None))
    h.push(Harness.buffer(data[:1316]), nows[-1] + 10 * MS)
    h.close()


def case_timer():
    print("\n--- the PCR timer through a silence (PLAYING, system clock) ---")
    data = rt.gen("--audio-only", "--duration", "3")
    h = Harness(live=True, stats_interval_ms=100)
    h.el.set_property("house-clock", hc())
    chunks = [data[o:o + 1316] for o in range(0, len(data), 1316)]
    for c in chunks[:20]:
        h.src.push(Harness.buffer(c))
    n0 = len(h.out)
    time.sleep(0.6)
    ticks = h.out[n0:]
    for c in chunks[20:30]:
        h.src.push(Harness.buffer(c))
    snap = h.el.get_property("stats")
    h.close()
    got = b"".join(data_of(b) for _k, bs in ticks for b in bs)
    pcrs = [r for r in rt.Walk(got).of("pcr")]
    only_pcr = all(r[2]["af_only"] for r in pcrs) and len(got) == PKT * len(pcrs)
    check(f"timer: a 600 ms silence carries PCR-only packets ({len(pcrs)}, 35 ms apart wanted)",
          10 <= len(pcrs) <= 20 and only_pcr)
    iv = rt._pcr_intervals(rt.Walk(got), 0x101)
    check(f"timer: their spacing about 35 ms (max {max(iv) / 1e6 if iv else -1:.1f} ms; loaded "
          "box: 100 ms allowed)", bool(iv) and max(iv) <= 100 * MS)
    check("timer: the buffers carry no timestamp; the snapshot counts timer-pcrs",
          all(b.pts == NONE and b.dts == NONE for _k, bs in ticks for b in bs)
          and snap.get_value("timer-pcrs") >= len(pcrs))


PROPS = ["house-clock", "timeline-id", "pcr-interval-ms", "d-e-margin-ms", "d-e-headroom-ms",
         "d-e-floor-ms", "d-e-max-ms", "gap-lower-min-ms", "stats-interval-ms", "stats", "d-e-ns",
         "epoch-seq", "abi", "desync-bytes", "cc-lost", "pes-oversize", "pes-dropped-cc",
         "header-spans", "psi-unsupported-sections", "pes-no-pts", "dts-discarded"]


def case_inspect():
    print("\n--- gst-inspect-1.0 and the property contract ---")
    r = subprocess.run(["gst-inspect-1.0", f"--gst-plugin-load={_SO}", "mrtsegress"],
                       capture_output=True, text=True)
    listed = [p for p in PROPS if f"\n  {p} " in r.stdout or f"\n  {p}:" in r.stdout]
    check(f"gst-inspect-1.0 lists every property ({len(listed)}/{len(PROPS)}: missing "
          f"{sorted(set(PROPS) - set(listed))})", r.returncode == 0 and listed == PROPS)
    el = Gst.ElementFactory.make("mrtsegress", None)
    d = {p: el.find_property(p).default_value for p in
         ("pcr-interval-ms", "d-e-margin-ms", "d-e-headroom-ms", "d-e-floor-ms", "d-e-max-ms",
          "gap-lower-min-ms", "stats-interval-ms")}
    pi = el.find_property("pcr-interval-ms")
    check(f"defaults are chapter 9's ({d}), pcr-interval-ms 10-40",
          d == {"pcr-interval-ms": 35, "d-e-margin-ms": 150, "d-e-headroom-ms": 20,
                "d-e-floor-ms": 100, "d-e-max-ms": 0, "gap-lower-min-ms": 500,
                "stats-interval-ms": 2000} and pi.minimum == 10 and pi.maximum == 40)
    live = Gst.PARAM_MUTABLE_PLAYING
    check("house-clock, timeline-id and stats-interval-ms are live",
          all(el.find_property(p).flags & live for p in ("house-clock", "timeline-id",
                                                          "stats-interval-ms")))


def case_runners():
    print("\n--- both runners: loaded, and hidden with the identity stand-in ---")
    import gst_native_plugins_test as npt
    desc = "audiotestsrc is-live=true ! mrtsegress name=eg ! fakesink sync=false async=false"
    runners = [("py", npt.PY_RUNNER)]
    if os.path.exists(npt.NATIVE_RUNNER):
        runners.append(("native", [npt.NATIVE_RUNNER]))
    else:
        check(f"native runner built ({npt.NATIVE_RUNNER}; make native)", False)
    tmp = tempfile.mkdtemp(prefix="mrtsegress-runner.")
    atexit.register(shutil.rmtree, tmp, True)
    empty = os.path.join(tmp, "empty")
    os.makedirs(empty)
    for tag, argv in runners:
        r = npt._start(argv, npt._PLUGINS, empty, desc)
        try:
            started = r.wait_event(npt.ev_is("started"))
            r.send({"cmd": "get_property", "id": "g1", "element": "eg", "property": "pcr-interval-ms"})
            got = r.wait_event(npt.ev_is("property", id="g1"))
            check(f"{tag}: the runner loads mrtsegress, no timing alarm (got {got})",
                  started is not None and r.first(npt.timing_alarm) is None
                  and got is not None and got.get("value") == 35)
        finally:
            r.close()
        r = npt._start(argv, empty, empty, desc)
        try:
            check(f"{tag}: with the plugin hidden, identity stands in for mrtsegress",
                  r.log_after(npt.STAND_INS)
                  == "audiotestsrc is-live=true ! identity name=eg ! fakesink sync=false async=false")
            alarm = r.wait_event(npt.timing_alarm)
            check(f"{tag}: and the rule-6 alarm shows ({alarm and alarm.get('message')})",
                  alarm is not None and alarm.get("message", "").startswith(npt.ALARM))
        finally:
            r.close()


if __name__ == "__main__":
    only = set(sys.argv[1:])
    for name, fn in (("bytes", case_bytes), ("gap", case_gap), ("list", case_list),
                     ("merged", case_merged), ("unknown", case_unknown_clock), ("timer", case_timer),
                     ("inspect", case_inspect), ("runners", case_runners)):
        if not only or name in only:
            fn()
    if _failures:
        print(f"\n{len(_failures)} FAILED: {_failures}")
        sys.exit(1)
    print("\nALL gst_mrtsegress_element_test.py TESTS PASSED")
