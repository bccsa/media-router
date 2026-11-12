#!/usr/bin/env python3
"""egress_core.py, the egress writer's Python reference (plan ch. 9 WI-P5-2, Phase 5 plan p5-2a,
register B-221): WI-P5-2's acceptance on the recordings of the Phase 5 plan's part 2.7 and on
generated audio-only and PCR-less programmes (fixture_gen --ts egress), S22's lateness cases,
the descriptor mirror against p5-1's vectors, every tests/fixtures/egress/*.clock.json against its
.expect.jsonl, and a mutant set, each caught.

Run:  python3 egress_ref_test.py [case ...]
"""
import atexit
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import egress_core as ec  # noqa: E402
import hcdesc  # noqa: E402

hr = ec.hr
PKT = ec.PKT
MS = ec.MS
SEC = ec.SEC
FIX = os.path.normpath(os.path.join(HERE, "..", "tests", "fixtures"))
EGRESS = os.path.join(FIX, "egress")
MRTS = os.path.normpath(os.path.join(HERE, "..", "native", "mrts"))
GEN = os.path.join(MRTS, "tests", "fixture_gen")
E1 = 1760283215123456789                          # a TAI - MONOTONIC of 2026
CLOCK = {"eNs": str(E1), "seq": 3, "known": True, "traceable": True, "disciplined": True,
         "source": 1, "taiOffsetS": 37, "errorUs": 1200}
_TMP = None
_GEN = {}


def fixture(name):
    with open(os.path.join(FIX, name), "rb") as f:
        return f.read()


def gen(*args):
    """fixture_gen --ts egress with these knobs, built here as `make` builds it."""
    if args in _GEN:
        return _GEN[args]
    global _TMP
    if _TMP is None:
        _TMP = tempfile.mkdtemp(prefix="egress-ref-")
        atexit.register(shutil.rmtree, _TMP, True)
    if not os.path.exists(GEN):
        subprocess.run(["make", "-s", "-C", MRTS, "tests/fixture_gen"], check=True)
    out = os.path.join(_TMP, "g%d.ts" % len(_GEN))
    subprocess.run([GEN, "--ts", "egress", "-o", out] + list(args), check=True)
    with open(out, "rb") as f:
        _GEN[args] = f.read()
    return _GEN[args]


def spec(lateness=((0, 100),), changes=(), config=None, **clock):
    c = dict(CLOCK)
    c.update(clock)
    return {"clock": c, "lateness": [list(x) for x in lateness], "changes": list(changes),
            "config": config or {}}


def ev(lines, kind):
    return [x for x in lines if x.get("event") == kind]


def stats(lines, program=None):
    s = [x["stats"] for x in lines if "stats" in x]
    return s if program is None else next(x for x in s if x["program"] == program)


class Walk:
    """The records of a TS in order: pmt (per section), pcr, pes (a split header joined)."""

    def __init__(self, data):
        self.pkts = [data[i:i + PKT] for i in range(0, len(data) - PKT + 1, PKT)]
        self.recs = []
        pmt_pids = set()
        asm = {}
        pend = {}
        for idx, p in enumerate(self.pkts):
            v = hr.parse_packet(bytearray(p))
            if v is None:
                continue
            if v.pid == 0:
                pmt_pids |= {q for _n, q in hr.parse_pat([p])}
                continue
            if v.pid in pmt_pids:
                for sec, _n in asm.setdefault(v.pid, ec._SectionAssembler()).feed(v):
                    if sec[0] != ec.TABLE_PMT:
                        continue
                    pil = ((sec[10] & 0x0F) << 8) | sec[11]
                    self.recs.append(("pmt", idx, {
                        "pid": v.pid, "program": (sec[3] << 8) | sec[4],
                        "version": (sec[5] >> 1) & 0x1F, "pcr": ((sec[8] & 0x1F) << 8) | sec[9],
                        "pi": sec[12:12 + pil], "decl": hcdesc.find_in(sec[12:12 + pil]),
                        "crc_ok": ec.crc32_mpeg(sec[:-4]) == int.from_bytes(sec[-4:], "big")}))
                continue
            pcr = hr.read_pcr(p)
            if pcr >= 0:
                self.recs.append(("pcr", idx, {"pid": v.pid, "pcr": pcr, "disc": bool(p[5] & 0x80),
                                               "af_only": (p[3] & 0x30) == 0x20, "cc": v.cc}))
            if v.payload_off >= PKT:
                continue
            if v.pusi:
                pend.pop(v.pid, None)
                h = hr.parse_pes_header(p, v.payload_off, PKT - v.payload_off)
                if h is not None and not h.complete:
                    pend[v.pid] = (idx, p[v.payload_off:])
                elif h is not None and h.pts >= 0:
                    self.recs.append(("pes", idx, {"pid": v.pid, "pts": h.pts, "dts": h.dts,
                                                   "sid": h.sid}))
            elif v.pid in pend:
                at, b = pend.pop(v.pid)
                b = b + p[v.payload_off:]
                h = hr.parse_pes_header(b, 0, len(b))
                if h is not None and h.complete and h.pts >= 0:
                    self.recs.append(("pes", at, {"pid": v.pid, "pts": h.pts, "dts": h.dts,
                                                  "sid": h.sid}))
        self.recs.sort(key=lambda r: r[1])

    def of(self, kind):
        return [r for r in self.recs if r[0] == kind]

    def pes_by_pid(self):
        out = {}
        for _k, idx, r in self.of("pes"):
            out.setdefault(r["pid"], []).append(r)
        return out


def pes_mapped(inp, out, e_of):
    """Every output PES PTS/DTS is bus_to_net of its input's (the input's tail where the output
    starts later); e_of(pid, k) gives the E of a PID's k-th output PES."""
    a, b = Walk(inp).pes_by_pid(), Walk(out).pes_by_pid()
    if set(a) != set(b) or not b:
        return False
    for pid, outs in b.items():
        ins = a[pid][len(a[pid]) - len(outs):]
        for k, (x, y) in enumerate(zip(ins, outs)):
            e = e_of(pid, k)
            if y["pts"] != ec.bus_to_net(x["pts"], e):
                return False
            if (x["dts"] >= 0) != (y["dts"] >= 0) or (
                    x["dts"] >= 0 and y["dts"] != ec.bus_to_net(x["dts"], e)):
                return False
    return True


