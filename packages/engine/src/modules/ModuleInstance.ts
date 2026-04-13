import { EventEmitter } from 'events';
import type { ModuleRuntimeState } from '@media-router/shared-types';
import { createLogger, formatError } from '@media-router/shared-types';
import type { PluginModule, ModuleServices } from '../plugins/PluginModule.js';
import type { GstChildProcess } from '../child-process/GstChildProcess.js';

const log = createLogger('ModuleInstance');

/**
 * Wraps a PluginModule with instance-specific state tracking.
 *
 * Manages the module lifecycle (init → start → stop → destroy)
 * and tracks runtime state (health, VU data, errors, pending restart).
 */
export class ModuleInstance extends EventEmitter {
    readonly instanceId: string;
    readonly pluginId: string;
    private plugin: PluginModule;
    public config: Record<string, unknown>;
    private _running = false;
    private _pendingRestart = false;
    private _initialized = false;
    private services: ModuleServices | null = null;
    /** Bound listener refs for cleanup — prevents EventEmitter leaks across start/stop cycles. */
    private pluginListeners: Array<{ event: string; handler: (...args: any[]) => void }> = [];

    constructor(instanceId: string, pluginId: string, plugin: PluginModule, config: Record<string, unknown>, services?: ModuleServices) {
        super();
        this.instanceId = instanceId;
        this.pluginId = pluginId;
        this.plugin = plugin;
        this.config = config;
        this.services = services ?? null;

        this.attachPluginListeners();
    }

    /** Attach forwarding listeners to the plugin and track them for cleanup. */
    private attachPluginListeners(): void {
        if (!('on' in this.plugin) || typeof (this.plugin as any).on !== 'function') return;

        const emitter = this.plugin as unknown as EventEmitter;

        const onVuData = (data: number[]) => {
            this.emit('vuData', this.instanceId, data);
        };
        const onStateChange = () => {
            this.emitStateChange();
        };

        const onConfigUpdated = (changes: Record<string, unknown>) => {
            this.emit('configUpdated', this.instanceId, changes);
        };

        emitter.on('vuData', onVuData);
        emitter.on('stateChange', onStateChange);
        emitter.on('configUpdated', onConfigUpdated);

        this.pluginListeners.push(
            { event: 'vuData', handler: onVuData },
            { event: 'stateChange', handler: onStateChange },
            { event: 'configUpdated', handler: onConfigUpdated },
        );
    }

    /** Remove all listeners we attached to the plugin. */
    private detachPluginListeners(): void {
        if (!('removeListener' in this.plugin) || typeof (this.plugin as any).removeListener !== 'function') return;

        const emitter = this.plugin as unknown as EventEmitter;
        for (const { event, handler } of this.pluginListeners) {
            emitter.removeListener(event, handler);
        }
        this.pluginListeners = [];
    }

    get running(): boolean {
        return this._running;
    }

    /** Get current runtime state from the underlying plugin. */
    getState(): ModuleRuntimeState {
        const state = this.plugin.getState();
        return {
            ...state,
            pendingRestart: this._pendingRestart,
        };
    }

    /** Initialise and start the module. */
    async start(): Promise<void> {
        if (this._running) return;
        try {
            if (!this._initialized) {
                await this.plugin.onInit(this.config, this.services ?? undefined);
                this._initialized = true;
            }
            await this.plugin.onStart();
            this._running = true;
            this._pendingRestart = false;
        } catch (err) {
            log.error({ err: formatError(err), instanceId: this.instanceId }, 'Module start failed');
            // Attempt cleanup so the module doesn't get stuck in a half-initialised state
            try { await this.plugin.onStop(); } catch { /* best effort */ }
            throw err;
        }
        this.emitStateChange();
    }

    /** Stop the module. */
    async stop(): Promise<void> {
        if (!this._running) return;
        try {
            await this.plugin.onStop();
        } catch (err) {
            log.error({ err, instanceId: this.instanceId }, 'Module stop failed');
        }
        this._running = false;
        // Auto-cleanup PipeWire resources owned by this module
        if (this.services?.pipeWire) {
            try {
                await this.services.pipeWire.releaseAll(this.instanceId);
            } catch { /* best effort */ }
        }
        // Auto-cleanup spawned processes owned by this module
        if (this.services?.processManager) {
            try {
                await this.services.processManager.releaseAll(this.instanceId);
            } catch { /* best effort */ }
        }
        this.emitStateChange();
    }

    /** Stop and destroy the module (final cleanup). */
    async destroy(): Promise<void> {
        await this.stop();
        try {
            await this.plugin.onDestroy();
        } catch (err) {
            log.error({ err, instanceId: this.instanceId }, 'Module destroy failed');
        }
        this._initialized = false;
        this.detachPluginListeners();
        this.removeAllListeners();
    }

    /**
     * Apply config changes.
     * Live-updatable params are applied immediately.
     * Other params set pendingRestart flag.
     */
    async applyConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        const liveParams = this.plugin.getLiveUpdatableParams();
        const liveChanges: Record<string, unknown> = {};
        let hasNonLive = false;

        for (const [key, value] of Object.entries(changes)) {
            if (liveParams.includes(key)) {
                liveChanges[key] = value;
            } else {
                hasNonLive = true;
            }
        }

        // Apply live changes immediately
        if (Object.keys(liveChanges).length > 0) {
            await this.plugin.onLiveConfigUpdate(liveChanges);
        }

        // Store all changes in config
        Object.assign(this.config, changes);

        // Flag pending restart if non-live params changed
        if (hasNonLive) {
            this._pendingRestart = true;
        }

        this.emitStateChange();
    }

    /** Get PipeWire node names for audio routing (single-port modules). */
    getPipeWireNodes(): { source?: string; sink?: string } | undefined {
        return this.plugin.getPipeWireNodes?.();
    }

    /** Get PipeWire node names for a specific port (multi-port modules). */
    getPipeWireNodeForPort(portId: string): { source?: string; sink?: string } | undefined {
        return this.plugin.getPipeWireNodeForPort?.(portId);
    }

    /** Get dynamic ports from the plugin (overrides config/manifest ports). */
    getDynamicPorts(): Array<{ id: string; direction: 'input' | 'output'; streamType: string; label: string; maxConnections?: number }> | undefined {
        return this.plugin.getDynamicPorts?.();
    }

    /** Get the GStreamer child process for MPEG-TS piping. */
    getChildProcess(): GstChildProcess | null {
        return this.plugin.getChildProcess?.() ?? null;
    }

    /** Count of running child processes owned by this module. */
    getProcessCount(): number {
        return this.plugin.getProcessCount?.() ?? 0;
    }

    /** Get the underlying plugin. */
    getPlugin(): PluginModule {
        return this.plugin;
    }

    private emitStateChange(): void {
        this.emit('stateChange', this.instanceId, this.getState());
    }
}
