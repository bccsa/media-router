/**
 * Dynamic-port + rendition config helpers for the audio transcoder.
 *
 * Pure and dependency-free (plain inputs → plain outputs) so they unit-test on
 * their own and stay decoupled from the GStreamer pipeline assembly in
 * `audioTranscoderPipeline.ts`.
 */

export type PortDirection = 'input' | 'output';

export type AudioCodec = 'opus' | 'aac' | 'pcm';

const AUDIO_CODECS: readonly AudioCodec[] = ['opus', 'aac', 'pcm'];

export interface DynamicPort {
    id: string;
    direction: PortDirection;
    /** Opus/AAC renditions emit plain TS; `pcm` renditions emit SMPTE-302M TS
     *  typed `audio/302m` so the UI wires them like audio. Both are valid
     *  MPEG-TS and TS-family-compatible with any TS transport pin. */
    streamType: 'muxed/mpegts' | 'audio/302m';
    label: string;
    maxConnections: number;
    /** Output ports carry MPEG-TS, so downstream consumers must wait for this
     *  pipeline to be PLAYING before they can be wired — same contract as the
     *  encoder / muxer / video-transcoder outputs. */
    requiresOrderedApply?: boolean;
}

/** One configured output rendition. Opus knobs are per-rendition (they shape
 *  that rendition's encoder only); absent values take the schema defaults. */
export interface Rendition {
    name: string;
    codec: AudioCodec;
    bitrate: number;
    frameSize?: number;
    inbandFec?: boolean;
    packetLoss?: number;
    audioType?: number;
}

/** A rendition with its allocated bus channel. */
export interface AudioTranscoderOutput {
    portId: string;
    port: number;
    rendition: Rendition;
}

export const MPEGTS_INPUT_PORT_ID = 'mpegts-in';
export const AUDIO_INPUT_PORT_ID = 'audio-in';
const OUTPUT_PORT_PREFIX = 'out-';
const MAX_RENDITIONS = 8;

/**
 * Provisional rendition used only when config carries none — the engine
 * resolves `getDynamicPorts` once BEFORE the module starts, when `this.config`
 * is still empty, and the node should show an output port immediately on add.
 * Kept in sync with the manifest's `renditions` default (video-transcoder
 * pattern).
 */
const DEFAULT_RENDITION: Rendition = { name: 'PCM 302M', codec: 'pcm', bitrate: 128 };

export function outputPortId(index: number): string {
    return `${OUTPUT_PORT_PREFIX}${index}`;
}

/**
 * Read + sanitise the rendition list from config. Enum fields are strictly
 * validated (unknown codec collapses to 'opus'), numerics coerced — a
 * malformed config can never splice junk into the gst-launch string.
 */
export function readRenditions(config: Record<string, unknown>): Rendition[] {
    const arr = config.renditions;
    // Key absent → unconfigured/pre-start: surface the provisional rendition so
    // a port exists. An explicit array (even empty) is the operator's choice.
    if (!Array.isArray(arr)) return [{ ...DEFAULT_RENDITION }];
    return arr.slice(0, MAX_RENDITIONS).map((raw) => {
        const e = (raw ?? {}) as Record<string, unknown>;
        const codec =
            typeof e.codec === 'string' && (AUDIO_CODECS as readonly string[]).includes(e.codec)
                ? (e.codec as AudioCodec)
                : 'opus';
        return {
            name: typeof e.name === 'string' ? e.name : '',
            codec,
            bitrate: toPositiveInt(e.bitrate, 128),
            frameSize: toOptionalNumber(e.frameSize),
            inbandFec: typeof e.inbandFec === 'boolean' ? e.inbandFec : undefined,
            packetLoss: toOptionalNumber(e.packetLoss),
            audioType: toOptionalNumber(e.audioType),
        };
    });
}

function toPositiveInt(value: unknown, fallback: number): number {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function toOptionalNumber(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}

/** Display label for a rendition's port: operator name, else codec + bitrate. */
export function renditionLabel(r: Rendition): string {
    if (r.name.trim()) return r.name.trim();
    if (r.codec === 'pcm') return 'PCM 302M';
    return `${r.codec === 'opus' ? 'Opus' : 'AAC'} ${r.bitrate}k`;
}

/**
 * Build the dynamic port list: the two fixed inputs + one output per
 * rendition. Both inputs are always present so sources can be wired before
 * renditions are configured; `mpegts-in` wins when both are connected
 * (enforced in the module).
 */
export function buildDynamicPorts(renditions: Rendition[]): DynamicPort[] {
    const ports: DynamicPort[] = [
        {
            id: MPEGTS_INPUT_PORT_ID,
            direction: 'input',
            streamType: 'muxed/mpegts',
            label: 'MPEG-TS In',
            maxConnections: 1,
        },
        {
            id: AUDIO_INPUT_PORT_ID,
            direction: 'input',
            streamType: 'audio/302m',
            label: 'Audio In (302M mix)',
            maxConnections: -1,
        },
    ];
    renditions.forEach((r, i) => {
        ports.push({
            id: outputPortId(i),
            direction: 'output',
            streamType: r.codec === 'pcm' ? 'audio/302m' : 'muxed/mpegts',
            label: renditionLabel(r),
            maxConnections: -1,
            requiresOrderedApply: true,
        });
    });
    return ports;
}
