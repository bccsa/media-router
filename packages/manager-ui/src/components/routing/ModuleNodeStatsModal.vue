<script setup lang="ts">
import { computed, onUnmounted, watch, type Component } from 'vue';

interface StatusField {
    key: string;
    label: string;
    unit?: string;
}
interface StatusSection {
    id: string;
    label: string;
    fields: StatusField[];
}

const props = defineProps<{
    open: boolean;
    displayName: string;
    iconComponent: Component | null;
    iconColor?: string;
    sections: StatusSection[];
    statusData: Record<string, Record<string, unknown>> | undefined;
}>();

/** A field has a value worth showing (not unset and not the "—" placeholder). */
function hasValue(v: unknown): boolean {
    if (v === undefined || v === null) return false;
    const s = typeof v === 'number' ? String(v) : String(v).trim();
    return s !== '' && s !== '—';
}

/**
 * Only render fields that actually carry a value, and drop any section left
 * with none. Keeps the popup from showing rows of "—" (e.g. an SRT listener's
 * aggregate Live Stats, whose per-flow numbers live in the per-caller sections).
 */
function visibleFields(section: StatusSection): StatusField[] {
    return section.fields.filter((f) => hasValue(props.statusData?.[section.id]?.[f.key]));
}

interface GridItem {
    kind: 'grid';
    section: StatusSection & { fields: StatusField[] };
}
interface TableItem {
    kind: 'table';
    /** Columns shared by every row; columns empty across all rows are dropped. */
    columns: StatusField[];
    rows: StatusSection[];
}

/**
 * Render plan: sections whose field shape (key signature) repeats — the
 * per-stream dynamic sections of a splitter/demuxer — collapse into ONE table
 * (row per section, column per field) at the position of their first member.
 * Unique-shaped sections keep the classic label/value grid, with empty fields
 * filtered as before.
 */
const renderItems = computed<Array<GridItem | TableItem>>(() => {
    const signature = (s: StatusSection) => s.fields.map((f) => f.key).join('|');
    const groups = new Map<string, StatusSection[]>();
    for (const s of props.sections) {
        const sig = signature(s);
        groups.set(sig, [...(groups.get(sig) ?? []), s]);
    }
    const emitted = new Set<string>();
    const items: Array<GridItem | TableItem> = [];
    for (const s of props.sections) {
        const sig = signature(s);
        if (emitted.has(sig)) continue;
        const group = groups.get(sig)!;
        if (group.length >= 2 && s.fields.length > 0) {
            emitted.add(sig);
            const columns = s.fields.filter((f) =>
                group.some((row) => hasValue(props.statusData?.[row.id]?.[f.key])),
            );
            if (columns.length > 0) {
                items.push({ kind: 'table', columns, rows: group });
                continue;
            }
        }
        const fields = visibleFields(s);
        if (fields.length > 0) items.push({ kind: 'grid', section: { ...s, fields } });
    }
    return items;
});

const emit = defineEmits<{ 'update:open': [value: boolean] }>();

function close(): void {
    emit('update:open', false);
}

function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
}

watch(
    () => props.open,
    (open) => {
        if (open) document.addEventListener('keydown', onKeydown);
        else document.removeEventListener('keydown', onKeydown);
    },
);

onUnmounted(() => document.removeEventListener('keydown', onKeydown));

function formatStatusValue(value: unknown, unit?: string): string {
    if (value === undefined || value === null) return '—';
    if (typeof value === 'object') return JSON.stringify(value);
    const str = typeof value === 'number' ? value.toLocaleString() : String(value);
    return unit ? `${str} ${unit}` : str;
}
</script>

<template>
    <Teleport to="body">
        <div
            v-if="open"
            class="fixed inset-0 flex items-center justify-center"
            style="z-index: 10000"
        >
            <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" @click="close" />
            <div
                class="relative w-full max-w-lg max-h-[80vh] overflow-auto rounded-xl shadow-2xl mx-4 bg-card border border-border"
            >
                <!-- Header -->
                <div
                    class="flex items-center justify-between px-5 py-3 sticky top-0 bg-card border-b border-border-alt"
                >
                    <div class="flex items-center gap-2">
                        <component
                            v-if="iconComponent"
                            :is="iconComponent"
                            :size="18"
                            :color="iconColor ?? 'var(--text-muted)'"
                        />
                        <h2 class="text-sm font-semibold text-foreground">
                            {{ displayName }} — Stats
                        </h2>
                    </div>
                    <button @click="close" class="p-1 rounded-md hover:bg-white/10 text-muted">
                        <svg
                            class="w-4 h-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M6 18L18 6M6 6l12 12"
                            />
                        </svg>
                    </button>
                </div>
                <!-- Sections (static from manifest + dynamic from runtime).
                     Same-shaped sections (per-stream detail) collapse into a
                     table; unique sections keep the label/value grid. Empty
                     fields/sections are filtered out — see renderItems. -->
                <div class="p-5 space-y-4">
                    <template v-for="(item, idx) in renderItems" :key="idx">
                        <div v-if="item.kind === 'grid'">
                            <h3
                                class="text-xs font-semibold uppercase tracking-wide mb-2 text-muted"
                            >
                                {{ item.section.label }}
                            </h3>
                            <div class="grid grid-cols-2 gap-x-4 gap-y-1">
                                <template v-for="field in item.section.fields" :key="field.key">
                                    <span class="text-xs text-muted">{{ field.label }}</span>
                                    <span class="text-xs tabular-nums text-right text-foreground">
                                        {{
                                            formatStatusValue(
                                                statusData?.[item.section.id]?.[field.key],
                                                field.unit,
                                            )
                                        }}
                                    </span>
                                </template>
                            </div>
                        </div>
                        <div v-else class="overflow-x-auto">
                            <table class="w-full text-xs">
                                <thead>
                                    <tr class="text-muted border-b border-border-alt">
                                        <th class="text-left font-semibold py-1 pr-3"></th>
                                        <th
                                            v-for="col in item.columns"
                                            :key="col.key"
                                            class="text-right font-semibold py-1 pl-3"
                                        >
                                            {{ col.label }}
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr
                                        v-for="row in item.rows"
                                        :key="row.id"
                                        class="border-b border-border-alt/40 last:border-0"
                                    >
                                        <td class="py-1 pr-3 text-muted whitespace-nowrap">
                                            {{ row.label }}
                                        </td>
                                        <td
                                            v-for="col in item.columns"
                                            :key="col.key"
                                            class="py-1 pl-3 text-right tabular-nums text-foreground whitespace-nowrap"
                                        >
                                            {{
                                                formatStatusValue(
                                                    statusData?.[row.id]?.[col.key],
                                                    col.unit,
                                                )
                                            }}
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </template>
                </div>
            </div>
        </div>
    </Teleport>
</template>
