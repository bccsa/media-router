import type { Component } from 'vue';
import type { DashboardWidget, ValueDescriptor } from '@media-router/shared-types';
import type { ValueEntry } from './entries';

export interface OptionDef {
    key: string;
    label: string;
    kind: 'text' | 'number' | 'boolean' | 'color' | 'select';
    default?: unknown;
    choices?: Array<{ value: string; label: string }>;
}

/**
 * One widget kind (ADR-0026): what it binds, which values it takes, its
 * options and default size. A folder under `widgets/` exporting this as
 * default is all it takes to add one.
 */
export interface WidgetDef {
    type: string;
    label: string;
    /** Lucide icon, kebab-case (getLucideIcon), for the palette. */
    icon: string;
    /** Palette position. */
    order: number;
    size: { w: number; h: number };
    /**
     * 'value': one bound value; 'values': several (`binds`); 'action': a button's action; 'none': static.
     * A new kind of binding also needs WidgetHost to resolve it (useValue / useSeries / useWidgetAction).
     */
    binds: 'value' | 'values' | 'action' | 'none';
    accepts?: (e: ValueEntry) => boolean;
    /** Sets its value: needs a writable one unless input is disabled. */
    control?: boolean;
    /** No card behind it (labels, frames). */
    bare?: boolean;
    /** Its label (a button's face, a label's text) is bold unless the author turns it off. */
    boldLabel?: boolean;
    options: OptionDef[];
    component: Component;
    /** Fixed props for the component (e.g. the fader: the shared linear control, upright). */
    componentProps?: Record<string, unknown>;
}

/** One of a multi-value widget's values, as its host resolved it. */
export interface SeriesValue {
    path: string;
    label: string;
    value: unknown;
    desc?: ValueDescriptor;
    /** Taking live values: its router online and the page connected. */
    live: boolean;
}

/** Props every widget component gets from its host. */
export interface WidgetProps {
    widget: DashboardWidget;
    value: unknown;
    desc?: ValueDescriptor;
    /** Takes input now: live, writable, not disabled, not being edited. */
    interactive: boolean;
    label: string;
    options: Record<string, any>;
    /** 'values' widgets: each bound value. */
    series?: SeriesValue[];
}

// `widgets/shared/` holds parts the kinds share, not a kind.
const found = import.meta.glob<{ default: WidgetDef }>(['./widgets/*/index.ts', '!./widgets/shared/**'], { eager: true });

export const WIDGETS: Readonly<Record<string, WidgetDef>> = Object.fromEntries(
    Object.values(found).map((m) => [m.default.type, m.default]),
);

export const WIDGET_LIST: readonly WidgetDef[] = Object.values(WIDGETS).sort((a, b) => a.order - b.order);

/** A kind that takes input (a control or a button): it offers "Input disabled" (UR-DSH-006). */
export const takesInput = (def: WidgetDef): boolean => !!def.control || def.binds === 'action';

/** Whether `def` can be tied to `e`: a value it takes and, for a control, can set. */
export function canBind(def: WidgetDef, e: ValueEntry, inputDisabled = false): boolean {
    if ((def.binds !== 'value' && def.binds !== 'values') || !def.accepts?.(e)) return false;
    return !def.control || inputDisabled || e.desc.access === 'write';
}

/**
 * Options every kind has: `label` (not on a static widget, which names itself),
 * `accent`, and the label's size and weight, which the host passes to every
 * widget as `--dw-label-size` / `--dw-label-weight`.
 */
export function commonOptions(def: WidgetDef): OptionDef[] {
    const own = def.binds === 'none';
    return [
        ...(own ? [] : [{ key: 'label', label: 'Label', kind: 'text' } as const]),
        { key: 'accent', label: 'Accent colour', kind: 'color' },
        { key: 'labelSize', label: own ? 'Text size (px, empty = auto)' : 'Label size (px, empty = auto)', kind: 'number' },
        { key: 'labelBold', label: own ? 'Bold' : 'Bold label', kind: 'boolean', default: !!def.boldLabel },
    ];
}

/** A widget's options with the kind's defaults filled in. */
export function optionsOf(def: WidgetDef | undefined, w: DashboardWidget): Record<string, any> {
    const out: Record<string, unknown> = {};
    for (const o of def ? [...commonOptions(def), ...def.options] : []) out[o.key] = o.default;
    return { ...out, ...(w.options ?? {}) };
}
