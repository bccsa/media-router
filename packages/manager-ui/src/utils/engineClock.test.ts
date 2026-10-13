import { describe, it, expect } from 'vitest';
import type { TimeSyncState } from '@media-router/shared-types';
import type { EngineState } from '@/stores/engines';
import { engineClockIndicator } from './engineClock';

const SYNCED: TimeSyncState = {
    source: 'ptp',
    synced: true,
    traceable: true,
    taiOffsetS: 37,
    estErrorUs: 250,
    maxErrorUs: 9000,
    freqPpm: -1.2,
    waitingForSync: false,
    epochSeq: 2,
    epochLatchedAt: '2026-10-13T08:00:00.000Z',
    epochReason: 'sync',
    sidecar: true,
};

function engine(timeSync: Partial<TimeSyncState>, features = ['house-clock']): EngineState {
    return {
        engineId: 'e',
        name: 'E',
        online: true,
        running: true,
        activeProfile: null,
        modules: {},
        connections: [],
        interlocks: [],
        groupId: 'ungrouped',
        sortOrder: 0,
        features,
        system: { cpu: 0, mem: 0, temp: null, timeSync: { ...SYNCED, ...timeSync } },
    };
}

describe('engineClockIndicator', () => {
    it('tooltip names source, error, TAI−UTC and the epoch (seq, reason, when)', () => {
        const c = engineClockIndicator(engine({}))!;
        expect(c.level).toBe('ok');
        expect(c.detail).toBe(
            'Time traceable · source ptp · error ±250 µs · TAI−UTC 37 s · ' +
                'epoch #2 (sync) at 2026-10-13T08:00:00.000Z',
        );
    });

    it("prefers chrony's own error estimate and shows its reference", () => {
        const c = engineClockIndicator(
            engine({
                source: 'chrony',
                chrony: {
                    reference: 'ntp1.example.org',
                    stratum: 2,
                    estErrorUs: 2600,
                    leap: 'Normal',
                },
            }),
        )!;
        expect(c.detail).toContain('error ±2.6 ms');
        expect(c.detail).toContain('ref ntp1.example.org (stratum 2)');
    });

    it('red with a reason when mr-clockstate is missing', () => {
        const c = engineClockIndicator(
            engine({ sidecar: false, synced: false, traceable: false, epochSeq: 0 }),
        )!;
        expect(c.level).toBe('error');
        expect(c.label).toMatch(/mr-clockstate missing/);
        expect(c.detail).toContain('no epoch yet');
    });

    it('null for an engine that does not announce house-clock', () => {
        expect(engineClockIndicator(engine({}, []))).toBeNull();
    });
});
