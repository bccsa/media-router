import { createLogger } from '@media-router/shared-types';
import type { ModuleInstance } from '../modules/ModuleInstance.js';
import type { Connection, ActiveHandle } from './MediaRouter.js';
import type { StreamTypeExecutor } from './StreamTypeExecutor.js';

const log = createLogger('MpegTsUdpExecutor');

/**
 * Built-in executor for `muxed/mpegts` connections over UDP multicast.
 *
 * The producer (any module that emits an MPEG-TS stream — muxer, encoder,
 * srt-input re-broadcast, etc.) has been assigned a UDP port via
 * `MediaRouter.assignUdpPort` before its pipeline started; this executor
 * looks that port up and restarts the consumer module so its `buildPipeline`
 * picks up the live `udpsrc` (via `services.mediaRouter.getModuleUdpSource`).
 *
 * Teardown stops then restarts the consumer so its `buildPipeline` returns
 * `null` (now that the connection is gone) and the module sits idle, freeing
 * its multicast subscription.
 */
export class MpegTsUdpExecutor implements StreamTypeExecutor {
    readonly streamType = 'muxed/mpegts';
    readonly handleType = 'udp' as const;

    constructor(
        private moduleGetter: (id: string) => ModuleInstance | undefined,
        private getUdpPort: (moduleId: string, portId?: string) => number | undefined,
        private multicastAddr: string,
        private connLabel: (conn: Connection) => string,
        /**
         * Invoked after the consumer module has been restarted in `execute`.
         * Wired by `MediaRouter.setConsumerRestartCallback` to
         * `ConnectionApplier.reapplyModuleConnections`, so the consumer's
         * *outgoing* connections (which may have been removed earlier when
         * the consumer hadn't allocated its UDP ports yet) get a fresh
         * attempt now that those ports exist. Without this hook, a chain
         * with a disabled upstream at engine startup left every
         * downstream-of-the-downstream connection permanently dead until
         * the operator manually toggled a module.
         */
        private onConsumerRestarted?: (consumerId: string) => Promise<void>,
    ) {}

    async execute(conn: Connection): Promise<ActiveHandle | null> {
        const sinkModule = this.moduleGetter(conn.sinkModuleId);
        if (!sinkModule) {
            log.warn({ connectionId: conn.id }, 'Consumer module not found');
            return null;
        }

        const udpPort = this.getUdpPort(conn.sourceModuleId, conn.sourcePortId);
        if (udpPort === undefined) {
            // Throw rather than silently returning null so the caller's
            // retry path (ConnectionApplier.connectWithRetry) can re-attempt
            // once the source module finishes starting and registers its
            // port. The previous silent-return path left consumers stuck on a
            // "no source" health warning until manual restart.
            throw new Error(
                `MPEG-TS producer ${conn.sourceModuleId}:${conn.sourcePortId} has not assigned a UDP port yet`,
            );
        }

        log.info(
            { host: this.multicastAddr, udpPort },
            `UDP MPEG-TS connection ${this.connLabel(conn)}`,
        );

        // Start/restart the consumer so it subscribes to the producer's multicast
        try {
            if (sinkModule.running) {
                await sinkModule.stop();
            }
            await sinkModule.start();
            log.info({ udpPort }, `Restarted consumer with udpsrc ${this.connLabel(conn)}`);
        } catch (err) {
            log.error({ err }, 'Failed to start consumer');
        }

        // The consumer's pipeline build runs inside `start()` above and may
        // have allocated UDP output ports of its own (e.g. mpegts-demuxer
        // does this once it has an input source). Give downstream connections
        // that were previously removed for "producer has no UDP port yet" a
        // fresh attempt now that those ports exist.
        if (this.onConsumerRestarted) {
            try {
                await this.onConsumerRestarted(conn.sinkModuleId);
            } catch (err) {
                // Bumped to warn: this hook *is* the cascade-recovery path
                // for downstream connections that were removed earlier by
                // retry exhaustion. A failure here means we may have just
                // silently left part of the graph orphaned (the exact bug
                // the hook exists to fix), so make sure it shows up in
                // normal log scans.
                log.warn(
                    { err, moduleId: conn.sinkModuleId },
                    'onConsumerRestarted cascade failed — downstream of this module may stay disconnected',
                );
            }
        }

        return {
            connectionId: conn.id,
            type: 'udp',
            udpPort,
        };
    }

    async teardown(
        handle: ActiveHandle,
        conn: Connection | undefined,
        skipModuleRestart: boolean,
    ): Promise<void> {
        log.info(
            { connectionId: handle.connectionId, udpPort: handle.udpPort },
            'Removing UDP connection',
        );

        if (skipModuleRestart) return;

        // Stop then restart the sink so its buildPipeline returns null
        // (connection already deleted) and it sits idle.
        if (conn) {
            const sink = this.moduleGetter(conn.sinkModuleId);
            if (sink?.running) {
                try {
                    await sink.stop();
                    await sink.start();
                } catch (err) {
                    log.debug(
                        { err, moduleId: conn.sinkModuleId },
                        'Consumer restart after disconnect failed',
                    );
                }
            }
        }
    }
}
