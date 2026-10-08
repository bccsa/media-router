"""transformProducer retime (`alignBranchesToStamps.transformProducer`, ADR-0005
2026-10-08) — every access unit of a transform producer's input demux retimed
onto its producer's stamps. Imported by gst-pipeline-runner.py; the native twin
is mr-gst-runner/branch_retime.cpp, rule for rule.

A transform producer's tsdemux maps the PCR onto the stamps through its skew
estimator, so its timestamps carry the input's PTS−PCR lead and walk. They are
replaced: PTS = K + ns(PES PTS), DTS = K + ns(PES DTS).
"""
import collections
import sys

from gi.repository import Gst

# Bytes of PES payload TAIL joined on, and completed access units kept per PID —
# shared with the runner's mux-mode join (`_BRANCH_ALIGN_*`).
KEY_BYTES = 64
HISTORY = 4096

EPS_NS = 1_000_000              # two readings of one mapping agree within this
BACK_TICKS = 90_000             # a PES continues its PID from −1 s …
FWD_TICKS = 450_000             # … to +5 s of the last one (the stamper's watch)
EPOCHS = 4                      # stamp epochs remembered
STEP_LOG_NS = 20_000_000        # K moves past this are logged
# The first exact reading needs a stamp that MOVED, which the first buffer alone
# cannot show: the bus input is held until it arrives, then re-chained — bounded.
HOLD_MS = 1000.0
HOLD_BUFFERS = 4096
TAIL = KEY_BYTES + 184          # payload window kept per open AU
# A repeated tail is told apart by tsdemux's own PTS: the entry within this of the
# pad's last (PTS − PES) offset. Well under any access unit's spacing.
JOIN_TOL_NS = 5_000_000


class Epoch:
    """One stamp epoch: the span over which K = stamp − ns(PES) holds."""
    __slots__ = ("seq", "k", "last_read", "ub", "pred", "last", "lastd", "cad", "reads")

    def __init__(self, seq, pred=None):
        self.seq, self.pred = seq, pred
        self.k = self.last_read = self.ub = None
        self.last, self.lastd, self.cad = {}, {}, {}   # pid -> PTS, decode time, its step
        self.reads = 0


class Au:
    """An indexed access unit: its epoch, PTS/DTS unwrapped on it, K once exact."""
    __slots__ = ("e", "u", "du", "k")

    def __init__(self, e, u, du):
        self.e, self.u, self.du, self.k = e, u, du, None


def fold(d):
    """Signed, 33-bit-wrap-folded PES delta (ticks)."""
    d %= 1 << 33
    return d - (1 << 33) if d > 1 << 32 else d


def log(st, msg):
    sys.stderr.write(f"[gst-runner.py] branchAlign: {st['name']} retime: {msg}\n")
    sys.stderr.flush()


def new_state(name):
    import ts_timeline
    return {"name": name, "ns": ts_timeline.pts90k_to_ns, "prev_stamp": None, "pcr_pid": None,
            "rule": None, "amb": None, "epochs": [], "pid_epoch": {}, "seq": 0, "exact": False,
            # the join (`join`): pid -> deque of (payload tail, Au)
            "aus": {}, "synced": {}, "open": {}, "psi": [False, False], "indexed": 0,
            "held": [], "hold_t0": None, "released": False, "releasing": False,
            "failed": False}


def epoch_k(e):
    """An epoch's best K: exact, else predicted, else its upper bound."""
    if e.k is not None:
        return e.k
    return e.pred if e.pred is not None else e.ub


def note(e, pid, u, du):
    dec = u if du is None else du
    ld = e.lastd.get(pid)
    if ld is not None and 0 < dec - ld <= FWD_TICKS:
        e.cad[pid] = dec - ld
    e.last[pid], e.lastd[pid] = u, dec


