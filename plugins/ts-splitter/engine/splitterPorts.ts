/**
 * Dynamic-port + persistence helpers for the TS-splitter.
 *
 * The splitter is a clean slate vs the old demuxer: PID-based output ports only
 * (no legacy positional `video-N`/`audio-N`), keyed on the numeric PID the
 * runner discovers. Pure (no engine imports) so the diff/serialise logic is
 * unit-testable with plain objects — the module owns the side effects.
 *
 * Discovery populates the persisted `discoveredStreams` config but never removes
 * from it (a configured-but-absent stream keeps its port so a downstream stays
 * wired when the source briefly goes dark).
 */
import { streamLabel, type StreamMedia } from './streamTypes.js';

export const INPUT_PORT_ID = 'mpegts-in';
const PID_OUT_PREFIX = 'pid-';

export interface DynamicPort {
    id: string;
    direction: 'input' | 'output';
    streamType: 'muxed/mpegts';
    label: string;
    maxConnections: number;
    /** Downstream consumers of these outputs must wait for the runner to be up
     *  before wiring — see the demuxer's DynamicPort note; applied by
     *  ConnectionApplier. */
    requiresOrderedApply?: boolean;
}

export interface DiscoveredStreamConfig {
    pid: number;
    streamType: number;
    media: StreamMedia;
    codec: string;
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
        },
    ];
    for (const s of [...discovered].sort((a, b) => a.pid - b.pid)) {
        ports.push({
            id: pidPortId(s.pid),
            direction: 'output',
            streamType: 'muxed/mpegts',
            label: streamLabel(s.pid, s.streamType),
            maxConnections: -1,
            requiresOrderedApply: true,
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
 * Merge freshly-discovered streams into the persisted set. A new PID is added,
 * a changed stream_type updates in place, and an absent PID is KEPT (never
 * auto-removed — its port survives a dark source). Returns null when nothing
 * changed, so the caller can skip a redundant SQLite write.
 */
export function mergeDiscovered(
    prev: DiscoveredStreamConfig[],
    fresh: DiscoveredStreamConfig[],
): DiscoveredStreamConfig[] | null {
    const merged = new Map<number, DiscoveredStreamConfig>();
    for (const s of prev) merged.set(s.pid, s);
    for (const s of fresh) merged.set(s.pid, s);
    const next = [...merged.values()].sort((a, b) => a.pid - b.pid);
    return sameStreams(prev, next) ? null : next;
}

function sameStreams(a: DiscoveredStreamConfig[], b: DiscoveredStreamConfig[]): boolean {
    if (a.length !== b.length) return false;
    const byPid = new Map(a.map((s) => [s.pid, s]));
    for (const s of b) {
        const p = byPid.get(s.pid);
        if (!p || p.streamType !== s.streamType) return false;
    }
    return true;
}
