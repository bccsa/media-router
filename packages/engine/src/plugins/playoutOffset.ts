/**
 * Playout offset D — ADR-0005 decision 4.
 *
 * Under the time-sync contract producers stamp bus buffer PTS with house-clock
 * media time (decisions 2+3), so a presentation sink no longer has to guess when
 * to render: it schedules at `stamped-time + D`. D is a CONFIGURED BUDGET, not a
 * best-effort — one engine-wide default plus a per-route override.
 *
 * Where the override lives, and why it is not on the sink. Decision 4 rejects
 * "per-sink-only config — reproduces today's failure mode of independently
 * trimmed sinks". So the override is read off the ROUTE HEAD: the producer
 * module both consumer legs take their bus from. Every leg of a route resolves
 * the same producer and therefore the same number BY CONSTRUCTION — there is no
 * conflict rule to get wrong, and no sync-group registry (which decision 4
 * deferred). The GUI needs nothing new: a route head exposes `playoutOffsetMs`
 * in its own `configSchema` like any other module setting.
 *
 * `lipSyncMs` (video-player) and `syncOffsetMs` (audio-decoder) survive as
 * DEPRECATED aliases and are added ON TOP of D as a per-sink trim — their real
 * job is trimming residual display/DAC-chain skew, which is genuinely per-sink
 * and which D cannot know about.
 *
 * With the contract OFF this whole file resolves to the trim alone, i.e. exactly
 * the legacy numbers (decision 10's kill-switch: `MR_TIME_SYNC_CONTRACT=0`).
 */

/** Engine-wide default playout offset when nothing else says otherwise (ADR-0005 decision 4; lowered from the original ~300 ms to 60 ms on 2026-09-03 after measured LAN arrival jitter of -19/+14 ms p10/p90 — see the decision-4 amendment). */
export const DEFAULT_PLAYOUT_OFFSET_MS = 60;

/**
 * Upper bound for any playout offset value. A sink's `ts-offset` is a hard
 * scheduling delay: a fat-fingered 300000 would park the picture five minutes in
 * the future with no error anywhere. 10 s is far beyond any real budget and well
 * short of "looks broken forever".
 */
export const MAX_PLAYOUT_OFFSET_MS = 10_000;

/** Config key carrying a route's playout-offset override, on the route head. */
export const PLAYOUT_OFFSET_KEY = 'playoutOffsetMs';

/**
 * Coerce an untrusted playout-offset value (config JSON, env var) to a usable
 * millisecond budget. Anything that isn't a finite number in [0, MAX] is
 * REJECTED rather than clamped: a caller that can't tell "absent" from
 * "nonsense" would silently run a mistyped value as if it were chosen.
 */
export function parsePlayoutOffsetMs(raw: unknown): number | undefined {
    // `Number('')` and `Number('  ')` are 0, so an unset-but-present env var
    // (`MR_PLAYOUT_OFFSET_MS=`) would otherwise read as a deliberate 0 ms and
    // pin every route to render-immediately instead of falling through.
    if (typeof raw === 'string' && raw.trim() === '') return undefined;
    const n = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
    if (n < 0 || n > MAX_PLAYOUT_OFFSET_MS) return undefined;
    return n;
}

/**
 * Engine-wide default D, in the same precedence shape as
 * `EngineConfig.timeSyncContract`: an explicit config value wins, else the
 * `MR_PLAYOUT_OFFSET_MS` env var (so the fleet can retune from the unit file
 * without a code change), else `DEFAULT_PLAYOUT_OFFSET_MS`. An unparseable env
 * value is ignored and falls through to the default.
 */
export function resolveEnginePlayoutOffsetMs(
    configValue: unknown,
    envValue: string | undefined,
): number {
    return (
        parsePlayoutOffsetMs(configValue) ??
        parsePlayoutOffsetMs(envValue) ??
        DEFAULT_PLAYOUT_OFFSET_MS
    );
}

/** The route-lookup surface `effectivePlayoutOffsetMs` needs from `MediaRouter`. */
export interface PlayoutOffsetRouteSource {
    /** Override declared by the route head feeding `consumerModuleId`, if any. */
    getRoutePlayoutOffsetMs(consumerModuleId: string, sinkPortId?: string): number | undefined;
}

/** The slice of `ModuleServices` the resolution reads. */
export interface PlayoutOffsetServices {
    instanceId?: string;
    timeSyncContract?: boolean;
    /** Engine-wide default — see `EngineServices.playoutOffsetMs`. */
    playoutOffsetMs?: number;
    mediaRouter?: Partial<PlayoutOffsetRouteSource>;
}

export interface PlayoutOffsetOptions {
    /**
     * Per-sink trim added on top of D — the deprecated `lipSyncMs` /
     * `syncOffsetMs` aliases. Applied in BOTH modes, so with the contract off
     * the result is the trim alone and the legacy pipeline string is unchanged.
     */
    trimMs?: number;
    /** Sink port to resolve the route through (multi-input consumers). */
    sinkPortId?: string;
}

/**
 * The one definition of a presentation sink's `ts-offset`, in milliseconds.
 *
 * Both consumer legs of a route call THIS — not their own arithmetic — which is
 * what makes "the same route resolves to the same D on every leg" a property of
 * the code rather than of two implementations that happen to agree today.
 *
 * Contract off ⇒ the trim alone (byte-identical legacy behaviour).
 */
export function effectivePlayoutOffsetMs(
    services: PlayoutOffsetServices | null | undefined,
    opts: PlayoutOffsetOptions = {},
): number {
    const trim = Number(opts.trimMs ?? 0) || 0;
    if (!services?.timeSyncContract) return trim;
    const routeOverride = services.instanceId
        ? services.mediaRouter?.getRoutePlayoutOffsetMs?.(services.instanceId, opts.sinkPortId)
        : undefined;
    // The override REPLACES the engine default for this route (it is that
    // route's budget, not a delta on top of one); the per-sink trim is what
    // stacks.
    const base =
        parsePlayoutOffsetMs(routeOverride) ??
        parsePlayoutOffsetMs(services.playoutOffsetMs) ??
        DEFAULT_PLAYOUT_OFFSET_MS;
    return base + trim;
}

/** `effectivePlayoutOffsetMs` in nanoseconds — the unit `ts-offset` takes. */
export function effectivePlayoutOffsetNs(
    services: PlayoutOffsetServices | null | undefined,
    opts: PlayoutOffsetOptions = {},
): number {
    return Math.round(effectivePlayoutOffsetMs(services, opts) * 1_000_000);
}
