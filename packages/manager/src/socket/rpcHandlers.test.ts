import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConfigStore } from '../config/ConfigStore.js';
import { registerRpcHandlers } from './rpcHandlers.js';

/**
 * Direct drive of the RPC handlers without standing up a real Socket.IO
 * server. The handlers register themselves with `socket.on(event, fn)` and
 * receive `(payload, ack)` at call-time — we capture the handler map by
 * stubbing `socket.on`, then invoke each handler with a test payload and
 * a synchronous ack spy. Same pattern as SocketIOSetup.test.ts.
 *
 * What's NOT exercised here: the wire format (Socket.IO frames, JSON
 * round-tripping). Zod validation runs against plain objects exactly as it
 * would in production, so payload-shape coverage is identical to the
 * previous HTTP-route test suite.
 */
function captureHandlers(configStore: ConfigStore) {
    const handlers: Record<string, (payload: unknown, ack: (response: unknown) => void) => void> =
        {};
    const socket = {
        id: 'sock-1',
        on: vi.fn((event: string, handler: (payload: unknown, ack: any) => void) => {
            handlers[event] = handler;
        }),
        emit: vi.fn(),
    } as any;

    const io = { emit: vi.fn() } as any;
    const engineManager = {
        isEngineOnline: vi.fn().mockReturnValue(false),
        refreshEncryptionKeys: vi.fn(),
        notifyRename: vi.fn(),
        sendToEngine: vi.fn(),
    } as any;
    const eventForwarder = {
        getEngineData: vi.fn().mockReturnValue(undefined),
        notifyRename: vi.fn(),
    } as any;
    const pluginRegistry = {
        getAll: vi.fn().mockReturnValue([{ id: 'audio-input' }, { id: 'audio-output' }]),
        enrichModule: vi.fn(),
    } as any;
    const engineCommands = {
        isRunning: vi.fn().mockReturnValue(false),
        setRunning: vi.fn(),
        sendCommand: vi.fn(),
        cancelAll: vi.fn(),
    } as any;

    registerRpcHandlers(socket, {
        io,
        configStore,
        engineManager,
        pluginRegistry,
        eventForwarder,
        engineCommands,
    });

    /** Invoke a handler and return the ack response synchronously. */
    function call<T = unknown>(event: string, payload: unknown): Promise<{ ok: boolean } & T> {
        return new Promise((resolve) => {
            const handler = handlers[event];
            if (!handler) throw new Error(`No handler registered for ${event}`);
            handler(payload, (response: any) => resolve(response));
        });
    }

    return { call, io, engineManager, eventForwarder, pluginRegistry, engineCommands };
}

