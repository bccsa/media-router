import type { WidgetDef } from '../../registry';
import { isRangedNumber } from '../../valueTypes';
import LinearControl from '../shared/LinearControl.vue';
import { RANGE_OPTIONS } from '../shared/options';

export default {
    type: 'slider',
    label: 'Slider',
    icon: 'sliders-horizontal',
    order: 20,
    size: { w: 6, h: 2 },
    binds: 'value',
    control: true,
    accepts: (e) => isRangedNumber(e.desc),
    options: RANGE_OPTIONS,
    component: LinearControl,
} satisfies WidgetDef;
