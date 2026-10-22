import { describe, it, expect, vi, afterEach } from 'vitest';
import { IngestTimingReporter, isIngestTimingSection } from './ingestTimingReporter.js';
import {
    CH,
    MS,
    asrcStats,
    event,
    fakeHost,
    pidMsg,
    setup,
    stats,
} from './testing/ingestTimingFixtures.js';

type Reporter = IngestTimingReporter;
const LEAD = [300, 340, 420];

/** The element's reports every 2 s from `from` to `to`, each followed by the publication tick. */
function run(rep: Reporter, from: number, to: number, s: Record<string, unknown> = {}): void {
    for (let t = from; t <= to; t += 2000) {
        rep.onEvent(CH.stats, stats(s), t);
        rep.onEvent(CH.pid, pidMsg(256, 0x1b, LEAD), t);
        rep.onEvent(CH.pid, pidMsg(257, 0x0f, LEAD), t);
        rep.tick(t);
    }
}

describe('IngestTimingReporter: what the card follows', () => {
    afterEach(() => vi.useRealTimers());

    it('an outage reads No PCR and keeps the last values; a PID that left the PMT goes', () => {
        const { rep, card } = setup();
        run(rep, 2000, 2000);
        const sparse = {
            'cadence-warning': true,
            'pcr-gap-max-ns': 700 * MS,
            'pcr-cadence-ns': 40 * MS,
        };
        for (let t = 4000; t <= 10_000; t += 2000) {
            rep.onEvent(CH.stats, stats({ state: 'degraded', reason: 'freeze', ...sparse }), t);
            rep.onEvent(CH.pid, pidMsg(256, 0x1b, LEAD), t);
            rep.tick(t);
        }
        expect(card.sections.map((s) => s.id)).toEqual(['clock', 'pid-256']);
        expect(card.options.pids).toEqual([{ value: '256', label: '0x0100 H.264 video' }]);
        expect(card.warning).toMatch(
            /^Degraded clock: PCR frozen .*; PCR comes irregularly: gaps up to 700 ms, normally every 40 ms$/,
        );

        for (let t = 12_000; t <= 16_000; t += 2000) rep.tick(t);
        expect(card.badges.clock).toMatchObject({ text: 'Degraded' });
        rep.tick(18_000);
        expect(card.badges.clock).toEqual({ icon: 'clock', text: 'No PCR', color: '#f59e0b' });
        expect(card.data.clock.state).toBe('No PCR');
        expect(card.sections.map((s) => s.id)).toEqual(['clock', 'pid-256']);
        expect(card.data['pid-256'].lead).toBe('300 / 340 / 420');
        // Warnings describe a clock that is flowing; the badge says it is not.
        expect(card.warning).toBeNull();

        run(rep, 20_000, 20_000);
        expect(card.badges.clock).toMatchObject({ text: 'Locked' });
        expect(card.warning).toBeNull();
    });

    it('several programs get a Clock section each and the badge shows the worst', () => {
        const { rep, card } = setup();
        rep.onEvent(CH.stats, stats({ program: 2, state: 'acquiring' }), 2000);
        rep.onEvent(CH.stats, stats({ program: 1 }), 2000);
        rep.tick(2000);
        expect(card.sections.map((s) => [s.id, s.label])).toEqual([
            ['clock-1', 'Clock · program 1'],
            ['clock-2', 'Clock · program 2'],
        ]);
        expect(card.data['clock-2'].state).toBe('Acquiring');
        expect(card.badges.clock).toMatchObject({ text: 'Acquiring' });
        // Program 2 leaves the PAT; program 1 reports on.
        for (let t = 4000; t <= 10_000; t += 2000) {
            rep.onEvent(CH.stats, stats({ program: 1 }), t);
            rep.tick(t);
        }
        expect(card.sections.map((s) => s.id)).toEqual(['clock']);
        expect(card.badges.clock).toMatchObject({ text: 'Locked' });
    });

    it('withdraws the badge once no program reports, and shows it again when one does', () => {
        const { rep, card } = setup();
        run(rep, 2000, 2000);
        expect(card.badges.clock).toMatchObject({ text: 'Locked' });
        // The PIDs report on without their program: it leaves, and the badge with it.
        for (let t = 4000; t <= 10_000; t += 2000) {
            rep.onEvent(CH.pid, pidMsg(256, 0x1b, LEAD), t);
            rep.tick(t);
        }
        expect(card.sections.map((s) => s.id)).toEqual(['pid-256']);
        expect(card.badges).toEqual({});
        run(rep, 12_000, 12_000);
        expect(card.badges.clock).toMatchObject({ text: 'Locked' });
    });

    it('a program heard of only through events leaves like the others', () => {
        const { rep, card } = setup();
        // Program 2 is named by an event and sends no stats; program 1 reports on.
        rep.onEvent(CH.event, event('relock', { program: 2, reason: 'leap' }), 2000);
        run(rep, 2000, 10_000);
        expect(card.sections.map((s) => s.id)).toEqual(['clock', 'pid-256', 'pid-257']);
        // When it does report, its card starts clean: the old event left with it.
        rep.onEvent(CH.stats, stats({ program: 2 }), 12_000);
        run(rep, 12_000, 12_000);
        expect(card.data['clock-2'].lastEvent).toBe('—');
    });

    it('counts dropped PES over the last 10 min, and from 0 after an element restart', () => {
        const { rep, card } = setup();
        const drop = (t: number, n: number) => {
            rep.onEvent(CH.pid, pidMsg(256, 0x1b, LEAD, { 'dropped-pes': n }), t);
            rep.tick(t);
        };
        drop(2000, 0);
        drop(4000, 5);
        drop(6000, 7);
        drop(300_000, 7);
        expect(card.data['pid-256'].dropped).toBe(7);
        drop(606_000, 7);
        expect(card.data['pid-256'].dropped).toBe(0);
        drop(608_000, 2);
        expect(card.data['pid-256'].dropped).toBe(2);
    });
});

