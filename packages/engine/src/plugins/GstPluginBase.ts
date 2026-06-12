import { EventEmitter } from 'events';
import type { ModuleRuntimeState, ModuleHealth } from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';
import { GstChildProcess } from '../child-process/GstChildProcess.js';
import type { ManagedProcess, ManagedProcessOptions } from '../child-process/ManagedProcess.js';
import { DeviceWatchdog } from './DeviceWatchdog.js';
import type { PluginModule, PipelineDescription, ModuleServices } from './PluginModule.js';

const defaultLog = createLogger('GstPluginBase');

/**
 * Abstract base class for GStreamer-based plugins.
 *
 * Subclasses implement `buildPipeline()` to define their GStreamer pipeline.
 * Manages child process lifecycle, VU metering, status data, and badges.
 */
export abstract class GstPluginBase extends EventEmitter implements PluginModule {
    protected config: Record<string, unknown> = {};
    protected services: ModuleServices | null = null;
    protected running = false;
    protected ready = false;
    protected health: ModuleHealth = 'stopped';
    protected error: string | undefined;
    protected vuData: number[] | undefined;
    protected liveUpdatableParams: string[] = [];
    protected childProcess: GstChildProcess | null = null;
    /** Separate VU metering child process (for data-mode pipelines). */
    private vuProcess: GstChildProcess | null = null;
    /** PulseAudio module ID for the null-sink created on start. */
    protected paModuleId: number | null = null;
    /** Per-instance logger — initialized in onInit with the instance ID. */
    protected log: ReturnType<typeof createLogger> = defaultLog;

