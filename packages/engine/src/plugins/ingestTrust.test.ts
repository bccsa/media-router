// The Trust section, badge, warnings and drain key of a network ingest (plan ch. 9 parts 8 and
// 10, WI-P5-11), through the reporter as a module drives it.
import { describe, it, expect } from 'vitest';
import { isIngestTimingSection } from './ingestTimingReporter.js';
import { CH, MS, setup, trustEvent, trustMsg } from './testing/ingestTimingFixtures.js';

const ID = '0123456789abcdef';
const ID2 = 'fedcba9876543210';

describe('the Trust section', () => {
    it('shows the mode, what is in effect, transit against the bound, L with its source and the sender', () => {
        const { rep, card } = setup();
        rep.setLatencySource('SRT negotiated');
        rep.onEvent(CH.trust, trustMsg(), 2000);
        rep.tick(2000);
        expect(card.sections.map((s) => s.id)).toEqual(['trust']);
        expect(card.sections[0].label).toBe('Trust');
        expect(card.data.trust).toEqual({
            mode: 'Trust',
            effective: 'Trust',
            failed: '—',
            transit: '40 / 52 / 70',
            bound: 2200,
            latency: 'SRT negotiated 2000 ms',
            ceiling: '2.2 s of 4 s',
            senderHouseTime: 'yes',
            senderSync: 'NTP, traceable',
            senderTaiUtc: '37 s',
            senderPtp: '—',
            senderError: '≤ 2.0 ms',
            senderDelay: 300,
            senderEpoch: 3,
            timeline: ID,
            lastSwitch: '—',
        });
        expect(card.badges.timing).toEqual({ icon: 'clock', text: 'Trust', color: '#10b981' });
        expect(card.warning).toBeNull();
    });

    it("a PTP sender's domain and grandmaster; an unknown error class; timeline 0 reads none", () => {
        const { rep, card } = setup();
        rep.onEvent(
            CH.trust,
            trustMsg({
                'decl-source': 'ptp',
                'decl-ptp-domain': 0,
                'decl-gm': '2C-CF-67-FF-FE-76-E6-69',
                'decl-error-class': 255,
                'decl-traceable': false,
                'decl-timeline-id': '0000000000000000',
            }),
            2000,
        );
        rep.tick(2000);
        expect(card.data.trust).toMatchObject({
            senderSync: 'PTP, not traceable',
            senderPtp: 'domain 0, grandmaster 2C-CF-67-FF-FE-76-E6-69',
            senderError: 'unknown',
            timeline: 'none',
            latency: '2000 ms',
        });
        // Under 1 ms the bound is in µs: class 9 is 512 µs.
        rep.onEvent(CH.trust, trustMsg({ 'decl-error-class': 9 }), 4000);
        rep.tick(4000);
        expect(card.data.trust.senderError).toBe('≤ 512 µs');
    });

    it('in Restamp it says whether the link would qualify, shows no badge and warns of nothing', () => {
        const { rep, card } = setup();
        rep.onEvent(CH.trust, trustMsg({ selected: 'restamp', effective: 'restamp' }), 2000);
        rep.tick(2000);
        expect(card.data.trust).toMatchObject({ mode: 'Restamp', qualify: 'yes' });
        expect('failed' in card.data.trust).toBe(false);
        expect(card.badges.timing).toBeUndefined();
        const high = {
            selected: 'restamp',
            effective: 'restamp',
            qualifies: false,
            failed: 'transit-high',
            'transit-max-ns': 37_000 * MS,
            'bound-ns': 4200 * MS,
        };
        rep.onEvent(CH.trust, trustMsg(high), 4000);
        rep.tick(4000);
        expect(card.data.trust.qualify).toBe('no (Transit 37.0 s above the 4.2 s bound)');
        // The ceiling warning is for a Trust selection only.
        expect(card.warning).toBeNull();
        expect(rep.drainOriginKey()).toBeUndefined();
    });

    it('converging shows what remains of k, and the last switch its size and age', () => {
        const { rep, card } = setup();
        rep.onEvent(CH.trust, trustMsg({ effective: 'returning' }), 2000);
        const sw = { reason: 'switch-to-trust', 'converging-ns': 2200 * MS, 'value-ns': 2200 * MS };
        rep.onEvent(CH.event, trustEvent('trust-switch', 'converging', 'returning', sw), 3000);
        rep.onEvent(
            CH.trust,
            trustMsg({ effective: 'converging', 'converging-remaining-ns': 1234 * MS }),
            4000,
        );
        rep.tick(4000);
        expect(card.data.trust.effective).toBe('Converging (1.2 s left)');
        expect(card.data.trust.lastSwitch).toBe('to Trust, converging 2.2 s, just now');
        expect(card.badges.timing).toMatchObject({ text: 'Converging' });
        rep.onEvent(
            CH.trust,
            trustMsg({ effective: 'converging', 'converging-remaining-ns': 640 * MS }),
            6000,
        );
        rep.tick(6000);
        expect(card.data.trust.effective).toBe('Converging (640 ms left)');
        // A fallback's switch leaves a gap.
        const fb = { reason: 'switch-to-restamp', failed: 'transit-high', 'gap-ns': 180 * MS };
        rep.onEvent(CH.event, trustEvent('trust-switch', 'fallback', 'trust', fb), 130_000);
        rep.onEvent(CH.trust, trustMsg({ effective: 'fallback' }), 130_000);
        rep.tick(130_000);
        expect(card.data.trust.lastSwitch).toBe('to Restamp, gap 180 ms, just now');
        rep.onEvent(CH.trust, trustMsg({ effective: 'fallback' }), 252_000);
        rep.tick(252_000);
        expect(card.data.trust.lastSwitch).toBe('to Restamp, gap 180 ms, 2 min ago');
    });
});

