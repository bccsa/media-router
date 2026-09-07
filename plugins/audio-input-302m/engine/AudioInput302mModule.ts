import {
    GstPluginBase,
    buildBusSink,
    type ChannelMapEntry,
    type ModuleServices,
    type PipelineDescription,
} from '@media-router/engine';
import {
    build302mEncodeBranch,
    mixMatrixClause,
    normalize302mChannels,
} from '@media-router/plugin-audio-302m-core';

/**
 * Audio Input (302M) plugin.
 *
 * Captures from a physical input device and emits SMPTE-302M PCM-in-TS —
 * the timeline-DEFINING ingest point for live sources: a physical signal
 * has no inherent timeline, so capture time (pipeline running time at
 * capture) becomes its PTS. Everything downstream of this module is
 * timeline-carrying GStreamer — no PipeWire routing, no re-stamping.
 *
 * Channel range. A 302M stream carries 2/4/6/8 channels (the format's
 * ceiling, not ours), so a wide desk is several of these modules: `channels`
 * picks the stream width and `firstChannel` (1-based) where on the device it
 * starts — an X32's 32 inputs are four modules at 8 channels, first channel
 * 1 / 9 / 17 / 25.
 *
 * Capture is `pipewiresrc` on the WHOLE device, then an `audioconvert
 * mix-matrix` selects the range. Two field facts force that shape (measured
 * 2026-09-05 against an X32's KT-USB card, 48 capture channels named
 * AUX0..AUX47, PipeWire 1.6.3):
 *   - `pulsesrc` is a dead end past stereo: pipewire-pulse refuses to create
 *     an 8-channel record stream at all ("Invalid argument"), and links a
 *     4-channel one to AUX0/AUX1 only.
 *   - PipeWire links by channel POSITION. A stream of ≤ 8 channels gets
 *     default positions (FL, FR, …) that never match a multichannel card's
 *     AUX names, so only the first two ports link. A stream asking for the
 *     card's full width with `channel-mask=0x0` stays unpositioned and is
 *     linked port-for-port in index order — all 48 of them.
 * So: full width in, matrix out. Selecting 8 of 48 costs one small matrix
 * multiply; a stereo device is captured as-is with no matrix.
 *
 * - Volume/mute: gst `volume` element. VU: in-pipeline `level`.
 * - Device hot-plug: base-class watchdog stops/starts the pipeline.
 * - NEVER a default device: unconfigured = health error, no pipeline.
 */
export class AudioInput302mModule extends GstPluginBase {
    protected liveUpdatableParams = ['volume', 'audioEnabled'];

