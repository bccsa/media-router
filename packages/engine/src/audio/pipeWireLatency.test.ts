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
const props = (id: number) => nodes.find((o) => o.id === id)?.info?.props ?? {};
const mrNodes = nodes
    .map((o) => String(o.info?.props?.['node.name']))
    .filter((n) => n.startsWith('MR_PW_'));
/** The `node.latency` requests in driver group `id`, the driver's own included. */
const groupRequests = (id: number) =>
    new Set(
        nodes
            .filter((o) => (o.info?.props?.['node.driver-id'] ?? o.id) === id)
            .map((o) => o.info?.props?.['node.latency'])
            .filter(Boolean),
    );

/** Nobody in the group asks, empty `Latency` param: clock.quantum 1024 / clock.rate 48000. */
const GRAPH_CYCLE = { quantum: 1024, rate: 48000, latencyMs: 21.333333333333332 };
/** The fleet groups' smallest request (80) raised to clock.min-quantum 512. */
const MIN_CYCLE = { quantum: 512, rate: 48000, latencyMs: 10.666666666666666 };
const hop = (quantum: number) => ({ quantum, rate: 48000, latencyMs: (quantum / 48000) * 1000 });

const settings = (entries: Record<string, number>) => ({
    id: 1,
    type: 'PipeWire:Interface:Metadata',
    props: { 'metadata.name': 'settings' },
    metadata: Object.entries(entries).map(([key, value]) => ({ subject: 0, key, value })),
});
const core = (powerOfTwo: boolean) => ({
    id: 0,
    type: 'PipeWire:Interface:Core',
    info: { props: { 'clock.power-of-two-quantum': powerOfTwo } },
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
/** A stream following driver `driver` and asking `latency`. */
const stream = (id: number, driver: number, latency: string) =>
    node(id, { 'node.name': 'mr-gst-runner', 'node.driver-id': driver, 'node.latency': latency });

describe('nodeLatencyFromDump', () => {
    it("a decoder whose runner asks 1920/48000 reads its driver group's cycle, 512 (10.667 ms), not 40 ms", () => {
        // Group 84 (driver MR_PW_audio-encoder-825) also holds runner 87's 480 and the loopbacks'
        // 80; the smallest, raised to the fleet's clock.min-quantum 512, is what the group runs.
        expect([props(74)['node.name'], props(74)['node.driver-id']]).toEqual([
            'MR_PW_audio-decoder-5600',
            84,
        ]);
        expect([props(567)['node.driver-id'], props(567)['node.latency']]).toEqual([
            84,
            '1920/48000',
        ]);
        expect(groupRequests(84)).toEqual(new Set(['1920/48000', '480/48000', '80/48000']));
        expect(nodeLatencyFromDump(dump, 'MR_PW_audio-decoder-5600')).toEqual(MIN_CYCLE);
    });

    it('all 27 MR_PW nodes, in groups 84 and 93, read 512 (10.667 ms), the decoders with no runner linked (4137, 3212) included', () => {
        expect(mrNodes).toHaveLength(27);
        expect(groupRequests(93)).toEqual(new Set(['1920/48000', '480/48000', '80/48000']));
        expect(Object.fromEntries(mrNodes.map((n) => [n, nodeLatencyFromDump(dump, n)]))).toEqual(
            Object.fromEntries(mrNodes.map((n) => [n, MIN_CYCLE])),
        );
    });

    it('the smallest request in the group wins, whoever asks; another group does not count', () => {
        const g = [
            settings({ 'clock.rate': 48000, 'clock.quantum': 1024 }),
            node(10, { 'node.name': 'MR_PW_enc' }),
            stream(11, 10, '512/48000'),
            node(12, { 'node.name': 'MR_PW_dec', 'node.driver-id': 10 }),
            stream(13, 10, '1920/48000'),
            node(20, { 'node.name': 'MR_PW_other' }),
            stream(21, 20, '64/48000'),
        ];
        expect(nodeLatencyFromDump(g, 'MR_PW_dec')).toEqual(hop(512));
        expect(nodeLatencyFromDump(g, 'MR_PW_enc')).toEqual(hop(512));
        expect(nodeLatencyFromDump(g, 'MR_PW_other')).toEqual(hop(64));
    });

    it('a group whose only request is 1920/48000 runs 1024, rounded down to a power of two unless the core turns that off', () => {
        const g = (...extra: object[]) => [
            settings({ 'clock.rate': 48000, 'clock.quantum': 4096 }),
            ...extra,
            node(5, { 'node.name': 'MR_PW_d' }),
            stream(6, 5, '1920/48000'),
        ];
        expect(nodeLatencyFromDump(g(), 'MR_PW_d')).toEqual(hop(1024));
        expect(nodeLatencyFromDump(g(core(true)), 'MR_PW_d')).toEqual(hop(1024));
        expect(nodeLatencyFromDump(g(core(false)), 'MR_PW_d')).toEqual(hop(1920));
    });

    it('a group where nobody asks runs clock.quantum', () => {
        const g = [
            settings({ 'clock.rate': 48000, 'clock.quantum': 1024 }),
            node(5, { 'node.name': 'MR_PW_drv' }),
            node(6, { 'node.name': 'MR_PW_n', 'node.driver-id': 5 }),
        ];
        expect(nodeLatencyFromDump(g, 'MR_PW_n')).toEqual(GRAPH_CYCLE);
    });

    it('clamps the group quantum to [clock.min-quantum, clock.max-quantum]', () => {
        const g = [
            settings({
                'clock.rate': 48000,
                'clock.quantum': 1024,
                'clock.min-quantum': 512,
                'clock.max-quantum': 2048,
            }),
            node(5, { 'node.name': 'MR_PW_lo' }),
            stream(6, 5, '80/48000'),
            node(7, { 'node.name': 'MR_PW_hi' }),
            stream(8, 7, '8192/48000'),
        ];
        expect(nodeLatencyFromDump(g, 'MR_PW_lo')).toEqual(hop(512));
        expect(nodeLatencyFromDump(g, 'MR_PW_hi')).toEqual(hop(2048));
    });

    it('a node with no node.driver-id heads its own group: its own request, else clock.quantum', () => {
        const g = [
            settings({ 'clock.rate': 48000, 'clock.quantum': 1024 }),
            node(5, { 'node.name': 'MR_PW_alone', 'node.latency': '256/48000' }),
            node(6, { 'node.name': 'MR_PW_idle' }),
            stream(7, 9, '64/48000'),
        ];
        expect(nodeLatencyFromDump(g, 'MR_PW_alone')).toEqual(hop(256));
        expect(nodeLatencyFromDump(g, 'MR_PW_idle')).toEqual(GRAPH_CYCLE);
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
        expect(nodeLatencyFromDump(g, 'MR_PW_out-1')).toEqual(hop(1024));
    });

    it('a forced quantum wins over every request in the group', () => {
        const g = [
            settings({ 'clock.rate': 48000, 'clock.quantum': 1024, 'clock.force-quantum': 256 }),
            node(5, { 'node.name': 'MR_PW_x', 'node.latency': '1024/48000' }),
            stream(6, 5, '1920/48000'),
        ];
        expect(nodeLatencyFromDump(g, 'MR_PW_x')).toEqual(hop(256));
    });

    it('adds the Latency param (quantum multiples, samples, ns) in its worst direction', () => {
        const g = [
            settings({ 'clock.rate': 48000, 'clock.quantum': 480 }),
            core(false),
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
        expect(m.get('MR_PW_audio-decoder-5600')).toEqual(MIN_CYCLE);
    });
});
