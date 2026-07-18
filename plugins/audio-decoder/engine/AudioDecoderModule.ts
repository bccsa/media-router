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

        // `sync=false` is LOAD-BEARING on this path — do NOT switch to
        // sync=true for jitter/drift reasons. Measured on gate01 (2026-07-16):
        // a sync=true sink plays only when the decoder starts together with its
        // producer; on any MID-STREAM join (demuxer restart, decoder
        // restartOnError respawn — i.e. routine production events) tsdemux's
        // segment start no longer matches the in-progress TS timeline, every
        // buffer arrives "late" beyond max-lateness, and the sink SILENTLY
        // drops all of them — decoders output pure silence with zero errors
        // (live A/B on the bus edge: sync=true peak=0, sync=false peak=6359).
        // Burst smoothing is instead handled arrival-driven: the non-leaky
        // dejitter queue above + the 200 ms pa ring below.
        //
        // Cross-pipeline A/V sync (opt-in, plan: shared net clock). When on, the
        // sink honours PTS against the engine's shared clock so this pipeline
        // presents on the same timeline as the video-player. `provide-clock=false`
        // stops pulsesink imposing the DAC clock over the shared net clock the
        // engine sets, and `sync=true` makes it present at PTS. The input chain
        // is already `tsdemux` with no `tsparse set-timestamps`, so the source
        // PTS is preserved (required for the lock). Off → sync=false (default).
        const clockSync = (config.clockSync as boolean) === true;
        // Low-latency deterministic anchor (opt-in) — the lipsync fix for
        // re-encoded audio paths (decoder → PipeWire loop → encoder → mux).
        // With sync=false every buffer in the loop FILLS and stays full: the
        // startup backlog is trapped forever as standing latency, and the
        // encoder's pulsesrc re-stamps audio AFTER it (measured on gate01:
        // audio timeline 776 ms late vs video on both 1080p muxes). sync=true
        // paces rendering at PTS + ts-offset, so the anchor shift becomes the
        // configured offset instead of "sum of all buffer fills". The
        // mid-stream-join silence trap documented above is disarmed by
        // `max-lateness=-1`: a late timeline (join, respawn, startup backlog)
        // renders immediately and DRAINS instead of being silently dropped —
        // degrading to arrival-driven behaviour, never to silence.
        // `syncOffsetMs` (default 250) must cover the ~150-200 ms PES-burst
        // arrival lateness of bus audio; too small ⇒ constant late-mode (no
        // harm, just arrival-anchored), too big ⇒ that much standing latency.
        const lowLatencySync = (config.lowLatencySync as boolean) === true && !clockSync;
        const syncOffsetMs = Math.max(0, Number(config.syncOffsetMs ?? 0));
        const sinkSync = clockSync || lowLatencySync ? 'true' : 'false';
        const provideClock = clockSync ? ' provide-clock=false' : '';
        // Small pa ring (50 ms vs the default 200 ms): with sync=true the ring
        // fill is bounded playout delay, not a reservoir — the upstream
        // non-leaky dejitter queue holds the bursts. syncOffsetMs defaults to
        // 0: PES-cluster arrivals then render slightly "late" (immediately,
        // thanks to max-lateness=-1), anchoring audio at arrival ≈ the
        // smallest possible standing latency. Raise it only if underflow
        // gaps appear (it trades latency for pacing headroom).
        const sinkTiming = lowLatencySync
            ? `${syncOffsetMs > 0 ? ` ts-offset=${syncOffsetMs * 1_000_000}` : ''} max-lateness=-1`
            : ' max-lateness=200000000';

        // pa ring size (µs) for the default sync=false path — see the
        // pulsesink comment below. Clamped 80–1000 ms.
        const sinkBufferUs =
            Math.max(80, Math.min(1000, Number(config.sinkBufferMs ?? 200))) * 1000;

        const parts = [
            // Post-tsdemux dejitter buffer — NON-LEAKY (leaky=0), sized to at
            // least one PES burst. `tsdemux` emits audio in ~150 ms PES bursts
            // and the pipewire `pulsesink` below is a REAL-TIME endpoint that
            // drains at a steady 48 kHz. The old leaky queue dropped the tail
            // of every burst, so between bursts the sink starved and underflowed
            // (~12–22 % silence in 40 ms gaps, measured on gate01, unixfd path);
            // non-leaky retains the whole burst as an arrival-driven reservoir
            // (the pa ring blocks when full, so the queue holds the overflow)
            // → 0 % gaps. This is CONSUMER-side dejitter: it can only back-
            // pressure this module's own bus edge (which sheds), never the
            // demuxer or sibling consumers — so it fixes choppiness without the
            // demuxer-side clocksync pacing that back-pressures tsdemux and
            // freezes the whole unixfd bus.
            //
            // `bufferMs`: an UNSET value defaults to 300 ms (safe for bursty
            // demuxer-fed sources). An EXPLICIT value is honoured down to a
            // 50 ms floor: splitter-fed inputs arrive at wire cadence (~4 ms,
            // measured gate01 2026-07-18), and because this queue is NON-LEAKY
            // its startup backlog is trapped forever (in-rate = out-rate) —
            // on a re-encode path that trapped fill lands 1:1 as A/V skew
            // (the encoder re-stamps at capture). Operators tuning latency
            // must be able to shrink it; the old hard 300 ms floor was
            // demuxer-burst-era protection.
            `${udpSrc} ! tsdemux latency=0 ! queue leaky=0 max-size-time=${(config.bufferMs !== undefined ? Math.min(5000, Math.max(50, Number(config.bufferMs) || 50)) : 300) * 1_000_000} max-size-buffers=0 max-size-bytes=0 ! ${decoder}`,
            'audioconvert',
            `volume name=vol volume=${gstVolume}`,
            'level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000',
            // `sinkBufferMs` (default 200 ms) — the DAC ring the sink drains
            // at 48 kHz. 50 ms was too shallow to bridge PES-burst spacing;
            // 200 ms gives the slaving headroom without material latency (the
            // reservoir upstream is the dominant term). Lower only during a
            // measured tuning pass — the floor of 80 ms guards against
            // configs that would re-starve the sink. `max-lateness=200000000`
            // drops a frame only when it arrives *already* >200 ms late
            // (post-stall recovery, not steady state);
            // `processing-deadline=100000000`.
            `pulsesink device=${this.pwNodeName} sync=${sinkSync}${provideClock} slave-method=${slaveMethod} processing-deadline=100000000 buffer-time=${lowLatencySync ? 50000 : sinkBufferUs}${sinkTiming}`,
        ];
        const pipeline = parts.join(' ! ');

        return {
            pipeline,
            restartOnError: true,
            ...(clockSync ? { clockSync: true } : {}),
        };
    }
}
