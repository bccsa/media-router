import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    DEVICE_STALLED_TEXT,
    GstPluginBase,
    ModuleInstance,
    liveInputLaunchText,
} from '@media-router/engine';
import {
    default302mChannelMap,
    liveAsrcName,
    liveDemuxName,
    mixMatrixClause,
} from '@media-router/plugin-audio-302m-core';
import { AudioOutput302mModule } from './AudioOutput302mModule.js';

/** The pipeline the runner launches when every source runs: the mixer, its inputs linked in. */
const launched = (desc: { pipeline: string; liveInputs?: any[] }): string =>
    [desc.pipeline, ...(desc.liveInputs ?? []).map((b, i) => liveInputLaunchText(b, i))].join(' ');

function makeModule(
    opts: {
        sources?: number;
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
    module.services = {
        instanceId: 'aout-1',
        mediaRouter: { getModuleBusSources: vi.fn(() => sources) },
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
    return { module, setHealth, setElementProperty };
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
            'pulsesink name=sink device=alsa_output.usb-foo sync=false',
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
            'mixin_out. ! mrlateness name=lat_render reference=running-time ! audioconvert' +
                ' ! mrasrc name=outasrc bypass-below-ppm=0.5 device-sink=sink ! volume',
        );
        expect(desc!.pipeline).toContain(
            'pulsesink name=sink device=alsa_output.usb-foo sync=false',
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

    it('the default range on a stereo device, or one of unknown width, keeps the string byte-for-byte (B-214)', () => {
        // P4 main's strings before B-214 (44397cb0, B-167): every translation station's SSL 2 output.
        const tail =
            ' ! capsfilter name=mixin_out caps="audio/x-raw,rate=48000,channels=2" mixin_out.' +
            ' ! mrlateness name=lat_render reference=running-time' +
            ' ! audioconvert ! mrasrc name=outasrc%ASRC% device-sink=sink ! volume name=vol volume=1.00' +
            ' ! level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000' +
            ' ! queue name=prefill leaky=0 min-threshold-time=40000000 max-size-time=1000000000' +
            ' max-size-buffers=0 max-size-bytes=0' +
            ' ! pulsesink name=sink device=alsa_output.usb-foo sync=false provide-clock=false buffer-time=100000' +
            ' stream-properties="props,node.dont-fallback=(string)true,node.linger=(string)true"';
        const ingress = (i: number, hash: string) =>
            `unixfdsrc socket-path=/tmp/mr-bus-${40100 + i}-x.sock` +
            ` ! mrlateness name=lat_busin_${40100 + i}_${hash} reference=house` +
            ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=40000000';
        const direct =
            `${ingress(0, 'ee74db')} ! mrtsdemux name=mixin_demux0 select=audio/x-smpte-302m` +
            ' ! avdec_s302m ! audioconvert' +
            ' ! queue leaky=0 max-size-time=100000000 max-size-buffers=0 max-size-bytes=0' +
            tail.replace('%ASRC%', ' bypass-below-ppm=0.5');
        const branch = (i: number, hash: string, bin: string) =>
            `( name=mixin_in_${bin} ${ingress(i, hash)}` +
            ` ! mrtsdemux name=mixin_demux_${bin} select=audio/x-smpte-302m ! avdec_s302m` +
            ` ! mrasrc name=mixin_asrc_${bin} bypass-below-ppm=0.5 out-rate=48000 ! audioconvert` +
            ` ! audio/x-raw,rate=48000,channels=2 ! mralignwatch name=mixin_aw_${bin} aligner=mixin` +
            ` input="c-${i}" hold-on-eos=true ) ! mixin.sink_${i}`;
        const mixed =
            'audiomixer name=mixin latency=0 start-time-selection=first' +
            tail.replace('%ASRC%', '') +
            ` ${branch(0, 'ee74db', '30ace7')} ${branch(1, '1f270a', '30ab54')}`;
        for (const deviceChannels of [2, null]) {
            for (const channels of [2, undefined]) {
                const one = makeModule({ sources: 1, deviceChannels }).module.buildPipeline({
                    device: 'alsa_output.usb-foo',
                    channels,
                });
                expect(launched(one!)).toBe(direct);
                const { module } = makeModule({ sources: 2, deviceChannels });
                const two = module.buildPipeline({ device: 'alsa_output.usb-foo', channels });
                expect(launched(two!)).toBe(mixed);
                // A source that joins or re-links live gets that same branch (B-206's rig re-links).
                two!.liveInputs.forEach((b: any, i: number) =>
                    expect(module.getLiveInputBranch('audio-in', `c-${i}`)).toEqual(b),
                );
            }
        }
    });

    it('MR-052: mono or stereo on channel 1 of a wider card is placed, mono as channel 1 of a 2-wide stream', () => {
        const mono = makeModule({ sources: 1, deviceChannels: 4 }).module.buildPipeline({
            device: 'alsa_output.usb-foo',
            channels: 1,
        });
        expect(mono!.pipeline).toContain(
            'interval=100000000 ! audioconvert mix-matrix="<<(float)1.0000>, <(float)0.0000>>"' +
                ' ! audio/x-raw,channels=2,channel-mask=(bitmask)0x0 ! queue name=prefill ',
        );
        // One channel is mono whatever its mask: the mix is not pinned, the source not matrixed.
        expect(mono!.pipeline).toContain('caps="audio/x-raw,rate=48000,channels=1"');
        expect(mono!.pipeline).toContain('avdec_s302m ! audioconvert ! queue');
        const stereo = makeModule({ sources: 2, deviceChannels: 32 }).module.buildPipeline({
            device: 'alsa_output.usb-foo',
        });
        expect(stereo!.pipeline).toContain(
            'caps="audio/x-raw,rate=48000,channels=2,channel-mask=(bitmask)0x3"',
        );
        expect(stereo!.pipeline).toContain(
            'interval=100000000 ! capssetter caps="audio/x-raw,channel-mask=(bitmask)0x0"' +
                ' ! audioconvert mix-matrix="<<(float)1.0000, (float)0.0000>, <(float)0.0000, (float)1.0000>>"' +
                ' ! audio/x-raw,channels=2,channel-mask=(bitmask)0x0 ! queue name=prefill ',
        );
    });

    it('MR-056: a placed mix pins its layout on the mixer and every input, each brought to it by its map or the default (MR-053)', () => {
        const { module } = makeModule({ sources: 4, deviceChannels: 32 });
        const bus = module.services.mediaRouter.getModuleBusSources;
        const four = bus().map((s: any, i: number) =>
            i < 2 ? s : { ...s, channelMap: [{ srcChannel: 0, dstChannel: i }] },
        );
        bus.mockReturnValue(four);
        const desc = module.buildPipeline({ device: 'alsa_output.usb-foo', channels: 4 });
        const quad = 'audio/x-raw,rate=48000,channels=4,channel-mask=(bitmask)0x33';
        expect(desc.pipeline).toContain(`capsfilter name=mixin_out caps="${quad}"`);
        const unmapped = mixMatrixClause(default302mChannelMap(2, 4), 2, 4);
        desc.liveInputs.forEach((b: any, i: number) => {
            const matrix =
                i < 2 ? unmapped : mixMatrixClause([{ srcChannel: 0, dstChannel: i }], 2, 4);
            expect(b.description).toContain(`! audioconvert${matrix} ! ${quad} ! mralignwatch`);
            // A source that joins later is built to the launched layout.
            expect(module.getLiveInputBranch('audio-in', `c-${i}`)).toEqual(b);
        });
        // The default reaches channels 3 and 4 at half level: what the editor shows (MR-053).
        expect(default302mChannelMap(2, 4)).toEqual([
            { srcChannel: 0, dstChannel: 0 },
            { srcChannel: 1, dstChannel: 1 },
            { srcChannel: 0, dstChannel: 2, gain: 0.5 },
            { srcChannel: 1, dstChannel: 3, gain: 0.5 },
        ]);
        // One source: the direct arm is held to the same layout.
        bus.mockReturnValue(four.slice(0, 1));
        const one = module.buildPipeline({ device: 'alsa_output.usb-foo', channels: 4 });
        expect(one.pipeline).toContain(
            `avdec_s302m ! audioconvert${unmapped} ! queue leaky=0 max-size-time=100000000` +
                ` max-size-buffers=0 max-size-bytes=0 ! capsfilter name=mixin_out caps="${quad}"`,
        );
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
        // The mix is 8 wide, its layout pinned; VU reads it before the spread.
        expect(p).toContain(
            'capsfilter name=mixin_out caps="audio/x-raw,rate=48000,channels=8,channel-mask=(bitmask)0xc3f"',
        );
        expect(p).toMatch(
            /level post-messages=true[^!]*! capssetter caps="audio\/x-raw,channel-mask=\(bitmask\)0x0" ! audioconvert mix-matrix="<[^"]*>" ! audio\/x-raw,channels=16,channel-mask=\(bitmask\)0x0 ! queue name=prefill [^!]*! pulsesink name=sink device=alsa_output\.usb-foo sync=false [^!]*stream-properties="[^"]*"$/,
        );
        // 16 wide — up to the last channel used, never the card's 32.
        // Row 8 (device channel 9) carries mix channel 0: the first lit cell.
        const matrix = /capssetter [^!]*! audioconvert mix-matrix="<([^"]*)>"/.exec(p)![1];
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

    it('placement sits before the prefill and leaves the sink exactly as it is without it', () => {
        const tail = (deviceChannels: number | undefined, firstChannel: number) => {
            const { module } = makeModule({ sources: 1, deviceChannels });
            const p: string = module.buildPipeline({
                device: 'alsa_output.usb-foo',
                channels: 2,
                firstChannel,
            })!.pipeline;
            return p.slice(p.indexOf(' ! queue name=prefill '));
        };
        const placed = makeModule({ sources: 1, deviceChannels: 32 }).module.buildPipeline({
            device: 'alsa_output.usb-foo',
            channels: 2,
            firstChannel: 3,
        })!.pipeline;
        expect(placed).toContain('channel-mask=(bitmask)0x0 ! queue name=prefill ');
        expect(tail(32, 3)).toBe(tail(undefined, 1));
        expect(tail(32, 3)).toMatch(
            /^ ! queue name=prefill [^!]* ! pulsesink name=sink device=alsa_output\.usb-foo sync=false provide-clock=false buffer-time=100000 stream-properties="[^"]*"$/,
        );
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
});

describe('AudioOutput302mModule: a launch catches up, whatever its sources went through (B-206)', () => {
    it('the runner skips what each input delivers from before the launch plays, as TS at its ingress tap, both arms', () => {
        const mixed = makeModule({ sources: 2 }).module.buildPipeline({
            device: 'alsa_output.usb-foo',
        });
        expect(mixed!.catchUp).toEqual({ prefix: 'lat_busin', render: 'lat_render' });
        // Every input of the launch (and of a live add) has its tap under that prefix, before
        // its ingress queue: the TS is dropped in the thread that reads the socket.
        const taps = launched(mixed!).match(
            /unixfdsrc [^!]+! mrlateness name=lat_busin_\S+ reference=house ! queue/g,
        );
        expect(taps).toHaveLength(2);
        const direct = makeModule({ sources: 1 }).module.buildPipeline({
            device: 'alsa_output.usb-foo',
        });
        expect(direct!.catchUp).toEqual({ prefix: 'lat_busin', render: 'lat_render' });
        expect(direct!.pipeline).toContain('mrlateness name=lat_busin_');
    });

    it('B-167: the render tap is the one element the mix first plays out of, right after the continuation, in both arms', () => {
        for (const sources of [1, 2]) {
            const p = launched(
                makeModule({ sources }).module.buildPipeline({ device: 'alsa_output.usb-foo' })!,
            );
            // There the runner skips what queued before the output first played: a mix that
            // waited out an absent input's silence limit plays live, not that wait behind.
            expect(p.match(/ name=lat_render /g)).toHaveLength(1);
            expect(p).toContain(
                'mixin_out. ! mrlateness name=lat_render reference=running-time ! ',
            );
        }
    });

    it('a launch seeds every pace at 0, whatever a producer last read (B-167: no D to hold them to)', () => {
        const { module } = makeModule({ sources: 3 });
        module.services.mediaRouter.getModuleBusSources = vi.fn(() => [
            { ...source(0), seedLatenessMs: 4300 },
            { ...source(1), seedLatenessMs: 50 },
            source(2),
        ]);
        const text = launched(module.buildPipeline({ device: 'alsa_output.usb-foo' })!);
        // A read off a producer's outage burst is stale; one that really is late lifts the
        // pace itself once it delivers. A source with no reading has no seed.
        expect(text.match(/ seed-lateness=\d+/g)).toEqual([' seed-lateness=0', ' seed-lateness=0']);
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

describe('AudioOutput302mModule timing (WI-P4-12)', () => {
    it("its Timing section: outasrc's render lateness, device relocks and stalls; a stalled device warns", () => {
        const { module, setHealth } = makeModule({ sources: 2 });
        const desc = module.buildPipeline({ device: 'alsa_output.usb-foo' })!;
        const deliver = (c: string, p: unknown) => module.dispatchPluginEvent(c, p);
        const ms = (v: number) => ({
            count: 50,
            'min-ns': v * 1e6,
            'mean-ns': v * 1e6,
            'max-ns': v * 1e6,
        });
        module.timing.start(desc);
        module.health = 'ok';
        setHealth.mockImplementation((health: string, error?: string) => {
            module.health = health;
            module.error = error;
        });
        const stats = (o: Record<string, number> = {}) => ({
            mode: 'device',
            state: 'locked',
            'in-frames': 96_000,
            relocks: 0,
            'device-ppb': -135_000,
            'device-relocks': 0,
            'device-stalls': 0,
            'render-lateness-ns': 290_000_000,
            ...o,
        });
        deliver('mrlateness:lat_render', ms(110));
        deliver('mrasrc-stats:outasrc', stats());
        module.timing.tick();
        const pub = module.timing.publication;
        expect(pub.sections[0].fields.map((f: { label: string }) => f.label)).toEqual(
            expect.arrayContaining([
                'Render lateness',
                'Device latency',
                'Device clock',
                'Device relocks',
                'Device stalls',
            ]),
        );
        expect(JSON.stringify(pub)).not.toMatch(/Presentation delay/);
        expect(pub.data.timing).toMatchObject({
            renderMs: 290,
            deviceLatencyMs: 180,
            deviceStalls: 0,
        });
        // B-206's late 'Plays nothing' gives way to the device term's stall (T24).
        deliver('mrasrc-event:outasrc', {
            kind: 'device-stalled',
            reason: '',
            'pending-frames': 4800,
        });
        expect(setHealth).toHaveBeenLastCalledWith('warning', DEVICE_STALLED_TEXT);
        deliver('mrasrc-stats:outasrc', stats({ 'device-stalls': 1 }));
        deliver('mrasrc-event:outasrc', {
            kind: 'device-resumed',
            reason: '',
            'dropped-frames': 9600,
        });
        expect(setHealth).toHaveBeenLastCalledWith('ok');
        module.timing.stop(false);
    });
});

describe('AudioOutput302mModule.buildPipeline — plays as soon as it can (house-clock part 4.1, B-167)', () => {
    /** The four shapes: one source or two (the mixer), on the default range or placed. */
    const SHAPES = {
        single: { sources: 1, deviceChannels: undefined, range: {} },
        mixer: { sources: 2, deviceChannels: undefined, range: {} },
        singlePlaced: { sources: 1, deviceChannels: 32, range: { channels: 2, firstChannel: 3 } },
        mixerPlaced: { sources: 2, deviceChannels: 32, range: { channels: 2, firstChannel: 3 } },
    } as const;
    const build = (name: keyof typeof SHAPES, extra: Record<string, unknown> = {}): string => {
        const s = SHAPES[name];
        const { module } = makeModule({ sources: s.sources, deviceChannels: s.deviceChannels });
        return launched(
            module.buildPipeline({ device: 'alsa_output.usb-foo', ...s.range, ...extra })!,
        );
    };

    it('the strings of both arms, with and without placement, are tests/pipelines.json (`vitest -u` rewrites it)', async () => {
        const out = Object.fromEntries(Object.keys(SHAPES).map((k) => [k, build(k as any)]));
        await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(
            '../tests/pipelines.json',
        );
    });

    it('each: lat_render, outasrc on the sink, the VU, the 40 ms prefill, a sync=false sink; nothing that waits or drops', () => {
        for (const name of Object.keys(SHAPES) as Array<keyof typeof SHAPES>) {
            const p = build(name);
            const at = (s: string): number => p.indexOf(s);
            // Render lateness before outasrc, where PTS is still content time (part 4.4).
            expect(p).toContain(
                'mixin_out. ! mrlateness name=lat_render reference=running-time ! audioconvert ! mrasrc name=outasrc ',
            );
            expect(p).toMatch(/ ! mrasrc name=outasrc [^!]*device-sink=sink ! volume name=vol /);
            expect(at('level post-messages=true')).toBeGreaterThan(at('mrasrc name=outasrc '));
            expect(p).toContain(
                ' ! queue name=prefill leaky=0 min-threshold-time=40000000 max-size-time=1000000000' +
                    ' max-size-buffers=0 max-size-bytes=0 ! pulsesink name=sink device=alsa_output.usb-foo' +
                    ' sync=false provide-clock=false buffer-time=100000 stream-properties=',
            );
            expect(at(' ! queue name=prefill ')).toBeGreaterThan(at('level post-messages=true'));
            for (const gone of [
                'ts-offset',
                'slave-method',
                'sync=true',
                'max-lateness',
                'live_upstream',
                'identity ',
                'audioresample',
            ]) {
                expect(p).not.toContain(gone);
            }
            expect(p.match(/mrlateness name=lat_render /g)).toHaveLength(1);
        }
    });

    it('only volume and audioEnabled are live: nothing else reaches the sink (B-167)', () => {
        const { module } = makeModule({ sources: 1 });
        expect(module.liveUpdatableParams).toEqual(['volume', 'audioEnabled']);
    });

    it('volume is still live, on the gst volume element', async () => {
        const { module, setElementProperty } = makeModule({ sources: 2 });
        module.config = { device: 'alsa_output.usb-foo' };
        module.buildPipeline(module.config);
        await module.onLiveConfigUpdate({ volume: 40 });
        expect(setElementProperty).toHaveBeenLastCalledWith('vol', 'volume', 0.4);
    });

    it('the status says house clock, with no playout offset', () => {
        const { module } = makeModule({ sources: 1 });
        module.buildPipeline({ device: 'alsa_output.usb-foo' });
        const [, output] = module.setStatusData.mock.calls.find((c: any[]) => c[0] === 'output');
        expect(output.timing).toBe('house clock');
        expect(output).not.toHaveProperty('tsOffsetMs');
    });

    it('follows the device clock: outasrc on the sink by name, read on a timer, no audioresample, no skew (WI-P3-15, B-166)', () => {
        for (const sources of [1, 2, 3]) {
            for (const deviceChannels of [undefined, 32]) {
                const { module } = makeModule({ sources, deviceChannels });
                const p: string = module.buildPipeline({
                    device: 'alsa_output.usb-foo',
                    ...(deviceChannels ? { channels: 2, firstChannel: 3 } : {}),
                })!.pipeline;
                expect(p).not.toContain('audioresample');
                expect(p).not.toContain('slave-method');
                expect(p).toContain(
                    ' ! pulsesink name=sink device=alsa_output.usb-foo sync=false ',
                );
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

    it('the input on content time from the formula demux: nothing to align to stamps', () => {
        const p = makeModule({ sources: 1 }).module.buildPipeline({
            device: 'alsa_output.usb-foo',
        })!.pipeline;
        expect(p).toContain('mrtsdemux name=mixin_demux0 select=audio/x-smpte-302m ! avdec_s302m');
        expect(p).not.toMatch(/\btsdemux\b/);
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
