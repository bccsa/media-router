import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The player's render target reads the host's DRM connectors: none here, so the build never
// depends on the box the suite runs on (a dev host without DRM).
vi.mock('@media-router/engine', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    listDrmConnectors: vi.fn(() => []),
    firstConnectedDisplay: vi.fn(() => undefined),
}));

import * as engine from '../index.js';
import { liveInputLaunchText } from './liveInputBranches.js';
import { LAT_IN_PREFIX } from './latenessTap.js';
import { WATCHED_QUEUE_NAMES } from './queueOverrun.js';
import { BUS_WATCHDOG_PREFIX } from './busHelpers.js';
import { INGEST_QUEUE_NAME } from './tsHelpers.js';
import { tsQueueByteCap } from './queueBounds.js';
import type { PipelineDescription } from './PluginModule.js';
import { Aes67InputModule } from '../../../../plugins/aes67-input/engine/Aes67InputModule.js';
import { Aes67OutputModule } from '../../../../plugins/aes67-output/engine/Aes67OutputModule.js';
import { AudioDecoderModule } from '../../../../plugins/audio-decoder/engine/AudioDecoderModule.js';
import { AudioDynamicsModule } from '../../../../plugins/audio-dynamics/engine/AudioDynamicsModule.js';
import { AudioEncoderModule } from '../../../../plugins/audio-encoder/engine/AudioEncoderModule.js';
import { AudioInput302mModule } from '../../../../plugins/audio-input-302m/engine/AudioInput302mModule.js';
import { AudioInputModule } from '../../../../plugins/audio-input/engine/AudioInputModule.js';
import { AudioMixerModule } from '../../../../plugins/audio-mixer/engine/AudioMixerModule.js';
import { AudioOutput302mModule } from '../../../../plugins/audio-output-302m/engine/AudioOutput302mModule.js';
import { AudioOutputModule } from '../../../../plugins/audio-output/engine/AudioOutputModule.js';
import { AudioProcessingModule } from '../../../../plugins/audio-processing/engine/AudioProcessingModule.js';
import { AudioTranscoderModule } from '../../../../plugins/audio-transcoder/engine/AudioTranscoderModule.js';
import { HlsPlayerModule } from '../../../../plugins/hls-player/engine/HlsPlayerModule.js';
import { MpegTsIpInputModule } from '../../../../plugins/mpegts-ip-input/engine/MpegTsIpInputModule.js';
import { MpegTsIpOutputModule } from '../../../../plugins/mpegts-ip-output/engine/MpegTsIpOutputModule.js';
import { MpegTsMuxerModule } from '../../../../plugins/mpegts-muxer/engine/MpegTsMuxerModule.js';
import { N1Mixer302mModule } from '../../../../plugins/n1-mixer-302m/engine/N1Mixer302mModule.js';
import { N1MixerModule } from '../../../../plugins/n1-mixer/engine/N1MixerModule.js';
import { RistInputModule } from '../../../../plugins/rist-input/engine/RistInputModule.js';
import { RistOutputModule } from '../../../../plugins/rist-output/engine/RistOutputModule.js';
import { SrtInputModule } from '../../../../plugins/srt-input/engine/SrtInputModule.js';
import { SrtOutputModule } from '../../../../plugins/srt-output/engine/SrtOutputModule.js';
import { TeletextSubtitlesModule } from '../../../../plugins/teletext-subtitles/engine/TeletextSubtitlesModule.js';
import { TranscoderModule } from '../../../../plugins/transcoder/engine/TranscoderModule.js';
import { TsSplitterModule } from '../../../../plugins/ts-splitter/engine/TsSplitterModule.js';
import { VideoEncoderModule } from '../../../../plugins/video-encoder/engine/VideoEncoderModule.js';
import { VideoPlayerModule } from '../../../../plugins/video-player/engine/VideoPlayerModule.js';

/**
 * The no-late-drop lint (house-clock WI-P4-13, B-173): every module's real launch strings, built
 * as the modules build them, hold the R10 checklist. Modules are plain objects here: the plugins'
 * engine types come from its dist, this file's from its source.
 */

// ---------------------------------------------------------------------------- the launch parser

