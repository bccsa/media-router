// Graphs for the crossRefs tests (not shipped: only tests import it).
import { emptyEditorLayout, type EditorLayout } from '@media-router/shared-types';
import type { ConnectionState, ModuleState, PortInfo } from '@/stores/engines';
import { deriveRefs, pageNamesOf } from '@/utils/crossRefs';

export const CYAN = '#06b6d4';
export const AMBER = '#f59e0b';

export function port(
    id: string,
    direction: PortInfo['direction'],
    streamType = 'audio/302m',
    max = -1,
): PortInfo {
    return { id, direction, streamType, label: id, maxConnections: max };
}
export function mod(id: string, ports: PortInfo[]): ModuleState {
    return {
        instanceId: id,
        pluginId: 'p',
        displayName: id.toUpperCase(),
        running: true,
        enabled: true,
        health: 'ok',
        pendingRestart: false,
        settings: {},
        ports,
    };
}
export function conn(src: string, sink: string, srcPort = 'out', sinkPort = 'in'): ConnectionState {
    return {
        id: `${src}-${sink}`,
        sourceModuleId: src,
        sourcePortId: srcPort,
        sinkModuleId: sink,
        sinkPortId: sinkPort,
    };
}
/** Pages A (order 0) and B (order 1); `onB` lists the modules pinned to B, the rest sit on A. */
export function layout(onB: string[], extra: Partial<EditorLayout> = {}): EditorLayout {
    return {
        ...emptyEditorLayout(),
        pages: { 'pg-a': { name: 'Intake', order: 0 }, 'pg-b': { name: 'Output', order: 1 } },
        modulePages: Object.fromEntries(onB.map((id) => [id, 'pg-b'])),
        ...extra,
    };
}
export const derive = (
    modules: Record<string, ModuleState>,
    connections: ConnectionState[],
    editor?: EditorLayout,
) => deriveRefs(modules, connections, editor, pageNamesOf(editor));

export const src = mod('src', [port('out', 'output')]);
export const sinks = ['s1', 's2', 's3'].map((id) => mod(id, [port('in', 'input')]));
export const fanOut = { src, ...Object.fromEntries(sinks.map((m) => [m.instanceId, m])) };
export const fanConns = sinks.map((m) => conn('src', m.instanceId));
