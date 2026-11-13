#!/usr/bin/env python3
"""The Python reference of mrts::TrustGate and RestampCore's Trust mapping (plan ch. 9 part 4.8,
WI-P5-6 + WI-P5-7; Phase 5 p5-6a, register B-225). Built first here (OQ-1); p5-6b ports it to
../native/mrts/ts_trust.{h,cpp} with parity through `mrts_cli trust-replay`. A reference only:
nothing loads it at runtime. trust_ref_test.py is its suite.

The boundary (S35): the gate (conditions, hysteresis, median, states, decisions, the `converging`
schedule of k) and the Trust mapping arithmetic, over an event list. The STC mapping is an input
(each PES's `stc`, the bus PTS the restamp's STC states gave it, without O and trims); guard drops,
CC, gap markers, B-203 and the deciding hold's bytes are the C++ restamp's (p5-6b).

Times are ns (arrival = the receiver's house time, MONOTONIC based); PTS, PCR base, transit and k
are 90 kHz ticks with the 33-bit fold, floor arithmetic as ts_house.h, so the C++ agrees exactly.

Transit per PCR: a = ns_to_pts90k(arrival + E_rx), p = PCR / 300, transit = fold33(a - (p + D_e));
lo = -(20 ms + 2^class us + local error) (an unknown class or local error: 50 ms each), hi = L + tau.
Qualified while (1) the PMT in force carries MRHT with house_time_tai, seen within 1 s (a natural
gap restarts that age; a silence between inputs counts 40 ms of it at most), (2) the sender and
this box are disciplined with a known E, (3) a PCR was judged and fewer than 3 in a row fell
outside [lo, hi]. `failed` names the first failing one:
no-descriptor, not-house-time, sender-undisciplined, local-undisciplined, transit-high,
transit-negative, no-pcr (none judged yet).

States: restamp (STC + O + trims), deciding (held; the fifth good PCR qualified -> trust, three bad,
a 5th good unqualified or 1 s -> fallback), qualifying (operator's Trust mid-stream; 2 s qualified,
then the next natural gap or 30 s -> switch), trust, converging, fallback (10 s qualified ->
returning), returning (the next natural gap or 30 s -> switch). No O and no trims in any state
while Trust is selected (Q13, C-10). A fallback is at once; an operator's Restamp from trust or
converging waits for a natural gap up to 30 s.

A switch into Trust never drops (Q1 (b), pending the owner): k = the last emitted PES's bus value
- its Trust value (the transit + the sender's D_e), less a natural gap taken there; k > 0 ->
converging, the program mapped f(x) = net_to_bus(x) + k(x), k(x) = clamp(k - fold33(x - x0) / 200,
0, k) on the PES's own PTS/DTS x (5 ms per second of content, 0.5 %), x0 the last emitted PTS: one
function per program, so A/V stays intact and order holds. The first PES whose k is 0 ends it
(-> trust). A natural gap g takes min(k, g) off k. A receiver re-epoch is a switch to Trust with
the new constant (converging when k > 0, a gap otherwise); a sender re-epoch passes through.

Run as a script it replays an event list: trust_gate.py events.jsonl|- [--pes]. One JSON object per
line, `t` in ns on every line but config: trace2jsonl's psi, decl, pcr, pes (optional "stc") and
outage lines (a natural gap of silenceNs for every program), and {"kind":"config", camelCase
TrustConfig fields}, {"kind":"mode","mode":"restamp"|"trust"}, {"kind":"l","ns"}, {"kind":"tau",
"ns"}, {"kind":"clock","eNs","seq","disciplined","errorUs" (null: unknown)}, {"kind":"offset","ns"},
{"kind":"trim","pid","ns"}, {"kind":"natural-gap","gapNs"[,"program"]}. After every event each
program's gate steps at its t; the input lines (psi, decl, decl2, pcr, pes, outage) come first to
every gate's on_input. No event steps the gates in a silence alone (no tick: the restamp's gates
step on input only). It prints each transition, with --pes each PES's mapping, and a summary per
program (keys in the orders of the functions below).
"""
import json
import sys
import zlib

MS = 1000000
SEC = 1000000000
PTS_WRAP = 1 << 33
MUX_CLOCK_BASE_90K = 3600 * 90000

