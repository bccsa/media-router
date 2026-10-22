#!/usr/bin/env python3
"""Tests for mrtsrestamp (plan ch. 5 WI-P1-4), the GStreamer face of mrts::RestampCore, in the
Python runner's interpreter, driving the element over its pads, appsrc and appsink (a harness,
not a twin; chapter 3 part 4.5 rule 1):

  - its bytes, gap markers, events and stats equal RestampCore's for the same input
    (mrtshouse/tests/restamp_ref), through live O and trim edits, a drop, an outage, garbage
    and a CC loss; buffer lists likewise, a list of 7 leaving as one list;
  - a live offset-ns change gives one marker per PID: GAP|DISCONT, PTS the gap's end, the
    length in the adaptation field's private data, no duration, DTS on the input's timeline;
  - each marker comes through srt-input's queue (leaky=2 max-size-time=100 ms) after a live
    edit and after a simulated 3 s outage, every time;
  - with arrival=clock the element's task marks a real outage at detection and every 250 ms;
  - fixed mode: video with dropped frames gives no marker, a 1.2 s video hole one (B-89);
  - trace-location records the core's .stct, from the start and from a live change;
  - pid-trims parsing, the counters and the stats snapshot, a restart, a flush;
  - any chunking: packets split over buffers and over memories leave as the core makes them;
  - gst-inspect-1.0 lists every property.

Skips (exit 0) without GStreamer or the built plugin; the reference is built with make."""
import os
import struct
import subprocess
import sys
import tempfile
import time
import warnings

try:
    import gi

    gi.require_version("Gst", "1.0")
    from gi.repository import GObject, Gst
except (ImportError, ValueError) as exc:  # pragma: no cover - environment gate
    print(f"SKIP gst_mrtsrestamp_element_test.py — GStreamer unavailable ({exc})")
    sys.exit(0)

Gst.init(sys.argv)
# GObject.ValueArray.get_nth is the one way to a GstValueArray here; its deprecation is noise.
warnings.filterwarnings("ignore", category=DeprecationWarning)

NONE = Gst.CLOCK_TIME_NONE
GAP_FLAGS = Gst.BufferFlags.GAP | Gst.BufferFlags.DISCONT

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import ingest_restamp_fixture as fx  # noqa: E402
from ingest_restamp_fixture import (MS, S, PKT, PTS_WRAP, TICK, PID_PMT, PID_V,  # noqa: E402
                                    PID_A, PID_SILENT, TS_CAPS, PAT, PMT, Stream, gap_length,
                                    pieces_of, pmt, psi_packet, ns90k, ref_counters,
                                    ref_events, ref_stats)

# The plugin from MR_PLUGINS_DIR when set (a mutant, an install); the reference always from here.
_SO = os.path.join(os.environ.get("MR_PLUGINS_DIR") or os.path.join(fx.ROOT, "plugins"),
                   "mpegts-core", "native", "mrtshouse", "libgstmrtshouse.so")

if not os.path.exists(_SO):
    print(f"SKIP gst_mrtsrestamp_element_test.py — mrtshouse plugin not built ({_SO}); "
          "run `make native`")
    sys.exit(0)
plugin = Gst.Plugin.load_file(_SO)   # a file that is there but does not load is a failure
# The reference is built as the plugin is; a stale or missing one is rebuilt here.
_made = fx.build_reference()
if _made:
    print(f"FAIL the reference tests/restamp_ref does not build:\n{_made}")
    sys.exit(1)

_failures = []
_tmp = tempfile.mkdtemp(prefix="mrtsrestamp-test.")


def check(name, cond):
    print(("PASS " if cond else "FAIL ") + name)
    if not cond:
        _failures.append(name)


def reference(records, **kw):
    """RestampCore over `records` (restamp_ref's JSON lines)."""
    return fx.reference(records, _tmp, **kw)


def expected_items(records, ref, base=0):
    """What the element must push for `records`; a data piece has the input's DTS (none)."""
    return fx.expected_items(records, ref, base, none=NONE)


# --- harnesses ----------------------------------------------------------------------------

def sdict(st):
    return {st.nth_field_name(i): st.get_value(st.nth_field_name(i)) for i in range(st.n_fields())}


def binfo(b):
    return (b.pts, b.dts, b.duration, int(b.get_flags()), b.extract_dup(0, b.get_size()))


def as_item(info):
    pts, dts, duration, flags, data = info
    if flags & int(Gst.BufferFlags.GAP):
        return ("gap", pts, dts, data)
    return ("data", pts, dts, data)


class Harness:
    """Own src pad -> mrtsrestamp -> own sink pad, in a pipeline for its bus. A push runs the
    element's chain in this thread, and its messages reach `msgs` in posting order."""

    def __init__(self, **props):
        self.pipe = Gst.Pipeline.new(None)
        self.el = Gst.ElementFactory.make("mrtsrestamp", "restamp")
        for k, v in props.items():
            self.el.set_property(k.replace("_", "-"), v)
        self.pipe.add(self.el)
        self.src = Gst.Pad.new("h_src", Gst.PadDirection.SRC)
        self.sink = Gst.Pad.new("h_sink", Gst.PadDirection.SINK)
        self.out, self.lists, self.events, self.msgs, self.warnings = [], 0, [], [], []
        self.sink.set_chain_function_full(self._chain)
        self.sink.set_chain_list_function_full(self._chain_list)
        self.sink.set_event_function_full(self._event)
        self.src.link(self.el.get_static_pad("sink"))
        self.el.get_static_pad("src").link(self.sink)
        self.pipe.get_bus().set_sync_handler(self._on_message)
        self.src.set_active(True)
        self.sink.set_active(True)
        self.start()

    def _chain(self, pad, parent, buf):
        self.out.append(("buf", binfo(buf)))
        return Gst.FlowReturn.OK

    def _chain_list(self, pad, parent, blist):
        self.lists += 1
        self.out.append(("list", [binfo(blist.get(i)) for i in range(blist.length())]))
        return Gst.FlowReturn.OK

    def _event(self, pad, parent, event):
        self.events.append(event.type)
        return True

    def _on_message(self, bus, msg):
        if msg.type == Gst.MessageType.ELEMENT and msg.src == self.el:
            st = msg.get_structure()
            self.msgs.append((st.get_name(), sdict(st)))
        elif msg.type == Gst.MessageType.WARNING:
            self.warnings.append(msg.parse_warning()[0].message)
        return Gst.BusSyncReply.DROP

    def start(self):
        self.pipe.set_state(Gst.State.PLAYING)
        self.src.push_event(Gst.Event.new_stream_start("mrtsrestamp-test"))
        self.src.push_event(Gst.Event.new_caps(Gst.Caps.from_string(TS_CAPS)))
        seg = Gst.Segment()
        seg.init(Gst.Format.TIME)
        self.src.push_event(Gst.Event.new_segment(seg))

    def stop(self):
        self.pipe.set_state(Gst.State.NULL)

    def buffer(self, data, pts):
        b = Gst.Buffer.new_wrapped(data)
        b.pts, b.dts, b.duration = pts, NONE, NONE
        return b

    def push(self, data, pts):
        return self.src.push(self.buffer(data, pts))

    def push_list(self, members):
        bl = Gst.BufferList.new()
        for data, pts in members:
            bl.insert(-1, self.buffer(data, pts))
        return self.src.push_list(bl)

    def items(self):
        out = []
        for kind, x in self.out:
            out += [as_item(i) for i in (x if kind == "list" else [x])]
        return out

    def messages(self, name):
        return [d for n, d in self.msgs if n == name]


