import { describe, it, expect, vi, beforeAll } from 'vitest';
import {
    HAVE_INGEST_QUEUE_RIG,
    ingestChain,
    runIngestQueueRig,
    stallBacklogBytes,
    type RigCase,
} from '../../../packages/engine/src/child-process/testing/ingestQueueRig';
import { SrtInputModule } from '../engine/SrtInputModule.js';

// B-182: the module's chain behind srtsrc (the restamp and the ingest queue) under a real-time
// feed of 1,316-byte buffers on send-time stamps, its output stalled once (ingest_queue_rig.py).

function chain(): string {
    const module = new SrtInputModule() as any;
    module.services = {
        instanceId: 'srt-in-1',
        mediaRouter: { assignBusChannel: vi.fn(), getBusChannel: vi.fn(() => ({ port: 41000 })) },
    };
    module.config = {};
    module.log = { warn: vi.fn(), debug: vi.fn() };
    return ingestChain(module.buildPipeline({}).pipeline);
}

const STALLS: Array<[number, number]> = [28, 40].flatMap((rate) =>
    [100, 300, 500].map((stall): [number, number] => [rate, stall]),
);

describe.skipIf(!HAVE_INGEST_QUEUE_RIG)('SrtInputModule under a high-bitrate feed (B-182)', () => {
    let results: RigCase[] = [];
    const at = (rate: number, stall: number, step = 0) =>
        results.find((r) => r.rateMbps === rate && r.stallMs === stall && r.stepMs === step)!;

    beforeAll(() => {
        results = runIngestQueueRig(chain(), [
            ...STALLS.map(([rate, stall]) => `${rate}:${stall}`),
            '28:40:150',
            '40:40:150',
            '40:2000',
        ]);
    }, 180_000);

    it('runs the chain the module builds: the restamp, then the ingest queue', () => {
        expect(chain()).toMatch(/^mrtsrestamp name=restamp [^!]* ! queue name=ingestq [^!]*$/);
    });

    it.each(STALLS)('loses nothing at %i Mbit/s through a %i ms stall of its output', (rate, stall) => {
        const r = at(rate, stall);
        expect(r.error).toBeNull();
        expect([r.lost, r.overruns]).toEqual([0, 0]);
        // The hold was real: the whole stall's data waited in the queue.
        expect(r.heldLevelBytes).toBeGreaterThan(0.95 * stallBacklogBytes(r));
    });

    it.each([28, 40])(
        'loses nothing at %i Mbit/s when the send-time stamps step 150 ms while it holds data',
        (rate) => {
            const r = at(rate, 40, 150);
            expect(r.error).toBeNull();
            expect([r.lost, r.overruns]).toEqual([0, 0]);
        },
    );

    it('never holds srtsrc: 2 s stalled at 40 Mbit/s, it keeps its 4 MB and sheds the rest, each counted', () => {
        const r = at(40, 2000);
        expect(r.error).toBeNull();
        // A queue that held srtsrc, on whose thread the restamp reads arrival, would lose nothing
        // here: the 6 MB past its bound would wait behind the restamp instead.
        expect(r.heldLevelBytes).toBeGreaterThan(4_000_000 - 1316);
        expect(r.maxLevelBytes).toBeLessThanOrEqual(4_000_000 + 1316);
        expect(r.lost).toBeGreaterThan((0.9 * (stallBacklogBytes(r) - 4_000_000)) / 1316);
        // One overrun per buffer shed, what the runner counts (shed_watch.cpp); one more if the
        // stall ended while the last was signalled, as the queue then found room.
        expect(r.overruns - r.lost).toBeGreaterThanOrEqual(0);
        expect(r.overruns - r.lost).toBeLessThanOrEqual(1);
    });
});