NEG_BASE_NS = 20 * MS
UNKNOWN_TERM_NS = 50 * MS             # an unknown class or local error widens lo by this (p5-9)
CLASS_MAX = 31                        # hcdesc::ERROR_CLASS_MAX; larger ones read as this
BAD_PCRS = 3
DECIDE_PCRS = 5
DECIDE_MAX_NS = SEC                   # OQ-39; the 4 MB bound is the C++ hold's
QUALIFY_NS = 2 * SEC
RETURN_QUALIFIED_NS = 10 * SEC
RETURN_GAP_WAIT_NS = 30 * SEC         # OQ-35
PMT_STALE_NS = SEC
SILENCE_NS = 40 * MS                  # ts_house.h's PCR_MAX_INTERVAL_NS: a silence's most PMT age
RING = 64
CONVERGE_DIV = 200                    # k falls 1 tick per 200 of content: 5 ms/s, 0.5 % (p4-18)
TAU_DEFAULT_NS = 200 * MS             # trustToleranceMs (Q12)

INPUTS = ("psi", "decl", "decl2", "pcr", "pes", "outage")   # what a buffer brings
MAPPED = ("trust", "converging")      # states whose PES take the Trust mapping
STC = ("restamp", "qualifying", "fallback", "returning")


def ns_to_pts90k(ns):
    return ns * 9 // 100000


def pts90k_to_ns(t):
    return t * 100000 // 9


def fold33(d):
    r = d % PTS_WRAP
    return r - PTS_WRAP if r > PTS_WRAP // 2 else r


def net_to_bus(pts, e_ns):
    return (pts - ns_to_pts90k(e_ns) + MUX_CLOCK_BASE_90K) % PTS_WRAP


class Config:
    def __init__(self):
        self.neg_base_ns = NEG_BASE_NS
        self.bad_pcrs = BAD_PCRS
        self.decide_pcrs = DECIDE_PCRS
        self.decide_max_ns = DECIDE_MAX_NS
        self.qualify_ns = QUALIFY_NS
        self.return_qualified_ns = RETURN_QUALIFIED_NS
        self.return_gap_wait_ns = RETURN_GAP_WAIT_NS
        self.pmt_stale_ns = PMT_STALE_NS


class Clock:
    """The local house-clock: E (0 = unknown), its seq, disciplined, error in us (None unknown)."""

    def __init__(self, e_ns=0, seq=0, disciplined=False, error_us=None):
        self.e_ns, self.seq, self.disciplined, self.error_us = e_ns, seq, disciplined, error_us