def drive(h, records):
    """`records` into the element as restamp_ref takes them: edits apply at the next buffer."""
    for r in records:
        if r[0] == "B":
            h.push(r[2], r[1])
        elif r[0] == "O":
            h.el.set_property("offset-ns", r[1])
        elif r[0] == "T":
            h.el.set_property("pid-trims", ";".join(f"{p}={ns}" for p, ns in sorted(r[1].items())))
        elif r[0] == "R":
            h.el.set_property("trace-location", r[1])
        elif r[0] == "F":
            h.src.push_event(Gst.Event.new_flush_start())
            h.src.push_event(Gst.Event.new_flush_stop(False))
        elif r[0] == "E":
            h.src.push_event(Gst.Event.new_eos())


def first_index(records, pred):
    return next(i for i, r in enumerate(records) if r[0] == "B" and pred(r))


# --- the main scenario ---------------------------------------------------------------------
# 20 s at 7-packet datagrams: O +500 ms at 6 s, a +200 ms trim on the audio at 9 s, O -300 ms
# at 12 s (the overlap dropped), 3 s of silence at 14 s with the PCR running on, 37 bytes of
# garbage at 18.5 s, a lost packet at 19 s, then EOS.
st = Stream(20, outage=(14 * S, 17 * S))
REC = []
_edits = [(6 * S, ("O", 500 * MS)), (9 * S, ("T", {PID_A: 200 * MS})), (12 * S, ("O", -300 * MS))]
_garbage = _lost = False
for arrival, data in st.datagrams:
    t = st.mux(arrival)
    while _edits and t >= _edits[0][0]:
        REC.append(_edits.pop(0)[1])
    if not _garbage and t >= 18_500 * MS:
        data, _garbage = data[:2 * PKT] + bytes(range(37)) + data[2 * PKT:], True
    elif not _lost and t >= 19 * S:
        data, _lost = data[:PKT] + data[2 * PKT:], True
    REC.append(("B", arrival, data))
REC.append(("E",))

print("\n--- gst-inspect-1.0 and the property contract ---")
PROPS = ["clock-mode", "arrival", "add-base-time", "offset-ns", "pid-trims", "stats-interval-ms",
         "trace-location", "stats", "abi", "desync-bytes", "cc-lost", "pes-oversize",
         "pes-dropped-cc", "header-spans", "psi-unsupported-sections", "pes-no-pts",
         "dts-discarded"]
_inspect = subprocess.run(["gst-inspect-1.0", f"--gst-plugin-load={_SO}", "mrtsrestamp"],
                          capture_output=True, text=True)
_listed = [p for p in PROPS if f"\n  {p}" in _inspect.stdout and
           (f"\n  {p} " in _inspect.stdout or f"\n  {p}:" in _inspect.stdout)]
check(f"gst-inspect-1.0 lists every property ({len(_listed)}/{len(PROPS)}: missing "
      f"{sorted(set(PROPS) - set(_listed))})", _inspect.returncode == 0 and _listed == PROPS)
check("gst-inspect-1.0 shows the enum nicks stc, fixed, clock, buffer-pts",
      all(f"): {n} " in _inspect.stdout for n in ("stc", "fixed", "clock", "buffer-pts")))
_f = Gst.ElementFactory.find("mrtsrestamp")
check("the factory table registers mrtsrestamp at rank NONE",
      _f is not None and _f.get_rank() == Gst.Rank.NONE and _f.get_plugin_name() == "mrtshouse")
_el = Gst.ElementFactory.make("mrtsrestamp", None)
_defaults = {p: _el.get_property(p) for p in ("add-base-time", "offset-ns", "pid-trims",
                                              "stats-interval-ms", "trace-location")}
check(f"defaults: stc, arrival clock, no base time, O 0, no trims, stats every 2 s, no trace "
      f"({_defaults})",
      _el.get_property("clock-mode").value_nick == "stc"
      and _el.get_property("arrival").value_nick == "clock"
      and _defaults == {"add-base-time": False, "offset-ns": 0, "pid-trims": "",
                        "stats-interval-ms": 2000, "trace-location": None})


def _flags(name):
    return _el.find_property(name).flags


_live = all(_flags(p) & Gst.PARAM_MUTABLE_PLAYING for p in
            ("offset-ns", "pid-trims", "stats-interval-ms", "trace-location"))
_at_start = all(_flags(p) & Gst.PARAM_MUTABLE_READY for p in
                ("clock-mode", "arrival", "add-base-time"))
