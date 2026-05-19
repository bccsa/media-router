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
 */
export function registerPipeWireDeviceProvider(
    services: EngineServices,
    opts: PipeWireDeviceProviderOptions,
): void {
    const { type, direction, pollMs } = opts;
    services.deviceProviders.register({
        type,
        pollMs,
        list: () =>
            services.pipeWire
                .listDevices()
                .filter((d) => d.direction === direction)
                .map(
                    (d): Device => ({
                        name: d.name,
                        label: `${d.description || d.name} (${d.channels ?? '?'}ch, ${d.sampleRate ?? '?'}Hz)`,
                        meta: {
                            direction: d.direction,
                            channels: d.channels,
                            sampleRate: d.sampleRate,
                        },
                    }),
                ),
    });
}
