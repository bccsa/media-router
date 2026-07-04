import { describe, it, expect } from 'vitest';
import {
    fragment,
    fragmentWithId,
    parseFragmentHeader,
    encodeNack,
    decodeNack,
    MAX_PAYLOAD_SIZE,
    HEADER_SIZE,
} from './fragmentation.js';

describe('fragmentation', () => {
    describe('fragment()', () => {
        it('returns a single packet for small messages', () => {
            const data = Buffer.from('hello');
            const packets = fragment(data);
            expect(packets).toHaveLength(1);

            const header = parseFragmentHeader(packets[0]);
            expect(header).not.toBeNull();
            expect(header!.fragmentIndex).toBe(0);
            expect(header!.fragmentCount).toBe(1);
            expect(header!.payload.toString()).toBe('hello');
        });

        it('fragments large messages into multiple packets', () => {
            const data = Buffer.alloc(MAX_PAYLOAD_SIZE * 3 + 100, 'A');
            const packets = fragment(data);
            expect(packets).toHaveLength(4);

            for (let i = 0; i < packets.length; i++) {
                const header = parseFragmentHeader(packets[i]);
                expect(header).not.toBeNull();
                expect(header!.fragmentIndex).toBe(i);
                expect(header!.fragmentCount).toBe(4);
            }
        });

        it('each packet is within max size', () => {
            const data = Buffer.alloc(10000, 'B');
            const packets = fragment(data);
            for (const packet of packets) {
                expect(packet.length).toBeLessThanOrEqual(MAX_PAYLOAD_SIZE + HEADER_SIZE);
            }
        });

        it('increments messageId', () => {
            const p1 = fragment(Buffer.from('a'));
            const p2 = fragment(Buffer.from('b'));
            const h1 = parseFragmentHeader(p1[0])!;
            const h2 = parseFragmentHeader(p2[0])!;
            expect(h2.messageId).toBe(h1.messageId + 1);
        });

        it('handles an empty buffer as one zero-length fragment', () => {
            const packets = fragment(Buffer.alloc(0));
            expect(packets).toHaveLength(1);
            expect(parseFragmentHeader(packets[0])!.fragmentCount).toBe(1);
        });
    });

    describe('fragmentWithId()', () => {
        it('exposes the assigned messageId, matching the packet headers', () => {
            const { messageId, packets } = fragmentWithId(Buffer.alloc(MAX_PAYLOAD_SIZE * 2, 'Z'));
            expect(packets.length).toBe(2);
            for (const p of packets) {
                expect(parseFragmentHeader(p)!.messageId).toBe(messageId);
            }
        });
    });

    describe('parseFragmentHeader()', () => {
        it('returns null for packets smaller than header', () => {
            expect(parseFragmentHeader(Buffer.alloc(4))).toBeNull();
        });

        it('parses header correctly', () => {
            const packet = Buffer.alloc(HEADER_SIZE + 5);
            packet.writeUInt32BE(42, 0);
            packet.writeUInt16BE(1, 4);
            packet.writeUInt16BE(3, 6);
            packet.write('hello', HEADER_SIZE);

            const h = parseFragmentHeader(packet)!;
            expect(h.messageId).toBe(42);
            expect(h.fragmentIndex).toBe(1);
            expect(h.fragmentCount).toBe(3);
            expect(h.payload.toString()).toBe('hello');
        });
    });

    describe('NACK encode/decode', () => {
        it('round-trips a messageId and missing indices', () => {
            const nack = encodeNack(1234, [0, 2, 5]);
            // fragmentCount === 0 is the NACK discriminator
            expect(parseFragmentHeader(nack)!.fragmentCount).toBe(0);
            const decoded = decodeNack(nack);
            expect(decoded.messageId).toBe(1234);
            expect(decoded.missing).toEqual([0, 2, 5]);
        });

        it('is distinguishable from a data fragment (count >= 1)', () => {
            const dataFrag = fragment(Buffer.from('x'))[0];
            expect(parseFragmentHeader(dataFrag)!.fragmentCount).toBeGreaterThanOrEqual(1);
        });
    });
});
