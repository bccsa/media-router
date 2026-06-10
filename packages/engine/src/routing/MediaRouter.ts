import type { ModulePort, StreamType, ChannelMapEntry } from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';
import type { PipeWireManager } from '../audio/PipeWireManager.js';
import type { ModuleInstance } from '../modules/ModuleInstance.js';
import { UdpPortManager } from './UdpPortManager.js';
import { PortRegistry } from './PortRegistry.js';
import { ConnectionExecutor } from './ConnectionExecutor.js';
import { StreamTypeExecutorRegistry, makeConnLabel } from './StreamTypeExecutor.js';
import { PcmAudioExecutor } from './PcmAudioExecutor.js';
import { MpegTsUdpExecutor } from './MpegTsUdpExecutor.js';

const log = createLogger('MediaRouter');

/** UDP multicast address for local MPEG-TS routing. */
const MULTICAST_ADDR = '239.255.0.1';

export interface Connection {
    id: string;
    sourceModuleId: string;
    sourcePortId: string;
    sinkModuleId: string;
    sinkPortId: string;
    streamType: StreamType;
    channelMap?: ChannelMapEntry[];
}

export interface ActiveHandle {
    connectionId: string;
    type: 'udp' | 'pw-link';
    udpPort?: number;
    pwLinkIds?: number[];
    /** Port name pairs for pw-link teardown (fallback when link IDs are 0). */
    pwLinkPairs?: Array<{ src: string; dst: string }>;
}

/**
 * Routing graph for module connections.
 *
 * Delegates to:
 * - PortRegistry — port registration and validation
 * - ConnectionExecutor — execution and teardown of audio/MPEG-TS links
 * - UdpPortManager — UDP port allocation for encoders
 */
export class MediaRouter {
    private connections = new Map<string, Connection>();
    private handles = new Map<string, ActiveHandle>();
    private executor: ConnectionExecutor | null = null;
    private moduleGetter: ((id: string) => ModuleInstance | undefined) | null = null;

    readonly portRegistry = new PortRegistry();
    readonly udpPorts = new UdpPortManager();
    /**
     * Pluggable per-stream-type executor registry. Pre-populated with the two
     * built-in executors (`audio/pcm`, `muxed/mpegts`) during `setDependencies`;
     * plugins can add more via `services.mediaRouter.streamExecutors.register(...)`
     * from their static `registerServices` hook.
     */
    readonly streamExecutors = new StreamTypeExecutorRegistry();

    // --- Setup ---

    /**
     * Optional hook invoked after `MpegTsUdpExecutor` restarts a consumer
     * module. Registered (lazily) by `ModuleLifecycle` once it has its
     * `ConnectionApplier` constructed, so the consumer's outgoing
     * connections can be re-applied. See `MpegTsUdpExecutor.onConsumerRestarted`.
     */
    private consumerRestartCallback: ((id: string) => Promise<void>) | null = null;

    setConsumerRestartCallback(cb: (id: string) => Promise<void>): void {
        this.consumerRestartCallback = cb;
    }

    setDependencies(
        pipeWire: PipeWireManager,
        moduleGetter: (id: string) => ModuleInstance | undefined,
        displayNameResolver?: (id: string) => string,
    ): void {
        this.moduleGetter = moduleGetter;
        const connLabel = makeConnLabel(displayNameResolver);
        this.streamExecutors.register(
            new PcmAudioExecutor(pipeWire, moduleGetter, connLabel),
        );
        this.streamExecutors.register(
            new MpegTsUdpExecutor(
                moduleGetter,
                (moduleId, portId) =>
                    this.udpPorts.get(this.udpPortKey(moduleId, portId)) ??
                    this.udpPorts.get(moduleId),
                MULTICAST_ADDR,
                connLabel,
                (id) => this.consumerRestartCallback?.(id) ?? Promise.resolve(),
            ),
        );
        this.executor = new ConnectionExecutor(this.streamExecutors);
    }

    // --- Port delegation ---

    registerPorts(moduleId: string, ports: ModulePort[]): void {
        this.portRegistry.register(moduleId, ports);
    }

    async unregisterPorts(moduleId: string): Promise<void> {
        this.portRegistry.unregister(moduleId);
        // Snapshot keys — removeConnection mutates this.connections during iteration
        const toRemove = Array.from(this.connections.entries())
            .filter(
                ([, conn]) => conn.sourceModuleId === moduleId || conn.sinkModuleId === moduleId,
            )
            .map(([id]) => id);
        for (const id of toRemove) {
            await this.removeConnection(id);
        }
    }

    unregisterAll(): void {
        this.portRegistry.unregisterAll();
    }

    getPort(moduleId: string, portId: string): ModulePort | undefined {
        return this.portRegistry.get(moduleId, portId);
    }

    // --- Connection CRUD ---

