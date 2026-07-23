import { streamTypesCompatible, type ModulePort } from '@media-router/shared-types';

export interface CompatibilityResult {
    compatible: boolean;
    reason?: string;
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

    /** Count active connections on a specific port. */
    getConnectionCount(
        moduleId: string,
        portId: string,
        connections: Iterable<{
            sourceModuleId: string;
            sourcePortId: string;
            sinkModuleId: string;
            sinkPortId: string;
        }>,
    ): number {
        let count = 0;
        for (const conn of connections) {
            if (
                (conn.sourceModuleId === moduleId && conn.sourcePortId === portId) ||
                (conn.sinkModuleId === moduleId && conn.sinkPortId === portId)
            ) {
                count++;
            }
        }
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
