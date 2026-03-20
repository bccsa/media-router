import type { ChannelMapEntry } from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';
import type { ModuleManager } from './ModuleManager.js';
import type { MediaRouter } from '../routing/MediaRouter.js';
import type { PipeWireManager } from '../audio/PipeWireManager.js';

const log = createLogger('ModuleLifecycle');

interface StoredConnection {
    id: string;
    sourceModuleId: string;
    sourcePortId: string;
    sinkModuleId: string;
    sinkPortId: string;
    channelMap?: ChannelMapEntry[];
}

/**
 * Manages module lifecycle operations: start all, stop all, restart,
 * enable, disable. Handles connection teardown/re-application.
 */
export class ModuleLifecycle {
    constructor(
        private moduleManager: ModuleManager,
        private mediaRouter: MediaRouter,
        private pipeWire: PipeWireManager,
        private getConfig: () => Record<string, unknown> | null,
    ) {}

    async startAll(): Promise<void> {
        const config = this.getConfig();
        if (!config) {
            log.info('No config — nothing to start');
            return;
        }

        // Stop any running modules first
        if (this.moduleManager.size > 0) {
            log.info('Stopping all modules...');
            await this.mediaRouter.removeAllConnections(true);
            await this.moduleManager.stopAll();
            log.info('All modules stopped');
        }

        const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;
        const connections = (config.connections ?? []) as StoredConnection[];

        const moduleEntries = Object.entries(modules);
        log.info({ count: moduleEntries.length }, 'Starting modules');

        for (const [instanceId, modConfig] of moduleEntries) {
            if (modConfig.enabled === false) {
                log.info({ instanceId }, 'Module disabled, skipping');
                continue;
            }

            const pluginId = modConfig.pluginId as string;
            try {
                this.moduleManager.createModule(instanceId, pluginId, (modConfig.settings as Record<string, unknown>) ?? {});

                // Register ports with MediaRouter so connections can find them
                const ports = (modConfig.ports ?? []) as Array<{ id: string; direction: string; streamType: string; label?: string; maxConnections?: number }>;
                this.mediaRouter.registerPorts(instanceId, ports.map((p) => ({
                    id: p.id,
                    direction: p.direction as 'input' | 'output',
                    streamType: p.streamType as any,
                    label: p.label ?? p.id,
                    maxConnections: p.maxConnections ?? -1,
                })));

                await this.moduleManager.startModule(instanceId);
                log.info({ instanceId }, 'Started module');
            } catch (err) {
                log.error({ err, instanceId }, 'Failed to start module');
            }
        }

        // Apply connections
        if (connections.length > 0) {
            await this.applyConnections(connections, modules);
        }
    }

    async stopAll(): Promise<void> {
        log.info('Stopping all modules...');
        await this.mediaRouter.removeAllConnections(true);
        // Unregister all ports — mediaRouter tracks them internally
        this.mediaRouter.unregisterAll();
        await this.moduleManager.stopAll();
        await this.pipeWire.cleanupOrphans();
        log.info('All modules stopped');
    }

    async restart(moduleId: string): Promise<void> {
        const instance = this.moduleManager.get(moduleId);
        if (!instance) return;

        // Tear down connections
        const connections = this.mediaRouter.getModuleConnections(moduleId);
        for (const conn of connections) {
            await this.mediaRouter.removeConnection(conn.id, true);
        }

        await instance.stop();
        await instance.start();

        // Re-apply connections from stored config
        await this.reapplyModuleConnections(moduleId);
    }

    async disable(moduleId: string): Promise<void> {
        log.info({ moduleId }, 'Module disabled');

        const connections = this.mediaRouter.getModuleConnections(moduleId);
        for (const conn of connections) {
            await this.mediaRouter.removeConnection(conn.id, true);
        }

        const instance = this.moduleManager.get(moduleId);
        if (instance?.running) {
            await instance.stop();
        }

        // Mark as disabled in current config
        const config = this.getConfig();
        if (config) {
            const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;
            if (modules[moduleId]) modules[moduleId].enabled = false;
        }
    }

