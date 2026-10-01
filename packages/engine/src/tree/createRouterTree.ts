import type { PatchOp } from '@media-router/shared-types';
import type { PluginLoader } from '../plugins/PluginLoader.js';
import type { ModuleManager } from '../modules/ModuleManager.js';
import type { ModuleRunController } from '../modules/ModuleRunController.js';
import type { ProfileStore } from '../api/ProfileStore.js';
import type { ManagerConnection } from '../comms/ManagerConnection.js';
import type { CommandDispatcher } from '../commands/CommandDispatcher.js';
import type { LocalChanges } from '../comms/LocalChanges.js';
import { RouterView } from './RouterView.js';
import { RouterTree } from './RouterTree.js';

export interface RouterTreeDeps {
    config: () => Record<string, unknown> | null;
    pluginLoader: PluginLoader;
    moduleManager: ModuleManager;
    profileStore: ProfileStore;
    runController: () => ModuleRunController;
    managerConnection: ManagerConnection;
    commandDispatcher: () => CommandDispatcher;
    localChanges: LocalChanges;
    /** Operator value writes, applied like a local-panel patch. */
    patch: (senderId: string, ops: PatchOp[]) => void;
    device: { ips: string[]; hostname: string; buildNumber: string | undefined };
    /** Changes when the engine dist is redeployed; open router tabs reload on it. */
    build: () => string;
}

/** The router tree reads this engine and acts like the local panel's controls. */
export function createRouterTree(d: RouterTreeDeps): RouterTree {
    const view = new RouterView({
        config: d.config,
        manifest: (pluginId) => d.pluginLoader.get(pluginId)?.manifest as Record<string, unknown> | undefined,
        schema: (pluginId) => d.pluginLoader.getPluginSchemas()[pluginId],
        state: (id) => d.moduleManager.get(id)?.getState(),
        info: () => ({
            name: d.profileStore.getActive()?.name,
            running: d.runController().isRunning,
            ...d.device,
            managerLink: { connected: d.managerConnection.isConnected, paths: d.managerConnection.pathStatus },
        }),
    });
    const command = (running: boolean) => (running ? 'start' : 'stop');
    return new RouterTree(
        view,
        {
            patch: d.patch,
            setRunning: (running) => {
                d.commandDispatcher().dispatch({ command: command(running) });
                d.localChanges.running(running);
            },
            restartModule: (id) => d.commandDispatcher().dispatch({ command: 'moduleRestart', moduleId: id }),
            reboot: () => d.commandDispatcher().dispatch({ command: 'reboot' }),
            reset: () => d.commandDispatcher().dispatch({ command: 'reset' }),
            managerConnected: () => d.managerConnection.isConnected,
        },
        d.build,
    );
}
