import {
    GstPluginBase,
    listDrmConnectors,
    onKernelLogSignal,
    probeGstElement,
    probeUnixSocket,
    type EngineServices,
    type KernelLogSignalEvent,
    type ModuleServices,
    type PipelineDescription,
} from '@media-router/engine';
import {
    bootNowMs,
    COG_POLL_INTERVAL_MS,
    ensureWaylandEnv,
    findCogPidForDisplay,
    hasWaylandSession,
    processStartMs,
    waitForWaylandSocket,
} from './helpers/wayland.js';
import { resolveFallbackImagePath, RESUME_SINK_NAME } from './helpers/pipelines.js';
import {
    decoderDemotionNote,
    probeDecoderAvailability,
    resolveCpuDecodeThreading,
    selectDecoder,
    HARDWARE_DECODER_IDS,
    KERNEL_HW_DECODE_DISABLED_NOTE,
    type DecoderAvailability,
    type DecoderSelection,
} from './helpers/decoderSelection.js';
import { DecoderDemotions, resolveDemotionTtlMs } from './helpers/decoderDemotions.js';
import { CodecMemory, codecMemoryKey } from './helpers/codecMemory.js';
import {
    activeDisplayName,
    describeRenderPath,
    resolveFallbackSurface,
    resolveRenderTarget,
    type SinkAvailability,
} from './helpers/renderTarget.js';
import {
    planFallbackPipeline,
    planLivePipeline,
    planSink,
    resolveBuildHealth,
    resolveResumeSocket,
    videoTsOffsetNs,
} from './helpers/pipelinePlan.js';
import {
    registerWaylandRestartTarget,
    resetWaylandRestartWatch,
    scheduleWaylandRestartCheck,
    unregisterWaylandRestartTarget,
    waylandRestartTargets,
} from './helpers/waylandRestartWatch.js';
import { cogNeedingRestack } from './helpers/cogRestack.js';
import { pollResumeSignal } from './helpers/busResume.js';
import { classifyDecoderFailure, planCodecReport } from './helpers/decoderRuntime.js';
import { describeRenderLag, shouldSelfHealAfterResume } from './helpers/renderLag.js';

export type { SinkAvailability };

/**
 * A pipeline error as it reaches the module. `element` is the gst bus
 * message's own source element INSTANCE (`v4l2slh265dec0`, `h265parse0`,
 * `waylandsink0`), forwarded verbatim by gst-pipeline-runner.py → GstRunner →
 * GstChildProcess; it is what makes decoder demotion attributable. Absent on
 * synthesised errors (spawn failure, max restarts, PLAYING watchdog).
 */
type RunnerErrorEvent = { kind?: string; message?: string; element?: string };

/**
 * Video Player plugin.
 *
 * Terminal sink module. Consumes an MPEG-TS stream from the inter-module
 * bus, decodes it, and renders to a DRM/KMS display. When no
 * source is connected (or when the connected source stops flowing), it
 * shows a SMPTE test pattern with a "No video detected" overlay so the
 * display never goes blank.
 *
 * Owns the `drm-connector` device type.
 *
 * The class is the coordinator: lifecycle, health, event dispatch and the
 * restart latch. Every decision it makes lives in `helpers/` —
 * `renderTarget` (where do we render), `pipelinePlan` (what do we build),
 * `decoderRuntime` + `decoderSelection` (which decoder), `busResume` (has the
 * source come back), `cogRestack` / `waylandRestartWatch` (compositor
 * surprises), `renderLag` (is the render chain keeping up).
 */
export class VideoPlayerModule extends GstPluginBase {
    // `fallbackText` is "live" only in the *fallback* pipeline — the `nov`
    // textoverlay element doesn't exist in the live (bus → decodebin)
    // pipeline. With a source connected, a fallbackText change is silently
    // deferred to the next fallback render. See onLiveConfigUpdate for the
    // hasSource guard that enforces this.
    protected liveUpdatableParams = ['fallbackText', 'lipSyncMs'];

    /** Probed once at plugin load — set by `initManifest`. */
    private static sinks: SinkAvailability = { wayland: false, kms: false };
    /**
     * Decoder-element availability, probed once at plugin load alongside the
     * sinks (`probeGstElement` caches per engine process). Empty until
     * `initManifest` runs, which selects `decodebin3` — the same pipeline the
     * player has always built.
     */
    private static decoders: DecoderAvailability = {};
    /**
     * Decoders that FAILED at runtime, skipped while the demotion is in force.
     * Static on purpose: a Pi whose rpivid driver rejects a stream rejects it
     * for every player instance, so one failure should not cost each instance
     * its own error cycle.
     *
     * Demotions AGE OUT (`decoderDemotions.ts`) rather than lasting the session:
     * one corrupt slice used to leave the box on software decode for hours. The
     * timestamps live in the registry; every read goes through
     * `activeDemotions`, which drops the aged-out ones.
     */
    private static demotions = new DecoderDemotions();

    /**
     * Started instances, for the one signal that has to reach ALL of them at
     * once (the kernel's hardware-decode latch). Maintained by onStart/onStop.
     *
     * Its own set rather than the wayland-restart registry, which happens to
     * hold the same members today: that registry exists to answer a compositor
     * question and may one day only take the instances that render through
     * wayland, at which point a KMS player would silently stop hearing about a
     * dead decoder.
     */
    private static readonly started = new Set<VideoPlayerModule>();

    /**
     * What each producer edge was last seen carrying. Static on purpose: it has
     * to outlive the module instance's own state, which an EXTERNAL stop wipes
     * (see clearDecoderState). That is what stops an external `moduleRestart`
     * paying for a throwaway `decodebin3` bootstrap — one hardware-decoder
     * open/kill cycle per churn — for a codec the engine already knew. Keyed by
     * source edge, so a rewire still bootstraps; see helpers/codecMemory.ts.
     */
    private static codecMemory = new CodecMemory();

