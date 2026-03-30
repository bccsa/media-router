import type { Server as SocketIOServer } from 'socket.io';
import { createLogger } from '@media-router/shared-types';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { EngineConnectionManager } from '../engines/EngineConnectionManager.js';
import type { PluginRegistry } from '../plugins/PluginRegistry.js';

const log = createLogger('ModuleHandlers');

/**
 * Handles all module CRUD operations: add, delete, config, toggle,
 * restart, rename, meta (focus), and position.
 *
 * Each method follows the same pattern:
 * 1. Update ConfigStore (SQLite)
 * 2. Forward command to engine via dgram-comms (if online)
 * 3. Broadcast JSON Patch to browsers via Socket.IO
 */
export class ModuleHandlers {
    private configDebounce = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(
        private configStore: ConfigStore,
        private engineManager: EngineConnectionManager,
        private io: SocketIOServer,
        private pluginRegistry: PluginRegistry,
    ) {}

    add(payload: {
        engineId: string;
        pluginId: string;
        displayName: string;
        position?: { x: number; y: number };
        settings?: Record<string, unknown>;
    }): void {
        const engine = this.configStore.getEngine(payload.engineId);
        if (!engine) return;

        let profileName = engine.active_profile as string | null;
        if (!profileName) {
            profileName = 'default';
            this.configStore.createProfile(payload.engineId, profileName, {});
            this.configStore.setActiveProfile(payload.engineId, profileName);
        }

        const instanceId = `${payload.pluginId}-${Date.now().toString(36)}`;
        const pluginManifest = this.pluginRegistry.find(payload.pluginId);
        const ports = pluginManifest?.ports ?? [];
        const configSchema = pluginManifest?.configSchema ?? {};

        // Build default settings from configSchema
        const defaultSettings: Record<string, unknown> = {};
        const schemaProps = ((configSchema as Record<string, unknown>).properties ?? {}) as Record<string, Record<string, unknown>>;
        for (const [key, schemaProp] of Object.entries(schemaProps)) {
            if (schemaProp.default !== undefined) {
                defaultSettings[key] = schemaProp.default;
            }
        }
        const settings = { ...defaultSettings, ...(payload.settings ?? {}) };

        const updatedConfig = this.configStore.modifyProfileConfig(payload.engineId, profileName, (config) => {
            const modules = (config.modules ?? {}) as Record<string, unknown>;
            modules[instanceId] = {
                pluginId: payload.pluginId,
                displayName: payload.displayName,
                position: payload.position ?? { x: 100, y: 100 },
                settings,
                ports,
                configSchema,
            };
            config.modules = modules;
            return config;
        });

        if (updatedConfig && this.engineManager.isEngineOnline(payload.engineId)) {
            this.engineManager.sendToEngine(payload.engineId, 'config', updatedConfig, { guaranteeDelivery: true });
            // Start the new module immediately without requiring full engine restart
            this.engineManager.sendToEngine(payload.engineId, 'command', {
                command: 'moduleStart', moduleId: instanceId,
            }, { guaranteeDelivery: true });
        }

        this.io.emit('engine:update', {
            engineId: payload.engineId,
            patch: [{
                op: 'add',
                path: `/modules/${instanceId}`,
                value: {
                    instanceId,
                    pluginId: payload.pluginId,
                    displayName: payload.displayName,
                    running: false,
                    health: 'stopped',
                    pendingRestart: false,
                    position: payload.position ?? { x: 100, y: 100 },
                    settings,
                    ports,
                    configSchema,
                    color: pluginManifest?.color,
                    icon: pluginManifest?.icon,
                    statusSections: pluginManifest?.statusSections,
                },
            }],
        });
    }

