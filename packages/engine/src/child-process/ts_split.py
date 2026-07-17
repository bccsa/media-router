#!/usr/bin/env python3
"""Packet-level MPEG-TS splitter core — the transport-free heart of the
ts-splitter plugin (driven by gst-pipeline-runner.py's `tsSplit` glue).

Splits one muxed TS into per-PID single-ES SPTS outputs by forwarding the
selected PIDs' 188-byte packets AS THEY ARRIVE — no PES assembly, no
tsdemux→mpegtsmux round-trip. That is the whole point: a demuxer cannot emit
a frame until its last byte lands (a 535 KB I-frame is ~220 ms of wire time
at 19.6 Mbps, measured on gate01), so its outputs are hold-and-burst even
when the wire is smooth. Packet pass-through inherits the wire cadence.

Ported from the abandoned feat-ts-splitter-combiner branch's tsduck-runner
Splitter/Output (split mode never used TSDuck), reworked for the embedded
appsink/appsrc shape:
  - ONE routing pass per input buffer (dict bucket by PID) instead of the
    branch's per-output packet rescan — O(pkts), not O(outputs × pkts).
  - One joined bytes payload per (input buffer, output) — the caller makes
    exactly one appsrc push per entry of the dict `feed()` returns. Batching
    never crosses input buffers: packets that arrived together leave
    together, with zero added latency.
  - No sockets, no threads, no Gst: bytes in, {pid: bytes} out. Unit-tested
    by ts_split_test.py (`python3 ts_split_test.py`).

Per-output SPTS surgery (branch-proven values):
  - Fresh PAT + single-ES PMT (on PID 0x1000) injected before the first ES
    packet and at least every 40 ES packets (~5% overhead) so any consumer
    joining mid-stream locks fast.
  - Outputs whose PID is not the source's PCR PID get the source's master
    PCR re-injected on its own cadence (>= 10 ms coalesce floor) as
    adaptation-only packets. The source clock is copied, never fabricated,
    and CC is stamped from the PID's last payload packet (adaptation-only
    packets do not advance CC per ISO 13818-1).
  - ES packets pass through byte-identical — source continuity counters are
    preserved, so downstream CC accounting sees exactly the wire.

Not ported (v1): KLV/SDT stream naming (the mpegts-demuxer keeps that duty),
add_output/remove_output runtime protocol (outputs are fixed per pipeline
build; the engine rebuilds the module when a newly discovered port is first
wired).
"""
from __future__ import annotations

import ts_psi

PKT = ts_psi.PKT
SYNC = ts_psi.SYNC
SPLIT_PMT_PID = 0x1000
SPLIT_PSI_INTERVAL_PKTS = 40
SPLIT_PCR_MIN_TICKS = ts_psi.PCR_HZ // 100        # coalesce floor: >= 10 ms between injected PCRs


class SplitOutput:
    """One per-PID SPTS output: PSI carousel + optional PCR re-injection."""

    def __init__(self, pid: int, ts_id: int, stream_type=None):
        self.pid = pid
        self.ts_id = ts_id
        self.stream_type = stream_type if stream_type is not None else ts_psi.STREAM_TYPE_AVC
        self.needs_pcr = False       # set on discovery: True when pid != source PCR pid
        self.cc_pat = 0
        self.cc_pmt = 0
        self.last_cc = 0             # last payload CC on this PID (stamped onto PCR-only packets)
        self.last_pcr = None
        self.since_psi = SPLIT_PSI_INTERVAL_PKTS   # force PSI before the first ES

    def psi(self):
        pat = ts_psi.build_pat(self.ts_id, {1: SPLIT_PMT_PID}, self.cc_pat)
        self.cc_pat = (self.cc_pat + 1) & 0x0F
        pmt = ts_psi.build_pmt(SPLIT_PMT_PID, 1, self.pid,
                               [(self.pid, self.stream_type)], self.cc_pmt)
        self.cc_pmt = (self.cc_pmt + 1) & 0x0F
        return [pat, pmt]

    def batch(self, es_chunks, master_pcr) -> bytes:
        """Join one input buffer's worth of this PID's packets into a single
        output payload, prefixed by due PSI / PCR packets."""
        out = []
        self.since_psi += len(es_chunks)
        if self.since_psi >= SPLIT_PSI_INTERVAL_PKTS:
            out += self.psi()
            self.since_psi = 0
        if self.needs_pcr and master_pcr is not None and master_pcr != self.last_pcr and \
                (self.last_pcr is None or
                 (master_pcr - self.last_pcr) % ts_psi.PCR_MODULO >= SPLIT_PCR_MIN_TICKS):
            out.append(ts_psi.build_pcr_packet(self.pid, master_pcr, self.last_cc))
            self.last_pcr = master_pcr
        out += es_chunks
        self.last_cc = es_chunks[-1][3] & 0x0F
        return b"".join(out)


