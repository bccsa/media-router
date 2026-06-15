/**
 * Stale-stream bookkeeping for the MPEG-TS demuxer, extracted from the module
 * so the GC hysteresis and the status rendering are unit-testable without
 * reaching into module privates.
 *
 * Two pieces:
 *  - `StaleStreamTracker` — decides WHEN a persisted stream may be
 *    garbage-collected (plan D5 refinement): only after being continuously
 *    stale AND unconnected for a full hysteresis window.
 *  - `renderStreamStatus` — pure projection of inspector + persisted state
 *    into the status panel's sections/badge (report-only, plan D6).
 */

import type { DiscoveredStreamConfig } from './mpegtsDemuxerPipeline.js';
import { StreamInspector, type DiscoveredStream } from './streamInspector.js';

/**
 * Hysteresis clock per PID. GC requires stale+unconnected to hold
 * CONTINUOUSLY for the window — a single-moment check races engine startup
 * and ordered connection apply (both transiently report zero connections)
 * and orphaned live edges. Any sighting of the PID live or connected resets
 * its clock.
 */
export class StaleStreamTracker {
    private since = new Map<number, number>();

    constructor(private readonly gcMs: number) {}

    /** Clear all clocks (module (re)start / stop). */
    reset(): void {
        this.since.clear();
    }

    /**
     * Evaluate the persisted set. Returns the streams to KEEP when at least
     * one expired entry should be collected, or null when nothing changes.
     * Streams seen live or connected always survive and reset their clock.
     */
    sweep(
        persisted: DiscoveredStreamConfig[],
        livePids: ReadonlySet<number>,
        isConnected: (pid: number) => boolean,
        now: number,
    ): DiscoveredStreamConfig[] | null {
        const kept = persisted.filter((s) => {
            if (livePids.has(s.pid) || isConnected(s.pid)) {
                this.since.delete(s.pid);
                return true;
            }
            const since = this.since.get(s.pid);
            if (since === undefined) {
                this.since.set(s.pid, now);
                return true;
            }
            return now - since < this.gcMs;
        });
        if (kept.length === persisted.length) return null;
        for (const s of persisted) {
            if (!kept.includes(s)) this.since.delete(s.pid);
        }
        return kept;
    }
}

/** One status-section definition + its data row, ready for the module to
 *  apply via `dynamicStatusSections` / `setStatusData`. */
export interface StreamStatusRender {
    summary: { detected: number; stale: number };
    /** Red node-face badge payload, or null when nothing is stale. */
    badge: { icon: string; text: string; color: string } | null;
    sections: Array<{
        id: string;
        label: string;
        fields: Array<{ key: string; label: string }>;
    }>;
    data: Array<{ id: string; values: Record<string, unknown> }>;
}

/**
 * Project live + stale streams into the status panel. A fixed `streams`
 * summary plus one dynamic section per stream so the panel grows with the
 * source without a manifest change. Persisted streams that aren't live this
 * run render as **stale**; the badge makes a dead PID visible at a glance in
 * the graph. Report-only — never touches health (plan D6).
 */
export function renderStreamStatus(
    streams: DiscoveredStream[],
    stale: DiscoveredStreamConfig[],
    klvNames: Map<number, string>,
): StreamStatusRender {
    const badge =
        stale.length > 0
            ? {
                  icon: 'alert-triangle',
                  text: stale.length === 1 ? '1 stale stream' : `${stale.length} stale streams`,
                  color: '#ef4444',
              }
            : null;
    const sections = [
        ...streams.map((s, i) => ({
            id: s.pid !== null ? `stream-${s.pid}` : `stream-idx-${i}`,
            // Label-resolution order: KLV name → language → generated.
            label: StreamInspector.resolveLabel(s, klvNames),
            fields: [
                { key: 'name', label: 'Name' },
                { key: 'codec', label: 'Codec' },
                { key: 'pid', label: 'PID' },
                { key: 'media', label: 'Type' },
            ],
        })),
        ...stale.map((s) => ({
            id: `stream-${s.pid}`,
            label: `${s.name ?? s.codec ?? s.media} (stale)`,
            fields: [
                { key: 'name', label: 'Name' },
                { key: 'codec', label: 'Codec' },
                { key: 'pid', label: 'PID' },
                { key: 'status', label: 'Status' },
            ],
        })),
    ];
    const data = [
        ...streams
            .filter((s) => s.pid !== null)
            .map((s) => ({
                id: `stream-${s.pid}`,
                values: {
                    name: StreamInspector.resolveLabel(s, klvNames),
                    codec: s.codec,
                    pid: StreamInspector.formatPid(s.pid),
                    media: s.media,
                },
            })),
        ...stale.map((s) => ({
            id: `stream-${s.pid}`,
            values: {
                name: s.name ?? '—',
                codec: s.codec ?? '—',
                pid: StreamInspector.formatPid(s.pid),
                status: 'stale (not in current stream)',
            },
        })),
    ];
    return { summary: { detected: streams.length, stale: stale.length }, badge, sections, data };
}
