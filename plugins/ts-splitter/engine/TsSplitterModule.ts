import {
    GstPluginBase,
    NativeSinkController,
    busTeeName,
    registerCodecClassifier,
    resolveNativeBinary,
    type BusAttachTarget,
    type EngineServices,
    type LiveSwapTarget,
    type ManagedProcess,
    type PipelineDescription,
} from '@media-router/engine';
import {
    INPUT_PORT_ID,
    INPUT_SRC_NAME,
    buildDynamicPorts,
    discoveredStreams,
    mergeDiscovered,
    pidPortId,
    type DiscoveredStreamConfig,
    type DynamicPort,
} from './splitterPorts.js';
import { buildSpawnArgs, dispatchRunnerEvent } from './nativeRunner.js';
import { formatPid, languageFromEsInfo, streamLabel, streamTypeInfo } from './streamTypes.js';

/**
 * TS-Splitter plugin (coexists with the mpegts-demuxer).
 *
 * Splits one `muxed/mpegts` input into per-PID single-ES SPTS outputs at
 * TS-PACKET level: 188-byte packets pass through as they arrive — no
 * tsdemux→mpegtsmux ES round-trip. A demuxer cannot emit a frame until its
 * last byte lands (a 535 KB I-frame is ~220 ms of wire time at 19.6 Mbps,
 * measured on gate01), so its outputs are hold-and-burst even on a smooth
 * wire; packet pass-through inherits the wire cadence and drops the
 * mini-mux's 1.2 s latency budget.
 *
 * The data path is the NATIVE child `mr-tssplit` (this plugin's
 * native/mr-tssplit — the
 * C++ port of ts_split.py measured at ~1/60th the CPU of the python/gst
 * shell): a GstUnixFd client on the input edge, the packet router, and one
 * fan-out server per output PID. There is no GStreamer pipeline at all —
 * `buildPipeline` returns null and the child is a ManagedProcess
 * (hls-player's producer pattern). Bus attach/detach and the live input
 * swap's `reinput` ride the child's stdin via `NativeSinkController`; its
 * stdout `plugin_event` lines are byte-compatible with the old runner's, so
 * `onPluginEvent` below is unchanged from the gst generation.
 *
 * All discovered outputs are declared to the child (`--out` per PID) but an
 * output only produces packets while its tee has an attached fan-out edge
 * (wired-only gating, in the child). Wiring a PID discovered after the last
 * spawn is the engine's materializeProducerPort bounce: the module restarts
 * and the new `--out` appears; sticky port allocation keeps sibling
 * consumers stable.
 *
 * Source PMT discovery arrives on the `tssplit:discovered` plugin-event
 * channel and is persisted to `discoveredStreams` config (never removed — a
 * dark source keeps its ports). Labels layer the natively-signalled ISO 639
 * language descriptor (carried as raw ES descriptor bytes in the event) onto
 * the generic stream_type label; the in-band KLV name channel is not read
 * here (the demuxer keeps that duty — a name would outrank the language).
 */
export class TsSplitterModule extends GstPluginBase {
    /** Route-head playout offset (ADR-0005 decision 4) — the splitter reads it
     *  itself for nothing; the engine fans it out to the consumers of each
     *  output leg, which is why it must never mark a pending restart here. */
    protected liveUpdatableParams = ['playoutOffsetMs'];
    /** Streams seen live this run (PID-keyed). Drives ports + status. */
    private readonly discovered = new Map<number, DiscoveredStreamConfig>();
    /** Live SPS-derived video parameters per pid ("1920×1080i50 (h264)") —
     *  ephemeral status, deliberately NOT part of discoveredStreams config. */
    private readonly videoInfo = new Map<number, string>();

    private splitProc: ManagedProcess | null = null;
    private controller: NativeSinkController | null = null;
    /** PIDs the RUNNING child has an output for — its `--out` set at spawn
     *  plus everything since added live. Empty while no child runs. */
    private readonly declaredPids = new Set<number>();

    private static classifiersRegistered = false;

    /**
     * Register the MPEG-TS audio codec classifiers used by `probeMpegTsStream`
     * (so a downstream audio-decoder can pick its decoder element). The
     * demuxer registers the same set; during coexistence both may register —
     * harmless (first-match-wins; the guard dedupes within this class).
     */
    static registerServices(_services: EngineServices): void {
        if (TsSplitterModule.classifiersRegistered) return;
        TsSplitterModule.classifiersRegistered = true;
        registerCodecClassifier({ test: (caps) => caps.startsWith('audio/x-ac3'), classify: () => 'ac3' });
        registerCodecClassifier({
            test: (caps) => caps.startsWith('audio/mpeg') && /mpegversion=\(int\)1\b/.test(caps),
            classify: () => 'mp2',
        });
        registerCodecClassifier({
            test: (caps) => caps.startsWith('audio/mpeg') && /mpegversion=\(int\)4\b/.test(caps),
            classify: () => 'aac',
        });
        registerCodecClassifier({ test: (caps) => caps.startsWith('audio/x-opus'), classify: () => 'opus' });
    }

