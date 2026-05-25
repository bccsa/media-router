import type { Server as SocketIOServer, Socket as IOSocket } from 'socket.io';
import { z } from 'zod';
import {
    createLogger,
    CreateEngineSchema,
    UpdateEngineSchema,
    DeleteEngineSchema,
    ReorderEnginesSchema,
    CreateGroupSchema,
    UpdateGroupSchema,
    DeleteGroupSchema,
    ReorderGroupsSchema,
    ListProfilesSchema,
    CreateManagerProfileSchema,
    DeleteProfileSchema,
    ActivateProfileSchema,
    ProfileQuerySchema,
    RollbackSchema,
    DeviceListSchema,
} from '@media-router/shared-types';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { EngineConnectionManager } from '../engines/EngineConnectionManager.js';
import type { PluginRegistry } from '../plugins/PluginRegistry.js';
import type { EngineEventForwarder } from '../handlers/EngineEventForwarder.js';
import type { EngineCommandService } from '../handlers/EngineCommandService.js';
import type { PluginUploadService } from '../services/PluginUploadService.js';

/**
 * Socket.IO carries binary payloads natively (the wire format is MessagePack
 * with Buffer support), so plugin uploads flow over the same RPC channel as
 * everything else rather than a dedicated HTTP route. Static GETs for preview
 * thumbnails still need HTTP because `<img src>` is HTTP-only; those live in
 * `httpRoutes.ts` and read from the same on-disk root.
 */
const PluginUploadSchema = z.object({
    pluginId: z.string().min(1),
    moduleId: z.string().min(1),
    filename: z.string().min(1),
    // Socket.IO's server-side parser always materialises incoming binary
    // payloads as Node `Buffer` — there's no ArrayBuffer path on this side
    // of the wire even when the client sent a `Uint8Array` / `ArrayBuffer`.
    bytes: z.instanceof(Buffer),
});

const PluginUploadGetSchema = z.object({
    pluginId: z.string().min(1),
    filename: z.string().min(1),
});

const log = createLogger('RpcHandlers');

/**
 * Ack envelope returned to the client via the Socket.IO callback. Success
 * always carries a `data` field (even if void) so the caller's promise
 * resolves to a defined shape. Failure carries a human-readable `error` and
 * optional structured `details` (used for Zod validation errors).
 */
export type Ack<T = void> =
    | { ok: true; data: T }
    | { ok: false; error: string; details?: string[] };

type AckCallback<T> = (response: Ack<T>) => void;

/**
 * Handler-level escape hatch for known failure modes (404, 409, etc.). The
 * `respond` wrapper catches it and translates to a structured ack instead of
 * a generic 'Internal error'. Use for anything the client should render — not
 * for unexpected programming errors (let those bubble to the catch-all).
 */
export class RpcError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RpcError';
    }
}

/**
 * Bind a single RPC event: validate payload with Zod, run the handler, send
 * the result (or any error) back through the Socket.IO ack callback.
 *
 * Handlers can return data, void, or a Promise of either. Throw `RpcError`
 * for client-facing failures; any other thrown error is logged and surfaced
 * as a generic 'Internal error'.
 */
function respond<T, R>(
    socket: IOSocket,
    event: string,
    schema: z.ZodType<T>,
    handler: (data: T) => R | Promise<R>,
): void {
    socket.on(event, async (raw: unknown, ack?: AckCallback<R>) => {
        const cb: AckCallback<R> = typeof ack === 'function' ? ack : () => {};
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
            const details = parsed.error.issues.map(
                (i) => `${i.path.join('.')}: ${i.message}`,
            );
            log.warn({ event, details }, 'Validation failed');
            cb({ ok: false, error: 'Validation failed', details });
            return;
        }
        try {
            const data = await handler(parsed.data);
            cb({ ok: true, data: data as R });
        } catch (err) {
            if (err instanceof RpcError) {
                cb({ ok: false, error: err.message });
                return;
            }
            log.error({ err, event }, 'Handler threw');
            cb({ ok: false, error: 'Internal error' });
        }
    });
}