interface El {
    factory: string;
    props: Map<string, string>;
    /** A `!` links it to the element before it. */
    linked: boolean;
}

function tokens(text: string): string[] {
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (const c of text) {
        if (c === '"') quoted = !quoted;
        // A bin's brackets stand alone (`( name=b … )`); in caps, `(string)` is a type.
        if (!quoted && (c === ' ' || c === '\n' || c === '\t' || c === '!')) {
            if (cur) out.push(cur);
            cur = '';
            if (c === '!') out.push(c);
            continue;
        }
        cur += c;
    }
    if (cur) out.push(cur);
    return out;
}

const PROP = /^([a-z][a-z0-9-]*)=(.*)$/s;
const PAD_REF = /^[A-Za-z_][\w-]*\.[\w%-]*$/;

/** gst-launch text as elements: a pad reference (`t.`) and a bin's brackets are elements too. */
function parseLaunch(text: string): El[] {
    const els: El[] = [];
    let link = false;
    for (const t of tokens(text)) {
        if (t === '!') {
            link = true;
            continue;
        }
        const prop = PROP.exec(t);
        if (prop && els.length > 0 && !link) {
            els[els.length - 1].props.set(prop[1], prop[2].replace(/^"(.*)"$/s, '$1'));
            continue;
        }
        const factory = PAD_REF.test(t) ? `ref:${t}` : t;
        els.push({ factory, props: new Map(), linked: link });
        link = false;
    }
    return els;
}

// ------------------------------------------------------------------------------------- the lint

/** A subject: one launch string of one module, as the runner gets it. */
interface Subject {
    module: string;
    text: string;
}

const PRESENTATION_SINKS = new Set([
    'waylandsink',
    'kmssink',
    'autovideosink',
    'glimagesink',
    'xvimagesink',
    'ximagesink',
    'fbdevsink',
    'pulsesink',
    'alsasink',
    'pipewiresink',
    'autoaudiosink',
]);
/** The sinks of the diagnostic taps, which carry no content to an output: the probes' appsink
 *  (the player's, teletext's, mpegts-ip-input's) and the player's resume tap. */
const DIAGNOSTIC_SINKS: ReadonlyArray<[string, string, string]> = [
    ['appsink', 'tsprobe', 'probe tap'],
    ['fakesink', 'resume_sink', 'resume tap'],
];
/** The bus ingress backstop's bounds (`buildBusSrc`, OQ-30). */
const BACKSTOP_NS = String(5000 * 1_000_000);
const BACKSTOP_BYTES = String(tsQueueByteCap(5000));
const LEAKY = new Set(['1', '2', 'upstream', 'downstream']);
/** The capture modules: their leaky queues sit before their mux, inside the ingest. */
const CAPTURE_MODULES = new Set(['video-encoder', 'audio-encoder']);

const diagnosticTap = (el: El | undefined): string | undefined =>
    el && DIAGNOSTIC_SINKS.find(([f, n]) => el.factory === f && el.props.get('name') === n)?.[2];

/** The whitelist: a leaky queue's fate in the R10 checklist, or null (a failure). */
function leakyFate(module: string, els: El[], i: number): string | null {
    const q = els[i].props;
    const prev = els[i].linked ? els[i - 1] : undefined;
    const next = els[i + 1]?.linked ? els[i + 1] : undefined;
    const tap = diagnosticTap(next);
    if (tap) return tap;
    if (q.get('name') === INGEST_QUEUE_NAME) return 'ingest queue';
    const busHead =
        prev &&
        (prev.factory === 'unixfdsrc' ||
            (prev.factory === 'watchdog' &&
                prev.props.get('name')?.startsWith(BUS_WATCHDOG_PREFIX)) ||
            (prev.factory === 'mrlateness' && prev.props.get('name')?.startsWith(LAT_IN_PREFIX)));
    if (
        busHead &&
        q.get('max-size-time') === BACKSTOP_NS &&
        q.get('max-size-bytes') === BACKSTOP_BYTES
    ) {
        return 'bus ingress backstop';
    }
    if (CAPTURE_MODULES.has(module)) {
        for (let j = i + 1; j < els.length && els[j].linked; j++) {
            if (els[j].factory === 'mpegtsmux') return 'capture queue';
        }
    }
    return null;
}

