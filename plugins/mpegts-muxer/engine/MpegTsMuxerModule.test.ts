import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    audioPortId,
    buildDynamicPorts,
    buildInputBranch,
    buildPipeline,
    isAudioInputPort,
    isVideoInputPort,
    sortSources,
    streamEntries,
    videoPortId,
} from './mpegtsMuxerPipeline.js';
import { MpegTsMuxerModule } from './MpegTsMuxerModule.js';

describe('mpegtsMuxerPipeline helpers', () => {
    describe('streamEntries', () => {
        it('reads the array shape, tolerating malformed entries', () => {
            const entries = streamEntries(
                { videoStreams: [{ name: 'Cam 1' }, {}, null, { name: 7 }] },
                'video',
            );
            expect(entries).toEqual([
                { name: 'Cam 1', offsetMs: 0 },
                { name: '', offsetMs: 0 },
                { name: '', offsetMs: 0 },
                { name: '', offsetMs: 0 },
            ]);
        });
        it('maps offsetMs, clamping to ±2000 and zeroing malformed values', () => {
            const entries = streamEntries(
                {
                    audioStreams: [
                        { name: 'ENG', offsetMs: -700 },
                        { name: '', offsetMs: -9999 },
                        { name: '', offsetMs: 9999 },
                        { name: '', offsetMs: 'nope' },
                        { name: '', offsetMs: NaN },
                    ],
                },
                'audio',
            );
            expect(entries.map((e) => e.offsetMs)).toEqual([-700, -2000, 2000, 0, 0]);
        });
        it('falls back to legacy counts + streamNames map (offsetMs 0)', () => {
            const entries = streamEntries(
                { audioStreamCount: 2, streamNames: { 'audio-1': 'FOH' } },
                'audio',
            );
            expect(entries).toEqual([
                { name: '', offsetMs: 0 },
                { name: 'FOH', offsetMs: 0 },
            ]);
        });
        it('defaults to one unnamed stream on an empty config', () => {
            expect(streamEntries({}, 'video')).toEqual([{ name: '', offsetMs: 0 }]);
        });
        it('clamps to the schema maxItems (8 video / 16 audio)', () => {
            const many = Array.from({ length: 20 }, () => ({ name: '' }));
            expect(streamEntries({ videoStreams: many }, 'video')).toHaveLength(8);
            expect(streamEntries({ audioStreams: many }, 'audio')).toHaveLength(16);
        });
    });

    describe('port id helpers', () => {
        it('produces matching prefix-based ids', () => {
            expect(videoPortId(0)).toBe('video-0');
            expect(audioPortId(2)).toBe('audio-2');
        });
        it('classifies port ids by direction prefix', () => {
            expect(isVideoInputPort('video-0')).toBe(true);
            expect(isVideoInputPort('audio-0')).toBe(false);
            expect(isAudioInputPort('audio-3')).toBe(true);
            expect(isAudioInputPort('mpegts-out')).toBe(false);
        });
    });

    describe('buildDynamicPorts', () => {
        it('emits one input port per configured stream + a single output', () => {
            const ports = buildDynamicPorts(2, 3);
            expect(ports).toHaveLength(2 + 3 + 1);
            expect(ports.filter((p) => p.direction === 'input')).toHaveLength(5);
            expect(ports.filter((p) => p.direction === 'output')).toHaveLength(1);
        });
        it('still exposes the output port when no inputs are configured', () => {
            const ports = buildDynamicPorts(0, 0);
            expect(ports).toHaveLength(1);
            expect(ports[0].direction).toBe('output');
        });
        it('caps each input at maxConnections=1 and the output at unlimited', () => {
            const ports = buildDynamicPorts(1, 1);
            const input = ports.find((p) => p.id === 'video-0')!;
            const output = ports.find((p) => p.direction === 'output')!;
            expect(input.maxConnections).toBe(1);
            expect(output.maxConnections).toBe(-1);
        });
    });

    describe('buildInputBranch', () => {
        it('uses multicast-group syntax for 239.x hosts and goes capsless on udpsrc (packet size auto-detected)', () => {
            const s = buildInputBranch('0', { sinkPortId: 'video-0', host: '239.255.0.1', port: 40000 });
            expect(s).toContain('udpsrc multicast-group=239.255.0.1 port=40000');
            expect(s).not.toContain('caps=');
            expect(s).toContain('tsdemux latency=0 name=demux_0');
            // No inline `! mux.` chain — pad-linking is done at runtime via linkOnPadAdded
            expect(s).not.toContain('! mux.');
        });
        it('goes straight from udpsrc to tsdemux with no tsparse — re-anchoring PCR mid-pipeline causes mpegtsmux PCR re-emit to surface as packet loss', () => {
            const s = buildInputBranch('0', { sinkPortId: 'video-0', host: '239.255.0.1', port: 40000 });
            expect(s).not.toContain('tsparse');
        });
        it('uses plain-port syntax for unicast hosts', () => {
            const s = buildInputBranch('1', { sinkPortId: 'audio-0', host: '127.0.0.1', port: 40001 });
            expect(s).toContain('udpsrc port=40001');
            expect(s).not.toContain('multicast-group');
        });
    });

    describe('buildPipeline', () => {
        it('returns null when no inputs are wired', () => {
            const result = buildPipeline({
                sources: [],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
            });
            expect(result).toBeNull();
        });
        it('connects mpegtsmux straight to udpsink with no leaky queue between — a leaky queue here would drop mid-stream UDP buffers and corrupt decode', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'video-0', host: '239.255.0.1', port: 40001 }],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
            });
            const p = result!.pipeline;
            expect(p).toMatch(/mpegtsmux name=mux[^!]+! udpsink/);
        });
        it('emits one demux branch per input plus a single mpegtsmux ! udpsink chain and per-media link rules', () => {
            const result = buildPipeline({
                sources: [
                    { sinkPortId: 'video-0', host: '239.255.0.1', port: 40001 },
                    { sinkPortId: 'audio-0', host: '239.255.0.1', port: 40002 },
                ],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
            });
            expect(result).not.toBeNull();
            expect(result!.pipeline).toContain('mpegtsmux name=mux latency=1200000000 min-upstream-latency=1200000000 alignment=7');
            expect(result!.pipeline).toContain('udpsink name=usink host=239.255.0.1 port=40010');
            expect(result!.pipeline.match(/tsdemux latency=0 name=demux_/g)).toHaveLength(2);
            expect(result!.pipeline).not.toContain('caps="video/mpegts');
            // One video rule for the video-0 source + one audio rule for the audio-0 source
            expect(result!.linkOnPadAdded).toHaveLength(2);
            expect(result!.linkOnPadAdded.every((r) => r.linkTo === 'mux')).toBe(true);
            const videoRule = result!.linkOnPadAdded.find((r) => r.media === 'video')!;
            const audioRule = result!.linkOnPadAdded.find((r) => r.media === 'audio')!;
            // Source order in the helper input is preserved (sortSources is
            // applied by the module, not the helper): video-0 → demux_0, audio-0 → demux_1
            expect(videoRule.from).toBe('demux_0');
            expect(audioRule.from).toBe('demux_1');
            // No codec parser in the branch — the Python pad-link runner
            // injects the right parser (`aacparse` / `ac3parse` / …) at
            // pad-added time based on the pad's actual caps.
            expect(audioRule.branches[0].startsWith('queue leaky=0')).toBe(true);
            expect(videoRule.branches[0].startsWith('queue leaky=0')).toBe(true);
            expect(audioRule.branches[0]).not.toContain('aacparse');
            expect(videoRule.branches[0]).not.toContain('h264parse');
        });
        it('pins deterministic PIDs via requestedPadNames (D3 scheme)', () => {
            const result = buildPipeline({
                sources: [
                    { sinkPortId: 'video-0', host: '239.255.0.1', port: 40001 },
                    { sinkPortId: 'video-1', host: '239.255.0.1', port: 40002 },
                    { sinkPortId: 'audio-0', host: '239.255.0.1', port: 40003 },
                    { sinkPortId: 'audio-1', host: '239.255.0.1', port: 40004 },
                ],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
            });
            const videoRules = result!.linkOnPadAdded.filter((r) => r.media === 'video');
            const audioRules = result!.linkOnPadAdded.filter((r) => r.media === 'audio');
            // video-0 → 0x100 (sink_256), video-1 → 0x101 (sink_257)
            expect(videoRules.map((r) => r.requestedPadNames)).toEqual([
                ['sink_256'],
                ['sink_257'],
            ]);
            // audio-0 → 0x140 (sink_320), audio-1 → 0x141 (sink_321)
            expect(audioRules.map((r) => r.requestedPadNames)).toEqual([
                ['sink_320'],
                ['sink_321'],
            ]);
        });
        it('numbers PIDs per-media-ordinal, not by global source index', () => {
            // An audio source ahead of a video source must not shift the video PID.
            const result = buildPipeline({
                sources: [
                    { sinkPortId: 'audio-0', host: '239.255.0.1', port: 40001 },
                    { sinkPortId: 'video-0', host: '239.255.0.1', port: 40002 },
                ],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
            });
            const videoRule = result!.linkOnPadAdded.find((r) => r.media === 'video')!;
            const audioRule = result!.linkOnPadAdded.find((r) => r.media === 'audio')!;
            expect(videoRule.requestedPadNames).toEqual(['sink_256']); // 0x100, not 0x101
            expect(audioRule.requestedPadNames).toEqual(['sink_320']); // 0x140
        });
        it('adds a udpsrc timeout on every input branch so a silent source restarts', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'video-0', host: '239.255.0.1', port: 40001 }],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
            });
            expect(result!.pipeline).toContain('timeout=5000000000');
        });
        it('does not emit a video rule for an audio-only source (and vice versa)', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'audio-0', host: '239.255.0.1', port: 40002 }],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
            });
            expect(result!.linkOnPadAdded).toHaveLength(1);
            expect(result!.linkOnPadAdded[0].media).toBe('audio');
        });
        it('honours the alignment config', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'video-0', host: '239.255.0.1', port: 40001 }],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 1,
            });
            expect(result!.pipeline).toContain('alignment=1');
        });
        it('defaults to non-leaky input queues (aggregator skew back-pressures, never sheds)', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'audio-0', host: '239.255.0.1', port: 40002 }],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
            });
            const audioRule = result!.linkOnPadAdded.find((r) => r.media === 'audio')!;
            // Measured on gate01: mpegtsmux back-pressures the leading pad by
            // the inter-stream skew on every buffer; a 50 ms leaky queue shed
            // 11% of audio frames. Non-leaky 500 ms bound lost zero.
            expect(audioRule.branches[0]).toBe(
                'queue leaky=0 max-size-time=500000000 max-size-buffers=0 max-size-bytes=0',
            );
        });
        it('threads queueDepthMs into the stability-mode bound (clamped 100–5000 ms)', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'audio-0', host: '239.255.0.1', port: 40002 }],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
                queueDepthMs: 1200,
            });
            expect(result!.linkOnPadAdded[0].branches[0]).toContain('max-size-time=1200000000');
            const clamped = buildPipeline({
                sources: [{ sinkPortId: 'audio-0', host: '239.255.0.1', port: 40002 }],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
                queueDepthMs: 99_999,
            });
            expect(clamped!.linkOnPadAdded[0].branches[0]).toContain('max-size-time=5000000000');
        });
        it('queueLeaky switches both input queues to shed-oldest at the same depth (never hold backlog)', () => {
            const result = buildPipeline({
                sources: [
                    { sinkPortId: 'video-0', host: '239.255.0.1', port: 40001 },
                    { sinkPortId: 'audio-0', host: '239.255.0.1', port: 40002 },
                ],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
                queueLeaky: true,
                queueDepthMs: 200,
            });
            const videoRule = result!.linkOnPadAdded.find((r) => r.media === 'video')!;
            const audioRule = result!.linkOnPadAdded.find((r) => r.media === 'audio')!;
            expect(videoRule.branches[0]).toContain('queue leaky=2 max-size-time=200000000');
            expect(audioRule.branches[0]).toContain('queue leaky=2 max-size-time=200000000');
        });
        it('emits parser-free branches (parser is picked by the runner from per-pad caps)', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'audio-0', host: '239.255.0.1', port: 40002 }],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
            });
            const branch = result!.linkOnPadAdded[0].branches[0];
            expect(branch.startsWith('queue leaky=0')).toBe(true);
            expect(branch).not.toMatch(/aacparse|ac3parse|mpegaudioparse|opusparse/);
        });
        it('emits a non-leaky bounded queue on the video branch (parser is injected ahead of it by the runner so back-pressure lands on whole frames)', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'video-0', host: '239.255.0.1', port: 40001 }],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
            });
            const videoRule = result!.linkOnPadAdded.find((r) => r.media === 'video')!;
            expect(videoRule.branches[0]).toBe(
                'queue leaky=0 max-size-time=500000000 max-size-buffers=0 max-size-bytes=0',
            );
        });
        it('has no metadata appsrc so mpegtsmux carries PCR on the media (not a software timer)', () => {
            // The KLV metadata appsrc was retired: as a live `do-timestamp`
            // appsrc it got picked as the mpegtsmux PCR stream, so the receiver
            // clock rode the ~50 ms carousel timer instead of the media and
            // sporadically dropped audio. Only media pads remain → PCR on video.
            const result = buildPipeline({
                sources: [
                    { sinkPortId: 'video-0', host: '239.255.0.1', port: 40001 },
                    { sinkPortId: 'audio-0', host: '239.255.0.1', port: 40002 },
                ],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
            });
            expect(result!.pipeline).not.toContain('appsrc');
            expect(result!.pipeline).not.toContain('meta/x-klv');
            expect(result!.pipeline).not.toContain('mux.sink_496');
            expect(result!.pipeline).toMatch(/mpegtsmux name=mux[^!]+! udpsink/);
        });

        it('emits tsdemux latency=0 on every input branch', () => {
            const result = buildPipeline({
                sources: [
                    { sinkPortId: 'video-0', host: '239.255.0.1', port: 40001 },
                    { sinkPortId: 'audio-0', host: '239.255.0.1', port: 40002 },
                ],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
            });
            expect(result!.pipeline.match(/tsdemux latency=0 name=demux_/g)).toHaveLength(2);
        });

        it('puts offsetMs on the AUDIO rule as padOffsetNs (lipsync knob), omitted at 0 so the default rule shape is unchanged', () => {
            const result = buildPipeline({
                sources: [
                    { sinkPortId: 'video-0', host: '239.255.0.1', port: 40001, offsetMs: -700 },
                    { sinkPortId: 'audio-0', host: '239.255.0.1', port: 40002, offsetMs: -700 },
                    { sinkPortId: 'audio-1', host: '239.255.0.1', port: 40003, offsetMs: 0 },
                    { sinkPortId: 'audio-2', host: '239.255.0.1', port: 40004 },
                ],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
            });
            const videoRule = result!.linkOnPadAdded.find((r) => r.media === 'video')!;
            const audioRules = result!.linkOnPadAdded.filter((r) => r.media === 'audio');
            // Video never gets an offset — delaying video adds real latency.
            expect('padOffsetNs' in videoRule).toBe(false);
            expect(audioRules[0].padOffsetNs).toBe(-700_000_000);
            // 0 / absent → key omitted entirely (byte-identical default rules).
            expect('padOffsetNs' in audioRules[1]).toBe(false);
            expect('padOffsetNs' in audioRules[2]).toBe(false);
        });

        it('clamps out-of-range offsetMs at the rule level too (±2000)', () => {
            const result = buildPipeline({
                sources: [
                    { sinkPortId: 'audio-0', host: '239.255.0.1', port: 40002, offsetMs: -5000 },
                ],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
            });
            expect(result!.linkOnPadAdded[0].padOffsetNs).toBe(-2_000_000_000);
        });
    });

    describe('sortSources', () => {
        it('sorts by sinkPortId so pipeline output is deterministic', () => {
            const out = sortSources([
                { sinkPortId: 'video-1', host: 'h', port: 1 },
                { sinkPortId: 'audio-0', host: 'h', port: 2 },
                { sinkPortId: 'video-0', host: 'h', port: 3 },
            ]);
            expect(out.map((s) => s.sinkPortId)).toEqual(['audio-0', 'video-0', 'video-1']);
        });
    });
});

