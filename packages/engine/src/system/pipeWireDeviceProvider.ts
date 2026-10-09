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

const titleOf = (d: AudioDevice) => d.description || d.name;

/**
 * The per-unit part of a USB serial: its last alphanumeric run (the MVX2U's
 * 32-hex id). WirePlumber keeps alphanumerics when it builds `node.name`, so
 * the id reads there verbatim: `…_MVX2U_3-efece7ff193b…-01.analog-stereo`.
 */
const serialId = (d: AudioDevice) => d.serial?.match(/[A-Za-z0-9]+/g)?.at(-1);

/** Heads of the ids: 8 chars, longer only while two of them still match. */
function heads(ids: Array<string | undefined>): Array<string | undefined> {
    for (let n = 8; ; n++) {
        const h = ids.map((id) => id?.slice(0, n));
        if (new Set(h).size === ids.length || ids.every((id) => (id?.length ?? 0) <= n)) return h;
    }
}

/**
 * Tags for devices whose label title another device in the same list shares
 * (two identical USB interfaces, the Pi's two HDMI outputs), keyed by node
 * name. A twin gets the first candidate that tells every twin apart: the head
 * of its serial id (where the twins' node names first differ, so any text that
 * prints the node name shows it too), else its bus path, else its node name.
 * Unique titles get none.
 */
function twinTags(devices: AudioDevice[]): Map<string, string> {
    const groups = new Map<string, AudioDevice[]>();
    for (const d of devices) groups.set(titleOf(d), [...(groups.get(titleOf(d)) ?? []), d]);
    const tags = new Map<string, string>();
    for (const twins of groups.values()) {
        if (twins.length < 2) continue;
        const pick = [
            heads(twins.map(serialId)),
            twins.map((d) => d.busPath?.replace(/^platform-/, '')),
            twins.map((d) => d.name),
        ].find((t) => t.every(Boolean) && new Set(t).size === twins.length);
        pick?.forEach((tag, i) => tags.set(twins[i].name, tag!));
    }
    return tags;
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
 * Labels read `<description> (<N>ch, <rate>Hz)`; devices that share a
 * description get a per-unit tag after it (`twinTags`). The value is always
 * the node name.
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
            const mine = devices.filter((d) => d.direction === direction);
            const tags = twinTags(mine);
            return mine.map((d): Device => {
                const tag = tags.get(d.name);
                return {
                    name: d.name,
                    label: `${titleOf(d)}${tag ? ` · ${tag}` : ''} (${d.channels ?? '?'}ch, ${d.sampleRate ?? '?'}Hz)`,
                    // Deliberately no volume here — the registry diffs this
                    // JSON to decide when to emit `deviceList`, and a
                    // fluctuating volume would spam the manager.
                    meta: {
                        direction: d.direction,
                        channels: d.channels,
                        sampleRate: d.sampleRate,
                    },
                };
            });
        },
    });
}
