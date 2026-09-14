/**
 * Shared subtitle rendering controls + pipeline fragments.
 *
 * Every module that renders subtitles — the video-player on its display, the
 * transcoder as burn-in ahead of its rendition tee — renders through ONE
 * `textoverlay` element driven by the same six config keys. The schema below
 * is the source of truth: consumer manifests copy `SUBTITLE_OVERLAY_SCHEMA`
 * verbatim into their `configSchema.properties` and list
 * `SUBTITLE_OVERLAY_LIVE_KEYS` in `liveUpdatableParams`; a test in each
 * consumer asserts the copy matches (ADR-0007: plugins compute, the UI
 * renders — the UI never learns what these keys mean).
 *
 * Text delivery is NOT the textoverlay text pad. Its pad semantics (a buffer
 * is shown only while its [pts, pts+duration) overlaps the video, no-duration
 * buffers flash for one frame, and the pad blocks while a buffer is pending)
 * fought every attempt in the 2026-09-09 spike. Instead this plugin's runner
 * hook (`py/subtitle_bridge.py`) reads the KLV cues off a `tsdemux` and
 * sets the element's `text` property from a probe on its VIDEO sink pad, so
 * a cue appears exactly on the first frame whose stamped PTS reaches the cue's
 * house-clock start and clears on the first frame past its end — frame
 * accurate against the stamped timeline (ADR-0005), no timeline math in the
 * consumer, and independent of the playout offset D.
 */

import { buildTsUdpInput, type DynamicPort, type RunnerHook } from '@media-router/engine';

/** Config keys → JSON-schema properties. Copy verbatim into manifests. */
export const SUBTITLE_OVERLAY_SCHEMA: Record<string, Record<string, unknown>> = {
    subtitlePosition: {
        type: 'string',
        enum: ['bottom', 'top', 'center'],
        default: 'bottom',
        'x-enumLabels': { bottom: 'Bottom', top: 'Top', center: 'Center' },
        'x-live': true,
        description: 'Vertical placement of subtitle text on the picture.',
    },
    subtitleAlign: {
        type: 'string',
        enum: ['center', 'left', 'right'],
        default: 'center',
        'x-enumLabels': { center: 'Center', left: 'Left', right: 'Right' },
        'x-live': true,
        description: 'Horizontal alignment of subtitle text.',
    },
    subtitleSize: {
        type: 'number',
        default: 36,
        minimum: 12,
        maximum: 120,
        'x-widget': 'slider',
        'x-step': 2,
        'x-unit': 'pt',
        'x-live': true,
        description:
            'Subtitle font size. Scales with the picture height (the renderer resizes relative to the frame), so one value suits every rendition.',
    },
    subtitleMargin: {
        type: 'number',
        default: 40,
        minimum: 0,
        maximum: 400,
        'x-widget': 'slider',
        'x-step': 5,
        'x-unit': 'px',
        'x-live': true,
        description: 'Distance from the top or bottom edge (ignored for Center).',
    },
    subtitleBackground: {
        type: 'boolean',
        default: true,
        'x-live': true,
        description: 'Draw a shaded box behind the text for legibility over bright pictures.',
    },
    subtitleBackgroundOpacity: {
        type: 'number',
        default: 60,
        minimum: 0,
        maximum: 100,
        'x-widget': 'slider',
        'x-step': 5,
        'x-unit': '%',
        'x-live': true,
        'x-showWhen': 'subtitleBackground=true',
        description: 'Opacity of the shaded box (0 = invisible, 100 = solid black).',
    },
};

export const SUBTITLE_OVERLAY_LIVE_KEYS: readonly string[] = Object.keys(SUBTITLE_OVERLAY_SCHEMA);

/** The subtitle input port every rendering module exposes. */
export const SUBTITLE_INPUT_PORT_ID = 'subtitles-in';

export const SUBTITLE_INPUT_PORT: DynamicPort = {
    id: SUBTITLE_INPUT_PORT_ID,
    direction: 'input',
    streamType: 'muxed/mpegts',
    label: 'Subtitles In',
    maxConnections: 1,
    acceptsStreamTypes: ['muxed/mpegts'],
};

/** textoverlay properties the six keys resolve to. */
export interface SubtitleOverlayProps {
    valignment: 'bottom' | 'top' | 'center';
    halignment: 'center' | 'left' | 'right';
    'font-desc': string;
    ypad: number;
    'shaded-background': boolean;
    'shading-value': number;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return typeof value === 'string' && (allowed as readonly string[]).includes(value)
        ? (value as T)
        : fallback;
}

