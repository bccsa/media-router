// shared-types is CJS: a namespace import is the safe interop (see stores/engines.ts).
import * as shared from '@media-router/shared-types';
import type { EditorLayout, PatchOp } from '@media-router/shared-types';
import type { ConnectionState, ModuleState } from '@/stores/engines';
import { PCM, pageResolver } from './crossRefs';
import { DEFAULT_MODULE_POSITION, MODULE_SIZE, tagClearance } from './xrefCanvas';

const { parseRefKey } = shared;

// Moving modules between routing editor pages (ADR-0030): the PipeWire guard,
// where the moved modules land and their dragged tags with them. The op list
// itself: pageOps.moveModulesOps.

/** Space between the target page's content and the moved group: a tag's room on each side. */
const GAP = tagClearance();
const SNAP = 16;

const snap = (v: number) => Math.round(v / SNAP) * SNAP;
const pos = (m: ModuleState) => m.position ?? DEFAULT_MODULE_POSITION;

/**
 * Why moving `moduleIds` to `targetPage` must not happen, or null: it would
 * leave a PipeWire (audio/pcm) wire with its two ends on different pages.
 * Only wires touching a moved module count.
 */
export function pcmCrossing(
    modules: Record<string, ModuleState>,
    connections: readonly ConnectionState[],
    editor: EditorLayout | undefined,
    moduleIds: readonly string[],
    targetPage: string,
): string | null {
    const moving = new Set(moduleIds);
    const pageFor = pageResolver(editor);
    const after = (id: string) => (moving.has(id) ? targetPage : pageFor(id));
    for (const c of connections) {
        if (!moving.has(c.sourceModuleId) && !moving.has(c.sinkModuleId)) continue;
        const src = modules[c.sourceModuleId];
        const sink = modules[c.sinkModuleId];
        if (!src || !sink) continue;
        const pcm =
            src.ports?.find((p) => p.id === c.sourcePortId)?.streamType === PCM ||
            sink.ports?.find((p) => p.id === c.sinkPortId)?.streamType === PCM;
        if (pcm && after(c.sourceModuleId) !== after(c.sinkModuleId)) {
            return `Would split the PipeWire wire ${src.displayName} → ${sink.displayName} across pages`;
        }
    }
    return null;
}

/**
 * New positions for `moving`, keeping their layout relative to each other,
 * placed to the right of `target` (the modules already on the target page),
 * top-aligned with them, the group's corner on the 16 px grid. An empty
 * target page keeps the positions as they are.
 */
export function placeOnPage(
    target: readonly ModuleState[],
    moving: readonly ModuleState[],
): Array<{ id: string; x: number; y: number }> {
    const movingIds = new Set(moving.map((m) => m.instanceId));
    const there = target.filter((m) => !movingIds.has(m.instanceId));
    let dx = 0;
    let dy = 0;
    if (moving.length > 0 && there.length > 0) {
        const right = Math.max(
            ...there.map((m) => pos(m).x + (m.size?.width ?? MODULE_SIZE.width)),
        );
        const top = Math.min(...there.map((m) => pos(m).y));
        dx = snap(right + GAP) - Math.min(...moving.map((m) => pos(m).x));
        dy = snap(top) - Math.min(...moving.map((m) => pos(m).y));
    }
    return moving.map((m) => ({ id: m.instanceId, x: pos(m).x + dx, y: pos(m).y + dy }));
}

/**
 * Ops that shift the stored (dragged) places of `moving`'s tags by as far as
 * their modules go to `positions` (placeOnPage), so the tags stay beside them:
 * a stored place is absolute. Tags without one follow their port anyway.
 */
export function shiftRefPosOps(
    editor: EditorLayout | undefined,
    moving: readonly ModuleState[],
    positions: ReadonlyArray<{ id: string; x: number; y: number }>,
): PatchOp[] {
    const offsets = new Map<string, { dx: number; dy: number }>();
    for (const to of positions) {
        const m = moving.find((mod) => mod.instanceId === to.id);
        const from = m && pos(m);
        if (from && (to.x !== from.x || to.y !== from.y))
            offsets.set(to.id, { dx: to.x - from.x, dy: to.y - from.y });
    }
    const ops: PatchOp[] = [];
    for (const [key, ref] of Object.entries(editor?.refs ?? {})) {
        const off = offsets.get(parseRefKey(key)?.moduleId ?? '');
        if (!ref.pos || !off) continue;
        const value = { x: ref.pos.x + off.dx, y: ref.pos.y + off.dy };
        ops.push({ op: 'replace', path: `/editor/refs/${key}/pos`, value });
    }
    return ops;
}
