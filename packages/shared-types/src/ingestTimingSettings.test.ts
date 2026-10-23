import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    INGEST_OFFSET_KEY,
    PID_TRIMS_KEY,
    SMOOTHING_COOLDOWN_KEY,
    parseManifestTiming,
    withIngestTimingSettings,
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
// The owner's words (2026-10-23): latency only when the stream is bursty.
const COOLDOWN = {
    type: 'number',
    default: 5,
    minimum: 0,
    maximum: 60,
    'x-unit': 'min',
    'x-live': true,
    title: 'Smoothing Cooldown',
    description:
        "Adds latency only when this input's stream is bursty (packets arriving in bursts, as through some relays). The input then runs at its bursts' height and comes back down no sooner than this long after the last burst, instead of skipping and re-syncing after every burst. A steady stream gets no added latency. Set it longer than the time between bursts; 0 turns smoothing off.",
};
const NETWORK = { pidTrims: true, pcrLock: true };
const CAPTURE = { pidTrims: false, pcrLock: false };
const base = () => ({
    type: 'object',
    properties: { port: { type: 'number', default: 5000 } },
});
const props = (s: Record<string, unknown>) => s.properties as Record<string, unknown>;

describe('withIngestTimingSettings', () => {
    it('a network ingest gets Ingest Offset, Per-PID Trim and Smoothing Cooldown, after its own settings', () => {
        const schema = withIngestTimingSettings(base(), NETWORK);
        expect(schema).toEqual({
            type: 'object',
            properties: {
                port: { type: 'number', default: 5000 },
                ingestOffsetMs: OFFSET,
                pidTrimsMs: TRIMS,
                smoothingCooldownMin: COOLDOWN,
            },
        });
        expect(Object.keys(props(schema))).toEqual([
            'port',
            INGEST_OFFSET_KEY,
            PID_TRIMS_KEY,
            SMOOTHING_COOLDOWN_KEY,
        ]);
    });

    it('a capture gets Ingest Offset only (OQ-15)', () => {
        expect(withIngestTimingSettings(base(), CAPTURE)).toEqual({
            type: 'object',
            properties: { port: { type: 'number', default: 5000 }, ingestOffsetMs: OFFSET },
        });
    });

    it('Smoothing Cooldown follows pcrLock alone, never pidTrims', () => {
        const trimsOnly = props(
            withIngestTimingSettings(base(), { pidTrims: true, pcrLock: false }),
        );
        expect(Object.keys(trimsOnly)).toEqual(['port', INGEST_OFFSET_KEY, PID_TRIMS_KEY]);
        const lockOnly = props(
            withIngestTimingSettings(base(), { pidTrims: false, pcrLock: true }),
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
        expect(p.ingestOffsetMs).toEqual(OFFSET);
        expect(p.smoothingCooldownMin).toEqual(COOLDOWN);
    });

    it('keeps the help-text contract of manifestHelpText.test.ts', () => {
        for (const p of [OFFSET, TRIMS]) {
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
        expect(description).toMatch(/^Adds latency only when this input's stream is bursty /);
        expect(description).toContain('A steady stream gets no added latency.');
        expect(description).toContain('0 turns smoothing off');
    });
});

describe('parseManifestTiming', () => {
    it('reads an ingest declaration; pidTrims and pcrLock only when exactly true', () => {
        expect(parseManifestTiming({ role: 'ingest', pidTrims: true, pcrLock: true })).toEqual({
            role: 'ingest',
            pidTrims: true,
            pcrLock: true,
        });
        expect(parseManifestTiming({ role: 'ingest', pidTrims: false })).toEqual({
            role: 'ingest',
            pidTrims: false,
            pcrLock: false,
        });
        expect(parseManifestTiming({ role: 'ingest' })?.pidTrims).toBe(false);
        expect(parseManifestTiming({ role: 'ingest', pidTrims: 'yes' })?.pidTrims).toBe(false);
        // Never inferred from pidTrims.
        expect(parseManifestTiming({ role: 'ingest', pidTrims: true })?.pcrLock).toBe(false);
        expect(parseManifestTiming({ role: 'ingest', pcrLock: 'yes' })?.pcrLock).toBe(false);
    });

    it('anything else declares nothing', () => {
        for (const v of [undefined, null, 'ingest', 7, {}, { role: 'egress', pidTrims: true }]) {
            expect(parseManifestTiming(v)).toBeNull();
        }
    });
});

describe('the plugin manifests', () => {
    const PLUGINS_DIR = path.resolve(__dirname, '../../../plugins');

    it('the three stc-mode network ingests declare pcrLock, the four captures do not (b95s)', () => {
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
        expect(timings).toEqual({
            'aes67-input': cap,
            'audio-encoder': cap,
            'audio-input-302m': cap,
            'mpegts-ip-input': net,
            'rist-input': net,
            'srt-input': net,
            'video-encoder': cap,
        });
    });
});
