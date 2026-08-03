import { createLogger } from '@media-router/shared-types';
import type { PaCommandQueue } from './PaCommandQueue.js';
import { PA_VOLUME_NORM } from './AudioDeviceOps.js';
import type { AudioDevice } from './PipeWireManager.js';

const log = createLogger('SinkVolumeNormalizer');

/**
 * Holds every hardware sink at unity gain (100% on all channels).
 *
 * Attenuation belongs in software — modules set their own `MR_PW_*`
 * remap-sink volume or attenuate in GStreamer. A hardware sink carrying an
 * extra gain stage of its own multiplies with that, and WirePlumber restores
 * whatever level a device was last left at (commonly 40% / -23.9 dB on a
 * fresh USB interface), which shows up as unusably quiet headphone output
 * with no indication in the UI.
 *
 * `MR_PW_*` devices never reach this class — `parseDeviceBlock` filters them
 * out of `listDevices()` — so the per-module software volume is untouched.
 */
export class SinkVolumeNormalizer {
    /** Devices with a reset already queued, so a re-poll doesn't stack more. */
    private inFlight = new Set<string>();

    constructor(private paQueue: PaCommandQueue) {}

    /**
     * Reset any sink in `devices` that isn't at unity. Fire-and-forget: the
     * caller is the device-provider poll, which must stay synchronous, and a
     * failed reset is retried on the next poll anyway.
     */
    normalize(devices: AudioDevice[]): void {
        for (const dev of devices) {
            if (dev.direction !== 'sink') continue;
            // No volume line parsed — don't guess, and don't treat unknown
            // as attenuated (that would spam pactl every poll).
            if (!dev.volumes?.length) continue;
            if (dev.volumes.every((v) => v === PA_VOLUME_NORM)) continue;
            if (this.inFlight.has(dev.name)) continue;

            this.inFlight.add(dev.name);
            const was = dev.volumes;
            this.paQueue
                .exec(['set-sink-volume', dev.name, String(PA_VOLUME_NORM)])
                .then(() => log.info({ device: dev.name, was }, 'Reset sink to unity gain'))
                .catch((err) => log.warn({ device: dev.name, err }, 'Failed to reset sink to unity gain'))
                .finally(() => this.inFlight.delete(dev.name));
        }
    }
}
