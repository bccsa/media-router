import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Device } from '@media-router/shared-types';
import { createApiServer } from '../api/server.js';
import type { Engine } from '../Engine.js';
import { DeviceWatchdog, type DeviceWatchdogOptions } from '../plugins/DeviceWatchdog.js';
import type { EngineServices } from '../plugins/PluginModule.js';
import { DeviceProviderRegistry } from '../system/DeviceProviderRegistry.js';
import { registerPipeWireDeviceProvider } from '../system/pipeWireDeviceProvider.js';
import { DEFAULT_DEVICE_CACHE_TTL_MS } from './AudioDeviceOps.js';
import { PaCommandQueue } from './PaCommandQueue.js';
import { PipeWireManager } from './PipeWireManager.js';
import { installFakePactl } from './testing/fakePactl.js';

// MR-042: while PipeWire does not answer pactl (hung) or does not run, every device list the engine
// serves is its last answer, marked stale, never an empty one. The engine's real pactl path, a
// stand-in pactl first on PATH, the local API and the registry's pushes (tree and manager).
const MIC = 'alsa_input.usb-Shure_Inc_Shure_MVX2U-00.mono-fallback';
const DAC = 'alsa_output.usb-Generic_USB_Audio-00.analog-stereo';
const SOURCES = [
    'Source #57',
    `\tName: ${MIC}`,
    '\tDescription: Shure MVX2U Mono',
    '\tSample Specification: s24le 1ch 48000Hz',
    '\tChannel Map: mono',
].join('\n');
const SINKS = [
    'Sink #58',
    `\tName: ${DAC}`,
    '\tDescription: USB Audio',
    '\tSample Specification: s16le 2ch 48000Hz',
    '\tChannel Map: front-left,front-right',
].join('\n');
const MIC_LABEL = 'Shure MVX2U Mono (1ch, 48000Hz)';
/** The stand-in's no answer: our timeout kills it first. */
const TIMEOUT_MS = 1500;

const fake = installFakePactl();
afterAll(() => fake?.remove());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Past the listing's 1 s snapshot: the next reader asks pactl again. */
const nextListing = () => sleep(DEFAULT_DEVICE_CACHE_TTL_MS + 50);

/** The engine's device lists as they are served: the providers of audio-input and audio-output
 *  on a registry, its pushes, and the local API on it. */
async function serve(pw: PipeWireManager) {
    const registry = new DeviceProviderRegistry();
    const services = { pipeWire: pw, deviceProviders: registry } as unknown as EngineServices;
    registerPipeWireDeviceProvider(services, {
        type: 'audio-source',
        direction: 'source',
        pollMs: 200,
    });
    registerPipeWireDeviceProvider(services, {
        type: 'audio-sink',
        direction: 'sink',
        pollMs: 200,
    });
    const pushed: Device[][] = [];
    registry.on(
        'deviceList',
        ({ type, devices }) => type === 'audio-source' && pushed.push(devices),
    );
    const app = await createApiServer(
        { deviceProviders: registry, pipeWire: pw } as unknown as Engine,
        0,
    );
    /** GET the list as the box's own tools do, and how long it took. */
    const get = async (type: string) => {
        const t0 = performance.now();
        const res = await app.inject({ method: 'GET', url: `/api/v1/system/devices/${type}` });
        return {
            status: res.statusCode,
            list: JSON.parse(res.payload) as Device[],
            ms: performance.now() - t0,
        };
    };
    const close = async () => {
        registry.stopPolling();
        await app.close();
    };
    return { registry, pushed, get, close };
}

const quiet = () =>
    ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        trace: vi.fn(),
        child: vi.fn(),
    }) as unknown as Required<DeviceWatchdogOptions>['log'];

/** A device watchdog on `pw`, as each audio module has. */
function watchdog(pw: PipeWireManager) {
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
        pollMs: 60_000, // ticked by hand
    });
    return { wd, onDisconnect, onReconnect, onHealthChange };
}

/** `since` as the list shows it: an ISO second no later than `max` ms and no earlier than `min`. */
function expectSince(since: string, min: number, max: number) {
    expect(since).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(Date.parse(since)).toBeGreaterThanOrEqual(Math.floor(min / 1000) * 1000);
    expect(Date.parse(since)).toBeLessThanOrEqual(max);
}

