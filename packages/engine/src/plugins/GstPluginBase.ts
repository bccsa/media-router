import { EventEmitter } from 'events';
import type { ModuleRuntimeState, ModuleHealth } from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';
import { GstChildProcess } from '../child-process/GstChildProcess.js';
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

    getState(): ModuleRuntimeState {
        return {
            running: this.running,
            ready: this.ready,
            health: this.health,
            pendingRestart: false,
            liveUpdatableParams: this.liveUpdatableParams,
            vuData: this.vuData,
            error: this.error,
            statusData: this.statusData,
            dynamicStatusSections: this.dynamicStatusSections,
            badges: Array.from(this.badges.values()),
        };
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

    // --- Live element control (delegates to GstChildProcess → Python runner) ---

    /** Set a property on a named GStreamer element (live, no restart). */
    protected async setElementProperty(
        element: string,
        property: string,
        value: unknown,
    ): Promise<void> {
        if (this.childProcess?.isRunning) {
            await this.childProcess.setProperty(element, property, value);
        }
    }

    /** Get a property from a named GStreamer element. */
    protected async getElementProperty(element: string, property: string): Promise<unknown> {
        if (this.childProcess?.isRunning) {
            return this.childProcess.getProperty(element, property);
        }
        return undefined;
    }

    /** Start tracking throughput on a named element's pad. */
    protected async trackThroughput(element: string, pad = 'src'): Promise<void> {
        if (this.childProcess?.isRunning) {
            await this.childProcess.trackThroughput(element, pad);
        }
    }

    /** Get throughput stats for all tracked elements. */
    protected async getThroughput(): Promise<
        Record<string, { total_bytes: number; bitrate_kbps: number; bitrate_mbps: number }>
    > {
        if (this.childProcess?.isRunning) {
            return this.childProcess.getThroughput();
        }
        return {};
    }

    /** Read the 'stats' property from a named element (e.g. srtsrc). */
    protected async getElementStats(element: string): Promise<Record<string, unknown>> {
        if (this.childProcess?.isRunning) {
            return this.childProcess.getStats(element);
        }
        return {};
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
    // Plugins bound to a hardware audio device start the watchdog in onStart.
    // Every 2s we check whether the bound device is still enumerated in PipeWire;
    // on disconnect/reconnect we delegate to subclass hooks so each plugin
    // can teardown/rebuild its own remap-source or remap-sink.

    private deviceWatchdog: ReturnType<typeof setInterval> | null = null;
    private deviceConnected = true;

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

    protected startDeviceWatchdog(): void {
        if (this.deviceWatchdog) return;
        this.deviceConnected = true;
        this.deviceWatchdog = setInterval(() => {
            this.checkDevice().catch(() => {
                /* swallowed — next tick retries */
            });
        }, 2000);
    }

    protected stopDeviceWatchdog(): void {
        if (this.deviceWatchdog) {
            clearInterval(this.deviceWatchdog);
            this.deviceWatchdog = null;
        }
    }

    private async checkDevice(): Promise<void> {
        const deviceName = this.getWatchedDeviceName();
        if (!deviceName || !this.services?.pipeWire) return;
        // Use `hasDevice` (enumeration only) not `getDeviceInfo` — the latter
        // returns null for SUSPENDED devices which would cause this watchdog
        // to tear down healthy idle hardware during engine startup.
        const present = this.services.pipeWire.hasDevice(deviceName);

        if (this.deviceConnected && !present) {
            this.deviceConnected = false;
            this.setHealth('error', 'Device disconnected');
            this.setVuData([]);
            try {
                await this.onDeviceDisconnected();
            } catch (err) {
                this.log.debug({ err }, 'onDeviceDisconnected hook failed');
            }
            return;
        }
        if (!this.deviceConnected && present) {
            this.deviceConnected = true;
            try {
                await this.onDeviceReconnected();
                this.setHealth('ok');
            } catch (err) {
                this.setHealth(
                    'error',
                    `Device reconnect failed: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
    }
}
