import { ref, watch, type Ref } from 'vue';
import { uniqueValueError, type UniqueRule } from '@/utils/uniqueItemValues';

export interface DraftField extends UniqueRule {
    key: string;
    label: string;
}

/**
 * Rejected array-item edits (`x-unique` duplicate, `x-reserved` value): the
 * typed value stays in its box with an error and is never committed. Drafts
 * are keyed by position, so ANY change to the list (a sibling edit, a remove,
 * an engine write-back) drops them all and every box shows the config again.
 */
export function useUniqueItemDrafts(
    items: Ref<Record<string, unknown>[]>,
    source: () => unknown,
    commit: (index: number, key: string, value: unknown) => void,
) {
    const drafts = ref<Record<string, { value: unknown; error: string }>>({});
    const draftKey = (index: number, key: string) => `${index}:${key}`;

    watch(source, () => {
        drafts.value = {};
    });

    function fieldValue(index: number, key: string): unknown {
        const d = drafts.value[draftKey(index, key)];
        return d ? d.value : items.value[index]?.[key];
    }

    function fieldError(index: number, key: string): string | undefined {
        return drafts.value[draftKey(index, key)]?.error;
    }

    function update(index: number, field: DraftField, value: unknown): void {
        const k = draftKey(index, field.key);
        const siblings = items.value.map((it) => it[field.key]);
        const error = uniqueValueError(field.label, value, index, siblings, {
            unique: field.unique,
            reserved: field.reserved,
        });
        const next = { ...drafts.value };
        if (error) next[k] = { value, error };
        else delete next[k];
        drafts.value = next;
        if (!error) commit(index, field.key, value);
    }

    return { fieldValue, fieldError, update };
}
