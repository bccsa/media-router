// The module tests' face on ingest_queue_rig.py (B-182): a network ingest's chain, as its module
// builds it, under a real-time high-bitrate feed whose output stalls once.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const RIG = join(__dirname, '..', 'ingest_queue_rig.py');
const PLUGINS = process.env.MR_PLUGINS_DIR ?? join(__dirname, '../../../../../plugins');
const SO = join(PLUGINS, 'mpegts-core/native/mrtshouse/libgstmrtshouse.so');

/** The rig runs here: the restamp's plugin is built and python3 has GStreamer. */
export const HAVE_INGEST_QUEUE_RIG =
    existsSync(SO) &&
    spawnSync('python3', ['-c', "import gi; gi.require_version('Gst', '1.0')"], { timeout: 30_000 })
        .status === 0;

/** One case: `lost` is what never reached the sink; `overruns`, the buffers that met the queue
 *  full; `heldLevelBytes`, the queue's level as the hold ends; `maxSrcLevelBytes`, the appsrc's own
 *  queue at its fullest (it fills only while the chain holds the transport's thread). */
export interface RigCase {
    rateMbps: number;
    stallMs: number;
    stepMs: number;
    pushed: number;
    lost: number;
    overruns: number;
    heldLevelBytes: number;
    maxLevelBytes: number;
    maxSrcLevelBytes: number;
    heldMs: number;
    error: string | null;
}

/** A module's elements between its transport source and its bus sink. */
export function ingestChain(pipeline: string): string {
    const parts = pipeline.split(' ! ');
    return parts.slice(1, parts.findIndex((p) => p.startsWith('capssetter'))).join(' ! ');
}

/** The cases (`<Mbit/s>:<stall ms>[:<stamp step ms>]`) in one run of the rig. */
export function runIngestQueueRig(chain: string, cases: string[]): RigCase[] {
    const r = spawnSync('python3', [RIG, chain, ...cases], { encoding: 'utf8', timeout: 180_000 });
    if (r.status !== 0) throw new Error(`ingest_queue_rig: ${r.stderr || r.error}`);
    const out = r.stdout
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
    if (out[0]?.skip) throw new Error(`ingest_queue_rig skipped: ${out[0].skip}`);
    return out;
}

/** The bytes a stall leaves waiting: rate × stall. */
export const stallBacklogBytes = (r: RigCase): number => (r.rateMbps * 1e6 * r.stallMs) / 8e3;
