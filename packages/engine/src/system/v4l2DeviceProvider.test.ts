import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
    execFile: (...args: unknown[]) => execFileMock(...args),
}));

import {
    acquireV4l2Demand,
    listV4l2DevicesOnDemand,
    registerV4l2DeviceProvider,
    releaseV4l2Demand,
    V4L2_DEVICE_TYPE,
    V4L2_IDLE_ENUMERATE_MS,
    _resetV4l2DemandForTests,
} from './v4l2DeviceProvider.js';
import { _resetV4l2DeviceCacheForTests } from './v4l2Devices.js';
import { _resetV4l2CtlGuardForTests } from './v4l2Ctl.js';
import { DeviceProviderRegistry } from './DeviceProviderRegistry.js';
import type { EngineServices } from '../plugins/PluginModule.js';

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

interface Spawn {
    args: string[];
    child: EventEmitter;
    cb: ExecCallback;
}

const LISTING = `USB Capture HDMI (usb-xhci-1):
\t/dev/video0
`;
// `Priority:` matters: the capability block is read up to the next top-level
// line, so the fixture needs one after the indented caps.
const CAPTURE_ALL = `Driver name      : uvcvideo
Device Caps      : 0x04200001
\tVideo Capture
\tStreaming
Priority: 2
`;
const FORMATS = `	[0]: 'YUYV' (YUYV 4:2:2)
		Size: Discrete 1280x720
			Interval: Discrete 0.017s (60.000 fps)
`;

const EXPECTED_DEVICE = {
    name: '/dev/video0',
    label: 'USB Capture HDMI (/dev/video0)',
    meta: {
        path: '/dev/video0',
        model: 'USB Capture HDMI',
        formats: [{ pixelFormat: 'YUYV', width: 1280, height: 720, framerates: [60] }],
    },
};

/**
 * Field finding (Pi 400): the `video` provider ran `v4l2-ctl --device=<p> --all`
 * over every `/dev/video*` node every 2 s — ~420 execs/min, 12.4 % of a core —
 * on a host with no module that consumes the list at all. These tests pin what
 * makes that stop, and what must keep working when a module does want it.
 */
