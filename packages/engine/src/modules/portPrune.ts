/**
 * Retiring the stored connections of dynamic ports that vanished (see
 * `ModuleLifecycle.onDynamicPortsRemoved`): an operator removed a muxer
 * input, a teletext page… An edge to a port that no longer exists can never
 * apply; left in config it dangles in the UI (its handle is gone) and fails
 * "port not found" on every restart. So: drop it from the engine's config,
 * tear down any live handle, and patch `remove /connections/<id>` up to the
 * manager so the edge leaves SQLite and the UI too.
 */
import { createLogger } from '@media-router/shared-types';
import { edgeOnPort, type PortEdge } from '../routing/PortRegistry.js';

const log = createLogger('portPrune');

export type StoredConnectionRef = PortEdge & { id: string };

/** The stored connections attached to any of `portIds` on `moduleId`. Pure. */
export function connectionsOnPorts<T extends PortEdge>(
    connections: readonly T[],
    moduleId: string,
    portIds: readonly string[],
): T[] {
    return connections.filter((c) => portIds.some((p) => edgeOnPort(c, moduleId, p)));
}

export interface RetireDeps {
    /** The engine's current config (mutated: `connections` is filtered). */
    getConfig: () => Record<string, unknown> | null;
    /** Tear down a live handle; resolves false / rejects when it was not live. */
    removeLiveConnection: (connId: string) => Promise<unknown>;
    /** Send ops to the manager AND the local control panel. */
    publish: (ops: Array<{ op: 'remove'; path: string }>) => void;
}

/** Retire every stored connection on the vanished ports. Returns their ids. */
export function retireConnectionsOnPorts(
    deps: RetireDeps,
    moduleId: string,
    portIds: readonly string[],
): string[] {
    const config = deps.getConfig();
    const conns = (config?.connections ?? []) as StoredConnectionRef[];
    const doomed = connectionsOnPorts(conns, moduleId, portIds);
    if (doomed.length === 0) return [];
    const ids = doomed.map((c) => c.id);
    log.info({ moduleId, portIds, connections: ids }, 'Dynamic ports removed — retiring their connections');
    const gone = new Set(ids);
    // Config first, so nothing re-applies them while the teardown runs.
    if (config) config.connections = conns.filter((c) => !gone.has(c.id));
    for (const id of ids) {
        deps.removeLiveConnection(id).catch((err: unknown) => {
            log.debug({ err, connId: id }, 'Retired connection was not live');
        });
    }
    deps.publish(ids.map((id) => ({ op: 'remove' as const, path: `/connections/${id}` })));
    return ids;
}
