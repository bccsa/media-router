import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GstPluginBase, ModuleInstance, liveInputLaunchText } from '@media-router/engine';
import { AudioOutput302mModule } from './AudioOutput302mModule.js';

/** The pipeline the runner launches when every source runs: the mixer, its inputs linked in. */
const launched = (desc: { pipeline: string; liveInputs?: any[] }): string =>
    [desc.pipeline, ...(desc.liveInputs ?? []).map((b, i) => liveInputLaunchText(b, i))].join(' ');

function makeModule(
    opts: {
        sources?: number;
        /** The engine default D (ms) and an optional route-head override. */
        playout?: { playoutOffsetMs?: number; routeOverrideMs?: number };
        /** Provide a PipeWire service whose getDeviceInfo reports this width
         *  (null = device not enumerated). Absent = no PipeWire service at all. */
        deviceChannels?: number | null;
    } = {},
) {
    const module = new AudioOutput302mModule() as any;
    const sources = Array.from({ length: opts.sources ?? 0 }, (_, i) => ({
        port: 40100 + i,
        connectionId: `c-${i}`,
        sourceModuleId: `src-${i}`,
        sourcePortId: 'out-0',
        sinkPortId: 'audio-in',
        streamType: 'audio/302m',
        socketPath: `/tmp/mr-bus-${40100 + i}-x.sock`,
    }));
    const getRoutePlayoutOffsetMs = vi.fn(() => opts.playout?.routeOverrideMs);
    module.services = {
        instanceId: 'aout-1',
        mediaRouter: { getModuleBusSources: vi.fn(() => sources), getRoutePlayoutOffsetMs },
        ...(opts.playout ? { playoutOffsetMs: opts.playout.playoutOffsetMs ?? 300 } : {}),
        ...(opts.deviceChannels !== undefined
            ? {
                  pipeWire: {
                      hasDevice: vi.fn(() => true),
                      getDeviceInfo: vi.fn(() =>
                          opts.deviceChannels === null
                              ? null
                              : { channels: opts.deviceChannels, sampleRate: 48000 },
                      ),
                  },
              }
            : {}),
    };
    module.config = {};
    const setHealth = vi.fn();
    module.setHealth = setHealth;
    module.setStatusData = vi.fn();
    const setElementProperty = vi.fn(async () => undefined);
    module.setElementProperty = setElementProperty;
    return { module, setHealth, setElementProperty, getRoutePlayoutOffsetMs };
}

beforeEach(() => vi.clearAllMocks());

