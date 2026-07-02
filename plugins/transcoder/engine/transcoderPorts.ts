/**
 * Dynamic-port + rendition config helpers for the video transcoder.
 *
 * Pure and dependency-free (plain inputs → plain outputs) so they unit-test on
 * their own and stay decoupled from the GStreamer pipeline assembly in
 * `transcoderPipeline.ts`.
 */

export type PortDirection = 'input' | 'output';

export interface DynamicPort {
    id: string;
    direction: PortDirection;
    streamType: 'muxed/mpegts';
    label: string;
    maxConnections: number;
    /** Output ports carry MPEG-TS, so downstream consumers must wait for this
     *  pipeline to be PLAYING before they can be wired — same contract as the
     *  encoder / muxer outputs. */
    requiresOrderedApply?: boolean;
}

/** One configured output rendition. */
export interface Rendition {
    name: string;
    width: number;
    height: number;
    bitrate: number;
}

/** A rendition with its allocated UDP endpoint + stable port id. */
export interface TranscoderOutput {
    portId: string;
    host: string;
    port: number;
    rendition: Rendition;
}

const INPUT_PORT_ID = 'mpegts-in';
const OUTPUT_PORT_PREFIX = 'out-';
const MAX_RENDITIONS = 8;

/**
 * Provisional rendition used only when config carries none. The engine resolves
 * `getDynamicPorts` once BEFORE the module starts — at which point the plugin's
 * `this.config` is still empty (config is applied in `onInit`, during start).
 * Returning at least one rendition here means the node shows an output port
 * immediately on add (the engine re-resolves with the real config once the
 * module is running, e.g. on connection-apply). Mirrors how the MPEG-TS muxer's
 * `?? 1` stream-count default keeps its ports visible pre-start. Kept in sync
 * with the first entry of the manifest's `renditions` default.
 */
const DEFAULT_RENDITION: Rendition = { name: '720p', width: 1280, height: 720, bitrate: 2500 };

export function outputPortId(index: number): string {
    return `${OUTPUT_PORT_PREFIX}${index}`;
}

/**
 * Read + sanitise the rendition list from config. Coerces the numeric fields
 * and clamps the count, so a malformed config can never splice junk into the
 * gst-launch string. A blank/missing name is left empty (the caller falls back
 * to the `WxH` resolution as the label).
 */
export function readRenditions(config: Record<string, unknown>): Rendition[] {
    const arr = config.renditions;
    // Key absent → unconfigured/pre-start: surface one provisional rendition so a
    // port exists (see DEFAULT_RENDITION). An explicit array (even empty) is the
    // operator's real choice and is honoured as-is.
    if (!Array.isArray(arr)) return [{ ...DEFAULT_RENDITION }];
    return arr.slice(0, MAX_RENDITIONS).map((raw) => {
        const e = (raw ?? {}) as Record<string, unknown>;
        return {
            name: typeof e.name === 'string' ? e.name : '',
            width: toPositiveInt(e.width, 1280),
            height: toPositiveInt(e.height, 720),
            bitrate: toPositiveInt(e.bitrate, 2500),
        };
    });
}

function toPositiveInt(value: unknown, fallback: number): number {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Display label for a rendition's port: operator name, else `WxH`. */
export function renditionLabel(r: Rendition): string {
    if (r.name.trim()) return r.name.trim();
    return `${r.width}x${r.height}`;
}

/**
 * Build the dynamic port list: one MPEG-TS input + one output per rendition.
 * The input is always present so a source can be wired before any rendition is
 * configured.
 */
export function buildDynamicPorts(renditions: Rendition[]): DynamicPort[] {
    const ports: DynamicPort[] = [
        {
            id: INPUT_PORT_ID,
            direction: 'input',
            streamType: 'muxed/mpegts',
            label: 'MPEG-TS In',
            maxConnections: 1,
        },
    ];
    renditions.forEach((r, i) => {
        ports.push({
            id: outputPortId(i),
            direction: 'output',
            streamType: 'muxed/mpegts',
            label: renditionLabel(r),
            maxConnections: -1,
            requiresOrderedApply: true,
        });
    });
    return ports;
}
