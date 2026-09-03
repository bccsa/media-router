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
                { name: 'Cam 1', offsetMs: 0, language: '' },
                { name: '', offsetMs: 0, language: '' },
                { name: '', offsetMs: 0, language: '' },
                { name: '', offsetMs: 0, language: '' },
            ]);
        });
        it('sanitizes language to a bare 2-3 letter ISO 639 code (lowercased), else blank', () => {
            const entries = streamEntries(
                {
                    audioStreams: [
                        { name: '', language: 'ENG' },
                        { name: '', language: 'de' },
                        { name: '', language: 'german' },
                        { name: '', language: 'e n' },
                        { name: '', language: 7 },
                        { name: '' },
                    ],
                },
                'audio',
            );
            expect(entries.map((e) => e.language)).toEqual(['eng', 'de', '', '', '', '']);
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
                { name: '', offsetMs: 0, language: '' },
                { name: 'FOH', offsetMs: 0, language: '' },
            ]);
        });
        it('defaults to one unnamed stream on an empty config', () => {
            expect(streamEntries({}, 'video')).toEqual([{ name: '', offsetMs: 0, language: '' }]);
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
        const entries = (n: number) =>
            Array.from({ length: n }, () => ({ name: '', offsetMs: 0, language: '' }));

        it('emits one input port per configured stream + a single output', () => {
            const ports = buildDynamicPorts(entries(2), entries(3));
            expect(ports).toHaveLength(2 + 3 + 1);
            expect(ports.filter((p) => p.direction === 'input')).toHaveLength(5);
            expect(ports.filter((p) => p.direction === 'output')).toHaveLength(1);
        });
        it('still exposes the output port when no inputs are configured', () => {
            const ports = buildDynamicPorts([], []);
            expect(ports).toHaveLength(1);
            expect(ports[0].direction).toBe('output');
        });
        it('caps each input at maxConnections=1 and the output at unlimited', () => {
            const ports = buildDynamicPorts(entries(1), entries(1));
            const input = ports.find((p) => p.id === 'video-0')!;
            const output = ports.find((p) => p.direction === 'output')!;
            expect(input.maxConnections).toBe(1);
            expect(output.maxConnections).toBe(-1);
        });

        it('audio inputs accept either TS family (dual-color dot); video inputs do not', () => {
            const ports = buildDynamicPorts(entries(1), entries(1));
            // An audio slot takes an audio ES in a muxed TS OR a 302M stream.
            expect(ports.find((p) => p.id === 'audio-0')!.acceptsAnyTs).toBe(true);
            expect(ports.find((p) => p.id === 'video-0')!.acceptsAnyTs).toBeUndefined();
        });

        it('carries name/language streamInfo on configured entries, none on blank ones', () => {
            const ports = buildDynamicPorts(
                [{ name: 'Cam 1', offsetMs: 0, language: '' }],
                [
                    { name: '', offsetMs: 0, language: 'nor' },
                    { name: '', offsetMs: 0, language: '' },
                ],
            );
            expect(ports.find((p) => p.id === 'video-0')!.streamInfo).toEqual({
                media: 'video',
                name: 'Cam 1',
            });
            expect(ports.find((p) => p.id === 'audio-0')!.streamInfo).toEqual({
                media: 'audio',
                language: 'nor',
            });
            expect(ports.find((p) => p.id === 'audio-1')!.streamInfo).toBeUndefined();
        });
    });

    describe('buildInputBranch', () => {
        it('reads the per-consumer edge socket via a named unixfdsrc, with NO watchdog element in the branch', () => {
            // The stall watch moved runner-side (inputStallWatch) on 2026-09-02:
            // the `watchdog` element churned a GLib timeout source per bus
            // buffer (~900 wakeups/s on a video input). The branch is now the
            // bare bus ingress; the watch is declared on the description.
            const s = buildInputBranch('0', {
                sinkPortId: 'video-0',
                port: 40000,
                socketPath: '/tmp/mr-bus-40000-abc123.sock',
            });
            expect(s).toBe(
                'unixfdsrc name=busin_0 socket-path=/tmp/mr-bus-40000-abc123.sock' +
                    ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=0' +
                    ' ! tsdemux latency=0 name=demux_0',
            );
            expect(s).not.toContain('watchdog');
            // No inline `! mux.` chain — pad-linking is done at runtime via linkOnPadAdded
            expect(s).not.toContain('! mux.');
        });
        it('falls back to the channel-level socket when no edge socketPath is handed out', () => {
            const s = buildInputBranch('1', { sinkPortId: 'audio-0', port: 40001 });
            expect(s).toContain('unixfdsrc name=busin_1 socket-path=/tmp/mr-bus-40001.sock');
            expect(s).toContain('tsdemux latency=0 name=demux_1');
        });
        it('goes straight from the bus src to tsdemux with no tsparse — re-anchoring PCR mid-pipeline causes mpegtsmux PCR re-emit to surface as packet loss', () => {
            const s = buildInputBranch('0', { sinkPortId: 'video-0', port: 40000 });
            expect(s).not.toContain('tsparse');
        });
    });

    describe('buildPipeline', () => {
        it('returns null when no inputs are wired', () => {
            const result = buildPipeline({
                sources: [],
                output: { port: 40010 },
                alignment: 7,
            });
            expect(result).toBeNull();
        });
        it('connects mpegtsmux straight to the bus egress with no leaky queue between — a leaky queue here would drop mid-stream TS slices and corrupt decode', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'video-0', port: 40001 }],
                output: { port: 40010 },
                alignment: 7,
            });
            const p = result!.pipeline;
            // capssetter is the first element of the bus egress (caps-only, no
            // buffering) — the point of the assertion is that nothing that can
            // DROP sits between the mux and the tee.
            expect(p).toMatch(/mpegtsmux name=mux[^!]+! capssetter caps="video\/mpegts/);
            expect(p).not.toMatch(/mpegtsmux name=mux[^!]+! queue/);
        });
        it('emits one demux branch per input plus a single mpegtsmux ! bus-egress chain and per-media link rules', () => {
            const result = buildPipeline({
                sources: [
                    { sinkPortId: 'video-0', port: 40001 },
                    { sinkPortId: 'audio-0', port: 40002 },
                ],
                output: { port: 40010 },
                alignment: 7,
            });
            expect(result).not.toBeNull();
            expect(result!.pipeline).toContain(
                'mpegtsmux name=mux latency=1200000000 min-upstream-latency=1200000000 alignment=7',
            );
            expect(result!.pipeline).toContain(
                'capssetter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" replace=true ! ' +
                    'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! ' +
                    'tee name=busout_40010 allow-not-linked=true',
            );
            expect(result!.pipeline.match(/tsdemux latency=0 name=demux_/g)).toHaveLength(2);
            expect(result!.pipeline.match(/unixfdsrc name=busin_/g)).toHaveLength(2);
            expect(result!.pipeline).not.toContain('udpsrc');
            expect(result!.pipeline).not.toContain('udpsink');
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
                    { sinkPortId: 'video-0', port: 40001 },
                    { sinkPortId: 'video-1', port: 40002 },
                    { sinkPortId: 'audio-0', port: 40003 },
                    { sinkPortId: 'audio-1', port: 40004 },
                ],
                output: { port: 40010 },
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
                    { sinkPortId: 'audio-0', port: 40001 },
                    { sinkPortId: 'video-0', port: 40002 },
                ],
                output: { port: 40010 },
                alignment: 7,
            });
            const videoRule = result!.linkOnPadAdded.find((r) => r.media === 'video')!;
            const audioRule = result!.linkOnPadAdded.find((r) => r.media === 'audio')!;
            expect(videoRule.requestedPadNames).toEqual(['sink_256']); // 0x100, not 0x101
            expect(audioRule.requestedPadNames).toEqual(['sink_320']); // 0x140
        });
        it('declares a 5 s runner-side stall watch on every input source so a silent-but-connected source restarts', () => {
            const result = buildPipeline({
                sources: [
                    { sinkPortId: 'audio-0', port: 40002 },
                    { sinkPortId: 'video-0', port: 40001 },
                ],
                output: { port: 40010 },
                alignment: 7,
            });
            // One entry per input, addressed by the branch's unixfdsrc name —
            // the runner probes that element's src pad (what the socket
            // delivers, ahead of any queue) once a second.
            expect(result!.inputStallWatch).toEqual([
                { element: 'busin_0', timeoutMs: 5000 },
                { element: 'busin_1', timeoutMs: 5000 },
            ]);
            for (const w of result!.inputStallWatch) {
                expect(result!.pipeline).toContain(`unixfdsrc name=${w.element} `);
            }
            expect(result!.pipeline).not.toContain('watchdog');
        });
        it('does not emit a video rule for an audio-only source (and vice versa)', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'audio-0', port: 40002 }],
                output: { port: 40010 },
                alignment: 7,
            });
            expect(result!.linkOnPadAdded).toHaveLength(1);
            expect(result!.linkOnPadAdded[0].media).toBe('audio');
        });
        it('honours the alignment config', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'video-0', port: 40001 }],
                output: { port: 40010 },
                alignment: 1,
            });
            expect(result!.pipeline).toContain('alignment=1');
        });
        it('defaults to non-leaky input queues (aggregator skew back-pressures, never sheds)', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'audio-0', port: 40002 }],
                output: { port: 40010 },
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
                sources: [{ sinkPortId: 'audio-0', port: 40002 }],
                output: { port: 40010 },
                alignment: 7,
                queueDepthMs: 1200,
            });
            expect(result!.linkOnPadAdded[0].branches[0]).toContain('max-size-time=1200000000');
            const clamped = buildPipeline({
                sources: [{ sinkPortId: 'audio-0', port: 40002 }],
                output: { port: 40010 },
                alignment: 7,
                queueDepthMs: 99_999,
            });
            expect(clamped!.linkOnPadAdded[0].branches[0]).toContain('max-size-time=5000000000');
        });
        it('queueLeaky switches both input queues to shed-oldest at the same depth (never hold backlog)', () => {
            const result = buildPipeline({
                sources: [
                    { sinkPortId: 'video-0', port: 40001 },
                    { sinkPortId: 'audio-0', port: 40002 },
                ],
                output: { port: 40010 },
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
                sources: [{ sinkPortId: 'audio-0', port: 40002 }],
                output: { port: 40010 },
                alignment: 7,
            });
            const branch = result!.linkOnPadAdded[0].branches[0];
            expect(branch.startsWith('queue leaky=0')).toBe(true);
            expect(branch).not.toMatch(/aacparse|ac3parse|mpegaudioparse|opusparse/);
        });
        it('emits a non-leaky bounded queue on the video branch (parser is injected ahead of it by the runner so back-pressure lands on whole frames)', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'video-0', port: 40001 }],
                output: { port: 40010 },
                alignment: 7,
            });
            const videoRule = result!.linkOnPadAdded.find((r) => r.media === 'video')!;
            expect(videoRule.branches[0]).toBe(
                'queue leaky=0 max-size-time=500000000 max-size-buffers=0 max-size-bytes=0',
            );
        });
        describe('in-band stream info (KLV appsrc + PCR pin)', () => {
            const twoSources = [
                { sinkPortId: 'video-0', port: 40001 },
                { sinkPortId: 'audio-0', port: 40002 },
            ];
            const output = { port: 40010 };

            it('emits the klvsrc metadata appsrc on the fixed metadata PID by default, NON-live', () => {
                const result = buildPipeline({ sources: twoSources, output, alignment: 7 });
                // is-live=false is load-bearing: a live pad makes the aggregator's
                // latency arithmetic impossible and mpegtsmux posts a bus WARNING
                // ~130×/s (the muxer's whole main-thread cost, 2026-09-02).
                expect(result!.pipeline).toContain(
                    'appsrc name=klvsrc is-live=false do-timestamp=true format=time' +
                        ' caps="meta/x-klv,parsed=true" ! mux.sink_496',
                );
                expect(result!.pipeline).not.toContain('klvsrc is-live=true');
                expect(result!.hasStreamInfo).toBe(true);
            });

            it('HARD INVARIANT: klvsrc never appears without a PCR pin to a non-metadata pid', () => {
                // The retirement bug: mpegtsmux picked the live do-timestamp
                // appsrc as the PCR stream, driving the receiver clock from a
                // 50 ms software timer. Every pipeline shape that contains
                // klvsrc must pin PCR_1 to a MEDIA pad.
                const shapes = [
                    twoSources,
                    [{ sinkPortId: 'audio-0', port: 40002 }],
                    [
                        { sinkPortId: 'audio-0', port: 40002 },
                        { sinkPortId: 'audio-1', port: 40003 },
                        { sinkPortId: 'video-0', port: 40001 },
                        { sinkPortId: 'video-1', port: 40004 },
                    ],
                ];
                for (const sources of shapes) {
                    const p = buildPipeline({ sources, output, alignment: 7 })!.pipeline;
                    if (!p.includes('klvsrc')) continue;
                    const pin = p.match(/PCR_1=sink_(\d+)/);
                    expect(pin).not.toBeNull();
                    expect(Number(pin![1])).not.toBe(0x1f0);
                }
            });

            it('pins PCR to the first video stream when video is present (the media clock)', () => {
                const result = buildPipeline({ sources: twoSources, output, alignment: 7 });
                expect(result!.pipeline).toContain('PCR_1=sink_256');
            });

            it('pins PCR to the first audio stream on an audio-only mux', () => {
                const result = buildPipeline({
                    sources: [{ sinkPortId: 'audio-0', port: 40002 }],
                    output,
                    alignment: 7,
                });
                expect(result!.pipeline).toContain('PCR_1=sink_320');
            });

            it('maps every stream pad AND the metadata pad into program 1 via prog-map', () => {
                const result = buildPipeline({ sources: twoSources, output, alignment: 7 });
                expect(result!.pipeline).toContain(
                    'prog-map="program_map,sink_256=(int)1,sink_320=(int)1,sink_496=(int)1,' +
                        'PCR_1=sink_256"',
                );
            });

            it('emitStreamInfo=false restores the metadata-free pipeline byte-identically', () => {
                const on = buildPipeline({ sources: twoSources, output, alignment: 7 });
                const off = buildPipeline({
                    sources: twoSources,
                    output,
                    alignment: 7,
                    emitStreamInfo: false,
                });
                expect(off!.pipeline).not.toContain('appsrc');
                expect(off!.pipeline).not.toContain('prog-map');
                expect(off!.pipeline).not.toContain('mux.sink_496');
                expect(off!.hasStreamInfo).toBe(false);
                // Same pipeline minus the prog-map clause and metadata branch.
                expect(
                    on!.pipeline
                        .replace(/ prog-map="[^"]*"/, '')
                        .replace(/ appsrc [^!]+! mux\.sink_496/, ''),
                ).toBe(off!.pipeline);
            });

            it('reports the output-PID map for every routed stream (discovery join key)', () => {
                const result = buildPipeline({
                    sources: [
                        { sinkPortId: 'audio-0', port: 40002 },
                        { sinkPortId: 'video-0', port: 40001 },
                    ],
                    output,
                    alignment: 7,
                });
                expect(result!.streamPids).toEqual([
                    { sinkPortId: 'audio-0', media: 'audio', pid: 0x140, demux: 'demux_0' },
                    { sinkPortId: 'video-0', media: 'video', pid: 0x100, demux: 'demux_1' },
                ]);
            });
        });

        describe('language (ISO 639 PMT descriptor via taginject)', () => {
            const output = { port: 40010 };

            it('appends a taginject to the audio branch when a language is set', () => {
                const result = buildPipeline({
                    sources: [{ sinkPortId: 'audio-0', port: 40002, language: 'deu' }],
                    output,
                    alignment: 7,
                });
                expect(result!.linkOnPadAdded[0].branches[0]).toBe(
                    'queue leaky=0 max-size-time=500000000 max-size-buffers=0 max-size-bytes=0' +
                        ' ! taginject name=lang_320 tags=language-code=deu',
                );
            });

            it('omits the taginject when language is blank or invalid — the source language passes through', () => {
                const result = buildPipeline({
                    sources: [
                        { sinkPortId: 'audio-0', port: 40002, language: '' },
                        { sinkPortId: 'audio-1', port: 40003, language: 'not a code' },
                        { sinkPortId: 'audio-2', port: 40004 },
                    ],
                    output,
                    alignment: 7,
                });
                for (const rule of result!.linkOnPadAdded) {
                    expect(rule.branches[0]).not.toContain('taginject');
                }
            });
        });

        it('emits tsdemux latency=0 on every input branch', () => {
            const result = buildPipeline({
                sources: [
                    { sinkPortId: 'video-0', port: 40001 },
                    { sinkPortId: 'audio-0', port: 40002 },
                ],
                output: { port: 40010 },
                alignment: 7,
            });
            expect(result!.pipeline.match(/tsdemux latency=0 name=demux_/g)).toHaveLength(2);
        });

        it('puts offsetMs on the AUDIO rule as padOffsetNs (lipsync knob), omitted at 0 so the default rule shape is unchanged', () => {
            const result = buildPipeline({
                sources: [
                    { sinkPortId: 'video-0', port: 40001, offsetMs: -700 },
                    { sinkPortId: 'audio-0', port: 40002, offsetMs: -700 },
                    { sinkPortId: 'audio-1', port: 40003, offsetMs: 0 },
                    { sinkPortId: 'audio-2', port: 40004 },
                ],
                output: { port: 40010 },
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

        it('reports every input branch demux for the stamp-anchored alignment', () => {
            // The branches each zero their own timeline off the ONE bus buffer
            // their tsdemux locked on, which is what put 100–121 ms of A/V skew
            // on the .202 mux output (inputs 0.001 ms apart) and re-drew it on
            // every restart. The runner anchors each branch to the producer's
            // stamps instead — it needs the branch element names to do it, and
            // ALL of them: a branch left out keeps its private zero point and
            // takes the pair back out of alignment.
            const result = buildPipeline({
                sources: [
                    { sinkPortId: 'video-0', port: 40001 },
                    { sinkPortId: 'audio-0', port: 40002 },
                    { sinkPortId: 'audio-1', port: 40003 },
                ],
                output: { port: 40010 },
                alignment: 7,
            });
            expect(result!.demuxes).toEqual(['demux_0', 'demux_1', 'demux_2']);
            // The names are the ones the pipeline actually carries.
            for (const name of result!.demuxes) {
                expect(result!.pipeline).toContain(`name=${name}`);
            }
        });

        it('clamps out-of-range offsetMs at the rule level too (±2000)', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'audio-0', port: 40002, offsetMs: -5000 }],
                output: { port: 40010 },
                alignment: 7,
            });
            expect(result!.linkOnPadAdded[0].padOffsetNs).toBe(-2_000_000_000);
        });
    });

    describe('sortSources', () => {
        it('sorts by sinkPortId so pipeline output is deterministic', () => {
            const out = sortSources([
                { sinkPortId: 'video-1', port: 1 },
                { sinkPortId: 'audio-0', port: 2 },
                { sinkPortId: 'video-0', port: 3 },
            ]);
            expect(out.map((s) => s.sinkPortId)).toEqual(['audio-0', 'video-0', 'video-1']);
        });
    });
});

