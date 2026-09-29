import { describe, it, expect } from 'vitest';
import { diffValues } from './diff.js';

describe('diffValues', () => {
    it('emits leaf ops for changed, added and removed keys', () => {
        const prev = { health: 'ok', statusData: { stats: { bitrate: 1.2, rtt: 10 } } };
        const next = { health: 'ok', statusData: { stats: { bitrate: 1.4 } }, pendingRestart: true };
        expect(diffValues(prev, next, ['m1'])).toEqual([
            { op: 'replace', path: '/m1/statusData/stats/bitrate', value: 1.4 },
            { op: 'remove', path: '/m1/statusData/stats/rtt' },
            { op: 'add', path: '/m1/pendingRestart', value: true },
        ]);
    });

    it('is empty for equal values', () => {
        const v = { a: [1, 2], b: { c: null } };
        expect(diffValues(v, JSON.parse(JSON.stringify(v)))).toEqual([]);
    });

    it('replaces arrays whole', () => {
        expect(diffValues({ vu: [-10, -12] }, { vu: [-10, -11] })).toEqual([
            { op: 'replace', path: '/vu', value: [-10, -11] },
        ]);
    });

    it('keeps null as a value but treats undefined as absent', () => {
        expect(diffValues({ error: 'boom' }, { error: null })).toEqual([
            { op: 'replace', path: '/error', value: null },
        ]);
        expect(diffValues({ error: 'boom' }, { error: undefined })).toEqual([
            { op: 'remove', path: '/error' },
        ]);
    });

    it('escapes keys that contain a slash', () => {
        expect(diffValues({}, { 'Bytes/s': 1 })).toEqual([{ op: 'add', path: '/Bytes~1s', value: 1 }]);
    });

    it('replaces on a type change', () => {
        expect(diffValues({ a: { b: 1 } }, { a: 'x' })).toEqual([{ op: 'replace', path: '/a', value: 'x' }]);
    });
});
