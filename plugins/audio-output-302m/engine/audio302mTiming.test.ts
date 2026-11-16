import { describe, it, expect, vi } from 'vitest';
import {
    audio302mTsOffsetNs,
    SINK_BUFFER_US,
    SINK_DECLARED_LATENCY_MS,
} from './audio302mTiming.js';

/** Services shaped as `effectivePlayoutOffsetNs` reads them. */
function services(opts: { engineMs?: number; routeMs?: number } = {}) {
    return {
        instanceId: 'aout-1',
        playoutOffsetMs: opts.engineMs ?? 300,
        mediaRouter: { getRoutePlayoutOffsetMs: vi.fn(() => opts.routeMs) },
    };
}

const MS = 1_000_000;

describe('audio302mTsOffsetNs', () => {
    it('is D minus the ring the sink declares', () => {
        expect(audio302mTsOffsetNs(services(), {})).toBe((300 - SINK_DECLARED_LATENCY_MS) * MS);
    });

    it('takes the route head override over the engine default', () => {
        expect(audio302mTsOffsetNs(services({ routeMs: 500 }), {})).toBe(
            (500 - SINK_DECLARED_LATENCY_MS) * MS,
        );
    });

    it('has no Lip-Sync Trim (B-249): a saved lipSyncMs moves nothing', () => {
        expect(audio302mTsOffsetNs(services(), { lipSyncMs: 40 })).toBe(200 * MS);
        expect(audio302mTsOffsetNs(services(), { lipSyncMs: -60 })).toBe(200 * MS);
    });

    it('has no mixer term: the aligned fan-in adds no latency to give back', () => {
        expect(audio302mTsOffsetNs.length).toBe(2);
        expect(audio302mTsOffsetNs(services(), { mixLatencyMs: 100 })).toBe(200 * MS);
    });

    it('never goes negative — a D under the ring clamps to 0', () => {
        expect(audio302mTsOffsetNs(services({ engineMs: 50 }), {})).toBe(0);
    });

    it('pins the ring the field tuning was measured against', () => {
        expect(SINK_BUFFER_US).toBe(100_000);
        expect(SINK_DECLARED_LATENCY_MS).toBe(100);
    });
});
