import { describe, it, expect } from 'vitest';
import { describeModuleValue, describeModule, checkWrite, metaAt, touchedModules, type DescribableModule } from './describe.js';
import { WriteRequestSchema, PatternListSchema } from './protocol.js';

const mod: DescribableModule = {
    settings: { volume: 80, volumeMax: 200, codec: 'opus' },
    liveUpdatableParams: ['volume'],
    configSchema: {
        properties: {
            volume: { type: 'number', minimum: 0, maximum: 150, title: 'Output Volume', 'x-unit': '%', 'x-step': 1, 'x-live': true, 'x-maxFrom': 'volumeMax', 'x-widget': 'slider' },
            volumeMax: { type: 'number', maximum: 400 },
            channels: { type: 'number', 'x-readOnly': true },
            device: { type: 'string', 'x-live': true },
            codec: { type: 'string', enum: ['opus', 'aac'] },
            bitrate: { type: 'number', 'x-maxBy': { field: 'codec', map: { opus: 510, aac: 320 } } },
            rate: { type: 'number', enum: ['48000', '96000'] },
            curve: { type: 'string', 'x-widget': 'graph' },
        },
    },
    statusSections: [{ id: 'stats', fields: [{ key: 'bitrate', label: 'Bitrate', unit: 'Mbps' }] }],
    statusData: { stats: { bitrate: 1.5 } },
};

describe('describeModuleValue', () => {
    it('describes a live slider with its resolved max', () => {
        expect(describeModuleValue(mod, ['settings', 'volume'])).toEqual({
            access: 'write', apply: 'live', type: 'number', label: 'Output Volume', unit: '%',
            min: 0, max: 200, step: 1, widget: 'slider',
        });
    });

    it('follows the runtime live list over the schema flag', () => {
        expect(describeModuleValue(mod, ['settings', 'device'])?.apply).toBe('restart');
    });

    it('resolves x-maxBy from the controlling setting', () => {
        expect(describeModuleValue(mod, ['settings', 'bitrate'])?.max).toBe(510);
    });

    it('reads x-readOnly settings and display widgets as read-only', () => {
        expect(describeModuleValue(mod, ['settings', 'channels'])?.access).toBe('read');
        expect(describeModuleValue(mod, ['settings', 'curve'])?.access).toBe('read');
    });

    it('returns null for an undeclared setting', () => {
        expect(describeModuleValue(mod, ['settings', 'legacyKey'])).toBeNull();
    });

    it('labels status values from the manifest sections', () => {
        expect(describeModuleValue(mod, ['statusData', 'stats', 'bitrate'])).toEqual({
            access: 'read', label: 'Bitrate', unit: 'Mbps',
        });
    });

    it('describeModule: every setting and declared status field, max resolved', () => {
        const meta = describeModule(mod);
        expect(meta.settings.volume).toMatchObject({ access: 'write', apply: 'live', max: 200 });
        expect(meta.settings.channels.access).toBe('read');
        expect(meta.settings.legacyKey).toBeUndefined();
        expect(meta.statusData.stats.bitrate).toEqual({ access: 'read', label: 'Bitrate', unit: 'Mbps' });
        expect(meta.enabled).toMatchObject({ access: 'write', type: 'boolean' });
        expect(meta.displayName?.access).toBe('write');
    });

    it('describeModule: only the listed module fields are writable (a router takes enabled)', () => {
        const meta = describeModule(mod, ['enabled']);
        expect(Object.keys(meta).sort()).toEqual(['enabled', 'settings', 'statusData']);
    });

    it('treats module fields as writable only when listed', () => {
        expect(describeModuleValue(mod, ['enabled'])?.access).toBe('write');
        expect(describeModuleValue(mod, ['health'])?.access).toBe('read');
    });
});

describe('checkWrite', () => {
    const vol = describeModuleValue(mod, ['settings', 'volume']);
    const put = (value: unknown) => ({ op: 'replace' as const, path: '/x', value });

    it('allows an in-range number', () => {
        expect(checkWrite(vol, put(180))).toBeNull();
    });

    it('rejects out of range, wrong type, read-only, unknown and remove', () => {
        expect(checkWrite(vol, put(250))).toMatch(/maximum/);
        expect(checkWrite(vol, put(-1))).toMatch(/minimum/);
        expect(checkWrite(vol, put('80'))).toMatch(/number/);
        expect(checkWrite(describeModuleValue(mod, ['settings', 'channels']), put(2))).toBe('read-only');
        expect(checkWrite(null, put(1))).toBe('unknown value');
        expect(checkWrite(vol, { op: 'remove', path: '/x' })).toBe('not removable');
    });

    it('checks enums, tolerating number/string representation', () => {
        expect(checkWrite(describeModuleValue(mod, ['settings', 'codec']), put('mp3'))).toMatch(/option/);
        expect(checkWrite(describeModuleValue(mod, ['settings', 'rate']), put(48000))).toBeNull();
    });
});

describe('tree protocol schemas', () => {
    it('validates write and pattern requests', () => {
        expect(WriteRequestSchema.safeParse({ id: 1, ops: [{ op: 'replace', path: '/a', value: 1 }] }).success).toBe(true);
        expect(WriteRequestSchema.safeParse({ id: -1, ops: [] }).success).toBe(false);
        expect(PatternListSchema.safeParse({ patterns: [] }).success).toBe(false);
    });
});

describe('touchedModules', () => {
    const op = (path: string) => ({ op: 'replace' as const, path, value: 1 });

    it('collects module ids; a whole-module op counts; other branches do not', () => {
        expect(touchedModules([op('/modules/a/settings/v'), op('/modules/b'), op('/connections/c1')])).toEqual(new Set(['a', 'b']));
    });

    it("a root or whole /modules op touches 'all'", () => {
        expect(touchedModules([op('')])).toBe('all');
        expect(touchedModules([op('/modules')])).toBe('all');
    });

    it('with fields, only those module fields (or the whole module) count', () => {
        const ops = [op('/modules/a/statusData/x'), op('/modules/b/liveUpdatableParams'), op('/modules/c')];
        expect(touchedModules(ops, ['liveUpdatableParams'])).toEqual(new Set(['b', 'c']));
    });
});

describe('metaAt', () => {
    const info = { running: { access: 'write' as const } };
    const built: string[] = [];
    const moduleMeta = (id: string) => {
        built.push(id);
        return id === 'm1' ? describeModule(mod) : undefined;
    };

    it('builds only what the path needs', () => {
        built.length = 0;
        expect(metaAt(['info', 'running'], info, () => ['m1'], moduleMeta)).toEqual({ access: 'write' });
        expect(built).toEqual([]);
        expect(metaAt(['modules', 'm1', 'settings', 'volume'], info, () => ['m1'], moduleMeta)).toMatchObject({ max: 200 });
        expect(built).toEqual(['m1']);
        expect(Object.keys(metaAt([], info, () => ['m1'], moduleMeta) as object)).toEqual(['info', 'modules']);
        expect(metaAt(['other'], info, () => ['m1'], moduleMeta)).toBeUndefined();
    });
});
