import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nodeLatencyFromDump, readNodeLatency } from './pipeWireLatency.js';

// `pw-dump` of a fleet Pi 5 running audio-decoder, audio-encoder and n1-mixer (PipeWire 1.6.3),
// cut by fixtures/fixture-reduce.py to the objects this module reads.
type Node = { id: number; type: string; info?: { props?: Record<string, unknown> } };
const dump = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'pw-dump-fleet.json'), 'utf8'),
) as Node[];
const nodes = dump.filter((o) => o.type === 'PipeWire:Interface:Node');
const named = (name: string) => nodes.filter((o) => o.info?.props?.['node.name'] === name);
const mrNodes = nodes
    .map((o) => String(o.info?.props?.['node.name']))
    .filter((n) => n.startsWith('MR_PW_'));

/** No request, empty `Latency` param: the graph cycle, clock.quantum 1024 / clock.rate 48000. */
const GRAPH_CYCLE = { quantum: 1024, rate: 48000, latencyMs: 21.333333333333332 };

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
    it('an MR_PW null sink (audio-decoder, audio-encoder, n1-mixer in/out) asks no latency: graph cycle 1024 / 48000 = 21.333 ms', () => {
        for (const name of [
            'MR_PW_audio-decoder-5600',
            'MR_PW_audio-encoder-825',
            'MR_PW_n1-mixer-mr5g8qqnkas7_in_0',
            'MR_PW_n1-mixer-mr5g8qqnkas7_out_0',
        ]) {
            expect(nodeLatencyFromDump(dump, name), name).toEqual(GRAPH_CYCLE);
        }
    });

    it('all 27 MR_PW nodes in the capture read that same graph cycle', () => {
        expect(mrNodes).toHaveLength(27);
        for (const name of mrNodes)
            expect(nodeLatencyFromDump(dump, name), name).toEqual(GRAPH_CYCLE);
    });

    it('a runner stream asking node.latency 1920/48000 at node.rate 1/48000 runs 1920 samples = 40 ms; of nine same-named streams the newest (id 579) wins over the six asking 480', () => {
        const runners = named('mr-gst-runner');
        const asked = runners.map((o) => o.info?.props?.['node.latency']);
        expect(asked.filter((a) => a === '480/48000')).toHaveLength(6);
        expect(asked.filter((a) => a === '1920/48000')).toHaveLength(3);
        const newest = runners.reduce((a, b) => (b.id > a.id ? b : a));
        expect([newest.id, newest.info?.props?.['node.latency']]).toEqual([579, '1920/48000']);
        expect(nodeLatencyFromDump(dump, 'mr-gst-runner')).toEqual({
            quantum: 1920,
            rate: 48000,
            latencyMs: 40,
        });
    });

    it('a request PipeWire 1.2.7 (dev Pi 5) reports reduced, 1024/48000 as 8/375, still reads 1024', () => {
        const g = [
            settings({ 'clock.rate': 48000, 'clock.quantum': 4096 }),
            node(71, {
                'node.name': 'MR_PW_out-1',
                'node.latency': '8/375',
                'node.rate': '1/48000',
            }),
        ];
        expect(nodeLatencyFromDump(g, 'MR_PW_out-1')).toEqual({
            quantum: 1024,
            rate: 48000,
            latencyMs: (1024 / 48000) * 1000,
        });
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
        const m = await readNodeLatency(
            ['MR_PW_audio-decoder-5600', 'MR_PW_gone'],
            async () => dump,
        );
        expect([...m.keys()]).toEqual(['MR_PW_audio-decoder-5600']);
        expect(m.get('MR_PW_audio-decoder-5600')).toEqual(GRAPH_CYCLE);
    });
});
