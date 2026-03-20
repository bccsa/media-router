import { describe, it, expect, afterEach } from 'vitest';
import { fragment, parseFragmentHeader, Reassembler, MAX_PAYLOAD_SIZE, HEADER_SIZE } from './fragmentation.js';

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

    describe('Reassembler', () => {
        let reassembler: Reassembler;

        afterEach(() => {
            reassembler?.destroy();
        });

        it('returns payload immediately for single-fragment messages', () => {
            reassembler = new Reassembler();
            const packets = fragment(Buffer.from('simple'));
            const result = reassembler.addFragment(packets[0]);
            expect(result).not.toBeNull();
            expect(result!.toString()).toBe('simple');
        });

        it('reassembles multi-fragment messages', () => {
            reassembler = new Reassembler();
            const data = Buffer.alloc(MAX_PAYLOAD_SIZE * 2 + 50, 'X');
            const packets = fragment(data);
            expect(packets.length).toBeGreaterThan(1);

            let result: Buffer | null = null;
            for (const packet of packets) {
                result = reassembler.addFragment(packet);
            }
            expect(result).not.toBeNull();
            expect(result!.equals(data)).toBe(true);
        });

        it('handles out-of-order fragments', () => {
            reassembler = new Reassembler();
            const data = Buffer.alloc(MAX_PAYLOAD_SIZE * 3, 'Y');
            const packets = fragment(data);

            // Deliver in reverse order
            const reversed = [...packets].reverse();
            let result: Buffer | null = null;
            for (const packet of reversed) {
                result = reassembler.addFragment(packet);
            }
            expect(result).not.toBeNull();
            expect(result!.equals(data)).toBe(true);
        });

        it('deduplicates completed messages', () => {
            reassembler = new Reassembler();
            const packets = fragment(Buffer.from('dedup'));

            const result1 = reassembler.addFragment(packets[0]);
            expect(result1).not.toBeNull();

            // Same packet again
            const result2 = reassembler.addFragment(packets[0]);
            expect(result2).toBeNull();
        });

        it('ignores invalid fragment indices', () => {
            reassembler = new Reassembler();
            const packet = Buffer.alloc(HEADER_SIZE + 5);
            packet.writeUInt32BE(999, 0);
            packet.writeUInt16BE(5, 4); // index 5
            packet.writeUInt16BE(3, 6); // but only 3 total — invalid!
            packet.write('oops!', HEADER_SIZE);

            const result = reassembler.addFragment(packet);
            expect(result).toBeNull();
        });
    });
});
