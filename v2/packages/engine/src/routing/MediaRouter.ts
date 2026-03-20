import type { ModulePort, StreamType, ChannelMapEntry } from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';
import type { PipeWireManager } from '../audio/PipeWireManager.js';
import type { ModuleInstance } from '../modules/ModuleInstance.js';
import { UdpPortManager } from './UdpPortManager.js';

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
    /** Per-channel routing rules (audio/pcm only). */
    channelMap?: ChannelMapEntry[];
}

export interface ActiveHandle {
    connectionId: string;
    type: 'loopback' | 'udp' | 'pw-link';
    /** PulseAudio module ID for loopback connections. */
    paModuleId?: number;
    /** UDP port used for MPEG-TS multicast connections. */
    udpPort?: number;
    /** pw-link IDs for per-channel connections. */
    pwLinkIds?: number[];
}

export interface CompatibilityResult {
    compatible: boolean;
    reason?: string;
}

/**
 * Routing graph and connection executor for module connections.
 *
 * Manages port registration, validates connections, and executes them:
 * - audio/pcm: PipeWire loopback (module-loopback between null-sinks)
 * - muxed/mpegts: stdout→stdin pipe between GStreamer child processes
 */
export class MediaRouter {
    /** Module ports: moduleId → ports[] */
    private ports = new Map<string, ModulePort[]>();
    /** Active connections: connectionId → Connection */
    private connections = new Map<string, Connection>();
    /** Active media handles: connectionId → ActiveHandle */
    private handles = new Map<string, ActiveHandle>();

    private pipeWire: PipeWireManager | null = null;
    private moduleGetter: ((id: string) => ModuleInstance | undefined) | null = null;
    /** Central UDP port allocator. */
    readonly udpPorts = new UdpPortManager();

    /**
     * Inject dependencies for connection execution.
     */
    setDependencies(
        pipeWire: PipeWireManager,
        moduleGetter: (id: string) => ModuleInstance | undefined,
    ): void {
        this.pipeWire = pipeWire;
        this.moduleGetter = moduleGetter;
    }

    /** Register a module's ports. */
    registerPorts(moduleId: string, ports: ModulePort[]): void {
        this.ports.set(moduleId, ports);
    }

    /** Unregister a module's ports and remove its connections. */
    async unregisterPorts(moduleId: string): Promise<void> {
        this.ports.delete(moduleId);
        // Remove all connections involving this module
        for (const [id, conn] of this.connections) {
            if (conn.sourceModuleId === moduleId || conn.sinkModuleId === moduleId) {
                await this.removeConnection(id);
            }
        }
    }

    /** Unregister all ports (used during full stop). */
    unregisterAll(): void {
        this.ports.clear();
    }

    /** Look up a specific port on a module. */
    getPort(moduleId: string, portId: string): ModulePort | undefined {
        return this.ports.get(moduleId)?.find((p) => p.id === portId);
    }

    /**
     * Create and execute a connection between an output port and an input port.
     * Returns the connection ID.
     */
    async createConnection(
        sourceModuleId: string,
        sourcePortId: string,
        sinkModuleId: string,
        sinkPortId: string,
        channelMap?: ChannelMapEntry[],
    ): Promise<string> {
        const sourcePort = this.getPort(sourceModuleId, sourcePortId);
        const sinkPort = this.getPort(sinkModuleId, sinkPortId);

        if (!sourcePort) throw new Error(`Source port not found: ${sourceModuleId}:${sourcePortId}`);
        if (!sinkPort) throw new Error(`Sink port not found: ${sinkModuleId}:${sinkPortId}`);

        // Validate directions
        if (sourcePort.direction !== 'output') {
            throw new Error(`Source port ${sourcePortId} is not an output`);
        }
        if (sinkPort.direction !== 'input') {
            throw new Error(`Sink port ${sinkPortId} is not an input`);
        }

        // Validate compatibility
        const compat = this.validateCompatibility(sourcePort, sinkPort);
        if (!compat.compatible) {
            throw new Error(`Incompatible ports: ${compat.reason}`);
        }

        // Validate maxConnections
        const sourceMax = sourcePort.maxConnections ?? -1;
        const sinkMax = sinkPort.maxConnections ?? -1;
        if (sourceMax === 0) throw new Error(`Port ${sourcePortId} does not allow connections`);
        if (sinkMax === 0) throw new Error(`Port ${sinkPortId} does not allow connections`);

        if (sourceMax > 0) {
            const currentOut = this.getPortConnectionCount(sourceModuleId, sourcePortId);
            if (currentOut >= sourceMax) {
                throw new Error(`Port ${sourcePortId} already has ${currentOut}/${sourceMax} connections`);
            }
        }
        if (sinkMax > 0) {
            const currentIn = this.getPortConnectionCount(sinkModuleId, sinkPortId);
            if (currentIn >= sinkMax) {
                throw new Error(`Port ${sinkPortId} already has ${currentIn}/${sinkMax} connections`);
            }
        }

        const connId = `${sourceModuleId}:${sourcePortId}-${sinkModuleId}:${sinkPortId}`;

        // Store the connection
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

        // Execute the connection
        try {
            const handle = await this.executeConnection(conn);
            if (handle) {
                this.handles.set(connId, handle);
            }
        } catch (err) {
            log.error({ err, connectionId: connId }, 'Failed to execute connection');
        }

        return connId;
    }

