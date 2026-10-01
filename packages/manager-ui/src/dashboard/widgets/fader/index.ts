import type { WidgetDef } from '../../registry';
import { isRangedNumber } from '../../valueTypes';
import LinearControl from '../shared/LinearControl.vue';
import { RANGE_OPTIONS } from '../shared/options';

export default {
    type: 'fader',
    label: 'Fader',
    icon: 'sliders-vertical',
    order: 10,
    size: { w: 2, h: 6 },
    binds: 'value',
    control: true,
    accepts: (e) => isRangedNumber(e.desc),
    options: RANGE_OPTIONS,
    component: LinearControl,
    // The shared linear control, upright.
    componentProps: { vertical: true },
} satisfies WidgetDef;
