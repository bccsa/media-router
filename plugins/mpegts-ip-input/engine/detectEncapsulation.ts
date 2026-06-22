import * as dgram from 'node:dgram';
import * as os from 'node:os';

export type Encapsulation = 'raw' | 'rtp';

/**
 * Classify a single inbound UDP datagram as raw MPEG-TS or RTP/TS.
 *
 * The discriminator is the MPEG-TS sync byte `0x47`, which a conformant TS
 * places at the start of every 188-byte packet:
 *   - **raw**: the datagram payload *is* TS packets, so byte 0 is `0x47`.
 *   - **rtp**: a 12-byte RTP header precedes the TS, so byte 0 is the RTP
 *     version/flags octet (`10xxxxxx` for version 2) and the sync byte lands
 *     at offset 12.
 *
 * Returns `null` when neither shape matches (garbage / non-TS payload) so the
 * caller can fall back rather than guess wrong.
 */
export function classifyDatagram(buf: Buffer): Encapsulation | null {
    if (buf.length === 0) return null;
    if (buf[0] === 0x47) return 'raw';
    // RTP version 2 lives in the top two bits of byte 0 (0x80 mask = 10b).
    const isRtpV2 = (buf[0] & 0xc0) === 0x80;
    if (isRtpV2 && buf.length >= 13 && buf[12] === 0x47) return 'rtp';
    return null;
}

/** Resolve a NIC name (e.g. `eth0`) to its first IPv4 address, or undefined. */
export function ifaceAddress(name: string): string | undefined {
    if (!name) return undefined;
    const entries = os.networkInterfaces()[name];
    return entries?.find((e) => e.family === 'IPv4')?.address;
}

export interface SniffOpts {
    port: number;
    /** Multicast group to join while sniffing (undefined = unicast listen). */
    multicastGroup?: string;
    /** Interface IPv4 address for the multicast join (from `ifaceAddress`). */
    ifaceAddr?: string;
    /** Give up after this long and return null. */
    timeoutMs: number;
}

/**
 * Briefly bind the listen port and classify the first datagram that arrives.
 *
 * Bound with SO_REUSEADDR and fully closed before returning so the GStreamer
 * `udpsrc` can take the port immediately after. A few startup packets are lost
 * during the handoff — acceptable for a live broadcast feed. Returns null on
 * timeout or socket failure; the caller picks a default.
 */
export function sniffEncapsulation(opts: SniffOpts): Promise<Encapsulation | null> {
    return new Promise((resolve) => {
        const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        let settled = false;

        const finish = (result: Encapsulation | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            sock.removeAllListeners('message');
            sock.close(() => resolve(result));
        };

        const timer = setTimeout(() => finish(null), opts.timeoutMs);

        // A stray socket error (e.g. ICMP unreachable) shouldn't wedge startup —
        // bail to the fallback rather than hang until the timeout.
        sock.on('error', () => finish(null));
        sock.on('message', (msg) => finish(classifyDatagram(msg)));

        sock.bind(opts.port, () => {
            if (opts.multicastGroup) {
                try {
                    sock.addMembership(opts.multicastGroup, opts.ifaceAddr);
                } catch {
                    // Best-effort: if the join fails we just wait out the timeout.
                }
            }
        });
    });
}
