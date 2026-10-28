import {
    DECODE_BYPASS_PPM,
    GstPluginBase,
    backlogShedConfig,
    buildAsrc,
    buildBusSrc,
    buildLatenessTap,
    effectivePlayoutOffsetNs,
    pulsePinnedStreamProps,
    type PipelineDescription,
    type ModuleServices,
    type PlayoutOffsetServices,
    probeMpegTsStream,
    type ProbeResult,
} from '@media-router/engine';

/**
 * `pulsesink buffer-time` (µs) this leg runs, and the
 * scheduling latency it DECLARES for that ring (ms).
 *
 * A live GStreamer sink renders at `running-time + ts-offset + latency`, where
 * `latency` is the pipeline's min latency from the LATENCY query — for an audio
 * sink essentially its ring. Measured on the 10.9.16.103 USB DAC (PipeWire 1.6,
 * GStreamer 1.28): 151.3 ms at a 200 ms ring, 101.3 ms at 100 ms, 71.3 ms at
 * 50 ms. The video leg's `waylandsink` declares ~20 ms, so a leg that ignores
 * this presents that much behind the picture on the SAME D — which is what
 * decision 4 exists to prevent.
 *
 * So the contract pins ONE ring for both audio legs (the 302M output's
 * `SINK_BUFFER_US`) and cancels ONE number, and the two resolve D identically
 * by construction rather than by two tunings happening to agree. A stored
 * `sinkBufferMs` is ignored. The 100 ms floor is itself field-derived: a 50 ms
 * ring xrunned audibly on a Pi 4.
 *
 * Residual, deliberately left: the declared figure is ring-dependent and only
 * measured at three points, so it is a CONSTANT here rather than a model. The
 * exact fix is a runner-side LATENCY query feeding the offset back — worth it
 * only when a leg needs a ring other than this one.
 */
const CONTRACT_SINK_BUFFER_US = 100_000;
const SINK_DECLARED_LATENCY_MS = 100;

/**
 * The audio leg's sink `ts-offset`, in nanoseconds: the route's playout offset D
 * plus the deprecated `syncOffsetMs` trim (ADR-0005 decision 4), MINUS the
 * latency the sink declares for its paced ring (see above). The video leg
 * computes its own through `videoTsOffsetNs`, which calls the same
 * `effectivePlayoutOffsetNs` against the same route — so one route resolves to
 * one D on both legs, by construction rather than by two implementations
 * agreeing.
 *
 * NEVER NEGATIVE: a D smaller than the ring clamps to 0. Audio cannot be
 * presented before it arrives (`max-lateness=-1` then plays it on arrival), and
 * the backlog shedder reads this very `ts-offset` as the leg's budget, so a
 * negative value makes every buffer read as retained backlog — field, .103,
 * 2026-09-03: a −1700 ms sink offset had the shedder drop ~10 s of audio
 * chasing a phantom 1943 ms backlog.
 *
 * TWIN: `audio302mTsOffsetNs` in
 * `plugins/audio-output-302m/engine/audio302mTiming.ts` cancels the same
 * declared ring latency and clamps the same way. TWO COPIES ON PURPOSE: plugin
 * `dist`s are hot-deployed onto boxes whose engine `dist` may be older, so a
 * shared export from `@media-router/engine` would fail to resolve there. Keep
 * them in step — if one changes, the two legs of a route stop agreeing, which
 * is the exact fault decision 4 forbids.
 */
export function audioTsOffsetNs(
    services: PlayoutOffsetServices | null | undefined,
    config: Record<string, unknown>,
): number {
    return Math.max(
        0,
        effectivePlayoutOffsetNs(services, {
            trimMs: Math.max(0, Number(config.syncOffsetMs ?? 0) || 0),
        }) -
            SINK_DECLARED_LATENCY_MS * 1_000_000,
    );
}

/**
 * `pulsesink slave-method` (GstAudioBaseSink): 3 = custom. The ASRC follows the sink's clock
 * through its custom-slaving callback and never asks it to skew, so no samples are dropped or
 * repeated for drift (house-clock part 4.4). Never set it without that ASRC.
 */
const SLAVE_METHOD_CUSTOM = 3;

/** `name=` of this leg's demux: its counters on the module's input. */
const DEMUX_NAME = 'addemux';
/** `name=` of this leg's ASRC: the source's clock term and the sink's, one resampler (OQ-23). */
const ASRC_NAME = 'asrc';

/**
 * Audio Decoder plugin.
 *
 * Receives MPEG-TS via UDP multicast (from an encoder or SRT source),
 * probes the stream to detect the codec, then builds the appropriate
 * decode pipeline for its first audio stream. Outputs PCM to a named null-sink.
 *
 * Under the time-sync contract (ADR-0005) this module's sink presents against
 * the house clock: `sync=true` and `ts-offset` = the route's playout offset D.
 *
 * CLOCKS (house-clock part 4.4). `asrc` resamples a source on a clock of its own to house rate
 * where it is decoded, and follows the null sink's clock through the sink's custom slaving: one
 * resampler for both terms (OQ-23), and the sink never drops or repeats samples for drift.
 */
export class AudioDecoderModule extends GstPluginBase {
    protected liveUpdatableParams = ['volume', 'audioEnabled', 'syncOffsetMs'];
    /** Probed stream info — plugin decides what to do with it. */
    private probeResult: ProbeResult | null = null;

    async onInit(config: Record<string, unknown>, services?: ModuleServices): Promise<void> {
        await super.onInit(config, services);
    }

