import { createLogger } from '@media-router/shared-types';
import type { PipeWireManager } from '../audio/PipeWireManager.js';
import type { ModuleInstance } from '../modules/ModuleInstance.js';
import type { Connection, ActiveHandle } from './MediaRouter.js';

const log = createLogger('ConnectionExecutor');

/**
 * Executes and tears down media connections between modules.
 *
 * Connection types:
 * - audio/pcm via pw-link (identity mapping or explicit channelMap)
 * - muxed/mpegts via UDP multicast
 */
export class ConnectionExecutor {
    constructor(
        private pipeWire: PipeWireManager,
        private moduleGetter: (id: string) => ModuleInstance | undefined,
        private getUdpPort: (moduleId: string, portId?: string) => number | undefined,
        private multicastAddr: string,
        /** Optional: resolve moduleId → display name for logging. */
        private displayNameResolver?: (id: string) => string,
    ) {}

    /** Short label for logging: "[Mic 1 → Encoder 1]" or "[audio-input-xxx → audio-encoder-yyy]". */
    private connLabel(conn: Connection): string {
        const src = this.displayNameResolver?.(conn.sourceModuleId) ?? conn.sourceModuleId;
        const dst = this.displayNameResolver?.(conn.sinkModuleId) ?? conn.sinkModuleId;
        return `[${src} → ${dst}]`;
    }

    async execute(conn: Connection): Promise<ActiveHandle | null> {
        if (conn.streamType === 'audio/pcm') {
            return this.executeAudio(conn);
        } else if (conn.streamType === 'muxed/mpegts') {
            return this.executeUdp(conn);
        }
        log.warn({ streamType: conn.streamType }, 'Unknown stream type');
        return null;
    }

    async teardown(
        handle: ActiveHandle,
        conn: Connection | undefined,
        skipModuleRestart = false,
    ): Promise<void> {
        if (handle.type === 'loopback' && handle.paModuleId !== undefined) {
            log.info({ paModuleId: handle.paModuleId }, 'Removing loopback');
            await this.pipeWire.unloadModule(handle.paModuleId);
        } else if (handle.type === 'pw-link') {
            log.info(
                { connectionId: handle.connectionId, links: handle.pwLinkPairs?.length ?? 0 },
                'Removing pw-link connections',
            );
            // 1. Remove by exact port name pairs
            if (handle.pwLinkPairs?.length) {
                for (const pair of handle.pwLinkPairs) {
                    await this.pipeWire.pwUnlinkByName(pair.src, pair.dst);
                }
            }
            // 2. Remove by link ID (catches any missed by name)
            if (handle.pwLinkIds?.length) {
                for (const linkId of handle.pwLinkIds) {
                    if (linkId > 0) await this.pipeWire.pwUnlink(linkId);
                }
            }
            // 3. Final sweep: remove ALL links between the two nodes (catches any stragglers)
            if (handle.pwLinkPairs?.length) {
                const srcNode = handle.pwLinkPairs[0].src.split(':')[0];
                const dstNode = handle.pwLinkPairs[0].dst.split(':')[0];
                if (srcNode && dstNode) {
                    await this.pipeWire.pwUnlinkAllBetween(srcNode, dstNode);
                }
            }
        } else if (handle.type === 'udp') {
            log.info(
                { connectionId: handle.connectionId, udpPort: handle.udpPort },
                'Removing UDP connection',
            );

            if (skipModuleRestart) return;

            // Stop the decoder (connection already deleted so buildPipeline returns null → idle).
            if (conn) {
                const sink = this.moduleGetter(conn.sinkModuleId);
                if (sink?.running) {
                    try {
                        await sink.stop();
                        await sink.start();
                    } catch (err) {
                        log.debug(
                            { err, moduleId: conn.sinkModuleId },
                            'Decoder restart after disconnect failed',
                        );
                    }
                }
            }
        }
    }

    // --- Audio connections ---

