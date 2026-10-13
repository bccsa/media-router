import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    buildLatenessTap,
    latenessTapAvailable,
    setLatenessTapAvailable,
    withLatenessTap,
} from './latenessTap.js';

describe('output lateness taps', () => {
    afterEach(() => {
        delete process.env.MR_PLUGINS_DIR;
        delete process.env.MR_LIBEXEC_DIR;
        setLatenessTapAvailable(true);
    });

    it('measures in running time, right before the sink', () => {
        expect(buildLatenessTap('lat_render')).toBe(
            'mrlateness name=lat_render reference=running-time',
        );
        expect(withLatenessTap('lat_egress', 'udpsink name=out')).toBe(
            'mrlateness name=lat_egress reference=running-time ! udpsink name=out',
        );
    });

    it('drops out when the instrument is missing', () => {
        setLatenessTapAvailable(false);
        expect(buildLatenessTap('lat_render')).toBeNull();
        expect(withLatenessTap('lat_render', 'fakesink')).toBe('fakesink');
    });

    it('probes for libgstmrlateness.so once, by path', () => {
        const root = mkdtempSync(join(tmpdir(), 'mr-lat-'));
        try {
            process.env.MR_PLUGINS_DIR = root;
            process.env.MR_LIBEXEC_DIR = join(root, 'libexec');
            setLatenessTapAvailable(undefined);
            expect(latenessTapAvailable()).toBe(false);
            const dir = join(root, 'mpegts-core', 'native', 'mrlateness');
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, 'libgstmrlateness.so'), '');
            // Cached: the file appearing later does not flip a running process.
            expect(latenessTapAvailable()).toBe(false);
            setLatenessTapAvailable(undefined);
            expect(latenessTapAvailable()).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
