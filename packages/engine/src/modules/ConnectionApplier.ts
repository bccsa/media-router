import type { ChannelMapEntry, StreamType } from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';
import type { ModuleManager } from './ModuleManager.js';
import type { MediaRouter } from '../routing/MediaRouter.js';
import type { PluginLoader } from '../plugins/PluginLoader.js';

const log = createLogger('ConnectionApplier');

/** Time to wait for MPEG-TS pipelines to settle before creating audio connections. */
const MPEGTS_SETTLE_MS = 1000;

/** Max retries for failed audio connections. */
const MAX_RETRIES = 2;
/** Delay between retries (doubles each attempt). */
const RETRY_BASE_MS = 1000;

export type RawPort = { id: string; direction: string; streamType: string; label?: string; maxConnections?: number };

export interface StoredConnection {
    id: string;
    sourceModuleId: string;
    sourcePortId: string;
    sinkModuleId: string;
    sinkPortId: string;
    channelMap?: ChannelMapEntry[];
}

/**
 * Applies and reapplies stored connections between modules.
 * Extracted from ModuleLifecycle to keep connection logic separate from lifecycle management.
 */
export class ConnectionApplier {
    constructor(
        private moduleManager: ModuleManager,
        private mediaRouter: MediaRouter,
        private getConfig: () => Record<string, unknown> | null,
        private resolvePortsForInstance: (instanceId: string, modConfig: Record<string, unknown>, pluginId: string) => RawPort[],
    ) {}

    /**
     * Apply stored connections after all modules have started.
     * MPEG-TS connections are applied first (they may restart decoder pipelines),
     * then audio connections after a settle delay.
     */
    async applyConnections(
        connections: StoredConnection[],
        modules: Record<string, Record<string, unknown>>,
    ): Promise<void> {
        log.info({ count: connections.length }, 'Applying connections');

        // MPEG-TS first (may restart decoder pipelines)
        const mpegtsConns = connections.filter((c) => {
            const srcMod = modules[c.sourceModuleId];
            const pluginId = srcMod?.pluginId as string | undefined;
            const ports = pluginId ? this.resolvePortsForInstance(c.sourceModuleId, srcMod!, pluginId) : [];
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
                log.error({ connectionId: conn.id }, `Failed to connect: ${err instanceof Error ? err.message : err}`);
            }
        }

        if (mpegtsConns.length > 0 && audioConns.length > 0) {
            await new Promise((r) => setTimeout(r, MPEGTS_SETTLE_MS));
        }

        for (const conn of audioConns) {
            await this.connectWithRetry(conn);
        }
    }

    /** Re-apply stored connections for a specific module after restart/enable. */
    async reapplyModuleConnections(moduleId: string): Promise<void> {
        const config = this.getConfig();
        if (!config) return;

        const storedConns = (config.connections ?? []) as StoredConnection[];
        for (const conn of storedConns) {
            if (conn.sourceModuleId === moduleId || conn.sinkModuleId === moduleId) {
                await this.connectWithRetry(conn);
            }
        }
    }

    /**
     * Attempt to create a connection with retry and exponential backoff.
     * PipeWire nodes may not be visible immediately after module start —
     * retrying gives transient issues time to resolve.
     */
    private async connectWithRetry(conn: StoredConnection): Promise<void> {
        const src = this.moduleManager.get(conn.sourceModuleId);
        const sink = this.moduleManager.get(conn.sinkModuleId);
        if (!src?.running || !sink?.running) {
            log.info({ connectionId: conn.id }, 'Skipping connection — endpoint not running');
            return;
        }

        const label = `${conn.sourceModuleId}:${conn.sourcePortId} → ${conn.sinkModuleId}:${conn.sinkPortId}`;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                await this.mediaRouter.createConnection(
                    conn.sourceModuleId, conn.sourcePortId,
                    conn.sinkModuleId, conn.sinkPortId,
                    conn.channelMap,
                );
                log.info({ source: `${conn.sourceModuleId}:${conn.sourcePortId}`, sink: `${conn.sinkModuleId}:${conn.sinkPortId}` }, 'Connected');
                return;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (attempt < MAX_RETRIES) {
                    const delay = RETRY_BASE_MS * Math.pow(2, attempt);
                    log.warn({ connectionId: conn.id, attempt: attempt + 1, retryIn: delay }, `Connection failed, retrying: ${msg}`);
                    await new Promise((r) => setTimeout(r, delay));
                    // Re-check endpoints are still running before retry
                    if (!this.moduleManager.get(conn.sourceModuleId)?.running || !this.moduleManager.get(conn.sinkModuleId)?.running) {
                        log.info({ connectionId: conn.id }, 'Endpoint stopped during retry — giving up');
                        return;
                    }
                } else {
                    log.error({ connectionId: conn.id }, `Connection failed after ${MAX_RETRIES + 1} attempts: ${msg}`);
                }
            }
        }
    }
}