    private async executeAudio(conn: Connection): Promise<ActiveHandle | null> {
        const sourceModule = this.moduleGetter(conn.sourceModuleId);
        const sinkModule = this.moduleGetter(conn.sinkModuleId);

        if (!sourceModule || !sinkModule) {
            log.warn({ connectionId: conn.id }, 'Module not found for audio connection');
            return null;
        }

        // Try port-specific lookup first (multi-port modules), fall back to module-level
        const sourceNodes =
            sourceModule.getPipeWireNodeForPort(conn.sourcePortId) ??
            sourceModule.getPipeWireNodes();
        const sinkNodes =
            sinkModule.getPipeWireNodeForPort(conn.sinkPortId) ?? sinkModule.getPipeWireNodes();

        if (!sourceNodes?.source) {
            log.warn({ moduleId: conn.sourceModuleId }, 'Source module has no PipeWire source');
            return null;
        }
        if (!sinkNodes?.sink) {
            log.warn({ moduleId: conn.sinkModuleId }, 'Sink module has no PipeWire sink');
            return null;
        }

        return this.executePwLink(conn, sourceNodes.source, sinkNodes.sink);
    }

    /**
     * Poll for PipeWire ports to appear on a node.
     * PipeWire node registration is async — ports may not be visible immediately
     * after module start, especially on loaded hardware (RPi 5).
     */
    private async waitForPorts(
        node: string,
        direction: 'input' | 'output',
        timeoutMs = 3000,
        intervalMs = 100,
    ): Promise<string[]> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const ports = await this.pipeWire.listPorts(node, direction);
            if (ports.length > 0) return ports;
            await new Promise((r) => setTimeout(r, intervalMs));
        }
        return [];
    }

    private async executePwLink(
        conn: Connection,
        sourcePwNode: string,
        sinkPwNode: string,
    ): Promise<ActiveHandle | null> {
        // Remove any existing direct links between these nodes
        await this.pipeWire.pwUnlinkAllBetween(sourcePwNode, sinkPwNode);

        // Wait for ports to appear (polls every 100ms, up to 3s)
        const srcPorts = await this.waitForPorts(sourcePwNode, 'output');
        const sinkPorts = await this.waitForPorts(sinkPwNode, 'input');

        if (srcPorts.length === 0) {
            log.warn(
                { node: sourcePwNode },
                `No output ports found after polling — connection cannot be created ${this.connLabel(conn)}`,
            );
            return null;
        }
        if (sinkPorts.length === 0) {
            log.warn(
                { node: sinkPwNode },
                `No input ports found after polling — connection cannot be created ${this.connLabel(conn)}`,
            );
            return null;
        }

        log.info({ srcPorts, sinkPorts }, `Discovered PipeWire ports ${this.connLabel(conn)}`);

        // Generate default mapping: 1:1 where both exist, mono fans out to all dst channels
        const defaultMap = () => {
            if (srcPorts.length === 1 && sinkPorts.length > 1) {
                // Mono source → duplicate to all destination channels
                return Array.from({ length: sinkPorts.length }, (_, i) => ({
                    srcChannel: 0,
                    dstChannel: i,
                }));
            }
            return Array.from({ length: Math.min(srcPorts.length, sinkPorts.length) }, (_, i) => ({
                srcChannel: i,
                dstChannel: i,
            }));
        };

        let channelMap: Array<{ srcChannel: number; dstChannel: number; gain?: number }>;
        if (conn.channelMap?.length) {
            // Clamp explicit map to actual port counts
            const valid = conn.channelMap.filter(
                (e) => e.srcChannel < srcPorts.length && e.dstChannel < sinkPorts.length,
            );
            const dropped = conn.channelMap.length - valid.length;
            if (dropped > 0) {
                log.warn(
                    {
                        total: conn.channelMap.length,
                        valid: valid.length,
                        dropped,
                        srcChannels: srcPorts.length,
                        sinkChannels: sinkPorts.length,
                    },
                    `Channel map: ${dropped} entries out of range, using ${valid.length > 0 ? 'valid subset' : 'identity fallback'} ${this.connLabel(conn)}`,
                );
            }
            // Fall back to identity mapping if all explicit entries were invalid
            channelMap = valid.length > 0 ? valid : defaultMap();
        } else {
            channelMap = defaultMap();
            if (
                srcPorts.length !== sinkPorts.length &&
                !(srcPorts.length === 1 && sinkPorts.length > 1)
            ) {
                log.warn(
                    {
                        source: sourcePwNode,
                        sink: sinkPwNode,
                        srcChannels: srcPorts.length,
                        sinkChannels: sinkPorts.length,
                        linked: channelMap.length,
                    },
                    `Channel count mismatch — linking ${channelMap.length} of ${Math.max(srcPorts.length, sinkPorts.length)} channels ${this.connLabel(conn)}`,
                );
            }
        }

        log.info(
            {
                connectionId: conn.id,
                source: sourcePwNode,
                sink: sinkPwNode,
                mappings: channelMap.length,
                explicit: !!conn.channelMap?.length,
            },
            `Creating pw-link connections ${this.connLabel(conn)}`,
        );

        const linkIds: number[] = [];
        const linkPairs: Array<{ src: string; dst: string }> = [];

        for (const entry of channelMap) {
            if ('gain' in entry && entry.gain !== undefined && entry.gain !== 1.0) {
                log.warn(
                    { srcCh: entry.srcChannel, dstCh: entry.dstChannel, gain: entry.gain },
                    'Per-channel gain not supported with pw-link — gain ignored',
                );
            }
            const srcPort = srcPorts[entry.srcChannel];
            const sinkPort = sinkPorts[entry.dstChannel];

            try {
                const linkId = await this.pipeWire.pwLink(srcPort, sinkPort);
                linkIds.push(linkId);
                linkPairs.push({ src: srcPort, dst: sinkPort });
                log.info(
                    { src: srcPort, dst: sinkPort, linkId },
                    `Created pw-link ${this.connLabel(conn)}`,
                );
            } catch (err) {
                log.error({ err, src: srcPort, dst: sinkPort }, 'Failed to create pw-link');
            }
        }

        return {
            connectionId: conn.id,
            type: 'pw-link',
            pwLinkIds: linkIds,
            pwLinkPairs: linkPairs,
        };
    }

    // --- UDP/MPEG-TS connections ---

    private async executeUdp(conn: Connection): Promise<ActiveHandle | null> {
        const sinkModule = this.moduleGetter(conn.sinkModuleId);
        if (!sinkModule) {
            log.warn({ connectionId: conn.id }, 'Decoder module not found');
            return null;
        }

        const udpPort = this.getUdpPort(conn.sourceModuleId, conn.sourcePortId);
        if (udpPort === undefined) {
            // Throw rather than silently returning null so the caller's
            // retry path (ConnectionApplier.connectWithRetry) can re-attempt
            // once the source module finishes starting and registers its
            // port. The previous silent-return path left decoders stuck on
            // the "No encoder connected" health warning until manual restart.
            throw new Error(
                `Encoder ${conn.sourceModuleId}:${conn.sourcePortId} has not assigned a UDP port yet`,
            );
        }

        log.info(
            { host: this.multicastAddr, udpPort },
            `UDP MPEG-TS connection ${this.connLabel(conn)}`,
        );

        // Start/restart the decoder so it subscribes to the encoder's multicast
        try {
            if (sinkModule.running) {
                await sinkModule.stop();
            }
            await sinkModule.start();
            log.info({ udpPort }, `Restarted decoder with udpsrc ${this.connLabel(conn)}`);
        } catch (err) {
            log.error({ err }, 'Failed to start decoder');
        }

        return {
            connectionId: conn.id,
            type: 'udp',
            udpPort,
        };
    }
}
