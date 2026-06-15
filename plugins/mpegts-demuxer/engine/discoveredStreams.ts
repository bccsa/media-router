/**
 * Pure helpers for turning the live stream inspector's findings into the
 * persisted `discoveredStreams` config (plan D5 — discovery populates config,
 * it never replaces it).
 *
 * Kept free of GStreamer / engine imports so the diff + serialise logic is
 * unit-testable with plain objects. The module owns the side effects
 * (`emitConfigUpdate`, port refresh); this file is just the data transform.
 *
 * Two invariants from the plan:
 *   - Only video/audio streams with a numeric PID are persisted as ports —
 *     the metadata PID is never routed (D6), and a null-PID stream has no
 *     stable identity to key a port on.
 *   - Entries are never auto-removed (D5): a configured-but-absent stream
 *     stays in config so its port survives a source going dark; the module
 *     renders it stale rather than deleting it.
 */

import type { DiscoveredStreamConfig } from './mpegtsDemuxerPipeline.js';
import type { DiscoveredStream } from './streamInspector.js';

/**
 * Project the live inspector list onto the persisted config shape, resolving
 * each entry's label fallback (KLV name, else codec) so an offline port reads
 * sensibly. Drops metadata / data / null-PID streams — only routable
 * video/audio with a PID become ports.
 */
export function streamsToConfig(
    streams: DiscoveredStream[],
    klvNames: Map<number, string>,
): DiscoveredStreamConfig[] {
    const out: DiscoveredStreamConfig[] = [];
    for (const s of streams) {
        if (s.pid === null) continue;
        if (s.media !== 'video' && s.media !== 'audio') continue;
        const name = klvNames.get(s.pid);
        out.push({
            pid: s.pid,
            media: s.media,
            ...(s.codec ? { codec: s.codec } : {}),
            ...(name ? { name } : {}),
        });
    }
    return out.sort((a, b) => {
        if (a.media !== b.media) return a.media === 'video' ? -1 : 1;
        return a.pid - b.pid;
    });
}

/**
 * Merge freshly-discovered streams into the persisted set, returning the new
 * set or null when nothing changed (so the caller can skip an `emitConfigUpdate`
 * → SQLite write on every carousel/discovery tick — the debounce/diff the plan
 * calls for).
 *
 * Merge rules:
 *   - A new PID is added.
 *   - An existing PID is updated when its media/codec/name changed (a live KLV
 *     name arriving, or a codec correction).
 *   - An existing PID that's no longer present is **kept** (D5 — never auto-
 *     remove; the module marks it stale instead).
 * Result is null only when the merged set is byte-identical to `prev`.
 */
export function diffDiscoveredStreams(
    prev: DiscoveredStreamConfig[],
    fresh: DiscoveredStreamConfig[],
): DiscoveredStreamConfig[] | null {
    const merged = new Map<number, DiscoveredStreamConfig>();
    for (const s of prev) merged.set(s.pid, s);
    for (const s of fresh) merged.set(s.pid, s);
    const next = [...merged.values()].sort((a, b) => {
        if (a.media !== b.media) return a.media === 'video' ? -1 : 1;
        return a.pid - b.pid;
    });
    return sameStreams(prev, next) ? null : next;
}

/** Order-insensitive structural equality of two persisted stream lists. */
function sameStreams(a: DiscoveredStreamConfig[], b: DiscoveredStreamConfig[]): boolean {
    if (a.length !== b.length) return false;
    const byPid = new Map(a.map((s) => [s.pid, s]));
    for (const s of b) {
        const p = byPid.get(s.pid);
        if (!p) return false;
        if (p.media !== s.media || p.codec !== s.codec || p.name !== s.name) return false;
    }
    return true;
}
