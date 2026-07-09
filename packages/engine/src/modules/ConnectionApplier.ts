import type { ChannelMapEntry, StreamType } from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';
import type { ModuleManager } from './ModuleManager.js';
import type { MediaRouter } from '../routing/MediaRouter.js';
import type { PluginLoader } from '../plugins/PluginLoader.js';

const log = createLogger('ConnectionApplier');

/**
 * Time to wait after applying parent-before-child connections before applying
 * the rest. Lets newly-started pipelines (Python runner spawn + GStreamer
 * pipeline construction) reach PLAYING so downstream pw-link connections
 * find the producer's PipeWire nodes ready.
 */
const ORDERED_APPLY_SETTLE_MS = 1000;

/** Max retries for failed connections. */
const MAX_RETRIES = 2;
/** Delay between retries (doubles each attempt). */
const RETRY_BASE_MS = 1000;

export type RawPort = {
    id: string;
    direction: string;
    streamType: string;
    label?: string;
    maxConnections?: number;
    /**
     * When set on an output port, connections from this port are applied in
     * topological order before other connections and a settle delay is
     * inserted afterwards. Used by plugins whose downstream consumers can
     * only be wired up once *their* pipeline has started — e.g. UDP-multicast
     * transports where the producer's port number is allocated lazily on
     * pipeline start. Previously hard-coded to `streamType === 'muxed/mpegts'`;
     * now any plugin opting in via this flag participates.
     */
    requiresOrderedApply?: boolean;
};

export interface StoredConnection {
    id: string;
    sourceModuleId: string;
    sourcePortId: string;
    sinkModuleId: string;
    sinkPortId: string;
    channelMap?: ChannelMapEntry[];
}

/**
 * Topologically sort the ordered-apply connections so that for every
 * connection `A → B`, all connections `_ → A` (i.e. connections whose sink
 * is *this* connection's source module) come first. Applying a parent
 * connection triggers the sink module's pipeline to start, which is what
 * assigns the dynamic UDP ports the child connection needs.
 *
 * Cycles (impossible by construction for a DAG of media flow but defended
 * against here) are placed at the end in arbitrary order.
 */