_ro = not _flags("stats") & GObject.ParamFlags.WRITABLE
_off = _el.find_property("offset-ns")
check("offset-ns, pid-trims, stats-interval-ms and trace-location are live; clock-mode, arrival "
      "and add-base-time apply at a start; stats is read-only; O within ±10 s",
      _live and _at_start and _ro and _off.minimum == -10 * S and _off.maximum == 10 * S)
_s0 = _el.get_property("stats")
check("a fresh element's stats: its mode and arrival, no programs, no PIDs",
      _s0.get_name() == "mrtsrestamp-stats" and _s0.get_value("mode") == "stc"
      and _s0.get_value("arrival") == "clock")

print("\n--- bytes, markers, events and stats equal RestampCore's (stc, arrival=buffer-pts) ---")
REF = reference(REC, stats_ms=1000)
h = Harness(arrival="buffer-pts", stats_interval_ms=1000)
drive(h, REC)
got, want = h.items(), expected_items(REC, REF)
_first_bad = next((i for i, (a, b) in enumerate(zip(got, want)) if a != b), None)
check(f"every buffer and marker equals the core's, in order ({len(got)} out, {len(want)} expected; "
      f"first difference at {_first_bad})", got == want)
_n_gaps = sum(1 for i in want if i[0] == "gap")
_reasons = sorted({g["reason"] for line in REF if "gaps" in line for g in line["gaps"]})
check(f"... which holds markers of every kind the run makes ({_n_gaps}: {_reasons})",
      _n_gaps == 5 and _reasons == ["edit", "outage"])
_copies = sum(1 for line in REF if "in_place" in line and not line["in_place"])
check(f"... and copies where the core removed bytes ({_copies} buffers: garbage, unknown PIDs "
      "before the PMT, the dropped overlap)", _copies >= 3)
_with_gaps = sum(1 for line in REF if line.get("gaps"))
check(f"a buffer leaves as a buffer, or with its markers as one list ({h.lists} lists for "
      f"{_with_gaps} buffers with markers)",
      h.lists == _with_gaps and all(any(i[3] & int(Gst.BufferFlags.GAP) for i in x)
                                    for k, x in h.out if k == "list"))
_ev = h.messages("mrtsrestamp-event")
check(f"mrtsrestamp-event: the core's events, every field ({len(_ev)} of {len(ref_events(REF))})",
      _ev == ref_events(REF) and len(_ev) >= 8)
_kinds = sorted({e["kind"] for e in _ev})
check(f"... kinds named as part 10 ({_kinds}); the PAT's psi-change names program -1",
      set(_kinds) <= {"relock", "degraded", "recovered", "gap", "overlap", "lead-clamp",
                      "envelope-step", "psi-change"}
      and any(e["kind"] == "psi-change" and e["program"] == -1 and e["reason"] == "pat"
              for e in _ev))
_stats = h.messages("mrtsrestamp-stats")
_pids = h.messages("mrtsrestamp-pid")
_want_stats = ref_stats(REF)
_wp = [p for progs, _ in _want_stats for p in progs]
_d = next((i for i, (x, y) in enumerate(zip(_stats, _wp)) if x != y), None)
if _d is not None or len(_stats) != len(_wp):
    print("DEBUG", len(_stats), len(_wp), _d)
    if _d is not None:
        print("DEBUG el ", _stats[_d])
        print("DEBUG ref", _wp[_d])
check(f"mrtsrestamp-stats: one per program per interval, the core's numbers ({len(_stats)} posts)",
      _stats == _wp and len(_stats) >= 17)
check(f"mrtsrestamp-pid: one per PID per interval, the core's numbers ({len(_pids)} posts)",
      _pids == [q for _, pids in _want_stats for q in pids] and len(_pids) == 2 * len(_stats))
_fields = {"program", "state", "reason", "ppb", "offset-drift-ns", "residual-min-ns",
           "residual-p50-ns", "residual-p99-ns", "residual-max-ns", "pcr-interval-max-ns",
           "cadence-warning", "pcr-cadence-ns", "pcr-gap-max-ns", "relocks", "gaps",
           "gap-ns-total", "dropped-pes", "dropped-ns-total", "cc-lost", "desync-bytes"}
check("every stats message carries part 10's fields, cadence-warning a bool, the element-wide "
      "counters as running totals",
      all(_fields <= set(s) and isinstance(s["cadence-warning"], bool) for s in _stats)
      and all(b["cc-lost"] >= a["cc-lost"] and b["desync-bytes"] >= a["desync-bytes"]
              for a, b in zip(_stats, _stats[1:]))
      and _stats[-1]["desync-bytes"] == 37 and _stats[-1]["cc-lost"] >= 1)
_cad = sorted({s["pcr-cadence-ns"] for s in _stats})
check(f"the PCR's own cadence (B-86) an int on every report, the source's 40 ms spacing ({_cad}); "
      f"no late interval (the outage's crossings are skipped)",
      all(isinstance(s["pcr-cadence-ns"], int) and isinstance(s["pcr-gap-max-ns"], int) for s in _stats)
      and _cad == [40 * MS] and {s["pcr-gap-max-ns"] for s in _stats} == {0}
      and not any(s["cadence-warning"] for s in _stats))
check("state and reason are part 10's strings",
      {s["state"] for s in _stats} <= {"acquiring", "locked", "degraded", "lost"}
      and {s["reason"] for s in _stats} <= {"none", "cadence", "rate", "freeze", "leap", "lead"})
_pf = {"program", "pid", "stream-type", "lead-min-ns", "lead-median-ns", "lead-max-ns", "trim-ns",
       "shift-ns", "dropped-pes"}
check("every PID message carries part 10's fields once the PID has a lead; the trim and the "
      "shift in force follow the edits",
      all(_pf <= set(q) for q in _pids if q["lead-count"])
      and _pids[-1]["pid"] == PID_A and _pids[-1]["trim-ns"] == 200 * MS
      and _pids[-1]["shift-ns"] == -100 * MS and _pids[-2]["shift-ns"] == -300 * MS)
_c = ref_counters(REF)
_props = {k: h.el.get_property(k) for k in ("desync-bytes", "cc-lost", "header-spans",
                                            "psi-unsupported-sections", "pes-no-pts",
                                            "dts-discarded")}
