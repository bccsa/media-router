import { afterAll, describe, expect, it, vi } from 'vitest';
import { PaCommandQueue } from './PaCommandQueue.js';
import { installFakePactl } from './testing/fakePactl.js';

// B-200: pactl as a child that never blocks the event loop, against a stand-in first on PATH.
const fake = installFakePactl();
afterAll(() => fake?.remove());

/** Runs `call` while a `everyMs` timer ticks: its result, and how late the latest tick came. */
async function whileTicking<T>(call: () => Promise<T>, everyMs = 20) {
    const t0 = performance.now();
    let last = t0;
    let worstLateMs = 0;
    let ticks = 0;
    const timer = setInterval(() => {
        const now = performance.now();
        worstLateMs = Math.max(worstLateMs, now - last - everyMs);
        last = now;
        ticks += 1;
    }, everyMs);
    try {
        const result = await call().then(
            (value) => ({ value, error: null }),
            (error: Error) => ({ value: null, error }),
        );
        return { ...result, tookMs: performance.now() - t0, worstLateMs, ticks };
    } finally {
        clearInterval(timer);
    }
}

describe.skipIf(fake === null)('PaCommandQueue: pactl never blocks the engine (B-200)', () => {
    it('no answer: the call fails at its timeout as no answer, and timers fire on time meanwhile', async () => {
        fake!.mode('hang');
        const pa = new PaCommandQueue(0, 600);
        const r = await whileTicking(() => pa.execImmediateAsync(['list', 'sources']));
        expect(r.error?.message).toBe(
            'pactl command failed: pactl list sources\nno answer within 600 ms',
        );
        expect(r.tookMs).toBeGreaterThanOrEqual(590);
        // A synchronous call would hold every timer for the whole 600 ms.
        expect(r.ticks).toBeGreaterThanOrEqual(10);
        expect(r.worstLateMs).toBeLessThan(400);
    });

    it("pactl's own end on SIGTERM (0, no output) is no answer, never an empty one", async () => {
        // The stand-in traps SIGTERM as pactl does; a timeout's SIGTERM would read as success.
        fake!.mode('hang');
        const pa = new PaCommandQueue(0, 300);
        await expect(pa.execImmediateAsync(['info'])).rejects.toThrow(/no answer within 300 ms/);
    });

    it('a late answer inside the timeout is the answer, and timers fire meanwhile', async () => {
        fake!.mode('late', 0.8);
        fake!.sources('Source #1\n\tName: alsa_input.usb-mic');
        const pa = new PaCommandQueue(0, 3000);
        const r = await whileTicking(() => pa.execImmediateAsync(['list', 'sources']));
        expect(r.value).toBe('Source #1\n\tName: alsa_input.usb-mic');
        expect(r.tookMs).toBeGreaterThanOrEqual(790);
        expect(r.ticks).toBeGreaterThanOrEqual(15);
        expect(r.worstLateMs).toBeLessThan(400);
    });

    it("a queued command's caches drop before its caller goes on, as before", async () => {
        fake!.mode('answer');
        const pa = new PaCommandQueue(0, 3000);
        const order: string[] = [];
        pa.onMutation = () => order.push('caches dropped');
        await pa.exec(['set-sink-volume', 'alsa_output.usb-dac', '65536']);
        order.push('caller');
        expect(order).toEqual(['caches dropped', 'caller']);
    });

    it('a queued command with no answer fails at its timeout; the queue then runs the next', async () => {
        fake!.mode('hang');
        const pa = new PaCommandQueue(0, 300);
        const mutated = vi.fn();
        pa.onMutation = mutated;
        const unload = pa.exec(['unload-module', '536870912']).then(
            () => 'answered',
            (e: Error) => e.message,
        );
        const info = pa.exec(['info']);
        // The stand-in reads its mode before it logs the call: from here the first one hangs.
        await vi.waitFor(() => expect(fake!.calls()).toContain('unload-module 536870912'));
        fake!.mode('answer');
        expect(await unload).toBe(
            'pactl command failed: pactl unload-module 536870912\nno answer within 300 ms',
        );
        expect(await info).toContain('Cookie: f196:62ca');
        expect(mutated).toHaveBeenCalledTimes(2);
    });
});
