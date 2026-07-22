import { connect, type Socket } from 'node:net';
import { PacedTsSink, TS_PACKET_BYTES } from './PacedTsSink.js';

/**
 * Datagram size for the sidecar hop: 128 TS packets. Boundaries are
 * irrelevant on a stream socket (the sidecar re-chunks 188-aligned), but the
 * size sets the PACING granularity — ~38 ms per datagram at 5 Mbps, well
 * inside the sidecar's 500 ms per-consumer queue budget.
 */
const STREAM_CHUNK_BYTES = 128 * TS_PACKET_BYTES;

/** Cap on Node-side socket buffering before we shed instead of ballooning. */
const MAX_UNFLUSHED_BYTES = 8 * 1024 * 1024;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Unix-stream transport for `PacedTsSink` (pacing/buffering documented
 * there): paced raw TS into the module's `unixfd-fanout.py` sidecar ingest
 * socket, which speaks the GstUnixFd protocol to the per-consumer edges. The
 * non-GStreamer Node producer egress under unixfd bus transport (hls-player).
 *
 * Connection discipline mirrors bus semantics — loss over a broken local hop
 * is tolerated, availability is not negotiable:
 *   - first `write` blocks until the sidecar accepts (it is spawned by the
 *     same module, so this converges quickly; retry loop, no deadline),
 *   - a mid-run disconnect (sidecar autoRestart) sheds datagrams while a
 *     background reconnect runs — exactly what the UDP sink's fire-and-forget
 *     `send` does when nobody listens.
 */
export class PacedUnixStreamTsSink extends PacedTsSink {
    private socket: Socket | null = null;
    private connecting: Promise<void> | null = null;
    private everConnected = false;
    private reconnecting = false;

    constructor(private readonly socketPath: string) {
        super(STREAM_CHUNK_BYTES);
    }

    protected async ensureReady(): Promise<void> {
        // Only the INITIAL connection blocks write(): the sidecar is spawned
        // by the same module, so this converges quickly. After that, a lost
        // connection must never stall the producer — sheds + background
        // reconnect instead (see sendNow/dropSocket).
        if (this.everConnected) return;
        while (!this.closed && !this.socket) {
            try {
                await this.connectOnce();
            } catch {
                await sleep(250);
            }
        }
    }

    private connectOnce(): Promise<void> {
        this.connecting ??= new Promise<void>((resolve, reject) => {
            const sock = connect(this.socketPath);
            sock.once('connect', () => {
                sock.removeAllListeners('error');
                // A later error/close drops the ref and starts the background
                // reconnect; datagrams shed until it lands.
                sock.on('error', () => this.dropSocket(sock));
                sock.on('close', () => this.dropSocket(sock));
                this.socket = sock;
                this.everConnected = true;
                this.connecting = null;
                resolve();
            });
            sock.once('error', (err) => {
                sock.destroy();
                this.connecting = null;
                reject(err);
            });
        });
        return this.connecting;
    }

    private dropSocket(sock: Socket): void {
        if (this.socket === sock) {
            this.socket = null;
            this.kickReconnect();
        }
        sock.destroy();
    }

    /** Background reconnect loop (single-flight) for mid-run disconnects. */
    private kickReconnect(): void {
        if (this.reconnecting || this.closed || this.socket) return;
        this.reconnecting = true;
        void (async () => {
            while (!this.closed && !this.socket) {
                try {
                    await this.connectOnce();
                } catch {
                    await sleep(250);
                }
            }
            this.reconnecting = false;
        })();
    }

    protected sendNow(datagram: Buffer): void {
        const sock = this.socket;
        if (!sock) {
            // Disconnected (sidecar restarting) — shed this datagram; the
            // background reconnect brings a fresh socket up. Pacing timing is
            // never blocked.
            this.kickReconnect();
            return;
        }
        // net.Socket buffers unboundedly in userland when the peer stalls; a
        // healthy sidecar drains a paced ~5 Mbps trivially, so a big backlog
        // means it's wedged — shed rather than balloon memory.
        if (sock.writableLength > MAX_UNFLUSHED_BYTES) return;
        sock.write(datagram);
    }

    protected async closeTransport(): Promise<void> {
        const sock = this.socket;
        this.socket = null;
        if (!sock) return;
        sock.removeAllListeners('close');
        sock.removeAllListeners('error');
        sock.on('error', () => {});
        await new Promise<void>((resolve) => sock.end(resolve));
        sock.destroy();
    }
}
