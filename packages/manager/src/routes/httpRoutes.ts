import type { Application } from 'express';
import express from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import * as path from 'path';
import * as fs from 'fs';
import { z } from 'zod';
import {
    createLogger,
    CreateEngineSchema,
    UpdateEngineSchema,
    CreateManagerProfileSchema,
    RollbackSchema,
} from '@media-router/shared-types';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { EngineConnectionManager } from '../engines/EngineConnectionManager.js';
import type { PluginRegistry } from '../plugins/PluginRegistry.js';
import type { EngineEventForwarder } from '../handlers/EngineEventForwarder.js';

const log = createLogger('HttpRoutes');

// CSS hex color (#abc | #aabbcc, optionally with alpha). Sidebar group accent.
const HexColor = z
    .string()
    .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);

// Schemas for sidebar grouping + ordering. Module-scope to match the rest of
// this file's pattern (UpdateEngineSchema, RollbackSchema, etc.).
const ReorderEnginesSchema = z.object({
    updates: z
        .array(
            z.object({
                engineId: z.string().min(1),
                groupId: z.string().min(1),
                sortOrder: z.number().int().nonnegative(),
            }),
        )
        .min(1),
});
const CreateGroupSchema = z.object({
    name: z.string().min(1).max(64),
    color: HexColor.optional(),
});
const UpdateGroupSchema = z.object({
    name: z.string().min(1).max(64).optional(),
    collapsed: z.boolean().optional(),
    color: HexColor.nullable().optional(),
});
const ReorderGroupsSchema = z.object({
    orderedIds: z.array(z.string().min(1)).min(1),
});

/** Wrap an Express handler with Zod body validation. Returns 400 with details on failure. */
function withBody<T>(
    schema: z.ZodType<T>,
    handler: (req: express.Request, res: express.Response, body: T) => void,
): express.RequestHandler {
    return ((req: express.Request, res: express.Response) => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            const details = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
            log.warn({ path: req.path, details }, 'Request body validation failed');
            res.status(400).json({ error: 'Validation failed', details });
            return;
        }
        handler(req, res, result.data);
    }) as express.RequestHandler;
}

/** Helper: get route param as string (Express v5 params can be string | string[]). */
function param(req: express.Request, name: string): string {
    const v = req.params[name];
    return Array.isArray(v) ? v[0] : v;
}

export interface HttpRouteDeps {
    app: Application;
    configStore: ConfigStore;
    engineManager: EngineConnectionManager;
    pluginRegistry: PluginRegistry;
    io: SocketIOServer;
    eventForwarder: EngineEventForwarder;
}

/**
 * Register all HTTP REST routes on the Express app.
 */
