import type { ComputedRef } from 'vue';
import type { Connection } from '@vue-flow/core';
// shared-types is CJS: a namespace import is the safe interop (see stores/engines.ts).
import * as shared from '@media-router/shared-types';
import type { EngineState } from '@/stores/engines';
import { useEngineStore } from '@/stores/engines';
import { patch } from '@/composables/usePatch';
import { useToast } from '@/composables/useToast';
import { validateCandidateConnection, type ValidationResult } from '@/utils/connectionValidation';
import type { LinkOrigin } from '@/utils/crossRefCandidates';
import { isEmptyPane } from '@/utils/xrefCanvas';

const { isRefKey } = shared;

/** Vue Flow's connect-start payload: the node and handle a wire is dragged from. */
export interface ConnectStart {
    nodeId?: string;
    handleId?: string | null;
}

/** Where a wire was released: the pointer, or the lifted finger. */
function releasePoint(e: MouseEvent | TouchEvent): { x: number; y: number } | null {
    const p = 'changedTouches' in e ? e.changedTouches[0] : e;
    return p ? { x: p.clientX, y: p.clientY } : null;
}

/** One end of a candidate connection, as dragged or picked: either side may be the output. */
export interface PortRef {
    moduleId: string;
    portId: string;
}

/**
 * Resolve both ends to ports and delegate to the pure validator
 * (`utils/connectionValidation.ts` — tested there). Every reject carries a
 * human-readable reason for the toast.
 */
function validatePair(engine: EngineState | undefined, a: PortRef, b: PortRef): ValidationResult {
    const aPort = engine?.modules[a.moduleId]?.ports?.find((p) => p.id === a.portId);
    const bPort = engine?.modules[b.moduleId]?.ports?.find((p) => p.id === b.portId);
    if (!aPort || !bPort) return { ok: false, reason: 'Port not found' };
    return validateCandidateConnection(
        { moduleId: a.moduleId, port: aPort },
        { moduleId: b.moduleId, port: bPort },
        engine?.connections ?? [],
    );
}

/** Validate, orient output → input, build the id and persist. */
function connectIn(
    engineId: string,
    engine: EngineState | undefined,
    a: PortRef,
    b: PortRef,
): ValidationResult {
    const verdict = validatePair(engine, a, b);
    if (!verdict.ok) return verdict;
    const aPort = engine?.modules[a.moduleId]?.ports?.find((p) => p.id === a.portId);
    const [out, inp] = aPort?.direction === 'input' ? [b, a] : [a, b];
    // Just persist — the edges rebuild when the store updates via the socket response.
    patch.addConnection(engineId, {
        id: `${out.moduleId}:${out.portId}-${inp.moduleId}:${inp.portId}`,
        sourceModuleId: out.moduleId,
        sourcePortId: out.portId,
        sinkModuleId: inp.moduleId,
        sinkPortId: inp.portId,
    });
    return verdict;
}

/**
 * Connect two ports of an engine (from the store), in either order. Returns the
 * verdict; a rejected pair writes nothing and the caller says why.
 */
export function connectPorts(engineId: string, a: PortRef, b: PortRef): ValidationResult {
    return connectIn(engineId, useEngineStore().getEngine(engineId), a, b);
}

const endsOf = (c: Connection): [PortRef, PortRef] => [
    { moduleId: c.source!, portId: c.sourceHandle! },
    { moduleId: c.target!, portId: c.targetHandle! },
];

/**
 * Wire-drag handling. `isValidConnection` is NOT passed to VueFlow as a prop
 * (it was called during setEdges and dropped edges that hit maxConnections);
 * `onConnect` validates and explains the silent Vue Flow snap-back via a toast.
 *
 * A wire released on empty canvas without connecting calls `onPaneDrop` with
 * the port it came from and the screen point (ADR-0030: the link picker).
 * Vue Flow fires connect-end after a successful connect too, so a gesture
 * that connected is skipped.
 */
export function useGraphConnect(
    engineId: () => string,
    engine: ComputedRef<EngineState | undefined>,
    onPaneDrop?: (origin: LinkOrigin, x: number, y: number) => void,
) {
    const toast = useToast();
    let origin: LinkOrigin | null = null;
    let connected = false;

    function validateConnection(connection: Connection): ValidationResult {
        return validatePair(engine.value, ...endsOf(connection));
    }

    function isValidConnection(connection: Connection): boolean {
        return validateConnection(connection).ok;
    }

    function onConnect(connection: Connection) {
        connected = true;
        // Tag handles can't be connected to; should one ever be, say how linking works.
        const ids = [connection.source, connection.target];
        if (ids.some((id) => !engine.value?.modules[id] && isRefKey(id))) {
            toast.show('Drop on empty canvas to link to another page');
            return;
        }
        const verdict = connectIn(engineId(), engine.value, ...endsOf(connection));
        if (!verdict.ok) toast.show(verdict.reason);
    }

    function onConnectStart(start: ConnectStart) {
        connected = false;
        const id = start.nodeId ?? '';
        const port = engine.value?.modules[id]?.ports?.find((p) => p.id === start.handleId);
        origin = port ? { moduleId: id, portId: port.id, direction: port.direction } : null;
    }

    function onConnectEnd(event?: MouseEvent | TouchEvent) {
        const from = origin;
        origin = null;
        if (!from || connected || !event || !onPaneDrop) return;
        const at = releasePoint(event);
        if (at && isEmptyPane(document.elementFromPoint(at.x, at.y))) onPaneDrop(from, at.x, at.y);
    }

    return { validateConnection, isValidConnection, onConnect, onConnectStart, onConnectEnd };
}
