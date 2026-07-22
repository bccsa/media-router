const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Read-ahead buffer: how much downloaded media to hold before back-pressuring
 * the producer. Generous — for HLS the user trades latency for smoothness, so
 * we keep ~60 s of downloaded media on hand to ride out CDN / network jitter.
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

interface Scheduled {
    datagram: Buffer;
    /** Cumulative media time (s) at which this datagram should be sent. */
    atSec: number;
}

/** One MPEG-TS packet. */
export const TS_PACKET_BYTES = 188;

/**
 * Slice a byte stream into whole `datagramBytes`-sized datagrams, carrying any
 * partial trailing bytes forward as `remainder` for the next call. Pure +
 * deterministic so it can be unit-tested without a socket.
 */
export function packetizeTs(
    leftover: Buffer,
    chunk: Buffer,
    datagramBytes: number,
): { datagrams: Buffer[]; remainder: Buffer } {
    const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
    const datagrams: Buffer[] = [];
    let offset = 0;
    while (buf.length - offset >= datagramBytes) {
        datagrams.push(buf.subarray(offset, offset + datagramBytes));
        offset += datagramBytes;
    }
    return { datagrams, remainder: buf.subarray(offset) };
}

/**
 * MPEG-TS sink core that **paces output to the media rate** while letting the
 * producer download ahead into a buffer — the shared engine of the
 * non-GStreamer Node producer egress (hls-player), transport supplied by the
 * subclass (`PacedUnixStreamTsSink` → the unixfd fan-out sidecar's ingest
 * socket).
 *
 * Implements the sink contract `write(chunk, mediaSeconds)` + `end()` (see
 * hls-pipe's `SegmentSink`). Producers deliver a whole segment per `write`;
 * sending those bytes downstream at once overruns the receiver (the sidecar's
 * 500 ms per-consumer queues) and shreds the
 * stream — the other producers avoid this only because a real-time source
 * (srtsrc, pulsesrc) paces them. We reconstruct that pacing:
 *
 *  - `write` slices the chunk into datagrams, stamps each with a cumulative
 *    media time (spread across the write's declared media span), and enqueues it —
 *    returning fast so the producer keeps fetching, up to a ~60 s read-ahead
 *    buffer (back-pressure beyond that). The buffer absorbs download jitter so
 *    the egress never starves — without it, one slow segment fetch stutters
 *    playback.
 *  - a background drain loop sends each datagram at its scheduled wall-clock
 *    time (anchored to the head of the queue, re-anchored whenever the queue
 *    runs dry), so egress flows at ~the stream bitrate.
 *
 * Chunks are queued zero-copy (views over the caller's buffer, held up to
 * ~60 s) — callers must hand over ownership and never mutate the buffer after
 * `write` (hls-pipe's `SegmentSink` contract states this).
 */
export abstract class PacedTsSink {
    private leftover: Buffer = Buffer.alloc(0);
    private _bytesSent = 0;

    private queue: Scheduled[] = [];
    private queueBytes = 0;
    private writeWaiters: Array<() => void> = [];
    /** Media time (s) assigned to the next datagram — end of the last enqueued chunk. */
    private mediaCursorSec = 0;
    private wallStartMs = 0;
    private draining = false;
    private ending = false;
    private _closed = false;

    constructor(private readonly datagramBytes: number) {}

    /** Total bytes pushed to the transport — used to derive the reported bitrate. */
    get bytesSent(): number {
        return this._bytesSent;
    }

    protected get closed(): boolean {
        return this._closed;
    }

    /** Bring the transport up (bind/connect). Awaited on every `write`. */
    protected abstract ensureReady(): Promise<void>;
    /** Fire-and-forget datagram egress — loss is tolerated for live TS. */
    protected abstract sendNow(datagram: Buffer): void;
    /** Tear the transport down after the buffered tail has drained. */
    protected abstract closeTransport(): Promise<void>;

    /** Media seconds currently buffered ahead of the drain head. */
    private bufferedSec(): number {
        const head = this.queue[0];
        return head ? this.mediaCursorSec - head.atSec : 0;
    }

    /**
     * Sink contract. `mediaSeconds` is this chunk's TRUE media duration (the
     * content-time span its bytes cover; 0 for init sections). Enqueues paced
     * datagrams and blocks only once the read-ahead buffer is full.
     */
    async write(chunk: Uint8Array, mediaSeconds: number): Promise<void> {
        if (this._closed) return;
        await this.ensureReady();

        const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        const { datagrams, remainder } = packetizeTs(this.leftover, buf, this.datagramBytes);
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

        // Back-pressure: let the producer race ahead only until the buffer is full.
        while (
            !this._closed &&
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
                if (this._closed || this.ending) break;
                // Queue ran dry (source stalled longer than the buffered
                // media, or a skip-on-stall jump advanced wall time without
                // media time) — drop the anchor so the next datagram
                // re-anchors. Keeping the old anchor would compute every
                // subsequent datagram as "late" and burst-send whole
                // segments: the exact receiver overflow this sink prevents.
                this.wallStartMs = 0;
                await sleep(10); // idle — wait for more input
                continue;
            }
            if (this.wallStartMs === 0) {
                // Anchor relative to the head datagram's media time,
                // back-dated by PREFILL_MS so the first bytes drain quickly.
                this.wallStartMs = performance.now() - PREFILL_MS - item.atSec * 1000;
            }
            const waitMs = this.wallStartMs + item.atSec * 1000 - performance.now();
            if (waitMs > 2) {
                await sleep(Math.min(waitMs, 250));
                continue;
            }
            this.queue.shift();
            this.queueBytes -= item.datagram.length;
            this._bytesSent += item.datagram.length;
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
        if (this._closed || this.ending) return;
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
        this._closed = true;
        for (const w of this.writeWaiters.splice(0)) w();
        await this.closeTransport();
    }
}
