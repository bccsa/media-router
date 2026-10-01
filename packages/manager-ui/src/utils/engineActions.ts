// shared-types is CJS: named imports break under Vite's interop (see stores/engines.ts).
import * as shared from '@media-router/shared-types';
import { useEngineStore } from '@/stores/engines';
import { useSocketStore } from '@/stores/socket';

const { joinPath } = shared;
const engine = (id: string, ...rest: string[]) => joinPath(['engines', id, ...rest]);

function warn(what: string) {
    return (err: unknown) => console.warn(`[engine] ${what} failed`, err);
}

/** Engine run state (a tree write) and lifecycle actions (tree calls). */
export const engineActions = {
    /** Start/stop all modules — optimistic, then `info/running` on the tree. */
    setRunning(engineId: string, running: boolean) {
        useEngineStore().patchInfo(engineId, { running });
        void useSocketStore()
            .write([{ op: 'replace', path: engine(engineId, 'info', 'running'), value: running }])
            .catch(warn(running ? 'start' : 'stop'));
    },
    reset(engineId: string) {
        return useSocketStore().call(engine(engineId), 'reset').catch(warn('reset'));
    },
    reboot(engineId: string) {
        return useSocketStore().call(engine(engineId), 'reboot').catch(warn('reboot'));
    },
    restartModule(engineId: string, moduleId: string) {
        return useSocketStore()
            .call(engine(engineId, 'modules', moduleId), 'restart')
            .catch(warn('module restart'));
    },
};
