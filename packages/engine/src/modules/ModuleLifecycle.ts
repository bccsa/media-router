import type { StreamType } from '@media-router/shared-types';
import { createLogger, formatError } from '@media-router/shared-types';
import type { ModuleManager } from './ModuleManager.js';
import type { MediaRouter } from '../routing/MediaRouter.js';
import type { PipeWireManager } from '../audio/PipeWireManager.js';
import type { PluginLoader } from '../plugins/PluginLoader.js';
import { ConnectionApplier } from './ConnectionApplier.js';
import type { RawPort, StoredConnection } from './ConnectionApplier.js';

const log = createLogger('ModuleLifecycle');

/**
 * Brief settle delay before applying connections after module start.
 * The real waiting happens in ConnectionExecutor.waitForPorts() which polls
 * for up to 3s — this is just a minimum pause to let PipeWire process events.
 */
const PW_SETTLE_MS = 200;

/** Create a log label like "Encoder 1 (audio-encoder-abc)" for readable logs. */
function moduleLabel(modConfig: Record<string, unknown>): string {
    const name = modConfig.displayName as string | undefined;
    return name ? `[${name}]` : '';
}

/** Map raw port config to typed ModulePort for MediaRouter registration. */
function mapPorts(raw: RawPort[]) {
    return raw.map((p) => ({
        id: p.id,
        direction: p.direction as 'input' | 'output',
        streamType: p.streamType as StreamType,
        label: p.label ?? p.id,
        maxConnections: p.maxConnections ?? -1,
    }));
}

/**
 * Manages module lifecycle operations: start all, stop all, restart,
 * enable, disable. Handles connection teardown/re-application.
 *
 * All public methods are serialized through a lifecycle lock to prevent
 * concurrent startAll/stopAll/restart/enable/disable from racing.
 */
export class ModuleLifecycle {
    /** Called when a module's dynamic ports are resolved — allows the engine to push updates to the manager. */
    onDynamicPortsResolved?: (moduleId: string, ports: RawPort[]) => void;

    private connectionApplier: ConnectionApplier;
    /** Serialization lock — prevents concurrent lifecycle operations from racing. */
    private lock: Promise<void> = Promise.resolve();

    constructor(
        private moduleManager: ModuleManager,
        private mediaRouter: MediaRouter,
        private pipeWire: PipeWireManager,
        private getConfig: () => Record<string, unknown> | null,
        private pluginLoader?: PluginLoader,
    ) {
        this.connectionApplier = new ConnectionApplier(
            moduleManager,
            mediaRouter,
            getConfig,
            (instanceId, modConfig, pluginId) =>
                this.resolvePortsForInstance(instanceId, modConfig, pluginId),
        );
        // After MpegTsUdpExecutor restarts a consumer module (so its UDP
        // ports get allocated), give that consumer's outgoing connections
        // a fresh attempt — they may have been removed earlier by retry
        // exhaustion when those ports didn't exist yet (e.g. demuxer with
        // a disabled upstream at engine startup).
        mediaRouter.setConsumerRestartCallback((id) =>
            this.connectionApplier.reapplyModuleConnections(id),
        );
    }

    /**
     * Resolve ports for a module. The plugin manifest is the source of truth
     * for static-port plugins — stored `modConfig.ports` is a cache that can
     * go stale (e.g. when a plugin changes maxConnections between versions).
     *
     * Priority:
     * 1. Plugin manifest ports — authoritative for plugins with static ports.
     * 2. Dynamic ports from module instance (getDynamicPorts) — for plugins
     *    with runtime-configurable port count (manifest.ports is empty).
     * 3. Stored config ports — last-resort fallback.
     */
    private resolvePortsForInstance(
        instanceId: string,
        modConfig: Record<string, unknown>,
        pluginId: string,
    ): RawPort[] {
        const manifestPorts = (this.pluginLoader?.get(pluginId)?.manifest?.ports ??
            []) as RawPort[];
        if (manifestPorts.length > 0) return manifestPorts;

        const instance = this.moduleManager.get(instanceId);
        const dynamicPorts = instance?.getDynamicPorts();
        if (dynamicPorts && dynamicPorts.length > 0) {
            modConfig.ports = dynamicPorts;
            this.onDynamicPortsResolved?.(instanceId, dynamicPorts as RawPort[]);
            return dynamicPorts as RawPort[];
        }

        return (modConfig.ports ?? []) as RawPort[];
    }

