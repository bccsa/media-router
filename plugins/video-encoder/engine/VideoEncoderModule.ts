import {
    GstPluginBase,
    ThroughputPoller,
    buildUdpSink,
    listV4l2Devices,
    ENCODER_ELEMENTS,
    buildEncoderBranch,
    resolveImpl,
    probeEncoderAvailability,
    applyEncoderAvailabilityToManifest,
    type CodecId,
    type EngineServices,
    type ImplId,
    type ModuleServices,
    type PipelineDescription,
    type ThroughputSample,
} from '@media-router/engine';
import {
    buildV4l2Source,
    liveElementProps,
    parseResolution,
    supportsLiveBitrate,
} from './videoEncoderPipeline.js';

/**
 * Video Encoder plugin.
 *
 * Captures from a V4L2 device, encodes to the selected codec (H.264/H.265/AV1),
 * muxes into MPEG-TS, and sends to a UDP multicast port assigned by the
 * MediaRouter — same transport as AudioEncoder so existing routing works
 * unchanged. Owns the `video` device type (enumerated via v4l2-ctl).
 *
 * Audio lives in a separate AudioEncoder module on purpose; an MpegTsMuxer
 * plugin will later combine the two into one stream.
 */
export class VideoEncoderModule extends GstPluginBase {
    /** Output-bitrate poller on the single udpsink. */
    private readonly throughput = new ThroughputPoller({
        getBytes: () => this.readSinkBytes(),
        publish: (sample) => this.publishThroughput(sample),
    });

    /** Runtime availability map — populated by `initManifest` after probing each encoder element. */
    private static availableImpls: Record<CodecId, ImplId[]> = { h264: [], h265: [], av1: [] };

    static registerServices(services: EngineServices): void {
        services.deviceProviders.register({
            type: 'video',
            list: () => listV4l2Devices(),
            pollMs: 2000,
        });
    }

    static async initManifest(manifest: Record<string, any>): Promise<void> {
        const availability = await probeEncoderAvailability(ENCODER_ELEMENTS);
        VideoEncoderModule.availableImpls = availability;
        applyEncoderAvailabilityToManifest(manifest, availability);
    }

    /** Exposed for tests. */
    static getAvailableImpls(): Record<CodecId, ImplId[]> {
        return VideoEncoderModule.availableImpls;
    }

    /** Exposed for tests. */
    static setAvailableImpls(availability: Record<CodecId, ImplId[]>): void {
        VideoEncoderModule.availableImpls = availability;
    }