describe('rpcHandlers — engines', () => {
    let store: ConfigStore;
    beforeEach(() => {
        store = new ConfigStore(':memory:');
    });
    afterEach(() => {
        store.close();
    });

    it('engine:create creates the engine, seeds default profile, broadcasts engine:added', async () => {
        const { call, io } = captureHandlers(store);
        const res = await call<{ data: { id: string } }>('engine:create', {
            engineId: 'eng-1',
            displayName: 'Engine One',
            password: 'super-secret',
        });
        expect(res.ok).toBe(true);
        // All *:create RPCs ack with { id } — same shape for engine, group, profile.
        expect(res.data).toEqual({ id: 'eng-1' });
        expect(store.getEngine('eng-1')?.password).toBe('super-secret');
        // Broadcast payload must omit the password — that secret never leaves
        // the manager process. (The engine:list emit on connect is covered in
        // SocketIOSetup.test.ts.)
        expect(io.emit).toHaveBeenCalledWith(
            'engine:added',
            expect.not.objectContaining({ password: expect.anything() }),
        );
    });

    it('engine:create rejects duplicate engineId with a structured error', async () => {
        store.createEngine('eng-1', 'Engine One', 'pw');
        const { call } = captureHandlers(store);
        const res = (await call('engine:create', {
            engineId: 'eng-1',
            displayName: 'X',
            password: 'pw',
        })) as { ok: false; error: string };
        expect(res.ok).toBe(false);
        expect(res.error).toBe('Engine ID already exists');
    });

    it('engine:create rejects malformed engineId (charset / length) at the Zod boundary', async () => {
        const { call } = captureHandlers(store);
        const res = (await call('engine:create', {
            engineId: 'has/slash',
            displayName: 'X',
            password: 'pw',
        })) as { ok: false; error: string; details: string[] };
        expect(res.ok).toBe(false);
        expect(res.error).toBe('Validation failed');
        expect(res.details.join(' ')).toMatch(/engineId/);
    });

    it('engine:update changes display_name without touching password when password is omitted', async () => {
        store.createEngine('eng-1', 'Old Name', 'super-secret');
        const { call } = captureHandlers(store);
        const res = await call('engine:update', {
            engineId: 'eng-1',
            displayName: 'New Name',
        });
        expect(res.ok).toBe(true);
        const stored = store.getEngine('eng-1');
        expect(stored?.display_name).toBe('New Name');
        expect(stored?.password).toBe('super-secret');
    });

    it('engine:update changes the password when supplied', async () => {
        store.createEngine('eng-1', 'Engine One', 'old-secret');
        const { call, engineManager } = captureHandlers(store);
        await call('engine:update', {
            engineId: 'eng-1',
            displayName: 'Engine One',
            password: 'new-secret',
        });
        expect(store.getEngine('eng-1')?.password).toBe('new-secret');
        expect(engineManager.refreshEncryptionKeys).toHaveBeenCalled();
    });

    it('engine:update renames when newEngineId differs, profiles follow the PK swap', async () => {
        store.createEngine('old-id', 'Engine One', 'pw');
        store.createProfile('old-id', 'default', { modules: {} });
        store.setActiveProfile('old-id', 'default');
        const { call, io, engineManager, eventForwarder } = captureHandlers(store);

        const res = await call('engine:update', {
            engineId: 'old-id',
            newEngineId: 'new-id',
            displayName: 'Engine One',
        });

        expect(res.ok).toBe(true);
        expect(store.getEngine('old-id')).toBeUndefined();
        expect(store.getEngine('new-id')?.display_name).toBe('Engine One');
        expect(store.getProfiles('new-id')).toHaveLength(1);
        // Both cache rekey hooks must run + an engine:renamed broadcast goes
        // out carrying online:false (truthful — session is being torn down).
        expect(eventForwarder.notifyRename).toHaveBeenCalledWith('old-id', 'new-id');
        expect(engineManager.notifyRename).toHaveBeenCalledWith('old-id', 'new-id');
        const renamedCall = (io.emit as any).mock.calls.find(
            (c: unknown[]) => c[0] === 'engine:renamed',
        );
        expect(renamedCall![1]).toMatchObject({
            oldEngineId: 'old-id',
            newEngineId: 'new-id',
            engine: { engine_id: 'new-id', online: false },
        });
    });

    it('engine:update returns 409-equivalent when target engineId already exists', async () => {
        store.createEngine('eng-1', 'One', 'pw1');
        store.createEngine('eng-2', 'Two', 'pw2');
        const { call } = captureHandlers(store);
        const res = (await call('engine:update', {
            engineId: 'eng-1',
            newEngineId: 'eng-2',
            displayName: 'One',
        })) as { ok: false; error: string };
        expect(res.ok).toBe(false);
        expect(res.error).toBe('Engine ID already exists');
        // Both engines must be untouched by the rejected rename.
        expect(store.getEngine('eng-1')?.display_name).toBe('One');
        expect(store.getEngine('eng-2')?.display_name).toBe('Two');
    });

    it('engine:update rejects malformed engineId / newEngineId at the Zod boundary', async () => {
        store.createEngine('eng-1', 'One', 'pw');
        const { call } = captureHandlers(store);
        for (const bad of ['foo/bar', '..', 'has space', 'has:colon', 'a'.repeat(65)]) {
            const res = (await call('engine:update', {
                engineId: 'eng-1',
                newEngineId: bad,
                displayName: 'One',
            })) as { ok: false; error: string };
            expect(res.ok).toBe(false);
            expect(res.error).toBe('Validation failed');
        }
        expect(store.getEngine('eng-1')).toBeDefined();
    });

    it('engine:update 404s for unknown engine', async () => {
        const { call } = captureHandlers(store);
        const res = (await call('engine:update', {
            engineId: 'missing',
            displayName: 'X',
        })) as { ok: false; error: string };
        expect(res.ok).toBe(false);
        expect(res.error).toBe('Engine not found');
    });

    it('engine:delete removes the engine and broadcasts engine:removed', async () => {
        store.createEngine('eng-1', 'One', 'pw');
        const { call, io } = captureHandlers(store);
        const res = await call('engine:delete', { engineId: 'eng-1' });
        expect(res.ok).toBe(true);
        expect(store.getEngine('eng-1')).toBeUndefined();
        expect(io.emit).toHaveBeenCalledWith('engine:removed', { engineId: 'eng-1' });
    });

    it('engine:reorder applies the new ordering', async () => {
        store.createEngine('first', 'First', 'p');
        store.createEngine('second', 'Second', 'p');
        const { call, io } = captureHandlers(store);
        const res = await call('engine:reorder', {
            updates: [
                { engineId: 'second', groupId: 'ungrouped', sortOrder: 0 },
                { engineId: 'first', groupId: 'ungrouped', sortOrder: 1 },
            ],
        });
        expect(res.ok).toBe(true);
        const engines = store.getAllEngines();
        expect(engines.map((e) => e.engine_id)).toEqual(['second', 'first']);
        expect(io.emit).toHaveBeenCalledWith('engines:reordered', expect.objectContaining({}));
    });

    it('engine:reorder rejects moves into unknown groups (DB referential integrity)', async () => {
        store.createEngine('e1', 'E1', 'p');
        const { call } = captureHandlers(store);
        const res = (await call('engine:reorder', {
            updates: [{ engineId: 'e1', groupId: 'nonexistent', sortOrder: 0 }],
        })) as { ok: false; error: string };
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/Unknown group/);
    });
});