def on_pes(st, pid, pts, dts):
    """The `Au` of one PES. Continuous with its PID: same epoch. Else the
    newest later epoch it is coherent with, else a fresh one predicted to carry on
    where the PID left off (until its first exact reading). Pure."""
    e = st["pid_epoch"].get(pid)
    if e is not None:
        d = fold(pts - e.last[pid])
        if -BACK_TICKS <= d <= FWD_TICKS:
            u = e.last[pid] + d
            du = None if dts is None else u + fold(dts - pts)
            note(e, pid, u, du)
            return Au(e, u, du)
    epochs = st["epochs"]
    for cand in reversed(epochs[epochs.index(e) + 1:] if e in epochs else epochs):
        q = next((q for q in cand.last.values()
                  if abs(fold(pts - q)) <= FWD_TICKS), None)
        if q is not None:
            u = q + fold(pts - q)
            du = None if dts is None else u + fold(dts - pts)
            st["pid_epoch"][pid] = cand
            note(cand, pid, u, du)
            return Au(cand, u, du)
    du = None if dts is None else pts + fold(dts - pts)
    pred = None
    if e is not None:
        k = epoch_k(e)
        if k is not None:
            pred = k + st["ns"](e.lastd[pid] + e.cad.get(pid, 0) - (pts if du is None else du))
        log(st, f"pid=0x{pid:x} PTS discontinuity "
                        f"{fold(pts - e.last[pid]) / 90000:+.3f} s — stamp epoch "
                        f"#{st['seq']}" + ("" if pred is None else ", predicted to continue the last"))
    new = Epoch(st["seq"], pred)
    st["seq"] += 1
    epochs.append(new)
    del epochs[:-EPOCHS]
    st["pid_epoch"][pid] = new
    note(new, pid, pts, du)
    return Au(new, pts, du)


def read(st, e, s):
    """One exact reading. K = the lower of the last two: a lone high reading (a
    clamped stamp read as moved after a bus drop) never lands, a real step does
    one reading later, a drop (latch repair) at once."""
    e.reads += 1
    k = s if e.last_read is None else min(e.last_read, s)
    e.last_read = s
    if e.k is None:
        st["exact"] = True
        if e.pred is not None:
            log(st, f"epoch #{e.seq} on its stamps, "
                            f"{(k - e.pred) / 1e6:+.3f} ms off the prediction")
    elif abs(k - e.k) > STEP_LOG_NS:
        log(st, f"epoch #{e.seq} K moved {(k - e.k) / 1e6:+.3f} ms "
                        f"(the producer re-anchored)")
    e.k = k


def bound(e, s):
    if e.ub is None or s < e.ub:
        e.ub = s


def learn(st, e, ma, mb):
    """Which PES stamps a buffer, from the one candidate that agreed. Set once;
    flipped only against a K that the last reading confirmed."""
    if ma == mb:
        return
    rule = "first" if ma else "pcr"
    if st["rule"] == rule:
        return
    if st["rule"] is not None and (e.last_read is None or e.k is None
                                   or abs(e.last_read - e.k) > EPS_NS):
        return
    st["rule"], st["amb"] = rule, None
    log(st, "the producer stamps a buffer by its "
                    + ("first timing PES" if ma else "first PCR-PID PES"))


def sample(st, stamp, a, b):
    """Fold one bus buffer's stamp into its epoch. `a` = its first timing-eligible
    PES, `b` = its first PCR-PID PES (`Au`, either None). A stamp equal to
    the previous one may be the floor's: it only bounds K. Pure."""
    eps, ns = EPS_NS, st["ns"]
    moved = st["prev_stamp"] is not None and stamp != st["prev_stamp"]
    st["prev_stamp"] = stamp
    if a is None:
        return
    e, ca = a.e, stamp - ns(a.u)
    if b is None or b is a:
        if not moved:
            bound(e, ca)
            return
        amb = st["amb"]
        if st["rule"] is None and amb is not None and amb[0] is e:
            learn(st, e, abs(ca - amb[1]) <= eps, abs(ca - amb[2]) <= eps)
        read(st, e, ca)
        return
    if b.e is not e:
        return                              # straddles a discontinuity
    cb = stamp - ns(b.u)
    if not moved:
        bound(e, max(ca, cb))
        return
    if e.k is not None:
        learn(st, e, abs(ca - e.k) <= eps, abs(cb - e.k) <= eps)
    elif st["amb"] is not None and st["amb"][0] is e:
        learn(st, e, abs(ca - st["amb"][1]) <= eps, abs(cb - st["amb"][2]) <= eps)
    if st["rule"] is None:
        st["amb"] = (e, ca, cb)
        bound(e, max(ca, cb))
        return
    read(st, e, ca if st["rule"] == "first" else cb)


def k_for(au):
    """K for an access unit leaving the demuxer: exact as of its own buffer, else
    its epoch's best."""
    return au.k if au.k is not None else epoch_k(au.e)


def join(st, ps, tail, ts):
    """`_branch_align_join` for one pad (`ps`), robust to repeated tails: an entry
    whose PES sits at the pad's last (tsdemux PTS − PES) offset wins, so an entry
    tsdemux discarded (a continuity gap) is skipped; else the order rule. Pure."""
    pid = ps["pid"]
    q = st["aus"].get(pid)
    if not q:
        return None
    ns, off = st["ns"], ps["off"]
    timed = off is not None and ts is not None
    synced = st["synced"].get(pid)
    hit = None
    for i, (t, au) in enumerate(q):
        if t != tail:
            continue
        if timed and abs(ts - ns(au.u) - off) <= JOIN_TOL_NS:
            hit = i
            break
        if hit is None:
            hit = i
            if not timed and (i == 0 or synced):
                break
        elif not timed and not synced:
            return None                 # first join, off the head, and the tail repeats
    if hit is None:
        return None
    au = q[hit][1]
    for _ in range(hit + 1):
        q.popleft()
    st["synced"][pid] = True
    if ts is not None:
        ps["off"] = ts - ns(au.u)
    return au


