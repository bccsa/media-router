import { describe, it, expect, vi, beforeAll } from 'vitest';
import {
    HAVE_INGEST_QUEUE_RIG,
    ingestChain,
    runIngestQueueRig,
    type RigCase,
} from '../../../packages/engine/src/child-process/testing/ingestQueueRig';
import { RistInputModule } from '../engine/RistInputModule.js';

// B-182, srt-input's rule on librist's output: the module's chain behind mrristsrc under a
// real-time high-bitrate feed, its output stalled once (ingest_queue_rig.py).

function chain(): string {
    const module = new RistInputModule() as any;
    module.services = {
        instanceId: 'rist-in-1',
        mediaRouter: { assignBusChannel: vi.fn(), getBusChannel: vi.fn(() => ({ port: 41000 })) },
    };
    module.config = {};
    module.log = { warn: vi.fn(), debug: vi.fn() };
    return ingestChain(module.buildPipeline({}).pipeline);
}

describe.skipIf(!HAVE_INGEST_QUEUE_RIG)('RistInputModule under a high-bitrate feed (B-182)', () => {
    let results: RigCase[] = [];
    beforeAll(() => {
        results = runIngestQueueRig(chain(), ['40:500', '40:40:150', '40:2000']);
    }, 180_000);

    it('runs the chain the module builds: the restamp, then the ingest queue', () => {
        expect(chain()).toMatch(/^mrtsrestamp name=restamp [^!]* ! queue name=ingestq [^!]*$/);
    });

    it('loses nothing at 40 Mbit/s through a 500 ms stall, or a 150 ms stamp step while it holds data', () => {
        for (const r of results.slice(0, 2)) {
            expect(r.error).toBeNull();
            expect([r.lost, r.overruns]).toEqual([0, 0]);
        }
    });

    it('never holds mrristsrc: past its bound it sheds, one overrun per buffer', () => {
        const r = results[2];
        expect(r.error).toBeNull();
        // Held, mrristsrc would lose nothing: the data past the bound would wait behind it.
        expect(r.lost).toBeGreaterThan(0);
        expect(r.overruns - r.lost).toBeGreaterThanOrEqual(0);
        expect(r.overruns - r.lost).toBeLessThanOrEqual(1);
    });
});
