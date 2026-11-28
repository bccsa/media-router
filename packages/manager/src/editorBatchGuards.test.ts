import { describe, it, expect } from 'vitest';
import { EDITOR_MAX_BYTES, emptyEditorLayout } from '@media-router/shared-types';
import { engineSenderId } from './PatchRouter.js';
import { harness, profile } from './testing/editorHarness.js';

const layout = (over: Record<string, unknown> = {}) => ({ ...emptyEditorLayout(), ...over });
const page = (name: string, order = 0) => ({ name, order });
const ok = { dropped: [], swallowed: [], reasons: {} };

describe('EditorBatch: what is stored is what was checked', () => {
    it('drops unknown keys from page adds, ref adds and tag positions, for the engine too', () => {
        const h = harness(profile(layout()));
        const junk = 'x'.repeat(1000);
        expect(
            h.write([
                { op: 'add', path: '/editor/pages/pg-a', value: { ...page('A'), junk } },
                {
                    op: 'add',
                    path: '/editor/refs/out:m1:out-0',
                    value: { pos: { x: 1, y: 2, junk }, junk },
                },
                { op: 'add', path: '/editor/refs/in:m2:in-0/pos', value: { x: 3, y: 4, junk } },
            ]),
        ).toEqual(ok);
        expect(JSON.stringify(h.sent)).not.toContain(junk);
        h.write([
            { op: 'replace', path: '/editor/refs/out:m1:out-0/pos', value: { x: 5, y: 6, junk } },
        ]);
        expect(JSON.stringify(h.sent)).not.toContain(junk);
        expect(h.editor()).toEqual(
            layout({
                pages: { 'pg-a': page('A') },
                refs: {
                    'out:m1:out-0': { n: 1, pos: { x: 5, y: 6 } },
                    'in:m2:in-0': { n: 2, pos: { x: 3, y: 4 } },
                },
                nextRef: 3,
            }),
        );
    });

    it('refuses a write that would make the stored layout too large', () => {
        const h = harness(profile(layout({ pages: { 'pg-a': page('A') } })));
        const huge = `pg-${'a'.repeat(EDITOR_MAX_BYTES)}`;
        expect(h.write([{ op: 'add', path: '/editor/modulePages/m1', value: huge }])).toEqual({
            dropped: [0],
            swallowed: [],
            reasons: { 0: 'The page layout is too large' },
        });
        expect(h.editor().modulePages).toEqual({});
    });
});

describe('EditorBatch: an engine relaying a local panel gets the same write rules', () => {
    it('refuses shapes outside the whitelist: numbers are never handed out twice', () => {
        const h = harness(profile(layout({ refs: { 'out:m1:out-0': { n: 8 } }, nextRef: 9 })));
        const out = h.write(
            [{ op: 'replace', path: '/editor/nextRef', value: 2 }],
            engineSenderId('e1'),
        );
        expect(out).toEqual({ dropped: [0], swallowed: [], reasons: { 0: 'not writable' } });
        expect(h.editor().nextRef).toBe(9);
    });
});

describe('EditorBatch: writes about modules or connections that are gone', () => {
    it('swallows page, tag and tagged writes for a module or connection that does not exist', () => {
        const h = harness(profile(layout({ pages: { 'pg-a': page('A') } })));
        expect(
            h.write([
                { op: 'add', path: '/editor/modulePages/gone', value: 'pg-a' },
                { op: 'add', path: '/editor/refs/out:gone:out-0', value: {} },
                { op: 'add', path: '/editor/tagged/c-gone', value: true },
            ]),
        ).toEqual({ dropped: [], swallowed: [0, 1, 2], reasons: {} });
        // No number used up.
        expect(h.editor()).toEqual(layout({ pages: { 'pg-a': page('A') } }));
    });

    it('follows the batch: a module added earlier in it can be placed, one removed cannot', () => {
        const h = harness(profile(layout({ pages: { 'pg-a': page('A') } })));
        const out = h.write([
            { op: 'add', path: '/modules/m3', value: { pluginId: 'p', settings: {} } },
            { op: 'add', path: '/editor/modulePages/m3', value: 'pg-a' },
            { op: 'remove', path: '/modules/m2' },
            { op: 'add', path: '/editor/modulePages/m2', value: 'pg-a' },
        ]);
        expect(out.swallowed).toEqual([3]);
        expect(h.editor().modulePages).toEqual({ m3: 'pg-a' });
    });

    it('a whole replace keeps no entries for modules or connections that are not there', () => {
        const h = harness(profile(layout()));
        const value = layout({
            pages: { 'pg-a': page('A') },
            modulePages: { m1: 'pg-a', gone: 'pg-a' },
            refs: { 'out:m1:out-0': { n: 1 }, 'out:gone:out-0': { n: 2 } },
            tagged: { c1: true, 'c-gone': true },
            nextRef: 3,
        });
        h.write([{ op: 'replace', path: '/editor', value }]);
        expect(h.editor()).toEqual(
            layout({
                pages: { 'pg-a': page('A') },
                modulePages: { m1: 'pg-a' },
                refs: { 'out:m1:out-0': { n: 1 } },
                tagged: { c1: true },
                nextRef: 3,
            }),
        );
    });
});
