/**
 * Display-only settings widgets — the ones that RENDER something the plugin
 * publishes instead of holding a value of their own (today: `graph`).
 *
 * A plugin declares such a prop in its `configSchema` purely for placement, so
 * it must never be seeded with a default, patched live, or written back into
 * the module's saved settings.
 */

/**
 * `x-graph` — where a `graph` widget reads its plot data from: a module status
 * field the plugin publishes with `setStatusGraph`, plus a layout hint.
 */
export interface GraphSource {
    /** Status section id, e.g. `graphs`. */
    section: string;
    /** Field within that section. */
    key: string;
    /** Plot height in SVG units. Default 150. */
    height?: number;
}

const DISPLAY_WIDGETS = new Set(['graph']);

export function isDisplayWidget(widget?: string): boolean {
    return !!widget && DISPLAY_WIDGETS.has(widget);
}

/** Settings buffer with every virtual display field removed. */
export function stripDisplayFields(
    fields: Array<{ key: string; widget?: string }>,
    settings: Record<string, unknown>,
): Record<string, unknown> {
    const virtual = new Set(fields.filter((f) => isDisplayWidget(f.widget)).map((f) => f.key));
    if (virtual.size === 0) return settings;
    return Object.fromEntries(Object.entries(settings).filter(([key]) => !virtual.has(key)));
}
