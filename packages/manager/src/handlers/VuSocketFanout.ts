import type { Server as SocketIOServer } from 'socket.io';
import { createLogger } from '@media-router/shared-types';

const log = createLogger('VuSocketFanout');

/**
 * Fans one engine's VU payload out to its `watch:<engineId>` room, latest-wins
 * per browser socket instead of volatile-drop.
 *
 * socket.io's `volatile.emit` discards a packet whenever the socket's transport
 * has a frame in flight (`conn.transport.writable === false`), and
 * `engine:system` is volatile-broadcast to every socket — so ~7% of VU batches
 * never reached the browser even on a LAN, each one a 2 s meter hole (#677;
 * measured: 1115/1200 numbered batches via loopback into the live manager,
 * 600/600 through dgram-comms alone, 1200/1200 after this change).
 *
 * Holding at most one payload per engine per socket and flushing on the
 * transport's `drain` keeps the queue bounded on slow links. The `writable`
 * flag and `drain` event are engine.io internals — the same ones socket.io's
 * own volatile check reads; verified against socket.io 4.8.3 / engine.io 6.6.6.
 */
export class VuSocketFanout {
    /** Per browser socket: newest payload per engine held while its transport is mid-write. */
    private pending = new WeakMap<object, Map<string, unknown>>();
    /** Payloads held (not dropped) since the last once-a-minute trace line. */
    private held = 0;
    private traceTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly io: SocketIOServer) {}

    emit(engineId: string, payload: Record<string, unknown>): void {
        const room = this.io.sockets.adapter.rooms.get(`watch:${engineId}`);
        if (!room) return;
        for (const socketId of room) {
            const socket = this.io.sockets.sockets.get(socketId);
            if (!socket) continue;
            if (socket.conn.transport.writable) {
                socket.emit('engine:vu', payload);
                continue;
            }
            this.trace();
            let pending = this.pending.get(socket);
            if (!pending) {
                pending = new Map();
                this.pending.set(socket, pending);
                socket.conn.once('drain', () => {
                    const heldPayloads = this.pending.get(socket);
                    this.pending.delete(socket);
                    if (!heldPayloads) return;
                    for (const p of heldPayloads.values()) socket.emit('engine:vu', p);
                });
            }
            pending.set(engineId, payload);
        }
    }

    /** One journal line per minute at most, so a #677-style report has a trace to grep for. */
    private trace(): void {
        this.held++;
        if (this.traceTimer) return;
        this.traceTimer = setTimeout(() => {
            this.traceTimer = null;
            log.info(
                { held: this.held },
                'VU payloads held for busy browser sockets (coalesced, not dropped)',
            );
            this.held = 0;
        }, 60_000);
        this.traceTimer.unref?.();
    }
}
