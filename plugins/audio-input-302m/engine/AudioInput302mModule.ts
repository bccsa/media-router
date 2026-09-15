import {
    GstPluginBase,
    buildBusSink,
    pulsePinnedStreamProps,
    StreamPortLinker,
    type ChannelMapEntry,
    type ModuleServices,
    type PipelineDescription,
    type StreamLinkDeps,
    type StreamLinkResult,
    type StreamLinkSpec,
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
 * Capture is a `pipewiresrc` stream exactly `channels` wide, unpositioned,
 * created with `node.autoconnect=false`, and the ENGINE links its ports to the
 * device's ports by channel index (`StreamPortLinker`, ADR-0014 amendment
 * 2026-09-15). WirePlumber links by channel POSITION, and a ≤ 8-channel
 * stream's FL/FR/… defaults never match a multichannel card's AUX names — the
 * first cut answered that by capturing the WHOLE device unpositioned and
 * matrixing the range out, which on an X32 made every stereo module a
 * 32-port stream (288 daemon links, ~2 MB of PipeWire scratch per port,
 * 30 MB per runner; measured 10.9.16.50, 2026-09-15). Explicit links cost
 * nothing per unused channel. `pulsesrc` remains a dead end past stereo
 * (pipewire-pulse refuses an 8-channel record stream).
 *
 * Narrow devices. 302M has no mono width, but PipeWire's UCM split exposes
 * some interfaces as 1-channel sources (an SSL 2's Mic1/Mic2, field 2026-09-08),
 * so a range that runs PAST the device is honoured rather than refused:
 *   - ONE device channel into the stereo pair → dual-mono: the same device
 *     port linked to both 302M channels (`dualMono` in status). A mono mic
 *     belongs in both ears / centred in a stereo mix, not in the left channel
 *     only (the first cut did that; the booth heard Mic 2 on one side).
 *   - anything wider → the device channels that exist are linked and the
 *     remaining 302M channels stay unlinked, i.e. silent (`silentChannels`).
 * Only a range that starts beyond the device is an error — there is nothing
 * to capture at all.
 *
 * - Volume/mute: gst `volume` element. VU: in-pipeline `level`.
 * - Device hot-plug: base-class watchdog stops/starts the pipeline.
 * - NEVER a default device: unconfigured = health error, no pipeline.
 */
/** GStreamer's default channel layouts for the 302M widths (FL FR / +RL RR / 5.1 / 7.1). */
const POSITIONED_MASK: Record<number, string> = { 2: '0x3', 4: '0x33', 6: '0x3f', 8: '0x63f' };

export class AudioInput302mModule extends GstPluginBase {
    protected liveUpdatableParams = ['volume', 'audioEnabled'];

    private deviceName = '';
    /** Device links for the pipeline `buildPipeline` last described; null = none to make. */
    private linkPlan: StreamLinkSpec | null = null;
    private linkWarning = false;
    /** Test seam for the linker's `pw-dump` / `pw-link`. */
    protected linkDeps?: StreamLinkDeps;
    private readonly linker = new StreamPortLinker({
        getPlan: () => this.linkPlan,
        deps: () => this.linkDeps,
        onResult: (result, plan) => this.onLinked(result, plan),
        onError: (err) => this.log.warn({ err }, 'Could not link the capture stream to its device'),
    });

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
        // Link WHILE the pipeline starts, not after: pipewiresrc finishes
        // negotiating only once its stream is linked and running, so a link
        // made after start would wait on the start that waits on the link.
        // buildPipeline (which sets the plan) runs synchronously inside
        // super.onStart() before its first await.
        const started = super.onStart();
        void this.linker.ensure();
        await started;
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
        const started = super.onStart();
        void this.linker.ensure();
        await started;
    }

    /** Every PLAYING — including a runner-internal restart, which re-creates
     *  the stream node and so needs its device links made again. */
    protected onPipelinePlaying(): void {
        void this.linker.ensure();
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
        this.linkPlan = null;
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
        const { silentChannels, dualMono } = capture;

        const endpoint = router.assignBusChannel(instanceId);
        if (!endpoint) {
            this.setHealth('error', 'No free UDP ports available');
            return null;
        }

        const audioOff = (config.audioEnabled as boolean) === false;
        const volumePct = audioOff ? 0 : ((config.volume as number) ?? 100);
        const sink = buildBusSink(endpoint.port);

        const pipeline =
            `${capture.clause}` +
            ` ! volume name=vol volume=${(volumePct / 100).toFixed(2)}` +
            ' ! level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000' +
            ` ! ${build302mEncodeBranch({ channels })} ! ${sink}`;

        this.linkPlan = capture.plan;
        this.setStatusData('input', {
            device,
            channels,
            firstChannel,
            lastChannel: firstChannel - 1 + channels,
            ...(deviceChannels ? { deviceChannels } : {}),
            ...(silentChannels > 0 ? { silentChannels } : {}),
            ...(dualMono ? { dualMono: true } : {}),
        });
        this.setStatusData('bus', { channel: endpoint.port });
        this.setHealth('ok');

        return {
            pipeline,
            restartOnError: true,
        };
    }

    /**
     * `pipewiresrc` stream `channels` wide on the device, plus the plan that
     * links stream channel k to device channel `firstChannel-1+k`. A single
     * available channel into a stereo stream is duplicated (`dualMono`);
     * otherwise channels past the device's width stay unlinked and come out
     * silent (`silentChannels` says how many). Null (with the health error
     * set) when nothing in the range exists on the device.
     */
    private buildCapture(o: {
        device: string;
        channels: number;
        /** 1-based first device channel. */
        firstChannel: number;
        /** Device width as PipeWire reports it; null when not enumerated. */
        deviceChannels: number | null;
        srcBufferMs: number;
    }): { clause: string; silentChannels: number; dualMono: boolean; plan: StreamLinkSpec } | null {
        const { device, channels, firstChannel, deviceChannels } = o;
        const lastChannel = firstChannel - 1 + channels;
        if (deviceChannels && deviceChannels > 0 && firstChannel > deviceChannels) {
            this.setHealth(
                'error',
                `Audio device "${device}" has ${deviceChannels} channel${deviceChannels === 1 ? '' : 's'} — ` +
                    `cannot capture ${firstChannel}–${lastChannel}`,
            );
            return null;
        }
        // Requested graph quantum — the capture-side standing latency knob
        // (`node.latency` is a request; the graph driver has the final say).
        // Ceiling 85 ms = 4096 samples = `default.clock.quantum-limit` in the
        // image's pipewire config (10-realtime*.conf); PipeWire clamps anything
        // above it to the limit, so the setting is capped here to say so.
        const quantum = Math.round(Math.max(40, Math.min(85, o.srcBufferMs)) * 48);
        // `node.autoconnect=false`: WirePlumber must not link this stream (it
        // would take the first N device ports by position); the engine does.
        const src =
            `pipewiresrc target-object=${device}` +
            ` ${pulsePinnedStreamProps({
                'node.latency': `${quantum}/48000`,
                'node.name': this.pwNodeName,
                'node.autoconnect': 'false',
            })}`;
        // Unpositioned → ports input_1..N, linked by index below. `avenc_s302m`
        // refuses a stream without a channel layout, and audioconvert neither
        // invents positions for an unpositioned input without a mix-matrix nor
        // adds them when an equal-count identity leaves the layout untouched —
        // so both the identity matrix AND an explicit mask are needed (bare
        // pipelines on gst 1.28.2, 2026-09-15). The mask is GStreamer's default
        // layout for N; 302M carries plain PCM pairs, positions mean nothing.
        const identity: ChannelMapEntry[] = Array.from({ length: channels }, (_, i) => ({
            srcChannel: i,
            dstChannel: i,
        }));
        const clause =
            `${src} ! audio/x-raw,channels=${channels},channel-mask=(bitmask)0x0` +
            ` ! audioconvert${mixMatrixClause(identity, channels, channels)}` +
            ` ! audio/x-raw,channels=${channels},channel-mask=(bitmask)${POSITIONED_MASK[channels] ?? '0x0'}`;

        const available =
            deviceChannels && deviceChannels > 0
                ? Math.min(channels, deviceChannels - firstChannel + 1)
                : channels;
        // One channel into the stereo pair → dual-mono (see class comment).
        const dualMono = available === 1 && channels === 2;
        return {
            clause,
            silentChannels: dualMono ? 0 : channels - available,
            dualMono,
            plan: {
                streamNode: this.pwNodeName,
                direction: 'capture',
                deviceNode: device,
                firstIndex: firstChannel - 1,
                channels,
                ...(dualMono ? { dualMono: true } : {}),
            },
        };
    }

    private onLinked(result: StreamLinkResult, plan: StreamLinkSpec): void {
        const expected = plan.channels;
        this.setStatusData('links', { linked: result.linked, expected, silent: result.missing });
        if (result.streamPorts === 0) {
            this.linkWarning = true;
            this.setHealth(
                'warning',
                'Capture stream did not appear in PipeWire — no device links made',
            );
        } else if (result.linked === 0 && result.missing > 0) {
            this.linkWarning = true;
            this.setHealth(
                'warning',
                `Audio device "${plan.deviceNode}" has no channels at ${plan.firstIndex + 1}–${plan.firstIndex + expected}`,
            );
        } else if (result.linked + result.missing < expected) {
            this.linkWarning = true;
            this.setHealth('warning', `Linked ${result.linked} of ${expected} device channels`);
        } else if (this.linkWarning) {
            this.linkWarning = false;
            this.setHealth('ok');
        }
    }
}
