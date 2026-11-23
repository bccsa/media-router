import { describe, it, expect, vi } from 'vitest';
import type { HouseClockFields } from '../clock/houseClockProperty.js';
import {
    EGRESS_AT_MAX_TEXT,
    EGRESS_E_UNKNOWN_TEXT,
    EGRESS_UNSTABLE_TEXT,
    EgressTimingReporter,
    MRHT_TEXT,
    buildEgressWriter,
    egressBusReports,
    netTimeText,
} from './egressTiming.js';
import { ModuleTiming, type ModuleTimingHost } from './moduleTiming.js';
import { timingPublication } from './timingSections.js';

const MS = 1_000_000;
const STATS = 'mrtsegress-stats:egress';
const EVENT = 'mrtsegress-event:egress';

const CHRONY: HouseClockFields = {
    eNs: 1_760_283_215_123_456_789n,
    seq: 3,
    traceable: true,
    disciplined: true,
    source: 'ntp',
    errorUs: 1200,
    taiOffsetS: 37,
    ptpDomain: -1,
    gm: '',
};
const NO_E: HouseClockFields = { ...CHRONY, eNs: 0n, seq: 0, traceable: false, source: 'none' };

/** One programme's `mrtsegress-stats`, field for field as gstmrtsegress.cpp posts it. */
function stats(o: {
    dE: number;
    inserted: number;
    packets: number;
    intervalMs?: number;
    seq?: number;
    traceable?: boolean;
    merged?: number;
}) {
    return {
        program: 1,
        'pcr-pid': 256,
        'd-e-ns': o.dE * MS,
        'pcr-written': o.inserted * 3,
        'pcr-inserted': o.inserted,
        'pcr-interval-max-ns': (o.intervalMs ?? 35) * MS,
        'pmt-rewritten': 20,
        'pmt-version': 1,
        'pes-rewritten': 400,
        'd-e-changes': 0,
        'lateness-off-house': 0,
        packets: o.packets,
        'bytes-in': o.packets * 188,
        'bytes-out': o.packets * 188,
        'epoch-seq': o.seq ?? 3,
        traceable: o.traceable ?? true,
        'timeline-id': '0000000000000000',
        'merged-buffers': o.merged ?? 0,
        'proc-ns-per-packet': 100,
        'lateness-min-ns': 10 * MS,
        'lateness-mean-ns': 20 * MS,
        'lateness-max-ns': 40 * MS,
    };
}

/** One `mrtsegress-event`, every field the element posts. */
function event(
    kind: string,
    o: {
        from?: number;
        to?: number;
        lateness?: number;
        gap?: number;
        seq?: number;
        fromSeq?: number;
        deltaMs?: number;
    } = {},
) {
    return {
        kind,
        program: 1,
        pid: 256,
        'from-ns': (o.from ?? 0) * MS,
        'to-ns': (o.to ?? 0) * MS,
        'lateness-ns': (o.lateness ?? 0) * MS,
        'gap-ns': (o.gap ?? 0) * MS,
        seq: o.seq ?? 0,
        'from-seq': o.fromSeq ?? 0,
        'delta-ns': (o.deltaMs ?? 0) * MS,
        'in-packets': 7,
        'out-packets': 8,
    };
}

describe('buildEgressWriter and egressBusReports', () => {
    it('names the writer `egress` and carries the house-clock property and timeline id as given', () => {
        expect(
            buildEgressWriter({
                houseClock: 'house-clock="house-clock, seq=(uint)1"',
                timelineId: '0123456789abcdef',
            }),
        ).toBe(
            'mrtsegress name=egress house-clock="house-clock, seq=(uint)1" timeline-id=0123456789abcdef',
        );
        expect(
            buildEgressWriter({
                name: 'w2',
                houseClock: 'house-clock=""',
                timelineId: '0000000000000000',
            }),
        ).toBe('mrtsegress name=w2 house-clock="" timeline-id=0000000000000000');
        expect(egressBusReports('w2')).toEqual([
            { element: 'w2', structure: 'mrtsegress-stats' },
            { element: 'w2', structure: 'mrtsegress-event' },
        ]);
    });
});

