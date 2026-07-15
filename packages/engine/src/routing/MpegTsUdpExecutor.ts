import { createLogger } from '@media-router/shared-types';
import type { ModuleInstance } from '../modules/ModuleInstance.js';
import type { Connection, ActiveHandle } from './MediaRouter.js';
import type { StreamTypeExecutor } from './StreamTypeExecutor.js';
import type { BusFanoutCoordinator } from './BusFanoutCoordinator.js';

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
        /**
         * Per-consumer unixfd bus fan-out. Attach the producer's edge branch
         * before starting the consumer (so its socket exists when the consumer's
         * `unixfdsrc` connects); detach on teardown. No-op under UDP.
         */
        private busFanout?: BusFanoutCoordinator,
    ) {}

    async execute(conn: Connection): Promise<ActiveHandle | null> {
        const sinkModule = this.moduleGetter(conn.sinkModuleId);
        if (!sinkModule) {
            log.warn({ connectionId: conn.id }, 'Consumer module not found');
            return null;
        }

        let udpPort = this.getUdpPort(conn.sourceModuleId, conn.sourcePortId);
        if (udpPort === undefined) {
            udpPort = await this.materializeProducerPort(conn);
        }
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

        // Attach this consumer's dedicated fan-out branch on the producer FIRST,
        // so its edge socket exists by the time the consumer's `unixfdsrc`
        // connects (the consumer's busSocketGate waits for it). Idempotent, and
        // a no-op under UDP multicast.
        this.busFanout?.attach(conn);

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

    /**
     * Connections whose producer we already restarted once to materialize a
     * late-discovered port. ConnectionApplier re-executes on every retry and
     * re-apply cycle — without this guard a producer whose rebuild cannot
     * produce the port would be bounced on each attempt, interrupting its
     * healthy consumers. Cleared on teardown so a deliberate re-wire of the
     * same edge gets a fresh attempt.
     */
    private materializeAttempted = new Set<string>();

    /**
     * A running producer can declare an output port that has no branch in its
     * live pipeline: the mpegts-demuxer discovers streams mid-run and adds
     * their ports live (deliberately without a reload), so a port wired
     * *after* discovery has no UDP allocation until the producer's next
     * `buildPipeline`. Restart the producer once so the rebuild materializes
     * the port's branch, then re-read the allocation.
     *
     * Guards, in order: at most one attempt per connection; the producer must
     * be running WITH a live pipeline (a running-but-idle producer — e.g. a
     * demuxer whose upstream is disconnected, so `buildPipeline` returned
     * null — would rebuild to null again); and the port must actually be
     * declared by the producer. A producer that simply hasn't finished
     * starting keeps the caller's retry contract (throw → ConnectionApplier
     * backoff) untouched. Existing consumers of the producer's other ports
     * survive the bounce: `UdpPortManager.acquire` is sticky per owner key,
     * so the rebuild re-lands on the same ports and their multicast
     * subscriptions stay valid.
     */
    private async materializeProducerPort(conn: Connection): Promise<number | undefined> {
        if (this.materializeAttempted.has(conn.id)) return undefined;
        const producer = this.moduleGetter(conn.sourceModuleId);
        if (!producer?.running) return undefined;
        if (!producer.getChildProcess?.()) return undefined;
        const declared = producer
            .getDynamicPorts?.()
            ?.some((p) => p.id === conn.sourcePortId && p.direction === 'output');
        if (!declared) return undefined;
        this.materializeAttempted.add(conn.id);
        log.info(
            { moduleId: conn.sourceModuleId, portId: conn.sourcePortId },
            `Producer port has no live branch — restarting producer for ${this.connLabel(conn)}`,
        );
        try {
            await producer.stop();
            await producer.start();
        } catch (err) {
            log.error({ err, moduleId: conn.sourceModuleId }, 'Producer restart failed');
            return undefined;
        }
        return this.getUdpPort(conn.sourceModuleId, conn.sourcePortId);
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
        this.materializeAttempted.delete(handle.connectionId);

        // Tear down the producer's fan-out branch for this edge (no-op on UDP).
        if (conn) this.busFanout?.detach(conn);

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
