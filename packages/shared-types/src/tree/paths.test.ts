import { describe, it, expect } from 'vitest';
import { splitPath, joinPath, escapeSegment, unescapeSegment, isPrefix } from './paths.js';
import { parsePattern, covers, isAncestorOf, overlaps } from './patterns.js';

describe('tree paths', () => {
    it('splits and joins the root', () => {
        expect(splitPath('/')).toEqual([]);
        expect(splitPath('')).toEqual([]);
        expect(joinPath([])).toBe('/');
    });

    it('round-trips keys with slashes, tildes and spaces', () => {
        const segs = ['engines', 'a/b', 'x~y', 'Waiting for producer'];
        const path = joinPath(segs);
        expect(path).toBe('/engines/a~1b/x~0y/Waiting for producer');
        expect(splitPath(path)).toEqual(segs);
    });

    it('escapes ~ before / so ~1 in a key survives', () => {
        expect(escapeSegment('~1')).toBe('~01');
        expect(unescapeSegment('~01')).toBe('~1');
    });

    it('isPrefix is true for the path itself and its ancestors only', () => {
        expect(isPrefix(['a'], ['a', 'b'])).toBe(true);
        expect(isPrefix(['a', 'b'], ['a', 'b'])).toBe(true);
        expect(isPrefix(['a', 'c'], ['a', 'b'])).toBe(false);
        expect(isPrefix(['a', 'b', 'c'], ['a', 'b'])).toBe(false);
    });
});

describe('tree patterns', () => {
    it('drops a trailing # — a pattern already means its whole subtree', () => {
        expect(parsePattern('/engines/e1/#')).toEqual(['engines', 'e1']);
        expect(parsePattern('/engines/e1')).toEqual(['engines', 'e1']);
    });

    it('covers its node and everything below it', () => {
        const p = parsePattern('/engines/e1');
        expect(covers(p, ['engines', 'e1'])).toBe(true);
        expect(covers(p, ['engines', 'e1', 'modules', 'm', 'vu'])).toBe(true);
        expect(covers(p, ['engines', 'e2'])).toBe(false);
        expect(covers(p, ['engines'])).toBe(false);
    });

    it('+ matches exactly one segment', () => {
        const p = parsePattern('/engines/+/modules/+/health');
        expect(covers(p, ['engines', 'a', 'modules', 'm1', 'health'])).toBe(true);
        expect(covers(p, ['engines', 'a', 'modules', 'm1', 'running'])).toBe(false);
        expect(covers(p, ['engines', 'a', 'modules'])).toBe(false);
    });

    it('an ancestor write overlaps a deeper pattern', () => {
        const p = parsePattern('/engines/+/modules/+/health');
        expect(isAncestorOf(['engines', 'a', 'modules'], p)).toBe(true);
        expect(isAncestorOf(['engines', 'a', 'info'], p)).toBe(false);
        expect(overlaps(p, ['engines', 'a'])).toBe(true);
        expect(overlaps(p, ['groups'])).toBe(false);
    });
});
