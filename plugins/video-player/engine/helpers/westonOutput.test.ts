import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The sysfs fallback (kernel preferred mode) is the one thing these tests can't
// stage on disk portably — mock just that export so each case controls what
// "the panel says" while every other engine export stays real.
vi.mock('@media-router/engine', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        resolveConnectorMode: vi.fn(() => undefined),
    };
});

import { resolveConnectorMode } from '@media-router/engine';
import { parseWestonOutput, resolveWestonSurface } from './westonOutput.js';

const resolveConnectorModeMock = resolveConnectorMode as unknown as ReturnType<typeof vi.fn>;

describe('parseWestonOutput', () => {
    it('collects mode and transform from the matching [output] section', () => {
        const ini = [
            '[core]',
            'idle-time=0',
            '',
            '[output]',
            'name=DSI-2',
            'app-ids=local.cog.DSI-2,local.mr.DSI-2',
            'mode=preferred',
            'transform=rotate-90',
        ].join('\n');
        expect(parseWestonOutput(ini, 'DSI-2')).toEqual({
            mode: 'preferred',
            transform: 'rotate-90',
        });
    });

    it('picks the right section in a multi-output ini', () => {
        const ini = [
            '[output]',
            'name=HDMI-A-1',
            'mode=1920x1080',
            'transform=normal',
            '',
            '[output]',
            'name=DSI-2',
            'mode=720x1280',
            'transform=rotate-270',
            '',
            '[output]',
            'name=HDMI-A-2',
            'mode=1280x720',
        ].join('\n');
        expect(parseWestonOutput(ini, 'HDMI-A-1')).toEqual({
            mode: '1920x1080',
            transform: 'normal',
        });
        expect(parseWestonOutput(ini, 'DSI-2')).toEqual({
            mode: '720x1280',
            transform: 'rotate-270',
        });
        expect(parseWestonOutput(ini, 'HDMI-A-2')).toEqual({ mode: '1280x720' });
    });

    it('returns {} for an unknown output, an empty name, or an empty file', () => {
        const ini = '[output]\nname=DSI-2\nmode=720x1280\n';
        expect(parseWestonOutput(ini, 'HDMI-A-1')).toEqual({});
        expect(parseWestonOutput(ini, '')).toEqual({});
        expect(parseWestonOutput('', 'DSI-2')).toEqual({});
    });

    it('ignores comments and keys from other sections', () => {
        const ini = [
            '# transform=rotate-180 (commented out by the operator)',
            '[shell]',
            'transform=rotate-180',
            '',
            '[output]',
            'name=DSI-2',
            '; mode=1920x1080',
            'mode=720x1280',
        ].join('\n');
        expect(parseWestonOutput(ini, 'DSI-2')).toEqual({ mode: '720x1280' });
    });
});