describe('AudioOutput302mModule.buildPipeline', () => {
    it('never plays to a default device — unconfigured device is a health error', () => {
        const { module, setHealth } = makeModule({ sources: 1 });
        expect(module.buildPipeline({})).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('error', expect.stringContaining('No audio device'));
    });

    it('returns null + warning with no 302M sources', () => {
        const { module, setHealth } = makeModule();
        expect(module.buildPipeline({ device: 'alsa_output.usb-foo' })).toBeNull();
        expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('No 302M'));
    });

    it('mixes N sources and plays to the EXPLICIT device with volume + VU in-pipeline', () => {
        const { module } = makeModule({ sources: 2 });
        const desc = module.buildPipeline({ device: 'alsa_output.usb-foo', volume: 80 });
        expect(desc).not.toBeNull();
        // The aligned mixer: every input through its watchdog, no force-live.
        expect(desc!.pipeline).toContain(
            'audiomixer name=mixin latency=0 start-time-selection=first ! capsfilter name=mixin_out',
        );
        expect(launched(desc!).match(/ \) ! mixin\.sink_\d/g)).toHaveLength(2);
        expect(
            launched(desc!).match(/! mralignwatch name=mixin_aw_[0-9a-f]{6} aligner=mixin /g),
        ).toHaveLength(2);
        expect(launched(desc!)).not.toContain('force-live');
        expect(desc!.pipeline).toContain('volume name=vol volume=0.80');
        expect(desc!.pipeline).toContain('level post-messages=true');
        expect(desc!.pipeline).toContain(
            'pulsesink name=sink device=alsa_output.usb-foo sync=true',
        );
        expect(desc!.restartOnError).toBe(true);
    });

    it('mutes via the gst volume element when audioEnabled=false', () => {
        const { module } = makeModule({ sources: 1 });
        const desc = module.buildPipeline({
            device: 'alsa_output.usb-foo',
            volume: 90,
            audioEnabled: false,
        });
        expect(desc!.pipeline).toContain('volume name=vol volume=0.00');
    });

    it('a single source plays direct — no mixer, no watchdog', () => {
        const { module } = makeModule({ sources: 1 });
        const desc = module.buildPipeline({ device: 'alsa_output.usb-foo' });
        expect(desc!.pipeline).not.toContain('audiomixer');
        expect(desc!.pipeline).not.toContain('mralignwatch');
        expect(desc!.pipeline).toContain('capsfilter name=mixin_out');
        expect(desc!.pipeline).toContain(
            'mixin_out. ! identity name=live_upstream sync=true ! audioconvert ! audioresample',
        );
        expect(desc!.pipeline).toContain(
            'pulsesink name=sink device=alsa_output.usb-foo sync=true',
        );
    });

    it('stops without the EOS drain in both arms (the mixer arm holds every EOS)', () => {
        for (const sources of [1, 2]) {
            const { module } = makeModule({ sources });
            const desc = module.buildPipeline({ device: 'alsa_output.usb-foo' });
            expect(launched(desc!).includes('hold-on-eos=true')).toBe(sources > 1);
            expect(desc!.eosDrain).toBe(false);
        }
    });

    it('consumes the per-connection unixfd edge sockets', () => {
        const { module } = makeModule({ sources: 1 });
        const desc = module.buildPipeline({ device: 'alsa_output.usb-foo' });
        expect(desc!.pipeline).toContain('unixfdsrc socket-path=/tmp/mr-bus-40100-x.sock');
    });

    it('default stereo range keeps the string byte-for-byte, even on a 32-channel card', () => {
        const narrow = makeModule({ sources: 1 }).module.buildPipeline({
            device: 'alsa_output.usb-foo',
        });
        const wide = makeModule({ sources: 1, deviceChannels: 32 }).module.buildPipeline({
            device: 'alsa_output.usb-foo',
        });
        expect(wide!.pipeline).toBe(narrow!.pipeline);
        expect(wide!.pipeline).not.toContain('mix-matrix');
        expect(wide!.pipeline).not.toContain('channel-mask');
    });

    it('places an 8-channel mix on outputs 9–16 of a 32-channel card as a 16-wide stream, upstream of an untouched sink', () => {
        const { module } = makeModule({ sources: 1, deviceChannels: 32 });
        const desc = module.buildPipeline({
            device: 'alsa_output.usb-foo',
            channels: 8,
            firstChannel: 9,
        });
        expect(desc).not.toBeNull();
        const p: string = desc!.pipeline;
        // The mix is 8 wide; VU reads it before the spread.
        expect(p).toContain('capsfilter name=mixin_out caps="audio/x-raw,rate=48000,channels=8"');
        expect(p).toMatch(
            /level post-messages=true[^!]*! audioconvert mix-matrix="<.*>" ! audio\/x-raw,channels=16,channel-mask=\(bitmask\)0x0 ! mrlateness name=lat_render reference=running-time ! pulsesink name=sink device=alsa_output\.usb-foo sync=true [^!]*stream-properties="[^"]*"$/,
        );
        // 16 wide — up to the last channel used, never the card's 32.
        // Row 8 (device channel 9) carries mix channel 0: the first lit cell.
        const matrix = /mix-matrix="<(.*)>"/.exec(p)![1];
        const rows = matrix.split('>, <');
        expect(rows).toHaveLength(16);
        expect(rows[8].replace(/[<>]/g, '').split(', ')[0]).toBe('(float)1.0000');
        expect(rows[0].replace(/[<>]/g, '')).not.toContain('1.0000');
        expect(module.setStatusData).toHaveBeenCalledWith(
            'output',
            expect.objectContaining({
                channels: 8,
                firstChannel: 9,
                lastChannel: 16,
                deviceChannels: 32,
            }),
        );
    });

    it('placement leaves the sink and its timing properties exactly as before', () => {
        const { module } = makeModule({
            sources: 1,
            deviceChannels: 32,
            playout: { playoutOffsetMs: 300 },
        });
        const desc = module.buildPipeline({
            device: 'alsa_output.usb-foo',
            channels: 2,
            firstChannel: 3,
        });
        expect(desc!.pipeline).toContain(
            'channel-mask=(bitmask)0x0 ! mrlateness name=lat_render reference=running-time' +
                ' ! pulsesink name=sink device=alsa_output.usb-foo sync=true' +
                ' provide-clock=false slave-method=1 max-lateness=-1 buffer-time=100000 ts-offset=200000000',
        );
        expect(desc!.backlogShed).toMatchObject({ element: 'sink', sink: 'sink' });
    });

    it('health error (and no pipeline) when the range runs past the device', () => {
        const { module, setHealth } = makeModule({ sources: 1, deviceChannels: 32 });
        expect(
            module.buildPipeline({ device: 'alsa_output.usb-foo', channels: 8, firstChannel: 45 }),
        ).toBeNull();
        expect(setHealth).toHaveBeenCalledWith(
            'error',
            expect.stringContaining('has 32 channels — cannot play on 45–52'),
        );
        expect(setHealth).not.toHaveBeenCalledWith('ok');
    });

    it('health error when a non-default range is asked of a device of unknown width', () => {
        const { module, setHealth } = makeModule({ sources: 1, deviceChannels: null });
        expect(
            module.buildPipeline({ device: 'alsa_output.usb-foo', channels: 8, firstChannel: 9 }),
        ).toBeNull();
        expect(setHealth).toHaveBeenCalledWith(
            'error',
            expect.stringContaining('not enumerated by PipeWire'),
        );
    });

    it('re-anchor on (ADR-0005 2026-10-08): the shed config asks to raise, never shed', () => {
        const { module } = makeModule({ sources: 1, playout: { playoutOffsetMs: 300 } });
        module.services.playoutReanchor = true;
        expect(module.buildPipeline({ device: 'alsa_output.usb-foo' })!.backlogShed).toMatchObject({
            element: 'sink',
            sink: 'sink',
            keyframeAligned: false,
            onLateness: 'reanchor',
            reanchorToleranceMs: 40,
            reanchorHoldMs: 15000,
            reanchorRetryMs: 30000,
            rebaseHoldMs: 3000,
            rebaseCooldownMs: 60000,
        });
    });

    it('re-anchor off: the shed config has none of the re-anchor keys', () => {
        const { module } = makeModule({ sources: 1, playout: { playoutOffsetMs: 300 } });
        const desc = module.buildPipeline({ device: 'alsa_output.usb-foo' });
        expect(desc!.backlogShed).not.toHaveProperty('onLateness');
    });
});