class TrustGate:
    """One program's gate and mapping. Handlers log transitions in `self.log`; on_pes returns the
    PES rows it emits (a held PES comes out at the release)."""

    def __init__(self, program, cfg, clock, trust_selected, l_ns, tau_ns, now):
        self.program, self.cfg, self.clock = program, cfg, clock
        self.l_ns, self.tau_ns = l_ns, tau_ns
        self.offset_ns, self.trims = 0, {}
        self.trust_selected = trust_selected
        self.state = "deciding" if trust_selected else "restamp"
        self.since = now
        self.decl, self.pmt_at, self.last_input = None, None, None
        self.ring = []
        self.bad_run, self.bad_side, self.judged, self.good = 0, None, False, 0
        self.qual_since, self.ready_at, self.restamp_pending = None, None, None
        self.gap = None                   # a natural gap this step (ns), consumed by step()
        self.k0, self.x0 = 0, 0
        self.last_pts, self.last_out = None, None
        self.held, self.log, self.released = [], [], []
        self.switches = 0
        self.counts = {"stc": 0, "restamp": 0, "trust": 0, "converging": 0}
        self.crc = 0

    # --- the conditions ---------------------------------------------------------------------
    def bounds(self):
        d = self.decl
        cls = d["clockErrorClass"] if d else 255
        sender = UNKNOWN_TERM_NS if cls == 255 else (1 << min(cls, CLASS_MAX)) * 1000
        err = self.clock.error_us
        local = UNKNOWN_TERM_NS if err is None else err * 1000
        return -ns_to_pts90k(self.cfg.neg_base_ns + sender + local), ns_to_pts90k(self.l_ns + self.tau_ns)

    def silence(self, now):
        """What the PMT's age is not charged for: a silence since the last input (or the PMT) past 40 ms."""
        if self.last_input is None or self.pmt_at is None:
            return 0
        return max(0, now - max(self.last_input, self.pmt_at) - SILENCE_NS)

    def failed(self, now):
        d = self.decl
        if d is None or self.pmt_at is None or now - self.pmt_at - self.silence(now) > self.cfg.pmt_stale_ns:
            return "no-descriptor"
        if not d["houseTimeTai"]:
            return "not-house-time"
        if not d["disciplined"]:
            return "sender-undisciplined"
        if not self.clock.disciplined or self.clock.e_ns == 0:
            return "local-undisciplined"
        if self.bad_run >= self.cfg.bad_pcrs:
            return self.bad_side
        if not self.judged:
            return "no-pcr"
        return None

    def transit(self, pcr27, arrival):
        a = ns_to_pts90k(arrival + self.clock.e_ns)
        return fold33(a - (pcr27 // 300 + self.decl["de90k"]))

    # --- inputs -----------------------------------------------------------------------------
    def on_input(self, now):
        """Something arrived (a buffer): the silence before it moves the PMT's time on (B-226)."""
        if self.pmt_at is not None:
            self.pmt_at += self.silence(now)
        self.last_input = now

    def on_pmt(self, decl, now):
        self.decl = decl if decl and decl.get("present") else None
        self.pmt_at = now

    def on_pcr(self, pcr27, now):
        d = self.decl
        if d is None or not d["houseTimeTai"] or self.clock.e_ns == 0:
            return
        tr = self.transit(pcr27, now)
        self.ring.append(tr)
        del self.ring[:-RING]
        lo, hi = self.bounds()
        self.judged = True
        if lo <= tr <= hi:
            self.bad_run = 0
            self.good += 1
        else:
            self.bad_run += 1
            self.bad_side = "transit-high" if tr > hi else "transit-negative"

    def on_natural_gap(self, gap_ns, now):
        self.gap = gap_ns if self.gap is None else max(self.gap, gap_ns)
        if self.pmt_at is not None:
            self.pmt_at = max(self.pmt_at, now)

    def set_mode(self, trust, now):
        self.trust_selected = trust
        st = self.state
        if trust:
            self.restamp_pending = None
            if st == "restamp":
                self._go("qualifying", "none", now)
            return []
        if st == "deciding":
            return self._release("restamp", "release-restamp", now)
        if st in ("qualifying", "fallback", "returning"):
            self._go("restamp", "none", now)
        elif st in MAPPED and self.restamp_pending is None:
            self.restamp_pending = now
        return []

    def set_clock(self, clock, now):
        """A receiver re-epoch: in a Trust state, a switch to the new constant at once."""
        old = self.clock
        self.clock = clock
        if self.state in MAPPED and clock.e_ns != old.e_ns and clock.e_ns != 0 and self.last_pts is not None:
            was = self._f(self.last_pts, old.e_ns)
            self._switch_trust(fold33(was - net_to_bus(self.last_pts, clock.e_ns)), now)

    def on_pes(self, pid, pts, dmp, stc, now):
        if self.state == "deciding":
            self.held.append((pid, pts, dmp, stc, now))
            return []
        return [self._emit(pid, pts, dmp, stc, now)]

    # --- the mapping ------------------------------------------------------------------------
    def k_at(self, x):
        if self.k0 <= 0:
            return 0
        d = fold33(x - self.x0)
        return self.k0 if d <= 0 else max(0, self.k0 - d // CONVERGE_DIV)

    def _f(self, x, e_ns=None):
        e = self.clock.e_ns if e_ns is None else e_ns
        return (net_to_bus(x, e) + self.k_at(x)) % PTS_WRAP

    def _emit(self, pid, pts, dmp, stc, now):
        st = self.state
        dts = (pts + dmp) % PTS_WRAP if dmp else None
        k = 0
        if st in MAPPED:
            k = self.k_at(pts)
            out = self._f(pts)
            out_dts = self._f(dts) if dts is not None else None
            self.crc = zlib.crc32(("%d:%d:%s;" % (pid, out, out_dts)).encode(), self.crc)
        else:
            add = 0
            if st == "restamp":
                add = ns_to_pts90k(self.offset_ns + self.trims.get(pid, 0))
            out = (stc + add) % PTS_WRAP if stc is not None else None
            out_dts = (out + dmp) % PTS_WRAP if out is not None and dts is not None else None
        kind = st if st in MAPPED or st == "restamp" else "stc"
        self.counts[kind] += 1
        if out is not None:
            self.last_pts, self.last_out = pts, out
        row = {"t": now, "program": self.program, "pid": pid, "mapping": kind, "pts": out, "dts": out_dts,
               "k90k": k}
        if st == "converging" and k == 0:
            self.k0 = 0
            self._go("trust", "none", now)
        return row

    def _release(self, state, decision, now):
        self._go(state, decision, now)
        rows = [self._emit(*h) for h in self.held]
        self.held = []
        return rows

    def _switch_trust(self, k, now):
        """Into Trust with k ticks of the old timeline left (less a natural gap taken here)."""
        self.switches += 1
        self.restamp_pending = None
        if k > 0:
            self.k0, self.x0 = k, self.last_pts
            self._go("converging", "switch-to-trust", now, kNs=pts90k_to_ns(k), k90k=k)
        else:
            self.k0 = 0
            self._go("trust", "switch-to-trust", now, gapNs=pts90k_to_ns(-k))

    def _switch_restamp(self, state, now):
        self.switches += 1
        self.k0, self.restamp_pending = 0, None
        self._go(state, "switch-to-restamp", now)

    def _go(self, state, decision, now, **extra):
        line = {"t": now, "program": self.program, "decision": decision, "from": self.state, "state": state,
                "failed": self.failed(now)}
        line.update(extra)
        self.log.append(line)
        if state != self.state:
            self.state, self.since = state, now
            self.ready_at = None
            if state == "deciding":
                self.good = 0

    # --- the step ---------------------------------------------------------------------------
    def step(self, now):
        """The decision at `now` (rows of a release in self.released)."""
        self.released = []
        why = self.failed(now)
        if why is None:
            if self.qual_since is None:
                self.qual_since = now
        else:
            self.qual_since = None
        gap, self.gap = self.gap, None
        st, cfg = self.state, self.cfg
        qualified_for = now - max(self.qual_since, self.since) if self.qual_since is not None else -1
        if st == "deciding":
            if self.good >= cfg.decide_pcrs and why is None:
                self.released = self._release("trust", "release-trust", now)
                return "release-trust"
            if self.bad_run >= cfg.bad_pcrs or self.good >= cfg.decide_pcrs or now - self.since >= cfg.decide_max_ns:
                self.released = self._release("fallback", "release-restamp", now)
                return "release-restamp"
            return "hold"
        if st in MAPPED:
            if why is not None:
                self._switch_restamp("fallback" if self.trust_selected else "restamp", now)
                return "switch-to-restamp"
            if self.restamp_pending is not None and (
                    gap is not None or now - self.restamp_pending >= cfg.return_gap_wait_ns):
                self._switch_restamp("restamp", now)
                return "switch-to-restamp"
            if st == "converging" and gap is not None and self.last_pts is not None:
                k = self.k_at(self.last_pts) - ns_to_pts90k(gap)
                if k > 0:
                    self.k0, self.x0 = k, self.last_pts
                    self._go("converging", "none", now, kNs=pts90k_to_ns(k), k90k=k)
                else:
                    self.k0 = 0
                    self._go("trust", "none", now, gapNs=pts90k_to_ns(-k))
            return "none"
        if st == "fallback":
            if qualified_for >= cfg.return_qualified_ns:
                self._go("returning", "none", now)
            return "none"
        if st == "qualifying" or st == "returning":
            if st == "returning" and why is not None:
                self._go("fallback", "none", now)
                return "none"
            if st == "qualifying":
                if qualified_for < cfg.qualify_ns:
                    self.ready_at = None
                    return "none"
                if self.ready_at is None:
                    self.ready_at = now
                start = self.ready_at
            else:
                start = self.since
            if gap is not None or now - start >= cfg.return_gap_wait_ns:
                k = 0
                if self.last_pts is not None:
                    k = fold33(self.last_out - net_to_bus(self.last_pts, self.clock.e_ns))
                if gap is not None:
                    k -= ns_to_pts90k(gap)
                self._switch_trust(k, now)
                return "switch-to-trust"
        return "none"

    # --- stats ------------------------------------------------------------------------------
    def stats(self, now):
        s = sorted(self.ring)
        lo, hi = self.bounds()
        d = self.decl or {}
        return {"program": self.program, "state": self.state, "mode": "trust" if self.trust_selected else "restamp",
                "failed": self.failed(now), "switches": self.switches, "pes": dict(self.counts),
                "digest": "%08x" % self.crc,
                "transit": {"minNs": pts90k_to_ns(s[0]), "medianNs": pts90k_to_ns(s[(len(s) - 1) // 2]),
                            "maxNs": pts90k_to_ns(s[-1])} if s else None,
                "boundLoNs": pts90k_to_ns(lo), "boundHiNs": pts90k_to_ns(hi), "kNs": pts90k_to_ns(self.k0),
                "timelineId": d.get("timelineId"), "deNs": pts90k_to_ns(d["de90k"]) if d else None,
                "epochSeq": d.get("epochSeq")}


class Replay:
    """An event list through one gate per program (the PIDs from the psi lines)."""

    def __init__(self, pes_rows=False):
        self.cfg = Config()
        self.clock = Clock()
        self.trust = False
        self.l_ns, self.tau_ns, self.offset_ns, self.trims = 0, TAU_DEFAULT_NS, 0, {}
        self.gates, self.pid_program, self.pcr_pid = {}, {}, {}
        self.pes_rows = pes_rows
        self.out = []
        self.now = 0

    def gate(self, program, now):
        g = self.gates.get(program)
        if g is None:
            g = self.gates[program] = TrustGate(program, self.cfg, self.clock, self.trust, self.l_ns,
                                                self.tau_ns, now)
            g.offset_ns, g.trims = self.offset_ns, self.trims
        return g

    def feed(self, ev):
        k = ev["kind"]
        if k == "config":
            for key, v in ev.items():
                name = "".join("_" + c.lower() if c.isupper() else c for c in key)
                if key != "kind":
                    if not hasattr(self.cfg, name):
                        raise ValueError("unknown config key " + key)
                    setattr(self.cfg, name, v)
            return
        now = self.now = ev["t"]
        rows = []
        if k in INPUTS:
            for g in self.gates.values():
                g.on_input(now)
        if k == "psi":
            g = self.gate(ev["program"], now)
            if ev["pcrPid"]:
                for pid in [p for p, prog in self.pid_program.items() if prog == g.program]:
                    del self.pid_program[pid]
                self.pcr_pid[g.program] = ev["pid"]
            else:
                self.pid_program[ev["pid"]] = g.program
            g.pmt_at = now
        elif k == "decl":
            self.gate(ev["program"], now).on_pmt(ev, now)
        elif k == "pcr":
            for prog, pid in self.pcr_pid.items():
                if pid == ev["pid"]:
                    self.gates[prog].on_pcr(ev["pcr"], now)
        elif k == "pes":
            prog = self.pid_program.get(ev["pid"])
            if prog is not None:
                rows += self.gates[prog].on_pes(ev["pid"], ev["pts"], ev.get("dtsMinusPts", 0), ev.get("stc"), now)
        elif k == "outage" or k == "natural-gap":
            g_ns = ev["silenceNs"] if k == "outage" else ev["gapNs"]
            for prog, g in self.gates.items():
                if k == "outage" or ev.get("program", prog) == prog:
                    g.on_natural_gap(g_ns, now)
        elif k == "mode":
            self.trust = ev["mode"] == "trust"
            for g in self.gates.values():
                rows += g.set_mode(self.trust, now)
        elif k == "l" or k == "tau":
            if k == "l":
                self.l_ns = ev["ns"]
            else:
                self.tau_ns = ev["ns"]
            for g in self.gates.values():
                g.l_ns, g.tau_ns = self.l_ns, self.tau_ns
        elif k == "clock":
            self.clock = Clock(ev["eNs"], ev.get("seq", 0), ev["disciplined"], ev.get("errorUs"))
            for g in self.gates.values():
                g.set_clock(self.clock, now)
        elif k == "offset":
            self.offset_ns = ev["ns"]
            for g in self.gates.values():
                g.offset_ns = self.offset_ns
        elif k == "trim":
            self.trims[ev["pid"]] = ev["ns"]
        elif k != "decl2":
            raise ValueError("unknown event kind " + k)
        for g in self.gates.values():
            g.step(now)
            rows += g.released
        for g in self.gates.values():
            self.out += g.log
            g.log = []
        if self.pes_rows:
            self.out += rows

    def summary(self):
        return [self.gates[p].stats(self.now) for p in sorted(self.gates)]


def run(events, pes_rows=False):
    """Every output line of an event list: the transitions (and PES rows), then the summaries."""
    r = Replay(pes_rows)
    for ev in events:
        r.feed(ev)
    return r.out + r.summary()


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        sys.stderr.write("usage: trust_gate.py events.jsonl|- [--pes]\n")
        return 2
    f = sys.stdin if args[0] == "-" else open(args[0])
    events = [json.loads(line) for line in f if line.strip()]
    for line in run(events, "--pes" in argv):
        print(json.dumps(line, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
