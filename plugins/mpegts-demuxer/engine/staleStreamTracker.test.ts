import { describe, it, expect } from 'vitest';
import { StaleStreamTracker, renderStreamStatus } from './staleStreamTracker.js';
import type { DiscoveredStreamConfig } from './mpegtsDemuxerPipeline.js';
import type { DiscoveredStream } from './streamInspector.js';

const GC_MS = 60_000;

function streams(...pids: number[]): DiscoveredStreamConfig[] {
    return pids.map((pid) => ({ pid, media: 'audio' as const, codec: 'aac' }));
}

describe('StaleStreamTracker', () => {
    it('first stale+unconnected sighting only starts the clock — nothing removed', () => {
        const t = new StaleStreamTracker(GC_MS);
        expect(t.sweep(streams(0x141), new Set(), () => false, 1_000)).toBeNull();
    });

    it('collects a stream once it has been stale+unconnected past the window', () => {
        const t = new StaleStreamTracker(GC_MS);
        t.sweep(streams(0x141, 0x142), new Set([0x141]), () => false, 1_000);
        const kept = t.sweep(streams(0x141, 0x142), new Set([0x141]), () => false, 1_000 + GC_MS);
        expect(kept!.map((s) => s.pid)).toEqual([0x141]);
    });

    it('keeps a stream under the window', () => {
        const t = new StaleStreamTracker(GC_MS);
        t.sweep(streams(0x142), new Set(), () => false, 1_000);
        expect(t.sweep(streams(0x142), new Set(), () => false, 1_000 + GC_MS - 1)).toBeNull();
    });

    it('a connection appearing mid-window resets the clock (never orphans)', () => {
        const t = new StaleStreamTracker(GC_MS);
        t.sweep(streams(0x142), new Set(), () => false, 1_000);
        // Connection applies (e.g. ordered apply finished) before expiry —
        // kept and clock cleared, so the window restarts from scratch later.
        expect(t.sweep(streams(0x142), new Set(), () => true, 1_000 + GC_MS)).toBeNull();
        expect(t.sweep(streams(0x142), new Set(), () => false, 2_000 + GC_MS)).toBeNull();
        expect(
            t.sweep(streams(0x142), new Set(), () => false, 2_000 + GC_MS * 2),
        ).toEqual([]);
    });

    it('seeing the PID live resets the clock', () => {
        const t = new StaleStreamTracker(GC_MS);
        t.sweep(streams(0x142), new Set(), () => false, 1_000);
        expect(t.sweep(streams(0x142), new Set([0x142]), () => false, 1_000 + GC_MS)).toBeNull();
        expect(t.sweep(streams(0x142), new Set(), () => false, 2_000 + GC_MS)).toBeNull();
    });

    it('reset() clears all clocks (module restart)', () => {
        const t = new StaleStreamTracker(GC_MS);
        t.sweep(streams(0x142), new Set(), () => false, 1_000);
        t.reset();
        expect(t.sweep(streams(0x142), new Set(), () => false, 1_000 + GC_MS)).toBeNull();
    });
});

describe('renderStreamStatus', () => {
    const live: DiscoveredStream[] = [
        { pid: 0x100, media: 'video', codec: 'h264', caps: 'video/x-h264', language: null },
    ];

    it('renders live streams with no badge when nothing is stale', () => {
        const r = renderStreamStatus(live, [], new Map());
        expect(r.summary).toEqual({ detected: 1, stale: 0 });
        expect(r.badge).toBeNull();
        expect(r.sections[0].id).toBe('stream-256');
    });

    it('renders a red badge and a (stale) section per missing stream', () => {
        const r = renderStreamStatus(live, streams(0x141, 0x142), new Map());
        expect(r.summary).toEqual({ detected: 1, stale: 2 });
        expect(r.badge).toEqual({
            icon: 'alert-triangle',
            text: '2 stale streams',
            color: '#ef4444',
        });
        const staleSection = r.sections.find((s) => s.id === 'stream-321')!;
        expect(staleSection.label).toContain('(stale)');
        const staleRow = r.data.find((d) => d.id === 'stream-321')!;
        expect(staleRow.values.status).toContain('stale');
    });

    it('prefers KLV names for live stream labels', () => {
        const r = renderStreamStatus(live, [], new Map([[0x100, 'Cam 1']]));
        expect(r.sections[0].label).toBe('Cam 1');
    });
});
