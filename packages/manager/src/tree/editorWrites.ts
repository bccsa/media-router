import { PAGE_ID_PATTERN, isRefKey, type PatchOp } from '@media-router/shared-types';

const writable = (ok: boolean) => (ok ? null : 'not writable');

/**
 * Op shapes a browser may write under `/engines/<id>/editor` (ADR-0030); `rel`
 * is the path below `editor`. The values are checked by `EditorBatch`
 * (editorRules.ts) once the batch has run; `nextRef` is the manager's own.
 */
export function editorOpError(op: PatchOp, rel: readonly string[]): string | null {
    const [record, key, field, ...deeper] = rel;
    if (record === undefined) return writable(op.op === 'replace');
    if (key === undefined || deeper.length > 0) return 'not writable';
    const leaf = field === undefined;
    switch (record) {
        case 'pages':
            if (!PAGE_ID_PATTERN.test(key)) return 'invalid page id';
            return writable(
                leaf
                    ? op.op !== 'replace'
                    : (field === 'name' || field === 'order') && op.op === 'replace',
            );
        case 'modulePages':
            return writable(leaf);
        case 'refs':
            if (!isRefKey(key)) return 'invalid ref key';
            return writable(leaf ? op.op !== 'replace' : field === 'name' || field === 'pos');
        case 'tagged':
            return writable(leaf && op.op !== 'replace');
        default:
            return 'not writable';
    }
}
