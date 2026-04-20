import { useSocketStore } from '@/stores/socket';
import { useEngineStore } from '@/stores/engines';

interface PatchOp {
    op: 'add' | 'replace' | 'remove';
    path: string;
    value?: unknown;
}

/**
 * Send a patch: apply to local store first (optimistic), then emit to server.
 * The N-1 router skips the sender, so without the local apply the sender
 * would never see its own change until refresh.
 */
function emit(engineId: string, ops: PatchOp[]) {
    // 1. Apply optimistically to local store
    useEngineStore().applyEnginePatch(engineId, ops);
    // 2. Send to server (server broadcasts to everyone else)
    useSocketStore().emit('patch', { engineId, ops });
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

    modulePosition(engineId: string, moduleId: string, position: { x: number; y: number }) {
        emit(engineId, [{ op: 'replace', path: `/modules/${moduleId}/position`, value: position }]);
    },

    moduleField(engineId: string, moduleId: string, field: string, value: unknown) {
        emit(engineId, [{ op: 'replace', path: `/modules/${moduleId}/${field}`, value }]);
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
