import { describe, it, expect, vi, afterEach } from 'vitest';
import * as dgram from 'dgram';
import { Socket } from './Socket.js';
import { FragmentTransport } from './FragmentTransport.js';

/**
 * Sequence-number dedup replaced an earlier receive-time content hash that
 * dropped any two messages sharing the same (topic, JSON) inside one 500ms
 * wall-clock bucket — which happened whenever high latency bunched packets
 * into a burst. These tests pin the identity-based behaviour.
 */
describe('Socket seq-based dedup', () => {
    let udp: dgram.Socket;
    let tx: FragmentTransport;
    let s: Socket;

    afterEach(() => {
        s?.disconnect();
        tx?.destroy();
        udp?.close();
    });

    const makeSocket = () => {
        udp = dgram.createSocket('udp4');
        tx = new FragmentTransport(udp);
        s = new Socket({
            port: 1,
            address: '127.0.0.1',
            transport: tx,
            isClient: true,
            clientID: 'test',
            encryptionKey: 'k',
            connectionTimeout: 500,
        });
        return s;
    };

    const dataMsg = (seq: number | undefined, message: unknown) =>
        ({
            type: 'data',
            clientID: 'test',
            seq,
            data: { topic: 't', message },
        }) as Parameters<Socket['handleMessage']>[0];

    it('delivers a duplicate seq (retransmit / bonded path copy) only once', () => {
        makeSocket();
        const spy = vi.fn();
        s.on('data', spy);

        s.handleMessage(dataMsg(1, { v: 1 }));
        s.handleMessage(dataMsg(1, { v: 1 }));

        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('delivers distinct messages with identical content (no content-hash false-drop)', () => {
        makeSocket();
        const spy = vi.fn();
        s.on('data', spy);

        // Same payload, distinct seqs — the old dedup wrongly dropped the second.
        s.handleMessage(dataMsg(2, { level: 0 }));
        s.handleMessage(dataMsg(3, { level: 0 }));
        s.handleMessage(dataMsg(4, { level: 0 }));

        expect(spy).toHaveBeenCalledTimes(3);
    });

    it('still ACKs a duplicate so the sender stops retransmitting', () => {
        makeSocket();
        const ackSpy = vi.spyOn(
            s as unknown as { sendAck: (id: number) => void },
            'sendAck',
        );
        const dataSpy = vi.fn();
        s.on('data', dataSpy);

        const guaranteed = () =>
            ({
                type: 'data',
                clientID: 'test',
                seq: 5,
                data: { topic: 't', message: { v: 1 }, ackID: 99 },
            }) as Parameters<Socket['handleMessage']>[0];

        s.handleMessage(guaranteed());
        s.handleMessage(guaranteed());

        // Delivered once, but acked both times.
        expect(dataSpy).toHaveBeenCalledTimes(1);
        expect(ackSpy).toHaveBeenCalledTimes(2);
        expect(ackSpy).toHaveBeenCalledWith(99);
    });

    it('delivers messages that carry no seq (backward compatible)', () => {
        makeSocket();
        const spy = vi.fn();
        s.on('data', spy);

        s.handleMessage(dataMsg(undefined, { v: 1 }));
        s.handleMessage(dataMsg(undefined, { v: 1 }));

        expect(spy).toHaveBeenCalledTimes(2);
    });

    it('ACKs the guaranteed connected handshake — every copy, but connects once', () => {
        makeSocket();
        const ackSpy = vi.spyOn(
            s as unknown as { sendAck: (id: number) => void },
            'sendAck',
        );
        const connSpy = vi.fn();
        s.on('connected', connSpy);

        const connectedMsg = () =>
            ({
                type: 'connected',
                clientID: 'test',
                data: { message: 'sock-id-1', ackID: 7, socketID: 'sock-id-1' },
            }) as Parameters<Socket['handleMessage']>[0];

        s.handleMessage(connectedMsg());
        s.handleMessage(connectedMsg()); // server resend (its ACK was lost)

        // The server sends 'connected' guaranteed — without these ACKs every
        // handshake retransmitted 10x and hit GIVE-UP even on a clean link.
        expect(ackSpy).toHaveBeenCalledTimes(2);
        expect(ackSpy).toHaveBeenCalledWith(7);
        expect(s.socketID).toBe('sock-id-1');
        expect(s.connected).toBe(true);
        expect(connSpy).toHaveBeenCalledTimes(1); // no re-emit on the resend
    });
});
