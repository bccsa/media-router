import { FragmentTransport } from './FragmentTransport.js';

/** Fallback full-resend attempts for a totally-lost reliable message before giving up. */
const MAX_RESEND = 10;

/**
 * Guaranteed-delivery bookkeeping for one Socket.
 *
 * Assigns ackIDs, maps each to its transport `messageId`, and drives the
 * fallback whole-message resend. Fragment-level NACKs (in FragmentTransport)
 * refill partial loss fast; this backstops TOTAL loss — where no fragment
 * arrived, so the receiver never NACKs — by resending the retained fragments
 * with exponential backoff, giving up after MAX_RESEND. Releases the retained
 * fragments as soon as the message is ACKed (or abandoned).
 */
export class ReliableDelivery {
    private waitingAck = new Map<number, ReturnType<typeof setTimeout>>();
    private ackToMessageId = new Map<number, number>();
    private ackCounter = 0;

    constructor(
        private readonly transport: FragmentTransport,
        /** Current remote endpoint (re-read each resend so NAT updates are honoured). */
        private readonly endpoint: () => { port: number; address: string },
        private readonly onAckTimeout: (info: { topic?: string; ackID: number }) => void,
        private readonly isDestroyed: () => boolean,
    ) {}

    /** Allocate the next ackID for a guaranteed message. */
    nextAckId(): number {
        this.ackCounter += 1;
        return this.ackCounter;
    }

    /** Start tracking a sent guaranteed message (schedules the fallback resend). */
    track(ackID: number, messageId: number, topic: string | undefined): void {
        this.ackToMessageId.set(ackID, messageId);
        this.scheduleResend(ackID, messageId, topic, 0);
    }

    /** ACK received — stop resending and release the retained fragments. */
    ack(ackID: number): void {
        const timer = this.waitingAck.get(ackID);
        if (timer) clearTimeout(timer);
        this.waitingAck.delete(ackID);
        const messageId = this.ackToMessageId.get(ackID);
        if (messageId !== undefined) {
            this.transport.release(messageId);
            this.ackToMessageId.delete(ackID);
        }
    }

    private scheduleResend(
        ackID: number,
        messageId: number,
        topic: string | undefined,
        attempt: number,
    ): void {
        if (attempt >= MAX_RESEND) {
            this.waitingAck.delete(ackID);
            this.ackToMessageId.delete(ackID);
            this.transport.release(messageId);
            this.onAckTimeout({ topic, ackID });
            return;
        }
        const delay = Math.min(200 * Math.pow(2, attempt), 1600);
        const timer = setTimeout(() => {
            if (!this.waitingAck.has(ackID) || this.isDestroyed()) return;
            const { port, address } = this.endpoint();
            this.transport.resend(messageId, port, address);
            this.scheduleResend(ackID, messageId, topic, attempt + 1);
        }, delay);
        this.waitingAck.set(ackID, timer);
    }

    /** Clear all pending resends and release retained fragments (on disconnect). */
    destroy(): void {
        for (const timer of this.waitingAck.values()) clearTimeout(timer);
        this.waitingAck.clear();
        for (const messageId of this.ackToMessageId.values()) {
            this.transport.release(messageId);
        }
        this.ackToMessageId.clear();
    }
}
