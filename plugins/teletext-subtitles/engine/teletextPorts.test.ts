import { describe, it, expect } from 'vitest';
import {
    buildDynamicPorts,
    outputPortId,
    pageLabel,
    readPages,
    readSelectedPages,
    resolvePages,
} from './teletextPorts.js';

describe('readPages', () => {
    it('is empty without a manual list', () => {
        expect(readPages({})).toEqual([]);
        expect(readPages({ pages: [] })).toEqual([]);
    });

    it('sanitises entries: page range, 3-letter lowercase language, trimmed name; skips junk', () => {
        expect(
            readPages({
                pages: [
                    { page: '692', language: ' NOR ', name: ' Norsk ' },
                    { page: 888, language: 'english', name: 7 },
                    { page: 999 },
                    null,
                ],
            }),
        ).toEqual([
            { page: 692, language: 'nor', name: 'Norsk' },
            { page: 888, language: '', name: '' },
        ]);
    });
});

describe('resolvePages', () => {
    const discoveredPages = [
        { page: 888, language: 'eng', type: 2 },
        { page: 692, language: 'nor', type: 2 },
    ];

    it('is empty until something is picked or typed', () => {
        expect(resolvePages({})).toEqual([]);
        expect(resolvePages({ detectedPages: [], pages: [] })).toEqual([]);
    });

    it('picked detected pages take their language from the announced list', () => {
        expect(resolvePages({ detectedPages: ['692', 888, '150'], discoveredPages })).toEqual([
            { page: 692, language: 'nor', name: '' },
            { page: 888, language: 'eng', name: '' },
            { page: 150, language: '', name: '' },
        ]);
        expect(readSelectedPages({ detectedPages: ['abc', '692', 692, 50] })).toEqual([692]);
    });

    it('manual pages follow, a duplicate page number only adds name/language', () => {
        expect(
            resolvePages({
                detectedPages: ['888'],
                discoveredPages,
                pages: [
                    { page: 888, language: 'fra', name: 'English' },
                    { page: 600, language: 'fra' },
                ],
            }),
        ).toEqual([
            { page: 888, language: 'eng', name: 'English' },
            { page: 600, language: 'fra', name: '' },
        ]);
    });

    it('returns the whole union — the caller applies MAX_PAGES', () => {
        const detectedPages = Array.from({ length: 6 }, (_, i) => String(100 + i));
        const pages = Array.from({ length: 6 }, (_, i) => ({ page: 200 + i }));
        expect(resolvePages({ detectedPages, pages })).toHaveLength(12);
    });
});

describe('buildDynamicPorts', () => {
    it('one TS input + one subtitle output per page, keyed by page number', () => {
        const ports = buildDynamicPorts(
            readPages({
                pages: [
                    { page: 888, language: 'eng' },
                    { page: 692, name: 'Norsk' },
                    { page: 150 },
                ],
            }),
        );
        expect(ports.map((p) => p.id)).toEqual(['mpegts-in', 'page-888', 'page-692', 'page-150']);
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

    it('port ids are stable per page number', () => {
        expect(outputPortId(692)).toBe('page-692');
        expect(pageLabel({ page: 888, language: '', name: '' })).toBe('Page 888');
    });
});
