/**
 * Guards the settings-panel text contract across every plugin manifest:
 * `description` is the "?" popover (one or two sentences), `title` is the
 * field heading. Long paragraphs used to sit inline under each heading;
 * this keeps them from creeping back. Also pins which settings their names
 * mark as secrets for the logs' redaction (B-109).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    isSecretKey,
    parseManifestTiming,
    withIngestTimingSettings,
} from '@media-router/shared-types';

const PLUGINS_DIR = path.resolve(__dirname, '../../../../plugins');
const MAX_DESCRIPTION = 120;
const MAX_TITLE = 40;
/** Settings that several plugins expose with identical meaning — keep one wording. */
const SHARED_KEYS = ['lcpSortOrder', 'pcmBitDepth'];

interface Prop {
    title?: unknown;
    description?: unknown;
    items?: { properties?: Record<string, Prop> };
}

/** Each manifest's settings with the ingest timing ones injected, as the registry shows them. */
function loadInjected(): Map<string, Record<string, Prop>> {
    const out = new Map<string, Record<string, Prop>>();
    for (const dir of fs.readdirSync(PLUGINS_DIR)) {
        const file = path.join(PLUGINS_DIR, dir, 'package.json');
        if (!fs.existsSync(file)) continue;
        const mr = JSON.parse(fs.readFileSync(file, 'utf8')).mediaRouter;
        const timing = parseManifestTiming(mr?.timing);
        if (!timing || !mr?.configSchema) continue;
        const schema = withIngestTimingSettings(mr.configSchema, timing);
        out.set(dir, schema.properties as Record<string, Prop>);
    }
    return out;
}

function loadProps(): Array<{ where: string; key: string; prop: Prop }> {
    const out: Array<{ where: string; key: string; prop: Prop }> = [];
    for (const dir of fs.readdirSync(PLUGINS_DIR)) {
        const file = path.join(PLUGINS_DIR, dir, 'package.json');
        if (!fs.existsSync(file)) continue;
        const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
        const props: Record<string, Prop> = pkg.mediaRouter?.configSchema?.properties ?? {};
        for (const [key, prop] of Object.entries(props)) {
            out.push({ where: dir, key, prop });
            for (const [ik, ip] of Object.entries(prop.items?.properties ?? {})) {
                out.push({ where: `${dir}.${key}[]`, key: ik, prop: ip });
            }
        }
    }
    return out;
}

describe('plugin manifest help text', () => {
    const all = loadProps();

    it('finds the plugin manifests', () => {
        expect(all.length).toBeGreaterThan(100);
    });

    it(`keeps every description at or under ${MAX_DESCRIPTION} characters`, () => {
        const long = all
            .filter((e) => typeof e.prop.description === 'string' && e.prop.description.length > MAX_DESCRIPTION)
            .map((e) => `${e.where}.${e.key} (${(e.prop.description as string).length})`);
        expect(long).toEqual([]);
    });

    it('keeps titles short, non-empty and without a trailing full stop', () => {
        const bad = all
            .filter((e) => e.prop.title !== undefined)
            .filter(
                (e) =>
                    typeof e.prop.title !== 'string' ||
                    !e.prop.title.trim() ||
                    e.prop.title.length > MAX_TITLE ||
                    e.prop.title.trim().endsWith('.'),
            )
            .map((e) => `${e.where}.${e.key}`);
        expect(bad).toEqual([]);
    });

    it('uses one wording for settings shared across plugins', () => {
        for (const key of SHARED_KEYS) {
            const texts = new Set(
                all.filter((e) => e.key === key && !e.where.includes('[]')).map((e) => `${e.prop.title}|${e.prop.description}`),
            );
            expect(texts.size, `${key} wording differs: ${[...texts].join(' || ')}`).toBe(1);
        }
    });

    it('marks by name exactly the passphrases the logs redact (B-109)', () => {
        const secrets = all.filter((e) => isSecretKey(e.key)).map((e) => `${e.where}.${e.key}`);
        expect(secrets.sort()).toEqual([
            'rist-input.secret',
            'rist-output.secret',
            'srt-input.passphrase',
            'srt-output.passphrase',
        ]);
    });

    it('pins Timing Mode and Trust Tolerance, one wording on the three network ingests, and the amended Smoothing Cooldown (WI-P5-11)', () => {
        const injected = loadInjected();
        const wording = (key: string) => {
            const seen = new Map<string, string[]>();
            for (const [dir, props] of injected) {
                const p = props[key];
                if (!p) continue;
                const text = `${p.title}|${p.description}`;
                seen.set(text, [...(seen.get(text) ?? []), dir]);
            }
            return Object.fromEntries(seen);
        };
        const NET = ['mpegts-ip-input', 'rist-input', 'srt-input'];
        expect(wording('timingMode')).toEqual({
            "Timing Mode|Restamp lands the stream on arrival; Trust keeps the sender's timeline after checking it.":
                NET,
        });
        expect(wording('trustToleranceMs')).toEqual({
            'Trust Tolerance|How far transit may exceed the link latency before Trust falls back to Restamp.':
                NET,
        });
        for (const key of ['timingMode', 'trustToleranceMs']) {
            for (const dir of NET) {
                expect((injected.get(dir)![key].description as string).length).toBeLessThanOrEqual(
                    MAX_DESCRIPTION,
                );
            }
        }
        const cooldown = Object.keys(wording('smoothingCooldownMin'));
        expect(cooldown).toHaveLength(1);
        expect(cooldown[0]).toMatch(
            /^Smoothing Cooldown\|While restamping, adds latency only when this input's stream is bursty /,
        );
    });
});