    async onStart(): Promise<void> {
        const instanceId = this.services?.instanceId ?? '';
        const udpSource = this.services?.mediaRouter?.getModuleBusSource(instanceId);

        // 1. Probe the stream for codec (and channels if available — opus includes it, AAC doesn't)
        if (udpSource) {
            this.probeResult = await probeMpegTsStream(udpSource.port, 3000, udpSource.socketPath);
            this.log.info(
                { codec: this.probeResult.codec, channels: this.probeResult.channels },
                'Stream probe',
            );
        } else {
            this.probeResult = null;
        }

        // 2. Resolve channel count from multiple sources (first available wins):
        //    - Stream probe caps (reliable for opus, unavailable for AAC/ADTS)
        //    - Upstream encoder config (available after encoder starts — getModuleBusSource reads it)
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
        await this.applyVolumeLiveUpdate(changes);
        // `syncOffsetMs` is a deprecated alias for the playout offset and, under
        // the contract, a per-sink trim on top of it — live for the same reason
        // `lipSyncMs` is on the video leg: an operator trims it while listening.
        if ('syncOffsetMs' in changes) await this.pushSinkTsOffset();
    }

    /**
     * The route head's playout offset D moved (ADR-0005 decision 4) — re-push
     * this leg's `ts-offset`. Called by `MediaRouter.notifyPlayoutOffsetChanged`
     * in the same pass as the video leg of the route, so the two never diverge.
     */
    async onRoutePlayoutOffsetChanged(): Promise<void> {
        await this.pushSinkTsOffset();
    }

    /** Push the resolved ts-offset to the running `pulsesink`. */
    private async pushSinkTsOffset(): Promise<void> {
        await this.setElementProperty(
            'sink',
            'ts-offset',
            audioTsOffsetNs(this.services, this.config),
        );
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
        const udpSource = this.services?.mediaRouter?.getModuleBusSource(instanceId);

        if (!udpSource) {
            this.setHealth('warning', 'No encoder connected');
            return null;
        }

        const udpSrc = buildBusSrc({
            port: udpSource.port,
            socketPath: udpSource.socketPath,
        });

        // Plugin decides decoder based on probe result.
        //
        // Each decoder is fed straight off a demux src pad, which emits
        // *unframed* elementary streams (one PES per buffer). These software
        // decoders need whole, framed access units, so a codec parser MUST sit
        // between the demux and the decoder — without it `avdec_aac` errors
        // "Input buffer exhausted before END element found" on every buffer and
        // the pipeline crash-loops (seen on a clean single-AAC RIST feed:
        // null-sink idle, gst-runner flapping). The `default` (decodebin) branch
        // is safe because decodebin auto-plugs the parser; the explicit branches
        // must add it themselves. opus is the exception — the demux already
        // emits muxer/decoder-ready opus caps, so opusdec needs no parser.
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

        // Presents at `stamped-time + D` (ADR-0005); `max-lateness=-1` drains a late timeline
        // rather than going silent. Custom slaving: `asrc` follows the sink, which never skews.
        const sinkTiming = ` ts-offset=${audioTsOffsetNs(this.services, config)} max-lateness=-1`;

        const parts = [
            // Post-demux dejitter buffer — NON-LEAKY (leaky=0), sized to at
            // least one PES burst. The demux emits audio in ~150 ms PES bursts
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
            //
            // `media=audio`: the first audio stream only (OQ-28), so an A/V input never links its
            // video here.
            `${udpSrc} ! mrtsdemux name=${DEMUX_NAME} media=audio ! queue leaky=0 max-size-time=${(config.bufferMs !== undefined ? Math.min(5000, Math.max(50, Number(config.bufferMs) || 50)) : 300) * 1_000_000} max-size-buffers=0 max-size-bytes=0 ! ${decoder}`,
            // Interleaved for `asrc` (avdec_aac's output is planar). Render lateness is read
            // before it, where PTS is still content time (part 4.4).
            'audioconvert',
            buildLatenessTap('lat_render'),
            buildAsrc({ name: ASRC_NAME, bypassBelowPpm: DECODE_BYPASS_PPM, deviceSink: 'sink' }),
            'audioconvert',
            `volume name=vol volume=${gstVolume}`,
            'level post-messages=true peak-falloff=120 peak-ttl=50000000 interval=100000000',
            // The DAC ring is CONTRACT_SINK_BUFFER_US (see there). `name=sink`
            // is what the live playout-offset push and `asrc`'s device term target.
            `pulsesink name=sink device=${this.pwNodeName} sync=true provide-clock=false slave-method=${SLAVE_METHOD_CUSTOM} processing-deadline=100000000 buffer-time=${CONTRACT_SINK_BUFFER_US}${sinkTiming} ${pulsePinnedStreamProps()}`,
        ];
        const pipeline = parts.filter((p) => p).join(' ! ');

        return {
            pipeline,
            restartOnError: true,
            timingSink: { element: 'sink', kind: 'audio' },
            // Backlog shedder — the latency ratchet guard on this `sync=true`
            // leg (see backlogShed.ts). `max-lateness=-1` makes this leg's
            // ratchet quieter than the video leg's, never absent — the sink
            // refuses to drop late buffers, so retained latency shows up as
            // lipsync drift against the video leg of the same route rather than
            // as dropped frames.
            //
            // Read and shed at `asrc`'s input, the last pad on content time: after its device
            // term the PTS are device-time labels (part 4.4, B-127). Whole PCM buffers, not
            // keyframe-aligned, nothing cut; at most one click a minute, for the route's D.
            backlogShed: backlogShedConfig(this.services, {
                element: ASRC_NAME,
                sink: 'sink',
                keyframeAligned: false,
            }),
        };
    }
}