describe('rpcHandlers — groups', () => {
    let store: ConfigStore;
    beforeEach(() => {
        store = new ConfigStore(':memory:');
    });
    afterEach(() => {
        store.close();
    });

    it('engine-group:create returns the new id and broadcasts engine-group:added', async () => {
        const { call, io } = captureHandlers(store);
        const res = await call<{ data: { id: string } }>('engine-group:create', { name: 'Studio' });
        expect(res.ok).toBe(true);
        expect(typeof res.data.id).toBe('string');
        expect(store.getGroup(res.data.id)?.name).toBe('Studio');
        expect(io.emit).toHaveBeenCalledWith(
            'engine-group:added',
            expect.objectContaining({ name: 'Studio' }),
        );
    });

    it('engine-group:update can clear color via null', async () => {
        store.createGroup('grp1', 'Studio', '#10b981');
        const { call } = captureHandlers(store);
        const res = await call('engine-group:update', { groupId: 'grp1', color: null });
        expect(res.ok).toBe(true);
        expect(store.getGroup('grp1')?.color).toBeNull();
    });

    it('engine-group:delete refuses to remove the default group', async () => {
        const { call } = captureHandlers(store);
        const res = (await call('engine-group:delete', { groupId: 'ungrouped' })) as {
            ok: false;
            error: string;
        };
        expect(res.ok).toBe(false);
        expect(res.error).toBe('Cannot delete the default group');
    });

    it('engine-group:delete reassigns engines to Ungrouped and broadcasts', async () => {
        store.createEngine('e1', 'E1', 'p');
        store.createGroup('grp1', 'Studio');
        store.reorderEngines([{ engineId: 'e1', groupId: 'grp1', sortOrder: 0 }]);
        const { call, io } = captureHandlers(store);
        const res = await call('engine-group:delete', { groupId: 'grp1' });
        expect(res.ok).toBe(true);
        expect(store.getGroup('grp1')).toBeUndefined();
        expect(store.getEngine('e1')?.group_id).toBe('ungrouped');
        expect(io.emit).toHaveBeenCalledWith(
            'engine-group:removed',
            expect.objectContaining({ groupId: 'grp1' }),
        );
    });

    it('engine-group:reorder applies the new ordering', async () => {
        store.createGroup('a', 'A');
        store.createGroup('b', 'B');
        const { call } = captureHandlers(store);
        const res = await call('engine-group:reorder', { orderedIds: ['b', 'a', 'ungrouped'] });
        expect(res.ok).toBe(true);
        expect(store.getAllGroups().map((g) => g.id)).toEqual(['b', 'a', 'ungrouped']);
    });
});

