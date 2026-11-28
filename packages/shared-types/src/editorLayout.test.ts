import { describe, it, expect } from 'vitest';
import {
    EDITOR_MAX_BYTES,
    EditorLayoutSchema,
    emptyEditorLayout,
    isEditorPath,
    isRefKey,
    parseStoredEditorLayout,
    type EditorLayout,
} from './editorLayout.js';

const layout = (over: Partial<EditorLayout> = {}): EditorLayout => ({
    ...emptyEditorLayout(),
    ...over,
});
const firstIssue = (value: unknown) =>
    EditorLayoutSchema.safeParse(value).error?.issues[0]?.message;

describe('EditorLayoutSchema', () => {
    it('accepts the defaults and a full layout', () => {
        expect(EditorLayoutSchema.safeParse(emptyEditorLayout()).success).toBe(true);
        const full = layout({
            pages: { 'pg-a': { name: 'Inputs', order: 0 }, 'pg-b': { name: 'Outputs', order: 1 } },
            modulePages: { 'audio-input-1': 'pg-a' },
            refs: { 'out:audio-input-1:out-0': { n: 1, name: 'Mic', pos: { x: 10, y: -4 } } },
            tagged: { 'c-1': true },
            nextRef: 2,
        });
        expect(EditorLayoutSchema.safeParse(full).success).toBe(true);
    });

    it('page names: trimmed, 1–40 characters, unique ignoring case', () => {
        const pages = (...names: string[]) =>
            layout({
                pages: Object.fromEntries(names.map((name, i) => [`pg-${i}`, { name, order: i }])),
            });
        expect(firstIssue(pages(''))).toBe('A page needs a name');
        expect(firstIssue(pages(' A'))).toMatch(/spaces/);
        expect(firstIssue(pages('x'.repeat(41)))).toBe('At most 40 characters');
        expect(firstIssue(pages('Main', 'main'))).toBe('Another page already has this name');
        expect(EditorLayoutSchema.safeParse(pages('x'.repeat(40), 'Main')).success).toBe(true);
    });

    it('ids and keys: page ids pg-…, ref keys out|in:<module>:<port>, no / or ~', () => {
        expect(
            EditorLayoutSchema.safeParse(layout({ pages: { '1': { name: 'A', order: 0 } } }))
                .success,
        ).toBe(false);
        expect(
            EditorLayoutSchema.safeParse(layout({ modulePages: { m1: 'page-1' } })).success,
        ).toBe(false);
        expect(
            EditorLayoutSchema.safeParse(layout({ refs: { 'side:m1:p': { n: 1 } }, nextRef: 2 }))
                .success,
        ).toBe(false);
        expect(EditorLayoutSchema.safeParse(layout({ tagged: { 'a/b': true } })).success).toBe(
            false,
        );
        expect(isRefKey('in:m1:port:with:colons')).toBe(true);
        expect(isRefKey('in:m1:a/b')).toBe(false);
    });

    it('ref numbers: unique, below nextRef; positions finite; names ≤ 40', () => {
        expect(
            firstIssue(
                layout({ refs: { 'out:m1:a': { n: 1 }, 'out:m2:a': { n: 1 } }, nextRef: 2 }),
            ),
        ).toBe('duplicate ref number');
        expect(firstIssue(layout({ refs: { 'out:m1:a': { n: 3 } }, nextRef: 3 }))).toMatch(
            /nextRef/,
        );
        expect(
            EditorLayoutSchema.safeParse(
                layout({ refs: { 'out:m1:a': { n: 1, pos: { x: Infinity, y: 0 } } }, nextRef: 2 }),
            ).success,
        ).toBe(false);
        expect(
            EditorLayoutSchema.safeParse(
                layout({ refs: { 'out:m1:a': { n: 1, name: 'x'.repeat(41) } }, nextRef: 2 }),
            ).success,
        ).toBe(false);
    });

    it('caps the overall size', () => {
        const modulePages: Record<string, string> = {};
        for (let i = 0; i * 30 < EDITOR_MAX_BYTES; i++)
            modulePages[`module-${i}-${'x'.repeat(10)}`] = 'pg-a';
        expect(firstIssue(layout({ modulePages }))).toBe('The page layout is too large');
    });
});