check(f"the counter properties are the core's totals ({_props})",
      all(_props[k] == _c[k] for k in _props) and _props["desync-bytes"] == 37
      and h.el.get_property("pes-oversize") == 0 and h.el.get_property("pes-dropped-cc") == 0)
_snap = h.el.get_property("stats")


def array_of(st, field):
    """A GstValueArray of structures as dicts, read while the array is alive."""
    ok, arr = st.get_array(field)
    return [sdict(arr.get_nth(i)) for i in range(arr.n_values)] if ok else None


_progs, _qs = array_of(_snap, "programs"), array_of(_snap, "pids")
check("the stats snapshot: the last post's programs and PIDs, the counters, what went through",
      _snap.get_value("mode") == "stc" and _snap.get_value("arrival") == "buffer-pts"
      and _snap.get_value("removed-packets") == _c["removed-packets"]
      and _snap.get_value("unknown-pid-packets") == _c["unknown-pid-packets"]
      and _snap.get_value("buffers") == sum(1 for r in REC if r[0] == "B")
      and _snap.get_value("gap-markers") == _n_gaps and _snap.get_value("outage-markers") == 0
      and _progs == _stats[-1:] and _qs == _pids[-2:])
check("EOS passes downstream", h.events and h.events[-1] == Gst.EventType.EOS)
h.stop()

print("\n--- a live offset-ns change: one marker per PID, OQ-12's form ---")
_marks = [(i, x) for i, x in enumerate(got) if x[0] == "gap"]
_edit = [(i, x) for i, x in _marks if any(g["reason"] == "edit" and g["end"] == x[1]
                                          for line in REF if "gaps" in line for g in line["gaps"])]
_first_edit = _edit[:2]
_pids_marked = sorted(((x[3][1] & 0x1F) << 8) | x[3][2] for _, x in _first_edit)
_lens = [gap_length(x[3]) for _, x in _first_edit]
check(f"O +500 ms: one marker on each PID ({_pids_marked}), each one adaptation-only packet "
      f"with 500 ms in its private data ({_lens})",
      _pids_marked == [PID_V, PID_A] and all(len(x[3]) == PKT for _, x in _first_edit)
      and all(abs(n - 500 * MS) <= TICK for n in _lens))
_ok_pts = True
for i, x in _first_edit:
    nxt = next(y for y in got[i + 1:] if y[0] == "data")
    # Ahead of the arrival by the source lead and the edit: the gap's end on house time.
    _ok_pts &= x[2] == nxt[1] and 800 * MS < x[1] - nxt[1] < 1300 * MS
check("... PTS the gap's end (the lead and the edit past the arrival), DTS the arrival of the "
      "data it precedes", _ok_pts)
_raw = [i for kind, x in h.out for i in (x if kind == "list" else [x])
        if i[3] & int(Gst.BufferFlags.GAP)]
check("... GAP|DISCONT, no duration",
      _raw and all(i[3] & int(GAP_FLAGS) == int(GAP_FLAGS) and i[2] == NONE for i in _raw))

print("\n--- a list of buffers leaves as one list ---")
# The same input in lists of 7; an edit applies at a list's first buffer, so it moves before
# the next list, for the reference too.
PLAN, _pending, _group = [], [], []
for r in REC:
    if r[0] in "OT":
        _pending.append(r)
    elif r[0] == "B":
        if not _group:
            PLAN += [("edit", e) for e in _pending]
            _pending = []
        _group.append(r)
        if len(_group) == 7:
            PLAN.append(("list", _group))
            _group = []
if _group:
    PLAN.append(("list", _group))
_lst_rec = [x for kind, v in PLAN for x in ([v] if kind == "edit" else v)] + [("E",)]
REF_L = reference(_lst_rec, stats_ms=1000)
hl = Harness(arrival="buffer-pts", stats_interval_ms=1000)
for kind, v in PLAN:
    if kind == "edit":
        drive(hl, [v])
    else:
        hl.push_list([(r[2], r[1]) for r in v])
hl.src.push_event(Gst.Event.new_eos())
_n_lists = sum(1 for kind, _ in PLAN if kind == "list")
check(f"each list leaves as one list ({hl.lists} out of {_n_lists} in), no single buffer",
      hl.lists == _n_lists and all(k == "list" for k, _ in hl.out))
check("... holding the core's bytes and markers, member by member",
      hl.items() == expected_items(_lst_rec, REF_L))
check("... and the same events", hl.messages("mrtsrestamp-event") == ref_events(REF_L))
_sizes = [len(x) for k, x in hl.out]
check(f"a list of 7 with nothing to mark or remove leaves as 7 ({_sizes.count(7)} of "
      f"{len(_sizes)})", _sizes.count(7) >= len(_sizes) - 12)
hl.stop()

print("\n--- a flagged PCR jump: the relock event, as the core's ---")
# The PMT lists a teletext PID that never carries a PES: its messages have no lead.
_sj = Stream(6, jump=(3 * S, 10 * S), pmt_sec=pmt([(0x06, PID_SILENT)]))
_rj = [("B", a, d) for a, d in _sj.datagrams] + [("E",)]
_refj = reference(_rj, stats_ms=500)
hj = Harness(arrival="buffer-pts", stats_interval_ms=500)
drive(hj, _rj)
_evj = hj.messages("mrtsrestamp-event")
check("the bytes and markers are the core's across the jump",
      hj.items() == expected_items(_rj, _refj))
check(f"one relock, reason discontinuity, every field the core's "
      f"({[(e['kind'], e['reason']) for e in _evj if e['kind'] == 'relock']})",
      _evj == ref_events(_refj)
      and [e["reason"] for e in _evj if e["kind"] == "relock"] == ["discontinuity"])
check("... and the stats messages the core's",
      hj.messages("mrtsrestamp-stats") == [p for ps, _ in ref_stats(_refj) for p in ps])
