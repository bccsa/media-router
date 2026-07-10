import { describe, it, expect, vi, afterEach } from 'vitest';
import { GstPluginBase } from '@media-router/engine';
import { AudioDynamicsModule } from './AudioDynamicsModule.js';

const COMP_EL = 'ladspa-lsp-test-sc-compressor-stereo';
const GATE_EL = 'ladspa-lsp-test-sc-gate-stereo';

/** Test double — resolves LADSPA elements without touching gst-inspect. */
class TestModule extends AudioDynamicsModule {
    public elementAvailable = true;
    public resolvedSuffixes: string[] = [];

    protected async resolveDynElement(suffix: string): Promise<string | null> {
        this.resolvedSuffixes.push(suffix);
        if (!this.elementAvailable) return null;
        return suffix === 'sc-gate-stereo' ? GATE_EL : COMP_EL;
    }
}

function createMockPipeWire() {
    return {
        loadNullSink: vi.fn(async () => 101),
        waitForSink: vi.fn(async () => true),
        setSinkVolume: vi.fn(async () => {}),
    };
}

async function createModule(config: Record<string, unknown> = {}) {
    const module = new TestModule();
    const pw = createMockPipeWire();
    const services = {
        pipeWire: pw as any,
        mediaRouter: {} as any,
        processManager: {} as any,
        deviceProviders: {} as any,
        instanceId: 'dyn-test-001',
    };
    await module.onInit(config, services as any);
    return { module, pw };
}

