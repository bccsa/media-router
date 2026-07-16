import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    audioPortId,
    buildDynamicPorts,
    buildOutputBranch,
    buildPipeline,
    discoveredPortLabel,
    discoveredStreams,
    inputPortId,
    legacyPortIdToPid,
    pidFromPortId,
    pidPortId,
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
            const s = buildOutputBranch({ portId: 'video-0', host: '239.255.0.1', port: 41005 }, 'v0', 'video');
            expect(s).toContain('queue leaky=0 max-size-time=400000000');
            expect(s).toContain('mpegtsmux name=mux_v0');
            expect(s).toContain('udpsink name=usink_v0 host=239.255.0.1 port=41005');
            // alignment=-1 (auto): let mpegtsmux emit its natural buffer
            // grouping instead of pinning a fixed packets-per-datagram count.
            expect(s).toContain('alignment=-1');
            // No codec parser in the JS string — the Python pad-link runner
            // prepends it at pad-added time based on the pad's actual caps.
            expect(s).not.toContain('h264parse');
            expect(s).not.toContain('h265parse');
            expect(s).not.toContain('av1parse');
        });
        it('produces a parser-free non-leaky queue → clocksync → mpegtsmux → udpsink branch for audio (parser is injected by the runner per pad caps)', () => {
            const s = buildOutputBranch({ portId: 'audio-0', host: '239.255.0.1', port: 41006 }, 'a0', 'audio');
            // Non-leaky thread-boundary queue sized to hold a whole paced PES
            // (ts-offset + PES ≈ 310 ms) — a leaky 50 ms queue would shear the
            // tail off every burst once clocksync back-pressures it.
            expect(s).toContain('queue leaky=0 max-size-time=400000000');
            // PTS pacing BEFORE the muxer: tsdemux releases a whole PES (~7 AAC
            // frames = 149 ms) at once; clocksync restores per-frame cadence.
            // Measured: without it the branch emits 150 ms line-rate bursts.
            expect(s).toContain('clocksync sync=true ts-offset=160000000');
            expect(s).toMatch(/clocksync[^!]+! mpegtsmux/);
            expect(s).toContain('mpegtsmux name=mux_a0');
            // alignment=-1 (auto): same natural grouping as the video branch —
            // b3978d6 unified both branches off the fixed 7/1 split.
            expect(s).toContain('alignment=-1');
            expect(s).not.toContain('aacparse');
            expect(s).not.toContain('ac3parse');
            expect(s).not.toContain('mpegaudioparse');
        });
        it('connects mpegtsmux straight to udpsink with no leaky queue between — a leaky queue here would drop mid-stream UDP buffers and corrupt decode', () => {
            const s = buildOutputBranch({ portId: 'video-0', host: '239.255.0.1', port: 41005 }, 'v0', 'video');
            expect(s).toMatch(/mpegtsmux name=mux_v0[^!]+! udpsink/);
        });
        it('marks branch udpsinks async=false — they are added to an already-PLAYING pipeline at pad-added time; a prerolling (async) sink stalls the shared tsdemux and freezes every branch', () => {
            expect(buildOutputBranch({ portId: 'video-0', host: '239.255.0.1', port: 41005 }, 'v0', 'video')).toContain('async=false');
            expect(buildOutputBranch({ portId: 'audio-0', host: '239.255.0.1', port: 41006 }, 'a0', 'audio')).toContain('async=false');
        });

        describe('output smoothing (opt-in outputBufferMs — Phase 5)', () => {
            // Default OFF must be byte-identical to the live path: capture the
            // exact current strings, then assert outputBufferMs=0 (and the
            // arg-omitted default) reproduce them character-for-character.
            it('emits BYTE-IDENTICAL strings when outputBufferMs is 0 or omitted (live path unchanged)', () => {
                const out = { portId: 'video-0', host: '239.255.0.1', port: 41005 };
                const videoBaseline = buildOutputBranch(out, 'v0', 'video');
                const audioBaseline = buildOutputBranch(
                    { portId: 'audio-0', host: '239.255.0.1', port: 41006 }, 'a0', 'audio');
                // Omitted arg.
                expect(buildOutputBranch(out, 'v0', 'video')).toBe(videoBaseline);
                // Explicit 0.
                expect(buildOutputBranch(out, 'v0', 'video', { outputBufferMs: 0 })).toBe(videoBaseline);
                expect(
                    buildOutputBranch({ portId: 'audio-0', host: '239.255.0.1', port: 41006 }, 'a0', 'audio', { outputBufferMs: 0 }),
                ).toBe(audioBaseline);
                // And no smoothing queue was prepended: the default path has
                // exactly ONE queue per branch (the re-mux queue itself — now
                // non-leaky on both media), not a leading smoothing queue.
                expect((videoBaseline.match(/queue leaky=/g) || []).length).toBe(1);
                expect((audioBaseline.match(/queue leaky=/g) || []).length).toBe(1);
            });

            it('prepends a deep NON-leaky smoothing queue with the right window on the video branch', () => {
                const s = buildOutputBranch(
                    { portId: 'video-0', host: '239.255.0.1', port: 41005 }, 'v0', 'video', { outputBufferMs: 2000 });
                // Smoothing queue is first, non-leaky, sized to the window.
                expect(s).toMatch(/^queue leaky=0 max-size-time=2000000000 max-size-buffers=0 max-size-bytes=0 !/);
                // The original branch is preserved after it.
                expect(s).toContain('queue leaky=0 max-size-time=400000000');
                expect(s).toContain('alignment=-1');
            });

            it('prepends the smoothing queue on the audio branch too, keeping alignment=-1', () => {
                const s = buildOutputBranch(
                    { portId: 'audio-0', host: '239.255.0.1', port: 41006 }, 'a0', 'audio', { outputBufferMs: 800 });
                expect(s).toMatch(/^queue leaky=0 max-size-time=800000000 max-size-buffers=0 max-size-bytes=0 !/);
                expect(s).toContain('queue leaky=0 max-size-time=400000000');
                expect(s).toContain('clocksync sync=true');
                expect(s).toContain('alignment=-1');
            });

            it('clamps the smoothing window to the 5000 ms ceiling', () => {
                const s = buildOutputBranch(
                    { portId: 'video-0', host: '239.255.0.1', port: 41005 }, 'v0', 'video', { outputBufferMs: 999999 });
                expect(s).toContain('queue leaky=0 max-size-time=5000000000');
            });
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
            expect(result!.pipeline).not.toContain('caps="video/mpegts');
            expect(result!.pipeline).toContain('tsdemux latency=0 ignore-pcr=true name=demux');
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
        it('paces audio by default — non-leaky queue + clocksync', () => {
            const result = buildPipeline({
                input: { host: '239.255.0.1', port: 40001 },
                videoOutputs: [],
                audioOutputs: [{ portId: 'audio-0', host: '239.255.0.1', port: 41002 }],
            });
            const audioRule = result!.linkOnPadAdded.find((r) => r.media === 'audio')!;
            expect(audioRule.branches[0]).toContain('queue leaky=0 max-size-time=400000000');
            expect(audioRule.branches[0]).toContain('clocksync sync=true ts-offset=160000000');
            expect(audioRule.branches[0]).not.toContain('leaky=2');
        });
        it('queueLeaky + audioPacing=false reproduces the pre-pacing leaky branch byte-for-byte (the low-latency A/B lever)', () => {
            const result = buildPipeline({
                input: { host: '239.255.0.1', port: 40001 },
                videoOutputs: [],
                audioOutputs: [{ portId: 'audio-0', host: '239.255.0.1', port: 41002 }],
                audioPacing: false,
                queueLeaky: true,
                queueDepthMs: 50,
            });
            const audioRule = result!.linkOnPadAdded.find((r) => r.media === 'audio')!;
            expect(audioRule.branches[0]).toBe(
                'queue leaky=2 max-size-time=50000000 max-size-buffers=0 max-size-bytes=0 ! ' +
                'mpegtsmux name=mux_a0 latency=1200000000 min-upstream-latency=1200000000 alignment=-1 ! ' +
                'udpsink name=usink_a0 host=239.255.0.1 port=41002 multicast-iface=lo auto-multicast=true ' +
                'buffer-size=4194304 sync=false async=false',
            );
            expect(audioRule.branches[0]).not.toContain('clocksync');
        });
        it('queueLeaky applies to the video branch, but the paced audio branch stays forced non-leaky', () => {
            const result = buildPipeline({
                input: { host: '239.255.0.1', port: 40001 },
                videoOutputs: [{ portId: 'video-0', host: '239.255.0.1', port: 41001 }],
                audioOutputs: [{ portId: 'audio-0', host: '239.255.0.1', port: 41002 }],
                queueLeaky: true,
                queueDepthMs: 100,
            });
            const videoRule = result!.linkOnPadAdded.find((r) => r.media === 'video')!;
            const audioRule = result!.linkOnPadAdded.find((r) => r.media === 'audio')!;
            expect(videoRule.branches[0]).toContain('queue leaky=2 max-size-time=100000000');
            // Paced audio ignores queueLeaky (clocksync back-pressures its
            // queue by design — leaky would shear every paced burst) and
            // keeps the pacing-derived bound.
            expect(audioRule.branches[0]).toContain('queue leaky=0 max-size-time=400000000');
            expect(audioRule.branches[0]).toContain('clocksync sync=true');
        });
        it('threads audioPacingMs into the clocksync offset and scales the branch queue bound', () => {
            const result = buildPipeline({
                input: { host: '239.255.0.1', port: 40001 },
                videoOutputs: [],
                audioOutputs: [{ portId: 'audio-0', host: '239.255.0.1', port: 41002 }],
                audioPacingMs: 500,
            });
            const audioRule = result!.linkOnPadAdded.find((r) => r.media === 'audio')!;
            expect(audioRule.branches[0]).toContain('clocksync sync=true ts-offset=500000000');
            // Queue bound scales with the offset: max(400, 500 + 240) = 740 ms.
            expect(audioRule.branches[0]).toContain('queue leaky=0 max-size-time=740000000');
        });
        it('clamps audioPacingMs to the sane range and keeps the 400 ms queue floor', () => {
            const result = buildPipeline({
                input: { host: '239.255.0.1', port: 40001 },
                videoOutputs: [],
                audioOutputs: [{ portId: 'audio-0', host: '239.255.0.1', port: 41002 }],
                audioPacingMs: 99_999,
            });
            const audioRule = result!.linkOnPadAdded.find((r) => r.media === 'audio')!;
            expect(audioRule.branches[0]).toContain('ts-offset=2000000000'); // 2000 ms cap
            const low = buildPipeline({
                input: { host: '239.255.0.1', port: 40001 },
                videoOutputs: [],
                audioOutputs: [{ portId: 'audio-0', host: '239.255.0.1', port: 41002 }],
                audioPacingMs: 0,
            });
            const lowRule = low!.linkOnPadAdded.find((r) => r.media === 'audio')!;
            expect(lowRule.branches[0]).toContain('ts-offset=0');
            expect(lowRule.branches[0]).toContain('queue leaky=0 max-size-time=400000000'); // floor
        });
        it('threads outputBufferMs into both video and audio branches (Phase 5)', () => {
            const result = buildPipeline({
                input: { host: '239.255.0.1', port: 40001 },
                videoOutputs: [{ portId: 'video-0', host: '239.255.0.1', port: 41001 }],
                audioOutputs: [{ portId: 'audio-0', host: '239.255.0.1', port: 41002 }],
                outputBufferMs: 1500,
            });
            const videoRule = result!.linkOnPadAdded.find((r) => r.media === 'video')!;
            const audioRule = result!.linkOnPadAdded.find((r) => r.media === 'audio')!;
            expect(videoRule.branches[0]).toContain('queue leaky=0 max-size-time=1500000000');
            expect(audioRule.branches[0]).toContain('queue leaky=0 max-size-time=1500000000');
        });
        it('emits no smoothing queue when outputBufferMs is omitted (default OFF)', () => {
            const result = buildPipeline({
                input: { host: '239.255.0.1', port: 40001 },
                videoOutputs: [{ portId: 'video-0', host: '239.255.0.1', port: 41001 }],
                audioOutputs: [{ portId: 'audio-0', host: '239.255.0.1', port: 41002 }],
            });
            for (const rule of result!.linkOnPadAdded) {
                for (const branch of rule.branches) {
                    // No smoothing queue prepended → exactly one queue per branch.
                    expect((branch.match(/queue leaky=/g) || []).length).toBe(1);
                }
            }
        });
        it('emits tsdemux latency=0 on the input', () => {
            const result = buildPipeline({
                input: { host: '239.255.0.1', port: 40001 },
                videoOutputs: [{ portId: 'video-0', host: '239.255.0.1', port: 41001 }],
                audioOutputs: [],
            });
            expect(result!.pipeline).toContain('tsdemux latency=0 ignore-pcr=true name=demux');
        });
        it('sets no udpsrc timeout — a single-input loopback demuxer must wait for a silent source, not restart-storm', () => {
            const result = buildPipeline({
                input: { host: '239.255.0.1', port: 40001 },
                videoOutputs: [{ portId: 'video-0', host: '239.255.0.1', port: 41001 }],
                audioOutputs: [],
            });
            // A timeout→restart can't recover a loopback source (the producer is
            // local; the group never goes away) and at boot restart-stormed the
            // whole demuxer→decoder chain, pinning every port to "stale". The
            // already-joined udpsrc receives the instant the producer starts.
            expect(result!.pipeline).not.toContain('timeout=');
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

    describe('PID-based port ids (Phase 3)', () => {
        it('formats a PID as a stable hex port id and round-trips it back', () => {
            expect(pidPortId(0x141)).toBe('pid-0x141');
            expect(pidPortId(0x100)).toBe('pid-0x100');
            expect(pidFromPortId('pid-0x141')).toBe(0x141);
            expect(pidFromPortId('pid-0x100')).toBe(0x100);
        });
        it('returns null for a non-PID port id', () => {
            expect(pidFromPortId('video-0')).toBeNull();
            expect(pidFromPortId('mpegts-in')).toBeNull();
        });
    });

    describe('discoveredStreams config parsing', () => {
        it('keeps only video/audio entries with a numeric PID, sorted video-then-audio by PID', () => {
            const cfg = {
                discoveredStreams: [
                    { pid: 0x141, media: 'audio', codec: 'aac' },
                    { pid: 0x1f0, media: 'metadata' }, // dropped — not routable
                    { pid: 0x100, media: 'video', codec: 'h264', name: 'Cam 1' },
                    { media: 'audio' }, // dropped — no PID
                    { pid: 0x101, media: 'video' },
                ],
            };
            const out = discoveredStreams(cfg);
            expect(out.map((s) => s.pid)).toEqual([0x100, 0x101, 0x141]);
            expect(out[0]).toMatchObject({ media: 'video', codec: 'h264', name: 'Cam 1' });
        });
        it('returns [] when discoveredStreams is absent or not an array', () => {
            expect(discoveredStreams({})).toEqual([]);
            expect(discoveredStreams({ discoveredStreams: 'nope' })).toEqual([]);
        });
    });

    describe('discoveredPortLabel — offline label fallback', () => {
        it('prefers the persisted name', () => {
            expect(discoveredPortLabel({ pid: 0x100, media: 'video', name: 'Cam 1' })).toBe('Cam 1');
        });
        it('falls back to generated codec+PID, matching the live generated form', () => {
            expect(discoveredPortLabel({ pid: 0x141, media: 'audio', codec: 'aac' })).toBe(
                'Audio (aac, PID 0x141)',
            );
            expect(discoveredPortLabel({ pid: 0x100, media: 'video' })).toBe('Video (PID 0x100)');
        });
    });

    describe('buildDynamicPorts with discovered streams', () => {
        it('emits PID-based ports for discovered streams alongside the legacy positional ports', () => {
            const ports = buildDynamicPorts(1, 1, [
                { pid: 0x100, media: 'video', name: 'Cam 1' },
                { pid: 0x141, media: 'audio', codec: 'aac' },
            ]);
            const ids = ports.map((p) => p.id);
            expect(ids).toContain('pid-0x100');
            expect(ids).toContain('pid-0x141');
            // Legacy positional ports kept so existing connections never dangle.
            expect(ids).toContain('video-0');
            expect(ids).toContain('audio-0');
            expect(ports.find((p) => p.id === 'pid-0x100')?.label).toBe('Cam 1');
        });
    });

    describe('legacyPortIdToPid — migration mapping', () => {
        const discovered = [
            { pid: 0x100, media: 'video' as const },
            { pid: 0x141, media: 'audio' as const },
            { pid: 0x142, media: 'audio' as const },
        ];
        it('maps the Nth positional id to the Nth discovered PID of that media', () => {
            expect(legacyPortIdToPid('video-0', discovered)).toBe('pid-0x100');
            expect(legacyPortIdToPid('audio-0', discovered)).toBe('pid-0x141');
            expect(legacyPortIdToPid('audio-1', discovered)).toBe('pid-0x142');
        });
        it('returns null for an out-of-range ordinal or a non-positional id', () => {
            expect(legacyPortIdToPid('video-1', discovered)).toBeNull();
            expect(legacyPortIdToPid('pid-0x100', discovered)).toBeNull();
            expect(legacyPortIdToPid('mpegts-in', discovered)).toBeNull();
        });
    });

    describe('buildPipeline PID routing (Phase 3)', () => {
        it('routes discovered streams by PID (matchPids), fanning a legacy port onto its mapped PID', () => {
            const result = buildPipeline({
                input: { host: '239.255.0.1', port: 40001 },
                // One PID-based video output + the legacy video-0 mapped to the same PID.
                videoOutputs: [
                    { portId: 'pid-0x100', host: '239.255.0.1', port: 41001, pid: 0x100 },
                    { portId: 'video-0', host: '239.255.0.1', port: 41010, pid: 0x100 },
                ],
                audioOutputs: [
                    { portId: 'pid-0x141', host: '239.255.0.1', port: 41002, pid: 0x141 },
                ],
            });
            const videoRule = result!.linkOnPadAdded.find((r) => r.media === 'video')!;
            // Same PID twice → tee fan-out in the runner.
            expect(videoRule.matchPids).toEqual([0x100, 0x100]);
            expect(videoRule.branches).toHaveLength(2);
            const audioRule = result!.linkOnPadAdded.find((r) => r.media === 'audio')!;
            expect(audioRule.matchPids).toEqual([0x141]);
        });
        it('keeps positional routing (no matchPids) when no output carries a PID (pre-discovery)', () => {
            const result = buildPipeline({
                input: { host: '239.255.0.1', port: 40001 },
                videoOutputs: [{ portId: 'video-0', host: '239.255.0.1', port: 41001 }],
                audioOutputs: [{ portId: 'audio-0', host: '239.255.0.1', port: 41002 }],
            });
            const videoRule = result!.linkOnPadAdded.find((r) => r.media === 'video')!;
            expect(videoRule.matchPids).toBeUndefined();
        });
        it('drops an unmapped legacy port (no discovered stream) rather than misrouting it', () => {
            const result = buildPipeline({
                input: { host: '239.255.0.1', port: 40001 },
                videoOutputs: [
                    { portId: 'pid-0x100', host: '239.255.0.1', port: 41001, pid: 0x100 },
                    { portId: 'video-1', host: '239.255.0.1', port: 41011 }, // unmapped, no pid
                ],
                audioOutputs: [],
            });
            const videoRule = result!.linkOnPadAdded.find((r) => r.media === 'video')!;
            // Only the pinned output gets a branch + matchPids entry.
            expect(videoRule.matchPids).toEqual([0x100]);
            expect(videoRule.branches).toHaveLength(1);
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
        const assignUdpPort = vi.fn((modId: string, portId?: string) => {
            const key = portId ? `${modId}:${portId}` : modId;
            if (!(key in allocated)) {
                allocated[key] = nextPort++;
            }
            return { host: '239.255.0.1', port: allocated[key] };
        });
        const getPortConnectionCount = vi.fn((_moduleId: string, _portId: string) => 0);
        (module as any).services = {
            instanceId: 'demux-1',
            mediaRouter: { getModuleUdpSource, assignUdpPort, getPortConnectionCount },
        };
        return { module, getModuleUdpSource, assignUdpPort, getPortConnectionCount, allocated };
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
        it('adds PID-based ports for persisted discovered streams (Phase 3)', () => {
            const { module } = makeModule();
            (module as any).config = {
                videoStreamCount: 1,
                audioStreamCount: 1,
                discoveredStreams: [
                    { pid: 0x100, media: 'video', name: 'Cam 1' },
                    { pid: 0x141, media: 'audio', codec: 'aac' },
                ],
            };
            const ports = module.getDynamicPorts();
            const ids = ports.map((p) => p.id);
            expect(ids).toContain('pid-0x100');
            expect(ids).toContain('pid-0x141');
            // Legacy ports are ALWAYS registered (dropping them from the
            // registry based on the engine's transient connection view
            // orphaned live edges) — post-discovery they carry the
            // hideWhenUnconnected display hint and the UI hides idle ones.
            expect(ids).toContain('video-0');
            expect(ids).toContain('audio-0');
            const legacy = ports.find((p) => p.id === 'video-0')!;
            expect(legacy.hideWhenUnconnected).toBe(true);
            const pidPort = ports.find((p) => p.id === 'pid-0x100')!;
            expect(pidPort.hideWhenUnconnected).toBeUndefined();
        });
        it('legacy ports carry no display hint before discovery (pre-wiring a fresh demuxer)', () => {
            const { module } = makeModule();
            (module as any).config = { videoStreamCount: 1, audioStreamCount: 1 };
            const ports = module.getDynamicPorts();
            const legacy = ports.find((p) => p.id === 'video-0')!;
            expect(legacy.hideWhenUnconnected).toBeUndefined();
        });
    });

    describe('persistDiscovered (Phase 3 — discovery writes config, diffed)', () => {
        function running() {
            const { module } = makeModule();
            (module as any).config = { videoStreamCount: 1, audioStreamCount: 1 };
            (module as any).setStatusData = vi.fn();
            return module as any;
        }

        it('emits discoveredStreams from the inspector and skips when unchanged', () => {
            const module = running();
            const emit = vi.fn();
            module.emitConfigUpdate = emit;
            module.inspector.record({ pid: 0x100, media: 'video', caps: 'video/x-h264' });
            module.inspector.record({ pid: 0x141, media: 'audio', caps: 'audio/mpeg, mpegversion=(int)4' });
            module.persistDiscovered();
            expect(emit).toHaveBeenCalledTimes(1);
            const written = emit.mock.calls[0][0].discoveredStreams;
            expect(written.map((s: any) => s.pid)).toEqual([0x100, 0x141]);
            // Mirror the write into config (the real emitConfigUpdate does this).
            module.config.discoveredStreams = written;
            // Same inspector state → diff returns null → no second emit.
            module.persistDiscovered();
            expect(emit).toHaveBeenCalledTimes(1);
        });

        it('never auto-removes a persisted stream that is no longer present (D5)', () => {
            const module = running();
            module.config.discoveredStreams = [
                { pid: 0x100, media: 'video', codec: 'h264' },
                { pid: 0x141, media: 'audio', codec: 'aac' },
            ];
            const emit = vi.fn();
            module.emitConfigUpdate = emit;
            // Only one stream live this run — the other should survive in config.
            module.inspector.record({ pid: 0x100, media: 'video', caps: 'video/x-h264' });
            module.persistDiscovered();
            // Set unchanged (0x141 retained) → no emit.
            expect(emit).not.toHaveBeenCalled();
        });

        it('does not route discovered streams as metadata (D6)', () => {
            const module = running();
            const emit = vi.fn();
            module.emitConfigUpdate = emit;
            module.inspector.record({ pid: 0x1f0, media: 'metadata', caps: 'meta/x-klv' });
            module.persistDiscovered();
            // Metadata-only discovery yields an empty routable set === prior ([]) → no emit.
            expect(emit).not.toHaveBeenCalled();
        });

        it('shows a red stale badge for persisted-but-absent streams, clears it on recovery', () => {
            const module = running();
            module.config.discoveredStreams = [
                { pid: 0x100, media: 'video', codec: 'h264' },
                { pid: 0x141, media: 'audio', codec: 'aac' },
            ];
            const setBadge = vi.fn();
            const clearBadge = vi.fn();
            module.setBadge = setBadge;
            module.clearBadge = clearBadge;
            // Only the video PID seen live this run → one stale stream.
            module.inspector.record({ pid: 0x100, media: 'video', caps: 'video/x-h264' });
            module.publishStreamStatus();
            expect(setBadge).toHaveBeenCalledWith('stale', {
                icon: 'alert-triangle',
                text: '1 stale stream',
                color: '#ef4444',
            });
            // The audio PID comes back → badge cleared.
            module.inspector.record({ pid: 0x141, media: 'audio', caps: 'audio/mpeg, mpegversion=(int)4' });
            module.publishStreamStatus();
            expect(clearBadge).toHaveBeenCalledWith('stale');
        });

        it('cleanupStaleStreams persists the tracker verdict and feeds it connection state', () => {
            // Hysteresis semantics themselves are covered in
            // staleStreamTracker.test.ts — this checks the module wiring:
            // sweep verdict → emitConfigUpdate, connection lookup by PID port.
            const { module: m, getPortConnectionCount } = makeModule();
            const module = m as any;
            module.config = {
                discoveredStreams: [
                    { pid: 0x100, media: 'video', codec: 'h264' },
                    { pid: 0x142, media: 'audio', codec: 'aac' },
                ],
            };
            module.setStatusData = vi.fn();
            module.setBadge = vi.fn();
            module.clearBadge = vi.fn();
            const emit = vi.fn();
            module.emitConfigUpdate = emit;
            getPortConnectionCount.mockReturnValue(0);
            const sweep = vi.fn(
                (
                    persisted: any[],
                    _live: Set<number>,
                    isConnected: (pid: number) => boolean,
                ): any[] | null => {
                    // The module must hand the tracker a PID-port connection probe.
                    isConnected(0x142);
                    return persisted.filter((s) => s.pid !== 0x142);
                },
            );
            module.staleTracker = { sweep, reset: vi.fn() };
            module.cleanupStaleStreams();
            expect(getPortConnectionCount).toHaveBeenCalledWith('demux-1', 'pid-0x142');
            expect(emit).toHaveBeenCalledTimes(1);
            expect(emit.mock.calls[0][0].discoveredStreams.map((s: any) => s.pid)).toEqual([0x100]);
            // Null verdict → no config write.
            sweep.mockReturnValue(null);
            module.cleanupStaleStreams();
            expect(emit).toHaveBeenCalledTimes(1);
        });

        it('cleanup is a no-op when every persisted stream is live or connected', () => {
            const { module: m, getPortConnectionCount } = makeModule();
            const module = m as any;
            module.config = {
                discoveredStreams: [{ pid: 0x100, media: 'video', codec: 'h264' }],
            };
            const emit = vi.fn();
            module.emitConfigUpdate = emit;
            module.inspector.record({ pid: 0x100, media: 'video', caps: 'video/x-h264' });
            getPortConnectionCount.mockReturnValue(0);
            module.cleanupStaleStreams();
            expect(emit).not.toHaveBeenCalled();
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
            const { module, assignUdpPort } = makeModule();
            (module as any).config = { videoStreamCount: 1, audioStreamCount: 2 };
            (module as any).setHealth = vi.fn();
            (module as any).setStatusData = vi.fn();
            const desc = module.buildPipeline((module as any).config);
            expect(desc).not.toBeNull();
            expect(assignUdpPort).toHaveBeenCalledWith('demux-1', 'video-0');
            expect(assignUdpPort).toHaveBeenCalledWith('demux-1', 'audio-0');
            expect(assignUdpPort).toHaveBeenCalledWith('demux-1', 'audio-1');
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

        it('requests the in-band name reader (readKlvNames) but never routes the metadata PID', () => {
            const { module } = makeModule();
            (module as any).config = { videoStreamCount: 1, audioStreamCount: 1 };
            (module as any).setHealth = vi.fn();
            (module as any).setStatusData = vi.fn();
            const desc = module.buildPipeline((module as any).config)!;
            expect(desc.readKlvNames).toBe(true);
            // No rule (= no routing branch / UDP output) for the metadata PID (D6).
            const medias = desc.linkOnPadAdded!.map((r) => r.media);
            expect(medias).not.toContain('metadata');
            expect(new Set(medias)).toEqual(new Set(['video', 'audio']));
        });
    });

    describe('in-band stream names (Phase 2)', () => {
        function primed() {
            const { module } = makeModule();
            (module as any).setStatusData = vi.fn();
            (module as any).log = { warn: vi.fn() };
            // Two discovered streams so labels have something to attach to.
            const insp = (module as any).inspector;
            insp.record({ pid: 0x100, media: 'video', caps: 'video/x-h264' });
            insp.record({ pid: 0x141, media: 'audio', caps: 'audio/mpeg, mpegversion=(int)4' });
            return module;
        }

        it('merges KLV names onto the inspector streams and resolves labels', () => {
            const module = primed();
            (module as any).handleStreamNames({
                payload: '{"v":1,"streams":[{"pid":256,"name":"Cam 1"},{"pid":321,"name":"FOH"}]}',
                malformed: false,
            });
            expect((module as any).klvNames.get(0x100)).toBe('Cam 1');
            const sections = (module as any).dynamicStatusSections as Array<{ label: string }>;
            expect(sections.map((s) => s.label)).toEqual(['Cam 1', 'FOH']);
        });

        it('keeps last-known labels when metadata disappears (absence is a non-event)', () => {
            const module = primed();
            (module as any).handleStreamNames({
                payload: '{"v":1,"streams":[{"pid":256,"name":"Cam 1"}]}',
            });
            (module as any).handleStreamNames({ payload: undefined });
            expect((module as any).klvNames.get(0x100)).toBe('Cam 1');
        });

        it('warns once on malformed payloads and never throws', () => {
            const module = primed();
            const warn = (module as any).log.warn as ReturnType<typeof vi.fn>;
            expect(() => {
                (module as any).handleStreamNames({ payload: '{bad json' });
                (module as any).handleStreamNames({ payload: 'still bad' });
            }).not.toThrow();
            expect(warn).toHaveBeenCalledTimes(1);
        });
    });
});
