import { describe, it, expect, afterEach } from 'vitest';
import * as dgram from 'dgram';
import { FragmentTransport } from './FragmentTransport.js';
import {
    fragment,
    fragmentWithId,
    encodeNack,
    parseFragmentHeader,
    MAX_PAYLOAD_SIZE,
    HEADER_SIZE,
} from './fragmentation.js';

const rinfo = (address = '1.1.1.1', port = 1): dgram.RemoteInfo =>
    ({ address, port, family: 'IPv4', size: 0 }) as dgram.RemoteInfo;

/** A stand-in udp socket that records outgoing packets. */
function fakeSock() {
    const sent: Array<{ buf: Buffer; port: number; address: string }> = [];
    const sock = {
        send: (buf: Buffer, port: number, address: string) => {
            sent.push({ buf, port, address });
        },
    } as unknown as dgram.Socket;
    return { sock, sent };
}

describe('FragmentTransport', () => {
    let t: FragmentTransport;
    let t2: FragmentTransport;
    afterEach(() => {
        t?.destroy();
        t2?.destroy();
    });

    describe('reassembly', () => {
        it('returns payload immediately for single-fragment messages', () => {
            t = new FragmentTransport(fakeSock().sock);
            const [p] = fragment(Buffer.from('simple'));
            expect(t.receive(p, rinfo())!.toString()).toBe('simple');
        });

        it('reassembles multi-fragment messages', () => {
            t = new FragmentTransport(fakeSock().sock);
            const data = Buffer.alloc(MAX_PAYLOAD_SIZE * 2 + 50, 'X');
            let result: Buffer | null = null;
            for (const p of fragment(data)) result = t.receive(p, rinfo());
            expect(result!.equals(data)).toBe(true);
        });

        it('handles out-of-order fragments', () => {
            t = new FragmentTransport(fakeSock().sock);
            const data = Buffer.alloc(MAX_PAYLOAD_SIZE * 3, 'Y');
            let result: Buffer | null = null;
            for (const p of [...fragment(data)].reverse()) result = t.receive(p, rinfo());
            expect(result!.equals(data)).toBe(true);
        });

        it('re-delivers a retransmitted single-fragment message (Socket re-ACKs it)', () => {
            // Transport-level dedup of resends starved the Socket's re-ACK:
            // one lost ACK made a guaranteed message permanently
            // unacknowledgeable. Dedup lives in the Socket (seq), which acks
            // every copy first — so the transport must pass resends through.
            t = new FragmentTransport(fakeSock().sock);
            const [p] = fragment(Buffer.from('resend'));
            expect(t.receive(p, rinfo())).not.toBeNull();
            expect(t.receive(p, rinfo())).not.toBeNull();
        });

        it('keeps a reused messageId from different sources separate', () => {
            t = new FragmentTransport(fakeSock().sock);
            const data = Buffer.alloc(MAX_PAYLOAD_SIZE * 2, 'Q');
            const packets = fragment(data); // both packets share one messageId
            // frag0 from source A, frag1 from source B — must NOT combine
            expect(t.receive(packets[0], rinfo('10.0.0.1', 5))).toBeNull();
            expect(t.receive(packets[1], rinfo('10.0.0.2', 6))).toBeNull();
            // source A completes with its own frag1, independent of B
            expect(t.receive(packets[1], rinfo('10.0.0.1', 5))!.equals(data)).toBe(true);
        });

        it('ignores invalid fragment indices', () => {
            t = new FragmentTransport(fakeSock().sock);
            const packet = Buffer.alloc(HEADER_SIZE + 5);
            packet.writeUInt32BE(999, 0);
            packet.writeUInt16BE(5, 4); // index 5
            packet.writeUInt16BE(3, 6); // of only 3 — invalid
            expect(t.receive(packet, rinfo())).toBeNull();
        });
    });

    describe('fragment-level retransmit', () => {
        it('NACKs only the missing fragment; sender resends just that one', async () => {
            const sender = fakeSock();
            const receiver = fakeSock();
            t = new FragmentTransport(sender.sock, { nackDelayMs: 30 });
            t2 = new FragmentTransport(receiver.sock, { nackDelayMs: 30 });

            const data = Buffer.alloc(MAX_PAYLOAD_SIZE * 3, 'F');
            t.send(data, 1, '2.2.2.2', true); // reliable → fragments recorded + retained
            const frags = sender.sent.map((s) => s.buf);
            expect(frags.length).toBe(3);

            // receiver gets frag 0 and 2 — frag 1 "lost"
            expect(t2.receive(frags[0], rinfo())).toBeNull();
            expect(t2.receive(frags[2], rinfo())).toBeNull();

            // after the quiet gap, receiver NACKs the missing fragment
            await new Promise((r) => setTimeout(r, 60));
            const nack = receiver.sent[receiver.sent.length - 1]?.buf;
            expect(nack).toBeDefined();

            // sender resends ONLY the missing fragment (not the whole message),
            // and only because the NACK came from the endpoint it sent to
            const before = sender.sent.length;
            t.receive(nack!, rinfo('2.2.2.2', 1));
            const resent = sender.sent.slice(before);
            expect(resent.length).toBe(1);

            // delivering it completes the message intact
            const done = t2.receive(resent[0].buf, rinfo());
            expect(done).not.toBeNull();
            expect(done!.equals(data)).toBe(true);
        });

        it('resend() re-sends every retained fragment (total-loss fallback)', () => {
            const sender = fakeSock();
            t = new FragmentTransport(sender.sock);
            const data = Buffer.alloc(MAX_PAYLOAD_SIZE * 2, 'G');
            const mid = t.send(data, 1, 'a', true);
            const n = sender.sent.length;
            t.resend(mid, 1, 'a');
            expect(sender.sent.length).toBe(n * 2);
        });

        it('release() drops retained fragments so resend/NACK do nothing', () => {
            const sender = fakeSock();
            t = new FragmentTransport(sender.sock);
            const data = Buffer.alloc(MAX_PAYLOAD_SIZE * 2, 'H');
            const mid = t.send(data, 1, 'a', true);
            t.release(mid);
            const n = sender.sent.length;
            t.resend(mid, 1, 'a');
            expect(sender.sent.length).toBe(n); // nothing retained → no resend
        });

        it('does not retain unreliable messages', () => {
            const sender = fakeSock();
            t = new FragmentTransport(sender.sock);
            const mid = t.send(Buffer.alloc(MAX_PAYLOAD_SIZE * 2, 'U'), 1, 'a', false);
            const n = sender.sent.length;
            t.resend(mid, 1, 'a');
            expect(sender.sent.length).toBe(n);
        });

        it('ignores a NACK from any endpoint other than the one it sent to', () => {
            // Reflection/amplification guard: a spoofed-source NACK must not make
            // us blast retained fragments at an arbitrary victim.
            const sender = fakeSock();
            t = new FragmentTransport(sender.sock);
            const mid = t.send(Buffer.alloc(MAX_PAYLOAD_SIZE * 2, 'S'), 5, '9.9.9.9', true);
            const before = sender.sent.length;

            // spoofed source → ignored
            t.receive(encodeNack(mid, [0]), rinfo('6.6.6.6', 66));
            expect(sender.sent.length).toBe(before);

            // genuine peer → served
            t.receive(encodeNack(mid, [0]), rinfo('9.9.9.9', 5));
            expect(sender.sent.length).toBe(before + 1);
        });

        it('caps consecutive NACKs when the sender never answers', async () => {
            const receiver = fakeSock();
            t2 = new FragmentTransport(receiver.sock, { nackDelayMs: 10, maxNackAttempts: 3 });
            const packets = fragment(Buffer.alloc(MAX_PAYLOAD_SIZE * 2, 'C'));
            // deliver only frag 0 — frag 1 missing, and nobody answers the NACKs
            t2.receive(packets[0], rinfo());
            await new Promise((r) => setTimeout(r, 120));
            const nacks = receiver.sent.filter(
                (s) => parseFragmentHeader(s.buf)!.fragmentCount === 0,
            );
            expect(nacks.length).toBe(3); // capped at maxNackAttempts, not ~unbounded
        });

        it('re-assembles a full resend of a completed multi-fragment message', () => {
            // The sender's fallback resend replays every retained fragment with
            // the same messageId. After completion the rx entry is gone, so the
            // resend re-assembles from scratch and is re-delivered — giving the
            // Socket another chance to ACK when the first ACK was lost.
            t = new FragmentTransport(fakeSock().sock);
            const data = Buffer.alloc(MAX_PAYLOAD_SIZE * 2, 'R');
            const { packets } = fragmentWithId(data);
            let first: Buffer | null = null;
            for (const p of packets) first = t.receive(p, rinfo());
            expect(first!.equals(data)).toBe(true);

            let second: Buffer | null = null;
            for (const p of packets) second = t.receive(p, rinfo());
            expect(second!.equals(data)).toBe(true);
        });
    });
});
