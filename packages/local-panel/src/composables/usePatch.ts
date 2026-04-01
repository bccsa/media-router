import { useSocketStore } from '@/stores/socket';

interface PatchOp {
    op: 'add' | 'replace' | 'remove';
    path: string;
    value?: unknown;
}

function emit(ops: PatchOp[]) {
    useSocketStore().emit('patch', { ops });
}

/**
 * Patch helpers for the Local Control Panel.
 * Same API as the manager-ui version, but sends to the engine (not manager).
 * No engineId needed — LCP is always connected to one engine.
 */
export const patch = {
    raw: emit,

    moduleSetting(moduleId: string, key: string, value: unknown) {
        emit([{ op: 'replace', path: `/modules/${moduleId}/settings/${key}`, value }]);
    },
};
