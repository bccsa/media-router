import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setup } from './testing/managerTreeFixture.js';

const mod = (displayName: string) => ({ pluginId: 'audio-output', displayName, settings: { volume: 80, volumeMax: 150 } });
const live = () => ({ running: true, health: 'ok', statusData: { stats: { level: -12 } } });

// MR-067: a copied profile keeps module ids, so a delete in one profile must not hide them in the other.
describe('profile switch and removed-module tombstones (MR-067)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function switched() {
        const f = setup();
        f.configStore.createProfile('e1', 'copy', { modules: { m1: mod('Out'), m4: mod('Four') }, connections: [], interlocks: [], running: true });
        return f;
    }

    it("the next state push reaches a module whose id was deleted in the old profile", async () => {
        const { track, writes, engineManager } = switched();
        const t = track('a', ['/engines/e1']);
        await writes.handle({ socketId: 'a' }, [{ op: 'remove', path: '/engines/e1/modules/m1' }], 1);
        expect(t.sync().engines.e1.modules.m1).toBeUndefined();

        const res = await writes.handle({ socketId: 'a' }, [{ op: 'replace', path: '/engines/e1/info/activeProfile', value: 'copy' }], 2);
        expect(res.rejected).toEqual([]);
        expect(t.sync().engines.e1.modules.m1).toMatchObject({ running: false, health: 'stopped' });

        engineManager.emit('engineState', 'e1', { m1: live(), m4: live() });
        const m = t.sync().engines.e1.modules;
        expect(m.m1).toMatchObject(live());
        expect(m.m4).toMatchObject(live());
    });

    it('leaf state patches reach it too', async () => {
        const { track, writes, engineManager } = switched();
        const t = track('a', ['/engines/e1']);
        await writes.handle({ socketId: 'a' }, [{ op: 'remove', path: '/engines/e1/modules/m1' }], 1);
        await writes.handle({ socketId: 'a' }, [{ op: 'replace', path: '/engines/e1/info/activeProfile', value: 'copy' }], 2);
        engineManager.emit('engineState', 'e1', { m1: live() });
        engineManager.emit('engineStatePatch', 'e1', { seq: 1, ops: [{ op: 'replace', path: '/modules/m1/statusData/stats/level', value: -6 }] });
        expect(t.sync().engines.e1.modules.m1.statusData).toEqual({ stats: { level: -6 } });
    });

    it('top-level leaf replaces alone fill an empty cache entry', async () => {
        const { track, writes, engineManager } = switched();
        const t = track('a', ['/engines/e1']);
        await writes.handle({ socketId: 'a' }, [{ op: 'remove', path: '/engines/e1/modules/m1' }], 1);
        await writes.handle({ socketId: 'a' }, [{ op: 'replace', path: '/engines/e1/info/activeProfile', value: 'copy' }], 2);
        engineManager.emit('engineStatePatch', 'e1', {
            seq: 1,
            ops: [
                { op: 'replace', path: '/modules/m1/running', value: true },
                { op: 'replace', path: '/modules/m1/health', value: 'ok' },
                { op: 'replace', path: '/modules/m1/statusData', value: { stats: { level: -12 } } },
            ],
        });
        expect(t.sync().engines.e1.modules.m1).toMatchObject(live());
    });

    it('switching back to a profile that deleted the id tombstones it again', async () => {
        const { writes, engineManager, runtime } = switched();
        await writes.handle({ socketId: 'a' }, [{ op: 'remove', path: '/engines/e1/modules/m1' }], 1);
        await writes.handle({ socketId: 'a' }, [{ op: 'replace', path: '/engines/e1/info/activeProfile', value: 'copy' }], 2);
        engineManager.emit('engineState', 'e1', { m1: live() });
        expect(runtime.getStates('e1').m1).toMatchObject(live());
        await writes.handle({ socketId: 'a' }, [{ op: 'replace', path: '/engines/e1/info/activeProfile', value: 'default' }], 3);
        expect(runtime.getStates('e1').m1).toBeUndefined();
        engineManager.emit('engineState', 'e1', { m1: live() });
        engineManager.emit('engineVu', 'e1', { m1: [-20] });
        expect(runtime.getStates('e1').m1).toBeUndefined();
        expect(runtime.getVu('e1').m1).toBeUndefined();
    });

    it('a deleted id the new profile does not have stays tombstoned', async () => {
        const { writes, engineManager, configStore, runtime } = switched();
        const prof = configStore.getProfile('e1', 'default') as any;
        configStore.updateProfileConfig('e1', 'default', { ...prof, modules: { ...prof.modules, m2: mod('Two') } });
        await writes.handle({ socketId: 'a' }, [{ op: 'remove', path: '/engines/e1/modules/m2' }], 1);
        await writes.handle({ socketId: 'a' }, [{ op: 'replace', path: '/engines/e1/info/activeProfile', value: 'copy' }], 2);
        engineManager.emit('engineState', 'e1', { m1: live(), m2: live() });
        engineManager.emit('engineVu', 'e1', { m2: [-20] });
        expect(runtime.getStates('e1').m1).toMatchObject(live());
        expect(runtime.getStates('e1').m2).toBeUndefined();
        expect(runtime.getVu('e1').m2).toBeUndefined();
    });

    it("the old profile's modules the new one lacks lose their state, and a late batch cannot bring it back", async () => {
        const { writes, engineManager, configStore, runtime } = switched();
        const prof = configStore.getProfile('e1', 'default') as any;
        configStore.updateProfileConfig('e1', 'default', { ...prof, modules: { ...prof.modules, m3: mod('Three') } });
        engineManager.emit('engineState', 'e1', { m1: live(), m3: live() });
        expect(runtime.getStates('e1').m3).toMatchObject(live());
        await writes.handle({ socketId: 'a' }, [{ op: 'replace', path: '/engines/e1/info/activeProfile', value: 'copy' }], 1);
        expect(runtime.getStates('e1').m3).toBeUndefined();
        engineManager.emit('engineState', 'e1', { m3: live() });
        expect(runtime.getStates('e1').m3).toBeUndefined();

        // Back to the profile that has it: its state is taken again.
        await writes.handle({ socketId: 'a' }, [{ op: 'replace', path: '/engines/e1/info/activeProfile', value: 'default' }], 2);
        engineManager.emit('engineState', 'e1', { m3: live() });
        expect(runtime.getStates('e1').m3).toMatchObject(live());
    });
});
