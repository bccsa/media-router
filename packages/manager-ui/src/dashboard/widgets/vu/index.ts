import type { WidgetDef } from '../../registry';
import VuMeter from './VuMeter.vue';

export default {
    type: 'vu',
    label: 'VU meter',
    icon: 'audio-lines',
    order: 90,
    size: { w: 2, h: 6 },
    binds: 'value',
    accepts: (e) => e.kind === 'vu',
    options: [
        {
            key: 'orientation',
            label: 'Orientation',
            kind: 'select',
            default: 'vertical',
            choices: [
                { value: 'vertical', label: 'Vertical' },
                { value: 'horizontal', label: 'Horizontal' },
            ],
        },
        { key: 'channels', label: 'Channels (e.g. 1,2; empty = all)', kind: 'text' },
    ],
    component: VuMeter,
} satisfies WidgetDef;