    delete(payload: { engineId: string; moduleId: string }): void {
        const engine = this.configStore.getEngine(payload.engineId);
        if (!engine?.active_profile) return;

        const updatedConfig = this.configStore.modifyProfileConfig(payload.engineId, engine.active_profile as string, (config) => {
            const modules = (config.modules ?? {}) as Record<string, unknown>;
            delete modules[payload.moduleId];
            const connections = (config.connections ?? []) as Array<Record<string, unknown>>;
            config.connections = connections.filter(
                (c) => c.sourceModuleId !== payload.moduleId && c.sinkModuleId !== payload.moduleId,
            );
            config.modules = modules;
            return config;
        });

        if (this.engineManager.isEngineOnline(payload.engineId)) {
            // Stop and remove the module on the engine first
            this.engineManager.sendToEngine(payload.engineId, 'command', {
                command: 'moduleDelete', moduleId: payload.moduleId,
            }, { guaranteeDelivery: true });
            // Then send updated config
            if (updatedConfig) {
                this.engineManager.sendToEngine(payload.engineId, 'config', updatedConfig, { guaranteeDelivery: true });
            }
        }

        this.io.emit('engine:update', {
            engineId: payload.engineId,
            patch: [{ op: 'remove', path: `/modules/${payload.moduleId}` }],
        });
    }

    position(payload: { engineId: string; moduleId: string; position: { x: number; y: number } }): void {
        const engine = this.configStore.getEngine(payload.engineId);
        if (!engine?.active_profile) return;

        this.configStore.modifyProfileConfig(payload.engineId, engine.active_profile as string, (config) => {
            const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;
            if (modules[payload.moduleId]) {
                modules[payload.moduleId].position = payload.position;
                config.modules = modules;
            }
            return config;
        });

        this.io.emit('engine:update', {
            engineId: payload.engineId,
            patch: [{ op: 'replace', path: `/modules/${payload.moduleId}/position`, value: payload.position }],
        });
    }

    config(payload: { engineId: string; moduleId: string; changes: Record<string, unknown> }): void {
        log.debug({ moduleId: payload.moduleId, changes: Object.keys(payload.changes) }, 'moduleConfig received');
        const engine = this.configStore.getEngine(payload.engineId);
        if (!engine?.active_profile) {
            log.warn({ engineId: payload.engineId }, 'moduleConfig: no active profile');
            return;
        }

        this.configStore.modifyProfileConfig(payload.engineId, engine.active_profile as string, (config) => {
            const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;
            if (modules[payload.moduleId]) {
                const settings = (modules[payload.moduleId].settings ?? {}) as Record<string, unknown>;
                Object.assign(settings, payload.changes);
                modules[payload.moduleId].settings = settings;
                config.modules = modules;
            }
            return config;
        });

        if (this.engineManager.isEngineOnline(payload.engineId)) {
            // Debounce config sends per module — cancel pending send, schedule new one.
            // This prevents guaranteeDelivery retry storms from rapid toggles while
            // still ensuring the LAST value reaches the engine reliably.
            const debounceKey = `config:${payload.engineId}:${payload.moduleId}`;
            if (this.configDebounce.has(debounceKey)) clearTimeout(this.configDebounce.get(debounceKey));
            this.configDebounce.set(debounceKey, setTimeout(() => {
                this.configDebounce.delete(debounceKey);
                this.engineManager.sendToEngine(payload.engineId, 'command', {
                    command: 'moduleConfig',
                    moduleId: payload.moduleId,
                    changes: payload.changes,
                }, { guaranteeDelivery: true });
            }, 100));
        }

        const patchOps: Array<{ op: 'replace'; path: string; value: unknown }> = Object.entries(payload.changes).map(([key, value]) => ({
            op: 'replace' as const,
            path: `/modules/${payload.moduleId}/settings/${key}`,
            value,
        }));

        // If pairCount changed on a module with dynamic ports, regenerate ports immediately
        if ('pairCount' in payload.changes) {
            const pairCount = payload.changes.pairCount as number;
            const ports = this.generateDynamicPorts(payload.engineId, payload.moduleId, pairCount);
            if (ports) {
                patchOps.push({ op: 'replace', path: `/modules/${payload.moduleId}/ports`, value: ports });
            }
        }

        this.io.emit('engine:update', { engineId: payload.engineId, patch: patchOps });
    }