export function registerHttpRoutes(deps: HttpRouteDeps): void {
    const { app, configStore, engineManager, pluginRegistry, io, eventForwarder } = deps;

    /** Return engine or send 404. Caller must `return` if result is null. */
    function requireEngine(id: string, res: express.Response) {
        const engine = configStore.getEngine(id);
        if (!engine) res.status(404).json({ error: 'Engine not found' });
        return engine;
    }

    // Health
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', uptime: process.uptime() });
    });

    // Plugins
    app.get('/api/v1/plugins', (_req, res) => {
        res.json(pluginRegistry.getAll());
    });

    // Per-engine data (cached from engine reports — arbitrary topics). Most
    // device consumers prefer the typed route below; this one is for anything
    // not device-shaped (future: stream metrics, channel maps, etc.).
    app.get('/api/v1/engines/:id/data/:topic', (req, res) => {
        if (!requireEngine(req.params.id, res)) return;
        const data = eventForwarder.getEngineData(req.params.id, req.params.topic);
        res.json(data ?? []);
    });

    // Generic per-engine device list — any plugin-registered device type.
    // Initial snapshot for the UI; live updates come over Socket.IO
    // (`engine:deviceList` event broadcast to the `watch:<engineId>` room).
    app.get('/api/v1/engines/:id/system/devices/:type', (req, res) => {
        if (!requireEngine(req.params.id, res)) return;
        const devices = eventForwarder.getEngineData(
            req.params.id,
            `devices:${req.params.type}`,
        );
        res.json(devices ?? []);
    });

    // Engine CRUD. Strip `password` from listings — the dgram-comms shared
    // secret should never round-trip to clients. The edit form prefills only
    // displayName from this list and leaves the password field blank ("leave
    // blank to keep current"), so the secret stays server-side.
    app.get('/api/v1/engines', (_req, res) => {
        const engines = configStore.getAllEngines().map((e) => {
            const { password: _password, ...rest } = e as Record<string, unknown>;
            return {
                ...rest,
                online: engineManager.isEngineOnline(e.engine_id as string),
            };
        });
        res.json(engines);
    });

    app.post(
        '/api/v1/engines',
        withBody(CreateEngineSchema, (req, res, { engineId, displayName, password }) => {
            if (configStore.getEngine(engineId)) {
                res.status(409).json({ error: 'Engine ID already exists' });
                return;
            }
            configStore.createEngine(engineId, displayName, password);
            configStore.createProfile(engineId, 'default', {});
            configStore.setActiveProfile(engineId, 'default');
            engineManager.refreshEncryptionKeys();

            const engine = configStore.getEngine(engineId)!;
            const result = {
                engine_id: engine.engine_id,
                display_name: engine.display_name,
                active_profile: engine.active_profile,
                group_id: engine.group_id,
                sort_order: engine.sort_order,
                online: false,
            };
            io.emit('engine:added', result);
            res.status(201).json(result);
        }),
    );

    // NOTE: defined before `PUT /api/v1/engines/:id` so the literal `reorder`
    // path isn't swallowed as `id=reorder`. Express matches routes in
    // definition order.
    app.put(
        '/api/v1/engines/reorder',
        withBody(ReorderEnginesSchema, (_req, res, { updates }) => {
            // Reject moves into groups that don't exist — keeps the DB
            // referentially clean without a FK constraint (we kept the group
            // column nullable-free with a string default for migration ease).
            const known = new Set(configStore.getAllGroups().map((g) => g.id as string));
            for (const u of updates) {
                if (!known.has(u.groupId)) {
                    res.status(400).json({ error: `Unknown group: ${u.groupId}` });
                    return;
                }
            }
            configStore.reorderEngines(updates);
            io.emit('engines:reordered', { updates });
            res.json({ ok: true });
        }),
    );

    app.put(
        '/api/v1/engines/:id',
        withBody(UpdateEngineSchema, (req, res, { displayName, password }) => {
            const id = param(req, 'id');
            const engine = requireEngine(id, res);
            if (!engine) return;
            configStore.updateEngine(id, displayName, password || undefined);
            if (password) engineManager.refreshEncryptionKeys();
            const updated = configStore.getEngine(id)!;
            const result = {
                engine_id: updated.engine_id,
                display_name: updated.display_name,
                active_profile: updated.active_profile,
                group_id: updated.group_id,
                sort_order: updated.sort_order,
                online: engineManager.isEngineOnline(id),
            };
            io.emit('engine:updated', result);
            res.json(result);
        }),
    );

    app.delete('/api/v1/engines/:id', (req, res) => {
        if (!requireEngine(req.params.id, res)) return;
        configStore.deleteEngine(req.params.id);
        engineManager.refreshEncryptionKeys();
        io.emit('engine:removed', { engineId: req.params.id });
        res.json({ ok: true });
    });

    // --- Engine groups ---
    //
    // All sidebar-grouping mutations are HTTP, not Socket.IO, so the handlers
    // don't have a `socket` handle to skip on broadcast — every `io.emit(...)`
    // below intentionally fans out to all connected browsers including the
    // originator. This is safe (not strictly N-1) because the originating
    // browser applies the change optimistically via `applyReorder` /
    // `upsertFromRow`, which are idempotent: a re-application of the same
    // groupId+sortOrder is a no-op (see EngineStore.applyReorder). If we ever
    // need true sender-skip here we can plumb an X-Client-Id header through
    // and tag the broadcast.

    app.get('/api/v1/engine-groups', (_req, res) => {
        res.json(configStore.getAllGroups());
    });

    app.post(
        '/api/v1/engine-groups',
        withBody(CreateGroupSchema, (_req, res, { name, color }) => {
            // Short, stable, non-secret id. Crypto isn't required — these are
            // not credentials.
            const id = `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
            configStore.createGroup(id, name, color ?? null);
            const group = configStore.getGroup(id)!;
            io.emit('engine-group:added', group);
            res.status(201).json(group);
        }),
    );

    // Reorder before `:id` so the literal path isn't swallowed by the param route.
    app.put(
        '/api/v1/engine-groups/reorder',
        withBody(ReorderGroupsSchema, (_req, res, { orderedIds }) => {
            configStore.reorderGroups(orderedIds);
            io.emit('engine-groups:reordered', { orderedIds });
            res.json({ ok: true });
        }),
    );

    app.put(
        '/api/v1/engine-groups/:id',
        withBody(UpdateGroupSchema, (req, res, fields) => {
            const id = param(req, 'id');
            const existing = configStore.getGroup(id);
            if (!existing) {
                res.status(404).json({ error: 'Group not found' });
                return;
            }
            configStore.updateGroup(id, fields);
            const updated = configStore.getGroup(id)!;
            io.emit('engine-group:updated', updated);
            res.json(updated);
        }),
    );

    app.delete('/api/v1/engine-groups/:id', (req, res) => {
        const id = param(req, 'id');
        const existing = configStore.getGroup(id);
        if (!existing) {
            res.status(404).json({ error: 'Group not found' });
            return;
        }
        if (existing.is_default === 1) {
            res.status(400).json({ error: 'Cannot delete the default group' });
            return;
        }
        configStore.deleteGroup(id);
        // Engines moved to "Ungrouped" — broadcast the new ordering so every
        // browser stays in sync without each having to refetch.
        const reassigned = configStore
            .getAllEngines()
            .filter((e) => e.group_id === 'ungrouped')
            .map((e) => ({
                engineId: e.engine_id as string,
                groupId: 'ungrouped',
                sortOrder: e.sort_order as number,
            }));
        io.emit('engine-group:removed', { groupId: id, reassigned });
        res.json({ ok: true });
    });

    // Profile CRUD
    app.get('/api/v1/engines/:id/profiles', (req, res) => {
        res.json(configStore.getProfiles(req.params.id));
    });

    app.post(
        '/api/v1/engines/:id/profiles',
        withBody(CreateManagerProfileSchema, (req, res, { profileName, config }) => {
            const id = param(req, 'id');
            const engine = requireEngine(id, res);
            if (!engine) return;
            configStore.createProfile(id, profileName, config ?? {});
            res.status(201).json({ profile_name: profileName });
        }),
    );

    app.delete('/api/v1/engines/:id/profiles/:profile', (req, res) => {
        const engine = requireEngine(req.params.id, res);
        if (!engine) return;
        if (engine.active_profile === req.params.profile) {
            res.status(400).json({ error: 'Cannot delete the active profile' });
            return;
        }
        configStore.deleteProfile(req.params.id, req.params.profile);
        res.json({ ok: true });
    });

    app.post('/api/v1/engines/:id/profiles/:profile/activate', (req, res) => {
        if (!requireEngine(req.params.id, res)) return;
        const profile = configStore.getProfile(req.params.id, req.params.profile);
        if (!profile) {
            res.status(404).json({ error: 'Profile not found' });
            return;
        }
        configStore.setActiveProfile(req.params.id, req.params.profile);

        if (engineManager.isEngineOnline(req.params.id)) {
            engineManager.sendToEngine(req.params.id, 'config', profile, {
                guaranteeDelivery: true,
            });
        }

        const modules = (profile.modules ?? {}) as Record<string, Record<string, unknown>>;
        const connections = (profile.connections ?? []) as unknown[];
        // Imported profiles can lack instanceId / runtime fields on each
        // module; without these the browser builds Vue Flow nodes with
        // `id: undefined` and crashes in `parseNode` (e.id.toString).
        for (const [id, mod] of Object.entries(modules)) {
            pluginRegistry.enrichModule(id, mod);
        }

        io.emit('engine:update', {
            engineId: req.params.id,
            patch: [
                { op: 'replace', path: '/activeProfile', value: req.params.profile },
                { op: 'replace', path: '/modules', value: modules },
                { op: 'replace', path: '/connections', value: connections },
            ],
        });
        res.json({ ok: true });
    });

    app.get('/api/v1/engines/:id/profiles/:profile/config', (req, res) => {
        const config = configStore.getProfile(req.params.id, req.params.profile);
        if (!config) {
            res.status(404).json({ error: 'Profile not found' });
            return;
        }
        res.json(config);
    });

    app.get('/api/v1/engines/:id/profiles/:profile/history', (req, res) => {
        res.json(configStore.getVersionHistory(req.params.id, req.params.profile));
    });

    app.post(
        '/api/v1/engines/:id/profiles/:profile/rollback',
        withBody(RollbackSchema, (req, res, { versionId }) => {
            const id = param(req, 'id'),
                profile = param(req, 'profile');
            const version = configStore.getVersion(id, profile, versionId);
            if (!version) {
                res.status(404).json({ error: 'Version not found' });
                return;
            }
            configStore.updateProfileConfig(id, profile, version);
            res.json({ ok: true });
        }),
    );

    // Static file serving (manager-ui)
    const uiDistPath = path.resolve(__dirname, '../../../manager-ui/dist');
    if (fs.existsSync(uiDistPath)) {
        // Hashed assets (*.js, *.css) — cache forever (hash changes on rebuild)
        app.use(
            '/assets',
            express.static(path.join(uiDistPath, 'assets'), {
                maxAge: '1y',
                immutable: true,
            }),
        );
        // index.html — never cache (so browser always gets latest asset references)
        app.use(express.static(uiDistPath, { maxAge: 0, etag: false }));
        app.get('/{*path}', (req, res) => {
            if (
                req.path.startsWith('/api/') ||
                req.path.startsWith('/health') ||
                req.path.startsWith('/socket.io')
            ) {
                res.status(404).json({ error: 'Not found' });
                return;
            }
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.sendFile(path.join(uiDistPath, 'index.html'));
        });
    } else {
        app.get('/', (_req, res) => {
            res.json({
                status: 'ok',
                message:
                    'Manager API running. UI not built — run: pnpm --filter @media-router/manager-ui build',
            });
        });
    }
}
