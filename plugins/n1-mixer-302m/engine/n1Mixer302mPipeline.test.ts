import { describe, it, expect } from 'vitest';
import type { AudioMixSource } from '@media-router/engine';
import {
    activeOutputIndices,
    buildN1Pipeline,
    buildN1Ports,
    readPairCount,
    type N1Output,
} from './n1Mixer302mPipeline.js';

function mkSource(i: number, n = 0): AudioMixSource {
    return {
        port: 40100 + i * 10 + n,
        connectionId: `c-${i}-${n}`,
        socketPath: `/tmp/mr-bus-${40100 + i * 10 + n}-abcdef.sock`,
    };
}

function mkInputs(indices: number[], sourcesPer = 1): Map<number, AudioMixSource[]> {
    return new Map(
        indices.map((i) => [i, Array.from({ length: sourcesPer }, (_, n) => mkSource(i, n))]),
    );
}

function mkOutputs(indices: number[]): N1Output[] {
    return indices.map((o) => ({ index: o, port: 40200 + o }));
}

describe('readPairCount', () => {
    it('defaults to 4 and clamps to 2–16', () => {
        expect(readPairCount({})).toBe(4);
        expect(readPairCount({ pairCount: 'junk' })).toBe(4);
        expect(readPairCount({ pairCount: 2 })).toBe(2);
        expect(readPairCount({ pairCount: 0 })).toBe(2);
        expect(readPairCount({ pairCount: 99 })).toBe(16);
    });
});

describe('buildN1Ports', () => {
    it('generates N input + N output 302M ports', () => {
        const ports = buildN1Ports(4);
        expect(ports).toHaveLength(8);
        expect(ports[0]).toEqual({
            id: 'in-0',
            direction: 'input',
            streamType: 'audio/302m',
            label: 'In 1',
            maxConnections: -1,
        });
        expect(ports[4]).toEqual({
            id: 'out-0',
            direction: 'output',
            streamType: 'audio/302m',
            label: 'Out 1 (N-1)',
            maxConnections: -1,
            requiresOrderedApply: true,
        });
    });

    it('scales to the pair-count bounds', () => {
        expect(buildN1Ports(2)).toHaveLength(4);
        expect(buildN1Ports(16)).toHaveLength(32);
    });
});

describe('activeOutputIndices', () => {
    it('an output is active when any OTHER input is connected', () => {
        expect(activeOutputIndices([0, 1, 2, 3], 4)).toEqual([0, 1, 2, 3]);
        expect(activeOutputIndices([2], 4)).toEqual([0, 1, 3]);
        expect(activeOutputIndices([1], 2)).toEqual([0]);
        expect(activeOutputIndices([], 4)).toEqual([]);
    });
});

describe('buildN1Pipeline', () => {
    it('returns null with no inputs or no outputs', () => {
        expect(buildN1Pipeline({ inputs: new Map(), outputs: mkOutputs([0]), latencyMs: 200 })).toBeNull();
        expect(buildN1Pipeline({ inputs: mkInputs([0]), outputs: [], latencyMs: 200 })).toBeNull();
    });

    it('builds the full N·(N-1) exclusion matrix with no self-branch', () => {
        const pipeline = buildN1Pipeline({
            inputs: mkInputs([0, 1, 2, 3]),
            outputs: mkOutputs([0, 1, 2, 3]),
            latencyMs: 200,
        })!;
        const matrix = [...pipeline.matchAll(/in(\d+)t\. ! queue [^!]+! omix(\d+)\./g)];
        expect(matrix).toHaveLength(12);
        for (const [, i, o] of matrix) expect(i).not.toBe(o);
        for (let i = 0; i < 4; i++) {
            expect(pipeline).toContain(`audiomixer name=inmix${i} force-live=true`);
            expect(pipeline).toContain(`tee name=in${i}t`);
            expect(pipeline).toContain(`audiomixer name=omix${i} force-live=true`);
        }
        // One 302M encode + bus sink per output, one decode per source branch.
        expect(pipeline.match(/avenc_s302m/g)).toHaveLength(4);
        expect(pipeline.match(/avdec_s302m/g)).toHaveLength(4);
        expect(pipeline).toContain(
            'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! tee name=busout_40200 allow-not-linked=true',
        );
        expect(pipeline.match(/tee name=busout_/g)).toHaveLength(4);
    });

    it('sums multiple sources wired to one input port', () => {
        const pipeline = buildN1Pipeline({
            inputs: mkInputs([0, 1], 3),
            outputs: mkOutputs([0, 1]),
            latencyMs: 200,
        })!;
        expect(pipeline.match(/! inmix0\./g)).toHaveLength(3);
        expect(pipeline.match(/! inmix1\./g)).toHaveLength(3);
    });

    it('single connected input feeds every output except its own pair', () => {
        const pipeline = buildN1Pipeline({
            inputs: mkInputs([1]),
            outputs: mkOutputs([0, 2, 3]),
            latencyMs: 200,
        })!;
        expect(pipeline).not.toContain('omix1');
        for (const o of [0, 2, 3]) {
            expect(pipeline).toContain(`in1t. ! queue leaky=0 max-size-time=500000000 max-size-buffers=0 max-size-bytes=0 ! omix${o}.`);
        }
    });

    it('never builds a pad-less output mixer — self-only output is dropped', () => {
        expect(
            buildN1Pipeline({ inputs: mkInputs([1]), outputs: mkOutputs([1]), latencyMs: 200 }),
        ).toBeNull();
    });

    it('N=2 is a pure cross-feed', () => {
        const pipeline = buildN1Pipeline({
            inputs: mkInputs([0, 1]),
            outputs: mkOutputs([0, 1]),
            latencyMs: 200,
        })!;
        const matrix = [...pipeline.matchAll(/in(\d+)t\. ! queue [^!]+! omix(\d+)\./g)];
        expect(matrix.map(([, i, o]) => `${i}>${o}`).sort()).toEqual(['0>1', '1>0']);
    });

    it('honours the mix latency budget on the input mixers only', () => {
        const pipeline = buildN1Pipeline({
            inputs: mkInputs([0, 1]),
            outputs: mkOutputs([0, 1]),
            latencyMs: 500,
        })!;
        expect(pipeline).toContain('audiomixer name=inmix0 force-live=true latency=500000000');
        expect(pipeline).toContain('audiomixer name=omix0 force-live=true latency=50000000');
    });

    it('per-edge unixfd sockets in, fan-out tees out', () => {
        const pipeline = buildN1Pipeline({
            inputs: mkInputs([0, 1]),
            outputs: mkOutputs([0, 1]),
            latencyMs: 200,
        })!;
        expect(pipeline).toContain('unixfdsrc');
        expect(pipeline).toContain('socket-path=/tmp/mr-bus-40100-abcdef.sock');
        expect(pipeline).toContain('tee name=busout_40200 allow-not-linked=true');
        expect(pipeline).toContain('tee name=busout_40201 allow-not-linked=true');
        expect(pipeline).not.toContain('udpsink');
    });
});