interface Finding {
    module: string;
    element: string;
    rule: string;
}

/** Every element of `s` that breaks a rule. `fates` collects the whitelisted leaky queues. */
function lint(s: Subject, fates?: Map<string, Set<string>>): Finding[] {
    const els = parseLaunch(s.text);
    const found: Finding[] = [];
    const fail = (el: El, rule: string) =>
        found.push({
            module: s.module,
            element: `${el.factory} ${el.props.get('name') ?? ''}`,
            rule,
        });
    els.forEach((el, i) => {
        const p = el.props;
        const leaky = p.get('leaky');
        if (el.factory === 'queue' && leaky !== undefined && LEAKY.has(leaky)) {
            const fate = leakyFate(s.module, els, i);
            if (fate === null) fail(el, `leaky=${leaky} outside the whitelist`);
            else fates?.set(fate, (fates.get(fate) ?? new Set()).add(s.module));
        }
        const watched =
            el.factory === 'queue' &&
            ((leaky !== undefined && leaky !== '0' && leaky !== 'no') ||
                WATCHED_QUEUE_NAMES.includes(p.get('name') ?? ''));
        if (watched && p.get('silent') === 'true') fail(el, 'silent=true on a watched queue');
        if (p.has('max-lateness') && p.get('max-lateness') !== '-1') {
            fail(el, `max-lateness=${p.get('max-lateness')}`);
        }
        if (p.get('qos') === 'true') fail(el, 'qos=true');
        const aes67Sink = s.module === 'aes67-output' && el.props.get('name') === 'netsink';
        if (el.factory.endsWith('sink') && !aes67Sink) {
            if (p.get('sync') === 'true') fail(el, 'sync=true');
            if (PRESENTATION_SINKS.has(el.factory) && p.get('sync') !== 'false') {
                fail(el, 'a presentation sink without sync=false');
            }
            if (p.has('ts-offset')) fail(el, 'ts-offset on a sink');
            if (el.factory === 'appsink' && p.get('drop') === 'true' && !diagnosticTap(el)) {
                fail(el, 'drop=true on an appsink carrying content');
            }
        }
    });
    return found;
}

// ------------------------------------------------------------------------------------ the modules

interface Source {
    port: number;
    connectionId: string;
    sourceModuleId: string;
    sourcePortId: string;
    sinkPortId: string;
    streamType: string;
    socketPath: string;
}

function source(i: number, sinkPortId: string, streamType = 'muxed/mpegts'): Source {
    return {
        port: 40100 + i,
        connectionId: `c-${i}`,
        sourceModuleId: `src-${i}`,
        sourcePortId: 'out',
        sinkPortId,
        streamType,
        socketPath: `/tmp/mr-bus-${40100 + i}-x.sock`,
    };
}

/** A module on a fake router: its wired sources, a bus channel per output port. */
function wire(module: object, instanceId: string, sources: Source[] = [], extra: object = {}) {
    let next = 41000;
    const channels = new Map<string, { port: number }>();
    const channel = (_id: string, portId = 'out') => {
        if (!channels.has(portId)) channels.set(portId, { port: next++ });
        return channels.get(portId)!;
    };
    const m = module as Record<string, unknown>;
    m.services = {
        instanceId,
        mediaRouter: {
            getModuleBusSource: (_id: string, portId?: string) =>
                sources.find((s) => portId === undefined || s.sinkPortId === portId),
            getModuleBusSources: (_id: string, portId?: string) =>
                sources.filter((s) => portId === undefined || s.sinkPortId === portId),
            assignBusChannel: channel,
            getBusChannel: channel,
            hasStoredConnection: () => false,
            getPortConnectionCount: () => sources.length,
            onProducerPlaying: () => undefined,
            moduleName: () => instanceId,
        },
        ...extra,
    };
    m.config = {};
    m.log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
    for (const f of [
        'setHealth',
        'setStatusData',
        'setBadge',
        'clearBadge',
        'setDynamicSections',
        'emitConfigUpdate',
    ]) {
        m[f] = vi.fn();
    }
    m.setElementProperty = vi.fn(async () => undefined);
    return module as { buildPipeline(config: Record<string, unknown>): PipelineDescription | null };
}