def e_wrapping_at(pts_bus):
    """An E of 2025 (int64 ns, as the C++ holds it) that puts the wire's 2^33 wrap at this bus PTS."""
    e90 = 18400 * ec.PTS_WRAP + (ec.MUX_CLOCK_BASE_90K - pts_bus) % ec.PTS_WRAP
    e_ns = -(-e90 * 100000 // 9)
    assert ec.ns_to_pts90k(e_ns) == e90
    return e_ns


class Recording(ec.EgressCore):
    """The core with each buffer's input and Result kept, for the byte checks."""

    def __init__(self, cfg=None):
        super().__init__(cfg)
        self.results = []
        self.pub = []

    def process(self, data, now_ns, clk=None, gap_pts=None):
        before = bytes(data)
        r = super().process(data, now_ns, clk, gap_pts)
        self.results.append((before, bytes(data), r, gap_pts is not None))
        return r

    def _apply_clock(self, now):
        old = self._pub_class
        super()._apply_clock(now)
        if self._pub_class != old or not self.pub:
            self.pub.append((now, self._pub_class))


def run(data, sp, bus=None, chunk=None, core_cls=ec.EgressCore):
    holder = {}

    class C(core_cls):
        def __init__(self, cfg=None):
            super().__init__(cfg)
            holder["core"] = self
    out, lines = ec.replay(data, sp, bus, chunk, C)
    return out, lines, holder["core"]


# --- the cases ---------------------------------------------------------------------------------

def case_hcdesc():
    d = hcdesc.HouseTimeDecl(house_time_tai=True, disciplined=True, traceable=True, ptp_valid=True,
                             sync_source=hcdesc.SYNC_PTP, tai_utc_offset_s=37, ptp_domain=0,
                             clock_error_class=11, gm_identity=0x2CCF67FFFE76E669, epoch_seq=0x1234,
                             d_e_90k=27000, timeline_id=0x0123456789ABCDEF)
    want = bytes([0x05, 32]) + b"MRHT" + bytes([1, 0xFF, 3, 37, 0, 0x2C, 0xCF, 0x67, 0xFF, 0xFE,
                                                0x76, 0xE6, 0x69, 11, 0x12, 0x34, 0x00, 0x00,
                                                0x69, 0x78, 0x01, 0x23, 0x45, 0x67, 0x89, 0xAB,
                                                0xCD, 0xEF])
    b = hcdesc.encode(d)
    v24 = bytearray(b[:26])
    v24[1] = 24
    v40 = bytearray(b) + b"\xa5" * 8
    v40[1], v40[6] = 40, 2
    v23 = bytearray(b[:25])
    v23[1] = 23
    klva = bytes([0x05, 4]) + b"KLVA"
    lang = bytes([0x0A, 4]) + b"eng\x00"
    pi = klva + b + lang + b
    return [
        ("hcdesc: p5-1's layout vector, byte for byte", b == want),
        ("hcdesc: a bare declaration's flags are 1111", hcdesc.encode(hcdesc.HouseTimeDecl())[7] == 0x0F),
        ("hcdesc: round trip", hcdesc.decode(b) == d),
        ("hcdesc: ptp_valid 0 writes 0xFF and all ones",
         hcdesc.encode(d.but(ptp_valid=False))[10:19] == b"\xff" * 9),
        ("hcdesc: length 24 decodes with timeline_id 0",
         hcdesc.decode(bytes(v24)) == d.but(timeline_id=0)),
        ("hcdesc: length 40, version 2: version 1's fields",
         hcdesc.decode(bytes(v40)) == d.but(version=2)),
        ("hcdesc: length 23 and version 0 rejected",
         hcdesc.decode(bytes(v23)) is None and hcdesc.decode(b[:6] + b"\x00" + b[7:]) is None),
        ("hcdesc: find_in behind a KLVA registration", hcdesc.find_in(klva + b) == d),
        ("hcdesc: strip_from removes two MRHT, keeps KLVA and ISO 639",
         hcdesc.strip_from(pi) == klva + lang),
        ("hcdesc: error_class(1200) == 11, unknown 0xFF",
         hcdesc.error_class(1200) == 11 and hcdesc.error_class(None) == 0xFF
         and hcdesc.error_class(0) == 0 and hcdesc.error_class(1024) == 10),
        ("hcdesc: the identity forms", hcdesc.parse_gm("2ccf67.fffe.76e669") == 0x2CCF67FFFE76E669
         and hcdesc.parse_gm("2C-CF-67-FF-FE-76-E6-69") == 0x2CCF67FFFE76E669
         and hcdesc.parse_gm("2c:cf:67:ff:fe:76:e6:69") == 0x2CCF67FFFE76E669
         and hcdesc.parse_gm("2ccf67fffe76e669") is None
         and hcdesc.gm_text(0x2CCF67FFFE76E669) == "2C-CF-67-FF-FE-76-E6-69"),
        ("hcdesc: the timeline text", hcdesc.timeline_text(0x1F) == "000000000000001f"
         and hcdesc.parse_timeline_text("000000000000001f") == 0x1F
         and hcdesc.parse_timeline_text("000000000000001F") is None),
    ]


def case_wrap():
    data = fixture("syn-wrap-33bit.ts")
    pes = Walk(data).of("pes")
    e2 = e_wrapping_at(pes[len(pes) // 2][2]["pts"])
    out1, _l1, _c = run(data, spec())
    out2, _l2, _c = run(data, spec(eNs=str(e2)))
    w2 = Walk(out2).of("pes")
    wrapped = any(r["pts"] > ec.PTS_WRAP - 90000 for _k, _i, r in w2) and any(
        r["pts"] < 90000 for _k, _i, r in w2)
    bframes = all(hr.fold33(r["pts"] - r["dts"]) >= 0 for _k, _i, r in w2 if r["dts"] >= 0)
    has_dts = any(r["dts"] >= 0 for _k, _i, r in w2)
    return [
        ("wrap: every PES PTS/DTS = bus_to_net(in), E of 2026", pes_mapped(data, out1, lambda p, k: E1)),
        ("wrap: the same with E putting the wire wrap mid-file", pes_mapped(data, out2, lambda p, k: e2)),
        ("wrap: the wire wraps inside the file", wrapped),
        ("wrap: B-frame DTS stays behind PTS across the wrap", has_dts and bframes),
    ]


def case_header_split():
    data = fixture("syn-pes-header-split.ts")
    out, lines, _c = run(data, spec())
    wi, wo = Walk(data), Walk(out)
    vpid = next(r["pcr"] for _k, _i, r in wo.of("pmt"))

    def before(walk, pid):
        """Per packet of `pid`: how many video packets precede it."""
        n, res = 0, []
        for p in walk.pkts:
            q = ((p[1] & 0x1F) << 8) | p[2]
            if q == vpid and p[3] & 0x10:
                n += 1
            elif q == pid:
                res.append(n)
        return res
    apid = next(pid for pid in wi.pes_by_pid() if pid != vpid)
    bi, bo = before(wi, apid), before(wo, apid)
    return [
        ("header split: every PES rewritten (PTS/DTS = bus_to_net(in))",
         pes_mapped(data, out, lambda p, k: E1)),
        ("header split: the AAC between the halves not delayed",
         len(bi) == len(bo) and all(y <= x for x, y in zip(bi, bo))
         and any(y < x for x, y in zip(bi, bo))),
        ("header split: no PES lost", len(wo.of("pes")) == len(wi.of("pes"))),
        ("header split: a strict CC walk over the output, in one buffer and in 188-byte ones",
         cc_strict(data, False) and cc_strict(out) and cc_strict(run(data, spec(), chunk=188)[0])),
    ]


def _pcr_intervals(walk, pid):
    """ns between consecutive PCRs on pid, a flagged one starting anew."""
    out, last = [], None
    for _k, _i, r in walk.of("pcr"):
        if r["pid"] != pid:
            continue
        if last is not None and not r["disc"]:
            out.append(ec.pcr27_to_ns((r["pcr"] - last) % ec.PCR_MODULO))
        last = r["pcr"]
    return out


def _drive(data, pkts_per_buf, step_ns, sp=None, core=None):
    """The core fed directly: buffers of n packets, now advancing step_ns per packet."""
    core = core or ec.EgressCore()
    core.set_clock(ec.clock_from_json((sp or spec())["clock"]))
    out = bytearray()
    n = pkts_per_buf * PKT
    t0 = 5000 * SEC
    for off in range(0, len(data), n):
        now = t0 + (off // PKT) * step_ns
        r = core.process(data[off:off + n], now, lambda i, now=now: now)
        out += ec.apply_edits(r.packets, r.edits)
    return bytes(out), core


def _cc_ok(out):
    t = ec.dc.CcTracker()
    for i in range(0, len(out), PKT):
        t.feed(hr.parse_packet(bytearray(out[i:i + PKT])))
    return t.lost == 0


def cc_walk(data):
    """A strict CC walk per PID: a payload packet is the last payload CC + 1, an adaptation-only
    one the last payload CC (before any, the first payload CC - 1; on a PID with no payload, its
    first adaptation-only CC). The violations, as
    (packet, pid, "pay"|"af", cc, wanted), and the adaptation-only packets judged."""
    pkts = [data[i:i + PKT] for i in range(0, len(data) - PKT + 1, PKT)]
    first = {}
    for p in pkts:
        if p[3] & 0x10:
            first.setdefault((p[1] & 0x1F) << 8 | p[2], p[3] & 0x0F)
    last, bad, n, af0 = {}, [], 0, {}
    for i, p in enumerate(pkts):
        pid, cc = (p[1] & 0x1F) << 8 | p[2], p[3] & 0x0F
        if pid == ec.PID_NULL:
            continue
        if p[3] & 0x10:
            if pid in last and cc != (last[pid] + 1) & 0x0F:
                bad.append((i, pid, "pay", cc, (last[pid] + 1) & 0x0F))
            last[pid] = cc
        elif p[3] & 0x20:
            want = last.get(pid, (first[pid] - 1) & 0x0F if pid in first else af0.setdefault(pid, cc))
            n += 1
            if want is not None and cc != want:
                bad.append((i, pid, "af", cc, want))
    return bad, n


def cc_strict(out, need_af=True):
    bad, n = cc_walk(out)
    return not bad and (n > 0 or not need_af)


def cc_af_kept(inp, out):
    """No adaptation-only CC violation in the output on a PID whose input has none."""
    dirty = {b[1] for b in cc_walk(inp)[0] if b[2] == "af"}
    return not [b for b in cc_walk(out)[0] if b[2] == "af" and b[1] not in dirty]


def _content_fn(data):
    """The CLI's content clock (egress_core's module docstring), for the tests' own sums."""
    anchors = ec.content_anchors(data)
    return lambda off: ec._interp(anchors, off)


def _max_spacing(data, chunk):
    c = _content_fn(data)
    t = [c(o) for o in range(0, len(data), chunk)]
    return max(b - a for a, b in zip(t, t[1:]))


def case_sparse_pcr():
    data = gen("--audio-only")
    out, core = _drive(data, 1, 2 * MS)
    iv = _pcr_intervals(Walk(out), 0x101)
    out2, _l, _c = run(data, spec(), chunk=1316)
    iv2 = _pcr_intervals(Walk(out2), 0x101)
    st = core.stats(1)
    return [
        ("sparse PCR: buffers 2 ms apart, PCR interval <= 35 + 2 ms", bool(iv) and max(iv) <= 37 * MS),
        ("sparse PCR: the writer inserted PCRs (input PCR every 500 ms)",
         st["pcrInserted"] > st["pcrWritten"]),
        ("sparse PCR: inserted packets AF-only with the PID's last payload CC (strict CC walk)",
         cc_strict(out) and cc_strict(out2)),
        ("sparse PCR: the output's CC tracker reports no loss", _cc_ok(out) and _cc_ok(out2)),
        ("sparse PCR: 1316-byte replay within 35 ms + its buffer spacing",
         bool(iv2) and max(iv2) <= 35 * MS + _max_spacing(data, 1316)),
    ]


def case_no_pcr_pid():
    data = gen("--pcr-pid", "none")
    out, lines, core = run(data, spec())
    pmts = Walk(out).of("pmt")
    iv = _pcr_intervals(Walk(out), 0x100)
    return [
        ("no PCR PID: video PID chosen, PMT rewritten",
         bool(pmts) and all(r["pcr"] == 0x100 for _k, _i, r in pmts)),
        ("no PCR PID: every PMT CRC valid", all(r["crc_ok"] for _k, _i, r in pmts)),
        ("no PCR PID: one pcr-pid-assigned", len(ev(lines, "pcr-pid-assigned")) == 1
         and ev(lines, "pcr-pid-assigned")[0]["pid"] == 0x100),
        ("no PCR PID: PCRs on it", bool(iv) and max(iv) <= 70 * MS),
        ("no PCR PID: input PMT says 0x1FFF", all(r["pcr"] == 0x1FFF for _k, _i, r in Walk(data).of("pmt"))),
    ]


def _ceil10(x):
    return -(-x // (10 * MS)) * 10 * MS


def _de_order_ok(out, lines, pcr_pid):
    """Each D_e change: a PMT one version on, carrying it, then a flagged PCR-only packet."""
    w = Walk(out)
    recs = w.recs
    want = [e["toNs"] for e in lines if e.get("event", "").startswith("d-e-")
            and e["fromNs"] != e["toNs"]]
    seen = []
    last_v = None
    for k, (kind, _idx, r) in enumerate(recs):
        if kind != "pmt":
            continue
        d = r["decl"].d_e_90k if r["decl"] else None
        if last_v is not None and r["version"] != last_v:
            if r["version"] != (last_v + 1) % 32:
                return False
            nxt = recs[k + 1] if k + 1 < len(recs) else None
            if nxt is None or nxt[0] != "pcr" or not nxt[2]["disc"] or not nxt[2]["af_only"] \
                    or nxt[2]["pid"] != pcr_pid:
                return False
            seen.append(ec.pts90k_to_ns(d))
        last_v = r["version"]
    return seen == want[1:] or seen == want


def _dts_pcr_min(out, pcr_pid, skip_first=True):
    """min over timing PES of (DTS else PTS) - the last PCR on pcr_pid, in ns."""
    last, m, first = None, None, skip_first
    for kind, _i, r in Walk(out).recs:
        if kind == "pcr" and r["pid"] == pcr_pid:
            last = r["pcr"] // 300
        elif kind == "pes" and last is not None and ec.timing_pes(r["sid"], r["pid"], pcr_pid):
            if first:
                first = False
                continue
            d = ec.pts90k_to_ns(hr.fold33((r["dts"] if r["dts"] >= 0 else r["pts"]) - last))
            m = d if m is None else min(m, d)
    return m


def case_de():
    data = gen("--duration", "20")
    out, lines, _c = run(data, spec(lateness=((0, 200), (20000, 1000))))
    st = ev(lines, "d-e-start")
    raises = ev(lines, "d-e-raise")
    out0, lines0, _c = run(data, spec(lateness=((0, 200),)))
    s0 = ev(lines0, "d-e-start")[0]
    outm, linesm, _c = run(data, spec(lateness=((0, 200), (20000, 1000)), config={"maxMs": 500}))
    maxes = ev(linesm, "d-e-max")
    pm = [r["decl"].d_e_90k for _k, _i, r in Walk(outm).of("pmt")]
    return [
        ("D_e: a strict CC walk over the ramp's output (inserted PCRs on the last payload CC sent, "
         "the first one before the first payload on its CC - 1)",
         cc_strict(data, False) and cc_strict(out) and cc_strict(outm)),
        ("D_e: start from the first PES, ceil10(lateness + margin + |eps|)",
         len(s0 and [s0]) == 1 and s0["toNs"] == _ceil10(s0["latenessNs"] + 150 * MS + 1200 * 1000)
         and 50 * MS < s0["latenessNs"] < 150 * MS),
        ("D_e: a lateness ramp 100 -> 900 ms raises several times", len(st) == 1 and len(raises) >= 4),
        ("D_e: raises >= 130 ms apart", all(e["toNs"] - e["fromNs"] >= 130 * MS for e in raises)),
        ("D_e: each change a PMT one version on, then a flagged PCR", _de_order_ok(out, lines, 0x100)),
        ("D_e: DTS - PCR >= headroom for every timing PES after the first",
         (_dts_pcr_min(out, 0x100) or 0) >= 20 * MS),
        ("D_e: nothing dropped, no event lowers it", not ev(lines, "d-e-lower")
         and len(Walk(out).of("pes")) == len(Walk(data).of("pes"))),
        ("D_e: max 500 ms holds, one d-e-max", len(maxes) == 1
         and max(pm) == ec.ns_to_pts90k(500 * MS)),
    ]


def case_gap():
    data = fixture("syn-gap-marker.ts")
    bus = ec.read_bus(os.path.join(FIX, "syn-gap-marker.bus.jsonl"))
    out, lines, core = run(data, spec(lateness=((0, 1100), (2900, 1100), (2950, 200))), bus)
    low = ev(lines, "d-e-lower")
    d = ec.EgressDelay(ec.EgressConfig())
    d.on_pes(0, 0)
    d.on_pes(2900 * MS, 0)
    big = d.d_e
    d.on_gap(10 * SEC, 2 * SEC)
    d.on_gap(10 * SEC, 1900 * MS)               # the same hole on another PID: no more
    lo = d.on_pes(0, 0)
    markers = sum(1 for i in range(0, len(out), PKT) if ec.dc.read_gap_length(out[i:i + PKT]) >= 0)
    s = ec.EgressDelay(ec.EgressConfig())
    s.on_pes(1000 * MS, 0)
    s.on_gap(20 * SEC, 4 * MS)                  # under one 10 ms step
    small = s.on_pes(0, 0)
    sd, sb = small_gap(data, bus)
    _o, sl, _c = run(sd, spec(lateness=((0, 1100), (2900, 1100), (2950, 200))), sb)
    slow = ev(sl, "d-e-lower")
    return [
        ("gap: a marker lowers D_e at the next PES, by at most the gap",
         len(low) == 1 and 0 < low[0]["fromNs"] - low[0]["toNs"] <= low[0]["gapNs"]),
        ("gap: the marker's length (520 or 512 ms)", bool(low) and low[0]["gapNs"] in (520 * MS, 512 * MS)),
        ("gap: a 2 s gap lowers by at most 2 s, its twin on another PID counted once",
         big == 3050 * MS and d.d_e == big - 2 * SEC and lo[0][0] == "d-e-lower"),
        ("gap: one hole's two markers lower once", len(low) == 1),
        ("gap: a gap under one step moves nothing and reports no d-e-lower",
         small == [] and s.d_e == 1150 * MS and core_moves(low)
         and core_moves(slow) and len(slow) == 1),
        ("gap: markers consumed and not sent", markers == 0 and core.counters["gapMarkers"] == 2),
        ("gap: a strict CC walk over the output (the lowering's flagged PCR included)",
         cc_strict(data, False) and cc_strict(out)),
        ("gap: a GAP buffer's every packet dropped",
         all(all(op == ec.DROP for _i, op, _b in r.edits) and len(r.edits) == len(r.packets)
             for r in [core_gap_result()])),
    ]


def core_moves(lows):
    return all(e["fromNs"] != e["toNs"] for e in lows)


def small_gap(data, bus, at_ns=1005 * SEC, g_ns=4 * MS):
    """syn-gap-marker with one more GAP buffer, a marker of g_ns ending at the first buffer whose
    PTS reaches at_ns: a gap under one D_e step, after the 520 ms one has lowered D_e."""
    marker = bytearray(next(data[i:i + PKT] for i in range(0, len(data), PKT)
                            if ec.dc.read_gap_length(data[i:i + PKT]) >= 0))
    marker[7:15] = g_ns.to_bytes(8, "big")
    k = next(j for j, b in enumerate(bus) if not b["flags"] and (b["pts"] or 0) >= at_ns)
    off = bus[k]["off"]
    new = dict(bus[k], len=PKT, flags=ec.GST_FLAG_GAP | 64)
    return (data[:off] + bytes(marker) + data[off:],
            bus[:k] + [new] + [dict(b, off=b["off"] + PKT) for b in bus[k:]])


def core_gap_result():
    c = ec.EgressCore()
    g = bytearray(b"\xff" * PKT)
    from_ts = fixture("syn-gap-marker.ts")
    for i in range(0, len(from_ts), PKT):
        if ec.dc.read_gap_length(from_ts[i:i + PKT]) >= 0:
            g = from_ts[i:i + PKT]
            break
    return c.process(bytes(g) * 2, 1000 * SEC, gap_pts=1000 * SEC)


def case_silence():
    data = gen("--duration", "8")
    cut = len(data) // 2 // PKT * PKT
    core = ec.EgressCore()
    core.set_clock(ec.clock_from_json(CLOCK))
    anchors = ec.content_anchors(data)
    offs = [a[0] for a in anchors]

    def content(off):
        import bisect
        k = max(0, min(len(anchors) - 1, bisect.bisect_right(offs, off) - 1))
        return anchors[k][1]
    out = bytearray()
    for off in range(0, len(data), 1316):
        if cut - 2 * 1316 * 60 <= off < cut:     # about 2 s of the stream lost
            continue
        lat = 1100 * MS if off < cut else 200 * MS
        now = content(off) + lat
        r = core.process(data[off:off + 1316], now)
        out += ec.apply_edits(r.packets, r.edits)
    evs = core.take_events()
    low = ev(evs, "d-e-lower")
    return [
        ("silence: a bus silence >= 500 ms counts as a gap", core.counters["gaps"] >= 1),
        ("silence: D_e lowered by at most the silence",
         len(low) == 1 and 0 < low[0]["fromNs"] - low[0]["toNs"] <= low[0]["gapNs"]
         and low[0]["gapNs"] >= 500 * MS),
    ]


def case_descriptor():
    data = fixture("tp-id3.ts")
    pi_in = Walk(data).of("pmt")[0][2]["pi"]
    out, _l, _c = run(data, spec())
    out2, _l2, _c = run(out, spec())
    p1, p2 = Walk(out).of("pmt"), Walk(out2).of("pmt")
    occ = fixture("cap-occ-1080i-h264-aac-ttx.ts")
    pio = Walk(occ).of("pmt")[0][2]["pi"]
    outo, _lo, _c = run(occ, spec())
    po = Walk(outo).of("pmt")
    return [
        ("descriptor: one MRHT in program_info", bool(p1) and all(
            len(hcdesc.find_all(r["pi"])) == 1 for _k, _i, r in p1)),
        ("descriptor: once even when the input carried one (relay)", bool(p2) and all(
            len(hcdesc.find_all(r["pi"])) == 1 for _k, _i, r in p2)),
        ("descriptor: the input's program_info kept, ours appended", bool(pi_in) and all(
            r["pi"][:len(pi_in)] == pi_in and hcdesc.strip_from(r["pi"]) == pi_in
            for _k, _i, r in p1 + p2)),
        ("descriptor: a foreign programme's descriptors kept (OCC)", bool(po) and all(
            hcdesc.strip_from(r["pi"]) == pio for _k, _i, r in po)),
        ("descriptor: the declaration's fields", bool(p1) and p1[-1][2]["decl"] == hcdesc.HouseTimeDecl(
            house_time_tai=True, disciplined=True, traceable=True, sync_source=1,
            tai_utc_offset_s=37, clock_error_class=11, epoch_seq=3,
            d_e_90k=p1[-1][2]["decl"].d_e_90k)),
    ]


def case_reepoch():
    data = gen("--duration", "6")
    e2 = E1 + 2500 * MS
    sp = spec(changes=[{"atMs": 3000, "clock": {"eNs": str(e2), "seq": 4}}])
    out, lines, _c = run(data, sp)
    re = ev(lines, "re-epoch")
    w = Walk(out)
    pmts = w.of("pmt")
    at = re[0]["packet"] if re else 0
    # The re-epoch's PMT and flagged PCR open the buffer; PES from the next PUSI carry the new E.
    k_new = next((k for k, r in enumerate(w.recs) if r[0] == "pmt" and r[2]["decl"].epoch_seq == 4), None)
    seq_flagged = k_new is not None and w.recs[k_new + 1][0] == "pcr" and w.recs[k_new + 1][2]["disc"]
    first_new = w.recs[k_new][1] if k_new is not None else 0
    ins = Walk(data).pes_by_pid()
    ok = True
    for pid, outs in w.pes_by_pid().items():
        for x, (kind, idx, y) in zip(ins[pid], [r for r in w.recs if r[0] == "pes" and r[2]["pid"] == pid]):
            e = e2 if idx > first_new else E1
            ok = ok and y["pts"] == ec.bus_to_net(x["pts"], e)
    versions = [r["version"] for _k, _i, r in pmts]
    # E moved, seq not (part 4.2 step 7): the version still bumped, then the flagged PCR.
    oute, linese, _c = run(data, spec(changes=[{"atMs": 3000, "clock": {"eNs": str(e2)}}]))
    we = Walk(oute)
    at_e = ev(linese, "re-epoch")[0]["packet"] if ev(linese, "re-epoch") else -1
    ke = next((k for k, r in enumerate(we.recs) if r[0] == "pmt" and r[1] >= at_e), None)
    e_bumped = (ke is not None and ke > 0 and we.recs[ke + 1][0] == "pcr" and we.recs[ke + 1][2]["disc"]
                and we.recs[ke][2]["version"] == (max(r["version"] for _k, i, r in we.of("pmt")
                                                      if i < we.recs[ke][1]) + 1) % 32)
    return [
        ("re-epoch: E moved with seq kept bumps the PMT version, then a flagged PCR", e_bumped),
        ("re-epoch: a strict CC walk over both outputs", cc_strict(out) and cc_strict(oute)),
        ("re-epoch: one event, seq 3 -> 4, delta E", len(re) == 1 and re[0]["seq"] == 4
         and re[0]["fromSeq"] == 3 and re[0]["deltaNs"] == 2500 * MS and at > 0),
        ("re-epoch: epoch_seq and the PMT version change, then a flagged PCR", seq_flagged
         and len(set(versions)) >= 3),
        ("re-epoch: PES before on the old E, from the next PUSI on the new", ok),
    ]


def case_error_hold():
    data = gen("--duration", "16")
    sp = spec(changes=[{"atMs": 2000, "clock": {"errorUs": 5000}},
                       {"atMs": 4000, "clock": {"errorUs": 1300}},
                       {"atMs": 4500, "clock": {"errorUs": 5000}}])
    out, lines, core = run(data, sp, core_cls=Recording)
    classes = [r["decl"].clock_error_class for _k, _i, r in Walk(out).of("pmt")]
    t0 = core.pub[0][0]
    pubs = [(t - t0, c) for t, c in core.pub]
    flagged = sum(1 for _k, _i, r in Walk(out).of("pcr") if r["disc"])
    de = sum(1 for e in lines if e.get("event", "").startswith("d-e-") and e["fromNs"] != e["toNs"])
    return [
        ("error class: published at once at start (11)", classes and classes[0] == 11),
        ("error class: a change published after 10 s held (13 at >= 14.5 s)",
         len(pubs) == 2 and pubs[1][1] == 13 and 14500 * MS <= pubs[1][0] < 14700 * MS),
        ("error class: a return inside 10 s publishes nothing", 13 in classes and classes.count(11) >= 1
         and sorted(set(classes)) == [11, 13]),
        ("error class: its PMT bump flags no PCR", flagged == de),
    ]


def case_timeline():
    data = gen("--duration", "5")
    sp = spec(changes=[{"atMs": 2500, "clock": {"timelineId": "0123456789abcdef"}}])
    out, lines, _c = run(data, sp)
    pmts = Walk(out).of("pmt")
    ids = [r["decl"].timeline_id for _k, _i, r in pmts]
    k = next((n for n, x in enumerate(ids) if x), None)
    de = [e for e in lines if e.get("event", "").startswith("d-e-")]
    flagged = sum(1 for _k, _i, r in Walk(out).of("pcr") if r["disc"])
    w = Walk(out)
    kk = next(n for n, r in enumerate(w.recs) if r[0] == "pmt" and r[2]["decl"].timeline_id)
    nxt = w.recs[kk + 1]
    return [
        ("timeline_id: a timeline-only change bumps the PMT version",
         k is not None and pmts[k][2]["version"] == (pmts[k - 1][2]["version"] + 1) % 32),
        ("timeline_id: no flagged PCR, no D_e change", flagged == 1 and len(de) == 1
         and not (nxt[0] == "pcr" and nxt[2]["disc"])),
        ("timeline_id: 0 until then, the id after", ids[0] == 0 and ids[-1] == 0x0123456789ABCDEF),
    ]


def _diff_in_fields(a, b):
    """True when two versions of one packet differ only in PTS/DTS or PCR bytes."""
    if a == b:
        return True
    allowed = set()
    if hr.read_pcr(a) >= 0:
        allowed |= set(range(6, 12))
    v = hr.parse_packet(bytearray(a))
    if not v.pusi and v.payload_off < PKT:       # the rest of a header split across packets
        allowed |= set(range(v.payload_off, min(PKT, v.payload_off + 19)))
    if v.pusi and v.payload_off < PKT:
        h = hr.parse_pes_header(a, v.payload_off, PKT - v.payload_off)
        if h is not None:
            for off in (h.pts_off, h.dts_off):
                if off >= 0:
                    allowed |= set(range(v.payload_off + off, min(PKT, v.payload_off + off + 5)))
    return all(i in allowed for i in range(PKT) if a[i] != b[i])


def case_bytes():
    res = []
    for name, bus in (("cap-mux-unbounded-video.ts", None), ("syn-gap-marker.ts", "syn-gap-marker.bus.jsonl"),
                      ("syn-mpts-two-programs.ts", None), ("syn-pes-header-split.ts", None)):
        data = fixture(name)
        out, lines, core = run(data, spec(lateness=((0, 400), (5000, 1200))),
                               ec.read_bus(os.path.join(FIX, bus)) if bus else None, core_cls=Recording)
        pmt_pids = core._pmt_pids
        unchanged = all(before == after for before, after, _r, _g in core.results)
        ok = True
        drops = 0
        for _b, _a, r, gap in core.results:
            for i, op, b in r.edits:
                p = r.packets[i] if i < len(r.packets) else None
                pid = ((p[1] & 0x1F) << 8 | p[2]) if p else -1
                if op == ec.REPLACE and pid not in pmt_pids:
                    ok = ok and _diff_in_fields(p, b)
                elif op == ec.DROP and not gap and pid not in pmt_pids:
                    drops += 1
        # Every other drop is a held packet (sent later) or one before its program's PMT.
        ok = ok and drops == core.counters["held"] + core.counters["droppedBeforePmt"]
        res.append(("bytes: %s identical outside PTS/DTS/PCR, PMT, inserted, dropped" % name, ok))
        res.append(("bytes: %s input unchanged after process" % name, unchanged))
    return res


def case_lateness_cut():
    data = gen("--duration", "4")
    _o, l0, _c = run(data, spec(lateness=((0, 0),)))
    s0 = ev(l0, "d-e-start")
    _o, l1, _c = run(data, spec(lateness=((0, 70000),)))
    st1 = stats(l1, 1)
    d = ec.EgressDelay(ec.EgressConfig())
    edge = d.on_pes(60 * SEC, 0)
    d2 = ec.EgressDelay(ec.EgressConfig())
    past = d2.on_pes(60 * SEC + 1, 0)
    return [
        ("S22: negative lateness counts as 0", len(s0) == 1 and s0[0]["latenessNs"] == 0
         and s0[0]["toNs"] == 160 * MS),
        ("S22: beyond 60 s counted lateness-off-house and ignored", not ev(l1, "d-e-start")
         and st1["latenessOffHouse"] > 100 and st1["dENs"] == 250 * MS),
        ("S22: exactly 60 s still drives D_e, 60 s + 1 ns does not",
         bool(edge) and edge[0][0] == "d-e-start" and past == [] and d2.off_house == 1),
    ]


def case_mpts():
    data = fixture("syn-mpts-two-programs.ts")
    out, lines, core = run(data, spec())
    progs = {r["program"] for _k, _i, r in Walk(out).of("pmt")}
    decls = all(r["decl"] is not None for _k, _i, r in Walk(out).of("pmt"))
    s1, s2 = stats(lines, 1), stats(lines, 2)
    d1 = {r["decl"].d_e_90k for _k, _i, r in Walk(out).of("pmt") if r["program"] == 1}
    return [
        ("MPTS: both programs' PMTs rewritten with the descriptor", progs == {1, 2} and decls),
        ("MPTS: D_e per program: 2 started, 1 (no PES with a PTS) at its pre-start value",
         s2["dEChanges"] == 1 and s1["dEChanges"] == 0 and d1 == {ec.ns_to_pts90k(250 * MS)}),
        ("MPTS: program 2's PES rewritten, both programs' PCRs",
         pes_mapped(data, out, lambda p, k: E1) and s1["pcrWritten"] > 0 and s2["pcrWritten"] > 0),
    ]


def case_expectations():
    res = []
    names = sorted(f[:-len(".clock.json")] for f in os.listdir(EGRESS) if f.endswith(".clock.json"))
    for name in names:
        with open(os.path.join(EGRESS, name + ".clock.json")) as f:
            sp = json.load(f)
        data = fixture(sp["input"])
        bus = ec.read_bus(os.path.join(FIX, sp["bus"])) if sp.get("bus") else None
        out, lines = ec.replay(data, sp, bus)
        res.append(("expectation: %s adds no adaptation-only CC error" % name, cc_af_kept(data, out)))
        with open(os.path.join(EGRESS, name + ".expect.jsonl")) as f:
            want = [line.rstrip("\n") for line in f if line.strip()]
        res.append(("expectation: %s" % name, want == [ec.dump_line(x) for x in lines]))
    res.append(("expectation: at least ten cases", len(names) >= 10))
    return res


def case_pcr_value():
    data = gen("--duration", "2")
    core = ec.EgressCore()
    core.set_clock(ec.clock_from_json(CLOCK))
    n0 = 1000 * SEC                               # the generator's house time
    r = core.process(data[:3 * PKT], n0, lambda i: n0 + 1000 * i)
    out = ec.apply_edits(r.packets, r.edits)
    pcr = [hr.read_pcr(out[i:i + PKT]) for i in range(0, len(out), PKT) if hr.read_pcr(out[i:i + PKT]) >= 0]
    flagged = None
    off = 3 * PKT
    n = n0
    while flagged is None and off < len(data):
        n += 2 * MS
        r = core.process(data[off:off + 1316], n, lambda i, n=n: n + 1000 * i)
        for i, op, b in r.edits:
            if op == ec.INSERT and hr.read_pcr(b) >= 0 and b[5] & 0x80:
                flagged = (i, hr.read_pcr(b), n)
        off += 1316
    d_e = core.stats(1)["dENs"]
    return [
        ("PCR value: H(emission) - D_e, H = the clock read for that PCR + E (D_e 250 ms before start)",
         pcr == [ec.ns_to_pcr27(n0 + 2000 + E1 - 250 * MS)]),
        ("PCR value: the flagged PCR at the start carries the new D_e", flagged is not None
         and flagged[1] == ec.ns_to_pcr27(flagged[2] + 1000 * flagged[0] + E1 - d_e) and d_e != 250 * MS),
    ]


def pcr_on_audio(data):
    """fixture_gen's egress stream with its PMT's PCR_PID moved to the audio (0x101): the video's
    PCRs then sit on a non-PCR PID. The PMTs changed."""
    data, n = bytearray(data), 0
    for off in range(0, len(data), PKT):
        v = hr.parse_packet(bytearray(data[off:off + PKT]))
        if v.pid != 0x1000 or not v.pusi:
            continue
        k = off + v.payload_off + 1 + data[off + v.payload_off]
        ln = 3 + (((data[k + 1] & 0x0F) << 8) | data[k + 2])
        data[k + 8], data[k + 9] = 0xE1, 0x01
        data[k + ln - 4:k + ln] = ec.crc32_mpeg(bytes(data[k:k + ln - 4])).to_bytes(4, "big")
        n += 1
    return bytes(data), n


def case_pcr_other_pid():
    """Part 4.2 step 5: a PCR on a PID other than the PCR PID is rewritten the same way."""
    data, n = pcr_on_audio(gen("--duration", "2"))
    core = ec.EgressCore()
    core.set_clock(ec.clock_from_json(CLOCK))
    out = bytearray()
    want_ok, seen = True, 0
    for off in range(0, len(data), PKT):
        now = 1000 * SEC + (off // PKT) * MS
        r = core.process(data[off:off + PKT], now)
        d_e = core.stats(1)["dENs"] if core.stats(1) else 0
        for i, op, b in r.edits:
            if op == ec.REPLACE and ((b[1] & 0x1F) << 8 | b[2]) == 0x100 and hr.read_pcr(b) >= 0:
                seen += 1
                want_ok = want_ok and hr.read_pcr(b) == ec.ns_to_pcr27(now + E1 - d_e)
        out += ec.apply_edits(r.packets, r.edits)
    w = Walk(bytes(out))
    pk = [out[i:i + PKT] for i in range(0, len(out), PKT)]
    pay = next(i for i, p in enumerate(pk) if ((p[1] & 0x1F) << 8 | p[2]) == 0x101 and p[3] & 0x10)
    p101 = [(i, r) for _k, i, r in w.of("pcr") if r["pid"] == 0x101]
    return [
        ("PCR other PID: D_e started on video before 0x101's first payload: its flagged PCR waits "
         "for that packet and goes just before it, on its CC - 1",
         bool(p101) and p101[0][0] == pay - 1 and p101[0][1]["disc"] and p101[0][1]["af_only"]
         and p101[0][1]["cc"] == ((pk[pay][3] & 0x0F) - 1) & 0x0F
         and any(r[0] == "pmt" and r[1] < pay - 1 and r[2]["version"] == 1 for r in w.recs)),
        ("PCR other PID: the PMT says 0x101 in and out", n > 0 and all(
            r["pcr"] == 0x101 for _k, _i, r in w.of("pmt"))),
        ("PCR other PID: every video PCR rewritten to H(emission) - D_e", seen > 20 and want_ok),
        ("PCR other PID: PCRs inserted on 0x101, a strict CC walk",
         any(r["pid"] == 0x101 for _k, _i, r in w.of("pcr")) and cc_strict(bytes(out))),
    ]


PCR_ONLY = 0x1F0


def dedicated_pcr(data, pid=PCR_ONLY, cc=7):
    """Each video PCR copied into a PCR-only packet on `pid` just before it (CC `cc`, never a
    payload), the PMT's PCR_PID pointed there: a dedicated PCR PID (part 4.2)."""
    out = bytearray()
    for off in range(0, len(data), PKT):
        p = bytearray(data[off:off + PKT])
        v = hr.parse_packet(bytearray(p))
        pcr = hr.read_pcr(p)
        if pcr >= 0 and v.pid == 0x100:
            out += ec.build_pcr_packet(pid, pcr, cc, False)
        if v.pid == 0x1000 and v.pusi:
            k = v.payload_off + 1 + p[v.payload_off]
            ln = 3 + (((p[k + 1] & 0x0F) << 8) | p[k + 2])
            p[k + 8], p[k + 9] = 0xE0 | (pid >> 8), pid & 0xFF
            p[k + ln - 4:k + ln] = ec.crc32_mpeg(bytes(p[k:k + ln - 4])).to_bytes(4, "big")
        out += p
    return bytes(out)


def case_dedicated_pcr():
    """A PCR PID that never carries payload: PCRs inserted on its own CC, flagged at D_e changes."""
    data = dedicated_pcr(gen("--duration", "20"))
    out, lines, core = run(data, spec(lateness=((0, 200), (20000, 1000))))
    w = Walk(out)
    on = [r for _k, _i, r in w.of("pcr") if r["pid"] == PCR_ONLY]
    de = [e for e in lines if e.get("event", "").startswith("d-e-") and e["fromNs"] != e["toNs"]]
    iv = _pcr_intervals(w, PCR_ONLY)
    st = core.stats(1)
    ccs = {out[i + 3] & 0x0F for i in range(0, len(out), PKT)
           if ((out[i + 1] & 0x1F) << 8 | out[i + 2]) == PCR_ONLY}
    return [
        ("dedicated PCR PID: the PMT says it in and out", all(
            r["pcr"] == PCR_ONLY for _k, _i, r in w.of("pmt")) and all(
            r["pcr"] == PCR_ONLY for _k, _i, r in Walk(data).of("pmt"))),
        ("dedicated PCR PID: each D_e change a PMT one version on, then a flagged PCR on it",
         len(de) >= 4 and _de_order_ok(out, lines, PCR_ONLY)
         and sum(1 for r in on if r["disc"]) == len(de)),
        ("dedicated PCR PID: PCRs inserted, interval <= 35 ms + its buffer spacing",
         st["pcrInserted"] > 0 and bool(iv) and max(iv) <= 35 * MS + _max_spacing(data, 1316)),
        ("dedicated PCR PID: inserted packets on its adaptation-only CC (strict CC walk)",
         cc_strict(out) and ccs == {7}),
        ("dedicated PCR PID: DTS - PCR >= headroom for every timing PES after the first",
         (_dts_pcr_min(out, PCR_ONLY) or 0) >= 20 * MS),
    ]


def case_unknown_e():
    """Part 4.5 Unknown E: known false with an eNs set writes E = 0, house_time_tai 0."""
    data = gen("--duration", "3")
    out, lines, _c = run(data, spec(known=False))
    decls = [r["decl"] for _k, _i, r in Walk(out).of("pmt")]
    return [
        ("unknown E: an eNs given with known false: every PES on E = 0",
         pes_mapped(data, out, lambda p, k: 0)),
        ("unknown E: house_time_tai and traceable 0", bool(decls) and all(
            not d.house_time_tai and not d.traceable for d in decls)),
    ]


def case_lateness_clock():
    """Lateness against the latest clock reading (a PCR read mid-buffer), not the buffer's head:
    buffers spanning about 400 ms of content keep DTS - PCR >= headroom."""
    data = gen("--duration", "20")
    chunk = 188 * 150
    out, lines, _c = run(data, spec(lateness=((0, 200), (20000, 1000))), chunk=chunk)
    return [
        ("lateness clock: buffers span > 300 ms of content", _max_spacing(data, chunk) > 300 * MS),
        ("lateness clock: DTS - PCR >= headroom for every timing PES after the first",
         (_dts_pcr_min(out, 0x100) or 0) >= 20 * MS),
    ]


def ttx_early(data, pid, by_ns):
    """The teletext PID's PES PTS moved `by_ns` earlier (each header whole in one packet)."""
    out = bytearray(data)
    for off in range(0, len(out), PKT):
        work = bytearray(out[off:off + PKT])
        v = hr.parse_packet(work)
        if v is None or v.pid != pid or not v.pusi or v.payload_off >= PKT:
            continue
        h = hr.parse_pes_header(work, v.payload_off, PKT - v.payload_off)
        if h is None or not h.complete or h.pts < 0:
            continue
        hr.rewrite_pes_timestamps(v, h, hr.fold33(h.pts - ec.ns_to_pts90k(by_ns)), h.dts)
        out[off:off + PKT] = work
    return bytes(out)


def case_private_pes():
    """A private PES (teletext, stream_id 0xBD) off the PCR PID does not drive D_e."""
    data = fixture("cap-occ-1080i-h264-aac-ttx.ts")
    ttx = next(r["pid"] for _k, _i, r in Walk(data).of("pes") if r["sid"] == 0xBD)
    sp = spec(lateness=((0, 200),))
    _o, lines, _c = run(data, sp)
    _o, lines2, _c = run(ttx_early(data, ttx, 5 * SEC), sp)
    de = [(e["event"], e["toNs"]) for e in lines if e.get("event", "").startswith("d-e-")]
    de2 = [(e["event"], e["toNs"]) for e in lines2 if e.get("event", "").startswith("d-e-")]
    return [
        ("private PES: teletext PTS 5 s earlier leaves every D_e event as it was",
         bool(de) and de == de2),
    ]


def case_before_pmt():
    """ES packets before the PMT are dropped and counted (droppedBeforePmt), then pass."""
    data = gen("--duration", "3")
    pk = [data[i:i + PKT] for i in range(0, len(data), PKT)]
    pids = [(p[1] & 0x1F) << 8 | p[2] for p in pk]
    first_pmt = pids.index(0x1000)
    lead = [p for p in pk[first_pmt + 1:] if (p[1] & 0x1F) << 8 | p[2] in (0x100, 0x101)][:40]
    moved = b"".join(lead) + data
    out, lines, core = run(moved, spec())
    opk = [out[i:i + PKT] for i in range(0, len(out), PKT)]
    opids = [(p[1] & 0x1F) << 8 | p[2] for p in opk]
    return [
        ("before PMT: the 40 leading ES packets dropped and counted",
         core.counters["droppedBeforePmt"] == 40 + sum(
             1 for q in pids[:first_pmt] if q in (0x100, 0x101))),
        ("before PMT: no ES packet leaves before the first PMT",
         not [q for q in opids[:opids.index(0x1000)] if q in (0x100, 0x101)]),
        ("before PMT: ES packets pass after it", len(Walk(out).of("pes")) > 0),
    ]


def shared_pmt_pid(data):
    """A second programme (2, one audio ES 0x102 never sent) whose PMT shares PID 0x1000 with
    programme 1's: the PAT lists both, each programme-1 PMT followed by programme 2's."""
    body = bytes([0x00, 0xB0, 17, 0, 1, 0xC1, 0, 0, 0, 1, 0xF0, 0x00, 0, 2, 0xF0, 0x00])
    pat = body + ec.crc32_mpeg(body).to_bytes(4, "big")
    p2 = ec.build_pmt_section(2, 0x102, b"", [(0x102, 0x0F, b"")], 0)
    out, cc_pat = bytearray(), 0
    for off in range(0, len(data), PKT):
        p = data[off:off + PKT]
        pid = (p[1] & 0x1F) << 8 | p[2]
        if pid == 0:
            pkts, cc_pat = ec.packetise_section(0, pat, cc_pat)
            out += pkts[0]
            continue
        out += p
        if pid == 0x1000 and p[1] & 0x40:
            out += ec.packetise_section(0x1000, p2, 0)[0][0]
    return bytes(out)


def case_shared_pmt_pid():
    data = shared_pmt_pid(gen("--duration", "3"))
    out, _l, _c = run(data, spec())
    progs = {r["program"] for _k, _i, r in Walk(out).of("pmt") if r["decl"] is not None}
    bad = [b for b in cc_walk(out)[0] if b[1] == 0x1000]
    return [
        ("shared PMT PID: both programmes' PMTs written with the descriptor", progs == {1, 2}),
        ("shared PMT PID: one CC sequence on it (strict CC walk)", not bad),
    ]


def _pmt_es(data, off):
    """(section offset, section length, program_info length, [(pid, type, es_info)]) of the PMT
    section starting in the packet at `off`."""
    v = hr.parse_packet(bytearray(data[off:off + PKT]))
    k = off + v.payload_off + 1 + data[off + v.payload_off]
    ln = 3 + (((data[k + 1] & 0x0F) << 8) | data[k + 2])
    pil = ((data[k + 10] & 0x0F) << 8) | data[k + 11]
    es, j = [], k + 12 + pil
    while j < k + ln - 4:
        eil = ((data[j + 3] & 0x0F) << 8) | data[j + 4]
        es.append((((data[j + 1] & 0x1F) << 8) | data[j + 2], data[j], bytes(data[j + 5:j + 5 + eil])))
        j += 5 + eil
    return k, ln, pil, es


def _pmt_offsets(data):
    return [o for o in range(0, len(data), PKT)
            if ((data[o + 1] & 0x1F) << 8 | data[o + 2]) == 0x1000 and data[o + 1] & 0x40]


def pcr_pid_none_reordered(data):
    """fixture_gen's --pcr-pid none stream with its PMT's ES loop as private 0x1F5 (never sent),
    then the audio, then the video: the video is not the first ES listed."""
    out = bytearray(data)
    for off in _pmt_offsets(data):
        k, _ln, pil, es = _pmt_es(out, off)
        sec = ec.build_pmt_section((out[k + 3] << 8) | out[k + 4], 0x1FFF,
                                   bytes(out[k + 12:k + 12 + pil]),
                                   [(0x1F5, 0x06, b"")] + es[::-1], (out[k + 5] >> 1) & 0x1F)
        out[off:off + PKT] = ec.packetise_section(0x1000, sec, out[off + 3] & 0x0F)[0][0]
    return bytes(out)


def case_pcr_pid_order():
    """PCR_PID 0x1FFF with a private ES and the audio listed before the video: the video chosen."""
    data = pcr_pid_none_reordered(gen("--pcr-pid", "none", "--duration", "3"))
    out, lines, _c = run(data, spec())
    a = ev(lines, "pcr-pid-assigned")
    return [
        ("PCR PID order: the input lists 0x1F5 first, the audio before the video, PCR_PID 0x1FFF",
         all([e[0] for e in _pmt_es(data, o)[3]][::3] == [0x1F5, 0x100]
             and [e[0] for e in _pmt_es(data, o)[3]].index(0x101) == 2 for o in _pmt_offsets(data))
         and all(r["pcr"] == 0x1FFF for _k, _i, r in Walk(data).of("pmt"))),
        ("PCR PID order: the video chosen though listed last, one pcr-pid-assigned",
         len(a) == 1 and a[0]["pid"] == 0x100
         and all(r["pcr"] == 0x100 for _k, _i, r in Walk(out).of("pmt"))),
    ]


def case_eps_cap():
    """The clock error term is capped at 50 ms: errorUs 80000 starts D_e where 50000 does."""
    data = gen("--duration", "2")
    start = {}
    for e in (40000, 50000, 80000):
        _o, lines, _c = run(data, spec(errorUs=e))
        start[e] = ev(lines, "d-e-start")[0]["toNs"]
    return [
        ("eps cap: errorUs 80000 starts D_e as 50000 does, 40000 10 ms lower",
         start[80000] == start[50000] == start[40000] + 10 * MS),
        ("eps cap: eps_ns(80000) == 50 ms", ec.EgressDelay.eps_ns(80000) == 50 * MS),
    ]


AF_MARK = 0x5A


def split_with_af(data):
    """syn-pes-header-split.ts with an adaptation-only packet (no PCR, its first stuffing byte
    AF_MARK) of the split PID between the first split header's two halves, on the first half's CC."""
    pk = [bytearray(data[i:i + PKT]) for i in range(0, len(data), PKT)]
    for idx, p in enumerate(pk):
        v = hr.parse_packet(bytearray(p))
        if v is None or not v.pusi or v.payload_off >= PKT:
            continue
        h = hr.parse_pes_header(p, v.payload_off, PKT - v.payload_off)
        if h is not None and not h.complete:
            af = bytearray(b"\xff" * PKT)
            af[0], af[1], af[2], af[3], af[4], af[5], af[6] = (
                0x47, v.pid >> 8, v.pid & 0xFF, 0x20 | v.cc, 183, 0x00, AF_MARK)
            return b"".join(bytes(q) for q in pk[:idx + 1]) + bytes(af) + b"".join(
                bytes(q) for q in pk[idx + 1:]), v.pid
    raise AssertionError("no split header")


def case_split_af():
    """Part 4.2: a split header's PID holds its adaptation-only packets behind the first half."""
    data, pid = split_with_af(fixture("syn-pes-header-split.ts"))
    res = []
    for chunk in (None, 188):
        out, _l, _c = run(data, spec(), chunk=chunk)
        seq = []
        for i in range(0, len(out), PKT):
            p = out[i:i + PKT]
            if (p[1] & 0x1F) << 8 | p[2] != pid:
                continue
            if (p[3] & 0x30) == 0x20 and p[5] == 0x00 and p[6] == AF_MARK:
                seq.append("af")
            elif p[3] & 0x10:
                seq.append("pusi" if p[1] & 0x40 else "pay")
        k = seq.index("af") if "af" in seq else -1
        res.append(k > 0 and seq[k - 1] == "pusi" and seq[k + 1] == "pay" and cc_strict(out))
    return [
        ("split AF: the adaptation-only packet leaves between the halves, CC walk strict "
         "(one buffer and 188-byte ones)", cc_strict(data, False) and all(res)),
    ]


CASES = {
    "hcdesc": case_hcdesc, "wrap": case_wrap, "header-split": case_header_split,
    "sparse-pcr": case_sparse_pcr, "no-pcr-pid": case_no_pcr_pid, "de": case_de, "gap": case_gap,
    "silence": case_silence, "descriptor": case_descriptor, "reepoch": case_reepoch,
    "error-hold": case_error_hold, "timeline": case_timeline, "bytes": case_bytes,
    "lateness-cut": case_lateness_cut, "mpts": case_mpts, "pcr-value": case_pcr_value,
    "pcr-other-pid": case_pcr_other_pid, "dedicated-pcr": case_dedicated_pcr,
    "unknown-e": case_unknown_e, "lateness-clock": case_lateness_clock,
    "private-pes": case_private_pes, "before-pmt": case_before_pmt,
    "shared-pmt-pid": case_shared_pmt_pid, "pcr-pid-order": case_pcr_pid_order,
    "eps-cap": case_eps_cap, "split-af": case_split_af,
    "expectations": case_expectations,
}


# --- mutants: each must make its case fail -----------------------------------------------------

def _patch(obj, name, value):
    old = getattr(obj, name)
    setattr(obj, name, value)
    return lambda: setattr(obj, name, old)


def _mut_headroom():
    orig = ec.EgressDelay.on_pes

    def on_pes(self, lam, eps):
        h = self.cfg.headroom_ns
        self.cfg.headroom_ns = 0
        try:
            return orig(self, lam, eps)
        finally:
            self.cfg.headroom_ns = h
    return _patch(ec.EgressDelay, "on_pes", on_pes)


def _mut_gap_bound():
    orig = ec.EgressDelay.on_pes

    def on_pes(self, lam, eps):
        g = self.gap_ns
        if g > 0:
            self.gap_ns = 1 << 62                 # lowered straight to the target
        return [(k, a, b, la, g if k == "d-e-lower" else x) for k, a, b, la, x in orig(self, lam, eps)]
    return _patch(ec.EgressDelay, "on_pes", on_pes)


def _mut_gap_twice():
    def on_gap(self, end_ns, g_ns):
        if g_ns > 0:
            self.gap_ns += g_ns
    return _patch(ec.EgressDelay, "on_gap", on_gap)


def _mut_error_hold():
    return _patch(ec.EgressCore, "ERROR_HOLD_NS", 0)


def _mut_pcr_before_pmt():
    def disc(self, i, prog, rebuilt=False):
        if not rebuilt:
            self._rebuild(prog)
        if prog.pcr_out is not None:
            self._insert_pcr(i, prog, True)
        self._emit_pmt(i, prog)
    return _patch(ec.EgressCore, "_discontinuity", disc)


def _mut_inserted_cc():
    return _patch(ec.PcrScheduler, "cc", lambda self: (self._cc + 1) & 0x0F)


def _mut_cc_before_sent():
    orig = ec.EgressCore._on_es

    def on_es(self, i, v, prog):
        if v.payload_off < PKT:                   # recorded before the packet's own handling
            self._sent(v.pid, v.cc)
        return orig(self, i, v, prog)
    return _patch(ec.EgressCore, "_on_es", on_es)


def _mut_first_cc_zero():
    def prime(self, v):
        for prog in self._progs.values():
            if prog.pcr_out == v.pid and not prog.cc_known:
                prog.cc_known = True              # CC 0 before the PID's first payload
    return _patch(ec.EgressCore, "_prime", prime)


def _mut_other_pid_pcr():
    orig = ec.EgressCore._write_pcr

    def write(self, i, buf, prog, pid):
        if pid == prog.pcr_out:
            orig(self, i, buf, prog, pid)
    return _patch(ec.EgressCore, "_write_pcr", write)


def _mut_flag_dropped():
    orig = ec.EgressCore._insert_pcr

    def insert(self, i, prog, discontinuity):
        if not prog.cc_known:
            return                                # the skipped flagged PCR forgotten
        orig(self, i, prog, discontinuity)
    return _patch(ec.EgressCore, "_insert_pcr", insert)


def _mut_reepoch_no_bump():
    orig = ec.EgressCore._rebuild
    return _patch(ec.EgressCore, "_rebuild", lambda self, prog, force=False: orig(self, prog))


def _mut_late_cut():
    return _patch(ec.EgressDelay, "LATE_MAX_NS", 1 << 62)


def _mut_prime_payload_only():
    def prime(self, v):
        if v.payload_off >= PKT:
            return                                # a PCR-only PID never primed
        for prog in self._progs.values():
            if prog.pcr_out == v.pid and not prog.cc_known:
                prog.sched.saw_payload((v.cc - 1) & 0x0F)
                prog.cc_known = True
    return _patch(ec.EgressCore, "_prime", prime)


def _mut_prime_af_minus_one():
    def prime(self, v):
        for prog in self._progs.values():
            if prog.pcr_out == v.pid and not prog.cc_known:
                prog.sched.saw_payload((v.cc - 1) & 0x0F)   # CC - 1 on adaptation-only too
                prog.cc_known = True
    return _patch(ec.EgressCore, "_prime", prime)


def _mut_unknown_e_used():
    orig = ec.EgressCore._apply_clock

    def apply(self, now):
        c = self._pending
        orig(self, now)
        if c is not None:
            self._e_ns = c.e_ns                   # E used though not known
    return _patch(ec.EgressCore, "_apply_clock", apply)


def _mut_lateness_head():
    orig = ec.EgressCore._times

    def times(self, i, prog, pid, h, pts33, dts33):
        t, self._t = self._t, self._now           # lateness against the buffer's head
        try:
            return orig(self, i, prog, pid, h, pts33, dts33)
        finally:
            self._t = t
    return _patch(ec.EgressCore, "_times", times)


def _mut_every_pes_timing():
    return _patch(ec, "timing_pes", lambda sid, pid, timing_pid: True)


def _mut_pass_before_pmt():
    return _patch(ec.EgressCore, "_all_known", lambda self: True)


def _mut_pmt_cc_per_program():
    def pk(self, prog):
        pkts, prog.cc_mut = ec.packetise_section(prog.pmt_pid, prog.section, getattr(prog, "cc_mut", 0))
        prog.st["pmtSent"] += 1
        return pkts
    return _patch(ec.EgressCore, "_packetise_pmt", pk)


def _mut_first_es_pcr():
    return _patch(ec.EgressCore, "_choose_pcr",
                  lambda self, streams: streams[0][0] if streams else ec.PID_NULL)


def _mut_eps_uncapped():
    orig = ec.EgressDelay.__dict__["eps_ns"]
    ec.EgressDelay.eps_ns = classmethod(lambda cls, e: cls.EPS_CAP_NS if e is None else e * 1000)
    return lambda: setattr(ec.EgressDelay, "eps_ns", orig)


def _mut_af_never_held():
    return _patch(ec.EgressCore, "MAX_HELD_AF", 0)


def _mut_lower_noop_event():
    def on_pes(self, lateness_ns, eps_ns):
        if self.started and self.gap_ns > 0 and lateness_ns <= self.LATE_MAX_NS:
            lam = max(0, lateness_ns)
            g, self.gap_ns = self.gap_ns, 0
            target = max(self.cfg.floor_ns, self._need(lam, eps_ns))
            if target < self.d_e:
                old, self.d_e = self.d_e, max(target, self._ceil(self.d_e - g))
                return self._count([("d-e-lower", old, self.d_e, lam, g)])
        return orig(self, lateness_ns, eps_ns)
    orig = ec.EgressDelay.on_pes
    return _patch(ec.EgressDelay, "on_pes", on_pes)


MUTANTS = [
    ("headroom 0", _mut_headroom, "de"),
    ("D_e lowered past the gap", _mut_gap_bound, "gap"),
    ("one hole's markers on two PIDs counted twice", _mut_gap_twice, "gap"),
    ("the error class published without its 10 s hold", _mut_error_hold, "error-hold"),
    ("the flagged PCR before the PMT", _mut_pcr_before_pmt, "de"),
    ("inserted PCR packets one CC on", _mut_inserted_cc, "sparse-pcr"),
    ("no 60 s cut", _mut_late_cut, "lateness-cut"),
    ("a payload CC taken before its packet is sent", _mut_cc_before_sent, "de"),
    ("CC 0 for a PCR before the PCR PID's first payload", _mut_first_cc_zero, "de"),
    ("a PCR on a non-PCR PID left as it came", _mut_other_pid_pcr, "pcr-other-pid"),
    ("a flagged PCR skipped before the PCR PID's first payload forgotten", _mut_flag_dropped,
     "pcr-other-pid"),
    ("a re-epoch with seq kept does not bump the version", _mut_reepoch_no_bump, "reepoch"),
    ("a PCR-only PCR PID never primed (no PCR inserted on it)", _mut_prime_payload_only,
     "dedicated-pcr"),
    ("an adaptation-only first packet primes CC - 1", _mut_prime_af_minus_one, "dedicated-pcr"),
    ("E used with known false", _mut_unknown_e_used, "unknown-e"),
    ("lateness against the buffer's head, not the latest clock reading", _mut_lateness_head,
     "lateness-clock"),
    ("every PES drives D_e", _mut_every_pes_timing, "private-pes"),
    ("unknown PIDs passed before the PMT", _mut_pass_before_pmt, "before-pmt"),
    ("the PMT CC kept per programme, not per PMT PID", _mut_pmt_cc_per_program, "shared-pmt-pid"),
    ("the first ES listed as the PCR PID", _mut_first_es_pcr, "pcr-pid-order"),
    ("no 50 ms cap on the clock error", _mut_eps_uncapped, "eps-cap"),
    ("adaptation-only packets never held behind a split header", _mut_af_never_held, "split-af"),
    ("a d-e-lower reported when D_e did not move", _mut_lower_noop_event, "gap"),
]


def main():
    only = set(sys.argv[1:])
    failures = 0
    for name, fn in CASES.items():
        if only and name not in only:
            continue
        for label, ok in fn():
            print("%s %s" % ("PASS" if ok else "FAIL", label))
            failures += not ok
    if not only or "mutants" in only:
        for label, patch, case in MUTANTS:
            undo = patch()
            try:
                caught = not all(ok for _l, ok in CASES[case]())
            except Exception:                     # a mutant that breaks the run is caught too
                caught = True
            finally:
                undo()
            print("%s mutant caught: %s (%s)" % ("PASS" if caught else "FAIL", label, case))
            failures += not caught
    if failures:
        print("\n%d FAILURE(S) in egress_ref_test" % failures)
        return 1
    print("\nALL egress_ref_test TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
