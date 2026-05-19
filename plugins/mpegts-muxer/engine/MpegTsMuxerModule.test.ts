import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    audioPortId,
    buildDynamicPorts,
    buildInputBranch,
    buildPipeline,
    isAudioInputPort,
    isVideoInputPort,
    sortSources,
    videoPortId,
} from './mpegtsMuxerPipeline.js';
import { MpegTsMuxerModule } from './MpegTsMuxerModule.js';

describe('mpegtsMuxerPipeline helpers', () => {
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
            // 2000ms cap → 2_000_000_000 ns
            expect(audioRule.branches[0]).toContain('max-size-time=2000000000');
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
        it('uses videoStreamCount and audioStreamCount from config', () => {
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
