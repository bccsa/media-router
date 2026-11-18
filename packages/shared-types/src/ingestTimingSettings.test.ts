import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    INGEST_OFFSET_KEY,
    PID_TRIMS_KEY,
    SMOOTHING_COOLDOWN_KEY,
    TIMING_MODE_KEY,
    TRUST_TOLERANCE_KEY,
    parseManifestTiming,
    withIngestTimingSettings,
    type ManifestTiming,
} from './index.js';

// The WI-P1-9 fragments, written out: bounds per OQ-14 and §5.5; the cooldown per b95s.
const OFFSET = {
    type: 'number',
    default: 0,
    minimum: -10000,
    maximum: 10000,
    'x-unit': 'ms',
    'x-live': true,
    title: 'Ingest Offset',
    description:
        'Moves this input on the house timeline: positive later, negative earlier. A live edit leaves a gap or drops overlap.',
};
const TRIMS = {
    type: 'object',
    additionalProperties: { type: 'number', minimum: -2000, maximum: 2000 },
    default: {},
    'x-widget': 'pidTrim',
    'x-optionsFrom': 'pids',
    'x-live': true,
    'x-unit': 'ms',
    title: 'Per-PID Trim',
    description:
        "Shifts one stream against the others, on top of Ingest Offset, to correct a source's fixed A/V error.",
};
// The owner's words (2026-10-23): latency only when the stream is bursty; while restamping (S6).
const COOLDOWN = {
    type: 'number',
    default: 5,
    minimum: 0,
    maximum: 60,
    'x-unit': 'min',
    'x-live': true,
    title: 'Smoothing Cooldown',
    description:
        "While restamping, adds latency only when this input's stream is bursty (packets arriving in bursts, as through some relays). The input then runs at its bursts' height and comes back down no sooner than this long after the last burst, instead of skipping and re-syncing after every burst. A steady stream gets no added latency. Set it longer than the time between bursts; 0 turns smoothing off.",
};
// Ch. 9 part 8 (WI-P5-11): the two Trust settings, and O and the trims greyed in Trust.
const MODE = {
    type: 'string',
    enum: ['restamp', 'trust'],
    'x-enumLabels': ['Restamp', 'Trust'],
    default: 'restamp',
    'x-live': true,
    title: 'Timing Mode',
    description:
        "Restamp lands the stream on arrival; Trust keeps the sender's timeline after checking it.",
};
const TOLERANCE = {
    type: 'number',
    minimum: 0,
    maximum: 10000,
    default: 200,
    'x-unit': 'ms',
    'x-live': true,
    'x-showWhen': 'timingMode=trust',
    title: 'Trust Tolerance',
    description: 'How far transit may exceed the link latency before Trust falls back to Restamp.',
};
const GREYED = {
    'x-disabledWhen': 'timingMode=trust',
    'x-disabledReason':
        "Trust keeps the sender's timeline. Switch Timing Mode to Restamp to set an offset.",
};
const NETWORK = { pidTrims: true, pcrLock: true, trust: true };
const CAPTURE = { pidTrims: false, pcrLock: false, trust: false };
const base = () => ({
    type: 'object',
    properties: { port: { type: 'number', default: 5000 } },
});
const props = (s: Record<string, unknown>) => s.properties as Record<string, unknown>;

