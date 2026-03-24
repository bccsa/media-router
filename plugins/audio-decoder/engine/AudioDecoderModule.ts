import { GstPluginBase, type PipelineDescription, type ModuleServices, probeMpegTsStream, type ProbeResult } from '@media-router/engine';

/**
 * Audio Decoder plugin.
 *
 * Receives MPEG-TS via UDP multicast (from an encoder or SRT source),
 * probes the stream to detect the codec, then builds the appropriate
 * decode pipeline. Outputs PCM to a named null-sink.
 */
export class AudioDecoderModule extends GstPluginBase {
    protected liveUpdatableParams = ['volume', 'audioEnabled'];
    /** Probed stream info — plugin decides what to do with it. */
    private probeResult: ProbeResult | null = null;

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
    }

    async onStart(): Promise<void> {
        // Create a named null-sink — decoded audio goes here
        if (this.services?.pipeWire) {
            this.paModuleId = await this.services.pipeWire.loadNullSink(
                this.services.instanceId, 2, 48000, this.services.instanceId,
            );
        }

        // Detect codec — use encoder's config if available, otherwise probe the stream
        const instanceId = this.services?.instanceId ?? '';
        const udpSource = this.services?.mediaRouter?.getModuleUdpSource(instanceId);
        if (udpSource?.codec) {
            // Local encoder — codec is known, skip probe for instant startup
            this.probeResult = { codec: udpSource.codec as any, rawCaps: '' };
        } else if (udpSource) {
            // External/unknown source — probe the stream
            this.probeResult = await probeMpegTsStream(udpSource.host, udpSource.port, 3000);
        } else {
            this.probeResult = null;
        }

        await super.onStart();
    }

    async onStop(): Promise<void> {
        await super.onStop();
        this.probeResult = null;
        // PipeWire cleanup is automatic via ownership tracking
    }

    async onLiveConfigUpdate(changes: Record<string, unknown>): Promise<void> {
        Object.assign(this.config, changes);
        if ('volume' in changes || 'audioEnabled' in changes) {
            const audioOff = (this.config.audioEnabled as boolean) === false;
            const volumePct = audioOff ? 0 : ((this.config.volume as number) ?? 100);
            const gstVol = volumePct / 100;
            await this.setElementProperty('vol', 'volume', gstVol).catch(() => {});
            if (this.services?.pipeWire) {
                await this.services.pipeWire.setSinkVolume(this.pwNodeName, volumePct);
            }
        }
    }

    getPipeWireNodes(): { source?: string; sink?: string } {
        // Other modules read from our null-sink's monitor
        return { source: `${this.pwNodeName}.monitor` };
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        const volumePct = (config.volume as number) ?? 100;
        const gstVolume = (volumePct / 100).toFixed(2);

        // Check if we have a UDP source assigned by MediaRouter
        const instanceId = this.services?.instanceId ?? '';
        const udpSource = this.services?.mediaRouter?.getModuleUdpSource(instanceId);

        if (!udpSource) {
            this.setHealth('warning', 'No encoder connected');
            return null;
        }

        // Multicast (239.x) uses multicast-group, unicast (127.x) uses plain port binding
        const isMulticast = udpSource.host.startsWith('239.');
        const udpSrc = isMulticast
            ? `udpsrc multicast-group=${udpSource.host} port=${udpSource.port} multicast-iface=lo auto-multicast=true buffer-size=2097152`
            : `udpsrc port=${udpSource.port} buffer-size=2097152`;

        // Plugin decides decoder based on probe result
        let decoder: string;
        switch (this.probeResult?.codec) {
            case 'opus': decoder = 'opusdec'; break;
            case 'aac': decoder = 'avdec_aac'; break;
            case 'mp2': decoder = 'mpegaudioparse ! mpg123audiodec'; break;
            case 'ac3': decoder = 'a52dec'; break;
            default: decoder = 'decodebin'; break; // fallback for unknown
        }

        // pulsesink slave-method: 0=resample (absorbs clock drift), 1=skew (adjusts timestamps)
        // Resample prevents latency buildup over hours — proven stable in v1 over 12+ hour sessions.
        const slaveMethod = (config.slaveMethod as number) ?? 0;

        const parts = [
            `${udpSrc} ! tsdemux latency=0 ! ${decoder}`,
            'audioconvert',
            `volume name=vol volume=${gstVolume}`,
            'level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000',
            `pulsesink device=${this.pwNodeName} sync=false slave-method=${slaveMethod} processing-deadline=40000000 buffer-time=50000 max-lateness=40000000`,
        ];
        const pipeline = parts.join(' ! ');

        return {
            pipeline,
            liveElements: { vol: ['volume'] },
            restartOnError: true,
        };
    }
}
