// The latency PipeWire reports for a module's node (design §9.5, WI-P0-10): one cycle of the
// node's driver group, which runs the smallest request among its nodes (an MR_PW null sink asks
// for nothing itself), plus whatever the node's own `Latency` param adds.
import { pwDump } from './streamPortLinks.js';

export interface NodeLatency {
    /** Samples per graph cycle of the node's driver group. */
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
const prop = (o: DumpObject | undefined, key: string): unknown => o?.info?.props?.[key];
/** A driver carries no `node.driver-id`: its own id names its group (alone, if none follow). */
const driverOf = (o: DumpObject): number => {
    const id = Number(prop(o, 'node.driver-id') ?? NaN);
    return Number.isInteger(id) ? id : o.id;
};

/** "1024/48000" or a reduced "8/375" → [num, den]. */
function fraction(v: unknown): [number, number] | null {
    const m = /^(\d+)\/(\d+)$/.exec(String(v ?? ''));
    return m && Number(m[2]) > 0 ? [Number(m[1]), Number(m[2])] : null;
}

/** Clock settings from the `settings` metadata, and the core's power-of-two rounding. */
function graphClock(objects: DumpObject[]) {
    const settings = objects.find(
        (o) => o.type.endsWith(':Metadata') && o.props?.['metadata.name'] === 'settings',
    );
    const get = (key: string): number => {
        const v = Number(settings?.metadata?.find((m) => m.key === key)?.value);
        return Number.isFinite(v) && v > 0 ? v : 0;
    };
    const core = objects.find((o) => o.type.endsWith(':Core'));
    return {
        quantum: get('clock.quantum') || 1024,
        minQuantum: get('clock.min-quantum') || 32,
        maxQuantum: get('clock.max-quantum') || 8192,
        forceQuantum: get('clock.force-quantum'),
        rate: get('clock.force-rate') || get('clock.rate') || 48000,
        // pipewire.conf(5) documents it on by default.
        powerOfTwo: prop(core, 'clock.power-of-two-quantum') !== false,
    };
}

type GraphClock = ReturnType<typeof graphClock>;

/** The quantum the driver group of `node` runs: its smallest request, clamped and rounded. */
function groupQuantum(objects: DumpObject[], node: DumpObject, graph: GraphClock): number {
    if (graph.forceQuantum) return graph.forceQuantum;
    const group = driverOf(node);
    const asks = objects
        .filter((o) => o.type.endsWith(':Node') && driverOf(o) === group)
        .map((o) => fraction(prop(o, 'node.latency')))
        .map((f) => (f ? Math.round((f[0] / f[1]) * graph.rate) : 0))
        .filter((q) => q > 0);
    const wanted = asks.length ? Math.min(...asks) : graph.quantum;
    const q = Math.min(Math.max(wanted, graph.minQuantum), graph.maxQuantum);
    // Requests and the final quantum both round down; rounding only the final one is the same.
    return graph.powerOfTwo ? 2 ** Math.floor(Math.log2(q)) : q;
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
    const quantum = groupQuantum(objects, node, graph);
    const extra = paramLatency(node.info?.params, quantum);
    return {
        quantum,
        rate: graph.rate,
        latencyMs: ((quantum + extra.samples) / graph.rate) * 1000 + extra.ns / 1e6,
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
