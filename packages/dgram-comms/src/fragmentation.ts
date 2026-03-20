/**
 * UDP message fragmentation and reassembly.
 *
 * Binary header format (8 bytes):
 *   [messageId: 4 bytes (UInt32BE)]
 *   [fragmentIndex: 2 bytes (UInt16BE)]
 *   [fragmentCount: 2 bytes (UInt16BE)]
 *   [payload: remaining bytes]
 *
 * Max packet size: 1412 bytes (avoids IP fragmentation on most networks).
 */

const HEADER_SIZE = 8;
const MAX_PACKET_SIZE = 1412;
const MAX_PAYLOAD_SIZE = MAX_PACKET_SIZE - HEADER_SIZE;

/** Start from random offset to avoid collisions when a client restarts. */
let globalMessageId = (Math.random() * 0xffffffff) >>> 0;

/** Fragment a message buffer into sendable UDP packets. */
export function fragment(data: Buffer): Buffer[] {
    if (data.length <= MAX_PAYLOAD_SIZE) {
        // Single packet — no fragmentation needed
        globalMessageId = (globalMessageId + 1) >>> 0;
        const packet = Buffer.alloc(HEADER_SIZE + data.length);
        packet.writeUInt32BE(globalMessageId, 0);
        packet.writeUInt16BE(0, 4);
        packet.writeUInt16BE(1, 6);
        data.copy(packet, HEADER_SIZE);
        return [packet];
    }

    globalMessageId = (globalMessageId + 1) >>> 0;
    const messageId = globalMessageId;
    const fragmentCount = Math.ceil(data.length / MAX_PAYLOAD_SIZE);
    const packets: Buffer[] = [];

    for (let i = 0; i < fragmentCount; i++) {
        const offset = i * MAX_PAYLOAD_SIZE;
        const end = Math.min(offset + MAX_PAYLOAD_SIZE, data.length);
        const payloadSize = end - offset;
        const packet = Buffer.alloc(HEADER_SIZE + payloadSize);
        packet.writeUInt32BE(messageId, 0);
        packet.writeUInt16BE(i, 4);
        packet.writeUInt16BE(fragmentCount, 6);
        data.copy(packet, HEADER_SIZE, offset, end);
        packets.push(packet);
    }

    return packets;
}

/** Parse the header from a fragment packet. */
export function parseFragmentHeader(packet: Buffer): {
    messageId: number;
    fragmentIndex: number;
    fragmentCount: number;
    payload: Buffer;
} | null {
    if (packet.length < HEADER_SIZE) return null;
    return {
        messageId: packet.readUInt32BE(0),
        fragmentIndex: packet.readUInt16BE(4),
        fragmentCount: packet.readUInt16BE(6),
        payload: packet.subarray(HEADER_SIZE),
    };
}

/**
 * Reassembles fragmented UDP messages.
 * Call `addFragment()` for each received packet.
 * Returns the complete message Buffer when all fragments are collected, or null if still waiting.
 */
export class Reassembler {
    private pending = new Map<
        number,
        {
            fragments: (Buffer | null)[];
            received: number;
            total: number;
            timer: ReturnType<typeof setTimeout>;
        }
    >();

    /** Set of recently completed messageIds for dedup. */
    private completed = new Set<number>();

    /** Timeout before incomplete messages are discarded (ms). */
    private timeout: number;

    /** Max completed IDs to remember for dedup. */
    private maxCompletedSize = 1000;

    constructor(timeout = 5000) {
        this.timeout = timeout;
    }

    /**
     * Add a received fragment packet. Returns the complete message when all
     * fragments are collected, or null if still waiting / duplicate.
     */
    addFragment(packet: Buffer): Buffer | null {
        const header = parseFragmentHeader(packet);
        if (!header) return null;

        const { messageId, fragmentIndex, fragmentCount, payload } = header;

        // Dedup: already completed this message
        if (this.completed.has(messageId)) return null;

        // Validate
        if (fragmentIndex >= fragmentCount) return null;

        // Single-fragment message — no assembly needed
        if (fragmentCount === 1) {
            this.markCompleted(messageId);
            return payload;
        }

        // Get or create pending entry
        let entry = this.pending.get(messageId);
        if (!entry) {
            entry = {
                fragments: new Array(fragmentCount).fill(null),
                received: 0,
                total: fragmentCount,
                timer: setTimeout(() => {
                    this.pending.delete(messageId);
                }, this.timeout),
            };
            this.pending.set(messageId, entry);
        }

        // Validate fragment count matches
        if (entry.total !== fragmentCount) return null;

        // Store fragment (don't overwrite)
        if (!entry.fragments[fragmentIndex]) {
            entry.fragments[fragmentIndex] = payload;
            entry.received++;
        }

        // Check if complete
        if (entry.received === entry.total) {
            clearTimeout(entry.timer);
            this.pending.delete(messageId);
            this.markCompleted(messageId);
            return Buffer.concat(entry.fragments as Buffer[]);
        }

        return null;
    }

    private markCompleted(messageId: number): void {
        this.completed.add(messageId);
        // Prune old IDs to prevent unbounded growth
        if (this.completed.size > this.maxCompletedSize) {
            const iter = this.completed.values();
            for (let i = 0; i < this.maxCompletedSize / 2; i++) {
                this.completed.delete(iter.next().value!);
            }
        }
    }

    /** Clean up all pending timers. */
    destroy(): void {
        for (const entry of this.pending.values()) {
            clearTimeout(entry.timer);
        }
        this.pending.clear();
        this.completed.clear();
    }
}

export { MAX_PACKET_SIZE, MAX_PAYLOAD_SIZE, HEADER_SIZE };
