import { onBeforeUnmount, ref } from 'vue';
import { readEntry, sameValue, type EntryRule } from '@/utils/entryRules';

interface Draft {
    text: string;
    /** Set once the entry is refused: why, and the stored value it was refused against. */
    reason?: string;
    base?: unknown;
}

/**
 * Typed text not yet committed, by box id (B-104): a box binds `shown(id, stored)`, as Vue resets a bound
 * box whenever its owner re-renders. `commit` reads it at Enter, on leaving it or at a spinner step.
 */
export function useEntryDrafts() {
    const drafts = ref<Record<string, Draft>>({});
    // A box removed while focused can still fire change (Blink blurs it): that writes nothing.
    let unmounting = false;
    onBeforeUnmount(() => {
        unmounting = true;
    });

    // A refused entry stays until fixed, unless the stored value moves under it (another writer).
    function current(id: string, stored: unknown): Draft | undefined {
        const d = drafts.value[id];
        return d && (d.reason === undefined || sameValue(d.base, stored)) ? d : undefined;
    }

    return {
        /** What the box shows: its draft, else `display` (the stored value, or its formatting). */
        shown(id: string, stored: unknown, display: unknown = stored): unknown {
            const d = current(id, stored);
            return d ? d.text : display;
        },
        /** Why the box's last entry was refused. */
        reason(id: string, stored: unknown): string | undefined {
            return current(id, stored)?.reason;
        },
        /** The box holds typing not yet committed. */
        typing(id: string, stored: unknown): boolean {
            const d = current(id, stored);
            return !!d && d.reason === undefined;
        },
        onInput(id: string, event: Event): void {
            drafts.value[id] = { text: (event.target as HTMLInputElement).value };
        },
        /** The entry once committed: a valid change, returned once; unchanged or refused, nothing. */
        commit(
            id: string,
            event: Event,
            stored: unknown,
            rule: EntryRule,
        ): { value: string | number } | undefined {
            if (unmounting) return undefined;
            const el = event.target as HTMLInputElement;
            const read = readEntry(el.value, rule, el.validity?.badInput === true);
            if ('reason' in read) {
                drafts.value[id] = { text: el.value, reason: read.reason, base: stored };
                return undefined;
            }
            delete drafts.value[id];
            return sameValue(read.value, stored) ? undefined : read;
        },
        // Focus moving elsewhere in the page ends the edit; a refused entry stays to say why. A switch to
        // another window or tab blurs the box too, with no change event, but leaves it document.activeElement.
        onBlur(id: string, event: FocusEvent): void {
            if (document.activeElement === event.target) return;
            if (drafts.value[id]?.reason === undefined) delete drafts.value[id];
        },
    };
}
