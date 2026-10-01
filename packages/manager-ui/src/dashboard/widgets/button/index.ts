import type { WidgetDef } from '../../registry';
import ActionButton from './ActionButton.vue';

export default {
    type: 'button',
    label: 'Button',
    icon: 'mouse-pointer-click',
    order: 60,
    size: { w: 3, h: 2 },
    binds: 'action',
    options: [
        { key: 'text', label: 'Text', kind: 'text' },
        { key: 'confirm', label: 'Ask to confirm', kind: 'boolean', default: false },
        { key: 'color', label: 'Colour', kind: 'color' },
    ],
    boldLabel: true,
    component: ActionButton,
} satisfies WidgetDef;
