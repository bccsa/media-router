import { describe, it, expect } from 'vitest';
import type { TimeSyncState } from '@media-router/shared-types';
import type { EngineState } from '@/stores/engines';
import { engineClockIndicator } from './engineClock';

const SYNCED: TimeSyncState = {
    source: 'chrony',
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
/** A locked PTP box as the field has it (MR-031): linuxptp never sets the kernel's esterror. */
const PTP: Partial<TimeSyncState> = { source: 'ptp', estErrorUs: 16_000_000, maxErrorUs: 0 };
const SLAVE = { portState: 'SLAVE', offsetNs: -812, pathDelayNs: 41_231 };

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
            'Time traceable · source chrony · error ±250 µs · TAI−UTC 37 s · ' +
                'epoch #2 (sync) at 2026-10-13T08:00:00.000Z',
        );
    });

    it("prefers chrony's own error estimate and shows its reference, as before B-198", () => {
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
        expect(c.detail).toBe(
            'Time traceable · source chrony · error ±2.6 ms · TAI−UTC 37 s · ' +
                'ref ntp1.example.org (stratum 2) · epoch #2 (sync) at 2026-10-13T08:00:00.000Z',
        );
    });

    it("a PTP box shows PTP's offset from its master, not the kernel's unset 16 s", () => {
        const c = engineClockIndicator(engine({ ...PTP, ptp: SLAVE }))!;
        expect(c.level).toBe('ok');
        expect(c.detail).toBe(
            'Time traceable · source ptp · ' +
                'error ±812 ns (PTP offset from master, path delay 41.2 µs) · TAI−UTC 37 s · ' +
                'epoch #2 (sync) at 2026-10-13T08:00:00.000Z',
        );
    });

    it('a PTP box without a PTP figure shows none, whatever the kernel holds', () => {
        // An older engine, or ptp4l gave no answer.
        expect(engineClockIndicator(engine(PTP))!.detail).toContain(
            '· error n/a (PTP) · TAI−UTC 37 s ·',
        );
        // A slave-only box whose master went: ptp4l answers, its port follows no master.
        expect(
            engineClockIndicator(engine({ ...PTP, ptp: { portState: 'LISTENING' } }))!.detail,
        ).toContain('· error n/a (PTP port LISTENING) ·');
        // chrony's last figure, left in the kernel when PTP took the clock over, is not PTP's.
        expect(engineClockIndicator(engine({ ...PTP, estErrorUs: 2600 }))!.detail).toContain(
            '· error n/a (PTP) ·',
        );
        for (const ptp of [undefined, SLAVE, { portState: 'LISTENING' }])
            expect(engineClockIndicator(engine({ ...PTP, ptp }))!.detail).not.toMatch(
                /16000|16\.0 s/,
            );
    });

    it("a slave-only PTP box on the NTP fallback says so, in the Device Manager's words", () => {
        const chrony = {
            reference: 'ntp1.example.org',
            stratum: 2,
            estErrorUs: 2600,
            leap: 'Normal',
        };
        const c = engineClockIndicator(engine({ source: 'chrony', chrony, ntpFallback: true }))!;
        expect(c.level).toBe('ok');
        expect(c.detail).toBe(
            'Time traceable · No PTP master: on internet time (NTP) · error ±2.6 ms · ' +
                'TAI−UTC 37 s · ref ntp1.example.org (stratum 2) · ' +
                'epoch #2 (sync) at 2026-10-13T08:00:00.000Z',
        );
        // Whoever the last poll found running: the box's ptp4l start applied NTP.
        expect(
            engineClockIndicator(engine({ source: 'none', ntpFallback: true }))!.detail,
        ).toContain('Time traceable · No PTP master: on internet time (NTP) · error');
    });

    it('every other engine keeps its plain source', () => {
        // A PTP box on PTP, a grandmaster on chrony (status.env, no fallback).
        expect(
            engineClockIndicator(engine({ ...PTP, ptp: SLAVE, ntpFallback: false }))!.detail,
        ).toContain('Time traceable · source ptp · error');
        expect(engineClockIndicator(engine({ ntpFallback: false }))!.detail).toContain(
            'Time traceable · source chrony · error',
        );
        // A box without PTP, or an engine from before the field.
        for (const t of [{}, PTP, { source: 'none' as const }])
            expect(engineClockIndicator(engine(t))!.detail).not.toContain('No PTP master');
    });

    it("no daemon's figure: the kernel's, n/a while it is still the unset 16 s", () => {
        expect(engineClockIndicator(engine({ source: 'none' }))!.detail).toContain(
            '· error ±250 µs ·',
        );
        expect(
            engineClockIndicator(engine({ source: 'none', estErrorUs: 16_000_000 }))!.detail,
        ).toContain('· error n/a · TAI−UTC');
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