    /** Subclasses define their GStreamer pipeline here. Return null to skip pipeline (idle module). */
    abstract buildPipeline(config: Record<string, unknown>): PipelineDescription | null;

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        this.config = config;
        this.services = services ?? null;
        if (services?.instanceId) {
            this.log = createLogger(`Plugin:${services.instanceId}`);
        }
    }

    /** Return the GStreamer child process (for MPEG-TS piping). */
    getChildProcess(): GstChildProcess | null {
        return this.childProcess;
    }

    /** Count of running child processes owned by this module. */
    getProcessCount(): number {
        return (this.childProcess?.isRunning ? 1 : 0) + (this.vuProcess?.isRunning ? 1 : 0);
    }

    /** PipeWire node name for this module instance. */
    protected get pwNodeName(): string {
        if (!this.services?.instanceId) {
            throw new Error('Cannot resolve PipeWire node name — services not initialised');
        }
        return `MR_PW_${this.services.instanceId}`;
    }

    async onStart(): Promise<void> {
        // Wait for PipeWire to register the null-sink created by subclass
        if (this.paModuleId !== null && this.services?.pipeWire) {
            const ready = await this.services.pipeWire.waitForSink(this.pwNodeName);
            if (!ready) {
                this.log.warn(
                    { pwNodeName: this.pwNodeName },
                    'Null-sink not confirmed — proceeding anyway',
                );
            }
        }

        const desc = this.buildPipeline(this.config);

        if (!desc) {
            // No pipeline needed (e.g. decoder with no connection) — module is idle
            return;
        }

        // Spawn child process
        this.childProcess = new GstChildProcess();

        this.childProcess.on('stateChange', (data: { state: string }) => {
            if (data.state === 'playing') {
                this.running = true;
                this.ready = true;
                this.health = 'ok';
                this.error = undefined;
            } else if (data.state === 'error') {
                this.health = 'error';
            } else if (data.state === 'stopped') {
                this.running = false;
                this.ready = false;
                this.health = 'stopped';
            }
            this.emit('stateChange', this.getState());
        });

        this.childProcess.on('vuData', (data: { peak: number[] }) => {
            this.setVuData(data.peak);
        });

        this.childProcess.on('error', (data: { message: string }) => {
            this.setHealth('error', data.message);
        });

        await this.childProcess.start(desc);
        this.running = true;
        this.health = 'ok';
        this.emit('stateChange', this.getState());

        // For data-mode pipelines with a null-sink, start a separate VU metering process
        if (desc.useStdioForData && this.paModuleId !== null) {
            this.startVuProcess();
        }
    }

    /**
     * Start a lightweight VU-only GStreamer pipeline.
     * Reads from the module's null-sink monitor and outputs level bus messages.
     */
    private async startVuProcess(): Promise<void> {
        try {
            this.vuProcess = new GstChildProcess();
            this.vuProcess.on('vuData', (data: { peak: number[] }) => {
                this.setVuData(data.peak);
            });
            this.vuProcess.on('error', (err: unknown) => {
                this.log.debug({ err }, 'VU process error (auxiliary — non-fatal)');
            });

            const vuPipeline = `pulsesrc device=${this.pwNodeName}.monitor buffer-time=20000 latency-time=10000 ! audioconvert ! level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=66000000 ! fakesink sync=false`;
            await this.vuProcess.start({ pipeline: vuPipeline });
        } catch (err) {
            this.log.warn({ err }, 'VU process failed to start');
            this.vuProcess = null;
        }
    }

    async onStop(): Promise<void> {
        if (this.vuProcess) {
            await this.vuProcess.destroy();
            this.vuProcess = null;
        }
        if (this.childProcess) {
            await this.childProcess.stop();
            this.childProcess = null;
        }
        this.running = false;
        this.ready = false;
        this.health = 'stopped';
        this.badges.clear();
        this.statusData = {};
        this.dynamicStatusSections = [];
        this.emit('stateChange', this.getState());
    }

    async onDestroy(): Promise<void> {
        // Ensure subclass cleanup (PipeWire null-sinks, VU loopbacks, etc.) runs
        // Each step is guarded so a failure doesn't prevent subsequent cleanup
        if (this.running) {
            try {
                await this.onStop();
            } catch (err) {
                this.log.error({ err }, 'onStop failed during destroy');
            }
        }
        if (this.vuProcess) {
            try {
                await this.vuProcess.destroy();
            } catch (err) {
                this.log.debug({ err }, 'VU process cleanup failed');
            }
            this.vuProcess = null;
        }
        if (this.childProcess) {
            try {
                await this.childProcess.destroy();
            } catch (err) {
                this.log.debug({ err }, 'Child process cleanup failed');
            }
            this.childProcess = null;
        }
        this.removeAllListeners();
    }

    /** Status data for stats popup — plugins override to provide live data. */
    protected statusData: Record<string, Record<string, string | number | boolean>> = {};
    /** Dynamic status sections — plugins can add/remove sections at runtime (e.g. per-caller stats). */
    protected dynamicStatusSections: Array<{
        id: string;
        label: string;
        fields: Array<{ key: string; label: string; unit?: string }>;
    }> = [];
    /** Badges shown on the module face — small icon+text indicators. */
    private badges = new Map<string, { id: string; icon?: string; text: string; color?: string }>();
    /** Probe-discovered option lists for config fields, keyed by `x-optionsFrom`. */
    protected fieldOptions: Record<string, Array<{ value: string; label: string }>> = {};

    getState(): ModuleRuntimeState {
        return {
            running: this.running,
            ready: this.ready,
            health: this.health,
            pendingRestart: false,
            // Call the method rather than reading the static field so plugin
            // overrides (e.g. VideoEncoder deciding per-codec whether bitrate
            // is live) reach the UI.
            liveUpdatableParams: this.getLiveUpdatableParams(),
            vuData: this.vuData,
            error: this.error,
            statusData: this.statusData,
            dynamicStatusSections: this.dynamicStatusSections,
            badges: Array.from(this.badges.values()),
            ...(Object.keys(this.fieldOptions).length ? { fieldOptions: this.fieldOptions } : {}),
        };
    }

    /**
     * Publish discovered option lists for a config field (keyed by the field's
     * `x-optionsFrom`). Pushes state so the settings panel can populate the
     * matching selector — e.g. audio / subtitle languages detected from an HLS
     * playlist.
     */
    protected setFieldOptions(key: string, options: Array<{ value: string; label: string }>): void {
        this.fieldOptions[key] = options;
        this.emit('stateChange', this.getState());
    }

    /** Update status data for a section and emit state change. Values are coerced to primitives. */
    protected setStatusData(sectionId: string, data: Record<string, unknown>): void {
        const clean: Record<string, string | number | boolean> = {};
        for (const [k, v] of Object.entries(data)) {
            if (v === null || v === undefined) clean[k] = '—';
            else if (typeof v === 'object') clean[k] = JSON.stringify(v);
            else clean[k] = v as string | number | boolean;
        }
        this.statusData[sectionId] = clean;
        this.emit('stateChange', this.getState());
    }

    /** Set a badge on the module face. Badges are small icon+text indicators. */
    protected setBadge(id: string, badge: { icon?: string; text: string; color?: string }): void {
        this.badges.set(id, { id, ...badge });
        this.emit('stateChange', this.getState());
    }

    /** Remove a badge from the module face. */
    protected clearBadge(id: string): void {
        if (this.badges.delete(id)) {
            this.emit('stateChange', this.getState());
        }
    }

    getLiveUpdatableParams(): string[] {
        return this.liveUpdatableParams;
    }

    /**
     * Spawn an external runner via ProcessManager with standardized health
     * wiring — the shared contract for process-backed producer plugins
     * (hls-player, rist-input, rist-output):
     *   - spawn failure / restart attempts exhausted → health `error`
     *   - crash-backoff restart pending / unexpected clean exit → `warning`
     *   - `clearBadges` are removed whenever the process goes down, so stale
     *     stats badges don't show green on a dead stream.
     * The plugin restores `ok` itself once the runner proves live (next
     * parsed stats line, or the process `started` event where spawn ≈ live).
     */
    protected spawnRunnerProcess(
        opts: ManagedProcessOptions & { clearBadges?: string[] },
    ): ManagedProcess {
        if (!this.services?.processManager) {
            throw new Error('processManager service unavailable');
        }
        const { clearBadges = [], ...spawnOpts } = opts;
        const proc = this.services.processManager.spawn(this.services.instanceId, spawnOpts);
        const down = (): void => clearBadges.forEach((id) => this.clearBadge(id));
        proc.on('error', (msg: string) => {
            down();
            this.setHealth('error', msg);
        });
        proc.on('restarting', (attempt: number) => {
            if (!this.running) return;
            down();
            this.setHealth('warning', `${opts.label} crashed — restarting (attempt ${attempt})`);
        });
        proc.on('stopped', (code: number | null) => {
            // Killed deliberately (module stop / relaunch) — not a health event.
            if (proc.destroyed || !this.running) return;
            down();
            // Non-zero exits are followed by 'restarting' (or 'error' once
            // attempts are exhausted); a clean exit means the runner ended on
            // its own (e.g. a VOD stream ran out) — surface it.
            if (code === 0) this.setHealth('warning', `${opts.label} exited`);
        });
        return proc;
    }

    /**
     * Notify the engine that config values were auto-detected/changed by the plugin.
     * This pushes the changes back to the manager so they're persisted in SQLite
     * and reflected in the UI.
     */
    protected emitConfigUpdate(changes: Record<string, unknown>): void {
        Object.assign(this.config, changes);
        this.emit('configUpdated', changes);
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        Object.assign(this.config, changes);
    }

    // --- Live element control (delegates to GstChildProcess → Python runner)
    //
    // These wrappers swallow RPC failures (command_error from Python, IPC
    // timeouts) and log at debug. Plugin authors get a forgiving
    // fire-and-forget contract — a stale element name or a wedged Python
    // child can't take a plugin down. The engine-level GstChildProcess
    // surface still throws so engine internals can react if they need to.

    /** Set a property on a named GStreamer element (live, no restart). */
    protected async setElementProperty(
        element: string,
        property: string,
        value: unknown,
    ): Promise<void> {
        if (!this.childProcess?.isRunning) return;
        try {
            await this.childProcess.setProperty(element, property, value);
        } catch (err) {
            this.log.debug({ err, element, property }, 'setElementProperty failed');
        }
    }

    /** Get a property from a named GStreamer element. */
    protected async getElementProperty(element: string, property: string): Promise<unknown> {
        if (!this.childProcess?.isRunning) return undefined;
        try {
            return await this.childProcess.getProperty(element, property);
        } catch (err) {
            this.log.debug({ err, element, property }, 'getElementProperty failed');
            return undefined;
        }
    }

    /** Start tracking throughput on a named element's pad. */
    protected async trackThroughput(element: string, pad = 'src'): Promise<void> {
        if (!this.childProcess?.isRunning) return;
        try {
            await this.childProcess.trackThroughput(element, pad);
        } catch (err) {
            this.log.debug({ err, element, pad }, 'trackThroughput failed');
        }
    }

    /** Get throughput stats for all tracked elements. */
    protected async getThroughput(): Promise<
        Record<string, { total_bytes: number; bitrate_kbps: number; bitrate_mbps: number }>
    > {
        if (!this.childProcess?.isRunning) return {};
        try {
            return await this.childProcess.getThroughput();
        } catch (err) {
            this.log.debug({ err }, 'getThroughput failed');
            return {};
        }
    }

    /** Read the 'stats' property from a named element (e.g. srtsrc). */
    protected async getElementStats(element: string): Promise<Record<string, unknown>> {
        if (!this.childProcess?.isRunning) return {};
        try {
            return await this.childProcess.getStats(element);
        } catch (err) {
            this.log.debug({ err, element }, 'getElementStats failed');
            return {};
        }
    }

    /** Update VU data (called by child process in Phase 3). */
    protected setVuData(data: number[]): void {
        this.vuData = data;
        this.emit('vuData', data);
    }

    /** Set health status with optional error message. */
    protected setHealth(health: ModuleHealth, error?: string): void {
        this.health = health;
        this.error = error;
        this.emit('stateChange', this.getState());
    }

    // --- Device presence watchdog (hardware hot-plug) ---
    //
    // The polling, transition, and concurrency logic lives in `DeviceWatchdog`
    // (so non-Gst plugins can use it too); this base class just wires its
    // callbacks to the subclass hooks (`getWatchedDeviceName`,
    // `onDeviceDisconnected`, `onDeviceReconnected`) and the base's own
    // `setHealth` / `setVuData`.

    private deviceWatchdog: DeviceWatchdog | null = null;

    /**
     * Subclasses bound to a hardware device return its PipeWire name (e.g.
     * `alsa_input.usb-...`). Return null to disable the watchdog.
     */
    protected getWatchedDeviceName(): string | null {
        return null;
    }

    /**
     * Called when the watched device disappears. Default: mark health=error,
     * zero VU, and delegate teardown to the subclass hook.
     */
    protected async onDeviceDisconnected(): Promise<void> {
        /* subclass teardown */
    }

    /**
     * Called when the watched device reappears. Subclass rebuilds its
     * PipeWire node (remap-sink/source) and reapplies volume + mute.
     */
    protected async onDeviceReconnected(): Promise<void> {
        /* subclass rebuild */
    }

    /**
     * Start the watchdog. Pass `initiallyConnected=false` when the device
     * was missing at start time — the next tick where the device is
     * present then triggers `onDeviceReconnected` to drive setup.
     */
    protected startDeviceWatchdog(initiallyConnected = true): void {
        if (this.deviceWatchdog) return;
        if (!this.services?.pipeWire) return;
        this.deviceWatchdog = new DeviceWatchdog({
            getDeviceName: () => this.getWatchedDeviceName(),
            pipeWire: this.services.pipeWire,
            log: this.log,
            onDisconnect: () => this.onDeviceDisconnected(),
            onReconnect: () => this.onDeviceReconnected(),
            onHealthChange: (h, m) => this.setHealth(h, m),
            onClear: () => this.setVuData([]),
        });
        this.deviceWatchdog.start(initiallyConnected);
    }

    /** Stop the watchdog and wait for an in-flight tick to settle. */
    protected async stopDeviceWatchdog(): Promise<void> {
        if (this.deviceWatchdog) {
            await this.deviceWatchdog.stop();
            this.deviceWatchdog = null;
        }
    }
}
