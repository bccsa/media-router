import { describe, it, expect } from 'vitest';
import { buildV4l2SourceForModes } from './videoEncoderPipeline.js';
import { pickCaptureMode, type CaptureMode } from './captureModes.js';

const mode = (
    pixelFormat: string,
    width: number,
    height: number,
    framerates: number[] = [30],
): CaptureMode => ({ pixelFormat, width, height, framerates });

describe('pickCaptureMode — rung 1, exact resolution', () => {
    it('prefers MJPG over raw at the requested resolution — compressed keeps USB bandwidth from capping the framerate', () => {
        const modes = [mode('YUYV', 1920, 1080, [5]), mode('MJPG', 1920, 1080, [30])];
        expect(pickCaptureMode(modes, 1920, 1080)).toMatchObject({ pixelFormat: 'MJPG' });
    });

    it('falls to RAW_FORMAT_PREFERENCE order when the device has no MJPG', () => {
        // NV12 (semi-planar 4:2:0) outranks YUYV (packed 4:2:2).
        const modes = [mode('UYVY', 1280, 720), mode('YUYV', 1280, 720), mode('NV12', 1280, 720)];
        expect(pickCaptureMode(modes, 1280, 720)).toMatchObject({ pixelFormat: 'NV12' });
    });

    it('ignores modes at other resolutions when an exact match exists', () => {
        const modes = [mode('MJPG', 1920, 1080), mode('MJPG', 1280, 720)];
        expect(pickCaptureMode(modes, 1280, 720)).toMatchObject({ width: 1280, height: 720 });
    });

    it('returns undefined when the device names nothing we can pin', () => {
        expect(pickCaptureMode([], 1280, 720)).toBeUndefined();
        expect(pickCaptureMode([mode('H264', 1280, 720)], 1280, 720)).toBeUndefined();
    });
});

describe('pickCaptureMode — rung 2, closest resolution', () => {
    it('takes the smallest mode that is at least as large as the request — downscaling beats upscaling', () => {
        const modes = [mode('MJPG', 3840, 2160), mode('MJPG', 1920, 1080), mode('MJPG', 640, 360)];
        expect(pickCaptureMode(modes, 1280, 720)).toMatchObject({ width: 1920, height: 1080 });
    });

    it('needs BOTH dimensions ≥ the request, so a wide-but-short mode does not count as "at least"', () => {
        const modes = [mode('MJPG', 1920, 480), mode('MJPG', 1600, 1200)];
        expect(pickCaptureMode(modes, 1280, 720)).toMatchObject({ width: 1600, height: 1200 });
    });

    it('falls back to the largest mode when everything on offer is smaller', () => {
        const modes = [mode('YUYV', 640, 360), mode('YUYV', 854, 480), mode('YUYV', 320, 240)];
        expect(pickCaptureMode(modes, 1920, 1080)).toMatchObject({ width: 854, height: 480 });
    });

    it('applies the format preference across the whole list before resolution — MJPG anywhere wins over a nearer raw mode', () => {
        const modes = [mode('YUYV', 1280, 768), mode('MJPG', 1920, 1080)];
        expect(pickCaptureMode(modes, 1280, 720)).toMatchObject({
            pixelFormat: 'MJPG',
            width: 1920,
        });
    });
});

