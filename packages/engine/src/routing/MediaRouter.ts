import type { ModulePort, StreamType, ChannelMapEntry } from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';
import type { PipeWireManager } from '../audio/PipeWireManager.js';
import type { ModuleInstance } from '../modules/ModuleInstance.js';
import { UdpPortManager } from './UdpPortManager.js';
import { PortRegistry } from './PortRegistry.js';
import { ConnectionExecutor } from './ConnectionExecutor.js';

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
    type: 'loopback' | 'udp' | 'pw-link';
    paModuleId?: number;
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

    // --- Setup ---

    setDependencies(
        pipeWire: PipeWireManager,
        moduleGetter: (id: string) => ModuleInstance | undefined,
        displayNameResolver?: (id: string) => string,
    ): void {
        this.moduleGetter = moduleGetter;
        this.executor = new ConnectionExecutor(
            pipeWire,
            moduleGetter,
            (moduleId) => this.udpPorts.get(moduleId),
            MULTICAST_ADDR,
            displayNameResolver,
        );
    }

    // --- Port delegation ---

    registerPorts(moduleId: string, ports: ModulePort[]): void {
        this.portRegistry.register(moduleId, ports);
    }

    async unregisterPorts(moduleId: string): Promise<void> {
        this.portRegistry.unregister(moduleId);
        for (const [id, conn] of this.connections) {
            if (conn.sourceModuleId === moduleId || conn.sinkModuleId === moduleId) {
                await this.removeConnection(id);
            }
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

        if (!sourcePort) throw new Error(`Source port not found: ${sourceModuleId}:${sourcePortId}`);
        if (!sinkPort) throw new Error(`Sink port not found: ${sinkModuleId}:${sinkPortId}`);

        if (sourcePort.direction !== 'output') throw new Error(`Source port ${sourcePortId} is not an output`);
        if (sinkPort.direction !== 'input') throw new Error(`Sink port ${sinkPortId} is not an input`);

        const compat = this.portRegistry.validateCompatibility(sourcePort, sinkPort);
        if (!compat.compatible) throw new Error(`Incompatible ports: ${compat.reason}`);

        // Validate maxConnections
        const sourceMax = sourcePort.maxConnections ?? -1;
        const sinkMax = sinkPort.maxConnections ?? -1;
        if (sourceMax === 0) throw new Error(`Port ${sourcePortId} does not allow connections`);
        if (sinkMax === 0) throw new Error(`Port ${sinkPortId} does not allow connections`);

        if (sourceMax > 0) {
            const count = this.portRegistry.getConnectionCount(sourceModuleId, sourcePortId, this.connections.values());
            if (count >= sourceMax) throw new Error(`Port ${sourcePortId} already has ${count}/${sourceMax} connections`);
        }
        if (sinkMax > 0) {
            const count = this.portRegistry.getConnectionCount(sinkModuleId, sinkPortId, this.connections.values());
            if (count >= sinkMax) throw new Error(`Port ${sinkPortId} already has ${count}/${sinkMax} connections`);
        }

        const connId = `${sourceModuleId}:${sourcePortId}-${sinkModuleId}:${sinkPortId}`;
        const conn: Connection = {
            id: connId,
            sourceModuleId, sourcePortId,
            sinkModuleId, sinkPortId,
            streamType: sourcePort.streamType,
            channelMap: channelMap?.length ? channelMap : undefined,
        };
        this.connections.set(connId, conn);

        try {
            const handle = await this.executor?.execute(conn);
            if (handle) this.handles.set(connId, handle);
        } catch (err) {
            log.error({ err, connectionId: connId }, 'Failed to execute connection');
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
            log.error({ err, connectionId: connId }, 'Failed to re-execute connection with new channel map');
        }
    }

    async removeAllConnections(skipModuleRestart = false): Promise<void> {
        for (const connId of Array.from(this.connections.keys())) {
            await this.removeConnection(connId, skipModuleRestart);
        }
    }

    // --- Encoder UDP port management ---

    assignEncoderPort(moduleId: string): { host: string; port: number } | null {
        const port = this.udpPorts.acquire(moduleId);
        return port !== null ? { host: MULTICAST_ADDR, port } : null;
    }

    getEncoderEndpoint(moduleId: string): { host: string; port: number } | undefined {
        const port = this.udpPorts.get(moduleId);
        return port !== undefined ? { host: MULTICAST_ADDR, port } : undefined;
    }

    releaseEncoderPort(moduleId: string): void {
        this.udpPorts.release(moduleId);
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
}