    /** Generate dynamic ports for modules that support them (e.g. N-1 mixer). */
    private generateDynamicPorts(engineId: string, moduleId: string, pairCount: number): unknown[] | null {
        const engine = this.configStore.getEngine(engineId);
        if (!engine?.active_profile) return null;
        const config = this.configStore.getProfile(engineId, engine.active_profile as string);
        const modules = (config?.modules ?? {}) as Record<string, Record<string, unknown>>;
        const mod = modules[moduleId];
        if (!mod) return null;

        const pluginId = mod.pluginId as string;
        const manifest = this.pluginRegistry.find(pluginId);
        // Only generate for plugins with empty manifest ports (dynamic port plugins)
        if (manifest && manifest.ports.length === 0) {
            const ports: unknown[] = [];
            for (let i = 0; i < pairCount; i++) {
                ports.push({ id: `in-${i}`, direction: 'input', streamType: 'audio/pcm', label: `In ${i + 1}`, maxConnections: -1 });
            }
            for (let i = 0; i < pairCount; i++) {
                ports.push({ id: `out-${i}`, direction: 'output', streamType: 'audio/pcm', label: `Out ${i + 1}`, maxConnections: -1 });
            }
            // Persist to config
            this.configStore.modifyProfileConfig(engineId, engine.active_profile as string, (cfg) => {
                const mods = (cfg.modules ?? {}) as Record<string, Record<string, unknown>>;
                if (mods[moduleId]) mods[moduleId].ports = ports;
                return cfg;
            });
            return ports;
        }
        return null;
    }

    toggle(payload: { engineId: string; moduleId: string }): void {
        const engine = this.configStore.getEngine(payload.engineId);
        if (!engine?.active_profile) return;

        let newEnabled = true;
        this.configStore.modifyProfileConfig(payload.engineId, engine.active_profile as string, (config) => {
            const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;
            if (modules[payload.moduleId]) {
                const isEnabled = modules[payload.moduleId].enabled !== false;
                newEnabled = !isEnabled;
                modules[payload.moduleId].enabled = newEnabled;
                config.modules = modules;
            }
            return config;
        });

        this.io.emit('engine:update', {
            engineId: payload.engineId,
            patch: [{ op: 'replace', path: `/modules/${payload.moduleId}/enabled`, value: newEnabled }],
        });

        if (this.engineManager.isEngineOnline(payload.engineId)) {
            this.engineManager.sendToEngine(payload.engineId, 'command', {
                command: newEnabled ? 'moduleEnable' : 'moduleDisable',
                moduleId: payload.moduleId,
            }, { guaranteeDelivery: true });
        }
    }

    restart(payload: { engineId: string; moduleId: string }): void {
        if (this.engineManager.isEngineOnline(payload.engineId)) {
            this.engineManager.sendToEngine(payload.engineId, 'command', {
                command: 'moduleRestart',
                moduleId: payload.moduleId,
            }, { guaranteeDelivery: true });
        }
    }

    meta(payload: { engineId: string; moduleId: string; meta: Record<string, unknown> }): void {
        const engine = this.configStore.getEngine(payload.engineId);
        if (!engine?.active_profile) return;

        this.configStore.modifyProfileConfig(payload.engineId, engine.active_profile as string, (config) => {
            const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;
            if (modules[payload.moduleId]) {
                Object.assign(modules[payload.moduleId], payload.meta);
            }
            return config;
        });

        const patchOps = Object.entries(payload.meta).map(([key, value]) => ({
            op: 'replace',
            path: `/modules/${payload.moduleId}/${key}`,
            value,
        }));
        this.io.emit('engine:update', { engineId: payload.engineId, patch: patchOps });
    }

    rename(payload: { engineId: string; moduleId: string; displayName: string }): void {
        const engine = this.configStore.getEngine(payload.engineId);
        if (!engine?.active_profile) return;

        this.configStore.modifyProfileConfig(payload.engineId, engine.active_profile as string, (config) => {
            const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;
            if (modules[payload.moduleId]) {
                modules[payload.moduleId].displayName = payload.displayName;
                config.modules = modules;
            }
            return config;
        });

        this.io.emit('engine:update', {
            engineId: payload.engineId,
            patch: [{ op: 'replace', path: `/modules/${payload.moduleId}/displayName`, value: payload.displayName }],
        });
    }
}
