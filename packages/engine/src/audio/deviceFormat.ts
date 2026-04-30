/**
 * Shared helpers for resolving an audio device's channel count and sample
 * rate at module init / start / reconnect time. Used by both audio-input
 * and audio-output to avoid drifting copies of the same probe-and-validate
 * logic.
 *
 * The two phases:
 *   - `detectDeviceFormat` (called once at `onInit`): probe PipeWire,
 *     compute pending config updates, surface a health warning when
 *     detection is partial or the device isn't enumerated.
 *   - `resolveDeviceFormat` (called at `onStart` / reconnect): re-probe,
 *     fall back to the persisted config, and refuse to proceed when
 *     channels or sample rate are still unknown — the previous silent
 *     2-channel / 48 kHz fallback caused mono devices to be mis-routed
 *     as stereo.
 */

import type { PipeWireManager } from './PipeWireManager.js';

export interface DeviceFormatState {
    channels: number | null;
    sampleRate: number | null;
}

export interface DeviceDetection {
    detected: DeviceFormatState;
    /** Config keys the caller should patch into its persisted module config. */
    configUpdates: Record<string, unknown>;
    /** When non-null, the caller should `setHealth('warning', this)`. */
    healthWarning: string | null;
}

/**
 * Initial probe at module init. Returns whatever PipeWire reports plus
 * any config updates and a health warning when info is missing.
 */
export function detectDeviceFormat(
    pipeWire: PipeWireManager | undefined,
    deviceName: string,
    config: { channels?: number; sampleRate?: number },
): DeviceDetection {
    const empty: DeviceDetection = {
        detected: { channels: null, sampleRate: null },
        configUpdates: {},
        healthWarning: null,
    };
    if (!pipeWire || !deviceName) return empty;

    const info = pipeWire.getDeviceInfo(deviceName);
    if (!info) {
        return {
            detected: { channels: null, sampleRate: null },
            configUpdates: {},
            healthWarning: `Audio device "${deviceName}" not found — pick a device from the list`,
        };
    }
    const detected: DeviceFormatState = {
        channels: info.channels ?? null,
        sampleRate: info.sampleRate ?? null,
    };
    const configUpdates: Record<string, unknown> = {};
    if (info.channels && info.channels > 0 && info.channels !== config.channels) {
        configUpdates.channels = info.channels;
    }
    if (info.sampleRate && info.sampleRate > 0 && info.sampleRate !== config.sampleRate) {
        configUpdates.sampleRate = info.sampleRate;
    }
    const healthWarning =
        info.channels === undefined
            ? `Could not detect channel count for "${deviceName}" — device may be suspended`
            : null;
    return { detected, configUpdates, healthWarning };
}

/**
 * Re-probe at start time and resolve the {channels, rate} pair to use for
 * the PipeWire remap-source/sink. Throws when neither the live probe nor
 * the persisted config provides a usable value — explicit failure beats
 * running with wrong assumptions for a broadcast pipeline.
 *
 * The returned `detected` field reflects the (possibly refreshed) device
 * state so callers can hold onto it as their authoritative `detectedX`
 * fields.
 */
export function resolveDeviceFormat(
    pipeWire: PipeWireManager | undefined,
    deviceName: string,
    prior: DeviceFormatState,
    config: { channels?: number; sampleRate?: number },
    role: 'input' | 'output',
): { channels: number; rate: number; detected: DeviceFormatState } {
    const resolved = tryResolveDeviceFormat(pipeWire, deviceName, prior, config);
    if (!resolved.channels || resolved.channels <= 0) {
        const hint = role === 'input' ? ' Re-pick the device once it\'s no longer suspended.' : '';
        throw new Error(
            `Cannot start audio ${role} "${deviceName}": channel count is unknown.${hint}`,
        );
    }
    if (!resolved.rate || resolved.rate <= 0) {
        throw new Error(`Cannot start audio ${role} "${deviceName}": sample rate is unknown.`);
    }
    return {
        channels: resolved.channels,
        rate: resolved.rate,
        detected: resolved.detected,
    };
}

/**
 * Same probe-and-resolve logic as `resolveDeviceFormat`, but returns `null`
 * instead of throwing when channels or sample rate can't be determined.
 * Used by the device-reconnect path where a missing format isn't fatal —
 * the caller logs and skips the rebuild until the next reconnect event.
 */
export function tryResolveDeviceFormat(
    pipeWire: PipeWireManager | undefined,
    deviceName: string,
    prior: DeviceFormatState,
    config: { channels?: number; sampleRate?: number },
): { channels: number | null; rate: number | null; detected: DeviceFormatState } {
    const detected: DeviceFormatState = { ...prior };
    if (pipeWire) {
        const info = pipeWire.getDeviceInfo(deviceName);
        if (info?.channels) detected.channels = info.channels;
        if (info?.sampleRate) detected.sampleRate = info.sampleRate;
    }
    const channels = detected.channels ?? config.channels ?? null;
    const rate = detected.sampleRate ?? config.sampleRate ?? null;
    return {
        channels: channels && channels > 0 ? channels : null,
        rate: rate && rate > 0 ? rate : null,
        detected,
    };
}
