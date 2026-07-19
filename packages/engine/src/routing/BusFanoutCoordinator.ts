import { createLogger } from '@media-router/shared-types';
import type { ModuleInstance } from '../modules/ModuleInstance.js';
import type { Connection } from './MediaRouter.js';
import { busTeeName, busEdgeSocketPath } from '../plugins/busHelpers.js';

const log = createLogger('BusFanout');

/**
 * Per-consumer fan-out for the unixfd inter-module bus.
 *
 * A producer's bus egress is a single `tee` (built by `buildBusSink`); this
 * coordinator attaches ONE `queue leaky=2 ! unixfdsink` branch per consumer
 * edge on that tee at runtime (`bus_attach`/`bus_detach` runner commands),
 * each on its own edge socket (`busEdgeSocketPath`).
 *
 * Why it exists: `unixfdsink` sends to every client under its object lock with
 * blocking sockets, so a single shared sink froze the producer and every
 * sibling consumer whenever one consumer stopped draining (restart, crash-loop,
 * preroll). A per-consumer branch with a leaky queue confines a stall to that
 * one branch. Operators restart modules at will, so this must hold without
 * touching the producer or sibling consumers.
 */
export class BusFanoutCoordinator {
    constructor(
        private readonly moduleGetter: (id: string) => ModuleInstance | undefined,
        /** Resolve a producer output port's allocated channel port (the tee id /
         *  edge-socket base). Mirrors `MediaRouter.getModuleBusSource`'s lookup. */
        private readonly resolveProducerPort: (
            moduleId: string,
            portId?: string,
        ) => number | undefined,
        private readonly getConnections: () => Connection[],
    ) {}

    /** Attach this connection's fan-out branch on the producer (idempotent).
     *  The edge socket is derived from (channel port, connection id) — the same
     *  formula `MediaRouter.getModuleBusSource` hands the consumer, so both ends
     *  address the identical socket. */
    attach(conn: Connection): void {
        const port = this.resolveProducerPort(conn.sourceModuleId, conn.sourcePortId);
        if (port === undefined) return;
        // The attach target is the gst runner for pipeline producers, or a
        // non-gst producer's own fan-out controller (hls-player's
        // UnixFdFanoutController driving its unixfd-fanout.py sidecar).
        const target = this.moduleGetter(conn.sourceModuleId)?.getBusAttachTarget?.();
        if (!target) return;
        target.sendBusAttach(busTeeName(port), busEdgeSocketPath(port, conn.id));
        log.debug(
            { conn: conn.id, port },
            'Attached bus fan-out branch',
        );
    }

    /** Detach this connection's fan-out branch on the producer. */
    detach(conn: Connection): void {
        const port = this.resolveProducerPort(conn.sourceModuleId, conn.sourcePortId);
        if (port === undefined) return;
        const target = this.moduleGetter(conn.sourceModuleId)?.getBusAttachTarget?.();
        if (!target) return;
        target.sendBusDetach(busEdgeSocketPath(port, conn.id));
        log.debug({ conn: conn.id, port }, 'Detached bus fan-out branch');
    }

    /**
     * Re-attach every fan-out branch for a producer that just reached PLAYING.
     * Load-bearing: a runner-internal `restartOnError` respawn (and an explicit
     * restart) rebuilds the pipeline from the base string with the tee but no
     * branches, so without this a producer restart would strand all its
     * consumers. Idempotent per socket, so a redundant call is harmless.
     */
    reattachProducer(moduleId: string): void {
        for (const conn of this.getConnections()) {
            if (conn.sourceModuleId === moduleId && conn.streamType === 'muxed/mpegts') {
                this.attach(conn);
            }
        }
    }
}
