import { describe, it, expect } from 'vitest';
import { descriptorsFromEsInfo, esInfoBytes, isoLanguage } from './esDescriptors.js';

describe('esInfoBytes', () => {
    it('accepts clean even-length hex only', () => {
        expect(esInfoBytes('0a04656e6700')?.length).toBe(6);
        expect(esInfoBytes('')).toBeUndefined();
        expect(esInfoBytes(undefined)).toBeUndefined();
        expect(esInfoBytes('abc')).toBeUndefined();
        expect(esInfoBytes('zz')).toBeUndefined();
    });
});

describe('descriptorsFromEsInfo', () => {
    it('walks tag/length/data in order', () => {
        const d = descriptorsFromEsInfo('0a04656e6700' + '5605' + '656e671088');
        expect(d.map((x) => x.tag)).toEqual([0x0a, 0x56]);
        expect(d[0].data.toString('latin1')).toBe('eng\0');
        expect(d[1].data.length).toBe(5);
    });

    it('drops a truncated tail and never throws on garbage', () => {
        expect(descriptorsFromEsInfo('0a04656e6700' + '5610656e67').map((x) => x.tag)).toEqual([
            0x0a,
        ]);
        expect(descriptorsFromEsInfo('56')).toEqual([]);
        expect(descriptorsFromEsInfo('not hex')).toEqual([]);
    });
});

describe('isoLanguage', () => {
    it('normalises three-letter codes and rejects the rest', () => {
        expect(isoLanguage(' NOR ')).toBe('nor');
        expect(isoLanguage('english')).toBe('');
        expect(isoLanguage(7)).toBe('');
        expect(isoLanguage('en1')).toBe('');
    });
});
