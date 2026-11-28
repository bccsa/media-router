// shared-types is CJS: a namespace import is the safe interop (see stores/engines.ts).
import * as shared from '@media-router/shared-types';

const { STREAM_TYPE_COLORS } = shared;

// Colours and style of the routing canvas's wires, tag stubs and tags.

/** Idle wires (nothing flowing), read-only tags and unknown stream types share this grey. */
export const IDLE_EDGE_COLOR = '#6b7280';

/** Colour by stream type — matches the CSS variables in main.css. */
export function edgeColor(streamType?: string | null): string {
    return STREAM_TYPE_COLORS[streamType ?? ''] ?? IDLE_EDGE_COLOR;
}

/** Wire style; a dimmed (focus mode) wire fades. */
export const edgeStyle = (stroke: string, dimmed: boolean) => ({
    stroke,
    opacity: dimmed ? 0.1 : 1,
    transition: 'opacity 0.2s ease, stroke 0.2s ease',
});