    private deviceName = '';

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
        this.deviceName = (config.device as string) ?? '';
    }

    async onStart(): Promise<void> {
        if (!this.deviceName) {
            throw new Error('No audio device configured');
        }
        if (this.services?.pipeWire && !this.services.pipeWire.hasDevice(this.deviceName)) {
            this.setHealth(
                'warning',
                `Audio device "${this.deviceName}" not connected — waiting for hot-plug`,
            );
            this.startDeviceWatchdog(false);
            return;
        }
        await super.onStart();
        this.startDeviceWatchdog();
    }

    async onStop(): Promise<void> {
        await this.stopDeviceWatchdog();
        await super.onStop();
    }

    protected getWatchedDeviceName(): string | null {
        return this.deviceName || null;
    }

    protected async onDeviceDisconnected(): Promise<void> {
        try {
            await super.onStop();
        } catch {
            /* already stopped */
        }
    }

    protected async onDeviceReconnected(): Promise<void> {
        await super.onStart();
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        await this.applyVolumeLiveUpdate(changes);
    }

    /** The 302M wire width this instance encodes — consumers size their
     *  channel-map matrices from it (`MediaRouter.getModuleBusSources`). */
    getBusStreamChannels(portId: string): number | undefined {
        return portId === 'audio-out'
            ? normalize302mChannels(Number(this.config.channels ?? 2))
            : undefined;
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        if (!router) return null;

        const device = (config.device as string) ?? '';
        if (!device) {
            this.setHealth('error', 'No audio device configured');
            return null;
        }

        const channels = normalize302mChannels(Number(config.channels ?? 2));
        const firstChannel = Math.max(1, Math.trunc(Number(config.firstChannel ?? 1)) || 1);
        const deviceChannels = this.services?.pipeWire?.getDeviceInfo(device)?.channels ?? null;

        const capture = this.buildCapture({
            device,
            channels,
            firstChannel,
            deviceChannels,
            srcBufferMs: Number(config.srcBufferMs ?? 60),
        });
        if (!capture) return null;

        const endpoint = router.assignBusChannel(instanceId);
        if (!endpoint) {
            this.setHealth('error', 'No free UDP ports available');
            return null;
        }

        const audioOff = (config.audioEnabled as boolean) === false;
        const volumePct = audioOff ? 0 : ((config.volume as number) ?? 100);
        const sink = buildBusSink(endpoint.port);

        const pipeline =
            `${capture}` +
            ` ! volume name=vol volume=${(volumePct / 100).toFixed(2)}` +
            ' ! level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000' +
            ` ! ${build302mEncodeBranch({ channels })} ! ${sink}`;

        this.setStatusData('input', {
            device,
            channels,
            firstChannel,
            lastChannel: firstChannel - 1 + channels,
            ...(deviceChannels ? { deviceChannels } : {}),
        });
        this.setStatusData('bus', { channel: endpoint.port });
        this.setHealth('ok');

        return {
            pipeline,
            restartOnError: true,
        };
    }

    /**
     * `pipewiresrc` on the device → `channels`-wide raw audio holding device
     * channels `firstChannel..firstChannel+channels-1`. Null (with the health
     * error set) when the range cannot be honoured. See the class comment for
     * why the full device width is captured and then matrixed.
     */
    private buildCapture(o: {
        device: string;
        channels: number;
        /** 1-based first device channel. */
        firstChannel: number;
        /** Device width as PipeWire reports it; null when not enumerated. */
        deviceChannels: number | null;
        srcBufferMs: number;
    }): string | null {
        const { device, channels, firstChannel, deviceChannels } = o;
        const lastChannel = firstChannel - 1 + channels;
        // Requested graph quantum — the capture-side standing latency knob
        // (`node.latency` is a request; the graph driver has the final say).
        const quantum = Math.round(Math.max(40, Math.min(1000, o.srcBufferMs)) * 48);
        const src =
            `pipewiresrc target-object=${device}` +
            ` stream-properties="props,node.latency=(string)${quantum}/48000"`;

        if (deviceChannels && deviceChannels > 0) {
            if (lastChannel > deviceChannels) {
                this.setHealth(
                    'error',
                    `Audio device "${device}" has ${deviceChannels} channels — ` +
                        `cannot capture ${firstChannel}–${lastChannel}`,
                );
                return null;
            }
            // Whole device, unpositioned → PipeWire links every port in index order.
            const wide = `audio/x-raw,channels=${deviceChannels},channel-mask=(bitmask)0x0`;
            if (firstChannel === 1 && channels === deviceChannels) {
                return `${src} ! ${wide} ! audioconvert`;
            }
            const pick: ChannelMapEntry[] = Array.from({ length: channels }, (_, i) => ({
                srcChannel: firstChannel - 1 + i,
                dstChannel: i,
            }));
            const matrix = mixMatrixClause(pick, deviceChannels, channels);
            return `${src} ! ${wide} ! audioconvert${matrix} ! audio/x-raw,channels=${channels}`;
        }

        // Device width unknown — PipeWire has not enumerated it (unplugged,
        // renamed, or the name is stale). Stereo from the first two channels is
        // what a positioned FL/FR stream always yields, so the default range
        // still comes up; anything wider needs the width.
        if (firstChannel === 1 && channels === 2) {
            return `${src} ! audio/x-raw,channels=2 ! audioconvert`;
        }
        this.setHealth(
            'error',
            `Audio device "${device}" is not enumerated by PipeWire, so its channel ` +
                `count is unknown — needed to capture ${firstChannel}–${lastChannel}. ` +
                'Check the device is connected and re-pick it from the list.',
        );
        return null;
    }
}
