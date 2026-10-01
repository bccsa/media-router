import type { WidgetDef } from '../../registry';
import { isScalar } from '../../valueTypes';
import ValueReadout from './ValueReadout.vue';

export default {
    type: 'readout',
    label: 'Readout',
    icon: 'type',
    order: 70,
    size: { w: 4, h: 2 },
    binds: 'value',
    accepts: (e) => e.kind !== 'vu' && isScalar(e.desc),
    options: [
        { key: 'decimals', label: 'Decimal places', kind: 'number' },
        { key: 'showUnit', label: 'Show unit', kind: 'boolean', default: true },
        { key: 'wrap', label: 'Wrap long text', kind: 'boolean', default: false },
    ],
    component: ValueReadout,
} satisfies WidgetDef;