    async createConnection(
        sourceModuleId: string,
        sourcePortId: string,
        sinkModuleId: string,
        sinkPortId: string,
        channelMap?: ChannelMapEntry[],
    ): Promise<string> {
        const sourcePort = this.portRegistry.get(sourceModuleId, sourcePortId);
        const sinkPort = this.portRegistry.get(sinkModuleId, sinkPortId);

        if (!sourcePort)
            throw new Error(`Source port not found: ${sourceModuleId}:${sourcePortId}`);
        if (!sinkPort) throw new Error(`Sink port not found: ${sinkModuleId}:${sinkPortId}`);

        if (sourcePort.direction !== 'output')
            throw new Error(`Source port ${sourcePortId} is not an output`);
        if (sinkPort.direction !== 'input')
            throw new Error(`Sink port ${sinkPortId} is not an input`);

        const compat = this.portRegistry.validateCompatibility(sourcePort, sinkPort);
        if (!compat.compatible) throw new Error(`Incompatible ports: ${compat.reason}`);

        const connId = `${sourceModuleId}:${sourcePortId}-${sinkModuleId}:${sinkPortId}`;

        // If this exact connection already exists, skip (idempotent). This must
        // run BEFORE the maxConnections check: a re-apply of an existing edge
        // would otherwise trip the capacity guard on single-slot ports (e.g.
        // mpegts-in, cap 1), throwing "already has 1/1 connections" instead of
        // being recognised as a harmless duplicate.
        if (this.connections.has(connId)) {
            log.info({ connectionId: connId }, 'Connection already exists — skipping');
            return connId;
        }

        // Validate maxConnections
        const sourceMax = sourcePort.maxConnections ?? -1;
        const sinkMax = sinkPort.maxConnections ?? -1;
        if (sourceMax === 0) throw new Error(`Port ${sourcePortId} does not allow connections`);
        if (sinkMax === 0) throw new Error(`Port ${sinkPortId} does not allow connections`);

        if (sourceMax > 0) {
            const count = this.portRegistry.getConnectionCount(
                sourceModuleId,
                sourcePortId,
                this.connections.values(),
            );
            if (count >= sourceMax)
                throw new Error(
                    `Port ${sourcePortId} already has ${count}/${sourceMax} connections`,
                );
        }
        if (sinkMax > 0) {
            const count = this.portRegistry.getConnectionCount(
                sinkModuleId,
                sinkPortId,
                this.connections.values(),
            );
            if (count >= sinkMax)
                throw new Error(`Port ${sinkPortId} already has ${count}/${sinkMax} connections`);
        }

        const conn: Connection = {
            id: connId,
            sourceModuleId,
            sourcePortId,
            sinkModuleId,
            sinkPortId,
            streamType: sourcePort.streamType,
            channelMap: channelMap?.length ? channelMap : undefined,
        };
        this.connections.set(connId, conn);

        if (this.executor) {
            try {
                const handle = await this.executor.execute(conn);
                if (handle) {
                    this.handles.set(connId, handle);
                } else {
                    // Execution returned null — remove the zombie connection
                    this.connections.delete(connId);
                    log.warn(
                        { connectionId: connId },
                        'Connection execution returned null — removed',
                    );
                }
            } catch (err) {
                // Execution threw — remove the zombie connection and re-throw
                // so callers (e.g. ConnectionApplier.connectWithRetry) see
                // the failure and can retry. Without re-throw, transient
                // startup races (encoder not yet started → no UDP port)
                // turned into silently-orphaned decoders that needed manual
                // restart to recover.
                this.connections.delete(connId);
                log.error({ err, connectionId: connId }, 'Failed to execute connection — removed');
                throw err;
            }
        }

        return connId;
    }

    async removeConnection(connId: string, skipModuleRestart = false): Promise<boolean> {
        const conn = this.connections.get(connId);
        const existed = this.connections.delete(connId);
        const handle = this.handles.get(connId);
        if (handle && this.executor) {
            await this.executor.teardown(handle, conn, skipModuleRestart);
            this.handles.delete(connId);
        }
        return existed;
    }

    async updateChannelMap(connId: string, channelMap?: ChannelMapEntry[]): Promise<void> {
        const conn = this.connections.get(connId);
        if (!conn) {
            log.warn({ connectionId: connId }, 'Cannot update channel map — connection not found');
            return;
        }
        if (conn.streamType !== 'audio/pcm') {
            log.warn({ connectionId: connId }, 'Channel map only applies to audio/pcm connections');
            return;
        }

        const handle = this.handles.get(connId);
        if (handle && this.executor) {
            await this.executor.teardown(handle, conn, true);
            this.handles.delete(connId);
        }

        conn.channelMap = channelMap?.length ? channelMap : undefined;

        try {
            const newHandle = await this.executor?.execute(conn);
            if (newHandle) this.handles.set(connId, newHandle);
        } catch (err) {
            log.error(
                { err, connectionId: connId },
                'Failed to re-execute connection with new channel map',
            );
        }
    }

    async removeAllConnections(skipModuleRestart = false): Promise<void> {
        for (const connId of Array.from(this.connections.keys())) {
            await this.removeConnection(connId, skipModuleRestart);
        }
    }

