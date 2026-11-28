/**
 * Editor-only layout of one engine's routing graph — pages and cross-reference
 * tags — stored in the profile under `editor` (ADR-0030). Engines store it and
 * ignore it; the manager validates it, numbers refs and cleans up after
 * module, connection and port removals. The UI derives the tags themselves
 * from the connections; `refs` only keeps a tag's number, name and position.
 */
import { z } from 'zod';

/** Top-level profile key of the editor namespace. */
export const EDITOR_KEY = 'editor';
/** Engine-relative patch path of the editor namespace. */
export const EDITOR_PATH = `/${EDITOR_KEY}`;

/** True for an engine-relative patch path in the editor namespace: `/editor` or below it. */
export function isEditorPath(path: string): boolean {
    return path === EDITOR_PATH || path.startsWith(`${EDITOR_PATH}/`);
}

/** A page of the routing editor. The id (record key) is internal; only `name` is shown. */
export interface EditorPage {
    name: string;
    /** Tab position, ascending. */
    order: number;
}

/** Stored part of a cross-reference tag. Key: `refKey(kind, moduleId, portId)`. */
export interface EditorRef {
    /** Manager-assigned number, never reused within the profile. */
    n: number;
    name?: string;
    /** Dragged position; absent = placed beside its port. */
    pos?: { x: number; y: number };
}

export interface EditorLayout {
    /** pageId (`pg-…`) → page. Empty = one implicit "Page 1". */
    pages: Record<string, EditorPage>;
    /** moduleId → pageId. Missing or unknown = the lowest-order page. */
    modulePages: Record<string, string>;
    /** refKey → stored tag fields. */
    refs: Record<string, EditorRef>;
    /** Connection ids drawn as tags although both ends share a page. */
    tagged: Record<string, true>;
    /** Next ref number the manager hands out. */
    nextRef: number;
}

/** `out` = tag beside a module output (handle left); `in` = beside a module input (handle right). */
export type RefKind = 'out' | 'in';

export const PAGE_ID_PATTERN = /^pg-[a-z0-9]+$/;
export const PAGE_NAME_MAX = 40;
export const REF_NAME_MAX = 40;
/** Name shown for the implicit page of a layout with no pages. */
export const DEFAULT_PAGE_NAME = 'Page 1';

export function emptyEditorLayout(): EditorLayout {
    return { pages: {}, modulePages: {}, refs: {}, tagged: {}, nextRef: 1 };
}

export function refKey(kind: RefKind, moduleId: string, portId: string): string {
    return `${kind}:${moduleId}:${portId}`;
}

/** Inverse of `refKey`; module ids hold no ':', a port id may. */
export function parseRefKey(
    key: string,
): { kind: RefKind; moduleId: string; portId: string } | null {
    const m = /^(out|in):([^:]+):(.+)$/.exec(key);
    return m ? { kind: m[1] as RefKind, moduleId: m[2], portId: m[3] } : null;
}

/**
 * Why `name` can't be a page name, or null when it can. `others` are the other
 * pages' names; the comparison is trimmed and case-insensitive.
 */
export function pageNameError(name: string, others: string[]): string | null {
    const trimmed = name.trim();
    if (trimmed.length === 0) return 'A page needs a name';
    if (trimmed.length > PAGE_NAME_MAX) return `At most ${PAGE_NAME_MAX} characters`;
    const lower = trimmed.toLowerCase();
    if (others.some((o) => o.trim().toLowerCase() === lower))
        return 'Another page already has this name';
    return null;
}

// --- Validation (manager writes) and the stored-value parse ------------------

/** Cap on a layout's JSON size; a large profile's layout is about 8 KB. */
export const EDITOR_MAX_BYTES = 256 * 1024;

/** A record key usable unescaped in a patch path (applyJsonPatch splits on '/' and never unescapes). */
const KEY_PATTERN = /^[^/~]+$/;
/** Module ids hold no ':' (refKey relies on it). */
const MODULE_KEY_PATTERN = /^[^/~:]+$/;

/** A well-formed `refKey` that is also usable in a patch path. */
export function isRefKey(key: string): boolean {
    return KEY_PATTERN.test(key) && parseRefKey(key) !== null;
}

const PageId = z.string().regex(PAGE_ID_PATTERN);

export const EditorPageSchema = z.object({
    name: z
        .string()
        .refine((s) => s === s.trim(), 'Page names have no leading or trailing spaces')
        .refine((s) => s.length > 0, 'A page needs a name')
        .refine((s) => s.length <= PAGE_NAME_MAX, `At most ${PAGE_NAME_MAX} characters`),
    order: z.number(),
});

/** A dragged tag's place. */
export const EditorPosSchema = z.object({ x: z.number(), y: z.number() });