_silent = [q for q in hj.messages("mrtsrestamp-pid") if q["pid"] == PID_SILENT]
check(f"a PID with no PES yet: lead-count 0 and no lead fields ({len(_silent)} messages), as the "
      "core's", _silent and all(q["lead-count"] == 0 and "lead-median-ns" not in q for q in _silent)
      and hj.messages("mrtsrestamp-pid") == [q for _, qs in ref_stats(_refj) for q in qs])
hj.stop()

print("\n--- srt-input's queue (leaky=2 max-size-time=100 ms): every marker gets through ---")


def leaky_run(records, ref):
    """appsrc ! mrtsrestamp arrival=buffer-pts ! queue leaky=2 max-size-time=100000000 ! appsink,
    one input buffer at a time once the queue has passed on the last one's output: whatever the
    queue drops, it drops for a marker's sake (the data of one buffer shares one timestamp)."""
    pipe = Gst.parse_launch(
        f'appsrc name=src format=time caps="{TS_CAPS}" ! mrtsrestamp name=restamp '
        "arrival=buffer-pts ! queue leaky=2 max-size-time=100000000 ! "
        "appsink name=sink sync=false async=false max-buffers=1 drop=true")
    seen = []

    def on_data(_pad, info):
        if info.type & Gst.PadProbeType.BUFFER_LIST:
            bl = info.get_buffer_list()
            seen.extend(binfo(bl.get(i)) for i in range(bl.length()))
        else:
            seen.append(binfo(info.get_buffer()))
        return Gst.PadProbeReturn.OK

    pipe.get_by_name("sink").get_static_pad("sink").add_probe(
        Gst.PadProbeType.BUFFER | Gst.PadProbeType.BUFFER_LIST, on_data)
    pipe.set_state(Gst.State.PLAYING)
    src, el = pipe.get_by_name("src"), pipe.get_by_name("restamp")
    lines, n_want, lost = iter(ref), 0, 0
    for r in records:
        if r[0] == "O":
            el.set_property("offset-ns", r[1])
            continue
        if r[0] != "B":
            continue
        line = next(lines)
        n_want += (len(line["gaps"]) + sum(1 for x in pieces_of(line) if x))
        b = Gst.Buffer.new_wrapped(r[2])
        b.pts = r[1]
        src.emit("push-buffer", b)
        deadline = time.monotonic() + 1.0
        while len(seen) < n_want and time.monotonic() < deadline:
            time.sleep(0.0002)
        lost += len(seen) < n_want
        n_want = len(seen)  # the next buffer waits for its own output only
    src.emit("end-of-stream")
    pipe.get_state(Gst.CLOCK_TIME_NONE)
    pipe.set_state(Gst.State.NULL)
    return [as_item(i) for i in seen], lost


_se = Stream(4)
_rec_edit = []
for a, d in _se.datagrams:
    if not any(r[0] == "O" for r in _rec_edit) and _se.mux(a) >= 3 * S:
        _rec_edit.append(("O", 500 * MS))
    _rec_edit.append(("B", a, d))
_so = Stream(6, outage=(2 * S, 5 * S))
_rec_out = [("B", a, d) for a, d in _so.datagrams]
for label, rec in (("after a live edit (O +500 ms)", _rec_edit),
                   ("after a simulated 3 s outage", _rec_out)):
    ref = reference(rec + [("E",)])
    want = expected_items(rec + [("E",)], ref)
    marks = [x for x in want if x[0] == "gap"]
    runs, ok_runs, lost_runs = 10, 0, 0
    for _ in range(runs):
        got_q, lost = leaky_run(rec, ref)
        ok_runs += got_q == want
        lost_runs += lost > 0
    check(f"{label}: all {len(marks)} markers, and every byte, delivered in {ok_runs} of {runs} "
          f"runs ({lost_runs} runs lost something)", ok_runs == runs and len(marks) == 2)

print("\n--- arrival=clock: the task marks a real outage at detection and every 250 ms ---")
# A live pipeline on the contract clock (CLOCK_MONOTONIC, base time 0): 1.5 s sent in real
# time, 5.5 s of silence, 0.5 s more, then EOS. The buffers' PTS run 120 ms behind the clock,
# as srtsrc's send time does, so only the clock gives the arrival the checks expect.
_sl = Stream(7.5, h0=0, outage=(1500 * MS, 7000 * MS))
_live = Gst.parse_launch(
    f'appsrc name=src is-live=true format=time caps="{TS_CAPS}" ! '
    "mrtsrestamp name=restamp stats-interval-ms=500 ! "
    # wait-on-eos off: appsink would hold the EOS, and with it the stream lock the task tries.
    "appsink name=sink sync=false async=false max-buffers=1 drop=true wait-on-eos=false")
_clock = Gst.SystemClock.obtain()
_live.use_clock(_clock)
_live.set_start_time(NONE)
_live.set_base_time(0)
_seen = []   # (from a list, info)
_lmsgs = []


def _on_live(_pad, info):
    if info.type & Gst.PadProbeType.BUFFER_LIST:
        bl = info.get_buffer_list()
        _seen.extend((True, binfo(bl.get(i))) for i in range(bl.length()))
    else:
        _seen.append((False, binfo(info.get_buffer())))
    return Gst.PadProbeReturn.OK


def _on_live_msg(_bus, msg):
    if msg.type == Gst.MessageType.ELEMENT and msg.src.get_name() == "restamp":
        st = msg.get_structure()
        _lmsgs.append((_clock.get_time(), st.get_name(), sdict(st)))
    return Gst.BusSyncReply.DROP


_live.get_by_name("sink").get_static_pad("sink").add_probe(
    Gst.PadProbeType.BUFFER | Gst.PadProbeType.BUFFER_LIST, _on_live)
_live.get_bus().set_sync_handler(_on_live_msg)
_live.set_state(Gst.State.PLAYING)
_lsrc, _lel = _live.get_by_name("src"), _live.get_by_name("restamp")
_t0 = _clock.get_time() + 50 * MS
_pushed = []   # (clock time just before the push, n seen before it)
for arrival, data in _sl.datagrams:
    while _clock.get_time() < _t0 + arrival - 20 * MS:
        time.sleep(0.0005)
    _now = _clock.get_time()
    _pushed.append((_now, len(_seen)))
    # srtsrc's PTS is the send time (OQ-19): 120 ms behind; the arrival is the clock.
    _b = Gst.Buffer.new_wrapped(data)
    _b.pts = _now - 120 * MS
    _lsrc.emit("push-buffer", _b)