describe('v4l2 device provider demand gate', () => {
    let spawns: Spawn[];
    let now: number;

    /** Healthy child: exits, then the exec callback fires — Node's order. */
    function finish(spawn: Spawn, stdout: string) {
        spawn.child.emit('exit', 0, null);
        spawn.child.emit('close', 0, null);
        spawn.cb(null, stdout, '');
    }

    function flush(): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, 0));
    }

    /** Drive one full enumeration (listing + `--all` + `--list-formats-ext`). */
    async function drive(result: Promise<unknown> | unknown): Promise<unknown> {
        finish(spawns[spawns.length - 1], LISTING);
        await flush();
        finish(spawns[spawns.length - 1], CAPTURE_ALL);
        await flush();
        finish(spawns[spawns.length - 1], FORMATS);
        return result;
    }

    beforeEach(() => {
        spawns = [];
        now = 1_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        execFileMock.mockReset();
        execFileMock.mockImplementation(
            (_cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
                const child = new EventEmitter();
                spawns.push({ args, child, cb });
                return child;
            },
        );
        _resetV4l2DemandForTests();
        _resetV4l2DeviceCacheForTests();
        _resetV4l2CtlGuardForTests();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('enumerates once on the first idle call, then serves the cache', async () => {
        // Boot still gets a real snapshot — the dropdown is populated before any
        // video module exists.
        await expect(drive(listV4l2DevicesOnDemand())).resolves.toEqual([EXPECTED_DEVICE]);
        expect(spawns).toHaveLength(3);

        // Every later idle poll spawns NOTHING. This is the 12.4 % of a core.
        // The gated path returns the cache SYNCHRONOUSLY (the registry accepts
        // either shape), so there is not even a microtask per skipped poll.
        now += 2_000;
        expect(listV4l2DevicesOnDemand()).toEqual([EXPECTED_DEVICE]);
        now += 2_000;
        expect(listV4l2DevicesOnDemand()).toEqual([EXPECTED_DEVICE]);
        expect(spawns).toHaveLength(3);
    });

    it('still refreshes once per idle window, so a hot-plugged card appears', async () => {
        await drive(listV4l2DevicesOnDemand());
        expect(spawns).toHaveLength(3);

        now += V4L2_IDLE_ENUMERATE_MS - 1;
        await listV4l2DevicesOnDemand();
        expect(spawns).toHaveLength(3);

        now += 1;
        await drive(listV4l2DevicesOnDemand());
        expect(spawns).toHaveLength(6);
    });

    it('an instantiated consumer restores the full cadence immediately', async () => {
        await drive(listV4l2DevicesOnDemand());
        expect(spawns).toHaveLength(3);

        // No waiting out the idle window: the very next poll is a real one.
        acquireV4l2Demand();
        now += 2_000;
        await expect(drive(listV4l2DevicesOnDemand())).resolves.toEqual([EXPECTED_DEVICE]);
        expect(spawns).toHaveLength(6);

        now += 2_000;
        await drive(listV4l2DevicesOnDemand());
        expect(spawns).toHaveLength(9);
    });

    it('keeps polling while ANY consumer remains, and stops when the last one goes', async () => {
        acquireV4l2Demand();
        acquireV4l2Demand();
        await drive(listV4l2DevicesOnDemand());
        expect(spawns).toHaveLength(3);

        releaseV4l2Demand();
        now += 2_000;
        await drive(listV4l2DevicesOnDemand());
        expect(spawns).toHaveLength(6);

        releaseV4l2Demand();
        now += 2_000;
        await listV4l2DevicesOnDemand();
        expect(spawns).toHaveLength(6);
    });

    it('an unbalanced release cannot drive the count negative and wedge the gate', async () => {
        releaseV4l2Demand();
        releaseV4l2Demand();
        acquireV4l2Demand();
        await drive(listV4l2DevicesOnDemand());
        now += 2_000;
        await drive(listV4l2DevicesOnDemand());
        expect(spawns).toHaveLength(6);
    });

    it('registers the gated list under the `video` type, once', () => {
        const registry = new DeviceProviderRegistry();
        const services = { deviceProviders: registry } as unknown as EngineServices;
        registerV4l2DeviceProvider(services);
        const provider = registry.getProvider(V4L2_DEVICE_TYPE);
        expect(provider?.pollMs).toBe(2000);

        // Idempotent: a second plugin registering must not replace the first
        // (a replace resets the registry's diff snapshot and re-emits).
        const replaced = vi.spyOn(registry, 'register');
        registerV4l2DeviceProvider(services);
        expect(replaced).not.toHaveBeenCalled();
    });

    it('the registered list() is the gated one — an idle registry poll spawns nothing', async () => {
        const registry = new DeviceProviderRegistry();
        registerV4l2DeviceProvider({ deviceProviders: registry } as unknown as EngineServices);
        await drive(registry.getDevices(V4L2_DEVICE_TYPE));
        expect(spawns).toHaveLength(3);

        now += 2_000;
        await expect(registry.getDevices(V4L2_DEVICE_TYPE)).resolves.toEqual([EXPECTED_DEVICE]);
        expect(spawns).toHaveLength(3);
    });
});

describe('suspendV4l2Enumeration', () => {
    it('serves the cache during the blackout window even under demand', async () => {
        const {
            suspendV4l2Enumeration,
            acquireV4l2Demand,
            listV4l2DevicesOnDemand,
            _resetV4l2DemandForTests,
        } = await import('./v4l2DeviceProvider.js');
        _resetV4l2DemandForTests();
        acquireV4l2Demand();
        suspendV4l2Enumeration(60_000);
        // During the blackout the provider must not spawn v4l2-ctl — the
        // cached (synchronous) list is the tell: a live enumeration returns a
        // Promise, the cache returns an array.
        const result = listV4l2DevicesOnDemand();
        expect(Array.isArray(result)).toBe(true);
        _resetV4l2DemandForTests();
    });

    it('overlapping suspensions extend, never shorten', async () => {
        const {
            suspendV4l2Enumeration,
            listV4l2DevicesOnDemand,
            acquireV4l2Demand,
            _resetV4l2DemandForTests,
        } = await import('./v4l2DeviceProvider.js');
        _resetV4l2DemandForTests();
        acquireV4l2Demand();
        suspendV4l2Enumeration(60_000);
        suspendV4l2Enumeration(1); // must NOT shorten the standing window
        expect(Array.isArray(listV4l2DevicesOnDemand())).toBe(true);
        _resetV4l2DemandForTests();
    });
});
