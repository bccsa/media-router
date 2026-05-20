import { describe, it, expect, vi } from 'vitest';
import { ConfigStore } from '../config/ConfigStore.js';
import { setupSocketIO } from './SocketIOSetup.js';

/**
 * Focused test on the `engine:list` initial-state payload — specifically
 * that the dgram-comms shared secret (`password`) never round-trips to the
 * browser. This is the only initial-state path now that the `GET
 * /api/v1/engines` listing was removed, so the guard has to live here.
 */
describe('setupSocketIO', () => {
    function mockDeps(configStore: ConfigStore) {
        // Capture the 'connection' handler so the test can drive it directly
        // without standing up a real Socket.IO server.
        let connectionHandler: ((socket: any) => void) | undefined;
        const io = {
            on: vi.fn((event: string, handler: (socket: any) => void) => {
                if (event === 'connection') connectionHandler = handler;
            }),
            emit: vi.fn(),
            to: vi.fn().mockReturnValue({ emit: vi.fn() }),
        } as any;

        const engineManager = {
            isEngineOnline: vi.fn().mockReturnValue(false),
        } as any;
        const pluginRegistry = {
            overlayManifest: vi.fn(),
        } as any;
        const engineCommands = {
            isRunning: vi.fn().mockReturnValue(false),
        } as any;
        const eventForwarder = {
            getCachedStates: vi.fn().mockReturnValue({}),
            getEngineData: vi.fn().mockReturnValue(undefined),
            getLogBuffer: vi.fn().mockReturnValue([]),
        } as any;
        const patchRouter = {
            onPatch: vi.fn(),
        } as any;

        setupSocketIO({
            io,
            configStore,
            engineManager,
            pluginRegistry,
            engineCommands,
            eventForwarder,
            patchRouter,
        });

        return { io, fireConnect: () => connectionHandler };
    }

    it('engine:list strips password from every engine row before emitting', () => {
        const store = new ConfigStore(':memory:');
        store.createEngine('eng-1', 'Engine One', 'super-secret');
        store.createEngine('eng-2', 'Engine Two', 'another-secret');

        const { fireConnect } = mockDeps(store);

        const socket = {
            id: 'sock-1',
            emit: vi.fn(),
            on: vi.fn(),
            rooms: new Set<string>(),
            join: vi.fn(),
            leave: vi.fn(),
        };
        fireConnect()!(socket as any);

        const listCall = socket.emit.mock.calls.find((c) => c[0] === 'engine:list');
        expect(listCall).toBeDefined();
        const rows = listCall![1] as Array<Record<string, unknown>>;
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row).not.toHaveProperty('password');
        }
        // The full serialized payload must not contain the secret anywhere
        // (defensive: catches future renames of the column, accidental
        // inclusion via a nested object, etc.).
        const payload = JSON.stringify(listCall![1]);
        expect(payload).not.toContain('super-secret');
        expect(payload).not.toContain('another-secret');

        store.close();
    });
});
