/**
 * Muxer input CONFIG: reading `inputs[]` (and the pre-generic legacy lists),
 * port ids, and the dynamic port list. Pure — no GStreamer / engine runtime.
 *
 * INPUTS ARE MEDIA-AGNOSTIC (ADR-0017): a muxer has N generic inputs
 * (`inputs[]` → ports `input-0..N-1`); any input takes any muxed/mpegts source.
 * Each generic input owns an 8-PID block (`muxPids.ts`: `muxInputBasePid(N)`
 * = 0x100 + 8·N, classes at +0 video / +1 audio / +2 klv / +3 subtitle).
 *
 * Configs written before this (`videoStreams` / `audioStreams`, ports
 * `video-N` / `audio-N`) keep working untouched: their ports keep their ids
 * (wiring survives the upgrade) and their A/V PIDs keep the old per-kind
 * connected-ordinal scheme (`muxSlotPid`), so downstream splitter ports keep
 * their identity. Such a legacy port routes only its own kind of elementary
 * stream plus klv and subtitle streams; see `inputEntries` for the
 * precedence rule. Slot layout lives in `muxerSlots.ts`, pipeline assembly
 * in `mpegtsMuxerPipeline.ts`.
 */

import type { DynamicPort } from '@media-router/engine';
import { muxInputBasePid, MUX_SLOTS_PER_CLASS } from './muxPids.js';

// Shared engine type. Note: muxer ports never set `streamInfo.pid` — a
// generic input's PIDs depend on which stream classes the connected source
// turns out to carry, so a single port-level PID would lie.
export type { DynamicPort };

export interface UdpInputSource {
    /** Sink port id this connection arrives on (`input-2`, or a legacy `video-0` / `audio-1`). */
    sinkPortId: string;
    port: number;
    /** Operator-set name for this input (live-updatable). Blank → fall back. */
    name?: string | null;
    /** Connected source module id (D4 name fallback when no operator name). */
    sourceModuleId?: string | null;
    /** Per-consumer edge socket (falls back to the channel socket). */
    socketPath?: string;
    /** Lipsync offset (ms) for this input's audio mux pad — see InputEntry.offsetMs. */
    offsetMs?: number;
    /** ISO 639 language code for this input's audio PMT descriptor — see
     *  InputEntry.language. Blank/absent → pass the source's language through. */
    language?: string;
    /** Operator base PID for this input's block — see InputEntry.pid. */
    pid?: number;
}

/** Elementary-stream PID range: below 0x20 is PSI/SI, 0x1fff is the null packet. */
export const MIN_ES_PID = 0x0020;
export const MAX_ES_PID = 0x1ffe;
/** Highest base PID that keeps the whole block (+3) inside the ES range. */
export const MAX_INPUT_BASE_PID = MAX_ES_PID - 3;

const INPUT_PORT_PREFIX = 'input-';
const LEGACY_VIDEO_PORT_PREFIX = 'video-';
const LEGACY_AUDIO_PORT_PREFIX = 'audio-';
const OUTPUT_PORT_ID = 'mpegts-out';

/** Generic input count cap — one PID block per input (`muxPids.ts`). */
export const MAX_INPUTS = MUX_SLOTS_PER_CLASS;
/** Legacy list caps (the old schema's maxItems), kept so old configs read the same. */
const LEGACY_MAX_STREAMS: Record<'video' | 'audio', number> = { video: 8, audio: 16 };

