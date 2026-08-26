import { EventEmitter } from 'events';
import type {
    ModuleRuntimeState,
    ModuleHealth,
    StatusGraph,
    StatusValue,
} from '@media-router/shared-types';
import { createLogger } from '@media-router/shared-types';
import { GstChildProcess } from '../child-process/GstChildProcess.js';
import type { BusAttachTarget } from '../child-process/UnixFdFanoutController.js';
import type { ManagedProcess, ManagedProcessOptions } from '../child-process/ManagedProcess.js';
import { DeviceWatchdog } from './DeviceWatchdog.js';
import { BACKLOG_SHED_EVENT } from './backlogShed.js';
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

    /**
     * Where the BusFanoutCoordinator sends this producer's unixfd
     * `bus_attach`/`bus_detach`. The gst runner handles them natively; a
     * non-GStreamer producer overrides this with its own fan-out controller
     * (hls-player → UnixFdFanoutController + unixfd-fanout.py sidecar).
     */
    getBusAttachTarget(): BusAttachTarget | null {
        return this.childProcess;
    }

    /** Count of running child processes owned by this module. */
    getProcessCount(): number {
        return (this.childProcess?.isRunning ? 1 : 0) + (this.vuProcess?.isRunning ? 1 : 0);
    }

    /**
     * Re-derive the pipeline description from current config/connections and
     * store it as the restart-replay copy — WITHOUT touching the live
     * pipeline. Called after a live mutation the pipeline already absorbed
     * (`bus_reinput` input swap): the swap changed which edge socket the
     * running `unixfdsrc` reads, so a later crash-restart must rebuild/gate on
     * the NEW socket, not replay the original description forever against a
     * socket that no longer exists. Returns false when there is nothing to
     * refresh (no child, or buildPipeline now returns null).
     */
    async refreshPipelineDescription(): Promise<boolean> {
        if (!this.childProcess) return false;
        const desc = this.buildPipeline(this.config);
        if (!desc) return false;
        await this.applyTimeSync(desc);
        await this.childProcess.updatePipelineDesc(desc);
        return true;
    }

    /**
     * Resolve how a pipeline gets its timeline, in precedence order.
     *
     * 1. Engine-wide time-sync contract (`services.timeSyncContract`): mark the
     *    description and stop. The runner then puts the pipeline on a plain
     *    monotonic system clock with a pinned timeline — nothing to resolve, no
     *    clock authority to spawn or reach, so this can never delay a start.
     *
     *    This applies to EVERY pipeline, not just `clockSync` ones. The contract
     *    is producer-stamped (ADR-0005 decisions 2+3): a producer's bus buffer
     *    PTS only means house-clock media time if that producer's running-time
     *    IS house-clock time, i.e. `base_time=0`. Gating on `clockSync` pinned
     *    the consumers (audio-decoder, video-player) and left every producer on
     *    a per-start base-time, so the wire carried `stamp + base_time` and the
     *    contract was silently a no-op end to end. `clockSync` stays a
     *    per-module opt-in for the LEGACY net clock below, which really is
     *    opt-in (it costs a daemon and a sync wait).
     *    It also DROPS `preserveSourceTimeline` — see below.
     * 2. Legacy (contract off): cross-pipeline A/V sync via the shared net
     *    clock. Resolve it from the engine's clock authority and stamp it onto
     *    the description. Best-effort — if the authority can't be brought up the
     *    pipeline runs unsynced (today's behaviour) rather than failing to start.
     *
     * The two `delete`s below are what makes the arm you are NOT in
     * byte-identical to what it was: contract on drops the legacy latch, contract
     * off drops the contract-only branch alignment.
     */
    private async applyTimeSync(desc: PipelineDescription): Promise<void> {
        if (this.services?.timeSyncContract) {
            desc.timeSyncContract = true;
            // `preserveSourceTimeline` is the mechanism the contract REPLACED
            // (ADR-0005 decision 2 rejects consumer-side pad offsets), and the
            // two do not compose:
            //
            //  * It cannot change what a SINGLE-BRANCH consumer's own consumers
            //    see. Every module that asks for it (transcoder,
            //    audio-transcoder) emits through `buildBusSink`, i.e. a
            //    `busout_*` tee, and the egress stamper rewrites those buffers'
            //    PTS/DTS to `anchor + (PES − firstPES)`. One branch means one
            //    pad offset, which shifts every PES value in that egress by the
            //    same amount, so it cancels in that delta: the wire ladder is
            //    identical with the latch on or off.
            //
            //    That cancellation is a property of the SINGLE branch, not of
            //    pad offsets, and it does not extend to a multi-input mux: there
            //    each input branch has its own zero point, so a per-branch offset
            //    changes the PES values of one stream RELATIVE to another and
            //    cannot cancel. Cross-branch alignment is therefore a real,
            //    separate job — `alignBranchesToStamps` below, which anchors
            //    every branch to the producers' stamps (the 100–121 ms A/V skew
            //    measured across the .202 X-Chain mux, 2026-08-14).
            //  * It answers a source discontinuity by ERRORING OUT so the
            //    pipeline restarts and re-latches (its offsets are baked into
            //    pad offsets and go stale). The contract answers the same event
            //    with an in-place re-anchor — one PTS step, no restart. Leaving
            //    both armed means the destructive one wins: the pipeline is
            //    already tearing down before the re-anchor can matter, and a
            //    transcoder restart rebuilds its encoders and interrupts every
            //    consumer over an event the contract handles for free.
            //
            // What is lost with it off is the ABSOLUTE PES/PCR values in the
            // transcoded TS (they rebase per incarnation again). No consumer
            // under the contract reads those as a timeline — tsdemux takes its
            // basis from the stamped DTS/PTS (ADR-0005's named regression) and
            // its frame spacing from PES deltas, both preserved. Modules keep
            // declaring it: with the contract off (MR_TIME_SYNC_CONTRACT=0) the
            // legacy behaviour is exactly what it was.
            delete desc.preserveSourceTimeline;
            this.log.info(
                { clockSync: desc.clockSync === true },
                'Time-sync contract: monotonic house clock, base_time=0, producer-stamped bus PTS',
            );
            return;
        }
        // Contract off: the bus buffers carry arrival times, not a house
        // mapping, so there is nothing for a branch to be anchored TO — the
        // measurement the runner would take is noise. Drop it here (rather than
        // gating in each plugin) so the legacy dataflow is byte-identical.
        delete desc.alignBranchesToStamps;
        if (!desc.clockSync) return;
        if (this.services?.clockAuthority) {
            const clock = await this.services.clockAuthority.getClockConfig();
            if (clock) desc.clock = clock;
        }
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

        // Time sync (opt-in): either mark the description for the engine-wide
        // contract or resolve the legacy shared net clock — see applyTimeSync.
        await this.applyTimeSync(desc);

        // Spawn child process
        this.childProcess = new GstChildProcess();

        this.childProcess.on('stateChange', (data: { state: string }) => {
            if (data.state === 'playing') {
                this.running = true;
                this.ready = true;
                this.health = 'ok';
                this.error = undefined;
                // Re-attach this producer's per-consumer bus fan-out branches:
                // a runner-internal respawn rebuilds the pipeline from the base
                // string with the egress tee but NO branches, so without this a
                // producer restart would strand every consumer. Idempotent and a
                // no-op under UDP / for non-producers. Done directly (not via the
                // overridable onPipelinePlaying) so a subclass override can't drop it.
                if (this.services?.instanceId) {
                    this.services.mediaRouter?.onProducerPlaying(this.services.instanceId);
                }
                // Fires on EVERY playing transition, including a runner-internal
                // crash-restart (which rebuilds the pipeline from the original
                // string, dropping any live element state). Subclasses re-seed
                // control state here so a restart doesn't strand them.
                this.onPipelinePlaying();
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

        // Generic pipeline→plugin data channel. Delivered to the subclass hook
        // so it can react to any channel it subscribed to (e.g. the
        // audio-dynamics ducker's gain envelope off `level:sclevel`).
        this.childProcess.on('pluginEvent', (data: { channel: string; payload: unknown }) => {
            this.dispatchPluginEvent(data.channel, data.payload);
        });

        this.childProcess.on('error', (data: { message: string }) => {
            this.setHealth('error', data.message);
        });

        // unixfd socket-gate progress: the runner waits indefinitely for
        // producer edge sockets before launching. Surface the wait as a
        // health warning naming the pending sockets — otherwise a gated
        // module reports 'ok' forever while nothing runs (e.g. a consumer
        // whose producer is disabled). Cleared when the gate opens
        // (pending: []) and superseded by the 'playing' health flip.
        this.childProcess.on('busGate', (data: { pending: string[] }) => {
            if (data.pending.length > 0) {
                this.setStatusData('bus', {
                    'Waiting for producer': data.pending.join(', '),
                });
                this.setHealth('warning', `Waiting for producer bus socket(s): ${data.pending.join(', ')}`);
            } else {
                this.setStatusData('bus', {});
                if (this.health === 'warning') this.setHealth('ok');
            }
        });

        await this.childProcess.start(desc);
        this.running = true;
        this.health = 'ok';
        // A successful start supersedes whatever error text the previous
        // incarnation left behind — without this the stale text rides along
        // with health='ok' forever ("healthy but shows an old error").
        this.error = undefined;
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
    protected statusData: Record<string, Record<string, StatusValue>> = {};
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
            // null (not undefined): a cleared error must survive JSON — the
            // key vanishes for undefined and per-field mergers (manager-ui
            // socket store) keep the stale text forever.
            error: this.error ?? null,
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
        const clean: Record<string, StatusValue> = {};
        for (const [k, v] of Object.entries(data)) {
            if (v === null || v === undefined) clean[k] = '—';
            else if (typeof v === 'object') clean[k] = JSON.stringify(v);
            else clean[k] = v as string | number | boolean;
        }
        this.statusData[sectionId] = clean;
        this.emit('stateChange', this.getState());
    }

    /**
     * Publish structured GRAPH data on the status channel — the settings
     * panel's `graph` widget renders whatever a schema prop's `x-graph`
     * points at (`{ section, key }`).
     *
     * Same transport and same store as `setStatusData`; the difference is that
     * the value keeps its shape instead of being flattened to a primitive. The
     * plugin owns every domain decision (what the curve is, its units, how it
     * was computed) and the UI only plots. Pass null to clear one graph.
     *
     * Merges into the section instead of replacing it, so several graphs can
     * share one section id — but `setStatusData` still REPLACES a section
     * wholesale, so give graphs a section of their own (e.g. `graphs`).
     */
    protected setStatusGraph(sectionId: string, key: string, graph: StatusGraph | null): void {
        const section = { ...(this.statusData[sectionId] ?? {}) };
        if (graph) section[key] = graph;
        else delete section[key];
        this.statusData[sectionId] = section;
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

    /**
     * Generic pipeline→plugin data channel. Called for every `pluginEvent` the
     * runner emits — `channel` names the data stream, `payload` is its JSON
     * body. Default no-op; subclasses match the channels they subscribed to
     * (e.g. `level:<name>` from `PipelineDescription.busReports`, keyed by the
     * audio-dynamics ducker's gain envelope). New data types need no
     * middle-layer plumbing — just an emitter in the runner and a case here.
     */
    protected onPluginEvent(_channel: string, _payload: unknown): void {
        /* subclass hook */
    }

    /**
     * Every runner plugin event lands here first.
     *
     * `backlog_shed` is logged HERE, not per plugin: the backlog shedder is a
     * contract-layer guard armed on every clock-paced leg (video-player,
     * audio-decoder, any future presentation leg — see backlogShed.ts), so its
     * one line per episode has to exist for all of them without each one
     * remembering to write it. The subclass hook still gets the event and may
     * do more with it.
     */
    protected dispatchPluginEvent(channel: string, payload: unknown): void {
        if (channel === BACKLOG_SHED_EVENT) this.logBacklogShed(payload);
        this.onPluginEvent(channel, payload);
    }

    /**
     * One journal line per backlog-shed episode (see `backlogShed.ts`).
     *
     * Deliberately at WARN for a real shed: frames (or samples) were dropped on
     * purpose, and the retained/budget pair beside it is the evidence for WHY —
     * without it a shed is indistinguishable in the journal from the glitch it
     * repaired. `implausible` and `awaiting_keyframe` are the two outcomes that
     * shed nothing yet: the first says the reading was not a backlog at all,
     * the second that the leg is caught up and waiting for an IRAP it must not
     * skip.
     */
    private logBacklogShed(payload: unknown): void {
        const p = (payload ?? {}) as { outcome?: string };
        if (p.outcome === 'implausible') {
            this.log.warn(
                { backlogShed: payload },
                'Backlog shed: lateness past the sanity ceiling — treated as a timeline mismatch, nothing shed',
            );
            return;
        }
        if (p.outcome === 'awaiting_keyframe') {
            this.log.warn(
                { backlogShed: payload },
                'Backlog shed: back inside the playout budget, holding for the next keyframe',
            );
            return;
        }
        this.log.warn({ backlogShed: payload }, 'Backlog shed — retained latency returned to the playout budget');
    }

    /**
     * Called on every transition to PLAYING, INCLUDING a runner-internal
     * crash-restart (which rebuilds the pipeline from the original string and so
     * loses any live element changes / control-loop memory). Default no-op;
     * subclasses re-seed state that must survive a restart — e.g. re-apply live
     * element properties, or reset a control envelope so it re-converges.
     */
    protected onPipelinePlaying(): void {
        /* subclass hook */
    }

    // --- Live element control (delegates to GstChildProcess → Python runner)
    //
    // These wrappers swallow RPC failures (command_error from Python, IPC
    // timeouts) and log at debug. Plugin authors get a forgiving
    // fire-and-forget contract — a stale element name or a wedged Python
    // child can't take a plugin down. The engine-level GstChildProcess
    // surface still throws so engine internals can react if they need to.

    /**
     * Push the KLV name carousel payload to the runner (mpegts muxer, Phase 2).
     * Fire-and-forget — the runner stores it and drives the ~1 s carousel on
     * the metadata appsrc, so a name edit updates downstream labels without a
     * pipeline rebuild. Report-only channel (plan D6): a no-op when the pipeline
     * isn't running, and a dropped update self-corrects on the next tick.
     */
    protected setKlvPayload(element: string, payload: string): void {
        this.childProcess?.sendKlvPayload(element, payload);
    }

    /**
     * Set a property on a named GStreamer element (live, no restart).
     *
     * Safe to call while the pipeline is down or mid-restart: the child
     * records the last value per property and replays it on every PLAYING
     * transition, so live changes survive crash-restarts (which rebuild the
     * pipeline from the original string with only start-time values).
     */
    protected async setElementProperty(
        element: string,
        property: string,
        value: unknown,
    ): Promise<void> {
        if (!this.childProcess) return;
        try {
            await this.childProcess.setProperty(element, property, value);
        } catch (err) {
            this.log.debug({ err, element, property }, 'setElementProperty failed');
        }
    }

    /**
     * Shared `volume`/`audioEnabled` live-update: merges the changes into
     * config and drives the pipeline's `volume name=vol` element (gst element
     * only — no pactl, to avoid double-attenuation). Call from
     * `onLiveConfigUpdate` in any module whose trunk carries the standard
     * `volume name=vol` fader; modules with extra live params call this first
     * and handle the rest after.
     */
    protected async applyVolumeLiveUpdate(changes: Record<string, unknown>): Promise<void> {
        Object.assign(this.config, changes);
        if ('volume' in changes || 'audioEnabled' in changes) {
            const audioOff = (this.config.audioEnabled as boolean) === false;
            const volumePct = audioOff ? 0 : ((this.config.volume as number) ?? 100);
            await this.setElementProperty('vol', 'volume', volumePct / 100).catch((err) => {
                this.log.debug({ err }, 'Volume update failed (pipeline may not be running)');
            });
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

    /**
     * Cumulative bytes pushed into the bus-egress tee. The tee has no byte
     * counter of its own, so count bytes on its sink pad via the runner's
     * throughput tracker. `track_throughput` is idempotent per element, so
     * re-arming on every read is safe — and it survives child-process
     * respawns, which drop the python-side trackers.
     */
    protected async readBusSinkBytes(element: string): Promise<number | undefined> {
        await this.trackThroughput(element, 'sink');
        const total = (await this.getThroughput())[element]?.total_bytes;
        return typeof total === 'number' ? total : undefined;
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

    /** Elements whose last stats read failed — logged once per outage, not per poll. */
    private statsFailureLogged = new Set<string>();

    /** Read the 'stats' property from a named element (e.g. srtsrc). */
    protected async getElementStats(element: string): Promise<Record<string, unknown>> {
        if (!this.childProcess?.isRunning) return {};
        try {
            const stats = await this.childProcess.getStats(element);
            if (this.statsFailureLogged.delete(element)) {
                this.log.debug({ element }, 'getElementStats recovered');
            }
            return stats;
        } catch (err) {
            // Pollers hit this every tick while an element blocks its stats
            // getter (srtsrc mid-reconnect) — one line per outage is enough.
            if (!this.statsFailureLogged.has(element)) {
                this.statsFailureLogged.add(element);
                this.log.debug(
                    { err, element },
                    'getElementStats failed (suppressing repeats until it recovers)',
                );
            }
            return {};
        }
    }

    /** Update VU data (called by child process in Phase 3). */
    protected setVuData(data: number[]): void {
        this.vuData = data;
        this.emit('vuData', data);
    }

    /** Set health status with optional error message. Public: the routing
     *  layer also surfaces module-scoped conditions here (e.g. the live
     *  input-swap pending window — MpegTsBusExecutor). */
    setHealth(health: ModuleHealth, error?: string): void {
        this.health = health;
        this.error = error;
        this.emit('stateChange', this.getState());
    }

    /**
     * Ask the engine to STOP this module cleanly — the module ran to a natural
     * end (e.g. a VOD stream finished) and should land in the same disabled
     * state a user stop produces: pipeline down, connections removed, no
     * crash-restart, and config re-applies don't revive it until re-enabled.
     * Routed `plugin → ModuleInstance → ModuleManager → ModuleLifecycle
     * .disable()`; the stop happens asynchronously AFTER the current tick, so
     * it is safe to call from process-exit callbacks.
     */
    protected requestSelfStop(reason: string): void {
        this.log.info({ reason }, 'Module requested self-stop');
        this.emit('selfStop', reason);
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
