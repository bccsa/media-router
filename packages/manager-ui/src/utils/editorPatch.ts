// shared-types is CJS: a namespace import is the safe interop (see stores/engines.ts).
import * as shared from '@media-router/shared-types';
import type { EditorLayout, PatchOp } from '@media-router/shared-types';

const { EDITOR_PATH, isEditorPath } = shared;

// How the browser writes the routing editor's layout (ADR-0030). Paths are
// engine-relative (`/editor/...`), like every op `usePatch` sends.

/**
 * A ref add (`refs/<key>`, or a field write on a ref with no record yet) is
 * not applied optimistically: the manager numbers it, and the echo brings the
 * record back with its `n`. Applied locally it would be a record with no number.
 */
export function waitsForEcho(editor: EditorLayout | undefined, op: PatchOp): boolean {
    if (op.op === 'remove' || !isEditorPath(op.path)) return false;
    const [record, key, field] = op.path.slice(EDITOR_PATH.length + 1).split('/');
    if (record !== 'refs' || key === undefined) return false;
    return field === undefined ? op.op === 'add' : !editor?.refs[key];
}

/** Manager reasons a person can act on, reworded; anything else is a plain "not saved". */
const READABLE: Record<string, string> = {
    'Another page already has this name': 'Page name already in use',
    'A page needs a name': 'A page needs a name',
    'Page names have no leading or trailing spaces':
        'Page names have no leading or trailing spaces',
    'That page no longer exists': 'That page no longer exists',
    'The page layout is too large': 'Layout change not saved: the page layout is too large',
};

/** Toast text for a refused editor op: no ids, no internal reasons. */
export function editorRefusalText(path: string, reason: string): string {
    if (reason.startsWith('At most ')) {
        const what = path.includes('/refs/') ? 'Tag name' : 'Page name';
        return `${what} too long (${reason.toLowerCase()})`;
    }
    return READABLE[reason] ?? 'Layout change not saved';
}
