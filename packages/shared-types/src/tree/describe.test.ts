import { describe, it, expect } from 'vitest';
import {
    describeModuleValue,
    describeModule,
    checkWrite,
    dependentsOverMaximum,
    metaAt,
    settingMaximum,
    touchedModules,
    type DescribableModule,
} from './describe.js';
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
    statusSections: [{ id: 'stats', fields: [{ key: 'bitrate', label: 'Bitrate', unit: 'Mbps' }, { key: 'rtt', label: 'RTT', type: 'number' }] }],
    statusData: { stats: { bitrate: 1.5 } },
};

describe('levels in /meta', () => {
    it('a module that carries audio has levels, stopped or silent too; others none', () => {
        const audioOut = { ports: [{ streamType: 'audio/pcm' }] };
        const transcoder = { ports: [{ streamType: 'muxed/mpegts', acceptsAnyTs: true }] };
        const muxer = { ports: [{ streamType: 'muxed/mpegts' }] };
        expect([audioOut, transcoder, muxer].map((m) => describeModule(m).vu?.max)).toEqual([15, 15, undefined]);
        expect(describeModuleValue(audioOut, ['vu'])).toMatchObject({ type: 'array', min: 0, max: 15 });
        expect(describeModuleValue(muxer, ['vu'])).toEqual({ access: 'read' });
    });
});

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

    it("carries a status field's declared type (known with the router offline)", () => {
        expect(describeModuleValue(mod, ['statusData', 'stats', 'rtt'])).toEqual({ access: 'read', label: 'RTT', type: 'number' });
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

describe('settingMaximum (B-103)', () => {
    const volume = { type: 'number', maximum: 150, 'x-maxFrom': 'volumeMax' };
    const bitrate = { type: 'number', maximum: 510, 'x-maxBy': { field: 'codec', map: { opus: 510, aac: 320 } } };

    it("x-maxFrom's setting, over the static maximum either way", () => {
        expect(settingMaximum(volume, { volumeMax: 500 })).toBe(500);
        expect(settingMaximum(volume, { volumeMax: 100 })).toBe(100);
    });

    it('a missing or non-numeric x-maxFrom setting falls back to the static maximum', () => {
        expect(settingMaximum(volume, {})).toBe(150);
        expect(settingMaximum(volume, { volumeMax: '500' })).toBe(150);
        expect(settingMaximum(volume, { volumeMax: null })).toBe(150);
    });

    it("x-maxBy's entry for the field's value, else the static maximum", () => {
        expect(settingMaximum(bitrate, { codec: 'aac' })).toBe(320);
        expect(settingMaximum(bitrate, { codec: 'mp3' })).toBe(510);
        expect(settingMaximum(bitrate, {})).toBe(510);
    });

    it('the static maximum, or none', () => {
        expect(settingMaximum({ type: 'number', maximum: 85 }, { volumeMax: 500 })).toBe(85);
        expect(settingMaximum({ type: 'number' }, {})).toBeUndefined();
    });
});

describe('dependentsOverMaximum (B-107)', () => {
    const props = {
        volumeMax: { type: 'number' },
        volume: { type: 'number', maximum: 150, 'x-maxFrom': 'volumeMax' },
        codec: { type: 'string' },
        bitrate: { type: 'number', maximum: 510, 'x-maxBy': { field: 'codec', map: { opus: 510, aac: 320 } } },
        port: { type: 'number', maximum: 65535 },
    };
    const sources = (...keys: string[]) => new Set(keys);

    it("each dependent of a written source above that source's maximum, with the maximum", () => {
        expect(dependentsOverMaximum(props, { volumeMax: 150, volume: 300 }, sources('volumeMax'))).toEqual({ volume: 150 });
        expect(dependentsOverMaximum(props, { codec: 'aac', bitrate: 400 }, sources('codec'))).toEqual({ bitrate: 320 });
    });

    it('nothing at or under the maximum, nothing unset, and nothing whose source was not written', () => {
        expect(dependentsOverMaximum(props, { volumeMax: 150, volume: 150 }, sources('volumeMax'))).toEqual({});
        expect(dependentsOverMaximum(props, { volumeMax: 150 }, sources('volumeMax'))).toEqual({});
        expect(dependentsOverMaximum(props, { volumeMax: 150, volume: 300, port: 70000 }, sources('codec', 'port'))).toEqual({});
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
