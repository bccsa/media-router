import type { Edge, XYPosition } from '@vue-flow/core';
import type { RefKind } from '@media-router/shared-types';
import type { ConnectionState, ModuleState } from '@/stores/engines';
import { XREF_HANDLE_ID, type RefNode, type StubEdge } from './crossRefTypes';
import { edgeColor, edgeStyle, IDLE_EDGE_COLOR } from './edgeStyle';

// Where cross-reference tags sit on the routing canvas and how their stub
// edges attach (ADR-0030). Pure: the graph composables feed in Vue Flow's
// measured node boxes.

/** Gap between a port and the tag beside it, px. */
export const TAG_GAP = 48;
/**
 * A tag's size until Vue Flow has measured it, px. The height is fixed
 * (XrefNode draws one row this tall) and stays under ModuleNode's 24 px port
 * step, so tags beside neighbouring ports never overlap.
 */
export const TAG_SIZE = { width: 80, height: 18 };
/**
 * Room between two modules for an undragged tag on each side (an output tag of
 * the left one, an input tag of the right one), so neither covers the other's
 * port: where page moves land modules (crossRefMoves) and Format's column gap
 * on a page with tags. `tagWidth`: the widest tag's measured width. 288 px by
 * default, on the 16 px grid.
 */
export function tagClearance(tagWidth: number = TAG_SIZE.width): number {
    return 2 * (TAG_GAP + tagWidth) + 32;
}

/** A module's size until measured, px (ModuleNode's minimum width). */
export const MODULE_SIZE = { width: 200, height: 80 };
/** Where the canvas draws a module that has no stored position. Read-only: copy it for a node. */
export const DEFAULT_MODULE_POSITION: Readonly<XYPosition> = { x: 100, y: 100 };

interface HandleBox {
    id?: string | null;
    x: number;
    y: number;
    width: number;
    height: number;
}

/** What placement reads of a module's Vue Flow node: position, size, handle bounds (relative). */
export interface ModuleBox {
    position: XYPosition;
    dimensions?: { width: number; height: number };
    handleBounds?: { source?: HandleBox[] | null; target?: HandleBox[] | null };
}

/**
 * Where an undragged tag sits: `TAG_GAP` right of its output handle, or left
 * of its input handle, centred on it. Before the module is measured, its
 * right (left) edge at mid-height stands in for the handle.
 */
export function besidePort(
    ref: Pick<RefNode, 'kind' | 'portId'>,
    box: ModuleBox,
    tag: { width?: number; height?: number } = {},
): XYPosition {
    const out = ref.kind === 'out';
    const width = box.dimensions?.width || MODULE_SIZE.width;
    const height = box.dimensions?.height || MODULE_SIZE.height;
    const tagWidth = tag.width || TAG_SIZE.width;
    const tagHeight = tag.height || TAG_SIZE.height;
    const handles = (out ? box.handleBounds?.source : box.handleBounds?.target) ?? [];
    const h = handles.find((b) => b.id === ref.portId);
    const cx = h ? h.x + h.width / 2 : out ? width : 0;
    const cy = h ? h.y + h.height / 2 : height / 2;
    return {
        x: Math.round(
            out ? box.position.x + cx + TAG_GAP : box.position.x + cx - TAG_GAP - tagWidth,
        ),
        y: Math.round(box.position.y + cy - tagHeight / 2),
    };
}

/** Vue Flow's node lookup (`findNode`), as placement reads it. */
export type FindBox = (
    id: string,
) => (ModuleBox & { dimensions?: { width: number; height: number } }) | undefined;

/**
 * Where a tag is drawn: its stored (dragged) place, else beside its port.
 * `modulePos` is the module's stored position; omit it to read the live one
 * from Vue Flow (a module being dragged). Measured sizes come from `find`.
 */
export function tagPlace(tag: RefNode, find: FindBox, modulePos?: XYPosition): XYPosition {
    if (tag.pos) return tag.pos;
    const node = find(tag.moduleId);
    const position = modulePos ?? node?.position ?? DEFAULT_MODULE_POSITION;
    const box = { position, dimensions: node?.dimensions, handleBounds: node?.handleBounds };
    return besidePort(tag, box, find(tag.key)?.dimensions);
}

/** A new tag for a wire dropped at `at` (flow coordinates): its handle lands under the pointer. */
export function tagAtDrop(kind: RefKind, at: XYPosition): XYPosition {
    return {
        x: Math.round(kind === 'out' ? at.x : at.x - TAG_SIZE.width),
        y: Math.round(at.y - TAG_SIZE.height / 2),
    };
}

/**
 * Ends of a tag's stub edge: module output → output tag (its left handle),
 * input tag (its point) → module input. The tag node's id is its ref key.
 */
export function stubEnds(
    stub: Pick<StubEdge, 'kind' | 'refKey' | 'moduleId' | 'portId'>,
): Pick<Edge, 'source' | 'sourceHandle' | 'target' | 'targetHandle'> {
    return stub.kind === 'out'
        ? {
              source: stub.moduleId,
              sourceHandle: stub.portId,
              target: stub.refKey,
              targetHandle: XREF_HANDLE_ID,
          }
        : {
              source: stub.refKey,
              sourceHandle: XREF_HANDLE_ID,
              target: stub.moduleId,
              targetHandle: stub.portId,
          };
}

/**
 * A tag's stub edge. It flows (animated, feed colour) while any connection
 * behind the tag flows, else it is idle grey like any other wire.
 */
export function stubEdge(
    stub: StubEdge,
    ctx: {
        modules: Record<string, ModuleState>;
        byId: Map<string, ConnectionState>;
        engineRunning: boolean;
        dimmed: boolean;
    },
): Edge {
    const { modules } = ctx;
    const live = ctx.engineRunning
        ? stub.connectionIds
              .map((id) => ctx.byId.get(id))
              .find(
                  (c) =>
                      c && modules[c.sourceModuleId]?.running && modules[c.sinkModuleId]?.running,
              )
        : undefined;
    const feed = live
        ? modules[live.sourceModuleId]?.ports?.find((p) => p.id === live.sourcePortId)?.streamType
        : undefined;
    return {
        id: stub.id,
        ...stubEnds(stub),
        animated: !!live,
        interactionWidth: 20,
        style: edgeStyle(live ? edgeColor(feed) : IDLE_EDGE_COLOR, ctx.dimmed),
    };
}

/**
 * True when `el` (the element under a released wire) is empty canvas: inside
 * Vue Flow's pane but not on a node, handle, edge, label or panel.
 */
export function isEmptyPane(el: Element | null): boolean {
    if (!el?.closest('.vue-flow__pane')) return false;
    return !el.closest(
        '.vue-flow__node, .vue-flow__handle, .vue-flow__edge, .vue-flow__edge-labels, .vue-flow__panel, .vue-flow__nodesselection',
    );
}
