import { shallowRef, watch, type ComputedRef } from 'vue';
import { useVueFlow, type Node, type XYPosition } from '@vue-flow/core';
import type { EngineState } from '@/stores/engines';
import { draggedNodes, type NodeDragPayload } from '@/composables/useGraphDrag';
import { DEFAULT_MODULE_POSITION, tagPlace } from '@/utils/xrefCanvas';
import { XREF_NODE_TYPE, type RefNode, type XrefNodeData } from '@/utils/crossRefTypes';

function sameData(a: XrefNodeData, b: XrefNodeData): boolean {
    return (
        a.dimmed === b.dimmed &&
        a.highlighted === b.highlighted &&
        JSON.stringify(a.ref) === JSON.stringify(b.ref)
    );
}

/**
 * Cross-reference tag nodes of the current page (ADR-0030), drawn after the
 * module nodes; the node id is the ref key. A tag sits at its stored place,
 * else beside its port, read from the module node's handleBounds and the
 * tag's own measured size. Those are empty until Vue Flow measures the nodes
 * and are not watched, so undragged tags are placed again on
 * onNodesInitialized and whenever a tag or its module is measured anew (a
 * rename, handles changing), and follow a dragged module through `onNodeDrag`
 * (moved inside Vue Flow only).
 *
 * Nothing is re-sent while a node is dragged: a new nodes array would put the
 * dragged module back at its stored place. The held rebuild runs in `afterDrag`.
 */
export function useXrefNodes(
    engine: ComputedRef<EngineState | undefined>,
    refs: () => RefNode[],
    activeDrags: Set<string>,
    isDimmed: (moduleId: string) => boolean,
    highlighted: () => string | null,
) {
    const { findNode, onNodesChange, onNodesInitialized, updateNode } = useVueFlow();
    // Replaced whole (a drag only moves positions in place): no deep reactivity over the nodes.
    const xrefNodes = shallowRef<Node[]>([]);
    let held = false;

    // Never runs mid-drag (rebuild holds), so the module's stored position is current.
    function place(tag: RefNode): XYPosition {
        const stored = engine.value?.modules[tag.moduleId]?.position ?? DEFAULT_MODULE_POSITION;
        return tagPlace(tag, findNode, stored);
    }

    function build(): Node[] {
        const prev = new Map(xrefNodes.value.map((n) => [n.id, n]));
        return refs().map((tag) => {
            const position = place(tag);
            const data: XrefNodeData = {
                ref: tag,
                dimmed: isDimmed(tag.moduleId),
                highlighted: highlighted() === tag.key,
            };
            const old = prev.get(tag.key);
            if (
                old &&
                old.position.x === position.x &&
                old.position.y === position.y &&
                sameData(old.data, data)
            ) {
                return old;
            }
            // Read-only (grey) tags have no record to store a place in.
            return { id: tag.key, type: XREF_NODE_TYPE, position, data, draggable: !tag.readOnly };
        });
    }

    function rebuild() {
        if (activeDrags.size > 0) {
            held = true;
            return;
        }
        held = false;
        const next = build();
        const prev = xrefNodes.value;
        if (next.length !== prev.length || next.some((n, i) => n !== prev[i])) {
            xrefNodes.value = next;
        }
    }

    // The tags, their modules' stored places, focus dimming and the jump glow.
    const placeDeps = () =>
        refs()
            .map((t) => {
                const p = engine.value?.modules[t.moduleId]?.position;
                return `${t.key}@${p?.x},${p?.y}:${isDimmed(t.moduleId)}`;
            })
            .join(';') + `|${highlighted()}`;
    watch([refs, placeDeps], rebuild, { immediate: true });

    // Handles measured (a page shown, new tags or modules mounted): place undragged tags beside them.
    onNodesInitialized(rebuild);
    // A tag or a tagged module measured anew: onNodesInitialized only covers the first measure.
    onNodesChange((changes) => {
        const sized = new Set(changes.filter((c) => c.type === 'dimensions').map((c) => c.id));
        if (sized.size > 0 && refs().some((t) => sized.has(t.key) || sized.has(t.moduleId))) {
            rebuild();
        }
    });

    /** A module drag: its undragged tags follow it, moved in Vue Flow only. */
    function onNodeDrag(event: NodeDragPayload) {
        const moved = new Set(draggedNodes(event).map((n) => n.id));
        for (const tag of refs()) {
            if (tag.pos || !moved.has(tag.moduleId) || moved.has(tag.key)) continue;
            const position = tagPlace(tag, findNode);
            // Also on the node last sent, so a module rebuild mid-drag re-sends the tag where it is now.
            const sent = xrefNodes.value.find((n) => n.id === tag.key);
            if (sent) sent.position = position;
            updateNode(tag.key, { position: { ...position } });
        }
    }

    /** After a drag stop: run a rebuild that waited for it. */
    function afterDrag() {
        if (held) rebuild();
    }

    return { xrefNodes, onNodeDrag, afterDrag };
}
