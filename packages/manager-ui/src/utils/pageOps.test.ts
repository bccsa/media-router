import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    applyTreeOp,
    emptyEditorLayout,
    type EditorLayout,
    type PatchOp,
} from '@media-router/shared-types';
import { IMPLICIT_PAGE_ID, pageOf, sortedPages } from './crossRefs';
import {
    addPageOps,
    deletePageOps,
    hasPages,
    materialiseOps,
    moveModulesOps,
    movePageOps,
    newPageId,
    nextPageName,
    renamePageOps,
} from './pageOps';

const MODULES = ['m1', 'm2', 'm3', 'm4'];

/** Three pages; m1 on B, m2 on C, m3 unpinned (implicitly on A), m4 pinned to a page that is gone. */
function threePages(): EditorLayout {
    return {
        ...emptyEditorLayout(),
        pages: {
            'pg-a': { name: 'A', order: 0 },
            'pg-b': { name: 'B', order: 1 },
            'pg-c': { name: 'C', order: 2 },
        },
        modulePages: { m1: 'pg-b', m2: 'pg-c', m4: 'pg-gone' },
    };
}

/** The layout after `ops`, applied as the store applies them. */
function applied(editor: EditorLayout | undefined, ops: PatchOp[]): EditorLayout {
    const root = { editor: JSON.parse(JSON.stringify(editor ?? emptyEditorLayout())) };
    for (const op of ops) applyTreeOp(root, op);
    return root.editor;
}
const pagesOf = (editor: EditorLayout) =>
    Object.fromEntries(MODULES.map((m) => [m, pageOf(editor, m)]));

afterEach(() => vi.restoreAllMocks());

describe('page ids and names', () => {
    it('new ids are pg- plus lowercase alphanumerics, never taken or the implicit one', () => {
        const spy = vi.spyOn(Math, 'random');
        spy.mockReturnValueOnce(0).mockReturnValueOnce(0.5).mockReturnValueOnce(0.25);
        const taken = `pg-${(0.5).toString(36).slice(2, 10)}`;
        const id = newPageId([taken]);
        expect(id).toMatch(/^pg-[a-z0-9]+$/);
        expect(id).not.toBe(taken);
        expect(spy).toHaveBeenCalledTimes(3);
        expect(newPageId([])).not.toBe(IMPLICIT_PAGE_ID);
    });

    it('the default name is the next free "Page N", compared without case', () => {
        expect(nextPageName(undefined)).toBe('Page 2');
        const editor = threePages();
        editor.pages['pg-c'].name = 'page 4';
        expect(nextPageName(editor)).toBe('Page 5');
    });
});

describe('materialise and add', () => {
    it('materialising writes "Page 1" and pins every module to it; nothing once pages exist', () => {
        const ops = materialiseOps(emptyEditorLayout(), MODULES);
        expect(ops[0]).toEqual({
            op: 'add',
            path: `/editor/pages/${IMPLICIT_PAGE_ID}`,
            value: { name: 'Page 1', order: 0 },
        });
        expect(ops.slice(1)).toEqual(
            MODULES.map((m) => ({
                op: 'add',
                path: `/editor/modulePages/${m}`,
                value: IMPLICIT_PAGE_ID,
            })),
        );
        expect(materialiseOps(threePages(), MODULES)).toEqual([]);
    });

    it('the first added page materialises Page 1 in the same batch, then comes after it', () => {
        const { id, ops } = addPageOps(undefined, MODULES);
        const after = applied(undefined, ops);
        expect(sortedPages(after).map((p) => [p.id, p.name])).toEqual([
            [IMPLICIT_PAGE_ID, 'Page 1'],
            [id, 'Page 2'],
        ]);
        expect(Object.values(pagesOf(after))).toEqual(MODULES.map(() => IMPLICIT_PAGE_ID));
    });

    it('a later page goes last with a trimmed name and pins nothing', () => {
        const { id, ops } = addPageOps(threePages(), MODULES, '  Returns ');
        expect(ops).toEqual([
            { op: 'add', path: `/editor/pages/${id}`, value: { name: 'Returns', order: 3 } },
        ]);
    });
});

describe('rename', () => {
    it('renaming the implicit page materialises it, then renames', () => {
        const ops = renamePageOps(undefined, MODULES, IMPLICIT_PAGE_ID, ' Intake ');
        expect(ops.at(-1)).toEqual({
            op: 'replace',
            path: `/editor/pages/${IMPLICIT_PAGE_ID}/name`,
            value: 'Intake',
        });
        const after = applied(undefined, ops);
        expect(after.pages).toEqual({ [IMPLICIT_PAGE_ID]: { name: 'Intake', order: 0 } });
        expect(Object.keys(after.modulePages)).toEqual(MODULES);
    });

    it('a real page is one replace; no change or an unknown page sends nothing', () => {
        expect(renamePageOps(threePages(), MODULES, 'pg-b', 'Out')).toEqual([
            { op: 'replace', path: '/editor/pages/pg-b/name', value: 'Out' },
        ]);
        expect(renamePageOps(threePages(), MODULES, 'pg-b', ' B ')).toEqual([]);
        expect(renamePageOps(threePages(), MODULES, 'pg-x', 'X')).toEqual([]);
    });
});

