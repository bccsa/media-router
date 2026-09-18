/**
 * Guards the settings-panel text contract across every plugin manifest:
 * `description` is the "?" popover (one or two sentences), `title` is the
 * field heading. Long paragraphs used to sit inline under each heading;
 * this keeps them from creeping back.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PLUGINS_DIR = path.resolve(__dirname, '../../../../plugins');
const MAX_DESCRIPTION = 120;
const MAX_TITLE = 40;
/** Settings that several plugins expose with identical meaning — keep one wording. */
const SHARED_KEYS = ['playoutOffsetMs', 'pcmBitDepth', 'mixLatencyMs'];

interface Prop {
    title?: unknown;
    description?: unknown;
    items?: { properties?: Record<string, Prop> };
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
});
