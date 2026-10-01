import type { WidgetDef } from '../../registry';
import TextLabel from './TextLabel.vue';

export default {
    type: 'label',
    label: 'Label / frame',
    icon: 'heading',
    order: 110,
    size: { w: 4, h: 1 },
    binds: 'none',
    bare: true,
    options: [
        { key: 'text', label: 'Text', kind: 'text', default: 'Label' },
        { key: 'frame', label: 'Draw as a frame', kind: 'boolean', default: false },
        {
            key: 'orientation',
            label: 'Orientation',
            kind: 'select',
            default: 'horizontal',
            choices: [
                { value: 'horizontal', label: 'Horizontal' },
                { value: 'up', label: 'Vertical, reading up' },
                { value: 'down', label: 'Vertical, reading down' },
            ],
        },
        {
            key: 'align',
            label: 'Horizontal align',
            kind: 'select',
            default: 'left',
            choices: [
                { value: 'left', label: 'Left' },
                { value: 'center', label: 'Centre' },
                { value: 'right', label: 'Right' },
            ],
        },
        {
            // Auto keeps what labels did before there was a choice: a frame's title on top, plain text in the middle.
            key: 'valign',
            label: 'Vertical align',
            kind: 'select',
            default: 'auto',
            choices: [
                { value: 'auto', label: 'Auto (frame: top, else middle)' },
                { value: 'top', label: 'Top' },
                { value: 'middle', label: 'Middle' },
                { value: 'bottom', label: 'Bottom' },
            ],
        },
    ],
    boldLabel: true,
    component: TextLabel,
} satisfies WidgetDef;
