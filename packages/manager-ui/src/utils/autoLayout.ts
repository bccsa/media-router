// Minimal shapes — accepting Vue Flow's full Node/Edge types from a Vue ref
// hits a `TS2589 Type instantiation is excessively deep` due to their generics.
export interface LayoutNode {
    id: string;
    position: { x: number; y: number };
    data?: { size?: { width?: number; height?: number } } | unknown;
}
export interface LayoutEdge {
    source: string;
    target: string;
}

const DEFAULT_NODE_WIDTH = 200;
const DEFAULT_NODE_HEIGHT = 140;
const LAYER_GAP = 80;
const ROW_GAP = 40;
const SNAP = 16;

function snap(v: number): number {
    return Math.round(v / SNAP) * SNAP;
}

function nodeWidth(n: LayoutNode): number {
    const w = (n.data as { size?: { width?: number } } | undefined)?.size?.width;
    return typeof w === 'number' ? w : DEFAULT_NODE_WIDTH;
}

function nodeHeight(n: LayoutNode): number {
    const h = (n.data as { size?: { height?: number } } | undefined)?.size?.height;
    return typeof h === 'number' ? h : DEFAULT_NODE_HEIGHT;
}

/**
 * Layered (Sugiyama-style) auto-layout for a directed module graph.
 *
 * - Layer = longest path from any source. Sources end up on the left,
 *   sinks on the right, mirroring signal flow in the routing editor.
 * - Within a layer, nodes are ordered by the barycenter of their
 *   already-placed predecessors' Y, so connected nodes line up
 *   horizontally and edges don't cross arbitrarily.
 * - Snaps to the same 16-px grid as drag operations.
 *
 * Cycles are broken by repeatedly seeding the lowest-in-degree unvisited
 * node as a new source — equivalent to dropping one back-edge per cycle so
 * cycle members layer naturally instead of piling up with the real sources.
 */
export function computeAutoLayout(
    nodes: LayoutNode[],
    edges: LayoutEdge[],
): Map<string, { x: number; y: number }> {
    if (nodes.length === 0) return new Map();

    const successors = new Map<string, string[]>();
    const predecessors = new Map<string, string[]>();
    for (const n of nodes) {
        successors.set(n.id, []);
        predecessors.set(n.id, []);
    }
    for (const e of edges) {
        if (!successors.has(e.source) || !predecessors.has(e.target)) continue;
        successors.get(e.source)!.push(e.target);
        predecessors.get(e.target)!.push(e.source);
    }

    const layer = new Map<string, number>();
    const inDeg = new Map<string, number>();
    for (const n of nodes) {
        inDeg.set(n.id, predecessors.get(n.id)!.length);
        layer.set(n.id, 0);
    }
    const visited = new Set<string>();
    const queue: string[] = [];
    for (const [id, d] of inDeg) if (d === 0) queue.push(id);
    while (visited.size < nodes.length) {
        while (queue.length) {
            const id = queue.shift()!;
            if (visited.has(id)) continue;
            visited.add(id);
            const l = layer.get(id)!;
            for (const succ of successors.get(id) ?? []) {
                layer.set(succ, Math.max(layer.get(succ) ?? 0, l + 1));
                const d = (inDeg.get(succ) ?? 0) - 1;
                inDeg.set(succ, d);
                if (d === 0) queue.push(succ);
            }
        }
        if (visited.size === nodes.length) break;
        let pick: string | null = null;
        let pickIn = Infinity;
        for (const n of nodes) {
            if (visited.has(n.id)) continue;
            const d = inDeg.get(n.id)!;
            if (d < pickIn) {
                pickIn = d;
                pick = n.id;
            }
        }
        if (pick === null) break;
        // Seed past whichever is later: any visited predecessor's layer +1
        // (cycle hanging off real flow) or max existing layer +1 (cycle
        // disconnected from any source — push it past current content
        // rather than piling onto layer 0).
        const visitedPredLayer = Math.max(
            -1,
            ...(predecessors.get(pick) ?? [])
                .filter((p) => visited.has(p))
                .map((p) => layer.get(p)!),
        );
        const maxExisting = visited.size
            ? Math.max(...Array.from(visited, (id) => layer.get(id)!))
            : -1;
        const seed = Math.max(visitedPredLayer, maxExisting) + 1;
        layer.set(pick, Math.max(layer.get(pick) ?? 0, seed));
        inDeg.set(pick, 0);
        queue.push(pick);
    }

    const byLayer = new Map<number, LayoutNode[]>();
    for (const n of nodes) {
        const l = layer.get(n.id) ?? 0;
        if (!byLayer.has(l)) byLayer.set(l, []);
        byLayer.get(l)!.push(n);
    }
    const layerKeys = Array.from(byLayer.keys()).sort((a, b) => a - b);

    const layerX = new Map<number, number>();
    let cursorX = 0;
    for (const l of layerKeys) {
        layerX.set(l, cursorX);
        const maxW = Math.max(...byLayer.get(l)!.map(nodeWidth));
        cursorX += maxW + LAYER_GAP;
    }

    const newPos = new Map<string, { x: number; y: number }>();
    for (const l of layerKeys) {
        const group = byLayer.get(l)!;
        if (l === layerKeys[0]) {
            group.sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
        } else {
            const ranks = new Map<string, number>();
            for (const n of group) {
                const placed = (predecessors.get(n.id) ?? [])
                    .map((p) => newPos.get(p)?.y)
                    .filter((y): y is number => y !== undefined);
                ranks.set(
                    n.id,
                    placed.length
                        ? placed.reduce((a, b) => a + b, 0) / placed.length
                        : n.position.y,
                );
            }
            group.sort(
                (a, b) => ranks.get(a.id)! - ranks.get(b.id)! || a.position.x - b.position.x,
            );
        }

        const totalHeight =
            group.reduce((s, n) => s + nodeHeight(n), 0) + ROW_GAP * (group.length - 1);
        let y = -totalHeight / 2;
        const x = layerX.get(l)!;
        for (const n of group) {
            newPos.set(n.id, { x: snap(x), y: snap(y) });
            y += nodeHeight(n) + ROW_GAP;
        }
    }

    return newPos;
}
