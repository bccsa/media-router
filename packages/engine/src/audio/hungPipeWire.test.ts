import { afterAll, describe, expect, it, vi } from 'vitest';
import { DeviceWatchdog, type DeviceWatchdogOptions } from '../plugins/DeviceWatchdog.js';
import { PaCommandQueue } from './PaCommandQueue.js';
import { PipeWireManager } from './PipeWireManager.js';
import { installFakePactl } from './testing/fakePactl.js';

// MR-023: pipewire-pulse accepts pactl's call and never answers. The engine's real pactl path
// against a stand-in first on PATH: nothing may wait on it but its own readers.
const MIC = 'alsa_input.usb-Shure_Inc_Shure_MVX2U-00.mono-fallback';
const LISTED = [
    'Source #57',
    '\tState: SUSPENDED',
    `\tName: ${MIC}`,
    '\tDescription: Shure MVX2U Mono',
    '\tSample Specification: s24le 1ch 48000Hz',
    '\tChannel Map: mono',
].join('\n');

const fake = installFakePactl();
afterAll(() => fake?.remove());

const quiet = () =>
    ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        trace: vi.fn(),
        child: vi.fn(),
    }) as unknown as Required<DeviceWatchdogOptions>['log'];

/** How late, at worst, a timer every `everyMs` fires over `forMs`. */
function worstTimerLatenessMs(forMs: number, everyMs = 20): Promise<number> {
    return new Promise((resolve) => {
        const t0 = performance.now();
        let last = t0;
        let worst = 0;
        const timer = setInterval(() => {
            const now = performance.now();
            worst = Math.max(worst, now - last - everyMs);
            last = now;
            if (now - t0 >= forMs) {
                clearInterval(timer);
                resolve(worst);
            }
        }, everyMs);
    });
}

describe.skipIf(fake === null)(
    'a hung PipeWire never freezes the engine (B-200, MR-023)',
    { timeout: 30_000 },
    () => {
        it('timers keep time, polls share one listing, the watchdog waits it out; then the device is seen again and an unplug is still one', async () => {
            fake!.sources(LISTED);
            const pw = new PipeWireManager(new PaCommandQueue(0, 600));
            const onDisconnect = vi.fn(async () => {});
            const onReconnect = vi.fn(async () => {});
            const onHealthChange = vi.fn();
            const wd = new DeviceWatchdog({
                getDeviceName: () => MIC,
                pipeWire: pw,
                log: quiet(),
                onDisconnect,
                onReconnect,
                onHealthChange,
                pollMs: 100,
            });
            wd.start();
            await wd.tick();
            expect(wd.isConnected()).toBe(true);

            // Hung: the watchdog polls, and two device providers poll every 100 ms beside it.
            fake!.mode('hang');
            const before = fake!.calls().length;
            const providers = setInterval(() => {
                void pw.listDevices();
                void pw.listDevices();
            }, 100);
            const lateMs = await worstTimerLatenessMs(2500);
            await vi.waitFor(() => expect(pw.isAvailable()).toBe(false), { timeout: 3000 });
            clearInterval(providers);
            const listings = fake!
                .calls()
                .slice(before)
                .filter((c) => c === 'list sources');

            // A synchronous listing would hold every timer for its 600 ms timeout, twice.
            expect(lateMs).toBeLessThan(400);
            // One listing at a time, then its no-answer kept for the TTL: not one per poll.
            expect(listings.length).toBeGreaterThanOrEqual(1);
            expect(listings.length).toBeLessThanOrEqual(4);
            expect(onDisconnect).not.toHaveBeenCalled();
            expect(onHealthChange).not.toHaveBeenCalled();

            // PipeWire answers again: the device is there, nothing to rebuild.
            fake!.mode('answer');
            await vi.waitFor(() => expect(pw.isAvailable()).toBe(true), { timeout: 5000 });
            expect(await pw.hasDevice(MIC)).toBe(true);
            await wd.tick();
            expect(onDisconnect).not.toHaveBeenCalled();
            expect(wd.isConnected()).toBe(true);

            // An unplug, answered, is still an unplug.
            fake!.sources('');
            await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledOnce(), { timeout: 5000 });
            expect(onHealthChange).toHaveBeenCalledWith('error', 'Device disconnected');
            await wd.stop();
        });
    },
);
