/**
 * Inputs and result of the transcoder's pipeline builder (`transcoderPipeline.ts`).
 */

import type { RunnerHook } from '@media-router/engine';
import type { TranscoderOutput } from './transcoderPorts.js';

export type DeinterlaceMethod = 'yadif' | 'greedyl';

export interface TranscoderPipelineInputs {
    input: { port: number; socketPath?: string };
    /** One output per rendition. Each carries its own fully-resolved encoder
     *  settings (`encode`: codec / impl / rateControl / speedPreset / h264Profile
     *  / sceneCut) — resolved in TranscoderModule (override ?? global) so this
     *  builder never sees `auto`/undefined and holds no encode defaults itself. */
    outputs: TranscoderOutput[];
    framerate: number;
    /** Keyframe interval in FRAMES — passed straight to the encoder as
     *  key-int-max (the standard x264/x265 unit). Shared by all renditions to
     *  keep keyframes aligned for ABR. */
    gopFrames: number;
    /** Buffer in ms (default 200): sizes the input jitter queue AND a post-decode
     *  raw-frame queue that lets the frame-threaded decoder work ahead. The cost
     *  is this much latency. Never buffered leakily on the compressed stream —
     *  see buildPipeline. Shared: sizes the single decode chain. */
    bufferMs?: number;
    /** 'multi' (default) sets `avdec_h264 thread-type=frame max-threads=3` so the
     *  decode spreads across cores on the live feed; 'single' is GStreamer's
     *  default one-core live decode (lowest latency). Shared: one decoder. */
    decodeThreads?: 'multi' | 'single';
    /** Interlace handling on the shared decode path (default 'auto'):
     *  'auto' inserts `deinterlace mode=auto` — the element reads the decoded
     *  buffers' interlace flags itself, deinterlacing interlaced content and
     *  passing progressive through untouched (no caps plumbing needed).
     *  'force' deinterlaces unconditionally; 'off' omits the element and passes
     *  fields through (only sensible when renditions keep the source
     *  resolution — the encoder flag for that case is handled per branch). */
    deinterlace?: 'auto' | 'force' | 'off';
    /** The deinterlacer's `method` (the module passes `deinterlaceMethodForArch(process.arch)`);
     *  default 'greedyl'. */
    deinterlaceMethod?: DeinterlaceMethod;
    /** Hardware scaler availability, probed by the module at manifest init.
     *  When a rendition's encoder impl has its hardware scaler available, the
     *  leaf's software `videoscale ! videoconvert` stage is replaced by the
     *  hardware equivalent (`vapostproc` for VA, `v4l2convert` for the Pi ISP). */
    hwScalers?: { va?: boolean; v4l2?: boolean };
    /**
     * Subtitle source wired to `subtitles-in` plus the module config the
     * overlay controls read. When set, ONE `textoverlay` sits on the shared
     * decoded frame ahead of the tee — every rendition gets the burn-in for
     * the price of one render — and the subtitle TS comes in on its own bus
     * edge. Absent → pipeline string unchanged.
     */
    subtitles?: { port: number; socketPath?: string; config: Record<string, unknown> };
    /** Video hold in ms (0 = none) so late subtitle cues land on their frame; only
     *  applied with a subtitle source. Delays this transcoder's output by as much. */
    subtitleDelayMs?: number;
}

export interface TranscoderPipelineResult {
    pipeline: string;
    /** The deinterlace guard (with a deinterlacer) and the subtitle bridge (with a subtitle
     *  source) — put on the description verbatim. */
    runnerHooks?: RunnerHook[];
    /** `'python'` with a subtitle source (subtitleRenderPlan) — put on the description. */
    runner?: 'python';
    /** Bus-egress tee names (one per rendition, `busout_<port>`) — the module
     *  polls these for per-rendition output throughput. Single source of truth
     *  for the names constructed in the leaf builder. */
    sinkNames: string[];
}
