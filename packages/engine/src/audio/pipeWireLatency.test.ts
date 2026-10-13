import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nodeLatencyFromDump, readNodeLatency } from './pipeWireLatency.js';

// Captured with `pw-dump` on the dev Pi 5 (PipeWire 1.2.7): a stream node
// asking for 1024/48000, which PipeWire reports reduced as `8/375`.
const dump = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'pw-dump-dev.json'), 'utf8'),
) as unknown[];

const settings = (entries: Record<string, number>) => ({
    id: 1,
    type: 'PipeWire:Interface:Metadata',
    props: { 'metadata.name': 'settings' },
    metadata: Object.entries(entries).map(([key, value]) => ({ subject: 0, key, value })),
});
const node = (
    id: number,
    props: Record<string, unknown>,
    params: Record<string, unknown> = {},
) => ({
    id,
    type: 'PipeWire:Interface:Node',
    info: { props, params },
});

describe('nodeLatencyFromDump', () => {
    it('reads the requested quantum off a captured node (node.latency, node.rate)', () => {
        expect(nodeLatencyFromDump(dump, 'MR_PW_out-1')).toEqual({
            quantum: 1024,
            rate: 48000,
            latencyMs: (1024 / 48000) * 1000,
        });
    });

    it('a node without a request runs at the graph quantum from the settings metadata', () => {
        const l = nodeLatencyFromDump(dump, 'Dummy-Driver');
        expect(l).toEqual({ quantum: 4096, rate: 48000, latencyMs: (4096 / 48000) * 1000 });
    });

    it('a forced quantum wins over the request', () => {
        const g = [
            settings({ 'clock.rate': 48000, 'clock.quantum': 1024, 'clock.force-quantum': 256 }),
            node(5, { 'node.name': 'MR_PW_x', 'node.latency': '1024/48000' }),
        ];
        expect(nodeLatencyFromDump(g, 'MR_PW_x')?.quantum).toBe(256);
    });

    it('adds the Latency param (quantum multiples, samples, ns) in its worst direction', () => {
        const g = [
            settings({ 'clock.rate': 48000, 'clock.quantum': 480 }),
            node(
                7,
                { 'node.name': 'MR_PW_y' },
                {
                    Latency: [
                        { direction: 'Input', maxQuantum: 1, maxRate: 0, maxNs: 0 },
                        { direction: 'Output', maxQuantum: 1, maxRate: 240, maxNs: 2_000_000 },
                    ],
                },
            ),
        ];
        // 480-sample cycle (10 ms) + 480 + 240 param samples (15 ms) + 2 ms.
        expect(nodeLatencyFromDump(g, 'MR_PW_y')?.latencyMs).toBeCloseTo(10 + 15 + 2, 6);
    });

    it('takes the newest of two same-named nodes and null for a missing one', () => {
        const g = [
            settings({ 'clock.rate': 48000, 'clock.quantum': 1024 }),
            node(3, { 'node.name': 'MR_PW_z', 'node.latency': '256/48000' }),
            node(9, { 'node.name': 'MR_PW_z', 'node.latency': '512/48000' }),
        ];
        expect(nodeLatencyFromDump(g, 'MR_PW_z')?.quantum).toBe(512);
        expect(nodeLatencyFromDump(g, 'MR_PW_none')).toBeNull();
    });
});

describe('readNodeLatency', () => {
    it('one dump, every node that exists', async () => {
        const m = await readNodeLatency(['MR_PW_out-1', 'MR_PW_gone'], async () => dump);
        expect([...m.keys()]).toEqual(['MR_PW_out-1']);
        expect(m.get('MR_PW_out-1')?.quantum).toBe(1024);
    });
});