describe('MpegTsMuxerModule', () => {
    function makeModule(opts: { sources?: Array<{ sinkPortId: string; port: number }> } = {}) {
        const module = new MpegTsMuxerModule();
        const getModuleBusSources = vi.fn(() =>
            (opts.sources ?? []).map((s) => ({
                port: s.port,
                connectionId: 'c-' + s.sinkPortId,
                sourceModuleId: 'enc-' + s.sinkPortId,
                sourcePortId: 'mpegts-out',
                sinkPortId: s.sinkPortId,
                socketPath: `/tmp/mr-bus-${s.port}-edge.sock`,
            })),
        );
        const assignBusChannel = vi.fn(() => ({ port: 41000 }));
        (module as any).services = {
            instanceId: 'mux-1',
            mediaRouter: { getModuleBusSources, assignBusChannel },
        };
        return { module, getModuleBusSources, assignBusChannel };
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

        it('produces one branch per connected input and outputs on the assigned bus channel', () => {
            const { module, assignBusChannel } = makeModule({
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
            expect(desc!.pipeline).toContain('tee name=busout_41000 allow-not-linked=true');
            expect(desc!.pipeline).toContain('socket-path=/tmp/mr-bus-40001-edge.sock');
            expect(desc!.pipeline).toContain('socket-path=/tmp/mr-bus-40002-edge.sock');
            expect(desc!.pipeline.match(/tsdemux latency=0 name=demux_/g)).toHaveLength(2);
            // 1 video rule (for video-0) + 1 audio rule (for audio-0)
            expect(desc!.linkOnPadAdded).toHaveLength(2);
            expect(assignBusChannel).toHaveBeenCalledWith('mux-1');
        });

        it('asks the runner to anchor every branch to the producers stamps', () => {
            const { module } = makeModule({
                sources: [
                    { sinkPortId: 'video-0', port: 40001 },
                    { sinkPortId: 'audio-0', port: 40002 },
                ],
            });
            (module as any).config = { alignment: 7 };
            (module as any).setHealth = vi.fn();
            (module as any).setStatusData = vi.fn();
            const desc = module.buildPipeline((module as any).config);
            // Declared unconditionally; `GstPluginBase.applyTimeSync` is the one
            // place that decides, and drops it when the contract is off.
            expect(desc!.alignBranchesToStamps).toEqual({ demuxes: ['demux_0', 'demux_1'] });
        });

        it('hands the runner one stall watch per input source (no watchdog element)', () => {
            const { module } = makeModule({
                sources: [
                    { sinkPortId: 'video-0', port: 40001 },
                    { sinkPortId: 'audio-0', port: 40002 },
                ],
            });
            (module as any).config = { alignment: 7 };
            (module as any).setHealth = vi.fn();
            (module as any).setStatusData = vi.fn();
            const desc = module.buildPipeline((module as any).config);
            expect(desc!.inputStallWatch).toEqual([
                { element: 'busin_0', timeoutMs: 5000 },
                { element: 'busin_1', timeoutMs: 5000 },
            ]);
            expect(desc!.pipeline).not.toContain('watchdog');
        });

        it('declares the stream arrays as live-updatable', () => {
            const { module } = makeModule();
            expect(module.getLiveUpdatableParams()).toEqual(['videoStreams', 'audioStreams']);
        });

        it('isLiveChange: rename is live, add/remove or legacy shape is not', () => {
            const { module } = makeModule();
            // Same length → rename (label only) → live update, no rebuild.
            expect(module.isLiveChange('videoStreams', [{ name: 'B' }], [{ name: 'A' }])).toBe(
                true,
            );
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
            expect(module.isLiveChange('audioStreams', [{ name: 'B' }], [{ name: 'A' }])).toBe(
                true,
            );
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
            const schema = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
                .mediaRouter.configSchema.properties;
            const audioItem = schema.audioStreams.items.properties;
            expect(audioItem.offsetMs).toMatchObject({
                type: 'number',
                default: 0,
                minimum: -2000,
                maximum: 2000,
            });
            expect(schema.videoStreams.items.properties.offsetMs).toBeUndefined();
        });

        it('exposes language on audioStreams items and the emitStreamInfo toggle in the schema', () => {
            const schema = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
                .mediaRouter.configSchema.properties;
            expect(schema.audioStreams.items.properties.language).toMatchObject({
                type: 'string',
                default: '',
            });
            expect(schema.emitStreamInfo).toMatchObject({
                type: 'boolean',
                default: true,
                'x-liveUpdatable': false,
            });
        });

        it('isLiveChange: a language edit is NOT live — the taginject is built into the branch', () => {
            const { module } = makeModule();
            expect(
                module.isLiveChange(
                    'audioStreams',
                    [{ name: 'ENG', language: 'eng' }],
                    [{ name: 'ENG', language: '' }],
                ),
            ).toBe(false);
            // Absent language (old entry shape) is equivalent to blank.
            expect(
                module.isLiveChange(
                    'audioStreams',
                    [{ name: 'ENG', language: 'eng' }],
                    [{ name: 'ENG' }],
                ),
            ).toBe(false);
            // Rename with unchanged language stays live.
            expect(
                module.isLiveChange(
                    'audioStreams',
                    [{ name: 'NOR', language: 'eng' }],
                    [{ name: 'ENG', language: 'eng' }],
                ),
            ).toBe(true);
        });

        it('threads audioStreams language into the audio branch taginject', () => {
            const { module } = makeModule({
                sources: [{ sinkPortId: 'audio-0', port: 40002 }],
            });
            (module as any).config = {
                videoStreams: [],
                audioStreams: [{ name: 'DE', language: 'deu' }],
                alignment: 7,
            };
            (module as any).setHealth = vi.fn();
            (module as any).setStatusData = vi.fn();
            const desc = module.buildPipeline((module as any).config);
            expect(desc!.linkOnPadAdded![0].branches[0]).toContain(
                'taginject name=lang_320 tags=language-code=deu',
            );
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

    describe('in-band stream info pushes', () => {
        function makeBuiltModule() {
            const { module } = makeModule({
                sources: [
                    { sinkPortId: 'video-0', port: 40001 },
                    { sinkPortId: 'audio-0', port: 40002 },
                ],
            });
            (module as any).config = {
                videoStreams: [{ name: 'Cam 1' }],
                audioStreams: [{ name: '' }],
                alignment: 7,
            };
            (module as any).setHealth = vi.fn();
            (module as any).setStatusData = vi.fn();
            const setKlvPayload = vi.fn();
            (module as any).setKlvPayload = setKlvPayload;
            module.buildPipeline((module as any).config);
            return { module, setKlvPayload };
        }

        it('pushes the name payload on PLAYING (config names + sourceModuleId fallback)', () => {
            const { module, setKlvPayload } = makeBuiltModule();
            (module as any).onPipelinePlaying();
            expect(setKlvPayload).toHaveBeenCalledTimes(1);
            const [element, json] = setKlvPayload.mock.calls[0];
            expect(element).toBe('klvsrc');
            expect(JSON.parse(json)).toEqual({
                v: 1,
                streams: [
                    { pid: 0x100, media: 'video', name: 'Cam 1' },
                    { pid: 0x140, media: 'audio', name: 'enc-audio-0' },
                ],
            });
        });

        it('merges discovery per the layering rule: native codec stays name-only, non-native gets codec fields', () => {
            const { module, setKlvPayload } = makeBuiltModule();
            (module as any).onPluginEvent('stream:discovered', {
                from: 'demux_0',
                pid: 0x151,
                media: 'audio',
                caps: 'audio/mpeg, mpegversion=(int)4, rate=(int)48000, channels=(int)2',
                padName: 'audio_0_0151',
            });
            (module as any).onPluginEvent('stream:discovered', {
                from: 'demux_1',
                pid: 0x131,
                media: 'video',
                caps: 'private/x-unmapped',
                padName: 'private_0_0131',
            });
            const last = JSON.parse(setKlvPayload.mock.calls.at(-1)![1]);
            // aac is natively signalled in the PMT → name-only entry; the
            // unknown/private video payload has no codec id → nothing to add.
            expect(last.streams).toEqual([
                { pid: 0x100, media: 'video', name: 'Cam 1' },
                { pid: 0x140, media: 'audio', name: 'enc-audio-0' },
            ]);
        });

        it('carries codec info for a non-native codec (the KLV fallback case)', () => {
            const { module, setKlvPayload } = makeBuiltModule();
            (module as any).onPluginEvent('stream:discovered', {
                from: 'demux_0',
                pid: 0x151,
                media: 'audio',
                caps: 'application/x-subtitle-vtt',
                padName: 'audio_0_0151',
            });
            const last = JSON.parse(setKlvPayload.mock.calls.at(-1)![1]);
            expect(last.streams.find((s: { pid: number }) => s.pid === 0x140)).toEqual({
                pid: 0x140,
                media: 'audio',
                name: 'enc-audio-0',
                codec: 'webvtt',
            });
        });

        it('first discovery per output PID wins (later same-media pads were not linked)', () => {
            const { module, setKlvPayload } = makeBuiltModule();
            (module as any).onPluginEvent('stream:discovered', {
                from: 'demux_0',
                pid: 0x151,
                media: 'audio',
                caps: 'application/x-subtitle-vtt',
                padName: 'audio_0_0151',
            });
            (module as any).onPluginEvent('stream:discovered', {
                from: 'demux_0',
                pid: 0x152,
                media: 'audio',
                caps: 'audio/x-opus',
                padName: 'audio_0_0152',
            });
            const last = JSON.parse(setKlvPayload.mock.calls.at(-1)![1]);
            expect(last.streams.find((s: { pid: number }) => s.pid === 0x140)?.codec).toBe(
                'webvtt',
            );
        });

        it('re-pushes on a live stream-array rename', async () => {
            const { module, setKlvPayload } = makeBuiltModule();
            await (module as any).onLiveConfigUpdate({ videoStreams: [{ name: 'Renamed' }] });
            const last = JSON.parse(setKlvPayload.mock.calls.at(-1)![1]);
            expect(last.streams[0].name).toBe('Renamed');
        });

        it('never pushes when the pipeline was built without the stream-info channel', () => {
            const { module } = makeModule({
                sources: [{ sinkPortId: 'audio-0', port: 40002 }],
            });
            (module as any).config = {
                audioStreams: [{ name: 'X' }],
                alignment: 7,
                emitStreamInfo: false,
            };
            (module as any).setHealth = vi.fn();
            (module as any).setStatusData = vi.fn();
            const setKlvPayload = vi.fn();
            (module as any).setKlvPayload = setKlvPayload;
            module.buildPipeline((module as any).config);
            (module as any).onPipelinePlaying();
            (module as any).onPluginEvent('stream:discovered', {
                from: 'demux_0',
                pid: 0x151,
                media: 'audio',
                caps: 'audio/x-opus',
                padName: 'audio_0_0151',
            });
            expect(setKlvPayload).not.toHaveBeenCalled();
        });
    });
});
