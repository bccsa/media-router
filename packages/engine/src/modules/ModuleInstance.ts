import { EventEmitter } from 'events';
import type { ModuleRuntimeState } from '@media-router/shared-types';
import { createLogger, formatError } from '@media-router/shared-types';
import type { PluginModule, ModuleServices } from '../plugins/PluginModule.js';
import type { GstChildProcess } from '../child-process/GstChildProcess.js';
import type { BusAttachTarget } from '../child-process/UnixFdFanoutController.js';

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

    constructor(
        instanceId: string,
        pluginId: string,
        plugin: PluginModule,
        config: Record<string, unknown>,
        services?: ModuleServices,
    ) {
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

        // A plugin that ran to a natural end (VOD finished) asks the engine to
        // stop it cleanly — forwarded upward for ModuleLifecycle.disable().
        const onSelfStop = (reason: string) => {
            this.emit('selfStopRequested', this.instanceId, reason);
        };

        emitter.on('vuData', onVuData);
        emitter.on('stateChange', onStateChange);
        emitter.on('configUpdated', onConfigUpdated);
        emitter.on('selfStop', onSelfStop);

        this.pluginListeners.push(
            { event: 'vuData', handler: onVuData },
            { event: 'stateChange', handler: onStateChange },
            { event: 'configUpdated', handler: onConfigUpdated },
            { event: 'selfStop', handler: onSelfStop },
        );
    }

    /** Remove all listeners we attached to the plugin. */
    private detachPluginListeners(): void {
        if (
            !('removeListener' in this.plugin) ||
            typeof (this.plugin as any).removeListener !== 'function'
        )
            return;

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
            log.error(
                { err: formatError(err), instanceId: this.instanceId },
                'Module start failed',
            );
            // Attempt cleanup so the module doesn't get stuck in a half-initialised state
            try {
                await this.plugin.onStop();
            } catch (e) {
                log.debug(
                    { err: formatError(e), instanceId: this.instanceId },
                    'onStop cleanup after failed start',
                );
            }
            // A failed onStart may already have spawned processes or claimed
            // resources (hls-player spawns its unixfd fan-out sidecar as its
            // first act). `_running` stays false here, so nothing else will
            // ever release them — every later stop skips this instance.
            await this.releaseResources();
            // Re-init on the next start attempt: plugins cache settings in
            // onInit (e.g. audio-output's device name), and a start that
            // failed on bad config would otherwise retry against the stale
            // cache forever even after the config is fixed.
            this._initialized = false;
            throw err;
        }
        this.emitStateChange();
    }

    /**
     * Stop the module.
     *
     * `onStop` only runs for a module that actually started, but resource
     * release runs unconditionally: a module can own live processes while
     * `_running` is false (a start that threw part-way, or a plugin that
     * spawned before its own guard flipped), and skipping the release there
     * left those processes orphaned past every subsequent stop.
     */
    async stop(): Promise<void> {
        const wasRunning = this._running;
        if (wasRunning) {
            try {
                await this.plugin.onStop();
            } catch (err) {
                log.error({ err, instanceId: this.instanceId }, 'Module stop failed');
            }
            this._running = false;
        }
        await this.releaseResources();
        if (wasRunning) this.emitStateChange();
    }

    /**
     * Release everything the engine owns on the module's behalf — PipeWire
     * nodes, spawned processes, UDP port slots. Idempotent and safe to call for
     * a module that never started; each step is guarded so one failure can't
     * skip the rest.
     */
    private async releaseResources(): Promise<void> {
        if (this.services?.pipeWire) {
            try {
                await this.services.pipeWire.releaseAll(this.instanceId);
            } catch (e) {
                log.debug(
                    { err: formatError(e), instanceId: this.instanceId },
                    'PipeWire cleanup failed',
                );
            }
        }
        if (this.services?.processManager) {
            try {
                await this.services.processManager.releaseAll(this.instanceId);
            } catch (e) {
                log.debug(
                    { err: formatError(e), instanceId: this.instanceId },
                    'Process cleanup failed',
                );
            }
        }
        // Release every UDP encoder port owned by this module — primary slot plus
        // any per-output sub-slots (multi-output plugins like mpegts-demuxer).
        if (this.services?.mediaRouter) {
            this.services.mediaRouter.releaseAllBusChannelsFor(this.instanceId);
        }
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
            // A param can opt out of live application per-change via
            // `isLiveChange` (e.g. renaming a muxer stream is live, adding
            // one is not) — see the hook's doc in PluginModule.
            const live =
                liveParams.includes(key) &&
                (this.plugin.isLiveChange?.(key, value, this.config[key]) ?? true);
            if (live) {
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
    getDynamicPorts():
        | Array<{
              id: string;
              direction: 'input' | 'output';
              streamType: string;
              label: string;
              maxConnections?: number;
          }>
        | undefined {
        // Pass the instance's authoritative config: the engine resolves ports
        // before start, when the plugin's own `this.config` is still empty
        // (applied in onInit). Without this, a not-yet-running module resolves
        // its port set from empty config and shows the wrong count.
        return this.plugin.getDynamicPorts?.(this.config);
    }

    /** Get the GStreamer child process for MPEG-TS piping. */
    getChildProcess(): GstChildProcess | null {
        return this.plugin.getChildProcess?.() ?? null;
    }

    /** Where the BusFanoutCoordinator sends this producer's unixfd
     *  bus_attach/bus_detach (gst runner, or a non-gst producer's own
     *  fan-out controller). */
    getBusAttachTarget(): BusAttachTarget | null {
        return this.plugin.getBusAttachTarget?.() ?? this.getChildProcess();
    }

    /** Count of running child processes owned by this module. */
    getProcessCount(): number {
        return this.plugin.getProcessCount?.() ?? 0;
    }

    /** Live-input-swap capability for a sink port (see PluginModule). */
    getLiveInputSwap(sinkPortId: string): { element: string } | null {
        return this.plugin.getLiveInputSwap?.(sinkPortId) ?? null;
    }

    /** Refresh the stored pipeline description after a live input swap. */
    async refreshPipelineDescription(): Promise<boolean> {
        return (await this.plugin.refreshPipelineDescription?.()) ?? false;
    }

    /** Set module health (routing-layer conditions, e.g. pending input swap). */
    setHealth(health: 'ok' | 'warning' | 'error' | 'stopped', error?: string): void {
        this.plugin.setHealth?.(health, error);
    }

    /** Get the underlying plugin. */
    getPlugin(): PluginModule {
        return this.plugin;
    }

    private emitStateChange(): void {
        this.emit('stateChange', this.instanceId, this.getState());
    }
}
