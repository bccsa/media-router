import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Record every datagram with the (fake) wall-clock time it was sent at, so
// pacing behaviour is assertable without a real socket.
const sends: Array<{ bytes: number; at: number }> = [];
vi.mock('node:dgram', () => ({
    createSocket: () => ({
        on: () => {},
        bind: (cb: () => void) => cb(),
        setMulticastInterface: () => {},
        setMulticastTTL: () => {},
        setSendBufferSize: () => {},
        send: (buf: Buffer, _port: number, _host: string, cb?: () => void) => {
            sends.push({ bytes: buf.length, at: performance.now() });
            cb?.();
        },
        close: (cb: () => void) => cb(),
    }),
}));

import {
    PacedUdpTsSink,
    packetizeTs,
    TS_DATAGRAM_BYTES,
    TS_PACKET_BYTES,
} from './PacedUdpTsSink.js';

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

describe('PacedUdpTsSink drain loop', () => {
    beforeEach(() => {
        sends.length = 0;
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
        });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    const makeSink = () => new PacedUdpTsSink(41000, '239.255.0.1');

    /** One 10-second segment of 10 datagrams — 1 datagram per media-second. */
    const segment = () => Buffer.alloc(TS_DATAGRAM_BYTES * 10);

    it('sends the prefill window immediately, then paces at the media rate', async () => {
        const sink = makeSink();
        await sink.write(segment(), 10);

        // PREFILL_MS = 2 s back-dating → datagrams at media 0,1,2 s go out at once.
        await vi.advanceTimersByTimeAsync(5);
        expect(sends).toHaveLength(3);

        // One more datagram per second of wall time after that.
        await vi.advanceTimersByTimeAsync(1000);
        expect(sends).toHaveLength(4);
        await vi.advanceTimersByTimeAsync(6000);
        expect(sends).toHaveLength(10);
    });

    it('re-anchors after the queue runs dry — a long stall must not burst-send the next segment', async () => {
        const sink = makeSink();
        await sink.write(Buffer.alloc(TS_DATAGRAM_BYTES * 3), 3);
        await vi.advanceTimersByTimeAsync(1500);
        expect(sends).toHaveLength(3); // all within the prefill window

        // Source stalls far longer than the buffered media (CDN hiccup /
        // skip-on-stall jump). With the original one-shot anchor, everything
        // below would compute as "late" and burst out in one go.
        await vi.advanceTimersByTimeAsync(30_000);
        sends.length = 0;

        await sink.write(segment(), 10);
        // 15 ms: enough for the drain loop's 10 ms idle sleep to wake.
        await vi.advanceTimersByTimeAsync(15);
        expect(sends).toHaveLength(3); // prefill only — NOT all 10
        await vi.advanceTimersByTimeAsync(8000);
        expect(sends).toHaveLength(10);
    });

    it('back-pressures write() once more than the read-ahead window is buffered', async () => {
        const sink = makeSink();
        // 10 datagrams spanning 70 s of media (7 s apart) — after the head
        // drains in the prefill window, 63 s remain buffered: over the cap.
        let resolved = false;
        const p = sink
            .write(Buffer.alloc(TS_DATAGRAM_BYTES * 10), 70)
            .then(() => (resolved = true));

        await vi.advanceTimersByTimeAsync(5);
        expect(resolved).toBe(false); // blocked — buffer over the cap

        // Draining the next datagram (due at media 7 s) drops the buffered
        // window to 56 s — back under the cap, so the writer is released.
        await vi.advanceTimersByTimeAsync(6000);
        await p;
        expect(resolved).toBe(true);
        expect(sends.length).toBeGreaterThan(1);
    });

    it('end() flushes whole trailing TS packets and drops the partial tail', async () => {
        const sink = makeSink();
        // 1 full datagram + 1 whole packet + 50 stray bytes left over.
        await sink.write(Buffer.alloc(TS_DATAGRAM_BYTES + TS_PACKET_BYTES + 50), 0);
        const done = sink.end();
        await vi.advanceTimersByTimeAsync(200);
        await done;
        expect(sends.map((s) => s.bytes)).toEqual([TS_DATAGRAM_BYTES, TS_PACKET_BYTES]);
        expect(sink.bytesSent).toBe(TS_DATAGRAM_BYTES + TS_PACKET_BYTES);
    });

    it('write() after end() is a no-op', async () => {
        const sink = makeSink();
        const done = sink.end();
        await vi.advanceTimersByTimeAsync(100);
        await done;
        sends.length = 0;
        await sink.write(segment(), 10);
        await vi.advanceTimersByTimeAsync(1000);
        expect(sends).toHaveLength(0);
    });
});
