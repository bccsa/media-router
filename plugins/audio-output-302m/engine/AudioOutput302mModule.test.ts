import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { GstPluginBase, ModuleInstance, liveInputLaunchText } from '@media-router/engine';
import { liveAsrcName, liveDemuxName } from '@media-router/plugin-audio-302m-core';
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
    // What a start reads before it builds (B-200): the build itself asks PipeWire nothing.
    module.deviceChannels = opts.deviceChannels ?? null;
    const setHealth = vi.fn();
    module.setHealth = setHealth;
    module.setStatusData = vi.fn();
    const setElementProperty = vi.fn(async () => undefined);
    module.setElementProperty = setElementProperty;
    return { module, setHealth, setElementProperty, getRoutePlayoutOffsetMs };
}

beforeEach(() => vi.clearAllMocks());

/** One bus source as `getModuleBusSources` gives it. */
const source = (i: number) => ({
    port: 40100 + i,
    connectionId: `c-${i}`,
    sourceModuleId: `src-${i}`,
    sourcePortId: 'out-0',
    sinkPortId: 'audio-in',
    streamType: 'audio/302m',
    socketPath: `/tmp/mr-bus-${40100 + i}-x.sock`,
});

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
            'mixin_out. ! identity name=live_upstream sync=true' +
                ' ! mrlateness name=lat_render reference=running-time ! audioconvert' +
                ' ! mrasrc name=outasrc bypass-below-ppm=0.5 device-sink=sink ! volume',
        );
        expect(desc!.pipeline).toContain(
            'pulsesink name=sink device=alsa_output.usb-foo sync=true',
        );
    });

    it('declares its pulsesink the PipeWire stream: a failure waits for the device, not a restart loop (B-195)', () => {
        for (const sources of [1, 2]) {
            const { module } = makeModule({ sources });
            const desc = module.buildPipeline({ device: 'alsa_output.usb-foo' });
            expect(desc!.pipeline).toContain('pulsesink name=sink device=alsa_output.usb-foo ');
            expect(desc!.pipeWireElements).toEqual(['sink']);
        }
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

    it("each branch's demux and ASRC serve its connection's timing row, in both arms (WI-P3-6)", () => {
        for (const n of [1, 3]) {
            const { module } = makeModule({ sources: n });
            const p = launched(module.buildPipeline({ device: 'alsa_output.usb-foo' })!);
            for (let i = 0; i < n; i++) {
                // The mixer's branches are live inputs (B-192), named by their connection.
                const demux = n > 1 ? liveDemuxName('mixin', `c-${i}`) : `mixin_demux${i}`;
                expect(p).toContain(`mrtsdemux name=${demux} `);
                expect(module.demuxInputOf(demux)).toEqual({ connection: `c-${i}` });
                // The single arm's decode term is outasrc's: the module's own row.
                const asrc = n > 1 ? liveAsrcName('mixin', `c-${i}`) : `mixin_asrc${i}`;
                expect(p.includes(`mrasrc name=${asrc} `)).toBe(n > 1);
                expect(module.demuxInputOf(asrc)).toEqual(
                    n > 1 ? { connection: `c-${i}` } : undefined,
                );
            }
            expect(module.demuxInputOf('outasrc')).toBeUndefined();
            expect(module.demuxInputOf('sink')).toBeUndefined();
        }
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
            /level post-messages=true[^!]*! audioconvert mix-matrix="<.*>" ! audio\/x-raw,channels=16,channel-mask=\(bitmask\)0x0 ! pulsesink name=sink device=alsa_output\.usb-foo sync=true [^!]*stream-properties="[^"]*"$/,
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
            'channel-mask=(bitmask)0x0 ! pulsesink name=sink device=alsa_output.usb-foo sync=true' +
                ' provide-clock=false slave-method=3 max-lateness=-1 buffer-time=100000 ts-offset=200000000',
        );
        expect(desc!.backlogShed).toMatchObject({ element: 'outasrc', sink: 'sink' });
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
            element: 'outasrc',
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

describe('AudioOutput302mModule: a launch plays at its own D, whatever its sources went through (B-206)', () => {
    it('the runner skips what each input delivers from before the launch plays, as TS at its ingress tap, both arms', () => {
        const mixed = makeModule({ sources: 2 }).module.buildPipeline({
            device: 'alsa_output.usb-foo',
        });
        expect(mixed!.catchUp).toEqual({ prefix: 'lat_busin' });
        // Every input of the launch (and of a live add) has its tap under that prefix, before
        // its ingress queue: the TS is dropped in the thread that reads the socket.
        const taps = launched(mixed!).match(
            /unixfdsrc [^!]+! mrlateness name=lat_busin_\S+ reference=house ! queue/g,
        );
        expect(taps).toHaveLength(2);
        const direct = makeModule({ sources: 1 }).module.buildPipeline({
            device: 'alsa_output.usb-foo',
        });
        expect(direct!.catchUp).toEqual({ prefix: 'lat_busin' });
        expect(direct!.pipeline).toContain('mrlateness name=lat_busin_');
    });

    it('its shed probe watches the playout: the sink missing for a second is reported', () => {
        const desc = makeModule({ sources: 2 }).module.buildPipeline({
            device: 'alsa_output.usb-foo',
        });
        expect(desc!.backlogShed!.missWatchMs).toBe(1000);
    });

    it('a seed past its ts-offset (a producer read during its own outage burst) starts there: the sink keeps its ring', () => {
        const { module } = makeModule({ sources: 2, playout: { playoutOffsetMs: 300 } });
        module.services.mediaRouter.getModuleBusSources = vi.fn(() => [
            { ...source(0), seedLatenessMs: 4300 },
            { ...source(1), seedLatenessMs: 50 },
        ]);
        const text = launched(module.buildPipeline({ device: 'alsa_output.usb-foo' })!);
        // D 300: ts-offset 200 (the 100 ms the sink declares cancelled).
        expect(text).toContain('seed-lateness=200000000');
        expect(text).toContain('seed-lateness=50000000');
        expect(text).not.toContain('seed-lateness=4300000000');
        // At the default D 60 the ts-offset is 0: no seed starts the pace past the sink.
        const d60 = makeModule({ sources: 2, playout: { playoutOffsetMs: 60 } }).module;
        d60.services.mediaRouter.getModuleBusSources = vi.fn(() => [
            { ...source(0), seedLatenessMs: 45 },
            source(1),
        ]);
        expect(launched(d60.buildPipeline({ device: 'alsa_output.usb-foo' })!)).toContain(
            'seed-lateness=0 ',
        );
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
        module.buildPipeline({ device: 'alsa_output.usb-foo' });
        expect(module.getLiveInputBranch('other', 'c-0')).toBeNull();
        const add = module.getLiveInputBranch('audio-in', 'c-1');
        expect(add.element).toBe('mixin');
        expect(add.description).toContain('unixfdsrc socket-path=/tmp/mr-bus-40101-x.sock');
        // An edge already gone from the router: what a live remove needs, the bin's name.
        const gone = module.getLiveInputBranch('audio-in', 'c-9');
        expect(gone).toEqual({ element: 'mixin', name: expect.stringMatching(/^mixin_in_/) });
    });
});

describe('AudioOutput302mModule: a second source on a direct pipeline (B-194)', () => {
    it('gets no live branch until a build makes the mix: the classic restart does, no add tried', () => {
        const { module } = makeModule({ sources: 2 });
        const bus = module.services.mediaRouter.getModuleBusSources;
        const both = bus();
        // Launched with Master alone: the direct branch, no mixer to add to.
        bus.mockReturnValue(both.slice(0, 1));
        expect(module.buildPipeline({ device: 'alsa_output.usb-foo' }).liveInputs).toBeUndefined();
        // ENG IN wired: the router lists two, the running pipeline is still the direct one.
        bus.mockReturnValue(both);
        expect(module.getLiveInputBranch('audio-in', 'c-1')).toBeNull();
        expect(module.getLiveInputBranch('audio-in', 'c-0')).toBeNull();
        // The restart's build is the mix: from then on each source is a live input.
        expect(module.buildPipeline({ device: 'alsa_output.usb-foo' }).liveInputs).toHaveLength(2);
        expect(module.getLiveInputBranch('audio-in', 'c-1')).toMatchObject({ element: 'mixin' });
    });

    it('a description refresh while the mixer runs leaves it the mixer: a source back joins live', () => {
        const { module } = makeModule({ sources: 2 });
        const bus = module.services.mediaRouter.getModuleBusSources;
        const both = bus();
        module.buildPipeline({ device: 'alsa_output.usb-foo' }); // launched: the mixer
        module.childProcess = {}; // its runner
        // One source disabled (its branch dropped), the replay copy refreshed with one.
        bus.mockReturnValue(both.slice(0, 1));
        expect(module.buildPipeline({ device: 'alsa_output.usb-foo' }).liveInputs).toBeUndefined();
        // Enabled again: added to the running mixer, as before.
        bus.mockReturnValue(both);
        expect(module.getLiveInputBranch('audio-in', 'c-1')).toMatchObject({ element: 'mixin' });
    });
});

describe('AudioOutput302mModule.buildPipeline — house-clock presentation (ADR-0005)', () => {
    it('presents at stamp + D on the house clock: sync=true, ts-offset=D minus the ring it declares, custom-slaved, never drops late', () => {
        const { module } = makeModule({ sources: 1, playout: { playoutOffsetMs: 300 } });
        const desc = module.buildPipeline({ device: 'alsa_output.usb-foo' });
        expect(desc!.pipeline).toContain(
            '! pulsesink name=sink device=alsa_output.usb-foo sync=true provide-clock=false' +
                ' slave-method=3 max-lateness=-1 buffer-time=100000 ts-offset=200000000',
        );
        expect(desc!.pipeline).not.toContain('sync=false');
        // The latency-ratchet guard, at outasrc's input (content time), whole-buffer.
        expect(desc!.backlogShed).toMatchObject({
            element: 'outasrc',
            sink: 'sink',
            keyframeAligned: false,
        });
        // …and the input on content time from the formula demux: nothing to align to stamps.
        expect(desc!.pipeline).toContain(
            'mrtsdemux name=mixin_demux0 select=audio/x-smpte-302m ! avdec_s302m',
        );
        expect(desc!.pipeline).not.toMatch(/\btsdemux\b/);
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
        for (const [n, outasrc] of [
            [1, 'mrasrc name=outasrc bypass-below-ppm=0.5 device-sink=sink'],
            [2, 'mrasrc name=outasrc device-sink=sink'],
        ] as const) {
            const m = makeModule({ sources: n, playout: { playoutOffsetMs: 300 } }).module;
            const p: string = m.buildPipeline({ device: 'alsa_output.usb-foo' })!.pipeline;
            // The identity answers LATENCY live, so the sink adds its ring in the
            // non-live mixer arm too, and the same 300 − 100 ring offset holds.
            expect(p).toContain(
                'mixin_out. ! identity name=live_upstream sync=true' +
                    ` ! mrlateness name=lat_render reference=running-time ! audioconvert ! ${outasrc}` +
                    ' ! volume name=vol volume=1.00',
            );
            expect(p.match(/identity /g)).toHaveLength(1);
            expect(p).toContain('ts-offset=200000000');
        }
    });

    it('follows the device clock: outasrc on the sink by name, the sink custom-slaved, no audioresample, no skew (WI-P3-15)', () => {
        for (const sources of [1, 2, 3]) {
            for (const deviceChannels of [undefined, 32]) {
                const { module } = makeModule({ sources, deviceChannels });
                const p: string = module.buildPipeline({
                    device: 'alsa_output.usb-foo',
                    ...(deviceChannels ? { channels: 2, firstChannel: 3 } : {}),
                })!.pipeline;
                expect(p).not.toContain('audioresample');
                expect(p).not.toMatch(/slave-method=(1|skew)\b/);
                expect(p).toContain(' ! pulsesink name=sink device=alsa_output.usb-foo ');
                expect(p).toContain(' slave-method=3 ');
                expect(p.match(/ ! mrasrc name=outasrc [^!]*device-sink=sink /g)).toHaveLength(1);
            }
        }
    });

    it("one resampler per path: the single arm's branch has no ASRC, a mixer's branches each their own (OQ-23)", () => {
        const asrcs = (n: number): string[] => {
            const p = launched(
                makeModule({ sources: n }).module.buildPipeline({ device: 'alsa_output.usb-foo' })!,
            );
            return [...p.matchAll(/mrasrc ([^!]*?) ?!/g)].map((m) => m[1]);
        };
        // One source: outasrc carries the decode term and the device term, one resampler.
        expect(asrcs(1)).toEqual(['name=outasrc bypass-below-ppm=0.5 device-sink=sink']);
        // Two: outasrc the device term alone, and each live branch matches its source to house rate.
        expect(asrcs(2)).toEqual([
            'name=outasrc device-sink=sink',
            `name=${liveAsrcName('mixin', 'c-0')} bypass-below-ppm=0.5 out-rate=48000`,
            `name=${liveAsrcName('mixin', 'c-1')} bypass-below-ppm=0.5 out-rate=48000`,
        ]);
    });

    it('reads render lateness before outasrc, behind live_upstream (B-62, house-clock part 4.4)', () => {
        for (const sources of [1, 2]) {
            const p: string = makeModule({ sources }).module.buildPipeline({
                device: 'alsa_output.usb-foo',
            })!.pipeline;
            const at = (s: string): number => p.indexOf(s);
            expect(at('identity name=live_upstream sync=true')).toBeGreaterThan(at('mixin_out.'));
            expect(at('mrlateness name=lat_render ')).toBeGreaterThan(
                at('identity name=live_upstream'),
            );
            expect(at('mrasrc name=outasrc ')).toBeGreaterThan(at('mrlateness name=lat_render '));
            expect(at('pulsesink name=sink ')).toBeGreaterThan(at('mrasrc name=outasrc '));
            expect(p.match(/mrlateness name=lat_render /g)).toHaveLength(1);
        }
    });

    it("sheds at outasrc's input, on content time: after it the PTS run on the device's clock", () => {
        for (const sources of [1, 2]) {
            const desc = makeModule({ sources }).module.buildPipeline({
                device: 'alsa_output.usb-foo',
            })!;
            // The shed point is the element's sink pad; the budget is the sink's ts-offset + latency.
            expect(desc.backlogShed).toMatchObject({ element: 'outasrc', sink: 'sink' });
            expect(desc.pipeline).toMatch(
                / ! audioconvert ! mrasrc name=outasrc [^!]*device-sink=sink /,
            );
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
 *  wired; `built` holds each pipeline it starts. `repick` is a settings patch, then Restart.
 *  PipeWire answers as the engine's does, a turn later, unless `pw.answers` is false (B-207);
 *  its devices are `width` wide. */
function underEngine(
    present: Set<string>,
    width = 2,
    settings: Record<string, unknown> = {},
    pw = { answers: true },
) {
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
            hasDevice: async (name: string) => (pw.answers ? present.has(name) : null),
            getDeviceInfo: async () => (pw.answers ? { channels: width, sampleRate: 48000 } : null),
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
        { device: OLD, ...settings },
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

    it('a start reads the device width before the build, which cannot wait for PipeWire (B-200)', async () => {
        const { instance, built } = underEngine(new Set([OLD]), 32, {
            channels: 8,
            firstChannel: 9,
        });
        await instance.start();
        // Outputs 9-16 of the 32-wide card: the 16-wide spread, not "width unknown".
        expect(built[0]).toContain('audio/x-raw,channels=16,channel-mask=(bitmask)0x0');
        await instance.stop();
    });

    it('a device that comes after the start: its width is read before that first build (B-200)', async () => {
        const present = new Set<string>();
        const { module, instance, built } = underEngine(present, 32, {
            channels: 8,
            firstChannel: 9,
        });
        await instance.start();
        expect(built).toEqual([]);
        present.add(OLD);
        await module.deviceWatchdog.tick();
        expect(built[0]).toContain('audio/x-raw,channels=16,channel-mask=(bitmask)0x0');
        await instance.stop();
    });

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

describe('AudioOutput302mModule while PipeWire gives no answer (B-207, MR-042)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('a start waits for PipeWire, never for hot-plug, and plays once PipeWire lists the device', async () => {
        const pw = { answers: false };
        const { module, instance, built } = underEngine(new Set([OLD]), 2, {}, pw);
        await instance.start();
        expect(built).toEqual([]);
        expect(module.getState().error).toBe(
            'PipeWire is not answering — starting once PipeWire and the device are back',
        );
        await module.deviceWatchdog.tick();
        expect(built).toEqual([]);
        pw.answers = true;
        await module.deviceWatchdog.tick();
        expect(built).toHaveLength(1);
        expect(built[0]).toContain(`pulsesink name=sink device=${OLD} `);
        await instance.stop();
    });

    it('a running output is not stopped by a device check with no answer', async () => {
        const pw = { answers: true };
        const { module, instance, built } = underEngine(new Set([OLD]), 2, {}, pw);
        const lost = vi.spyOn(module, 'onDeviceDisconnected');
        await instance.start();
        pw.answers = false;
        for (let i = 0; i < 5; i++) await module.deviceWatchdog.tick();
        expect(lost).not.toHaveBeenCalled();
        expect(module.deviceWatchdog.isConnected()).toBe(true);
        expect(built).toHaveLength(1);
        await instance.stop();
    });
});