    /**
     * Live params depend on the resolved encoder. AV1 (svtav1enc) needs a
     * pipeline rebuild for bitrate changes, so we narrow to `[]` there and
     * route the change through `pendingRestart` instead.
     */
    getLiveUpdatableParams(): string[] {
        const codec = (this.config.codec as CodecId) ?? 'h264';
        const impl = this.resolveCurrentImpl();
        return impl && supportsLiveBitrate(codec, impl) ? ['bitrate'] : [];
    }

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
    }

    async onStart(): Promise<void> {
        const instanceId = this.services?.instanceId ?? '';
        this.services?.mediaRouter?.assignUdpPort(instanceId);

        await super.onStart();
        this.updateStatusData();
        this.throughput.start();
    }

    async onStop(): Promise<void> {
        this.throughput.stop();
        await super.onStop();
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        Object.assign(this.config, changes);
        if ('bitrate' in changes) {
            await this.applyLiveBitrate(changes.bitrate as number);
        }
        this.updateStatusData();
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const device = (config.device as string) ?? '';
        if (!device) {
            this.setHealth('warning', 'No V4L2 device selected');
            return null;
        }
        const codec = (config.codec as CodecId) ?? 'h264';
        const impl = resolveImpl(
            codec,
            (config.encoderImpl as ImplId | 'auto') ?? 'auto',
            VideoEncoderModule.availableImpls[codec] ?? [],
        );
        if (!impl) {
            this.setHealth(
                'error',
                `No encoder available for ${codec} — install a compatible GStreamer plugin`,
            );
            return null;
        }
        const { width, height } = parseResolution((config.resolution as string) ?? '1920x1080');
        const framerate = (config.framerate as number) ?? 30;
        const bitrateKbps = (config.bitrate as number) ?? 4000;
        const kif = (config.keyframeInterval as number) ?? 60;

        const source = buildV4l2Source(device, width, height, framerate);
        // name 'venc0' + speed-preset 'superfast' keep the Video Encoder's
        // established behaviour; the shared builder's other knobs stay at their
        // defaults (CBR, auto profile, scenecut 40 — x264's own default).
        const encoder = buildEncoderBranch({
            codec,
            impl,
            bitrateKbps,
            kif,
            name: 'venc0',
            speedPreset: 'superfast',
        });

        const instanceId = this.services?.instanceId ?? '';
        const endpoint = this.services?.mediaRouter?.getUdpEndpoint(instanceId);
        const udpSink = endpoint
            ? buildUdpSink({ name: 'usink', host: endpoint.host, port: endpoint.port })
            : 'fakesink name=usink sync=false';

        // No leaky queue between mpegtsmux and udpsink: any drop here is a
        // mid-stream UDP buffer (~1316 B = 7 TS packets) and corrupts decode
        // at the receiver. The 2 MB kernel UDP send buffer absorbs typical
        // bursts on its own. The source→encoder boundary still has its own
        // queue placed by `buildV4l2Source` immediately after v4l2src, where
        // it's needed to protect the V4L2 kernel ringbuffer from filling up
        // under back-pressure.
        const pipeline = `${source} ! ${encoder} ! mpegtsmux name=mux latency=0 alignment=7 ! ${udpSink}`;

        return {
            pipeline,
            liveElements: { venc0: liveElementProps(codec, impl) },
            restartOnError: true,
        };
    }

    // --- internals ---

    private resolveCurrentImpl(): ImplId | null {
        const codec = (this.config.codec as CodecId) ?? 'h264';
        return resolveImpl(
            codec,
            (this.config.encoderImpl as ImplId | 'auto') ?? 'auto',
            VideoEncoderModule.availableImpls[codec] ?? [],
        );
    }

    private async applyLiveBitrate(kbps: number): Promise<void> {
        const codec = (this.config.codec as CodecId) ?? 'h264';
        const impl = this.resolveCurrentImpl();
        if (!impl || !supportsLiveBitrate(codec, impl)) return;
        // v4l2h264enc/v4l2h265enc only — the V4L2 driver stores the full
        // controls struct from the last `extra-controls` write, so we must
        // re-assert `video_bitrate_mode=1` (CBR) every time. Dropping it here
        // silently reverts to whatever default the driver chose (typically
        // VBR), which defeats the rate-control set up at build time.
        const key = codec === 'h265' ? 'h265_i_frame_period' : 'h264_i_frame_period';
        const kif = (this.config.keyframeInterval as number) ?? 60;
        await this.setElementProperty(
            'venc0',
            'extra-controls',
            `controls,video_bitrate=${kbps * 1000},video_bitrate_mode=1,${key}=${kif}`,
        );
    }

    private updateStatusData(): void {
        const codec = (this.config.codec as CodecId) ?? 'h264';
        const impl = this.resolveCurrentImpl();
        const resolution = (this.config.resolution as string) ?? '1920x1080';
        const fps = (this.config.framerate as number) ?? 30;
        this.setStatusData('encoder', {
            codec,
            impl: impl ?? 'unavailable',
            resolution,
            framerate: `${fps} fps`,
        });
        const instanceId = this.services?.instanceId ?? '';
        const endpoint = this.services?.mediaRouter?.getUdpEndpoint(instanceId);
        this.setStatusData('udp', {
            host: endpoint?.host ?? '—',
            port: endpoint?.port ?? 0,
        });
    }

    private async readSinkBytes(): Promise<number | undefined> {
        const served = await this.getElementProperty('usink', 'bytes-served');
        return typeof served === 'number' ? served : undefined;
    }

    private publishThroughput(sample: ThroughputSample): void {
        this.setStatusData('throughput', {
            'Output Bitrate': `${sample.bitrateKbps} kbps`,
            'Total Bytes': `${(sample.totalBytes / 1024 / 1024).toFixed(1)} MB`,
        });
    }
}
