import type { WidgetDef } from '../../registry';
import { isNumber } from '../../valueTypes';
import NumberBox from './NumberBox.vue';

export default {
    type: 'number',
    label: 'Number box',
    icon: 'hash',
    order: 30,
    size: { w: 4, h: 2 },
    binds: 'value',
    control: true,
    accepts: (e) => isNumber(e.desc),
    options: [
        { key: 'step', label: 'Step', kind: 'number' },
        { key: 'decimals', label: 'Decimal places', kind: 'number' },
        { key: 'showUnit', label: 'Show unit', kind: 'boolean', default: true },
    ],
    component: NumberBox,
} satisfies WidgetDef;
