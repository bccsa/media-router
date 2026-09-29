import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { applyTreeOp } from '@media-router/shared-types';
import { TopicBus } from '@media-router/topic-tree';
import { fakeSocket } from '@media-router/topic-tree/dist/testing.js';
import { ConfigStore } from '../config/ConfigStore.js';
import { PluginRegistry } from '../plugins/PluginRegistry.js';
import { EngineCommandService } from '../handlers/EngineCommandService.js';
import { EngineEventForwarder } from '../handlers/EngineEventForwarder.js';
import { PatchRouter } from '../PatchRouter.js';
import { RuntimeCache } from './RuntimeCache.js';
import { EngineView } from './EngineView.js';
import { ManagerTree } from './ManagerTree.js';
import { TreePublisher } from './TreePublisher.js';
import { TreeWrites } from './TreeWrites.js';
import { AdminWrites } from './AdminWrites.js';
import { TreeCalls } from './TreeCalls.js';

const manifest = {
    pluginId: 'audio-output',
    displayName: 'Audio Output',
    ports: [],
    color: '#3b82f6',
    configSchema: {
        properties: {
            volume: { type: 'number', minimum: 0, maximum: 150, 'x-live': true, 'x-maxFrom': 'volumeMax' },
            volumeMax: { type: 'number' },
            channels: { type: 'number', 'x-readOnly': true },
        },
    },
    statusSections: [{ id: 'stats', label: 'Stats', fields: [{ key: 'level', label: 'Level', unit: 'dB' }] }],
};

function setup() {
    const configStore = new ConfigStore(':memory:');
    configStore.createEngine('e1', 'Router One', 'pw');
    configStore.createProfile('e1', 'default', {
        modules: { m1: { pluginId: 'audio-output', displayName: 'Out', settings: { volume: 80, volumeMax: 150 } } },
        connections: [],
        interlocks: [],
        running: true,
    });
    configStore.setActiveProfile('e1', 'default');
    const online = new Set(['e1']);
    const engineManager = Object.assign(new EventEmitter(), {
        isEngineOnline: (id: string) => online.has(id),
        enginePaths: () => [],
        sendToEngine: vi.fn(),
        refreshEncryptionKeys: vi.fn(),
        notifyRename: vi.fn(),
        dgramListeners: [{ port: 3000 }],
        setListeners: vi.fn(async () => {}),
    }) as any;
    const registry = new PluginRegistry('/nonexistent');
    (registry as any).cache = [manifest];
    const runtime = new RuntimeCache();
    const view = new EngineView({ configStore, runtime, pluginRegistry: registry, engineManager });
    const tree = new ManagerTree({ view, configStore, engineManager, pluginRegistry: registry });
    const bus = new TopicBus(tree, 10);
    const publisher = new TreePublisher(bus, view);
    const engineCommands = new EngineCommandService(configStore, engineManager);
    new EngineEventForwarder(configStore, engineManager, engineCommands, runtime, publisher).setup();
    const patchRouter = new PatchRouter(configStore, engineManager, publisher, registry, runtime);
    const writes = new TreeWrites(patchRouter, view, new AdminWrites({ configStore, engineManager, engineCommands, runtime, publisher, tree }), bus);
    const calls = new TreeCalls({ configStore, engineManager, runtime, publisher, pluginUploads: {} as any });
    const sock = (id: string, patterns: string[]) => {
        const s = fakeSocket(id);
        bus.attach(s);
        const snapshot = bus.subscribe(id, patterns);
        return { s, snapshot };
    };
    const ops = (s: ReturnType<typeof fakeSocket>) => {
        vi.advanceTimersByTime(20);
        return s.frames().flat();
    };
    /** A client mirror: the snapshot, then every frame applied in order. */
    const track = (id: string, patterns: string[]) => {
        const { s, snapshot } = sock(id, patterns);
        const mirror: any = {};
        snapshot.forEach((op) => applyTreeOp(mirror, op));
        let seen = 0;
        const sync = () => {
            vi.advanceTimersByTime(20);
            const frames = s.frames();
            for (const f of frames.slice(seen)) for (const op of f) applyTreeOp(mirror, op);
            seen = frames.length;
            return mirror;
        };
        return { s, mirror, sync };
    };
    const stored = () => configStore.getProfile('e1', 'default') as any;
    return { configStore, engineManager, online, bus, writes, calls, sock, ops, track, stored };
}

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

    it('anything outside the writable paths is rejected', async () => {
        const { writes } = setup();
        const res = await writes.handle({ socketId: 'a' }, [{ op: 'replace', path: '/foo', value: 1 }], 1);
        expect(res.rejected).toEqual([{ index: 0, path: '/foo', reason: 'not writable' }]);
    });
});