/** Every launch string of a description: the pipeline, its live inputs, its pad-added branches. */
function texts(module: string, desc: PipelineDescription | null): Subject[] {
    if (!desc) return [{ module, text: '' }];
    const d = desc;
    return [
        d.pipeline,
        ...(d.liveInputs ?? []).map((b, i) => liveInputLaunchText(b, i)),
        ...(d.linkOnPadAdded ?? []).flatMap((r) => r.branches),
    ].map((text) => ({ module, text }));
}

const ts = (i: number, port = 'mpegts-in') => source(i, port);

/** audio-processing resolves its chain at start: the stages, a LADSPA element named for it. */
async function resolveApStages(ap: Record<string, unknown>, mode: string): Promise<unknown> {
    (ap as { resolveLadspa: (s: string) => Promise<string> }).resolveLadspa = async (sfx) =>
        `ladspa-lsp-plugins-ladspa-so-${sfx}`;
    const superStart = vi.spyOn(engine.GstPluginBase.prototype, 'onStart').mockResolvedValue();
    try {
        await (ap as { onStart(): Promise<void> }).onStart();
    } finally {
        superStart.mockRestore();
    }
    expect(ap.stages, `audio-processing ${mode} resolves its stages`).toBeTruthy();
    return ap.stages;
}
const s302m = (i: number, port = 'audio-in') => source(i, port, 'audio/302m');

/** The output and processing modules, then the ingests, as each builds its pipeline. */
let built: Promise<Subject[]> | undefined;
/** Built once: the video-encoder's device probe runs a child each build. */
const subjects = (): Promise<Subject[]> => (built ??= buildSubjects());

