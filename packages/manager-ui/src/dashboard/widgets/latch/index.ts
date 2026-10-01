import type { WidgetDef } from '../../registry';
import LatchButton from './LatchButton.vue';

// Push on, push off: a button that flips a true/false value (e.g. mute).
export default {
    type: 'latch',
    label: 'Toggle button',
    icon: 'power',
    order: 45,
    size: { w: 2, h: 2 },
    binds: 'value',
    control: true,
    accepts: (e) => e.desc.type === 'boolean',
    options: [
        {
            key: 'litWhen',
            label: 'Lit when the value is',
            kind: 'select',
            default: 'true',
            choices: [
                { value: 'true', label: 'On (true)' },
                { value: 'false', label: 'Off (false), e.g. mute on "Audio Enabled"' },
            ],
        },
        { key: 'litText', label: 'Text when lit', kind: 'text' },
        { key: 'unlitText', label: 'Text when not lit', kind: 'text' },
        { key: 'litColor', label: 'Colour when lit', kind: 'color' },
    ],
    boldLabel: true,
    component: LatchButton,
} satisfies WidgetDef;
