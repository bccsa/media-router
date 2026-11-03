import { createLogger } from '@media-router/shared-types';
import type { PaCommandQueue } from './PaCommandQueue.js';
import { MR_PW_PREFIX, type AudioDevice } from './PipeWireManager.js';
import { SharedRead } from './SharedRead.js';

const log = createLogger('AudioDeviceOps');

/**
 * PulseAudio's unity-gain reference (`PA_VOLUME_NORM`) — the raw value pactl
 * renders as `100% / 0.00 dB`. Volumes are compared and set in raw units
 * rather than percent because pactl rounds the percentage it prints (65530
 * also renders as `100%`), and we want an exact, idempotent target.
 */
export const PA_VOLUME_NORM = 65536;

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
        const tokens = map
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
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
 * Parse the per-channel raw volumes from a `pactl list` block.
 *
 * The line looks like:
 *   `Volume: front-left: 26214 /  40% / -23.88 dB,   front-right: 26214 / ...`
 * or, for a mono device, `Volume: mono: 65536 / 100% / 0.00 dB`.
 *
 * The `^[ \t]*` anchor matters: it keeps `Base Volume:` (a different line,
 * always at 65536) from being mistaken for the current volume.
 *
 * Returns an empty array when the block has no volume line — pactl omits it
 * for some virtual devices, and "unknown" must not be read as "attenuated".
 */
