import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    audioPortId,
    buildDynamicPorts,
    buildOutputBranch,
    buildPipeline,
    inputPortId,
    videoPortId,
} from './mpegtsDemuxerPipeline.js';
import { MpegTsDemuxerModule } from './MpegTsDemuxerModule.js';

describe('mpegtsDemuxerPipeline helpers', () => {
    describe('buildDynamicPorts', () => {
        it('emits one input + N video outputs + M audio outputs', () => {
            const ports = buildDynamicPorts(2, 3);
            expect(ports).toHaveLength(1 + 2 + 3);
            expect(ports[0]).toMatchObject({ id: 'mpegts-in', direction: 'input' });
            expect(ports.filter((p) => p.direction === 'output')).toHaveLength(5);
        });
        it('still exposes the input port when no outputs are configured', () => {
            const ports = buildDynamicPorts(0, 0);
            expect(ports).toHaveLength(1);
            expect(ports[0]).toMatchObject({ id: 'mpegts-in', direction: 'input' });
        });
    });

    describe('buildOutputBranch', () => {
        it('produces a parser-free frame-bounded queue → mpegtsmux → udpsink branch for video (parser is injected by the runner per pad caps)', () => {
            const s = buildOutputBranch({ portId: 'video-0', host: '239.255.0.1', port: 41005 }, 'v0', 'video', 20);
            expect(s).toContain('queue leaky=2 max-size-buffers=2');
            expect(s).toContain('mpegtsmux name=mux_v0');
            expect(s).toContain('udpsink name=usink_v0 host=239.255.0.1 port=41005');
            // alignment=7: pack 7 TS packets into one UDP datagram (1316 B —
            // MTU-sized). For video this is right: a single frame fills many
            // packets, so the batching adds negligible delay.
            expect(s).toContain('alignment=7');
            // No codec parser in the JS string — the Python pad-link runner
            // prepends it at pad-added time based on the pad's actual caps.
            expect(s).not.toContain('h264parse');
            expect(s).not.toContain('h265parse');
            expect(s).not.toContain('av1parse');
        });
        it('produces a parser-free leaky queue → mpegtsmux → udpsink branch for audio (parser is injected by the runner per pad caps)', () => {
            const s = buildOutputBranch({ portId: 'audio-0', host: '239.255.0.1', port: 41006 }, 'a0', 'audio', 20);
            expect(s).toContain('queue leaky=2 max-size-time=20000000');
            expect(s).toContain('mpegtsmux name=mux_a0');
            // alignment=1 — one TS packet per UDP datagram on audio. The
            // batched alignment=7 introduces ~40–160 ms of bursty delivery
            // for AAC, which exceeds the decoder's late-frame tolerance and
            // surfaces as scratchy audio. The video branch keeps alignment=7
            // because video frames fill 7 packets fast.
            expect(s).toContain('alignment=1');
            expect(s).not.toContain('alignment=7');
            expect(s).not.toContain('aacparse');
            expect(s).not.toContain('ac3parse');
            expect(s).not.toContain('mpegaudioparse');
        });
        it('connects mpegtsmux straight to udpsink with no leaky queue between — a leaky queue here would drop mid-stream UDP buffers and corrupt decode', () => {
            const s = buildOutputBranch({ portId: 'video-0', host: '239.255.0.1', port: 41005 }, 'v0', 'video', 50);
            expect(s).toMatch(/mpegtsmux name=mux_v0[^!]+! udpsink/);
        });
    });

    describe('buildPipeline', () => {
        it('produces a single tsdemux pipeline + per-media pad-link rules', () => {
            const result = buildPipeline({
                input: { host: '239.255.0.1', port: 40001 },
                videoOutputs: [{ portId: 'video-0', host: '239.255.0.1', port: 41001 }],
                audioOutputs: [
                    { portId: 'audio-0', host: '239.255.0.1', port: 41002 },
                    { portId: 'audio-1', host: '239.255.0.1', port: 41003 },
                ],
            });
            expect(result).not.toBeNull();
            expect(result!.pipeline).toContain('udpsrc multicast-group=239.255.0.1 port=40001');
            expect(result!.pipeline).toContain('caps="video/mpegts');
            expect(result!.pipeline).toContain('tsdemux latency=0 name=demux');
            expect(result!.linkOnPadAdded).toHaveLength(2); // 1 video rule + 1 audio rule
            const videoRule = result!.linkOnPadAdded.find((r) => r.media === 'video')!;
            const audioRule = result!.linkOnPadAdded.find((r) => r.media === 'audio')!;
            expect(videoRule.from).toBe('demux');
            expect(videoRule.branches).toHaveLength(1);
            expect(audioRule.branches).toHaveLength(2);
            // Each audio branch hits a different port
            expect(audioRule.branches[0]).toContain('port=41002');
            expect(audioRule.branches[1]).toContain('port=41003');
        });
        it('threads bufferMs into the audio output queue (video uses a frame-count queue so bufferMs does not apply)', () => {
            const result = buildPipeline({
                input: { host: '239.255.0.1', port: 40001 },
                videoOutputs: [],
                audioOutputs: [{ portId: 'audio-0', host: '239.255.0.1', port: 41002 }],
                bufferMs: 50,
            });
            const audioRule = result!.linkOnPadAdded.find((r) => r.media === 'audio')!;
            expect(audioRule.branches[0]).toContain('queue leaky=2 max-size-time=50000000');
        });
        it('emits tsdemux latency=0 on the input', () => {
            const result = buildPipeline({
                input: { host: '239.255.0.1', port: 40001 },
                videoOutputs: [{ portId: 'video-0', host: '239.255.0.1', port: 41001 }],
                audioOutputs: [],
            });
            expect(result!.pipeline).toContain('tsdemux latency=0 name=demux');
        });
        it('goes straight from udpsrc to tsdemux with no tsparse — re-anchoring PCR mid-pipeline causes mpegtsmux PCR re-emit to surface as packet loss', () => {
            const result = buildPipeline({
                input: { host: '239.255.0.1', port: 40001 },
                videoOutputs: [{ portId: 'video-0', host: '239.255.0.1', port: 41001 }],
                audioOutputs: [],
            });
            expect(result!.pipeline).not.toContain('tsparse');
        });
        it('omits the rule for a media type when its output count is zero', () => {
            const result = buildPipeline({
                input: { host: '239.255.0.1', port: 40001 },
                videoOutputs: [],
                audioOutputs: [{ portId: 'audio-0', host: '239.255.0.1', port: 41002 }],
            });
            expect(result!.linkOnPadAdded).toHaveLength(1);
            expect(result!.linkOnPadAdded[0].media).toBe('audio');
        });
    });

    describe('port id helpers', () => {
        it('match the dynamic-port id format', () => {
            const ports = buildDynamicPorts(1, 1);
            expect(ports.map((p) => p.id)).toEqual([
                inputPortId(),
                videoPortId(0),
                audioPortId(0),
            ]);
        });
    });
});

