<script setup lang="ts">
/**
 * The generic `graph` settings widget — an SVG plotter for a `StatusGraph`
 * published by a plugin (see `plugins/README.md` → "Graph status fields").
 *
 * It knows axes, grids, series, marker lines and one live point. It knows
 * nothing about what is plotted: no dB, no frequencies, no filters, no
 * dynamics. Every domain decision was made by the publisher; roles map to
 * theme tokens so a plugin never names a colour.
 */
import { computed } from 'vue';
import type { GraphRole, GraphStroke, StatusGraph } from '@media-router/shared-types';
import {
    axisTicks,
    formatTick,
    logTicks,
    polylinePoints,
    toX,
    toY,
    type Domain,
    type PlotBox,
} from '@/utils/graphScale';

const props = defineProps<{
    /** Wire data — undefined until the module publishes its first graph. */
    data?: StatusGraph;
    /** Plot height in viewBox units. Width is fixed at 260 and scales to fit. */
    height?: number;
}>();

const WIDTH = 260;
/** Room under the plot for tick labels + the x-axis caption. */
const FOOTER = 20;

const box = computed<PlotBox>(() => ({
    left: 26,
    right: WIDTH - 8,
    top: 8,
    bottom: (props.height ?? 150) - FOOTER,
}));
const viewBox = computed(() => `0 0 ${WIDTH} ${props.height ?? 150}`);

const xAxis = computed(() => props.data?.axes.x);
const yAxis = computed(() => props.data?.axes.y);
const xDomain = computed<Domain>(() => ({
    min: xAxis.value?.min ?? 0,
    max: xAxis.value?.max ?? 1,
}));
const yDomain = computed<Domain>(() => ({
    min: yAxis.value?.min ?? 0,
    max: yAxis.value?.max ?? 1,
}));
const logX = computed(() => xAxis.value?.scale === 'log');

const ROLE_COLOR: Record<GraphRole, string> = {
    primary: 'var(--accent)',
    secondary: 'var(--text-secondary)',
    warning: 'var(--health-warning)',
    error: 'var(--health-error)',
    muted: 'var(--text-muted)',
};
const STROKE_DASH: Record<GraphStroke, string> = {
    solid: '',
    dashed: '4 2',
    dotted: '1 2',
};

const color = (role?: GraphRole): string => ROLE_COLOR[role ?? 'primary'];
const dash = (stroke?: GraphStroke): string => STROKE_DASH[stroke ?? 'solid'];

/** Gridline values: 1-2-5 per decade on a log axis, `gridStep` on a linear one. */
function gridValues(axis: {
    min: number;
    max: number;
    scale?: string;
    gridStep?: number;
}): number[] {
    const domain = { min: axis.min, max: axis.max };
    if (axis.scale === 'log') return logTicks(domain);
    return axisTicks(domain, axis.gridStep || (axis.max - axis.min) / 6);
}

const xGrid = computed(() => (xAxis.value ? gridValues(xAxis.value) : []));
const yGrid = computed(() => (yAxis.value ? gridValues(yAxis.value) : []));
const xLabels = computed(() => xAxis.value?.labels ?? xGrid.value);
const yLabels = computed(() => yAxis.value?.labels ?? yGrid.value);

const caption = (axis?: { label?: string; unit?: string }): string =>
    axis?.label ? `${axis.label}${axis.unit ? ` (${axis.unit})` : ''}` : (axis?.unit ?? '');

const x = (v: number) => toX(v, xDomain.value, box.value, logX.value);
const y = (v: number) => toY(v, yDomain.value, box.value);

const seriesPoints = (points: Array<[number, number]>): string =>
    polylinePoints(
        points.map(([px, py]) => ({ x: px, y: py })),
        xDomain.value,
        yDomain.value,
        box.value,
        logX.value,
    );
</script>

