import { describe, it, expect, afterEach, vi } from 'vitest';
import { PacedTsSink, packetizeTs, TS_PACKET_BYTES } from './PacedTsSink.js';

/**
 * The pacing engine under fake timers, where the only thing that matters is
 * measurable: WHEN a datagram reaches the transport versus the media time it
 * carries.
 *
 * That difference is the producer's DELIVERY LEAD, and it is this sink's half
 * of the bus time contract (ADR-0005). Consumers hold the lead in their
 * `leaky=2 max-size-time=bufferMs` queues, and the fan-out sidecar's
 * `TimelineStamper` anchors the bus timeline ONCE and then cancels only the
 * margin's TREND, never its level (ts_timeline.py, "NO SETPOINT"). So the lead
 * has exactly one owner — this file — and exactly one bound, `PREFILL_MS`.
 *
 * `leadMs` below is `-marginNs` as that sidecar reports it, which is what makes
 * these numbers directly comparable to a burn-in log.
 */

/** The consumers' leaky-queue window on the .202 burn-in profile. */
const CONSUMER_QUEUE_MS = 3_000;

class TestSink extends PacedTsSink {
    /** `[wall ms at send, first byte]` for every datagram handed to the transport. */
    readonly sent: Array<{ atMs: number; byte: number }> = [];

    constructor() {
        // One TS packet per datagram, and `writeMedia` spans one media second
        // per packet — so a datagram's identifying byte IS its media second.
        super(TS_PACKET_BYTES);
    }
    protected async ensureReady(): Promise<void> {}
    protected sendNow(datagram: Buffer): void {
        this.sent.push({ atMs: performance.now(), byte: datagram[0]! });
    }
    protected async closeTransport(): Promise<void> {}
}

/**
 * Hand the sink `seconds` seconds of media in ONE write, as `seconds`
 * datagrams tagged `startByte..startByte+seconds-1`. One write covering many
 * seconds is the real shape: the extractor downloads ahead into the sink's
 * 60 s read-ahead buffer and the drain loop meters it out.
 *
 * The batch must exceed PREFILL_MS of media for any of this to be
 * interesting — until the sink has metered out more than the prefill it is
 * still BEHIND its own mapping (every datagram overdue, all sent at once), and
 * a sink that never gets ahead cannot show a lead at all.
 */
function writeMedia(sink: TestSink, startByte: number, seconds: number): void {
    const buf = Buffer.alloc(seconds * TS_PACKET_BYTES);
    for (let i = 0; i < seconds; i++) {
        buf.fill(startByte + i, i * TS_PACKET_BYTES, (i + 1) * TS_PACKET_BYTES);
    }
    void sink.write(buf, seconds);
}

/**
 * Let the drain loop run: it alternates `await sleep(...)` with microtasks, so
 * advancing the clock alone is not enough — each tick has to be handed back to
 * the event loop, which `advanceTimersByTimeAsync` does.
 */
const run = (ms: number): Promise<void> => vi.advanceTimersByTimeAsync(ms);

/**
 * How far AHEAD of 1x realtime the datagram for media second `m` went out, in
 * ms, measured from the first datagram's send — i.e. exactly what a downstream
 * stamper anchored on that first packet computes as `-(house - stamp)`.
 */
function leadMs(sink: TestSink, m: number): number {
    const first = sink.sent[0]!.atMs;
    const hit = sink.sent.find((s) => s.byte === m);
    if (!hit) throw new Error(`media second ${m} was never sent`);
    return first + m * 1000 - hit.atMs;
}

describe('packetizeTs', () => {
    it('slices whole datagrams and carries the partial tail forward', () => {
        const a = packetizeTs(Buffer.alloc(0), Buffer.alloc(TS_PACKET_BYTES + 50, 1), 188);
        expect(a.datagrams).toHaveLength(1);
        expect(a.remainder).toHaveLength(50);

        // The carried remainder is prepended to the next chunk, not dropped.
        const b = packetizeTs(a.remainder, Buffer.alloc(138, 2), 188);
        expect(b.datagrams).toHaveLength(1);
        expect(b.remainder).toHaveLength(0);
        expect(b.datagrams[0]![0]).toBe(1); // starts with the carried bytes
    });
});

