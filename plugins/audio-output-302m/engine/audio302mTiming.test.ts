import { describe, it, expect, vi } from 'vitest';
import {
    audio302mTsOffsetNs,
    SINK_BUFFER_US,
    SINK_DECLARED_LATENCY_MS,
    SLAVE_METHOD_SKEW,
} from './audio302mTiming.js';

/** Services shaped as `effectivePlayoutOffsetNs` reads them. */
function services(opts: { contract?: boolean; engineMs?: number; routeMs?: number } = {}) {
    return {
        instanceId: 'aout-1',
        ...(opts.contract === false ? {} : { timeSyncContract: true }),
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

    it('stacks the lipSyncMs trim on top, either sign', () => {
        expect(audio302mTsOffsetNs(services(), { lipSyncMs: 40 })).toBe(240 * MS);
        expect(audio302mTsOffsetNs(services(), { lipSyncMs: -60 })).toBe(140 * MS);
    });

    it('subtracts the mixer arm aggregation latency too, so both arms land on D', () => {
        expect(audio302mTsOffsetNs(services(), {}, 100 * MS)).toBe(100 * MS);
        // Single-source arm declares none.
        expect(audio302mTsOffsetNs(services(), {}, 0)).toBe(200 * MS);
    });

    it('never goes negative — a trim or a latency past D clamps to 0', () => {
        expect(audio302mTsOffsetNs(services(), { lipSyncMs: -2000 })).toBe(0);
        expect(audio302mTsOffsetNs(services(), {}, 5000 * MS)).toBe(0);
        expect(audio302mTsOffsetNs(services({ engineMs: 50 }), {})).toBe(0);
    });

    it('off the contract D collapses to the trim alone (the module then never consults it)', () => {
        // Legacy resolution: no D, just the trim — the ring is still taken off
        // and the floor still holds. AudioOutput302mModule only calls this on
        // the contract path; off it the sink is `sync=false` with no ts-offset.
        expect(audio302mTsOffsetNs(services({ contract: false }), { lipSyncMs: 400 })).toBe(
            300 * MS,
        );
        expect(audio302mTsOffsetNs(services({ contract: false }), { lipSyncMs: 40 })).toBe(0);
    });

    it('pins the ring and the skew slaving the field tuning was measured against', () => {
        expect(SINK_BUFFER_US).toBe(100_000);
        expect(SINK_DECLARED_LATENCY_MS).toBe(100);
        expect(SLAVE_METHOD_SKEW).toBe(1);
    });
});
