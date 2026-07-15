import {
    GstPluginBase,
    buildUdpSrc,
    type PipelineDescription,
    type ModuleServices,
    probeMpegTsStream,
    type ProbeResult,
} from '@media-router/engine';

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
        const instanceId = this.services?.instanceId ?? '';
        const udpSource = this.services?.mediaRouter?.getModuleUdpSource(instanceId);

        // 1. Probe the stream for codec (and channels if available — opus includes it, AAC doesn't)
        if (udpSource) {
            this.probeResult = await probeMpegTsStream(
                udpSource.host,
                udpSource.port,
                3000,
                udpSource.socketPath,
            );
            this.log.info(
                { codec: this.probeResult.codec, channels: this.probeResult.channels },
                'Stream probe',
            );
        } else {
            this.probeResult = null;
        }

        // 2. Resolve channel count from multiple sources (first available wins):
        //    - Stream probe caps (reliable for opus, unavailable for AAC/ADTS)
        //    - Upstream encoder config (available after encoder starts — getModuleUdpSource reads it)
        //    - Stored decoder config (from previous run's emitConfigUpdate)
        //    - Default: 2
        const probedCh = this.probeResult?.channels;
        const encoderCh = udpSource?.channels;
        const storedCh = this.config.channels as number | undefined;
        const channels = probedCh ?? encoderCh ?? storedCh ?? 2;
        const rate = this.probeResult?.sampleRate ?? (this.config.sampleRate as number) ?? 48000;
        this.log.info(
            { probedCh, encoderCh, storedCh, resolved: channels, rate },
            'Channel resolution',
        );

        // 3. Create null-sink with resolved channel count
        if (this.services?.pipeWire) {
            this.paModuleId = await this.services.pipeWire.loadNullSink(
                this.services.instanceId,
                channels,
                rate,
                this.services.instanceId,
            );
            // Force 100% volume — PulseAudio's stream-restore may remember 0% from a previous session
            await this.services.pipeWire.setSinkVolume(this.pwNodeName, 100);
        }

        // 4. Update config and notify UI if changed
        if (channels !== storedCh) {
            this.emitConfigUpdate({ channels });
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
            // Volume controlled via GStreamer element only — no pactl to avoid double-attenuation
            await this.setElementProperty('vol', 'volume', volumePct / 100).catch((err) => {
                this.log.debug({ err }, 'Volume update failed (pipeline may not be running)');
            });
        }
    }

    getPipeWireNodes(): { source?: string; sink?: string } {
        // Other modules read from our null-sink's monitor
        return { source: `${this.pwNodeName}.monitor` };
    }

    buildPipeline(config: Record<string, unknown>): PipelineDescription | null {
        // Respect audioEnabled on start — otherwise a muted module unmutes
        // itself when restarted (gst volume element starts at config.volume).
        const audioOff = (config.audioEnabled as boolean) === false;
        const volumePct = audioOff ? 0 : ((config.volume as number) ?? 100);
        const gstVolume = (volumePct / 100).toFixed(2);

        // Check if we have a UDP source assigned by MediaRouter
        const instanceId = this.services?.instanceId ?? '';
        const udpSource = this.services?.mediaRouter?.getModuleUdpSource(instanceId);

        if (!udpSource) {
            this.setHealth('warning', 'No encoder connected');
            return null;
        }

        // 256 KB kernel buffer (was 64 KB). Bigger headroom against short
        // scheduler hiccups without any latency cost — kernel UDP receive
        // buffer is purely a back-pressure safety net, not a steady-state
        // delay. The leaky queue after `tsdemux` still bounds latency.
        const udpSrc = buildUdpSrc({
            host: udpSource.host,
            port: udpSource.port,
            bufferSize: 262_144,
            socketPath: udpSource.socketPath,
        });

        // Plugin decides decoder based on probe result.
        //
        // Each decoder is fed straight off a `tsdemux` src pad, which emits
        // *unframed* elementary streams. These software decoders need whole,
        // framed access units, so a codec parser MUST sit between tsdemux and
        // the decoder — without it `avdec_aac` errors "Input buffer exhausted
        // before END element found" on every buffer and the pipeline
        // crash-loops (seen on a clean single-AAC RIST feed: null-sink idle,
        // gst-runner flapping). The `default` (decodebin) branch is safe
        // because decodebin auto-plugs the parser; the explicit branches must
        // add it themselves. opus is the exception — tsdemux already emits
        // muxer/decoder-ready opus caps, so opusdec needs no parser.
        let decoder: string;
        switch (this.probeResult?.codec) {
            case 'opus':
                decoder = 'opusdec';
                break;
            case 'aac':
                decoder = 'aacparse ! avdec_aac';
                break;
            case 'mp2':
                decoder = 'mpegaudioparse ! mpg123audiodec';
                break;
            case 'ac3':
                decoder = 'ac3parse ! a52dec';
                break;
            default:
                decoder = 'decodebin';
                break; // fallback for unknown
        }

        // pulsesink slave-method: 0=resample (absorbs clock drift), 1=skew (adjusts timestamps)
        // Resample prevents latency buildup over hours — proven stable in v1 over 12+ hour sessions.
        const slaveMethod = (config.slaveMethod as number) ?? 0;

        // Cross-pipeline A/V sync (opt-in, plan: shared net clock). When on, the
        // sink honours PTS against the engine's shared clock so this pipeline
        // presents on the same timeline as the video-player. `provide-clock=false`
        // stops pulsesink imposing the DAC clock over the shared net clock the
        // engine sets, and `sync=true` makes it present at PTS. The input chain
        // is already `tsdemux` with no `tsparse set-timestamps`, so the source
        // PTS is preserved (required for the lock). Off → today's exact string.
        const clockSync = (config.clockSync as boolean) === true;
        const sinkSync = clockSync ? 'true' : 'false';
        const provideClock = clockSync ? ' provide-clock=false' : '';

        const parts = [
            // Post-tsdemux jitter buffer (leaky=2 drops oldest when full). Size
            // is per-instance via `bufferMs` — default 100 ms keeps live
            // SRT/RIST latency-tight; raise (e.g. 1500 ms) on HLS chains where
            // mid-stream joins and CPU spikes need lookahead to avoid scratch.
            `${udpSrc} ! tsdemux latency=0 ! queue leaky=2 max-size-time=${Number(config.bufferMs ?? 100) * 1_000_000} max-size-buffers=0 max-size-bytes=0 ! ${decoder}`,
            'audioconvert',
            `volume name=vol volume=${gstVolume}`,
            'level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000',
            // `buffer-time=50000` (50 ms) — kept tight because broadcast
            // latency budget is the dominant constraint here.
            // `max-lateness=200000000` and `processing-deadline=100000000`
            // were bumped up from 40 ms each: they don't add steady-state
            // latency (pulsesink only drops/skips when an arriving frame is
            // *already* this late) but they let pulsesink tolerate transient
            // delivery jitter that was previously surfacing as scratchy audio.
            `pulsesink device=${this.pwNodeName} sync=${sinkSync}${provideClock} slave-method=${slaveMethod} processing-deadline=100000000 buffer-time=50000 max-lateness=200000000`,
        ];
        const pipeline = parts.join(' ! ');

        return {
            pipeline,
            restartOnError: true,
            ...(clockSync ? { clockSync: true } : {}),
        };
    }
}