async function buildSubjects(): Promise<Subject[]> {
    TranscoderModule.setAvailableImpls({
        h264: ['software'],
        h265: ['software'],
        av1: ['software'],
    });
    VideoEncoderModule.setAvailableImpls({ h264: ['v4l2', 'software'], h265: [], av1: [] });
    AudioMixerModule.setS302mSupported(true);
    AudioProcessingModule.setS302mSupported(true);
    const out: Subject[] = [];
    const add = (module: string, desc: PipelineDescription | null) =>
        out.push(...texts(module, desc));

    // Outputs. The player on each sink form (Weston, KMS, auto), live and on its card.
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'nolatedrop-'));
    fs.writeFileSync(path.join(runtime, 'wayland-0'), '');
    vi.stubEnv('XDG_RUNTIME_DIR', runtime);
    try {
        for (const sinks of [
            { wayland: true, kms: true },
            { wayland: false, kms: true },
            { wayland: false, kms: false },
        ]) {
            VideoPlayerModule.setSinkAvailability(sinks);
            add('video-player', wire(new VideoPlayerModule(), 'vp', [ts(0)]).buildPipeline({}));
            add('video-player', wire(new VideoPlayerModule(), 'vp0').buildPipeline({}));
            // Its source silent: the card, with the resume tap on the edge socket.
            const silent = { ...ts(0), socketPath: path.join(runtime, 'edge.sock') };
            fs.writeFileSync(silent.socketPath, '');
            const vp = wire(new VideoPlayerModule(), 'vp1', [silent]);
            (vp as unknown as { busStallDetected: boolean }).busStallDetected = true;
            add('video-player', vp.buildPipeline({}));
        }
    } finally {
        vi.unstubAllEnvs();
        fs.rmSync(runtime, { recursive: true, force: true });
    }
    const dec = wire(new AudioDecoderModule(), 'dec', [ts(1)]);
    Object.defineProperty(dec, 'pwNodeName', { value: 'MR_PW_dec', configurable: true });
    add('audio-decoder', dec.buildPipeline({}));
    for (const n of [1, 2]) {
        const aout = wire(
            new AudioOutput302mModule(),
            `aout${n}`,
            Array.from({ length: n }, (_, i) => s302m(10 + i)),
        );
        (aout as unknown as { deviceChannels: number }).deviceChannels = 2;
        add('audio-output-302m', aout.buildPipeline({ device: 'alsa_output.usb-foo' }));
    }
    const aes = wire(new Aes67OutputModule(), 'aes', [s302m(20, 'in')]);
    add('aes67-output', aes.buildPipeline({ address: '192.0.2.10', port: 5004 }));
    add('audio-output', wire(new AudioOutputModule(), 'ao').buildPipeline({ channels: 2 }));
    add('srt-output', wire(new SrtOutputModule(), 'srto', [ts(30)]).buildPipeline({ port: 9000 }));
    add(
        'rist-output',
        wire(new RistOutputModule(), 'risto', [ts(31)]).buildPipeline({ address: '192.0.2.1' }),
    );
    for (const encapsulation of ['raw', 'rtp']) {
        add(
            'mpegts-ip-output',
            wire(new MpegTsIpOutputModule(), 'ipo', [ts(32)]).buildPipeline({
                encapsulation,
                destinations: [
                    { host: '192.0.2.2', port: 5000 },
                    { host: '198.51.100.2', port: 5000 },
                ],
            }),
        );
    }

    // Processing.
    // The transcoder with and without a burn-in source.
    for (const inputs of [[ts(40)], [ts(40), ts(46, 'subtitles-in')]]) {
        add(
            'transcoder',
            wire(new TranscoderModule(), 'tc', inputs).buildPipeline({
                renditions: [
                    { width: 1920, height: 1080, bitrate: 5000 },
                    { width: 1280, height: 720, bitrate: 2500 },
                ],
            }),
        );
    }
    AudioTranscoderModule.setS302mSupported(true);
    add(
        'audio-transcoder',
        wire(new AudioTranscoderModule(), 'atc', [ts(41)]).buildPipeline({
            renditions: [{ codec: 'opus' }, { codec: 'aac' }, { codec: 'pcm' }],
        }),
    );
    add(
        'mpegts-muxer',
        wire(new MpegTsMuxerModule(), 'mux', [ts(42, 'input-0'), ts(43, 'input-1')]).buildPipeline({
            inputs: [{}, {}],
        }),
    );
    add(
        'teletext-subtitles',
        wire(new TeletextSubtitlesModule(), 'ttx', [ts(45)]).buildPipeline({}),
    );
    add(
        'audio-mixer',
        wire(new AudioMixerModule(), 'amix', [s302m(50), s302m(51)]).buildPipeline({ channels: 2 }),
    );
    N1Mixer302mModule.setS302mSupported(true);
    add(
        'n1-mixer-302m',
        wire(new N1Mixer302mModule(), 'n1s', [s302m(53, 'in-0'), s302m(54, 'in-1')]).buildPipeline({
            pairCount: 2,
        }),
    );
    for (const mode of ['none', 'ducker', 'compressor']) {
        const ap = wire(new AudioProcessingModule(), 'ap', [
            s302m(55, 'program-in'),
            s302m(56, 'sidechain-in'),
        ]) as unknown as Record<string, unknown> & {
            buildPipeline(c: object): PipelineDescription | null;
        };
        ap.config = { mode };
        ap.stages = await resolveApStages(ap, mode);
        add('audio-processing', ap.buildPipeline(ap.config as object));
    }
    for (const mode of ['ducker', 'compressor', 'gate']) {
        const dyn = wire(new AudioDynamicsModule(), 'dyn') as unknown as Record<string, unknown> & {
            buildPipeline(c: object): PipelineDescription | null;
        };
        dyn.config = { mode };
        dyn.dynElement = `ladspa-lsp-plugins-ladspa-so-${mode}`;
        add('audio-dynamics', dyn.buildPipeline({ mode }));
    }

    // Ingests.
    add('srt-input', wire(new SrtInputModule(), 'srti').buildPipeline({ port: 9001 }));
    add('rist-input', wire(new RistInputModule(), 'risti').buildPipeline({ port: 8000 }));
    add(
        'mpegts-ip-input',
        wire(new MpegTsIpInputModule(), 'ipi').buildPipeline({ address: '192.0.2.3', port: 5002 }),
    );
    add(
        'aes67-input',
        wire(new Aes67InputModule(), 'aesi').buildPipeline({ address: '239.0.0.1' }),
    );
    add('audio-input', wire(new AudioInputModule(), 'ain').buildPipeline({ device: 'mic' }));
    const ain302 = wire(new AudioInput302mModule(), 'ain302');
    (ain302 as unknown as { deviceChannels: number }).deviceChannels = 2;
    add('audio-input-302m', ain302.buildPipeline({ device: 'mic' }));
    const aenc = wire(new AudioEncoderModule(), 'aenc');
    Object.defineProperty(aenc, 'pwNodeName', { value: 'MR_PW_aenc', configurable: true });
    add('audio-encoder', aenc.buildPipeline({}));
    add(
        'video-encoder',
        wire(new VideoEncoderModule(), 'venc').buildPipeline({
            device: '/dev/video-nonexistent-for-test',
            codec: 'h264',
            encoderImpl: 'v4l2',
            resolution: '1920x1080',
            framerate: 30,
            bitrate: 4000,
        }),
    );
    return out;
}