describe('netTimeText', () => {
    it('TAI with epoch, source and error; else why not', () => {
        expect(netTimeText(true, 3, CHRONY)).toBe('TAI, epoch 3, chrony, ≤ 2 ms');
        expect(netTimeText(true, 3, { ...CHRONY, errorUs: 300 })).toBe(
            'TAI, epoch 3, chrony, ≤ 1 ms',
        );
        expect(netTimeText(true, 4, { ...CHRONY, source: 'ptp', errorUs: undefined })).toBe(
            'TAI, epoch 4, PTP, error unknown',
        );
        expect(netTimeText(false, 0, NO_E)).toBe('Not traceable (no house time)');
        expect(netTimeText(true, 3, null)).toBe('Not traceable (no house time)');
        expect(netTimeText(false, 3, { ...CHRONY, traceable: false })).toBe(
            'Not traceable (clock not traceable to TAI)',
        );
        expect(netTimeText(false, 3, { ...CHRONY, disciplined: false })).toBe(
            'Not traceable (clock not synchronised)',
        );
    });
});

describe('EgressTimingReporter on a writer sequence (start, raise, lower, max)', () => {
    it('gives the rows, the log lines and one warning raised and cleared', () => {
        const r = new EgressTimingReporter(2000);
        const t0 = 1_000_000;
        expect(r.summary(t0, CHRONY)).toBeUndefined(); // nothing before the first stats
        const logs = [
            ...r.onEvent(EVENT, event('d-e-start', { from: 250, to: 300, lateness: 12 }), t0)!,
            ...r.onEvent(STATS, stats({ dE: 300, inserted: 0, packets: 1000 }), t0)!,
            ...r.onEvent(
                EVENT,
                event('d-e-raise', { from: 300, to: 950, lateness: 812 }),
                t0 + 1000,
            )!,
            ...r.onEvent(
                STATS,
                stats({ dE: 950, inserted: 50, packets: 2000, intervalMs: 52 }),
                t0 + 2000,
            )!,
        ];
        expect(logs.map((l) => l.msg)).toEqual([
            'Egress D_e 300 ms at start (lateness 12 ms)',
            'Egress D_e 300 → 950 ms (lateness 812 ms)',
            'Egress PCR interval 52 ms, over 40 ms (logged once an hour)',
        ]);
        expect(r.summary(t0 + 2000, CHRONY)).toEqual({
            delayMs: 950,
            delayChanges: 1,
            pcrIntervalMaxMs: 52,
            pcrInsertedPerS: 25,
            pcrLateWindows: 1,
            reEpochs: 0,
            netTime: 'TAI, epoch 3, chrony, ≤ 2 ms',
            traceable: true,
            descriptor: MRHT_TEXT,
        });
        expect(r.warning(t0 + 2000, CHRONY)).toBeNull();

        // Three more changes inside 10 min: four, past part 10's three.
        r.onEvent(EVENT, event('d-e-lower', { from: 950, to: 700, gap: 2000 }), t0 + 60_000);
        r.onEvent(EVENT, event('d-e-raise', { from: 700, to: 900, lateness: 760 }), t0 + 120_000);
        const lower = r.onEvent(
            EVENT,
            event('d-e-lower', { from: 900, to: 400, gap: 3000 }),
            t0 + 180_000,
        )!;
        expect(lower[0].msg).toBe('Egress D_e 900 → 400 ms (gap 3000 ms)');
        r.onEvent(STATS, stats({ dE: 400, inserted: 60, packets: 3000 }), t0 + 180_000);
        expect(r.warning(t0 + 180_000, CHRONY)).toBe(EGRESS_UNSTABLE_TEXT(4));
        expect(r.summary(t0 + 180_000, CHRONY)?.delayChanges).toBe(4);
        // It stands while any change is under 10 min old, then clears by itself.
        const keep = (at: number) =>
            r.onEvent(STATS, stats({ dE: 400, inserted: 60, packets: 3000 }), at);
        keep(t0 + 650_000);
        expect(r.warning(t0 + 650_000, CHRONY)).toBe(EGRESS_UNSTABLE_TEXT(3));
        keep(t0 + 781_000);
        expect(r.warning(t0 + 781_000, CHRONY)).toBeNull();
        expect(r.summary(t0 + 781_000, CHRONY)?.delayChanges).toBe(0);
    });

    it('held at max: a warning until D_e is lowered; a re-epoch counted and logged', () => {
        const r = new EgressTimingReporter(2000);
        r.onEvent(EVENT, event('d-e-start', { to: 300 }), 0);
        r.onEvent(STATS, stats({ dE: 300, inserted: 0, packets: 10 }), 0);
        const max = r.onEvent(EVENT, event('d-e-max', { from: 500, to: 500, lateness: 900 }), 100)!;
        expect(max).toEqual([
            expect.objectContaining({
                level: 'warn',
                msg: 'Egress D_e held at its max 500 ms (lateness 900 ms): receivers get late content',
            }),
        ]);
        expect(r.warning(100, CHRONY)).toBe(EGRESS_AT_MAX_TEXT);
        const re = r.onEvent(
            EVENT,
            event('re-epoch', { seq: 4, fromSeq: 3, deltaMs: 12.34 }),
            200,
        )!;
        expect(re[0].msg).toBe('Egress re-epoch on the wire: epoch 3 → 4 (E moved 12.3 ms)');
        r.onEvent(EVENT, event('d-e-lower', { from: 500, to: 300, gap: 600 }), 300);
        expect(r.warning(300, CHRONY)).toBeNull();
        expect(r.summary(300, CHRONY)?.reEpochs).toBe(1);
    });

    it('E unknown: not traceable, the warning while the writer reports', () => {
        const r = new EgressTimingReporter(2000);
        r.onEvent(STATS, stats({ dE: 250, inserted: 0, packets: 10, seq: 0, traceable: false }), 0);
        expect(r.summary(0, NO_E)).toMatchObject({
            netTime: 'Not traceable (no house time)',
            traceable: false,
        });
        expect(r.warning(0, NO_E)).toBe(EGRESS_E_UNKNOWN_TEXT);
        // Stale after three missed reports: no rows, no warning.
        expect(r.summary(6001, NO_E)).toBeUndefined();
        expect(r.warning(6001, NO_E)).toBeNull();
    });

    it('logs pcr-pid-assigned, pmt-grew, descriptor-dropped and merged buffers once each', () => {
        const r = new EgressTimingReporter(2000);
        const all = [
            ...r.onEvent(EVENT, event('pcr-pid-assigned'), 0)!,
            ...r.onEvent(EVENT, event('pcr-pid-assigned'), 1)!,
            ...r.onEvent(EVENT, event('pmt-grew'), 2)!,
            ...r.onEvent(EVENT, event('descriptor-dropped'), 3)!,
            ...r.onEvent(EVENT, event('descriptor-dropped'), 4)!,
            ...r.onEvent(STATS, stats({ dE: 250, inserted: 0, packets: 10, merged: 1 }), 5)!,
            ...r.onEvent(STATS, stats({ dE: 250, inserted: 0, packets: 20, merged: 2 }), 6)!,
        ];
        expect(all.map((l) => l.msg)).toEqual([
            'Egress pcr-pid-assigned (programme 1, PID 256)',
            'Egress pmt-grew (programme 1, PID 256)',
            'Egress descriptor-dropped (programme 1, PID 256)',
            'Egress merged-buffers',
        ]);
        expect(r.summary(6, CHRONY)?.descriptor).toBe('Left out: the PMT would pass 1024 bytes');
    });

    it('a PCR interval over 40 ms counts only while data flows, and logs once an hour', () => {
        const r = new EgressTimingReporter(2000);
        const at = (t: number, packets: number) =>
            r.onEvent(STATS, stats({ dE: 250, inserted: 0, packets, intervalMs: 80 }), t)!;
        expect(at(0, 10)).toHaveLength(1);
        expect(at(2000, 10)).toHaveLength(0); // nothing flowed
        expect(at(4000, 20)).toHaveLength(0); // counted, not logged again
        expect(at(3_600_000, 30)).toHaveLength(1);
        expect(r.summary(3_600_000, CHRONY)?.pcrLateWindows).toBe(3);
    });

    it('takes only its own channels', () => {
        const r = new EgressTimingReporter();
        expect(r.onEvent('mrlateness:lat_egress', {})).toBeNull();
        expect(r.onEvent('mrrist-stats:ristsink', {})).toBeNull();
    });
});