export function parseDeviceVolumes(block: string): number[] {
    const match = block.match(/^[ \t]*Volume:[ \t]*(.+)$/m);
    if (!match) return [];
    return [...match[1].matchAll(/:\s*(\d+)\s*\//g)].map((m) => parseInt(m[1], 10));
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
export function parseDeviceBlock(block: string, direction: 'source' | 'sink'): AudioDevice | null {
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
        volumes: parseDeviceVolumes(block),
    };
}

/**
 * `pactl info`'s `Cookie:`: the PipeWire daemon's core cookie, random at every daemon start
 * (impl-core.c `pw_rand32`, served by pipewire-pulse), so it changes when PipeWire restarts.
 */
export function parseServerCookie(info: string): string | null {
    return info.match(/^\s*Cookie:\s*(\S+)/m)?.[1] ?? null;
}

/** How long one `pactl list` snapshot is reused before it is re-fetched. */
export const DEFAULT_DEVICE_CACHE_TTL_MS = 1000;

export interface AudioDeviceOpsOptions {
    /** Snapshot lifetime in ms — `0` disables caching. Default 1000. */
    cacheTtlMs?: number;
    /** Monotonic-ish clock, injectable for tests. Default `Date.now`. */
    now?: () => number;
}

/**
 * Audio device operations: volume control and device enumeration. Volume
 * commands go through PaCommandQueue's queue for rate limiting; device
 * listing uses `execImmediateAsync` (bypasses the queue, read-only).
 *
 * Listing is CACHED for `cacheTtlMs`. Every caller of `hasDevice` /
 * `getDeviceInfo` / `listDevices` used to spawn two `pactl list` processes
 * (sources + sinks): two device providers polling every 2 s plus one
 * DeviceWatchdog per audio module added up to ~4 pactl spawns per second on
 * a 5-module Pi 4 profile, ~10 % of a core across node, pipewire-pulse and
 * wireplumber. With the cache the same callers cost at most two spawns per
 * second, usually fewer, and hot-plug is still seen within TTL + poll period.
 * The cache is dropped as soon as any queued (mutating) pactl command
 * settles — see `PaCommandQueue.onMutation`.
 *
 * Nothing here blocks the event loop (B-200): a listing is asked without waiting, one at a time
 * (`SharedRead`), and a hung PipeWire costs its readers one pactl timeout, not the engine.
 */
export class AudioDeviceOps {
    private readonly now: () => number;
    private readonly listing: SharedRead<AudioDevice[]>;
    private readonly info: SharedRead<string | null>;
    /** Since when pactl gets no answer (null: it answers): one line per outage, not per call. */
    private outageSince: number | null = null;
    /** The last device listing got an answer. */
    private listed = true;

    constructor(
        private paQueue: PaCommandQueue,
        opts: AudioDeviceOpsOptions = {},
    ) {
        const ttlMs = opts.cacheTtlMs ?? DEFAULT_DEVICE_CACHE_TTL_MS;
        this.now = opts.now ?? Date.now;
        this.listing = new SharedRead(() => this.fetchDevices(), ttlMs, this.now);
        this.info = new SharedRead(() => this.fetchServerCookie(), ttlMs, this.now);
        this.paQueue.onMutation = () => this.invalidateDeviceCache();
    }

    /** Forget the cached listing — the next read re-runs `pactl list`. */
    invalidateDeviceCache(): void {
        this.listing.invalidate();
    }

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
    async listDevices(): Promise<AudioDevice[]> {
        return [...(await this.listing.get())];
    }

    /** The PipeWire daemon's identity (`parseServerCookie`), cached like the listing; null when
     *  unknown. Asked without blocking, one `pactl info` at a time, shared by its readers. */
    daemonInstance(): Promise<string | null> {
        return this.info.get();
    }

    /** False while the device listing gets no answer: the list is then unknown, not empty. */
    isAvailable(): boolean {
        return this.listed;
    }

    /** Both lists asked together, sources first in the result; either one failing is no answer. */
    private async fetchDevices(): Promise<AudioDevice[]> {
        const kinds = [
            ['sources', 'source'],
            ['sinks', 'sink'],
        ] as const;
        const outputs = await Promise.allSettled(
            kinds.map(([kind]) => this.paQueue.execImmediateAsync(['list', kind])),
        );
        const devices: AudioDevice[] = [];
        let failure: unknown = null;
        outputs.forEach((output, i) => {
            if (output.status === 'rejected') {
                failure = output.reason;
                return;
            }
            for (const block of output.value.split('\n\n')) {
                const dev = parseDeviceBlock(block, kinds[i][1]);
                if (dev) devices.push(dev);
            }
        });
        this.listed = failure === null;
        this.noteAnswer(failure);
        return devices;
    }

    private async fetchServerCookie(): Promise<string | null> {
        try {
            const info = await this.paQueue.execImmediateAsync(['info']);
            this.noteAnswer(null);
            return parseServerCookie(info);
        } catch (err) {
            this.noteAnswer(err);
            return null;
        }
    }

    /** One warning when PipeWire stops answering pactl, one line when it answers again (B-195). */
    private noteAnswer(failure: unknown): void {
        if (failure && this.outageSince === null) {
            this.outageSince = this.now();
            log.warn(
                { err: failure },
                'PipeWire does not answer pactl: audio devices read as absent until it does',
            );
        } else if (!failure && this.outageSince !== null) {
            log.info({ downMs: this.now() - this.outageSince }, 'PipeWire answers pactl again');
            this.outageSince = null;
        }
    }

    /**
     * Is this device currently enumerated by PipeWire? Same underlying
     * source as `getDeviceInfo` — kept as a separate method for the
     * presence-only callers (e.g. the device watchdog) where the channel
     * count and sample rate aren't needed and `getDeviceInfo(...) !== null`
     * would be a less expressive idiom.
     */
    async hasDevice(deviceName: string): Promise<boolean> {
        return (await this.listDevices()).some((d) => d.name === deviceName);
    }

    /**
     * Get device info (channels, sampleRate) for a specific source or sink.
     * Returns whatever fields could be parsed from the pactl block — channels
     * is reliable even on SUSPENDED devices (read from `Channel Map:`),
     * sampleRate may be undefined when the active profile hasn't reported a
     * `Sample Specification:` line yet. Returns `null` only when the device
     * isn't enumerated at all.
     */
    async getDeviceInfo(
        deviceName: string,
    ): Promise<{ channels?: number; sampleRate?: number } | null> {
        const dev = (await this.listDevices()).find((d) => d.name === deviceName);
        if (!dev) return null;
        return { channels: dev.channels, sampleRate: dev.sampleRate };
    }
}
