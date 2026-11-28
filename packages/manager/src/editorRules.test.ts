import { describe, it, expect } from 'vitest';
import { emptyEditorLayout } from '@media-router/shared-types';
import { harness, profile } from './testing/editorHarness.js';

const layout = (over: Record<string, unknown> = {}) => ({ ...emptyEditorLayout(), ...over });
const page = (name: string, order = 0) => ({ name, order });

describe('EditorBatch: seeding', () => {
    it('a profile without editor gets the defaults as a leading cascade, once per batch', () => {
        const h = harness(profile());
        const out = h.write([
            { op: 'add', path: '/editor/pages/pg-a', value: page('A') },
            { op: 'add', path: '/editor/modulePages/m1', value: 'pg-a' },
        ]);
        expect(out).toEqual({ dropped: [], swallowed: [], reasons: {} });
        expect(h.published.map((e) => [e.op.op, e.op.path, e.fromSender])).toEqual([
            ['add', '/editor', false],
            ['add', '/editor/pages/pg-a', true],
            ['add', '/editor/modulePages/m1', true],
        ]);
        expect(h.published[0].op.value).toEqual(emptyEditorLayout());
        expect(h.editor()).toEqual(
            layout({ pages: { 'pg-a': page('A') }, modulePages: { m1: 'pg-a' } }),
        );
    });

    it('no seed when the profile has a layout, or for a whole replace', () => {
        const h = harness(profile(layout()));
        h.write([{ op: 'add', path: '/editor/tagged/c1', value: true }]);
        expect(h.published.map((e) => e.op.path)).toEqual(['/editor/tagged/c1']);
        const bare = harness(profile());
        bare.write([
            { op: 'replace', path: '/editor', value: layout({ pages: { 'pg-a': page('A') } }) },
        ]);
        expect(bare.published.map((e) => e.op.path)).toEqual(['/editor']);
        expect(bare.editor().pages).toEqual({ 'pg-a': page('A') });
    });

    it('a stored layout with invalid entries is rewritten with the valid ones first', () => {
        const h = harness(profile({ ...layout(), pages: { 'pg-a': page('A'), bad: page('B') } }));
        h.write([{ op: 'add', path: '/editor/pages/pg-c', value: page('C', 1) }]);
        expect(h.cascades()).toEqual([
            { op: 'replace', path: '/editor', value: layout({ pages: { 'pg-a': page('A') } }) },
        ]);
        expect(Object.keys(h.editor().pages)).toEqual(['pg-a', 'pg-c']);
    });
});

describe('EditorBatch: ref numbers', () => {
    it('a new ref gets nextRef as its number and the bump goes out as a cascade', () => {
        const h = harness(profile(layout({ nextRef: 5 })));
        h.write([{ op: 'add', path: '/editor/refs/out:m1:out-0', value: { n: 99, name: 'Feed' } }]);
        expect(h.published).toEqual([
            {
                op: { op: 'add', path: '/editor/refs/out:m1:out-0', value: { n: 5, name: 'Feed' } },
                fromSender: true,
            },
            { op: { op: 'replace', path: '/editor/nextRef', value: 6 }, fromSender: false },
        ]);
        expect(h.editor().refs).toEqual({ 'out:m1:out-0': { n: 5, name: 'Feed' } });
        expect(h.editor().nextRef).toBe(6);
    });

    it('two adds in one batch get distinct numbers', () => {
        const h = harness(profile());
        h.write([
            { op: 'add', path: '/editor/refs/out:m1:out-0', value: {} },
            { op: 'add', path: '/editor/refs/in:m2:in-0', value: {} },
        ]);
        expect(h.editor().refs).toEqual({ 'out:m1:out-0': { n: 1 }, 'in:m2:in-0': { n: 2 } });
        expect(h.editor().nextRef).toBe(3);
    });

    it('a field write on a missing record becomes a numbered add', () => {
        const h = harness(profile(layout({ nextRef: 3 })));
        h.write([{ op: 'replace', path: '/editor/refs/in:m2:in-0/pos', value: { x: 4, y: 5 } }]);
        expect(h.published[0].op).toEqual({
            op: 'add',
            path: '/editor/refs/in:m2:in-0',
            value: { n: 3, pos: { x: 4, y: 5 } },
        });
        expect(h.editor().refs['in:m2:in-0']).toEqual({ n: 3, pos: { x: 4, y: 5 } });
    });

    it('a field write on an existing record passes as it is', () => {
        const h = harness(profile(layout({ refs: { 'out:m1:out-0': { n: 1 } }, nextRef: 2 })));
        h.write([{ op: 'add', path: '/editor/refs/out:m1:out-0/name', value: 'Feed' }]);
        expect(h.published).toEqual([
            {
                op: { op: 'add', path: '/editor/refs/out:m1:out-0/name', value: 'Feed' },
                fromSender: true,
            },
        ]);
        expect(h.editor().nextRef).toBe(2);
    });
});