describe('the egress rows in the timing section and the net-time badge', () => {
    it('rows with units; the badge only while not traceable', () => {
        const egress = {
            delayMs: 950.4,
            delayChanges: 1,
            pcrIntervalMaxMs: 35.2,
            pcrInsertedPerS: 24.6,
            pcrLateWindows: 0,
            reEpochs: 2,
            netTime: 'TAI, epoch 3, chrony, ≤ 2 ms',
            traceable: true,
            descriptor: MRHT_TEXT,
        };
        const pub = timingPublication({ inputs: [], instrument: true, egress });
        expect(pub.sections[0].fields).toEqual([
            { key: 'egressDelayMs', label: 'Egress delay', unit: 'ms' },
            { key: 'egressDelayChanges', label: 'Egress delay changes (10 min)' },
            { key: 'pcrIntervalMaxMs', label: 'PCR interval max', unit: 'ms' },
            { key: 'pcrInsertedPerS', label: 'PCR packets inserted', unit: '/s' },
            { key: 'pcrLateWindows', label: 'PCR intervals over 40 ms' },
            { key: 'reEpochs', label: 'Re-epochs' },
            { key: 'netTime', label: 'Network time' },
            { key: 'pmtDescriptor', label: 'PMT descriptor' },
        ]);
        expect(pub.data.timing).toEqual({
            egressDelayMs: 950,
            egressDelayChanges: 1,
            pcrIntervalMaxMs: 35,
            pcrInsertedPerS: 25,
            pcrLateWindows: 0,
            reEpochs: 2,
            netTime: 'TAI, epoch 3, chrony, ≤ 2 ms',
            pmtDescriptor: 'MRHT v1',
        });
        expect(pub.netTime).toBeNull();
        const off = timingPublication({
            inputs: [],
            instrument: true,
            egress: { ...egress, traceable: false, netTime: 'Not traceable (no house time)' },
        });
        expect(off.netTime).toEqual({
            id: 'net-time',
            icon: 'clock',
            text: 'Untraceable',
            color: '#f59e0b',
        });
    });
});

