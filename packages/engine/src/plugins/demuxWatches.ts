// The demuxes' `mrtsdemux` messages (house-clock WI-P3-6): per element, the interval counters as
// its input's Demux rows, the program changes for the log, and the warnings that stand until the
// next program, a restart or their condition's end. LatenessReporter maps each element to an input.
import type { DemuxCounters } from '@media-router/shared-types';

/** Plugin-event channel prefix: `mrtsdemux:<element name>` (one structure, `reason=`). */
export const DEMUX_EVENT = 'mrtsdemux';

/** The input a demux (or an ASRC on one input's branch) serves, as a module answers it: an
 *  input's tap, a bus connection or the sink port of one (its edge's tap), a row of its own by
 *  `label`, or none. */
export type DemuxInputRef =
    | { tap: string }
    | { connection: string }
    | { port: string }
    | { label: string }
    | null;

/** PES/s is counted over this much of the latest interval reports. */
const RATE_WINDOW_MS = 10_000;
/** `media`'s default: every pad class (gstmrtsdemux.cpp MEDIA_ALL). */
const MEDIA_ALL = 'video,audio,private,subpicture';
const MEDIA_WORDS: Record<string, string> = {
    video: 'video',
    audio: 'audio',
    private: 'data',
    subpicture: 'subtitle',
};

export type DemuxStreamState = 'waiting' | 'found' | 'missing';

/** One message's fields; a field the message does not carry reads 0 or ''. */
export interface DemuxReport {
    reason: string;
    /** Select mode's caps; empty in demux mode. */
    select: string;
    stream: DemuxStreamState;
    /** The program's (-1 before the first PMT); absent where the message carries none. */
    generation?: number;
    pes: number;
    gaps: number;
    ccLost: number;
    pads: string;
    pcrPid: number;
    pid: number;
    streamType: number;
    registration: string;
    offsetMs: number;
}

const STREAMS: ReadonlySet<string> = new Set(['waiting', 'found', 'missing']);

/** One `mrtsdemux` payload as a report; null without a reason. */
export function parseDemuxPayload(payload: unknown): DemuxReport | null {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (typeof p.reason !== 'string' || !p.reason) return null;
    const num = (k: string): number => {
        const v = Number(p[k]);
        return Number.isFinite(v) ? v : 0;
    };
    const str = (k: string): string => (typeof p[k] === 'string' ? (p[k] as string) : '');
    return {
        reason: p.reason,
        select: str('select'),
        stream: (STREAMS.has(str('stream')) ? str('stream') : 'waiting') as DemuxStreamState,
        ...(p.generation !== undefined ? { generation: num('generation') } : {}),
        pes: num('pes'),
        gaps: num('gaps'),
        ccLost: num('cc-lost'),
        pads: str('pads'),
        pcrPid: num('pcr-pid'),
        pid: num('pid'),
        streamType: num('stream-type'),
        registration: str('registration'),
        offsetMs: num('offset-ms'),
    };
}

/** A warning standing on one demux, for the module's health text. */
export type DemuxWarning =
    | { kind: 'demux-unknown-stream'; pid: number; streamType: number; registration: string }
    | { kind: 'input-not-house-time'; pid: number; offsetMs: number }
    | { kind: 'input-no-stream'; select: string };

/** A demux mode's new program (generation > 0): a line in the module's log. */
export interface DemuxProgram {
    name: string;
    generation: number;
    pads: string;
    pcrPid: number;
}

export interface DemuxWatch {
    name: string;
    /** From the second interval report on. */
    counters?: DemuxCounters;
    warnings: DemuxWarning[];
}

interface Entry {
    at: number;
    /** The newest generation any message carried: older warnings are cleared at it. */
    generation: number;
    /** The newest generation logged (or the one the element started on). */
    logged: number;
    pes: number;
    samples: Array<{ at: number; pes: number }>;
    gaps: number;
    ccLost: number;
    unknown: Map<number, { streamType: number; registration: string; generation: number }>;
    offHouse: Map<number, { offsetMs: number; generation: number }>;
    noStream?: { select: string };
}

const pidText = (pid: number): string => `0x${pid.toString(16).padStart(4, '0')}`;
const typeText = (t: number): string => `0x${t.toString(16).padStart(2, '0')}`;

/** What a demux set for `select` or `media` carries none of, in words. */
export function streamKind(select: string, media?: string): string {
    if (select) {
        if (select === 'audio/x-smpte-302m') return '302M audio';
        const type = select.split('/')[0];
        return type === 'audio' || type === 'video' ? type : select;
    }
    if (!media || media.replace(/\s/g, '') === MEDIA_ALL) return '';
    return media
        .split(',')
        .map((m) => MEDIA_WORDS[m.trim()] ?? m.trim())
        .join(' or ');
}

