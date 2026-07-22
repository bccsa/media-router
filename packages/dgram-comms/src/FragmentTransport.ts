import * as dgram from 'dgram';
import {
    fragmentWithId,
    parseFragmentHeader,
    encodeNack,
    decodeNack,
} from './fragmentation.js';
import { dnsCache } from './dnsCache.js';

interface SentEntry {
    packets: Buffer[];
    /** Endpoint the fragments were sent to — the only endpoint allowed to NACK them. */
    port: number;
    address: string;
    expiry: ReturnType<typeof setTimeout>;
}

interface RxEntry {
    fragments: (Buffer | null)[];
    received: number;
    total: number;
    address: string;
    port: number;
    messageId: number;
    /** Consecutive NACKs sent since the last fragment arrived — capped to avoid futile NACK storms. */
    nackAttempts: number;
    discardTimer: ReturnType<typeof setTimeout>;
    nackTimer: ReturnType<typeof setTimeout> | null;
}

export interface FragmentTransportOptions {
    /** Discard an incomplete inbound message after this long (ms). Default 10000. */
    reassemblyTimeoutMs?: number;
    /** Keep sent fragments this long for NACK / fallback resend (ms). Default 15000. */
    retainMs?: number;
    /** After this quiet gap with a fragment still missing, NACK for it (ms). Default 300. */
    nackDelayMs?: number;
    /** Max consecutive NACKs for one message before giving up (relies on discard/sender fallback). Default 8. */
    maxNackAttempts?: number;
}

/**
 * Fragmentation with fragment-level reliability.
 *
 * On send, reliable messages are fragmented once (stable messageId) and the
 * packets are retained. On receive, an incomplete multi-fragment message that
 * stalls (no new fragment for `nackDelayMs`) triggers a NACK listing only the
 * *missing* fragment indices; the sender retransmits just those from its
 * retained set. This replaces whole-message retransmit — a single lost fragment
 * no longer forces resending the entire message, so large (config-sized)
 * messages survive lossy links where per-attempt success was (1-loss)^N.
 *
 * One transport wraps one udp socket and is shared by every Socket sending on
 * it (so retained fragments live where the NACKs arrive). Inbound reassembly is
 * keyed by source+messageId, so two peers reusing a messageId never collide.
 *
 * Deliberately NO completed-message dedup at this layer: a retransmitted copy
 * (same messageId — the sender's fallback resend) must be RE-DELIVERED to the
 * Socket, whose data path ACKs first and then dedups by seq. Dropping resends
 * here starved that re-ACK: one lost ACK packet made a guaranteed message
 * permanently unacknowledgeable — the sender retransmitted into a receiver
 * that recognised every copy and answered none of them (measured on the NO-BR
 * gate: every command executed once but GAVE-UP after 10 resends, because the
 * single ACK died on the lossy uplink and no retransmit was ever re-ACKed).
 */
export class FragmentTransport {
    private udpSocket: dgram.Socket;
    private sent = new Map<number, SentEntry>();
    private rx = new Map<string, RxEntry>();

    private readonly reassemblyTimeoutMs: number;
    private readonly retainMs: number;
    private readonly nackDelayMs: number;
    private readonly maxNackAttempts: number;
    private destroyed = false;

    constructor(udpSocket: dgram.Socket, options: FragmentTransportOptions = {}) {
        this.udpSocket = udpSocket;
        this.reassemblyTimeoutMs = options.reassemblyTimeoutMs ?? 10000;
        this.retainMs = options.retainMs ?? 15000;
        this.nackDelayMs = options.nackDelayMs ?? 300;
        this.maxNackAttempts = options.maxNackAttempts ?? 8;
    }

    // ---- Send ----------------------------------------------------------------

    /**
     * Fragment and send a message. If `reliable`, retain the packets so missing
     * fragments can be retransmitted on NACK (and all on `resend`). Returns the
     * messageId — the caller uses it to `release` on ACK or `resend` on timeout.
     */
    send(buf: Buffer, port: number, address: string, reliable: boolean): number {
        // Resolve a hostname once per message, not per datagram — dgram.send()
        // dns.lookup()s a name on EVERY call, each occupying a libuv threadpool
        // slot, and at real send rates (keepalives + one send per fragment) the
        // pool saturates and datagrams queue behind DNS for tens of seconds
        // (see DnsCache). Retaining the IP also makes the NACK endpoint check
        // below workable for hostname configs: rinfo.address is always an IP
        // and could never equal a stored hostname.
        const ip = dnsCache.resolve(address);
        const { messageId, packets } = fragmentWithId(buf);
        for (const packet of packets) {
            this.udpSocket.send(packet, port, ip);
        }
        if (reliable) {
            const prev = this.sent.get(messageId);
            if (prev) clearTimeout(prev.expiry);
            this.sent.set(messageId, {
                packets,
                port,
                address: ip,
                expiry: setTimeout(() => this.sent.delete(messageId), this.retainMs),
            });
        }
        return messageId;
    }