export interface RpcDeps {
    io: SocketIOServer;
    configStore: ConfigStore;
    engineManager: EngineConnectionManager;
    pluginRegistry: PluginRegistry;
    eventForwarder: EngineEventForwarder;
    engineCommands: EngineCommandService;
    pluginUploads: PluginUploadService;
}

/**
 * Register the application API on a freshly-connected browser socket. State
 * propagation (broadcasts) still goes through `io.emit` so every browser
 * picks up the change, not just the originator.
 */
export function registerRpcHandlers(socket: IOSocket, deps: RpcDeps): void {
    const { io, configStore, engineManager, pluginRegistry, eventForwarder, engineCommands, pluginUploads } = deps;

    /** Throws RpcError(404) if the engine is missing. Use as a guard at the top of handlers. */
    function requireEngine(engineId: string): Record<string, unknown> {
        const engine = configStore.getEngine(engineId);
        if (!engine) throw new RpcError('Engine not found');
        return engine;
    }

    // --- Plugins ---

    respond(socket, 'plugin:list', z.object({}).optional().nullable(), () =>
        pluginRegistry.getAll(),
    );

    // --- Devices (initial snapshot; live updates already broadcast to watch:<id>) ---

    respond(socket, 'device:list', DeviceListSchema, ({ engineId, type }) => {
        requireEngine(engineId);
        const devices = eventForwarder.getEngineData(engineId, `devices:${type}`);
        return devices ?? [];
    });

    // --- Engine CRUD ---

    respond(socket, 'engine:create', CreateEngineSchema, ({ engineId, displayName, password }) => {
        if (configStore.getEngine(engineId)) {
            throw new RpcError('Engine ID already exists');
        }
        configStore.createEngine(engineId, displayName, password);
        configStore.createProfile(engineId, 'default', {});
        configStore.setActiveProfile(engineId, 'default');
        engineManager.refreshEncryptionKeys();

        const engine = configStore.getEngine(engineId)!;
        io.emit('engine:added', {
            engine_id: engine.engine_id,
            display_name: engine.display_name,
            active_profile: engine.active_profile,
            group_id: engine.group_id,
            sort_order: engine.sort_order,
            online: false,
        });
        // All *:create RPCs return `{ id }` for the just-created entity —
        // the broadcast carries the canonical record, the ack just lets the
        // caller correlate the response with what it asked to create.
        return { id: engineId };
    });

    respond(
        socket,
        'engine:update',
        UpdateEngineSchema,
        ({ engineId, displayName, password, newEngineId }) => {
            requireEngine(engineId);
            const renamed = !!newEngineId && newEngineId !== engineId;

            if (renamed) {
                // Pre-check collision so the UI gets a friendly error instead
                // of a generic 500 from the SQLite PK constraint.
                if (configStore.getEngine(newEngineId!)) {
                    throw new RpcError('Engine ID already exists');
                }
                try {
                    // Atomic: PK swap + display_name/password all-or-nothing
                    // (see EngineRepository.rename for the transaction).
                    configStore.renameEngine(engineId, newEngineId!, {
                        displayName,
                        password: password || undefined,
                    });
                } catch (err) {
                    log.error(
                        { err, oldId: engineId, newId: newEngineId },
                        'Engine rename failed',
                    );
                    throw new RpcError('Failed to rename engine');
                }

                // Order matters — see ConfigStore.renameEngine + the dgram-
                // comms session teardown:
                //   1) move event-forwarder caches under newId BEFORE the
                //      engineOffline(oldId) fires (step 3 below would clear
                //      them otherwise).
                eventForwarder.notifyRename(engineId, newEngineId!);

                //   2) emit engine:renamed with online:false (truthful — the
                //      old session is about to be destroyed and the engine
                //      hasn't reconnected under newId yet).
                const updated = configStore.getEngine(newEngineId!)!;
                io.emit('engine:renamed', {
                    oldEngineId: engineId,
                    newEngineId,
                    engine: {
                        engine_id: updated.engine_id,
                        display_name: updated.display_name,
                        active_profile: updated.active_profile,
                        group_id: updated.group_id,
                        sort_order: updated.sort_order,
                        online: false,
                    },
                });

                //   3) close the live UDP session. socket.destroy()
                //      synchronously fires engineOffline(oldId) → io.emit(
                //      'engine:offline', oldId) AFTER our engine:renamed, so
                //      the browser correctly no-ops the trailing offline.
                engineManager.notifyRename(engineId, newEngineId!);

                //   4) rebuild the encryption-keys map — old id is no longer
                //      in the DB, new id needs the password registered for
                //      the eventual reconnect.
                engineManager.refreshEncryptionKeys();
            } else {
                configStore.updateEngine(engineId, displayName, password || undefined);
                if (password) engineManager.refreshEncryptionKeys();

                const updated = configStore.getEngine(engineId)!;
                io.emit('engine:updated', {
                    engine_id: updated.engine_id,
                    display_name: updated.display_name,
                    active_profile: updated.active_profile,
                    group_id: updated.group_id,
                    sort_order: updated.sort_order,
                    online: engineManager.isEngineOnline(engineId),
                });
            }
        },
    );

    respond(socket, 'engine:delete', DeleteEngineSchema, ({ engineId }) => {
        requireEngine(engineId);
        configStore.deleteEngine(engineId);
        engineManager.refreshEncryptionKeys();
        io.emit('engine:removed', { engineId });
    });

    respond(socket, 'engine:reorder', ReorderEnginesSchema, ({ updates }) => {
        // Reject moves into non-existent groups — keeps the DB referentially
        // clean without a FK constraint on group_id.
        const known = new Set(configStore.getAllGroups().map((g) => g.id as string));
        for (const u of updates) {
            if (!known.has(u.groupId)) {
                throw new RpcError(`Unknown group: ${u.groupId}`);
            }
        }
        configStore.reorderEngines(updates);
        io.emit('engines:reordered', { updates });
    });

    // --- Engine groups ---

    respond(socket, 'engine-group:create', CreateGroupSchema, ({ name, color }) => {
        const id = `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        configStore.createGroup(id, name, color ?? null);
        io.emit('engine-group:added', configStore.getGroup(id));
        return { id };
    });

    respond(socket, 'engine-group:update', UpdateGroupSchema, ({ groupId, ...fields }) => {
        if (!configStore.getGroup(groupId)) throw new RpcError('Group not found');
        configStore.updateGroup(groupId, fields);
        io.emit('engine-group:updated', configStore.getGroup(groupId));
    });

    respond(socket, 'engine-group:delete', DeleteGroupSchema, ({ groupId }) => {
        const existing = configStore.getGroup(groupId);
        if (!existing) throw new RpcError('Group not found');
        if (existing.is_default === 1) throw new RpcError('Cannot delete the default group');
        configStore.deleteGroup(groupId);
        const reassigned = configStore
            .getAllEngines()
            .filter((e) => e.group_id === 'ungrouped')
            .map((e) => ({
                engineId: e.engine_id as string,
                groupId: 'ungrouped',
                sortOrder: e.sort_order as number,
            }));
        io.emit('engine-group:removed', { groupId, reassigned });
    });

    respond(socket, 'engine-group:reorder', ReorderGroupsSchema, ({ orderedIds }) => {
        configStore.reorderGroups(orderedIds);
        io.emit('engine-groups:reordered', { orderedIds });
    });

    // --- Profiles ---

    respond(socket, 'profile:list', ListProfilesSchema, ({ engineId }) => {
        return configStore.getProfiles(engineId);
    });

    respond(
        socket,
        'profile:create',
        CreateManagerProfileSchema,
        ({ engineId, profileName, config }) => {
            requireEngine(engineId);
            configStore.createProfile(engineId, profileName, config ?? {});
            return { id: profileName };
        },
    );

    respond(socket, 'profile:delete', DeleteProfileSchema, ({ engineId, profileName }) => {
        const engine = requireEngine(engineId);
        if (engine.active_profile === profileName) {
            throw new RpcError('Cannot delete the active profile');
        }
        configStore.deleteProfile(engineId, profileName);
    });

    respond(
        socket,
        'profile:activate',
        ActivateProfileSchema,
        ({ engineId, profileName }) => {
            requireEngine(engineId);
            const profile = configStore.getProfile(engineId, profileName);
            if (!profile) throw new RpcError('Profile not found');

            // `isRunning` resolves through the engine's *active* profile, so
            // capture the pre-switch state before we swap.
            const wasRunning = engineCommands.isRunning(engineId);
            configStore.setActiveProfile(engineId, profileName);
            const willBeRunning = engineCommands.isRunning(engineId);

            if (engineManager.isEngineOnline(engineId)) {
                if (willBeRunning) {
                    // sendCommand pushes config then start; startAll destroys
                    // the old profile's modules before creating the new ones.
                    engineCommands.sendCommand(engineId, 'start');
                } else if (wasRunning) {
                    // New profile is stopped but the engine was running the
                    // old one — push config and stop so old modules clear.
                    engineManager.sendToEngine(engineId, 'config', profile, {
                        guaranteeDelivery: true,
                    });
                    engineCommands.sendCommand(engineId, 'stop');
                } else {
                    engineManager.sendToEngine(engineId, 'config', profile, {
                        guaranteeDelivery: true,
                    });
                }
            }

            const modules = (profile.modules ?? {}) as Record<string, Record<string, unknown>>;
            const connections = (profile.connections ?? []) as unknown[];
            // Imported profiles can lack instanceId / runtime fields on each
            // module; without enrichment the browser builds Vue Flow nodes
            // with `id: undefined` and crashes in `parseNode`.
            for (const [moduleId, mod] of Object.entries(modules)) {
                pluginRegistry.enrichModule(moduleId, mod);
            }

            io.emit('engine:update', {
                engineId,
                patch: [
                    { op: 'replace', path: '/activeProfile', value: profileName },
                    { op: 'replace', path: '/modules', value: modules },
                    { op: 'replace', path: '/connections', value: connections },
                ],
            });
        },
    );

    respond(socket, 'profile:config', ProfileQuerySchema, ({ engineId, profileName }) => {
        const config = configStore.getProfile(engineId, profileName);
        if (!config) throw new RpcError('Profile not found');
        return config;
    });

    respond(socket, 'profile:history', ProfileQuerySchema, ({ engineId, profileName }) => {
        return configStore.getVersionHistory(engineId, profileName);
    });

    respond(
        socket,
        'profile:rollback',
        RollbackSchema,
        ({ engineId, profileName, versionId }) => {
            const version = configStore.getVersion(engineId, profileName, versionId);
            if (!version) throw new RpcError('Version not found');
            configStore.updateProfileConfig(engineId, profileName, version);
        },
    );

    // Generic plugin upload — any plugin whose schema declares an upload
    // widget can hit this. The service handles validation, dedup-by-module
    // and on-disk layout; this binding is just the transport.
    respond(socket, 'plugin:upload', PluginUploadSchema, ({ pluginId, moduleId, filename, bytes }) => {
        try {
            return pluginUploads.save({ pluginId, moduleId, filename, bytes });
        } catch (err) {
            throw new RpcError((err as Error).message);
        }
    });

    // Read-back for previews. Socket.IO encodes the returned Buffer as a
    // binary frame on the wire — the UI wraps it in a `data:` URL so
    // <img> can render it without a parallel HTTP route.
    respond(socket, 'plugin:upload-get', PluginUploadGetSchema, ({ pluginId, filename }) => {
        try {
            return pluginUploads.read(pluginId, filename);
        } catch (err) {
            throw new RpcError((err as Error).message);
        }
    });
}