/** A warning's text on the input it names (`label`); `media` is the demux's as built. */
export function demuxWarningText(w: DemuxWarning, label: string, media?: string): string {
    if (w.kind === 'demux-unknown-stream') {
        const reg = w.registration ? ` (registration ${w.registration})` : '';
        const descriptor = w.streamType === 0x06 ? ' with no known descriptor' : '';
        return (
            `Input ${label}: PID ${pidText(w.pid)}: stream type ${typeText(w.streamType)}` +
            `${reg}${descriptor} is not demuxed`
        );
    }
    if (w.kind === 'input-not-house-time') {
        const s = Math.abs(w.offsetMs) / 1000;
        const off = s >= 10 ? String(Math.round(s)) : s.toFixed(1);
        return `Input ${label} is ${off} s off house time — its producer does not stamp house time`;
    }
    const kind = streamKind(w.select, media);
    return `Input ${label} carries no ${kind ? `${kind} ` : ''}stream`;
}

/** A new element under an old name (a runner respawn): its counters start again. */
function restarted(e: Entry, r: DemuxReport): boolean {
    if (r.generation !== undefined && r.generation < e.generation) return true;
    return r.reason === 'interval' && r.pes < e.pes;
}

export class DemuxWatches {
    private readonly entries = new Map<string, Entry>();

    /** One message from element `name`: whether its warnings changed, and a new program. Null
     *  when the payload is no `mrtsdemux` report. */
    take(
        name: string,
        payload: unknown,
        now: number,
    ): { changed: boolean; program?: DemuxProgram } | null {
        const r = parseDemuxPayload(payload);
        if (!r) return null;
        const old = this.entries.get(name);
        const e: Entry =
            old && !restarted(old, r)
                ? old
                : {
                      at: now,
                      generation: r.generation ?? -1,
                      logged: r.generation ?? -1,
                      pes: 0,
                      samples: [],
                      gaps: 0,
                      ccLost: 0,
                      unknown: new Map(),
                      offHouse: new Map(),
                  };
        const before = old === e ? warningKey(e) : '';
        e.at = now;
        const gen = r.generation;
        if (gen !== undefined && gen > e.generation) {
            // The next program: what stood on the old one goes (its unknown streams are posted
            // again, ahead of the program message, where the new PMT still lists them).
            for (const [pid, u] of e.unknown) if (u.generation < gen) e.unknown.delete(pid);
            for (const [pid, o] of e.offHouse) if (o.generation < gen) e.offHouse.delete(pid);
            e.noStream = undefined;
            e.generation = gen;
        }
        if (r.stream === 'found') e.noStream = undefined;
        let program: DemuxProgram | undefined;
        switch (r.reason) {
            case 'interval':
                e.pes = r.pes;
                e.gaps = r.gaps;
                e.ccLost = r.ccLost;
                e.samples.push({ at: now, pes: r.pes });
                while (e.samples.length > 2 && now - e.samples[0].at > RATE_WINDOW_MS) {
                    e.samples.shift();
                }
                break;
            case 'unknown-stream':
                e.unknown.set(r.pid, {
                    streamType: r.streamType,
                    registration: r.registration,
                    generation: gen ?? e.generation,
                });
                break;
            case 'not-house-time':
                e.offHouse.set(r.pid, { offsetMs: r.offsetMs, generation: e.generation });
                break;
            case 'no-stream':
                e.noStream = { select: r.select };
                break;
        }
        // The first program is the start, not a change (select mode has none: generation -1).
        if (r.reason === 'program' && gen !== undefined && gen > 0 && gen > e.logged) {
            e.logged = gen;
            program = { name, generation: gen, pads: r.pads, pcrPid: r.pcrPid };
        }
        this.entries.set(name, e);
        return { changed: warningKey(e) !== before, ...(program ? { program } : {}) };
    }

    /** Forget demuxes that stopped reporting (input removed, pipeline gone). */
    expire(now: number, staleMs: number): void {
        for (const [name, e] of this.entries) if (now - e.at > staleMs) this.entries.delete(name);
    }

    list(): DemuxWatch[] {
        return [...this.entries].map(([name, e]) => ({
            name,
            ...(e.samples.length >= 2 ? { counters: counters(e) } : {}),
            warnings: warnings(e),
        }));
    }

    clear(): void {
        this.entries.clear();
    }
}

function counters(e: Entry): DemuxCounters {
    const first = e.samples[0];
    const last = e.samples[e.samples.length - 1];
    const dt = last.at - first.at;
    return {
        pesPerS: dt > 0 ? ((last.pes - first.pes) * 1000) / dt : 0,
        gaps: e.gaps,
        ccLost: e.ccLost,
        unknownStreams: e.unknown.size,
    };
}

function warnings(e: Entry): DemuxWarning[] {
    const out: DemuxWarning[] = [];
    for (const [pid, u] of [...e.unknown].sort(([a], [b]) => a - b)) {
        const { streamType, registration } = u;
        out.push({ kind: 'demux-unknown-stream', pid, streamType, registration });
    }
    // One input, one producer: the furthest PID speaks for it.
    const off = [...e.offHouse].sort(([, a], [, b]) => Math.abs(b.offsetMs) - Math.abs(a.offsetMs));
    if (off.length)
        out.push({ kind: 'input-not-house-time', pid: off[0][0], offsetMs: off[0][1].offsetMs });
    if (e.noStream) out.push({ kind: 'input-no-stream', select: e.noStream.select });
    return out;
}

const warningKey = (e: Entry): string => JSON.stringify(warnings(e));
