import { describe, it, expect, vi, beforeEach } from 'vitest';
import { N1MixerModule } from './N1MixerModule.js';

// Mock PipeWireManager
function createMockPipeWire() {
    const loadedSinks: string[] = [];
    const loadedLoopbacks: Array<{ connId: string; source: string; sink: string }> = [];
    let moduleIdCounter = 100;

    return {
        loadedSinks,
        loadedLoopbacks,
        loadNullSink: vi.fn(async (name: string, _channels: number, _rate: number, _ownerId?: string) => {
            loadedSinks.push(`MR_PW_${name}`);
            return ++moduleIdCounter;
        }),
        waitForSink: vi.fn(async () => true),
        loadLoopback: vi.fn(async (connId: string, source: string, sink: string) => {
            loadedLoopbacks.push({ connId, source, sink });
            return ++moduleIdCounter;
        }),
        setSinkVolume: vi.fn(async () => {}),
        releaseAll: vi.fn(async () => {}),
    };
}

function createModule(pairCount = 4) {
    const module = new N1MixerModule();
    const pw = createMockPipeWire();
    const services = {
        pipeWire: pw as any,
        mediaRouter: {} as any,
        processManager: {} as any,
        instanceId: 'n1-test-001',
    };

    return { module, pw, services, pairCount };
}