    /**
     * Remove and tear down a connection by ID.
     * @param skipModuleRestart If true, don't restart encoder/decoder modules
     *   (used when the module is about to be stopped/disabled anyway).
     */
    async removeConnection(connId: string, skipModuleRestart = false): Promise<boolean> {
        // Save connection info before deleting — teardown needs it
        const conn = this.connections.get(connId);
        // Delete connection FIRST so decoder's buildPipeline() sees no source on restart
        const existed = this.connections.delete(connId);
        const handle = this.handles.get(connId);
        if (handle) {
            await this.teardownConnection(handle, conn, skipModuleRestart);
            this.handles.delete(connId);
        }
        return existed;
    }

    /**
     * Update the channel map on an existing connection.
     * Tears down the current audio link and re-creates it with the new map.
     */
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

        // Tear down existing handle
        const handle = this.handles.get(connId);
        if (handle) {
            await this.teardownConnection(handle, conn, true);
            this.handles.delete(connId);
        }

        // Update the connection's channel map
        conn.channelMap = channelMap?.length ? channelMap : undefined;

        // Re-execute with new channel map
        try {
            const newHandle = await this.executeConnection(conn);
            if (newHandle) {
                this.handles.set(connId, newHandle);
            }
        } catch (err) {
            log.error({ err, connectionId: connId }, 'Failed to re-execute connection with new channel map');
        }
    }

    /** Remove all connections (used on engine stop). */
    async removeAllConnections(skipModuleRestart = false): Promise<void> {
        for (const connId of Array.from(this.connections.keys())) {
            await this.removeConnection(connId, skipModuleRestart);
        }
    }

    /** Allocate a UDP port for an encoder module. Called at encoder startup. */
    assignEncoderPort(moduleId: string): { host: string; port: number } | null {
        const port = this.udpPorts.acquire(moduleId);
        if (port === null) return null;
        return { host: MULTICAST_ADDR, port };
    }

    /** Get the encoder's assigned UDP endpoint (if any). */
    getEncoderEndpoint(moduleId: string): { host: string; port: number } | undefined {
        const port = this.udpPorts.get(moduleId);
        if (port === undefined) return undefined;
        return { host: MULTICAST_ADDR, port };
    }

    /** Release encoder UDP port for a module (call when disabling/deleting a module). */
    releaseEncoderPort(moduleId: string): void {
        this.udpPorts.release(moduleId);
    }

    /** Get all active connections. */
    getConnections(): Connection[] {
        return Array.from(this.connections.values());
    }

    /** Count active connections on a specific port. */
    getPortConnectionCount(moduleId: string, portId: string): number {
        let count = 0;
        for (const conn of this.connections.values()) {
            if ((conn.sourceModuleId === moduleId && conn.sourcePortId === portId) ||
                (conn.sinkModuleId === moduleId && conn.sinkPortId === portId)) {
                count++;
            }
        }
        return count;
    }

    /** Get connections involving a specific module. */
    getModuleConnections(moduleId: string): Connection[] {
        return this.getConnections().filter(
            (c) => c.sourceModuleId === moduleId || c.sinkModuleId === moduleId,
        );
    }

    /**
     * Validate stream type compatibility between two ports.
     */
    validateCompatibility(sourcePort: ModulePort, sinkPort: ModulePort): CompatibilityResult {
        if (sourcePort.streamType !== sinkPort.streamType) {
            return {
                compatible: false,
                reason: `Stream type mismatch: ${sourcePort.streamType} → ${sinkPort.streamType}`,
            };
        }

        // For audio/pcm: optionally check channel count
        if (sourcePort.streamType === 'audio/pcm') {
            const srcCh = sourcePort.channelConfig?.channels;
            const sinkCh = sinkPort.channelConfig?.channels;
            if (srcCh && sinkCh && srcCh !== sinkCh) {
                return {
                    compatible: false,
                    reason: `Channel mismatch: ${srcCh} → ${sinkCh}`,
                };
            }
        }

        return { compatible: true };
    }

    // --- Connection execution ---

    private async executeConnection(conn: Connection): Promise<ActiveHandle | null> {
        if (conn.streamType === 'audio/pcm') {
            return this.executeAudioConnection(conn);
        } else if (conn.streamType === 'muxed/mpegts') {
            return this.executeUdpConnection(conn);
        }
        log.warn({ streamType: conn.streamType }, 'Unknown stream type');
        return null;
    }

    private async executeAudioConnection(conn: Connection): Promise<ActiveHandle | null> {
        if (!this.pipeWire || !this.moduleGetter) {
            log.warn('PipeWire not available, cannot create audio connection');
            return null;
        }

        const sourceModule = this.moduleGetter(conn.sourceModuleId);
        const sinkModule = this.moduleGetter(conn.sinkModuleId);

        if (!sourceModule || !sinkModule) {
            log.warn({ connectionId: conn.id }, 'Module not found for audio connection');
            return null;
        }

        const sourceNodes = sourceModule.getPipeWireNodes();
        const sinkNodes = sinkModule.getPipeWireNodes();

        if (!sourceNodes?.source) {
            log.warn({ moduleId: conn.sourceModuleId }, 'Source module has no PipeWire source');
            return null;
        }
        if (!sinkNodes?.sink) {
            log.warn({ moduleId: conn.sinkModuleId }, 'Sink module has no PipeWire sink');
            return null;
        }

        // If channel map is specified, use pw-link for per-channel routing
        if (conn.channelMap?.length) {
            return this.executePwLinkConnection(conn, sourceNodes.source, sinkNodes.sink);
        }

        // Default: use module-loopback (PipeWire handles channel matching)
        log.info({ source: sourceNodes.source, sink: sinkNodes.sink }, 'Creating audio loopback');

        const paModuleId = await this.pipeWire.loadLoopback(
            conn.id,
            sourceNodes.source,
            sinkNodes.sink,
            2, 48000,
            conn.sourceModuleId,
        );

        return {
            connectionId: conn.id,
            type: 'loopback',
            paModuleId,
        };
    }

    /**
     * Execute per-channel routing using pw-link.
     * Each ChannelMapEntry creates a direct port-to-port link.
     */
    private async executePwLinkConnection(
        conn: Connection,
        sourcePwNode: string,
        sinkPwNode: string,
    ): Promise<ActiveHandle | null> {
        if (!this.pipeWire) return null;

        log.info({
            connectionId: conn.id,
            source: sourcePwNode,
            sink: sinkPwNode,
            mappings: conn.channelMap!.length,
        }, 'Creating per-channel pw-link connections');

        // First, remove any existing direct links between these nodes
        // (from previous channel maps or stale connections)
        this.pipeWire.pwUnlinkAllBetween(sourcePwNode, sinkPwNode);

        // Discover actual port names from PipeWire
        const srcPorts = this.pipeWire.listPorts(sourcePwNode, 'output');
        const sinkPorts = this.pipeWire.listPorts(sinkPwNode, 'input');

        log.info({ srcPorts, sinkPorts }, 'Discovered PipeWire ports');

        const linkIds: number[] = [];

        for (const entry of conn.channelMap!) {
            if (entry.gain !== undefined && entry.gain !== 1.0) {
                log.warn({ srcCh: entry.srcChannel, dstCh: entry.dstChannel, gain: entry.gain },
                    'Per-channel gain is not supported with pw-link — gain ignored');
            }
            const srcPort = srcPorts[entry.srcChannel];
            const sinkPort = sinkPorts[entry.dstChannel];

            if (!srcPort) {
                log.warn({ srcCh: entry.srcChannel, available: srcPorts.length }, 'Source channel out of range');
                continue;
            }
            if (!sinkPort) {
                log.warn({ dstCh: entry.dstChannel, available: sinkPorts.length }, 'Sink channel out of range');
                continue;
            }

            try {
                const linkId = this.pipeWire.pwLink(srcPort, sinkPort);
                linkIds.push(linkId);
                log.info({ src: srcPort, dst: sinkPort, linkId }, 'Created pw-link');
            } catch (err) {
                log.error({ err, src: srcPort, dst: sinkPort }, 'Failed to create pw-link');
            }
        }

        return {
            connectionId: conn.id,
            type: 'pw-link',
            pwLinkIds: linkIds,
        };
    }

    /**
     * Get the UDP multicast address and port info for an MPEG-TS connection.
     * Used by plugins to build their GStreamer pipelines.
     */
    /**
     * Get the UDP endpoint a decoder module should receive from.
     * Looks up the encoder's port via the connection graph.
     */
    getModuleUdpSource(moduleId: string): { host: string; port: number; connectionId: string; codec?: string } | undefined {
        for (const [connId, conn] of this.connections) {
            if (conn.sinkModuleId === moduleId && conn.streamType === 'muxed/mpegts') {
                const port = this.udpPorts.get(conn.sourceModuleId);
                if (port !== undefined) {
                    const srcModule = this.moduleGetter?.(conn.sourceModuleId);
                    const codec = srcModule?.config?.codec as string | undefined;
                    return { host: MULTICAST_ADDR, port, connectionId: connId, codec };
                }
            }
        }
        return undefined;
    }

    private async executeUdpConnection(conn: Connection): Promise<ActiveHandle | null> {
        if (!this.moduleGetter) return null;

        const sinkModule = this.moduleGetter(conn.sinkModuleId);
        if (!sinkModule) {
            log.warn({ connectionId: conn.id }, 'Decoder module not found');
            return null;
        }

        // Encoder already has its port assigned at startup — just look it up
        const udpPort = this.udpPorts.get(conn.sourceModuleId);
        if (udpPort === undefined) {
            log.warn({ sourceModuleId: conn.sourceModuleId }, 'Encoder has no assigned port — is it running?');
            return null;
        }

        log.info({ source: conn.sourceModuleId, sink: conn.sinkModuleId, host: MULTICAST_ADDR, udpPort }, 'UDP MPEG-TS connection');

        // Start/restart the decoder so it subscribes to the encoder's multicast
        if (sinkModule.running) {
            try {
                await sinkModule.stop();
                await sinkModule.start();
                log.info({ udpPort }, 'Restarted decoder with udpsrc');
            } catch (err) {
                log.error({ err }, 'Failed to restart decoder');
            }
        } else {
            // Decoder was idle (no pipeline) — start it now
            try {
                await sinkModule.start();
                log.info({ udpPort }, 'Started decoder with udpsrc');
            } catch (err) {
                log.error({ err }, 'Failed to start decoder');
            }
        }

        return {
            connectionId: conn.id,
            type: 'udp',
            udpPort,
        };
    }

    private async teardownConnection(handle: ActiveHandle, conn: Connection | undefined, skipModuleRestart = false): Promise<void> {
        if (handle.type === 'loopback' && handle.paModuleId !== undefined && this.pipeWire) {
            log.info({ paModuleId: handle.paModuleId }, 'Removing loopback');
            await this.pipeWire.unloadModule(handle.paModuleId);
        } else if (handle.type === 'pw-link' && handle.pwLinkIds?.length && this.pipeWire) {
            log.info({ connectionId: handle.connectionId, links: handle.pwLinkIds.length }, 'Removing pw-link connections');
            for (const linkId of handle.pwLinkIds) {
                this.pipeWire.pwUnlink(linkId);
            }
        } else if (handle.type === 'udp') {
            log.info({ connectionId: handle.connectionId, udpPort: handle.udpPort }, 'Removing UDP connection');

            if (skipModuleRestart) return;

            // Encoder keeps running — it always outputs to its assigned port.
            // Stop the decoder (connection already deleted so buildPipeline returns null → idle).
            if (conn && this.moduleGetter) {
                const sink = this.moduleGetter(conn.sinkModuleId);
                if (sink?.running) {
                    try { await sink.stop(); await sink.start(); } catch {}
                }
            }
        }
    }

}
