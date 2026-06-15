import { describe, it, expect, vi, beforeEach } from 'vitest';
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
                { name: 'Cam 1' },
                { name: '' },
                { name: '' },
                { name: '' },
            ]);
        });
        it('falls back to legacy counts + streamNames map', () => {
            const entries = streamEntries(
                { audioStreamCount: 2, streamNames: { 'audio-1': 'FOH' } },
                'audio',
            );
            expect(entries).toEqual([{ name: '' }, { name: 'FOH' }]);
        });
        it('defaults to one unnamed stream on an empty config', () => {
            expect(streamEntries({}, 'video')).toEqual([{ name: '' }]);
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
        it('uses multicast-group syntax for 239.x hosts and declares MPEG-TS caps on udpsrc', () => {
            const s = buildInputBranch('0', { sinkPortId: 'video-0', host: '239.255.0.1', port: 40000 });
            expect(s).toContain('udpsrc multicast-group=239.255.0.1 port=40000');
            expect(s).toContain('caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188"');
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
            expect(result!.pipeline).toContain('mpegtsmux name=mux latency=0 alignment=7');
            expect(result!.pipeline).toContain('udpsink name=usink host=239.255.0.1 port=40010');
            expect(result!.pipeline.match(/tsdemux latency=0 name=demux_/g)).toHaveLength(2);
            expect(result!.pipeline.match(/caps="video\/mpegts/g)).toHaveLength(2);
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
            expect(audioRule.branches[0].startsWith('queue leaky=2')).toBe(true);
            expect(videoRule.branches[0].startsWith('queue leaky=2')).toBe(true);
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
        it('threads bufferMs into the audio pad-link queue (video uses a buffer-count queue, not time-based)', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'audio-0', host: '239.255.0.1', port: 40002 }],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
                bufferMs: 50,
            });
            const audioRule = result!.linkOnPadAdded.find((r) => r.media === 'audio')!;
            // 50ms = 50_000_000 ns
            expect(audioRule.branches[0]).toContain('queue leaky=2 max-size-time=50000000');
        });
        it('emits parser-free branches (parser is picked by the runner from per-pad caps)', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'audio-0', host: '239.255.0.1', port: 40002 }],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
            });
            const branch = result!.linkOnPadAdded[0].branches[0];
            expect(branch.startsWith('queue leaky=2')).toBe(true);
            expect(branch).not.toMatch(/aacparse|ac3parse|mpegaudioparse|opusparse/);
        });
        it('clamps audio bufferMs to a sane upper bound', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'audio-0', host: '239.255.0.1', port: 40002 }],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
                bufferMs: 999_999,
            });
            const audioRule = result!.linkOnPadAdded.find((r) => r.media === 'audio')!;
            // 5000ms cap → 5_000_000_000 ns (matches the demuxer's slider ceiling)
            expect(audioRule.branches[0]).toContain('max-size-time=5000000000');
        });
        it('emits a frame-bounded leaky queue on the video branch (parser is injected ahead of it by the runner so drops land on whole frames)', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'video-0', host: '239.255.0.1', port: 40001 }],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
            });
            const videoRule = result!.linkOnPadAdded.find((r) => r.media === 'video')!;
            expect(videoRule.branches[0]).toContain('queue leaky=2 max-size-buffers=2');
        });
        it('adds a KLV metadata appsrc pinned to the fixed metadata PID (0x1f0 = 496)', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'video-0', host: '239.255.0.1', port: 40001 }],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
            });
            expect(result!.pipeline).toContain('appsrc name=klvsrc caps=meta/x-klv,parsed=true');
            // Pinned to the metadata PID's mpegtsmux request pad.
            expect(result!.pipeline).toContain('! mux.sink_496');
            // mpegtsmux ! udpsink chain still comes first (the appsrc is appended).
            expect(result!.pipeline).toMatch(/mpegtsmux name=mux[^!]+! udpsink/);
        });

        it('returns PID-keyed named streams carrying name + sourceModuleId for the carousel', () => {
            const result = buildPipeline({
                sources: [
                    { sinkPortId: 'video-0', host: 'h', port: 1, name: 'Cam 1', sourceModuleId: 'enc-v' },
                    { sinkPortId: 'audio-0', host: 'h', port: 2, sourceModuleId: 'enc-a' },
                ],
                output: { host: '239.255.0.1', port: 40010 },
                alignment: 7,
            });
            expect(result!.namedStreams).toEqual([
                { pid: 0x100, media: 'video', sinkPortId: 'video-0', name: 'Cam 1', sourceModuleId: 'enc-v' },
                { pid: 0x140, media: 'audio', sinkPortId: 'audio-0', name: undefined, sourceModuleId: 'enc-a' },
            ]);
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

        it('threads operator names + sourceModuleId fallback into the carousel payload', () => {
            const { module } = makeModule({
                sources: [
                    { sinkPortId: 'video-0', port: 40001 },
                    { sinkPortId: 'audio-0', port: 40002 },
                ],
            });
            (module as any).config = {
                videoStreamCount: 1,
                audioStreamCount: 1,
                streamNames: { 'video-0': 'Main Cam' },
            };
            (module as any).setHealth = vi.fn();
            (module as any).setStatusData = vi.fn();
            module.buildPipeline((module as any).config);

            // Capture the payload the module would push on PLAYING.
            const sent: string[] = [];
            (module as any).setKlvPayload = (_el: string, payload: string) => sent.push(payload);
            (module as any).pushKlvCarousel();

            expect(sent).toHaveLength(1);
            const parsed = JSON.parse(sent[0]);
            expect(parsed.v).toBe(1);
            // video-0 named explicitly; audio-0 falls back to its sourceModuleId.
            expect(parsed.streams).toEqual([
                { pid: 0x100, media: 'video', name: 'Main Cam' },
                { pid: 0x140, media: 'audio', name: 'enc-audio-0' },
            ]);
        });

        it('live rename resolves by sink port id, not PID ordinal (non-contiguous wiring)', async () => {
            // videoStreams[0]=A, [1]=B, but ONLY video-1 is connected: the
            // stream gets the first video PID (0x100) yet its name must come
            // from index 1. Reverse-deriving the port from the PID broadcast
            // "A" for stream "B" — the exact mislabeling this feature exists
            // to prevent.
            const { module } = makeModule({
                sources: [{ sinkPortId: 'video-1', port: 40001 }],
            });
            (module as any).config = {
                videoStreams: [{ name: 'A' }, { name: 'B' }],
                audioStreams: [],
            };
            (module as any).setHealth = vi.fn();
            (module as any).setStatusData = vi.fn();
            module.buildPipeline((module as any).config);

            const sent: string[] = [];
            (module as any).setKlvPayload = (_el: string, payload: string) => sent.push(payload);
            (module as any).pushKlvCarousel();
            expect(JSON.parse(sent[0]).streams).toEqual([
                { pid: 0x100, media: 'video', name: 'B' },
            ]);

            // And a live rename of index 1 follows the same port, not the PID.
            await module.onLiveConfigUpdate({
                videoStreams: [{ name: 'A' }, { name: 'B2' }],
            });
            expect(JSON.parse(sent[1]).streams[0].name).toBe('B2');
        });

        it('a live stream rename re-pushes the carousel without rebuilding', async () => {
            const { module } = makeModule({
                sources: [{ sinkPortId: 'video-0', port: 40001 }],
            });
            (module as any).config = { videoStreams: [{ name: '' }], audioStreams: [] };
            (module as any).setHealth = vi.fn();
            (module as any).setStatusData = vi.fn();
            module.buildPipeline((module as any).config);

            const sent: string[] = [];
            (module as any).setKlvPayload = (_el: string, payload: string) => sent.push(payload);
            await module.onLiveConfigUpdate({ videoStreams: [{ name: 'Renamed' }] });

            expect(sent).toHaveLength(1);
            expect(JSON.parse(sent[0]).streams[0].name).toBe('Renamed');
        });

        it('still pushes a carousel with zero named inputs (names fall back to sourceModuleId)', () => {
            const { module } = makeModule({ sources: [{ sinkPortId: 'audio-0', port: 40002 }] });
            (module as any).config = { videoStreamCount: 0, audioStreamCount: 1 };
            (module as any).setHealth = vi.fn();
            (module as any).setStatusData = vi.fn();
            module.buildPipeline((module as any).config);

            const sent: string[] = [];
            (module as any).setKlvPayload = (_el: string, payload: string) => sent.push(payload);
            (module as any).pushKlvCarousel();
            expect(sent).toHaveLength(1);
            expect(JSON.parse(sent[0]).streams[0].name).toBe('enc-audio-0');
        });

        it('declares the stream arrays as live-updatable', () => {
            const { module } = makeModule();
            expect(module.getLiveUpdatableParams()).toEqual(['videoStreams', 'audioStreams']);
        });

        it('isLiveChange: rename is live, add/remove or legacy shape is not', () => {
            const { module } = makeModule();
            // Same length → rename → live KLV push, no rebuild.
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
