import {
    firstConnectedDisplay,
    listDrmConnectors,
    pickActiveDisplay,
    resolveConnectorMode,
    type ActiveDisplayChoice,
} from '@media-router/engine';
import { hasWaylandSession } from './wayland.js';
import {
    buildPipelineEnv,
    DEFAULT_SURFACE,
    type SinkSelectionEnv,
    type SurfaceSize,
} from './pipelines.js';
import { resolveWestonSurface } from './westonOutput.js';

/**
 * "Where does this pipeline render?" — everything the video player has to
 * settle before it can build a pipeline at all: is there a lit display, is a
 * compositor there to render through, which connector do we actually land on,
 * and how big is the surface on it.
 *
 * The two guards below can veto the whole build, so they live together with
 * the connector pick rather than being scattered through `buildPipeline`. All
 * functions here are read-only over sysfs / env / weston.ini — they return
 * decisions as data (including the health message to raise) and the module
 * applies them.
 */

/** Sink elements installed on this host — probed once at plugin load. */
export interface SinkAvailability {
    /** Whether `waylandsink` is installed. */
    wayland: boolean;
    /** Whether `kmssink` is installed. */
    kms: boolean;
}

/** A guard vetoed the build: no pipeline, and this is why. */
export interface RenderTargetBlocked {
    kind: 'blocked';
    health: 'error' | 'warning';
    message: string;
}

/** Everything the pipeline builders need about the output we're rendering to. */
export interface RenderTargetReady {
    kind: 'ready';
    /** Connector actually chosen, plus the substitution flag for health. */
    active: ActiveDisplayChoice;
    /** Sink-selection inputs — see `buildSink`. */
    sinkEnv: SinkSelectionEnv;
    /**
     * `active.name` is empty when the user hasn't picked a display
     * (`pickActiveDisplay('')` returns an empty name by design), which left
     * the surface with NO `MR_GLIB_PRGNAME` app_id. kiosk-shell only maps
     * surfaces whose app_id is listed in that output's `app-ids=`, so an
     * unpinned surface is never placed and the video is simply absent —
     * exactly the "output that isn't lit" failure `pickActiveDisplay` warns
     * about. Fall back to the first lit physical output so an unconfigured
     * module renders instead of silently going nowhere. Also the basis for the
     * fallback card's surface size.
     */
    renderConnector: string;
    /**
     * On the wayland (kiosk-shell fullscreen) path the compositor scales our
     * surface onto the output itself, so the live pipeline must not scale in
     * software. KMS / autovideosink have no compositor and keep their own
     * scaler. See `buildLivePipeline`.
     */
    waylandFullscreen: boolean;
    /** Per-pipeline env for the runner (wayland surface app_id pinning). */
    env: Record<string, string>;
}

export type RenderTarget = RenderTargetBlocked | RenderTargetReady;

/**
 * Connector name the module should treat as "our output" for anything that
 * needs a name rather than a sink (the cog restack watch, the fallback card's
 * size).
 *
 * Same fallback as the surface/app_id resolution in `resolveRenderTarget`:
 * with no display configured, `pickActiveDisplay('')` returns an empty name —
 * which silently disabled the cog poll watch (`findCogPidForDisplay('')`
 * matches nothing), so a cog respawn after a weston restart could land ON TOP
 * of the video and starve its frame callbacks to ~1 fps while decode kept
 * burning CPU, with no recovery. Observed on a Pi 4 field device, 2026-08-01.
 */
export function activeDisplayName(requestedDisplay: string): string {
    return pickActiveDisplay(requestedDisplay).name || firstConnectedDisplay() || '';
}

/**
 * Resolve the render target, or veto the build.
 *
 * Runs the two guards in order (headless, then compositor) and, if neither
 * fires, resolves the connector we actually render on and the sink/env inputs
 * derived from it.
 */
