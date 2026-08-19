/**
 * Hand-built MPEG-TS fixtures for the tests of anything that reads PES PTS —
 * today the two producer conformance suites (`unixfdbus-core` fan-out sidecars,
 * `ts-splitter` mr-tssplit) and whatever joins them.
 *
 * WHY here and not in each suite: the fixtures are the *input side* of the
 * time-sync contract, and both suites assert on stamps derived from them. Two
 * copies of `pesPacket` — which is what there were — is two chances for a
 * fixture to drift and one suite to be asserting about a stream shape the other
 * no longer produces. mpegts-core is the library plugin that owns the TS domain
 * (ADR-0001), so its `tests/` is where cross-plugin TS test material belongs;
 * both suites import it by relative path (test files are not compiled by any
 * plugin's tsconfig, so no package export is involved).
 *
 * The layouts match what `ts_psi.read_pes_pts` (py and C++) parses — the same
 * bytes `ts_psi_test.py` and `gst_bus_stamper_test.py` build.
 */

export const PTS_WRAP = 1n << 33n;

/** 40 ms per rung in 90 kHz ticks — one video frame at 25 fps. */
export const STEP = 3600n;

/** 90 kHz ticks → ns, exactly as every implementation computes it. */
export const toNs = (ticks: bigint) => (ticks * 100000n) / 9n;

/**
 * One TS packet carrying a PES header with `pts90k` — payload starts
 * 00 00 01 <stream_id>, then length, the '10' marker byte, PTS_DTS_flags and
 * the 5-byte PTS. Values past 33 bits wrap, as the wire counter does.
 */
export function pesPacket(pid: number, pts90k: bigint): Buffer {
    const pkt = Buffer.alloc(188, 0xff);
    pkt[0] = 0x47;
    pkt[1] = 0x40 | ((pid >> 8) & 0x1f); // PUSI
    pkt[2] = pid & 0xff;
    pkt[3] = 0x10;
    const p = pts90k & (PTS_WRAP - 1n);
    const bits = (hi: bigint, lo: bigint) => Number((p >> lo) & ((1n << (hi - lo + 1n)) - 1n));
    pkt.set(
        [0x00, 0x00, 0x01, 0xe0, 0x00, 0x00, 0x80, 0x80, 0x05,
         0x21 | (bits(32n, 30n) << 1),
         bits(29n, 22n),
         0x01 | (bits(21n, 15n) << 1),
         bits(14n, 7n),
         0x01 | (bits(6n, 0n) << 1)],
        4,
    );
    return pkt;
}

/** A packet with NO PES header (null PID) — the staircase must still cover it. */
export function fillerPacket(): Buffer {
    const pkt = Buffer.alloc(188, 0xaa);
    pkt[0] = 0x47;
    pkt[1] = 0x1f;
    pkt[2] = 0xff;
    pkt[3] = 0x10;
    return pkt;
}

export interface LadderOptions {
    /** PIDs carrying each rung. More than one interleaves them (an A/V pair). */
    pids?: number[];
    /** PTS lead of each further PID over the first, in 90 kHz ticks. */
    skew?: bigint;
    /** Pad each rung to this many TS packets with PES-less fillers. */
    packetsPerRung?: number;
}

/**
 * A fixture whose PES ladder is known EXACTLY: `ladder` gives the PES PTS per
 * rung, so a caller can express a 2^33 wrap, a shed run (a gap in the ladder)
 * or a source discontinuity directly.
 *
 * `packetsPerRung` exists because a sidecar that chunks its ingest at a fixed
 * size makes rung k broadcast buffer k only if the rung is exactly that size;
 * `pids`/`skew` because a splitter's whole claim is that its per-PID outputs
 * stay mutually aligned, which needs an interleaved A/V pair to test.
 */
export function ladderFixture(ladder: bigint[], opts: LadderOptions = {}): Buffer {
    const { pids = [0x100], skew = 0n, packetsPerRung = 1 } = opts;
    const parts: Buffer[] = [];
    for (const pts of ladder) {
        pids.forEach((pid, i) => parts.push(pesPacket(pid, pts + BigInt(i) * skew)));
        for (let i = pids.length; i < packetsPerRung; i++) parts.push(fillerPacket());
    }
    return Buffer.concat(parts);
}

/** `n` rungs from `first`, `step` apart — the common ladder shape. */
export const rungs = (n: number, first: bigint, step = STEP): bigint[] =>
    Array.from({ length: n }, (_, i) => first + BigInt(i) * step);