describe('resolveWestonSurface', () => {
    let tmp: string;

    function ini(contents: string): string {
        const file = path.join(tmp, 'weston.ini');
        fs.writeFileSync(file, contents);
        return file;
    }

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-weston-ini-'));
        resolveConnectorModeMock.mockReset();
        resolveConnectorModeMock.mockReturnValue(undefined);
    });

    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('swaps the portrait panel mode into the compositor\'s landscape canvas (rotate-90)', () => {
        // The live bug: Pi 5 DSI panel, kernel preferred 720x1280, weston
        // rotates it 90° so the logical canvas is 1280x720. A 720x1280 surface
        // gets fit-scaled into that and the video shows as a small band.
        resolveConnectorModeMock.mockReturnValue({ width: 720, height: 1280 });
        const file = ini(
            ['[output]', 'name=DSI-2', 'mode=preferred', 'transform=rotate-90'].join('\n'),
        );
        expect(resolveWestonSurface('DSI-2', file)).toEqual({ width: 1280, height: 720 });
    });

    it('swaps for rotate-270 and the flipped 90/270 variants too', () => {
        resolveConnectorModeMock.mockReturnValue({ width: 720, height: 1280 });
        for (const transform of [
            'rotate-270',
            '90',
            '270',
            'flipped-rotate-90',
            'flipped-rotate-270',
        ]) {
            const file = ini(
                ['[output]', 'name=DSI-2', 'mode=preferred', `transform=${transform}`].join('\n'),
            );
            expect(resolveWestonSurface('DSI-2', file)).toEqual({ width: 1280, height: 720 });
        }
    });

    it('does not swap for normal, rotate-180, flipped-rotate-180, or an absent transform', () => {
        resolveConnectorModeMock.mockReturnValue({ width: 720, height: 1280 });
        for (const line of [
            'transform=normal',
            'transform=rotate-180',
            'transform=flipped',
            'transform=flipped-rotate-180',
            '',
        ]) {
            const file = ini(['[output]', 'name=DSI-2', 'mode=preferred', line].join('\n'));
            expect(resolveWestonSurface('DSI-2', file)).toEqual({ width: 720, height: 1280 });
        }
    });

    it('does not swap on an unknown transform value', () => {
        resolveConnectorModeMock.mockReturnValue({ width: 1920, height: 1080 });
        const file = ini(
            ['[output]', 'name=HDMI-A-1', 'mode=preferred', 'transform=sideways'].join('\n'),
        );
        expect(resolveWestonSurface('HDMI-A-1', file)).toEqual({ width: 1920, height: 1080 });
    });

    it('prefers a manual mode over the kernel preferred mode (F7)', () => {
        // The compositor drives the panel at the manual mode, so that — not
        // sysfs — is the surface basis; otherwise the pipeline scales in
        // software and the compositor scales straight back.
        resolveConnectorModeMock.mockReturnValue({ width: 1920, height: 1080 });
        const file = ini(['[output]', 'name=HDMI-A-1', 'mode=1280x720'].join('\n'));
        expect(resolveWestonSurface('HDMI-A-1', file)).toEqual({ width: 1280, height: 720 });
        expect(resolveConnectorModeMock).not.toHaveBeenCalled();
    });

    it('parses a manual mode carrying a refresh rate', () => {
        resolveConnectorModeMock.mockReturnValue({ width: 1920, height: 1080 });
        const file = ini(['[output]', 'name=HDMI-A-1', 'mode=1280x720@59.94'].join('\n'));
        expect(resolveWestonSurface('HDMI-A-1', file)).toEqual({ width: 1280, height: 720 });
    });

    it('applies the transform to a manual mode as well', () => {
        const file = ini(
            ['[output]', 'name=DSI-2', 'mode=720x1280@60', 'transform=rotate-90'].join('\n'),
        );
        expect(resolveWestonSurface('DSI-2', file)).toEqual({ width: 1280, height: 720 });
    });

    it('falls back to the kernel preferred mode for mode=preferred, a missing key, or junk', () => {
        resolveConnectorModeMock.mockReturnValue({ width: 1920, height: 1080 });
        for (const line of ['mode=preferred', 'mode=current', 'mode=off', 'mode=garbage', '']) {
            const file = ini(['[output]', 'name=HDMI-A-1', line].join('\n'));
            expect(resolveWestonSurface('HDMI-A-1', file)).toEqual({ width: 1920, height: 1080 });
        }
    });

    it('falls back to the kernel preferred mode when weston.ini is missing (dev boxes, KMS hosts)', () => {
        resolveConnectorModeMock.mockReturnValue({ width: 1920, height: 1080 });
        expect(resolveWestonSurface('HDMI-A-1', path.join(tmp, 'does-not-exist.ini'))).toEqual({
            width: 1920,
            height: 1080,
        });
    });

    it('never throws when the ini path is unreadable (a directory)', () => {
        resolveConnectorModeMock.mockReturnValue({ width: 1280, height: 720 });
        expect(resolveWestonSurface('HDMI-A-1', tmp)).toEqual({ width: 1280, height: 720 });
    });

    it('returns undefined when neither weston.ini nor sysfs can size the output', () => {
        // Caller keeps its `?? DEFAULT_SURFACE`, so this is the headless path.
        expect(resolveWestonSurface('HDMI-A-1', path.join(tmp, 'nope.ini'))).toBeUndefined();
        const file = ini(['[output]', 'name=HDMI-A-1', 'mode=preferred'].join('\n'));
        expect(resolveWestonSurface('HDMI-A-1', file)).toBeUndefined();
    });

    it('only reads the output section for the connector it was asked about', () => {
        resolveConnectorModeMock.mockReturnValue({ width: 720, height: 1280 });
        const file = ini(
            [
                '[output]',
                'name=DSI-2',
                'mode=preferred',
                'transform=rotate-90',
                '',
                '[output]',
                'name=HDMI-A-1',
                'mode=1920x1080',
            ].join('\n'),
        );
        expect(resolveWestonSurface('DSI-2', file)).toEqual({ width: 1280, height: 720 });
        expect(resolveWestonSurface('HDMI-A-1', file)).toEqual({ width: 1920, height: 1080 });
    });
});
