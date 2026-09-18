import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    buildDynamicPorts,
    buildInputBranch,
    buildPipeline,
    inputEntries,
    inputPortId,
    isInputPort,
    isLegacyConfig,
    legacyPortMedia,
    assignInputKeys,
    assignInputPids,
    configPidConflicts,
    findPidConflicts,
    MuxerPidConflictError,
    sortSources,
    type InputEntry,
} from './mpegtsMuxerPipeline.js';
import { MpegTsMuxerModule } from './MpegTsMuxerModule.js';
import type { MuxRoutingConfig } from './muxPids.js';
import type { PipelineDescription } from '@media-router/engine';

/** The mux_routing hook inputs a built PipelineDescription carries. */
const hookInputs = (desc: PipelineDescription) =>
    (desc.runnerHooks![0].config as MuxRoutingConfig).inputs;

const entry = (id: string, extra: Partial<InputEntry> = {}): InputEntry => ({
    id,
    label: id,
    name: '',
    offsetMs: 0,
    language: '',
    ...extra,
});

describe('mpegtsMuxerPipeline helpers', () => {
    describe('inputEntries', () => {
        it('reads the generic inputs array, tolerating malformed entries', () => {
            const entries = inputEntries({ inputs: [{ name: 'Cam 1' }, {}, null, { name: 7 }] });
            expect(entries).toEqual([
                {
                    id: 'input-0',
                    key: 0,
                    label: 'Input 1',
                    name: 'Cam 1',
                    offsetMs: 0,
                    language: '',
                },
                { id: 'input-1', key: 1, label: 'Input 2', name: '', offsetMs: 0, language: '' },
                { id: 'input-2', key: 2, label: 'Input 3', name: '', offsetMs: 0, language: '' },
                { id: 'input-3', key: 3, label: 'Input 4', name: '', offsetMs: 0, language: '' },
            ]);
        });
        it('keys ports by the persisted `key`, so removing an entry never renames the ones after it', () => {
            // Seeded [0,1,2]; the operator removed the middle one.
            const after = inputEntries({ inputs: [{ key: 0 }, { key: 2 }] });
            expect(after.map((e) => [e.id, e.label])).toEqual([
                ['input-0', 'Input 1'],
                ['input-2', 'Input 2'], // label is positional, id is not
            ]);
            // A new entry appended after that: index 2 is taken as a key → one past the highest.
            const grown = inputEntries({ inputs: [{ key: 0 }, { key: 2 }, {}] });
            expect(grown.map((e) => e.id)).toEqual(['input-0', 'input-2', 'input-3']);
            expect(assignInputKeys([{ key: 0 }, { key: 2 }, {}])).toEqual([0, 2, 3]);
            // Unseeded entries resolve to their index — what an old config already had.
            expect(assignInputKeys([{}, {}, { key: 'x' }])).toEqual([0, 1, 2]);
            // A not-yet-seeded entry after a keyed one keeps its index when free.
            expect(assignInputKeys([{ key: 5 }, {}])).toEqual([5, 1]);
        });
        it('sanitizes language to a bare 2-3 letter ISO 639 code (lowercased), else blank', () => {
            const entries = inputEntries({
                inputs: [
                    { language: 'ENG' },
                    { language: 'de' },
                    { language: 'german' },
                    { language: 'e n' },
                    { language: 7 },
                    {},
                ],
            });
            expect(entries.map((e) => e.language)).toEqual(['eng', 'de', '', '', '', '']);
        });
        it('maps offsetMs, clamping to ±2000 and zeroing malformed values', () => {
            const entries = inputEntries({
                inputs: [
                    { offsetMs: -700 },
                    { offsetMs: -9999 },
                    { offsetMs: 9999 },
                    { offsetMs: 'nope' },
                    { offsetMs: NaN },
                ],
            });
            expect(entries.map((e) => e.offsetMs)).toEqual([-700, -2000, 2000, 0, 0]);
        });
        it('defaults to one generic input on an empty config', () => {
            expect(inputEntries({})).toEqual([
                { id: 'input-0', key: 0, label: 'Input 1', name: '', offsetMs: 0, language: '' },
            ]);
        });
        it('clamps to the schema maxItems (16 — one PID slot per class per input)', () => {
            const many = Array.from({ length: 20 }, () => ({}));
            expect(inputEntries({ inputs: many })).toHaveLength(16);
        });

        describe('legacy configs (videoStreams / audioStreams, pre-generic)', () => {
            it('keeps the legacy port ids, labels and kinds so existing wiring survives', () => {
                const entries = inputEntries({
                    videoStreams: [{ name: 'Cam 1' }],
                    audioStreams: [{ name: 'FOH', language: 'ENG', offsetMs: -700 }, {}],
                });
                expect(entries).toEqual([
                    {
                        id: 'video-0',
                        label: 'Video 1',
                        name: 'Cam 1',
                        offsetMs: 0,
                        language: '',
                        legacyMedia: 'video',
                    },
                    {
                        id: 'audio-0',
                        label: 'Audio 1',
                        name: 'FOH',
                        offsetMs: -700,
                        language: 'eng',
                        legacyMedia: 'audio',
                    },
                    {
                        id: 'audio-1',
                        label: 'Audio 2',
                        name: '',
                        offsetMs: 0,
                        language: '',
                        legacyMedia: 'audio',
                    },
                ]);
            });
            it('still honours the oldest counts + streamNames shape', () => {
                const entries = inputEntries({
                    videoStreamCount: 1,
                    audioStreamCount: 2,
                    streamNames: { 'audio-1': 'FOH' },
                });
                expect(entries.map((e) => [e.id, e.name])).toEqual([
                    ['video-0', ''],
                    ['audio-0', ''],
                    ['audio-1', 'FOH'],
                ]);
            });
            it('LEGACY KEYS WIN over an inputs array — the settings form seeds the inputs default and Apply writes it back', () => {
                // Without this rule the first Apply on a legacy module would flip
                // it to a lone input-0 port and silently drop every connection.
                const entries = inputEntries({
                    inputs: [{ name: '' }],
                    videoStreams: [{ name: 'Cam' }],
                    audioStreams: [{ name: 'Mix' }],
                });
                expect(entries.map((e) => e.id)).toEqual(['video-0', 'audio-0']);
            });
            it('clamps legacy lists to their old maxItems (8 video / 16 audio)', () => {
                const many = Array.from({ length: 20 }, () => ({}));
                const entries = inputEntries({ videoStreams: many, audioStreams: many });
                expect(entries.filter((e) => e.legacyMedia === 'video')).toHaveLength(8);
                expect(entries.filter((e) => e.legacyMedia === 'audio')).toHaveLength(16);
            });
            it('isLegacyConfig detects every legacy key shape', () => {
                expect(isLegacyConfig({ videoStreams: [] })).toBe(true);
                expect(isLegacyConfig({ audioStreamCount: 1 })).toBe(true);
                expect(isLegacyConfig({ inputs: [{}] })).toBe(false);
                expect(isLegacyConfig({})).toBe(false);
            });
        });
    });

    describe('port id helpers', () => {
        it('produces generic ids and recognises generic + legacy input ports', () => {
            expect(inputPortId(2)).toBe('input-2');
            expect(isInputPort('input-0')).toBe(true);
            expect(isInputPort('video-0')).toBe(true);
            expect(isInputPort('audio-3')).toBe(true);
            expect(isInputPort('mpegts-out')).toBe(false);
        });
        it('reads the legacy kind off a port id', () => {
            expect(legacyPortMedia('video-1')).toBe('video');
            expect(legacyPortMedia('audio-0')).toBe('audio');
            expect(legacyPortMedia('input-0')).toBeUndefined();
        });
    });

    describe('buildDynamicPorts', () => {
        it('emits one input port per entry + a single output', () => {
            const ports = buildDynamicPorts([entry('input-0'), entry('input-1'), entry('input-2')]);
            expect(ports.filter((p) => p.direction === 'input').map((p) => p.id)).toEqual([
                'input-0',
                'input-1',
                'input-2',
            ]);
            expect(ports.filter((p) => p.direction === 'output')).toHaveLength(1);
        });
        it('still exposes the output port when no inputs are configured', () => {
            const ports = buildDynamicPorts([]);
            expect(ports).toHaveLength(1);
            expect(ports[0].direction).toBe('output');
        });
        it('caps each input at maxConnections=1 and the output at unlimited', () => {
            const ports = buildDynamicPorts([entry('input-0')]);
            expect(ports.find((p) => p.id === 'input-0')!.maxConnections).toBe(1);
            expect(ports.find((p) => p.direction === 'output')!.maxConnections).toBe(-1);
        });
        it('every input accepts either TS family (dual-colour dot) — any input takes any stream', () => {
            const ports = buildDynamicPorts([
                entry('input-0'),
                entry('video-0', { legacyMedia: 'video' }),
            ]);
            for (const p of ports.filter((p) => p.direction === 'input')) {
                expect(p.acceptsAnyTs).toBe(true);
            }
        });
        it('carries name/language streamInfo on configured entries, none on blank generic ones', () => {
            const ports = buildDynamicPorts([
                entry('input-0', { name: 'Cam 1' }),
                entry('input-1', { language: 'nor' }),
                entry('input-2'),
            ]);
            expect(ports.find((p) => p.id === 'input-0')!.streamInfo).toEqual({ name: 'Cam 1' });
            expect(ports.find((p) => p.id === 'input-1')!.streamInfo).toEqual({ language: 'nor' });
            expect(ports.find((p) => p.id === 'input-2')!.streamInfo).toBeUndefined();
        });
        it('legacy ports keep their media in streamInfo and their old labels', () => {
            const ports = buildDynamicPorts([
                entry('audio-0', { label: 'Audio 1', legacyMedia: 'audio', name: 'FOH' }),
            ]);
            const p = ports.find((p) => p.id === 'audio-0')!;
            expect(p.label).toBe('Audio 1');
            expect(p.streamInfo).toEqual({ media: 'audio', name: 'FOH' });
        });
    });

    describe('buildInputBranch', () => {
        it('reads the per-consumer edge socket via a named unixfdsrc, with NO watchdog element in the branch', () => {
            const s = buildInputBranch('0', {
                sinkPortId: 'input-0',
                port: 40000,
                socketPath: '/tmp/mr-bus-40000-abc123.sock',
            });
            expect(s).toBe(
                'unixfdsrc name=busin_0 socket-path=/tmp/mr-bus-40000-abc123.sock' +
                    ' ! queue leaky=2 max-size-time=5000000000 max-size-buffers=0 max-size-bytes=40000000' +
                    ' ! tsdemux latency=0 name=demux_0',
            );
            expect(s).not.toContain('watchdog');
            expect(s).not.toContain('! mux.');
        });
        it('falls back to the channel-level socket when no edge socketPath is handed out', () => {
            const s = buildInputBranch('1', { sinkPortId: 'input-1', port: 40001 });
            expect(s).toContain('unixfdsrc name=busin_1 socket-path=/tmp/mr-bus-40001.sock');
            expect(s).toContain('tsdemux latency=0 name=demux_1');
        });
        it('goes straight from the bus src to tsdemux with no tsparse', () => {
            expect(buildInputBranch('0', { sinkPortId: 'input-0', port: 40000 })).not.toContain(
                'tsparse',
            );
        });
    });

    describe('buildPipeline', () => {
        const output = { port: 40010 };
        const QUEUE =
            'queue leaky=0 max-size-time=500000000 max-size-buffers=0 max-size-bytes=4000000';

        it('returns null when no inputs are wired', () => {
            expect(buildPipeline({ sources: [], output, alignment: 7 })).toBeNull();
        });
        it('connects mpegtsmux straight to the bus egress with no leaky queue between', () => {
            const p = buildPipeline({
                sources: [{ sinkPortId: 'input-0', port: 40001 }],
                output,
                alignment: 7,
            })!.pipeline;
            expect(p).toMatch(/mpegtsmux name=mux[^!]+! capssetter caps="video\/mpegts/);
            expect(p).not.toMatch(/mpegtsmux name=mux[^!]+! queue/);
        });
        it('emits one demux branch + one media-agnostic rule per input, all into the named mux', () => {
            const result = buildPipeline({
                sources: [
                    { sinkPortId: 'input-0', port: 40001 },
                    { sinkPortId: 'input-1', port: 40002 },
                ],
                output,
                alignment: 7,
            })!;
            expect(result.pipeline).toContain(
                'mpegtsmux name=mux latency=1200000000 min-upstream-latency=1200000000 alignment=7',
            );
            expect(result.pipeline).toContain(
                'capssetter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" replace=true ! ' +
                    'capsfilter caps="video/mpegts, systemstream=(boolean)true, packetsize=(int)188" ! ' +
                    'tee name=busout_40010 allow-not-linked=true',
            );
            expect(result.pipeline.match(/tsdemux latency=0 name=demux_/g)).toHaveLength(2);
            expect(result.pipeline.match(/unixfdsrc name=busin_/g)).toHaveLength(2);
            expect(result.routing.inputs).toHaveLength(2);
            for (const rule of result.routing.inputs) {
                expect(rule.linkTo).toBe('mux');
                // Every routed class present, all parser-free (the hook picks
                // the parser from the pad's caps at pad-added time).
                expect(Object.keys(rule.routes).sort()).toEqual(
                    ['audio', 'klv', 'subtitle', 'video'].sort(),
                );
                for (const route of Object.values(rule.routes)) {
                    expect(route!.branch.startsWith('queue leaky=0')).toBe(true);
                    expect(route!.branch).not.toMatch(/h264parse|aacparse/);
                }
            }
            expect(result.routing.inputs[0].demux).toBe('demux_0');
            expect(result.routing.inputs[1].demux).toBe('demux_1');
        });
        it('gives each generic input ONE pid (the set value, else the next free automatic) and no per-class pad names — the hook assigns pads from the source PMT', () => {
            const result = buildPipeline({
                sources: [
                    { sinkPortId: 'input-0', port: 40001 },
                    { sinkPortId: 'input-2', port: 40002, pid: 0x200 }, // input-1 unwired
                    { sinkPortId: 'input-3', port: 40003 },
                ],
                output,
                alignment: 7,
            })!;
            const [r0, r2, r3] = result.routing.inputs;
            expect(r0.pid).toBe(0x100);
            expect(r2.pid).toBe(0x200);
            expect(r3.pid).toBe(0x108); // next free after 0x100; 0x200 is taken
            for (const rule of [r0, r2, r3]) {
                for (const route of Object.values(rule.routes)) expect('padName' in route!).toBe(false);
            }
            expect(result.slots).toEqual([
                { sinkPortId: 'input-0', demux: 'demux_0', pid: 0x100, automatic: true },
                { sinkPortId: 'input-2', demux: 'demux_1', pid: 0x200, automatic: false },
                { sinkPortId: 'input-3', demux: 'demux_2', pid: 0x108, automatic: true },
            ]);
        });
        it('marks the cue classes sparse so the runner keeps the mux fed while they are idle', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'input-0', port: 40001 }],
                output,
                alignment: 7,
            })!;
            const routes = result.routing.inputs[0].routes;
            expect(routes.klv!.sparse).toBe(true);
            expect(routes.subtitle!.sparse).toBe(true);
            expect('sparse' in routes.video!).toBe(false);
            expect('sparse' in routes.audio!).toBe(false);
        });
        it('never routes the metadata carousel PID of an upstream muxer', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'input-0', port: 40001 }],
                output,
                alignment: 7,
            })!;
            expect(result.routing.inputs[0].ignorePids).toEqual([0x1f0]);
        });

        describe('legacy ports keep their old PIDs and only their own kind', () => {
            it('video-N → 0x100+ordinal, audio-N → 0x140+ordinal, exactly the D3 scheme', () => {
                const result = buildPipeline({
                    sources: [
                        { sinkPortId: 'audio-0', port: 40003 },
                        { sinkPortId: 'audio-1', port: 40004 },
                        { sinkPortId: 'video-0', port: 40001 },
                        { sinkPortId: 'video-1', port: 40002 },
                    ],
                    output,
                    alignment: 7,
                })!;
                const routes = result.routing.inputs.map((r) => r.routes);
                expect(routes[0].audio!.padName).toBe('sink_320');
                expect(routes[1].audio!.padName).toBe('sink_321');
                expect(routes[2].video!.padName).toBe('sink_256');
                expect(routes[3].video!.padName).toBe('sink_257');
            });
            it('numbers legacy PIDs per-kind by CONNECTED ordinal, not by port index', () => {
                // audio-1 wired alone still lands on 0x140, as it always did.
                const result = buildPipeline({
                    sources: [
                        { sinkPortId: 'audio-1', port: 40004 },
                        { sinkPortId: 'video-0', port: 40001 },
                    ],
                    output,
                    alignment: 7,
                })!;
                expect(result.routing.inputs[0].routes.audio!.padName).toBe('sink_320');
                expect(result.routing.inputs[1].routes.video!.padName).toBe('sink_256');
            });
            it('a legacy port routes its own kind + klv + subtitle, never the other A/V kind', () => {
                const result = buildPipeline({
                    sources: [
                        { sinkPortId: 'audio-0', port: 40003 },
                        { sinkPortId: 'video-0', port: 40001 },
                    ],
                    output,
                    alignment: 7,
                })!;
                const [audioRule, videoRule] = result.routing.inputs;
                expect(Object.keys(audioRule.routes).sort()).toEqual(['audio', 'klv', 'subtitle']);
                expect(Object.keys(videoRule.routes).sort()).toEqual(['klv', 'subtitle', 'video']);
                // klv/subtitle slots keyed by the source's overall ordinal — no
                // collision between the two ports.
                expect(audioRule.routes.klv!.padName).toBe('sink_384');
                expect(videoRule.routes.klv!.padName).toBe('sink_385');
            });
            it('THE .103 CASE: a KLV-only subtitle TS on a legacy audio port is routed, not left unlinked', () => {
                const result = buildPipeline({
                    sources: [{ sinkPortId: 'audio-0', port: 40003 }],
                    output,
                    alignment: 7,
                })!;
                const rule = result.routing.inputs[0];
                expect(rule.linkTo).toBe('mux');
                expect(rule.routes.klv).toEqual({
                    padName: 'sink_384',
                    branch: QUEUE,
                    sparse: true,
                });
            });
        });

        it('videoParserBypass marks only the VIDEO route parser:none', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'input-0', port: 40001 }],
                output,
                alignment: 7,
                videoParserBypass: true,
            })!;
            const routes = result.routing.inputs[0].routes;
            expect(routes.video!.parser).toBe('none');
            expect(routes.audio!.parser).toBeUndefined();
            expect(routes.klv!.parser).toBeUndefined();
        });
        it('omits the parser key entirely when videoParserBypass is off (route shape unchanged)', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'input-0', port: 40001 }],
                output,
                alignment: 7,
            })!;
            expect('parser' in result.routing.inputs[0].routes.video!).toBe(false);
        });
        it('declares a 5 s runner-side stall watch on every input source', () => {
            const result = buildPipeline({
                sources: [
                    { sinkPortId: 'input-0', port: 40002 },
                    { sinkPortId: 'input-1', port: 40001 },
                ],
                output,
                alignment: 7,
            })!;
            expect(result.inputStallWatch).toEqual([
                { element: 'busin_0', timeoutMs: 5000 },
                { element: 'busin_1', timeoutMs: 5000 },
            ]);
            for (const w of result.inputStallWatch) {
                expect(result.pipeline).toContain(`unixfdsrc name=${w.element} `);
            }
            expect(result.pipeline).not.toContain('watchdog');
        });
        it('honours the alignment config', () => {
            expect(
                buildPipeline({
                    sources: [{ sinkPortId: 'input-0', port: 40001 }],
                    output,
                    alignment: 1,
                })!.pipeline,
            ).toContain('alignment=1');
        });
        it('defaults to non-leaky input queues on every route (aggregator skew back-pressures, never sheds)', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'input-0', port: 40002 }],
                output,
                alignment: 7,
            })!;
            for (const route of Object.values(result.routing.inputs[0].routes)) {
                expect(route!.branch).toBe(QUEUE);
            }
        });
        it('threads queueDepthMs into the bound (clamped 100–5000 ms)', () => {
            const r = buildPipeline({
                sources: [{ sinkPortId: 'input-0', port: 40002 }],
                output,
                alignment: 7,
                queueDepthMs: 1200,
            })!;
            expect(r.routing.inputs[0].routes.audio!.branch).toContain('max-size-time=1200000000');
            const clamped = buildPipeline({
                sources: [{ sinkPortId: 'input-0', port: 40002 }],
                output,
                alignment: 7,
                queueDepthMs: 99_999,
            })!;
            expect(clamped.routing.inputs[0].routes.audio!.branch).toContain(
                'max-size-time=5000000000',
            );
        });
        it('queueLeaky switches every route to shed-oldest at the same depth', () => {
            const result = buildPipeline({
                sources: [{ sinkPortId: 'input-0', port: 40001 }],
                output,
                alignment: 7,
                queueLeaky: true,
                queueDepthMs: 200,
            })!;
            for (const route of Object.values(result.routing.inputs[0].routes)) {
                expect(route!.branch).toContain('queue leaky=2 max-size-time=200000000');
                expect(route!.branch).toContain('max-size-bytes=1600000');
            }
        });

        describe('prog-map + PCR', () => {
            const twoSources = [
                { sinkPortId: 'input-0', port: 40001 },
                { sinkPortId: 'input-1', port: 40002 },
            ];
            it('maps every input PID into program 1 and seeds PCR_1 with the first one (the hook re-points it at the first video pad)', () => {
                const result = buildPipeline({
                    sources: [{ sinkPortId: 'input-0', port: 40001 }],
                    output,
                    alignment: 7,
                })!;
                expect(result.pipeline).toContain(
                    'prog-map="program_map,sink_256=(int)1,PCR_1=sink_256"',
                );
                expect(
                    buildPipeline({ sources: twoSources, output, alignment: 7 })!.pipeline,
                ).toContain('prog-map="program_map,sink_256=(int)1,sink_264=(int)1,PCR_1=sink_256"');
            });
            it('seeds PCR_1 with the first audio slot on a legacy audio-only mux, as before', () => {
                expect(
                    buildPipeline({
                        sources: [{ sinkPortId: 'audio-0', port: 40002 }],
                        output,
                        alignment: 7,
                    })!.pipeline,
                ).toContain('PCR_1=sink_320');
            });
            it('hands PCR selection to the runner on every rule (video first) — the builder cannot know which input carries video', () => {
                const result = buildPipeline({ sources: twoSources, output, alignment: 7 })!;
                for (const rule of result.routing.inputs) expect(rule.pcr).toEqual({ program: 1 });
            });
            it('emits NO stream-info carousel: no appsrc, no metadata pad, PID 0x1f0 only ever ignored', () => {
                const result = buildPipeline({ sources: twoSources, output, alignment: 7 })!;
                expect(result.pipeline).not.toContain('appsrc');
                expect(result.pipeline).not.toContain('klv');
                expect(result.pipeline).not.toContain('sink_496');
                for (const rule of result.routing.inputs) expect(rule.ignorePids).toEqual([0x1f0]);
            });
            it('reports every PID slot (discovery join key)', () => {
                const result = buildPipeline({
                    sources: [
                        { sinkPortId: 'audio-0', port: 40002 },
                        { sinkPortId: 'input-1', port: 40001 },
                    ],
                    output,
                    alignment: 7,
                })!;
                expect(result.slots).toEqual([
                    {
                        sinkPortId: 'audio-0',
                        demux: 'demux_0',
                        media: 'audio',
                        pid: 0x140,
                        automatic: true,
                    },
                    {
                        sinkPortId: 'audio-0',
                        demux: 'demux_0',
                        media: 'klv',
                        pid: 0x180,
                        automatic: true,
                    },
                    {
                        sinkPortId: 'audio-0',
                        demux: 'demux_0',
                        media: 'subtitle',
                        pid: 0x1a0,
                        automatic: true,
                    },
                    // Generic input: one slot, no class — the hook decides
                    // where each class lands from the source PMT.
                    {
                        sinkPortId: 'input-1',
                        demux: 'demux_1',
                        pid: 0x100,
                        automatic: true,
                    },
                ]);
            });
        });

        describe('language (ISO 639 PMT descriptor via taginject) and offset — audio route only', () => {
            it('appends a taginject to every non-video route when a language is set', () => {
                const result = buildPipeline({
                    sources: [{ sinkPortId: 'input-0', port: 40002, language: 'deu' }],
                    output,
                    alignment: 7,
                })!;
                const routes = result.routing.inputs[0].routes;
                // Every non-video class carries the tag — the ISO 639 descriptor
                // is the official carrier of stream identity (what Gate01's
                // feeds do); mpegtsmux writes it for audio today.
                expect(routes.audio!.branch).toBe(
                    `${QUEUE} ! taginject name=lang_demux_0_audio tags=language-code=deu`,
                );
                expect(routes.klv!.branch).toBe(
                    `${QUEUE} ! taginject name=lang_demux_0_klv tags=language-code=deu`,
                );
                expect(routes.subtitle!.branch).toBe(
                    `${QUEUE} ! taginject name=lang_demux_0_subtitle tags=language-code=deu`,
                );
                expect(routes.video!.branch).toBe(QUEUE);
            });
            it('omits the taginject when language is blank or invalid', () => {
                const result = buildPipeline({
                    sources: [
                        { sinkPortId: 'input-0', port: 40002, language: '' },
                        { sinkPortId: 'input-1', port: 40003, language: 'not a code' },
                        { sinkPortId: 'input-2', port: 40004 },
                    ],
                    output,
                    alignment: 7,
                })!;
                for (const rule of result.routing.inputs) {
                    for (const route of Object.values(rule.routes)) {
                        expect(route!.branch).not.toContain('taginject');
                    }
                }
            });
            it('puts offsetMs on the AUDIO route as padOffsetNs, omitted at 0, clamped ±2000', () => {
                const result = buildPipeline({
                    sources: [
                        { sinkPortId: 'input-0', port: 40001, offsetMs: -700 },
                        { sinkPortId: 'input-1', port: 40003, offsetMs: 0 },
                        { sinkPortId: 'input-2', port: 40004, offsetMs: -5000 },
                    ],
                    output,
                    alignment: 7,
                })!;
                const [r0, r1, r2] = result.routing.inputs.map((r) => r.routes);
                expect(r0.audio!.padOffsetNs).toBe(-700_000_000);
                expect('padOffsetNs' in r0.video!).toBe(false);
                expect('padOffsetNs' in r1.audio!).toBe(false);
                expect(r2.audio!.padOffsetNs).toBe(-2_000_000_000);
            });
        });

        it('reports every input branch demux for the stamp-anchored alignment', () => {
            const result = buildPipeline({
                sources: [
                    { sinkPortId: 'input-0', port: 40001 },
                    { sinkPortId: 'input-1', port: 40002 },
                    { sinkPortId: 'input-2', port: 40003 },
                ],
                output,
                alignment: 7,
            })!;
            expect(result.demuxes).toEqual(['demux_0', 'demux_1', 'demux_2']);
            for (const name of result.demuxes) expect(result.pipeline).toContain(`name=${name}`);
        });
    });

    describe('sortSources', () => {
        it('sorts by prefix then by port NUMBER so input-10 follows input-2', () => {
            const out = sortSources([
                { sinkPortId: 'input-10', port: 1 },
                { sinkPortId: 'input-2', port: 2 },
                { sinkPortId: 'input-0', port: 3 },
            ]);
            expect(out.map((s) => s.sinkPortId)).toEqual(['input-0', 'input-2', 'input-10']);
        });
        it('keeps the legacy audio-before-video order', () => {
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
        (module as any).setHealth = vi.fn();
        (module as any).setStatusData = vi.fn();
        const emitConfigUpdate = vi.fn();
        (module as any).emitConfigUpdate = emitConfigUpdate;
        return { module, getModuleBusSources, assignBusChannel, emitConfigUpdate };
    }

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('getDynamicPorts', () => {
        it('sizes ports from the inputs array', () => {
            const { module } = makeModule();
            (module as any).config = { inputs: [{ name: 'Cam 1' }, {}, {}] };
            const ports = module.getDynamicPorts();
            expect(ports.filter((p) => p.direction === 'input').map((p) => p.id)).toEqual([
                'input-0',
                'input-1',
                'input-2',
            ]);
            expect(ports.filter((p) => p.direction === 'output')).toHaveLength(1);
        });
        it('keeps legacy video-N/audio-N ports for a pre-generic config', () => {
            const { module } = makeModule();
            (module as any).config = { videoStreamCount: 2, audioStreamCount: 3 };
            const ports = module.getDynamicPorts();
            expect(ports.filter((p) => p.direction === 'input').map((p) => p.id)).toEqual([
                'video-0',
                'video-1',
                'audio-0',
                'audio-1',
                'audio-2',
            ]);
        });
        it('falls back to one input when config is empty', () => {
            const { module } = makeModule();
            (module as any).config = {};
            expect(module.getDynamicPorts().map((p) => p.id)).toEqual(['input-0', 'mpegts-out']);
        });
    });

    describe('buildPipeline', () => {
        it('returns null + warning when no inputs are connected', () => {
            const { module } = makeModule({ sources: [] });
            (module as any).config = { inputs: [{}] };
            expect(module.buildPipeline((module as any).config)).toBeNull();
            expect((module as any).setHealth).toHaveBeenCalledWith(
                'warning',
                expect.stringContaining('No inputs'),
            );
        });

        it('produces one branch per connected input and outputs on the assigned bus channel', () => {
            const { module, assignBusChannel } = makeModule({
                sources: [
                    { sinkPortId: 'input-0', port: 40001 },
                    { sinkPortId: 'input-1', port: 40002 },
                ],
            });
            (module as any).config = { inputs: [{}, {}], alignment: 7 };
            const desc = module.buildPipeline((module as any).config)!;
            expect(desc.pipeline).toContain('mpegtsmux name=mux');
            expect(desc.pipeline).toContain('tee name=busout_41000 allow-not-linked=true');
            expect(desc.pipeline).toContain('socket-path=/tmp/mr-bus-40001-edge.sock');
            expect(desc.pipeline).toContain('socket-path=/tmp/mr-bus-40002-edge.sock');
            expect(desc.pipeline.match(/tsdemux latency=0 name=demux_/g)).toHaveLength(2);
            expect(hookInputs(desc)).toHaveLength(2);
            expect(desc.runnerHooks![0].module).toBe('mux_routing');
            expect(assignBusChannel).toHaveBeenCalledWith('mux-1');
            expect((module as any).setStatusData).toHaveBeenCalledWith('inputs', {
                connected: 2,
                streams: 0,
                mode: 'generic',
            });
        });

        it('a legacy config builds on its legacy ports and reports the mode', () => {
            const { module } = makeModule({
                sources: [
                    { sinkPortId: 'video-0', port: 40001 },
                    { sinkPortId: 'audio-0', port: 40002 },
                ],
            });
            (module as any).config = { videoStreams: [{}], audioStreams: [{}], alignment: 7 };
            const desc = module.buildPipeline((module as any).config)!;
            expect(hookInputs(desc)).toHaveLength(2);
            expect(hookInputs(desc)[0].routes.audio!.padName).toBe('sink_320');
            expect(hookInputs(desc)[1].routes.video!.padName).toBe('sink_256');
            expect((module as any).setStatusData).toHaveBeenCalledWith('inputs', {
                connected: 2,
                streams: 0,
                mode: 'legacy video/audio ports',
            });
        });

        it('asks the runner to anchor every branch to the producers stamps and hands it one stall watch per input', () => {
            const { module } = makeModule({
                sources: [
                    { sinkPortId: 'input-0', port: 40001 },
                    { sinkPortId: 'input-1', port: 40002 },
                ],
            });
            (module as any).config = { alignment: 7, inputs: [{}, {}] };
            const desc = module.buildPipeline((module as any).config)!;
            expect(desc.alignBranchesToStamps).toEqual({ demuxes: ['demux_0', 'demux_1'] });
            expect(desc.inputStallWatch).toEqual([
                { element: 'busin_0', timeoutMs: 5000 },
                { element: 'busin_1', timeoutMs: 5000 },
            ]);
            expect(desc.pipeline).not.toContain('watchdog');
        });

        it('declares the input arrays (generic and legacy) as live-updatable, so a legacy rename stays live', () => {
            const { module } = makeModule();
            expect(module.getLiveUpdatableParams()).toEqual([
                'inputs',
                'videoStreams',
                'audioStreams',
            ]);
        });

        it('isLiveChange: rename is live; add/remove, offset or language edits are not', () => {
            const { module } = makeModule();
            expect(module.isLiveChange('inputs', [{ name: 'B' }], [{ name: 'A' }])).toBe(true);
            expect(module.isLiveChange('inputs', [{}, {}], [{}])).toBe(false);
            expect(module.isLiveChange('inputs', [{}], undefined)).toBe(false);
            expect(
                module.isLiveChange('inputs', [{ name: 'ENG', offsetMs: -700 }], [{ name: 'ENG' }]),
            ).toBe(false);
            expect(
                module.isLiveChange(
                    'inputs',
                    [{ name: 'ENG', language: 'eng' }],
                    [{ name: 'ENG' }],
                ),
            ).toBe(false);
            expect(
                module.isLiveChange(
                    'inputs',
                    [{ name: 'NOR', offsetMs: -700, language: 'eng' }],
                    [{ name: 'ENG', offsetMs: -700, language: 'eng' }],
                ),
            ).toBe(true);
            expect(module.isLiveChange('bufferMs', 100, 50)).toBe(true);
        });

        it('threads the input entry offsetMs and language into that input audio route', () => {
            const { module } = makeModule({
                sources: [
                    { sinkPortId: 'input-0', port: 40001 },
                    { sinkPortId: 'input-1', port: 40002 },
                ],
            });
            (module as any).config = {
                inputs: [{ name: '' }, { name: 'DE', offsetMs: -700, language: 'deu' }],
                alignment: 7,
            };
            const desc = module.buildPipeline((module as any).config)!;
            const [r0, r1] = hookInputs(desc).map((r) => r.routes);
            expect('padOffsetNs' in r0.audio!).toBe(false);
            expect(r1.audio!.padOffsetNs).toBe(-700_000_000);
            expect(r1.audio!.branch).toContain('taginject name=lang_demux_1_audio tags=language-code=deu');
            expect(r1.video!.branch).not.toContain('taginject');
        });

        it('exposes name/language/offsetMs on inputs items, no legacy lists and no carousel toggle in the schema', () => {
            const schema = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
                .mediaRouter.configSchema.properties;
            expect(schema.inputs).toMatchObject({
                type: 'array',
                maxItems: 16,
                'x-liveUpdatable': true,
            });
            expect(schema.inputs.items.properties.name).toMatchObject({ type: 'string' });
            expect(schema.inputs.items.properties.language).toMatchObject({
                type: 'string',
                default: '',
            });
            expect(schema.inputs.items.properties.offsetMs).toMatchObject({
                type: 'number',
                default: 0,
                minimum: -2000,
                maximum: 2000,
            });
            expect(schema.videoStreams).toBeUndefined();
            expect(schema.audioStreams).toBeUndefined();
            expect(schema.emitStreamInfo).toBeUndefined();
        });

        it('ignores connections that arrive on unknown port ids (e.g. the output)', () => {
            const { module } = makeModule({
                sources: [
                    { sinkPortId: 'input-0', port: 40001 },
                    { sinkPortId: 'mpegts-out', port: 40005 },
                ],
            });
            (module as any).config = { inputs: [{}] };
            const desc = module.buildPipeline((module as any).config)!;
            expect(desc.pipeline.match(/tsdemux latency=0 name=demux_/g)).toHaveLength(1);
        });
    });

    describe('stream discovery → status', () => {
        it('counts the streams routed per (demux, class) once each — later same-class pads were sunk', () => {
            const { module } = makeModule({
                sources: [
                    { sinkPortId: 'input-0', port: 40001 },
                    { sinkPortId: 'input-1', port: 40002 },
                ],
            });
            (module as any).config = { inputs: [{}, {}], alignment: 7 };
            module.buildPipeline((module as any).config);
            const ev = (demux: string, media: string, outPid: number, caps: string) =>
                (module as any).onPluginEvent('mux:routed', { demux, media, outPid, srcPid: 1, caps });
            ev('demux_0', 'video', 0x100, 'video/x-h264, stream-format=(string)byte-stream');
            ev('demux_1', 'klv', 0x108, 'meta/x-klv, parsed=(boolean)true');
            ev('demux_1', 'klv', 0x108, 'meta/x-klv, parsed=(boolean)true'); // duplicate report
            (module as any).onPluginEvent('stream:discovered', { from: 'demux_1', caps: 'x' }); // ignored
            expect((module as any).setStatusData).toHaveBeenLastCalledWith('inputs', {
                connected: 2,
                streams: 2,
                mode: 'generic',
            });
        });
    });
});

describe('operator PID (one PID per input) + duplicate checking', () => {
    const output = { port: 40010 };

    it('reads pid; 0, blank, malformed or outside the ES range = automatic', () => {
        expect(inputEntries({ inputs: [{ pid: 0x200 }] })[0].pid).toBe(0x200);
        expect(inputEntries({ inputs: [{ pid: 0 }] })[0].pid).toBeUndefined();
        expect(inputEntries({ inputs: [{ pid: '' }] })[0].pid).toBeUndefined();
        expect(inputEntries({ inputs: [{ pid: 'x' }] })[0].pid).toBeUndefined();
        expect(inputEntries({ inputs: [{ pid: 0x1f }] })[0].pid).toBeUndefined(); // below ES range
        expect(inputEntries({ inputs: [{ pid: 0x1fff }] })[0].pid).toBeUndefined(); // null packet
        expect(inputEntries({ inputs: [{ pid: 0x1ffe }] })[0].pid).toBe(0x1ffe);
        expect(inputEntries({ inputs: [{ pid: '300' }] })[0].pid).toBe(300);
        expect(inputEntries({ inputs: [{ pid: 300.5 }] })[0].pid).toBeUndefined();
    });

    it('a set PID is the input PID: the hook input carries it, the prog-map and PCR seed name it, no class offsets anywhere', () => {
        const result = buildPipeline({
            sources: [{ sinkPortId: 'input-0', port: 40001, pid: 0x200 }],
            output,
            alignment: 7,
        })!;
        const rule = result.routing.inputs[0];
        expect(rule.pid).toBe(0x200);
        expect(Object.keys(rule.routes).sort()).toEqual(['audio', 'klv', 'subtitle', 'video']);
        for (const route of Object.values(rule.routes)) expect('padName' in route!).toBe(false);
        expect(result.pipeline).toContain('prog-map="program_map,sink_512=(int)1,PCR_1=sink_512"');
        expect(result.pipeline).not.toContain('sink_513');
        expect(result.slots).toEqual([
            { sinkPortId: 'input-0', demux: 'demux_0', pid: 0x200, automatic: false },
        ]);
    });

    it('two inputs on the same PID is a build error naming both inputs; adjacent PIDs are fine', () => {
        expect(() =>
            buildPipeline({
                sources: [
                    { sinkPortId: 'input-0', port: 40001, pid: 0x200 },
                    { sinkPortId: 'input-1', port: 40002, pid: 0x200 },
                ],
                output,
                alignment: 7,
            }),
        ).toThrow(MuxerPidConflictError);
        try {
            buildPipeline({
                sources: [
                    { sinkPortId: 'input-0', port: 40001, pid: 0x200 },
                    { sinkPortId: 'input-1', port: 40002, pid: 0x200 },
                ],
                output,
                alignment: 7,
            });
            throw new Error('did not throw');
        } catch (err) {
            expect((err as MuxerPidConflictError).conflicts).toEqual([
                'PID 0x200 is set on input-0 and input-1',
            ]);
        }
        // No blocks any more: 0x200 and 0x201 are two inputs, no clash.
        expect(() =>
            buildPipeline({
                sources: [
                    { sinkPortId: 'input-0', port: 40001, pid: 0x200 },
                    { sinkPortId: 'input-1', port: 40002, pid: 0x201 },
                ],
                output,
                alignment: 7,
            }),
        ).not.toThrow();
    });

    it('an automatic input skips a PID another input has set — a set value never collides with an automatic one', () => {
        const result = buildPipeline({
            sources: [
                { sinkPortId: 'input-0', port: 40001, pid: 0x100 },
                { sinkPortId: 'input-1', port: 40002 },
            ],
            output,
            alignment: 7,
        })!;
        expect(result.routing.inputs[1].pid).toBe(0x108);
    });

    it('the reserved PMT PID 0x1000 is refused', () => {
        expect(() =>
            buildPipeline({
                sources: [{ sinkPortId: 'input-0', port: 40001, pid: 0x1000 }],
                output,
                alignment: 7,
            }),
        ).toThrow(/PID 0x1000 is mpegtsmux's PMT/);
    });

    it("the metadata PID 0x1f0 (older muxers' carousel, dropped downstream) is refused; its neighbours are not", () => {
        expect(() =>
            buildPipeline({
                sources: [{ sinkPortId: 'input-0', port: 40001, pid: 0x1f0 }],
                output,
                alignment: 7,
            }),
        ).toThrow(/PID 0x1f0 is the metadata PID/);
        expect(configPidConflicts(inputEntries({ inputs: [{ pid: 0x1f0 }] }))).toHaveLength(1);
        expect(configPidConflicts(inputEntries({ inputs: [{ pid: 0x1ed }] }))).toEqual([]);
        // Automatic PIDs step over it (16 inputs: 0x100..0x178).
        expect(
            configPidConflicts(inputEntries({ inputs: Array.from({ length: 16 }, () => ({})) })),
        ).toEqual([]);
    });

    it('automatic PIDs never conflict with each other (16 inputs)', () => {
        const sources = Array.from({ length: 16 }, (_, i) => ({
            sinkPortId: `input-${i}`,
            port: 40001 + i,
        }));
        expect(() => buildPipeline({ sources, output, alignment: 7 })).not.toThrow();
        expect(findPidConflicts(buildPipeline({ sources, output, alignment: 7 })!.slots)).toEqual(
            [],
        );
    });

    it('configPidConflicts checks every CONFIGURED input, wired or not — only genuine duplicates', () => {
        expect(configPidConflicts(inputEntries({ inputs: [{ pid: 0x200 }, {}, { pid: 0x200 }] }))).toEqual([
            'PID 0x200 is set on input-0 and input-2',
        ]);
        // An operator value on an automatic PID is not a clash: the automatic input moves on.
        expect(configPidConflicts(inputEntries({ inputs: [{}, { pid: 0x100 }, { pid: 0x200 }] }))).toEqual([]);
    });

    it('assignInputPids keeps set values and fills blanks with the next free PID, in order', () => {
        const entries = inputEntries({ inputs: [{}, { pid: 0x300 }, {}, { pid: 0x108 }] });
        expect(assignInputPids(entries)).toEqual([0x100, 0x300, 0x110, 0x108]);
    });

    describe('module', () => {
        function makeModule(sources: Array<{ sinkPortId: string; port: number }>) {
            const module = new MpegTsMuxerModule();
            (module as any).services = {
                instanceId: 'mux-1',
                mediaRouter: {
                    getModuleBusSources: () =>
                        sources.map((s) => ({
                            port: s.port,
                            connectionId: 'c',
                            sourceModuleId: 'enc',
                            sourcePortId: 'mpegts-out',
                            sinkPortId: s.sinkPortId,
                        })),
                    assignBusChannel: () => ({ port: 41000 }),
                },
            };
            const setHealth = vi.fn();
            const emitConfigUpdate = vi.fn();
            (module as any).setHealth = setHealth;
            (module as any).setStatusData = vi.fn();
            (module as any).emitConfigUpdate = emitConfigUpdate;
            return { module, setHealth, emitConfigUpdate };
        }

        it('writes the automatic PID back into every blank pid field so the form shows the value in use', () => {
            const { module, emitConfigUpdate } = makeModule([
                { sinkPortId: 'input-0', port: 40001 },
            ]);
            (module as any).config = {
                inputs: [{ name: 'Cam' }, { name: 'Mix', pid: 0x300 }, { language: 'eng' }],
                alignment: 7,
            };
            module.buildPipeline((module as any).config);
            expect(emitConfigUpdate).toHaveBeenCalledTimes(1);
            expect(emitConfigUpdate).toHaveBeenCalledWith({
                inputs: [
                    { name: 'Cam', pid: 0x100, key: 0 },
                    { name: 'Mix', pid: 0x300, key: 1 }, // pid already explicit — only the key is seeded
                    { language: 'eng', pid: 0x108, key: 2 }, // next free after 0x100
                ],
            });
        });

        it('does not write back when every pid is already explicit, nor for legacy configs', () => {
            const { module, emitConfigUpdate } = makeModule([
                { sinkPortId: 'input-0', port: 40001 },
            ]);
            (module as any).config = { inputs: [{ pid: 0x100, key: 0 }], alignment: 7 };
            module.buildPipeline((module as any).config);
            expect(emitConfigUpdate).not.toHaveBeenCalled();
            const legacy = makeModule([{ sinkPortId: 'video-0', port: 40001 }]);
            (legacy.module as any).config = { videoStreams: [{}], alignment: 7 };
            legacy.module.buildPipeline((legacy.module as any).config);
            expect(legacy.emitConfigUpdate).not.toHaveBeenCalled();
        });

        it('seeds even before any input is wired (the field shows the PID as soon as the muxer runs)', () => {
            const { module, emitConfigUpdate } = makeModule([]);
            (module as any).config = { inputs: [{}, {}], alignment: 7 };
            expect(module.buildPipeline((module as any).config)).toBeNull();
            expect(emitConfigUpdate).toHaveBeenCalledWith({
                inputs: [{ key: 0, pid: 0x100 }, { key: 1, pid: 0x108 }],
            });
        });

        it('muxes a freshly added input on the PID it writes back — even when an earlier, unconnected input holds a lower PID', () => {
            // input-0 (pid 256) is configured but NOT wired; input-1 is blank and wired.
            const { module, emitConfigUpdate } = makeModule([{ sinkPortId: 'input-1', port: 40002 }]);
            (module as any).config = { inputs: [{ pid: 0x100, key: 0 }, {}], alignment: 7 };
            const desc = module.buildPipeline((module as any).config)!;
            expect(emitConfigUpdate).toHaveBeenCalledWith({
                inputs: [{ pid: 0x100, key: 0 }, { key: 1, pid: 0x108 }],
            });
            // The wire follows the field: 0x108, not the lowest free PID among wired sources.
            expect(hookInputs(desc)[0].pid).toBe(0x108);
            expect(desc.pipeline).toContain('sink_264=(int)1');
        });

        it('seeds keys at onInit too — before any build, so a removal before the first start is safe', async () => {
            const { module, emitConfigUpdate } = makeModule([]);
            await module.onInit({ inputs: [{ name: 'A' }, { name: 'B', key: 4 }], alignment: 7 });
            expect(emitConfigUpdate).toHaveBeenCalledWith({
                inputs: [{ name: 'A', key: 0, pid: 0x100 }, { name: 'B', key: 4, pid: 0x108 }],
            });
            // Legacy configs are left alone.
            const legacy = makeModule([]);
            await legacy.module.onInit({ videoStreams: [{}], alignment: 7 });
            expect(legacy.emitConfigUpdate).not.toHaveBeenCalled();
        });

        it('isLiveChange: the key seed is live; a removed entry (shorter list) is not', () => {
            const { module } = makeModule([]);
            expect(module.isLiveChange('inputs', [{ key: 0, pid: 0x100 }], [{ pid: 0x100 }])).toBe(true);
            expect(module.isLiveChange('inputs', [{ key: 0 }, { key: 2 }], [{ key: 0 }, { key: 1 }, { key: 2 }])).toBe(false);
        });

        it('refuses to start with a health error when configured PIDs clash — even before the second input is wired', () => {
            const { module, setHealth, emitConfigUpdate } = makeModule([
                { sinkPortId: 'input-0', port: 40001 },
            ]);
            (module as any).config = { inputs: [{ pid: 0x200 }, { pid: 0x200 }], alignment: 7 };
            expect(module.buildPipeline((module as any).config)).toBeNull();
            expect(setHealth).toHaveBeenCalledWith(
                'error',
                'PID conflict — PID 0x200 is set on input-0 and input-1',
            );
            expect(emitConfigUpdate).not.toHaveBeenCalled();
        });

        it('threads the set PID from config into the hook input when it is clean', () => {
            const { module, setHealth } = makeModule([{ sinkPortId: 'input-0', port: 40001 }]);
            (module as any).config = { inputs: [{ pid: 0x150 }], alignment: 7 };
            const desc = module.buildPipeline((module as any).config)!;
            expect(hookInputs(desc)[0].pid).toBe(0x150);
            expect(setHealth).not.toHaveBeenCalledWith('error', expect.anything());
        });

        it('isLiveChange: the module seed (blank → automatic value) is live; any other PID edit is not', () => {
            const { module } = makeModule([]);
            // Seed for index 0 (0x100) and index 1 (0x108): no restart.
            expect(
                module.isLiveChange('inputs', [{ pid: 0x100 }, { pid: 0x108 }], [{}, { pid: 0 }]),
            ).toBe(true);
            // A real edit restarts — the route is built at pad-link time.
            expect(
                module.isLiveChange('inputs', [{ name: 'A', pid: 0x200 }], [{ name: 'A' }]),
            ).toBe(false);
            expect(module.isLiveChange('inputs', [{ pid: 0x300 }], [{ pid: 0x100 }])).toBe(false);
            // Rename with an unchanged explicit PID stays live.
            expect(
                module.isLiveChange(
                    'inputs',
                    [{ name: 'B', pid: 0x300 }],
                    [{ name: 'A', pid: 0x300 }],
                ),
            ).toBe(true);
        });

        it('exposes one pid field on inputs items with the schema bounds, and no per-class fields', () => {
            const props = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
                .mediaRouter.configSchema.properties.inputs.items.properties;
            expect(props.pid).toMatchObject({
                type: 'number',
                default: 0,
                minimum: 0,
                maximum: 8190,
            });
            for (const key of ['videoPid', 'audioPid', 'klvPid', 'subtitlePid']) {
                expect(props[key]).toBeUndefined();
            }
        });
    });
});