describe('EditorBatch: swallowed ops', () => {
    const stored = () =>
        profile(
            layout({
                pages: { 'pg-a': page('A') },
                refs: { 'out:m1:out-0': { n: 1 } },
                tagged: { c1: true },
                nextRef: 2,
            }),
        );

    it('an add of an existing key and a remove of a missing path change nothing and are not dropped', () => {
        const h = harness(stored());
        const out = h.write([
            { op: 'add', path: '/editor/refs/out:m1:out-0', value: {} },
            { op: 'add', path: '/editor/pages/pg-a', value: page('Other') },
            { op: 'add', path: '/editor/tagged/c1', value: true },
            { op: 'remove', path: '/editor/refs/in:m9:x' },
            { op: 'remove', path: '/editor/refs/out:m1:out-0/name' },
            { op: 'remove', path: '/editor/refs/in:m9:x/pos' },
        ]);
        expect(out).toEqual({ dropped: [], swallowed: [0, 1, 2, 3, 4, 5], reasons: {} });
        expect(h.published).toEqual([]);
        expect(h.sent).toEqual([]);
        expect(h.editor().nextRef).toBe(2);
    });

    it("an add of a module's page sets it: a move is never lost", () => {
        const h = harness(
            profile(
                layout({
                    pages: { 'pg-a': page('A'), 'pg-b': page('B', 1) },
                    modulePages: { m1: 'pg-a' },
                }),
            ),
        );
        expect(
            h.write([{ op: 'add', path: '/editor/modulePages/m1', value: 'pg-b' }]).swallowed,
        ).toEqual([]);
        expect(h.editor().modulePages.m1).toBe('pg-b');
    });
});

describe('EditorBatch: validation', () => {
    it('an invalid name is dropped with its reason; the batch keeps its other ops', () => {
        const h = harness(profile(layout()));
        const out = h.write([
            { op: 'replace', path: '/modules/m1/displayName', value: 'Mic' },
            { op: 'add', path: '/editor/pages/pg-a', value: page('x'.repeat(41)) },
        ]);
        expect(out).toEqual({
            dropped: [1],
            swallowed: [],
            reasons: { 1: 'At most 40 characters' },
        });
        expect(h.published.map((e) => e.op.path)).toEqual(['/modules/m1/displayName']);
        expect(h.editor().pages).toEqual({});
        expect((h.config.modules as any).m1.displayName).toBe('Mic');
    });

    it('a failing batch loses every sender editor op and their nextRef bumps', () => {
        const h = harness(profile(layout({ pages: { 'pg-a': page('Main') } })));
        const out = h.write([
            { op: 'add', path: '/editor/refs/out:m1:out-0', value: {} },
            { op: 'add', path: '/editor/pages/pg-b', value: page('main', 1) },
        ]);
        expect(out.dropped).toEqual([0, 1]);
        expect(out.reasons).toEqual({
            0: 'Another page already has this name',
            1: 'Another page already has this name',
        });
        expect(h.published).toEqual([]);
        expect(h.sent).toEqual([]);
        expect(h.editor()).toEqual(layout({ pages: { 'pg-a': page('Main') } }));
    });

    it('a failing batch keeps its cleanup', () => {
        const h = harness(profile(layout({ modulePages: { m1: 'pg-a' } })));
        const out = h.write([
            { op: 'remove', path: '/modules/m1' },
            { op: 'add', path: '/editor/pages/pg-a', value: page('') },
        ]);
        expect(out.dropped).toEqual([1]);
        expect(h.cascades()).toContainEqual({ op: 'remove', path: '/editor/modulePages/m1' });
        expect(h.editor().modulePages).toEqual({});
    });

    it('a field write on a page that is gone is dropped with its reason', () => {
        const h = harness(profile(layout()));
        expect(h.write([{ op: 'replace', path: '/editor/pages/pg-x/name', value: 'X' }])).toEqual({
            dropped: [0],
            swallowed: [],
            reasons: { 0: 'That page no longer exists' },
        });
    });

    it('a whole replace keeps what is valid and never lowers nextRef', () => {
        const h = harness(profile(layout({ nextRef: 9 })));
        h.write([
            {
                op: 'replace',
                path: '/editor',
                value: {
                    pages: { 'pg-a': page('A'), nope: page('B') },
                    refs: { 'out:m1:out-0': { n: 2 } },
                    nextRef: 3,
                },
            },
        ]);
        expect(h.editor()).toEqual(
            layout({
                pages: { 'pg-a': page('A') },
                refs: { 'out:m1:out-0': { n: 2 } },
                nextRef: 9,
            }),
        );
    });
});