def pes_dts(p):
    """DTS of the PES header at `p` (00 00 01 …), or None."""
    if (p[7] & 0xC0) != 0xC0 or len(p) < 19:
        return None
    return (((p[14] >> 1) & 0x07) << 30) | (p[15] << 22) | ((p[16] >> 1) << 15) \
        | (p[17] << 7) | (p[18] >> 1)


def install(name, demux, sink_pad, registry, pid_of):
    """Arm the retime on one transform producer's input demux: a sink-pad index
    (stamp readings + a payload-tail join of every access unit) and a probe on
    every audio/video src pad that rewrites PTS/DTS. Lives for the pipeline.
    The state goes into `registry[name]`; `pid_of` parses a tsdemux pad name."""
    import ts_psi
    import ts_timeline
    st = new_state(name)
    registry[name] = st
    ns, timing_sid = st["ns"], ts_timeline.timing_stream_id

    def close(pid):
        rec = st["open"].pop(pid, None)          # [au, tail window, bytes, need, afterPsi]
        if rec is None or not rec[4] or not rec[2]:
            return                               # before PAT+PMT: tsdemux discards it
        q = st["aus"].get(pid)
        if q is None:
            q = st["aus"][pid] = collections.deque()
        q.append((bytes(rec[1][-KEY_BYTES:]), rec[0]))
        if len(q) > HISTORY:
            q.popleft()
        st["indexed"] += 1

    def add(pid, chunk):
        rec = st["open"].get(pid)
        if rec is None:
            return
        rec[1] += chunk
        rec[2] += len(chunk)
        if len(rec[1]) > TAIL:
            del rec[1][:-TAIL]
        if rec[3] is not None and rec[2] >= rec[3]:
            # A length-bearing PES leaves tsdemux the moment it is complete.
            over = rec[2] - rec[3]
            if over:
                del rec[1][len(rec[1]) - over:]
            close(pid)

    def index(buf):
        heads = []                               # (pid, stream_id, au), wire order
        for pkt in ts_psi.iter_packets(buf.extract_dup(0, buf.get_size())):
            pid = ((pkt[1] & 0x1F) << 8) | pkt[2]
            if pkt[3] & 0x20 and pkt[4] >= 7 and pkt[5] & 0x10:
                st["pcr_pid"] = pid
            if not pkt[3] & 0x10:
                continue
            off = ts_psi.payload_offset(pkt)
            if off >= ts_psi.PKT:
                continue
            if not pkt[1] & 0x40:
                add(pid, pkt[off:])
                continue
            p = pkt[off:]
            if len(p) < 14 or p[0] != 0x00 or p[1] != 0x00 or p[2] != 0x01:
                if off + 1 < len(pkt):           # PSI: PAT on pid 0, then a PMT (table 0x02)
                    tid_at = off + 1 + pkt[off]
                    if pid == 0:
                        st["psi"][0] = True
                    elif st["psi"][0] and tid_at < len(pkt) and pkt[tid_at] == 0x02:
                        st["psi"][1] = True
                continue
            close(pid)
            pts = ts_psi.read_pes_pts(pkt)
            if pts is None:
                continue
            au = on_pes(st, pid, pts, pes_dts(p))
            hdr = 9 + p[8]
            plen = (p[4] << 8) | p[5]
            need = (6 + plen - hdr) if plen and 6 + plen > hdr else None
            st["open"][pid] = [au, bytearray(), 0, need, st["psi"][0] and st["psi"][1]]
            heads.append((pid, p[3], au))
            add(pid, p[hdr:])
        if buf.pts != Gst.CLOCK_TIME_NONE:
            pcr = st["pcr_pid"]
            a = next((au for pid, sid, au in heads if timing_sid(sid) or pid == pcr), None)
            b = next((au for pid, _sid, au in heads if pid == pcr), None)
            sample(st, buf.pts, a, b)
        for _pid, _sid, au in heads:
            if au.e.k is not None:
                au.k = au.e.k                    # the mapping this AU's own stamp says

    def release(pad, how):
        held, st["held"] = st["held"], []
        st["released"], st["releasing"] = True, True
        try:
            for b in held:
                pad.chain(b)
        finally:
            st["releasing"] = False
        k = epoch_k(st["epochs"][-1]) if st["epochs"] else None
        log(st, f"released {how} ({len(held)} bus buffers held), K={k} — every "
                        f"access unit leaves at K + its PES")

    def hold(pad, buf):
        stamp = buf.pts
        if st["hold_t0"] is None and stamp != Gst.CLOCK_TIME_NONE:
            st["hold_t0"] = stamp
        held_ms = 0.0 if st["hold_t0"] is None or stamp == Gst.CLOCK_TIME_NONE \
            else (stamp - st["hold_t0"]) / 1e6
        if st["exact"]:
            release(pad, "on the first exact stamp reading")
        elif st["failed"] or held_ms >= HOLD_MS or len(st["held"]) >= HOLD_BUFFERS:
            release(pad, f"WITHOUT an exact stamp reading after {held_ms:.0f} ms — the first "
                         f"access units sit on its upper bound")
        else:
            st["held"].append(buf.copy())
            return Gst.PadProbeReturn.DROP
        return Gst.PadProbeReturn.OK             # this buffer follows the held ones

    def on_sink(pad, info):
        if not info.type & Gst.PadProbeType.BUFFER:
            ev = info.get_event()
            if ev is not None and ev.type == Gst.EventType.EOS:
                if st["held"]:
                    release(pad, "at end of stream")
                for pid in list(st["open"]):
                    close(pid)                   # tsdemux flushes what it still holds
            elif ev is not None and ev.type == Gst.EventType.FLUSH_STOP:
                st["held"].clear()
                st["open"].clear()
                st["aus"].clear()
                st["synced"].clear()
            return Gst.PadProbeReturn.OK
        if st["releasing"]:
            return Gst.PadProbeReturn.OK         # a held buffer going back in
        buf = info.get_buffer()
        if buf is None:
            return Gst.PadProbeReturn.OK
        if not st["failed"]:
            try:
                index(buf)
            except Exception as exc:  # noqa: BLE001 — one line, never a traceback per buffer
                st["failed"] = True
                log(st, f"sink index failed ({exc!r}) — access units pass on tsdemux's "
                                f"timestamps plus each pad's last correction")
        return Gst.PadProbeReturn.OK if st["released"] else hold(pad, buf)

    def on_out(pad, info, ps):
        buf = info.get_buffer()
        if buf is None:
            return Gst.PadProbeReturn.OK
        pts, dts = buf.pts, buf.dts
        au, size = None, buf.get_size()
        if size and not st["failed"]:
            n = min(size, KEY_BYTES)
            au = join(st, ps, buf.extract_dup(size - n, n),
                              None if pts == Gst.CLOCK_TIME_NONE else pts)
        k = None if au is None else k_for(au)
        out = None if k is None else k + ns(au.u)
        dts_out = None if k is None or au.du is None else k + ns(au.du)
        if out is None or out < 0 or (dts_out is not None and dts_out < 0):
            # Unjoined: tsdemux's own timestamp, carried by the pad's last correction.
            d = ps["delta"]
            if d is not None:
                if pts != Gst.CLOCK_TIME_NONE and pts + d >= 0:
                    buf.pts = pts + d
                if dts != Gst.CLOCK_TIME_NONE and dts + d >= 0:
                    buf.dts = dts + d
            if not ps["logged"]:
                ps["logged"] = True
                log(st, f"{pad.get_name()} pid=0x{ps['pid']:x} an access unit did not "
                                f"join its PES — passed on tsdemux's timestamp"
                                + ("" if d is None else f" + the pad's last correction ({d / 1e6:+.3f} ms)")
                                + " (logged once per pad)")
            return Gst.PadProbeReturn.OK
        buf.pts = out
        if dts_out is not None:
            buf.dts = dts_out
        elif dts != Gst.CLOCK_TIME_NONE:
            buf.dts = out                        # no PES DTS: decode at presentation
        if pts != Gst.CLOCK_TIME_NONE:
            ps["delta"] = out - pts
        return Gst.PadProbeReturn.OK

    def on_pad_added(_element, pad):
        pad_name = pad.get_name() or ""
        if not (pad_name.startswith("audio_") or pad_name.startswith("video_")):
            return
        pid = pid_of(pad_name)
        if pid is not None:
            pad.add_probe(Gst.PadProbeType.BUFFER, on_out,
                          {"pid": pid, "off": None, "delta": None, "logged": False})

    sink_pad.add_probe(Gst.PadProbeType.BUFFER | Gst.PadProbeType.EVENT_DOWNSTREAM
                       | Gst.PadProbeType.EVENT_FLUSH, on_sink)
    demux.connect("pad-added", on_pad_added)
