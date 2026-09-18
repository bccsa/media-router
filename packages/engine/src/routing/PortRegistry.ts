import { streamTypesCompatible, type ModulePort } from '@media-router/shared-types';

export interface CompatibilityResult {
    compatible: boolean;
    reason?: string;
}

/** The four fields every connection record carries — live (`Connection`) or
 *  stored (engine config `connections`). */
export interface PortEdge {
    sourceModuleId: string;
    sourcePortId: string;
    sinkModuleId: string;
    sinkPortId: string;
}

/** True when `edge` is attached to `moduleId:portId` at either end. */
export function edgeOnPort(edge: PortEdge, moduleId: string, portId: string): boolean {
    return (
        (edge.sourceModuleId === moduleId && edge.sourcePortId === portId) ||
        (edge.sinkModuleId === moduleId && edge.sinkPortId === portId)
    );
}

/**
 * Registry of module ports — tracks which ports each module exposes
 * and validates connection compatibility.
 */
export class PortRegistry {
    private ports = new Map<string, ModulePort[]>();

    register(moduleId: string, ports: ModulePort[]): void {
        this.ports.set(moduleId, ports);
    }

    unregister(moduleId: string): void {
        this.ports.delete(moduleId);
    }

    unregisterAll(): void {
        this.ports.clear();
    }

    get(moduleId: string, portId: string): ModulePort | undefined {
        return this.ports.get(moduleId)?.find((p) => p.id === portId);
    }

    getAll(moduleId: string): ModulePort[] {
        return this.ports.get(moduleId) ?? [];
    }

    /** Count connections on a specific port. */
    getConnectionCount(moduleId: string, portId: string, connections: Iterable<PortEdge>): number {
        let count = 0;
        for (const conn of connections) if (edgeOnPort(conn, moduleId, portId)) count++;
        return count;
    }

    /** Validate stream type compatibility between two ports.
     *  Exact match, or TS-family (`muxed/mpegts` ↔ `audio/302m`) — see
     *  `streamTypesCompatible` in shared-types (single source of truth,
     *  shared with the manager-ui connection validator). */
    validateCompatibility(sourcePort: ModulePort, sinkPort: ModulePort): CompatibilityResult {
        if (!streamTypesCompatible(sourcePort.streamType, sinkPort.streamType)) {
            return {
                compatible: false,
                reason: `Stream type mismatch: ${sourcePort.streamType} → ${sinkPort.streamType}`,
            };
        }

        // Plugin-declared exact-match accept list — opts this input out of
        // TS-family leniency (see ModulePort.acceptsStreamTypes).
        if (
            sinkPort.acceptsStreamTypes &&
            !sinkPort.acceptsStreamTypes.includes(sourcePort.streamType)
        ) {
            return {
                compatible: false,
                reason: `Port accepts only ${sinkPort.acceptsStreamTypes.join(', ')} — got ${sourcePort.streamType}`,
            };
        }

        if (sourcePort.streamType === 'audio/pcm') {
            const srcCh = sourcePort.channelConfig?.channels;
            const sinkCh = sinkPort.channelConfig?.channels;
            if (srcCh && sinkCh && srcCh !== sinkCh) {
                return {
                    compatible: false,
                    reason: `Channel mismatch: ${srcCh} → ${sinkCh}`,
                };
            }
        }

        return { compatible: true };
    }
}
