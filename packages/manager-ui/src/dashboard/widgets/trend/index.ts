import type { WidgetDef } from '../../registry';
import { isNumber } from '../../valueTypes';
import { TREND_WINDOWS } from './trendHistory';
import TrendChart from './TrendChart.vue';

// Numbers over time: 1–8 lines, history in this browser tab only. Levels
// (per-channel) draw their loudest channel.
export default {
    type: 'trend',
    label: 'Trend',
    icon: 'chart-line',
    order: 95,
    size: { w: 8, h: 5 },
    binds: 'values',
    accepts: (e) => isNumber(e.desc) || e.kind === 'vu',
    options: [
        {
            key: 'window',
            label: 'Time shown',
            kind: 'select',
            default: '5',
            choices: TREND_WINDOWS.map((m) => ({ value: String(m), label: `${m} min` })),
        },
        { key: 'min', label: 'Fixed minimum (empty = auto)', kind: 'number' },
        { key: 'max', label: 'Fixed maximum (empty = auto)', kind: 'number' },
        { key: 'legend', label: 'Show legend', kind: 'boolean', default: true },
    ],
    component: TrendChart,
} satisfies WidgetDef;
