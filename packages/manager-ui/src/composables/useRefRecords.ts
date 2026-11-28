import { watch, getCurrentInstance, onUnmounted, type ComputedRef } from 'vue';
import type { EditorLayout } from '@media-router/shared-types';
import { useSocketStore } from '@/stores/socket';
import { missingRefKeys, stalePositionKeys } from '@/utils/crossRefs';
import type { DerivedRefs } from '@/utils/crossRefTypes';

/** Quiet time before the pass runs, so a burst of changes sends one write. */
export const REF_PASS_DELAY_MS = 300;

/** A stale place's item: `<ref key>/pos` (ref keys hold no '/'). */
const POS = '/pos';

/**
 * Keeps an engine's stored tag records in step with the tags drawn (ADR-0030),
 * in one debounced pass:
 * - a tag with no number gets its `refs/<key>` record added; the manager
 *   assigns `n` and the echo brings it;
 * - a record whose tag is gone loses its dragged place (stalePositionKeys).
 * Every open editor runs it; the manager swallows a repeat.
 *
 * Items are the paths below `refs/`. One is never re-sent while in flight, and
 * one the manager refused is not retried while it is still due, so nothing
 * loops. It raises no toasts: it writes through the tree client, not
 * `usePatch` (ref adds are never applied locally anyway). A lost connection
 * is retried on the next change.
 */
export function useRefRecords(
    engineId: () => string,
    derived: ComputedRef<DerivedRefs>,
    editor: () => EditorLayout | undefined,
) {
    const inFlight = new Set<string>();
    const failed = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const due = (): string[] => [
        ...missingRefKeys(derived.value),
        ...stalePositionKeys(editor(), derived.value).map((key) => key + POS),
    ];

    function schedule() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(run, REF_PASS_DELAY_MS);
    }

    function run() {
        timer = null;
        const items = due();
        const live = new Set(items);
        // A refused item that is no longer due gets one more try if it comes back.
        for (const item of failed) if (!live.has(item)) failed.delete(item);
        const todo = items.filter((item) => !inFlight.has(item) && !failed.has(item));
        if (todo.length > 0) send(engineId(), todo);
    }

    function send(eid: string, items: string[]) {
        for (const item of items) inFlight.add(item);
        const prefix = `/engines/${eid}/editor/refs/`;
        useSocketStore()
            .write(
                items.map((item) =>
                    item.endsWith(POS)
                        ? { op: 'remove' as const, path: prefix + item }
                        : { op: 'add' as const, path: prefix + item, value: {} },
                ),
            )
            .then(({ rejected }) => {
                if (rejected.length === 0) return;
                console.warn('[cross-refs] tag records refused', rejected);
                // A refused batch rejects every editor op in it.
                for (const r of rejected) failed.add(r.path.slice(prefix.length));
            })
            .catch((err) => console.warn('[cross-refs] tag records not sent', err))
            .finally(() => items.forEach((item) => inFlight.delete(item)));
    }

    // Every change runs the pass, an emptied set too: that is when refused items are let go.
    watch(() => due().sort().join('\n'), schedule, { immediate: true });
    // Another engine: its items start fresh.
    watch(engineId, () => {
        inFlight.clear();
        failed.clear();
    });
    if (getCurrentInstance())
        onUnmounted(() => {
            if (timer) clearTimeout(timer);
        });

    return { inFlight, failed, run };
}
