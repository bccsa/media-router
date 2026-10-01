import type { WidgetDef } from '../../registry';
import { HEALTH } from '../../entries';
import StatusLight from './StatusLight.vue';

export default {
    type: 'light',
    label: 'Status light',
    icon: 'circle-dot',
    order: 80,
    size: { w: 3, h: 2 },
    binds: 'value',
    accepts: (e) => e.desc.type === 'boolean' || (Array.isArray(e.desc.enum) && e.desc.enum.every((v) => HEALTH.includes(String(v)))),
    options: [
        { key: 'showText', label: 'Show text', kind: 'boolean', default: true },
        { key: 'okColor', label: 'Colour: ok / on', kind: 'color' },
        { key: 'warningColor', label: 'Colour: warning', kind: 'color' },
        { key: 'errorColor', label: 'Colour: error', kind: 'color' },
        { key: 'stoppedColor', label: 'Colour: stopped / off', kind: 'color' },
    ],
    component: StatusLight,
} satisfies WidgetDef;
