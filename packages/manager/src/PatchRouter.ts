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
    onPatch(
        senderId: string,
        senderType: 'browser' | 'engine',
        engineId: string,
        ops: PatchOp[],
    ): void {
        if (!ops || ops.length === 0) return;

        const engine = this.configStore.getEngine(engineId);
        if (!engine?.active_profile) {
            log.warn({ engineId }, 'No active profile — dropping patch');
            return;
        }

        log.debug({ engineId, senderType, opCount: ops.length }, 'Processing patch');

        // 1. Apply to SQLite. preprocessOps returns:
        //   - `processed`: the full op list applied to config (rewrites of
        //     originals + new cascade ops, all using index-based paths where needed)
        //   - `cascades`: ONLY the ops preprocessing added beyond the originals
        //     (mute cascade, connection-on-module-delete, etc.). These are what
        //     the sender needs on top of its optimistic local apply — rewrites
        //     of originals would double-apply on the sender and corrupt state
        //     (e.g. a rewritten `remove /connections/<index>` on an array that
        //     already had the id-removed item spliced out).
        let processed: PatchOp[] = [];
        let cascades: PatchOp[] = [];
        const updatedConfig = this.configStore.modifyProfileConfig(
            engineId,
            engine.active_profile as string,
            (config) => {
                const result = this.preprocessOps(engineId, config, ops);
                processed = result.processed;
                cascades = result.cascades;
                applyJsonPatch(config, processed);
                return config;
            },
        );

        // Other browsers get originals (id-based paths they prefer) + cascades.
        const browserOps = this.enrichOpsForBroadcast(
            engineId,
            [...ops, ...cascades],
            updatedConfig,
        );

        if (senderType === 'browser') {
            if (this.engineManager.isEngineOnline(engineId)) {
                this.engineManager.sendToEngine(
                    engineId,
                    'patch',
                    { ops: processed },
                    { guaranteeDelivery: true },
                );
            }
            this.io.except(senderId).emit('engine:update', { engineId, patch: browserOps });
            // Sender already applied originals optimistically — only send cascades.
            if (cascades.length > 0) {
                this.io.to(senderId).emit('engine:update', { engineId, patch: cascades });
            }
        } else {
            this.io.emit('engine:update', { engineId, patch: browserOps });
        }
    }

    /**
     * Pre-process ops before applying to config.
     * Handles: connection remove by ID, module delete cascading connections, dynamic ports,
     * interlock exclusive-mute expansion and cascade on module delete.
     */
    /**
     * Emit mute ops for every member past the first hot one. Used by every
     * interlock-invariant branch (audioEnabled flip, members change, group create).
     * Array order is priority — the first hot member stays live, the rest mute.
     * Skip muting `exceptModuleId` (used when that module is being unmuted by the
     * same patch, so we don't emit a redundant mute).
     */
    private muteExceptFirstHot(
        modules: Record<string, Record<string, unknown>>,
        memberIds: string[],
        exceptModuleId?: string,
    ): PatchOp[] {
        const out: PatchOp[] = [];
        let keptHot = false;
        for (const id of memberIds) {
            const mod = modules[id];
            const on =
                mod?.settings && (mod.settings as Record<string, unknown>).audioEnabled !== false;
            if (!on) continue;
            if (!keptHot) {
                keptHot = true;
                continue;
            }
            if (id === exceptModuleId) continue;
            out.push({ op: 'replace', path: `/modules/${id}/settings/audioEnabled`, value: false });
        }
        return out;
    }

    private preprocessOps(
        engineId: string,
        config: Record<string, unknown>,
        ops: PatchOp[],
    ): { processed: PatchOp[]; cascades: PatchOp[] } {
        const processed: PatchOp[] = [];
        // Cascades are NEW ops (not rewrites of originals) added by preprocessing.
        // Identity-safe helper used at each branch that introduces extra ops.
        const cascades: PatchOp[] = [];
        const addCascade = (op: PatchOp) => {
            processed.push(op);
            cascades.push(op);
        };
        if (!Array.isArray(config.interlocks)) config.interlocks = [];
        const interlocks = config.interlocks as Array<{ id: string; members: string[] }>;
        const modules = (config.modules ?? {}) as Record<string, Record<string, unknown>>;

        for (const op of ops) {
            // Connection ops by ID: /connections/{connectionId} or /connections/{connectionId}/{field}
            // Convert ID-based paths to index-based paths for array storage
            if (
                op.path.match(/^\/connections\/[^/]+/) &&
                !op.path.match(/^\/connections\/\d+(\/|$)/) &&
                op.path !== '/connections/-'
            ) {
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

            // Interlock ops by ID → rewrite to index-based path so applyJsonPatch
            // can walk the array. Covers both `/interlocks/<id>/<field>` and
            // `/interlocks/<id>` (remove). Handled together so cascade logic
            // below doesn't need a second regex.
            const idPathMatch = op.path.match(/^\/interlocks\/([^/]+)(\/.+)?$/);
            if (idPathMatch && !/^\d+$/.test(idPathMatch[1]) && idPathMatch[1] !== '-') {
                const [, ilkId, rest = ''] = idPathMatch;
                const idx = interlocks.findIndex((i) => i.id === ilkId);
                if (idx < 0) continue; // unknown interlock — drop silently
                const rewritten = { ...op, path: `/interlocks/${idx}${rest}` };
                processed.push(rewritten);
                // Members replace also triggers exclusive-mute reconcile.
                if (op.op === 'replace' && rest === '/members') {
                    for (const c of this.muteExceptFirstHot(modules, (op.value as string[]) ?? []))
                        addCascade(c);
                }
                continue;
            }

            // Module delete: also remove connections involving this module, and
            // prune it from any interlock group that references it.
            if (op.op === 'remove' && op.path.match(/^\/modules\/[^/]+$/)) {
                const moduleId = op.path.split('/')[2];
                const connections = (config.connections ?? []) as Array<Record<string, unknown>>;
                // Remove connections in reverse order (so indices don't shift)
                const toRemove = connections
                    .map((c, i) => ({ idx: i, conn: c }))
                    .filter(
                        (c) =>
                            c.conn.sourceModuleId === moduleId || c.conn.sinkModuleId === moduleId,
                    )
                    .reverse();
                for (const { idx } of toRemove) {
                    addCascade({ op: 'remove', path: `/connections/${idx}` });
                }
                for (let i = 0; i < interlocks.length; i++) {
                    const ilk = interlocks[i];
                    if (ilk.members.includes(moduleId)) {
                        addCascade({
                            op: 'replace',
                            path: `/interlocks/${i}/members`,
                            value: ilk.members.filter((m) => m !== moduleId),
                        });
                    }
                }
                processed.push(op);
                continue;
            }

            // Interlock exclusive-mute: when a member is unmuted, mute the others
            // FIRST (avoids a window with two hot members, even for one op-frame).
            if (
                op.op === 'replace' &&
                op.value === true &&
                op.path.match(/^\/modules\/[^/]+\/settings\/audioEnabled$/)
            ) {
                const moduleId = op.path.split('/')[2];
                const ilk = interlocks.find((g) => g.members.includes(moduleId));
                if (ilk) {
                    // Temporarily mark moduleId as hot so it's treated as "keptFirst"
                    // and the other hot members get muted.
                    const mutes = this.muteExceptFirstHot(
                        {
                            ...modules,
                            [moduleId]: {
                                ...modules[moduleId],
                                settings: {
                                    ...(modules[moduleId]?.settings ?? {}),
                                    audioEnabled: true,
                                },
                            },
                        },
                        [moduleId, ...ilk.members.filter((m) => m !== moduleId)],
                        moduleId,
                    );
                    for (const c of mutes) addCascade(c);
                }
                processed.push(op);
                continue;
            }

            // Index-path members replace (e.g. from cascade on module delete, or
            // clients that sent index paths directly). Same cascade as id path.
            if (op.op === 'replace' && op.path.match(/^\/interlocks\/\d+\/members$/)) {
                processed.push(op);
                for (const c of this.muteExceptFirstHot(modules, (op.value as string[]) ?? []))
                    addCascade(c);
                continue;
            }

            // Group created with pre-populated members: same cascade.
            if (
                op.op === 'add' &&
                op.path === '/interlocks/-' &&
                op.value &&
                typeof op.value === 'object'
            ) {
                processed.push(op);
                const newMembers =
                    ((op.value as Record<string, unknown>).members as string[]) ?? [];
                for (const c of this.muteExceptFirstHot(modules, newMembers)) addCascade(c);
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
                        const schemaProps = ((manifest.configSchema as any)?.properties ??
                            {}) as Record<string, Record<string, unknown>>;
                        for (const [key, schemaProp] of Object.entries(schemaProps)) {
                            if (schemaProp.default !== undefined) {
                                defaultSettings[key] = schemaProp.default;
                            }
                        }
                        modValue.settings = {
                            ...defaultSettings,
                            ...((modValue.settings as Record<string, unknown>) ?? {}),
                        };
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
                            ports.push({
                                id: `in-${i}`,
                                direction: 'input',
                                streamType: 'audio/pcm',
                                label: `In ${i + 1}`,
                                maxConnections: -1,
                            });
                        }
                        for (let i = 0; i < pairCount; i++) {
                            ports.push({
                                id: `out-${i}`,
                                direction: 'output',
                                streamType: 'audio/pcm',
                                label: `Out ${i + 1}`,
                                maxConnections: -1,
                            });
                        }
                        addCascade({
                            op: 'replace',
                            path: `/modules/${moduleId}/ports`,
                            value: ports,
                        });
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
                    if (conn.sourceModuleId !== moduleId && conn.sinkModuleId !== moduleId)
                        continue;
                    const filtered = conn.channelMap.filter((entry: any) => {
                        if (conn.sourceModuleId === moduleId && entry.srcChannel >= newChannels)
                            return false;
                        if (conn.sinkModuleId === moduleId && entry.dstChannel >= newChannels)
                            return false;
                        return true;
                    });
                    if (filtered.length !== conn.channelMap.length) {
                        addCascade({
                            op: 'replace',
                            path: `/connections/${i}/channelMap`,
                            value: filtered.length > 0 ? filtered : undefined,
                        });
                    }
                }
                continue;
            }

            processed.push(op);
        }

        return { processed, cascades };
    }

    /**
     * Enrich ops for broadcast (e.g. module add needs full module data with manifest info).
     */
    private enrichOpsForBroadcast(
        engineId: string,
        ops: PatchOp[],
        updatedConfig: Record<string, unknown> | undefined,
    ): PatchOp[] {
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
