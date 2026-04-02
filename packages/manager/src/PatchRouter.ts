import type { Server as SocketIOServer } from 'socket.io';
import { createLogger, applyJsonPatch } from '@media-router/shared-types';
import type { PatchOp } from '@media-router/shared-types';
import type { ConfigStore } from './config/ConfigStore.js';
import type { EngineConnectionManager } from './engines/EngineConnectionManager.js';
import type { PluginRegistry } from './plugins/PluginRegistry.js';

const log = createLogger('PatchRouter');

/**
 * Manager-side N-1 Patch Router.
 *
 * Receives JSON Patch ops from any client (browser or engine),
 * persists to SQLite, detects side effects, and forwards to all
 * other clients (skip sender).
 *
 * Browser sends patch → save to SQLite → send to engine + all other browsers
 * Engine sends patch  → save to SQLite → send to all browsers (not back to engine)
 */
export class PatchRouter {
    constructor(
        private configStore: ConfigStore,
        private engineManager: EngineConnectionManager,
        private io: SocketIOServer,
        private pluginRegistry: PluginRegistry,
    ) {}

    /**
     * Process a patch from any source.
     * @param senderId  Socket ID of the sender (browser socket ID or 'engine')
     * @param senderType  'browser' or 'engine'
     * @param engineId  Which engine's config to patch
     * @param ops  JSON Patch operations
     */
    onPatch(senderId: string, senderType: 'browser' | 'engine', engineId: string, ops: PatchOp[]): void {
        if (!ops || ops.length === 0) return;

        const engine = this.configStore.getEngine(engineId);
        if (!engine?.active_profile) {
            log.warn({ engineId }, 'No active profile — dropping patch');
            return;
        }

        log.debug({ engineId, senderType, opCount: ops.length }, 'Processing patch');

        // 1. Apply to SQLite
        const updatedConfig = this.configStore.modifyProfileConfig(engineId, engine.active_profile as string, (config) => {
            // Handle special ops that need pre-processing
            const processedOps = this.preprocessOps(engineId, config, ops);
            applyJsonPatch(config, processedOps);
            return config;
        });

        // 2. Broadcast to other clients (skip sender)
        // Enrich ops if needed (e.g. module add needs full module data)
        const broadcastOps = this.enrichOpsForBroadcast(engineId, ops, updatedConfig);

        if (senderType === 'browser') {
            // Forward to engine
            if (this.engineManager.isEngineOnline(engineId)) {
                this.engineManager.sendToEngine(engineId, 'patch', { ops: broadcastOps }, { guaranteeDelivery: true });
            }
            // Broadcast to all OTHER browsers (skip sender)
            this.io.except(senderId).emit('engine:update', { engineId, patch: broadcastOps });
        } else {
            // Sender is engine — broadcast to ALL browsers
            this.io.emit('engine:update', { engineId, patch: broadcastOps });
        }
    }