    /** Run an operation under the lifecycle lock — prevents concurrent lifecycle transitions. */
    private serialize(fn: () => Promise<void>): Promise<void> {
        this.lock = this.lock.then(fn, fn);
        return this.lock;
    }

    async startAll(): Promise<void> {
        return this.serialize(() => this._startAll());
    }

    async stopAll(): Promise<void> {
        return this.serialize(() => this._stopAll());
    }

    async deleteSingle(moduleId: string): Promise<void> {
        return this.serialize(() => this._deleteSingle(moduleId));
    }

    async startSingle(moduleId: string): Promise<void> {
        return this.serialize(() => this._startSingle(moduleId));
    }

    async restart(moduleId: string): Promise<void> {
        return this.serialize(() => this._restart(moduleId));
    }

    async disable(moduleId: string): Promise<void> {
        return this.serialize(() => this._disable(moduleId));
    }

    async enable(moduleId: string): Promise<void> {
        return this.serialize(() => this._enable(moduleId));
    }

    // --- Internal implementations (run under lock) ---

    private async _startAll(): Promise<void> {
        const config = this.getConfig();
        if (!config) {
            log.info('No config — nothing to start');
            return;
        }

        // Destroy any existing modules first (stop + clear)
        if (this.moduleManager.size > 0) {
            log.info('Stopping all modules...');
            await this.mediaRouter.removeAllConnections(true);
            this.mediaRouter.unregisterAll();
            await this.moduleManager.destroyAll();
            await this.pipeWire.cleanupOrphans();
            log.info('All modules stopped');
        }

        const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;
        const connections = (config.connections ?? []) as StoredConnection[];

        const moduleEntries = Object.entries(modules);
        log.info({ count: moduleEntries.length }, 'Starting modules');

        for (const [instanceId, modConfig] of moduleEntries) {
            const label = moduleLabel(modConfig);
            if (modConfig.enabled === false) {
                log.info({ instanceId, module: label }, 'Module disabled, skipping');
                continue;
            }

            const pluginId = modConfig.pluginId as string;
            try {
                this.moduleManager.createModule(
                    instanceId,
                    pluginId,
                    (modConfig.settings as Record<string, unknown>) ?? {},
                );

                this.mediaRouter.registerPorts(
                    instanceId,
                    mapPorts(this.resolvePortsForInstance(instanceId, modConfig, pluginId)),
                );

                await this.moduleManager.startModule(instanceId);
                log.info({ instanceId, module: label }, 'Started module');
            } catch (err) {
                log.error(
                    { instanceId, module: label },
                    `Failed to start module: ${formatError(err)}`,
                );
            }
        }

        // Apply connections
        if (connections.length > 0) {
            await this.connectionApplier.applyConnections(connections, modules);
        }
    }

    private async _stopAll(): Promise<void> {
        log.info('Stopping all modules...');
        await this.mediaRouter.removeAllConnections(true);
        this.mediaRouter.unregisterAll();
        await this.moduleManager.stopAll();
        await this.pipeWire.cleanupOrphans();
        log.info('All modules stopped');
    }

    private async _deleteSingle(moduleId: string): Promise<void> {
        const instance = this.moduleManager.get(moduleId);
        const label = instance ? `[${instance.config?.displayName ?? moduleId}]` : `[${moduleId}]`;
        log.info({ moduleId, module: label }, 'Deleting module');

        // Tear down all connections involving this module
        const connections = this.mediaRouter.getModuleConnections(moduleId);
        for (const conn of connections) {
            try {
                await this.mediaRouter.removeConnection(conn.id, true);
            } catch (err) {
                log.debug(
                    { err: formatError(err), connId: conn.id },
                    'Connection removal during delete',
                );
            }
        }

        // Stop the module
        if (instance) {
            try {
                await instance.stop();
            } catch (err) {
                log.debug({ err: formatError(err), moduleId }, 'Module stop during delete');
            }
        }

        // Unregister ports BEFORE deleting — ensures consistent state during deletion events
        await this.mediaRouter.unregisterPorts(moduleId);
        await this.moduleManager.deleteModule(moduleId);
        log.info({ moduleId, module: label }, 'Module deleted');
    }

