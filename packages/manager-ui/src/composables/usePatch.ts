import { useSocketStore } from '@/stores/socket';
import { useEngineStore } from '@/stores/engines';
import { newModuleInstanceId } from '@/utils/ids';

// JSON round-trip clone — robust against Vue/Pinia reactive proxies, which can
// trip `structuredClone` depending on the underlying values. Module state is
// plain JSON (settings, ports, configSchema) so this is lossless.
function jsonClone<T>(v: T): T {
    return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

interface PatchOp {
    op: 'add' | 'replace' | 'remove';
    path: string;
    value?: unknown;
}

/**
 * Send a patch: apply to the local store first (optimistic), then write it to
 * the tree at `/engines/<id>/…`. The echo brings the stored value back; a
 * rejected op snaps back the same way (ADR-0024).
 */
function emit(engineId: string, ops: PatchOp[]) {
    useEngineStore().applyEnginePatch(engineId, ops);
    const prefix = `/engines/${engineId}`;
    useSocketStore()
        .write(ops.map((op) => ({ ...op, path: prefix + op.path })))
        .then(({ rejected }) => {
            if (rejected.length > 0) console.warn('[patch] rejected by the manager', rejected);
        })
        .catch((err) => console.warn('[patch] write failed', err));
}

/**
 * Patch helpers for sending unified config changes.
 * Every method applies to the local store immediately, then sends to the server.
 *
 * Usage:
 *   import { patch } from '@/composables/usePatch';
 *   patch.moduleSetting(engineId, moduleId, 'volume', 80);
 *   patch.moduleRename(engineId, moduleId, 'New Name');
 */
export const patch = {
    raw: emit,

    moduleSetting(engineId: string, moduleId: string, key: string, value: unknown) {
        emit(engineId, [{ op: 'replace', path: `/modules/${moduleId}/settings/${key}`, value }]);
    },

    moduleSettings(engineId: string, moduleId: string, changes: Record<string, unknown>) {
        emit(
            engineId,
            Object.entries(changes).map(([key, value]) => ({
                op: 'replace' as const,
                path: `/modules/${moduleId}/settings/${key}`,
                value,
            })),
        );
    },

    moduleRename(engineId: string, moduleId: string, displayName: string) {
        emit(engineId, [
            { op: 'replace', path: `/modules/${moduleId}/displayName`, value: displayName },
        ]);
    },

    /** One patch for every moved module (single or group drag). */
    modulePositions(engineId: string, positions: Array<{ id: string; x: number; y: number }>) {
        emit(
            engineId,
            positions.map(({ id, x, y }) => ({
                op: 'replace' as const,
                path: `/modules/${id}/position`,
                value: { x, y },
            })),
        );
    },

    moduleSize(engineId: string, moduleId: string, size: { width: number; height: number }) {
        emit(engineId, [{ op: 'replace', path: `/modules/${moduleId}/size`, value: size }]);
    },

    moduleField(engineId: string, moduleId: string, field: string, value: unknown) {
        emit(engineId, [{ op: 'replace', path: `/modules/${moduleId}/${field}`, value }]);
    },

    /** Same field on several modules in one patch (group actions). */
    modulesField(engineId: string, moduleIds: string[], field: string, value: unknown) {
        emit(
            engineId,
            moduleIds.map((id) => ({ op: 'replace' as const, path: `/modules/${id}/${field}`, value })),
        );
    },

    moduleToggle(engineId: string, moduleId: string, enabled: boolean) {
        emit(engineId, [{ op: 'replace', path: `/modules/${moduleId}/enabled`, value: enabled }]);
    },

    addModule(engineId: string, instanceId: string, value: Record<string, unknown>) {
        emit(engineId, [{ op: 'add', path: `/modules/${instanceId}`, value }]);
    },

    removeModule(engineId: string, moduleId: string) {
        emit(engineId, [{ op: 'remove', path: `/modules/${moduleId}` }]);
    },

    removeModules(engineId: string, moduleIds: string[]) {
        emit(
            engineId,
            moduleIds.map((id) => ({ op: 'remove' as const, path: `/modules/${id}` })),
        );
    },

    cloneModule(engineId: string, moduleId: string): string | undefined {
        const mod = useEngineStore().getEngine(engineId)?.modules[moduleId];
        if (!mod) return undefined;
        const instanceId = newModuleInstanceId(mod.pluginId);
        emit(engineId, [
            {
                op: 'add',
                path: `/modules/${instanceId}`,
                value: {
                    instanceId,
                    pluginId: mod.pluginId,
                    displayName: mod.displayName + ' (copy)',
                    position: {
                        x: (mod.position?.x ?? 100) + 50,
                        y: (mod.position?.y ?? 100) + 50,
                    },
                    settings: jsonClone(mod.settings ?? {}),
                    ports: jsonClone(mod.ports ?? []),
                    configSchema: jsonClone(mod.configSchema),
                    color: mod.color,
                    icon: mod.icon,
                    // Manifest-derived fields, copied so the optimistic view
                    // has resize grips, status sections, etc. before the echo.
                    statusSections: jsonClone(mod.statusSections),
                    faceWidgets: jsonClone(mod.faceWidgets),
                    interlock: mod.interlock === true,
                    resizable: mod.resizable,
                    enabled: true,
                    running: false,
                    health: 'stopped',
                },
            },
        ]);
        return instanceId;
    },

    addConnection(engineId: string, connection: Record<string, unknown>) {
        emit(engineId, [{ op: 'add', path: '/connections/-', value: connection }]);
    },

    removeConnection(engineId: string, connectionId: string) {
        emit(engineId, [{ op: 'remove', path: `/connections/${connectionId}` }]);
    },

    connectionField(engineId: string, connectionId: string, field: string, value: unknown) {
        emit(engineId, [{ op: 'replace', path: `/connections/${connectionId}/${field}`, value }]);
    },

    // --- Interlocks (exclusive-mute groups) ---

    createInterlock(
        engineId: string,
        value: { id: string; name: string; members: string[]; color?: string },
    ) {
        emit(engineId, [{ op: 'add', path: '/interlocks/-', value }]);
    },

    deleteInterlock(engineId: string, interlockId: string) {
        emit(engineId, [{ op: 'remove', path: `/interlocks/${interlockId}` }]);
    },

    renameInterlock(engineId: string, interlockId: string, name: string) {
        emit(engineId, [{ op: 'replace', path: `/interlocks/${interlockId}/name`, value: name }]);
    },

    recolorInterlock(engineId: string, interlockId: string, color: string) {
        emit(engineId, [{ op: 'replace', path: `/interlocks/${interlockId}/color`, value: color }]);
    },

    setInterlockMembers(engineId: string, interlockId: string, members: string[]) {
        emit(engineId, [
            { op: 'replace', path: `/interlocks/${interlockId}/members`, value: members },
        ]);
    },
};