describe.skipIf(fake === null)(
    'a hung or stopped PipeWire keeps the device lists, marked stale (B-207, MR-042)',
    { timeout: 30_000 },
    () => {
        let served: Awaited<ReturnType<typeof serve>> | null = null;
        afterEach(async () => {
            await served?.close();
            served = null;
            fake!.mode('answer');
        });

        it('hung: the API and the pushes keep its last list within the timeout, "PipeWire not answering since"; no device reads as gone; its next answer clears it', async () => {
            fake!.sources(SOURCES);
            fake!.sinks(SINKS);
            fake!.mode('answer');
            const pw = new PipeWireManager(new PaCommandQueue(0, TIMEOUT_MS));
            served = await serve(pw);
            const { get, pushed, registry } = served;
            const { wd, onDisconnect, onReconnect, onHealthChange } = watchdog(pw);
            wd.start();
            await wd.tick();
            const fresh = await get('audio-source');
            expect(fresh.list).toEqual([
                {
                    name: MIC,
                    label: MIC_LABEL,
                    meta: { direction: 'source', channels: 1, sampleRate: 48000 },
                },
            ]);
            registry.startPolling();
            await vi.waitFor(() => expect(pushed).toHaveLength(1));

            fake!.mode('hang');
            await nextListing();
            const askedFrom = Date.now();
            const hung = await get('audio-source');
            const askedTo = Date.now();
            expect(hung.status).toBe(200);
            expect(hung.ms).toBeLessThan(TIMEOUT_MS + 1000);
            expect(hung.list).toHaveLength(1);
            const [mic] = hung.list;
            const stale = mic.meta!.stale as { reason: string; since: string };
            expect(stale.reason).toBe('PipeWire not answering');
            expectSince(stale.since, askedFrom - DEFAULT_DEVICE_CACHE_TTL_MS - 300, askedTo);
            expect(mic).toEqual({
                name: MIC,
                label: `${MIC_LABEL} — PipeWire not answering since ${stale.since}`,
                meta: { direction: 'source', channels: 1, sampleRate: 48000, stale },
            });
            const sinks = await get('audio-sink');
            expect(sinks.list.map((d) => [d.name, d.meta!.stale])).toEqual([[DAC, stale]]);
            // The device checks: unknown, so a running module is not told its device went.
            expect(await pw.hasDevice(MIC)).toBeNull();
            expect(await pw.getDeviceInfo(MIC)).toBeNull();
            await wd.tick();
            await wd.tick();
            expect(onDisconnect).not.toHaveBeenCalled();
            expect(onHealthChange).not.toHaveBeenCalled();
            // The pushes: the marked list once, never an empty one.
            await vi.waitFor(() => expect(pushed).toHaveLength(2), { timeout: 5000 });
            expect(pushed[1]).toEqual(hung.list);

            fake!.mode('answer');
            await vi.waitFor(() => expect(pushed).toHaveLength(3), { timeout: 5000 });
            expect(pushed[2]).toEqual(fresh.list);
            expect((await get('audio-source')).list).toEqual(fresh.list);
            expect(await pw.hasDevice(MIC)).toBe(true);
            expect(pw.isAvailable()).toBe(true);
            await wd.tick();
            expect(onDisconnect).not.toHaveBeenCalled();
            expect(onReconnect).not.toHaveBeenCalled();
            expect(pushed.every((list) => list.length > 0)).toBe(true);
            await wd.stop();
        });

        it('not running: pactl fails at once, "PipeWire not running since", well inside the timeout; a hang after it is its own', async () => {
            fake!.sources(SOURCES);
            fake!.sinks(SINKS);
            fake!.mode('answer');
            const pw = new PipeWireManager(new PaCommandQueue(0, TIMEOUT_MS));
            served = await serve(pw);
            const { get } = served;
            await get('audio-source');

            fake!.mode('fail');
            await nextListing();
            const downFrom = Date.now();
            const down = await get('audio-source');
            expect(down.ms).toBeLessThan(TIMEOUT_MS);
            const stale = down.list[0].meta!.stale as { reason: string; since: string };
            expect(stale.reason).toBe('PipeWire not running');
            expectSince(stale.since, downFrom - 300, Date.now());
            expect(down.list[0].label).toBe(
                `${MIC_LABEL} — PipeWire not running since ${stale.since}`,
            );
            expect(await pw.hasDevice(MIC)).toBeNull();

            fake!.mode('hang');
            await nextListing();
            const hung = await get('audio-source');
            expect((hung.list[0].meta!.stale as { reason: string }).reason).toBe(
                'PipeWire not answering',
            );

            fake!.mode('answer');
            await nextListing();
            expect((await get('audio-source')).list[0]).toEqual({
                name: MIC,
                label: MIC_LABEL,
                meta: { direction: 'source', channels: 1, sampleRate: 48000 },
            });
        });

        it('started while PipeWire hangs: "No answer", never "no devices"; a waiting module waits; the first answer is the list', async () => {
            fake!.sources(SOURCES);
            fake!.sinks(SINKS);
            fake!.mode('hang');
            const pw = new PipeWireManager(new PaCommandQueue(0, TIMEOUT_MS));
            served = await serve(pw);
            const { get } = served;
            const from = Date.now();
            const none = await get('audio-source');
            expect(none.ms).toBeLessThan(TIMEOUT_MS + 1000);
            expect(none.list).toHaveLength(1);
            const stale = none.list[0].meta!.stale as { reason: string; since: string };
            expectSince(stale.since, from - 300, Date.now());
            expect(none.list).toEqual([
                {
                    name: '',
                    label: `No answer: PipeWire not answering since ${stale.since}`,
                    meta: { stale },
                },
            ]);
            expect(await pw.hasDevice(MIC)).toBeNull();
            // A module that started meanwhile waits for the device, and is not started from nothing.
            const { wd, onReconnect, onHealthChange } = watchdog(pw);
            wd.start(false);
            await wd.tick();
            expect(onReconnect).not.toHaveBeenCalled();
            expect(onHealthChange).not.toHaveBeenCalled();

            fake!.mode('answer');
            await nextListing();
            expect((await get('audio-source')).list.map((d) => d.name)).toEqual([MIC]);
            await wd.tick();
            expect(onReconnect).toHaveBeenCalledOnce();
            expect(onHealthChange).toHaveBeenLastCalledWith('ok');
            await wd.stop();
        });
    },
);