    // --- UDP port management ---
    //
    // The UDP port pool is generic infrastructure used by any plugin that
    // needs an allocated multicast port for muxed/mpegts traffic — MPEG-TS
    // muxers/demuxers, SRT in/out, RIST in/out, video/audio encoders. Plugins
    // call `assignUdpPort(instanceId[, portId])` during pipeline build and
    // `releaseUdpPort` / `releaseAllUdpPortsFor` on teardown.

    /**
     * Owner key for the UDP port pool. When a module exposes multiple muxed/mpegts
     * outputs (e.g. an MPEG-TS demuxer with one port per program), each output port
     * gets its own multicast port keyed by `${moduleId}:${portId}`. The legacy
     * single-port case (no portId) keeps the bare `moduleId` key.
     *
     * INVARIANT: module ids must not contain a colon — they're generated by
     * `${pluginId}-${nanoid}` (see `ModuleManager.createModule`), so this holds
     * naturally. If a future plugin id ever introduces colons, this key shape
     * will collide with the per-port form.
     */
    private udpPortKey(moduleId: string, portId?: string): string {
        return portId ? `${moduleId}:${portId}` : moduleId;
    }

    assignUdpPort(
        moduleId: string,
        portId?: string,
    ): { host: string; port: number } | null {
        const port = this.udpPorts.acquire(this.udpPortKey(moduleId, portId));
        return port !== null ? { host: MULTICAST_ADDR, port } : null;
    }

    getUdpEndpoint(
        moduleId: string,
        portId?: string,
    ): { host: string; port: number } | undefined {
        const port = this.udpPorts.get(this.udpPortKey(moduleId, portId));
        return port !== undefined ? { host: MULTICAST_ADDR, port } : undefined;
    }

    releaseUdpPort(moduleId: string, portId?: string): void {
        this.udpPorts.release(this.udpPortKey(moduleId, portId));
    }

    /** Release every UDP port owned by a module — primary slot plus any per-port sub-slots. */
    releaseAllUdpPortsFor(moduleId: string): void {
        this.udpPorts.releaseAllForOwner(moduleId);
    }

    // --- Queries ---

    getConnections(): Connection[] {
        return Array.from(this.connections.values());
    }

    getModuleConnections(moduleId: string): Connection[] {
        return this.getConnections().filter(
            (c) => c.sourceModuleId === moduleId || c.sinkModuleId === moduleId,
        );
    }

    getPortConnectionCount(moduleId: string, portId: string): number {
        return this.portRegistry.getConnectionCount(moduleId, portId, this.connections.values());
    }

    getModuleUdpSource(
        moduleId: string,
        sinkPortId?: string,
    ):
        | {
              host: string;
              port: number;
              connectionId: string;
              channels?: number;
              sourceModuleId: string;
              sourcePortId: string;
          }
        | undefined {
        for (const [connId, conn] of this.connections) {
            if (conn.sinkModuleId !== moduleId || conn.streamType !== 'muxed/mpegts') continue;
            if (sinkPortId !== undefined && conn.sinkPortId !== sinkPortId) continue;
            // Prefer per-output port allocation, fall back to module-level (legacy single-port encoders)
            const port =
                this.udpPorts.get(this.udpPortKey(conn.sourceModuleId, conn.sourcePortId)) ??
                this.udpPorts.get(conn.sourceModuleId);
            if (port !== undefined) {
                const srcModule = this.moduleGetter?.(conn.sourceModuleId);
                const channels = srcModule?.config?.channels as number | undefined;
                return {
                    host: MULTICAST_ADDR,
                    port,
                    connectionId: connId,
                    channels,
                    sourceModuleId: conn.sourceModuleId,
                    sourcePortId: conn.sourcePortId,
                };
            }
        }
        return undefined;
    }

    /** Resolve every connected muxed/mpegts source feeding a given sink module. */
    getModuleUdpSources(
        moduleId: string,
    ): Array<{
        host: string;
        port: number;
        connectionId: string;
        sourceModuleId: string;
        sourcePortId: string;
        sinkPortId: string;
    }> {
        const out: Array<{
            host: string;
            port: number;
            connectionId: string;
            sourceModuleId: string;
            sourcePortId: string;
            sinkPortId: string;
        }> = [];
        for (const [connId, conn] of this.connections) {
            if (conn.sinkModuleId !== moduleId || conn.streamType !== 'muxed/mpegts') continue;
            const port =
                this.udpPorts.get(this.udpPortKey(conn.sourceModuleId, conn.sourcePortId)) ??
                this.udpPorts.get(conn.sourceModuleId);
            if (port !== undefined) {
                out.push({
                    host: MULTICAST_ADDR,
                    port,
                    connectionId: connId,
                    sourceModuleId: conn.sourceModuleId,
                    sourcePortId: conn.sourcePortId,
                    sinkPortId: conn.sinkPortId,
                });
            }
        }
        return out;
    }
}
