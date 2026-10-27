import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GstPluginBase } from '@media-router/engine';
import { AudioProcessingModule } from './AudioProcessingModule.js';

/** Test double — resolves LADSPA elements without touching gst-inspect. */
class TestModule extends AudioProcessingModule {
    public elementAvailable = true;
    public resolvedSuffixes: string[] = [];

    protected async resolveLadspa(suffix: string): Promise<string | null> {
        this.resolvedSuffixes.push(suffix);
        return this.elementAvailable ? `ladspa-lsp-test-${suffix}` : null;
    }
}

interface FakeSource {
    port: number;
    connectionId: string;
    sourceModuleId: string;
    sourcePortId: string;
    sinkPortId: string;
    streamType: string;
    socketPath: string;
}

function mkSource(sinkPortId: string, n = 0): FakeSource {
    return {
        port: 40100 + n,
        connectionId: `c-${sinkPortId}-${n}`,
        sourceModuleId: `src-${n}`,
        sourcePortId: 'audio-out',
        sinkPortId,
        streamType: 'audio/302m',
        socketPath: `/tmp/mr-bus-${40100 + n}-x.sock`,
    };
}

async function createModule(config: Record<string, unknown> = {}, sources: FakeSource[] = []) {
    const module = new TestModule();
    const assignBusChannel = vi.fn(() => ({ port: 40200 }));
    const services = {
        pipeWire: {} as any,
        mediaRouter: {
            getModuleBusSources: vi.fn(() => sources),
            assignBusChannel,
        } as any,
        processManager: {} as any,
        deviceProviders: {} as any,
        instanceId: 'ap-test-001',
    };
    await module.onInit(config, services as any);
    const setHealth = vi.fn();
    (module as any).setHealth = setHealth;
    (module as any).setStatusData = vi.fn();
    const setProperty = vi.fn(async () => {});
    (module as any).setElementProperty = setProperty;
    return { module, setHealth, assignBusChannel, setProperty };
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

beforeEach(() => {
    vi.clearAllMocks();
    AudioProcessingModule.setS302mSupported(true);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('AudioProcessingModule — 302M gating', () => {
    it('health-errors (and builds nothing) on a runtime without 302M support', async () => {
        AudioProcessingModule.setS302mSupported(false);
        const { module, setHealth } = await createModule({}, [mkSource('program-in')]);
        await startModule(module);
        expect(module.buildPipeline((module as any).config)).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('GStreamer'));
        // The LADSPA probe is skipped — the 302M diagnosis is the useful one.
        expect(module.resolvedSuffixes).toEqual([]);
        await module.onStop();
    });

    it('returns null before onStart has resolved the DSP elements', async () => {
        const { module } = await createModule({}, [mkSource('program-in')]);
        expect(module.buildPipeline({})).toBeNull();
    });
});

describe('AudioProcessingModule — element resolution', () => {
    it('resolves only the elements the enabled stages need', async () => {
        const { module } = await createModule({ mode: 'none' }, [mkSource('program-in')]);
        await startModule(module);
        expect(module.resolvedSuffixes).toEqual([]); // pass-through chain: no LADSPA
        await module.onStop();

        const full = await createModule(
            { mode: 'compressor', eqEnabled: true, limiterEnabled: true, hpfEnabled: true },
            [mkSource('program-in')],
        );
        await startModule(full.module);
        expect(full.module.resolvedSuffixes).toEqual([
            'para-equalizer-x16-stereo',
            'compressor-stereo',
            'limiter-stereo',
        ]);
        await full.module.onStop();
    });

    it('ducker needs no LADSPA element at all (runs on any image)', async () => {
        const { module } = await createModule({ mode: 'ducker' }, [
            mkSource('program-in'),
            mkSource('sidechain-in', 1),
        ]);
        module.elementAvailable = false; // even with no LADSPA present
        await startModule(module);
        expect(module.resolvedSuffixes).toEqual([]);
        await module.onStop();
    });

    it('uses sc-gate-stereo ONLY for a sidechain-keyed gate with a key wired', async () => {
        const keyed = await createModule({ mode: 'gate', gateKey: 'sidechain' }, [
            mkSource('program-in'),
            mkSource('sidechain-in', 1),
        ]);
        await startModule(keyed.module);
        expect(keyed.module.resolvedSuffixes).toEqual(['sc-gate-stereo']);
        const desc = keyed.module.buildPipeline((keyed.module as any).config)!;
        expect(desc.pipeline).toContain('audiointerleave name=il latency=0');
        await keyed.module.onStop();

        // Same config, nothing on the sidechain pin → self-keyed fallback.
        const dark = await createModule({ mode: 'gate', gateKey: 'sidechain' }, [
            mkSource('program-in'),
        ]);
        await startModule(dark.module);
        expect(dark.module.resolvedSuffixes).toEqual(['gate-stereo']);
        const darkDesc = dark.module.buildPipeline((dark.module as any).config)!;
        expect(darkDesc.pipeline).not.toContain('interleave');
        expect(dark.setHealth).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('no sidechain source'),
        );
        await dark.module.onStop();
    });

    it('gateKey=sidechain with NO key wired: gate-stereo, and no sidechain-input prop', async () => {
        // Regression: the property used to be emitted off raw config while the
        // ELEMENT was chosen off the wiring, so this state started the
        // self-keyed `gate-stereo` with a `sidechain-input=1` it has no port
        // for — one "no property" warning per start.
        const { module } = await createModule({ mode: 'gate', gateKey: 'sidechain' }, [
            mkSource('program-in'),
        ]);
        await startModule(module);
        const p = module.buildPipeline((module as any).config)!.pipeline;
        expect(p).toContain('ladspa-lsp-test-gate-stereo name=dyn');
        expect(p).not.toContain('sc-gate-stereo');
        expect(p).not.toContain('sidechain-input');
        // …and the self-keyed props still all land.
        expect(p).toContain('curve-threshold=');
        expect(p).toContain('reduction=');
        await module.onStop();
    });

    it('refuses to start when an enabled stage has no LADSPA element', async () => {
        const { module } = await createModule({ eqEnabled: true }, [mkSource('program-in')]);
        module.elementAvailable = false;
        await expect(module.onStart()).rejects.toThrow(/lsp-plugins-ladspa/);
    });
});

describe('AudioProcessingModule — buildPipeline', () => {
    it('warns and builds nothing without a program source', async () => {
        const { module, setHealth } = await createModule({}, [mkSource('sidechain-in')]);
        await startModule(module);
        expect(module.buildPipeline({})).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('Program In'));
        await module.onStop();
    });

    it('leaves a sidechain edge unconsumed when no mode keys off it, and says so', async () => {
        // The field wiring: transcoder → Sidechain, every DSP stage off. The
        // key must not be summed into the programme mix, and the dead wire has
        // to be visible instead of silently doing nothing.
        const key = mkSource('sidechain-in', 1);
        const { module, setHealth } = await createModule({ mode: 'none' }, [
            mkSource('program-in'),
            key,
        ]);
        await startModule(module);
        const desc = module.buildPipeline((module as any).config)!;
        expect(desc.pipeline).toContain('/tmp/mr-bus-40100-x.sock'); // program
        expect(desc.pipeline).not.toContain(key.socketPath); // key: unconsumed
        expect(desc.pipeline).not.toContain('scmix');
        expect((module as any).setStatusData).toHaveBeenCalledWith('chain', {
            chain: 'bypass (no stages enabled)',
            sidechain: '1 source(s) — unused by none mode',
        });
        expect(setHealth).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('nothing keys off it'),
        );
        await module.onStop();
    });

    it('routes each pin to its own fan-in for a sidechain-keyed gate', async () => {
        const program = mkSource('program-in');
        const key = mkSource('sidechain-in', 1);
        const { module } = await createModule({ mode: 'gate', gateKey: 'sidechain' }, [
            program,
            key,
        ]);
        await startModule(module);
        const p = module.buildPipeline((module as any).config)!.pipeline;
        const owner = (socket: string) => p.slice(p.indexOf(socket)).match(/name=(\w+)_out/)?.[1];
        expect(owner(program.socketPath)).toBe('progmix');
        expect(owner(key.socketPath)).toBe('scmix');
        await module.onStop();
    });

    it('allocates one bus channel and reports the chain', async () => {
        const { module, assignBusChannel, setHealth } = await createModule(
            { mode: 'compressor', eqEnabled: true, hpfEnabled: true, limiterEnabled: true },
            [mkSource('program-in')],
        );
        await startModule(module);
        const desc = module.buildPipeline((module as any).config)!;
        expect(assignBusChannel).toHaveBeenCalledWith('ap-test-001', 'audio-out');
        expect(desc.pipeline).toContain('tee name=busout_40200 allow-not-linked=true');
        expect(desc.restartOnError).toBe(true);
        expect((module as any).setStatusData).toHaveBeenCalledWith('chain', {
            chain: 'HPF → EQ → compressor → limiter',
            sidechain: 'not connected',
        });
        expect(setHealth).toHaveBeenCalledWith('ok');
        await module.onStop();
    });

    it('stops without the EOS drain, a fan-in of two holding every EOS or not', async () => {
        for (const n of [1, 2]) {
            const sources = Array.from({ length: n }, (_, i) => mkSource('program-in', i));
            const { module } = await createModule({ mode: 'compressor' }, sources);
            await startModule(module);
            const desc = module.buildPipeline((module as any).config)!;
            expect(desc.pipeline.includes('hold-on-eos=true')).toBe(n > 1);
            expect(desc.eosDrain).toBe(false);
            await module.onStop();
        }
    });

    it('errors when the bus channel pool is exhausted', async () => {
        const { module, setHealth } = await createModule({}, [mkSource('program-in')]);
        await startModule(module);
        (module as any).services.mediaRouter.assignBusChannel = vi.fn(() => null);
        expect(module.buildPipeline({})).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('port pool'));
        await module.onStop();
    });

    it('a ducker with a key wired builds mrducker and subscribes to its messages', async () => {
        const { module, setHealth } = await createModule({ mode: 'ducker', duckDepth: -20 }, [
            mkSource('program-in'),
            mkSource('sidechain-in', 1),
        ]);
        await startModule(module);
        const desc = module.buildPipeline((module as any).config)!;
        expect(desc.busReports).toEqual([{ element: 'ducker', structure: 'mrducker' }]);
        expect(desc.pipeline).toContain(
            'mrducker name=ducker threshold=-35 depth=-20 attack=5 release=200 hold=250',
        );
        expect(desc.pipeline).toContain('audiointerleave name=il latency=0');
        expect(desc.pipeline).not.toContain('sclevel');
        expect(setHealth).toHaveBeenCalledWith('ok');
        await module.onStop();
    });

    it('a ducker with nothing on the sidechain pin warns but still passes audio', async () => {
        const { module, setHealth } = await createModule({ mode: 'ducker' }, [
            mkSource('program-in'),
        ]);
        await startModule(module);
        const desc = module.buildPipeline((module as any).config)!;
        expect(desc.busReports).toBeUndefined();
        expect(desc.pipeline).not.toContain('mrducker');
        expect(desc.pipeline).toContain('progmix_out. ! audioconvert ! level name=outlevel');
        expect(setHealth).toHaveBeenCalledWith(
            'warning',
            expect.stringContaining('no sidechain source'),
        );
        await module.onStop();
    });
});