describe('MpegTsMuxerModule', () => {
    function makeModule(opts: { sources?: Array<{ sinkPortId: string; port: number }> } = {}) {
        const module = new MpegTsMuxerModule();
        const getModuleUdpSources = vi.fn(() =>
            (opts.sources ?? []).map((s) => ({
                host: '239.255.0.1',
                port: s.port,
                connectionId: 'c-' + s.sinkPortId,
                sourceModuleId: 'enc-' + s.sinkPortId,
                sourcePortId: 'mpegts-out',
                sinkPortId: s.sinkPortId,
            })),
        );
        const assignUdpPort = vi.fn(() => ({ host: '239.255.0.1', port: 41000 }));
        (module as any).services = {
            instanceId: 'mux-1',
            mediaRouter: { getModuleUdpSources, assignUdpPort },
        };
        return { module, getModuleUdpSources, assignUdpPort };
    }

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('getDynamicPorts', () => {
        it('sizes ports from the videoStreams/audioStreams arrays', () => {
            const { module } = makeModule();
            (module as any).config = {
                videoStreams: [{ name: 'Cam 1' }, { name: '' }],
                audioStreams: [{ name: 'FOH' }],
            };
            const ports = module.getDynamicPorts();
            expect(ports.filter((p) => p.direction === 'input')).toHaveLength(3);
            expect(ports.filter((p) => p.direction === 'output')).toHaveLength(1);
        });
        it('still honours legacy videoStreamCount/audioStreamCount configs', () => {
            const { module } = makeModule();
            (module as any).config = { videoStreamCount: 2, audioStreamCount: 3 };
            const ports = module.getDynamicPorts();
            expect(ports.filter((p) => p.direction === 'input')).toHaveLength(5);
            expect(ports.filter((p) => p.direction === 'output')).toHaveLength(1);
        });
        it('falls back to defaults (1+1) when config is empty', () => {
            const { module } = makeModule();
            (module as any).config = {};
            const ports = module.getDynamicPorts();
            // 1 video + 1 audio + 1 output = 3
            expect(ports).toHaveLength(3);
        });
    });

    describe('buildPipeline', () => {
        it('returns null + warning when no inputs are connected', () => {
            const { module } = makeModule({ sources: [] });
            (module as any).config = { videoStreamCount: 1, audioStreamCount: 1 };
            const setHealth = vi.fn();
            (module as any).setHealth = setHealth;
            expect(module.buildPipeline((module as any).config)).toBeNull();
            expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('No inputs'));
        });

        it('produces one branch per connected input and uses the assigned encoder port', () => {
            const { module, assignUdpPort } = makeModule({
                sources: [
                    { sinkPortId: 'video-0', port: 40001 },
                    { sinkPortId: 'audio-0', port: 40002 },
                ],
            });
            (module as any).config = {
                videoStreamCount: 1,
                audioStreamCount: 1,
                alignment: 7,
            };
            (module as any).setHealth = vi.fn();
            (module as any).setStatusData = vi.fn();
            const desc = module.buildPipeline((module as any).config);
            expect(desc).not.toBeNull();
            expect(desc!.pipeline).toContain('mpegtsmux name=mux');
            expect(desc!.pipeline).toContain('host=239.255.0.1 port=41000');
            expect(desc!.pipeline.match(/tsdemux latency=0 name=demux_/g)).toHaveLength(2);
            // 1 video rule (for video-0) + 1 audio rule (for audio-0)
            expect(desc!.linkOnPadAdded).toHaveLength(2);
            expect(assignUdpPort).toHaveBeenCalledWith('mux-1');
        });

        it('declares the stream arrays as live-updatable', () => {
            const { module } = makeModule();
            expect(module.getLiveUpdatableParams()).toEqual(['videoStreams', 'audioStreams']);
        });

        it('isLiveChange: rename is live, add/remove or legacy shape is not', () => {
            const { module } = makeModule();
            // Same length → rename (label only) → live update, no rebuild.
            expect(
                module.isLiveChange('videoStreams', [{ name: 'B' }], [{ name: 'A' }]),
            ).toBe(true);
            // Length change → port set changed → pending restart.
            expect(
                module.isLiveChange('audioStreams', [{ name: '' }, { name: '' }], [{ name: '' }]),
            ).toBe(false);
            // First write over a legacy count-based config → pending restart.
            expect(module.isLiveChange('videoStreams', [{ name: '' }], undefined)).toBe(false);
            // Unrelated keys are not refined here.
            expect(module.isLiveChange('bufferMs', 100, 50)).toBe(true);
        });

        it('isLiveChange: an offsetMs edit is NOT live — the offset is applied at pad-link time, so a live update would silently swallow it', () => {
            const { module } = makeModule();
            expect(
                module.isLiveChange(
                    'audioStreams',
                    [{ name: 'ENG', offsetMs: -700 }],
                    [{ name: 'ENG', offsetMs: 0 }],
                ),
            ).toBe(false);
            // Absent offsetMs (old entry shape) is equivalent to 0.
            expect(
                module.isLiveChange(
                    'audioStreams',
                    [{ name: 'ENG', offsetMs: -700 }],
                    [{ name: 'ENG' }],
                ),
            ).toBe(false);
            // Rename with unchanged offset stays live.
            expect(
                module.isLiveChange(
                    'audioStreams',
                    [{ name: 'NOR', offsetMs: -700 }],
                    [{ name: 'ENG', offsetMs: -700 }],
                ),
            ).toBe(true);
            // Rename where neither side carries an offset stays live too.
            expect(
                module.isLiveChange('audioStreams', [{ name: 'B' }], [{ name: 'A' }]),
            ).toBe(true);
        });

        it('passes audioStreams offsetMs from config through to the audio pad-link rule', () => {
            const { module } = makeModule({
                sources: [
                    { sinkPortId: 'video-0', port: 40001 },
                    { sinkPortId: 'audio-0', port: 40002 },
                ],
            });
            (module as any).config = {
                videoStreams: [{ name: '' }],
                audioStreams: [{ name: 'ENG', offsetMs: -700 }],
                alignment: 7,
            };
            (module as any).setHealth = vi.fn();
            (module as any).setStatusData = vi.fn();
            const desc = module.buildPipeline((module as any).config);
            const audioRule = desc!.linkOnPadAdded!.find((r) => r.media === 'audio')!;
            const videoRule = desc!.linkOnPadAdded!.find((r) => r.media === 'video')!;
            expect(audioRule.padOffsetNs).toBe(-700_000_000);
            expect('padOffsetNs' in videoRule).toBe(false);
        });

        it('exposes offsetMs in the audioStreams schema (and not in videoStreams)', () => {
            const schema = JSON.parse(
                readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
            ).mediaRouter.configSchema.properties;
            const audioItem = schema.audioStreams.items.properties;
            expect(audioItem.offsetMs).toMatchObject({
                type: 'number',
                default: 0,
                minimum: -2000,
                maximum: 2000,
            });
            expect(schema.videoStreams.items.properties.offsetMs).toBeUndefined();
        });

        it('ignores connections that arrive on unknown port ids (e.g. the output)', () => {
            const { module } = makeModule({
                sources: [
                    { sinkPortId: 'video-0', port: 40001 },
                    { sinkPortId: 'mpegts-out', port: 40005 }, // shouldn't happen but be defensive
                ],
            });
            (module as any).config = { videoStreamCount: 1, audioStreamCount: 1 };
            (module as any).setHealth = vi.fn();
            (module as any).setStatusData = vi.fn();
            const desc = module.buildPipeline((module as any).config);
            expect(desc!.pipeline.match(/tsdemux latency=0 name=demux_/g)).toHaveLength(1);
        });
    });
});