_lsrc.emit("end-of-stream")
_eos_at = _clock.get_time()
_n_at_eos = len(_seen)
time.sleep(1.5)
_live.set_state(Gst.State.NULL)
_snap_l = _lel.get_property("stats")

_resume = next((i for i, (t, _) in enumerate(_pushed) if i and t - _pushed[i - 1][0] > 4 * S), 1)
_last_t, _n_before = _pushed[_resume - 1]
_resume_t, _n_resume = _pushed[_resume]
# The task pushes its markers alone; a marker in the stream leaves in its buffer's list.
_task = [i for in_list, i in _seen[_n_before:_n_resume]
         if not in_list and i[3] & int(Gst.BufferFlags.GAP)]
_first_task = next((k for k, (in_list, i) in enumerate(_seen)
                    if not in_list and i[3] & int(Gst.BufferFlags.GAP)), _n_resume)
_data_before = [i for _, i in _seen[:_first_task] if not i[3] & int(Gst.BufferFlags.GAP)]
_pts = [m[0] for m in _task] or [0]
_spacing = [b - a for a, b in zip(_pts, _pts[1:])] or [0]
check(f"{len(_task)} task markers in a 5.5 s silence: at 1 s, then every 250 ms",
      17 <= len(_task) <= 19)
check(f"... the first 1 s after the last arrival ({(_pts[0] - _last_t) / MS:.1f} ms)",
      _task and S <= _pts[0] - _last_t <= S + 200 * MS)
