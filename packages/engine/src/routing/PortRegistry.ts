import type { ModulePort } from '@media-router/shared-types';

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
        connections: Iterable<{ sourceModuleId: string; sourcePortId: string; sinkModuleId: string; sinkPortId: string }>,
    ): number {
        let count = 0;
        for (const conn of connections) {
            if ((conn.sourceModuleId === moduleId && conn.sourcePortId === portId) ||
                (conn.sinkModuleId === moduleId && conn.sinkPortId === portId)) {
                count++;
            }
        }
        return count;
    }

    /** Validate stream type compatibility between two ports. */
    validateCompatibility(sourcePort: ModulePort, sinkPort: ModulePort): CompatibilityResult {
        if (sourcePort.streamType !== sinkPort.streamType) {
            return {
                compatible: false,
                reason: `Stream type mismatch: ${sourcePort.streamType} → ${sinkPort.streamType}`,
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