describe('AudioOutput302mModule: several sources are live inputs (B-192)', () => {
    it('two or more: the mixer and its tail in the pipeline, each source a live input apart', () => {
        const { module } = makeModule({ sources: 4 });
        const desc = module.buildPipeline({ device: 'alsa_output.usb-foo' })!;
        // Nothing in the pipeline itself waits for a source: the runner links in the ones there.
        expect(desc.pipeline).not.toContain('unixfdsrc');
        expect(desc.pipeline).toMatch(
            /^audiomixer name=mixin latency=0 start-time-selection=first/,
        );
        expect(desc.liveInputs).toHaveLength(4);
        desc.liveInputs!.forEach((b: any, i: number) => {
            expect(b).toEqual(module.getLiveInputBranch('audio-in', `c-${i}`));
            expect(b.element).toBe('mixin');
            expect(b.description).toMatch(
                new RegExp(
                    `^unixfdsrc socket-path=/tmp/mr-bus-${40100 + i}-x\\.sock .* hold-on-eos=true$`,
                ),
            );
        });
        expect(module.setStatusData).toHaveBeenCalledWith(
            'output',
            expect.objectContaining({ sources: 4 }),
        );
    });

    it('one source keeps its direct string, with no live inputs', () => {
        const { module } = makeModule({ sources: 1 });
        const desc = module.buildPipeline({ device: 'alsa_output.usb-foo' })!;
        expect(desc.liveInputs).toBeUndefined();
        expect(desc.pipeline).toMatch(/^unixfdsrc socket-path=\/tmp\/mr-bus-40100-x\.sock /);
        expect(module.getLiveInputBranch('audio-in', 'c-0')).toBeNull();
    });

    it('the live verbs reach Audio In from two sources on; a remove names the branch alone', () => {
        const { module } = makeModule({ sources: 2 });
        expect(module.getLiveInputBranch('other', 'c-0')).toBeNull();
        const add = module.getLiveInputBranch('audio-in', 'c-1');
        expect(add.element).toBe('mixin');
        expect(add.description).toContain('unixfdsrc socket-path=/tmp/mr-bus-40101-x.sock');
        // An edge already gone from the router: what a live remove needs, the bin's name.
        const gone = module.getLiveInputBranch('audio-in', 'c-9');
        expect(gone).toEqual({ element: 'mixin', name: expect.stringMatching(/^mixin_in_/) });
    });
});

