import { createLogger } from '@media-router/shared-types';
import type { PipeWireManager } from '../audio/PipeWireManager.js';
import type { ModuleInstance } from '../modules/ModuleInstance.js';
import type { Connection, ActiveHandle } from './MediaRouter.js';
import type { StreamTypeExecutor } from './StreamTypeExecutor.js';

const log = createLogger('PcmAudioExecutor');

/**
 * Built-in executor for `audio/pcm` connections.
 *
 * Resolves source/sink PipeWire nodes (port-specific lookup first for
 * multi-port modules, falling back to the module-level node names), polls
 * for ports to appear (PipeWire registration is async, especially on loaded
 * RPi 5), applies the channel map (or a sensible identity / mono-fan-out
 * default), and creates one pw-link per mapping entry. Teardown removes the
 * specific links by name, then by id as a backup, then sweeps any stragglers
 * between the two nodes.
 */
export class PcmAudioExecutor implements StreamTypeExecutor {
    readonly streamType = 'audio/pcm';
    readonly handleType = 'pw-link' as const;

    constructor(
        private pipeWire: PipeWireManager,
        private moduleGetter: (id: string) => ModuleInstance | undefined,
        private connLabel: (conn: Connection) => string,
    ) {}

    async execute(conn: Connection): Promise<ActiveHandle | null> {
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

    async teardown(handle: ActiveHandle): Promise<void> {
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
        // 3. Final sweep: remove ALL links between the two nodes (catches stragglers)
        if (handle.pwLinkPairs?.length) {
            const srcNode = handle.pwLinkPairs[0].src.split(':')[0];
            const dstNode = handle.pwLinkPairs[0].dst.split(':')[0];
            if (srcNode && dstNode) {
                await this.pipeWire.pwUnlinkAllBetween(srcNode, dstNode);
            }
        }
    }

    /**
     * Poll for PipeWire ports to appear on a node. Registration is async —
     * ports may not be visible immediately after module start, especially on
     * loaded hardware (RPi 5).
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

        // Throw (not return null) when ports never appear so the caller's retry
        // path (ConnectionApplier.connectWithRetry) re-attempts with backoff.
        // PipeWire port registration is async; on the consumer-restart cascade
        // the just-recreated null-sink can miss this poll window, and that path
        // has no PW_SETTLE_MS wait (ModuleLifecycle wires it directly). A silent
        // null instead makes createConnection drop the connection record and the
        // caller log a false "Connected" — the edge is then gone with no retry
        // until a manual restart. Same asymmetry MpegTsUdpExecutor already
        // avoids by throwing on a not-yet-assigned UDP port.
        if (srcPorts.length === 0) {
            throw new Error(
                `No output ports on ${sourcePwNode} after polling — cannot create ${this.connLabel(conn)}`,
            );
        }
        if (sinkPorts.length === 0) {
            throw new Error(
                `No input ports on ${sinkPwNode} after polling — cannot create ${this.connLabel(conn)}`,
            );
        }

        log.info({ srcPorts, sinkPorts }, `Discovered PipeWire ports ${this.connLabel(conn)}`);

        // Generate default mapping: 1:1 where both exist, mono fans out to all dst channels
        const defaultMap = (): Array<{ srcChannel: number; dstChannel: number }> => {
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
}
