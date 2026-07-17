import {
    GstPluginBase,
    registerCodecClassifier,
    type EngineServices,
    type PipelineDescription,
} from '@media-router/engine';
import {
    INPUT_PORT_ID,
    buildDynamicPorts,
    discoveredStreams,
    mergeDiscovered,
    pidPortId,
    type DiscoveredStreamConfig,
    type DynamicPort,
} from './splitterPorts.js';
import { buildSplitterPipeline } from './splitterPipeline.js';
import { formatPid, streamLabel, streamTypeInfo } from './streamTypes.js';

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
 * The splitting itself runs inside gst-pipeline-runner.py (`tsSplit` config,
 * ts_split.py core — the librist embedding pattern): the module's pipeline is
 * `bus src ! appsink` plus one `appsrc ! bus sink` chain per PID output. All
 * discovered outputs are ALWAYS produced into their fan-out tees
 * (`allow-not-linked`) — an unconsumed tee is nearly free, so there is no
 * add/remove-output protocol and no connection polling. Wiring a PID that was
 * discovered after the last build is the engine's existing
 * materializeProducerPort bounce: buildPipeline re-runs and the new branch
 * appears; sticky port allocation keeps sibling consumers stable.
 *
 * Source PMT discovery arrives on the `tssplit:discovered` plugin-event
 * channel and is persisted to `discoveredStreams` config (never removed — a
 * dark source keeps its ports). v1 skips KLV/SDT stream naming (the demuxer
 * keeps that duty).
 */
export class TsSplitterModule extends GstPluginBase {
    /** Streams seen live this run (PID-keyed). Drives ports + status. */
    private readonly discovered = new Map<number, DiscoveredStreamConfig>();

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

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        if (!router) return null;

        const upstream = router.getModuleUdpSource(instanceId, INPUT_PORT_ID);
        if (!upstream) {
            this.setHealth('warning', 'No upstream MPEG-TS source connected');
            return null;
        }

        // Allocate (sticky, owner-keyed `${instanceId}:pid-0x…`) an endpoint
        // per persisted stream and build EVERY output — always-produce.
        // Zero persisted streams ⇒ input-only pipeline: discovery runs before
        // any output exists, so the first PIDs appear without manual config.
        const outputs = [];
        for (const s of discoveredStreams(config)) {
            const ep = router.assignUdpPort(instanceId, pidPortId(s.pid));
            if (!ep) {
                this.setHealth('error', `UDP port pool exhausted while allocating ${pidPortId(s.pid)}`);
                return null;
            }
            outputs.push({ pid: s.pid, streamType: s.streamType, host: ep.host, port: ep.port });
        }

        const { pipeline, tsSplit } = buildSplitterPipeline({
            input: { host: upstream.host, port: upstream.port, socketPath: upstream.socketPath },
            outputs,
            tsId: (config.tsId as number) ?? 1,
        });
        return { pipeline, restartOnError: true, tsSplit };
    }

    async onStart(): Promise<void> {
        await super.onStart();
        const upstream = this.services?.mediaRouter?.getModuleUdpSource(
            this.services.instanceId,
            INPUT_PORT_ID,
        );
        if (upstream) this.setStatusData('input', { host: upstream.host, port: upstream.port });
        this.publishStatus();
    }

    async onStop(): Promise<void> {
        this.discovered.clear();
        await super.onStop();
    }

    protected onPluginEvent(channel: string, payload: unknown): void {
        if (channel !== 'tssplit:discovered') return;
        const streams = (payload as { streams?: Array<{ pid: number; streamType: number }> })?.streams;
        if (!Array.isArray(streams)) return;
        for (const s of streams) {
            const pid = Number(s.pid);
            const streamType = Number(s.streamType);
            if (!Number.isFinite(pid) || !Number.isFinite(streamType)) continue;
            const existing = this.discovered.get(pid);
            if (existing && existing.streamType === streamType) continue;
            const { media, codec } = streamTypeInfo(streamType);
            this.discovered.set(pid, { pid, streamType, media, codec });
        }
        // emitConfigUpdate persists + re-resolves dynamic ports, so a new PID
        // port appears in the UI without a reload. The pipeline is NOT
        // rebuilt here — the branch materializes when the port is first
        // wired (materializeProducerPort bounce).
        const next = mergeDiscovered(discoveredStreams(this.config), [...this.discovered.values()]);
        if (next) this.emitConfigUpdate({ discoveredStreams: next });
        this.publishStatus();
    }

    private publishStatus(): void {
        const streams = [...this.discovered.values()].sort((a, b) => a.pid - b.pid);
        this.setStatusData('streams', { detected: streams.length });
        this.setBadge('streams', {
            icon: 'git-fork',
            text: `${streams.length}`,
            color: streams.length > 0 ? '#10b981' : '#6b7280',
        });
        this.dynamicStatusSections = streams.map((s) => ({
            id: `stream-${s.pid}`,
            label: streamLabel(s.pid, s.streamType),
            fields: [
                { key: 'codec', label: 'Codec' },
                { key: 'pid', label: 'PID' },
            ],
        }));
        for (const s of streams) {
            this.setStatusData(`stream-${s.pid}`, { codec: s.codec, pid: formatPid(s.pid) });
        }
    }
}
