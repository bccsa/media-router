import { defineStore } from 'pinia';
import { ref, shallowRef, readonly } from 'vue';
import { io, type Socket } from 'socket.io-client';
import { useEngineStore } from './engines';
import { useVuStore } from './vuMeters';
import { useLogStore } from './logs';

export const useSocketStore = defineStore('socket', () => {
    const connected = ref(false);
    const socket = shallowRef<Socket | null>(null);

    function connect() {
        // Clean up old socket listeners to prevent accumulation on reconnect
        if (socket.value) {
            socket.value.removeAllListeners();
            socket.value.disconnect();
            socket.value = null;
        }

        const s = io('/', {
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionAttempts: Infinity,
        });

        s.on('connect', () => {
            connected.value = true;
            console.log('[socket] Connected');
        });

        s.on('disconnect', () => {
            connected.value = false;
            console.log('[socket] Disconnected');
        });

        // Engine list (initial load on connect — includes modules/connections)
        s.on('engine:list', (list: any[]) => {
            const engines = useEngineStore();
            for (const e of list) {
                engines.addEngine(e);
            }
        });

        // Delta updates (JSON Patch)
        s.on('engine:update', (data: { engineId: string; patch: unknown[] }) => {
            const engines = useEngineStore();
            engines.applyEnginePatch(data.engineId, data.patch);
        });

        // Online/offline
        s.on('engine:online', (data: { engineId: string }) => {
            useEngineStore().setOnline(data.engineId, true);
        });
        s.on('engine:offline', (data: { engineId: string }) => {
            useEngineStore().setOnline(data.engineId, false);
        });

        // Engine running state
        s.on('engine:running', (data: { engineId: string; running: boolean }) => {
            const store = useEngineStore();
            store.setRunning(data.engineId, data.running);
            // Clear VU meters when engine stops
            if (!data.running) {
                useVuStore().clear(data.engineId);
            }
        });

        // Module state updates (health, running, errors)
        s.on('engine:state', (data: { engineId: string; state: Record<string, unknown> }) => {
            const store = useEngineStore();
            const engine = store.getEngine(data.engineId);
            if (!engine) return;
            // State is { [instanceId]: { running, health, error, ... } }
            for (const [instanceId, modState] of Object.entries(data.state)) {
                const mod = engine.modules[instanceId];
                if (mod && typeof modState === 'object' && modState !== null) {
                    const s = modState as Record<string, unknown>;
                    if ('health' in s) mod.health = s.health as string;
                    if ('running' in s) mod.running = s.running as boolean;
                    if ('error' in s) mod.error = s.error as string | undefined;
                    if ('statusData' in s) mod.statusData = s.statusData as any;
                    if ('dynamicStatusSections' in s) mod.dynamicStatusSections = s.dynamicStatusSections as any;
                    if ('badges' in s) mod.badges = s.badges as any;
                }
            }
            // Trigger reactivity
            store.touchEngine(data.engineId);
        });

        // VU meter data — uses dedicated VU store for fine-grained reactivity
        s.on('engine:vu', (data: { engineId: string; instanceId: string; vuData: number[] }) => {
            useVuStore().update(data.engineId, data.instanceId, data.vuData);
        });

        // System stats (CPU, memory, temp, IP, build)
        s.on('engine:system', (data: { engineId: string; cpu: number; mem: number; temp: number | null; processCount?: number; ip?: string; ips?: string[]; hostname?: string; buildNumber?: string }) => {
            const store = useEngineStore();
            store.setSystemStats(data.engineId, { cpu: data.cpu, mem: data.mem, temp: data.temp, processCount: data.processCount });
            if (data.ip || data.ips || data.hostname || data.buildNumber) {
                store.setEngineInfo(data.engineId, { ip: data.ip, ips: data.ips, hostname: data.hostname, buildNumber: data.buildNumber });
            }
        });

        // Log streaming
        s.on('engine:logs', (data: { engineId: string; entries: any[] }) => {
            useLogStore().addEntries(data.engineId, data.entries);
        });
        s.on('logs:history', (data: { engineId: string; entries: any[] }) => {
            useLogStore().setHistory(data.engineId, data.entries);
        });

        // Engine CRUD broadcasts
        s.on('engine:added', (data: any) => {
            useEngineStore().addEngine(data);
        });
        s.on('engine:updated', (data: any) => {
            useEngineStore().updateEngineInfo(data);
        });
        s.on('engine:removed', (data: { engineId: string }) => {
            useEngineStore().removeEngine(data.engineId);
        });

        socket.value = s;
    }

    function disconnect() {
        socket.value?.removeAllListeners();
        socket.value?.disconnect();
        socket.value = null;
        connected.value = false;
    }

    function emit(event: string, data?: unknown) {
        socket.value?.emit(event, data);
    }

    function requestLogHistory(engineId: string) {
        socket.value?.emit('logs:history', { engineId });
    }

    return {
        connected: readonly(connected),
        connect,
        disconnect,
        emit,
        requestLogHistory,
    };
});
