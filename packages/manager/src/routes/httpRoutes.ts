import type { Application } from 'express';
import express from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { EngineConnectionManager } from '../engines/EngineConnectionManager.js';
import type { PluginRegistry } from '../plugins/PluginRegistry.js';

export interface HttpRouteDeps {
    app: Application;
    configStore: ConfigStore;
    engineManager: EngineConnectionManager;
    pluginRegistry: PluginRegistry;
    io: SocketIOServer;
}

/**
 * Register all HTTP REST routes on the Express app.
 */
export function registerHttpRoutes(deps: HttpRouteDeps): void {
    const { app, configStore, engineManager, pluginRegistry, io } = deps;

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

    // Audio devices
    app.get('/api/v1/audio/devices', (_req, res) => {
        const devices: Array<{ name: string; description: string; direction: string; channels: number; sampleRate: number }> = [];
        try {
            const parseDevices = (output: string, direction: string) => {
                let name = '';
                let description = '';
                let channels = 2;
                let sampleRate = 48000;
                for (const line of output.split('\n')) {
                    const nameMatch = line.match(/^\s+Name:\s+(.+)/);
                    const descMatch = line.match(/^\s+Description:\s+(.+)/);
                    const specMatch = line.match(/^\s+Sample Specification:\s+\S+\s+(\d+)ch\s+(\d+)Hz/);
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
                        name = ''; description = ''; channels = 2; sampleRate = 48000;
                    }
                }
                if (name && description) {
                    if (direction !== 'source' || !name.endsWith('.monitor')) {
                        devices.push({ name, description, direction, channels, sampleRate });
                    }
                }
            };
            parseDevices(execFileSync('pactl', ['list', 'sinks'], { encoding: 'utf-8' }), 'sink');
            parseDevices(execFileSync('pactl', ['list', 'sources'], { encoding: 'utf-8' }), 'source');
        } catch {}
        res.json(devices);
    });

    // Engine CRUD
    app.get('/api/v1/engines', (_req, res) => {
        const engines = configStore.getAllEngines().map((e) => ({
            ...e,
            online: engineManager.isEngineOnline(e.engine_id as string),
        }));
        res.json(engines);
    });

    app.post('/api/v1/engines', (req, res) => {
        const { engineId, displayName, password } = req.body;
        if (!engineId || !displayName || !password) {
            res.status(400).json({ error: 'engineId, displayName, and password are required' });
            return;
        }
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
    });

    app.put('/api/v1/engines/:id', (req, res) => {
        const engine = requireEngine(req.params.id, res);
        if (!engine) return;
        const { displayName, password } = req.body;
        if (!displayName) { res.status(400).json({ error: 'displayName is required' }); return; }
        configStore.updateEngine(req.params.id, displayName, password || undefined);
        if (password) engineManager.refreshEncryptionKeys();
        const updated = configStore.getEngine(req.params.id)!;
        const result = {
            engine_id: updated.engine_id,
            display_name: updated.display_name,
            active_profile: updated.active_profile,
            online: engineManager.isEngineOnline(req.params.id),
        };
        io.emit('engine:updated', result);
        res.json(result);
    });

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

    app.post('/api/v1/engines/:id/profiles', (req, res) => {
        const engine = requireEngine(req.params.id, res);
        if (!engine) return;
        const { profileName, config } = req.body;
        if (!profileName) { res.status(400).json({ error: 'profileName is required' }); return; }
        configStore.createProfile(req.params.id, profileName, config ?? {});
        res.status(201).json({ profile_name: profileName });
    });

    app.delete('/api/v1/engines/:id/profiles/:profile', (req, res) => {
        const engine = requireEngine(req.params.id, res);
        if (!engine) return;
        if (engine.active_profile === req.params.profile) {
            res.status(400).json({ error: 'Cannot delete the active profile' }); return;
        }
        configStore.deleteProfile(req.params.id, req.params.profile);
        res.json({ ok: true });
    });

    app.post('/api/v1/engines/:id/profiles/:profile/activate', (req, res) => {
        if (!requireEngine(req.params.id, res)) return;
        const profile = configStore.getProfile(req.params.id, req.params.profile);
        if (!profile) { res.status(404).json({ error: 'Profile not found' }); return; }
        configStore.setActiveProfile(req.params.id, req.params.profile);

        if (engineManager.isEngineOnline(req.params.id)) {
            engineManager.sendToEngine(req.params.id, 'config', profile, { guaranteeDelivery: true });
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
        if (!config) { res.status(404).json({ error: 'Profile not found' }); return; }
        res.json(config);
    });

    app.get('/api/v1/engines/:id/profiles/:profile/history', (req, res) => {
        res.json(configStore.getVersionHistory(req.params.id, req.params.profile));
    });

    app.post('/api/v1/engines/:id/profiles/:profile/rollback', (req, res) => {
        const { versionId } = req.body as { versionId: number };
        if (!versionId) { res.status(400).json({ error: 'versionId required' }); return; }
        const version = configStore.getVersion(req.params.id, req.params.profile, versionId);
        if (!version) { res.status(404).json({ error: 'Version not found' }); return; }
        configStore.updateProfileConfig(req.params.id, req.params.profile, version);
        res.json({ ok: true });
    });

    // Static file serving (manager-ui)
    const uiDistPath = path.resolve(__dirname, '../../../manager-ui/dist');
    if (fs.existsSync(uiDistPath)) {
        app.use(express.static(uiDistPath));
        app.get('/{*path}', (req, res) => {
            if (req.path.startsWith('/api/') || req.path.startsWith('/health') || req.path.startsWith('/socket.io')) {
                res.status(404).json({ error: 'Not found' });
                return;
            }
            res.sendFile(path.join(uiDistPath, 'index.html'));
        });
    } else {
        app.get('/', (_req, res) => {
            res.json({
                status: 'ok',
                message: 'Manager API running. UI not built — run: pnpm --filter @media-router/manager-ui build',
            });
        });
    }
}
