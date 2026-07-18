import { describe, it, expect } from 'vitest';
import {
    AUDIO_INPUT_PORT_ID,
    MPEGTS_INPUT_PORT_ID,
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
    it('prefers the operator name, else codec + bitrate, and PCM 302M without bitrate', () => {
        expect(renditionLabel({ name: 'Main', codec: 'opus', bitrate: 128 })).toBe('Main');
        expect(renditionLabel({ name: '', codec: 'opus', bitrate: 128 })).toBe('Opus 128k');
        expect(renditionLabel({ name: '', codec: 'aac', bitrate: 96 })).toBe('AAC 96k');
        expect(renditionLabel({ name: '', codec: 'pcm', bitrate: 128 })).toBe('PCM 302M');
    });
});

describe('buildDynamicPorts', () => {
    it('always exposes both fixed inputs with the right types and caps', () => {
        const ports = buildDynamicPorts([]);
        const mpegts = ports.find((p) => p.id === MPEGTS_INPUT_PORT_ID)!;
        const audio = ports.find((p) => p.id === AUDIO_INPUT_PORT_ID)!;
        expect(mpegts.streamType).toBe('muxed/mpegts');
        expect(mpegts.maxConnections).toBe(1);
        expect(audio.streamType).toBe('audio/302m');
        expect(audio.maxConnections).toBe(-1);
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
