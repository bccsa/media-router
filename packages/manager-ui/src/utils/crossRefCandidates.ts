import * as shared from '@media-router/shared-types';
import type { EditorLayout } from '@media-router/shared-types';
import type { ConnectionState, EngineState } from '@/stores/engines';
import { validateCandidateConnection } from './connectionValidation';
import { compactPortLabel } from './portDisplay';
import { PCM, deriveRefs, pageNamesOf, pageResolver, sortedPages } from './crossRefs';
import type { LinkCandidate } from './crossRefTypes';

// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
const { refKey } = shared;

/** The port a wire was dragged from before it was dropped on empty canvas. */
export interface LinkOrigin {
    moduleId: string;
    portId: string;
    direction: 'input' | 'output';
}

function usesPort(c: ConnectionState, moduleId: string, portId: string): boolean {
    return (
        (c.sourceModuleId === moduleId && c.sourcePortId === portId) ||
        (c.sinkModuleId === moduleId && c.sinkPortId === portId)
    );
}

/**
 * Ports on other pages that a wire dropped from `from` can be linked to, in
 * page order, then module name, then the module's port order. Each passes the
 * same validator as a dragged wire, capacity included. PipeWire ports, ports
 * the canvas hides (`hideWhenUnconnected` with nothing wired) and ports
 * already wired to `from` are left out.
 */
export function linkCandidates(
    engine: Pick<EngineState, 'modules' | 'connections'>,
    editor: EditorLayout | undefined,
    from: LinkOrigin,
): LinkCandidate[] {
    const fromPort = engine.modules[from.moduleId]?.ports?.find((p) => p.id === from.portId);
    if (!fromPort || fromPort.streamType === PCM) return [];
    const { modules, connections } = engine;
    const pageFor = pageResolver(editor);
    const fromPage = pageFor(from.moduleId);
    const names = pageNamesOf(editor);
    const pageIndex = new Map(sortedPages(editor).map((p, i) => [p.id, i]));
    const derived = deriveRefs(modules, connections, editor, names);
    const want = from.direction === 'output' ? 'input' : 'output';
    const kind = want === 'input' ? 'in' : 'out';
    const fromEnd = { moduleId: from.moduleId, port: fromPort };

    const found: Array<LinkCandidate & { rank: number }> = [];
    for (const mod of Object.values(modules)) {
        const pageId = pageFor(mod.instanceId);
        if (pageId === fromPage) continue;
        for (const port of mod.ports ?? []) {
            if (port.direction !== want || port.streamType === PCM) continue;
            const wired = connections.filter((c) => usesPort(c, mod.instanceId, port.id));
            if (port.hideWhenUnconnected && wired.length === 0) continue;
            if (wired.some((c) => usesPort(c, from.moduleId, from.portId))) continue;
            const end = { moduleId: mod.instanceId, port };
            if (!validateCandidateConnection(fromEnd, end, connections).ok) continue;
            found.push({
                rank: pageIndex.get(pageId) ?? 0,
                pageId,
                pageName: names[pageId] ?? pageId,
                moduleId: mod.instanceId,
                moduleName: mod.displayName,
                portId: port.id,
                portLabel: compactPortLabel(port),
                streamType: port.streamType,
                existingRefLabel: derived.refs[refKey(kind, mod.instanceId, port.id)]?.label,
            });
        }
    }
    // Array.sort is stable, so a module's ports keep their declared order.
    found.sort((a, b) => a.rank - b.rank || a.moduleName.localeCompare(b.moduleName));
    return found.map(({ rank: _rank, ...candidate }) => candidate);
}
