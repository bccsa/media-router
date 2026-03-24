<script setup lang="ts">
import { ref, reactive, nextTick, onMounted, onUnmounted } from 'vue';
import MrSlider from './MrSlider.vue';

export interface MenuItem {
    label: string;
    action: string;
    disabled?: boolean;
    danger?: boolean;
    divider?: boolean;
    icon?: string;
    tooltip?: string;
    /** Slider widget: renders an inline range slider instead of a button. */
    slider?: {
        min: number;
        max: number;
        step: number;
        value: number;
        unit?: string;
    };
    /** Toggle widget: renders an inline on/off switch. */
    toggle?: {
        value: boolean;
    };
}

const props = defineProps<{ items: MenuItem[]; x: number; y: number }>();
const emit = defineEmits<{ action: [action: string]; close: []; sliderChange: [action: string, value: number]; toggleChange: [action: string, value: boolean] }>();

const menu = ref<HTMLDivElement | null>(null);

// Local toggle overrides — tracks clicks so repeated toggles work without waiting for server round-trip
const toggleOverrides = reactive<Record<string, boolean>>({});
function getToggleValue(item: MenuItem): boolean {
    if (item.action in toggleOverrides) return toggleOverrides[item.action];
    return item.toggle?.value ?? false;
}
function onToggleClick(item: MenuItem) {
    const newVal = !getToggleValue(item);
    toggleOverrides[item.action] = newVal;
    emit('toggleChange', item.action, newVal);
}
const adjustedX = ref(0);
const adjustedY = ref(0);

// Track local slider values to prevent snap-back during server round-trip
const localSliderValues = reactive<Record<string, number>>({});

function getSliderValue(item: MenuItem): number {
    if (item.action in localSliderValues) return localSliderValues[item.action];
    return item.slider?.value ?? 0;
}

function onSliderInput(item: MenuItem, value: number) {
    localSliderValues[item.action] = value;
    emit('sliderChange', item.action, value);
}

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
                <!-- Toggle widget -->
                <button v-else-if="item.toggle" @click.stop="onToggleClick(item)"
                        class="w-full text-left px-3 py-1.5 flex items-center justify-between transition-colors hover:brightness-125"
                        :style="{ color: 'var(--text-primary)' }">
                    <span class="text-[11px]">{{ item.label }}</span>
                    <div class="relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors"
                         :style="{ backgroundColor: getToggleValue(item) ? 'var(--accent)' : 'var(--border-primary)' }">
                        <span class="inline-block h-3 w-3 rounded-full bg-white shadow transition-transform"
                              :class="getToggleValue(item) ? 'translate-x-3.5' : 'translate-x-0.5'"
                              style="margin-top: 2px" />
                    </div>
                </button>
                <!-- Slider widget -->
                <div v-else-if="item.slider" class="px-3 py-1.5" @click.stop @mousedown.stop @touchstart.stop>
                    <div class="flex items-center justify-between text-[11px] mb-1" :style="{ color: 'var(--text-muted)' }">
                        <span>{{ item.label }}</span>
                        <span :style="{ color: 'var(--text-primary)' }">{{ getSliderValue(item) }}{{ item.slider.unit ?? '' }}</span>
                    </div>
                    <MrSlider
                        :model-value="getSliderValue(item)"
                        :min="item.slider.min" :max="item.slider.max" :step="item.slider.step"
                        @update:model-value="onSliderInput(item, $event)" />
                </div>
                <!-- Regular button -->
                <button v-else @click="onAction(item)" :disabled="item.disabled"
                        class="group/tip relative w-full text-left px-3 py-1.5 disabled:opacity-40 hover:brightness-125 transition-colors flex items-center gap-2"
                        :style="{ color: item.danger ? '#f87171' : 'var(--text-primary)' }">
                    <svg v-if="item.icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" v-html="item.icon" />
                    <span>{{ item.label }}</span>
                    <div v-if="item.tooltip"
                         class="hidden group-hover/tip:block absolute left-full top-0 ml-2 w-44 p-2 rounded-md shadow-lg text-[10px] leading-relaxed pointer-events-none"
                         style="z-index: 9999"
                         :style="{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-primary)', color: 'var(--text-primary)' }">
                        {{ item.tooltip }}
                    </div>
                </button>
            </template>
        </div>
    </Teleport>
</template>
