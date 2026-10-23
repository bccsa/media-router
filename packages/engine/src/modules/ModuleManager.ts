import { EventEmitter } from 'events';
import type { ModuleRuntimeState } from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';
import type { PluginModule, ModuleServices } from '../plugins/PluginModule.js';
import type { PluginLoader } from '../plugins/PluginLoader.js';
import type { PipeWireManager } from '../audio/PipeWireManager.js';
import type { MediaRouter } from '../routing/MediaRouter.js';
import type { ProcessManager } from '../child-process/ProcessManager.js';
import type { DeviceProviderRegistry } from '../system/DeviceProviderRegistry.js';
import type { HouseClock } from '../clock/HouseClock.js';
import { ModuleInstance } from './ModuleInstance.js';
import { checkStartSettings } from './startSettings.js';

const log = createLogger('ModuleManager');

/**
 * Manages all module instances.
 *
 * Handles create/start/stop/delete lifecycle and forwards state
 * changes to the Engine (which forwards to manager + LCP).
 *
 * Emits:
 *   - 'stateChange' (instanceId, state) — when any module's state changes
 */
export class ModuleManager extends EventEmitter {
    private modules = new Map<string, ModuleInstance>();
    private pluginLoader: PluginLoader;
    private pipeWire: PipeWireManager | null = null;
    private mediaRouter: MediaRouter | null = null;
    private processManager: ProcessManager | null = null;
    private deviceProviders: DeviceProviderRegistry | null = null;
    /** Engine-wide default playout offset D in ms — see `EngineConfig.playoutOffsetMs`. */
    private playoutOffsetMs: number | undefined;
    /** Re-anchor instead of shed — see `EngineConfig.playoutReanchor`. */
    private playoutReanchor = false;
    private houseClock: HouseClock | null = null;

    constructor(
        pluginLoader: PluginLoader,
        pipeWire?: PipeWireManager,
        mediaRouter?: MediaRouter,
        processManager?: ProcessManager,
        deviceProviders?: DeviceProviderRegistry,
        playoutOffsetMs?: number,
        playoutReanchor?: boolean,
        houseClock?: HouseClock,
    ) {
        super();
        this.pluginLoader = pluginLoader;
        this.pipeWire = pipeWire ?? null;
        this.mediaRouter = mediaRouter ?? null;
        this.processManager = processManager ?? null;
        this.deviceProviders = deviceProviders ?? null;
        this.playoutOffsetMs = playoutOffsetMs;
        this.playoutReanchor = playoutReanchor === true;
        this.houseClock = houseClock ?? null;
    }

    /** Create a new module instance. Does NOT start it. */
    createModule(
        instanceId: string,
        pluginId: string,
        config: Record<string, unknown>,
        plugin?: PluginModule,
    ): ModuleInstance {
        if (this.modules.has(instanceId)) {
            throw new Error(`Module already exists: ${instanceId}`);
        }

        // If no plugin provided, create from loader
        const loaded = this.pluginLoader.get(pluginId);
        if (!plugin) {
            if (loaded?.ModuleClass) {
                plugin = new loaded.ModuleClass();
            } else {
                // Fallback no-op plugin for testing
                plugin = createNoOpPlugin();
            }
        }

        // The plugin's schema with the manager's maxima: a value past a bound starts at that bound,
        // any other invalid one at its default (B-103).
        const schema = loaded?.manifest?.configSchema;
        if (schema && typeof schema === 'object' && Object.keys(schema).length > 0) {
            const fixes = checkStartSettings(schema, config);
            if (fixes) {
                log.warn(
                    { instanceId, pluginId, ...fixes },
                    'Config validation failed — values past a bound brought to it, other invalid values reset to defaults',
                );
            }
        }

        // Build services context for the plugin
        const services: ModuleServices | undefined =
            this.pipeWire && this.mediaRouter && this.processManager && this.deviceProviders
                ? {
                      pipeWire: this.pipeWire,
                      mediaRouter: this.mediaRouter,
                      processManager: this.processManager,
                      deviceProviders: this.deviceProviders,
                      ...(this.playoutOffsetMs !== undefined
                          ? { playoutOffsetMs: this.playoutOffsetMs }
                          : {}),
                      ...(this.playoutReanchor ? { playoutReanchor: true } : {}),
                      ...(this.houseClock ? { houseClock: this.houseClock } : {}),
                      instanceId,
                  }
                : undefined;

        const instance = new ModuleInstance(instanceId, pluginId, plugin, config, services, () =>
            this.pluginLoader.settle(pluginId),
        );

        // Forward state changes
        instance.on('stateChange', (id: string, state: ModuleRuntimeState) => {
            this.emit('stateChange', id, state);
        });

        // Forward VU data
        instance.on('vuData', (id: string, data: number[]) => {
            this.emit('vuData', id, data);
        });

        // Forward config updates (e.g. decoder auto-detected channels)
        instance.on('configUpdated', (id: string, changes: Record<string, unknown>) => {
            this.emit('configUpdated', id, changes);
        });

        // Forward clean self-stop requests (plugin ran to a natural end) —
        // the Engine routes these to ModuleLifecycle.disable().
        instance.on('selfStopRequested', (id: string, reason: string) => {
            this.emit('selfStopRequested', id, reason);
        });

        this.modules.set(instanceId, instance);
        return instance;
    }