<template>
    <div class="rounded-md border border-border-alt bg-surface-alt p-2">
        <div v-if="!data" class="py-4 text-center text-[10px] text-muted">
            No graph data yet — the module publishes it once it is configured.
        </div>
        <template v-else>
            <svg :viewBox="viewBox" class="w-full h-auto" role="img" :aria-label="caption(xAxis)">
                <!-- Grid -->
                <g stroke="var(--border-secondary)" stroke-width="0.5" opacity="0.6">
                    <line
                        v-for="v in xGrid"
                        :key="`xg${v}`"
                        :x1="x(v)"
                        :y1="box.top"
                        :x2="x(v)"
                        :y2="box.bottom"
                    />
                    <line
                        v-for="v in yGrid"
                        :key="`yg${v}`"
                        :x1="box.left"
                        :y1="y(v)"
                        :x2="box.right"
                        :y2="y(v)"
                    />
                </g>

                <!-- Reference markers -->
                <g v-for="(m, i) in data.markers ?? []" :key="`m${i}`">
                    <line
                        :x1="m.axis === 'x' ? x(m.value) : box.left"
                        :y1="m.axis === 'x' ? box.top : y(m.value)"
                        :x2="m.axis === 'x' ? x(m.value) : box.right"
                        :y2="m.axis === 'x' ? box.bottom : y(m.value)"
                        :stroke="color(m.role ?? 'warning')"
                        stroke-width="1"
                        :stroke-dasharray="dash(m.stroke ?? 'dashed')"
                    />
                    <text
                        v-if="m.label"
                        :x="
                            m.axis === 'x' ? Math.min(x(m.value) + 3, box.right - 30) : box.left + 3
                        "
                        :y="m.axis === 'x' ? box.top + 8 : Math.max(y(m.value) - 2, box.top + 7)"
                        font-size="7"
                        :fill="color(m.role ?? 'warning')"
                    >
                        {{ m.label }}
                    </text>
                </g>

                <!-- Series -->
                <polyline
                    v-for="s in data.series"
                    :key="s.id"
                    :points="seriesPoints(s.points)"
                    fill="none"
                    :stroke="color(s.role)"
                    :stroke-dasharray="dash(s.stroke)"
                    stroke-width="1.75"
                    stroke-linejoin="round"
                />

                <!-- Live operating point (+ optional band at the same x) -->
                <template v-if="data.live">
                    <rect
                        v-if="data.live.span"
                        :x="x(data.live.x) - 2.5"
                        :y="Math.min(y(data.live.span[0]), y(data.live.span[1]))"
                        width="5"
                        :height="Math.abs(y(data.live.span[1]) - y(data.live.span[0]))"
                        :fill="color(data.live.role ?? 'warning')"
                        opacity="0.35"
                    />
                    <circle
                        :cx="x(data.live.x)"
                        :cy="y(data.live.y)"
                        r="3"
                        :fill="color(data.live.role ?? 'primary')"
                        stroke="var(--bg-card)"
                        stroke-width="1"
                    />
                </template>

                <!-- Frame + tick labels -->
                <rect
                    :x="box.left"
                    :y="box.top"
                    :width="box.right - box.left"
                    :height="box.bottom - box.top"
                    fill="none"
                    stroke="var(--border-primary)"
                    stroke-width="0.75"
                />
                <g font-size="7" fill="var(--text-muted)">
                    <text
                        v-for="v in xLabels"
                        :key="`xl${v}`"
                        :x="x(v)"
                        :y="box.bottom + 8"
                        text-anchor="middle"
                    >
                        {{ formatTick(v) }}
                    </text>
                    <text
                        v-for="v in yLabels"
                        :key="`yl${v}`"
                        :x="box.left - 3"
                        :y="y(v) + 2.5"
                        text-anchor="end"
                    >
                        {{ formatTick(v) }}
                    </text>
                    <text
                        v-if="caption(xAxis)"
                        :x="(box.left + box.right) / 2"
                        :y="box.bottom + 17"
                        text-anchor="middle"
                    >
                        {{ caption(xAxis) }}
                    </text>
                </g>
            </svg>
            <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] text-muted">
                <span v-if="caption(yAxis)">{{ caption(yAxis) }}</span>
                <span v-for="(note, i) in data.notes ?? []" :key="`n${i}`">· {{ note }}</span>
            </div>
        </template>
    </div>
</template>
