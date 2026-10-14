/**
 * Plan ch. 3 part 4.5 rule 6: a runner could not use libgstmrtshouse.so (missing, or its ABI is
 * below the runner's). Both runners send this sentence too (gst_native_plugins.py, native_plugins.h).
 */
export const TIMING_PLUGIN_ALARM =
    'Native TS module not loaded: this stream carries no house time on the bus; consumers will mis-time it until the deploy is fixed.';

/** The alarm with the runner's specifics: the tried paths, or both ABI numbers and the path. */
export function timingPluginAlarm(detail?: string): string {
    return detail ? `${TIMING_PLUGIN_ALARM} (${detail})` : TIMING_PLUGIN_ALARM;
}

/**
 * The runner's `timingPlugin` channel (GstRunner): `detail` from its `warning` event (the plugin
 * could not be used), or `loaded` from a `started` event that loaded it.
 */
export interface TimingPluginEvent {
    detail?: string;
    loaded?: { version: string; abi: number; path: string };
}
