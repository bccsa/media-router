import * as fs from 'fs';
import { withLatenessTap, type PipelineDescription, type TimingSink } from '@media-router/engine';
import {
    buildFallbackOnlyPipeline,
    buildLivePipeline,
    buildSink,
    resolveDecoderThreadType,
    TS_PROBE_SINK_NAME,
    VIDEO_PACE_NAME,
    type SurfaceSize,
} from './pipelines.js';
import { decoderRankEnv, VIDEO_DECODER_NAME, type DecoderSelection } from './decoderSelection.js';
import type { RenderTargetReady } from './renderTarget.js';
import { subtitleRenderPlan } from '@media-router/plugin-subtitle-core';

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

/** The sink element both shapes end in. */
export interface SinkPlan {
    sinkElement: string;
}

/** The sink for the render target: it shows each frame as it comes (`buildSink`, B-169). */
export function planSink(target: RenderTargetReady): SinkPlan {
    return { sinkElement: buildSink(target.active.name, target.sinkEnv) };
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
    /** Raw `cpuDecodeThreading` config value; normalised here. */
    cpuDecodeThreading: unknown;
    /** Refresh of the output's mode (`resolveOutputRefreshHz`), when known: the timing
     *  section's device latency is one refresh of it, and `mrvideopace`'s prior. */
    refreshHz?: number;
    /**
     * Subtitle source wired to `subtitles-in` (subtitle-core carrier) plus the
     * module config the overlay controls read. Absent → no overlay, no extra
     * input, pipeline string unchanged.
     */
    subtitles?: { port: number; socketPath?: string; config: Record<string, unknown> };
}

const videoTimingSink = (refreshHz: number | undefined): TimingSink => ({
    element: 'sink',
    kind: 'video',
    ...(refreshHz ? { refreshHz } : {}),
});

export function planLivePipeline(input: LivePlanInput): PipelineDescription {
    // The sink is only addressable when it carries `name=sink` — autovideosink
    // (dev) is a bin without one, the same condition renderWatch is gated on.
    const namedSink = input.sinkElement.includes('name=sink');
    const subs = input.subtitles
        ? subtitleRenderPlan(input.subtitles, input.subtitles.config)
        : undefined;
    return {
        pipeline:
            buildLivePipeline(
                // Render lateness is read right before the sink (§9.5), after the pace.
                withLatenessTap('lat_render', input.sinkElement),
                input.udpSource,
                input.waylandFullscreen,
                input.decoder,
                subs?.overlayElement,
                input.refreshHz ? Math.round(input.refreshHz * 1000) : undefined,
            ) + (subs ? ` ${subs.inputFragment}` : ''),
        restartOnError: true,
        // A pipeline that keeps failing is rebuilt at 1, 2, 4 … up to every 30 s, not every
        // 5 s: each rebuild opens the hardware decoder again, and rapid opens wedged the
        // Pi 4's VPU H.264 decoder until a reboot (DEV-P4b).
        restartBackoffMs: { baseMs: 1_000, maxMs: 30_000 },
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
        // Keep-up watch (see onPluginEvent), on a named sink only: autovideosink (dev) is a bin.
        // The pace's rate drops count as kept up: a display slower than the content takes no more.
        ...(namedSink ? { renderWatch: { sink: 'sink', pace: VIDEO_PACE_NAME } } : {}),
        // The timing section's device latency is one refresh of the output's mode.
        ...(namedSink ? { timingSink: videoTimingSink(input.refreshHz) } : {}),
        // EXPLICIT rungs only. A live TS join lands mid-GOP, and feeding a
        // stateless V4L2 decoder delta units before its first keyframe leaves
        // the kernel driver holding a decode request that never completes —
        // the next teardown then hangs in D state and takes V4L2 down
        // box-wide (Pi 4 rpivid and Pi 5 hevc_dec, kernel 6.12.87). The gate
        // drops those until the first keyframe, and RE-ARMS on any later loss:
        // a DISCONT now comes only from real loss (the source's, or the bus
        // ingress shedding at capacity, OQ-30), and the delta units after it
        // reference frames the decoder never saw.
        //
        // The decodebin3 rung CANNOT be gated — the bin plugs its own decoder,
        // so there is no element to name. It only ever carries the stream until
        // the TS probe names the codec and the rebuild moves to a gated
        // explicit rung.
        ...(input.decoder.explicit ? { keyframeGate: { decoder: VIDEO_DECODER_NAME } } : {}),
        ...(subs ? { runnerHooks: subs.runnerHooks, runner: subs.runner } : {}),
    };
}
