import { describe, it, expect, vi, afterEach } from 'vitest';
import * as dgram from 'dgram';
import { Socket } from './Socket.js';
import { FragmentTransport } from './FragmentTransport.js';
import { SeqDedup } from './SeqDedup.js';

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
        const ackSpy = vi.spyOn(s as unknown as { sendAck: (id: number) => void }, 'sendAck');
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
        const ackSpy = vi.spyOn(s as unknown as { sendAck: (id: number) => void }, 'sendAck');
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

describe('Socket reset handling', () => {
    let udp: dgram.Socket;
    let tx: FragmentTransport;
    let s: Socket;

    afterEach(() => {
        s?.disconnect();
        tx?.destroy();
        udp?.close();
    });

    const makeSocket = (isClient = true) => {
        udp = dgram.createSocket('udp4');
        tx = new FragmentTransport(udp);
        s = new Socket({
            port: 1,
            address: '127.0.0.1',
            transport: tx,
            isClient,
            clientID: 'test',
            encryptionKey: 'k',
            connectionTimeout: 500,
        });
        return s;
    };

    const connectClient = (socketID: string) => {
        s.handleMessage({
            type: 'connected',
            clientID: 'test',
            data: { socketID },
        } as Parameters<Socket['handleMessage']>[0]);
    };

    const resetMsg = (socketID: string) =>
        ({
            type: 'reset',
            clientID: 'test',
            data: { socketID },
        }) as Parameters<Socket['handleMessage']>[0];

    it('reset naming our current socketID disconnects a connected client socket', () => {
        makeSocket();
        connectClient('sock-a');
        const spy = vi.fn();
        s.on('disconnected', spy);

        s.handleMessage(resetMsg('sock-a'));

        expect(s.destroyed).toBe(true);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('reset naming a different socketID is ignored (stale duplicate / spoof)', () => {
        makeSocket();
        connectClient('sock-a');

        s.handleMessage(resetMsg('sock-old'));

        expect(s.destroyed).toBe(false);
        expect(s.connected).toBe(true);
    });

    it('reset is ignored on a server-side socket', () => {
        makeSocket(false);
        s.connected = true;
        s.markConnected();

        s.handleMessage(resetMsg(s.socketID));

        expect(s.destroyed).toBe(false);
    });
});

describe('Socket watchdog event-loop-lag guard', () => {
    let udp: dgram.Socket;
    let tx: FragmentTransport;
    let s: Socket;

    afterEach(() => {
        s?.disconnect();
        tx?.destroy();
        udp?.close();
        vi.useRealTimers();
    });

    const makeSocket = () => {
        vi.useFakeTimers();
        udp = dgram.createSocket('udp4');
        tx = new FragmentTransport(udp);
        s = new Socket({
            port: 1,
            address: '127.0.0.1',
            transport: tx,
            isClient: false,
            clientID: 'test',
            encryptionKey: 'k',
            connectionTimeout: 2000, // watchdog interval = 500ms
            missedKeepaliveThreshold: 3,
        });
        s.connected = true;
        s.markConnected();
        return s;
    };

    it('a late tick (event-loop stall) does not count as missed keepalives', () => {
        makeSocket();

        // Simulate a 10s stall: the clock jumps but no ticks ran meanwhile —
        // inbound packets sat unread, so the silence is our fault. The first
        // tick after the stall sees itself 10s late and must restart the
        // measurement; without the guard, ticks at +500/+1000/+1500 all see
        // >2000ms of "silence" and hit the 3-miss threshold.
        vi.setSystemTime(Date.now() + 10_000);
        vi.advanceTimersByTime(1600);

        expect(s.destroyed).toBe(false);
        expect(s.connected).toBe(true);
    });

    it('genuine peer silence still disconnects at the threshold', () => {
        makeSocket();

        // Ticks run on time (never late) with no inbound traffic:
        // silence > 2000ms from t=2500, misses at 2500/3000/3500 → disconnect.
        vi.advanceTimersByTime(3600);

        expect(s.destroyed).toBe(true);
    });
});

describe('Socket multi-path', () => {
    const sockets: Socket[] = [];
    const udps: dgram.Socket[] = [];

    afterEach(() => {
        for (const s of sockets.splice(0)) s.disconnect();
        for (const u of udps.splice(0)) u.close();
        vi.useRealTimers();
    });

    const tx = () => {
        const udp = dgram.createSocket('udp4');
        udps.push(udp);
        return new FragmentTransport(udp);
    };
    const make = (opts: Partial<ConstructorParameters<typeof Socket>[0]> = {}) => {
        const s = new Socket({
            port: 1,
            address: '10.0.0.1',
            transport: tx(),
            clientID: 'c',
            encryptionKey: 'k',
            connectionTimeout: 1000,
            missedKeepaliveThreshold: 3,
            ...opts,
        });
        sockets.push(s);
        return s;
    };
    const dataMsg = (socketID: string, seq: number) =>
        ({
            type: 'data',
            clientID: 'c',
            seq,
            data: { topic: 't', message: seq, socketID },
        }) as Parameters<Socket['handleMessage']>[0];

    it('fans a send out to every endpoint through its own transport', () => {
        const s = make();
        const t2 = tx();
        s.touchEndpoint(t2, 2, '10.0.2.1');
        const spy1 = vi
            .spyOn(s['endpoints'].get('10.0.0.1:1')!.transport, 'send')
            .mockReturnValue(1);
        const spy2 = vi.spyOn(t2, 'send').mockReturnValue(2);

        s.send('cfg', { a: 1 });

        expect(spy1).toHaveBeenCalledWith(expect.any(Buffer), 1, '10.0.0.1', false);
        expect(spy2).toHaveBeenCalledWith(expect.any(Buffer), 2, '10.0.2.1', false);
        // Same seq on both copies
        const seq1 = JSON.parse((spy1.mock.calls[0][0] as Buffer).toString()).seq;
        const seq2 = JSON.parse((spy2.mock.calls[0][0] as Buffer).toString()).seq;
        expect(seq1).toBe(seq2);
    });

    it('sendToEndpoint reaches only the named endpoint', () => {
        const s = make();
        const t2 = tx();
        s.touchEndpoint(t2, 2, '10.0.2.1');
        const spy1 = vi
            .spyOn(s['endpoints'].get('10.0.0.1:1')!.transport, 'send')
            .mockReturnValue(1);
        const spy2 = vi.spyOn(t2, 'send').mockReturnValue(2);
        s.sendToEndpoint('10.0.2.1', 2, 'connected', 'id', { type: 'connected' });
        expect(spy1).not.toHaveBeenCalled();
        expect(spy2).toHaveBeenCalledTimes(1);
    });

    it('prunes an endpoint silent for a full death window, never the last one', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-23T10:00:00Z'));
        const s = make();
        s.markConnected();
        s.touchEndpoint(tx(), 2, '10.0.2.1');
        const down = vi.fn();
        s.on('pathDown', down);
        vi.spyOn(s['endpoints'].get('10.0.0.1:1')!.transport, 'send').mockReturnValue(0);
        vi.spyOn(s['endpoints'].get('10.0.2.1:2')!.transport, 'send').mockReturnValue(0);

        // Keep endpoint 1 alive, let endpoint 2 fall silent past 3 × 1000 ms.
        for (let i = 0; i < 16; i++) {
            vi.advanceTimersByTime(250);
            s.touchEndpoint(s['endpoints'].get('10.0.0.1:1')!.transport, 1, '10.0.0.1');
            s.resetKeepalive();
        }
        expect(down).toHaveBeenCalledWith('10.0.2.1:2');
        expect(s.endpointKeys).toEqual(['10.0.0.1:1']);

        // The sole remaining endpoint is never pruned by silence alone.
        vi.advanceTimersByTime(250);
        s.resetKeepalive();
        expect(s.endpointKeys).toEqual(['10.0.0.1:1']);
        expect(s.destroyed).toBe(false);
    });

    it('a shared SeqDedup collapses the same (session, seq) across two path sockets', () => {
        const shared = new SeqDedup();
        const a = make({ isClient: true, seqDedup: shared });
        const b = make({ isClient: true, seqDedup: shared });
        const got: number[] = [];
        a.on('data', (_t: string, m: number) => got.push(m));
        b.on('data', (_t: string, m: number) => got.push(m));

        a.handleMessage(dataMsg('srv', 1));
        b.handleMessage(dataMsg('srv', 1)); // bonded copy via the other path
        b.handleMessage(dataMsg('srv', 2));
        a.handleMessage(dataMsg('srv', 2));

        expect(got).toEqual([1, 2]);
        // A path dying must not wipe the Client's table.
        a.disconnect();
        expect(shared.size).toBe(2);
    });

    it('dedup keys on the sending session, so a new session restarting at seq 1 is delivered', () => {
        const s = make({ isClient: true });
        const got: unknown[] = [];
        s.on('data', (_t: string, m: unknown) => got.push(m));
        s.handleMessage(dataMsg('session-A', 1));
        s.handleMessage(dataMsg('session-B', 1));
        expect(got).toHaveLength(2);
    });

    it('endpointInfo carries the local listener port per endpoint', () => {
        const s = make({ localPort: 3000 });
        s.touchEndpoint(tx(), 2, '10.0.2.1', 3002);
        expect(s.endpointInfo.map((e) => [e.address, e.port, e.localPort])).toEqual([
            ['10.0.0.1', 1, 3000],
            ['10.0.2.1', 2, 3002],
        ]);
    });
});