check(f"... then 250 ms apart (min {min(_spacing) / MS:.1f}, max {max(_spacing) / MS:.1f} ms)",
      len(_task) > 1 and min(_spacing) >= 249 * MS and max(_spacing) <= 400 * MS
      and sorted(_spacing)[len(_spacing) // 2] <= 260 * MS)


def _starts(m):
    """Per PID in the marker: PTS - its length, where its gap starts."""
    data, out = m[4], {}
    for k in range(0, len(data), PKT):
        pkt = data[k:k + PKT]
        out[((pkt[1] & 0x1F) << 8) | pkt[2]] = m[0] - gap_length(pkt)
    return out


_st = [_starts(m) for m in _task]
check("... each one packet per PID in PMT order, GAP|DISCONT, no duration, the DTS of the last "
      "input buffer",
      all(len(m[4]) == 2 * PKT and m[4][1:3] == bytes([0x01, 0x00])
          and m[4][PKT + 1:PKT + 3] == bytes([0x01, 0x01])
          and m[3] & int(GAP_FLAGS) == int(GAP_FLAGS) and m[2] == NONE
          and _data_before and m[1] == _data_before[-1][0] for m in _task) and _task)
_st0 = _st[0] if _st else {}
check(f"... the length grows with now: every marker says the same start per PID ({_st0})",
      _st and all(x == _st0 for x in _st) and set(_st0) == {PID_V, PID_A}
      and all(_last_t < v < _last_t + 1200 * MS for v in _st0.values()))
_resumed = [i for in_list, i in _seen[_n_resume:] if in_list and i[3] & int(Gst.BufferFlags.GAP)]
_rs = {}
for m in _resumed:
    for pid, start in _starts(m).items():
        _rs.setdefault(pid, start)
check(f"on resume each PID's gap is marked before its first PES, from the same start ({_rs})",
      _rs and _rs == _st0)
_ls = [(t, d) for t, n, d in _lmsgs if n == "mrtsrestamp-stats" and _last_t < t < _resume_t]
check(f"the task keeps the stats cadence in the silence ({len(_ls)} posts), the clock lost after "
      f"5 s ({[d['state'] for _, d in _ls][-3:]})",
      len(_ls) >= 9 and _ls[-1][1]["state"] == "lost" and _ls[0][1]["state"] != "lost")
# After EOS the input is done, not silent: no marker is made (nor could one leave an EOS pad)
# and the task posts nothing; the snapshot is the EOS post's.
_after = [n for t, n, _ in _lmsgs if t > _eos_at + 100 * MS]
check(f"after EOS the task neither marks nor posts ({len(_after)} posts in the 1.5 s after it)",
      not _after and not [i for _, i in _seen[_n_at_eos:] if i[3] & int(Gst.BufferFlags.GAP)])
check("the snapshot counts the task's markers",
      _snap_l.get_value("outage-markers") == len(_task)
      and _snap_l.get_value("gap-markers") == len(_task) + len(_resumed))

print("\n--- trace-location: the core's .stct, from the start and from a live change ---")
_te, _tr = os.path.join(_tmp, "el.stct"), os.path.join(_tmp, "ref.stct")
ht = Harness(arrival="buffer-pts", trace_location=_te)
drive(ht, REC)
with open(_te, "rb") as fh:   # complete at EOS, still PLAYING
    _tb = fh.read()
ht.stop()
reference([("R", _tr)] + REC)
with open(_tr, "rb") as fh:
    _rb = fh.read()
_count = struct.unpack("<Q", _tb[8:16])[0] if len(_tb) >= 16 else -1
check(f"from the start: byte for byte the core's trace ({len(_tb)} bytes)", _tb == _rb and _tb)
check(f"... a valid .stct at EOS, before any stop: STCT, version 1, the count patched "
      f"({_count} records)",
      _tb[:4] == b"STCT" and struct.unpack("<I", _tb[4:8])[0] == 1
      and _count == (len(_tb) - 16) // 24 and _count > 1000 and (len(_tb) - 16) % 24 == 0)
_kinds = {}
for k in range(16, len(_tb) - 23, 24):   # whole records only
    _kinds[_tb[k + 18]] = _kinds.get(_tb[k + 18], 0) + 1
check(f"... PCR, PES, PSI and the OUTAGE of the silence recorded ({_kinds})",
      _kinds.get(1, 0) > 400 and _kinds.get(2, 0) > 900 and _kinds.get(3, 0) >= 3
      and _kinds.get(4, 0) == 1)
_te2, _tr2 = os.path.join(_tmp, "el2.stct"), os.path.join(_tmp, "ref2.stct")
_at = first_index(REC, lambda r: st.mux(r[1]) >= 10 * S)
_rec2 = REC[:_at] + [("R", _te2)] + REC[_at:]
ht2 = Harness(arrival="buffer-pts")
drive(ht2, _rec2)
ht2.stop()
reference(REC[:_at] + [("R", _tr2)] + REC[_at:])
with open(_te2, "rb") as fh:
    _tb2 = fh.read()
with open(_tr2, "rb") as fh:
    _rb2 = fh.read()
check(f"set live at 10 s: the core's trace from there, the tables in force first "
      f"({len(_tb2)} bytes)", _tb2 == _rb2 and len(_tb2) > 40 and _tb2[16 + 18] == 3)

print("\n--- pid-trims: parsed, clamped, bad entries skipped with a warning ---")
hp = Harness(arrival="buffer-pts", stats_interval_ms=500)
_trims = " 0x101 = 150000000 ;256=-5000000000;bogus;300=abc;9000=5;; "
hp.el.set_property("pid-trims", _trims)
check("the property reads back as set", hp.el.get_property("pid-trims") == _trims)
check(f"one warning names the skipped entries ({hp.warnings})",
      len(hp.warnings) == 1 and "bogus; 300=abc; 9000=5" in hp.warnings[0])
_sp = Stream(3)
for a, d in _sp.datagrams:
    hp.push(d, a)
_q = {q["pid"]: q for q in hp.messages("mrtsrestamp-pid")[-2:]}
check(f"0x101 trimmed 150 ms; 256 clamped to -2 s ({ {p: q['trim-ns'] for p, q in _q.items()} })",
      _q[PID_A]["trim-ns"] == 150 * MS and _q[PID_V]["trim-ns"] == -2 * S
      and _q[PID_V]["shift-ns"] == -2 * S)
hp.el.set_property("pid-trims", "")
_s2 = Stream(2, h0=104 * S, sigma0=7204 * S)
for a, d in _s2.datagrams:
    hp.push(d, a)
_q = {q["pid"]: q for q in hp.messages("mrtsrestamp-pid")[-2:]}
check("an empty string clears them",
      all(q["trim-ns"] == 0 and q["shift-ns"] == 0 for q in _q.values()))
hp.stop()

print("\n--- fixed mode with add-base-time: PES and PCR move by the base, markers on the bus "
      "convention ---")
hf = Harness(clock_mode="fixed", add_base_time=True, arrival="buffer-pts")
_base = hf.el.get_base_time()
_sf = Stream(4, sigma0=100 * S + 3600 * S)   # a local mux: PES - 1 h on the arrival's timeline
_recf = []
for a, d in _sf.datagrams:
    if not _recf.count(("O", 500 * MS)) and _sf.mux(a) >= 2 * S:
        _recf.append(("O", 500 * MS))
    _recf.append(("B", a, d))
_recf.append(("E",))
_reff = reference(_recf, fixed=True, base=_base)
drive(hf, _recf)
_gf = hf.items()
_mf = [x for x in _gf if x[0] == "gap"]
check(f"bytes and markers are the core's with the base time {_base} ns", _gf == expected_items(
    _recf, _reff, base=_base) and len(_mf) == 2)


def pes_pts(data, pid):
    """The PTS of every PES header that starts in `data` on `pid`."""
    out = []
    for k in range(0, len(data) - PKT + 1, PKT):
        pkt = data[k:k + PKT]
        if ((pkt[1] & 0x1F) << 8 | pkt[2]) != pid or not pkt[1] & 0x40:
            continue
        off = 4 + (1 + pkt[4] if pkt[3] & 0x20 else 0)
        f = pkt[off + 9:off + 14]
        out.append(((f[0] >> 1) & 7) << 30 | f[1] << 22 | (f[2] >> 1) << 15 | f[3] << 7 | f[4] >> 1)
    return out


_moves = set()
_lines = iter(_reff)
for r in _recf:
    if r[0] == "O":
        break
    if r[0] == "B":
        _o = bytes.fromhex(next(_lines)["out"])
        _pi, _po = pes_pts(r[2], PID_A), pes_pts(_o, PID_A)
        if len(_pi) == len(_po):   # before the PMT the PID is unknown and its PES removed
            _moves.update((b - a) % PTS_WRAP for a, b in zip(_pi, _po))
check(f"... every PES before the edit moved by exactly the base time ({_moves})",
      _moves == {ns90k(_base)})
check("... which lands ahead of the arrival by the lead and the edit",
      all(800 * MS < m[1] - m[2] < 1300 * MS for m in _mf))
hf.stop()

print("\n--- fixed mode: a dropped video frame is no gap (B-89) ---")


def dropped_run(drops):
    """The fixed-mode element, as video-encoder runs it, over a 10 s local mux whose frames each
    lie within ±4 ms of their slot and whose frames numbered in `drops` are missing: its items,
    the core's, and its gap events."""
    hv = Harness(clock_mode="fixed", add_base_time=True, arrival="buffer-pts")
    base = hv.el.get_base_time()
    sv = Stream(10, sigma0=100 * S + 3600 * S, jitter_v=4 * MS, drop_v=drops)
    rec = [("B", a, d) for a, d in sv.datagrams] + [("E",)]
    ref = reference(rec, fixed=True, base=base)
    drive(hv, rec)
    out = (hv.items(), expected_items(rec, ref, base=base),
           [e for e in hv.messages("mrtsrestamp-event") if e["kind"] == "gap"])
    hv.stop()
    return out


# B-21's rule alone marked every 2- and 5-frame hole here.
_gd, _wd, _ed = dropped_run({50} | {100, 101} | set(range(150, 155)))
check(f"1, 2 and 5 frames missing: no GAP buffer, no gap event; the core's bytes "
      f"({len(_gd)} items)", _gd == _wd and not [x for x in _gd if x[0] == "gap"] and not _ed)
_gh, _wh, _eh = dropped_run(set(range(150, 180)))
_mh = [x for x in _gh if x[0] == "gap"]
check(f"a 1.2 s hole (30 frames): one GAP buffer, on the video PID, the hole's length "
      f"({[round(gap_length(x[3]) / MS, 3) for x in _mh]} ms), reason jump; the core's bytes",
      _gh == _wh and len(_mh) == 1 and fx.pkt_pid(_mh[0][3]) == PID_V
      and abs(gap_length(_mh[0][3]) - 1200 * MS) <= 16 * MS
      and [e["reason"] for e in _eh] == ["jump"])

print("\n--- the stats cadence starts at the first buffer ---")
hc = Harness(arrival="buffer-pts", stats_interval_ms=1000)
_psi = psi_packet(0, PAT) + psi_packet(PID_PMT, PMT)
hc.push(_psi, 100 * S)
_c0 = len(hc.messages("mrtsrestamp-stats"))
hc.push(_psi, 100 * S + 999 * MS)
_c1 = len(hc.messages("mrtsrestamp-stats"))
hc.push(_psi, 101 * S)
check(f"a program known from the first buffer: its first stats one interval later "
      f"({_c0}, {_c1}, then {len(hc.messages('mrtsrestamp-stats'))})",
      _c0 == 0 and _c1 == 0 and len(hc.messages("mrtsrestamp-stats")) == 1)
hc.stop()

print("\n--- a restart counts from 0; a flush joins nothing across it ---")
hr = Harness(arrival="buffer-pts", stats_interval_ms=500)
_sr = Stream(2)
_dg = _sr.datagrams
hr.push(_dg[0][1][:100] + bytes(5) + _dg[0][1][100:], _dg[0][0])
for a, d in _dg[1:]:
    hr.push(d, a)
hr.src.push_event(Gst.Event.new_eos())
_d1 = hr.el.get_property("desync-bytes")
hr.stop()
check(f"the totals survive a stop ({_d1})", _d1 > 0 and hr.el.get_property("desync-bytes") == _d1)
hr.msgs.clear()
hr.start()
check("a start resets every counter to 0",
      all(hr.el.get_property(c) == 0 for c in ("desync-bytes", "cc-lost", "header-spans")))
for a, d in _dg:
    hr.push(d, a)
_ev_r = hr.messages("mrtsrestamp-event")
check(f"... and builds a fresh core: the PAT is news again ({_ev_r[:1]})",
      _ev_r and _ev_r[0]["kind"] == "psi-change" and _ev_r[0]["program"] == -1
      and _ev_r[0]["reason"] == "pat")
hr.src.push_event(Gst.Event.new_eos())
check("... counting afresh", hr.el.get_property("desync-bytes") == 0)
hr.stop()

_recx = [("B", a, d) for a, d in Stream(3).datagrams]
_cut = 40
_half = _recx[_cut][2][:PKT * 3 + 94]
_recx = _recx[:_cut] + [("B", _recx[_cut][1], _half), ("F",)] + _recx[_cut + 1:] + [("E",)]
_refx = reference(_recx)
hx = Harness(arrival="buffer-pts")
for r in _recx:
    if r[0] == "F":
        hx.src.push_event(Gst.Event.new_flush_start())
        hx.src.push_event(Gst.Event.new_flush_stop(False))
        seg = Gst.Segment()
        seg.init(Gst.Format.TIME)
        hx.src.push_event(Gst.Event.new_segment(seg))
    else:
        drive(hx, [r])
_cx = ref_counters(_refx)
check(f"a flush: the carried half packet is dropped, as the core does "
      f"(desync {_cx['desync-bytes']})",
      hx.items() == expected_items(_recx, _refx) and _cx["desync-bytes"] == 0
      and hx.el.get_property("desync-bytes") == 0)
check("flush-start, flush-stop and EOS pass downstream",
      Gst.EventType.FLUSH_START in hx.events and Gst.EventType.FLUSH_STOP in hx.events
      and hx.events[-1] == Gst.EventType.EOS)
hx.stop()

print("\n--- any chunking: packets split over buffers and over memories, as the core's ---")
# The walk WI-S0-7's probe pinned: 1000-byte buffers, every third of two memories split
# mid-packet, each arriving with the datagram that holds its last byte.
_sc = Stream(3)
_flat = b"".join(d for _, d in _sc.datagrams)
_ends, _off = [], 0
for a, d in _sc.datagrams:
    _off += len(d)
    _ends.append((_off, a))
_recc, _pos, _k = [], 0, 0
while _pos < len(_flat):
    _end = min(_pos + 1000, len(_flat))
    while _ends[_k][0] < _end:
        _k += 1
    _recc.append(("B", _ends[_k][1], _flat[_pos:_end]))
    _pos = _end
_recc.append(("E",))
_refc = reference(_recc)
hk = Harness(arrival="buffer-pts")
_split = 0
for n, r in enumerate(_recc[:-1]):
    if n % 3 == 1:
        b = Gst.Buffer.new_wrapped(r[2][:333]).append(Gst.Buffer.new_wrapped(r[2][333:]))
        b.pts, b.dts, b.duration = r[1], NONE, NONE
        _split += b.n_memory() == 2
        hk.src.push(b)
    else:
        hk.push(r[2], r[1])
hk.src.push_event(Gst.Event.new_eos())
_cc = ref_counters(_refc)
check(f"{len(_recc) - 1} buffers ({_split} of two memories): the core's bytes, no desync, no CC "
      "loss", hk.items() == expected_items(_recc, _refc) and _split > 30
      and _cc["desync-bytes"] == 0 and _cc["cc-lost"] == 0
      and hk.el.get_property("desync-bytes") == 0 and hk.el.get_property("cc-lost") == 0)
hk.stop()

for _f in os.listdir(_tmp):
    os.remove(os.path.join(_tmp, _f))
os.rmdir(_tmp)
if _failures:
    print(f"\n{len(_failures)} FAILURE(S) in gst_mrtsrestamp_element_test.py")
    sys.exit(1)
print("\nALL gst_mrtsrestamp_element_test.py TESTS PASSED")
