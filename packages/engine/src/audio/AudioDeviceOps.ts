import { createLogger } from '@media-router/shared-types';
import type { PaCommandQueue } from './PaCommandQueue.js';
import { MR_PW_PREFIX, type AudioDevice } from './PipeWireManager.js';

const log = createLogger('AudioDeviceOps');

/**
 * Parse the channel count from a `pactl list sources/sinks` block, preferring
 * `Channel Map:` over `Sample Specification:`.
 *
 * Why prefer Channel Map: `Sample Specification: ... Nch ...` reflects the
 * device's *currently active profile*, not its hardware capability. A genuine
 * mono USB device (e.g. "USB PnP Sound Device Mono") with the default
 * `analog-stereo` profile applied will show `2ch` in the spec line — masking
 * the fact that the second channel is just a duplicate of the first. The
 * `Channel Map: mono` line, in contrast, accurately tracks what the active
 * profile *exposes*: `mono` → 1 channel, `front-left,front-right` → 2,
 * `front-left,front-right,front-center,…` → 5.1, etc.
 *
 * Falls back to Sample Specification when Channel Map is missing (very rare —
 * usually only for malformed pactl output).
 */
export function parseDeviceChannels(block: string): number | undefined {
    const mapMatch = block.match(/Channel Map:\s*(.+)/);
    if (mapMatch) {
        const map = mapMatch[1].trim();
        if (map === 'mono') return 1;
        // Comma-separated channel positions (e.g. "front-left,front-right").
        const tokens = map.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        if (tokens.length > 0) return tokens.length;
    }
    const specMatch = block.match(/Sample Specification:\s*\S+\s+(\d+)ch\s+(\d+)Hz/);
    if (specMatch) {
        const n = parseInt(specMatch[1], 10);
        if (n > 0) return n;
    }
    return undefined;
}

/** Parse the sample rate from a `pactl list` block (Sample Specification line). */
export function parseDeviceSampleRate(block: string): number | undefined {
    const specMatch = block.match(/Sample Specification:\s*\S+\s+(\d+)ch\s+(\d+)Hz/);
    if (!specMatch) return undefined;
    const n = parseInt(specMatch[2], 10);
    return n > 0 ? n : undefined;
}

/**
 * Parse one `pactl list sources/sinks` block into an `AudioDevice`. Returns
 * `null` only when the block has no `Name:` field (i.e. it's not a real
 * device entry — e.g. the trailing blank between blocks).
 *
 * SUSPENDED devices that omit `Sample Specification:` are still returned —
 * their channel count comes from `Channel Map:` which is always present
 * even when suspended. This is critical for the audio-input flow: a
 * just-selected device is typically SUSPENDED until something opens it,
 * but the user has already chosen a channel layout for routing.
 */
export function parseDeviceBlock(
    block: string,
    direction: 'source' | 'sink',
): AudioDevice | null {
    const nameMatch = block.match(/Name:\s*(.+)/);
    if (!nameMatch) return null;
    const name = nameMatch[1].trim();
    if (direction === 'source' && name.endsWith('.monitor')) return null;
    if (name.startsWith(MR_PW_PREFIX)) return null;
    const descMatch = block.match(/Description:\s*(.+)/);
    return {
        id: 0,
        name,
        description: descMatch?.[1]?.trim() ?? name,
        direction,
        channels: parseDeviceChannels(block),
        sampleRate: parseDeviceSampleRate(block),
    };
}

/**
 * Audio device operations: volume control and device enumeration. Volume
 * commands go through PaCommandQueue's queue for rate limiting; device
 * listing uses `execImmediate` (bypasses the queue, read-only).
 */
export class AudioDeviceOps {
    constructor(private paQueue: PaCommandQueue) {}

    /**
     * Set volume on a PulseAudio source device (for Audio Input).
     * Device must be explicitly specified — no default fallback.
     */
    async setSourceVolume(device: string, percent: number): Promise<void> {
        if (!device) {
            throw new Error('[PipeWireManager] No source device specified for volume control');
        }
        const vol = Math.max(0, Math.round(percent));
        try {
            await this.paQueue.exec(['set-source-volume', device, `${vol}%`]);
        } catch (err) {
            log.warn({ err }, 'Failed to set source volume');
        }
    }

    /**
     * Set volume on a PulseAudio sink device (for Audio Output).
     * Device must be explicitly specified — no default fallback.
     */
    async setSinkVolume(device: string, percent: number): Promise<void> {
        if (!device) {
            throw new Error('[PipeWireManager] No sink device specified for volume control');
        }
        const vol = Math.max(0, Math.round(percent));
        try {
            await this.paQueue.exec(['set-sink-volume', device, `${vol}%`]);
        } catch (err) {
            log.warn({ err }, 'Failed to set sink volume');
        }
    }

    /**
     * List available audio devices (sources and sinks) with full descriptions.
     */
    listDevices(): AudioDevice[] {
        const devices: AudioDevice[] = [];
        const probe = (kind: 'sources' | 'sinks', direction: 'source' | 'sink') => {
            try {
                const output = this.paQueue.execImmediate(['list', kind]);
                for (const block of output.split('\n\n')) {
                    const dev = parseDeviceBlock(block, direction);
                    if (dev) devices.push(dev);
                }
            } catch (err) {
                log.warn({ err, kind }, 'Failed to list devices');
            }
        };
        probe('sources', 'source');
        probe('sinks', 'sink');
        return devices;
    }

    /**
     * Is this device currently enumerated by PipeWire? Same underlying
     * source as `getDeviceInfo` — kept as a separate method for the
     * presence-only callers (e.g. the device watchdog) where the channel
     * count and sample rate aren't needed and `getDeviceInfo(...) !== null`
     * would be a less expressive idiom.
     */
    hasDevice(deviceName: string): boolean {
        return this.listDevices().some((d) => d.name === deviceName);
    }

    /**
     * Get device info (channels, sampleRate) for a specific source or sink.
     * Returns whatever fields could be parsed from the pactl block — channels
     * is reliable even on SUSPENDED devices (read from `Channel Map:`),
     * sampleRate may be undefined when the active profile hasn't reported a
     * `Sample Specification:` line yet. Returns `null` only when the device
     * isn't enumerated at all.
     */
    getDeviceInfo(deviceName: string): { channels?: number; sampleRate?: number } | null {
        const devices = this.listDevices();
        const dev = devices.find((d) => d.name === deviceName);
        if (!dev) return null;
        return { channels: dev.channels, sampleRate: dev.sampleRate };
    }
}