/** One configured input. */
export interface InputEntry {
    /** Sink port id: `input-N`, or the `video-N` / `audio-N` of a legacy config. */
    id: string;
    /** Pin label (`Input 1`, or the legacy `Video 1` / `Audio 1`). */
    label: string;
    /** Operator-set name (blank = unset). */
    name: string;
    /**
     * Lipsync offset (ms) applied to this input's AUDIO mux pad via
     * `GstPad.set_offset()` (never video — delaying video would add real
     * latency). Negative advances the stream on the mux timeline: use
     * `-<measured audio-late skew>` to cancel a stable path offset with no
     * added latency (costs ~|offset| of clipped audio at pipeline start).
     * Clamped ±2000; 0/absent → no offset applied (route shape unchanged).
     */
    offsetMs: number;
    /**
     * ISO 639 language code (2/3-letter, e.g. en / eng / deu) written into the
     * output PMT as the language descriptor of this input's streams via a
     * `taginject` in each non-video branch (mpegtsmux converts any accepted
     * form to ISO 639-2B on the wire; today it writes the descriptor for AUDIO
     * only — KLV/teletext get it once mpegtsmux does). Empty → no taginject, so
     * whatever language the SOURCE TS carries passes through tsdemux→mpegtsmux
     * untouched. Applied at build time — changing it restarts the muxer (a
     * live `tags` property change is not reliably re-emitted by taginject).
     */
    language: string;
    /**
     * Legacy port kind. Set only for entries read from a pre-generic config:
     * the port routes just this class of elementary stream (plus klv and
     * subtitle), and its PID follows the old per-kind connected ordinal, so
     * everything downstream sees exactly the TS it saw before the upgrade.
     */
    legacyMedia?: 'video' | 'audio';
    /**
     * Operator base PID of this input's block (config `pid`): its video goes
     * here, audio at +1, KLV/WebVTT subtitles at +2, DVB/teletext at +3.
     * Undefined = automatic (`muxInputBasePid(index)`); the module writes the
     * automatic value back into the config so the field shows the PID in use.
     * Applied at build time; a block colliding with any other slot, or with a
     * reserved PID, is a build error — the muxer refuses to start and names
     * the clash (`MuxerPidConflictError`) rather than letting mpegtsmux fail
     * the second request pad on the wire. Not used by legacy ports.
     */
    pid?: number;
}

const MAX_OFFSET_MS = 2000;

/** Clamp a raw config offset to ±2000 ms; malformed → 0. */
export function normalizeOffsetMs(raw: unknown): number {
    const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    return Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, n));
}

/** Sanitize a raw config language to a bare ISO 639 code; anything else → ''.
 *  The strict 2-3 letter shape doubles as launch-string safety — the value is
 *  interpolated into `taginject tags=…` and can never need quoting. */
export function normalizeLanguage(raw: unknown): string {
    return typeof raw === 'string' && /^[A-Za-z]{2,3}$/.test(raw) ? raw.toLowerCase() : '';
}

/** A raw config base PID: an integer whose block fits the ES range → that PID;
 *  0, blank or malformed → undefined (automatic). */
export function normalizePid(raw: unknown): number | undefined {
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < MIN_ES_PID || n > MAX_INPUT_BASE_PID) {
        return undefined;
    }
    return n;
}

function entryFields(raw: unknown): Pick<InputEntry, 'name' | 'offsetMs' | 'language' | 'pid'> {
    const e = (raw ?? {}) as Record<string, unknown>;
    const pid = normalizePid(e.pid);
    return {
        name: typeof e.name === 'string' ? e.name : '',
        offsetMs: normalizeOffsetMs(e.offsetMs),
        language: normalizeLanguage(e.language),
        ...(pid !== undefined ? { pid } : {}),
    };
}

/** The base PID a generic input entry uses: its operator value, else the
 *  automatic block for its port index. */
export function effectiveInputPid(entry: InputEntry, index: number): number {
    return entry.pid ?? muxInputBasePid(index);
}

/** True when the config still carries the pre-generic stream lists. */
export function isLegacyConfig(config: Record<string, unknown>): boolean {
    return (
        Array.isArray(config.videoStreams) ||
        Array.isArray(config.audioStreams) ||
        typeof config.videoStreamCount === 'number' ||
        typeof config.audioStreamCount === 'number'
    );
}

/** Legacy `videoStreams` / `audioStreams` arrays, or the older counts + a
 *  `streamNames` map keyed by port id — same reader the old plugin had. */
function legacyEntries(config: Record<string, unknown>, media: 'video' | 'audio'): InputEntry[] {
    const prefix = media === 'video' ? LEGACY_VIDEO_PORT_PREFIX : LEGACY_AUDIO_PORT_PREFIX;
    const label = media === 'video' ? 'Video' : 'Audio';
    const arr = config[media === 'video' ? 'videoStreams' : 'audioStreams'];
    if (Array.isArray(arr)) {
        return arr.slice(0, LEGACY_MAX_STREAMS[media]).map((e, i) => ({
            id: `${prefix}${i}`,
            label: `${label} ${i + 1}`,
            ...entryFields(e),
            legacyMedia: media,
        }));
    }
    const count = Math.max(
        0,
        (config[media === 'video' ? 'videoStreamCount' : 'audioStreamCount'] as number) ?? 1,
    );
    const legacyNames = (config.streamNames as Record<string, string> | undefined) ?? {};
    return Array.from({ length: Math.min(count, LEGACY_MAX_STREAMS[media]) }, (_, i) => ({
        id: `${prefix}${i}`,
        label: `${label} ${i + 1}`,
        name: legacyNames[`${media}-${i}`] ?? '',
        offsetMs: 0,
        language: '',
        legacyMedia: media,
    }));
}

