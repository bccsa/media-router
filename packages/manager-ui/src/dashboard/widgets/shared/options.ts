import type { OptionDef } from '../../registry';

/** Options of the widgets that show a number along its range: fader, slider, bar gauge. */
export const RANGE_OPTIONS: OptionDef[] = [
    { key: 'step', label: 'Step', kind: 'number' },
    { key: 'showValue', label: 'Show value', kind: 'boolean', default: true },
    { key: 'showUnit', label: 'Show unit', kind: 'boolean', default: true },
];
