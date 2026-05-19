import { describe, it, expect } from 'vitest';
import { parseFormats } from './v4l2Devices.js';

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