describe('MpegTsDemuxerModule', () => {
    function makeModule(opts: { upstream?: { port: number } | null } = {}) {
        const module = new MpegTsDemuxerModule();
        const getModuleUdpSource = vi.fn(() =>
            opts.upstream === null
                ? undefined
                : {
                      host: '239.255.0.1',
                      port: opts.upstream?.port ?? 40001,
                      connectionId: 'c-up',
                      sourceModuleId: 'mux-1',
                      sourcePortId: 'mpegts-out',
                  },
        );
        let nextPort = 41000;
        const allocated: Record<string, number> = {};
        const assignEncoderPort = vi.fn((modId: string, portId?: string) => {
            const key = portId ? `${modId}:${portId}` : modId;
            if (!(key in allocated)) {
                allocated[key] = nextPort++;
            }
            return { host: '239.255.0.1', port: allocated[key] };
        });
        (module as any).services = {
            instanceId: 'demux-1',
            mediaRouter: { getModuleUdpSource, assignEncoderPort },
        };
        return { module, getModuleUdpSource, assignEncoderPort, allocated };
    }

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('getDynamicPorts', () => {
        it('reflects videoStreamCount / audioStreamCount', () => {
            const { module } = makeModule();
            (module as any).config = { videoStreamCount: 1, audioStreamCount: 2 };
            const ports = module.getDynamicPorts();
            expect(ports).toHaveLength(1 + 1 + 2);
        });
    });

    describe('buildPipeline', () => {
        it('returns null + warning when no upstream source is connected', () => {
            const { module } = makeModule({ upstream: null });
            (module as any).config = { videoStreamCount: 1, audioStreamCount: 1 };
            const setHealth = vi.fn();
            (module as any).setHealth = setHealth;
            expect(module.buildPipeline((module as any).config)).toBeNull();
            expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('No upstream'));
        });

        it('allocates one UDP port per output with the matching portId key', () => {
            const { module, assignEncoderPort } = makeModule();
            (module as any).config = { videoStreamCount: 1, audioStreamCount: 2 };
            (module as any).setHealth = vi.fn();
            (module as any).setStatusData = vi.fn();
            const desc = module.buildPipeline((module as any).config);
            expect(desc).not.toBeNull();
            expect(assignEncoderPort).toHaveBeenCalledWith('demux-1', 'video-0');
            expect(assignEncoderPort).toHaveBeenCalledWith('demux-1', 'audio-0');
            expect(assignEncoderPort).toHaveBeenCalledWith('demux-1', 'audio-1');
            const audioRule = desc!.linkOnPadAdded!.find((r) => r.media === 'audio')!;
            expect(audioRule.branches).toHaveLength(2);
        });

        it('returns null + warning when both stream counts are zero', () => {
            const { module } = makeModule();
            (module as any).config = { videoStreamCount: 0, audioStreamCount: 0 };
            const setHealth = vi.fn();
            (module as any).setHealth = setHealth;
            expect(module.buildPipeline((module as any).config)).toBeNull();
            expect(setHealth).toHaveBeenCalledWith('warning', expect.stringContaining('No outputs'));
        });
    });
});
