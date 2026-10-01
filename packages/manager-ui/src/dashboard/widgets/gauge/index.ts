import type { WidgetDef } from '../../registry';
import { isRangedNumber } from '../../valueTypes';
import { RANGE_OPTIONS } from '../shared/options';
import BarGauge from './BarGauge.vue';

export default {
    type: 'gauge',
    label: 'Bar gauge',
    icon: 'gauge',
    order: 100,
    size: { w: 4, h: 2 },
    binds: 'value',
    accepts: (e) => isRangedNumber(e.desc),
    options: RANGE_OPTIONS,
    component: BarGauge,
} satisfies WidgetDef;
