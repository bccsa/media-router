import { describe, it, expect } from 'vitest';
import {
    KLV_PAYLOAD_MAX_BYTES,
    mergeKlvNames,
    parseKlvPayload,
} from './klvNames.js';

describe('parseKlvPayload — happy path', () => {
    it('parses a v1 payload into a PID→name map', () => {
        const r = parseKlvPayload(
            '{"v":1,"streams":[{"pid":256,"media":"video","name":"Cam 1"},{"pid":321,"media":"audio","name":"FOH Mix"}]}',
        );
        expect(r.malformed).toBe(false);
        expect(r.names.get(256)).toBe('Cam 1');
        expect(r.names.get(321)).toBe('FOH Mix');
    });

    it('ignores unknown extra fields (forward-compat)', () => {
        const r = parseKlvPayload(
            '{"v":1,"extra":true,"streams":[{"pid":256,"name":"X","lang":"eng"}]}',
        );
        expect(r.malformed).toBe(false);
        expect(r.names.get(256)).toBe('X');
    });

    it('trims names and skips blank ones', () => {
        const r = parseKlvPayload('{"v":1,"streams":[{"pid":1,"name":"  A  "},{"pid":2,"name":"  "}]}');
        expect(r.names.get(1)).toBe('A');
        expect(r.names.has(2)).toBe(false);
    });
});

describe('parseKlvPayload — absence is a non-event', () => {
    it('null / undefined → empty, not malformed', () => {
        for (const v of [null, undefined]) {
            const r = parseKlvPayload(v);
            expect(r.names.size).toBe(0);
            expect(r.malformed).toBe(false);
        }
    });

    it('an unknown but well-formed version is a clean skip, not malformed', () => {
        const r = parseKlvPayload('{"v":2,"streams":[{"pid":1,"name":"A"}]}');
        expect(r.names.size).toBe(0);
        expect(r.malformed).toBe(false);
    });
});

describe('parseKlvPayload — garbage never throws and is flagged malformed', () => {
    it('invalid JSON', () => {
        const r = parseKlvPayload('{not json');
        expect(r.names.size).toBe(0);
        expect(r.malformed).toBe(true);
    });
    it('wrong top-level shape', () => {
        expect(parseKlvPayload('42').malformed).toBe(true);
        expect(parseKlvPayload('"a string"').malformed).toBe(true);
        expect(parseKlvPayload('[1,2,3]').malformed).toBe(true);
    });
    it('missing/invalid version field', () => {
        expect(parseKlvPayload('{"streams":[]}').malformed).toBe(true);
        expect(parseKlvPayload('{"v":"1","streams":[]}').malformed).toBe(true);
    });
    it('streams is not an array', () => {
        expect(parseKlvPayload('{"v":1,"streams":{}}').malformed).toBe(true);
    });
    it('oversized payload is dropped without parsing', () => {
        const big = '{"v":1,"streams":[]}' + 'x'.repeat(KLV_PAYLOAD_MAX_BYTES);
        const r = parseKlvPayload(big);
        expect(r.names.size).toBe(0);
        expect(r.malformed).toBe(true);
    });
    it('skips individual entries with a bad pid or name without failing the whole payload', () => {
        const r = parseKlvPayload(
            '{"v":1,"streams":[{"pid":"x","name":"A"},{"pid":2},{"pid":3,"name":"C"}]}',
        );
        expect(r.malformed).toBe(false);
        expect(r.names.size).toBe(1);
        expect(r.names.get(3)).toBe('C');
    });
});

describe('mergeKlvNames — last-known labels survive a metadata gap', () => {
    it('overlays new names and keeps prior ones', () => {
        const store = new Map<number, string>([[1, 'old']]);
        mergeKlvNames(store, new Map([[1, 'new'], [2, 'two']]));
        expect(store.get(1)).toBe('new');
        expect(store.get(2)).toBe('two');
    });
    it('an empty parse leaves the store untouched (absence ≠ erase)', () => {
        const store = new Map<number, string>([[1, 'keep']]);
        mergeKlvNames(store, new Map());
        expect(store.get(1)).toBe('keep');
    });
});