    /**
     * Pre-process ops before applying to config.
     * Handles: connection remove by ID, module delete cascading connections, dynamic ports.
     */
    private preprocessOps(engineId: string, config: Record<string, unknown>, ops: PatchOp[]): PatchOp[] {
        const processed: PatchOp[] = [];

        for (const op of ops) {
            // Connection ops by ID: /connections/{connectionId} or /connections/{connectionId}/{field}
            // Convert ID-based paths to index-based paths for array storage
            if (op.path.match(/^\/connections\/[^/]+/) && !op.path.match(/^\/connections\/\d+(\/|$)/) && op.path !== '/connections/-') {
                const parts = op.path.split('/');
                const connId = parts[2];
                const connections = (config.connections ?? []) as Array<Record<string, unknown>>;
                const idx = connections.findIndex((c) => c.id === connId);
                if (idx >= 0) {
                    const rest = parts.slice(3).join('/');
                    const indexPath = rest ? `/connections/${idx}/${rest}` : `/connections/${idx}`;
                    processed.push({ ...op, path: indexPath });
                }
                continue;
            }

            // Module delete: also remove connections involving this module
            if (op.op === 'remove' && op.path.match(/^\/modules\/[^/]+$/)) {
                const moduleId = op.path.split('/')[2];
                const connections = (config.connections ?? []) as Array<Record<string, unknown>>;
                // Remove connections in reverse order (so indices don't shift)
                const toRemove = connections
                    .map((c, i) => ({ idx: i, conn: c }))
                    .filter((c) => c.conn.sourceModuleId === moduleId || c.conn.sinkModuleId === moduleId)
                    .reverse();
                for (const { idx } of toRemove) {
                    processed.push({ op: 'remove', path: `/connections/${idx}` });
                }
                processed.push(op);
                continue;
            }

            // Module add: enrich with defaults from plugin manifest
            if (op.op === 'add' && op.path.match(/^\/modules\/[^/]+$/) && op.value) {
                const modValue = op.value as Record<string, unknown>;
                const pluginId = modValue.pluginId as string;
                if (pluginId) {
                    const manifest = this.pluginRegistry.find(pluginId);
                    if (manifest) {
                        // Build default settings from configSchema
                        const defaultSettings: Record<string, unknown> = {};
                        const schemaProps = ((manifest.configSchema as any)?.properties ?? {}) as Record<string, Record<string, unknown>>;
                        for (const [key, schemaProp] of Object.entries(schemaProps)) {
                            if (schemaProp.default !== undefined) {
                                defaultSettings[key] = schemaProp.default;
                            }
                        }
                        modValue.settings = { ...defaultSettings, ...(modValue.settings as Record<string, unknown> ?? {}) };
                        modValue.ports = modValue.ports ?? manifest.ports ?? [];
                        modValue.configSchema = manifest.configSchema ?? {};
                    }
                }
                processed.push({ ...op, value: modValue });
                continue;
            }

            // Dynamic port regeneration when pairCount changes
            if (op.op === 'replace' && op.path.match(/^\/modules\/[^/]+\/settings\/pairCount$/)) {
                processed.push(op);
                const parts = op.path.split('/');
                const moduleId = parts[2];
                const pairCount = op.value as number;
                const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;
                const mod = modules[moduleId];
                if (mod) {
                    const manifest = this.pluginRegistry.find(mod.pluginId as string);
                    if (manifest && manifest.ports.length === 0) {
                        // Dynamic port plugin — regenerate ports
                        const ports: unknown[] = [];
                        for (let i = 0; i < pairCount; i++) {
                            ports.push({ id: `in-${i}`, direction: 'input', streamType: 'audio/pcm', label: `In ${i + 1}`, maxConnections: -1 });
                        }
                        for (let i = 0; i < pairCount; i++) {
                            ports.push({ id: `out-${i}`, direction: 'output', streamType: 'audio/pcm', label: `Out ${i + 1}`, maxConnections: -1 });
                        }
                        processed.push({ op: 'replace', path: `/modules/${moduleId}/ports`, value: ports });
                    }
                }
                continue;
            }

            // Channel count change: clean up stale channel map entries on connected edges
            if (op.op === 'replace' && op.path.match(/^\/modules\/[^/]+\/settings\/channels$/)) {
                processed.push(op);
                const parts = op.path.split('/');
                const moduleId = parts[2];
                const newChannels = op.value as number;
                const connections = (config.connections ?? []) as Array<Record<string, unknown>>;
                for (let i = 0; i < connections.length; i++) {
                    const conn = connections[i];
                    if (!Array.isArray(conn.channelMap) || conn.channelMap.length === 0) continue;
                    if (conn.sourceModuleId !== moduleId && conn.sinkModuleId !== moduleId) continue;
                    const filtered = conn.channelMap.filter((entry: any) => {
                        if (conn.sourceModuleId === moduleId && entry.srcChannel >= newChannels) return false;
                        if (conn.sinkModuleId === moduleId && entry.dstChannel >= newChannels) return false;
                        return true;
                    });
                    if (filtered.length !== conn.channelMap.length) {
                        processed.push({ op: 'replace', path: `/connections/${i}/channelMap`, value: filtered.length > 0 ? filtered : undefined });
                    }
                }
                continue;
            }

            processed.push(op);
        }

        return processed;
    }

    /**
     * Enrich ops for broadcast (e.g. module add needs full module data with manifest info).
     */
    private enrichOpsForBroadcast(engineId: string, ops: PatchOp[], updatedConfig: Record<string, unknown> | undefined): PatchOp[] {
        const enriched: PatchOp[] = [];

        for (const op of ops) {
            // Module add: enrich with runtime defaults for the UI
            if (op.op === 'add' && op.path.match(/^\/modules\/[^/]+$/) && op.value) {
                const modValue = op.value as Record<string, unknown>;
                const pluginId = modValue.pluginId as string;
                const manifest = pluginId ? this.pluginRegistry.find(pluginId) : undefined;
                const moduleId = op.path.split('/')[2];
                enriched.push({
                    ...op,
                    value: {
                        instanceId: moduleId,
                        running: false,
                        health: 'stopped',
                        pendingRestart: false,
                        ...modValue,
                        color: manifest?.color,
                        icon: manifest?.icon,
                        statusSections: manifest?.statusSections,
                        faceWidgets: (manifest as any)?.faceWidgets,
                    },
                });
                continue;
            }

            enriched.push(op);
        }

        return enriched;
    }
}
