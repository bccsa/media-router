import { describe, it, expect } from 'vitest';
import { aspectLabel, describeDisplayFit, describeFit } from './displayFit.js';

const FHD = { width: 1920, height: 1080 };
const XGA = { width: 1024, height: 768 };

describe('aspectLabel', () => {
    it('names the common ratios, landscape and portrait', () => {
        expect(aspectLabel(FHD)).toBe('16:9');
        expect(aspectLabel({ width: 1366, height: 768 })).toBe('16:9');
        expect(aspectLabel(XGA)).toBe('4:3');
        expect(aspectLabel({ width: 1920, height: 1200 })).toBe('16:10');
        expect(aspectLabel({ width: 1280, height: 1024 })).toBe('5:4');
        expect(aspectLabel({ width: 720, height: 1280 })).toBe('9:16');
    });

    it('prints anything else as a decimal ratio', () => {
        expect(aspectLabel({ width: 1998, height: 1080 })).toBe('1.85:1');
        expect(aspectLabel({ width: 1080, height: 1998 })).toBe('1:1.85');
    });
});

describe('describeFit', () => {
    it('is 1:1 when the video matches the screen', () => {
        expect(describeFit(FHD, FHD)).toBe('none (1:1)');
    });

    it('fills the screen when only the size differs', () => {
        expect(describeFit({ width: 1280, height: 720 }, FHD)).toBe(
            'scaled down to fill the screen',
        );
        expect(describeFit(FHD, { width: 1280, height: 720 })).toBe('scaled up to fill the screen');
    });

    it('letterboxes 16:9 video on a 4:3 mode (the no-EDID fallback case)', () => {
        expect(describeFit(XGA, FHD)).toBe('scaled to fit 1024x576, black bars top and bottom');
    });

    it('pillarboxes 4:3 video on a 16:9 screen', () => {
        expect(describeFit(FHD, { width: 720, height: 540 })).toBe(
            'scaled to fit 1440x1080, black bars left and right',
        );
    });
});

describe('describeDisplayFit', () => {
    it('reports mode, video and scaling when all are known', () => {
        expect(describeDisplayFit(FHD, FHD, true)).toEqual({
            mode: '1920x1080 (16:9)',
            video: '1920x1080 (16:9)',
            fit: 'none (1:1)',
        });
    });

    it('calls out a missing EDID on the mode', () => {
        expect(describeDisplayFit(XGA, FHD, false)).toEqual({
            mode: '1024x768 (4:3) — no EDID from the screen (fallback mode); check the HDMI cable',
            video: '1920x1080 (16:9)',
            fit: 'scaled to fit 1024x576, black bars top and bottom',
        });
    });

    it('leaves out rows it cannot fill', () => {
        expect(describeDisplayFit(undefined, undefined, undefined)).toEqual({});
        expect(describeDisplayFit(FHD, undefined, true)).toEqual({ mode: '1920x1080 (16:9)' });
        expect(describeDisplayFit(undefined, FHD, undefined)).toEqual({
            video: '1920x1080 (16:9)',
        });
        expect(describeDisplayFit(undefined, undefined, false)).toEqual({
            mode: 'no EDID from the screen; check the HDMI cable',
        });
    });
});
