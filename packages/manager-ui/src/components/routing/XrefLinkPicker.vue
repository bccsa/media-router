<script setup lang="ts">
/**
 * Picker for a wire dropped on empty canvas (ADR-0030): the compatible ports on
 * other pages, grouped by page, then module, in the order given. Choosing one
 * emits `pick`; the caller creates the connection. Escape or a press outside
 * closes it.
 */
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue';
import MrInput from '@/components/common/MrInput.vue';
import { edgeColor } from '@/utils/edgeStyle';
import type {
    LinkCandidate,
    XrefLinkPickerEmits,
    XrefLinkPickerProps,
} from '../../utils/crossRefTypes';

const props = defineProps<XrefLinkPickerProps>();
const emit = defineEmits<XrefLinkPickerEmits>();

const root = ref<HTMLDivElement | null>(null);
const filter = ref('');
const left = ref(props.x);
const top = ref(props.y);

interface ModuleGroup {
    moduleId: string;
    moduleName: string;
    ports: LinkCandidate[];
}
interface PageGroup {
    pageId: string;
    pageName: string;
    modules: ModuleGroup[];
}

const groups = computed<PageGroup[]>(() => {
    const q = filter.value.trim().toLowerCase();
    const pages = new Map<string, PageGroup>();
    for (const c of props.candidates) {
        const text = [c.pageName, c.moduleName, c.portLabel, c.existingRefLabel ?? ''];
        if (q && !text.some((s) => s.toLowerCase().includes(q))) continue;
        let page = pages.get(c.pageId);
        if (!page) {
            page = { pageId: c.pageId, pageName: c.pageName, modules: [] };
            pages.set(c.pageId, page);
        }
        let mod = page.modules.find((m) => m.moduleId === c.moduleId);
        if (!mod) {
            mod = { moduleId: c.moduleId, moduleName: c.moduleName, ports: [] };
            page.modules.push(mod);
        }
        mod.ports.push(c);
    }
    return [...pages.values()];
});

/** Enter in the filter takes the first port shown. */
function pickFirst() {
    const first = groups.value[0]?.modules[0]?.ports[0];
    if (first) emit('pick', first);
}

function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') emit('close');
}
function onPressOutside(e: Event) {
    if (root.value && !root.value.contains(e.target as Node)) emit('close');
}

let rafId: number | null = null;
onMounted(() => {
    document.addEventListener('keydown', onKeydown);
    nextTick(() => {
        if (!root.value) return;
        // Keep the whole list on screen, as MrContextMenu does.
        const rect = root.value.getBoundingClientRect();
        left.value = Math.max(8, Math.min(props.x, window.innerWidth - rect.width - 8));
        top.value = Math.max(8, Math.min(props.y, window.innerHeight - rect.height - 8));
        root.value.querySelector('input')?.focus();
    });
    // A frame later, so the release that opened it doesn't close it.
    rafId = requestAnimationFrame(() => {
        rafId = null;
        document.addEventListener('mousedown', onPressOutside);
        document.addEventListener('touchstart', onPressOutside);
        document.addEventListener('contextmenu', onPressOutside);
    });
});
onUnmounted(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('mousedown', onPressOutside);
    document.removeEventListener('touchstart', onPressOutside);
    document.removeEventListener('contextmenu', onPressOutside);
});
</script>

<template>
    <Teleport to="body">
        <div
            ref="root"
            role="dialog"
            aria-label="Link to another page"
            class="fixed z-50 w-72 flex flex-col rounded-lg shadow-xl text-sm bg-card border border-border"
            :style="{ left: left + 'px', top: top + 'px' }"
        >
            <div
                class="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted"
            >
                Link to another page
            </div>
            <div v-if="candidates.length > 0" class="px-2 pb-1.5">
                <MrInput
                    v-model="filter"
                    placeholder="Filter pages, modules, ports"
                    @keydown.enter="pickFirst"
                />
            </div>
            <div class="max-h-72 overflow-y-auto pb-1">
                <p
                    v-if="candidates.length === 0"
                    data-test="empty"
                    class="px-3 py-2 text-xs text-muted"
                >
                    No compatible ports on other pages.
                </p>
                <p v-else-if="groups.length === 0" class="px-3 py-2 text-xs text-muted">
                    No matches
                </p>
                <template v-for="page in groups" :key="page.pageId">
                    <div
                        data-test="page"
                        class="px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted break-words"
                    >
                        {{ page.pageName }}
                    </div>
                    <template v-for="mod in page.modules" :key="mod.moduleId">
                        <div
                            data-test="module"
                            class="px-3 pt-1 text-[11px] text-subtle break-words"
                        >
                            {{ mod.moduleName }}
                        </div>
                        <button
                            v-for="c in mod.ports"
                            :key="c.portId"
                            data-test="candidate"
                            class="w-full flex items-center gap-2 pl-6 pr-3 py-1 text-left text-foreground transition-colors hover:bg-surface-alt"
                            @click="emit('pick', c)"
                        >
                            <span
                                class="w-2 h-2 rounded-full shrink-0"
                                :style="{ background: edgeColor(c.streamType) }"
                            />
                            <span class="flex-1 min-w-0 break-words">{{ c.portLabel }}</span>
                            <span
                                v-if="c.existingRefLabel"
                                data-test="existing"
                                class="shrink-0 px-1 rounded text-[10px] bg-white/10 text-muted"
                                >{{ c.existingRefLabel }}</span
                            >
                        </button>
                    </template>
                </template>
            </div>
        </div>
    </Teleport>
</template>
