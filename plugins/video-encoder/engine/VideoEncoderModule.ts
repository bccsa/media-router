import {
    GstPluginBase,
    ProbedEncoders,
    ThroughputPoller,
    acquireV4l2Demand,
    bitrateBadge,
    buildBusSink,
    buildEncodeLeaf,
    buildScaleStage,
    buildV4l2ExtraControls,
    busTeeName,
    registerV4l2DeviceProvider,
    suspendV4l2Enumeration,
    releaseV4l2Demand,
    ENCODER_ELEMENTS,
    type CodecId,
    type EngineServices,
    type ImplId,
    type ModuleServices,
    type PipelineDescription,
    type ThroughputSample,
} from '@media-router/engine';
import { buildV4l2Source, supportsLiveBitrate } from './videoEncoderPipeline.js';
import { readEncoderKnobs } from './videoEncoderConfig.js';
import { encoderStatus, throughputStatus } from './videoEncoderStatus.js';

/**
 * How long V4L2 enumeration stays blacked out around a pipeline start: probe +
 * runner spawn + reach-PLAYING, with margin. See `suspendV4l2Enumeration`.
 */
const V4L2_SETUP_BLACKOUT_MS = 10_000;

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

    /** Bus egress element to poll for throughput, resolved at build time:
     *  the fan-out `tee` (busTeeName). */
    private busSinkName: string | undefined;

    /**
     * What this host can encode with — impls per codec plus hardware-scaler
     * availability, filled in by `initManifest`. The capture tail's scale
     * stage goes to the encoder impl's own scaler when it is installed
     * (`buildScaleStage`: v4l2convert on a Pi 4). Starts as the all-empty host
     * so a build before/without probing fails cleanly rather than naming an
     * encoder that isn't there.
     */
    static probed: ProbedEncoders = ProbedEncoders.unprobed();

    static registerServices(services: EngineServices): void {
        registerV4l2DeviceProvider(services);
    }

    /**
     * This instance's claim on the V4L2 enumeration cadence. Taken at
     * construction (an instance that is merely on the canvas still shows a
     * device picker) and dropped in `onDestroy`; while no instance exists the
     * provider stops paying for `v4l2-ctl` — see `v4l2DeviceProvider.ts`.
     */
    private v4l2DemandHeld = false;

    constructor() {
        super();
        acquireV4l2Demand();
        this.v4l2DemandHeld = true;
    }

    static async initManifest(manifest: Record<string, any>): Promise<void> {
        VideoEncoderModule.probed = await ProbedEncoders.probe(ENCODER_ELEMENTS, {
            probeHwScalers: true,
        });
        VideoEncoderModule.probed.applyToManifest(manifest);
    }

    /** Exposed for tests. */
    static getAvailableImpls(): Record<CodecId, ImplId[]> {
        return VideoEncoderModule.probed.availability;
    }

    /** Exposed for tests. */
    static setAvailableImpls(
        availability: Record<CodecId, ImplId[]>,
        hwScalers: { va: boolean; v4l2: boolean } = { va: false, v4l2: false },
    ): void {
        VideoEncoderModule.probed = ProbedEncoders.forTest(availability, hwScalers);
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
        this.services?.mediaRouter?.assignBusChannel(instanceId);

        // Black out V4L2 device enumeration around the pipeline start: any
        // concurrent /dev/video* open wedges the bcm2835 M2M setup or EINVALs
        // v4l2src's buffer allocation (reproduction on
        // `suspendV4l2Enumeration`). Here, not in `buildPipeline`: that is also
        // called from `refreshPipelineDescription`, which never re-enters V4L2
        // setup, and it runs for an UNCONFIGURED module too — which would
        // freeze the device picker for 10 s exactly while the operator is
        // browsing it for a device.
        if (this.config.device) suspendV4l2Enumeration(V4L2_SETUP_BLACKOUT_MS);

        await super.onStart();
        this.updateStatusData();
        this.throughput.start();
    }

    async onStop(): Promise<void> {
        this.throughput.stop();
        await super.onStop();
    }

    async onDestroy(): Promise<void> {
        // Guarded, so a double destroy can't drop another instance's claim.
        if (this.v4l2DemandHeld) {
            this.v4l2DemandHeld = false;
            releaseV4l2Demand();
        }
        await super.onDestroy();
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
        const knobs = readEncoderKnobs(config);
        const { codec } = knobs;
        const impl = VideoEncoderModule.probed.resolve(
            codec,
            config.encoderImpl as ImplId | 'auto' | undefined,
        );
        if (!impl) {
            this.setHealth(
                'error',
                `No encoder available for ${codec} — install a compatible GStreamer plugin`,
            );
            return null;
        }
        const {
            width,
            height,
            framerate,
            bitrateKbps,
            kif,
            rateControl,
            speedPreset,
            h264Profile,
            sceneCut,
            cpbSeconds,
        } = knobs;
        const scaleStage = buildScaleStage({
            width,
            height,
            impl,
            hwScalers: VideoEncoderModule.probed.hwScalers,
            threads: 2,
        });
        const source = buildV4l2Source(device, width, height, framerate, scaleStage);

        const instanceId = this.services?.instanceId ?? '';
        const endpoint = this.services?.mediaRouter?.getBusChannel(instanceId);
        this.busSinkName = endpoint ? busTeeName(endpoint.port) : undefined;
        const sink = endpoint ? buildBusSink(endpoint.port) : 'fakesink name=usink sync=false';

        // name 'venc0' keeps the Video Encoder's established element name; the
        // knobs come from `readEncoderKnobs` (validated, defaulted).
        //
        // `inputQueue: 'none'` — the leaf gets NO head queue, and nothing leaky
        // sits between mpegtsmux and the bus egress: a drop there is a
        // mid-stream TS slice and corrupts decode at the receiver. The
        // source→encoder boundary still has its own queue, placed by
        // `buildV4l2Source` immediately after v4l2src, where it's needed to
        // protect the V4L2 kernel ringbuffer from filling up under
        // back-pressure.
        const leaf = buildEncodeLeaf({
            encoder: {
                codec,
                impl,
                bitrateKbps,
                kif,
                name: 'venc0',
                rateControl,
                speedPreset,
                h264Profile,
                sceneCut,
                cpbSeconds,
            },
            inputQueue: 'none',
            muxName: 'mux',
            sink,
        });

        return {
            pipeline: `${source} ! ${leaf}`,
            restartOnError: true,
            // v4l2src head feeding the aggregator mpegtsmux: keep the time-sync
            // contract's monotonic house clock but NOT its base-time zeroing.
            // With base-time pinned to 0 the mux schedules off a running time
            // the size of the box's uptime while the live capture produces from
            // its own natural zero, and it releases video in GOP-sized ~2.3 s
            // bursts — every live consumer freezes on one frame. Full trace on
            // `PipelineDescription.liveCaptureClock`.
            liveCaptureClock: true,
        };
    }

    // --- internals ---

    private resolveCurrentImpl(): ImplId | null {
        const codec = (this.config.codec as CodecId) ?? 'h264';
        return VideoEncoderModule.probed.resolve(
            codec,
            this.config.encoderImpl as ImplId | 'auto' | undefined,
        );
    }

    private async applyLiveBitrate(kbps: number): Promise<void> {
        const codec = (this.config.codec as CodecId) ?? 'h264';
        const impl = this.resolveCurrentImpl();
        if (!impl || !supportsLiveBitrate(codec, impl)) return;
        // v4l2h264enc/v4l2h265enc only — `buildV4l2ExtraControls` writes the
        // FULL controls struct because the driver keeps only the last one
        // written; a partial write would silently reset the omitted fields to
        // driver defaults. The helper pins VBR (the only working bcm2835 mode).
        const v4l2Codec = codec === 'h265' ? 'h265' : 'h264';
        const kif = (this.config.keyframeInterval as number) ?? 60;
        await this.setElementProperty(
            'venc0',
            'extra-controls',
            buildV4l2ExtraControls(v4l2Codec, kbps * 1000, kif),
        );
    }

    private updateStatusData(): void {
        this.setStatusData('encoder', encoderStatus(this.config, this.resolveCurrentImpl()));
        const instanceId = this.services?.instanceId ?? '';
        const endpoint = this.services?.mediaRouter?.getBusChannel(instanceId);
        this.setStatusData('bus', { channel: endpoint?.port ?? 0 });
    }

    private async readSinkBytes(): Promise<number | undefined> {
        return this.busSinkName ? this.readBusSinkBytes(this.busSinkName) : undefined;
    }

    private publishThroughput(sample: ThroughputSample): void {
        this.setStatusData('throughput', throughputStatus(sample));
        this.setBadge('bitrate', bitrateBadge(sample.bitrateKbps));
    }
}
