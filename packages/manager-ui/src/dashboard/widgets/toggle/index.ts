import type { WidgetDef } from '../../registry';
import ToggleSwitch from './ToggleSwitch.vue';

export default {
    type: 'toggle',
    label: 'Toggle',
    icon: 'toggle-right',
    order: 40,
    size: { w: 3, h: 2 },
    binds: 'value',
    control: true,
    accepts: (e) => e.desc.type === 'boolean',
    options: [
        { key: 'onText', label: 'Text when on', kind: 'text', default: 'On' },
        { key: 'offText', label: 'Text when off', kind: 'text', default: 'Off' },
        { key: 'onColor', label: 'Colour when on', kind: 'color' },
        { key: 'offColor', label: 'Colour when off', kind: 'color' },
    ],
    component: ToggleSwitch,
} satisfies WidgetDef;
