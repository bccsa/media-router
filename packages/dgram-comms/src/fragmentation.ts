/**
 * UDP message fragmentation.
 *
 * Data fragment header (8 bytes):
 *   [messageId: 4 bytes (UInt32BE)]
 *   [fragmentIndex: 2 bytes (UInt16BE)]
 *   [fragmentCount: 2 bytes (UInt16BE)]   // always >= 1 for data
 *   [payload: remaining bytes]
 *
 * NACK control packet (retransmit request) reuses the header with
 * `fragmentCount === 0` as the discriminator:
 *   [messageId: 4 bytes]  [0: 2 bytes]  [0: 2 bytes = NACK marker]
 *   [missing fragment index: 2 bytes (UInt16BE)] ...
 *
 * Reassembly + fragment-level retransmit live in FragmentTransport.
 * Max packet size: 1412 bytes (avoids IP fragmentation on most networks).
 */

const HEADER_SIZE = 8;
const MAX_PACKET_SIZE = 1412;
const MAX_PAYLOAD_SIZE = MAX_PACKET_SIZE - HEADER_SIZE;

/** Start from random offset to avoid collisions when a client restarts. */
let globalMessageId = (Math.random() * 0xffffffff) >>> 0;

/**
 * Fragment a message buffer into sendable UDP packets, returning the assigned
 * messageId so the caller can retain the packets for fragment-level retransmit.
 */
export function fragmentWithId(data: Buffer): { messageId: number; packets: Buffer[] } {
    globalMessageId = (globalMessageId + 1) >>> 0;
    const messageId = globalMessageId;
    const fragmentCount = Math.max(1, Math.ceil(data.length / MAX_PAYLOAD_SIZE));
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

    return { messageId, packets };
}

/** Fragment a message buffer into sendable UDP packets. */
export function fragment(data: Buffer): Buffer[] {
    return fragmentWithId(data).packets;
}

/** Parse the header from a fragment packet. `fragmentCount === 0` means it is a NACK. */
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

/** Build a NACK packet requesting retransmit of the given missing fragment indices. */
export function encodeNack(messageId: number, missing: number[]): Buffer {
    const buf = Buffer.alloc(HEADER_SIZE + missing.length * 2);
    buf.writeUInt32BE(messageId >>> 0, 0);
    buf.writeUInt16BE(0, 4);
    buf.writeUInt16BE(0, 6); // fragmentCount === 0 discriminates a NACK
    for (let i = 0; i < missing.length; i++) {
        buf.writeUInt16BE(missing[i] & 0xffff, HEADER_SIZE + i * 2);
    }
    return buf;
}

/** Parse a NACK packet (header already known to have fragmentCount === 0). */
export function decodeNack(packet: Buffer): { messageId: number; missing: number[] } {
    const messageId = packet.readUInt32BE(0);
    const missing: number[] = [];
    for (let off = HEADER_SIZE; off + 2 <= packet.length; off += 2) {
        missing.push(packet.readUInt16BE(off));
    }
    return { messageId, missing };
}

export { MAX_PACKET_SIZE, MAX_PAYLOAD_SIZE, HEADER_SIZE };
