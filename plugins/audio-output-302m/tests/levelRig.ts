// B-214's level rig: the Audio Output (302M)'s own launch text in real GStreamer, each source's
// ingress a local 302M tone, pulsesink a level meter; shapes share one gst-launch under name
// prefixes. Which device port a stream channel reaches is PipeWire's.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveInputLaunchText, type ChannelMapEntry } from '@media-router/engine';
import { build302mEncodeBranch } from '@media-router/plugin-audio-302m-core';
import { AudioOutput302mModule } from '../engine/AudioOutput302mModule.js';

const PLUGINS = process.env.MR_PLUGINS_DIR ?? join(__dirname, '../..');
const NATIVE = [
    join(PLUGINS, 'mpegts-core/native/mrtshouse/libgstmrtshouse.so'),
    join(PLUGINS, 'mpegts-core/native/mrlateness/libgstmrlateness.so'),
];
const ELEMENTS = [
    'audiotestsrc',
    'audioconvert',
    'audiomixer',
    'capssetter',
    'level',
    'volume',
    'identity',
    'fakesink',
    'avenc_s302m',
    'avdec_s302m',
    'mpegtsmux',
];

/** Never the user's registry: the gate's own, or one of this run's. */
export const REGISTRY =
    process.env.GST_REGISTRY ?? join(tmpdir(), `mr-c35-registry-${process.pid}.bin`);

/** Drop this run's own registry (never the gate's). */
export function removeRigRegistry(): void {
    if (!process.env.GST_REGISTRY_KEEP && REGISTRY.includes('mr-c35-registry-')) {
        rmSync(REGISTRY, { force: true });
    }
}

/** Why the rig cannot run here (null: it can). */
export function levelRigSkip(): string | null {
    if (spawnSync('sh', ['-c', 'command -v gst-launch-1.0']).status !== 0) {
        return 'gst-launch-1.0 not installed';
    }
    const missing = NATIVE.filter((f) => !existsSync(f));
    if (missing.length) return `not built: ${missing.join(', ')}`;
    const env = { ...process.env, GST_REGISTRY: REGISTRY };
    const absent = ELEMENTS.filter(
        (el) =>
            spawnSync('gst-inspect-1.0', [el], { env, stdio: 'ignore', timeout: 120_000 })
                .status !== 0,
    );
    return absent.length ? `GStreamer elements missing: ${absent.join(', ')}` : null;
}

/** A tone at `AMP`, `gains[c]` on wire channel c. A stereo wire is encoded and decoded for real;
 *  a 4/6/8 wire comes as `avdec_s302m`'s own output, in the layout it gives (the dev Pi's
 *  encoder takes stereo only): quad, 5.1, and unpositioned at 8. */
export interface ToneSource {
    wire: 2 | 4 | 6 | 8;
    gains: number[];
    freq: number;
    map?: ChannelMapEntry[];
}

export interface Shape {
    channels: number;
    firstChannel: number;
    deviceChannels: number | null;
    sources: ToneSource[];
}

export const AMP = 0.25;
const AVDEC_MASK: Record<number, string> = { 2: '0x3', 4: '0x33', 6: '0x3f', 8: '0x0' };

/** The module's launch text for `shape` (null: it refuses the shape), rigged and prefixed. */
export function shapeLaunch(shape: Shape, prefix: string): string | null {
    const module = new AudioOutput302mModule() as any;
    const sources = shape.sources.map((s, i) => ({
        port: 40100 + i,
        connectionId: `c-${i}`,
        sourceModuleId: `src-${i}`,
        sourcePortId: 'out-0',
        sinkPortId: 'audio-in',
        streamType: 'audio/302m',
        socketPath: `/tmp/mr-c35-${i}.sock`,
        sourceChannels: s.wire,
        ...(s.map ? { channelMap: s.map } : {}),
    }));
    module.services = {
        instanceId: 'aout',
        mediaRouter: {
            getModuleBusSources: () => sources,
            getRoutePlayoutOffsetMs: () => undefined,
        },
    };
    module.config = {};
    module.deviceChannels = shape.deviceChannels;
    module.setHealth = () => {};
    module.setStatusData = () => {};
    const desc = module.buildPipeline({
        device: 'rigdev',
        channels: shape.channels,
        firstChannel: shape.firstChannel,
    });
    if (!desc) return null;
    let text = [
        desc.pipeline,
        ...(desc.liveInputs ?? []).map((b: any, i: number) => liveInputLaunchText(b, i)),
    ].join(' ');
    shape.sources.forEach((s, i) => {
        const tone =
            `audiotestsrc is-live=true wave=sine freq=${s.freq} volume=${AMP}` +
            ' ! audio/x-raw,rate=48000,channels=1,format=F32LE' +
            ` ! audioconvert mix-matrix="<${s.gains.map((g) => `<(float)${g.toFixed(4)}>`).join(', ')}>"`;
        const ingress = new RegExp(`unixfdsrc socket-path=/tmp/mr-c35-${i}\\.sock .*? ! mrtsdemux`);
        const decoded = new RegExp(
            `unixfdsrc socket-path=/tmp/mr-c35-${i}\\.sock .*? ! avdec_s302m`,
        );
        text =
            s.wire === 2
                ? text.replace(
                      ingress,
                      `${tone} ! audio/x-raw,channels=2,channel-mask=(bitmask)0x0` +
                          ` ! ${build302mEncodeBranch()} ! mrtsdemux`,
                  )
                : text.replace(
                      decoded,
                      `${tone} ! audio/x-raw,format=S32LE,rate=48000,channels=${s.wire},` +
                          `channel-mask=(bitmask)${AVDEC_MASK[s.wire]}`,
                  );
    });
    text = text.replace(
        /pulsesink name=sink .*?stream-properties="[^"]*"/,
        'level name=devlevel post-messages=true interval=100000000 ! fakesink name=sink sync=true',
    );
    if (text.includes('unixfdsrc') || !text.includes('devlevel')) {
        throw new Error(`level rig: cannot rig ${JSON.stringify(shape)}`);
    }
    return prefixNames(text, prefix);
}

