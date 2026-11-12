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


def _inserted_cc_ok(out, pid):
    """Every PCR-only packet on pid carries its PID's last payload CC."""
    last, ok, n = None, True, 0
    for i in range(0, len(out), PKT):
        p = out[i:i + PKT]
        if ((p[1] & 0x1F) << 8 | p[2]) != pid:
            continue
        if p[3] & 0x10:
            last = p[3] & 0x0F
        elif hr.read_pcr(p) >= 0 and last is not None:
            n += 1
            ok = ok and (p[3] & 0x0F) == last and (p[3] & 0x30) == 0x20
    return ok and n > 0


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
        ("sparse PCR: inserted packets AF-only with the PID's last payload CC", _inserted_cc_ok(out, 0x101)),
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
    return [
        ("gap: a marker lowers D_e at the next PES, by at most the gap",
         len(low) == 1 and 0 < low[0]["fromNs"] - low[0]["toNs"] <= low[0]["gapNs"]),
        ("gap: the marker's length (520 or 512 ms)", bool(low) and low[0]["gapNs"] in (520 * MS, 512 * MS)),
        ("gap: a 2 s gap lowers by at most 2 s, its twin on another PID counted once",
         big == 3050 * MS and d.d_e == big - 2 * SEC and lo[0][0] == "d-e-lower"),
        ("gap: one hole's two markers lower once", len(low) == 1),
        ("gap: markers consumed and not sent", markers == 0 and core.counters["gapMarkers"] == 2),
        ("gap: a GAP buffer's every packet dropped",
         all(all(op == ec.DROP for _i, op, _b in r.edits) and len(r.edits) == len(r.packets)
             for r in [core_gap_result()])),
    ]


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
    return [
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
        _o, lines = ec.replay(data, sp, bus)
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


CASES = {
    "hcdesc": case_hcdesc, "wrap": case_wrap, "header-split": case_header_split,
    "sparse-pcr": case_sparse_pcr, "no-pcr-pid": case_no_pcr_pid, "de": case_de, "gap": case_gap,
    "silence": case_silence, "descriptor": case_descriptor, "reepoch": case_reepoch,
    "error-hold": case_error_hold, "timeline": case_timeline, "bytes": case_bytes,
    "lateness-cut": case_lateness_cut, "mpts": case_mpts, "pcr-value": case_pcr_value,
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


def _mut_late_cut():
    return _patch(ec.EgressDelay, "LATE_MAX_NS", 1 << 62)


MUTANTS = [
    ("headroom 0", _mut_headroom, "de"),
    ("D_e lowered past the gap", _mut_gap_bound, "gap"),
    ("one hole's markers on two PIDs counted twice", _mut_gap_twice, "gap"),
    ("the error class published without its 10 s hold", _mut_error_hold, "error-hold"),
    ("the flagged PCR before the PMT", _mut_pcr_before_pmt, "de"),
    ("inserted PCR packets one CC on", _mut_inserted_cc, "sparse-pcr"),
    ("no 60 s cut", _mut_late_cut, "lateness-cut"),
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
