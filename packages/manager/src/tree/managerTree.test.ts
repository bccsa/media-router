import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setup } from './testing/managerTreeFixture.js';

describe('manager tree (integration)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('serves router info with counts to a wildcard subscriber', () => {
        const { sock } = setup();
        const { snapshot } = sock('a', ['/engines/+/info']);
        expect(snapshot).toHaveLength(1);
        expect(snapshot[0].value).toMatchObject({ name: 'Router One', online: true, running: true, moduleCount: 1, connectionCount: 0 });
    });

    it('serves a module merged from config, manifest and runtime', () => {
        const { sock, engineManager, ops } = setup();
        const { s, snapshot } = sock('a', ['/engines/e1/modules/m1']);
        expect(snapshot[0].value).toMatchObject({ instanceId: 'm1', color: '#3b82f6', health: 'stopped', settings: { volume: 80 } });
        engineManager.emit('engineState', 'e1', { m1: { running: true, health: 'ok', statusData: { stats: { level: -12 } } } });
        expect(ops(s)).toEqual(expect.arrayContaining([
            { op: 'replace', path: '/engines/e1/modules/m1/health', value: 'ok' },
            { op: 'replace', path: '/engines/e1/modules/m1/statusData', value: { stats: { level: -12 } } },
        ]));
        engineManager.emit('engineState', 'e1', { m1: { running: true, health: 'ok', statusData: { stats: { level: -9 } } } });
        expect(ops(s).slice(-1)).toEqual([{ op: 'replace', path: '/engines/e1/modules/m1/statusData/stats/level', value: -9 }]);
    });

    it('applies a checked write, echoes it to the writer and sends it to the engine', async () => {
        const { sock, writes, engineManager, stored, ops } = setup();
        const a = sock('a', ['/engines/e1']).s;
        const b = sock('b', ['/engines/e1/modules/+/settings']).s;
        const res = await writes.handle({ socketId: 'a' }, [{ op: 'replace', path: '/engines/e1/modules/m1/settings/volume', value: 100 }], 5);
        expect(res.rejected).toEqual([]);
        expect(stored().modules.m1.settings.volume).toBe(100);
        expect(engineManager.sendToEngine).toHaveBeenCalledWith('e1', 'patch', { ops: [{ op: 'replace', path: '/modules/m1/settings/volume', value: 100 }] }, { guaranteeDelivery: true });
        expect(ops(a)).toContainEqual({ op: 'replace', path: '/engines/e1/modules/m1/settings/volume', value: 100, w: 5 });
        expect(ops(b)).toContainEqual({ op: 'replace', path: '/engines/e1/modules/m1/settings/volume', value: 100 });
    });

    it('rejects per op — range, read-only, undeclared — and checks against the batch so far', async () => {
        const { writes, stored } = setup();
        const res = await writes.handle({ socketId: 'a' }, [
            { op: 'replace', path: '/engines/e1/modules/m1/settings/volume', value: 999 },
            { op: 'replace', path: '/engines/e1/modules/m1/settings/channels', value: 2 },
            { op: 'replace', path: '/engines/e1/modules/m1/settings/legacy', value: 1 },
            { op: 'replace', path: '/engines/e1/modules/m1/settings/volumeMax', value: 200 },
            { op: 'replace', path: '/engines/e1/modules/m1/settings/volume', value: 180 },
            { op: 'replace', path: '/engines/e1/modules/m1/health', value: 'ok' },
        ], 1);
        expect(res.rejected.map((r) => [r.index, r.reason])).toEqual([
            [0, 'above maximum 150'], [1, 'read-only'], [2, 'unknown value'], [5, 'read-only'],
        ]);
        expect(stored().modules.m1.settings).toMatchObject({ volume: 180, volumeMax: 200 });
    });

    it('module add updates the info counts', async () => {
        const { track, writes } = setup();
        const t = track('a', ['/engines/+/info']);
        await writes.handle({ socketId: 'x' }, [{ op: 'add', path: '/engines/e1/modules/m2', value: { pluginId: 'audio-output', settings: {} } }], 1);
        expect(t.sync().engines.e1.info.moduleCount).toBe(2);
    });

    it('an accepted admin write comes back to its writer tagged with the write id', async () => {
        const { sock, writes, ops } = setup();
        const a = sock('a', ['/engines/e1/info']).s;
        const res = await writes.handle({ socketId: 'a' }, [{ op: 'replace', path: '/engines/e1/info/name', value: 'Renamed' }], 9);
        expect(res.rejected).toEqual([]);
        vi.advanceTimersByTime(20);
        expect(ops(a)).toContainEqual({ op: 'replace', path: '/engines/e1/info/name', value: 'Renamed', w: 9 });
    });

    it('writing info/running stops the engine and publishes the intent', async () => {
        const { track, writes, engineManager } = setup();
        const t = track('a', ['/engines/e1/info']);
        await writes.handle({ socketId: 'a' }, [{ op: 'replace', path: '/engines/e1/info/running', value: false }], 2);
        expect(engineManager.sendToEngine).toHaveBeenCalledWith('e1', 'command', { command: 'stop' }, { guaranteeDelivery: true });
        expect(t.sync().engines.e1.info.running).toBe(false);
    });

    it('an engine going offline publishes the runtime reset', () => {
        const { track, engineManager, online } = setup();
        const t = track('a', ['/engines/e1']);
        engineManager.emit('engineState', 'e1', { m1: { running: true, health: 'ok', error: 'x' } });
        expect(t.sync().engines.e1.modules.m1).toMatchObject({ running: true, health: 'ok', error: 'x' });
        online.delete('e1');
        engineManager.emit('engineOffline', 'e1');
        const m = t.sync().engines.e1;
        expect(m.modules.m1).toMatchObject({ running: false, health: 'stopped' });
        expect(m.modules.m1.error).toBeUndefined();
        expect(m.info.online).toBe(false);
        expect(m.modules.m1.settings.volume).toBe(80);
    });

    it('rename moves subscriptions and tells the socket', () => {
        const { sock, calls, bus, engineManager } = setup();
        const { s } = sock('a', ['/engines/e1/info']);
        expect(calls.handle({ socketId: 'a' }, '/engines/e1', 'rename', { newEngineId: 'e9' })).toEqual({ id: 'e9' });
        expect(s.emitted).toContainEqual(['tree:renamed', { from: '/engines/e1', to: '/engines/e9' }]);
        expect(bus.patternsOf('a')).toEqual([['engines', 'e9', 'info']]);
        expect(engineManager.notifyRename).toHaveBeenCalledWith('e1', 'e9');
    });

    it('groups are created, renamed and deleted through writes', async () => {
        const { track, writes } = setup();
        const t = track('a', ['/groups']);
        await writes.handle({ socketId: 'a' }, [{ op: 'add', path: '/groups/grp_x', value: { name: 'X' } }], 1);
        expect(t.sync().groups.grp_x.name).toBe('X');
        await writes.handle({ socketId: 'a' }, [{ op: 'replace', path: '/groups/grp_x/name', value: 'Y' }], 2);
        expect(t.sync().groups.grp_x.name).toBe('Y');
        await writes.handle({ socketId: 'a' }, [{ op: 'remove', path: '/groups/grp_x' }], 3);
        expect(t.sync().groups.grp_x).toBeUndefined();
    });

    it('a listener set that cannot bind is rejected with its reason', async () => {
        const { writes, engineManager } = setup();
        engineManager.setListeners.mockRejectedValueOnce(new Error('EADDRINUSE'));
        const res = await writes.handle({ socketId: 'a' }, [{ op: 'replace', path: '/settings/dgramListeners', value: [{ port: 3002 }] }], 1);
        expect(res.rejected[0].reason).toMatch(/Could not bind listeners: EADDRINUSE/);
    });

    it('calls create an engine and refuse commands to an offline one', () => {
        const { sock, calls, ops } = setup();
        const { s } = sock('a', ['/engines/+/info']);
        expect(calls.handle({ socketId: 'a' }, '/engines', 'create', { engineId: 'e2', displayName: 'Two', password: 'x' })).toEqual({ id: 'e2' });
        expect(ops(s)).toContainEqual(expect.objectContaining({ op: 'add', path: '/engines/e2/info' }));
        expect(() => calls.handle({ socketId: 'a' }, '/engines/e2', 'reboot', {})).toThrow('Engine is offline');
        expect(() => calls.handle({ socketId: 'a' }, '/engines/e2', 'explode', {})).toThrow(/no method/);
    });

    it('rollback sends the active profile only the difference and keeps the run intent', async () => {
        const { writes, calls, engineManager, stored, track } = setup();
        const t = track('a', ['/engines/e1/modules/m1/settings/volume']);
        const write = (path: string, value: unknown) => writes.handle({ socketId: 'x' }, [{ op: 'replace', path, value }], 1);
        await write('/engines/e1/info/running', false); // first version: stopped, volume 80
        vi.advanceTimersByTime(11 * 60 * 1000); // history keeps one version per 10 min
        await write('/engines/e1/info/running', true);
        await write('/engines/e1/modules/m1/settings/volume', 120);
        const versions = calls.handle({ socketId: 'x' }, '/engines/e1/profiles/default', 'history', {}) as Array<{ id: number; config: string }>;
        const stopped = versions.find((v) => JSON.parse(v.config).running === false)!;
        engineManager.sendToEngine.mockClear();
        calls.handle({ socketId: 'x' }, '/engines/e1/profiles/default', 'rollback', { versionId: stopped.id });
        expect(stored().modules.m1.settings.volume).toBe(80);
        expect(stored().running).toBe(true);
        // No config push, no start: live values apply, restart-required ones wait (UR-MGR-006c).
        expect(engineManager.sendToEngine.mock.calls).toEqual([
            ['e1', 'patch', { ops: [{ op: 'replace', path: '/modules/m1/settings/volume', value: 80 }] }, { guaranteeDelivery: true }],
        ]);
        expect(t.sync().engines.e1.modules.m1.settings.volume).toBe(80);
    });

    it('rollback of an inactive profile only stores it', () => {
        const { configStore, calls, engineManager } = setup();
        const spare = (volume: number) => ({ modules: { m1: { pluginId: 'audio-output', settings: { volume } } }, connections: [], interlocks: [] });
        configStore.createProfile('e1', 'spare', {});
        configStore.updateProfileConfig('e1', 'spare', spare(10));
        vi.advanceTimersByTime(11 * 60 * 1000);
        configStore.updateProfileConfig('e1', 'spare', spare(20));
        const versions = configStore.getVersionHistory('e1', 'spare');
        const first = versions.find((v) => JSON.parse(v.config).modules.m1.settings.volume === 10)!;
        calls.handle({ socketId: 'x' }, '/engines/e1/profiles/spare', 'rollback', { versionId: first.id });
        expect((configStore.getProfile('e1', 'spare') as any).modules.m1.settings.volume).toBe(10);
        expect(engineManager.sendToEngine).not.toHaveBeenCalled();
    });

    it('anything outside the writable paths is rejected', async () => {
        const { writes } = setup();
        const res = await writes.handle({ socketId: 'a' }, [{ op: 'replace', path: '/foo', value: 1 }], 1);
        expect(res.rejected).toEqual([{ index: 0, path: '/foo', reason: 'not writable' }]);
    });
});
