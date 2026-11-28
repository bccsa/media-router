import {
    isPlainObject,
    parseRefKey,
    parseStoredEditorLayout,
    type EditorLayout,
    type LiveArrayIndex,
    type PatchOp,
} from '@media-router/shared-types';

// What the routing editor's layout (ADR-0030) loses when a module, connection
// or port goes, whatever removed it, and what a whole layout keeps of the
// graph it lands on. Pure: the ops returned are profile-relative removes;
// EditorBatch (editorRules.ts) applies and emits them.

export type Keyed = { id?: unknown; sourceModuleId?: unknown; sinkModuleId?: unknown };

const removeOp = (...segments: string[]): PatchOp => ({
    op: 'remove',
    path: ['/editor', ...segments].join('/'),
});

/** The ids in an array of ports or connections. */
export function idsOf(items: unknown): string[] {
    if (!Array.isArray(items)) return [];
    return items
        .map((item) => (item as Keyed | null)?.id)
        .filter((id): id is string => typeof id === 'string');
}

/** Removes for a module's refs on ports that are not in `portIds`; `editor` may be any stored value. */
export function pruneRefsForPorts(
    editor: unknown,
    moduleId: string,
    portIds: Iterable<string>,
): PatchOp[] {
    const refs = isPlainObject(editor) && isPlainObject(editor.refs) ? editor.refs : {};
    const keep = new Set(portIds);
    return Object.keys(refs)
        .filter((key) => {
            const parsed = parseRefKey(key);
            return parsed?.moduleId === moduleId && !keep.has(parsed.portId);
        })
        .map((key) => removeOp('refs', key));
}

/**
 * The cleanup one emitted op needs: a module remove (its page, refs and
 * connections' tagged entries), a connection remove or whole connections
 * write (tagged entries), a ports replace (refs of ports that are gone).
 * `connections` must not have tracked `op` yet, so an index path still names
 * its connection. `layout` is read only for ops that can need cleanup.
 */
export function cleanupFor(
    op: PatchOp,
    layout: () => EditorLayout,
    connections: LiveArrayIndex<Keyed>,
): PatchOp[] {
    const [branch, id, field, ...deeper] = op.path.split('/').slice(1);
    if (branch === 'modules' && id !== undefined) {
        if (field === undefined && op.op === 'remove') {
            return forgetModule(layout(), id, connections);
        }
        if (field === 'ports' && deeper.length === 0 && op.op !== 'remove') {
            return pruneRefsForPorts(layout(), id, idsOf(op.value));
        }
    }
    if (branch === 'connections') {
        if (id === undefined) {
            const kept = new Set(op.op === 'remove' ? [] : idsOf(op.value));
            const tagged = Object.keys(layout().tagged);
            return untag(
                layout(),
                tagged.filter((c) => !kept.has(c)),
            );
        }
        if (field === undefined && op.op === 'remove') {
            return untag(layout(), idsOf([connections.at(id)]));
        }
    }
    return [];
}

/**
 * `layout` without the entries of modules or connections that don't exist —
 * what a whole layout written over a graph (a rollback) keeps. Their ref
 * numbers stay used: nextRef is untouched. Mutates and returns `layout`.
 */
export function dropOrphans(
    layout: EditorLayout,
    hasModule: (id: string) => boolean,
    hasConnection: (id: string) => boolean,
): EditorLayout {
    for (const id of Object.keys(layout.modulePages)) {
        if (!hasModule(id)) delete layout.modulePages[id];
    }
    for (const key of Object.keys(layout.refs)) {
        const moduleId = parseRefKey(key)?.moduleId;
        if (moduleId === undefined || !hasModule(moduleId)) delete layout.refs[key];
    }
    for (const id of Object.keys(layout.tagged)) {
        if (!hasConnection(id)) delete layout.tagged[id];
    }
    return layout;
}

/**
 * What a rollback restores: the version's layout (defaults without one), less
 * entries for modules and connections the version lacks; numbers are never
 * handed out twice.
 */
export function restoredEditor(current: unknown, version: Record<string, unknown>): EditorLayout {
    const layout = parseStoredEditorLayout(version.editor).layout;
    layout.nextRef = Math.max(layout.nextRef, parseStoredEditorLayout(current).layout.nextRef);
    const modules = isPlainObject(version.modules) ? version.modules : {};
    const connections = new Set(idsOf(version.connections));
    return dropOrphans(
        layout,
        (id) => Object.hasOwn(modules, id),
        (id) => connections.has(id),
    );
}

function forgetModule(
    layout: EditorLayout,
    moduleId: string,
    connections: LiveArrayIndex<Keyed>,
): PatchOp[] {
    const ops: PatchOp[] = [];
    if (Object.hasOwn(layout.modulePages, moduleId)) ops.push(removeOp('modulePages', moduleId));
    for (const key of Object.keys(layout.refs)) {
        if (parseRefKey(key)?.moduleId === moduleId) ops.push(removeOp('refs', key));
    }
    // cascadeModuleDelete has removed its connections just before; this catches any it could not.
    const touching = connections
        .snapshot()
        .filter((c) => c.sourceModuleId === moduleId || c.sinkModuleId === moduleId);
    return [...ops, ...untag(layout, idsOf(touching))];
}

function untag(layout: EditorLayout, connectionIds: string[]): PatchOp[] {
    return connectionIds
        .filter((id) => Object.hasOwn(layout.tagged, id))
        .map((id) => removeOp('tagged', id));
}
