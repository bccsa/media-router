import * as shared from '@media-router/shared-types';
import type { EditorLayout, PatchOp } from '@media-router/shared-types';
import { IMPLICIT_PAGE_ID, pageResolver, sortedPages } from './crossRefs';

// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
const { DEFAULT_PAGE_NAME, EDITOR_PATH: EDITOR, PAGE_ID_PATTERN, pageNameError } = shared;

// Op lists for the routing editor's pages (ADR-0030), sent with
// `patch.editor(engineId, ops)`. Paths are engine-relative: `/editor/...`, plus
// `/modules/<id>/position` for a move. `moduleIds` is every module of the
// engine. Builders never validate names (the manager does, and a clash comes
// back as a toast); they trim them.

const setPage = (moduleId: string, pageId: string): PatchOp => ({
    op: 'add',
    path: `${EDITOR}/modulePages/${moduleId}`,
    value: pageId,
});
const setOrder = (pageId: string, order: number): PatchOp => ({
    op: 'replace',
    path: `${EDITOR}/pages/${pageId}/order`,
    value: order,
});
/** The layout has real pages (else everything is on the implicit Page 1). */
export const hasPages = (editor: EditorLayout | undefined) =>
    Object.keys(editor?.pages ?? {}).length > 0;

/** A fresh page id: `pg-` + lowercase alphanumerics, never one in use or the implicit page's. */
export function newPageId(taken: Iterable<string>): string {
    const used = new Set(taken).add(IMPLICIT_PAGE_ID);
    for (;;) {
        const id = `pg-${Math.random().toString(36).slice(2, 10)}`;
        if (PAGE_ID_PATTERN.test(id) && !used.has(id)) return id;
    }
}

/** "Page N": the first free N from the page count + 1 up. */
export function nextPageName(editor: EditorLayout | undefined): string {
    const names = sortedPages(editor).map((p) => p.name);
    for (let n = names.length + 1; ; n++) {
        if (pageNameError(`Page ${n}`, names) === null) return `Page ${n}`;
    }
}

/**
 * Write the implicit "Page 1" and pin every module to it, so a later reorder
 * never moves a module. Nothing when the layout already has pages.
 */
export function materialiseOps(
    editor: EditorLayout | undefined,
    moduleIds: readonly string[],
): PatchOp[] {
    if (hasPages(editor)) return [];
    return [
        {
            op: 'add',
            path: `${EDITOR}/pages/${IMPLICIT_PAGE_ID}`,
            value: { name: DEFAULT_PAGE_NAME, order: 0 },
        },
        ...moduleIds.map((id) => setPage(id, IMPLICIT_PAGE_ID)),
    ];
}

/** Pin the modules that sit on the lowest-order page only implicitly (no or an unknown stored page). */
function pinStragglers(editor: EditorLayout, moduleIds: readonly string[]): PatchOp[] {
    const pageFor = pageResolver(editor);
    return moduleIds
        .filter((id) => editor.modulePages[id] !== pageFor(id))
        .map((id) => setPage(id, pageFor(id)));
}

/** A new last page, named `name` or the next free "Page N". */
export function addPageOps(
    editor: EditorLayout | undefined,
    moduleIds: readonly string[],
    name?: string,
): { id: string; ops: PatchOp[] } {
    const id = newPageId(Object.keys(editor?.pages ?? {}));
    const order = Math.max(...sortedPages(editor).map((p) => p.order)) + 1;
    const page = { name: (name ?? nextPageName(editor)).trim(), order };
    return {
        id,
        ops: [
            ...materialiseOps(editor, moduleIds),
            { op: 'add', path: `${EDITOR}/pages/${id}`, value: page },
        ],
    };
}

/**
 * Rename a page; renaming the implicit "Page 1" materialises it first (as an
 * add of "Page 1" and then the rename, so the name lands even if another
 * browser materialised it meanwhile). Nothing for an unknown page or no change.
 */
export function renamePageOps(
    editor: EditorLayout | undefined,
    moduleIds: readonly string[],
    id: string,
    name: string,
): PatchOp[] {
    const trimmed = name.trim();
    const page = sortedPages(editor).find((p) => p.id === id);
    if (!page || page.name === trimmed) return [];
    return [
        ...materialiseOps(editor, moduleIds),
        { op: 'replace', path: `${EDITOR}/pages/${id}/name`, value: trimmed },
    ];
}

/** Move a tab one place left (-1) or right (1): two `order` replaces, stragglers pinned first. */
export function movePageOps(
    editor: EditorLayout | undefined,
    moduleIds: readonly string[],
    id: string,
    delta: -1 | 1,
): PatchOp[] {
    if (!editor || !hasPages(editor)) return [];
    const pages = sortedPages(editor);
    const i = pages.findIndex((p) => p.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= pages.length) return [];
    const pins = pinStragglers(editor, moduleIds);
    const [a, b] = [pages[i], pages[j]];
    if (a.order !== b.order) return [...pins, setOrder(a.id, b.order), setOrder(b.id, a.order)];
    // Equal orders can't be swapped: number every page by its new place.
    [pages[i], pages[j]] = [b, a];
    return [...pins, ...pages.flatMap((p, k) => (p.order === k ? [] : [setOrder(p.id, k)]))];
}

/**
 * Delete page `id`, its modules going to `targetId`; modules elsewhere that
 * sit on a page only implicitly are pinned first. Nothing for the last page,
 * an unknown page or target, or `id === targetId`.
 */
export function deletePageOps(
    editor: EditorLayout | undefined,
    moduleIds: readonly string[],
    id: string,
    targetId: string,
): PatchOp[] {
    if (!editor || !hasPages(editor) || id === targetId) return [];
    if (!Object.hasOwn(editor.pages, id) || !Object.hasOwn(editor.pages, targetId)) return [];
    const pageFor = pageResolver(editor);
    const moves = moduleIds.flatMap((mid) => {
        const page = pageFor(mid);
        if (page === id) return [setPage(mid, targetId)];
        return editor.modulePages[mid] === page ? [] : [setPage(mid, page)];
    });
    return [...moves, { op: 'remove', path: `${EDITOR}/pages/${id}` }];
}

/**
 * Put modules on an existing page, with new positions (crossRefMoves.placeOnPage).
 * For "Move to new page", send `addPageOps(...).ops` first in the same batch.
 */
export function moveModulesOps(
    ids: readonly string[],
    pageId: string,
    positions: ReadonlyArray<{ id: string; x: number; y: number }> = [],
): PatchOp[] {
    return [
        ...ids.map((id) => setPage(id, pageId)),
        ...positions.map(
            ({ id, x, y }): PatchOp => ({
                op: 'replace',
                path: `/modules/${id}/position`,
                value: { x, y },
            }),
        ),
    ];
}