class SplitterCore:
    """Single-pass PID router. feed(bytes) -> {pid: joined SPTS bytes}.

    `outputs`: iterable of (pid, stream_type_or_None).
    `on_discovered(streams, pcr_pid)`: called (from feed's thread) when the
    source PMT first parses or changes; `streams` is [(pid, stream_type), ...].
    `on_desync(dropped_bytes)`: optional, rate-limited by the caller's cadence
    (fires once per feed() call that had to resync).
    """

    def __init__(self, ts_id: int, outputs, on_discovered=None, on_desync=None):
        self.outputs = {int(pid): SplitOutput(int(pid), ts_id, stype)
                        for pid, stype in outputs}
        self.disc = ts_psi.PsiDiscovery()
        self.on_discovered = on_discovered
        self.on_desync = on_desync
        self.pcr_pid = None
        self.master_pcr = None
        self.desync_bytes = 0        # lifetime counter, readable by the glue
        self._rem = b""
        self._enabled = set(self.outputs)
        self._routing = dict(self.outputs)   # enabled subset used by feed()

    def set_enabled(self, pids):
        """Gate which outputs are produced (wired-only mode). A pid outside
        the enabled set is discarded at the routing lookup — no bucket, no
        join, no PSI rewrite, no push. A pin transitioning to enabled gets
        its PSI carousel and PCR re-injection forced so a fresh consumer
        locks on the very first batch."""
        pids = {int(p) for p in pids} & set(self.outputs)
        for pid in pids - self._enabled:
            o = self.outputs[pid]
            o.since_psi = SPLIT_PSI_INTERVAL_PKTS
            o.last_pcr = None
        self._enabled = pids
        self._routing = {pid: self.outputs[pid] for pid in pids}

    def _apply_discovery(self):
        streams = list(self.disc.pmt["streams"])
        self.pcr_pid = self.disc.pmt["pcr_pid"]
        known = dict(streams)
        for pid, o in self.outputs.items():
            if pid in known:
                o.stream_type = known[pid]
            o.needs_pcr = pid != self.pcr_pid
        if self.on_discovered is not None:
            self.on_discovered(streams, self.pcr_pid)

    def feed(self, data: bytes):
        """Route one input buffer. Returns {pid: bytes} — one entry per output
        that received packets from this buffer (possibly empty dict)."""
        if self._rem:
            data = self._rem + data
            self._rem = b""
        n = len(data)
        mv = memoryview(data)
        buckets = {}
        psi_pkts = []
        outputs = self._routing            # enabled subset (see set_enabled)
        pmt_pid_before = self.disc.pmt_pid
        pcr_pid = self.pcr_pid
        off = 0
        desynced = 0
        while off + PKT <= n:
            if data[off] != SYNC:
                # Lost sync (wire loss / unaligned producer): scan for a sync
                # byte confirmed by another sync one packet later (or by the
                # buffer edge), drop the garbage span.
                scan = off + 1
                while scan + PKT <= n and not (
                        data[scan] == SYNC and
                        (scan + 2 * PKT > n or data[scan + PKT] == SYNC)):
                    scan += 1
                desynced += scan - off
                off = scan
                continue
            pid = ((data[off + 1] & 0x1F) << 8) | data[off + 2]
            if pid in outputs:
                buckets.setdefault(pid, []).append(mv[off:off + PKT])
            if pid == 0 or (pmt_pid_before is not None and pid == pmt_pid_before):
                psi_pkts.append(data[off:off + PKT])   # real copy: discovery retains these
            if pid == pcr_pid:
                v = ts_psi.read_pcr(mv[off:off + PKT])
                if v is not None:
                    self.master_pcr = v
            off += PKT
        # Remainder = wherever the pass actually stopped (a desync can leave
        # the tail unaligned — never pre-compute this from len(data) alone).
        self._rem = data[off:]
        if desynced:
            self.desync_bytes += desynced
            if self.on_desync is not None:
                self.on_desync(desynced)
        # Feed discovery every call (empty is fine): _n drives its periodic
        # PMT re-parse, keeping change detection at the branch's cadence.
        if self.disc.feed(psi_pkts):
            self._apply_discovery()
        if pmt_pid_before is None and self.disc.pmt_pid is not None:
            # The PAT parsed from THIS buffer — its PMT packets are typically
            # adjacent in the same buffer and were not captured above (the
            # pmt_pid was unknown during the pass). One targeted re-scan,
            # once per stream lifetime, so single-buffer PAT+PMT discovers
            # immediately (a whole-file feed would otherwise never discover).
            new_pid = self.disc.pmt_pid
            late = [data[o:o + PKT] for o in range(0, (n // PKT) * PKT, PKT)
                    if data[o] == SYNC and
                    (((data[o + 1] & 0x1F) << 8) | data[o + 2]) == new_pid]
            if late and self.disc.feed(late):
                self._apply_discovery()
        master = self.master_pcr
        return {pid: outputs[pid].batch(chunks, master)
                for pid, chunks in buckets.items()}
