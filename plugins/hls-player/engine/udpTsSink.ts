import { performance } from 'node:perf_hooks';
import { createSocket, type Socket } from 'node:dgram';

/** One MPEG-TS packet. */
export const TS_PACKET_BYTES = 188;
/** 7 TS packets = 1316 bytes — the classic TS-over-UDP datagram size (fits a 1500-byte MTU). */
export const TS_PACKETS_PER_DATAGRAM = 7;
export const TS_DATAGRAM_BYTES = TS_PACKET_BYTES * TS_PACKETS_PER_DATAGRAM;

/**
 * Slice a byte stream into whole 1316-byte datagrams, carrying any partial
 * trailing bytes forward as `remainder` for the next call. Pure + deterministic
 * so it can be unit-tested without a socket.
 */
export function packetizeTs(
    leftover: Buffer,
    chunk: Buffer,
): { datagrams: Buffer[]; remainder: Buffer } {
    const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
    const datagrams: Buffer[] = [];
    let offset = 0;
    while (buf.length - offset >= TS_DATAGRAM_BYTES) {
        datagrams.push(buf.subarray(offset, offset + TS_DATAGRAM_BYTES));
        offset += TS_DATAGRAM_BYTES;
    }
    return { datagrams, remainder: buf.subarray(offset) };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Read-ahead buffer: how much downloaded media to hold before back-pressuring
 * hls-pipe. Generous — for HLS the user trades latency for smoothness, so we
 * keep ~60 s of downloaded media on hand to ride out CDN / network jitter.
 */
const MAX_BUFFER_SEC = 60;
const MAX_BUFFER_BYTES = 128 * 1024 * 1024;

/**
 * Wall-clock lead time on the first datagram — back-date the wall-clock anchor
 * by this much so the initial bytes drain quickly into the kernel UDP buffer
 * before steady-rate pacing kicks in. Small (2 s) by design:
 *   - On INITIAL play, it's enough to give the player a modest buffer head-start.
 *   - On RESTART, a too-large pre-fill dumps 10 s of pre-keyframe data into a
 *     pipeline that's just been re-subscribed, and the player has to chew
 *     through it before finding sync — looks like "scrambled video for a while
 *     then clears up". 2 s keeps that recovery window tight.
 */
const PREFILL_MS = 2_000;

/** Socket send buffer — paired with a host sysctl bump on `net.core.wmem_max`. */
const SEND_BUFFER_BYTES = 16 * 1024 * 1024;

interface Scheduled {
    datagram: Buffer;
    /** Cumulative media time (s) at which this datagram should be sent. */
    atSec: number;
}

/**
 * MPEG-TS → UDP multicast sink that **paces output to the media rate** while
 * letting hls-pipe download ahead into a buffer.
 *
 * Implements hls-pipe's sink contract (`write(chunk, mediaSeconds)` + `end()`).
 * hls-pipe delivers a whole segment per `write`; sending those bytes to the
 * socket at once overruns the receiver's UDP buffer (udpsrc, default 4 MB) and
 * shreds the stream — the other producers avoid this only because a real-time
 * source (srtsrc, pulsesrc) paces them. We reconstruct that pacing:
 *
 *  - `write` packetizes the chunk, stamps each datagram with a cumulative media
 *    time (spread across the segment's EXTINF), and enqueues it — returning fast
 *    so hls-pipe keeps fetching, up to a ~60 s read-ahead buffer (see
 *    `MAX_BUFFER_SEC`; back-pressure beyond that). The buffer absorbs download
 *    jitter so the egress never starves — without it, one slow segment fetch
 *    stutters playback.
 *  - a background drain loop sends each datagram at its scheduled wall-clock
 *    time (anchored to the first send), so egress flows at ~the stream bitrate.
 *
 * Wire format matches GStreamer `udpsink`: raw 188-byte-aligned TS in 1316-byte
 * datagrams to `239.x.x.x` on `lo`, read by `udpsrc ! tsdemux` downstream.
 */
export class PacedUdpTsSink {
    private readonly socket: Socket;
    private leftover: Buffer = Buffer.alloc(0);
    private bound = false;
    private _bytesSent = 0;

    private queue: Scheduled[] = [];
    private queueBytes = 0;
    private writeWaiters: Array<() => void> = [];
    /** Media time (s) assigned to the next datagram — end of the last enqueued chunk. */
    private mediaCursorSec = 0;
    private wallStartMs = 0;
    private draining = false;
    private ending = false;
    private closed = false;

    constructor(
        private readonly port: number,
        private readonly host = '239.255.0.1',
        private readonly iface = '127.0.0.1',
    ) {
        this.socket = createSocket({ type: 'udp4', reuseAddr: true });
        // Loss is tolerated for live TS — never let a socket error kill the run.
        this.socket.on('error', () => {});
    }

    /** Total bytes pushed to the socket — used to derive the reported bitrate. */
    get bytesSent(): number {
        return this._bytesSent;
    }

    private ensureBound(): Promise<void> {
        if (this.bound) return Promise.resolve();
        return new Promise((resolve) => {
            this.socket.bind(() => {
                try {
                    this.socket.setMulticastInterface(this.iface);
                    this.socket.setMulticastTTL(1);
                    this.socket.setSendBufferSize(SEND_BUFFER_BYTES);
                } catch {
                    /* some kernels reject these on loopback multicast — non-fatal */
                }
                this.bound = true;
                resolve();
            });
        });
    }

    /** Media seconds currently buffered ahead of the drain head. */
    private bufferedSec(): number {
        const head = this.queue[0];
        return head ? this.mediaCursorSec - head.atSec : 0;
    }

    /**
     * hls-pipe sink contract. `mediaSeconds` is this chunk's media duration
     * (segment EXTINF; 0 for init sections). Enqueues paced datagrams and
     * blocks only once the read-ahead buffer is full.
     */
    async write(chunk: Uint8Array, mediaSeconds: number): Promise<void> {
        if (this.closed) return;
        await this.ensureBound();

        const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        const { datagrams, remainder } = packetizeTs(this.leftover, buf);
        this.leftover = remainder;

        const span = mediaSeconds > 0 ? mediaSeconds : 0;
        const base = this.mediaCursorSec;
        const n = datagrams.length;
        for (let i = 0; i < n; i++) {
            const atSec = n > 1 ? base + span * (i / n) : base;
            this.queue.push({ datagram: datagrams[i]!, atSec });
            this.queueBytes += datagrams[i]!.length;
        }
        this.mediaCursorSec += mediaSeconds;

        this.startDrain();

        // Back-pressure: let hls-pipe race ahead only until the buffer is full.
        while (
            !this.closed &&
            (this.bufferedSec() > MAX_BUFFER_SEC || this.queueBytes > MAX_BUFFER_BYTES)
        ) {
            await new Promise<void>((r) => this.writeWaiters.push(r));
        }
    }

    private startDrain(): void {
        if (this.draining) return;
        this.draining = true;
        void this.drainLoop();
    }

    private async drainLoop(): Promise<void> {
        while (true) {
            const item = this.queue[0];
            if (!item) {
                if (this.closed || this.ending) break;
                await sleep(10); // idle — wait for more input
                continue;
            }
            if (this.wallStartMs === 0) this.wallStartMs = performance.now() - PREFILL_MS;
            const waitMs = this.wallStartMs + item.atSec * 1000 - performance.now();
            if (waitMs > 2) {
                await sleep(Math.min(waitMs, 250));
                continue;
            }
            this.queue.shift();
            this.queueBytes -= item.datagram.length;
            this.sendNow(item.datagram);
            if (
                this.writeWaiters.length > 0 &&
                this.bufferedSec() <= MAX_BUFFER_SEC &&
                this.queueBytes <= MAX_BUFFER_BYTES
            ) {
                this.writeWaiters.shift()!();
            }
        }
        this.draining = false;
    }

    async end(): Promise<void> {
        if (this.closed || this.ending) return;
        // Flush whole TS packets still buffered (drop a partial trailing packet).
        const flushable = this.leftover.length - (this.leftover.length % TS_PACKET_BYTES);
        if (flushable > 0) {
            this.queue.push({
                datagram: this.leftover.subarray(0, flushable),
                atSec: this.mediaCursorSec,
            });
            this.queueBytes += flushable;
        }
        this.leftover = Buffer.alloc(0);
        this.ending = true;
        this.startDrain();
        // Deliver the buffered tail at media rate, then close.
        while (this.queue.length > 0) await sleep(50);
        this.closed = true;
        for (const w of this.writeWaiters.splice(0)) w();
        await new Promise<void>((resolve) => this.socket.close(() => resolve()));
    }

    private sendNow(datagram: Buffer): void {
        this._bytesSent += datagram.length;
        this.socket.send(datagram, this.port, this.host, () => {
            /* swallow transient send errors (ENOBUFS) — loss is acceptable */
        });
    }
}
