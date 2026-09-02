import type { Device } from '@media-router/shared-types';
import type { EngineServices } from '../plugins/PluginModule.js';
import { cachedV4l2Devices, listV4l2Devices } from './v4l2Devices.js';

/** Device-type key the manager-UI dropdown looks up for V4L2 capture fields. */
export const V4L2_DEVICE_TYPE = 'video';

/**
 * Idle re-enumeration cadence — the slow heartbeat that still notices a capture
 * card plugged into a host with no video modules on it, at 1/30th the cost of
 * the demand cadence.
 */
export const V4L2_IDLE_ENUMERATE_MS = 60_000;

/**
 * Instantiated modules that consume V4L2 device data (see `acquireV4l2Demand`).
 * Module-scoped, like the enumerator's own cache: one engine process, one host.
 */
let consumers = 0;
/** When the last enumeration was paid for, on the wall clock. */
let lastEnumerateAt = 0;

/**
 * Enumerating V4L2 is expensive: `v4l2-ctl` runs once for the listing and TWICE
 * MORE PER NODE, and a Pi exposes a dozen-plus `/dev/video*` entries for ISP and
 * codec sub-devices. At the registry's 2 s cadence that measured ~420 execs/min
 * and 12.4 % of a core on a Pi 400 — burnt continuously on a host whose only
 * video use is playback, with not one module that wants the list.
 *
 * So the enumeration is demand-driven: full cadence while at least one module
 * that consumes the list exists, otherwise the cached list is served and a
 * refresh is paid for only once per `V4L2_IDLE_ENUMERATE_MS`.
 *
 * The gate is inside `list()` rather than on the registry's poll timer BECAUSE
 * the timer is not the only caller: `EngineEventWiring` re-sends every device
 * snapshot on the 10 s manager heartbeat via `getDevices()`, which goes straight
 * to `list()`. Gating the timer alone would have left two thirds of the burn.
 *
 * Freshness where it counts is preserved: the picker for a `video` field only
 * exists inside an instantiated video module, and that module holds a demand
 * token from construction to destruction — so the list behind an open picker is
 * always the 2 s one. (There is no narrower "picker is open" signal to use: the
 * manager pushes cached lists to browsers, and nothing in-tree calls the
 * engine's on-demand `/api/v1/system/devices/:type` route.)
 */
export function listV4l2DevicesOnDemand(): Promise<Device[]> | Device[] {
    if (Date.now() < suspendedUntil) {
        return cachedV4l2Devices();
    }
    if (consumers === 0 && Date.now() - lastEnumerateAt < V4L2_IDLE_ENUMERATE_MS) {
        return cachedV4l2Devices();
    }
    lastEnumerateAt = Date.now();
    return listV4l2Devices();
}

/** Enumeration blackout deadline — see `suspendV4l2Enumeration`. */
let suspendedUntil = 0;

/**
 * Black out V4L2 enumeration for the next `ms` milliseconds; overlapping calls
 * extend, never shorten. The cached list is served meanwhile.
 *
 * WHY THIS EXISTS. Opening ANY `/dev/video*` node while a pipeline that uses
 * the bcm2835 hardware JPEG decoder is SETTING UP wedges that pipeline before
 * PLAYING, or fails v4l2src's buffer allocation with EINVAL (kernel 6.12,
 * Pi 4 — reproduced deterministically: a `v4l2-ctl --list-devices` loop wedged
 * 3/3 startup attempts of `v4l2src ! jpegparse ! v4l2jpegdec`, including
 * variants that only touched OTHER nodes; the identical pipeline starts clean
 * every time with enumeration quiet). Every `v4l2-ctl` this provider spawns
 * opens every node, so a module that is about to start a capture pipeline
 * calls this first. The blackout is a WINDOW, not a lock, because
 * runner-internal restarts can also re-enter setup without the engine's
 * knowledge — those stay exposed, but the runner's 10 s reach-PLAYING watchdog
 * turns a wedged attempt into a retry rather than a hang.
 */
export function suspendV4l2Enumeration(ms: number): void {
    suspendedUntil = Math.max(suspendedUntil, Date.now() + ms);
}

/**
 * Claim the full enumeration cadence for one module instance. Called from the
 * consuming module's constructor — i.e. when the module is INSTANTIATED, not
 * when it starts: a module sitting stopped on the canvas still has a device
 * picker in its settings panel. Balance every call with `releaseV4l2Demand`.
 */
export function acquireV4l2Demand(): void {
    consumers += 1;
}

/** Drop one instance's claim (module destroyed). Never goes negative. */
export function releaseV4l2Demand(): void {
    if (consumers > 0) consumers -= 1;
}

/**
 * Register the `video` device provider so a config field with
 * `x-deviceType: "video"` renders as a dropdown of the host's capture devices.
 * Idempotent — the first registration wins, like the network-interface one.
 *
 * Call from a plugin's static `registerServices(services)` hook.
 */
export function registerV4l2DeviceProvider(services: EngineServices): void {
    if (services.deviceProviders.getProvider(V4L2_DEVICE_TYPE)) return;
    services.deviceProviders.register({
        type: V4L2_DEVICE_TYPE,
        // Unchanged cadence: it is what the poll COSTS that is now demand-gated,
        // so hot-plug latency for a host that actually captures video is as
        // before, and an idle tick is a cache read.
        pollMs: 2000,
        list: () => listV4l2DevicesOnDemand(),
    });
}

/** Test-only: forget the demand count, idle-refresh timestamp and blackout. */
export function _resetV4l2DemandForTests(): void {
    consumers = 0;
    lastEnumerateAt = 0;
    suspendedUntil = 0;
}
