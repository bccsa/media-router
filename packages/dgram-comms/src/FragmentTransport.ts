import * as dgram from 'dgram';
import {
    fragmentWithId,
    parseFragmentHeader,
    encodeNack,
    decodeNack,
} from './fragmentation.js';

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
    /**
     * How long a completed messageId is remembered for dedup (ms). Must exceed the
     * sender's retransmit window so a late resend of an already-delivered message
     * is dropped, not re-delivered. Default `retainMs * 2`.
     */
    dedupTtlMs?: number;
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
 */
export class FragmentTransport {
    private udpSocket: dgram.Socket;
    private sent = new Map<number, SentEntry>();
    private rx = new Map<string, RxEntry>();
    /** Completed source:messageId → completion timestamp (ms), for age-based dedup. */
    private completed = new Map<string, number>();
    /** Hard backstop on the dedup table; age eviction (dedupTtlMs) is the primary bound. */
    private readonly maxCompleted = 65536;

    private readonly reassemblyTimeoutMs: number;
    private readonly retainMs: number;
    private readonly nackDelayMs: number;
    private readonly maxNackAttempts: number;
    private readonly dedupTtlMs: number;
    private destroyed = false;

    constructor(udpSocket: dgram.Socket, options: FragmentTransportOptions = {}) {
        this.udpSocket = udpSocket;
        this.reassemblyTimeoutMs = options.reassemblyTimeoutMs ?? 10000;
        this.retainMs = options.retainMs ?? 15000;
        this.nackDelayMs = options.nackDelayMs ?? 300;
        this.maxNackAttempts = options.maxNackAttempts ?? 8;
        this.dedupTtlMs = options.dedupTtlMs ?? this.retainMs * 2;
    }

    // ---- Send ----------------------------------------------------------------

    /**
     * Fragment and send a message. If `reliable`, retain the packets so missing
     * fragments can be retransmitted on NACK (and all on `resend`). Returns the
     * messageId — the caller uses it to `release` on ACK or `resend` on timeout.
     */
    send(buf: Buffer, port: number, address: string, reliable: boolean): number {
        const { messageId, packets } = fragmentWithId(buf);
        for (const packet of packets) {
            this.udpSocket.send(packet, port, address);
        }
        if (reliable) {
            const prev = this.sent.get(messageId);
            if (prev) clearTimeout(prev.expiry);
            this.sent.set(messageId, {
                packets,
                port,
                address,
                expiry: setTimeout(() => this.sent.delete(messageId), this.retainMs),
            });
        }
        return messageId;
    }

    /** Resend every retained fragment for a message (fallback when the whole message was lost). */
    resend(messageId: number, port: number, address: string): void {
        const entry = this.sent.get(messageId);
        if (!entry) return;
        for (const packet of entry.packets) {
            this.udpSocket.send(packet, port, address);
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

        if (this.completed.has(key)) return null;
        if (fragmentIndex >= fragmentCount) return null;

        // Single-fragment message — nothing to reassemble.
        if (fragmentCount === 1) {
            this.markCompleted(key);
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
            this.markCompleted(key);
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

    /**
     * Remember a completed message for dedup. Evicts by age (older than
     * `dedupTtlMs`, which outlasts the sender's retransmit window) so the table
     * stays bounded regardless of message rate — the count cap is only a
     * backstop. Keys are inserted once, in time order, so the oldest entry is
     * always at the front.
     */
    private markCompleted(key: string): void {
        const now = Date.now();
        this.completed.set(key, now);
        while (this.completed.size > 0) {
            const oldest = this.completed.keys().next().value as string;
            const ts = this.completed.get(oldest) ?? 0;
            if (this.completed.size <= this.maxCompleted && now - ts <= this.dedupTtlMs) break;
            this.completed.delete(oldest);
        }
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
        this.completed.clear();
    }
}
