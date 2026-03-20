import { EventEmitter } from 'events';
import Ajv from 'ajv';
import type { ModuleRuntimeState } from '@media-router/shared-types';
import { ConfigValidationError, createLogger } from '@media-router/shared-types';
import type { PluginModule, ModuleServices } from '../plugins/PluginModule.js';
import type { PluginLoader } from '../plugins/PluginLoader.js';
import type { PipeWireManager } from '../audio/PipeWireManager.js';
import type { MediaRouter } from '../routing/MediaRouter.js';
import type { ProcessManager } from '../child-process/ProcessManager.js';
import { ModuleInstance } from './ModuleInstance.js';

const log = createLogger('ModuleManager');
const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });

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

    constructor(pluginLoader: PluginLoader, pipeWire?: PipeWireManager, mediaRouter?: MediaRouter, processManager?: ProcessManager) {
        super();
        this.pluginLoader = pluginLoader;
        this.pipeWire = pipeWire ?? null;
        this.mediaRouter = mediaRouter ?? null;
        this.processManager = processManager ?? null;
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

        // Validate config against plugin's JSON Schema — reset invalid values to defaults
        const schema = loaded?.manifest?.configSchema;
        if (schema && typeof schema === 'object' && Object.keys(schema).length > 0) {
            const validate = ajv.compile(schema);
            if (!validate(config)) {
                const errors = validate.errors?.map(
                    (e) => `${e.instancePath || '/'} ${e.message}`,
                ) ?? [];
                log.warn({ instanceId, pluginId, errors }, 'Config validation failed — resetting invalid values to defaults');

                // Reset invalid properties to their schema defaults
                const props = (schema as any).properties ?? {};
                for (const err of validate.errors ?? []) {
                    const key = (err.instancePath || '').replace(/^\//, '');
                    if (key && props[key]?.default !== undefined) {
                        (config as Record<string, unknown>)[key] = props[key].default;
                    }
                }
            }
        }

        // Build services context for the plugin
        const services: ModuleServices | undefined = (this.pipeWire && this.mediaRouter && this.processManager)
            ? { pipeWire: this.pipeWire, mediaRouter: this.mediaRouter, processManager: this.processManager, instanceId }
            : undefined;

        const instance = new ModuleInstance(instanceId, pluginId, plugin, config, services);

        // Forward state changes
        instance.on('stateChange', (id: string, state: ModuleRuntimeState) => {
            this.emit('stateChange', id, state);
        });

        // Forward VU data
        instance.on('vuData', (id: string, data: number[]) => {
            this.emit('vuData', id, data);
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
    }

    /** Stop all running modules. */
    async stopAll(): Promise<void> {
        const promises = Array.from(this.modules.values())
            .filter((m) => m.running)
            .map((m) => m.stop());
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