    /**
     * Per-instance latch so concurrent restart triggers (wayland session
     * change, cog respawn, bus stall) collapse to one onStop+onStart cycle.
     * Also doubles as "we're in an internal restart, don't clear state that
     * needs to survive the rebuild" — `onStop` checks this before clearing
     * the bus-stall latch.
     */
    private pipelineRestartInProgress = false;
    /** A restart trigger arrived mid-cycle — run one follow-up cycle so the
     *  pipeline converges on the latest state (see restartPipeline). */
    private pipelineRestartPending = false;

    // Kiosk-browser (cog) surface tracking — see helpers/cogRestack.ts for the
    // restack rule and why process start times, not PID changes, drive it.
    private cogPollTimer: NodeJS.Timeout | null = null;
    /** When this pipeline's cog watch (≈ surface creation) began, in
     *  BOOT-relative ms (`bootNowMs`) so an NTP step can't skew the comparison
     *  against `processStartMs` — see those helpers. */
    private cogWatchStartedAt = 0;
    /** Cog PID we already restacked for — one restart per cog incarnation. */
    private lastRestackCogPid: number | undefined = undefined;

    // Source-silent fallback. When the live pipeline's stall watchdog fires
    // (no buffer off the bus socket for 5 s) the Python runner tags the
    // error with `kind: 'bus_stall'`. We latch a flag so the next pipeline
    // build returns the colour-bars fallback instead of looping on a live
    // pipeline that's just going to stall again. The latch is cleared by
    // the resume poller the moment bytes flow again — see helpers/busResume.ts.
    private busStallDetected = false;
    /**
     * Whether the current fallback pipeline carries the bus-resume tap
     * (`unixfdsrc ! fakesink resume_sink` draining this module's own
     * fan-out edge). Built in only when the edge socket existed at build
     * time — see `resolveResumeSocket`.
     */
    private resumeTapActive = false;
    /** Last byte count read off the resume tap — advance = source resumed. */
    private lastResumeBytes: number | undefined;
    /** Consecutive 1 Hz polls that saw the source flowing (stability gate). */
    private resumeStreak = 0;
    /** When the last stall-resume rebuilt the live pipeline (0 = never), in
     *  BOOT-relative ms (`bootNowMs`) — the same clock the cog ordering uses,
     *  so an NTP step mid-window can't skew the heal decision. */
    private lastStallResumeAt = 0;
    /** One free self-heal rebuild per resume — see onPluginEvent. */
    private postResumeHealDone = false;
    /** 1 Hz resume poller, alive only while we're latched in fallback. */
    private busResumeWatchdog: NodeJS.Timeout | null = null;

    // Codec-aware decode. The live pipeline carries a report-only TS probe
    // (`tsProbe` → `tsprobe:videoinfo`); the codec it reports drives which
    // decoder the NEXT build uses. Three pieces of state, because "what the
    // stream is" and "what the running pipeline was built for" have to be
    // compared to know whether a rebuild is worth it — see
    // helpers/decoderRuntime.ts:
    /**
     * Codec last reported by the probe. Survives an internal restart (wayland
     * session change, cog respawn, stall/resume) so those rebuilds go straight
     * to the right decoder instead of bootstrapping on decodebin3 again. An
     * EXTERNAL stop clears it — see clearDecoderState.
     */
    private detectedCodec?: string;
    /** Decoder rung the CURRENT live pipeline was built with; undefined while
     *  the fallback card is up (an error there must never demote a decoder). */
    private liveDecoder?: DecoderSelection;
    /** Codec `liveDecoder` was chosen for — the debounce key for rebuilds. */
    private liveDecoderCodec?: string;
    /**
     * Fires when a demotion that outranks the running rung ages out. Armed by
     * every live build that lands BELOW a demoted decoder and cleared on stop,
     * so it can only ever fire against the pipeline it was armed for — see
     * `armDemotionRetry`.
     */
    private demotionRetryTimer: NodeJS.Timeout | null = null;

    /**
     * Latched while the runner's renderWatch reports the pipeline lagging
     * behind the stream's declared framerate. Owns the corresponding health
     * warning: recovery only clears health that this latch set.
     */
    private renderLagActive = false;

    static registerServices(services: EngineServices): void {
        services.deviceProviders.register({
            type: 'drm-connector',
            list: () => listDrmConnectors(),
            pollMs: 2000,
        });
        // Engines launched via SSH inherit no Wayland env. If a compositor
        // socket exists in the user runtime dir, point the engine (and its
        // gst-runner children) at it so `waylandsink` can connect. Idempotent
        // for desktop sessions where these are already set.
        ensureWaylandEnv();
        // The kernel is the only thing that reports a dead hardware decoder —
        // see onHardwareDecodeDisabled. Subscribing here rather than per
        // instance keeps it to one watcher per engine process, and the signal
        // is replayed if it already latched (including from before this engine
        // started), so load order does not matter.
        onKernelLogSignal('hevc-decode-disabled', (event) =>
            VideoPlayerModule.onHardwareDecodeDisabled(event),
        );
    }