describe('PacedTsSink pacing', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('meters a downloaded backlog out at media rate, one prefill ahead', async () => {
        vi.useFakeTimers();
        const sink = new TestSink();

        writeMedia(sink, 0, 6); // six seconds handed over at once
        await run(10_000);

        expect(sink.sent.map((s) => s.byte)).toEqual([0, 1, 2, 3, 4, 5]);
        // The backlog is NOT dumped: the prefill's worth goes straight out and
        // the rest is metered at 1x, leaving a steady PREFILL_MS of lead.
        expect(leadMs(sink, 5)).toBe(2_000);
    });

    /**
     * THE REGRESSION (.202, 2026-08-13). A dry spell shorter than the lead the
     * sink already held used to re-grant the whole prefill on top of it, and
     * the grants ACCUMULATED — nothing downstream gives lead back. Ordinary
     * segment-boundary hiccups walked the lead past the consumers' 3 s queue
     * window, after which the pre-decoder queue leaked every GOP for as long as
     * the route ran: DISCONT on a delta AU, keyframe gate re-armed, glass stuck
     * at 2-7 fps until the engine was restarted.
     */
    it('does not widen the lead when the queue runs dry briefly', async () => {
        vi.useFakeTimers();
        const sink = new TestSink();

        writeMedia(sink, 0, 6);
        await run(3_000); // media 0..5 are out; the queue is empty
        await run(100); // ...and stays dry for 100 ms

        writeMedia(sink, 6, 6);
        await run(6_000);

        // Media 6 keeps the mapping it would have had: 1x from media 5.
        // Pre-fix the dry spell re-anchored ~2.9 s earlier and media 6 went
        // out the instant it arrived, taking the lead to 2.9 s with it.
        expect(leadMs(sink, 6)).toBe(2_000);
        expect(leadMs(sink, 11)).toBe(2_000);
    });

    it('holds the lead clear of the consumers queue window over many hiccups', async () => {
        vi.useFakeTimers();
        const sink = new TestSink();

        writeMedia(sink, 0, 6);
        await run(3_000);
        for (let i = 1; i <= 3; i++) {
            await run(100); // dry between downloads
            writeMedia(sink, i * 6, 6);
            await run(6_000);
        }

        // Every hiccup used to compound. .202 runs bufferMs=3000, and a lead
        // past that leaks a chunk out of the pre-decoder queue every GOP.
        expect(leadMs(sink, 23)).toBeLessThan(CONSUMER_QUEUE_MS);
        expect(leadMs(sink, 23)).toBe(2_000);
    });

    it('re-anchors FORWARD after a stall longer than the prefill', async () => {
        vi.useFakeTimers();
        const sink = new TestSink();

        writeMedia(sink, 0, 4);
        await run(2_000);

        // Source gone for 10 s. The mapping MUST move forward: held where it
        // was, the whole backlog reads as 10 s late and gets burst-sent at
        // line speed — the receiver overflow this sink exists to prevent.
        await run(10_000);
        writeMedia(sink, 4, 6);
        await run(6_000);

        expect(sink.sent.map((s) => s.byte)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        // Catch-up is bounded by the prefill, not by the length of the stall:
        // one prefill of media goes straight out, then 1x resumes.
        const at = (m: number): number => sink.sent.find((s) => s.byte === m)!.atMs;
        expect(at(6) - at(4)).toBe(0); // media 4,5,6 together
        expect(at(7) - at(6)).toBe(1_000); // then metered
        // And the recovered lead is exactly one prefill, no more.
        expect(at(4) + 5_000 - at(9)).toBe(2_000);
    });
});
