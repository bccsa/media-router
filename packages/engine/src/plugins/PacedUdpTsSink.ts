import { createSocket, type Socket } from 'node:dgram';
import { DEFAULT_MPEGTS_ALIGNMENT } from './tsHelpers.js';
import { MULTICAST_IFACE_ADDR, isMulticast } from './udpHelpers.js';
import { PacedTsSink, TS_PACKET_BYTES, packetizeTs as packetize } from './PacedTsSink.js';

export { TS_PACKET_BYTES };
/** 7 TS packets = 1316 bytes — the classic TS-over-UDP datagram size (fits a 1500-byte MTU). */
export const TS_PACKETS_PER_DATAGRAM = DEFAULT_MPEGTS_ALIGNMENT;
export const TS_DATAGRAM_BYTES = TS_PACKET_BYTES * TS_PACKETS_PER_DATAGRAM;

/**
 * Back-compat wrapper over the generalized `packetizeTs` (see PacedTsSink.ts)
 * pinned to the classic 1316-byte TS-over-UDP datagram.
 */
export function packetizeTs(
    leftover: Buffer,
    chunk: Buffer,
): { datagrams: Buffer[]; remainder: Buffer } {
    return packetize(leftover, chunk, TS_DATAGRAM_BYTES);
}

/** Socket send buffer — paired with a host sysctl bump on `net.core.wmem_max`. */
const SEND_BUFFER_BYTES = 16 * 1024 * 1024;

/**
 * UDP transport for `PacedTsSink` (pacing/buffering documented there): raw
 * 188-byte-aligned TS in 1316-byte datagrams, wire-identical to GStreamer
 * `udpsink`, read by `udpsrc ! tsdemux` downstream. The non-GStreamer Node
 * producer egress onto the loopback multicast bus under UDP transport
 * (hls-player today — under unixfd it uses `PacedUnixStreamTsSink` instead).
 */
export class PacedUdpTsSink extends PacedTsSink {
    private readonly socket: Socket;
    private bound = false;

    constructor(
        private readonly port: number,
        private readonly host: string,
        private readonly iface = MULTICAST_IFACE_ADDR,
    ) {
        super(TS_DATAGRAM_BYTES);
        this.socket = createSocket({ type: 'udp4', reuseAddr: true });
        // Loss is tolerated for live TS — never let a socket error kill the run.
        this.socket.on('error', () => {});
    }

    protected ensureReady(): Promise<void> {
        if (this.bound) return Promise.resolve();
        return new Promise((resolve) => {
            this.socket.bind(() => {
                // Multicast socket opts only apply to a multicast destination —
                // on a unicast host they can throw, and (sharing the try) would
                // skip the send-buffer sizing below.
                if (isMulticast(this.host)) {
                    try {
                        this.socket.setMulticastInterface(this.iface);
                        this.socket.setMulticastTTL(1);
                    } catch {
                        /* some kernels reject these on loopback multicast — non-fatal */
                    }
                }
                try {
                    this.socket.setSendBufferSize(SEND_BUFFER_BYTES);
                } catch {
                    /* non-fatal */
                }
                this.bound = true;
                resolve();
            });
        });
    }

    protected sendNow(datagram: Buffer): void {
        this.socket.send(datagram, this.port, this.host, () => {
            /* swallow transient send errors (ENOBUFS) — loss is acceptable */
        });
    }

    protected closeTransport(): Promise<void> {
        return new Promise((resolve) => this.socket.close(() => resolve()));
    }
}