    /**
     * The kernel has switched hardware video decode off until reboot.
     *
     * WHY THE APP HAS TO ACT. Post-latch the driver fails every decode job with
     * `VB2_BUF_STATE_ERROR`, but GStreamer's `v4l2codecs` ignores
     * `V4L2_BUF_FLAG_ERROR` and pushes the buffer downstream regardless — so
     * the pipeline never errors, never stalls the bus watchdog, and simply
     * renders garbage or a frozen frame for the rest of the boot. Nothing in
     * the normal failure path (`handleDecoderFailure`) can fire, because
     * nothing fails.
     *
     * The demotions are PERMANENT (`demotePermanently`): the retry the TTL
     * exists for cannot succeed before a reboot, and each attempt would cost a
     * rebuild and a few seconds of broken picture. Every hardware rung goes, not
     * just the HEVC one — see `HARDWARE_DECODER_IDS`.
     *
     * Then every started instance rebuilds, so the picture is back on software
     * decode within one pipeline cycle instead of at the next restart.
     */
    private static onHardwareDecodeDisabled(event: KernelLogSignalEvent): void {
        const now = Date.now();
        for (const id of HARDWARE_DECODER_IDS) {
            VideoPlayerModule.demotions.demotePermanently(id, now);
        }
        for (const instance of [...VideoPlayerModule.started]) {
            instance.log.error(
                { kernelLine: event.line, source: event.source, demoted: HARDWARE_DECODER_IDS },
                'Kernel disabled hardware video decode until reboot — rebuilding on software decode',
            );
            instance.setHealth('warning', KERNEL_HW_DECODE_DISABLED_NOTE);
            // The rebuild is what actually gets the picture back: the running
            // pipeline is wedged silently and will never rebuild itself.
            instance.restartPipeline().catch(() => {
                /* logged inside */
            });
        }
    }

    static async initManifest(_manifest: Record<string, unknown>): Promise<void> {
        const [wayland, kms, decoders] = await Promise.all([
            probeGstElement('waylandsink'),
            probeGstElement('kmssink'),
            probeDecoderAvailability(probeGstElement),
        ]);
        VideoPlayerModule.sinks = { wayland, kms };
        VideoPlayerModule.decoders = decoders;
    }

    static getSinkAvailability(): SinkAvailability {
        return VideoPlayerModule.sinks;
    }

    static setSinkAvailability(value: SinkAvailability): void {
        VideoPlayerModule.sinks = value;
    }

    static getDecoderAvailability(): DecoderAvailability {
        return VideoPlayerModule.decoders;
    }

    static setDecoderAvailability(value: DecoderAvailability): void {
        VideoPlayerModule.decoders = value;
    }

    /** Demotions still in force — exposed for status/logging and tests. */
    static getDemotedDecoders(): ReadonlySet<string> {
        return VideoPlayerModule.activeDemotions();
    }

    /**
     * The demotion set every decision is made against: struck-off decoders
     * MINUS the ones whose demotion has aged out. One accessor so the plan, the
     * rank mask and the operator note can never disagree about what is demoted.
     */
    private static activeDemotions(): ReadonlySet<string> {
        return VideoPlayerModule.demotions.active(Date.now());
    }

