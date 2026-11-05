import type { Device } from '@media-router/shared-types';
import type { AudioDevice } from '../audio/PipeWireManager.js';
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
 *
 * While PipeWire gives no answer the list is its last answer, each device marked
 * (`meta.stale`, and its label) with why and since when; with no device to mark, one
 * nameless entry says so (B-207). Never an empty list, which would read as none.
 */
export function registerPipeWireDeviceProvider(
    services: EngineServices,
    opts: PipeWireDeviceProviderOptions,
): void {
    const { type, direction, pollMs } = opts;
    services.deviceProviders.register({
        type,
        pollMs,
        list: async () => {
            const listing = await services.pipeWire.deviceListing();
            const devices = (listing.devices ?? []).filter((d) => d.direction === direction);
            if (listing.stale === null) {
                if (direction === 'sink') services.pipeWire.normalizeSinkVolumes(listing.devices);
                return devices.map((d) => entry(d));
            }
            const stale = { reason: listing.stale.reason, since: isoSecond(listing.stale.since) };
            if (devices.length > 0) return devices.map((d) => entry(d, stale));
            const lead = listing.devices ? "No device in PipeWire's last list —" : 'No answer:';
            return [{ name: '', label: `${lead} ${staleText(stale)}`, meta: { stale } }];
        },
    });
}

/** Why a list is PipeWire's last answer: `reason` and since when (ISO 8601, to the second). */
interface StaleMark {
    reason: string;
    since: string;
}

const isoSecond = (epochMs: number): string =>
    new Date(epochMs).toISOString().replace(/\.\d+Z$/, 'Z');
const staleText = (stale: StaleMark): string => `${stale.reason} since ${stale.since}`;

/** One device as the dropdown lists it; a stale one carries why in its label and `meta.stale`. */
function entry(d: AudioDevice, stale?: StaleMark): Device {
    const label = `${d.description || d.name} (${d.channels ?? '?'}ch, ${d.sampleRate ?? '?'}Hz)`;
    return {
        name: d.name,
        label: stale ? `${label} — ${staleText(stale)}` : label,
        // Deliberately no volume here — the registry diffs this
        // JSON to decide when to emit `deviceList`, and a
        // fluctuating volume would spam the manager.
        meta: {
            direction: d.direction,
            channels: d.channels,
            sampleRate: d.sampleRate,
            ...(stale && { stale }),
        },
    };
}
