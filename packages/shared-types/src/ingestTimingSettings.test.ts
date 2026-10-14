import { describe, it, expect } from 'vitest';
import {
    INGEST_OFFSET_KEY,
    PID_TRIMS_KEY,
    parseManifestTiming,
    withIngestTimingSettings,
} from './index.js';

// The WI-P1-9 fragments, written out: bounds per OQ-14 and §5.5.
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
const base = () => ({
    type: 'object',
    properties: { port: { type: 'number', default: 5000 } },
});
const props = (s: Record<string, unknown>) => s.properties as Record<string, unknown>;

describe('withIngestTimingSettings', () => {
    it('a network ingest gets Ingest Offset and Per-PID Trim, after its own settings', () => {
        const schema = withIngestTimingSettings(base(), { pidTrims: true });
        expect(schema).toEqual({
            type: 'object',
            properties: {
                port: { type: 'number', default: 5000 },
                ingestOffsetMs: OFFSET,
                pidTrimsMs: TRIMS,
            },
        });
        expect(Object.keys(props(schema))).toEqual(['port', INGEST_OFFSET_KEY, PID_TRIMS_KEY]);
    });

    it('a capture gets Ingest Offset only (OQ-15)', () => {
        expect(withIngestTimingSettings(base(), { pidTrims: false })).toEqual({
            type: 'object',
            properties: { port: { type: 'number', default: 5000 }, ingestOffsetMs: OFFSET },
        });
    });

    it('copies: the manifest schema is untouched and no fragment is shared', () => {
        const schema = base();
        const a = withIngestTimingSettings(schema, { pidTrims: true });
        const b = withIngestTimingSettings(schema, { pidTrims: true });
        expect(schema).toEqual(base());
        expect(props(a)[PID_TRIMS_KEY]).not.toBe(props(b)[PID_TRIMS_KEY]);
        expect(withIngestTimingSettings({}, { pidTrims: false })).toEqual({
            properties: { ingestOffsetMs: OFFSET },
        });
    });

    it('one definition wins over a manifest that spells the key itself', () => {
        const own = { properties: { ingestOffsetMs: { type: 'number', maximum: 99 } } };
        expect(props(withIngestTimingSettings(own, { pidTrims: false })).ingestOffsetMs).toEqual(
            OFFSET,
        );
    });

    it('keeps the help-text contract of manifestHelpText.test.ts', () => {
        for (const p of [OFFSET, TRIMS]) {
            expect(p.description.length).toBeLessThanOrEqual(120);
            expect(p.title.length).toBeLessThanOrEqual(40);
            expect(p.title.endsWith('.')).toBe(false);
        }
    });
});

describe('parseManifestTiming', () => {
    it('reads an ingest declaration; pidTrims only when exactly true', () => {
        expect(parseManifestTiming({ role: 'ingest', pidTrims: true })).toEqual({
            role: 'ingest',
            pidTrims: true,
        });
        expect(parseManifestTiming({ role: 'ingest', pidTrims: false })?.pidTrims).toBe(false);
        expect(parseManifestTiming({ role: 'ingest' })?.pidTrims).toBe(false);
        expect(parseManifestTiming({ role: 'ingest', pidTrims: 'yes' })?.pidTrims).toBe(false);
    });

    it('anything else declares nothing', () => {
        for (const v of [undefined, null, 'ingest', 7, {}, { role: 'egress', pidTrims: true }]) {
            expect(parseManifestTiming(v)).toBeNull();
        }
    });
});
