import type { ConnectionState, ModuleState, PortInfo } from '@/stores/engines';

/**
 * Map of a module's input-port id → the upstream OUTPUT port(s) wired into it.
 *
 * This is how in-band stream identity (KLV names, ISO 639 language labels)
 * reaches the receiving side of an edge in the UI: the SOURCE port already
 * carries it (structured `streamInfo` on splitter/demuxer PID ports and muxer
 * stream inputs, or its label), so the sink pin can mirror it without any
 * engine round-trip. Multiple feeds into one pin (mixer inputs) are all
 * returned, in connection order.
 */
export function upstreamPorts(
    modules: Record<string, ModuleState>,
    connections: ConnectionState[],
    instanceId: string,
): Map<string, PortInfo[]> {
    const result = new Map<string, PortInfo[]>();
    for (const c of connections) {
        if (c.sinkModuleId !== instanceId) continue;
        const srcPort = modules[c.sourceModuleId]?.ports?.find((p) => p.id === c.sourcePortId);
        if (!srcPort) continue;
        const list = result.get(c.sinkPortId) ?? [];
        list.push(srcPort);
        result.set(c.sinkPortId, list);
    }
    return result;
}