describe('AudioOutput302mModule.buildPipeline — house-clock presentation (ADR-0005)', () => {
    it('presents at stamp + D on the house clock: sync=true, ts-offset=D minus the ring it declares, skew-slaved, never drops late', () => {
        const { module } = makeModule({ sources: 1, playout: { playoutOffsetMs: 300 } });
        const desc = module.buildPipeline({ device: 'alsa_output.usb-foo' });
        expect(desc!.pipeline).toContain(
            '! pulsesink name=sink device=alsa_output.usb-foo sync=true provide-clock=false' +
                ' slave-method=1 max-lateness=-1 buffer-time=100000 ts-offset=200000000',
        );
        expect(desc!.pipeline).not.toContain('sync=false');
        // The latency-ratchet guard, on the sink's own pad, whole-buffer.
        expect(desc!.backlogShed).toMatchObject({
            element: 'sink',
            sink: 'sink',
            keyframeAligned: false,
        });
        // …and the input on content time from the formula demux: nothing to align to stamps.
        expect(desc!.pipeline).toContain(
            'mrtsdemux name=mixin_demux0 select=audio/x-smpte-302m ! avdec_s302m',
        );
        expect(desc!.pipeline).not.toMatch(/\btsdemux\b/);
        expect(desc!.alignBranchesToStamps).toBeUndefined();
    });

    it('the route head override replaces the engine default — resolved for THIS consumer', () => {
        const { module, getRoutePlayoutOffsetMs } = makeModule({
            sources: 1,
            playout: { playoutOffsetMs: 300, routeOverrideMs: 500 },
        });
        const desc = module.buildPipeline({ device: 'alsa_output.usb-foo' });
        expect(desc!.pipeline).toContain('ts-offset=400000000');
        expect(getRoutePlayoutOffsetMs).toHaveBeenCalledWith('aout-1', undefined);
    });

    it('lipSyncMs is a per-sink trim on top of D — positive delays audio, negative advances it', () => {
        const { module } = makeModule({ sources: 1, playout: { playoutOffsetMs: 300 } });
        expect(
            module.buildPipeline({ device: 'alsa_output.usb-foo', lipSyncMs: -110 })!.pipeline,
        ).toContain('ts-offset=90000000');
        expect(
            module.buildPipeline({ device: 'alsa_output.usb-foo', lipSyncMs: 40 })!.pipeline,
        ).toContain('ts-offset=240000000');
    });

    it('never emits a negative ts-offset: a trim past D clamps to 0 (audio cannot play before it arrives)', async () => {
        const { module, setElementProperty } = makeModule({
            sources: 1,
            playout: { playoutOffsetMs: 300 },
        });
        expect(
            module.buildPipeline({ device: 'alsa_output.usb-foo', lipSyncMs: -2000 })!.pipeline,
        ).toContain('ts-offset=0');
        // …and the live push clamps the same way — the shedder reads ts-offset
        // as the budget, so a negative value would make it drop real audio.
        module.config = { device: 'alsa_output.usb-foo', lipSyncMs: -2000 };
        module.buildPipeline(module.config);
        await module.onRoutePlayoutOffsetChanged();
        expect(setElementProperty).toHaveBeenLastCalledWith('sink', 'ts-offset', 0);
    });

    it('both arms play at stamp + D: one offset, and the sink sees a live upstream in each', () => {
        const one = makeModule({ sources: 1, playout: { playoutOffsetMs: 300 } }).module;
        const two = makeModule({ sources: 2, playout: { playoutOffsetMs: 300 } }).module;
        const tail =
            ' ! identity name=live_upstream sync=true ! audioconvert ! audioresample' +
            ' ! volume name=vol volume=1.00';
        for (const m of [one, two]) {
            const p: string = m.buildPipeline({ device: 'alsa_output.usb-foo' })!.pipeline;
            // The identity answers LATENCY live, so the sink adds its ring in the
            // non-live mixer arm too, and the same 300 − 100 ring offset holds.
            expect(p).toContain(`mixin_out.${tail}`);
            expect(p.match(/identity /g)).toHaveLength(1);
            expect(p).toContain('ts-offset=200000000');
        }
    });

    it('mixLatencyMs is gone: not in the manifest, and a stored value changes nothing', () => {
        const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
        expect(manifest.mediaRouter.configSchema.properties).not.toHaveProperty('mixLatencyMs');
        const { module } = makeModule({ sources: 2, playout: { playoutOffsetMs: 300 } });
        const plain = module.buildPipeline({ device: 'alsa_output.usb-foo' })!.pipeline;
        const stored = module.buildPipeline({
            device: 'alsa_output.usb-foo',
            mixLatencyMs: 400,
        })!.pipeline;
        expect(stored).toBe(plain);
    });

    it('re-pushes ts-offset live when the route D or the trim changes', async () => {
        const { module, setElementProperty } = makeModule({
            sources: 1,
            playout: { playoutOffsetMs: 300 },
        });
        module.config = { device: 'alsa_output.usb-foo', lipSyncMs: 0 };
        module.buildPipeline(module.config);
        await module.onRoutePlayoutOffsetChanged();
        expect(setElementProperty).toHaveBeenLastCalledWith('sink', 'ts-offset', 200000000);
        await module.onLiveConfigUpdate({ lipSyncMs: 50 });
        expect(setElementProperty).toHaveBeenLastCalledWith('sink', 'ts-offset', 250000000);
    });

    it('a live push through the mixer arm gives the offset the single-source arm gets', async () => {
        const { module, setElementProperty } = makeModule({
            sources: 2,
            playout: { playoutOffsetMs: 300 },
        });
        module.config = { device: 'alsa_output.usb-foo' };
        module.buildPipeline(module.config);
        await module.onRoutePlayoutOffsetChanged();
        expect(setElementProperty).toHaveBeenLastCalledWith('sink', 'ts-offset', 200000000);
        await module.onLiveConfigUpdate({ lipSyncMs: 50 });
        expect(setElementProperty).toHaveBeenLastCalledWith('sink', 'ts-offset', 250000000);
    });
});