    private async _startSingle(moduleId: string): Promise<void> {
        const config = this.getConfig();
        if (!config) {
            log.warn({ moduleId }, 'No config — cannot start module');
            return;
        }
        const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;
        const modConfig = modules[moduleId];
        if (!modConfig) {
            log.warn({ moduleId }, 'Module not in config');
            return;
        }

        const pluginId = modConfig.pluginId as string;
        const label = `[${modConfig.displayName ?? moduleId}]`;

        if (modConfig.enabled === false) {
            log.info({ moduleId, module: label }, 'Module disabled, skipping');
            return;
        }

        try {
            const instance = this.moduleManager.createModule(
                moduleId,
                pluginId,
                modConfig.settings as Record<string, unknown>,
            );

            this.mediaRouter.registerPorts(
                moduleId,
                mapPorts(this.resolvePortsForInstance(moduleId, modConfig, pluginId)),
            );

            await this.moduleManager.startModule(moduleId);
            log.info({ moduleId, module: label }, 'Started module');
        } catch (err) {
            log.error({ err: formatError(err), moduleId, module: label }, 'Failed to start module');
            return;
        }

        // Wait for PipeWire to settle, then reapply any stored connections
        await new Promise((r) => setTimeout(r, PW_SETTLE_MS));
        await this.connectionApplier.reapplyModuleConnections(moduleId);
    }

    private async _restart(moduleId: string): Promise<void> {
        const instance = this.moduleManager.get(moduleId);
        if (!instance) return;

        // Tear down connections
        const connections = this.mediaRouter.getModuleConnections(moduleId);
        for (const conn of connections) {
            await this.mediaRouter.removeConnection(conn.id, true);
        }

        // Unregister old ports before stop
        await this.mediaRouter.unregisterPorts(moduleId);

        await instance.stop();
        await instance.start();

        // Re-register ports (may have changed if module has dynamic ports)
        const config = this.getConfig();
        const modules = (config?.modules ?? {}) as Record<string, Record<string, unknown>>;
        const modConfig = modules[moduleId];
        if (modConfig) {
            const pluginId = modConfig.pluginId as string;
            const ports = this.resolvePortsForInstance(moduleId, modConfig, pluginId);
            if (ports.length > 0) {
                this.mediaRouter.registerPorts(moduleId, mapPorts(ports));
            }
        }

        // Wait for PipeWire to settle, then re-apply connections
        await new Promise((r) => setTimeout(r, PW_SETTLE_MS));
        await this.connectionApplier.reapplyModuleConnections(moduleId);
    }

    private async _disable(moduleId: string): Promise<void> {
        const config = this.getConfig();
        const modName =
            (config?.modules as Record<string, Record<string, unknown>>)?.[moduleId]?.displayName ??
            moduleId;
        log.info({ moduleId, module: `[${modName}]` }, 'Module disabled');

        const connections = this.mediaRouter.getModuleConnections(moduleId);
        for (const conn of connections) {
            await this.mediaRouter.removeConnection(conn.id, true);
        }

        const instance = this.moduleManager.get(moduleId);
        if (instance?.running) {
            await instance.stop();
        }

        // Mark as disabled in current config
        if (config) {
            const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;
            if (modules[moduleId]) modules[moduleId].enabled = false;
        }
    }

    private async _enable(moduleId: string): Promise<void> {
        const config = this.getConfig();
        if (!config) return;

        const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;
        const modConfig = modules[moduleId];
        if (!modConfig) return;
        modConfig.enabled = true;

        const label = moduleLabel(modConfig);
        log.info({ moduleId, module: label }, 'Module enabled');

        try {
            // If instance exists (was disabled, not deleted), just restart it
            const existing = this.moduleManager.get(moduleId);
            if (existing) {
                if (!existing.running) {
                    await this.moduleManager.startModule(moduleId);
                }
            } else {
                const pluginId = modConfig.pluginId as string;
                this.moduleManager.createModule(
                    moduleId,
                    pluginId,
                    (modConfig.settings as Record<string, unknown>) ?? {},
                );

                const ports = this.resolvePortsForInstance(moduleId, modConfig, pluginId);
                if (ports.length > 0) {
                    this.mediaRouter.registerPorts(moduleId, mapPorts(ports));
                }

                await this.moduleManager.startModule(moduleId);
            }
            log.info({ moduleId, module: label }, 'Module started');
        } catch (err) {
            log.error({ err: formatError(err), moduleId, module: label }, 'Failed to start module');
            return;
        }

        // Wait for PipeWire to settle, then reapply connections
        await new Promise((r) => setTimeout(r, PW_SETTLE_MS));
        await this.connectionApplier.reapplyModuleConnections(moduleId);
    }
}