/** Map module config → textoverlay properties (total; bad values → defaults). */
export function subtitleOverlayProps(config: Record<string, unknown>): SubtitleOverlayProps {
    const size = clampInt(config.subtitleSize, 12, 120, 36);
    return {
        valignment: pick(config.subtitlePosition, ['bottom', 'top', 'center'] as const, 'bottom'),
        halignment: pick(config.subtitleAlign, ['center', 'left', 'right'] as const, 'center'),
        'font-desc': `Sans Bold ${size}`,
        ypad: clampInt(config.subtitleMargin, 0, 400, 40),
        'shaded-background':
            config.subtitleBackground === undefined ? true : !!config.subtitleBackground,
        // operator percent → textoverlay's 0–255 shading value
        'shading-value': Math.round(
            (clampInt(config.subtitleBackgroundOpacity, 0, 100, 60) * 255) / 100,
        ),
    };
}

/** Which textoverlay properties a live config change touches. */
export function subtitleOverlayLiveUpdates(
    changes: Record<string, unknown>,
    config: Record<string, unknown>,
): Array<{ property: keyof SubtitleOverlayProps; value: string | number | boolean }> {
    if (!SUBTITLE_OVERLAY_LIVE_KEYS.some((k) => k in changes)) return [];
    const props = subtitleOverlayProps({ ...config, ...changes });
    const out: Array<{ property: keyof SubtitleOverlayProps; value: string | number | boolean }> =
        [];
    if ('subtitlePosition' in changes)
        out.push({ property: 'valignment', value: props.valignment });
    if ('subtitleAlign' in changes) out.push({ property: 'halignment', value: props.halignment });
    if ('subtitleSize' in changes) out.push({ property: 'font-desc', value: props['font-desc'] });
    if ('subtitleMargin' in changes) out.push({ property: 'ypad', value: props.ypad });
    if ('subtitleBackground' in changes) {
        out.push({ property: 'shaded-background', value: props['shaded-background'] });
    }
    if ('subtitleBackgroundOpacity' in changes) {
        out.push({ property: 'shading-value', value: props['shading-value'] });
    }
    return out;
}

/**
 * The overlay element for a pipeline string. `wait-text=false` + an empty
 * `text` so video flows untouched until the bridge sets a cue; the bridge
 * addresses the element by `name`.
 */
export function buildSubtitleOverlayElement(name: string, config: Record<string, unknown>): string {
    const p = subtitleOverlayProps(config);
    return (
        `textoverlay name=${name} wait-text=false text="" ` +
        `valignment=${p.valignment} halignment=${p.halignment} ` +
        `font-desc="${p['font-desc']}" ypad=${p.ypad} ` +
        `shaded-background=${p['shaded-background']} shading-value=${p['shading-value']}`
    );
}

export interface SubtitleInputOpts {
    /** Bus channel of the subtitle source (its `port` + per-consumer edge socket). */
    port: number;
    socketPath?: string;
    /** `name=` for the tsdemux the bridge attaches to (unique per pipeline). */
    demuxName: string;
}

/**
 * Bus input for a subtitle TS: `unixfdsrc ! queue ! tsparse ! tsdemux`. Its
 * pads are linked at runtime by the runner's subtitle bridge (KLV pad → cue
 * reader; anything else → fakesink so a mis-wired A/V stream cannot stall the
 * demux). Standalone fragment — join it to the rest of the pipeline string
 * with a space, not `!`.
 */
export function buildSubtitleInput(opts: SubtitleInputOpts): string {
    return (
        `${buildTsUdpInput({ port: opts.port, socketPath: opts.socketPath, jitterMs: 200 })} ` +
        `! tsdemux name=${opts.demuxName} latency=0`
    );
}

/** Config for the consumer half of the bridge (`subtitle_bridge` hook, `overlay`). */
export interface SubtitleOverlayRunnerConfig {
    /** tsdemux the cues arrive on (from buildSubtitleInput). */
    demux: string;
    /** textoverlay whose `text` property the bridge drives. */
    overlay: string;
}

/** Config for one producer branch (`subtitle_bridge` hook, `pay[]`). */
export interface SubtitlePayRunnerConfig {
    /** appsink delivering `text/x-raw` cue text (one buffer per cue; empty = clear). */
    appsink: string;
    /** appsrc (`meta/x-klv,parsed=true`) feeding the mux for this subtitle stream. */
    appsrc: string;
    /** How long a cue stays up when the source never sends a clear (ms). */
    holdMs: number;
    /** Operator label for status events (page number, language). */
    label?: string;
}

/** The runner python module shipped in this plugin's `py/` dir. */
export const SUBTITLE_RUNNER_MODULE = 'subtitle_bridge';

/**
 * The `PipelineDescription.runnerHooks` entry that installs the subtitle
 * bridge on a pipeline: producers pass `pay`, renderers pass `overlay`.
 */
export function subtitleRunnerHook(config: {
    pay?: SubtitlePayRunnerConfig[];
    overlay?: SubtitleOverlayRunnerConfig;
}): RunnerHook {
    return { module: SUBTITLE_RUNNER_MODULE, config };
}
