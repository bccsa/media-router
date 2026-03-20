import type { ChannelMapEntry } from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';
import type { PipeWireManager } from '../audio/PipeWireManager.js';
import type { ModuleInstance } from '../modules/ModuleInstance.js';
import type { Connection, ActiveHandle } from './MediaRouter.js';

const log = createLogger('ConnectionExecutor');

/**
 * Executes and tears down media connections between modules.
 *
 * Handles three connection types:
 * - audio/pcm via PipeWire loopback (default)
 * - audio/pcm via pw-link (when channelMap is specified)
 * - muxed/mpegts via UDP multicast
 */
export class ConnectionExecutor {
    constructor(
        private pipeWire: PipeWireManager,
        private moduleGetter: (id: string) => ModuleInstance | undefined,
        private getUdpPort: (moduleId: string) => number | undefined,
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

    async teardown(handle: ActiveHandle, conn: Connection | undefined, skipModuleRestart = false): Promise<void> {
        if (handle.type === 'loopback' && handle.paModuleId !== undefined) {
            log.info({ paModuleId: handle.paModuleId }, 'Removing loopback');
            await this.pipeWire.unloadModule(handle.paModuleId);
        } else if (handle.type === 'pw-link' && handle.pwLinkIds?.length) {
            log.info({ connectionId: handle.connectionId, links: handle.pwLinkIds.length }, 'Removing pw-link connections');
            for (const linkId of handle.pwLinkIds) {
                this.pipeWire.pwUnlink(linkId);
            }
        } else if (handle.type === 'udp') {
            log.info({ connectionId: handle.connectionId, udpPort: handle.udpPort }, 'Removing UDP connection');

            if (skipModuleRestart) return;

            // Stop the decoder (connection already deleted so buildPipeline returns null → idle).
            if (conn) {
                const sink = this.moduleGetter(conn.sinkModuleId);
                if (sink?.running) {
                    try { await sink.stop(); await sink.start(); } catch { /* best effort */ }
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
            return this.executePwLink(conn, sourceNodes.source, sinkNodes.sink);
        }

        // Default: use module-loopback
        log.info({ source: sourceNodes.source, sink: sinkNodes.sink }, `Creating audio loopback ${this.connLabel(conn)}`);

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

    private async executePwLink(
        conn: Connection,
        sourcePwNode: string,
        sinkPwNode: string,
    ): Promise<ActiveHandle | null> {
        log.info({
            connectionId: conn.id,
            source: sourcePwNode,
            sink: sinkPwNode,
            mappings: conn.channelMap!.length,
        }, `Creating per-channel pw-link connections ${this.connLabel(conn)}`);

        // Remove any existing direct links between these nodes
        this.pipeWire.pwUnlinkAllBetween(sourcePwNode, sinkPwNode);

        // Discover actual port names from PipeWire
        const srcPorts = this.pipeWire.listPorts(sourcePwNode, 'output');
        const sinkPorts = this.pipeWire.listPorts(sinkPwNode, 'input');

        log.info({ srcPorts, sinkPorts }, `Discovered PipeWire ports ${this.connLabel(conn)}`);

        const linkIds: number[] = [];

        for (const entry of conn.channelMap!) {
            if (entry.gain !== undefined && entry.gain !== 1.0) {
                log.warn({ srcCh: entry.srcChannel, dstCh: entry.dstChannel, gain: entry.gain },
                    'Per-channel gain not supported with pw-link — gain ignored');
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
                log.info({ src: srcPort, dst: sinkPort, linkId }, `Created pw-link ${this.connLabel(conn)}`);
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

    // --- UDP/MPEG-TS connections ---

    private async executeUdp(conn: Connection): Promise<ActiveHandle | null> {
        const sinkModule = this.moduleGetter(conn.sinkModuleId);
        if (!sinkModule) {
            log.warn({ connectionId: conn.id }, 'Decoder module not found');
            return null;
        }

        const udpPort = this.getUdpPort(conn.sourceModuleId);
        if (udpPort === undefined) {
            log.warn({ sourceModuleId: conn.sourceModuleId }, 'Encoder has no assigned port — is it running?');
            return null;
        }

        log.info({ host: this.multicastAddr, udpPort }, `UDP MPEG-TS connection ${this.connLabel(conn)}`);

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