/** Every element name (and its pad and aligner references) under `prefix`. */
function prefixNames(text: string, prefix: string): string {
    const names = [...new Set([...text.matchAll(/\bname=([\w]+)/g)].map((m) => m[1]))];
    names.sort((a, b) => b.length - a.length);
    for (const name of names) {
        text = text.replace(new RegExp(`(?<![\\w-])${name}(?![\\w-])`, 'g'), `${prefix}${name}`);
    }
    return text;
}

/** gst-launch's argv: a shell's words, quotes stripped. */
function words(text: string): string[] {
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (const ch of text) {
        if (ch === '"') quoted = !quoted;
        else if (ch === ' ' && !quoted) {
            if (cur) out.push(cur);
            cur = '';
        } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
}

/** rms (dBFS) per channel of each shape's stream, the loudest of its last 8 readings; null: no
 *  reading, undefined: the module refused it. `batch` shapes to a gst-launch; one that read
 *  nothing runs again alone, four at a time, so a broken shape cannot silence its batch. */
export async function measure(
    shapes: Shape[],
    opts: { seconds?: number; batch?: number } = {},
): Promise<Array<number[] | null | undefined>> {
    const batch = opts.batch ?? 24;
    const seconds = opts.seconds ?? 3;
    const out: Array<number[] | null | undefined> = [];
    for (let at = 0; at < shapes.length; at += batch) {
        const chunk = shapes.slice(at, at + batch);
        out.push(...(await measureTogether(chunk, at, seconds)));
    }
    const again = out.flatMap((r, i) => (r === null && shapes.length > 1 ? [i] : []));
    for (let k = 0; k < again.length; k += 4) {
        await Promise.all(
            again.slice(k, k + 4).map(async (i) => {
                out[i] = (await measureTogether([shapes[i]], i, seconds))[0];
            }),
        );
    }
    return out;
}

async function measureTogether(
    shapes: Shape[],
    at: number,
    seconds: number,
): Promise<Array<number[] | null | undefined>> {
    const texts = shapes.map((s, i) => shapeLaunch(s, `s${at + i}_`));
    const run = texts.filter((t): t is string => t !== null);
    const readings = run.length ? await launch(run.join(' '), seconds) : new Map();
    return texts.map((t, i) => {
        if (t === null) return undefined;
        const tail = (readings.get(`s${at + i}_devlevel`) ?? []).slice(-8);
        return tail.length ? tail[0].map((_, c) => Math.max(...tail.map((r) => r[c]))) : null;
    });
}

/** Every level meter's rms readings (dBFS per channel), by element name, of `text` run for
 *  `seconds` in a gst-launch. */
export async function launch(text: string, seconds: number): Promise<Map<string, number[][]>> {
    const args = ['-m', `--gst-plugin-load=${NATIVE.join(',')}`, ...words(text)];
    const child = spawn('gst-launch-1.0', args, {
        env: { ...process.env, GST_REGISTRY: REGISTRY },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (b) => (log += b));
    child.stderr.on('data', (b) => (log += b));
    const exited = new Promise((r) => child.once('exit', r));
    const stop = setTimeout(() => child.kill('SIGINT'), seconds * 1000);
    const kill = setTimeout(() => child.kill('SIGKILL'), seconds * 1000 + 5000);
    await exited;
    clearTimeout(stop);
    clearTimeout(kill);
    const readings = new Map<string, number[][]>();
    for (const line of log.split('\n')) {
        const m = /from element "(\w+)" \(element\): level, .*?rms=\(\w+\)[<{]([^>}]*)[>}]/.exec(
            line,
        );
        if (!m) continue;
        const rms = m[2].split(',').map((x) => Number(x.trim()));
        readings.set(m[1], [...(readings.get(m[1]) ?? []), rms]);
    }
    return readings;
}

/** The stream `shape` should give, rms dBFS per channel (-Infinity: silent): the legacy positioned
 *  stream (the mix itself) or the placed one (2 wide at least, the mix at `firstChannel`), each
 *  source through its map or `defaultMap`. Sources' tones differ, so their powers add. */
export function expectedRms(
    shape: Shape,
    legacy: boolean,
    defaultMap: (wire: number, mix: number) => ChannelMapEntry[],
): number[] {
    const n = shape.channels;
    const width = legacy ? n : Math.max(shape.firstChannel - 1 + n, 2);
    const at = legacy ? 0 : shape.firstChannel - 1;
    const power = new Array<number>(width).fill(0);
    for (const s of shape.sources) {
        const mix = new Array<number>(n).fill(0);
        for (const e of s.map ?? defaultMap(s.wire, n)) {
            if (e.srcChannel < s.wire && e.dstChannel < n) {
                mix[e.dstChannel] += (e.gain ?? 1) * s.gains[e.srcChannel];
            }
        }
        mix.forEach((a, j) => (power[at + j] += (AMP * a) ** 2 / 2));
    }
    return power.map((p) => (p > 0 ? 10 * Math.log10(p) : -Infinity));
}
