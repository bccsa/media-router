<script setup lang="ts">
import { computed } from 'vue';
import * as wire from '@media-router/shared-types/browser';
import type { WidgetProps } from '../../registry';

// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
const { VU_BLOCKS, vuBlockDbfs } = wire;

const props = defineProps<WidgetProps>();

/** Meter zones, by the level a block stands for: green, amber from -20 dBFS, red from -8 dBFS. */
const AMBER_DBFS = -20;
const RED_DBFS = -8;
const blocks = computed(() => props.desc?.max ?? VU_BLOCKS);
const blockColour = (i: number) => {
    const db = vuBlockDbfs(i);
    return db < AMBER_DBFS ? 'var(--d-ok)' : db < RED_DBFS ? 'var(--d-vu-mid)' : 'var(--d-error)';
};

/** Chosen channels ("1,3" → first and third), else all of them. */
const levels = computed(() => {
    const all = Array.isArray(props.value) ? (props.value as number[]) : [];
    const picked = String(props.options.channels ?? '')
        .split(/[\s,]+/)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= all.length);
    return picked.length > 0 ? picked.map((n) => all[n - 1]) : all;
});
const vertical = computed(() => props.options.orientation !== 'horizontal');
</script>

<template>
    <div class="vu">
        <div class="dw-label">{{ label }}</div>
        <div class="vu-meters" :class="vertical ? 'vu-v' : 'vu-h'">
            <div v-for="(lvl, c) in levels" :key="c" class="vu-ch">
                <div
                    v-for="i in blocks"
                    :key="i"
                    class="vu-block"
                    :style="{ background: i - 1 < lvl ? blockColour(i - 1) : 'var(--d-vu-off)' }"
                />
            </div>
            <div v-if="levels.length === 0" class="vu-none">—</div>
        </div>
    </div>
</template>

<style scoped>
.vu {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
}
.vu-meters {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 3px;
    padding: 4px 6px 6px;
    justify-content: center;
}
.vu-v {
    flex-direction: row;
}
.vu-h {
    flex-direction: column;
}
.vu-ch {
    display: flex;
    gap: 2px;
    flex: 1;
    max-width: 22px;
}
.vu-v .vu-ch {
    flex-direction: column-reverse;
}
.vu-h .vu-ch {
    flex-direction: row;
    max-width: none;
    max-height: 22px;
}
.vu-block {
    flex: 1;
    border-radius: 2px;
}
.vu-none {
    align-self: center;
    color: var(--d-muted);
}
</style>
