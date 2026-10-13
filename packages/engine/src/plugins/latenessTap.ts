/**
 * The `mrlateness` instrument (house-clock design §9.5, plan WI-P0-8): where
 * the taps go and what they are called. Bus edges get theirs from
 * `buildBusSrc`/`buildBusSink`; output modules put `buildLatenessTap()` right
 * before their final sink. Every tap posts one `mrlateness` window per 2 s,
 * which both runners forward as the plugin event `mrlateness:<tap name>`.
 */
import { resolveNativeAsset } from '../child-process/nativeBinaries.js';

/** Plugin-event channel prefix: `mrlateness:<tap name>`. */
export const LATENESS_EVENT = 'mrlateness';
/** Bus-ingress taps are named `lat_busin*`, bus-egress taps `lat_busout_<port>`. */
export const LAT_IN_PREFIX = 'lat_busin';
export const LAT_OUT_PREFIX = 'lat_busout';
/** The tap before an output's sink: rendering (`lat_render`) or the wire (`lat_egress`). */
export type OutputTapName = 'lat_render' | 'lat_egress';

let available: boolean | undefined;

/**
 * Whether `libgstmrlateness.so` is installed, checked once per process. When
 * it is not, no fragment names the element, so a pipeline never fails to
 * parse over a missing instrument (the module says so in its timing section).
 */
export function latenessTapAvailable(): boolean {
    available ??= resolveNativeAsset('mpegts-core', 'mrlateness', 'libgstmrlateness.so') !== null;
    return available;
}

/** Pin (or with `undefined`, re-probe) the availability — tests and the vitest setup. */
export function setLatenessTapAvailable(value: boolean | undefined): void {
    available = value;
}

/**
 * The tap before an output module's sink. `running-time` because a sink
 * renders on its pipeline clock; null when the instrument is missing.
 */
export function buildLatenessTap(name: OutputTapName): string | null {
    return latenessTapAvailable() ? `mrlateness name=${name} reference=running-time` : null;
}

/** `sink` with the output tap in front of it, or `sink` alone without the instrument. */
export function withLatenessTap(name: OutputTapName, sink: string): string {
    const tap = buildLatenessTap(name);
    return tap ? `${tap} ! ${sink}` : sink;
}

/** A bus-edge tap: `house` reads raw PTS against CLOCK_MONOTONIC (§4.3). */
export function busLatenessTap(name: string): string {
    return latenessTapAvailable() ? ` ! mrlateness name=${name} reference=house` : '';
}
