import type { ConfigPushTag } from '@media-router/shared-types';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { EngineConnectionManager } from '../engines/EngineConnectionManager.js';
import type { EngineCommandService } from '../handlers/EngineCommandService.js';
import type { RuntimeCache } from './RuntimeCache.js';
import type { TreePublisher } from './TreePublisher.js';

export interface ActivationDeps {
    configStore: ConfigStore;
    engineManager: EngineConnectionManager;
    engineCommands: EngineCommandService;
    runtime: RuntimeCache;
    publisher: TreePublisher;
}

const moduleIds = (config: Record<string, unknown> | undefined) => Object.keys((config?.modules ?? {}) as Record<string, unknown>);

/**
 * Switch an engine's active profile. The running intent is per profile, so
 * the engine is started, stopped or just sent the config accordingly.
 * Returns an error message, or null on success.
 */
export function activateProfile(d: ActivationDeps, engineId: string, profileName: string): string | null {
    const { configStore, engineManager, engineCommands, runtime, publisher } = d;
    const profile = configStore.getProfile(engineId, profileName);
    if (!profile) return 'Profile not found';
    const previous = configStore.getEngine(engineId)?.active_profile;
    const before = typeof previous === 'string' ? moduleIds(configStore.getProfile(engineId, previous)) : [];
    const wasRunning = engineCommands.isRunning(engineId);
    configStore.setActiveProfile(engineId, profileName);
    // Copied profiles share module ids (MR-067): lift the new graph's tombstones, tombstone what it drops.
    const after = new Set(moduleIds(profile));
    runtime.clearModuleTombstones(engineId, [...after]);
    runtime.purgeModuleStates(engineId, before.filter((id) => !after.has(id)));
    const willBeRunning = engineCommands.isRunning(engineId);
    if (engineManager.isEngineOnline(engineId)) {
        if (willBeRunning) {
            // sendCommand pushes the config, then start (startAll swaps modules).
            engineCommands.sendCommand(engineId, 'start');
        } else {
            const _push: ConfigPushTag = { reason: 'activate', profile: profileName };
            engineManager.sendToEngine(engineId, 'config', { ...profile, _push }, { guaranteeDelivery: true });
            if (wasRunning) engineCommands.sendCommand(engineId, 'stop');
        }
    }
    publisher.graph(engineId);
    return null;
}
