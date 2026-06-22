import { describe, it, expect } from 'vitest';
import { classifyDatagram, sniffEncapsulation } from './detectEncapsulation.js';
import * as dgram from 'node:dgram';

describe('classifyDatagram', () => {
    it('classifies a datagram starting with the TS sync byte as raw', () => {
        const buf = Buffer.alloc(188);
        buf[0] = 0x47;
        expect(classifyDatagram(buf)).toBe('raw');
    });

    it('classifies an RTP v2 datagram with sync byte at offset 12 as rtp', () => {
        const buf = Buffer.alloc(200);
        buf[0] = 0x80; // RTP version 2, no padding/extension
        buf[1] = 33; // payload type 33 (MP2T)
        buf[12] = 0x47; // TS sync byte after the 12-byte RTP header
        expect(classifyDatagram(buf)).toBe('rtp');
    });

    it('returns null for an empty datagram', () => {
        expect(classifyDatagram(Buffer.alloc(0))).toBeNull();
    });

    it('returns null when neither raw nor RTP shape matches', () => {
        const buf = Buffer.from([0x00, 0x01, 0x02, 0x03]);
        expect(classifyDatagram(buf)).toBeNull();
    });

    it('does not misread a short RTP-looking buffer with no sync byte', () => {
        const buf = Buffer.alloc(13);
        buf[0] = 0x80;
        buf[12] = 0x00; // not 0x47
        expect(classifyDatagram(buf)).toBeNull();
    });
});

describe('sniffEncapsulation', () => {
    it('returns null on timeout when no packet arrives', async () => {
        const result = await sniffEncapsulation({ port: 0, timeoutMs: 50 });
        // port 0 = ephemeral; nothing is sent, so it times out
        expect(result).toBeNull();
    });

    it('classifies the first datagram received on the bound port', async () => {
        // Bind a throwaway socket to claim a free port, read it, then release
        // it so the sniffer can bind the same port.
        const probe = dgram.createSocket('udp4');
        const port = await new Promise<number>((resolve) => {
            probe.bind(0, '127.0.0.1', () => resolve(probe.address().port));
        });
        await new Promise<void>((resolve) => probe.close(() => resolve()));

        const sniff = sniffEncapsulation({ port, timeoutMs: 1000 });

        // Give the sniffer a moment to bind, then send a raw-TS datagram.
        const sender = dgram.createSocket('udp4');
        const tsPacket = Buffer.alloc(188);
        tsPacket[0] = 0x47;
        await new Promise((r) => setTimeout(r, 100));
        sender.send(tsPacket, port, '127.0.0.1');

        const result = await sniff;
        sender.close();
        expect(result).toBe('raw');
    });
});
