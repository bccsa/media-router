import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    kernelLogSignalEvent,
    kernelLogWatchMode,
    kmsgMessageText,
    matchKernelLogSignal,
    offKernelLogSignal,
    onKernelLogSignal,
    resetKernelLogWatch,
    startKernelLogWatch,
    KERNEL_LOG_SIGNALS,
    type KernelLogSignalEvent,
} from './kernelLogWatch.js';

/** The line the patched rpi HEVC driver prints, envelope and all. */
const LATCH_RECORD =
    '3,842,141592653,-;rpi-hevc-dec: phase1 stuck - hardware decode disabled until reboot\n';

/** Ordinary traffic the watcher must read past without reacting. */
const NOISE = [
    '6,1,0,-;Booting Linux on physical CPU 0x0000000000\n',
    '4,700,141000000,-;rpi-hevc-dec: phase1 stuck - abandoning sync, hardware may need reset\n',
    '6,701,141000001,-;rpi-hevc-dec: hardware decode enabled\n',
].join('');

describe('kernelLogWatch', () => {
    let tmp: string;
    let kmsgPath: string;

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-kmsg-'));
        kmsgPath = path.join(tmp, 'kmsg');
        resetKernelLogWatch();
    });

    afterEach(() => {
        resetKernelLogWatch();
        vi.useRealTimers();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    describe('kmsgMessageText', () => {
        it('drops the record envelope up to the first semicolon', () => {
            expect(kmsgMessageText(LATCH_RECORD.trimEnd())).toBe(
                'rpi-hevc-dec: phase1 stuck - hardware decode disabled until reboot',
            );
        });

        it('keeps a semicolon that belongs to the message text', () => {
            // Only the FIRST semicolon is the envelope terminator.
            expect(kmsgMessageText('3,1,2,-;a; b')).toBe('a; b');
        });

        it('passes a line with no envelope through (dmesg output, continuations)', () => {
            expect(kmsgMessageText('[  141.592] rpi-hevc-dec: something')).toBe(
                '[  141.592] rpi-hevc-dec: something',
            );
        });
    });

    describe('matchKernelLogSignal', () => {
        it('spots the driver latch line', () => {
            expect(
                matchKernelLogSignal(
                    'rpi-hevc-dec: phase1 stuck - hardware decode disabled until reboot',
                ),
            ).toBe('hevc-decode-disabled');
        });

        it('spots a reworded latch line by device name plus verdict', () => {
            // The middle of the sentence is the driver's to change; the device
            // and "disabled until reboot" are the load-bearing parts.
            expect(matchKernelLogSignal('rpi-hevc-dec: block dead, disabled until reboot')).toBe(
                'hevc-decode-disabled',
            );
        });

        it('ignores the RECOVERABLE stuck line from the same driver', () => {
            // "abandoning sync" is the bounded-teardown path: the block is reset
            // and decode carries on. Latching on it would give up hardware
            // decode for the boot over a fault the driver just handled.
            expect(
                matchKernelLogSignal(
                    'rpi-hevc-dec: phase1 stuck - abandoning sync, hardware may need reset',
                ),
            ).toBeUndefined();
        });

        it('ignores unrelated kernel chatter', () => {
            for (const line of [
                'Booting Linux on physical CPU 0x0000000000',
                'rpi-hevc-dec: probe of 1000800000.codec succeeded',
                'usb 1-1: new high-speed USB device number 2',
            ]) {
                expect(matchKernelLogSignal(line)).toBeUndefined();
            }
        });
    });

    describe('backlog', () => {
        it('sees a line printed before the watch started', () => {
            // The whole point: the driver latches once, and the engine may well
            // be starting AFTER it did.
            fs.writeFileSync(kmsgPath, NOISE + LATCH_RECORD);
            const seen: KernelLogSignalEvent[] = [];
            startKernelLogWatch({ kmsgPath });
            onKernelLogSignal('hevc-decode-disabled', (e) => seen.push(e));

            expect(seen).toHaveLength(1);
            expect(seen[0]).toEqual({
                signal: 'hevc-decode-disabled',
                source: 'kmsg',
                line: 'rpi-hevc-dec: phase1 stuck - hardware decode disabled until reboot',
            });
        });

        it('replays the latched event to a subscriber that arrives later still', () => {
            fs.writeFileSync(kmsgPath, LATCH_RECORD);
            startKernelLogWatch({ kmsgPath });
            const first = vi.fn();
            onKernelLogSignal('hevc-decode-disabled', first);
            const second = vi.fn();
            onKernelLogSignal('hevc-decode-disabled', second);

            expect(first).toHaveBeenCalledTimes(1);
            expect(second).toHaveBeenCalledTimes(1);
            expect(second.mock.calls[0][0]).toEqual(first.mock.calls[0][0]);
        });

        it('stops reading once every signal has latched', () => {
            fs.writeFileSync(kmsgPath, LATCH_RECORD);
            startKernelLogWatch({ kmsgPath });
            // One signal today, so the first latch is the end of the watch —
            // there is nothing further the kernel log can tell us.
            expect(KERNEL_LOG_SIGNALS).toEqual(['hevc-decode-disabled']);
            expect(kernelLogWatchMode()).toBe('off');
            expect(kernelLogSignalEvent('hevc-decode-disabled')?.source).toBe('kmsg');
        });

        it('reads a quiet log without latching anything', () => {
            fs.writeFileSync(kmsgPath, NOISE);
            const handler = vi.fn();
            startKernelLogWatch({ kmsgPath });
            onKernelLogSignal('hevc-decode-disabled', handler);

            expect(handler).not.toHaveBeenCalled();
            expect(kernelLogWatchMode()).toBe('kmsg');
            expect(kernelLogSignalEvent('hevc-decode-disabled')).toBeUndefined();
        });
    });

    describe('live tail', () => {
        it('picks up a line appended after the watch started', () => {
            vi.useFakeTimers();
            fs.writeFileSync(kmsgPath, NOISE);
            const handler = vi.fn();
            startKernelLogWatch({ kmsgPath, kmsgPollMs: 1000 });
            onKernelLogSignal('hevc-decode-disabled', handler);
            expect(handler).not.toHaveBeenCalled();

            fs.appendFileSync(kmsgPath, LATCH_RECORD);
            vi.advanceTimersByTime(1000);

            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler.mock.calls[0][0].line).toContain('disabled until reboot');
        });

        it('emits once however often the kernel repeats the line', () => {
            vi.useFakeTimers();
            fs.writeFileSync(kmsgPath, '');
            const handler = vi.fn();
            startKernelLogWatch({ kmsgPath, kmsgPollMs: 1000 });
            onKernelLogSignal('hevc-decode-disabled', handler);

            fs.appendFileSync(kmsgPath, LATCH_RECORD + LATCH_RECORD);
            vi.advanceTimersByTime(1000);
            fs.appendFileSync(kmsgPath, LATCH_RECORD);
            vi.advanceTimersByTime(5000);

            expect(handler).toHaveBeenCalledTimes(1);
        });

        it('does not deliver to a handler that unsubscribed', () => {
            vi.useFakeTimers();
            fs.writeFileSync(kmsgPath, '');
            const handler = vi.fn();
            startKernelLogWatch({ kmsgPath, kmsgPollMs: 1000 });
            onKernelLogSignal('hevc-decode-disabled', handler);
            offKernelLogSignal('hevc-decode-disabled', handler);

            fs.appendFileSync(kmsgPath, LATCH_RECORD);
            vi.advanceTimersByTime(1000);

            expect(handler).not.toHaveBeenCalled();
            // Still latched, so a later subscriber is not cheated of it.
            expect(kernelLogSignalEvent('hevc-decode-disabled')).toBeDefined();
        });

        it('joins a record split across two reads', () => {
            vi.useFakeTimers();
            fs.writeFileSync(kmsgPath, '');
            const handler = vi.fn();
            startKernelLogWatch({ kmsgPath, kmsgPollMs: 1000 });
            onKernelLogSignal('hevc-decode-disabled', handler);

            const half = LATCH_RECORD.indexOf('hardware');
            fs.appendFileSync(kmsgPath, LATCH_RECORD.slice(0, half));
            vi.advanceTimersByTime(1000);
            expect(handler).not.toHaveBeenCalled();

            fs.appendFileSync(kmsgPath, LATCH_RECORD.slice(half));
            vi.advanceTimersByTime(1000);
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it('starts the watch on the first subscription and not before', () => {
            fs.writeFileSync(kmsgPath, '');
            expect(kernelLogWatchMode()).toBe('off');
            // Nothing subscribes → nothing is opened. (The real path takes no
            // options; this test drives startKernelLogWatch directly, which is
            // what onKernelLogSignal calls.)
            startKernelLogWatch({ kmsgPath });
            expect(kernelLogWatchMode()).toBe('kmsg');
        });
    });

    describe('dmesg fallback', () => {
        const missing = '/nonexistent/mr-kmsg-device';

        it('falls back when /dev/kmsg cannot be opened', async () => {
            const handler = vi.fn();
            startKernelLogWatch({
                kmsgPath: missing,
                readDmesg: async () => `[  141.592] ${kmsgMessageText(LATCH_RECORD)}\n`,
            });
            onKernelLogSignal('hevc-decode-disabled', handler);
            await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

            expect(handler.mock.calls[0][0].source).toBe('dmesg');
            expect(handler.mock.calls[0][0].line).toContain('disabled until reboot');
        });

        it('re-scans on the slow poll until the line shows up', async () => {
            vi.useFakeTimers();
            let output = NOISE.replace(/^\d+,\d+,\d+,-;/gm, '');
            const readDmesg = vi.fn(async () => output);
            const handler = vi.fn();
            startKernelLogWatch({ kmsgPath: missing, readDmesg, dmesgPollMs: 10_000 });
            onKernelLogSignal('hevc-decode-disabled', handler);

            await vi.advanceTimersByTimeAsync(0);
            expect(readDmesg).toHaveBeenCalledTimes(1);
            expect(handler).not.toHaveBeenCalled();

            output += kmsgMessageText(LATCH_RECORD) + '\n';
            await vi.advanceTimersByTimeAsync(10_000);

            expect(handler).toHaveBeenCalledTimes(1);
            // Latched → the watch (and the spawning) stops for good.
            expect(kernelLogWatchMode()).toBe('off');
            await vi.advanceTimersByTimeAsync(60_000);
            expect(readDmesg).toHaveBeenCalledTimes(2);
        });

        it('survives dmesg being unavailable too', async () => {
            const readDmesg = vi.fn(async () => {
                throw new Error('spawn dmesg ENOENT');
            });
            const handler = vi.fn();
            startKernelLogWatch({ kmsgPath: missing, readDmesg, dmesgPollMs: 10_000 });
            onKernelLogSignal('hevc-decode-disabled', handler);
            await vi.waitFor(() => expect(readDmesg).toHaveBeenCalled());

            // No signal, no crash — the pipeline still runs, it just has no
            // way to hear about the latch on this box.
            expect(handler).not.toHaveBeenCalled();
            expect(kernelLogWatchMode()).toBe('dmesg');
        });
    });
});
