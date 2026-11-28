<script setup lang="ts">
/** Toolbar "Modules (n)" button: a searchable list of every module; picking one jumps to it. */
import { ref, computed } from 'vue';
import MrButton from '@/components/common/MrButton.vue';
import MrTooltip from '@/components/common/MrTooltip.vue';
import type { ModuleState } from '@/stores/engines';

const props = defineProps<{ modules: Record<string, ModuleState> }>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ focusModule: [moduleId: string] }>();

const btnRef = ref<any>(null);
const pos = ref({ x: 0, y: 0 });
const search = ref('');

function toggle() {
    // Don't read `open` back after setting it: under v-model the prop only updates on the parent's next render.
    const next = !open.value;
    open.value = next;
    if (next) {
        search.value = '';
        if (btnRef.value) {
            const el = btnRef.value.$el ?? btnRef.value;
            const rect = el?.getBoundingClientRect?.();
            if (rect) pos.value = { x: rect.left, y: rect.bottom + 4 };
        }
    }
}

const filtered = computed(() => {
    const mods = Object.values(props.modules);
    if (!search.value) return mods;
    const q = search.value.toLowerCase();
    return mods.filter(
        (m) =>
            m.displayName?.toLowerCase().includes(q) ||
            m.pluginId?.toLowerCase().includes(q) ||
            m.instanceId?.toLowerCase().includes(q),
    );
});

function pick(moduleId: string) {
    emit('focusModule', moduleId);
    open.value = false;
}
</script>

<template>
    <MrTooltip text="Click to list all modules — click a module to jump to it">
        <MrButton ref="btnRef" size="sm" variant="secondary" @click="toggle">
            Modules ({{ Object.keys(modules).length }})
        </MrButton>
        <Teleport to="body">
            <div v-if="open" class="fixed inset-0 z-[998]" @click="open = false" />
            <div
                v-if="open"
                class="fixed w-56 rounded-lg shadow-xl z-[999] flex flex-col bg-card border border-border"
                :style="{
                    top: pos.y + 'px',
                    left: pos.x + 'px',
                    maxHeight: '280px',
                }"
            >
                <div class="px-2 py-1.5 shrink-0 border-b border-border-alt">
                    <input
                        v-model="search"
                        placeholder="Search modules..."
                        class="w-full px-2 py-1 text-xs rounded-md bg-input border border-border text-foreground"
                    />
                </div>
                <div class="overflow-y-auto py-1">
                    <div v-if="filtered.length === 0" class="px-3 py-2 text-xs text-muted">
                        No modules found
                    </div>
                    <button
                        v-for="mod in filtered"
                        :key="mod.instanceId"
                        @click="pick(mod.instanceId)"
                        class="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-foreground"
                    >
                        <div
                            class="w-2 h-2 rounded-full shrink-0"
                            :class="
                                mod.health === 'ok'
                                    ? 'bg-ok'
                                    : mod.health === 'error'
                                      ? 'bg-error'
                                      : 'bg-stopped'
                            "
                        />
                        {{ mod.displayName }}
                        <span class="text-[10px] ml-auto text-muted">{{ mod.pluginId }}</span>
                    </button>
                </div>
            </div>
        </Teleport>
    </MrTooltip>
</template>