describe('AudioProcessingModule — live config updates', () => {
    it('drives EQ band + fan-out properties on the running element', async () => {
        const { module, setProperty } = await createModule({ eqEnabled: true }, [
            mkSource('program-in'),
        ]);
        await startModule(module);
        await module.onLiveConfigUpdate({
            eqBand1Gain: 6,
            eqBand1Type: 'bell',
            eqSlope: 'x2',
            eqBypass: true,
        });
        expect(setProperty).toHaveBeenCalledWith('eq', 'gain-1', 1.995262);
        expect(setProperty).toHaveBeenCalledWith('eq', 'filter-type-1', 1);
        expect(setProperty).toHaveBeenCalledWith('eq', 'bypass', true);
        expect(setProperty).toHaveBeenCalledWith('eq', 'filter-slope-0', 1);
        expect(setProperty).toHaveBeenCalledWith('eq', 'filter-slope-5', 1);
        expect((module as any).config.eqBand1Gain).toBe(6);
        await module.onStop();
    });

    it('drives the auto gain knobs on the running element, speed fanning out', async () => {
        const { module, setProperty } = await createModule({ agcEnabled: true }, [
            mkSource('program-in'),
        ]);
        await startModule(module);
        expect(module.resolvedSuffixes).toEqual(['autogain-stereo']);
        await module.onLiveConfigUpdate({ agcTarget: -20, agcSpeed: 'fast' });
        expect(setProperty).toHaveBeenCalledWith('agc', 'desired-loudness-level', -20);
        expect(setProperty).toHaveBeenCalledWith('agc', 'long-gain-grow-time', 500);
        await module.onStop();
    });

    it('maps the shared dynamics knobs onto the active element (dB → gain)', async () => {
        const { module, setProperty } = await createModule({ mode: 'compressor' }, [
            mkSource('program-in'),
        ]);
        await startModule(module);
        await module.onLiveConfigUpdate({ threshold: -20, release: 500, makeupGain: 6 });
        expect(setProperty).toHaveBeenCalledWith('dyn', 'attack-threshold', 0.1);
        expect(setProperty).toHaveBeenCalledWith('dyn', 'release-time', 500);
        expect(setProperty).toHaveBeenCalledWith('dyn', 'makeup-gain', 1.995262);
        await module.onStop();
    });

    it('never writes to a stage the running chain does not have', async () => {
        const { module, setProperty } = await createModule({ mode: 'ducker' }, [
            mkSource('program-in'),
        ]);
        await startModule(module);
        await module.onLiveConfigUpdate({
            threshold: -20, // a ducker with no key wired builds no mrducker
            duckDepth: -18,
            eqBand0Gain: 6, // no EQ in this chain
            limiterThreshold: -3, // no limiter in this chain
            hpfFreq: 120, // no HPF in this chain
        });
        expect(setProperty).not.toHaveBeenCalled();
        expect((module as any).config).toMatchObject({ threshold: -20, duckDepth: -18 });
        await module.onStop();
    });

    it('a duck slider is a live write on the ducker element, clamped to its range', async () => {
        const { module, setProperty } = await createModule({ mode: 'ducker' }, [
            mkSource('program-in'),
            mkSource('sidechain-in', 1),
        ]);
        await startModule(module);
        await module.onLiveConfigUpdate({
            threshold: -20,
            duckDepth: -18,
            attack: 40,
            release: 1, // under the element's 5 ms floor
            hold: 600,
        });
        expect(setProperty.mock.calls).toEqual([
            ['ducker', 'threshold', -20],
            ['ducker', 'depth', -18],
            ['ducker', 'attack', 40],
            ['ducker', 'release', 5],
            ['ducker', 'hold', 600],
        ]);
        await module.onStop();
    });
});

