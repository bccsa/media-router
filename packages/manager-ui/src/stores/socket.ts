import { defineStore } from 'pinia';
import { ref, shallowRef, readonly } from 'vue';
import { io, type Socket } from 'socket.io-client';
import { useEngineStore } from './engines';
import { useEngineGroupsStore } from './engineGroups';
import { useVuStore } from './vuMeters';
import { useLogStore } from './logs';
import { useDeviceStore } from './devices';
import type { Device } from '@media-router/shared-types';

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

        // Engine list (lightweight — metadata only, no modules/connections)
        s.on('engine:list', (list: any[]) => {
            const engines = useEngineStore();
            for (const e of list) {
                engines.addEngine(e);
            }
        });

        // Engine config (full modules/connections — sent when watch:engine fires)
        s.on(
            'engine:config',
            (data: {
                engineId: string;
                modules: Record<string, unknown>;
                connections: unknown[];
            }) => {
                const engines = useEngineStore();
                engines.setEngineConfig(data.engineId, data.modules, data.connections);
            },
        );

        // Delta updates (JSON Patch)
        s.on('engine:update', (data: { engineId: string; patch: unknown[] }) => {
            const engines = useEngineStore();
            engines.applyEnginePatch(data.engineId, data.patch);
        });

        // Live device-list push — any plugin-registered device type.
        // Fired by the manager whenever an engine's device list changes;
        // settings panels read from `useDeviceStore` for instant updates.
        s.on(
            'engine:deviceList',
            (data: { engineId: string; type: string; devices: Device[] }) => {
                useDeviceStore().applyPush(data);
            },
        );

        // Online/offline
        s.on('engine:online', (data: { engineId: string }) => {
            useEngineStore().setOnline(data.engineId, true);
        });
        s.on('engine:offline', (data: { engineId: string }) => {
            useEngineStore().setOnline(data.engineId, false);
            useEngineStore().clearEngineRuntime(data.engineId);
            useVuStore().clear(data.engineId);
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
                    if ('dynamicStatusSections' in s)
                        mod.dynamicStatusSections = s.dynamicStatusSections as any;
                    if ('badges' in s) mod.badges = s.badges as any;
                    // Plugins may change their live-updatable set based on
                    // current config (e.g. AV1 drops `bitrate`). Keep the UI
                    // in sync so the ⚡ icon follows.
                    if ('liveUpdatableParams' in s)
                        mod.liveUpdatableParams = s.liveUpdatableParams as string[] | undefined;
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
        s.on(
            'engine:system',
            (data: {
                engineId: string;
                cpu: number;
                mem: number;
                temp: number | null;
                processCount?: number;
                ip?: string;
                ips?: string[];
                hostname?: string;
                buildNumber?: string;
            }) => {
                const store = useEngineStore();
                store.setSystemStats(data.engineId, {
                    cpu: data.cpu,
                    mem: data.mem,
                    temp: data.temp,
                    processCount: data.processCount,
                });
                if (data.ip || data.ips || data.hostname || data.buildNumber) {
                    store.setEngineInfo(data.engineId, {
                        ip: data.ip,
                        ips: data.ips,
                        hostname: data.hostname,
                        buildNumber: data.buildNumber,
                    });
                }
            },
        );

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
        s.on(
            'engine:renamed',
            (data: {
                oldEngineId: string;
                newEngineId: string;
                engine: Record<string, unknown>;
            }) => {
                // Rekey first, then merge the freshly-stored metadata under
                // the new key. The server bundles both onto one event so the
                // order is local — there's no race where engine:updated could
                // arrive before the rekey.
                //
                // Auxiliary stores are keyed by engineId too and would otherwise
                // hold their data under the orphan old key — the detail view
                // would render empty logs / device dropdowns / VU meters until
                // the engine republished (which it might not, if idle).
                const store = useEngineStore();
                store.renameEngine(data.oldEngineId, data.newEngineId);
                store.updateEngineInfo(data.engine);
                useLogStore().rename(data.oldEngineId, data.newEngineId);
                useDeviceStore().rename(data.oldEngineId, data.newEngineId);
                useVuStore().rename(data.oldEngineId, data.newEngineId);
            },
        );
        s.on('engine:removed', (data: { engineId: string }) => {
            useEngineStore().removeEngine(data.engineId);
        });

        // Engine groups + sidebar ordering. Initial set arrives once on
        // connect (`engine-group:list`); subsequent mutations come as
        // targeted events so we don't re-render the whole list.
        s.on('engine-group:list', (list: Array<Record<string, unknown>>) => {
            useEngineGroupsStore().setAll(list);
        });
        s.on('engine-group:added', (row: Record<string, unknown>) => {
            useEngineGroupsStore().upsertFromRow(row);
        });
        s.on('engine-group:updated', (row: Record<string, unknown>) => {
            useEngineGroupsStore().upsertFromRow(row);
        });
        s.on(
            'engine-group:removed',
            (data: {
                groupId: string;
                reassigned: Array<{ engineId: string; groupId: string; sortOrder: number }>;
            }) => {
                useEngineGroupsStore().removeGroup(data.groupId);
                useEngineStore().applyReorder(data.reassigned);
            },
        );
        s.on('engine-groups:reordered', (data: { orderedIds: string[] }) => {
            useEngineGroupsStore().applyOrder(data.orderedIds);
        });
        s.on(
            'engines:reordered',
            (data: {
                updates: Array<{ engineId: string; groupId: string; sortOrder: number }>;
            }) => {
                useEngineStore().applyReorder(data.updates);
            },
        );

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

    /**
     * Manager RPC: emit an event with a payload and resolve with the server's
     * ack response. Replaces the old `fetch('/api/v1/...')` calls now that
     * the HTTP API has been retired in favour of a single Socket.IO channel.
     *
     * Rejects on server-reported errors (404, 409, validation, internal) and
     * on transport-level failures (socket not connected, ack timeout). The
     * caller's catch block deals with both the same way — there's no useful
     * client-side distinction between "server said no" and "network said no".
     *
     * `timeoutMs` lets the caller widen the default for slow paths (e.g.
     * `profile:activate` does a guaranteed-delivery config push plus plugin
     * enrichment over every module; on a loaded Pi with SQLite contention
     * that can take several seconds). The default of 10s suits read-shaped
     * RPCs (`plugin:list`, `device:list`) and quick mutations.
     */
    function request<T = void>(
        event: string,
        payload?: unknown,
        opts?: { timeoutMs?: number },
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            const s = socket.value;
            if (!s) {
                reject(new Error('Socket not connected'));
                return;
            }
            const timer = setTimeout(() => {
                reject(new Error(`Request '${event}' timed out`));
            }, opts?.timeoutMs ?? 10_000);
            s.emit(event, payload ?? null, (ack: unknown) => {
                clearTimeout(timer);
                if (!ack || typeof ack !== 'object') {
                    reject(new Error(`Malformed ack for '${event}'`));
                    return;
                }
                const a = ack as { ok: boolean; data?: T; error?: string };
                if (a.ok) resolve(a.data as T);
                else reject(new Error(a.error ?? 'Unknown error'));
            });
        });
    }

    return {
        connected: readonly(connected),
        connect,
        disconnect,
        emit,
        requestLogHistory,
        request,
    };
});