describe('ModuleTiming hosts the egress writer (S30)', () => {
    function rig(clock: HouseClockFields | null) {
        const host = {
            emit: vi.fn(),
            getProperty: vi.fn(),
            busSources: () => [],
            log: vi.fn(),
            houseClock: () => clock,
            egressWarnings: vi.fn(),
        } satisfies ModuleTimingHost;
        const t = new ModuleTiming(host);
        t.start({ pipeline: 'fakesrc ! fakesink' });
        return { t, host };
    }

    it("takes the writer's messages: rows in Timing, log lines, nothing passed on", () => {
        const { t, host } = rig(CHRONY);
        expect(t.onEvent(EVENT, event('d-e-start', { to: 300, lateness: 5 }))).toBe(true);
        expect(t.onEvent(STATS, stats({ dE: 300, inserted: 0, packets: 100 }))).toBe(true);
        expect(host.log).toHaveBeenCalledWith(
            'info',
            expect.anything(),
            'Egress D_e 300 ms at start (lateness 5 ms)',
        );
        expect(t.publication.data.timing).toMatchObject({
            egressDelayMs: 300,
            netTime: 'TAI, epoch 3, chrony, ≤ 2 ms',
        });
        expect(t.publication.netTime).toBeNull();
        expect(host.egressWarnings).toHaveBeenLastCalledWith(null);
        t.stop();
    });

    it('E unknown: the net-time badge and the warning; both go at stop', () => {
        const { t, host } = rig(NO_E);
        t.onEvent(STATS, stats({ dE: 250, inserted: 0, packets: 100, seq: 0, traceable: false }));
        expect(t.publication.netTime?.text).toBe('Untraceable');
        expect(host.egressWarnings).toHaveBeenLastCalledWith(EGRESS_E_UNKNOWN_TEXT);
        t.stop();
        expect(t.publication.netTime).toBeNull();
        expect(host.egressWarnings).toHaveBeenLastCalledWith(null);
        expect(t.summary()).toBeUndefined();
    });
});
