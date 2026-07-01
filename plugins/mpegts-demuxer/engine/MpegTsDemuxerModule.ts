import {
    GstPluginBase,
    registerCodecClassifier,
    type EngineServices,
    type PipelineDescription,
    type ModuleServices,
} from '@media-router/engine';
import {
    audioPortId,
    buildDynamicPorts,
    buildPipeline,
    discoveredStreams,
    legacyPortIdToPid,
    pidFromPortId,
    pidPortId,
    videoPortId,
    type DemuxerOutput,
    type DynamicPort,
} from './mpegtsDemuxerPipeline.js';
import {
    StreamInspector,
    type StreamDiscoveredEvent,
} from './streamInspector.js';
import { diffDiscoveredStreams, streamsToConfig } from './discoveredStreams.js';
import { mergeKlvNames, parseKlvPayload } from './klvNames.js';
import { StaleStreamTracker, renderStreamStatus } from './staleStreamTracker.js';

/**
 * MPEG-TS Demuxer plugin.
 *
 * Receives one muxed/mpegts UDP-multicast stream and splits its elementary
 * streams into per-output multicast groups. Each output port is allocated
 * its own UDP port via `MediaRouter.assignUdpPort(moduleId, portId)`.
 *
 * Pad fan-out is performed at runtime via `linkOnPadAdded` rules — the Nth
 * pad-added event of each media type is linked to the Nth configured output
 * port for that media type.
 *
 * Also owns the canonical MPEG-TS audio codec classifiers (opus / aac / mp2
 * / ac3). Other plugins (e.g. audio-decoder) call `probeMpegTsStream` and
 * get codec identification from the classifiers we register here — previously
 * these were hard-coded in `engine/routing/MpegTsProbe.ts`, which forced an
 * engine change to support new MPEG-TS codecs.
 */
export class MpegTsDemuxerModule extends GstPluginBase {
    protected liveUpdatableParams: string[] = [];

    /** Streams detected in the incoming TS, surfaced via the status panel.
     *  Report-only (plan D6) — never feeds back into routing or health. */
    private readonly inspector = new StreamInspector();

    /** Last-known KLV names by PID (plan: labels survive a metadata gap). */
    private readonly klvNames = new Map<number, string>();

    /** One-shot guard so a persistently-malformed name payload warns once, not
     *  every carousel tick. Reset on each (re)start. */
    private klvGarbageWarned = false;

    /** One-shot post-start stale evaluation — see the comment in onStart. */
    private staleCheckTimer: ReturnType<typeof setTimeout> | null = null;

    /** Guards stale-port cleanup until pads have had time to appear after a
     *  (re)start — before that, "not seen this run" is everyone, and cleaning
     *  then would purge and re-add ports on every start. */
    private staleGraceElapsed = false;

    /** GC hysteresis clocks (see StaleStreamTracker). 60 s is generous on
     *  purpose: ordered apply settles in seconds; an operator re-wiring takes
     *  longer, and a kept port costs nothing. */
    private readonly staleTracker = new StaleStreamTracker(60_000);

    /** Periodic stale re-evaluation while running (badge + GC) — without it a
     *  dark port would only be re-checked when an unrelated discovery event
     *  happens to fire. */
    private staleSweepTimer: ReturnType<typeof setInterval> | null = null;

    /** Latched after the first registerServices call so multi-engine test
     *  setups, plugin reloads, or any other re-entry don't grow the classifier
     *  list with duplicates (`registerCodecClassifier` unshifts without
     *  dedupe). */
    private static classifiersRegistered = false;

