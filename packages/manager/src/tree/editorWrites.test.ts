import { describe, it, expect } from 'vitest';
import type { PatchOp } from '@media-router/shared-types';
import { editorOpError } from './editorWrites.js';

const check = (op: PatchOp['op'], rel: string) =>
    editorOpError({ op, path: '' }, rel ? rel.split('/') : []);

describe('editorOpError', () => {
    it('accepts the whitelisted shapes', () => {
        const allowed: Array<[PatchOp['op'], string]> = [
            ['replace', ''],
            ['add', 'pages/pg-a1'],
            ['remove', 'pages/pg-a1'],
            ['replace', 'pages/pg-a1/name'],
            ['replace', 'pages/pg-a1/order'],
            ['add', 'modulePages/m1'],
            ['replace', 'modulePages/m1'],
            ['remove', 'modulePages/m1'],
            ['add', 'refs/out:m1:out-0'],
            ['remove', 'refs/in:m1:in-0'],
            ['add', 'refs/out:m1:out-0/name'],
            ['replace', 'refs/out:m1:out-0/pos'],
            ['remove', 'refs/out:m1:out-0/pos'],
            ['add', 'tagged/c1'],
            ['remove', 'tagged/c1'],
        ];
        for (const [op, rel] of allowed) expect([op, rel, check(op, rel)]).toEqual([op, rel, null]);
    });

    it('refuses everything else', () => {
        expect(check('add', '')).toBe('not writable');
        expect(check('replace', 'nextRef')).toBe('not writable');
        expect(check('replace', 'pages/pg-a')).toBe('not writable');
        expect(check('add', 'pages/pg-a/name')).toBe('not writable');
        expect(check('replace', 'pages/pg-a/colour')).toBe('not writable');
        expect(check('add', 'pages/1')).toBe('invalid page id');
        expect(check('replace', 'refs/out:m1:p')).toBe('not writable');
        expect(check('replace', 'refs/out:m1:p/n')).toBe('not writable');
        expect(check('add', 'refs/m1:p')).toBe('invalid ref key');
        expect(check('add', 'modulePages/m1/x')).toBe('not writable');
        expect(check('replace', 'tagged/c1')).toBe('not writable');
        expect(check('add', 'refs/out:m1:p/pos/x')).toBe('not writable');
        expect(check('add', 'other/x')).toBe('not writable');
    });
});