/**
 * Read the input list from config.
 *
 * Current shape: `inputs` — an array of `{ name, language, offsetMs }`, one
 * entry per input port ("+ Add" in the UI appends an entry), ports `input-N`.
 *
 * LEGACY KEYS WIN. A config that still carries `videoStreams` / `audioStreams`
 * (or the even older counts) is read exactly as before — ports `video-N` /
 * `audio-N` — even if an `inputs` array is present too: the settings form
 * seeds every schema default into the panel and "Apply" writes them all
 * back, so a legacy module would otherwise flip to a single `input-0` port
 * on the first Apply and silently drop every connection into it. The module
 * reports the legacy mode in its status; switching to generic inputs is a
 * deliberate re-create.
 */
export function inputEntries(config: Record<string, unknown>): InputEntry[] {
    if (isLegacyConfig(config)) {
        return [...legacyEntries(config, 'video'), ...legacyEntries(config, 'audio')];
    }
    const arr = Array.isArray(config.inputs) ? config.inputs : [{}];
    return arr.slice(0, MAX_INPUTS).map((e, i) => ({
        id: inputPortId(i),
        label: `Input ${i + 1}`,
        ...entryFields(e),
    }));
}

export function inputPortId(index: number): string {
    return `${INPUT_PORT_PREFIX}${index}`;
}

/** Any of this module's input port ids — generic or legacy. */
export function isInputPort(portId: string): boolean {
    return (
        portId.startsWith(INPUT_PORT_PREFIX) ||
        portId.startsWith(LEGACY_VIDEO_PORT_PREFIX) ||
        portId.startsWith(LEGACY_AUDIO_PORT_PREFIX)
    );
}

/** Legacy port kind from its id, undefined for a generic `input-N`. */
export function legacyPortMedia(portId: string): 'video' | 'audio' | undefined {
    if (portId.startsWith(LEGACY_VIDEO_PORT_PREFIX)) return 'video';
    if (portId.startsWith(LEGACY_AUDIO_PORT_PREFIX)) return 'audio';
    return undefined;
}

/** `<prefix>-<n>` → n; undefined when the id has no trailing number. Shared by
 *  the slot layout (block index) and the source sort (numeric order). */
export function portIndex(portId: string): number | undefined {
    const m = /-(\d+)$/.exec(portId);
    return m ? Number(m[1]) : undefined;
}

/**
 * Build the dynamic port list that mirrors the configured inputs. The output
 * port is always present so downstream players can connect even when no
 * inputs are configured yet. Every input accepts either TS family (a muxed
 * TS OR a 302M stream — PCM muxes into the program like any audio), hence
 * the dual-colour dot.
 */
export function buildDynamicPorts(entries: InputEntry[]): DynamicPort[] {
    const ports: DynamicPort[] = entries.map((entry) => {
        const name = entry.name.trim();
        const streamInfo =
            name || entry.language || entry.legacyMedia
                ? {
                      ...(entry.legacyMedia ? { media: entry.legacyMedia } : {}),
                      ...(name ? { name } : {}),
                      ...(entry.language ? { language: entry.language } : {}),
                  }
                : undefined;
        return {
            id: entry.id,
            direction: 'input' as const,
            streamType: 'muxed/mpegts' as const,
            label: entry.label,
            maxConnections: 1,
            acceptsAnyTs: true,
            ...(streamInfo ? { streamInfo } : {}),
        };
    });
    ports.push({
        id: OUTPUT_PORT_ID,
        direction: 'output',
        streamType: 'muxed/mpegts',
        label: 'MPEG-TS Out',
        maxConnections: -1,
        requiresOrderedApply: true,
    });
    return ports;
}
