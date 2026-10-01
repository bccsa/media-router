<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { WidgetProps } from '../../registry';
import { asNumber, formatValue, numberOption } from '../../valueTypes';
import { TrendHistory, bandPath, linePath, trendValue, yRange } from './trendHistory';

// Values over time, recorded in this tab while the dashboard is open.
const props = defineProps<WidgetProps>();

/** Series colours: `--d-series-1…8` in dashboard.css (DASHBOARD_MAX_BINDS lines). */
const COLORS = Array.from({ length: 8 }, (_, i) => `var(--d-series-${i + 1})`);
const series = computed(() => props.series ?? []);
const windowMs = computed(() => (Number(props.options.window) || 5) * 60_000);

const history = new TrendHistory(windowMs.value);
const now = ref(Date.now());

/** Record every value now; redraw (`now`) at most twice a second between timer ticks. */
function sample(redraw = true) {
    const t = Date.now();
    history.windowMs = windowMs.value;
    history.retain(series.value.map((s) => s.path));
    for (const s of series.value) history.sample(s.path, t, s.live ? (trendValue(s.value, asNumber) ?? null) : null);
    if (redraw || t - now.value >= 500) now.value = t;
}
// Every update is recorded as it arrives: a browser may run the timer rarely
// (the router's kiosk does), and a fast value (a level) must not be sampled blind.
watch(() => series.value.map((s) => [s.live, s.value]), () => sample(false), { deep: true });

let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
    sample();
    timer = setInterval(() => sample(), 1000);
});
onUnmounted(() => timer && clearInterval(timer));
watch(() => series.value.map((s) => s.path).join('|'), () => sample());

const fixedMin = computed(() => numberOption(props.options.min));
const fixedMax = computed(() => numberOption(props.options.max));
const range = computed(() => {
    void now.value;
    return yRange(history.values(series.value.map((s) => s.path)), fixedMin.value, fixedMax.value);
});
const lines = computed(() => {
    void now.value;
    const [lo, hi] = range.value;
    return series.value.map((s, i) => ({
        path: s.path,
        color: COLORS[i % COLORS.length],
        d: linePath(history.points(s.path), now.value - windowMs.value, windowMs.value, lo, hi),
        band: bandPath(history.points(s.path), now.value - windowMs.value, windowMs.value, lo, hi),
    }));
});

const unit = (i: number) => series.value[i]?.desc?.unit;
const sharedUnit = computed(() => {
    const units = new Set(series.value.map((s) => s.desc?.unit ?? ''));
    return units.size === 1 ? [...units][0] || undefined : undefined;
});
const yLabels = computed(() => {
    const [lo, hi] = range.value;
    return [hi, (hi + lo) / 2, lo].map((v) => formatValue(Number(v.toPrecision(3)), undefined, sharedUnit.value));
});
const current = (i: number) => {
    const s = series.value[i];
    return s.live ? formatValue(trendValue(s.value, asNumber), undefined, unit(i)) : '—';
};
const showLegend = computed(() => props.options.legend !== false);
</script>

<template>
    <div class="tr">
        <div class="dw-label">{{ label }}</div>
        <div v-if="showLegend" class="tr-legend">
            <span v-for="(s, i) in series" :key="s.path" class="tr-item" :class="{ 'tr-off': !s.live }">
                <span class="tr-swatch" :style="{ background: COLORS[i % COLORS.length] }" />
                <span class="tr-name">{{ s.label }}</span>
                <span class="tr-now dw-value">{{ current(i) }}</span>
            </span>
        </div>
        <div class="tr-plot">
            <div class="tr-y">
                <span v-for="(t, i) in yLabels" :key="i">{{ t }}</span>
            </div>
            <div class="tr-area">
                <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" class="tr-svg">
                    <line v-for="g in [0, 250, 500, 750, 1000]" :key="g" x1="0" x2="1000" :y1="g" :y2="g" class="tr-grid" />
                    <path v-for="l in lines" :key="`${l.path}-band`" :d="l.band" :style="{ fill: l.color }" class="tr-band" />
                    <path v-for="l in lines" :key="l.path" :d="l.d" :style="{ stroke: l.color }" class="tr-line" />
                </svg>
                <div class="tr-x">
                    <span>−{{ Number(options.window) || 5 }} min</span>
                    <span>now</span>
                </div>
            </div>
        </div>
        <div v-if="series.length === 0" class="tr-empty">Add values in the editor</div>
    </div>
</template>

<style scoped>
.tr {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    position: relative;
}
.tr-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 12px;
    padding: 0 8px 4px;
    font-size: 11px;
}
.tr-item {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
}
.tr-off {
    opacity: 0.5;
}
.tr-swatch {
    width: 10px;
    height: 3px;
    border-radius: 2px;
    flex: none;
}
.tr-name {
    color: var(--d-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 22ch;
}
.tr-now {
    color: var(--d-text);
    font-weight: 600;
}
.tr-plot {
    flex: 1;
    min-height: 0;
    display: flex;
    gap: 4px;
    padding: 2px 8px 6px 4px;
}
.tr-y {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding-bottom: 14px;
    font-size: 10px;
    color: var(--d-muted);
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
}
.tr-area {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
}
.tr-svg {
    flex: 1;
    min-height: 0;
    width: 100%;
    background: var(--d-track);
    border-radius: 4px;
}
.tr-grid {
    stroke: var(--d-border);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
}
.tr-line {
    fill: none;
    stroke-width: 2;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
}
.tr-band {
    opacity: 0.22;
    stroke: none;
}
.tr-x {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: var(--d-muted);
    height: 14px;
}
.tr-empty {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    color: var(--d-muted);
    pointer-events: none;
}
</style>