    /** PID-based output ports come from persisted discovery (survives a dark
     *  source); the single muxed input is always present. */
    getDynamicPorts(config: Record<string, unknown> = this.config): DynamicPort[] {
        return buildDynamicPorts(discoveredStreams(config));
    }

    /** No GStreamer pipeline — the data path is the native child. */
    buildPipeline(_config: Record<string, unknown>): PipelineDescription | null {
        return null;
    }

    /**
     * Live input swap: the splitter's shape does not depend on WHICH source
     * feeds it — the native child re-points its input client at a new edge
     * socket (`reinput` verb, make-before-break) while every output fan-out
     * (and all downstream consumers) keeps running. Discovery re-converges
     * from the new source's PSI. `element` is the legacy gst RPC field; the
     * native child ignores it (one input).
     */
    getLiveInputSwap(sinkPortId: string): { element: string } | null {
        return sinkPortId === INPUT_PORT_ID ? { element: INPUT_SRC_NAME } : null;
    }

    /** Bus fan-out + reinput both ride the native child's stdin. */
    getBusAttachTarget(): BusAttachTarget | null {
        return this.splitProc ? this.controller : null;
    }

    getLiveSwapTarget(): LiveSwapTarget | null {
        return this.splitProc ? this.controller : null;
    }

    async onStart(): Promise<void> {
        await super.onStart();
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        const upstream = router?.getModuleBusSource(instanceId, INPUT_PORT_ID);
        if (!router || !upstream) {
            this.setHealth('warning', 'No upstream MPEG-TS source connected');
            this.publishStatus();
            return;   // idle — no child until an input is wired
        }

        // Allocate (sticky, owner-keyed `${instanceId}:pid-0x…`) an endpoint
        // per persisted stream and declare EVERY output to the child. Zero
        // persisted streams ⇒ input-only: discovery runs before any output
        // exists, so the first PIDs appear without manual config.
        const outputs = [];
        for (const s of discoveredStreams(this.config)) {
            const ep = router.assignBusChannel(instanceId, pidPortId(s.pid));
            if (!ep) {
                this.setHealth('error', `UDP port pool exhausted while allocating ${pidPortId(s.pid)}`);
                return;
            }
            outputs.push({ pid: s.pid, streamType: s.streamType, port: ep.port });
        }
        this.declaredPids.clear();
        for (const o of outputs) this.declaredPids.add(o.pid);

        const binary = resolveNativeBinary('mr-tssplit', 'ts-splitter');
        if (!binary) {
            this.setHealth('error', 'mr-tssplit binary not found — run `make native` (see plugins/README.md)');
            return;
        }
        this.controller = new NativeSinkController(
            () => this.splitProc,
            // Every child `ready` (first start + each autoRestart respawn):
            // the controller replayed its own desired edges; this reattach
            // covers connections created while the module was down, which
            // only the engine-side coordinator knows about.
            () => {
                router.onProducerPlaying(instanceId);
                this.setHealth('ok');
            },
        );
        this.splitProc = this.spawnRunnerProcess({
            label: 'mr-tssplit',
            command: binary,
            args: buildSpawnArgs({
                inputSocketPath: upstream.socketPath,
                tsId: (this.config.tsId as number) ?? 1,
                outputs,
                // Fan-out coalescing window; 0 disables batching for
                // ultra-low-latency chains (see the schema description).
                busBatchMs: this.config.busBatchMs as number | undefined,
                // Producer half of the time-sync contract: every output PID is
                // stamped from its own payload against ONE shared anchor.
                stampTimeline: this.services?.timeSyncContract === true,
            }),
            autoRestart: true,
            stdin: true,
            onStdout: (line) => this.handleRunnerLine(line),
            onStderr: (line) => this.log.warn({ src: 'mr-tssplit' }, line),
        });
        this.running = true;
        this.setStatusData('input', { channel: upstream.port });
        this.publishStatus();
    }

    async onStop(): Promise<void> {
        // ProcessManager.releaseAll kills the child; drop refs so a stale
        // controller can't write into the next incarnation.
        this.splitProc = null;
        this.controller = null;
        this.declaredPids.clear();
        this.discovered.clear();
        this.videoInfo.clear();
        await super.onStop();
    }

    private handleRunnerLine(line: string): void {
        const msg = this.controller?.handleLine(line);
        if (!msg) return;
        dispatchRunnerEvent(msg, {
            onPluginEvent: (channel, payload) => this.onPluginEvent(channel, payload),
            // Input silence is source-side, not a module failure — same
            // semantics as the gst path's bus_stall warning.
            onInputStalled: (ms) =>
                this.setHealth('warning', `Input stalled — no data for ${ms} ms`),
            onInputResumed: () => this.setHealth('ok'),
            onStats: (stats) => {
                this.setStatusData('io', {
                    consumers: stats.clients ?? 0,
                    inKbps: stats.in_kbps ?? 0,
                });
            },
        });
    }

