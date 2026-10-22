/**
 * WirePlumber policy pins for the engine's PipeWire client streams (#736).
 *
 * Every `pulsesrc` / `pulsesink` / `pipewiresrc` the engine builds names its
 * PipeWire target explicitly (pipewire-pulse turns `device=` into
 * `target.object`). WirePlumber's stock linking policy still treats that name
 * as a *preference*: when the node is absent — a null-sink not yet registered
 * on a slow start, or unloaded and re-created under a live stream — the stream
 * is linked to the DEFAULT sink/source instead, and one graph rescan later
 * `linking.follow-default-target` writes `target.node=-1` metadata that makes
 * the stream ignore its own device property for the rest of its life. Field
 * symptom: an encoder whose null-sink was recycled kept encoding whatever the
 * default sink carried (the Master input) until the engine was restarted.
 *
 * `node.dont-fallback=true` forbids the fallback; `node.linger=true` keeps the
 * stream alive, silent and unlinked, until its target exists — WirePlumber then
 * links it on the next rescan, and re-links it after the target is recycled.
 * Verified on WirePlumber 0.5.14 / PipeWire 1.6.3 (see the #736 write-up).
 */
export const PULSE_PINNED_STREAM_PROPS: Readonly<Record<string, string>> = {
    'node.dont-fallback': 'true',
    'node.linger': 'true',
};

/**
 * `stream-properties=` clause pinning a pulse/pipewire element to its named
 * target. `extra` entries are merged in after the pins; every value is
 * emitted as a `(string)` GstStructure field, which is what PipeWire expects
 * for node properties.
 */
export function pulsePinnedStreamProps(extra: Record<string, string | number> = {}): string {
    const fields = Object.entries({ ...PULSE_PINNED_STREAM_PROPS, ...extra })
        .map(([key, value]) => `${key}=(string)${value}`)
        .join(',');
    return `stream-properties="props,${fields}"`;
}

/**
 * `pipewiresrc` / `pipewiresink` only (B-88): the stream's node on the runner's RT data loop,
 * which module-rt gets SCHED_RR through rtkit. Unset, PipeWire runs it on the plugin's
 * SCHED_OTHER main loop, and an async capture loses whole cycles when the box is busy.
 */
export const PIPEWIRE_RT_STREAM_PROPS: Readonly<Record<string, string>> = {
    'node.loop.class': 'data.rt',
};

/**
 * `stream-properties=` clause for a `pipewiresrc` / `pipewiresink`: the #736 pins, the RT
 * data loop, then `extra`. Pulse elements keep `pulsePinnedStreamProps`: their nodes live
 * in pipewire-pulse, on its own RT loop.
 */
export function pipewireStreamProps(extra: Record<string, string | number> = {}): string {
    return pulsePinnedStreamProps({ ...PIPEWIRE_RT_STREAM_PROPS, ...extra });
}