describe('IngestTimingReporter: throttling', () => {
    it("an event's age republishes once a minute for an hour, then hourly", () => {
        const { rep, card } = setup();
        rep.onEvent(CH.event, event('relock', { reason: 'leap' }), 1000);
        run(rep, 2000, 2000, { relocks: 1 });
        expect(card.data.clock.lastEvent).toBe('relock (PCR jump), just now');
        const publishes: Array<[number, unknown]> = [];
        let emits = card.emits;
        for (let t = 4000; t <= 7_400_000; t += 2000) {
            run(rep, t, t, { relocks: 1 });
            if (card.emits === emits) continue;
            publishes.push([t, card.data.clock.lastEvent]);
            emits = card.emits;
        }
        const minutes = Array.from({ length: 59 }, (_, i): [number, unknown] => [
            62_000 + i * 60_000,
            `relock (PCR jump), ${i + 1} min ago`,
        ]);
        expect(publishes).toEqual([
            ...minutes,
            [3_602_000, 'relock (PCR jump), 1 h ago'],
            [7_202_000, 'relock (PCR jump), 2 h ago'],
        ]);
    });
});

describe('IngestTimingReporter: the warnings of part 10', () => {
    it('a lead clamp warns for a minute after its event', () => {
        const { rep, card } = setup();
        rep.onEvent(CH.event, event('lead-clamp', { pid: 257 }), 2000);
        run(rep, 4000, 4000);
        expect(card.warning).toBe('Source lead above 4 s on PID 0x0101 — clamped');
        rep.onEvent(CH.event, event('lead-clamp', { pid: 256 }), 5000);
        run(rep, 6000, 6000);
        expect(card.warning).toBe('Source lead above 4 s on PID 0x0100, 0x0101 — clamped');
        expect(card.data.clock.lastEvent).toBe('lead clamp, just now');
        run(rep, 8000, 62_000);
        expect(card.warning).toBe('Source lead above 4 s on PID 0x0100, 0x0101 — clamped');
        run(rep, 64_000, 64_000);
        expect(card.warning).toBe('Source lead above 4 s on PID 0x0100 — clamped');
        run(rep, 66_000, 66_000);
        expect(card.warning).toBeNull();
    });

    it('more than 3 re-locks in 10 min: unstable, naming the last reason', () => {
        const { rep, card } = setup();
        const relock = (t: number, reason: string) =>
            rep.onEvent(CH.event, event('relock', { reason }), t);
        relock(1000, 'discontinuity');
        relock(2000, 'leap');
        relock(3000, 'leap');
        run(rep, 4000, 4000, { relocks: 3 });
        expect(card.warning).toBeNull();
        relock(5000, 'envelope-step');
        run(rep, 6000, 6000, { relocks: 4 });
        expect(card.warning).toBe(
            'Source clock unstable: 4 re-locks in 10 min (last: network delay step)',
        );
        expect(card.data.clock).toMatchObject({
            relocks: 4,
            lastEvent: 'relock (network delay step), just now',
        });
        run(rep, 8000, 600_000, { relocks: 4 });
        expect(card.warning).not.toBeNull();
        run(rep, 602_000, 602_000, { relocks: 4 });
        expect(card.warning).toBeNull();
    });

    it("a reconnect backlog's drop reads as such in the last event", () => {
        const { rep, card } = setup();
        rep.onEvent(CH.event, event('overlap', { pid: 256, reason: 'backlog' }), 1000);
        run(rep, 2000, 2000);
        expect(card.data.clock).toMatchObject({
            lastEvent: 'overlap (reconnect backlog), just now',
        });
        expect(card.warning).toBeNull();
    });

    it('a source rate past 100 ppm for a minute', () => {
        const { rep, card } = setup();
        run(rep, 2000, 60_000, { ppb: -150_000 });
        expect(card.data.clock.sourceRate).toBe(-150);
        expect(card.warning).toBeNull();
        run(rep, 62_000, 62_000, { ppb: -150_000 });
        expect(card.warning).toBe('Source clock off by 150 ppm');
        run(rep, 64_000, 64_000, { ppb: 1000 });
        expect(card.warning).toBeNull();
    });

    it("degraded, the re-lock and rate alarms name the reference PID's timing, not the source clock", () => {
        const { rep, card } = setup();
        rep.onEvent(CH.event, event('degraded', { pid: 100, reason: 'lead' }), 1000);
        const deg = { state: 'degraded', reason: 'lead', ppb: -242_300 };
        for (const t of [2000, 3000, 4000, 5000]) {
            rep.onEvent(CH.event, event('relock', { reason: 'envelope-step' }), t);
        }
        run(rep, 6000, 66_000, deg);
        expect(card.warning).toBe(
            'Degraded clock: lead out of range — timing from PID 0x0064 PTS against arrival; ' +
                'Timing from PID 0x0064 PTS unstable: 4 re-locks in 10 min (last: network delay step); ' +
                'Timing from PID 0x0064 PTS off by 242 ppm',
        );
        // Back on the PCR the re-lock alarm is the source clock's again, and the rate's hold
        // starts over: the minute behind it was the reference lock's.
        rep.onEvent(CH.event, event('recovered', { reason: 'lead' }), 67_000);
        run(rep, 68_000, 126_000, { ppb: -150_000 });
        expect(card.warning).toBe(
            'Source clock unstable: 4 re-locks in 10 min (last: network delay step)',
        );
        run(rep, 128_000, 128_000, { ppb: -150_000 });
        expect(card.warning).toBe(
            'Source clock unstable: 4 re-locks in 10 min (last: network delay step); Source clock off by 150 ppm',
        );
    });

    it('one late PCR interval warns, with its gap and the usual cadence', () => {
        const { rep, card } = setup();
        const late = {
            'cadence-warning': true,
            'pcr-gap-max-ns': 4002 * MS,
            'pcr-cadence-ns': 2000 * MS,
        };
        run(rep, 2000, 2000, late);
        expect(card.warning).toBe('PCR comes irregularly: gaps up to 4.0 s, normally every 2.0 s');
        run(rep, 4000, 4000);
        expect(card.warning).toBeNull();
    });

    it('a steady sparse PCR reads Locked with its cadence, no warning (B-86)', () => {
        const { rep, card } = setup();
        run(rep, 2000, 2000, { 'pcr-cadence-ns': 2000 * MS });
        expect(card.badges.clock).toEqual({ icon: 'clock', text: 'Locked', color: '#10b981' });
        expect(card.data.clock.state).toBe('Locked (PCR every 2.0 s)');
        expect(card.warning).toBeNull();
        run(rep, 4000, 4000, { state: 'acquiring', 'pcr-cadence-ns': 2000 * MS });
        expect(card.data.clock.state).toBe('Acquiring (PCR every 2.0 s)');
        run(rep, 6000, 6000, { 'pcr-cadence-ns': 600 * MS });
        expect(card.data.clock.state).toBe('Locked (PCR every 600 ms)');
        run(rep, 8000, 8000);
        expect(card.data.clock.state).toBe('Locked');
    });

    it('degraded on the cadence row says PCR missing, and the irregular text is not repeated', () => {
        const { rep, card } = setup();
        rep.onEvent(CH.event, event('degraded', { reason: 'cadence', pid: 257 }), 1000);
        run(rep, 2000, 2000, {
            state: 'degraded',
            reason: 'cadence',
            'cadence-warning': true,
            'pcr-gap-max-ns': 12 * 1000 * MS,
            'pcr-cadence-ns': 2000 * MS,
        });
        expect(card.data.clock.state).toBe('Degraded (PCR missing)');
        expect(card.warning).toBe(
            'Degraded clock: PCR missing — timing from PID 0x0101 PTS against arrival',
        );
    });

    it('transport errors rising for 10 s; a single glitch does not warn', () => {
        const glitch = setup();
        run(glitch.rep, 2000, 2000);
        run(glitch.rep, 4000, 40_000, { 'cc-lost': 3 });
        expect(glitch.card.warns).toBe(0);

        const { rep, card } = setup();
        const at = (t: number) => ({
            'cc-lost': t / 1000 - 2,
            'desync-bytes': 47 * (t / 1000 - 2),
        });
        for (let t = 2000; t <= 12_000; t += 2000) run(rep, t, t, at(t));
        expect(card.warning).toBeNull();
        run(rep, 14_000, 14_000, at(14_000));
        expect(card.warning).toBe(
            'Transport errors: 10 continuity errors, 470 bytes out of sync in 10 s',
        );
        run(rep, 16_000, 22_000, at(14_000));
        expect(card.warning).toBe(
            'Transport errors: 2 continuity errors, 94 bytes out of sync in 10 s',
        );
        run(rep, 24_000, 24_000, at(14_000));
        expect(card.warning).toBeNull();
    });

    it('an element restart inside a rising streak keeps the errors it counted', () => {
        const { rep, card } = setup();
        for (let t = 2000; t <= 14_000; t += 2000) run(rep, t, t, { 'cc-lost': t / 1000 - 2 });
        expect(card.warning).toBe('Transport errors: 10 continuity errors in 10 s');
        // The element restarts and counts from 0: the errors before it stay in the window.
        run(rep, 16_000, 16_000, { 'cc-lost': 0 });
        expect(card.warning).toBe('Transport errors: 8 continuity errors in 10 s');
        run(rep, 18_000, 18_000, { 'cc-lost': 5 });
        expect(card.warning).toBe('Transport errors: 11 continuity errors in 10 s');
    });

    it('several at once share the health text', () => {
        const { rep, card } = setup();
        rep.onEvent(CH.event, event('lead-clamp', { pid: 257 }), 1000);
        run(rep, 2000, 2000, {
            state: 'degraded',
            reason: 'lead',
            'cadence-warning': true,
            'pcr-gap-max-ns': 700 * MS,
        });
        expect(card.warning).toBe(
            "Degraded clock: lead out of range — timing from the reference PID's PTS against " +
                'arrival; PCR comes irregularly: gaps up to 700 ms, normally every 40 ms; ' +
                'Source lead above 4 s on PID 0x0101 — clamped',
        );
    });
});

