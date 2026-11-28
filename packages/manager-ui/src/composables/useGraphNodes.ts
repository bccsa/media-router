import { ref, watch, nextTick, type ComputedRef } from 'vue';
import { useVueFlow, type Node } from '@vue-flow/core';
import type { EngineState } from '@/stores/engines';
import { pageResolver } from '@/utils/crossRefs';
import { DEFAULT_MODULE_POSITION } from '@/utils/xrefCanvas';

/**
 * Module nodes of the routing canvas, bound to <VueFlow :nodes>: the modules
 * on the current page (ADR-0030), or every module when no page is given.
 *
 * Position sources: `mod.position` is persistent (DB-backed); during an
 * active drag we read live position from `findNode(id).position` (Vue Flow's
 * internal store), NOT from `nodes.value` — its two-way sync with Vue Flow
 * lags by a microtask and was the source of the snap-back race.
 *
 * Per-node change detection preserves refs when nothing relevant changed,
 * so deep mutations (statusData / health / VU) don't churn the array.
 */
export function useGraphNodes(
    engine: ComputedRef<EngineState | undefined>,
    currentPage?: () => string,
) {
    const { fitView, findNode } = useVueFlow();
    const hasInitialFit = ref(false);
    const nodes = ref<Node[]>([]);
    /** Ids being dragged right now; useGraphDrag adds and removes them. */
    const activeDrags = new Set<string>();
    let shownPage: string | undefined;
    let keepView = false;

    watch(
        [() => engine.value?.modules, () => engine.value?.editor, () => currentPage?.()],
        ([modules, editor, page]) => {
            if (!modules) {
                nodes.value = [];
                return;
            }
            if (page !== shownPage) {
                // Another page fits the view to it, unless the caller centres the view itself.
                if (shownPage !== undefined && !keepView) hasInitialFit.value = false;
                keepView = false;
                shownPage = page;
            }
            const pageFor = pageResolver(editor);
            const prev = new Map((nodes.value as Node[]).map((n) => [n.id, n]));
            const incoming = Object.values(modules).filter(
                (mod) => page === undefined || pageFor(mod.instanceId) === page,
            );
            let changed = incoming.length !== nodes.value.length;
            const next: Node[] = incoming.map((mod) => {
                const livePos = activeDrags.has(mod.instanceId)
                    ? findNode(mod.instanceId)?.position
                    : undefined;
                const desiredPos = livePos ?? mod.position ?? { ...DEFAULT_MODULE_POSITION };
                const old = prev.get(mod.instanceId);
                if (
                    old &&
                    old.data === mod &&
                    old.position.x === desiredPos.x &&
                    old.position.y === desiredPos.y
                ) {
                    return old;
                }
                changed = true;
                return { id: mod.instanceId, type: 'module', position: desiredPos, data: mod };
            });
            if (changed) nodes.value = next;

            if (!hasInitialFit.value && nodes.value.length > 0) {
                hasInitialFit.value = true;
                nextTick(() => fitView({ padding: 0.2 }));
                setTimeout(() => fitView({ padding: 0.2 }), 200);
            }
        },
        { deep: true, immediate: true },
    );

    /** Skip the fit of the next page change: the caller (focusModule) centres the view. */
    function keepViewOnPageChange() {
        keepView = true;
    }

    return { nodes, hasInitialFit, activeDrags, fitView, keepViewOnPageChange };
}