afterEach(() => vi.restoreAllMocks());

/** Modules with no GStreamer launch string: N-1 Mixer (PipeWire only), HLS Player (its own
 *  fan-out sidecar), TS Splitter (the native mr-tssplit), Note. */
const NO_LAUNCH_STRING = ['n1-mixer', 'hls-player', 'ts-splitter', 'note'];

/** The R10 checklist's whitelisted leaky queues at this tree, each fate with its modules. */
const FATES: Record<string, string[]> = {
    'bus ingress backstop': [
        'aes67-output',
        'audio-decoder',
        'audio-mixer',
        'audio-output-302m',
        'audio-processing',
        'audio-transcoder',
        'mpegts-ip-output',
        'mpegts-muxer',
        'n1-mixer-302m',
        'rist-output',
        'srt-output',
        'teletext-subtitles',
        'transcoder',
        'video-player',
    ],
    'probe tap': ['mpegts-ip-input', 'teletext-subtitles', 'video-player'],
    'resume tap': ['video-player'],
    'ingest queue': ['rist-input', 'srt-input'],
    'capture queue': ['audio-encoder', 'video-encoder'],
};

const only = (all: Subject[], module: string, has: string): Subject => {
    const hit = all.filter((s) => s.module === module && s.text.includes(has));
    expect(hit.length, `${module}: a string with "${has}"`).toBeGreaterThan(0);
    return hit[0];
};
/** `s` with `from` replaced by `to`, which must change it. */
const plant = (s: Subject, from: string | RegExp, to: string): Subject => {
    const text = s.text.replace(from, to);
    expect(text, `planted ${to}`).not.toBe(s.text);
    return { module: s.module, text };
};
const rules = (s: Subject): string[] => lint(s).map((f) => `${f.element.trim()}: ${f.rule}`);