    protected onPluginEvent(channel: string, payload: unknown): void {
        if (channel === 'tssplit:videoinfo') {
            // Ephemeral status only — NEVER merged into the persisted
            // discoveredStreams config (would churn port re-resolution for a
            // cosmetic value). `display` is pre-formatted by the runner.
            const p = payload as { pid?: number; codec?: string; display?: string };
            const pid = Number(p?.pid);
            if (Number.isFinite(pid) && p.display) {
                this.videoInfo.set(pid, `${p.display} (${p.codec})`);
                this.publishStatus();
            }
            return;
        }
        if (channel !== 'tssplit:discovered') return;
        const streams = (
            payload as { streams?: Array<{ pid: number; streamType: number; esInfo?: string }> }
        )?.streams;
        if (!Array.isArray(streams)) return;
        for (const s of streams) {
            const pid = Number(s.pid);
            const streamType = Number(s.streamType);
            if (!Number.isFinite(pid) || !Number.isFinite(streamType)) continue;
            // ISO label layering: no in-band name channel here, so the ES's
            // natively-signalled ISO 639 language (from the raw PMT
            // descriptor bytes in `esInfo`) is the strongest label input.
            const language = languageFromEsInfo(s.esInfo);
            const existing = this.discovered.get(pid);
            if (
                existing &&
                existing.streamType === streamType &&
                (existing.language ?? '') === (language ?? '')
            ) {
                continue;
            }
            const { media, codec } = streamTypeInfo(streamType);
            this.discovered.set(pid, {
                pid,
                streamType,
                media,
                codec,
                ...(language ? { language } : {}),
            });
        }
        // emitConfigUpdate persists + re-resolves dynamic ports, so a new PID
        // port appears in the UI without a reload. The pipeline is NOT
        // rebuilt here — the branch materializes when the port is first
        // wired (materializeProducerPort bounce).
        const next = mergeDiscovered(discoveredStreams(this.config), [...this.discovered.values()]);
        if (next) this.emitConfigUpdate({ discoveredStreams: next });
        this.publishStatus();
        void this.declareNewOutputs();
    }

    /**
     * Give the running child an output for every discovered PID it does not
     * have yet (`add_output`), so wiring a late-discovered port needs no
     * module restart. Allocating the bus channel here also means the engine
     * finds the port already assigned, so `materializeProducerPort` never has
     * to bounce us. Best-effort: on any failure the output simply stays
     * undeclared and the engine's restart path materialises it as before.
     */
    private async declareNewOutputs(): Promise<void> {
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        if (!router || !this.controller || !this.splitProc) return;
        for (const s of this.discovered.values()) {
            if (this.declaredPids.has(s.pid)) continue;
            const ep = router.assignBusChannel(instanceId, pidPortId(s.pid));
            if (!ep) {
                this.log.warn({ pid: s.pid }, 'No bus channel for late-discovered PID');
                continue;
            }
            // Mark BEFORE awaiting: a second discovery event for the same PID
            // must not race a duplicate verb (the child is idempotent, but the
            // engine should not spam it either).
            this.declaredPids.add(s.pid);
            try {
                await this.controller.addOutput(s.pid, busTeeName(ep.port));
            } catch (err) {
                this.declaredPids.delete(s.pid);
                this.log.warn(
                    { err, pid: s.pid },
                    'add_output failed — the port materialises on the next restart',
                );
            }
        }
    }

    private publishStatus(): void {
        const streams = [...this.discovered.values()].sort((a, b) => a.pid - b.pid);
        this.setStatusData('streams', { detected: streams.length });
        this.setBadge('streams', {
            icon: 'git-fork',
            text: `${streams.length}`,
            color: streams.length > 0 ? '#10b981' : '#6b7280',
        });
        // Uniform field shape across every stream section — same-shaped
        // sections collapse into ONE table in the stats modal (row per
        // stream); a conditional language field would split the table.
        this.dynamicStatusSections = streams.map((s) => ({
            id: `stream-${s.pid}`,
            label: streamLabel(s.pid, s.streamType, s.language),
            fields: [
                { key: 'media', label: 'Media' },
                { key: 'codec', label: 'Codec' },
                { key: 'video', label: 'Video' },
                { key: 'language', label: 'Language' },
                { key: 'pid', label: 'PID' },
                { key: 'pidDec', label: 'PID (dec)' },
            ],
        }));
        for (const s of streams) {
            this.setStatusData(`stream-${s.pid}`, {
                media: s.media,
                codec: s.codec,
                video: this.videoInfo.get(s.pid) ?? '—',
                language: s.language ?? '—',
                pid: formatPid(s.pid),
                pidDec: s.pid,
            });
        }
    }
}
