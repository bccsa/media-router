import type { Device } from '@media-router/shared-types';
import type { EngineServices } from '../plugins/PluginModule.js';

export interface PipeWireDeviceProviderOptions {
    /** Device-type key the manager-UI dropdown looks up (e.g. `'audio-source'`, `'audio-sink'`). */
    type: string;
    /** PipeWire direction to filter on. */
    direction: 'source' | 'sink';
    /** Poll cadence in ms passed through to the registry. Default is the registry default (2000ms). */
    pollMs?: number;
}

/**
 * Register a device provider that exposes PipeWire sources/sinks under a
 * custom `type` key. The list is regenerated on every poll, so hot-plug
 * insertions and removals appear without any extra wiring on the plugin's
 * side.
 *
 * Replaces the boilerplate that `audio-input` and `audio-output` previously
 * duplicated — call from a plugin's static `registerServices(services)` hook.
 *
 * The sink poll doubles as the detection point for volume normalisation: any
 * hardware sink not at unity gain is reset, so a device is corrected as soon
 * as it is enumerated and again if something (WirePlumber restore, alsamixer)
 * pulls it back down. See `SinkVolumeNormalizer`.
 */
export function registerPipeWireDeviceProvider(
    services: EngineServices,
    opts: PipeWireDeviceProviderOptions,
): void {
    const { type, direction, pollMs } = opts;
    services.deviceProviders.register({
        type,
        pollMs,
        list: () => {
            const devices = services.pipeWire.listDevices();
            if (direction === 'sink') services.pipeWire.normalizeSinkVolumes(devices);
            return devices
                .filter((d) => d.direction === direction)
                .map(
                    (d): Device => ({
                        name: d.name,
                        label: `${d.description || d.name} (${d.channels ?? '?'}ch, ${d.sampleRate ?? '?'}Hz)`,
                        // Deliberately no volume here — the registry diffs this
                        // JSON to decide when to emit `deviceList`, and a
                        // fluctuating volume would spam the manager.
                        meta: {
                            direction: d.direction,
                            channels: d.channels,
                            sampleRate: d.sampleRate,
                        },
                    }),
                );
        },
    });
}