describe('the Trust warnings (part 10)', () => {
    it("the bound above the aligners' 4 s ceiling (S11): L + τ = 4.2 s warns while Trust is selected", () => {
        const { rep, card } = setup();
        const far = { 'l-ns': 4000 * MS, 'bound-ns': 4200 * MS };
        rep.onEvent(CH.trust, trustMsg(far), 2000);
        rep.tick(2000);
        expect(card.warning).toBe("Trust bound above the aligners' 4 s ceiling (4.2 s)");
        expect(card.data.trust.ceiling).toBe('4.2 s, above: aligners re-anchor this input');
        rep.onEvent(CH.trust, trustMsg({ 'l-ns': 3800 * MS, 'bound-ns': 4000 * MS }), 4000);
        rep.tick(4000);
        expect(card.warning).toBeNull();
        expect(card.data.trust.ceiling).toBe('4.0 s of 4 s');
    });

    it('Trust selected and never qualified: a standing warning after 60 s, gone once it qualifies', () => {
        const { rep, card } = setup();
        const none = {
            effective: 'fallback',
            qualifies: false,
            failed: 'no-descriptor',
            'decl-present': false,
        };
        rep.onEvent(CH.event, trustEvent('trust-fallback', 'fallback', 'deciding'), 1000);
        for (let t = 2000; t <= 60_000; t += 2000) {
            rep.onEvent(CH.trust, trustMsg(none), t);
            rep.tick(t);
        }
        // Trust showed first in the event at 1 s: the 60 s run from there.
        expect(card.warning).toBeNull();
        expect(card.badges.timing).toMatchObject({ text: 'Fallback', color: '#f59e0b' });
        rep.onEvent(CH.trust, trustMsg(none), 62_000);
        rep.tick(62_000);
        expect(card.warning).toBe(
            'Trust selected but stream does not qualify: no house-time descriptor',
        );
        expect(card.data.trust.failed).toBe('No house-time descriptor from the sender');
        rep.onEvent(CH.trust, trustMsg({ effective: 'returning' }), 64_000);
        rep.tick(64_000);
        expect(card.warning).toBeNull();
        expect(card.warns).toBe(1);
    });

    it('each failed condition in words', () => {
        const { rep, card } = setup();
        const cases: Array<[string, Record<string, unknown>, string]> = [
            ['not-house-time', {}, 'The sender does not declare house time'],
            ['sender-undisciplined', {}, "The sender's clock is not synchronised"],
            ['local-undisciplined', {}, "This box's clock is not synchronised"],
            [
                'transit-negative',
                { 'transit-min-ns': -40 * MS },
                'Transit -40 ms, below the -22 ms floor',
            ],
        ];
        let t = 2000;
        for (const [failed, o, words] of cases) {
            rep.onEvent(CH.trust, trustMsg({ qualifies: false, failed, ...o }), t);
            rep.tick(t);
            expect(card.data.trust.failed).toBe(words);
            t += 2000;
        }
    });

    it('a trust-fallback event is logged as a warning, a trust-switch as info', () => {
        const { rep, card } = setup();
        rep.onEvent(
            CH.event,
            trustEvent('trust-switch', 'fallback', 'trust', {
                reason: 'switch-to-restamp',
                failed: 'transit-high',
            }),
            1000,
        );
        rep.onEvent(
            CH.event,
            trustEvent('trust-fallback', 'fallback', 'trust', {
                reason: 'switch-to-restamp',
                failed: 'transit-high',
            }),
            1000,
        );
        rep.onEvent(CH.event, { ...trustEvent('sender-reepoch', '', ''), state: undefined }, 1500);
        expect(card.logs.map(([level, , msg]) => [level, msg])).toEqual([
            ['info', 'mrtsrestamp-event trust-switch (switch-to-restamp)'],
            ['warn', 'mrtsrestamp-event trust-fallback (switch-to-restamp)'],
            ['info', 'mrtsrestamp-event sender-reepoch'],
        ]);
    });
});

