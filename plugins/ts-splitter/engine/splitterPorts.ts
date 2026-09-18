/**
 * Dynamic-port + persistence helpers for the TS-splitter.
 *
 * The splitter is a clean slate vs the old demuxer: PID-based output ports only
 * (no legacy positional `video-N`/`audio-N`), keyed on the numeric PID the
 * runner discovers. Pure (type-only engine imports) so the diff/serialise
 * logic is unit-testable with plain objects — the module owns the side effects.
 *
 * Discovery populates the persisted `discoveredStreams` config. Every discovery
 * event carries the source's FULL current PMT, so a persisted PID missing from
 * it has left the source: it is dropped when nothing downstream references its
 * port, and kept — flagged `stale` — while a stored connection still does, so a
 * wired consumer survives a source change (ADR-0021). A dark source sends no
 * discovery at all, so it prunes nothing.
 */
import { streamLabel, type StreamMedia } from './streamTypes.js';
import type { DynamicPort } from '@media-router/engine';

export type { DynamicPort };

export const INPUT_PORT_ID = 'mpegts-in';

/**
 * Legacy element name reported by `getLiveInputSwap`. The gst generation named
 * the input `unixfdsrc` this and the runner re-pointed it by name; the native
 * child has exactly one input and ignores the field, but the engine's swap
 * contract (`{ element }`) still carries it.
 */
export const INPUT_SRC_NAME = 'netin';

const PID_OUT_PREFIX = 'pid-';

export interface DiscoveredStreamConfig {
    pid: number;
    streamType: number;
    /** Resolved by the module at discovery from stream_type PLUS the ES
     *  descriptor loop (Opus is signalled by descriptor only), and used
     *  verbatim here — never re-derived from streamType, which would drop the
     *  descriptor-only identities. */
    media: StreamMedia;
    codec: string;
    /** ISO 639 code from the source PMT's language descriptor (natively
     *  signalled — layered into port/status labels; absent when the ES
     *  carries no language descriptor). */
    language?: string;
    /** Absent from the source's current PMT but kept because a stored
     *  connection still references its port. Cleared when the PID returns. */
    stale?: boolean;
}

/** Port/status label; a stale stream says so. */
export function discoveredLabel(s: DiscoveredStreamConfig): string {
    const base = streamLabel(s.pid, s, s.language);
    return s.stale ? `${base} — stale` : base;
}

export function pidPortId(pid: number): string {
    return `${PID_OUT_PREFIX}0x${pid.toString(16)}`;
}

export function pidFromPortId(portId: string): number | null {
    if (!portId.startsWith(PID_OUT_PREFIX)) return null;
    const pid = Number.parseInt(portId.slice(PID_OUT_PREFIX.length), 16);
    return Number.isFinite(pid) ? pid : null;
}

/** One `muxed/mpegts` input + one output per persisted discovered stream. */
export function buildDynamicPorts(discovered: DiscoveredStreamConfig[]): DynamicPort[] {
    const ports: DynamicPort[] = [
        {
            id: INPUT_PORT_ID,
            direction: 'input',
            streamType: 'muxed/mpegts',
            label: 'MPEG-TS In',
            maxConnections: 1,
            acceptsStreamTypes: ['muxed/mpegts'],
        },
    ];
    for (const s of [...discovered].sort((a, b) => a.pid - b.pid)) {
        ports.push({
            id: pidPortId(s.pid),
            direction: 'output',
            streamType: 'muxed/mpegts',
            label: discoveredLabel(s),
            maxConnections: -1,
            requiresOrderedApply: true,
            streamInfo: {
                pid: s.pid,
                media: s.media,
                codec: s.codec,
                ...(s.language ? { language: s.language } : {}),
            },
            ...(s.stale ? { stale: true } : {}),
        });
    }
    return ports;
}

/** Read the persisted discovered-stream list off module config. */
export function discoveredStreams(config: Record<string, unknown>): DiscoveredStreamConfig[] {
    const raw = config.discoveredStreams;
    return Array.isArray(raw) ? (raw as DiscoveredStreamConfig[]) : [];
}

/**
 * Reconcile the persisted set with one discovery event (`fresh` = the
 * source's whole current PMT). A new PID is added, a changed identity updates
 * in place, a returning PID loses its stale flag. A persisted PID absent from
 * `fresh` is DROPPED unless `hasConnection(pid)` says a stored connection
 * still references its port — then it is kept and flagged `stale`. The
 * predicate must answer from the PERSISTED graph (engine
 * `hasStoredConnection`), not the live one, or a consumer that is merely
 * disabled would lose its source port. Returns null when nothing changed, so
 * the caller can skip a redundant SQLite write.
 */
export function mergeDiscovered(
    prev: DiscoveredStreamConfig[],
    fresh: DiscoveredStreamConfig[],
    hasConnection: (pid: number) => boolean,
): DiscoveredStreamConfig[] | null {
    const merged = new Map<number, DiscoveredStreamConfig>();
    for (const s of fresh) {
        const { stale: _drop, ...live } = s;
        merged.set(s.pid, live);
    }
    for (const s of prev) {
        if (merged.has(s.pid)) continue;
        if (hasConnection(s.pid)) merged.set(s.pid, { ...s, stale: true });
    }
    const next = [...merged.values()].sort((a, b) => a.pid - b.pid);
    return sameStreams(prev, next) ? null : next;
}

function sameStreams(a: DiscoveredStreamConfig[], b: DiscoveredStreamConfig[]): boolean {
    if (a.length !== b.length) return false;
    const byPid = new Map(a.map((s) => [s.pid, s]));
    for (const s of b) {
        const p = byPid.get(s.pid);
        // media/codec (not just streamType): a descriptor-derived identity can
        // change under an unchanged stream_type — e.g. an Opus 0x06 persisted
        // as 'data'/'private' by an older build must re-persist as
        // 'audio'/'opus'. They move together today; comparing both keeps the
        // guard honest if one ever re-classifies on its own.
        if (
            !p ||
            p.streamType !== s.streamType ||
            p.media !== s.media ||
            p.codec !== s.codec ||
            (p.language ?? '') !== (s.language ?? '') ||
            (p.stale ?? false) !== (s.stale ?? false)
        ) {
            return false;
        }
    }
    return true;
}
