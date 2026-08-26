import { describe, it, expect } from 'vitest';
import { isDisplayWidget, stripDisplayFields } from './displayWidgets';

const field = (key: string, widget?: string) => ({ key, widget });

describe('isDisplayWidget', () => {
    it('knows the virtual display widgets', () => {
        expect(isDisplayWidget('graph')).toBe(true);
    });

    it('leaves real value widgets alone', () => {
        expect(isDisplayWidget('slider')).toBe(false);
        expect(isDisplayWidget('imageUpload')).toBe(false);
        expect(isDisplayWidget(undefined)).toBe(false);
    });
});

describe('stripDisplayFields', () => {
    const fields = [
        field('mode'),
        field('threshold', 'slider'),
        field('transferCurve', 'graph'),
        field('frequencyResponse', 'graph'),
    ];

    it('drops virtual widget keys from the saved patch', () => {
        const settings = {
            mode: 'compressor',
            threshold: -20,
            transferCurve: 'leaked',
            frequencyResponse: null,
        };
        expect(stripDisplayFields(fields, settings)).toEqual({
            mode: 'compressor',
            threshold: -20,
        });
    });

    it('keeps false / 0 / empty-string values of real fields', () => {
        const settings = { mode: '', threshold: 0, eqBypass: false };
        expect(stripDisplayFields(fields, settings)).toEqual(settings);
    });

    it('returns the same object when the schema has no display widgets', () => {
        const settings = { mode: 'gate' };
        expect(stripDisplayFields([field('mode')], settings)).toBe(settings);
    });
});
