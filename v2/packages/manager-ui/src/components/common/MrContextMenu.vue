<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted } from 'vue';

export interface MenuItem {
    label: string;
    action: string;
    disabled?: boolean;
    danger?: boolean;
    divider?: boolean;
    icon?: string;
}

const props = defineProps<{ items: MenuItem[]; x: number; y: number }>();
const emit = defineEmits<{ action: [action: string]; close: [] }>();

const menu = ref<HTMLDivElement | null>(null);
const adjustedX = ref(0);
const adjustedY = ref(0);

function onAction(item: MenuItem) {
    if (item.disabled) return;
    emit('action', item.action);
    emit('close');
}

function onClickOutside(e: MouseEvent) {
    if (menu.value && !menu.value.contains(e.target as Node)) emit('close');
}

let rafId: number | null = null;

onMounted(() => {
    // Clamp position to viewport bounds
    adjustedX.value = props.x;
    adjustedY.value = props.y;
    nextTick(() => {
        if (menu.value) {
            const rect = menu.value.getBoundingClientRect();
            adjustedX.value = Math.min(props.x, window.innerWidth - rect.width - 8);
            adjustedY.value = Math.min(props.y, window.innerHeight - rect.height - 8);
        }
    });

    // Delay listener so the opening click doesn't immediately close the menu
    rafId = requestAnimationFrame(() => {
        rafId = null;
        document.addEventListener('mousedown', onClickOutside);
        document.addEventListener('contextmenu', onClickOutside);
    });
});
onUnmounted(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    document.removeEventListener('mousedown', onClickOutside);
    document.removeEventListener('contextmenu', onClickOutside);
});
</script>

<template>
    <Teleport to="body">
        <div ref="menu" class="fixed z-50 min-w-[160px] rounded-lg shadow-xl py-1 text-sm"
             :style="{ left: adjustedX + 'px', top: adjustedY + 'px', backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-primary)' }">
            <template v-for="(item, i) in items" :key="i">
                <div v-if="item.divider" class="my-1" :style="{ borderTop: '1px solid var(--border-secondary)' }" />
                <button v-else @click="onAction(item)" :disabled="item.disabled"
                        class="w-full text-left px-3 py-1.5 disabled:opacity-40 hover:brightness-125 transition-colors flex items-center gap-2"
                        :style="{ color: item.danger ? '#f87171' : 'var(--text-primary)' }">
                    <svg v-if="item.icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="item.icon" />
                    <span>{{ item.label }}</span>
                </button>
            </template>
        </div>
    </Teleport>
</template>
