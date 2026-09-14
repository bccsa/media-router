import { describe, it, expect } from 'vitest';
import { buildDynamicPorts, outputPortId, pageLabel, readPages } from './teletextPorts.js';

describe('readPages', () => {
    it('falls back to one provisional page 888 when config carries none (pre-start)', () => {
        expect(readPages({})).toEqual([{ page: 888, language: 'eng', name: '' }]);
    });

    it('honours an explicit empty array', () => {
        expect(readPages({ pages: [] })).toEqual([]);
    });

    it('sanitises entries: page range, 3-letter lowercase language, trimmed name', () => {
        expect(
            readPages({
                pages: [
                    { page: '692', language: ' NOR ', name: ' Norsk ' },
                    { page: 999, language: 'english', name: 7 },
                    null,
                ],
            }),
        ).toEqual([
            { page: 692, language: 'nor', name: 'Norsk' },
            { page: 888, language: '', name: '' },
            { page: 888, language: '', name: '' },
        ]);
    });

    it('caps at 8 pages', () => {
        const pages = Array.from({ length: 12 }, (_, i) => ({ page: 100 + i }));
        expect(readPages({ pages })).toHaveLength(8);
    });
});

describe('buildDynamicPorts', () => {
    it('one TS input + one subtitle output per page, labelled and typed', () => {
        const ports = buildDynamicPorts(
            readPages({
                pages: [
                    { page: 888, language: 'eng' },
                    { page: 692, name: 'Norsk' },
                    { page: 150 },
                ],
            }),
        );
        expect(ports.map((p) => p.id)).toEqual(['mpegts-in', 'page-0', 'page-1', 'page-2']);
        expect(ports[0]).toMatchObject({
            direction: 'input',
            streamType: 'muxed/mpegts',
            maxConnections: 1,
        });
        expect(ports.slice(1).map((p) => p.label)).toEqual(['eng 888', 'Norsk', 'Page 150']);
        expect(ports[1]).toMatchObject({
            direction: 'output',
            streamType: 'muxed/mpegts',
            requiresOrderedApply: true,
            streamInfo: { media: 'subtitle', codec: 'webvtt', language: 'eng', name: 'eng 888' },
        });
        expect(ports[3].streamInfo).not.toHaveProperty('language');
    });

    it('port ids are stable per index', () => {
        expect(outputPortId(3)).toBe('page-3');
        expect(pageLabel({ page: 888, language: '', name: '' })).toBe('Page 888');
    });
});