export const EditorRefSchema = z.object({
    n: z.number().int().positive(),
    name: z.string().max(REF_NAME_MAX, `At most ${REF_NAME_MAX} characters`).optional(),
    pos: EditorPosSchema.optional(),
});

/** The whole layout, as the manager checks it after every batch of editor writes. */
export const EditorLayoutSchema = z
    .object({
        pages: z.record(PageId, EditorPageSchema),
        modulePages: z.record(z.string().regex(MODULE_KEY_PATTERN), PageId),
        refs: z.record(z.string().refine(isRefKey, 'invalid ref key'), EditorRefSchema),
        tagged: z.record(z.string().regex(KEY_PATTERN), z.literal(true)),
        nextRef: z.number().int().positive(),
    })
    .superRefine((layout, ctx) => {
        const names = new Set<string>();
        for (const [id, page] of Object.entries(layout.pages)) {
            const lower = page.name.toLowerCase();
            if (names.has(lower)) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['pages', id, 'name'],
                    message: 'Another page already has this name',
                });
            }
            names.add(lower);
        }
        const numbers = new Set<number>();
        for (const [key, ref] of Object.entries(layout.refs)) {
            if (numbers.has(ref.n))
                ctx.addIssue({
                    code: 'custom',
                    path: ['refs', key, 'n'],
                    message: 'duplicate ref number',
                });
            if (ref.n >= layout.nextRef)
                ctx.addIssue({
                    code: 'custom',
                    path: ['nextRef'],
                    message: 'nextRef must exceed every ref number',
                });
            numbers.add(ref.n);
        }
        if (JSON.stringify(layout).length > EDITOR_MAX_BYTES) {
            ctx.addIssue({ code: 'custom', path: [], message: 'The page layout is too large' });
        }
    });

/** The entries of one stored record; anything but an object is dropped whole (named in `dropped`). */
function storedEntries(value: unknown, name: string, dropped: string[]): Array<[string, unknown]> {
    if (value === undefined) return [];
    if (value !== null && typeof value === 'object' && !Array.isArray(value))
        return Object.entries(value);
    dropped.push(name);
    return [];
}

/**
 * Read a stored `editor` value (profile, import, rollback, the UI's mirror).
 * Never throws and never resets the whole layout, so version skew can't wipe
 * it: unknown keys are stripped and each invalid entry is dropped on its own
 * and named in `dropped` (`pages/<id>`, `refs/<key>`, …) for the caller to log.
 * A later page with a name already taken, or a later ref with a number already
 * used, is the one dropped. `nextRef` is raised above every kept number.
 */
export function parseStoredEditorLayout(raw: unknown): { layout: EditorLayout; dropped: string[] } {
    const layout = emptyEditorLayout();
    const dropped: string[] = [];
    if (raw === undefined || raw === null) return { layout, dropped };
    if (typeof raw !== 'object' || Array.isArray(raw)) return { layout, dropped: ['editor'] };
    const stored = raw as Record<string, unknown>;

    const names = new Set<string>();
    for (const [id, value] of storedEntries(stored.pages, 'pages', dropped)) {
        const page = EditorPageSchema.safeParse(value);
        if (!PAGE_ID_PATTERN.test(id) || !page.success || names.has(page.data.name.toLowerCase())) {
            dropped.push(`pages/${id}`);
            continue;
        }
        names.add(page.data.name.toLowerCase());
        layout.pages[id] = page.data;
    }
    for (const [moduleId, pageId] of storedEntries(stored.modulePages, 'modulePages', dropped)) {
        if (
            MODULE_KEY_PATTERN.test(moduleId) &&
            typeof pageId === 'string' &&
            PAGE_ID_PATTERN.test(pageId)
        ) {
            layout.modulePages[moduleId] = pageId;
        } else dropped.push(`modulePages/${moduleId}`);
    }
    let maxN = 0;
    const numbers = new Set<number>();
    for (const [key, value] of storedEntries(stored.refs, 'refs', dropped)) {
        const ref = EditorRefSchema.safeParse(value);
        if (!isRefKey(key) || !ref.success || numbers.has(ref.data.n)) {
            dropped.push(`refs/${key}`);
            continue;
        }
        numbers.add(ref.data.n);
        maxN = Math.max(maxN, ref.data.n);
        layout.refs[key] = ref.data;
    }
    for (const [connectionId, value] of storedEntries(stored.tagged, 'tagged', dropped)) {
        if (KEY_PATTERN.test(connectionId) && value === true) layout.tagged[connectionId] = true;
        else dropped.push(`tagged/${connectionId}`);
    }
    const next = stored.nextRef;
    if (typeof next === 'number' && Number.isInteger(next) && next > maxN) layout.nextRef = next;
    else {
        layout.nextRef = maxN + 1;
        if (next !== undefined) dropped.push('nextRef');
    }
    return { layout, dropped };
}
