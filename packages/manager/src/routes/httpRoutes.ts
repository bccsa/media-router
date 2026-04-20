import type { Application } from 'express';
import express from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { execFile } from 'child_process';
import { promisify } from 'util';
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

    // Audio devices (async to avoid blocking the event loop)
    const execFileAsync = promisify(execFile);
    app.get('/api/v1/audio/devices', async (_req, res) => {
        const devices: Array<{
            name: string;
            description: string;
            direction: string;
            channels: number;
            sampleRate: number;
        }> = [];
        try {
            const parseDevices = (output: string, direction: string) => {
                let name = '';
                let description = '';
                let channels = 2;
                let sampleRate = 48000;
                for (const line of output.split('\n')) {
                    const nameMatch = line.match(/^\s+Name:\s+(.+)/);
                    const descMatch = line.match(/^\s+Description:\s+(.+)/);
                    const specMatch = line.match(
                        /^\s+Sample Specification:\s+\S+\s+(\d+)ch\s+(\d+)Hz/,
                    );
                    if (nameMatch) name = nameMatch[1];
                    if (descMatch) description = descMatch[1];
                    if (specMatch) {
                        channels = parseInt(specMatch[1], 10);
                        sampleRate = parseInt(specMatch[2], 10);
                    }
                    if (line.trim() === '' && name && description) {
                        if (direction !== 'source' || !name.endsWith('.monitor')) {
                            devices.push({ name, description, direction, channels, sampleRate });
                        }
                        name = '';
                        description = '';
                        channels = 2;
                        sampleRate = 48000;
                    }
                }
                if (name && description) {
                    if (direction !== 'source' || !name.endsWith('.monitor')) {
                        devices.push({ name, description, direction, channels, sampleRate });
                    }
                }
            };
            const [sinks, sources] = await Promise.all([
                execFileAsync('pactl', ['list', 'sinks'], { encoding: 'utf-8' }),
                execFileAsync('pactl', ['list', 'sources'], { encoding: 'utf-8' }),
            ]);
            parseDevices(sinks.stdout, 'sink');
            parseDevices(sources.stdout, 'source');
        } catch (err) {
            log.warn({ err }, 'Failed to enumerate local audio devices via pactl');
        }
        res.json(devices);
    });

    // Per-engine data (cached from engine reports — audio devices, etc.)
    app.get('/api/v1/engines/:id/data/:topic', (req, res) => {
        if (!requireEngine(req.params.id, res)) return;
        const data = eventForwarder.getEngineData(req.params.id, req.params.topic);
        res.json(data ?? []);
    });

    // Shortcut: per-engine audio devices
    app.get('/api/v1/engines/:id/audio/devices', (req, res) => {
        if (!requireEngine(req.params.id, res)) return;
        const devices = eventForwarder.getEngineData(req.params.id, 'audioDevices');
        res.json(devices ?? []);
    });

    // Engine CRUD
    app.get('/api/v1/engines', (_req, res) => {
        const engines = configStore.getAllEngines().map((e) => ({
            ...e,
            online: engineManager.isEngineOnline(e.engine_id as string),
        }));
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
                online: false,
            };
            io.emit('engine:added', result);
            res.status(201).json(result);
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
        const pluginManifests = pluginRegistry.getAll();
        for (const [, mod] of Object.entries(modules)) {
            const manifest = pluginManifests.find((p) => p.pluginId === mod.pluginId);
            if (manifest) {
                mod.ports = manifest.ports ?? [];
                mod.configSchema = manifest.configSchema ?? {};
                mod.statusSections = manifest.statusSections;
                mod.faceWidgets = manifest.faceWidgets;
                mod.color = manifest.color;
                mod.icon = manifest.icon;
            }
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