    async enable(moduleId: string): Promise<void> {
        log.info({ moduleId }, 'Module enabled');
        const config = this.getConfig();
        if (!config) return;

        const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;
        const modConfig = modules[moduleId];
        if (!modConfig) return;
        modConfig.enabled = true;

        const pluginId = modConfig.pluginId as string;
        try {
            this.moduleManager.createModule(moduleId, pluginId, (modConfig.settings as Record<string, unknown>) ?? {});
            await this.moduleManager.startModule(moduleId);
            log.info({ moduleId }, 'Module started');
        } catch (err) {
            log.error({ err, moduleId }, 'Failed to start module');
            return;
        }

        await this.reapplyModuleConnections(moduleId);
    }

    // --- Helpers ---

    private async applyConnections(
        connections: StoredConnection[],
        modules: Record<string, Record<string, unknown>>,
    ): Promise<void> {
        log.info({ count: connections.length }, 'Applying connections');

        // MPEG-TS first (may restart decoder pipelines)
        const mpegtsConns = connections.filter((c) => {
            const srcMod = modules[c.sourceModuleId];
            const ports = (srcMod?.ports ?? []) as Array<{ id: string; streamType: string }>;
            return ports.find((p) => p.id === c.sourcePortId)?.streamType === 'muxed/mpegts';
        });
        const audioConns = connections.filter((c) => !mpegtsConns.includes(c));

        for (const conn of mpegtsConns) {
            try {
                await this.mediaRouter.createConnection(
                    conn.sourceModuleId, conn.sourcePortId,
                    conn.sinkModuleId, conn.sinkPortId,
                    conn.channelMap,
                );
                log.info({ source: `${conn.sourceModuleId}:${conn.sourcePortId}`, sink: `${conn.sinkModuleId}:${conn.sinkPortId}` }, 'Connected');
            } catch (err) {
                log.error({ err: err instanceof Error ? err.message : err, connectionId: conn.id }, 'Failed to connect');
            }
        }

        if (mpegtsConns.length > 0 && audioConns.length > 0) {
            await new Promise((r) => setTimeout(r, 500));
        }

        for (const conn of audioConns) {
            const src = this.moduleManager.get(conn.sourceModuleId);
            const sink = this.moduleManager.get(conn.sinkModuleId);
            if (!src?.running || !sink?.running) {
                log.info({ connectionId: conn.id }, 'Skipping connection — endpoint not running');
                continue;
            }
            try {
                await this.mediaRouter.createConnection(
                    conn.sourceModuleId, conn.sourcePortId,
                    conn.sinkModuleId, conn.sinkPortId,
                    conn.channelMap,
                );
                log.info({ source: `${conn.sourceModuleId}:${conn.sourcePortId}`, sink: `${conn.sinkModuleId}:${conn.sinkPortId}` }, 'Connected');
            } catch (err) {
                log.error({ err: err instanceof Error ? err.message : err, connectionId: conn.id }, 'Failed to connect');
            }
        }
    }

    /** Re-apply stored connections for a specific module after restart/enable. */
    private async reapplyModuleConnections(moduleId: string): Promise<void> {
        const config = this.getConfig();
        if (!config) return;

        const storedConns = (config.connections ?? []) as StoredConnection[];
        for (const conn of storedConns) {
            if (conn.sourceModuleId === moduleId || conn.sinkModuleId === moduleId) {
                const src = this.moduleManager.get(conn.sourceModuleId);
                const sink = this.moduleManager.get(conn.sinkModuleId);
                if (src?.running && sink?.running) {
                    try {
                        await this.mediaRouter.createConnection(
                            conn.sourceModuleId, conn.sourcePortId,
                            conn.sinkModuleId, conn.sinkPortId,
                            conn.channelMap,
                        );
                    } catch (err) {
                        log.warn({ err: err instanceof Error ? err.message : err, connectionId: conn.id }, 'Failed to reapply connection');
                    }
                }
            }
        }
    }
}