describe('reorder', () => {
    it('swaps two order values and pins stragglers first', () => {
        const ops = movePageOps(threePages(), MODULES, 'pg-b', -1);
        expect(ops).toEqual([
            { op: 'add', path: '/editor/modulePages/m3', value: 'pg-a' },
            { op: 'add', path: '/editor/modulePages/m4', value: 'pg-a' },
            { op: 'replace', path: '/editor/pages/pg-b/order', value: 0 },
            { op: 'replace', path: '/editor/pages/pg-a/order', value: 1 },
        ]);
    });

    it("never changes a module's page", () => {
        const editor = threePages();
        const before = pagesOf(editor);
        const after = applied(editor, movePageOps(editor, MODULES, 'pg-a', 1));
        expect(sortedPages(after).map((p) => p.id)).toEqual(['pg-b', 'pg-a', 'pg-c']);
        expect(pagesOf(after)).toEqual(before);
    });

    it('equal orders are renumbered by the new tab order', () => {
        const editor = threePages();
        editor.pages['pg-b'].order = 0;
        const after = applied(editor, movePageOps(editor, MODULES, 'pg-b', -1));
        expect(sortedPages(after).map((p) => p.id)).toEqual(['pg-b', 'pg-a', 'pg-c']);
    });

    it('nothing past either end or on the implicit page', () => {
        expect(movePageOps(threePages(), MODULES, 'pg-a', -1)).toEqual([]);
        expect(movePageOps(threePages(), MODULES, 'pg-c', 1)).toEqual([]);
        expect(movePageOps(undefined, MODULES, IMPLICIT_PAGE_ID, 1)).toEqual([]);
    });
});

describe('delete', () => {
    it("moves the page's modules to the chosen page and removes it, pinning stragglers", () => {
        const editor = threePages();
        const ops = deletePageOps(editor, MODULES, 'pg-a', 'pg-c');
        expect(ops.at(-1)).toEqual({ op: 'remove', path: '/editor/pages/pg-a' });
        const after = applied(editor, ops);
        // m3 and m4 sat on A only implicitly: both follow A's modules to C, not to the new lowest page B.
        expect(pagesOf(after)).toEqual({ m1: 'pg-b', m2: 'pg-c', m3: 'pg-c', m4: 'pg-c' });
    });

    it("deleting another page leaves the lowest page's stragglers where they are", () => {
        const editor = threePages();
        const after = applied(editor, deletePageOps(editor, MODULES, 'pg-b', 'pg-c'));
        expect(pagesOf(after)).toEqual({ m1: 'pg-c', m2: 'pg-c', m3: 'pg-a', m4: 'pg-a' });
        expect(Object.keys(after.pages)).toEqual(['pg-a', 'pg-c']);
    });

    it('refuses the last page, an unknown page or target, and a page onto itself', () => {
        const one: EditorLayout = {
            ...emptyEditorLayout(),
            pages: { 'pg-a': { name: 'A', order: 0 } },
        };
        expect(deletePageOps(one, MODULES, 'pg-a', 'pg-a')).toEqual([]);
        expect(deletePageOps(undefined, MODULES, IMPLICIT_PAGE_ID, 'pg-a')).toEqual([]);
        expect(deletePageOps(threePages(), MODULES, 'pg-x', 'pg-a')).toEqual([]);
        expect(deletePageOps(threePages(), MODULES, 'pg-a', 'pg-x')).toEqual([]);
        expect(deletePageOps(threePages(), MODULES, 'pg-b', 'pg-b')).toEqual([]);
    });
});

describe('move modules', () => {
    it("sets each module's page and position in one list", () => {
        expect(moveModulesOps(['m1', 'm3'], 'pg-c', [{ id: 'm1', x: 640, y: 16 }])).toEqual([
            { op: 'add', path: '/editor/modulePages/m1', value: 'pg-c' },
            { op: 'add', path: '/editor/modulePages/m3', value: 'pg-c' },
            { op: 'replace', path: '/modules/m1/position', value: { x: 640, y: 16 } },
        ]);
    });

    it('"Move to new page" = add page + move in one batch', () => {
        const editor = threePages();
        const { id, ops } = addPageOps(editor, MODULES);
        const after = applied(editor, [...ops, ...moveModulesOps(['m2'], id, [])]);
        expect(pageOf(after, 'm2')).toBe(id);
        expect(after.pages[id]).toEqual({ name: 'Page 4', order: 3 });
    });
});

describe('hasPages', () => {
    it('is true only for a layout with real pages', () => {
        expect(hasPages(undefined)).toBe(false);
        expect(hasPages(emptyEditorLayout())).toBe(false);
        expect(hasPages(threePages())).toBe(true);
    });
});
