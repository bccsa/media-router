/**
 * Runtime guard for graph data arriving on the status channel.
 *
 * A status value is normally a primitive; only a `graph` widget's field
 * carries a `StatusGraph`. Anything that doesn't have the required shape is
 * ignored so a plugin pointing `x-graph` at the wrong field renders the
 * widget's empty state instead of throwing inside the plotter.
 */

import type { StatusGraph, StatusValue } from '@media-router/shared-types';

const isAxis = (v: unknown): boolean =>
    !!v &&
    typeof v === 'object' &&
    typeof (v as { min?: unknown }).min === 'number' &&
    typeof (v as { max?: unknown }).max === 'number';

export function isStatusGraph(value: StatusValue | undefined): value is StatusGraph {
    if (!value || typeof value !== 'object') return false;
    const graph = value as Partial<StatusGraph>;
    if (!Array.isArray(graph.series)) return false;
    return isAxis(graph.axes?.x) && isAxis(graph.axes?.y);
}
