// shared-types is CJS: a namespace import is the safe interop (see stores/engines.ts).
import * as shared from '@media-router/shared-types';
import type { EditorLayout, PatchOp } from '@media-router/shared-types';
import type { EngineState } from './engines';

const { emptyEditorLayout, isEditorPath } = shared;

// Graph-branch helpers of the engine store (stores/engines.ts).

/** Engine-level graph branches the mirror can drop once nothing subscribes to them. */
export type GraphBranch = 'modules' | 'connections' | 'interlocks' | 'profiles' | 'editor';

/**
 * The routing editor layout (ADR-0030) an engine patch starts from: a fresh
 * copy when `ops` write it, so watchers comparing old and new layouts see the
 * change; the same object otherwise.
 */
export function editorForPatch(
    editor: EditorLayout | undefined,
    ops: readonly PatchOp[],
): EditorLayout | undefined {
    if (!ops.some((op) => isEditorPath(op.path))) return editor;
    return JSON.parse(JSON.stringify(editor ?? emptyEditorLayout())) as EditorLayout;
}

/** `engine` with the given graph branches emptied. */
export function withoutBranches(engine: EngineState, branches: GraphBranch[]): EngineState {
    const next: EngineState = { ...engine };
    if (branches.includes('modules')) next.modules = {};
    if (branches.includes('connections')) next.connections = [];
    if (branches.includes('interlocks')) next.interlocks = [];
    if (branches.includes('profiles')) next.profiles = undefined;
    if (branches.includes('editor')) next.editor = undefined;
    return next;
}