    /** Resend every retained fragment for a message (fallback when the whole message was lost). */
    resend(messageId: number, port: number, address: string): void {
        const entry = this.sent.get(messageId);
        if (!entry) return;
        const ip = dnsCache.resolve(address);
        for (const packet of entry.packets) {
            this.udpSocket.send(packet, port, ip);
        }
    }

    /** Drop retained fragments once the message is fully ACKed. */
    release(messageId: number): void {
        const entry = this.sent.get(messageId);
        if (entry) {
            clearTimeout(entry.expiry);
            this.sent.delete(messageId);
        }
    }

    // ---- Receive -------------------------------------------------------------

    /**
     * Feed a raw inbound packet. Returns the complete reassembled message, or
     * null if it was a fragment (still waiting), a NACK (handled internally by
     * retransmitting), or a duplicate.
     */
    receive(packet: Buffer, rinfo: dgram.RemoteInfo): Buffer | null {
        const header = parseFragmentHeader(packet);
        if (!header) return null;

        // NACK: retransmit only the requested missing fragments — but ONLY to the
        // exact endpoint we sent them to. A spoofed-source NACK must not make us
        // blast retained fragments at an arbitrary victim (reflection/amplification).
        if (header.fragmentCount === 0) {
            const { messageId, missing } = decodeNack(packet);
            const entry = this.sent.get(messageId);
            if (entry && rinfo.address === entry.address && rinfo.port === entry.port) {
                for (const idx of missing) {
                    const frag = entry.packets[idx];
                    if (frag) this.udpSocket.send(frag, entry.port, entry.address);
                }
            }
            return null;
        }

        const { messageId, fragmentIndex, fragmentCount, payload } = header;
        const key = `${rinfo.address}:${rinfo.port}:${messageId}`;

        if (fragmentIndex >= fragmentCount) return null;

        // Single-fragment message — nothing to reassemble. Retransmitted copies
        // are returned again on purpose: the Socket re-ACKs them (see class doc).
        if (fragmentCount === 1) {
            return payload;
        }

        let entry = this.rx.get(key);
        if (!entry) {
            entry = {
                fragments: new Array(fragmentCount).fill(null),
                received: 0,
                total: fragmentCount,
                address: rinfo.address,
                port: rinfo.port,
                messageId,
                nackAttempts: 0,
                discardTimer: setTimeout(() => this.dropRx(key), this.reassemblyTimeoutMs),
                nackTimer: null,
            };
            this.rx.set(key, entry);
        }
        if (entry.total !== fragmentCount) return null;

        if (!entry.fragments[fragmentIndex]) {
            entry.fragments[fragmentIndex] = payload;
            entry.received++;
            entry.nackAttempts = 0; // progress — reset the futile-NACK counter
        }

        if (entry.received === entry.total) {
            this.dropRx(key);
            // No completed-marker: a full resend of this message re-assembles
            // and re-delivers, so the Socket can re-ACK it (see class doc).
            return Buffer.concat(entry.fragments as Buffer[]);
        }

        // Progress made but still incomplete — (re)arm the gap timer. A NACK
        // fires only after a quiet gap, so in-flight fragments aren't NACKed
        // prematurely, and it repeats (up to maxNackAttempts) until the message
        // completes, more fragments arrive, or it is discarded.
        this.armNackTimer(key);
        return null;
    }

    private armNackTimer(key: string): void {
        const entry = this.rx.get(key);
        if (!entry) return;
        // Stop after too many consecutive unanswered NACKs — the sender isn't
        // serving them (unreliable message, or its retained set was released/
        // expired). Discard timer / sender fallback take over from here.
        if (entry.nackAttempts >= this.maxNackAttempts) return;
        if (entry.nackTimer) clearTimeout(entry.nackTimer);
        entry.nackTimer = setTimeout(() => {
            const cur = this.rx.get(key);
            if (!cur || this.destroyed) return;
            const missing: number[] = [];
            for (let i = 0; i < cur.total; i++) if (!cur.fragments[i]) missing.push(i);
            if (missing.length > 0) {
                cur.nackAttempts++;
                this.udpSocket.send(encodeNack(cur.messageId, missing), cur.port, cur.address);
                this.armNackTimer(key); // keep asking until filled, discarded, or capped
            }
        }, this.nackDelayMs);
    }

    private dropRx(key: string): void {
        const entry = this.rx.get(key);
        if (!entry) return;
        clearTimeout(entry.discardTimer);
        if (entry.nackTimer) clearTimeout(entry.nackTimer);
        this.rx.delete(key);
    }

    destroy(): void {
        this.destroyed = true;
        for (const entry of this.sent.values()) clearTimeout(entry.expiry);
        this.sent.clear();
        for (const entry of this.rx.values()) {
            clearTimeout(entry.discardTimer);
            if (entry.nackTimer) clearTimeout(entry.nackTimer);
        }
        this.rx.clear();
    }
}