// --- A restart applies a re-picked device (B-191) ----------------------------------------------

/** Audio Output's device before and after it was re-picked in the field (MR-002). */
const OLD = 'alsa_output.usb-Solid_State_Logic_SSL_2-00.HiFi__hw_S2__sink';
const NEW = 'alsa_output.usb-Solid_State_Logic_SSL_2-00.HiFi__Line__sink';

/** The module under the engine's ModuleInstance on a graph of `present` devices, one source
 *  wired; `built` holds each pipeline it starts. `repick` is a settings patch, then Restart. */
function underEngine(present: Set<string>) {
    const built: string[] = [];
    vi.spyOn(GstPluginBase.prototype, 'onStart').mockImplementation(async function (this: any) {
        built.push(this.buildPipeline(this.config)?.pipeline ?? '');
    });
    const module = new AudioOutput302mModule() as any;
    const source = {
        port: 40100,
        connectionId: 'c-0',
        sourceModuleId: 'src-0',
        sourcePortId: 'out-0',
        sinkPortId: 'audio-in',
        streamType: 'audio/302m',
        socketPath: '/tmp/mr-bus-40100-x.sock',
    };
    const services = {
        instanceId: 'aout-1',
        pipeWire: {
            hasDevice: (name: string) => present.has(name),
            getDeviceInfo: () => ({ channels: 2, sampleRate: 48000 }),
            releaseAll: vi.fn(async () => {}),
        },
        mediaRouter: { getModuleBusSources: () => [source], releaseAllBusChannelsFor: vi.fn() },
        processManager: { releaseAll: vi.fn(async () => {}) },
        deviceProviders: {},
    } as any;
    const instance = new ModuleInstance(
        'aout-1',
        'audio-output-302m',
        module,
        { device: OLD },
        services,
    );
    const repick = async (device: string) => {
        await instance.applyConfigUpdate({ device });
        await instance.stop();
        await instance.start();
    };
    return { module, instance, built, repick };
}

describe('AudioOutput302mModule: a restart applies a re-picked device (B-191)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('a running output plays to and watches the re-picked device after Restart', async () => {
        const { module, instance, built, repick } = underEngine(new Set([OLD, NEW]));
        await instance.start();
        expect(built[0]).toContain(`pulsesink name=sink device=${OLD} `);
        await repick(NEW);
        expect(built).toHaveLength(2);
        expect(built[1]).toContain(`pulsesink name=sink device=${NEW} `);
        expect(module.getWatchedDeviceName()).toBe(NEW);
        await instance.stop();
    });

    it('an output waiting for hot-plug waits for the re-picked device after Restart', async () => {
        const present = new Set<string>();
        const { module, instance, built, repick } = underEngine(present);
        await instance.start();
        expect(module.getState().error).toBe(
            `Audio device "${OLD}" not connected — waiting for hot-plug`,
        );
        await repick(NEW);
        expect(module.getState().error).toBe(
            `Audio device "${NEW}" not connected — waiting for hot-plug`,
        );
        present.add(OLD);
        await module.deviceWatchdog.tick();
        expect(built).toEqual([]);
        present.add(NEW);
        await module.deviceWatchdog.tick();
        expect(built).toHaveLength(1);
        expect(built[0]).toContain(`pulsesink name=sink device=${NEW} `);
        await instance.stop();
    });
});
