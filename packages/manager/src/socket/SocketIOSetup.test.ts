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
    /**
     * Spin up `setupSocketIO` with throwaway mocks and capture the connection
     * handler. `online` controls `engineManager.isEngineOnline`; other deps
     * use default no-op behaviour and are returned for per-test overrides.
     */
    function mockDeps(configStore: ConfigStore, { online = false }: { online?: boolean } = {}) {
        let connectionHandler: ((socket: any) => void) | undefined;
        const io = {
            on: vi.fn((event: string, handler: (socket: any) => void) => {
                if (event === 'connection') connectionHandler = handler;
            }),
            emit: vi.fn(),
            to: vi.fn().mockReturnValue({ emit: vi.fn() }),
        } as any;

        const engineManager = {
            isEngineOnline: vi.fn().mockReturnValue(online),
            sendToEngine: vi.fn(),
        } as any;
        const pluginRegistry = { overlayManifest: vi.fn() } as any;
        const engineCommands = { isRunning: vi.fn().mockReturnValue(false) } as any;
        const eventForwarder = {
            getCachedStates: vi.fn().mockReturnValue({}),
            getEngineData: vi.fn().mockReturnValue(undefined),
            getLogBuffer: vi.fn().mockReturnValue([]),
        } as any;
        const patchRouter = { onPatch: vi.fn() } as any;

        setupSocketIO({
            io,
            configStore,
            engineManager,
            pluginRegistry,
            engineCommands,
            eventForwarder,
            patchRouter,
        });

        /** Drive the connection handler with a captured socket; returns the
         *  per-event handler map the test can fire against. */
        function connectSocket() {
            const handlers: Record<string, (payload: unknown) => void> = {};
            const socket = {
                id: 'sock-1',
                emit: vi.fn(),
                on: vi.fn((event: string, handler: (payload: unknown) => void) => {
                    handlers[event] = handler;
                }),
                rooms: new Set<string>(),
                join: vi.fn(),
                leave: vi.fn(),
            };
            connectionHandler!(socket as any);
            return { socket, handlers };
        }

        return { io, engineManager, connectSocket, fireConnect: () => connectionHandler };
    }

    it('engine:reboot forwards a reboot command to the online engine', () => {
        const store = new ConfigStore(':memory:');
        store.createEngine('eng-1', 'Engine One', 'pw');
        const { engineManager, connectSocket } = mockDeps(store, { online: true });
        const { handlers } = connectSocket();

        handlers['engine:reboot']!({ engineId: 'eng-1' });

        expect(engineManager.sendToEngine).toHaveBeenCalledWith(
            'eng-1',
            'command',
            { command: 'reboot' },
            { guaranteeDelivery: true },
        );
        store.close();
    });

    it('engine:reboot is a no-op when the engine is offline', () => {
        const store = new ConfigStore(':memory:');
        store.createEngine('eng-1', 'Engine One', 'pw');
        const { engineManager, connectSocket } = mockDeps(store, { online: false });
        const { handlers } = connectSocket();

        handlers['engine:reboot']!({ engineId: 'eng-1' });

        expect(engineManager.sendToEngine).not.toHaveBeenCalled();
        store.close();
    });

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
