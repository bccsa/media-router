import { describe, it, expect } from 'vitest';
import { packetizeTs, TS_DATAGRAM_BYTES, TS_PACKET_BYTES } from './udpTsSink.js';

describe('packetizeTs', () => {
    it('emits whole 1316-byte datagrams and carries the remainder forward', () => {
        const chunk = Buffer.alloc(TS_DATAGRAM_BYTES * 2 + 100);
        const { datagrams, remainder } = packetizeTs(Buffer.alloc(0), chunk);
        expect(datagrams).toHaveLength(2);
        expect(datagrams.every((d) => d.length === TS_DATAGRAM_BYTES)).toBe(true);
        expect(remainder.length).toBe(100);
    });

    it('prepends leftover bytes to the next chunk', () => {
        const leftover = Buffer.alloc(200);
        const chunk = Buffer.alloc(TS_DATAGRAM_BYTES); // 200 + 1316 = 1516 → one datagram + 200 remainder
        const { datagrams, remainder } = packetizeTs(leftover, chunk);
        expect(datagrams).toHaveLength(1);
        expect(datagrams[0]!.length).toBe(TS_DATAGRAM_BYTES);
        expect(remainder.length).toBe(200);
    });

    it('buffers sub-datagram input without emitting', () => {
        const { datagrams, remainder } = packetizeTs(Buffer.alloc(0), Buffer.alloc(500));
        expect(datagrams).toHaveLength(0);
        expect(remainder.length).toBe(500);
    });

    it('every datagram is a whole multiple of a TS packet', () => {
        const { datagrams } = packetizeTs(Buffer.alloc(0), Buffer.alloc(TS_DATAGRAM_BYTES * 3));
        expect(datagrams.every((d) => d.length % TS_PACKET_BYTES === 0)).toBe(true);
    });
});
