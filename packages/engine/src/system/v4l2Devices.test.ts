import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
    execFile: (...args: unknown[]) => execFileMock(...args),
}));

import { parseFormats, listV4l2Devices, _resetV4l2DeviceCacheForTests } from './v4l2Devices.js';
import { _resetV4l2CtlGuardForTests } from './v4l2Ctl.js';

describe('parseFormats (v4l2-ctl --list-formats-ext)', () => {
    it('extracts pixel format, size, and framerate list from sample output', () => {
        const sample = `
ioctl: VIDIOC_ENUM_FMT
	Type: Video Capture

	[0]: 'YUYV' (YUYV 4:2:2)
		Size: Discrete 1920x1080
			Interval: Discrete 0.033s (30.000 fps)
			Interval: Discrete 0.067s (15.000 fps)
		Size: Discrete 1280x720
			Interval: Discrete 0.017s (60.000 fps)
	[1]: 'MJPG' (Motion-JPEG, compressed)
		Size: Discrete 1920x1080
			Interval: Discrete 0.033s (30.000 fps)
`;
        const formats = parseFormats(sample);
        expect(formats).toEqual([
            { pixelFormat: 'YUYV', width: 1920, height: 1080, framerates: [30, 15] },
            { pixelFormat: 'YUYV', width: 1280, height: 720, framerates: [60] },
            { pixelFormat: 'MJPG', width: 1920, height: 1080, framerates: [30] },
        ]);
    });

    it('returns an empty array for empty input', () => {
        expect(parseFormats('')).toEqual([]);
    });
});

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

interface Spawn {
    args: string[];
    child: EventEmitter;
    cb: ExecCallback;
}

const LISTING = `USB Capture HDMI (usb-xhci-1):
\t/dev/video0
`;
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
 * Guard tests drive `v4l2-ctl` by hand: `spawns` records every invocation and
 * the test decides whether the child exits, only calls back (the kernel-wedged
 * case: SIGKILL delivered, process still in D-state), or does neither.
 */
describe('listV4l2Devices guard', () => {
    let spawns: Spawn[];
    let now: number;

    /** Healthy child: exits, then the exec callback fires — Node's order. */
    function finish(spawn: Spawn, stdout: string) {
        spawn.child.emit('exit', 0, null);
        spawn.child.emit('close', 0, null);
        spawn.cb(null, stdout, '');
    }

    /** Wedged child: the timeout kills it and the callback errors, but it never exits. */
    function killWithoutExit(spawn: Spawn) {
        spawn.cb(new Error('ETIMEDOUT'), '', '');
    }

    /** Let queued microtasks/callbacks run so the next spawn happens. */
    function flush(): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, 0));
    }

    /** Drive one full healthy enumeration of a single capture device. */
    async function enumerateHealthy(): Promise<unknown> {
        const promise = listV4l2Devices();
        finish(spawns[spawns.length - 1], LISTING);
        await flush();
        finish(spawns[spawns.length - 1], CAPTURE_ALL);
        await flush();
        finish(spawns[spawns.length - 1], FORMATS);
        return promise;
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
        _resetV4l2DeviceCacheForTests();
        _resetV4l2CtlGuardForTests();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('enumerates capture devices over the three v4l2-ctl calls (normal path)', async () => {
        const devices = await enumerateHealthy();
        expect(spawns.map((s) => s.args)).toEqual([
            ['--list-devices'],
            ['--device', '/dev/video0', '--all'],
            ['--device', '/dev/video0', '--list-formats-ext'],
        ]);
        expect(devices).toEqual([EXPECTED_DEVICE]);
    });

    it('returns an empty list when v4l2-ctl --list-devices fails', async () => {
        const promise = listV4l2Devices();
        spawns[0].child.emit('exit', 1, null);
        spawns[0].cb(new Error('exit 1'), '', '');
        await expect(promise).resolves.toEqual([]);
    });

    it('single-flight: a poll during a pending run returns the cache without spawning', async () => {
        await enumerateHealthy();
        expect(spawns).toHaveLength(3);

        // Second run: leave the listing child pending — nothing has come back.
        const pending = listV4l2Devices();
        expect(spawns).toHaveLength(4);
        await expect(listV4l2Devices()).resolves.toEqual([EXPECTED_DEVICE]);
        await expect(listV4l2Devices()).resolves.toEqual([EXPECTED_DEVICE]);
        expect(spawns).toHaveLength(4);

        // Let the pending run complete so nothing is left hanging.
        finish(spawns[3], LISTING);
        await flush();
        finish(spawns[4], CAPTURE_ALL);
        await flush();
        finish(spawns[5], FORMATS);
        await expect(pending).resolves.toEqual([EXPECTED_DEVICE]);
    });

    it('stuck child: a killed-but-unexited v4l2-ctl stops further spawns', async () => {
        await enumerateHealthy();
        expect(spawns).toHaveLength(3);

        // The promise settles (SIGKILL "succeeded") but the process lives on.
        const promise = listV4l2Devices();
        killWithoutExit(spawns[3]);
        await expect(promise).resolves.toEqual([]);
        expect(spawns).toHaveLength(4);

        // Every later poll is skipped even though no promise is pending.
        await expect(listV4l2Devices()).resolves.toEqual([]);
        await expect(listV4l2Devices()).resolves.toEqual([]);
        expect(spawns).toHaveLength(4);

        // Past the 30 s hard cap it stays skipped (and logs only once).
        now += 31_000;
        await expect(listV4l2Devices()).resolves.toEqual([]);
        await expect(listV4l2Devices()).resolves.toEqual([]);
        expect(spawns).toHaveLength(4);
    });

    it('stuck child: a real exit re-enables enumeration', async () => {
        const promise = listV4l2Devices();
        killWithoutExit(spawns[0]);
        await promise;
        await listV4l2Devices();
        expect(spawns).toHaveLength(1);

        // The driver unwedges and the process is finally reaped.
        now += 45_000;
        spawns[0].child.emit('exit', 137, 'SIGKILL');
        const devices = await enumerateHealthy();
        expect(spawns).toHaveLength(4);
        expect(devices).toEqual([EXPECTED_DEVICE]);
    });

    it('keeps the previous list when a per-device probe is skipped mid-run', async () => {
        await enumerateHealthy();

        // Listing comes back but its child never exits, so the `--all` probe
        // for /dev/video0 is refused — the truncated run must not clear the cache.
        const promise = listV4l2Devices();
        spawns[3].cb(null, LISTING, '');
        await expect(promise).resolves.toEqual([EXPECTED_DEVICE]);
        expect(spawns).toHaveLength(4);
    });

    it('does not spawn again after a wedged per-device probe', async () => {
        const promise = listV4l2Devices();
        finish(spawns[0], LISTING);
        await flush();
        killWithoutExit(spawns[1]); // `--all` killed but never exits
        await expect(promise).resolves.toEqual([]);
        expect(spawns).toHaveLength(2);

        await expect(listV4l2Devices()).resolves.toEqual([]);
        expect(spawns).toHaveLength(2);
    });
});
