import { FragmentTransport } from './FragmentTransport.js';

/** Fallback full-resend attempts for a totally-lost reliable message before giving up. */
const MAX_RESEND = 10;

/** One retained copy of a guaranteed message: which transport sent it, to which endpoint. */
export interface SentCopy {
    transport: FragmentTransport;
    messageId: number;
    /** Endpoint key (`address:port`) the copy went to — resends follow the endpoint's current address. */
    endpointKey: string;
}

/** Current remote endpoint for a key, or undefined once it has been pruned. */
export type EndpointLookup = (key: string) => { port: number; address: string } | undefined;

/**
 * Guaranteed-delivery bookkeeping for one Socket.
 *
 * Assigns ackIDs, maps each to the transport `messageId`s of every copy sent
 * (one per live endpoint on a multi-path session), and drives the fallback
 * whole-message resend. Fragment-level NACKs (in FragmentTransport) refill
 * partial loss fast; this backstops TOTAL loss — where no fragment arrived,
 * so the receiver never NACKs — by resending the retained fragments with
 * exponential backoff, giving up after MAX_RESEND. The first ACK from any
 * path releases every copy. Copies whose endpoint has since been pruned are
 * skipped on resend.
 */
export class ReliableDelivery {
    private waitingAck = new Map<number, ReturnType<typeof setTimeout>>();
    private ackToCopies = new Map<number, SentCopy[]>();
    private ackCounter = 0;

    constructor(
        /** Re-read on each resend so NAT rebinds are honoured and pruned endpoints skipped. */
        private readonly endpoint: EndpointLookup,
        private readonly onAckTimeout: (info: { topic?: string; ackID: number }) => void,
        private readonly isDestroyed: () => boolean,
        /** Shared ackID source — a multi-path Client's path Sockets must not collide (the server acks fan out to every path). */
        private readonly nextId?: () => number,
    ) {}

    /** Allocate the next ackID for a guaranteed message. */
    nextAckId(): number {
        if (this.nextId) return this.nextId();
        this.ackCounter += 1;
        return this.ackCounter;
    }

    /** Start tracking a sent guaranteed message (schedules the fallback resend). */
    track(ackID: number, copies: SentCopy[], topic: string | undefined): void {
        this.ackToCopies.set(ackID, copies);
        this.scheduleResend(ackID, topic, 0);
    }

    /** ACK received — stop resending and release the retained fragments. */
    ack(ackID: number): void {
        const timer = this.waitingAck.get(ackID);
        if (timer) clearTimeout(timer);
        this.waitingAck.delete(ackID);
        this.releaseCopies(ackID);
    }

    private releaseCopies(ackID: number): void {
        const copies = this.ackToCopies.get(ackID);
        if (!copies) return;
        for (const c of copies) c.transport.release(c.messageId);
        this.ackToCopies.delete(ackID);
    }

    private scheduleResend(ackID: number, topic: string | undefined, attempt: number): void {
        if (attempt >= MAX_RESEND) {
            this.waitingAck.delete(ackID);
            this.releaseCopies(ackID);
            this.onAckTimeout({ topic, ackID });
            return;
        }
        const delay = Math.min(200 * Math.pow(2, attempt), 1600);
        const timer = setTimeout(() => {
            if (!this.waitingAck.has(ackID) || this.isDestroyed()) return;
            for (const c of this.ackToCopies.get(ackID) ?? []) {
                const ep = this.endpoint(c.endpointKey);
                if (!ep) continue;
                c.transport.resend(c.messageId, ep.port, ep.address);
            }
            this.scheduleResend(ackID, topic, attempt + 1);
        }, delay);
        this.waitingAck.set(ackID, timer);
    }

    /** Clear all pending resends and release retained fragments (on disconnect). */
    destroy(): void {
        for (const timer of this.waitingAck.values()) clearTimeout(timer);
        this.waitingAck.clear();
        for (const ackID of [...this.ackToCopies.keys()]) this.releaseCopies(ackID);
    }
}