describe('rpcHandlers — profiles', () => {
    let store: ConfigStore;
    beforeEach(() => {
        store = new ConfigStore(':memory:');
        store.createEngine('eng-1', 'Engine', 'pw');
    });
    afterEach(() => {
        store.close();
    });

    it('profile:list returns profile rows for the engine', async () => {
        store.createProfile('eng-1', 'p1', {});
        store.createProfile('eng-1', 'p2', {});
        const { call } = captureHandlers(store);
        const res = await call<{ data: Array<{ profile_name: string }> }>('profile:list', {
            engineId: 'eng-1',
        });
        expect(res.ok).toBe(true);
        expect(res.data.map((r) => r.profile_name).sort()).toEqual(['p1', 'p2']);
    });

    it('profile:create + profile:delete round-trip', async () => {
        const { call } = captureHandlers(store);
        const created = (await call('profile:create', {
            engineId: 'eng-1',
            profileName: 'prod',
        })) as { ok: true; data: { id: string } };
        expect(created.ok).toBe(true);
        expect(created.data).toEqual({ id: 'prod' });
        expect(store.getProfile('eng-1', 'prod')).toBeDefined();

        const deleted = await call('profile:delete', { engineId: 'eng-1', profileName: 'prod' });
        expect(deleted.ok).toBe(true);
        expect(store.getProfile('eng-1', 'prod')).toBeUndefined();
    });

    it('profile:delete refuses to remove the active profile', async () => {
        store.createProfile('eng-1', 'live', {});
        store.setActiveProfile('eng-1', 'live');
        const { call } = captureHandlers(store);
        const res = (await call('profile:delete', { engineId: 'eng-1', profileName: 'live' })) as {
            ok: false;
            error: string;
        };
        expect(res.ok).toBe(false);
        expect(res.error).toBe('Cannot delete the active profile');
    });

    it('profile:activate broadcasts engine:update patch with modules + connections', async () => {
        store.createProfile('eng-1', 'p1', {
            modules: { 'mod-a': { pluginId: 'audio-input' } },
            connections: [],
        });
        const { call, io } = captureHandlers(store);
        const res = await call('profile:activate', { engineId: 'eng-1', profileName: 'p1' });
        expect(res.ok).toBe(true);
        expect(store.getEngine('eng-1')?.active_profile).toBe('p1');
        const updateCall = (io.emit as any).mock.calls.find(
            (c: unknown[]) => c[0] === 'engine:update',
        );
        expect(updateCall).toBeDefined();
        expect(updateCall![1].patch).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ path: '/activeProfile', value: 'p1' }),
            ]),
        );
    });

    it('profile:activate routes through sendCommand("start") when the new profile is running', async () => {
        store.createProfile('eng-1', 'p1', {
            modules: { 'mod-a': { pluginId: 'audio-input' } },
            connections: [],
            running: true,
        });
        const { call, engineManager, engineCommands } = captureHandlers(store);
        (engineManager.isEngineOnline as any).mockReturnValue(true);
        (engineCommands.isRunning as any).mockReturnValue(true);

        const res = await call('profile:activate', { engineId: 'eng-1', profileName: 'p1' });
        expect(res.ok).toBe(true);

        // sendCommand handles config push + start with retry/dedupe — no
        // raw sendToEngine duplication from the handler.
        expect(engineCommands.sendCommand).toHaveBeenCalledWith('eng-1', 'start');
        expect(engineCommands.sendCommand).not.toHaveBeenCalledWith('eng-1', 'stop');
    });

    it('profile:activate stops the engine when switching from a running profile to a stopped one', async () => {
        // Old profile running; new profile last-known stopped — without the
        // explicit stop, the old profile's modules would keep running.
        store.createProfile('eng-1', 'old', { modules: {}, connections: [], running: true });
        store.setActiveProfile('eng-1', 'old');
        store.createProfile('eng-1', 'new', { modules: {}, connections: [], running: false });
        const { call, engineManager, engineCommands } = captureHandlers(store);
        (engineManager.isEngineOnline as any).mockReturnValue(true);
        // Reflect the active profile's stored running flag — true before
        // setActiveProfile fires, false after.
        (engineCommands.isRunning as any).mockImplementation((id: string) => {
            const engine = store.getEngine(id);
            if (!engine?.active_profile) return false;
            const cfg = store.getProfile(id, engine.active_profile as string);
            return (cfg?.running as boolean) ?? false;
        });

        const res = await call('profile:activate', { engineId: 'eng-1', profileName: 'new' });
        expect(res.ok).toBe(true);

        expect(engineCommands.sendCommand).toHaveBeenCalledWith('eng-1', 'stop');
        // Config still pushed so a later start uses the new profile's modules.
        const configCall = (engineManager.sendToEngine as any).mock.calls.find(
            (c: unknown[]) => c[1] === 'config',
        );
        expect(configCall).toBeDefined();
    });

    it('profile:activate just syncs config when both old and new profiles are stopped', async () => {
        store.createProfile('eng-1', 'p1', { modules: {}, connections: [], running: false });
        const { call, engineManager, engineCommands } = captureHandlers(store);
        (engineManager.isEngineOnline as any).mockReturnValue(true);
        (engineCommands.isRunning as any).mockReturnValue(false);

        const res = await call('profile:activate', { engineId: 'eng-1', profileName: 'p1' });
        expect(res.ok).toBe(true);

        expect(engineCommands.sendCommand).not.toHaveBeenCalled();
        const configCall = (engineManager.sendToEngine as any).mock.calls.find(
            (c: unknown[]) => c[1] === 'config',
        );
        expect(configCall).toBeDefined();
    });

    it('profile:config returns the stored config; 404 when missing', async () => {
        store.createProfile('eng-1', 'p1', { modules: {} });
        const { call } = captureHandlers(store);
        const ok = await call<{ data: Record<string, unknown> }>('profile:config', {
            engineId: 'eng-1',
            profileName: 'p1',
        });
        expect(ok.ok).toBe(true);
        expect(ok.data).toMatchObject({ modules: {} });

        const missing = (await call('profile:config', {
            engineId: 'eng-1',
            profileName: 'nope',
        })) as { ok: false; error: string };
        expect(missing.ok).toBe(false);
        expect(missing.error).toBe('Profile not found');
    });

    it('profile:rollback restores a prior version', async () => {
        store.createProfile('eng-1', 'p1', { modules: { a: {} } });
        // Mutate to create a history entry.
        store.updateProfileConfig('eng-1', 'p1', { modules: { b: {} } });
        const history = store.getVersionHistory('eng-1', 'p1');
        expect(history.length).toBeGreaterThan(0);

        const { call } = captureHandlers(store);
        const res = await call('profile:rollback', {
            engineId: 'eng-1',
            profileName: 'p1',
            versionId: history[0].id,
        });
        expect(res.ok).toBe(true);
    });
});

