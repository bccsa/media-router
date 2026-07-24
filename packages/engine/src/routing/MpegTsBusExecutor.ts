import { createLogger } from '@media-router/shared-types';
import type { ModuleInstance } from '../modules/ModuleInstance.js';
import type { Connection, ActiveHandle } from './MediaRouter.js';
import type { StreamTypeExecutor } from './StreamTypeExecutor.js';
import type { BusFanoutCoordinator } from './BusFanoutCoordinator.js';
import { PendingInputSwaps, performLiveSwap } from './LiveInputSwap.js';

const log = createLogger('MpegTsBusExecutor');

/**
 * Built-in executor for `muxed/mpegts` connections over the bus.
 *
 * The producer (any module that emits an MPEG-TS stream — muxer, encoder,
 * srt-input re-broadcast, etc.) has been assigned a bus channel via
 * `MediaRouter.assignBusChannel` before its pipeline started; this executor
 * looks that channel up and restarts the consumer module so its
 * `buildPipeline` picks up the live bus ingress (via
 * `services.mediaRouter.getModuleBusSource`).
 *
 * Teardown stops then restarts the consumer so its `buildPipeline` returns
 * `null` (now that the connection is gone) and the module sits idle.
 */
export class MpegTsBusExecutor implements StreamTypeExecutor {
    readonly streamType = 'muxed/mpegts';
    readonly handleType = 'bus' as const;

    constructor(
        private moduleGetter: (id: string) => ModuleInstance | undefined,
        private getUdpPort: (moduleId: string, portId?: string) => number | undefined,
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
         * `unixfdsrc` connects); detach on teardown.
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
                `MPEG-TS producer ${conn.sourceModuleId}:${conn.sourcePortId} has not assigned a bus channel yet`,
            );
        }

        log.info({ channel: udpPort }, `Bus MPEG-TS connection ${this.connLabel(conn)}`);

        // Attach this consumer's dedicated fan-out branch on the producer FIRST,
        // so its edge socket exists by the time the consumer's `unixfdsrc`
        // connects (the consumer's busSocketGate waits for it). Idempotent.
        this.busFanout?.attach(conn);

        // Live input swap: a remove on this sink:port opened a pending window
        // (see teardown) — the sink is still running against the OLD edge.
        // Re-point its input at the new edge instead of restarting it, so its
        // own producer sockets stay up and the downstream graph never notices.
        const pending = this.pendingSwaps.claim(conn);
        if (pending) {
            const swapped = await performLiveSwap({
                sink: sinkModule,
                conn,
                oldConn: pending.conn,
                udpPort,
                busFanout: this.busFanout,
            });
            if (swapped) {
                return { connectionId: conn.id, type: 'bus', busChannel: udpPort };
            }
            // Fall through: performLiveSwap already detached the old edge —
            // the classic restart below rebuilds against the new connection.
        }

        // Start/restart the consumer so it connects to the producer's edge socket
        try {
            if (sinkModule.running) {
                await sinkModule.stop();
            }
            await sinkModule.start();
            log.info({ channel: udpPort }, `Restarted consumer ${this.connLabel(conn)}`);
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
            type: 'bus',
            busChannel: udpPort,
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
     * survive the bounce: `BusChannelManager.acquire` is sticky per owner key,
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

    /**
     * Deferred-teardown windows for swap-capable single-input sinks (see
     * LiveInputSwap). While a window is open the OLD producer edge stays
     * attached (make-before-break) and the sink keeps running.
     */
    private pendingSwaps = new PendingInputSwaps();

    async teardown(
        handle: ActiveHandle,
        conn: Connection | undefined,
        skipModuleRestart: boolean,
    ): Promise<void> {
        log.info(
            { connectionId: handle.connectionId, channel: handle.busChannel },
            'Removing bus connection',
        );
        this.materializeAttempted.delete(handle.connectionId);

        // Live-swap-capable sink: defer the ENTIRE physical teardown (edge
        // detach + sink restart) — a matching add within the window re-points
        // the input live; expiry runs the classic path below. The sink keeps
        // streaming the old source meanwhile, surfaced as a health warning.
        if (conn && !skipModuleRestart) {
            const sink = this.moduleGetter(conn.sinkModuleId);
            if (
                sink?.running &&
                sink.getLiveInputSwap?.(conn.sinkPortId) &&
                sink.getChildProcess?.()
            ) {
                sink.setHealth?.(
                    'warning',
                    'Input disconnect pending — still streaming previous source',
                );
                this.pendingSwaps.defer({ conn }, async (entry) => {
                    this.busFanout?.detach(entry.conn);
                    await this.restartSinkIdle(entry.conn);
                });
                return;
            }
        }

        // Tear down the producer's fan-out branch for this edge.
        if (conn) this.busFanout?.detach(conn);

        if (skipModuleRestart) return;

        if (conn) await this.restartSinkIdle(conn);
    }

    /** Classic disconnect: stop then restart the sink so its buildPipeline
     *  returns null (connection already deleted) and it sits idle. */
    private async restartSinkIdle(conn: Connection): Promise<void> {
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