    /**
     * Plugin-load-time hook. Registers the codec classifiers used by
     * `probeMpegTsStream` so downstream consumers (audio-decoder) can identify
     * which decoder element to spawn.
     */
    static registerServices(_services: EngineServices): void {
        if (MpegTsDemuxerModule.classifiersRegistered) return;
        MpegTsDemuxerModule.classifiersRegistered = true;
        // First-match-wins. Registered with `unshift`, so the order below is
        // reversed at lookup time — list specific patterns last.
        registerCodecClassifier({
            test: (caps) => caps.startsWith('audio/x-ac3'),
            classify: () => 'ac3',
        });
        registerCodecClassifier({
            test: (caps) =>
                caps.startsWith('audio/mpeg') && /mpegversion=\(int\)1\b/.test(caps),
            classify: () => 'mp2',
        });
        registerCodecClassifier({
            test: (caps) =>
                caps.startsWith('audio/mpeg') && /mpegversion=\(int\)4\b/.test(caps),
            classify: () => 'aac',
        });
        registerCodecClassifier({
            test: (caps) => caps.startsWith('audio/x-opus'),
            classify: () => 'opus',
        });
    }

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
    }

    async onStart(): Promise<void> {
        this.inspector.clear();
        this.klvNames.clear();
        this.klvGarbageWarned = false;
        await super.onStart();
        // super.onStart() builds this.childProcess; subscribe to the runner's
        // stream-inspection events. All report-only — they only update the
        // status panel and never touch routing or health (plan D6).
        this.childProcess?.on('streamDiscovered', (data: StreamDiscoveredEvent) => {
            this.inspector.record(data);
            this.publishStreamStatus();
            this.persistDiscovered();
            if (this.staleGraceElapsed) this.cleanupStaleStreams();
        });
        // In-band name carousel (Phase 2): merge KLV names onto the inspector.
        this.childProcess?.on('streamNames', (data: { payload?: string; malformed?: boolean }) => {
            this.handleStreamNames(data);
        });
        // Grace-timer stale check: with a completely dark source no discovery
        // event ever fires, so nothing would call publishStreamStatus and the
        // persisted streams would never show as stale. One pass after the pads
        // have had ample time to appear covers that; the timer (not an
        // immediate call) avoids flashing the stale badge — or worse, starting
        // GC clocks — on every start before discovery has caught up.
        this.staleGraceElapsed = false;
        this.staleTracker.reset();
        this.staleCheckTimer = setTimeout(() => {
            this.staleGraceElapsed = true;
            this.publishStreamStatus();
            this.cleanupStaleStreams();
        }, 5000);
        // Re-evaluate periodically so the hysteresis clock actually expires
        // (and the badge updates) even when no discovery event fires again.
        this.staleSweepTimer = setInterval(() => {
            if (!this.staleGraceElapsed) return;
            this.publishStreamStatus();
            this.cleanupStaleStreams();
        }, 30_000);
    }

    async onStop(): Promise<void> {
        if (this.staleCheckTimer) {
            clearTimeout(this.staleCheckTimer);
            this.staleCheckTimer = null;
        }
        if (this.staleSweepTimer) {
            clearInterval(this.staleSweepTimer);
            this.staleSweepTimer = null;
        }
        this.staleTracker.reset();
        this.inspector.clear();
        this.klvNames.clear();
        await super.onStop();
    }

    /** Parse a KLV name payload and merge it onto the last-known label store.
     *  Malformed input warns once and is otherwise ignored (plan D6 — the name
     *  channel can never affect routing or health). Absence is a non-event:
     *  an empty parse leaves prior labels intact. */
    private handleStreamNames(data: { payload?: string; malformed?: boolean }): void {
        const parsed = parseKlvPayload(data.payload);
        if ((data.malformed || parsed.malformed) && !this.klvGarbageWarned) {
            this.klvGarbageWarned = true;
            this.log.warn('Malformed in-band stream-name payload — ignoring (labels unaffected)');
        }
        if (parsed.names.size === 0) return;
        mergeKlvNames(this.klvNames, parsed.names);
        this.publishStreamStatus();
        // A new/changed name updates the persisted entry's label fallback so it
        // survives offline (D5). Diffed, so a steady carousel doesn't re-write.
        this.persistDiscovered();
    }

    /**
     * Persist the currently-discovered streams into module config (plan D5).
     * Diffed against the last-persisted set so a steady discovery/name carousel
     * doesn't spam SQLite — only an actual change emits. Never removes an entry
     * (D5): a PID that disappears stays in config so its port survives a dark
     * source. On a real change we both push the config (for persistence/offline
     * ports) and refresh the live port list so the new port appears without a
     * reload.
     */
    private persistDiscovered(): void {
        const fresh = streamsToConfig(this.inspector.list(), this.klvNames);
        const prev = discoveredStreams(this.config);
        const next = diffDiscoveredStreams(prev, fresh);
        if (!next) return;
        // emitConfigUpdate persists the new set; the engine re-resolves this
        // module's dynamic ports off the back of the `configUpdated` event when
        // a port-affecting key changes (see ModuleLifecycle.refreshPorts), so
        // the new PID-based port appears in the UI without a reload.
        this.emitConfigUpdate({ discoveredStreams: next });
    }

    /**
     * Garbage-collect stale ports nobody uses (D5 refinement): a persisted
     * stream that is absent from the live TS AND has zero connections on its
     * port is dropped from config. Anything with a connection is never
     * touched (an upstream change can't orphan downstream wiring); removal of
     * unconnected ports is risk-free because re-discovery recreates the
     * identical PID-derived port id. When and whether removal is allowed is
     * the `StaleStreamTracker`'s hysteresis call — see its doc for the
     * startup/ordered-apply race it exists to defeat.
     */
    private cleanupStaleStreams(): void {
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        if (!router) return;
        const kept = this.staleTracker.sweep(
            discoveredStreams(this.config),
            this.livePids(),
            (pid) => router.getPortConnectionCount(instanceId, pidPortId(pid)) > 0,
            Date.now(),
        );
        if (!kept) return;
        // Same configUpdated → refreshModulePorts path that adds ports on
        // discovery also removes them here, live, without a reload.
        this.emitConfigUpdate({ discoveredStreams: kept });
        this.publishStreamStatus();
    }

    private livePids(): Set<number> {
        return new Set(
            this.inspector.list().map((s) => s.pid).filter((p): p is number => p !== null),
        );
    }

    /** Project inspector + persisted state into the status panel via
     *  `renderStreamStatus` (report-only, plan D6). */
    private publishStreamStatus(): void {
        const streams = this.inspector.list();
        const livePids = this.livePids();
        // Persisted streams whose PID hasn't been seen live this run.
        const stale = discoveredStreams(this.config).filter((s) => !livePids.has(s.pid));
        const render = renderStreamStatus(streams, stale, this.klvNames);

        this.setStatusData('streams', render.summary);
        if (render.badge) this.setBadge('stale', render.badge);
        else this.clearBadge('stale');
        this.dynamicStatusSections = render.sections;
        for (const row of render.data) this.setStatusData(row.id, row.values);
    }

    /**
     * Input port + output ports. PID-based ports come from the persisted
     * `discoveredStreams` (plan Phase 3 / D5). The legacy positional
     * `video-N`/`audio-N` ports are ALWAYS registered while counts are in
     * config — the engine must never drop a port based on its own connection
     * view, which is transiently empty at startup and during ordered apply
     * (doing so orphaned connected edges). Post-discovery they're flagged
     * `hideWhenUnconnected` instead: the UI, which has authoritative live
     * edge state, hides the unconnected ones visually.
     */
    getDynamicPorts(config: Record<string, unknown> = this.config): DynamicPort[] {
        const v = Math.max(0, (config.videoStreamCount as number) ?? 1);
        const a = Math.max(0, (config.audioStreamCount as number) ?? 1);
        return buildDynamicPorts(v, a, discoveredStreams(config));
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        if (!router) return null;

        const upstream = router.getModuleUdpSource(instanceId);
        if (!upstream) {
            this.setHealth('warning', 'No upstream MPEG-TS source connected');
            return null;
        }

        const videoCount = Math.max(0, (config.videoStreamCount as number) ?? 1);
        const audioCount = Math.max(0, (config.audioStreamCount as number) ?? 1);
        const discovered = discoveredStreams(config);

        const allocate = (portId: string, pid?: number): DemuxerOutput | null => {
            const ep = router.assignUdpPort(instanceId, portId);
            if (!ep) return null;
            return { portId, host: ep.host, port: ep.port, ...(pid !== undefined ? { pid } : {}) };
        };

        // Per-port UDP allocation keys by portId (`assignUdpPort(id, portId)`),
        // so each port lands on its own endpoint. PID-based outputs carry their
        // PID so the runner links by PID, not pad-added order — fixing the
        // positional fragility. The legacy positional ports route by mapping
        // their ordinal onto the discovered PID (`legacyPortIdToPid`): a still-
        // connected `video-0` keeps receiving its stream's data (fanned out via
        // a tee in the runner when its PID also feeds a `pid-…` port). Before
        // any discovery the legacy ports route positionally, exactly as before.
        const videoOutputs: DemuxerOutput[] = [];
        const audioOutputs: DemuxerOutput[] = [];
        for (const s of discovered) {
            const out = allocate(pidPortId(s.pid), s.pid);
            if (!out) {
                this.setHealth('error', `UDP port pool exhausted while allocating ${pidPortId(s.pid)}`);
                return null;
            }
            (s.media === 'video' ? videoOutputs : audioOutputs).push(out);
        }
        const allocateLegacy = (portId: string, into: DemuxerOutput[]): boolean => {
            // When discovery has run, pin the legacy port to its mapped PID so
            // it follows its stream (tee fan-out); otherwise leave it
            // positional (pid undefined → runner links by pad-added order).
            const mappedPid = discovered.length > 0 ? legacyPortIdToPid(portId, discovered) : null;
            const pid = mappedPid ? pidFromPortId(mappedPid) ?? undefined : undefined;
            const out = allocate(portId, pid);
            if (!out) {
                this.setHealth('error', `UDP port pool exhausted while allocating ${portId}`);
                return false;
            }
            into.push(out);
            return true;
        };
        for (let i = 0; i < videoCount; i++) {
            if (!allocateLegacy(videoPortId(i), videoOutputs)) return null;
        }
        for (let i = 0; i < audioCount; i++) {
            if (!allocateLegacy(audioPortId(i), audioOutputs)) return null;
        }

        if (videoOutputs.length + audioOutputs.length === 0) {
            this.setHealth('warning', 'No outputs — no streams discovered yet (legacy stream counts are zero)');
            return null;
        }

        const bufferMs = (config.bufferMs as number) ?? 50;
        // Opt-in output smoothing (default 0 = OFF = today's exact strings).
        // Raise for a bursty source (HLS); leave 0 for low-latency live.
        const outputBufferMs = (config.outputBufferMs as number) ?? 0;
        const result = buildPipeline({
            input: { host: upstream.host, port: upstream.port },
            videoOutputs,
            audioOutputs,
            bufferMs,
            outputBufferMs,
        });
        if (!result) return null;

        this.setStatusData('input', { host: upstream.host, port: upstream.port });
        this.setStatusData('outputs', {
            video: videoOutputs.length,
            audio: audioOutputs.length,
        });

        return {
            pipeline: result.pipeline,
            linkOnPadAdded: result.linkOnPadAdded,
            restartOnError: true,
            // Read the in-band name carousel off the metadata PID (Phase 2).
            // The runner attaches a `queue ! appsink` to the meta/x-klv pad and
            // emits `stream_names`; the metadata PID is never routed (D6).
            readKlvNames: true,
        };
    }
}
