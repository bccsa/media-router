import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { buildPipeline } from '../engine/mpegtsMuxerPipeline.js';

/**
 * The muxer's aggregation timing against REAL GStreamer (muxTiming.ts): the
 * `mpegtsmux` element the builder emits, fed on the runner's contract clock by
 * a video input 200 ms behind its stamps and an audio input on time
 * (`mux_timing_probe.py`). Under the contract no audio PES may wait for the
 * video, and every video frame carries a PCR; the legacy element must still
 * show the hold and its every-other-frame PCR, so the probe cannot pass
 * vacuously.
 *
 * Skipped (loudly) where python3-gi or the elements are missing.
 */

const PROBE = join(__dirname, 'mux_timing_probe.py');
const LAG_MS = 200;

interface Hold {
    n: number;
    p50: number;
    p95: number;
    max: number;
}
interface Run {
    latencyMs: number | null;
    audioIn: number;
    videoIn: number;
    audioHoldMs: Hold;
    videoHoldMs: Hold;
    ccErrors: number;
    dtsBackward: number;
    ptsBeforeDts: number;
    pcrMaxDeltaMs: number;
}

const probe = (() => {
    const r = spawnSync('python3', [PROBE, 'elements'], { encoding: 'utf8', timeout: 60_000 });
    if (r.status !== 0) {
        return { ok: false, reason: `python3-gi/GStreamer unavailable: ${r.stderr?.trim()}` };
    }
    const missing = Object.entries(JSON.parse(r.stdout) as Record<string, boolean>)
        .filter(([, present]) => !present)
        .map(([n]) => n);
    return { ok: missing.length === 0, reason: `missing elements: ${missing.join(', ')}` };
})();

beforeAll(() => {
    if (!probe.ok) console.warn(`[mux timing] GStreamer suite skipped — ${probe.reason}`);
});

/** The `mpegtsmux …` element of a two-input mux (PIDs 250 video, 251 audio). */
function muxElement(timeSyncContract: boolean): string {
    const { pipeline } = buildPipeline({
        sources: [
            { sinkPortId: 'input-0', port: 40001, pid: 250 },
            { sinkPortId: 'input-1', port: 40002, pid: 251 },
        ],
        output: { port: 40010 },
        alignment: 7,
        timeSyncContract,
    })!;
    return pipeline.slice(0, pipeline.indexOf(' ! '));
}

function run(timeSyncContract: boolean): Run {
    const args = [PROBE, 'run', muxElement(timeSyncContract), '--lag-ms', String(LAG_MS)];
    const r = spawnSync('python3', args, { encoding: 'utf8', timeout: 60_000 });
    if (r.status !== 0) throw new Error(`probe failed: ${r.stderr || r.error}`);
    return JSON.parse(r.stdout) as Run;
}

describe.skipIf(!probe.ok)('mpegtsmux timing against real GStreamer', () => {
    it('under the contract every audio PES leaves on arrival and every video frame carries a PCR', () => {
        const out = run(true);
        expect(out.latencyMs).toBe(0);
        expect(out.audioHoldMs.n).toBe(out.audioIn);
        expect(out.videoHoldMs.n).toBe(out.videoIn);
        // ~0.5 ms measured; the bound only absorbs a loaded CI box.
        expect(out.audioHoldMs.p50).toBeLessThan(25);
        expect(out.videoHoldMs.p50).toBeLessThan(25);
        expect(out.ccErrors + out.dtsBackward + out.ptsBeforeDts).toBe(0);
        // A PCR on every 40 ms frame: the egress conditioner rewrites each PCR
        // from the lowest recent PTS, so their spacing is what keeps it inside
        // ISO 13818-1's 100 ms (muxTiming.ts).
        expect(out.pcrMaxDeltaMs).toBeLessThanOrEqual(40);
    }, 60_000);

    it('the legacy budget still holds audio for the video (the probe sees the fault)', () => {
        const out = run(false);
        expect(out.latencyMs).toBe(2400);
        expect(out.audioHoldMs.p50).toBeGreaterThan(LAG_MS / 2);
        // mpegtsmux's default 40 ms pcr-interval is strict: every other frame.
        expect(out.pcrMaxDeltaMs).toBeGreaterThan(60);
    }, 60_000);
});