    /** Start a module by instance ID. */
    async startModule(instanceId: string): Promise<void> {
        const mod = this.modules.get(instanceId);
        if (!mod) throw new Error(`Module not found: ${instanceId}`);
        await mod.start();
    }

    /** Stop a module by instance ID. */
    async stopModule(instanceId: string): Promise<void> {
        const mod = this.modules.get(instanceId);
        if (!mod) throw new Error(`Module not found: ${instanceId}`);
        await mod.stop();
    }

    /** Delete a module (stop + destroy + remove). */
    async deleteModule(instanceId: string): Promise<void> {
        const mod = this.modules.get(instanceId);
        if (!mod) return;
        await mod.destroy();
        this.modules.delete(instanceId);
        this.emit('moduleDeleted', instanceId);
    }

    /**
     * Stop all modules.
     *
     * Deliberately unfiltered: a module whose `running` is false can still own
     * live processes (a start that threw after spawning), and `stop()` guards
     * `onStop` internally, so a not-running module costs only its resource
     * sweep. Filtering on `running` here is what let those processes survive
     * every stop.
     */
    async stopAll(): Promise<void> {
        const promises = Array.from(this.modules.values()).map((m) => m.stop());
        await Promise.allSettled(promises);
    }

    /** Destroy all modules. */
    async destroyAll(): Promise<void> {
        const promises = Array.from(this.modules.values()).map((m) => m.destroy());
        await Promise.allSettled(promises);
        this.modules.clear();
    }

    /** Get a module instance. */
    get(instanceId: string): ModuleInstance | undefined {
        return this.modules.get(instanceId);
    }

    /** Get all module states. */
    getAllStates(): Record<string, ModuleRuntimeState> {
        const states: Record<string, ModuleRuntimeState> = {};
        for (const [id, mod] of this.modules) {
            states[id] = mod.getState();
        }
        return states;
    }

    /** Get count of modules. */
    get size(): number {
        return this.modules.size;
    }

    /** Count of all running GStreamer processes across all modules. */
    get gstProcessCount(): number {
        let count = 0;
        for (const mod of this.modules.values()) {
            count += mod.getProcessCount();
        }
        return count;
    }

    /** Apply config update to a module. */
    async applyConfigUpdate(instanceId: string, changes: Record<string, unknown>): Promise<void> {
        const mod = this.modules.get(instanceId);
        if (!mod) throw new Error(`Module not found: ${instanceId}`);
        await mod.applyConfigUpdate(changes);
    }
}

/** Create a minimal no-op plugin for testing. */
function createNoOpPlugin(): PluginModule {
    return {
        async onInit() {},
        async onStart() {},
        async onStop() {},
        async onDestroy() {},
        getState: () => ({
            running: false,
            ready: false,
            health: 'stopped' as const,
            pendingRestart: false,
        }),
        getLiveUpdatableParams: () => [],
        async onLiveConfigUpdate() {},
    };
}
