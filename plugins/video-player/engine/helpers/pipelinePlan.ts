import * as fs from 'fs';
import type { PipelineDescription } from '@media-router/engine';
import {
    buildFallbackOnlyPipeline,
    buildLivePipeline,
    buildSink,
    resolveDecoderThreadType,
    TS_PROBE_SINK_NAME,
    type SurfaceSize,
} from './pipelines.js';
import { decoderRankEnv, VIDEO_DECODER_NAME, type DecoderSelection } from './decoderSelection.js';
import type { RenderTargetReady } from './renderTarget.js';

/**
 * Turn a resolved render target plus the module's current state into the
 * `PipelineDescription` the runner is handed.
 *
 * Two mutually exclusive shapes — the colour-bars/still fallback card and the
 * live bus→decode→sink chain — plus the sink element both share. The pipeline
 * STRINGS themselves are built in `pipelines.ts`; this file only decides which
 * one to build and with which knobs, so `VideoPlayerModule.buildPipeline`
 * stays a short read.
 */

/** Sink element plus the two clock decisions derived from the module config. */
export interface SinkPlan {
    sinkElement: string;
    /**
     * Cross-pipeline A/V sync (opt-in): lock to the engine's shared clock so
     * video stays with an audio-decoder fed from the same source. Forces the
     * sink to sync=true and preserves source PTS (see buildLivePipeline);
     * `clockSync` in the returned description makes GstPluginBase resolve and
     * attach the shared clock. Off → today's behaviour.
     */
    clockSync: boolean;
    /** Clock-paced sink (sync config or clockSync) → tsparse returns to the
     *  chain for clock-anchored timestamps. */
    sinkPaced: boolean;
}

export function planSink(target: RenderTargetReady, config: Record<string, unknown>): SinkPlan {
    const clockSync = (config.clockSync as boolean | undefined) === true;
    const sinkPaced = clockSync || ((config.sync as boolean | undefined) ?? true);
    return {
        sinkElement: buildSink(target.active.name, target.sinkEnv, {
            qos: (config.qos as boolean | undefined) ?? true,
            sync: sinkPaced,
            // Positive lipSyncMs delays video to meet late audio (audio path has
            // more buffering latency). Live-updatable via the named `sink`.
            tsOffsetNs: Math.round(Number(config.lipSyncMs ?? 0) * 1_000_000),
        }),
        clockSync,
        sinkPaced,
    };
}

export interface BuildHealthInput {
    /** Display the operator asked for (may not be the one we render on). */
    requestedDisplay: string;
    /** The connector actually chosen — see `ActiveDisplayChoice`. */
    active: RenderTargetReady['active'];
    /** A source IS assigned but its bus went silent (stall latch). */
    sourceSilent: boolean;
    /** Whether a bus source is assigned at all. */
    hasSource: boolean;
}

/**
 * Health this build implies, in precedence order. A display substitution
 * outranks the source state: the operator asked for one screen and is getting
 * another, which is the more surprising fact.
 *
 * Returned as `setHealth` arguments so the healthy case really is a bare
 * `setHealth('ok')` — the base class treats a trailing message as the error
 * detail, and 'ok' has none.
 */
export function resolveBuildHealth(
    input: BuildHealthInput,
): readonly [level: 'ok' | 'warning', message?: string] {
    if (input.active.substituted) {
        return [
            'warning',
            `Display "${input.requestedDisplay}" not connected — using "${input.active.name}"`,
        ] as const;
    }
    if (input.sourceSilent) {
        return ['warning', 'Source silent — showing fallback pattern'] as const;
    }
    if (!input.hasSource) return ['warning', 'No video connected'] as const;
    return ['ok'] as const;
}

/**
 * Resume tap: only when we latched on a SILENT source and its edge socket is
 * currently being served — a missing socket (producer down, or no source at
 * all) must not enter the pipeline, or the runner's bus-socket gate would hold
 * the colour bars hostage waiting for it. existsSync is the best sync check
 * available here; a stale socket file only costs one restartOnError cycle.
 */
export function resolveResumeSocket(
    sourceSilent: boolean,
    socketPath: string | undefined,
): string | undefined {
    return sourceSilent && socketPath && fs.existsSync(socketPath) ? socketPath : undefined;
}

export interface FallbackPlanInput {
    fallbackText: string;
    /** Validated still-image path, or undefined for SMPTE colour bars. */
    fallbackImage?: string;
    sinkElement: string;
    env: Record<string, string>;
    /** Card size — the output's own mode; see `resolveFallbackSurface`. */
    surface: SurfaceSize;
    /** Edge socket to tap, from `resolveResumeSocket`. */
    resumeSocket?: string;
}