describe('N1MixerModule', () => {
    describe('buildPipeline', () => {
        it('returns null — N-1 mixer does not use a single pipeline', () => {
            const { module } = createModule();
            expect(module.buildPipeline({})).toBeNull();
        });
    });

    describe('getDynamicPorts', () => {
        it('generates correct ports for 4 pairs', async () => {
            const { module, services } = createModule();
            await module.onInit({ pairCount: 4 }, services);
            const ports = module.getDynamicPorts();
            expect(ports).toHaveLength(8); // 4 in + 4 out
            expect(ports.filter((p) => p.direction === 'input')).toHaveLength(4);
            expect(ports.filter((p) => p.direction === 'output')).toHaveLength(4);
            expect(ports[0]).toEqual({ id: 'in-0', direction: 'input', streamType: 'audio/pcm', label: 'In 1', maxConnections: -1 });
            expect(ports[4]).toEqual({ id: 'out-0', direction: 'output', streamType: 'audio/pcm', label: 'Out 1', maxConnections: -1 });
        });

        it('generates correct ports for 2 pairs', async () => {
            const { module, services } = createModule();
            await module.onInit({ pairCount: 2 }, services);
            const ports = module.getDynamicPorts();
            expect(ports).toHaveLength(4); // 2 in + 2 out
        });

        it('generates correct ports for 8 pairs', async () => {
            const { module, services } = createModule();
            await module.onInit({ pairCount: 8 }, services);
            const ports = module.getDynamicPorts();
            expect(ports).toHaveLength(16); // 8 in + 8 out
            expect(ports[7].id).toBe('in-7');
            expect(ports[15].id).toBe('out-7');
        });

        it('all ports are audio/pcm', async () => {
            const { module, services } = createModule();
            await module.onInit({ pairCount: 6 }, services);
            const ports = module.getDynamicPorts();
            expect(ports.every((p) => p.streamType === 'audio/pcm')).toBe(true);
        });
    });

    describe('getPipeWireNodeForPort', () => {
        let module: N1MixerModule;

        beforeEach(async () => {
            const setup = createModule();
            await setup.module.onInit({ pairCount: 4 }, setup.services);
            module = setup.module;
        });

        it('returns sink for input ports', () => {
            const result = module.getPipeWireNodeForPort('in-0');
            expect(result).toEqual({ sink: 'MR_PW_n1-test-001_in_0' });
        });

        it('returns source for output ports', () => {
            const result = module.getPipeWireNodeForPort('out-2');
            expect(result).toEqual({ source: 'MR_PW_n1-test-001_out_2.monitor' });
        });

        it('returns empty for invalid port ID', () => {
            expect(module.getPipeWireNodeForPort('invalid')).toEqual({});
            expect(module.getPipeWireNodeForPort('')).toEqual({});
        });

        it('returns correct names for all input ports', () => {
            for (let i = 0; i < 4; i++) {
                const result = module.getPipeWireNodeForPort(`in-${i}`);
                expect(result.sink).toBe(`MR_PW_n1-test-001_in_${i}`);
            }
        });

        it('returns correct names for all output ports', () => {
            for (let i = 0; i < 4; i++) {
                const result = module.getPipeWireNodeForPort(`out-${i}`);
                expect(result.source).toBe(`MR_PW_n1-test-001_out_${i}.monitor`);
            }
        });
    });

    describe('N-1 routing matrix', () => {
        async function startMixer(pairCount: number) {
            const { module, pw, services } = createModule(pairCount);
            await module.onInit({ pairCount }, services);
            // onStart will fail on GstChildProcess (VU) but PipeWire calls succeed
            try { await module.onStart(); } catch { /* VU processes will fail in test env */ }
            return { module, pw };
        }

        it('creates correct null-sinks for 4 pairs', async () => {
            const { pw } = await startMixer(4);
            // 4 input + 4 output = 8 null-sinks
            expect(pw.loadNullSink).toHaveBeenCalledTimes(8);

            // Check input sinks
            for (let i = 0; i < 4; i++) {
                expect(pw.loadNullSink).toHaveBeenCalledWith(
                    `n1-test-001_in_${i}`, 2, 48000, 'n1-test-001',
                );
            }
            // Check output sinks
            for (let i = 0; i < 4; i++) {
                expect(pw.loadNullSink).toHaveBeenCalledWith(
                    `n1-test-001_out_${i}`, 2, 48000, 'n1-test-001',
                );
            }
        });

        it('creates N*(N-1) loopbacks for 4 pairs = 12 loopbacks', async () => {
            const { pw } = await startMixer(4);
            expect(pw.loadLoopback).toHaveBeenCalledTimes(12);
        });

        it('creates correct N-1 exclusion pattern for 4 pairs', async () => {
            const { pw } = await startMixer(4);

            // For each output bus, verify it gets all inputs EXCEPT its own
            for (let out = 0; out < 4; out++) {
                const loopbacksToThisOutput = pw.loadedLoopbacks.filter(
                    (lb) => lb.sink === `MR_PW_n1-test-001_out_${out}`,
                );

                // Should have 3 loopbacks (N-1 = 4-1)
                expect(loopbacksToThisOutput).toHaveLength(3);

                // The excluded input should be the one at the same index
                const sourceInputIndices = loopbacksToThisOutput.map((lb) => {
                    const match = lb.source.match(/_in_(\d+)\.monitor$/);
                    return match ? parseInt(match[1], 10) : -1;
                }).sort();

                // Should contain all indices except 'out'
                const expected = [0, 1, 2, 3].filter((i) => i !== out);
                expect(sourceInputIndices).toEqual(expected);
            }
        });

        it('creates correct loopbacks for 2 pairs', async () => {
            const { pw } = await startMixer(2);
            // 2 input + 2 output = 4 null-sinks
            expect(pw.loadNullSink).toHaveBeenCalledTimes(4);
            // 2*(2-1) = 2 loopbacks
            expect(pw.loadLoopback).toHaveBeenCalledTimes(2);

            // out-0 gets in-1 only
            const toOut0 = pw.loadedLoopbacks.filter(
                (lb) => lb.sink === 'MR_PW_n1-test-001_out_0',
            );
            expect(toOut0).toHaveLength(1);
            expect(toOut0[0].source).toBe('MR_PW_n1-test-001_in_1.monitor');

            // out-1 gets in-0 only
            const toOut1 = pw.loadedLoopbacks.filter(
                (lb) => lb.sink === 'MR_PW_n1-test-001_out_1',
            );
            expect(toOut1).toHaveLength(1);
            expect(toOut1[0].source).toBe('MR_PW_n1-test-001_in_0.monitor');
        });

        it('creates correct loopbacks for 8 pairs = 56 loopbacks', async () => {
            const { pw } = await startMixer(8);
            // 8 input + 8 output = 16 null-sinks
            expect(pw.loadNullSink).toHaveBeenCalledTimes(16);
            // 8*(8-1) = 56 loopbacks
            expect(pw.loadLoopback).toHaveBeenCalledTimes(56);
        });
    });

    describe('getPipeWireNodes', () => {
        it('returns empty (multi-port module, use getPipeWireNodeForPort instead)', () => {
            const module = new N1MixerModule();
            expect(module.getPipeWireNodes()).toEqual({});
        });
    });
});
