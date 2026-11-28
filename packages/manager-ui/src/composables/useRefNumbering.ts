import { watch, getCurrentInstance, onUnmounted, type ComputedRef } from 'vue';
import { useSocketStore } from '@/stores/socket';
import { missingRefKeys } from '@/utils/crossRefs';
import type { DerivedRefs } from '@/utils/crossRefTypes';

/** Quiet time before the pass runs, so a burst of changes sends one write. */
export const NUMBERING_DELAY_MS = 300;

/**
 * Gets every tag of an engine a number (ADR-0030): a debounced pass that only
 * adds the missing `refs/<key>` records; the manager assigns `n` and the echo
 * brings it. Every open editor runs it; the manager swallows a second add.
 *
 * A key is never re-sent while in flight, and a key the manager refused is not
 * retried while it stays missing, so nothing loops. It raises no toasts: it
 * writes through the tree client, not `usePatch` (ref adds are never applied
 * locally anyway). A lost connection is retried on the next change.
 */
export function useRefNumbering(engineId: () => string, derived: ComputedRef<DerivedRefs>) {
    const inFlight = new Set<string>();
    const failed = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    function schedule() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(run, NUMBERING_DELAY_MS);
    }

    function run() {
        timer = null;
        const missing = missingRefKeys(derived.value);
        const live = new Set(missing);
        // A refused key that is gone (numbered elsewhere, link removed) gets one more try if it comes back.
        for (const key of failed) if (!live.has(key)) failed.delete(key);
        const todo = missing.filter((key) => !inFlight.has(key) && !failed.has(key));
        if (todo.length > 0) send(engineId(), todo);
    }

    function send(eid: string, keys: string[]) {
        for (const key of keys) inFlight.add(key);
        const prefix = `/engines/${eid}/editor/refs/`;
        useSocketStore()
            .write(keys.map((key) => ({ op: 'add' as const, path: prefix + key, value: {} })))
            .then(({ rejected }) => {
                if (rejected.length === 0) return;
                console.warn('[cross-refs] numbering refused', rejected);
                // A refused batch rejects every editor op in it.
                for (const r of rejected) failed.add(r.path.slice(prefix.length));
            })
            .catch((err) => console.warn('[cross-refs] numbering not sent', err))
            .finally(() => keys.forEach((key) => inFlight.delete(key)));
    }

    // Every change runs the pass, an emptied set too: that is when refused keys are let go.
    watch(() => missingRefKeys(derived.value).sort().join('\n'), schedule, { immediate: true });
    // Another engine: its keys start fresh.
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