export interface FallbackPlan {
    description: PipelineDescription;
    /** Whether the built card carries the bus-resume tap — the module's
     *  `resumeTapActive`, which picks tap vs no-tap resume polling. */
    resumeTapActive: boolean;
}

export function planFallbackPipeline(input: FallbackPlanInput): FallbackPlan {
    return {
        description: {
            pipeline: buildFallbackOnlyPipeline(
                input.fallbackText,
                input.sinkElement,
                input.fallbackImage,
                input.resumeSocket,
                input.surface,
            ),
            restartOnError: true,
            env: input.env,
        },
        resumeTapActive: !!input.resumeSocket,
    };
}

export interface LivePlanInput {
    sinkElement: string;
    udpSource: { port: number; socketPath?: string };
    env: Record<string, string>;
    /** See `RenderTargetReady.waylandFullscreen`. */
    waylandFullscreen: boolean;
    /** Chosen decoder rung — `decodebin3` until the TS probe reports a codec. */
    decoder: DecoderSelection;
    /**
     * Decoders demoted this engine session. Only used on the `decodebin3`
     * rung, where they become a rank override so the bin can't auto-plug one
     * of them. Nothing else is masked — see `decoderRankEnv`.
     */
    demoted?: ReadonlySet<string>;
    /** Raw `bufferMs` config value; normalised here. */
    bufferMs: unknown;
    /** Raw `cpuDecodeThreading` config value; normalised here. */
    cpuDecodeThreading: unknown;
    clockSync: boolean;
    sinkPaced: boolean;
}

export function planLivePipeline(input: LivePlanInput): PipelineDescription {
    return {
        pipeline: buildLivePipeline(
            input.sinkElement,
            input.udpSource,
            input.waylandFullscreen,
            Number(input.bufferMs ?? 200),
            input.clockSync,
            input.sinkPaced,
            input.decoder,
        ),
        restartOnError: true,
        // Merged, never replaced: `input.env` carries the wayland app_id
        // (MR_GLIB_PRGNAME) the compositor pins our surface by, and losing it
        // would move the picture to the wrong output. On the decodebin3 rung
        // the merge adds a rank mask for any DEMOTED decoder, so the bin can't
        // auto-plug one we struck off — nothing else is masked, so it still
        // picks hardware by rank. See decoderRankEnv.
        env: { ...input.env, ...decoderRankEnv(input.decoder, input.demoted) },
        // Passed on every rung. It is what threads the software decoder
        // decodebin3 auto-plugs on the bootstrap rung; on an explicit rung the runner's
        // hook skips a decoder whose `max-threads` we already pinned (the
        // threaded chain) and only reaches the bare one `'single'` builds,
        // where this resolves to `'auto'` and leaves ffmpeg's live default —
        // one core — exactly as intended.
        decoderThreadType: resolveDecoderThreadType(input.cpuDecodeThreading),
        // Report-only TS video-info probe feeding onPluginEvent — the tap
        // appsink is built into the live pipeline by buildLivePipeline.
        tsProbe: { appsink: TS_PROBE_SINK_NAME },
        // Keep-up watch on the live render chain (see onPluginEvent).
        // Only the wayland/kms sinks are named — autovideosink (dev) is a
        // bin without `name=sink`, so the runner would fail the lookup.
        ...(input.sinkElement.includes('name=sink') ? { renderWatch: { sink: 'sink' } } : {}),
        // EXPLICIT rungs only. A live TS join lands mid-GOP, and feeding a
        // stateless V4L2 decoder delta units before its first keyframe leaves
        // the kernel driver holding a decode request that never completes —
        // the next teardown then hangs in D state and takes V4L2 down
        // box-wide (Pi 4 rpivid and Pi 5 hevc_dec, kernel 6.12.87). The gate
        // drops those until the first keyframe, and RE-ARMS on any later loss:
        // the chain's `leaky=2` jitter queues shed AUs whenever the decoder
        // stalls (device open at startup is ~1 s of stream time), and the
        // delta units after a shed reference frames the decoder never saw —
        // the same missing-reference hazard, which is why the leaky queues
        // stay leaky (they are the live latency contract) and the gate is what
        // makes their loss safe.
        //
        // The decodebin3 rung CANNOT be gated — the bin plugs its own decoder,
        // so there is no element to name. It only ever carries the stream until
        // the TS probe names the codec and the rebuild moves to a gated
        // explicit rung.
        ...(input.decoder.explicit ? { keyframeGate: { decoder: VIDEO_DECODER_NAME } } : {}),
        ...(input.clockSync ? { clockSync: true } : {}),
    };
}