describe('the no-late-drop lint (WI-P4-13, B-173)', () => {
    it('every module builds, no launch string breaks a rule, and each leaky queue has its fate', async () => {
        const all = await subjects();
        expect(all.filter((s) => !s.text).map((s) => s.module)).toEqual([]);
        const fates = new Map<string, Set<string>>();
        expect(all.flatMap((s) => lint(s, fates))).toEqual([]);
        expect(Object.fromEntries([...fates].map(([f, m]) => [f, [...m].sort()]))).toEqual(FATES);
        // aes67-output's netsink is the one syncing sink and the one ts-offset (WI-P4-10).
        const syncing = all.filter((s) => /\bsync=true\b|\bts-offset=/.test(s.text));
        expect([...new Set(syncing.map((s) => s.module))]).toEqual(['aes67-output']);
    });

    it('covers every module: each builds above, or has no launch string', async () => {
        const root = path.resolve(__dirname, '../../../../plugins');
        const withModule = fs
            .readdirSync(root)
            .filter((d) => fs.existsSync(path.join(root, d, 'engine')))
            .filter((d) =>
                fs.readdirSync(path.join(root, d, 'engine')).some((f) => /Module\.ts$/.test(f)),
            );
        const names = new Set((await subjects()).map((s) => s.module));
        expect(withModule.filter((d) => !names.has(d)).sort()).toEqual(
            [...NO_LAUNCH_STRING].sort(),
        );
        for (const m of [new N1MixerModule(), new HlsPlayerModule(), new TsSplitterModule()]) {
            expect(wire(m, 'x', [ts(0)]).buildPipeline({})).toBeNull();
        }
    });

    it('fails a planted leaky=2 in a copy of the player string', async () => {
        const live = only(await subjects(), 'video-player', 'name=vp_esq leaky=0');
        expect(rules(plant(live, 'name=vp_esq leaky=0', 'name=vp_esq leaky=2'))).toEqual([
            'queue vp_esq: leaky=2 outside the whitelist',
        ]);
        expect(rules(plant(live, 'name=vp_esq leaky=0', 'name=vp_esq leaky=downstream'))).toEqual([
            'queue vp_esq: leaky=downstream outside the whitelist',
        ]);
        expect(
            rules(plant(live, 'name=vp_esq leaky=0', 'name=vp_esq silent=true leaky=0')),
        ).toEqual(['queue vp_esq: silent=true on a watched queue']);
    });

    it("fails a planted ts-offset on the audio-decoder's sink", async () => {
        const dec = only(await subjects(), 'audio-decoder', 'pulsesink name=sink');
        expect(
            rules(plant(dec, 'pulsesink name=sink', 'pulsesink name=sink ts-offset=60000000')),
        ).toEqual(['pulsesink sink: ts-offset on a sink']);
        expect(rules(plant(dec, /(pulsesink name=sink [^!]*)sync=false/, '$1'))).toEqual([
            'pulsesink sink: a presentation sink without sync=false',
        ]);
        expect(
            rules(plant(dec, 'pulsesink name=sink', 'pulsesink name=sink max-lateness=20000000')),
        ).toEqual(['pulsesink sink: max-lateness=20000000']);
    });

    it("fails the transcoder's old raw buffer and old decoder-pool queue", async () => {
        const tc = only(await subjects(), 'transcoder', 'avdec_h264');
        const oldRaw = plant(tc, /(avdec_h264 [^!]*! )queue leaky=0 /, '$1queue leaky=2 ');
        expect(rules(oldRaw)).toEqual(['queue: leaky=2 outside the whitelist']);
        const oldPool = plant(
            tc,
            /queue leaky=0 max-size-buffers=4 /g,
            'queue leaky=2 max-size-buffers=4 ',
        );
        expect(rules(oldPool)).toEqual([
            'queue: leaky=2 outside the whitelist',
            'queue: leaky=2 outside the whitelist',
        ]);
    });

    it('fails qos=true, sync=true on a display, drop=true on a content appsink and a resized backstop', async () => {
        const all = await subjects();
        const live = only(all, 'video-player', 'name=vp_esq');
        expect(rules(plant(live, /(name=sink [^!]*)qos=false/, '$1qos=true'))).toEqual([
            expect.stringMatching(/ sink: qos=true$/),
        ]);
        expect(rules(plant(live, /(name=sink [^!]*)sync=false/, '$1sync=true'))).toEqual(
            expect.arrayContaining([expect.stringMatching(/: sync=true$/)]),
        );
        expect(rules(plant(live, 'appsink name=tsprobe', 'appsink name=frames drop=true'))).toEqual(
            [
                'queue: leaky=downstream outside the whitelist',
                'appsink frames: drop=true on an appsink carrying content',
            ],
        );
        expect(rules(plant(live, 'max-size-time=5000000000', 'max-size-time=1000000000'))).toEqual([
            'queue: leaky=2 outside the whitelist',
        ]);
        // The aes67 exception is its netsink's, in its module only.
        const aes = only(all, 'aes67-output', 'name=netsink');
        expect(rules({ module: 'srt-output', text: aes.text })).toEqual([
            'udpsink netsink: sync=true',
            'udpsink netsink: ts-offset on a sink',
        ]);
    });

    it('buildLeakyQueue is gone, with its export (B-173)', () => {
        expect('buildLeakyQueue' in engine).toBe(false);
    });
});