describe('buildV4l2SourceForModes', () => {
    const QUEUE = 'queue leaky=2 max-size-time=100000000 max-size-buffers=0 max-size-bytes=0';

    it('pins MJPG caps and inserts jpegdec on an exact match', () => {
        const s = buildV4l2SourceForModes('/dev/video0', 1920, 1080, 30, [
            mode('MJPG', 1920, 1080, [30, 60]),
        ]);
        expect(s).toBe(
            `v4l2src device=/dev/video0 do-timestamp=true ! image/jpeg,width=1920,height=1080,framerate=60/1 ! videorate drop-only=true ! image/jpeg,framerate=30/1 ! ${QUEUE} ! jpegparse ! jpegdec ! ` +
                'queue leaky=2 max-size-buffers=4 max-size-time=0 max-size-bytes=0 ! videorate drop-only=true ! video/x-raw,framerate=30/1 ! videoscale n-threads=2 ! video/x-raw,width=1920,height=1080 ! videoconvert n-threads=2',
        );
    });

    it('pins raw caps with no decoder on an exact raw match', () => {
        const s = buildV4l2SourceForModes('/dev/video1', 1280, 720, 50, [
            mode('NV12', 1280, 720, [25, 50]),
        ]);
        expect(s).toBe(
            `v4l2src device=/dev/video1 do-timestamp=true ! video/x-raw,format=NV12,width=1280,height=720,framerate=50/1 ! ${QUEUE} ! ` +
                'queue leaky=2 max-size-buffers=4 max-size-time=0 max-size-bytes=0 ! videorate drop-only=true ! video/x-raw,framerate=50/1 ! videoscale n-threads=2 ! video/x-raw,width=1280,height=720 ! videoconvert n-threads=2',
        );
    });

    it('ATEM Mini Pro: MJPG-1080p-only device configured at 720p captures 1080p, decodes and scales', () => {
        // Field bug (Pi4 + ATEM Mini Pro): the device offers ONLY MJPG
        // 1920x1080. With no exact 1280x720 mode the old code fell through to
        // bare negotiation, which handed image/jpeg straight to videoconvert
        // with no decoder — pipeline died "not-negotiated".
        const s = buildV4l2SourceForModes('/dev/video0', 1280, 720, 25, [
            mode('MJPG', 1920, 1080, [50, 25]),
        ]);
        expect(s).toContain('image/jpeg,width=1920,height=1080');
        expect(s).toContain('jpegdec');
        expect(s).toContain('video/x-raw,width=1280,height=720');
        expect(s).toContain('video/x-raw,framerate=25/1');
        expect(s).toBe(
            `v4l2src device=/dev/video0 do-timestamp=true ! image/jpeg,width=1920,height=1080,framerate=50/1 ! videorate drop-only=true ! image/jpeg,framerate=25/1 ! ${QUEUE} ! jpegparse ! jpegdec ! ` +
                'queue leaky=2 max-size-buffers=4 max-size-time=0 max-size-bytes=0 ! videorate drop-only=true ! video/x-raw,framerate=25/1 ! videoscale n-threads=2 ! video/x-raw,width=1280,height=720 ! videoconvert n-threads=2',
        );
    });

    it('MJPG captures at the lowest rate ABOVE the request and pre-drops (latency)', () => {
        const s = buildV4l2SourceForModes('/dev/video0', 1920, 1080, 30, [
            mode('MJPG', 1920, 1080, [5, 25, 50]),
        ]);
        // 50 is the only rate above 30: capture there for freshness, drop the
        // compressed frames down to 30 before the decoder pays for them.
        expect(s).toContain('image/jpeg,width=1920,height=1080,framerate=50/1');
        expect(s).toContain('videorate drop-only=true ! image/jpeg,framerate=30/1');
    });

    it('MJPG falls back to the closest rate when nothing above the request exists', () => {
        const s = buildV4l2SourceForModes('/dev/video0', 1920, 1080, 30, [
            mode('MJPG', 1920, 1080, [5, 25]),
        ]);
        expect(s).toContain('image/jpeg,width=1920,height=1080,framerate=25/1');
        expect(s).not.toContain('image/jpeg,framerate=30/1'); // no pre-drop stage
        expect(s).toContain('video/x-raw,framerate=30/1');
    });

    it('keeps the requested framerate when the mode reports none', () => {
        const s = buildV4l2SourceForModes('/dev/video0', 1280, 720, 30, [
            mode('MJPG', 1280, 720, []),
        ]);
        expect(s).toContain('image/jpeg,width=1280,height=720,framerate=30/1');
    });

    it('upscales from the largest mode when the device cannot reach the request', () => {
        const s = buildV4l2SourceForModes('/dev/video2', 1920, 1080, 30, [
            mode('YUYV', 640, 480, [30]),
            mode('YUYV', 320, 240, [30]),
        ]);
        expect(s).toContain('video/x-raw,format=YUYV,width=640,height=480,framerate=30/1');
        expect(s).toContain('video/x-raw,width=1920,height=1080');
        expect(s).toContain('video/x-raw,framerate=30/1');
    });

    it('drops to bare negotiation only when the probe itself failed — no source capsfilter, no jpegdec', () => {
        const s = buildV4l2SourceForModes('/dev/video0', 1920, 1080, 30, undefined);
        expect(s).toBe(
            `v4l2src device=/dev/video0 do-timestamp=true ! ${QUEUE} ! ` +
                'queue leaky=2 max-size-buffers=4 max-size-time=0 max-size-bytes=0 ! videorate drop-only=true ! video/x-raw,framerate=30/1 ! videoscale n-threads=2 ! video/x-raw,width=1920,height=1080 ! videoconvert n-threads=2',
        );
        expect(s).not.toContain('jpegdec');
        expect(s).not.toContain('image/jpeg');
    });

    it('also drops to bare negotiation when the probe succeeded but named no format we can pin', () => {
        const s = buildV4l2SourceForModes('/dev/video0', 1920, 1080, 30, [
            mode('H264', 1920, 1080),
        ]);
        expect(s).toBe(
            `v4l2src device=/dev/video0 do-timestamp=true ! ${QUEUE} ! ` +
                'queue leaky=2 max-size-buffers=4 max-size-time=0 max-size-bytes=0 ! videorate drop-only=true ! video/x-raw,framerate=30/1 ! videoscale n-threads=2 ! video/x-raw,width=1920,height=1080 ! videoconvert n-threads=2',
        );
    });
});

describe('MJPG decode path', () => {
    const atem = [{ pixelFormat: 'MJPG', width: 1920, height: 1080, framerates: [50, 25] }];

    it('always decodes in software behind jpegparse — never v4l2jpegdec (wedges in-engine)', () => {
        const p = buildV4l2SourceForModes('/dev/video0', 1280, 720, 25, atem);
        expect(p).toContain('! jpegparse ! jpegdec !');
        expect(p).not.toContain('v4l2jpegdec');
    });
});

describe('scale stage injection', () => {
    const atem = [{ pixelFormat: 'MJPG', width: 1920, height: 1080, framerates: [50, 25] }];
    it('uses the caller-built hardware scale stage after the rate conform, directly before the encoder', () => {
        const p = buildV4l2SourceForModes(
            '/dev/video0',
            1280,
            720,
            25,
            atem,
            'v4l2convert ! video/x-raw,width=1280,height=720',
        );
        expect(p).toMatch(
            /videorate drop-only=true ! video\/x-raw,framerate=25\/1 ! v4l2convert ! video\/x-raw,width=1280,height=720$/,
        );
        expect(p).not.toContain('videoscale');
    });

    it('drops the hardware stage when the chosen mode already has the requested size (ISP round-trip for nothing)', () => {
        const camlink = [{ pixelFormat: 'NV12', width: 1920, height: 1080, framerates: [50] }];
        const p = buildV4l2SourceForModes(
            '/dev/video4',
            1920,
            1080,
            25,
            camlink,
            'v4l2convert ! video/x-raw,width=1920,height=1080',
        );
        expect(p).not.toContain('v4l2convert');
        expect(p).toContain(
            'videoscale n-threads=2 ! video/x-raw,width=1920,height=1080 ! videoconvert n-threads=2',
        );
    });
});