export function topoSortOrderedConns(conns: StoredConnection[]): StoredConnection[] {
    const sorted: StoredConnection[] = [];
    const remaining = [...conns];
    while (remaining.length > 0) {
        const readyIdx = remaining.findIndex(
            (c) => !remaining.some((other) => other !== c && other.sinkModuleId === c.sourceModuleId),
        );
        if (readyIdx === -1) {
            sorted.push(...remaining);
            break;
        }
        sorted.push(...remaining.splice(readyIdx, 1));
    }
    return sorted;
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
        private resolvePortsForInstance: (
            instanceId: string,
            modConfig: Record<string, unknown>,
            pluginId: string,
        ) => RawPort[],
    ) {}

    /**
     * Apply stored connections after all modules have started.
     *
     * Connections whose source port carries the manifest flag
     * `requiresOrderedApply: true` are applied first (typically UDP-transport
     * pipelines that need to restart on each connection), in topological
     * order so parent connections complete before children that depend on
     * them. The remaining connections (mostly pw-link audio routing) wait a
     * settle window so the just-started pipelines are PLAYING before their
     * PipeWire nodes are queried.
     *
     * Ordered-apply connections are sorted so a connection `A.out → B.in`
     * runs before `B.out → C.in`, because applying `A.out → B.in` is what
     * triggers B's pipeline to start and assign B's output ports. Without
     * this ordering, the child connection fails with "no assigned port yet"
     * (see `ConnectionExecutor.executeUdp`) and the per-connection retry
     * can't recover because the unblocker is queued behind it in storage
     * order. This bit the mpegts-demuxer chain: srt-input → demuxer →
     * decoder applied the demuxer→decoder leg before srt-input→demuxer, and
     * the decoder stayed stuck on "no encoder connected" until manual
     * restart.
     */
    async applyConnections(
        connections: StoredConnection[],
        modules: Record<string, Record<string, unknown>>,
    ): Promise<void> {
        log.info({ count: connections.length }, 'Applying connections');

        // Pipelines that need to start before their downstream consumers go
        // first. Identified by the source port's `requiresOrderedApply` flag
        // (previously hard-coded as `streamType === 'muxed/mpegts'`; now any
        // plugin can opt in by setting the flag on its producing ports).
        const orderedConns = connections.filter((c) => {
            const srcMod = modules[c.sourceModuleId];
            const pluginId = srcMod?.pluginId as string | undefined;
            const ports = pluginId
                ? this.resolvePortsForInstance(c.sourceModuleId, srcMod!, pluginId)
                : [];
            return ports.find((p) => p.id === c.sourcePortId)?.requiresOrderedApply === true;
        });
        const remainingConns = connections.filter((c) => !orderedConns.includes(c));

        const sorted = topoSortOrderedConns(orderedConns);
        for (const conn of sorted) {
            await this.connectWithRetry(conn);
        }

        if (orderedConns.length > 0 && remainingConns.length > 0) {
            await new Promise((r) => setTimeout(r, ORDERED_APPLY_SETTLE_MS));
        }

        for (const conn of remainingConns) {
            await this.connectWithRetry(conn);
        }
    }

    /** Re-apply stored connections for a specific module after restart/enable. */
    async reapplyModuleConnections(moduleId: string, outgoingOnly = false): Promise<void> {
        const config = this.getConfig();
        if (!config) return;

        // Cascade path (post consumer-restart via MpegTsUdpExecutor): the
        // module we're re-applying for was just stopped/started to pick up a
        // producer's udpsrc, which recreated its PipeWire null-sink. Any live
        // pw-link handle on its *outgoing* edges now points at a destroyed
        // node. Drop those handles (and their connection records) first so the
        // re-apply below actually re-executes them, instead of the idempotent
        // `createConnection` short-circuit skipping the re-link and leaving the
        // downstream module (e.g. an encoder fed by this decoder) wired to a
        // dead node — silent until a manual restart.
        if (outgoingOnly) {
            await this.mediaRouter.invalidateOutgoingPwLinks(moduleId);
        }

        const storedConns = (config.connections ?? []) as StoredConnection[];
        for (const conn of storedConns) {
            // `outgoingOnly` is used by the post-consumer-restart cascade
            // (MpegTsUdpExecutor.onConsumerRestarted): re-applying the just-
            // restarted module's *incoming* edges would restart it again,
            // re-firing the cascade — an infinite restart loop. It bites
            // multi-input consumers hardest (e.g. mpegts-muxer: 2 encoder
            // inputs + 1 output), which then never settle and report "no
            // inputs". Outgoing-only matches the hook's documented purpose:
            // give the consumer's *downstream* connections a fresh attempt
            // now that it has allocated its own UDP output ports.
            const match = outgoingOnly
                ? conn.sourceModuleId === moduleId
                : conn.sourceModuleId === moduleId || conn.sinkModuleId === moduleId;
            if (match) {
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
                    conn.sourceModuleId,
                    conn.sourcePortId,
                    conn.sinkModuleId,
                    conn.sinkPortId,
                    conn.channelMap,
                );
                log.info(
                    {
                        source: `${conn.sourceModuleId}:${conn.sourcePortId}`,
                        sink: `${conn.sinkModuleId}:${conn.sinkPortId}`,
                    },
                    'Connected',
                );
                return;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (attempt < MAX_RETRIES) {
                    const delay = RETRY_BASE_MS * Math.pow(2, attempt);
                    log.warn(
                        { connectionId: conn.id, attempt: attempt + 1, retryIn: delay },
                        `Connection failed, retrying: ${msg}`,
                    );
                    await new Promise((r) => setTimeout(r, delay));
                    // Re-check endpoints are still running before retry
                    if (
                        !this.moduleManager.get(conn.sourceModuleId)?.running ||
                        !this.moduleManager.get(conn.sinkModuleId)?.running
                    ) {
                        log.info(
                            { connectionId: conn.id },
                            'Endpoint stopped during retry — giving up',
                        );
                        return;
                    }
                } else {
                    log.error(
                        { connectionId: conn.id },
                        `Connection failed after ${MAX_RETRIES + 1} attempts: ${msg}`,
                    );
                }
            }
        }
    }
}
