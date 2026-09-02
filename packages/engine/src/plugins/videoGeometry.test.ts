import { describe, expect, it } from 'vitest';
import { parseResolution } from './videoGeometry.js';

describe('parseResolution', () => {
    it('parses WxH', () => {
        expect(parseResolution('1280x720')).toEqual({ width: 1280, height: 720 });
    });
    it('defaults to 1080p on anything else', () => {
        expect(parseResolution('')).toEqual({ width: 1920, height: 1080 });
        expect(parseResolution('720p')).toEqual({ width: 1920, height: 1080 });
        expect(parseResolution('1280 x 720')).toEqual({ width: 1920, height: 1080 });
    });
});
