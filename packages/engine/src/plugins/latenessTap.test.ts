import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    buildLatenessTap,
    busEgressLatenessTap,
    busLatenessTap,
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
        expect(busLatenessTap('lat_busin')).toBe('');
        expect(busEgressLatenessTap('lat_busout_41000')).toBe('');
    });

    it('a bus ingress reads house time, a bus egress running time (B-26)', () => {
        // Every bus-fed pipeline runs base 0; an egress may not (video-encoder's natural base),
        // and the stamper writes running time there.
        expect(busLatenessTap('lat_busin')).toBe(' ! mrlateness name=lat_busin reference=house');
        expect(busEgressLatenessTap('lat_busout_41000')).toBe(
            ' ! mrlateness name=lat_busout_41000 reference=running-time',
        );
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
