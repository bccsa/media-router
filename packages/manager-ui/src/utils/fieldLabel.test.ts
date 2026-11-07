import { describe, it, expect } from 'vitest';
import { fieldLabel } from './fieldLabel';

describe('fieldLabel', () => {
    it('splits camelCase keys into capitalised words', () => {
        expect(fieldLabel('ingestOffsetMs')).toBe('Ingest Offset Ms');
        expect(fieldLabel('port', {})).toBe('Port');
    });

    it('prefers a non-empty schema title', () => {
        expect(fieldLabel('ingestOffsetMs', { title: 'Ingest offset' })).toBe('Ingest offset');
    });

    it('falls back to the humanized key when title is missing, blank or not a string', () => {
        expect(fieldLabel('ptpGmid')).toBe('Ptp Gmid');
        expect(fieldLabel('ptpGmid', { title: '  ' })).toBe('Ptp Gmid');
        expect(fieldLabel('ptpGmid', { title: 42 })).toBe('Ptp Gmid');
    });
});