describe('withIngestTimingSettings', () => {
    it('a network ingest gets Timing Mode, Trust Tolerance, Ingest Offset, Per-PID Trim and Smoothing Cooldown, after its own settings', () => {
        const schema = withIngestTimingSettings(base(), NETWORK);
        expect(schema).toEqual({
            type: 'object',
            properties: {
                port: { type: 'number', default: 5000 },
                timingMode: MODE,
                trustToleranceMs: TOLERANCE,
                ingestOffsetMs: { ...OFFSET, ...GREYED },
                pidTrimsMs: { ...TRIMS, ...GREYED },
                smoothingCooldownMin: COOLDOWN,
            },
        });
        expect(Object.keys(props(schema))).toEqual([
            'port',
            TIMING_MODE_KEY,
            TRUST_TOLERANCE_KEY,
            INGEST_OFFSET_KEY,
            PID_TRIMS_KEY,
            SMOOTHING_COOLDOWN_KEY,
        ]);
    });

    it('the two Trust settings and the greying come with trust alone (S6)', () => {
        const noTrust = props(withIngestTimingSettings(base(), { ...NETWORK, trust: false }));
        expect(Object.keys(noTrust)).toEqual([
            'port',
            INGEST_OFFSET_KEY,
            PID_TRIMS_KEY,
            SMOOTHING_COOLDOWN_KEY,
        ]);
        expect(noTrust[INGEST_OFFSET_KEY]).toEqual(OFFSET);
        expect(noTrust[PID_TRIMS_KEY]).toEqual(TRIMS);
        // Smoothing stays enabled in a Trust-selected ingest: no greying (E6).
        expect(props(withIngestTimingSettings(base(), NETWORK))[SMOOTHING_COOLDOWN_KEY]).toEqual(
            COOLDOWN,
        );
    });

    it('a capture gets Ingest Offset only (OQ-15)', () => {
        expect(withIngestTimingSettings(base(), CAPTURE)).toEqual({
            type: 'object',
            properties: { port: { type: 'number', default: 5000 }, ingestOffsetMs: OFFSET },
        });
    });

    it('Smoothing Cooldown follows pcrLock alone, never pidTrims', () => {
        const trimsOnly = props(
            withIngestTimingSettings(base(), { pidTrims: true, pcrLock: false, trust: false }),
        );
        expect(Object.keys(trimsOnly)).toEqual(['port', INGEST_OFFSET_KEY, PID_TRIMS_KEY]);
        const lockOnly = props(
            withIngestTimingSettings(base(), { pidTrims: false, pcrLock: true, trust: false }),
        );
        expect(Object.keys(lockOnly)).toEqual(['port', INGEST_OFFSET_KEY, SMOOTHING_COOLDOWN_KEY]);
        expect(lockOnly[SMOOTHING_COOLDOWN_KEY]).toEqual(COOLDOWN);
    });

    it('copies: the manifest schema is untouched and no fragment is shared', () => {
        const schema = base();
        const a = withIngestTimingSettings(schema, NETWORK);
        const b = withIngestTimingSettings(schema, NETWORK);
        expect(schema).toEqual(base());
        expect(props(a)[PID_TRIMS_KEY]).not.toBe(props(b)[PID_TRIMS_KEY]);
        expect(props(a)[SMOOTHING_COOLDOWN_KEY]).not.toBe(props(b)[SMOOTHING_COOLDOWN_KEY]);
        expect(withIngestTimingSettings({}, CAPTURE)).toEqual({
            properties: { ingestOffsetMs: OFFSET },
        });
    });

    it('one definition wins over a manifest that spells the key itself', () => {
        const own = {
            properties: {
                ingestOffsetMs: { type: 'number', maximum: 99 },
                smoothingCooldownMin: { type: 'number', default: 30 },
            },
        };
        const p = props(withIngestTimingSettings(own, NETWORK));
        expect(p.ingestOffsetMs).toEqual({ ...OFFSET, ...GREYED });
        expect(p.smoothingCooldownMin).toEqual(COOLDOWN);
    });

    it('keeps the help-text contract of manifestHelpText.test.ts', () => {
        for (const p of [OFFSET, TRIMS, MODE, TOLERANCE]) {
            expect(p.description.length).toBeLessThanOrEqual(120);
            expect(p.title.length).toBeLessThanOrEqual(40);
            expect(p.title.endsWith('.')).toBe(false);
        }
        // The cooldown's text is the owner's, longer by his ask; its title keeps the rule.
        expect(COOLDOWN.title.length).toBeLessThanOrEqual(40);
        expect(COOLDOWN.title.endsWith('.')).toBe(false);
    });

    it("the cooldown says plainly where latency comes from: a bursty stream's, never a steady one's", () => {
        const { description } = COOLDOWN;
        expect(description).toMatch(
            /^While restamping, adds latency only when this input's stream is bursty /,
        );
        expect(description).toContain('A steady stream gets no added latency.');
        expect(description).toContain('0 turns smoothing off');
    });
});

describe('parseManifestTiming', () => {
    it('reads an ingest declaration; pidTrims, pcrLock and trust only when exactly true', () => {
        expect(
            parseManifestTiming({ role: 'ingest', pidTrims: true, pcrLock: true, trust: true }),
        ).toEqual({ role: 'ingest', pidTrims: true, pcrLock: true, trust: true });
        expect(parseManifestTiming({ role: 'ingest', pidTrims: false })).toEqual({
            role: 'ingest',
            pidTrims: false,
            pcrLock: false,
            trust: false,
        });
        const ingest = (v: unknown) => parseManifestTiming(v) as ManifestTiming | null;
        expect(ingest({ role: 'ingest', trust: 'yes' })?.trust).toBe(false);
        expect(ingest({ role: 'ingest' })?.pidTrims).toBe(false);
        expect(ingest({ role: 'ingest', pidTrims: 'yes' })?.pidTrims).toBe(false);
        // Never inferred from pidTrims.
        expect(ingest({ role: 'ingest', pidTrims: true })?.pcrLock).toBe(false);
        expect(ingest({ role: 'ingest', pcrLock: 'yes' })?.pcrLock).toBe(false);
    });

    it('an egress declares a writer and nothing else (S34)', () => {
        expect(parseManifestTiming({ role: 'egress' })).toEqual({ role: 'egress' });
        expect(parseManifestTiming({ role: 'egress', pidTrims: true, pcrLock: true })).toEqual({
            role: 'egress',
        });
    });

    it('anything else declares nothing', () => {
        for (const v of [undefined, null, 'ingest', 'egress', 7, {}, { role: 'output' }]) {
            expect(parseManifestTiming(v)).toBeNull();
        }
    });
});

describe('the plugin manifests', () => {
    const PLUGINS_DIR = path.resolve(__dirname, '../../../plugins');

    it('the three stc-mode network ingests declare pcrLock and trust, the four captures neither (b95s, WI-P5-11); the three network outputs are egress', () => {
        const timings: Record<string, unknown> = {};
        for (const dir of fs.readdirSync(PLUGINS_DIR)) {
            const file = path.join(PLUGINS_DIR, dir, 'package.json');
            if (!fs.existsSync(file)) continue;
            const timing = parseManifestTiming(
                JSON.parse(fs.readFileSync(file, 'utf8')).mediaRouter?.timing,
            );
            if (timing) timings[dir] = timing;
        }
        const net = { role: 'ingest', ...NETWORK };
        const cap = { role: 'ingest', ...CAPTURE };
        const egress = { role: 'egress' };
        expect(timings).toEqual({
            'aes67-input': cap,
            'audio-encoder': cap,
            'audio-input-302m': cap,
            'mpegts-ip-input': net,
            'mpegts-ip-output': egress,
            'rist-input': net,
            'rist-output': egress,
            'srt-input': net,
            'srt-output': egress,
            'video-encoder': cap,
        });
    });
});