    static _test_resetDecoderState(): void {
        VideoPlayerModule.decoders = {};
        VideoPlayerModule.demotions.clear();
        VideoPlayerModule.codecMemory.clear();
    }

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
    }

    async onStart(): Promise<void> {
        // If waylandsink is installed (i.e. this host is *expected* to render
        // through a Wayland compositor) but the wayland socket isn't here
        // yet, give the compositor a brief window to come up. Without this
        // an engine that boots before labwc/Weston picks the KMS fallback
        // and stays there for the lifetime of the pyProcess — even when the
        // compositor appears 2s later. Seen in production after a power
        // outage on 10.9.1.166: kmssink then either parse-errors (older
        // builds without `connector-name`) or loses the DRM master fight
        // with the compositor. 10s is plenty of headroom for a normal boot
        // and bounded enough that genuinely-headless hosts still fall
        // through promptly.
        if (VideoPlayerModule.sinks.wayland) {
            await waitForWaylandSocket(10_000);
        }
        await super.onStart();
        this.updateStatusData();
        this.installBusStallListener();
        VideoPlayerModule.started.add(this);
        VideoPlayerModule.registerForWaylandRestartWatch(this);
        this.startCogPollWatch();
    }

    /**
     * Runner plugin events. Two independent watches report here:
     *
     * `renderwatch:lag` / `renderwatch:recovered` — render keep-up (see
     * PipelineDescription.renderWatch and helpers/renderLag.ts).
     *
     * `tsprobe:videoinfo` — the live pipeline's TS tap, the only way the
     * module learns what codec it is actually being fed; it drives decoder
     * selection. See the branch below.
     */
    protected onPluginEvent(channel: string, payload: unknown): void {
        if (channel === 'renderwatch:lag') {
            // `busStallDetected` is the only signal that separates "the source
            // went quiet" from "nothing gets through the decode/display chain"
            // when the sink pad sees zero arrivals — see RenderLagContext.
            const lag = describeRenderLag(payload, { sourceSilent: this.busStallDetected });
            // TRANSITION only (the latch is the edge — the runner reports
            // transitions too, but re-arms its streaks on a caps switch and can
            // repeat). Without this the fps figures lived only in module state:
            // a total render stall — 0/50 fps for minutes — left ZERO trace in
            // the journal, so log-based fleet monitoring could not see it at all.
            if (!this.renderLagActive) {
                this.log.warn(
                    { renderWatch: payload, kind: lag.kind, sourceSilent: this.busStallDetected },
                    `Render keep-up degraded — ${lag.message}`,
                );
            }
            this.renderLagActive = true;
            this.setHealth('warning', lag.message);
            if (
                shouldSelfHealAfterResume({
                    sourceShortfall: lag.sourceShortfall,
                    healDone: this.postResumeHealDone,
                    lastStallResumeAt: this.lastStallResumeAt,
                    // Boot-relative on BOTH sides — see SelfHealInput.now.
                    now: bootNowMs(),
                })
            ) {
                this.postResumeHealDone = true;
                this.log.info('Render lag shortly after stall-resume — rebuilding pipeline once');
                this.restartPipeline().catch(() => {
                    /* logged inside */
                });
            }
        } else if (channel === 'renderwatch:recovered') {
            // The matching edge, so the journal carries both ends of every
            // episode and its duration is readable from the timestamps.
            if (this.renderLagActive) {
                this.log.info({ renderWatch: payload }, 'Render keep-up recovered');
            }
            // Only clear health WE degraded — never stomp a bus-stall or
            // substituted-display warning someone else owns.
            if (this.renderLagActive && this.health === 'warning') {
                this.setHealth('ok');
            }
            this.renderLagActive = false;
        } else if (channel === 'tsprobe:videoinfo') {
            // The probe emits an early codec-only line as soon as the PMT
            // parses (well before the SPS), so the upgrade off decodebin3
            // happens within a second of the pipeline playing, and re-emits on
            // a mid-stream PMT change (the h265→h264 feed switch case) which is
            // what drives the codec-change rebuild.
            const codec = (payload as { codec?: string } | null)?.codec;
            if (!codec) return;
            const previous = this.detectedCodec;
            this.detectedCodec = codec;
            // Remembered against the producer edge, so the NEXT start on this
            // source skips the decodebin3 bootstrap. Recorded here rather than
            // at stop: an external stop usually follows the connection being
            // deleted, and by then the edge can no longer be identified.
            VideoPlayerModule.codecMemory.remember(this.codecMemoryKey(), codec);
            const action = planCodecReport({
                codec,
                liveDecoder: this.liveDecoder,
                liveDecoderCodec: this.liveDecoderCodec,
                selectRung: (c) => this.selectDecoderRung(c),
            });
            if (action.kind === 'ignore') return;
            if (action.kind === 'record-codec') {
                this.liveDecoderCodec = codec;
                return;
            }
            this.log.info(
                {
                    codec,
                    previousCodec: previous,
                    decoder: action.next.id,
                    from: this.liveDecoder?.id,
                },
                'Video codec detected — rebuilding pipeline with the matching decoder',
            );
            // restartPipeline coalesces: a renderwatch self-heal (or any other
            // trigger) already in flight queues one follow-up cycle rather than
            // tearing the pipeline down twice.
            this.restartPipeline().catch(() => {
                /* logged inside */
            });
        }
    }

    async onStop(): Promise<void> {
        this.stopCogPollWatch();
        this.stopBusResumeWatchdog();
        // Unconditional, internal restart or not: a retry that fired into the
        // gap between onStop and onStart would rebuild a pipeline that is
        // already being rebuilt. The next live build re-arms it from the
        // demotion's own timestamp, so nothing is lost by dropping it here.
        this.clearDemotionRetry();
        // A rebuilt pipeline gets a fresh runner-side monitor that re-measures
        // from scratch — a stale lag latch must not suppress or fake events.
        // Clear the warning the latch owns too: the fresh monitor starts
        // un-lagged and only reports TRANSITIONS, so it would never emit the
        // "recovered" that clears it (field 2026-08-02: "can't keep up
        // (0/50 fps)" stuck on a healthy pipeline after a compositor-restart
        // rebuild).
        if (this.renderLagActive && this.health === 'warning') {
            this.setHealth('ok');
        }
        this.renderLagActive = false;
        // During an *internal* restart cycle (latched by pipelineRestartInProgress)
        // we deliberately keep the bus-stall latch alive so the rebuilt
        // pipeline picks the fallback path that triggered this very restart
        // (onStart re-arms the resume poller from the latch). On an external
        // stop (user disabled, engine shutdown) we wipe the state — a fresh
        // start should never inherit a stale fallback decision.
        if (!this.pipelineRestartInProgress) {
            this.clearBusStallState();
            this.clearDecoderState();
        }
        VideoPlayerModule.started.delete(this);
        VideoPlayerModule.unregisterForWaylandRestartWatch(this);
        await super.onStop();
    }

    /**
     * Subscribe to the fresh childProcess created by super.onStart() so we
     * can react to bus-stall events with a fallback switch instead of
     * looping on the live pipeline. Also (re)arms the resume poller when a
     * restart cycle rebuilt the pipeline with the latch already set.
     */
    private installBusStallListener(): void {
        if (this.busStallDetected) this.startBusResumeWatchdog();
        if (!this.childProcess) return;
        this.childProcess.on('error', (data: RunnerErrorEvent) => {
            if (data?.kind !== 'bus_stall') {
                // Any other error on a pipeline built with an EXPLICIT decoder
                // is a CANDIDATE for demotion — but only if the error is
                // attributable to that decoder. See handleDecoderFailure.
                this.handleDecoderFailure(data);
                return;
            }
            if (this.busStallDetected) return;
            this.log.info('Bus source went silent — switching to fallback pattern');
            this.busStallDetected = true;
            this.forgetCodecForStall();
            this.startBusResumeWatchdog();
            // gst-runner's restartOnError will replay the *same* live pipeline
            // desc — it doesn't ask the plugin for a new one. Trigger a full
            // restart so buildPipeline is re-called with busStallDetected set
            // and the colour-bars fallback is actually built. The latch in
            // restartPipeline coalesces this with any other in-flight restart.
            this.restartPipeline().catch(() => {
                /* logged inside */
            });
        });
    }

    /**
     * Resolve the best decoder for a codec against the current availability +
     * demotion state. One place so buildPipeline, the codec-change check and
     * the demotion note can't disagree about which rung comes next.
     */
    private selectDecoderRung(codec: string | undefined): DecoderSelection {
        return selectDecoder({
            codec,
            available: VideoPlayerModule.decoders,
            demoted: VideoPlayerModule.activeDemotions(),
            threading: resolveCpuDecodeThreading(this.config?.cpuDecodeThreading),
        });
    }

    /** Apply the verdict `classifyDecoderFailure` reached on a pipeline error. */
    private handleDecoderFailure(data: RunnerErrorEvent | undefined): void {
        const action = classifyDecoderFailure({
            errorKind: data?.kind,
            element: data?.element,
            liveDecoder: this.liveDecoder,
            restartInProgress: this.pipelineRestartInProgress,
            detectedCodec: this.detectedCodec,
            liveDecoderCodec: this.liveDecoderCodec,
        });
        if (action.kind === 'ignore') return;
        if (action.kind === 'codec-changed') {
            this.log.info(
                { built: this.liveDecoderCodec, detected: this.detectedCodec },
                'Pipeline error after a codec change — rebuilding without demoting the decoder',
            );
            this.restartPipeline().catch(() => {
                /* logged inside */
            });
            return;
        }
        if (action.kind === 'rebuild-same') {
            // Nothing to do: the runner's restartOnError replays the very same
            // pipeline string, so the same decoder rung comes straight back up.
            // Triggering our own restart here would only tear down a pipeline
            // that is already being rebuilt.
            this.log.info(
                {
                    element: action.element,
                    decoder: this.liveDecoder?.id,
                    err: data?.message,
                },
                action.element
                    ? `Pipeline error from ${action.element} — not the decoder, keeping ${this.liveDecoder?.id}`
                    : `Pipeline error with no source element — keeping ${this.liveDecoder?.id}`,
            );
            return;
        }
        VideoPlayerModule.demotions.demote(action.failed.id, Date.now());
        const next = this.selectDecoderRung(this.liveDecoderCodec);
        const note = decoderDemotionNote(
            this.liveDecoderCodec,
            next,
            VideoPlayerModule.activeDemotions(),
            VideoPlayerModule.demotions.permanentIds(),
        );
        // A re-demotion resets the clock, so the retry cadence for a decoder
        // that keeps failing is exactly one attempt per TTL.
        const ttlMs = resolveDemotionTtlMs();
        this.log.warn(
            {
                decoder: action.failed.id,
                next: next.id,
                element: data?.element,
                err: data?.message,
                retryInMs: ttlMs || undefined,
            },
            ttlMs > 0
                ? `Decoder ${action.failed.id} failed — demoted, retrying in ${Math.round(ttlMs / 1000)}s, rebuilding on ${next.id}`
                : `Decoder ${action.failed.id} failed — demoted for this session, rebuilding on ${next.id}`,
        );
        // Warning, not error: the picture keeps playing on the next rung, so
        // the operator should see a degraded-path note rather than a red
        // module. buildPipeline re-applies the same note on every subsequent
        // build (it derives it from the demotion set), so it survives the
        // rebuild's setHealth('ok') instead of flashing once.
        if (note) this.setHealth('warning', note);
        // RACES the runner's own restartOnError replay, deliberately. The runner
        // is already scheduling a replay of the SAME (demoted) pipeline string
        // on its backoff; this restart tears the child down and hands it a
        // freshly built description, so whichever lands first, the module's
        // rebuild is the one that survives — a replay that beat us is torn down
        // by our onStop, and one that starts after gets the new pipeline. Worst
        // case the picture takes one extra backoff cycle to appear on the next
        // rung; it can never settle on the demoted decoder.
        this.restartPipeline().catch(() => {
            /* logged inside */
        });
    }

    /**
     * Arm the retry for a live build that landed BELOW a demoted rung.
     *
     * Expiry has to do more than make the rung eligible again: a live pipeline
     * that is playing fine on software decode has no reason to rebuild, so
     * without a timer the box would stay on the slow path until something else
     * happened to rebuild it — which, in the field, was "until someone restarted
     * the engine". The whole point of the age-out.
     *
     * Armed from the BUILD rather than from the failure, so it is derived from
     * state: every rebuild re-arms it against the demotion's original timestamp
     * (no drift, and a restart loop can't starve the retry), and an instance
     * that never saw the failure itself still arms one for a demotion another
     * instance recorded. Cleared by `onStop`, so it cannot fire into a
     * torn-down pipeline.
     */
    private armDemotionRetry(current: DecoderSelection): void {
        this.clearDemotionRetry();
        const retryAt = VideoPlayerModule.demotions.retryAt(this.liveDecoderCodec, current);
        if (retryAt === undefined) return;
        this.demotionRetryTimer = setTimeout(
            () => {
                this.demotionRetryTimer = null;
                this.retryExpiredDemotion();
            },
            Math.max(0, retryAt - Date.now()),
        );
    }

    private clearDemotionRetry(): void {
        if (this.demotionRetryTimer) {
            clearTimeout(this.demotionRetryTimer);
            this.demotionRetryTimer = null;
        }
    }

    /**
     * A demotion aged out while we were running below it — put the decoder back
     * on trial. If it fails again it is simply re-demoted with a fresh
     * timestamp, which is what makes the TTL the retry cadence.
     */
    private retryExpiredDemotion(): void {
        // No live decoder = the fallback card is up (or the build was vetoed):
        // there is no degraded pipeline to improve, and the next live build
        // re-arms this anyway.
        const current = this.liveDecoder;
        if (!current) return;
        const expired = VideoPlayerModule.demotions.prune(Date.now());
        const next = this.selectDecoderRung(this.liveDecoderCodec);
        if (next.id === current.id) {
            // Nothing to gain — the timer beat its own deadline by a tick, or
            // another rung's demotion is what expired. `prune` leaves only
            // demotions with a future deadline, so the re-arm always moves
            // forward.
            this.armDemotionRetry(current);
            return;
        }
        this.log.info(
            { expired, from: current.id, decoder: next.id },
            `Decoder demotion expired, retrying ${next.id}`,
        );
        // Same rebuild machinery as a codec change: coalesced by the in-progress
        // latch, and the rebuild's buildPipeline is what re-arms this timer if
        // the retry does not in fact climb the ladder.
        this.restartPipeline().catch(() => {
            /* logged inside */
        });
    }

    /**
     * The card (or the live chain) just reached PLAYING.
     *
     * Take the resume tap's byte baseline NOW, the moment the tap element
     * exists. The poller's first tick would otherwise be spent installing the
     * throughput probe and recording a count it has nothing to compare against
     * (`total_bytes` counts from probe install, so there is no "0" to seed) —
     * a whole second of the interlude spent learning something the tap already
     * knows. The settle gate is untouched: `RESUME_STABLE_POLLS` advancing
     * observations are still required, they just start one tick earlier.
     */
    protected onPipelinePlaying(): void {
        if (!this.busStallDetected || !this.resumeTapActive) return;
        void this.readBusSinkBytes(RESUME_SINK_NAME)
            .then((bytes) => {
                // Never overwrite a baseline the poller already took, and never
                // resurrect one after a resume/stop cleared the latch.
                if (this.busStallDetected && this.lastResumeBytes === undefined) {
                    this.lastResumeBytes = bytes;
                }
            })
            .catch((err) => this.log.debug({ err }, 'resume baseline seed failed'));
    }

    /** One resume-poller tick — see helpers/busResume.ts for the two modes. */
    private async pollBusResume(): Promise<void> {
        if (!this.busStallDetected || this.pipelineRestartInProgress) return;
        const instanceId = this.services?.instanceId ?? '';
        const source = this.services?.mediaRouter?.getModuleBusSource(instanceId);
        if (!source) return;
        const signal = await pollResumeSignal({
            tapActive: this.resumeTapActive,
            state: { lastBytes: this.lastResumeBytes, streak: this.resumeStreak },
            readTapBytes: () => this.readBusSinkBytes(RESUME_SINK_NAME),
            socketPath: source.socketPath,
            probeSocket: probeUnixSocket,
        });
        this.lastResumeBytes = signal.lastBytes;
        this.resumeStreak = signal.streak;
        if (!signal.resumed || !this.busStallDetected) return;
        this.log.info('Source resumed — restarting live pipeline');
        this.busStallDetected = false;
        this.lastStallResumeAt = bootNowMs();
        this.postResumeHealDone = false;
        this.stopBusResumeWatchdog();
        this.restartPipeline().catch(() => {
            /* logged inside */
        });
    }

    private startBusResumeWatchdog(): void {
        if (this.busResumeWatchdog) return;
        this.lastResumeBytes = undefined;
        this.resumeStreak = 0;
        // 1 Hz is plenty — worst case is one extra second of fallback.
        // Lifetime is bounded to "we're latched in fallback": armed by the
        // bus_stall listener (and re-armed by installBusStallListener after
        // each internal restart), stopped on resume / external stop.
        this.busResumeWatchdog = setInterval(() => {
            this.pollBusResume().catch((err) => {
                this.log.debug({ err }, 'bus resume poll failed');
            });
        }, 1000);
    }

    private stopBusResumeWatchdog(): void {
        if (this.busResumeWatchdog) {
            clearInterval(this.busResumeWatchdog);
            this.busResumeWatchdog = null;
        }
        this.lastResumeBytes = undefined;
        this.resumeStreak = 0;
    }

    /** Wipe stall state on an external stop — fresh start should never inherit a stale fallback decision. */
    private clearBusStallState(): void {
        this.stopBusResumeWatchdog();
        this.busStallDetected = false;
        this.resumeTapActive = false;
        this.lastStallResumeAt = 0;
        this.postResumeHealDone = false;
    }

    /**
     * Forget the detected codec on an EXTERNAL stop. An external stop is where
     * a rewire happens (the operator points this player at a different source),
     * and starting from a remembered codec would build an explicit chain for a
     * stream that may now be something else — a guaranteed error cycle before
     * the probe can correct it. Internal restarts skip this, so a compositor
     * restart or stall/resume keeps the fast path.
     *
     * The next build can still get the codec back from `codecMemory` — but only
     * if it comes up against the SAME producer edge, which is exactly the case
     * this instance state cannot distinguish. Demotions and the codec memory are
     * process-wide and deliberately survive both kinds of stop; demotions age
     * out on their own clock.
     */
    private clearDecoderState(): void {
        this.detectedCodec = undefined;
        this.liveDecoder = undefined;
        this.liveDecoderCodec = undefined;
    }

    /**
     * A 5-second stall means the codec is no longer known. Drop it — instance
     * state AND the edge's entry in the shared memory — so the post-resume live
     * build bootstraps on `decodebin3` instead of committing to a guess.
     *
     * WHY, given that the memory exists precisely to skip that bootstrap. A
     * silent source correlates with upstream RECONFIGURATION: an encoder
     * flipping h265→h264 stops emitting while it restarts, which is how the
     * stall got here in the first place (field, Pi 400, 2026-08-05). Both routes
     * cost exactly ONE extra rebuild — the TS probe reports the real codec
     * within a second either way, and `planCodecReport` / `classifyDecoderFailure`
     * turn that into the same single teardown — so the guess buys no time. What
     * it does buy is an explicit `h265parse ! v4l2slh265dec` chain opened
     * against an h264 feed: a stateless HEVC decoder opened, fed data it cannot
     * decode, and killed again. That open/kill cycle is what leaves the Pi's
     * HEVC block dirty and lengthens the NEXT device open — the stall's own
     * root cause (see codecMemory.ts and the keyframe-gate comment in
     * pipelinePlan.ts). `decodebin3` auto-plugs off the caps it actually sees,
     * so it can never open the wrong codec's hardware.
     *
     * NON-STALL rebuilds keep the memory: a compositor restart, a cog restack or
     * an operator's profile patch says nothing about the feed, which is the case
     * the memory was added for.
     */
    private forgetCodecForStall(): void {
        VideoPlayerModule.codecMemory.forget(this.codecMemoryKey());
        // Cleared together, always: `classifyDecoderFailure` reads a mismatch
        // between these two as "the feed changed under this pipeline", and a
        // half-cleared pair would fabricate that verdict on the fallback card.
        this.detectedCodec = undefined;
        this.liveDecoderCodec = undefined;
    }

    /** This instance's key into the shared codec memory — see codecMemory.ts. */
    private codecMemoryKey(): string | undefined {
        const instanceId = this.services?.instanceId ?? '';
        return codecMemoryKey(
            instanceId,
            this.services?.mediaRouter?.getModuleBusSource(instanceId),
        );
    }

    /**
     * Begin polling /proc for the cog process pinned to our active display.
     * Only meaningful on the wayland path — on KMS we own the connector
     * directly and kiosk-shell isn't involved. The watch start time is the
     * baseline the restack rule compares cog start times against.
     */
    private startCogPollWatch(nowMs: typeof bootNowMs = bootNowMs): void {
        if (this.cogPollTimer) return;
        if (!VideoPlayerModule.sinks.wayland || !hasWaylandSession()) return;
        if (!this.currentActiveDisplayName()) return;
        this.cogWatchStartedAt = nowMs();
        this.cogPollTimer = setInterval(() => this.pollCogRestack(), COG_POLL_INTERVAL_MS);
    }

    /** One cog-watch tick: restart once for a cog that will surface above us. */
    private pollCogRestack(
        findPid: typeof findCogPidForDisplay = findCogPidForDisplay,
        startMs: typeof processStartMs = processStartMs,
    ): void {
        const activeDisplay = this.currentActiveDisplayName();
        const cogPid = cogNeedingRestack({
            display: activeDisplay,
            watchStartedAt: this.cogWatchStartedAt,
            lastRestackPid: this.lastRestackCogPid,
            findPid,
            startMs,
        });
        if (cogPid === undefined) return;
        this.lastRestackCogPid = cogPid;
        this.log.info(
            { display: activeDisplay, cogPid },
            'Kiosk browser surfaced after our pipeline — restarting video pipeline to restack',
        );
        this.restartPipeline().catch(() => {
            /* logged inside */
        });
    }

    private stopCogPollWatch(): void {
        if (this.cogPollTimer) {
            clearInterval(this.cogPollTimer);
            this.cogPollTimer = null;
        }
        // `lastRestackCogPid` deliberately survives: the grace window means a
        // freshly-restacked pipeline would otherwise see the SAME cog inside
        // the window again after its own restart and loop. One restack per
        // cog incarnation, per module instance.
    }

    private currentActiveDisplayName(): string {
        return activeDisplayName((this.config?.display as string) ?? '');
    }

    /**
     * Trigger a clean pipeline restart against the *current* wayland session.
     * Used by the runtime-dir watcher (compositor socket replaced), the
     * cog-PID watcher (kiosk browser respawned), and the bus stall/resume
     * switches. Callers log their own trigger reason first; this method only
     * logs failure.
     *
     * A trigger that lands while a cycle is mid-flight queues ONE follow-up
     * cycle instead of being dropped. Dropping it froze the player on a stale
     * build: source went silent → fallback restart started → source resumed
     * 2 s later (clearing `busStallDetected`) → the resume restart was
     * discarded by the old in-progress latch → the fallback pipeline (built
     * from the stale flag) stayed up forever with healthy data underneath.
     * The follow-up cycle re-runs buildPipeline against the LATEST state, so
     * back-to-back stall/resume flips always converge.
     */
    private async restartPipeline(): Promise<void> {
        if (this.pipelineRestartInProgress) {
            this.pipelineRestartPending = true;
            return;
        }
        this.pipelineRestartInProgress = true;
        try {
            do {
                this.pipelineRestartPending = false;
                try {
                    await this.onStop();
                    await this.onStart();
                } catch (err) {
                    this.log.warn({ err }, 'Pipeline restart cycle failed');
                }
            } while (this.pipelineRestartPending);
        } finally {
            this.pipelineRestartInProgress = false;
        }
    }

    private static registerForWaylandRestartWatch(instance: VideoPlayerModule): void {
        registerWaylandRestartTarget(instance, (ident) => {
            instance.log.info({ ident }, 'Wayland session changed — restarting video pipeline');
            instance.restartPipeline().catch(() => {
                /* logged in the per-instance handler */
            });
        });
    }

    private static unregisterForWaylandRestartWatch(instance: VideoPlayerModule): void {
        unregisterWaylandRestartTarget(instance);
    }

    // --- test-only hooks ---
    static _test_getRunningInstances(): ReadonlySet<VideoPlayerModule> {
        return waylandRestartTargets() as ReadonlySet<VideoPlayerModule>;
    }
    /** The started-instance set the kernel-latch broadcast reaches. Live, so a
     *  test can seed it without driving a real onStart (which spawns a child). */
    static _test_startedInstances(): Set<VideoPlayerModule> {
        return VideoPlayerModule.started;
    }
    /** Demotions that will not age out — see `DecoderDemotions.permanentIds`. */
    static _test_permanentDemotions(): ReadonlySet<string> {
        return VideoPlayerModule.demotions.permanentIds();
    }
    static _test_resetWaylandWatcher(): void {
        resetWaylandRestartWatch();
    }
    static _test_triggerWaylandCheck(): void {
        scheduleWaylandRestartCheck();
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        Object.assign(this.config, changes);
        if ('fallbackText' in changes) {
            // The `nov` text overlay only exists in the *fallback* pipeline
            // (videotestsrc branch). The fallback runs when there's no bus
            // source assigned, OR when the source is assigned but silent
            // (busStallDetected — colour-bars-while-source-down path). In
            // both states the element exists and the live push is safe.
            // With a healthy live source there's no `nov` element and the
            // new text takes effect the next time the fallback pipeline is
            // built (source disconnect, stall, module restart).
            const instanceId = this.services?.instanceId ?? '';
            const hasSource = !!this.services?.mediaRouter?.getModuleBusSource(instanceId);
            const fallbackPipelineActive = !hasSource || this.busStallDetected;
            if (fallbackPipelineActive) {
                const text = changes.fallbackText as string;
                await this.setElementProperty('nov', 'text', text).catch((err) =>
                    this.log.debug({ err }, 'Failed to update fallback text overlay'),
                );
            }
        }
        if ('lipSyncMs' in changes) {
            // Live lip-sync trim — push the new ts-offset to the running video
            // `sink` (no rebuild). Only bites when the sink is sync=true. Under
            // the time-sync contract the trim rides ON TOP of the route's
            // playout offset D, so the pushed value has to be re-resolved
            // whole rather than sent as the raw trim.
            await this.pushSinkTsOffset();
        }
        this.updateStatusData();
    }

    /**
     * The route head's playout offset D moved (ADR-0005 decision 4) — re-push
     * the sink's `ts-offset` without a rebuild, the same live path `lipSyncMs`
     * has always used. The audio leg of the route gets the identical call at the
     * same moment (MediaRouter.notifyPlayoutOffsetChanged), so the two legs
     * never sit on different values.
     */
    async onRoutePlayoutOffsetChanged(): Promise<void> {
        await this.pushSinkTsOffset();
    }

    /** Resolve this leg's ts-offset from current config + route and push it live. */
    private async pushSinkTsOffset(): Promise<void> {
        const ns = videoTsOffsetNs(this.services, this.config);
        await this.setElementProperty('sink', 'ts-offset', ns).catch((err) =>
            this.log.debug({ err }, 'Failed to update sink ts-offset'),
        );
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const fallbackText = (config.fallbackText as string) ?? 'No video detected';
        const rawImagePath = (config.fallbackImagePath as string) ?? '';
        const fallbackImage = resolveFallbackImagePath(rawImagePath);
        if (rawImagePath && !fallbackImage) {
            // Path was provided but unusable (missing / not readable / unsafe
            // characters). Don't tear the pipeline down — fall through to the
            // SMPTE pattern and surface the misconfiguration to the operator.
            this.log.warn(
                { path: rawImagePath },
                'fallbackImagePath not usable — falling back to SMPTE colour bars',
            );
        }
        const requestedDisplay = (config.display as string) ?? '';
        // Headless / no-compositor guards can veto the build outright; when
        // they don't, this is the connector, sink env and surface geometry
        // everything below builds against. See helpers/renderTarget.ts.
        const target = resolveRenderTarget(requestedDisplay, VideoPlayerModule.sinks);
        if (target.kind === 'blocked') {
            this.setHealth(target.health, target.message);
            return null;
        }
        const sink = planSink(target, config, videoTsOffsetNs(this.services, config));

        const instanceId = this.services?.instanceId ?? '';
        const udpSource = this.services?.mediaRouter?.getModuleBusSource(instanceId);
        const sourceSilent = !!udpSource && this.busStallDetected;
        const useFallback = !udpSource || sourceSilent;

        this.setHealth(
            ...resolveBuildHealth({
                requestedDisplay,
                active: target.active,
                sourceSilent,
                hasSource: !!udpSource,
            }),
        );

        if (useFallback) {
            const resumeSocket = resolveResumeSocket(sourceSilent, udpSource?.socketPath);
            const plan = planFallbackPipeline({
                fallbackText,
                fallbackImage,
                sinkElement: sink.sinkElement,
                env: target.env,
                surface: resolveFallbackSurface(target.renderConnector, target.waylandFullscreen),
                resumeSocket,
            });
            this.resumeTapActive = plan.resumeTapActive;
            // No decoder in the fallback card — clear the record so an error
            // on the colour bars can never demote a decoder that isn't running,
            // and drop the retry: there is no degraded rung to climb off.
            this.liveDecoder = undefined;
            this.clearDemotionRetry();
            return plan.description;
        }
        this.resumeTapActive = false;

        // Codec-aware decoder. For a codec nobody has ever reported on this
        // edge this resolves to `decodebin3` — the bootstrap build, identical
        // to the pipeline the player has always produced. Once
        // `tsprobe:videoinfo` names the codec, onPluginEvent triggers a rebuild
        // and this picks the explicit chain (see decoderSelection.ts).
        //
        // A start that has no codec of its own takes the one this producer edge
        // was last seen carrying, so an external moduleRestart goes straight to
        // the right decoder instead of opening (and killing) a hardware decoder
        // inside a throwaway decodebin3 (see codecMemory.ts). The probe is armed
        // on this build either way, so a codec CHANGE still rebuilds as today.
        this.detectedCodec ??= VideoPlayerModule.codecMemory.recall(
            codecMemoryKey(instanceId, udpSource),
        );
        const decoder = this.selectDecoderRung(this.detectedCodec);
        this.liveDecoder = decoder;
        this.liveDecoderCodec = this.detectedCodec;
        // Retry the decoder we're running below, once its demotion ages out.
        this.armDemotionRetry(decoder);
        // Re-apply the demotion note on every build so "running on the slow
        // path" stays visible while the demotion lasts rather than flashing
        // once at the failure. A display substitution is the more urgent
        // warning, so it keeps precedence.
        const demotionNote = decoderDemotionNote(
            this.detectedCodec,
            decoder,
            VideoPlayerModule.activeDemotions(),
            VideoPlayerModule.demotions.permanentIds(),
        );
        if (demotionNote && !target.active.substituted) this.setHealth('warning', demotionNote);

        return planLivePipeline({
            sinkElement: sink.sinkElement,
            udpSource,
            env: target.env,
            waylandFullscreen: target.waylandFullscreen,
            decoder,
            // Only bites on the decodebin3 rung, where it stops the bin
            // auto-plugging a decoder we struck off. Nothing else is masked —
            // the bin still picks hardware by rank. See decoderRankEnv.
            demoted: VideoPlayerModule.activeDemotions(),
            bufferMs: config.bufferMs,
            cpuDecodeThreading: config.cpuDecodeThreading,
            clockSync: sink.clockSync,
            sinkPaced: sink.sinkPaced,
        });
    }

    private updateStatusData(): void {
        const instanceId = this.services?.instanceId ?? '';
        const udpSource = this.services?.mediaRouter?.getModuleBusSource(instanceId);
        this.setStatusData('input', {
            source: udpSource ? `bus ${udpSource.port}` : '—',
            state: udpSource ? 'connected' : 'no source',
        });
        this.setStatusData(
            'display',
            describeRenderPath((this.config.display as string) ?? '', VideoPlayerModule.sinks),
        );
    }
}
