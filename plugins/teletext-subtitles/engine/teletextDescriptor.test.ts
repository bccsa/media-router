import { describe, it, expect } from 'vitest';
import {
    announcedLabel,
    announcedPages,
    pageOptions,
    sameAnnounced,
    teletextPagesFromEsInfo,
} from './teletextDescriptor.js';

// ISO 639 descriptor (skipped) + teletext descriptor: eng 888 subtitles (mag 8
// codes as 0), nor 692 subtitles, deu 150 initial page.
const ES_INFO = '0a04656e6700' + '560f' + '656e671088' + '6e6f721692' + '6465750950';

describe('teletextPagesFromEsInfo', () => {
    it('reads language, type, magazine and BCD page from a 0x56 descriptor', () => {
        expect(teletextPagesFromEsInfo(ES_INFO)).toEqual([
            { page: 888, language: 'eng', type: 2 },
            { page: 692, language: 'nor', type: 2 },
            { page: 150, language: 'deu', type: 1 },
        ]);
    });

    it('skips non-BCD pages and junk languages, tolerates truncation', () => {
        expect(teletextPagesFromEsInfo('560a' + '656e6710ff' + '2a2a2a1692')).toEqual([
            { page: 692, language: '', type: 2 },
        ]);
        expect(teletextPagesFromEsInfo('5610656e671088')).toEqual([]); // claims 16 bytes, has 5
        expect(teletextPagesFromEsInfo(undefined)).toEqual([]);
        expect(teletextPagesFromEsInfo('zz')).toEqual([]);
    });
});

describe('announcedPages', () => {
    it('merges all ESs, one entry per page, sorted, subtitle type wins', () => {
        const pages = announcedPages([
            { streamType: 0x1b, esInfo: '' },
            { streamType: 0x06, esInfo: '5605' + '656e670888' }, // 888 as initial page
            { streamType: 0x06, esInfo: ES_INFO },
        ]);
        expect(pages.map((p) => p.page)).toEqual([150, 692, 888]);
        expect(pages[2]).toEqual({ page: 888, language: 'eng', type: 2 });
        expect(announcedPages(undefined)).toEqual([]);
    });

    it('compares lists and builds the pick-list options', () => {
        const a = announcedPages([{ esInfo: ES_INFO }]);
        expect(sameAnnounced(a, announcedPages([{ esInfo: ES_INFO }]))).toBe(true);
        expect(sameAnnounced(a, a.slice(1))).toBe(false);
        expect(announcedLabel(a[0])).toBe('150 deu · initial page');
        expect(pageOptions(a)).toEqual([
            { value: '150', label: '150 deu · initial page' },
            { value: '692', label: '692 nor · subtitles' },
            { value: '888', label: '888 eng · subtitles' },
        ]);
    });
});
