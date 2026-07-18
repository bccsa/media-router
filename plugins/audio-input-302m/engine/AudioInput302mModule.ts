import {
    GstPluginBase,
    build302mEncodeBranch,
    buildUdpSink,
    type ModuleServices,
    type PipelineDescription,
} from '@media-router/engine';

/**
 * Audio Input (302M) plugin.
 *
 * Captures from a physical input device and emits SMPTE-302M PCM-in-TS —
 * the timeline-DEFINING ingest point for live sources: a physical signal
 * has no inherent timeline, so capture time (pipeline clock, deterministic
 * given the fixed `srcBufferMs` ring) becomes its PTS. Everything
 * downstream of this module is timeline-carrying GStreamer — no PipeWire
 * routing, no re-stamping.
 *
 * Follow-up (recorded, not v1): shared-clock stamping + a configurable
 * `ingestOffsetMs` for exact cross-source alignment.
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
        Object.assign(this.config, changes);
        if ('volume' in changes || 'audioEnabled' in changes) {
            const audioOff = (this.config.audioEnabled as boolean) === false;
            const volumePct = audioOff ? 0 : ((this.config.volume as number) ?? 100);
            await this.setElementProperty('vol', 'volume', volumePct / 100).catch((err) => {
                this.log.debug({ err }, 'Volume update failed (pipeline may not be running)');
            });
        }
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const router = this.services?.mediaRouter;
        const instanceId = this.services?.instanceId ?? '';
        if (!router) return null;

        const device = (config.device as string) ?? '';
        if (!device) {
            // Broadcast rule: never fall back to a default device.
            this.setHealth('error', 'No audio device configured');
            return null;
        }

        const endpoint = router.assignUdpPort(instanceId);
        if (!endpoint) {
            this.setHealth('error', 'No free UDP ports available');
            return null;
        }

        const audioOff = (config.audioEnabled as boolean) === false;
        const volumePct = audioOff ? 0 : ((config.volume as number) ?? 100);
        const srcBufferUs =
            Math.max(40, Math.min(1000, Number(config.srcBufferMs ?? 60))) * 1000;
        const sink = buildUdpSink({ name: 'usink', host: endpoint.host, port: endpoint.port });

        const pipeline =
            `pulsesrc device=${device} buffer-time=${srcBufferUs}` +
            ` ! audioconvert ! volume name=vol volume=${(volumePct / 100).toFixed(2)}` +
            ' ! level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000' +
            ` ! ${build302mEncodeBranch()} ! ${sink}`;

        this.setStatusData('input', { device });
        this.setStatusData('udp', { host: endpoint.host, port: endpoint.port });
        this.setHealth('ok');

        return {
            pipeline,
            restartOnError: true,
        };
    }
}
