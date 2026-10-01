import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setup } from './testing/managerTreeFixture.js';

describe('manager tree /meta (integration)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('/meta serves descriptors: max follows the referenced setting, live', async () => {
        const { sock, writes, track } = setup();
        const { snapshot } = sock('d', ['/meta/engines/e1/modules/m1/settings/volume']);
        expect(snapshot).toEqual([{
            op: 'add',
            path: '/meta/engines/e1/modules/m1/settings/volume',
            value: { access: 'write', apply: 'live', type: 'number', label: 'volume', min: 0, max: 150 },
        }]);
        const t = track('d2', ['/meta/engines/e1/modules/m1']);
        expect(t.mirror.meta.engines.e1.modules.m1.settings.channels.access).toBe('read');
        expect(t.mirror.meta.engines.e1.modules.m1.statusData.stats.level).toEqual({ access: 'read', label: 'Level', unit: 'dB' });
        await writes.handle({ socketId: 'x' }, [{ op: 'replace', path: '/engines/e1/modules/m1/settings/volumeMax', value: 200 }], 1);
        expect(t.sync().meta.engines.e1.modules.m1.settings.volume.max).toBe(200);
    });

    it('/meta follows the live params the engine reports, by whole state or statePatch', () => {
        const { track, engineManager } = setup();
        const t = track('d', ['/meta/engines/e1/modules/m1/settings/volume']);
        expect(t.mirror.meta.engines.e1.modules.m1.settings.volume.apply).toBe('live');
        engineManager.emit('engineState', 'e1', { m1: { running: true, health: 'ok', liveUpdatableParams: [] } });
        expect(t.sync().meta.engines.e1.modules.m1.settings.volume.apply).toBe('restart');
        engineManager.emit('engineStatePatch', 'e1', { seq: 1, ops: [{ op: 'replace', path: '/modules/m1/liveUpdatableParams', value: ['volume'] }] });
        expect(t.sync().meta.engines.e1.modules.m1.settings.volume.apply).toBe('live');
    });

    it('/meta is not part of `/`; info carries the engine-level writable values', () => {
        const { sock } = setup();
        const root = sock('r', ['/']).snapshot;
        expect(root.map((o) => o.path)).not.toContain('/meta');
        expect(sock('i', ['/meta/engines/e1/info/running']).snapshot[0].value).toMatchObject({ access: 'write', type: 'boolean' });
        // Every writable info field has one: `/meta` + P holds for the sidebar moves too.
        const info = sock('j', ['/meta/engines/e1/info']).snapshot[0].value as Record<string, { access: string }>;
        expect(Object.keys(info).sort()).toEqual(['activeProfile', 'groupId', 'name', 'running', 'sortOrder']);
        expect(Object.values(info).every((d) => d.access === 'write')).toBe(true);
    });
});
