import type { Node } from '@vue-flow/core';
import { patch } from '@/composables/usePatch';
import { XREF_NODE_TYPE } from '@/utils/crossRefTypes';

/** A Vue Flow node-drag event: group drags list every moved node in `nodes`. */
export interface NodeDragPayload {
    node?: Node;
    nodes?: Node[];
}

/** A dragged cross-reference tag's new place; `key` is its node id (the ref key). */
export interface TagMove {
    key: string;
    x: number;
    y: number;
}

// `node` is only the one grabbed; a group drag moves all of `nodes`.
export function draggedNodes(event: NodeDragPayload): Node[] {
    if (event.nodes?.length) return event.nodes;
    return event.node ? [event.node] : [];
}

/**
 * Node drags: mark the dragged ids live (useGraphNodes then reads their
 * position from Vue Flow) and save every moved position on drop: modules in
 * one patch, cross-reference tags (ADR-0030) through `onTagsMoved`.
 */
export function useGraphDrag(
    engineId: () => string,
    activeDrags: Set<string>,
    onTagsMoved?: (moved: TagMove[]) => void,
) {
    function onNodeDragStart(event: NodeDragPayload) {
        for (const n of draggedNodes(event)) activeDrags.add(n.id);
    }

    function onNodeDragStop(event: NodeDragPayload) {
        const moved = draggedNodes(event);
        for (const n of moved) activeDrags.delete(n.id);
        const tags = moved.filter((n) => n.type === XREF_NODE_TYPE);
        const modules = moved.filter((n) => n.type !== XREF_NODE_TYPE);
        if (tags.length > 0) {
            onTagsMoved?.(tags.map((n) => ({ key: n.id, x: n.position.x, y: n.position.y })));
        }
        if (modules.length === 0) return;
        patch.modulePositions(
            engineId(),
            modules.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })),
        );
    }

    return { onNodeDragStart, onNodeDragStop };
}