describe('IngestTimingReporter: a capture card', () => {
    it('shows the ASRC and the ingest offset; no badge, no PID options', () => {
        const { rep, card } = setup('fixed');
        const ratio = { 'ratio-ppb': -21_500, 'phase-err-ns': 0.3 * MS, relocks: 1 };
        rep.onEvent(CH.asrc, asrcStats(ratio), 2000);
        rep.onEvent(CH.pid, pidMsg(256, 0x06, [0, 0, 0], { 'shift-ns': -40 * MS }), 2000);
        rep.onEvent(CH.stats, stats(), 2000);
        rep.tick(2000);
        expect(card.sections).toEqual([
            {
                id: 'clock',
                label: 'Clock',
                fields: [
                    { key: 'asrcRatio', label: 'ASRC ratio', unit: 'ppm' },
                    { key: 'phaseError', label: 'Phase error', unit: 'ms' },
                    { key: 'relocks', label: 'Re-locks' },
                    { key: 'ingestOffset', label: 'Ingest offset', unit: 'ms' },
                ],
            },
        ]);
        expect(card.data.clock).toEqual({
            asrcRatio: -21.5,
            phaseError: 0,
            relocks: 1,
            ingestOffset: -40,
        });
        expect(card.badges).toEqual({});
        expect(card.options).toEqual({});
    });

    it('a device clock past 200 ppm for a minute warns; its events are logged', () => {
        const { rep, card } = setup('fixed');
        for (let t = 2000; t <= 62_000; t += 2000) {
            rep.onEvent(CH.asrc, asrcStats({ 'ratio-ppb': 250_000 }), t);
            rep.tick(t);
            if (t === 60_000) expect(card.warning).toBeNull();
        }
        expect(card.warning).toBe("Device clock off by 250 ppm — check the device's sample rate");
        rep.onEvent(CH.asrcEvent, { kind: 'ratio-out-of-bounds', reason: '' }, 63_000);
        rep.onEvent(CH.asrcEvent, { kind: 'relock', reason: 'discont' }, 64_000);
        expect(card.logs.map(([level, , msg]) => [level, msg])).toEqual([
            ['warn', 'mrasrc-event ratio-out-of-bounds'],
            ['info', 'mrasrc-event relock (discont)'],
        ]);
    });
});

