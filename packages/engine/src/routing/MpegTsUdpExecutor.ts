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
