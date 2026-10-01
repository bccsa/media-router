<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { Dashboard } from '@media-router/shared-types';
import { gridMetrics } from './grid';
import { useZoomPan } from './useZoomPan';

const props = defineProps<{ dashboard: Pick<Dashboard, 'cols' | 'rows' | 'scroll' | 'zoom'> }>();

const outer = ref<HTMLElement | null>(null);
const box = ref({ width: 0, height: 0 });
let observer: ResizeObserver | null = null;

onMounted(() => {
    const measure = () => {
        if (outer.value) box.value = { width: outer.value.clientWidth, height: outer.value.clientHeight };
    };
    measure();
    if (typeof ResizeObserver !== 'undefined' && outer.value) {
        observer = new ResizeObserver(measure);
        observer.observe(outer.value);
    }
});
onUnmounted(() => observer?.disconnect());

const metrics = computed(() => gridMetrics(props.dashboard, box.value));
const zoom = useZoomPan(outer, () => props.dashboard.zoom);
</script>

<template>
    <div ref="outer" class="dg" :class="{ 'dg-scroll': dashboard.scroll }" data-pan-surface>
        <div
            class="dg-content"
            data-pan-surface
            :style="{ width: `${metrics.width}px`, height: `${metrics.height}px`, transform: zoom.transform.value }"
        >
            <slot :metrics="metrics" />
        </div>
    </div>
</template>

<style scoped>
.dg {
    position: absolute;
    inset: 0;
    overflow: hidden;
    touch-action: none;
}
.dg-scroll {
    overflow: auto;
    touch-action: pan-x pan-y;
}
.dg-content {
    position: relative;
    transform-origin: 0 0;
}
</style>
