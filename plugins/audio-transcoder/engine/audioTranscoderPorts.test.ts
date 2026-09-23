import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    BITRATE_KBPS,
    INPUT_PORT_ID,
    buildDynamicPorts,
    outputPortId,
    readRenditions,
    renditionLabel,
} from './audioTranscoderPorts.js';

describe('readRenditions', () => {
    it('returns the provisional PCM rendition when the key is absent (pre-start ports)', () => {
        const r = readRenditions({});
        expect(r).toHaveLength(1);
        expect(r[0].codec).toBe('pcm');
    });

    it('honours an explicit empty array (operator removed all outputs)', () => {
        expect(readRenditions({ renditions: [] })).toHaveLength(0);
    });

    it('sanitises codec strictly — unknown collapses to opus, never into the launch string', () => {
        const r = readRenditions({
            renditions: [{ codec: 'pcm' }, { codec: 'aac' }, { codec: 'mp3; rm -rf /' }, null],
        });
        expect(r.map((x) => x.codec)).toEqual(['pcm', 'aac', 'opus', 'opus']);
    });

    it('coerces numerics and clamps count to 8', () => {
        const many = Array.from({ length: 12 }, () => ({ codec: 'opus', bitrate: '96' }));
        const r = readRenditions({ renditions: many });
        expect(r).toHaveLength(8);
        expect(r[0].bitrate).toBe(96);
    });
});

describe('renditionLabel', () => {
    it('accepts any bitrate and clamps it to the codec range (#664)', () => {
        const r = readRenditions({
            renditions: [
                { codec: 'opus', bitrate: 48 },
                { codec: 'opus', bitrate: 9999 },
                { codec: 'opus', bitrate: 0 },
                { codec: 'aac', bitrate: 9999 },
                { codec: 'aac', bitrate: 10 },
                { codec: 'aac', bitrate: 'junk' },
            ],
        });
        expect(r.map((x) => x.bitrate)).toEqual([48, 510, 128, 320, 32, 128]);
    });

    it('manifest rendition bitrate bounds mirror BITRATE_KBPS (#664)', () => {
        const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
        const prop = pkg.mediaRouter.configSchema.properties.renditions.items.properties.bitrate;
        expect(prop.minimum).toBe(Math.min(...Object.values(BITRATE_KBPS).map((r) => r.min)));
        expect(prop.maximum).toBe(Math.max(...Object.values(BITRATE_KBPS).map((r) => r.max)));
        expect(prop['x-maxBy'].map).toEqual({
            opus: BITRATE_KBPS.opus.max,
            aac: BITRATE_KBPS.aac.max,
        });
        expect(prop.default).toBe(BITRATE_KBPS.opus.default);
    });

    it('prefers the operator name, else codec + bitrate, and PCM 302M without bitrate', () => {
        expect(renditionLabel({ name: 'Main', codec: 'opus', bitrate: 128 })).toBe('Main');
        expect(renditionLabel({ name: '', codec: 'opus', bitrate: 128 })).toBe('Opus 128k');
        expect(renditionLabel({ name: '', codec: 'aac', bitrate: 96 })).toBe('AAC 96k');
        expect(renditionLabel({ name: '', codec: 'pcm', bitrate: 128 })).toBe('PCM 302M');
    });
});

describe('buildDynamicPorts', () => {
    it('exposes ONE single-source input, TS-family typed (mixing is the audio-mixer plugin)', () => {
        const ports = buildDynamicPorts([]);
        const inputs = ports.filter((p) => p.direction === 'input');
        expect(inputs).toHaveLength(1);
        expect(inputs[0].id).toBe(INPUT_PORT_ID);
        // Id stays 'mpegts-in' for wire-compat with existing graphs.
        expect(inputs[0].id).toBe('mpegts-in');
        expect(inputs[0].streamType).toBe('muxed/mpegts');
        expect(inputs[0].maxConnections).toBe(1);
        expect(inputs[0].label).toBe('Audio In');
        // Decode-capable input → dual-family dot in the UI.
        expect(inputs[0].acceptsAnyTs).toBe(true);
    });

    it('types outputs per rendition codec: pcm → audio/302m, opus/aac → muxed/mpegts', () => {
        const ports = buildDynamicPorts([
            { name: '', codec: 'opus', bitrate: 128 },
            { name: '', codec: 'pcm', bitrate: 128 },
            { name: '', codec: 'aac', bitrate: 96 },
        ]);
        const outs = ports.filter((p) => p.direction === 'output');
        expect(outs.map((p) => p.id)).toEqual([outputPortId(0), outputPortId(1), outputPortId(2)]);
        expect(outs.map((p) => p.streamType)).toEqual([
            'muxed/mpegts',
            'audio/302m',
            'muxed/mpegts',
        ]);
        // Consumers restart on wire → ordered apply on every output.
        expect(outs.every((p) => p.requiresOrderedApply)).toBe(true);
    });
});

describe('LCP manifest parity', () => {
    it('declares mixer-strip LCP type + the lcp* config fields (it replaces decoder/encoder strips)', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const manifest = JSON.parse(
            readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
        ).mediaRouter;
        expect(manifest.lcpType).toBe('mixer-strip');
        for (const key of ['lcpVisible', 'lcpSortOrder', 'lcpVolumeEnabled', 'lcpMuteEnabled']) {
            expect(manifest.configSchema.properties[key]).toBeDefined();
        }
    });
});