/** Run onStart with the base-class pipeline spawn stubbed out. */
async function startModule(module: TestModule) {
    const superStart = vi.spyOn(GstPluginBase.prototype, 'onStart').mockResolvedValue(undefined);
    try {
        await module.onStart();
    } finally {
        superStart.mockRestore();
    }
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('AudioDynamicsModule', () => {
    describe('getPipeWireNodeForPort', () => {
        it('maps the three static ports to their null-sinks', async () => {
            const { module } = await createModule();
            expect(module.getPipeWireNodeForPort('program-in')).toEqual({
                sink: 'MR_PW_dyn-test-001_prog',
            });
            expect(module.getPipeWireNodeForPort('sidechain-in')).toEqual({
                sink: 'MR_PW_dyn-test-001_sc',
            });
            expect(module.getPipeWireNodeForPort('audio-out')).toEqual({
                source: 'MR_PW_dyn-test-001_out.monitor',
            });
        });

        it('returns empty for unknown port IDs', async () => {
            const { module } = await createModule();
            expect(module.getPipeWireNodeForPort('nope')).toEqual({});
            expect(module.getPipeWireNodes()).toEqual({});
        });
    });

    describe('onStart', () => {
        it('creates prog/sc/out null-sinks (stereo, 48 kHz)', async () => {
            const { module, pw } = await createModule({ mode: 'ducker' });
            await startModule(module);
            expect(pw.loadNullSink).toHaveBeenCalledTimes(3);
            for (const name of ['prog', 'sc', 'out']) {
                expect(pw.loadNullSink).toHaveBeenCalledWith(
                    `dyn-test-001_${name}`,
                    2,
                    48000,
                    'dyn-test-001',
                );
                expect(pw.waitForSink).toHaveBeenCalledWith(`MR_PW_dyn-test-001_${name}`);
            }
            await module.onStop();
        });

        it('ducker mode needs no LADSPA element (runs anywhere)', async () => {
            const { module } = await createModule({ mode: 'ducker' });
            module.elementAvailable = false; // even with no LADSPA present
            await startModule(module);
            expect(module.resolvedSuffixes).toEqual([]); // never probed
            await module.onStop();
        });

        it('resolves the compressor / gate element in the LADSPA modes', async () => {
            const comp = await createModule({ mode: 'compressor' });
            await startModule(comp.module);
            expect(comp.module.resolvedSuffixes).toEqual(['sc-compressor-stereo']);
            await comp.module.onStop();

            const gate = await createModule({ mode: 'gate' });
            await startModule(gate.module);
            expect(gate.module.resolvedSuffixes).toEqual(['sc-gate-stereo']);
            await gate.module.onStop();
        });

        it('throws a clear error when a LADSPA mode element is missing', async () => {
            const { module, pw } = await createModule({ mode: 'compressor' });
            module.elementAvailable = false;
            await expect(module.onStart()).rejects.toThrow(/lsp-plugins-ladspa/);
            expect(pw.loadNullSink).not.toHaveBeenCalled();
        });
    });

    describe('buildPipeline — ducker (level→volume)', () => {
        it('builds a stock level+volume pipeline that reports the sidechain level (no LADSPA)', async () => {
            const { module } = await createModule({ mode: 'ducker' });
            await startModule(module);
            const desc = module.buildPipeline(module['config'])!;
            await module.onStop();

            expect(desc.pipeline).toContain('volume name=duckvol');
            expect(desc.pipeline).toContain('level name=sclevel');
            expect(desc.pipeline).toContain('level name=outlevel'); // VU meter
            expect(desc.pipeline).toContain('pulsesrc device=MR_PW_dyn-test-001_prog.monitor');
            expect(desc.pipeline).toContain('pulsesrc device=MR_PW_dyn-test-001_sc.monitor');
            expect(desc.pipeline).toContain('pulsesink device=MR_PW_dyn-test-001_out');
            expect(desc.pipeline).not.toContain('ladspa');
            expect(desc.pipeline).not.toContain('interleave');
            expect(desc.busReports).toEqual([{ element: 'sclevel', structure: 'level' }]);
        });
    });

    describe('onPluginEvent — ducker gain envelope', () => {
        /** Drive the envelope with N sidechain readings at `keyDb`, `stepMs` apart. */
        async function runEnvelope(
            config: Record<string, unknown>,
            keyDb: number,
            ticks: number,
            stepMs = 15,
        ) {
            const { module } = await createModule({ mode: 'ducker', ...config });
            const sets: number[] = [];
            (module as any).setElementProperty = async (_el: string, _p: string, v: number) => {
                sets.push(v);
            };
            // Seed the envelope clock, then advance a fake wall-clock per tick.
            let t = 1_000_000;
            const spy = vi.spyOn(Date, 'now').mockImplementation(() => t);
            (module as any).duckDb = 0;
            (module as any).duckActiveMs = -Infinity;
            (module as any).duckTickMs = t;
            (module as any).duckSetGain = 1;
            for (let i = 0; i < ticks; i++) {
                t += stepMs;
                module['onPluginEvent']('level:sclevel', { rms: [keyDb], peak: [keyDb] });
            }
            spy.mockRestore();
            return { module, sets, lastGain: sets.length ? sets[sets.length - 1] : 1 };
        }

        it('ducks the program to the exact floor when the key is over threshold', async () => {
            // -12 dB floor → gain 0.251; attack 5ms reaches it within a few ticks
            const { lastGain } = await runEnvelope(
                { threshold: -35, duckDepth: -12, attack: 5 },
                -3,
                40,
            );
            expect(lastGain).toBeCloseTo(10 ** (-12 / 20), 2); // 0.251
        });

        it('stays at unity when the key is below threshold', async () => {
            const { sets } = await runEnvelope({ threshold: -35 }, -50, 20);
            expect(sets).toHaveLength(0); // never moved from unity → no writes
        });

        it('releases back to unity after the key drops (past the hold)', async () => {
            const { module } = await createModule({
                mode: 'ducker',
                threshold: -35,
                duckDepth: -18,
                attack: 5,
                release: 100,
                hold: 50,
            });
            const sets: number[] = [];
            (module as any).setElementProperty = async (_e: string, _p: string, v: number) => {
                sets.push(v);
            };
            let t = 1_000_000;
            const spy = vi.spyOn(Date, 'now').mockImplementation(() => t);
            (module as any).duckTickMs = t;
            // duck hard
            for (let i = 0; i < 30; i++) {
                t += 15;
                module['onPluginEvent']('level:sclevel', { rms: [-3], peak: [-3] });
            }
            const ducked = sets[sets.length - 1];
            // key gone quiet — advance well past hold + release
            for (let i = 0; i < 60; i++) {
                t += 15;
                module['onPluginEvent']('level:sclevel', { rms: [-80], peak: [-80] });
            }
            spy.mockRestore();
            expect(ducked).toBeCloseTo(10 ** (-18 / 20), 2);
            expect(sets[sets.length - 1]).toBeCloseTo(1, 2); // recovered to unity
        });

        it('ignores other channels and other modes', async () => {
            const { module } = await createModule({ mode: 'ducker' });
            const spy = vi.fn(async () => {});
            (module as any).setElementProperty = spy;
            module['onPluginEvent']('level:outlevel', { rms: [0], peak: [0] });
            expect(spy).not.toHaveBeenCalled();
        });
    });

    describe('buildPipeline — compressor / gate (LADSPA)', () => {
        it('compressor keys internally with a 4-channel interleave', async () => {
            const { module } = await createModule({ mode: 'compressor', threshold: -35 });
            await startModule(module);
            const desc = module.buildPipeline(module['config'])!;
            await module.onStop();

            expect(desc.pipeline).toContain(`${COMP_EL} name=dyn`);
            expect(desc.pipeline).toContain('sidechain-type=0');
            expect(desc.pipeline).toContain('attack-threshold=0.017783'); // -35 dB
            expect(desc.pipeline).toContain('ratio=8');
            expect(desc.pipeline).toContain('audio/x-raw,channels=4,channel-mask=(bitmask)0x0');
            expect(desc.pipeline).toContain('dp.src_0 ! queue ! il.sink_0');
            expect(desc.pipeline).toContain('ds.src_1 ! queue ! il.sink_3');
            expect(desc.busReports).toBeUndefined(); // LADSPA modes don't subscribe
        });

        it('gate uses the gate element with its own property names', async () => {
            const { module } = await createModule({
                mode: 'gate',
                threshold: -60,
                gateDepth: -48,
                gateKey: 'sidechain',
            });
            await startModule(module);
            const desc = module.buildPipeline(module['config'])!;
            await module.onStop();

            expect(desc.pipeline).toContain(`${GATE_EL} name=dyn`);
            expect(desc.pipeline).toContain('curve-threshold=0.001'); // -60 dB
            expect(desc.pipeline).toContain('reduction=0.003981'); // -48 dB
            expect(desc.pipeline).toContain('sidechain-input=1');
            expect(desc.pipeline).not.toContain('sidechain-type');
        });

        it('returns null before the element is resolved', async () => {
            const { module } = await createModule({ mode: 'compressor' });
            expect(module.buildPipeline({})).toBeNull();
        });
    });

    describe('onLiveConfigUpdate', () => {
        it('ducker live updates just merge into config (envelope reads them live)', async () => {
            const { module } = await createModule({ mode: 'ducker' });
            const spy = vi.fn(async () => {});
            (module as any).setElementProperty = spy;
            await module.onLiveConfigUpdate({ duckDepth: -20, release: 1500, hold: 400 });
            expect(module['config']).toMatchObject({ duckDepth: -20, release: 1500, hold: 400 });
            expect(spy).not.toHaveBeenCalled(); // no per-change IPC
        });

        it('compressor maps params to LSP element properties (dB→gain)', async () => {
            const { module } = await createModule({ mode: 'compressor' });
            const spy = vi.fn(async () => {});
            (module as any).setElementProperty = spy;
            await module.onLiveConfigUpdate({ threshold: -20, release: 500, makeupGain: 6 });
            expect(spy).toHaveBeenCalledWith('dyn', 'attack-threshold', 0.1);
            expect(spy).toHaveBeenCalledWith('dyn', 'release-time', 500);
            expect(spy).toHaveBeenCalledWith('dyn', 'makeup-gain', 1.995262);
        });

        it('gate maps params to gate properties', async () => {
            const { module } = await createModule({ mode: 'gate' });
            const spy = vi.fn(async () => {});
            (module as any).setElementProperty = spy;
            await module.onLiveConfigUpdate({ threshold: -40, gateKey: 'sidechain' });
            expect(spy).toHaveBeenCalledWith('dyn', 'curve-threshold', 0.01);
            expect(spy).toHaveBeenCalledWith('dyn', 'sidechain-input', 1);
        });
    });

    describe('onPipelinePlaying (restart re-seed)', () => {
        it('ducker resets the envelope AND pushes unity (sticky replay may have restored a duck)', async () => {
            const { module } = await createModule({ mode: 'ducker' });
            const spy = vi.fn(async () => {});
            (module as any).setElementProperty = spy;
            // Pretend the envelope was pinned at the floor before a restart
            (module as any).duckDb = -18;
            (module as any).duckSetGain = 0.125;
            (module as any).duckActiveMs = 5;
            module['onPipelinePlaying']();
            expect((module as any).duckDb).toBe(0);
            expect((module as any).duckSetGain).toBe(1);
            expect((module as any).duckActiveMs).toBe(-Infinity);
            expect(spy).toHaveBeenCalledWith('duckvol', 'volume', 1);
        });

        it('LADSPA modes do nothing — live props are restored by the sticky replay', async () => {
            const { module } = await createModule({ mode: 'compressor', threshold: -20 });
            const spy = vi.fn(async () => {});
            (module as any).setElementProperty = spy;
            module['onPipelinePlaying']();
            expect(spy).not.toHaveBeenCalled();
        });
    });
});