describe('parseStoredEditorLayout', () => {
    it('missing → defaults with nothing dropped; not an object → defaults, named', () => {
        expect(parseStoredEditorLayout(undefined)).toEqual({
            layout: emptyEditorLayout(),
            dropped: [],
        });
        expect(parseStoredEditorLayout('junk')).toEqual({
            layout: emptyEditorLayout(),
            dropped: ['editor'],
        });
        expect(parseStoredEditorLayout([])).toEqual({
            layout: emptyEditorLayout(),
            dropped: ['editor'],
        });
    });

    it('fills missing records and keeps a valid layout as it is', () => {
        const stored = {
            pages: { 'pg-a': { name: 'A', order: 0 } },
            refs: { 'in:m1:p': { n: 4 } },
            nextRef: 9,
        };
        const { layout: l, dropped } = parseStoredEditorLayout(stored);
        expect(dropped).toEqual([]);
        expect(l).toEqual({
            pages: stored.pages,
            modulePages: {},
            refs: stored.refs,
            tagged: {},
            nextRef: 9,
        });
        expect(EditorLayoutSchema.safeParse(l).success).toBe(true);
    });

    it('strips unknown keys at every level', () => {
        const { layout: l, dropped } = parseStoredEditorLayout({
            future: 1,
            pages: { 'pg-a': { name: 'A', order: 0, colour: 'red' } },
            refs: { 'out:m1:p': { n: 1, extra: true } },
            nextRef: 2,
        });
        expect(dropped).toEqual([]);
        expect(l).toEqual(
            layout({
                pages: { 'pg-a': { name: 'A', order: 0 } },
                refs: { 'out:m1:p': { n: 1 } },
                nextRef: 2,
            }),
        );
    });

    it('drops each invalid entry on its own, never the whole layout', () => {
        const { layout: l, dropped } = parseStoredEditorLayout({
            pages: {
                'pg-a': { name: 'Main', order: 0 },
                'pg-b': { name: 'MAIN', order: 1 },
                Page7: { name: 'Seven', order: 2 },
                'pg-c': { name: '', order: 3 },
            },
            modulePages: { m1: 'pg-a', m2: 42, 'x:y': 'pg-a' },
            refs: {
                'out:m1:p': { n: 2 },
                'out:m2:p': { n: 2 },
                'bad-key': { n: 3 },
                'in:m1:p': { n: 'x' },
            },
            tagged: { c1: true, c2: 'yes' },
            nextRef: 3,
        });
        expect(dropped).toEqual([
            'pages/pg-b',
            'pages/Page7',
            'pages/pg-c',
            'modulePages/m2',
            'modulePages/x:y',
            'refs/out:m2:p',
            'refs/bad-key',
            'refs/in:m1:p',
            'tagged/c2',
        ]);
        expect(l).toEqual({
            pages: { 'pg-a': { name: 'Main', order: 0 } },
            modulePages: { m1: 'pg-a' },
            refs: { 'out:m1:p': { n: 2 } },
            tagged: { c1: true },
            nextRef: 3,
        });
        expect(EditorLayoutSchema.safeParse(l).success).toBe(true);
    });

    it('a record that is not an object is dropped by name; the rest survives', () => {
        const { layout: l, dropped } = parseStoredEditorLayout({
            pages: [1, 2],
            modulePages: { m1: 'pg-a' },
            nextRef: 5,
        });
        expect(dropped).toEqual(['pages']);
        expect(l.modulePages).toEqual({ m1: 'pg-a' });
        expect(l.nextRef).toBe(5);
    });

    it('raises nextRef above every kept number; a missing one is no drop', () => {
        expect(parseStoredEditorLayout({ refs: { 'out:m1:p': { n: 7 } } })).toMatchObject({
            layout: { nextRef: 8 },
            dropped: [],
        });
        expect(
            parseStoredEditorLayout({ refs: { 'out:m1:p': { n: 7 } }, nextRef: 3 }),
        ).toMatchObject({ layout: { nextRef: 8 }, dropped: ['nextRef'] });
        expect(parseStoredEditorLayout({ nextRef: 1.5 })).toMatchObject({
            layout: { nextRef: 1 },
            dropped: ['nextRef'],
        });
    });
});

describe('isEditorPath', () => {
    it('is the editor namespace only', () => {
        expect(isEditorPath('/editor')).toBe(true);
        expect(isEditorPath('/editor/pages/pg-a')).toBe(true);
        expect(isEditorPath('/editorial')).toBe(false);
        expect(isEditorPath('/modules/editor')).toBe(false);
    });
});