describe('IngestTimingReporter: lifecycle', () => {
    afterEach(() => vi.useRealTimers());

    it('re-raises its warning after PLAYING and forgets everything on stop', () => {
        const { rep, card } = setup();
        run(rep, 2000, 2000, { state: 'degraded', reason: 'rate' });
        const text =
            "Degraded clock: PCR rate out of range — timing from the reference PID's PTS against arrival";
        expect(card.warning).toBe(text);
        card.warning = null; // PLAYING set health ok
        rep.reassert();
        expect(card.warning).toBe(text);
        rep.stop();
        const emits = card.emits;
        rep.tick(4000);
        rep.reassert();
        expect(card.emits).toBe(emits);
    });

    it('publishes by itself every stats interval while started', () => {
        vi.useFakeTimers();
        const { rep, card } = setup();
        rep.start();
        rep.onEvent(CH.stats, stats());
        expect(card.sections).toEqual([]);
        vi.advanceTimersByTime(2000);
        expect(card.badges.clock).toMatchObject({ text: 'Locked' });
        rep.stop();
        rep.onEvent(CH.stats, stats({ state: 'degraded' }));
        vi.advanceTimersByTime(10_000);
        expect(card.badges.clock).toMatchObject({ text: 'Locked' });
    });

    it("re-sends its sections whole on a change, after another writer replaced the module's", () => {
        const { rep, card } = setup();
        run(rep, 2000, 2000);
        card.sections = []; // e.g. srt-input's stop/error handler: setDynamicSections([])
        card.data = {};
        rep.onEvent(CH.stats, stats({ 'residual-p99-ns': 9 * MS }), 4000);
        rep.tick(4000);
        expect(card.sections.map((s) => s.id)).toEqual(['clock', 'pid-256', 'pid-257']);
        expect(Object.keys(card.data)).toEqual(['clock', 'pid-256', 'pid-257']);
    });

    it("takes only its own elements' channels, under the names it was given", () => {
        const { host, card } = fakeHost();
        const rep = new IngestTimingReporter(host, { mode: 'stc', restamp: 'rs' });
        expect(rep.onEvent('mrtsrestamp-stats:restamp', stats(), 2000)).toBe(false);
        expect(rep.onEvent('mrlateness:lat_busout_41000', {}, 2000)).toBe(false);
        expect(rep.onEvent('mrtsrestamp-stats:rs', stats(), 2000)).toBe(true);
        rep.tick(2000);
        expect(card.badges.clock).toMatchObject({ text: 'Locked' });
    });

    it('names its sections so a module can merge them with its own', () => {
        expect(['clock', 'clock-2', 'pid-256'].every(isIngestTimingSection)).toBe(true);
        const theirs = ['caller-0', 'peer-1', 'timing', 'pid-0x100', 'clocks', 'stats'];
        expect(theirs.some(isIngestTimingSection)).toBe(false);
    });
});
