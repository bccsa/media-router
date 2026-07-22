import { describe, expect, it } from 'vitest';
import { codecChip, compactPortLabel } from './portDisplay';

describe('compactPortLabel', () => {
    it('prefers the in-band/operator name', () => {
        expect(
            compactPortLabel({
                id: 'pid-0xc9',
                label: 'Audio nor (aac, PID 0xc9)',
                streamInfo: { name: 'FOH Mix', language: 'nor', pid: 201, codec: 'aac' },
            }),
        ).toBe('FOH Mix');
    });

    it('falls back to the ISO 639 language', () => {
        expect(
            compactPortLabel({
                id: 'pid-0xc9',
                label: 'Audio nor (aac, PID 0xc9)',
                streamInfo: { language: 'nor', pid: 201, codec: 'aac' },
            }),
        ).toBe('nor');
        // Blank name is unset, not a name.
        expect(
            compactPortLabel({
                id: 'p',
                label: 'l',
                streamInfo: { name: '   ', language: 'deu', pid: 202 },
            }),
        ).toBe('deu');
    });

    it('falls back to the PID in decimal', () => {
        expect(
            compactPortLabel({
                id: 'pid-0xc9',
                label: 'Audio (aac, PID 0xc9)',
                streamInfo: { pid: 0xc9, codec: 'aac' },
            }),
        ).toBe('201');
    });

    it('keeps the full label for ports without streamInfo (role pins)', () => {
        expect(compactPortLabel({ id: 'mpegts-in', label: 'MPEG-TS In' })).toBe('MPEG-TS In');
        expect(compactPortLabel({ id: 'x', label: '' })).toBe('x');
    });
});

describe('codecChip', () => {
    it('tints the chip by media type', () => {
        expect(codecChip({ streamInfo: { codec: 'aac', media: 'audio' } })).toMatchObject({
            text: 'aac',
            classes: expect.stringContaining('emerald'),
        });
        expect(codecChip({ streamInfo: { codec: 'h264', media: 'video' } })).toMatchObject({
            text: 'h264',
            classes: expect.stringContaining('violet'),
        });
        expect(codecChip({ streamInfo: { codec: 'private', media: 'data' } })!.classes).toContain(
            'bg-white/10',
        );
    });

    it('returns null when the codec is unknown', () => {
        expect(codecChip({ streamInfo: { language: 'nor' } })).toBeNull();
        expect(codecChip({})).toBeNull();
    });
});
