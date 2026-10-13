// The latency PipeWire reports for a module's node (design §9.5, WI-P0-10). PipeWire-graph
// modules carry no PTS, so instead of lateness they show one graph cycle (quantum / rate)
// plus whatever the node's own `Latency` param adds.
import { pwDump } from './streamPortLinks.js';

export interface NodeLatency {
    /** Samples per graph cycle for this node. */
    quantum: number;
    rate: number;
    latencyMs: number;
}

interface DumpObject {
    id: number;
    type: string;
    props?: Record<string, unknown>;
    metadata?: Array<{ key?: string; value?: unknown }>;
    info?: { props?: Record<string, unknown>; params?: Record<string, unknown> };
}

const isObj = (o: unknown): o is DumpObject =>
    typeof o === 'object' && o !== null && typeof (o as DumpObject).id === 'number';

/** "1024/48000" or a reduced "8/375" → [num, den]. */
function fraction(v: unknown): [number, number] | null {
    const m = /^(\d+)\/(\d+)$/.exec(String(v ?? ''));
    return m && Number(m[2]) > 0 ? [Number(m[1]), Number(m[2])] : null;
}

/** Graph quantum and rate from the `settings` metadata; a forced value wins. */
function graphClock(objects: DumpObject[]): { quantum: number; rate: number; forced: boolean } {
    const settings = objects.find(
        (o) => o.type.endsWith(':Metadata') && o.props?.['metadata.name'] === 'settings',
    );
    const get = (key: string): number => {
        const v = Number(settings?.metadata?.find((m) => m.key === key)?.value);
        return Number.isFinite(v) && v > 0 ? v : 0;
    };
    return {
        quantum: get('clock.force-quantum') || get('clock.quantum') || 1024,
        rate: get('clock.force-rate') || get('clock.rate') || 48000,
        forced: get('clock.force-quantum') > 0,
    };
}

/** Extra latency from the node's `Latency` params, in samples and ns (the worst direction). */
function paramLatency(params: Record<string, unknown> | undefined, quantum: number) {
    const list = Array.isArray(params?.Latency) ? (params.Latency as Record<string, number>[]) : [];
    let samples = 0;
    let ns = 0;
    for (const l of list) {
        samples = Math.max(samples, (l.maxQuantum ?? 0) * quantum + (l.maxRate ?? 0));
        ns = Math.max(ns, l.maxNs ?? 0);
    }
    return { samples, ns };
}

/** The node called `nodeName` (the newest, if a restart overlaps), from a parsed `pw-dump`. */
export function nodeLatencyFromDump(dump: unknown[], nodeName: string): NodeLatency | null {
    const objects = dump.filter(isObj);
    let node: DumpObject | null = null;
    for (const o of objects) {
        if (o.type.endsWith(':Node') && o.info?.props?.['node.name'] === nodeName) {
            if (!node || o.id > node.id) node = o;
        }
    }
    if (!node) return null;
    const graph = graphClock(objects);
    const props = node.info?.props ?? {};
    const rate = fraction(props['node.rate'])?.[1] ?? graph.rate;
    // A node that asks for a latency (`node.latency`, seconds as a fraction)
    // runs at that quantum unless the graph forces one.
    const asked = fraction(props['node.latency']);
    const quantum =
        asked && !graph.forced
            ? Math.round((asked[0] / asked[1]) * rate) || graph.quantum
            : graph.quantum;
    const extra = paramLatency(node.info?.params, quantum);
    return {
        quantum,
        rate,
        latencyMs: ((quantum + extra.samples) / rate) * 1000 + extra.ns / 1e6,
    };
}

/** One `pw-dump`, every named node that exists. */
export async function readNodeLatency(
    nodeNames: string[],
    dump: () => Promise<unknown[]> = pwDump,
): Promise<Map<string, NodeLatency>> {
    const graph = await dump();
    const out = new Map<string, NodeLatency>();
    for (const name of nodeNames) {
        const l = nodeLatencyFromDump(graph, name);
        if (l) out.set(name, l);
    }
    return out;
}