/** The envelope runs in `mrducker` (native/mrducker, its tests there); these cover the
 *  module's side: its messages into the ducker graphs. */
describe('AudioProcessingModule — ducker wiring', () => {
    /** One `mrducker` message as a runner forwards it (busReports, `mrducker:ducker`). */
    const msg = (gainDb: number, phase = 'attack', keyDb: number | null = -8) => ({
        'running-time': 0,
        'gain-db': gainDb,
        'key-db': keyDb,
        phase,
    });

    it('feeds the ducker graphs from mrducker messages, at most 4 Hz of their 10', async () => {
        const { module } = await createModule({ mode: 'ducker', duckDepth: -12 });
        const graph = vi.fn();
        (module as any).setStatusGraph = graph;
        let t = 2_000_000;
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => t);
        // 2 s of messages at 10 Hz walking down to the floor and holding there.
        for (let i = 0; i < 20; i++) {
            t += 100;
            (module as any).onPluginEvent('mrducker:ducker', msg(Math.max(-12, -1.5 * (i + 1))));
        }
        spy.mockRestore();
        const envelopes = graph.mock.calls.filter(([, key]) => key === 'duckEnvelope');
        // The onset, then never two publishes inside 250 ms: at most 1 + 2000 / 250.
        expect(envelopes.length).toBeGreaterThan(1);
        expect(envelopes.length).toBeLessThanOrEqual(1 + 2000 / 250);
        const graphed = envelopes.at(-1)![2];
        expect(graphed.live.y).toBeLessThan(0); // the dot on the envelope
        const live = graphed.markers.find((m: { axis: string }) => m.axis === 'y');
        expect(live.value).toBeLessThan(0); // the applied duck, live on the plot
        // The ducker has no transfer curve — every publish clears that key.
        const curve = graph.mock.calls.filter(([, key]) => key === 'dynamics');
        expect(curve.length).toBeGreaterThan(0);
        expect(curve.every(([, , g]) => g === null)).toBe(true);
    });

    it('ignores other channels and payloads that are no reading', async () => {
        const { module } = await createModule({ mode: 'ducker' });
        const duck = vi.spyOn((module as any).telemetry, 'duckLevel');
        (module as any).onPluginEvent('level:sclevel', { rms: [0], peak: [0] });
        (module as any).onPluginEvent('mrducker:other', msg(-6));
        (module as any).onPluginEvent('mrducker:ducker', { 'gain-db': null, phase: 'hold' });
        (module as any).onPluginEvent('mrducker:ducker', { 'gain-db': -6, phase: 'ducking' });
        (module as any).onPluginEvent('mrducker:ducker', undefined);
        expect(duck).not.toHaveBeenCalled();
        (module as any).onPluginEvent('mrducker:ducker', msg(-6, 'hold', null));
        expect(duck).toHaveBeenCalledWith({ gainDb: -6, keyDb: null, phase: 'hold' });
    });

    it('writes nothing on PLAYING: the gain lives in the element, not in a property', async () => {
        const { module, setProperty } = await createModule({ mode: 'ducker' }, [
            mkSource('program-in'),
            mkSource('sidechain-in', 1),
        ]);
        await startModule(module);
        (module as any).onPipelinePlaying();
        expect(setProperty).not.toHaveBeenCalled();
        await module.onStop();
    });

    it('no setting of the manifest is a fixed mixer budget (OQ-33)', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
        const keys = Object.keys(manifest.mediaRouter.configSchema.properties);
        expect(keys.filter((k) => /LatencyMs$/.test(k))).toEqual([]);
    });
});

describe('AudioProcessingModule — timing rows (B-70)', () => {
    it("the interleave's channels are internal; a fan-in's watch is the engine's rule", () => {
        const of = (aligner: string, input: string) =>
            (new TestModule() as any).alignerInputOf({ name: 'x', aligner, input });
        for (const input of ['prog0', 'prog1', 'key0', 'key1']) expect(of('il', input)).toBeNull();
        expect(of('progmix', 'enc-a:out:program')).toBeUndefined();
    });
});
