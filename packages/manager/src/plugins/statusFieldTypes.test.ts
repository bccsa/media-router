import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const PLUGINS = path.resolve(__dirname, '../../../../plugins');

/** Every plugin's status fields, from its manifest. */
function statusFields() {
    const out: Array<{ plugin: string; field: string; type: unknown }> = [];
    for (const dir of fs.readdirSync(PLUGINS)) {
        const file = path.join(PLUGINS, dir, 'package.json');
        if (!fs.existsSync(file)) continue;
        const sections = JSON.parse(fs.readFileSync(file, 'utf8')).mediaRouter?.statusSections ?? [];
        for (const s of sections) for (const f of s.fields ?? []) out.push({ plugin: dir, field: `${s.id}.${f.key}`, type: f.type });
    }
    return out;
}

describe('plugin status fields (dashboards, ADR-0026)', () => {
    it('all declare their type, so dashboards can be built with routers offline', () => {
        const fields = statusFields();
        expect(fields.length).toBeGreaterThan(100);
        expect(fields.filter((f) => !['number', 'string', 'boolean'].includes(f.type as string))).toEqual([]);
    });
});