describe('rpcHandlers — plugins + devices', () => {
    let store: ConfigStore;
    beforeEach(() => {
        store = new ConfigStore(':memory:');
    });
    afterEach(() => {
        store.close();
    });

    it('plugin:list returns the registry contents', async () => {
        const { call } = captureHandlers(store);
        const res = await call<{ data: Array<{ id: string }> }>('plugin:list', null);
        expect(res.ok).toBe(true);
        expect(res.data.map((p) => p.id)).toEqual(['audio-input', 'audio-output']);
    });

    it('device:list returns the cached device snapshot for a type', async () => {
        store.createEngine('eng-1', 'E', 'p');
        const { call, eventForwarder } = captureHandlers(store);
        (eventForwarder.getEngineData as any).mockReturnValue([{ id: 'hw:0', label: 'Mic' }]);
        const res = await call<{ data: Array<{ id: string }> }>('device:list', {
            engineId: 'eng-1',
            type: 'audio-source',
        });
        expect(res.ok).toBe(true);
        expect(res.data).toEqual([{ id: 'hw:0', label: 'Mic' }]);
        expect(eventForwarder.getEngineData).toHaveBeenCalledWith('eng-1', 'devices:audio-source');
    });

    it('device:list 404s on unknown engine', async () => {
        const { call } = captureHandlers(store);
        const res = (await call('device:list', { engineId: 'unknown', type: 'audio-source' })) as {
            ok: false;
            error: string;
        };
        expect(res.ok).toBe(false);
        expect(res.error).toBe('Engine not found');
    });
});