export function resolveRenderTarget(
    requestedDisplay: string,
    sinks: SinkAvailability,
): RenderTarget {
    // Headless guard: this host has DRM connectors but none is a connected
    // physical output (`Writeback-*` is the compositor's virtual screencast
    // sink, not a screen) — there is nowhere to render. Return no pipeline
    // instead of letting a sink error-loop (kmssink has no connector to
    // drive, and waylandsink has no compositor since Weston itself can't
    // start without a display), and set health so the manager UI shows WHY
    // there's no video. Recovery is automatic: when a display is plugged
    // in the compositor comes up, the wayland-session watcher sees the
    // fresh socket and restartPipeline() re-evaluates this guard. An
    // explicitly selected connector that IS connected (even a virtual one
    // — an operator may deliberately target Writeback capture) is
    // honoured. Hosts with no DRM subsystem at all (dev machines) skip the
    // guard and keep the autovideosink path.
    const connectors = listDrmConnectors();
    const requestedConnected = connectors.some(
        (c) =>
            c.name === requestedDisplay && (c.meta?.status as string | undefined) === 'connected',
    );
    if (connectors.length > 0 && !firstConnectedDisplay() && !requestedConnected) {
        return {
            kind: 'blocked',
            health: 'error',
            message: 'No display connected — video output unavailable',
        };
    }
    // Compositor gate: waylandsink installed means this host renders
    // through the compositor (multi-display and rotation are compositor
    // features — kmssink has neither). With a display CONNECTED but no
    // session yet (boot or hotplug window, compositor restarting), do NOT
    // fall back to kmssink: it takes the DRM master and then fights the
    // compositor's startup for it — observed after display hotplug as
    // video flashing over the console (kmssink letterboxing onto the raw
    // mode) and then vanishing while both sides restart. Idle with a
    // clear health state instead; the wayland-session watcher restarts
    // this module the moment the compositor's socket appears. Hosts
    // without waylandsink installed keep the KMS-direct path.
    if (sinks.wayland && !hasWaylandSession()) {
        return {
            kind: 'blocked',
            health: 'warning',
            message: 'Display connected — waiting for compositor',
        };
    }
    // If the user-picked connector isn't `connected`, fall through to the
    // first connector that is. Both kmssink (via connector-id) and
    // waylandsink (via the MR_GLIB_PRGNAME app_id that kiosk-shell pins
    // to per-output `app-ids=` in weston.ini) need the *active* display
    // name, otherwise the surface lands on an output that isn't lit and
    // looks the same to the user as "video player won't start".
    const active = pickActiveDisplay(requestedDisplay);
    const sinkEnv: SinkSelectionEnv = {
        ...sinks,
        waylandSession: hasWaylandSession(),
        connectorId: active.connectorId,
    };
    const renderConnector = active.name || firstConnectedDisplay() || '';
    return {
        kind: 'ready',
        active,
        sinkEnv,
        renderConnector,
        waylandFullscreen: sinkEnv.wayland && sinkEnv.waylandSession,
        env: buildPipelineEnv(renderConnector, sinkEnv),
    };
}

/**
 * Size the fallback card to the output's own mode (the live path needs no
 * size — it renders at source resolution). Falls back to DEFAULT_SURFACE when
 * the mode can't be read (nothing plugged in), which is also all
 * autovideosink/headless needs.
 *
 * `renderConnector` rather than the raw configured display: an unconfigured
 * module otherwise always got the default surface and, on a 1080p panel, drew
 * a 720p card that the compositor upscaled straight back.
 *
 * On the compositor path the size must be the output's LOGICAL geometry
 * (weston.ini `mode=` / `transform=`), not the kernel's preferred mode: a
 * rotated output swaps the canvas axes, and fit-scaling a portrait surface
 * into a rotated landscape canvas renders the card as a small band. See
 * resolveWestonSurface. KMS / autovideosink have no compositor, so weston.ini
 * must not apply there — those keep the raw sysfs mode.
 */
export function resolveFallbackSurface(
    renderConnector: string,
    waylandFullscreen: boolean,
): SurfaceSize {
    return (
        (waylandFullscreen
            ? resolveWestonSurface(renderConnector)
            : resolveConnectorMode(renderConnector)) ?? DEFAULT_SURFACE
    );
}

/**
 * Operator-facing description of the render path, for the module's `display`
 * status panel.
 *
 * Mirrors the selection logic in `buildSink` so the user sees the render path
 * that's actually being used, not a stale DRM assumption. `status` carries
 * only the renderer-reachability state (compositor / connected / no display /
 * unavailable). Target-mismatch is conveyed by the optional `requested` field,
 * only set when the user picked a display and we substituted a different one —
 * the substitution is implicit in the presence of `requested`, so there's no
 * separate boolean to render as a noisy "substituted: —" row.
 */
export function describeRenderPath(
    requestedDisplay: string,
    sinks: SinkAvailability,
): Record<string, string> {
    const active = pickActiveDisplay(requestedDisplay);
    const env = { ...sinks, waylandSession: hasWaylandSession() };
    let renderPath = 'autovideosink';
    let target = '—';
    let status = 'unavailable';
    if (env.wayland && env.waylandSession) {
        renderPath = 'waylandsink';
        target = active.name || process.env.WAYLAND_DISPLAY || 'wayland';
        status = 'compositor';
    } else if (active.name && env.kms) {
        renderPath = 'kmssink';
        target = active.name;
        status = 'connected';
    } else if (env.kms) {
        const firstConnected = listDrmConnectors().find(
            (c) => (c.meta?.status as string) === 'connected',
        );
        renderPath = 'kmssink';
        target = firstConnected?.name ?? '(auto)';
        status = firstConnected ? 'connected' : 'no display';
    }
    const displayStatus: Record<string, string> = { renderer: renderPath, target, status };
    if (active.substituted) displayStatus.requested = requestedDisplay;
    return displayStatus;
}