describe('drainOriginKey (for p5-20)', () => {
    it("is the sender's timeline in trust and converging only", () => {
        const { rep } = setup();
        const states = ['deciding', 'qualifying', 'fallback', 'returning', 'restamp'];
        let t = 2000;
        for (const effective of states) {
            const selected = effective === 'restamp' ? 'restamp' : 'trust';
            rep.onEvent(CH.trust, trustMsg({ selected, effective }), (t += 2000));
            expect(rep.drainOriginKey(), effective).toBeUndefined();
        }
        for (const effective of ['trust', 'converging']) {
            rep.onEvent(CH.trust, trustMsg({ effective }), (t += 2000));
            expect(rep.drainOriginKey(), effective).toBe(ID);
        }
        // An older writer, or a fixture with no timeline: id 0 is no key.
        rep.onEvent(CH.trust, trustMsg({ 'decl-timeline-id': '0000000000000000' }), (t += 2000));
        expect(rep.drainOriginKey()).toBeUndefined();
        rep.onEvent(CH.trust, trustMsg(), (t += 2000));
        expect(rep.drainOriginKey()).toBe(ID);
        // The transport dropped: off any timeline until the next report.
        rep.down(t);
        expect(rep.drainOriginKey()).toBeUndefined();
        rep.onEvent(CH.trust, trustMsg(), (t += 2000));
        expect(rep.drainOriginKey()).toBe(ID);
    });

    it('moves on the Trust events, before any further report: undefined at once after trust-fallback', () => {
        const { rep } = setup();
        rep.onEvent(CH.trust, trustMsg(), 2000);
        expect(rep.drainOriginKey()).toBe(ID);
        const fb = { reason: 'switch-to-restamp', failed: 'transit-high' };
        rep.onEvent(CH.event, trustEvent('trust-switch', 'fallback', 'trust', fb), 2500);
        rep.onEvent(CH.event, trustEvent('trust-fallback', 'fallback', 'trust', fb), 2500);
        expect(rep.drainOriginKey()).toBeUndefined();
        rep.onEvent(CH.event, trustEvent('trust-state', 'returning', 'fallback'), 12_500);
        expect(rep.drainOriginKey()).toBeUndefined();
        const back = { reason: 'switch-to-trust', 'converging-ns': 300 * MS };
        rep.onEvent(CH.event, trustEvent('trust-switch', 'converging', 'returning', back), 14_500);
        expect(rep.drainOriginKey()).toBe(ID);
    });

    it('an MPTS: defined when its Trust programmes share one id; undefined for two ids or one in fallback, logged once per change', () => {
        const { rep, card } = setup();
        const both = (t: number, a: Record<string, unknown>, b: Record<string, unknown>) => {
            rep.onEvent(CH.trust, trustMsg({ program: 1, ...a }), t);
            rep.onEvent(CH.trust, trustMsg({ program: 2, ...b }), t);
            rep.tick(t);
        };
        both(2000, {}, {});
        expect(rep.drainOriginKey()).toBe(ID);
        expect(card.sections.map((s) => [s.id, s.label])).toEqual([
            ['trust-1', 'Trust · program 1'],
            ['trust-2', 'Trust · program 2'],
        ]);
        both(4000, {}, { 'decl-timeline-id': ID2 });
        both(6000, {}, { 'decl-timeline-id': ID2 });
        expect(rep.drainOriginKey()).toBeUndefined();
        const logged = () => card.logs.filter(([, , msg]) => msg.startsWith('drain origin'));
        expect(logged().map(([, , msg]) => msg)).toEqual([
            `drain origin: programs disagree (program 1 trust ${ID}, program 2 trust ${ID2}); grouped by module`,
        ]);
        both(8000, {}, { effective: 'fallback', qualifies: false, failed: 'transit-high' });
        expect(rep.drainOriginKey()).toBeUndefined();
        expect(logged()).toHaveLength(2);
        expect(logged()[1][2]).toContain('program 2 fallback');
        both(10_000, {}, {});
        expect(rep.drainOriginKey()).toBe(ID);
        expect(logged()).toHaveLength(2);
        // Each program's warnings say which.
        both(12_000, {}, { 'l-ns': 4000 * MS, 'bound-ns': 4200 * MS });
        expect(card.warning).toBe("Program 2: Trust bound above the aligners' 4 s ceiling (4.2 s)");
    });

    it('a program gone from the stream leaves the key to the others', () => {
        const { rep } = setup();
        rep.onEvent(CH.trust, trustMsg({ program: 1 }), 2000);
        rep.onEvent(CH.trust, trustMsg({ program: 2, effective: 'fallback' }), 2000);
        expect(rep.drainOriginKey()).toBeUndefined();
        for (let t = 4000; t <= 10_000; t += 2000) {
            rep.onEvent(CH.trust, trustMsg({ program: 1 }), t);
            rep.tick(t);
        }
        expect(rep.drainOriginKey()).toBe(ID);
    });
});

describe('the reporter and the module', () => {
    it("the Trust sections are the reporter's; stop withdraws the timing badge", () => {
        expect(isIngestTimingSection('trust')).toBe(true);
        expect(isIngestTimingSection('trust-2')).toBe(true);
        expect(isIngestTimingSection('trusty')).toBe(false);
        const { rep, card } = setup();
        rep.onEvent(CH.trust, trustMsg(), 2000);
        rep.tick(2000);
        expect(card.badges.timing).toBeDefined();
        rep.stop();
        expect(card.badges.timing).toBeUndefined();
        expect(card.sections).toEqual([]);
        expect(rep.drainOriginKey()).toBeUndefined();
    });

    it('a capture reporter ignores Trust reports for its card', () => {
        const { rep, card } = setup('fixed');
        rep.onEvent(CH.trust, trustMsg(), 2000);
        rep.tick(2000);
        expect(card.sections).toEqual([]);
        expect(card.badges.timing).toBeUndefined();
    });
});
